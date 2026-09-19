import { DEFAULT_BEHAVIOR_PARAMETERS } from '../../../contracts/src/behavior.js';
import type { BehaviorObservation, BehaviorProfile, HabitFilterId } from '../../../contracts/src/behavior.js';
import type { Assessment, FilterResult, SimRun } from '../../../contracts/src/simulation.js';
import type { LiveEntry } from '../simulation/viseca-worker.js';
import { result, type EvaluationContext } from '../simulation/common.js';
import { buildBehaviorProfile, habitContext } from './behavior-profile.js';
import type { BuildBehaviorProfileOptions } from './behavior-profile.js';

/** Learning is optional: an inconsistent profile must restore ordinary checks,
 * not prevent hard-rule evaluation or invent a trusted habit. */
export function safeBehaviorProfile(observations:readonly BehaviorObservation[],options:BuildBehaviorProfileOptions):BehaviorProfile {
  try{return buildBehaviorProfile(observations,options);}
  catch{
    // Positive evidence may be damaged while explicit restrictions are valid.
    // Preserve those restrictions; if controls themselves cannot be rebuilt,
    // warning disables BOTH suppression and new positive feedback below.
    let baseline:BehaviorProfile;
    try{baseline=buildBehaviorProfile([],options);}
    catch{baseline=buildBehaviorProfile([],{...options,controls:[],parameters:DEFAULT_BEHAVIOR_PARAMETERS});}
    return {...baseline,warning:'Habit evidence was inconsistent. Standard checks remain active; habit learning is paused for this check.'};
  }
}

const reasons: Record<HabitFilterId, string> = {
  C15: 'C15_DEVICE_CONFIRMATION_REQUIRED',
  C18: 'C18_UNUSUAL_TIME',
  C19: 'C19_COUNTRY_CONFIRMATION_REQUIRED',
};
const eligible = (id:string):id is HabitFilterId => Object.hasOwn(reasons,id);

/** Records are candidates until the enclosing authorization is finally approved.
 * Neither automatic approvals nor a generic cancellation are training labels. */
export function applyLearnedHabits(ctx:EvaluationContext, results:FilterResult[]):Assessment['behavior_learning'] {
  if(ctx.config.parameters.learn_confirmed_habits!==true)return undefined;
  const p=ctx.config.parameters,customerId=ctx.event.mandate.customer_id;
  const candidate=ctx.behavior_profile;
  const scope=ctx.behavior_scope??'local';
  const profile:BehaviorProfile=candidate&&candidate.scope===scope&&candidate.customer_id===customerId&&Date.parse(candidate.as_of)===Date.parse(ctx.event.authorization.timestamp)&&candidate.timezone===new Intl.DateTimeFormat('en',{timeZone:p.timezone}).resolvedOptions().timeZone
    ?candidate:buildBehaviorProfile([],{customerId,scope,asOf:ctx.event.authorization.timestamp,timezone:p.timezone});
  const confirmations:BehaviorObservation[]=[],applied_filter_ids:HabitFilterId[]=[];
  if(profile.warning)return {enabled:true,profile:structuredClone(profile),applied_filter_ids,confirmations};
  for(let index=0;index<results.length;index++){
    const r=results[index]!;
    if(!eligible(r.filter_id)||!r.reasons.some(reason=>reason.code===reasons[r.filter_id as HabitFilterId]))continue;
    // A customer-selected time window is a mandatory review, not a learned habit.
    if(r.filter_id==='C18'&&p.time_review!==null)continue;
    const key=habitContext(r.filter_id,ctx.event,p.timezone);if(key===null)continue;
    const contextHabit=profile.habits.find(h=>h.filter_id===r.filter_id&&h.context_key===key);
    if(contextHabit?.status==='suspended')continue;
    const confirmed=ctx.answers.find(answer=>answer.kind==='confirm_risk'&&answer.value==='confirm'&&answer.fact_key===r.reasons[0]?.fact_key&&answer.offer_hash===ctx.offer_hash&&answer.config_revision===ctx.config.revision&&Date.parse(answer.expires_at)>Date.parse(ctx.now)&&answer.actor.authenticated_by_server===true&&answer.actor.role==='simulated_human'&&answer.actor.channel==='local_ui'&&answer.actor.customer_id===customerId);
    if(confirmed&&r.outcome==='pass'){
      confirmations.push({customer_id:customerId,scope:profile.scope,source_id:`${ctx.pack.pack_version}:${ctx.event.authorization.source_authorization_id}${r.filter_id==='C18'?`:${profile.timezone}`:''}`,authorization_id:ctx.event.authorization.authorization_id,filter_id:r.filter_id,context_key:key,occurred_at:ctx.event.authorization.timestamp,recorded_at:ctx.now,actor_id:confirmed.actor.actor_id});
      continue;
    }
    const habit=contextHabit?.learned?contextHabit:undefined;
    if(r.outcome!=='needs_review'||!habit)continue;
    const parameters=(profile.parameters??DEFAULT_BEHAVIOR_PARAMETERS)[r.filter_id];
    const adapted=result(r.filter_id,'pass',`${r.filter_id}_CONFIRMED_HABIT`,'This context matches a habit you explicitly confirmed.',{context_key:key,distinct_days:habit.distinct_days,effective_count:habit.effective_count,last_confirmed_at:habit.last_confirmed_at,profile_version:profile.version,parameter_version:profile.parameter_version,algorithm_version:profile.algorithm_version},`At least ${parameters.min_distinct_days} distinct days and ${parameters.min_effective_count} effective confirmations`,{source_type:'human_review',source_ref:profile.version,field:r.filter_id,kind:'review_signal'});
    adapted.evidence[0]!.method='confirmed-habits-v1';
    results[index]=adapted;applied_filter_ids.push(r.filter_id);
  }
  return {enabled:true,profile:structuredClone(profile),applied_filter_ids,confirmations};
}

/** Existing durable decision records are the source of truth. Rebuilding the
 * profile after a restart therefore cannot lose feedback or count it twice. */
export function localHabitObservations(runs:readonly SimRun[]):BehaviorObservation[] {
  return runs.flatMap(run=>run.purchases.flatMap(p=>{
    const final=p.assessments.at(-1),learning=final?.behavior_learning;
    if(final?.decision!=='approve'||final.execution_state!=='approved'||!learning?.enabled)return [];
    return learning.confirmations.filter(o=>o.scope==='local'&&o.customer_id===run.customer_id&&o.authorization_id===p.event.authorization.authorization_id);
  }));
}

export function liveHabitObservations(entries:readonly LiveEntry[]):BehaviorObservation[] {
  return entries.flatMap(entry=>{
    // An HTTP success, a pending step-up, or an automatic approval is insufficient.
    if(entry.accepted?.decision!=='approve'||entry.intent?.operation!=='resolve'||entry.intent.decision!=='approve')return [];
    const review=entry.history.filter(h=>h.kind==='human_revalidated').at(-1);
    const evidence=(review?.details as {evidence?:unknown[]}|undefined)?.evidence;
    if(!Array.isArray(evidence))return [];
    return evidence.flatMap(value=>{
      if(!value||typeof value!=='object'||!('type' in value)||value.type!=='confirmed_habit_observation'||!('observation' in value))return [];
      const o=value.observation as BehaviorObservation;
      return o&&o.scope==='live'&&o.customer_id===entry.event.mandate.customer_id&&o.authorization_id===entry.id&&o.actor_id===entry.intent?.actor_id?[o]:[];
    });
  });
}
