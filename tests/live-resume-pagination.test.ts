import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it} from 'vitest';
import {fixture} from './simulation-fixture.js';
import {LiveSessionService} from '../packages/local-runtime/src/services/live-session-service.js';
import {VisecaClient,type VisecaTransport} from '../packages/local-runtime/src/simulation/viseca-client.js';
import {VisecaOutbox,VisecaWorker,type BeforeLiveSubmission} from '../packages/local-runtime/src/simulation/viseca-worker.js';

const json=(value:unknown,status=200)=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const dirs:string[]=[],services:LiveSessionService[]=[],stores:VisecaOutbox[]=[],clients:VisecaClient[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.close();for(const client of clients.splice(0))client.close();for(const store of stores.splice(0))store.close();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function directory(){const dir=await mkdtemp(join(tmpdir(),'viseca-resume-pagination-'));dirs.push(dir);return dir;}
function input(){const ctx=fixture();return {config:ctx.config,scenario_id:ctx.event.authorization.scenario_id,instruction:ctx.config.instruction,hard_rules:[],confirmed_by:'human'};}
function purchase(){const event=fixture().event;event.deadline_at=new Date(Date.now()+8000).toISOString();event.mandate.mandate_id='M1' as never;event.authorization.mandate_id='M1' as never;return event;}
function feed(event:ReturnType<typeof purchase>){return {run_id:'R1',authorization_id:event.authorization.authorization_id,type:'authorization.request',status:'pending',data:event};}
function summary(event:ReturnType<typeof purchase>,status='pending'){return {run_id:'R1',authorization_id:event.authorization.authorization_id,status};}
function since(path:string){return new URL(path,'http://injected').searchParams.get('since')??'0';}
function service(stateDir:string,transport:VisecaTransport){const result=new LiveSessionService(fixture().pack,{stateDir,baseUrl:'http://injected',apiKey:'test',transport});services.push(result);return result;}
function standard(path:string){
 if(path==='/v1/bootstrap')return json({timeouts:{}});
 if(path==='/v1/mandates')return json({draft_id:'D1'});
 if(path.endsWith('/confirm'))return json({mandate_id:'M1'});
 if(path==='/v1/scenario-runs')return json({run_id:'R1'});
 if(path==='/v1/scenario-runs/R1')return json({run_id:'R1',mandate_id:'M1',scenario_id:input().scenario_id,status:'running'});
 return json({data:[],next_cursor:'0'});
}
function blockedPoll(init?:RequestInit){return new Promise<Response>((_resolve,reject)=>{const signal=init?.signal;if(signal?.aborted)reject(Error('stopped'));else signal?.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});}
async function setup(transport:VisecaTransport,guard?:BeforeLiveSubmission){const client=new VisecaClient('http://injected','test',transport);clients.push(client);const outbox=new VisecaOutbox(join(await directory(),'outbox.sqlite'));stores.push(outbox);await outbox.load();const worker=new VisecaWorker(client,outbox,()=>Date.now(),100,guard);await worker.startRun('R1',{});return {worker,outbox};}

// These reproduce R03/R04 without changing the preserved audit scripts or demo journals.
describe('validated restoration of suspended sessions',()=>{
 it.each(['reconciliation_required','authentication_required','queue_conflict'])('reactivates %s only after reading the repaired ledger and active run',async(initialStatus)=>{
  const stateDir=await directory(),event=purchase(),calls:string[]=[];let repaired=false,posts=0;
  const transport:VisecaTransport=async(path,init)=>{
   calls.push(path);
   if(path.includes('decision-requests'))return !repaired&&initialStatus==='queue_conflict'?json({run_id:'OTHER_RUN',data:event}):blockedPoll(init);
   if(path==='/v1/authorizations'){
    if(!repaired&&initialStatus==='authentication_required')return json({error:{code:'invalid_key'}},401);
    return json({data:!repaired&&initialStatus==='queue_conflict'?[]:[summary(event,posts?'approved':'pending')]});
   }
   if(path.startsWith('/v1/events'))return json({data:repaired&&since(path)==='0'?[feed(event)]:[],next_cursor:repaired?'4':'0'});
   if(path.endsWith('/decision')){posts++;expect(JSON.parse(String(init?.body)).decision).toBe('approve');return json({status:'approved'});}
   return standard(path);
  };
  const first=service(stateDir,transport),ids=await first.start(input(),'resume');await expect.poll(()=>first.get(ids.session_id).status).toBe(initialStatus);await first.close();
  repaired=true;calls.length=0;event.deadline_at=new Date(Date.now()+8000).toISOString();const resumed=service(stateDir,transport);await resumed.initialize();
  await expect.poll(()=>resumed.get(ids.session_id).entries[0]?.state).toBe('accepted');
  expect(posts).toBe(1);expect(resumed.get(ids.session_id)).toMatchObject({status:'running',last_error:null,entries:[{accepted:{decision:'approve'},reserved:false}]});
  expect(calls.indexOf('/v1/scenario-runs/R1')).toBeLessThan(calls.findIndex(path=>path.endsWith('/decision')));
  expect(resumed.get(ids.session_id).entries[0]?.history.some(item=>item.kind==='submission_unknown')).toBe(false);
 });
 it.each(['authentication_failure','terminal_run','revoked_mandate'])('preserves the negative check after ledger repair: %s',async(negative)=>{
  const stateDir=await directory(),event=purchase();let repaired=false;const decisions:string[]=[];
  const transport:VisecaTransport=async(path,init)=>{
   if(path.includes('decision-requests'))return blockedPoll(init);
   if(path==='/v1/authorizations')return json({data:[summary(event,decisions.length?'declined':'pending')]});
   if(path.startsWith('/v1/events'))return json({data:repaired&&since(path)==='0'?[feed(event)]:[],next_cursor:repaired?'4':'0'});
   if(init?.method==='DELETE')return json({status:'revoked'});
   if(repaired&&path==='/v1/scenario-runs/R1'&&negative==='authentication_failure')return json({error:{code:'invalid_key'}},401);
   if(repaired&&path==='/v1/scenario-runs/R1'&&negative==='terminal_run')return json({status:'completed'});
   if(path.endsWith('/decision')){decisions.push(JSON.parse(String(init?.body)).decision);return json({status:'declined'});}
   return standard(path);
  };
  const first=service(stateDir,transport),ids=await first.start(input(),'negative');await expect.poll(()=>first.get(ids.session_id).status).toBe('reconciliation_required');
  if(negative==='revoked_mandate')await first.revoke(ids.session_id);await first.close();repaired=true;
  const resumed=service(stateDir,transport);await resumed.initialize();
  if(negative==='revoked_mandate'){await expect.poll(()=>decisions.length).toBe(1);expect(decisions).toEqual(['decline']);expect(resumed.get(ids.session_id).mandate_status).toBe('revoked');}
  else{
   await expect.poll(()=>resumed.get(ids.session_id).last_error).toBe(negative==='authentication_failure'?'viseca_http_401:invalid_key':'live_run_terminal_with_pending_authorizations');
   expect(resumed.get(ids.session_id).status).toBe(negative==='authentication_failure'?'authentication_required':'reconciliation_required');
   expect(decisions).toEqual([]);expect(resumed.get(ids.session_id).entries[0]).toMatchObject({state:'proposed',intent:null,reserved:true});
  }
 });
});

describe('provably blocked dispatches',()=>{
 it('leaves an automatic decision retryable when no request was dispatched',async()=>{
  const event=purchase();let blocked=true,posts=0;
  const {worker}=await setup(async(path)=>{if(path.includes('decision-requests'))return json({run_id:'R1',data:event});posts++;return json({status:'approved'});},()=>{if(blocked)throw Error('live_approval_suspended');});
  const entry=await worker.pollOnce(async()=>({decision:'approve'}));expect(entry).toMatchObject({state:'proposed',intent:null,reserved:true,history:expect.arrayContaining([expect.objectContaining({kind:'submission_blocked'})])});expect(posts).toBe(0);
  blocked=false;await worker.processRecovered(async()=>({decision:'approve'}));expect(posts).toBe(1);expect(worker.listEntries()[0]?.accepted?.decision).toBe('approve');
 });
 it('keeps a blocked human reply pending without consuming proof or extending its deadline',async()=>{
  const event=purchase();let blocked=true,posts=0;
  const {worker}=await setup(async(path)=>{if(path.includes('decision-requests'))return json({run_id:'R1',data:event});if(path.endsWith('/resolve')){posts++;return json({status:'approved'});}return json({status:'awaiting_human'});},decision=>{if(blocked&&decision==='approve')throw Error('mandate_revocation_pending');});
  const initial=(await worker.pollOnce(async()=>({decision:'step_up'})))!,actor=async()=>({actor_id:'customer',proof:'never-sent-proof'});
  await expect(worker.resolve(initial.id,'approve',null,actor,async()=>true)).rejects.toThrow('mandate_revocation_pending');
  expect(posts).toBe(0);expect(worker.listEntries()[0]).toMatchObject({state:'awaiting_human',intent:initial.intent,human_expires_at:initial.human_expires_at,accepted:{decision:'step_up'}});
  blocked=false;await worker.resolve(initial.id,'approve',null,actor,async()=>true);expect(posts).toBe(1);expect(worker.listEntries()[0]?.accepted?.decision).toBe('approve');
 });
 it.each(['lost_response','http_429'])('does not automatically retry a dispatched %s',async(failure)=>{
  const event=purchase();let posts=0;
  const {worker}=await setup(async(path)=>{if(path.includes('decision-requests'))return json({run_id:'R1',data:event});posts++;if(failure==='lost_response')throw Error('lost');return json({error:{code:'rate_limited'}},429);});
  const entry=await worker.pollOnce(async()=>({decision:'approve'}));expect(entry?.state).toBe('submission_unknown');
  await worker.processRecovered(async()=>({decision:'approve'}));await worker.pollOnce(async()=>({decision:'approve'}));expect(posts).toBe(1);
  expect(worker.listEntries()[0]?.history.some(item=>item.kind==='submission_blocked')).toBe(false);
 });
});

describe('complete bounded event pagination',()=>{
 it('collects the request and final outcome across later pages before checking the complete ledger',async()=>{
  const event=purchase(),reads:string[]=[];let posts=0;
  const {worker,outbox}=await setup(async(path)=>{
   if(path==='/v1/authorizations')return json({data:[summary(event,'approved')]});
   if(path.endsWith('/decision')){posts++;return json({status:'approved'});}
   reads.push(since(path));
   if(since(path)==='0')return json({data:[{run_id:'OLD_RUN',type:'scenario_run.finished'}],next_cursor:'1'});
   if(since(path)==='1')return json({data:{events:[feed(event)],next_cursor:'2'}});
   if(since(path)==='2')return json({data:[summary(event,'approved')],next_cursor:'3'});
   return json({data:[],next_cursor:'3'});
  });
  await expect(worker.reconcile()).resolves.toMatchObject({cursor:'3',accepted:[event.authorization.authorization_id]});
  expect(reads).toEqual(['0','1','2','3']);expect(outbox.value.cursor).toBe('3');expect(worker.listEntries()).toMatchObject([{state:'accepted',accepted:{decision:'approve'},reserved:false}]);
  await worker.processRecovered(async()=>({decision:'approve'}));expect(posts).toBe(0);
 });
 it.each(['cycle','page_limit','event_limit','invalid_cursor','lost_page'])('rejects %s without importing entries or committing a partial cursor',async(failure)=>{
  const event=purchase(),reads:string[]=[];let repaired=false;
  const {worker,outbox}=await setup(async(path)=>{
   if(path==='/v1/authorizations')return json({data:[summary(event)]});
   const current=since(path);reads.push(current);
   if(repaired)return json({data:current==='0'?[feed(event)]:[],next_cursor:'1'});
   if(failure==='page_limit')return json({data:[],next_cursor:String(Number(current)+1)});
   if(failure==='event_limit')return json({data:Array.from({length:10001},()=>feed(event)),next_cursor:'1'});
   if(current==='0')return json({data:[feed(event)],next_cursor:'1'});
   if(failure==='lost_page')throw Error('page_response_lost');
   return json({data:[],next_cursor:failure==='invalid_cursor'?{}:'0'});
  });
  const error=failure==='cycle'?'live_event_cursor_cycle':failure==='invalid_cursor'?'live_event_cursor_invalid':failure==='lost_page'?'page_response_lost':'live_event_pagination_limit';
  await expect(worker.reconcile()).rejects.toThrow(error);expect(outbox.value.cursor).toBe('0');expect(worker.listEntries()).toEqual([]);
  expect(reads.length).toBeLessThanOrEqual(100);repaired=true;reads.length=0;
  await expect(worker.reconcile()).resolves.toMatchObject({cursor:'1'});expect(reads).toEqual(['0','1']);expect(worker.listEntries()[0]).toMatchObject({state:'proposed',intent:null});
 });
 it.each(['run','confirmation'])('recovers an ambiguous %s using a later page without repeating the mutation',async(stage)=>{
  const stateDir=await directory(),mutations:string[]=[];let lost=false;
  const transport:VisecaTransport=async(path,init)=>{
   if(init?.method==='POST')mutations.push(path);
   if(path===(stage==='run'?'/v1/scenario-runs':'/v1/mandates/D1/confirm')&&!lost){lost=true;throw Error('response_lost');}
   if(path.startsWith('/v1/events')){
    const current=since(path);
    if(current==='0')return json({data:[{type:'scenario_run.finished',run_id:'OLD_RUN'}],next_cursor:'1'});
    if(current==='1')return json({data:[stage==='run'?{type:'scenario_run.started',run_id:'R1',data:{mandate_id:'M1'}}:{type:'mandate.confirmed',data:{mandate_id:'M1'}}],next_cursor:'2'});
    return json({data:[],next_cursor:'2'});
   }
   if(path==='/v1/mandates/M1')return json({mandate_id:'M1',draft_id:'D1',instruction:input().instruction,hard_rules:[],uncertainty_policy:'ask'});
   if(path.includes('decision-requests'))return blockedPoll(init);
   return standard(path);
  };
  const first=service(stateDir,transport);await expect(first.start(input(),'ambiguous')).rejects.toThrow('response_lost');await first.close();
  const resumed=service(stateDir,transport);await resumed.initialize();expect(resumed.getStart('ambiguous')?.stage).toBe(stage==='run'?'running':'run_ready');
  await expect(resumed.start(input(),'ambiguous')).resolves.toMatchObject({run_id:'R1',mandate_id:'M1'});
  expect(mutations).toEqual(['/v1/mandates','/v1/mandates/D1/confirm','/v1/scenario-runs']);
 });
});
