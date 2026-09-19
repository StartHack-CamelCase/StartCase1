import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createLocalRuntime} from '../packages/local-runtime/src/runtime.js';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {synchronizeBehaviorJournal} from '../packages/local-runtime/src/learning/behavior-journal.js';
import type {BehaviorProfileDashboard,BehaviorProfileOption} from '../packages/contracts/src/behavior-dashboard.js';
const cleanup:Array<{app:FastifyInstance;dir:string}>=[];
afterEach(async()=>{for(const resource of cleanup.splice(0)){await resource.app.close();await rm(resource.dir,{recursive:true,force:true});}});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'behavior-profile-routes-'));
 const options={stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),now:()=>new Date('2026-09-19T12:00:00Z'),instructionDecoder:{model:'test',configured:false,decode:async()=>{throw Error('No model calls in profile tests');}}};
 const runtime=await createLocalRuntime(options);const scenario=runtime.pack.scenarios[0]!;const source=runtime.pack.attemptsByScenario.get(scenario.scenario_id)![0]!;const customer=runtime.pack.authoritiesById.get(source.authority_id)!.customer_id;
 runtime.simulations.store.transaction('test-seed-explicit-feedback',{fixture:'three-distinct-days'},state=>{
  synchronizeBehaviorJournal(state,(['local','live'] as const).flatMap(scope=>Array.from({length:3},(_,i)=>({customer_id:customer,scope,source_id:`fixture:${i}`,authorization_id:`fixture-auth:${i}`,filter_id:'C15' as const,context_key:'test-device',occurred_at:new Date(Date.parse(source.timestamp)-(3-i)*86400000).toISOString(),recorded_at:'2026-09-19T10:00:00Z',actor_id:'fixture-human'}))));return null;
 });
 const before=runtime.simulations.store.select(state=>state.behavior_journal!.sequence);
 const liveObservation={customer_id:customer,scope:'live' as const,source_id:'fixture:extra-live',authorization_id:'fixture-live-extra',filter_id:'C19' as const,context_key:'FR',occurred_at:new Date(Date.parse(source.timestamp)-86400000).toISOString(),recorded_at:'2026-09-19T11:00:00Z',actor_id:'fixture-human'};
 expect(runtime.simulations.behaviorJournal([liveObservation]).sequence).toBe(before+1);
 expect(runtime.simulations.behaviorJournal([liveObservation]).sequence).toBe(before+1);
 expect(runtime.simulations.store.select(state=>state.behavior_journal!.observations.some(o=>o.source_id==='fixture:extra-live'))).toBe(true);
 await runtime.close();
 const app=await createLocalApp(options);cleanup.push({app,dir});
 const session=await app.inject(`/api/wallet/session?scenario_id=${scenario.scenario_id}`);const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'test-habit-control'};
 const detail=async(scope='local')=>(await app.inject(`/api/wallet/profiles/detail?scenario_id=${scenario.scenario_id}&scope=${scope}`)).json<BehaviorProfileDashboard>();
 return {app,dir,options,scenario,customer,headers,detail};
}
it('lists profiles, separates local/live, persists forgetting through API retries and restart',async()=>{
 const x=await setup();const listed=(await x.app.inject('/api/wallet/profiles')).json<{profiles:BehaviorProfileOption[]}>();expect(listed.profiles).toHaveLength(5);
 const initial=await x.detail();expect(initial.profile.habits[0]).toMatchObject({learned:true,distinct_days:3});
 expect(initial.simple_preferences?.contexts[0]).toMatchObject({confirmed:3,rejected:0,samples:3,score:4/5});
 const payload={scenario_id:x.scenario.scenario_id,scope:'local',filter_id:'C15',context_key:'test-device',action:'forget',expected_revision:initial.revision};
 const request={method:'POST' as const,url:'/api/wallet/profiles/control',headers:x.headers,payload};
 const changed=await x.app.inject(request);expect(changed.statusCode,changed.body).toBe(200);expect(changed.json().profile.habits[0]).toMatchObject({status:'forgotten',learned:false,distinct_days:0});
 expect((await x.app.inject(request)).json().revision).toBe(changed.json().revision);
 expect((await x.detail('live')).profile.habits.find(h=>h.filter_id==='C15')?.learned).toBe(true);
 expect((await x.detail('live')).profile.habits.find(h=>h.filter_id==='C19')?.confirmations).toBe(1);
 expect((await x.detail('live')).simple_preferences?.totals).toMatchObject({confirmed:4,rejected:0,contexts:2});
 const stale=await x.app.inject({...request,headers:{...x.headers,'idempotency-key':'stale-habit-control'},payload:{...payload,action:'suspend'}});expect(stale.statusCode).toBe(409);
 const collision=await x.app.inject({...request,payload:{...payload,action:'suspend'}});expect(collision.statusCode).toBe(409);
 await x.app.close();const restarted=await createLocalApp(x.options);cleanup[cleanup.length-1]!.app=restarted;
 const after=(await restarted.inject(`/api/wallet/profiles/detail?scenario_id=${x.scenario.scenario_id}&scope=local`)).json<BehaviorProfileDashboard>();expect(after.profile.habits[0]).toMatchObject({status:'forgotten',learned:false,distinct_days:0});expect(after.controls).toHaveLength(1);
 expect(after.simple_preferences?.contexts[0]).toMatchObject({status:'forgotten',samples:0,score:null});
});
it('rejects missing CSRF, wrong customer, malformed controls and invented reviewed decisions',async()=>{
 const x=await setup();const initial=await x.detail();const payload={scenario_id:x.scenario.scenario_id,scope:'local',filter_id:'C15',context_key:'test-device',action:'suspend',expected_revision:initial.revision};
 expect((await x.app.inject({method:'POST',url:'/api/wallet/profiles/control',headers:{'idempotency-key':'missing-owner-session'},payload})).statusCode).toBe(403);
 const listed=(await x.app.inject('/api/wallet/profiles')).json<{profiles:BehaviorProfileOption[]}>();const other=listed.profiles.find(p=>p.customer_id!==x.customer)!;
 expect((await x.app.inject({method:'POST',url:'/api/wallet/profiles/control',headers:x.headers,payload:{...payload,scenario_id:other.scenario_id}})).statusCode).toBe(403);
 expect((await x.app.inject({method:'POST',url:'/api/wallet/profiles/control',headers:x.headers,payload:{...payload,expected_revision:'6'}})).statusCode).toBe(400);
 expect((await x.app.inject({method:'POST',url:'/api/wallet/profiles/control',headers:x.headers,payload:{...payload,extra:'unsupported'}})).statusCode).toBe(400);
 expect((await x.app.inject({method:'POST',url:'/api/wallet/profiles/feedback',headers:x.headers,payload:{scenario_id:x.scenario.scenario_id,scope:'local',authorization_id:'invented',filter_id:'C15',verdict:'confirmed',expected_revision:initial.revision}})).statusCode).toBe(404);
 expect((await x.detail()).revision).toBe(initial.revision);
});
it('keeps a suspension across forgetting and starts fresh after explicit resume',async()=>{
 const x=await setup();let current=await x.detail();
 for(const [index,action] of ['suspend','forget','resume'].entries()){
  const response=await x.app.inject({method:'POST',url:'/api/wallet/profiles/control',headers:{...x.headers,'idempotency-key':`profile-control-${index}`},payload:{scenario_id:x.scenario.scenario_id,scope:'local',filter_id:'C15',context_key:'test-device',action,expected_revision:current.revision}});
  expect(response.statusCode,response.body).toBe(200);current=response.json();expect(current.profile.habits[0]?.learned).toBe(false);
  if(action!=='resume')expect(current.profile.habits[0]?.status).toBe('suspended');else expect(current.profile.habits[0]?.distinct_days).toBe(0);
 }
 expect(current.controls).toHaveLength(3);
});
