import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {fixture} from './simulation-fixture.js';
import {VisecaClient,type VisecaTransport} from '../packages/local-runtime/src/simulation/viseca-client.js';
import {VisecaOutbox,VisecaWorker} from '../packages/local-runtime/src/simulation/viseca-worker.js';

const now=Date.parse('2026-09-19T00:00:00.000Z');
const humanDeadline='2026-09-19T00:01:50.000Z';
const resources:Array<{directory:string;client:VisecaClient;outbox:VisecaOutbox}>=[];
afterEach(async()=>{for(const r of resources.splice(0)){r.client.close();r.outbox.close();await rm(r.directory,{recursive:true,force:true});}});
const event=()=>({...fixture().event,deadline_at:new Date(now+8000).toISOString()});
const hostedWaiting=(id:string)=>({authorization_id:id,run_id:'RAILWAY_RUN',status:'awaiting_customer',decision:'step_up',is_final:false,human_deadline_at:humanDeadline});
async function setup(transport:VisecaTransport){
 const directory=await mkdtemp(join(tmpdir(),'viseca-railway-compat-'));
 const client=new VisecaClient('https://fixture.invalid','fixture-key',transport),outbox=new VisecaOutbox(join(directory,'outbox.sqlite'));
 resources.push({directory,client,outbox});await outbox.load();const worker=new VisecaWorker(client,outbox,()=>now,100);await worker.startRun('RAILWAY_RUN',{});return {worker,outbox,client};
}

for(const wrapped of [false,true])it.each(['approve','decline'] as const)(`accepts hosted awaiting_customer and sends an explicit /resolve %s (wrapped=${wrapped})`,async decision=>{
 const request=event(),calls:string[]=[];
 const envelope=(value:unknown)=>Response.json(wrapped?{data:value}:value);
 const {worker}=await setup(async(path,init)=>{
  calls.push(path);
  if(path.includes('decision-requests'))return Response.json({run_id:'RAILWAY_RUN',data:request});
  if(path.endsWith('/decision'))return envelope(hostedWaiting(request.authorization.authorization_id));
  if(path.endsWith('/resolve')){expect(JSON.parse(String(init!.body))).toEqual({authorization_id:request.authorization.authorization_id,decision,evidence:[{type:'human_review',actor:'explicit-test-customer'}]});return envelope({authorization_id:request.authorization.authorization_id,status:decision==='approve'?'approved':'declined',decision,is_final:true});}
  throw Error('unexpected read');
 });
 const purchase=await worker.pollOnce(async()=>({decision:'step_up'}));
 expect(purchase).toMatchObject({state:'awaiting_human',reserved:true,accepted:{decision:'step_up'},human_expires_at:humanDeadline});
 expect(calls.filter(path=>path.endsWith('/resolve'))).toHaveLength(0);
 await worker.resolve(purchase!.id,decision,'human-proof',async()=>({actor_id:'explicit-test-customer',proof:'human-proof'}),async()=>true);
 expect(worker.listEntries()[0]).toMatchObject({state:'accepted',reserved:false,accepted:{decision}});
 expect(worker.listPending()).toEqual([]);expect(calls.filter(path=>path.endsWith('/resolve'))).toHaveLength(1);
});

it('recovers the hosted awaiting_customer state after a lost step-up response without repeating /decision',async()=>{
 const request=event();let decisions=0,resolutions=0;
 const {worker,client,outbox}=await setup(async path=>{
  if(path.includes('decision-requests'))return Response.json({run_id:'RAILWAY_RUN',data:request});
  if(path.endsWith('/decision')){decisions++;throw Error('lost response');}
  if(path==='/v1/authorizations')return Response.json({authorizations:[hostedWaiting(request.authorization.authorization_id)]});
  if(path.startsWith('/v1/events'))return Response.json({events:[],next_cursor:0,has_more:false});
  if(path.endsWith('/resolve')){resolutions++;return Response.json({authorization_id:request.authorization.authorization_id,status:'declined',decision:'decline',is_final:true});}
  throw Error('unexpected read');
 });
 expect((await worker.pollOnce(async()=>({decision:'step_up'})))!.state).toBe('submission_unknown');
 const recovered=new VisecaWorker(client,outbox,()=>now,100);await recovered.startRun('RAILWAY_RUN',{});await recovered.reconcile();
 expect(recovered.listEntries()[0]).toMatchObject({state:'awaiting_human',accepted:{decision:'step_up'},human_expires_at:humanDeadline});
 await recovered.resolve(request.authorization.authorization_id,'decline','proof',async()=>({actor_id:'customer',proof:'proof'}),async()=>true);
 expect(decisions).toBe(1);expect(resolutions).toBe(1);expect(recovered.listEntries()[0]!.accepted?.decision).toBe('decline');
});

it.each([{decision:'approve',is_final:false},{decision:'step_up',is_final:true},{decision:'step_up',accepted:false},{decision:'approve',is_final:false,accepted:true},{decision:'step_up',is_final:true,accepted:true}])('does not trust contradictory hosted pending state: %j',async conflict=>{
 const request=event();const {worker}=await setup(async path=>path.includes('decision-requests')?Response.json({run_id:'RAILWAY_RUN',data:request}):Response.json({...hostedWaiting(request.authorization.authorization_id),...conflict}));
 const purchase=await worker.pollOnce(async()=>({decision:'step_up'}));expect(purchase).toMatchObject({state:'submission_unknown',reserved:true,accepted:null});
});

it.each(['step_up',null])('reconciles a hosted final timed_out authorization without any new POST (prior decision: %s)',async priorDecision=>{
 const request=event();let posts=0;
 const {worker}=await setup(async(path,init)=>{
  if(path.includes('decision-requests'))return Response.json({run_id:'RAILWAY_RUN',data:request});
  if(init?.method==='POST'){posts++;throw Error('lost response');}
  if(path==='/v1/authorizations')return Response.json({authorizations:[{authorization_id:request.authorization.authorization_id,run_id:'RAILWAY_RUN',status:'timed_out',decision:priorDecision,is_final:true,resolution:null}]});
  if(path.startsWith('/v1/events'))return Response.json({events:[],next_cursor:0,has_more:false});
  throw Error('unexpected read');
 });
 expect((await worker.pollOnce(async()=>({decision:'step_up'})))!.state).toBe('submission_unknown');
 await worker.reconcile();
 expect(worker.listEntries()[0]).toMatchObject({state:'accepted',reserved:false,accepted:{decision:'decline',response:{status:'timed_out',is_final:true}}});
 expect(worker.listPending()).toEqual([]);expect(posts).toBe(1);
});
