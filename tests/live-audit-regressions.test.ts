import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { LiveSessionService, type LiveSessionStart } from '../packages/local-runtime/src/services/live-session-service.js';
import { VisecaClient, type VisecaTransport } from '../packages/local-runtime/src/simulation/viseca-client.js';
import { VisecaOutbox, VisecaWorker } from '../packages/local-runtime/src/simulation/viseca-worker.js';

const json=(body:unknown,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const folders:string[]=[],services:LiveSessionService[]=[],stores:VisecaOutbox[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.close();for(const store of stores.splice(0))store.close();await Promise.all(folders.splice(0).map(folder=>rm(folder,{recursive:true,force:true})));});
async function directory(){const path=await mkdtemp(join(tmpdir(),'viseca-audit-regression-'));folders.push(path);return path;}
const context=()=>fixture();
function input():LiveSessionStart{const ctx=context();return {config:ctx.config,scenario_id:ctx.event.authorization.scenario_id,instruction:ctx.config.instruction,hard_rules:[],confirmed_by:'human'};}
function session(stateDir:string,transport:VisecaTransport){const service=new LiveSessionService(context().pack,{baseUrl:'http://injected',apiKey:'test',stateDir,transport});services.push(service);return service;}
function purchase(){const event=context().event;event.deadline_at=new Date(Date.now()+8000).toISOString();event.mandate.mandate_id='M1' as never;event.authorization.mandate_id='M1' as never;return event;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>{resolve=accept;});return {promise,resolve};}
function standard(path:string){if(path==='/v1/bootstrap')return json({timeouts:{}});if(path==='/v1/mandates')return json({draft_id:'D1'});if(path.endsWith('/confirm'))return json({mandate_id:'M1'});if(path==='/v1/scenario-runs')return json({run_id:'R1'});if(path==='/v1/scenario-runs/R1')return json({status:'completed',run_id:'R1',mandate_id:'M1',scenario_id:input().scenario_id});if(path.includes('decision-requests'))return json(null,204);return json({data:[],next_cursor:'0'});}

async function humanSession(){
 const event=purchase(),calls:string[]=[];let emitted=false,incompleteLedger=false,resolvePoll:((response:Response)=>void)|undefined;
 const service=session(await directory(),async(path,init)=>{
  if(path==='/v1/authorizations'&&incompleteLedger)return json({data:[{run_id:'R1',authorization_id:'UNKNOWN_APPROVAL',status:'approved'}]});
  if(path.includes('decision-requests')){if(!emitted){emitted=true;return json({run_id:'R1',data:event});}return new Promise<Response>((resolve,reject)=>{resolvePoll=resolve;init?.signal?.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});}
  if(path.endsWith('/decision')){calls.push('step_up');return json({status:'awaiting_human',decision:'step_up'});}
  if(init?.method==='DELETE'){calls.push('revoked');return json({status:'revoked'});}
  if(path.endsWith('/resolve')){calls.push('approve');return json({status:'approved',decision:'approve'});}
  if(path==='/v1/scenario-runs/R1')return json({status:'running'});
  return standard(path);
 });
 const request=input();request.config.parameters.always_ask=true;
 const ids=await service.start(request,'human');await expect.poll(()=>service.get(ids.session_id).entries[0]?.state).toBe('awaiting_human');
 return {service,ids,event,calls,makeLedgerIncomplete:()=>{incompleteLedger=true;},isPolling:()=>Boolean(resolvePoll),conflictQueue:()=>resolvePoll?.(json({run_id:'OTHER_RUN',data:event}))};
}

describe('audited live adapter regressions',()=>{
 it('F04 blocks approval of an existing step-up after an incomplete ledger suspends the run',async()=>{
  const {service,ids,event,calls,makeLedgerIncomplete}=await humanSession();makeLedgerIncomplete();
  await expect.poll(()=>service.get(ids.session_id).status).toBe('reconciliation_required');
  expect(service.get(ids.session_id).last_error).toBe('live_authorization_history_incomplete');
  let revalidated=false;
  await expect(service.respond(ids.session_id,event.authorization.authorization_id,'approve',null,async()=>({actor_id:'human',proof:'after-suspension'}),async()=>{revalidated=true;return true;})).rejects.toThrow('live_approval_suspended');
  expect(revalidated).toBe(false);expect(calls).toEqual(['step_up']);expect(service.get(ids.session_id).entries[0]).toMatchObject({state:'awaiting_human',accepted:{decision:'step_up'},reserved:true});
 });
 it('checks the suspended run again at dispatch if the queue conflicts during revalidation',async()=>{
  const {service,ids,event,calls,isPolling,conflictQueue}=await humanSession();await expect.poll(isPolling).toBe(true);
  const entered=deferred<void>(),gate=deferred<boolean>();
  const responding=service.respond(ids.session_id,event.authorization.authorization_id,'approve',null,async()=>({actor_id:'human',proof:'before-suspension'}),async()=>{entered.resolve();return gate.promise;});
  const rejected=expect(responding).rejects.toThrow('live_approval_suspended');await entered.promise;conflictQueue();
  await expect.poll(()=>service.get(ids.session_id).status).toBe('queue_conflict');gate.resolve(true);await rejected;
  expect(calls).toEqual(['step_up']);expect(service.get(ids.session_id).entries[0]?.accepted?.decision).toBe('step_up');
 });
 it('F01 blocks a simultaneous approval with immediately resolved revalidation',async()=>{
  const {service,ids,event,calls}=await humanSession();
  const revoking=service.revoke(ids.session_id);
  const responding=service.respond(ids.session_id,event.authorization.authorization_id,'approve',null,async()=>({actor_id:'human',proof:'one'}),async()=>true);
  const results=await Promise.allSettled([revoking,responding]);
  expect(results[0]?.status).toBe('fulfilled');expect(results[1]?.status).toBe('rejected');expect(calls).toEqual(['step_up','revoked']);expect(service.get(ids.session_id).mandate_status).toBe('revoked');
 });
 it('F01 checks revocation again at dispatch after a validation already started',async()=>{
  const {service,ids,event,calls}=await humanSession();const gate=deferred<boolean>(),entered=deferred<void>();
  const responding=service.respond(ids.session_id,event.authorization.authorization_id,'approve',null,async()=>({actor_id:'human',proof:'two'}),async()=>{entered.resolve();return gate.promise;});
  const rejected=expect(responding).rejects.toThrow('mandate_revoked');
  await entered.promise;await service.revoke(ids.session_id);gate.resolve(true);await rejected;
  expect(calls).toEqual(['step_up','revoked']);expect(service.get(ids.session_id).entries[0]?.accepted?.decision).toBe('step_up');
 });
 it.each(['/v1/mandates','/v1/mandates/D1/confirm','/v1/scenario-runs'])('F03 safely retries a definitive rejection at %s without recreating accepted stages',async(failedPath)=>{
  const stateDir=await directory(),calls:string[]=[];let rejected=false;
  const transport:VisecaTransport=async(path,init)=>{if(init?.method==='POST'){calls.push(path);if(path===failedPath&&!rejected){rejected=true;return json({error:{code:'invalid_request'}},400);}}return standard(path);};
  const first=session(stateDir,transport);await expect(first.start(input(),'retry')).rejects.toThrow('viseca_http_400');
  expect(first.listStarts()).toEqual([expect.objectContaining({stage:'rejected',retryable:true,last_error:'viseca_http_400:invalid_request'})]);
  await first.close();const resumed=session(stateDir,transport);await expect(resumed.start(input(),'retry')).resolves.toMatchObject({mandate_id:'M1',run_id:'R1'});
  expect(calls.filter(path=>path===failedPath)).toHaveLength(2);
  const before=failedPath==='/v1/scenario-runs'?['/v1/mandates','/v1/mandates/D1/confirm']:failedPath.includes('/confirm')?['/v1/mandates']:[];
  for(const path of before)expect(calls.filter(call=>call===path)).toHaveLength(1);
 });
 it('F03 allows a corrected request under a new key after a definitive rejection',async()=>{
  let posts=0;const service=session(await directory(),async(path,init)=>path==='/v1/mandates'&&init?.method==='POST'&&++posts===1?json({error:{code:'invalid_request'}},400):standard(path));
  await expect(service.start(input(),'rejected')).rejects.toThrow('viseca_http_400');
  await expect(service.start(input(),'corrected')).resolves.toMatchObject({run_id:'R1'});expect(posts).toBe(2);
 });
 it('F03 recovers a remotely created run after its POST response was lost, without repeating POSTs',async()=>{
  const stateDir=await directory(),mutations:string[]=[];let remoteRun=false;
  const transport:VisecaTransport=async(path,init)=>{
   if(init?.method==='POST')mutations.push(path);
   if(path==='/v1/scenario-runs'){remoteRun=true;throw Error('response_lost');}
   if(path.startsWith('/v1/events'))return json({data:remoteRun?[{type:'scenario_run.started',run_id:'R1',data:{run_id:'R1',mandate_id:'M1',scenario_id:input().scenario_id}}]:[],next_cursor:'4'});
   return standard(path);
  };
  const first=session(stateDir,transport);await expect(first.start(input(),'once')).rejects.toThrow('response_lost');expect(first.listStarts()[0]).toMatchObject({stage:'run_intended',retryable:false,status:'submission_unknown'});await first.close();
  const resumed=session(stateDir,transport);await resumed.initialize();expect(resumed.listStarts()).toEqual([]);await expect(resumed.start(input(),'once')).resolves.toMatchObject({run_id:'R1'});
  expect(mutations).toEqual(['/v1/mandates','/v1/mandates/D1/confirm','/v1/scenario-runs']);
 });
 it('F03 leaves an unprovable draft mutation visible and blocks a duplicate under a different key',async()=>{
  let posts=0;const service=session(await directory(),async(path)=>{if(path==='/v1/mandates'){posts++;throw Error('lost');}return standard(path);});
  await expect(service.start(input(),'unknown')).rejects.toThrow('lost');await service.reconcileStarts();
  expect(service.listStarts()[0]).toMatchObject({key:'unknown',stage:'mandate_intended',retryable:false,status:'submission_unknown',last_error:'live_start_submission_unknown_requires_reconciliation'});
  await expect(service.start(input(),'other')).rejects.toThrow('requires_reconciliation');expect(posts).toBe(1);
 });
 it('F03 keeps a lost run ambiguous when the readback does not match its saved mandate',async()=>{
  let runPosts=0;const service=session(await directory(),async(path)=>{
   if(path==='/v1/scenario-runs'){runPosts++;throw Error('lost');}
   if(path.startsWith('/v1/events'))return json({data:[{type:'scenario_run.started',run_id:'R1',data:{mandate_id:'M1'}}],next_cursor:'4'});
   if(path==='/v1/scenario-runs/R1')return json({run_id:'R1',mandate_id:'OTHER_MANDATE',scenario_id:input().scenario_id,status:'running'});
   return standard(path);
  });
  await expect(service.start(input(),'conflicting-readback')).rejects.toThrow('lost');await service.reconcileStarts();
  expect(service.listStarts()[0]).toMatchObject({stage:'run_intended',retryable:false,last_error:'live_start_reconciliation_conflict'});expect(service.list()).toEqual([]);expect(runPosts).toBe(1);
 });
 it('F03 reconciles a lost confirmation by exact draft identity then starts only the missing run',async()=>{
  const stateDir=await directory(),mutations:string[]=[];
  const transport:VisecaTransport=async(path,init)=>{
   if(init?.method==='POST')mutations.push(path);
   if(path.endsWith('/confirm'))throw Error('confirmation_lost');
   if(path.startsWith('/v1/events'))return json({data:[{type:'mandate.confirmed',data:{mandate_id:'M1'}}],next_cursor:'3'});
   if(path==='/v1/mandates/M1')return json({mandate_id:'M1',draft_id:'D1',instruction:input().instruction,hard_rules:[],uncertainty_policy:'ask'});
   return standard(path);
  };
  const first=session(stateDir,transport);await expect(first.start(input(),'confirmation')).rejects.toThrow('confirmation_lost');await first.close();
  const resumed=session(stateDir,transport);await resumed.initialize();expect(resumed.listStarts()[0]).toMatchObject({stage:'run_ready',retryable:true});
  await resumed.start(input(),'confirmation');expect(mutations).toEqual(['/v1/mandates','/v1/mandates/D1/confirm','/v1/scenario-runs']);
 });
 it('F07 keeps completed lifecycle separate from a later mandate revocation',async()=>{
  let runs=0;const service=session(await directory(),async(path,init)=>{if(path==='/v1/scenario-runs')runs++;if(init?.method==='DELETE')return json({status:'revoked'});return standard(path);});
  const ids=await service.start(input(),'first');await expect.poll(()=>service.get(ids.session_id).status).toBe('completed');
  await service.revoke(ids.session_id);expect(service.get(ids.session_id)).toMatchObject({status:'completed',mandate_status:'revoked'});
  await expect(service.start(input(),'second')).resolves.toMatchObject({run_id:'R1'});expect(runs).toBe(2);
 });
 it('F04 explicitly stops the session if the remote spending ledger cannot be reconstructed',async()=>{
  let polls=0;const service=session(await directory(),async(path,init)=>{
   if(path==='/v1/authorizations')return json({data:[{run_id:'R1',authorization_id:'UNKNOWN_APPROVAL',status:'approved'}]});
   if(path.includes('decision-requests')){polls++;return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});}
   return standard(path);
  });
  const ids=await service.start(input(),'missing-ledger');await expect.poll(()=>service.get(ids.session_id).status).toBe('reconciliation_required');
  expect(service.get(ids.session_id).last_error).toBe('live_authorization_history_incomplete');expect(polls).toBe(1);
  await expect(service.start(input(),'other')).rejects.toThrow('live_run_already_active');
 });
});

async function worker(transport:VisecaTransport){const outbox=new VisecaOutbox(join(await directory(),'outbox.sqlite'));stores.push(outbox);await outbox.load();const worker=new VisecaWorker(new VisecaClient('http://injected','test',transport),outbox);await worker.startRun('R1',{});return {worker,outbox};}
function feed(event:ReturnType<typeof purchase>){return {run_id:'R1',authorization_id:event.authorization.authorization_id,type:'authorization.request',status:'pending',data:event};}

describe('recovery of dequeued authorization requests',()=>{
 it('F04 reconstructs a lost poll response and submits its decision once before the deadline',async()=>{
  const event=purchase();let posts=0,firstPoll=true;
  const {worker:w}=await worker(async(path)=>{
   if(path.includes('decision-requests')){if(firstPoll){firstPoll=false;throw Error('lost_after_dequeue');}return json({run_id:'R1',data:event});}
   if(path.endsWith('/decision')){posts++;return json({status:'approved',decision:'approve'});}
   if(path.startsWith('/v1/events'))return json({data:[feed(event)],next_cursor:'4'});
   return json({data:[{run_id:'R1',authorization_id:event.authorization.authorization_id,status:'pending'}]});
  });
  await expect(w.pollOnce(async()=>({decision:'approve'}))).rejects.toThrow('lost_after_dequeue');
  expect(await w.reconcile()).toMatchObject({cursor:'4'});expect(w.listEntries()[0]).toMatchObject({state:'proposed',reserved:true});
  await w.processRecovered(async()=>({decision:'approve'}));await w.pollOnce(async()=>({decision:'approve'}));expect(posts).toBe(1);expect(w.listEntries()[0]).toMatchObject({state:'accepted',accepted:{decision:'approve'},reserved:false});
 });
 it('F04 restores remote final approvals before processing another purchase',async()=>{
  const event=purchase();let posts=0;const {worker:w}=await worker(async(path)=>{if(path.endsWith('/decision'))posts++;return path.startsWith('/v1/events')?json({data:[feed(event)],next_cursor:'5'}):json({data:[{run_id:'R1',authorization_id:event.authorization.authorization_id,status:'approved',decision:'approve'}]});});
  await w.reconcile();await w.processRecovered(async()=>({decision:'approve'}));expect(posts).toBe(0);expect(w.listEntries()[0]).toMatchObject({accepted:{decision:'approve'},reserved:false});expect(w.listEntries().filter(e=>e.accepted?.decision==='approve').reduce((sum,e)=>sum+e.event.authorization.billing_amount_chf,0)).toBe(event.authorization.billing_amount_chf);
 });
 it('F04 refuses to advance the cursor if an authorization cannot be reconstructed',async()=>{
  const {worker:w,outbox}=await worker(async(path)=>path.startsWith('/v1/events')?json({data:[],next_cursor:'9'}):json({data:[{run_id:'R1',authorization_id:'UNKNOWN',status:'approved'}]}));
  await expect(w.reconcile()).rejects.toThrow('live_authorization_history_incomplete');expect(outbox.value.cursor).toBe('0');expect(w.listEntries()).toEqual([]);
 });
 it('F04 rejects malformed recovered request data before advancing the cursor',async()=>{
  const {worker:w,outbox}=await worker(async(path)=>path.startsWith('/v1/events')?json({data:[{run_id:'R1',authorization_id:'UNKNOWN',type:'authorization.request',data:{type:'authorization.request'}}],next_cursor:'9'}):json({data:[]}));
  await expect(w.reconcile()).rejects.toThrow('live_feed_request_invalid');expect(outbox.value.cursor).toBe('0');expect(w.listEntries()).toEqual([]);
 });
});
