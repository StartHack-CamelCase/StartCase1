import { describe, expect, it } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { assess, stampCommitted } from '../packages/local-runtime/src/simulation/evaluator.js';
import { offerHash } from '../packages/local-runtime/src/simulation/common.js';
import { buildBehaviorProfile, habitContext } from '../packages/local-runtime/src/learning/behavior-profile.js';
import { localHabitObservations, liveHabitObservations, safeBehaviorProfile } from '../packages/local-runtime/src/learning/learned-habits.js';
import type { BehaviorControlEvent, BehaviorObservation } from '../packages/contracts/src/behavior.js';
import type { LiveEntry } from '../packages/local-runtime/src/simulation/viseca-worker.js';

function context(day=24,observations:BehaviorObservation[]=[]){
  const c=fixture('AU0001');
  c.config.parameters.learn_confirmed_habits=true;c.config.parameters.watch_devices=true;
  c.event.authorization.timestamp=`2026-08-${day}T10:00:00Z`;
  c.event.authorization.authorization_id=`SYNTHETIC_LEARNING_${day}` as never;
  c.event.authorization.source_authorization_id=`SYNTHETIC_LEARNING_${day}` as never;
  c.event.authorization.customer_device_id='explicitly-confirmed-new-device';
  c.offer_hash=offerHash(c.event,c.config);
  c.behavior_profile=buildBehaviorProfile(observations,{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone});
  return c;
}
function confirmDevice(c:ReturnType<typeof context>){
  const initial=assess(c),q=initial.questions.find(q=>q.filter_ids.includes('C15'))!;
  expect(q).toBeDefined();
  c.answers=[{answer_id:'ANSWER',question_id:q.question_id,fact_key:q.fact_key,kind:'confirm_risk',value:'confirm',source_ref:null,source_excerpt:null,actor:{actor_id:'customer',customer_id:c.run.customer_id,role:'simulated_human',channel:'local_ui',authenticated_by_server:true},offer_hash:c.offer_hash,config_revision:c.config.revision,created_at:c.now,expires_at:'2026-09-20T00:00:00Z',consumed_by:null}];
  const final=assess(c);expect(final.can_finalize).toBe(true);stampCommitted(final);
  c.run.purchases.push({event:c.event,assessments:[initial,final],answers:c.answers});
  return {final,observations:localHabitObservations([c.run])};
}
function learned(){return [21,22,23].flatMap(day=>confirmDevice(context(day)).observations);}

describe('confirmed habit learning through the decision engine',()=>{
  it('learns across three distinct days, then avoids only the repeated device question',()=>{
    let observations:BehaviorObservation[]=[];
    for(const day of [21,22,23]){
      const c=context(day,observations),initial=assess(c);
      expect(initial.results.find(r=>r.filter_id==='C15')!.outcome).toBe('needs_review');
      const accepted=confirmDevice(c);observations.push(...accepted.observations);
    }
    const fourth=assess(context(24,observations));
    expect(fourth.can_finalize).toBe(true);
    expect(fourth.behavior_learning?.applied_filter_ids).toEqual(['C15']);
    expect(fourth.behavior_learning?.confirmations).toEqual([]);
    expect(fourth.results.find(r=>r.filter_id==='C15')!.evidence[0]!.method).toBe('confirmed-habits-v1');
  });
  it('does not learn from its own approvals, rejected purchases, or missing opt-in',()=>{
    const c=context(24,learned()),approved=assess(c);stampCommitted(approved);
    c.run.purchases=[{event:c.event,assessments:[approved],answers:[]}];
    expect(localHabitObservations([c.run])).toEqual([]);
    const accepted=confirmDevice(context(21));
    const rejected=structuredClone(accepted.final);rejected.execution_state='cancelled';rejected.decision=null;
    c.run.purchases=[{event:c.event,assessments:[rejected],answers:[]}];
    expect(localHabitObservations([c.run])).toEqual([]);
    c.config.parameters.learn_confirmed_habits=false;
    const disabled=assess(c);expect(disabled.behavior_learning).toBeUndefined();
    expect(disabled.results.find(r=>r.filter_id==='C15')!.outcome).toBe('needs_review');
  });
  it('never overrides a price limit or the customer always-ask setting',()=>{
    const c=context(24,learned());c.config.parameters.max_order_chf='1';
    expect(assess(c).decision).toBe('deny');
    c.config.parameters.max_order_chf=null;c.config.parameters.always_ask=true;
    const a=assess(c);expect(a.decision).toBe('step_up');
    expect(a.questions.some(q=>q.filter_ids.includes('C24'))).toBe(true);
  });
  it('does not override an explicit time-review window',()=>{
    const c=context();c.config.parameters.time_review={from_hour:0,to_hour:23};
    const key=habitContext('C18',c.event,c.config.parameters.timezone)!;
    const observations=learned().map(o=>({...o,filter_id:'C18' as const,context_key:key}));
    c.behavior_profile=buildBehaviorProfile(observations,{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone});
    const a=assess(c);expect(a.results.find(r=>r.filter_id==='C18')!.outcome).toBe('needs_review');
    expect(a.behavior_learning?.applied_filter_ids).not.toContain('C18');
  });
  it('keeps another customer profile and current/future purchases out of the decision',()=>{
    const c=context(21,learned());expect(assess(c).can_finalize).toBe(false);
    c.behavior_profile=buildBehaviorProfile(learned().map(o=>({...o,customer_id:'someone-else'})),{customerId:'someone-else',scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone});
    expect(assess(c).behavior_learning?.applied_filter_ids).toEqual([]);
  });
  it('does not use a live habit profile for a local purchase',()=>{
    const c=context(24);
    c.behavior_profile=buildBehaviorProfile(learned().map(o=>({...o,scope:'live'})),{customerId:c.run.customer_id,scope:'live',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone});
    expect(assess(c).behavior_learning?.applied_filter_ids).toEqual([]);
  });
  it('falls back to ordinary checks when optional learning evidence conflicts',()=>{
    const c=context(),observations=learned();observations.push({...observations[0]!,context_key:'conflicting-device'});
    c.behavior_profile=safeBehaviorProfile(observations,{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone});
    const a=assess(c);expect(a.behavior_learning?.profile.warning).toContain('Standard checks');
    expect(a.results.find(r=>r.filter_id==='C15')!.outcome).toBe('needs_review');
  });
  it('keeps a suspended context visible and does not collect a new positive confirmation',()=>{
    const c=context(24),observations=learned().map((o,i)=>({...o,sequence:i+1}));
    const control:BehaviorControlEvent={sequence:4,customer_id:c.run.customer_id,scope:'local',filter_id:'C15',context_key:c.event.authorization.customer_device_id!,action:'suspend',at:c.now,actor_id:'customer'};
    c.behavior_profile=buildBehaviorProfile(observations,{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone,controls:[control],availableThroughSequence:4});
    const initial=assess(c);expect(initial.behavior_learning?.profile.habits[0]!.status).toBe('suspended');
    expect(initial.behavior_learning?.applied_filter_ids).toEqual([]);
    const confirmed=confirmDevice(c);
    expect(confirmed.final.execution_state).toBe('approved');
    expect(confirmed.final.behavior_learning?.confirmations).toEqual([]);
    expect(confirmed.observations).toEqual([]);
  });
  it('preserves a suspension on evidence failure and pauses all optional learning for that check',()=>{
    const c=context(),rows=learned().map((o,i)=>({...o,sequence:i+1}));
    const control:BehaviorControlEvent={sequence:4,customer_id:c.run.customer_id,scope:'local',filter_id:'C15',context_key:c.event.authorization.customer_device_id!,action:'suspend',at:c.now,actor_id:'customer'};
    c.behavior_profile=safeBehaviorProfile([...rows,{...rows[0]!,context_key:'conflict'}],{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone,controls:[control]});
    expect(c.behavior_profile.habits[0]!.status).toBe('suspended');
    expect(c.behavior_profile.warning).toBeDefined();
    expect(confirmDevice(c).observations).toEqual([]);
    c.answers=[];c.run.purchases=[];
    c.behavior_profile=safeBehaviorProfile(rows,{customerId:c.run.customer_id,scope:'local',asOf:c.event.authorization.timestamp,timezone:c.config.parameters.timezone,controls:[{...control,sequence:-1}]});
    expect(c.behavior_profile.warning).toBeDefined();
    expect(assess(c).behavior_learning?.applied_filter_ids).toEqual([]);
    expect(confirmDevice(c).observations).toEqual([]);
  });
  it('requires a final platform acceptance after an attributed human resolution',()=>{
    const c=context(),observation={...learned()[0]!,scope:'live' as const,authorization_id:c.event.authorization.authorization_id};
    const entry={id:c.event.authorization.authorization_id,event:c.event,intent:{operation:'resolve',decision:'approve',actor_id:observation.actor_id},accepted:{decision:'approve'},history:[{kind:'human_revalidated',details:{evidence:[{type:'confirmed_habit_observation',observation}]}}]} as unknown as LiveEntry;
    expect(liveHabitObservations([entry])).toEqual([observation]);
    expect(liveHabitObservations([{...entry,accepted:null}])).toEqual([]);
    expect(liveHabitObservations([{...entry,accepted:{...entry.accepted!,decision:'decline'}}])).toEqual([]);
    expect(liveHabitObservations([{...entry,intent:{...entry.intent!,operation:'decision'}}])).toEqual([]);
    expect(liveHabitObservations([{...entry,intent:{...entry.intent!,actor_id:'other'}}])).toEqual([]);
  });
});
