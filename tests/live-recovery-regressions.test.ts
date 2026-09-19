import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {fixture} from './simulation-fixture.js';
import {VisecaClient} from '../packages/local-runtime/src/simulation/viseca-client.js';
import {VisecaOutbox,VisecaWorker} from '../packages/local-runtime/src/simulation/viseca-worker.js';
const base=Date.parse('2026-09-19T00:00:00Z');
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const paths:string[]=[];const stores:VisecaOutbox[]=[];
afterEach(async()=>{for(const store of stores.splice(0))store.close();await Promise.all(paths.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(transport:(path:string,init?:RequestInit)=>Promise<Response>,clock:()=>number){const dir=await mkdtemp(join(tmpdir(),'live-recovery-'));paths.push(dir);const path=join(dir,'outbox.sqlite');const outbox=new VisecaOutbox(path);stores.push(outbox);await outbox.load();const worker=new VisecaWorker(new VisecaClient('http://fake',undefined,transport),outbox,clock,100);await worker.startRun('R1',{});return {worker,outbox,path};}
function purchase(){const e=fixture().event;e.deadline_at=new Date(base+8000).toISOString();return e;}
const actor=async()=>({actor_id:'real-customer-channel',proof:'explicit-click-1'});

it('submits a reply at second 119 while a 25-second poll is still pending',async()=>{
 let now=base,polls=0,sentAt=0;const event=purchase(),waiting=deferred<Response>(),pollStarted=deferred<void>();
 const {worker}=await setup(async path=>{
  if(path.includes('decision-requests')){if(++polls===1)return json({run_id:'R1',data:event});pollStarted.resolve();return waiting.promise;}
  if(path.endsWith('/decision'))return json({decision:'step_up',status:'accepted'});
  if(path.endsWith('/resolve')){sentAt=now;return json({decision:'approve',status:'approved'});}
  return json({data:[]});
 },()=>now);
 const entry=await worker.pollOnce(async()=>({decision:'step_up'}));
 const polling=worker.pollOnce(async()=>({decision:'approve'}));await pollStarted.promise;now=base+119000;
 const responding=worker.resolve(entry!.id,'approve',null,actor,async()=>true);
 try{await expect.poll(()=>sentAt,{timeout:500}).toBe(base+119000);await responding;}
 finally{now=base+121000;waiting.resolve(new Response(null,{status:204}));await polling;}
 expect(worker.listEntries()[0]?.accepted?.decision).toBe('approve');
});

it('does not block a timely reply behind a reconciliation GET or overwrite it with stale step-up data',async()=>{
 let now=base,posted=0;const event=purchase(),reads=deferred<Response>(),reading=deferred<void>();
 const {worker}=await setup(async path=>{
  if(path.includes('decision-requests'))return json({run_id:'R1',data:event});
  if(path.endsWith('/decision'))return json({decision:'step_up',status:'accepted'});
  if(path.endsWith('/resolve')){posted++;return json({decision:'approve',status:'approved'});}
  reading.resolve();const response=await reads.promise;return response.clone();
 },()=>now);
 const entry=await worker.pollOnce(async()=>({decision:'step_up'}));const reconciliation=worker.reconcile();await reading.promise;now=base+119000;
 const responding=worker.resolve(entry!.id,'approve',null,actor,async()=>true);
 try{await expect.poll(()=>posted,{timeout:500}).toBe(1);await responding;}
 finally{reads.resolve(json({data:[{run_id:'R1',authorization_id:entry!.id,status:'awaiting_human'}]}));await reconciliation;}
 expect(worker.listEntries()[0]?.state).toBe('accepted');expect(worker.listEntries()[0]?.accepted?.decision).toBe('approve');
});

it('recovers a lost human reply from the current platform status, without automatic repost or renewed consent time',async()=>{
 let now=base,posts=0,currentStatus='awaiting_human';const event=purchase();
 const {worker,outbox,path}=await setup(async path=>{
  if(path.includes('decision-requests'))return json({run_id:'R1',data:event});
  if(path.endsWith('/decision'))return json({decision:'step_up',status:'accepted'});
  if(path.endsWith('/resolve')){posts++;throw Error('connection_lost');}
  return json({data:path==='/v1/authorizations'?[{run_id:'R1',authorization_id:event.authorization.authorization_id,status:currentStatus}]:[]});
 },()=>now);
 const original=await worker.pollOnce(async()=>({decision:'step_up'}));const deadline=original!.human_expires_at;
 now=base+50000;await expect(worker.resolve(original!.id,'approve',null,actor,async()=>true)).rejects.toThrow('human_submission_unknown');
 expect(worker.listEntries()[0]?.state).toBe('submission_unknown');
 stores.splice(stores.indexOf(outbox),1);outbox.close();const restored=new VisecaOutbox(path);stores.push(restored);await restored.load();
 const resumed=new VisecaWorker(new VisecaClient('http://fake',undefined,async p=>json({data:p==='/v1/authorizations'?[{run_id:'R1',authorization_id:original!.id,status:currentStatus}]:[]})),restored,()=>now);
 await resumed.startRun('R1',{});now=base+90000;await resumed.reconcile();
 expect(resumed.listEntries()[0]).toMatchObject({state:'awaiting_human',reserved:true,human_expires_at:deadline});expect(posts).toBe(1);
 currentStatus='approved';await resumed.reconcile();expect(resumed.listEntries()[0]).toMatchObject({state:'accepted',reserved:false,accepted:{decision:'approve'}});expect(posts).toBe(1);
});

it('does not restore a lost reply from a historical step-up event or extend its original deadline',async()=>{
 let now=base;const event=purchase();const {worker}=await setup(async path=>{
  if(path.includes('decision-requests'))return json({run_id:'R1',data:event});
  if(path.endsWith('/decision'))return json({decision:'step_up',status:'accepted'});
  if(path.endsWith('/resolve'))throw Error('lost');
  return json({data:path.includes('/events')?[{run_id:'R1',authorization_id:event.authorization.authorization_id,status:'awaiting_human'}]:[]});
 },()=>now);
 const initial=await worker.pollOnce(async()=>({decision:'step_up'}));await expect(worker.resolve(initial!.id,'approve',null,actor,async()=>true)).rejects.toThrow();
 now=base+60000;await worker.reconcile();expect(worker.listEntries()[0]).toMatchObject({state:'submission_unknown',human_expires_at:initial!.human_expires_at,reserved:true});
});

it('rejects a genuinely late human answer without sending any resolution',async()=>{
 let now=base,posts=0;const event=purchase();const {worker}=await setup(async path=>{if(path.includes('decision-requests'))return json({run_id:'R1',data:event});if(path.endsWith('/resolve'))posts++;return json({status:'accepted',decision:'step_up'});},()=>now);
 const initial=await worker.pollOnce(async()=>({decision:'step_up'}));now=base+120001;
 await expect(worker.resolve(initial!.id,'approve',null,actor,async()=>true)).rejects.toThrow('human_confirmation_expired');expect(posts).toBe(0);
});
