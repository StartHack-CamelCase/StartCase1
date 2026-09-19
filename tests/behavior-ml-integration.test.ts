import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import type {BehaviorJournal} from '../packages/contracts/src/behavior-dashboard.js';
import type {SimulationDocument} from '../packages/contracts/src/simulation.js';
import {fixture} from './simulation-fixture.js';
import {assess} from '../packages/local-runtime/src/simulation/evaluator.js';
import {assessBehaviorLearningComparison} from '../packages/local-runtime/src/learning/behavior-evaluation.js';
import {collectBehaviorMLDataset,projectBehaviorML} from '../packages/local-runtime/src/learning/behavior-ml-projection.js';
import {projectSimplePreferences} from '../packages/local-runtime/src/learning/simple-preferences.js';
import {localHabitObservations} from '../packages/local-runtime/src/learning/learned-habits.js';
import {synchronizeBehaviorJournal} from '../packages/local-runtime/src/learning/behavior-journal.js';
import {analyzeBehaviorMLInWorker,boundBehaviorMLDataset} from '../packages/local-runtime/src/learning/behavior-ml-worker-client.js';
import {createLocalRuntime} from '../packages/local-runtime/src/runtime.js';
import {createLocalApp} from '../apps/local-web/src/app.js';

function example(){
  const c=fixture('AU0001');c.config.parameters.watch_devices=true;c.config.parameters.learn_confirmed_habits=true;
  c.event.authorization.customer_device_id='unseen-ml-device';
  const a=assess(c);a.behavior_learning!.comparison=assessBehaviorLearningComparison(c,a);
  c.run.purchases=[{event:c.event,assessments:[a],answers:[]}];
  const journal:BehaviorJournal={schema_version:1,sequence:0,observations:[],controls:[],reviews:[]};
  const state:SimulationDocument={schema_version:1,configs:[c.config],runs:[c.run],commands:{},behavior_journal:journal};
  const snapshot=a.behavior_learning!.ml_features!.find(s=>s.filter_id==='C15')!;
  expect(snapshot).toBeDefined();
  return {c,a,snapshot,journal,state};
}
function review(x:ReturnType<typeof example>,verdict:'confirmed'|'rejected',second=10){
  const row={sequence:++x.journal.sequence,customer_id:x.c.run.customer_id,scope:'local' as const,source_id:x.a.behavior_learning!.comparison!.source_id,authorization_id:x.a.authorization_id,filter_id:'C15' as const,context_key:x.snapshot.context_key,verdict,at:new Date(Date.parse(x.c.now)+second*1000).toISOString(),actor_id:'explicit-test-user'};
  x.journal.reviews!.push(row);return row;
}
function replay(x:ReturnType<typeof example>){
  const run=structuredClone(x.c.run);run.run_id='REPLAY_RUN';run.run_key='REPLAY';
  const purchase=run.purchases[0]!,assessment=purchase.assessments[0]!;
  purchase.event.authorization.authorization_id='REPLAY_AUTH' as never;
  assessment.run_id=run.run_id;assessment.authorization_id='REPLAY_AUTH';assessment.recorded_at='2026-09-19T00:00:01.000Z';
  assessment.behavior_learning!.comparison!.authorization_id=assessment.authorization_id;
  for(const snapshot of assessment.behavior_learning!.ml_features!)snapshot.predicted_at=assessment.recorded_at;
  x.state.runs.push(run);return {run,assessment};
}

it('counts a replay review once and replaces its verdict without losing the original source identity',()=>{
  const x=example(),replayed=replay(x),positive=review(x,'confirmed');positive.authorization_id=replayed.assessment.authorization_id;
  const collect=()=>collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  const data=collect();
  expect(data.records).toHaveLength(1);expect(data.records[0]!.authorization_id).toBe(x.a.authorization_id);
  expect(data.examples).toEqual([expect.objectContaining({id:x.snapshot.source_id,predicted_at:x.snapshot.predicted_at,label:1})]);
  expect(projectSimplePreferences(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z').contexts[0]).toMatchObject({confirmed:1,rejected:0,samples:1,score:2/3});
  const negative=review(x,'rejected',20);negative.authorization_id=replayed.assessment.authorization_id;
  expect(projectSimplePreferences(collect(),x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z').contexts[0]).toMatchObject({confirmed:0,rejected:1,samples:1,score:1/3});
  x.journal.controls.push({...negative,sequence:++x.journal.sequence,action:'forget'});
  replayed.assessment.behavior_learning!.ml_features![0]!.knowledge_sequence=x.journal.sequence;
  expect(collect().examples).toEqual([]);
});

it('counts an approved replay confirmation once alongside a later review of the same source',()=>{
  const x=example(),replayed=replay(x),a=replayed.assessment;
  a.decision='approve';a.execution_state='approved';
  a.behavior_learning!.confirmations=[{customer_id:x.c.run.customer_id,scope:'local',source_id:x.snapshot.source_id,authorization_id:a.authorization_id,filter_id:'C15',context_key:x.snapshot.context_key,occurred_at:a.scenario_timestamp,recorded_at:'2026-09-19T00:00:05.000Z',actor_id:'explicit-test-user'}];
  synchronizeBehaviorJournal(x.state,localHabitObservations(x.state.runs));
  const positive=review(x,'confirmed');positive.authorization_id=a.authorization_id;
  const data=collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  expect(data.examples).toHaveLength(2);
  expect(projectSimplePreferences(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z').contexts[0]).toMatchObject({confirmed:1,rejected:0,samples:1,score:2/3});
});

it('binds replay labels to their customer, environment, source, exact context and availability',()=>{
  const x=example(),replayed=replay(x),positive=review(x,'confirmed');positive.authorization_id=replayed.assessment.authorization_id;
  const collect=()=>collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  const original={...positive};
  for(const patch of [{customer_id:'OTHER'},{scope:'live' as const},{source_id:'other-source'},{context_key:'another-device'},{authorization_id:'unknown-auth'},{at:x.c.now}]){
    Object.assign(positive,original,patch);expect(collect().examples).toEqual([]);
  }
  Object.assign(positive,original);
  replayed.assessment.behavior_learning!.ml_features![0]!.context_key='another-device';
  expect(collect().examples).toEqual([]);
});

it('matches replay time reviews using the comparison source while preserving the timezone-specific snapshot identity',()=>{
  const x=example();
  Object.assign(x.snapshot,{filter_id:'C18',context_key:'Europe/Zurich|weekday|0-4',source_id:`${x.a.behavior_learning!.comparison!.source_id}:Europe/Zurich`});
  const replayed=replay(x),positive=review(x,'confirmed');
  Object.assign(positive,{authorization_id:replayed.assessment.authorization_id,filter_id:'C18'});
  const data=collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  expect(data.examples).toEqual([expect.objectContaining({id:x.snapshot.source_id,filter_id:'C18',label:1})]);
  expect(projectSimplePreferences(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z').contexts[0]).toMatchObject({filter_id:'C18',context_key:x.snapshot.context_key,samples:1,score:2/3});
});

it('captures only context before the reply, without numeric features or payment influence',()=>{
  const x=example(),original=x.snapshot.features;
  expect(original).toEqual([]);
  const sample=x.c.run.history.find(h=>h.customer_id===x.c.run.customer_id)!;
  x.c.run.history=[...x.c.run.history,{...sample,timestamp:'2099-01-01T00:00:00Z',billing_amount_chf:'999999'},{...sample,customer_id:'OTHER' as never,billing_amount_chf:'999999'}];
  const next=assess(x.c);expect(next.behavior_learning!.ml_features![0]!.features).toEqual(original);
  expect(next.decision).toBe(x.a.decision);expect(next.results).toEqual(x.a.results);
  const question=x.a.questions.find(q=>q.filter_ids.includes('C15'))!;
  x.c.answers=[{answer_id:'test-answer',question_id:question.question_id,fact_key:question.fact_key,kind:'confirm_risk',value:'confirm',source_ref:null,source_excerpt:null,actor:{actor_id:'test-user',customer_id:x.c.run.customer_id,role:'simulated_human',channel:'local_ui',authenticated_by_server:true},offer_hash:x.c.offer_hash,config_revision:x.c.config.revision,created_at:x.c.now,expires_at:'2026-09-20T00:00:00Z',consumed_by:null}];
  expect(assess(x.c).behavior_learning!.ml_features).toEqual([]);
  expect(x.snapshot.features).toEqual(original);
});

it('captures a new device context even without comparable purchase history',()=>{
  const x=example();x.c.run.history=[];
  const snapshot=assess(x.c).behavior_learning!.ml_features!.find(s=>s.filter_id==='C15');
  expect(snapshot).toMatchObject({feature_version:'behavior-context-v2',context_key:'unseen-ml-device',features:[]});
});

it('keeps positive and negative context feedback visible in the simple model during suspension',()=>{
  const x=example();review(x,'confirmed');
  const copy=structuredClone(x.c.run.purchases[0]!);copy.assessments[0]!.authorization_id='second-source-auth';
  copy.assessments[0]!.behavior_learning!.ml_features![0]!.source_id='second-source';x.c.run.purchases.push(copy);
  const rejected=review(x,'rejected',20);rejected.authorization_id='second-source-auth';
  x.journal.controls.push({...rejected,sequence:++x.journal.sequence,action:'suspend'});
  const data=collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  expect(data.examples.map(e=>e.label)).toEqual([1,0]);
});

it('does not resurrect a forgotten source through a replay with a rolled-back clock',()=>{
  const x=example(),positive=review(x,'confirmed');
  x.journal.controls.push({...positive,sequence:++x.journal.sequence,action:'forget'});
  const replay=structuredClone(x.c.run.purchases[0]!);replay.assessments[0]!.recorded_at='2026-09-18T23:00:00Z';
  const snapshot=replay.assessments[0]!.behavior_learning!.ml_features![0]!;
  snapshot.predicted_at=replay.assessments[0]!.recorded_at;snapshot.knowledge_sequence=x.journal.sequence;
  x.c.run.purchases.push(replay);
  const data=collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  expect(data.records[0]!.snapshot.knowledge_sequence).toBe(0);expect(data.examples).toEqual([]);
  const past=collectBehaviorMLDataset(x.state,[],{...x.journal,controls:x.journal.controls.map(c=>({...c,at:'2026-09-21T00:00:00Z'}))},'local','2026-09-20T00:00:00Z',{includeSuspendedLabels:true});
  expect(past.examples).toHaveLength(1);
});

it('keeps unknown outcomes unknown, deduplicates replays and isolates local/live',()=>{
  const x=example();x.state.runs.push(structuredClone(x.c.run));
  const unknown=collectBehaviorMLDataset(x.state,[],x.journal,'local');expect(unknown.records).toHaveLength(1);expect(unknown.examples).toEqual([]);expect(unknown.unknown).toBe(1);
  review(x,'confirmed');
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').examples).toHaveLength(1);
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'live').examples).toEqual([]);
  const before=JSON.stringify(x.state);projectBehaviorML(unknown,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z');expect(JSON.stringify(x.state)).toBe(before);
});

it('retains a negative under suspension, removes corrected negatives and cannot revive forgotten sources',()=>{
  const x=example(),negative=review(x,'rejected');
  x.journal.controls.push({...negative,sequence:++x.journal.sequence,action:'suspend'});
  let data=collectBehaviorMLDataset(x.state,[],x.journal,'local');expect(data.examples.map(e=>e.label)).toEqual([0]);
  expect(projectBehaviorML(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z').predictions[0]).toMatchObject({score:null,abstention_reason:'This context is suspended.'});
  review(x,'confirmed',20);expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').examples).toEqual([]);
  x.journal.controls.push({...negative,sequence:++x.journal.sequence,action:'forget'});review(x,'rejected',30);
  data=collectBehaviorMLDataset(x.state,[],x.journal,'local');expect(data.examples).toEqual([]);expect(data.excluded_controlled).toBe(1);
  x.journal.controls.push({...negative,sequence:++x.journal.sequence,action:'resume'});
  const fresh=structuredClone(x.c.run.purchases[0]!);fresh.event.authorization.authorization_id='fresh-auth' as never;fresh.assessments[0]!.authorization_id='fresh-auth';
  fresh.assessments[0]!.behavior_learning!.ml_features![0]!.knowledge_sequence=x.journal.sequence;
  fresh.assessments[0]!.behavior_learning!.ml_features![0]!.source_id='fresh-source';
  fresh.assessments[0]!.behavior_learning!.comparison!.source_id='fresh-source';
  x.c.run.purchases.push(fresh);const positive=review(x,'confirmed',40);positive.authorization_id='fresh-auth';positive.source_id='fresh-source';
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').examples.map(e=>e.id)).toEqual(['fresh-source']);
});

it('preserves dated label corrections and never labels old assessments from reconstructed features',()=>{
  const x=example();review(x,'confirmed');review(x,'rejected',20);
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').examples.map(e=>[e.label,e.label_at])).toEqual([[1,'2026-09-19T00:00:10.000Z'],[0,'2026-09-19T00:00:20.000Z']]);
  delete x.a.behavior_learning!.ml_features;
  const data=collectBehaviorMLDataset(x.state,[],x.journal,'local');expect(data.examples).toEqual([]);expect(data.excluded_legacy_assessments).toBe(1);
});

it('ignores malformed optional feature snapshots and future corrections when building the current cohort',()=>{
  const x=example(),negative=review(x,'rejected');
  x.journal.controls.push({...negative,sequence:++x.journal.sequence,action:'suspend'});review(x,'confirmed',200);
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local','2026-09-19T00:01:00Z').examples.map(e=>e.label)).toEqual([0]);
  (x.snapshot.features as number[])[0]=NaN;
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').records).toEqual([]);
  (x.snapshot.features as number[])[0]=0;x.snapshot.filter_id='C99' as never;
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').records).toEqual([]);
  x.a.behavior_learning!.ml_features=[null] as never;
  expect(collectBehaviorMLDataset(x.state,[],x.journal,'local').records).toEqual([]);
});

it('executes real analysis in a worker and returns an honest cold start without state writes',async()=>{
  const x=example(),data=collectBehaviorMLDataset(x.state,[],x.journal,'local'),before=JSON.stringify(x.state);
  const report=await analyzeBehaviorMLInWorker(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z');
  expect(report.notice).not.toContain('temporarily unavailable');expect(report.models).toHaveLength(3);expect(report.models.every(m=>m.status==='insufficient_data')).toBe(true);expect(report.decision_influence).toBe(false);
  expect(JSON.stringify(x.state)).toBe(before);
  expect(await analyzeBehaviorMLInWorker(data,x.journal,x.c.run.customer_id,'local','2026-09-20T00:00:00Z')).toEqual(report);
  const many={...data,records:Array.from({length:105},(_,i)=>({...data.records[0]!,snapshot:{...x.snapshot,source_id:String(i)}})),examples:Array.from({length:105},(_,i)=>({id:String(i),customer_id:x.c.run.customer_id,scope:'local' as const,filter_id:'C15' as const,predicted_at:x.c.now,label_at:'2026-09-19T00:00:10Z',label:1 as const,features:x.snapshot.features}))};
  expect(boundBehaviorMLDataset(many).examples).toHaveLength(100);
});

it('accepts replay feedback after an earlier unfinished alert through authenticated API and survives restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'behavior-ml-api-'));
  let now='2026-09-19T01:00:00Z';
  const options={stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),now:()=>new Date(now)};
  let app:Awaited<ReturnType<typeof createLocalApp>>|undefined;
  try{
    const runtime=await createLocalRuntime(options),x=example(),completed=replay(x).assessment;
    completed.decision='deny';completed.execution_state='declined'; // The original source is unfinished; its replay can be reviewed.
    runtime.simulations.store.transaction('seed-ml-context',{},s=>{s.runs.push(...x.state.runs);s.configs.push(x.c.config);return null;});await runtime.close();
    app=await createLocalApp(options);
    const scenario=x.c.run.scenario_id,url=`/api/wallet/profiles/detail?scenario_id=${scenario}&scope=local`;
    const before=(await app.inject(url)).json();expect(before.reviews.find((r:{authorization_id:string})=>r.authorization_id===completed.authorization_id)).toMatchObject({was_suppressed:false,verdict:null});expect(before.simple_preferences.observation_only).toBe(true);
    const session=await app.inject(`/api/wallet/session?scenario_id=${scenario}`),headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'ml-negative'};
    const positiveRequest={method:'POST' as const,url:'/api/wallet/profiles/feedback',headers:{...headers,'idempotency-key':'simple-confirmed'},payload:{scenario_id:scenario,scope:'local',authorization_id:completed.authorization_id,filter_id:'C15',verdict:'confirmed',expected_revision:before.revision}};
    const positive=await app.inject(positiveRequest);expect(positive.statusCode,positive.body).toBe(200);
    now='2026-09-19T01:00:01Z';
    const first=(await app.inject(url)).json();
    expect(first.machine_learning).toBeUndefined();
    expect(first.simple_preferences.contexts.find((m:{filter_id:string})=>m.filter_id==='C15')).toMatchObject({confirmed:1,rejected:0,samples:1,score:2/3});
    const request={method:'POST' as const,url:'/api/wallet/profiles/feedback',headers,payload:{scenario_id:scenario,scope:'local',authorization_id:completed.authorization_id,filter_id:'C15',verdict:'rejected',expected_revision:positive.json().revision}};
    const accepted=await app.inject(request);expect(accepted.statusCode,accepted.body).toBe(200);expect((await app.inject(request)).json().revision).toBe(accepted.json().revision);
    now='2026-09-19T01:00:02Z';
    await app.close();app=await createLocalApp(options);
    const after=(await app.inject(url)).json();expect(after.simple_preferences.contexts.find((m:{filter_id:string})=>m.filter_id==='C15')).toMatchObject({rejected:1,confirmed:0,status:'suspended',score:null});expect(after.profile.habits[0].status).toBe('suspended');
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
