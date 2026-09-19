import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import type { BehaviorObservation } from '../../../contracts/src/behavior.js';
import type { SimulationDocument } from '../../../contracts/src/simulation.js';
import {safeBehaviorProfile} from './learned-habits.js';
import type {BuildBehaviorProfileOptions} from './behavior-profile.js';

export function behaviorSourceKey(o:BehaviorObservation):string {
  return JSON.stringify([o.scope,o.customer_id,o.filter_id,o.source_id]);
}

/** Stable knowledge order survives rebuilds, retries, forgotten contexts and replays. */
export function synchronizeBehaviorJournal(state:SimulationDocument, observations:readonly BehaviorObservation[]):BehaviorJournal {
  const journal=state.behavior_journal??={schema_version:1,sequence:0,observations:[],controls:[]};
  const seen=new Map(journal.observations.map(o=>[behaviorSourceKey(o),o]));
  // Legacy imports have no provable historic arrival order. Import them now in a
  // deterministic order; never use their assigned sequence to rewrite past decisions.
  for(const observation of [...observations].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at)||behaviorSourceKey(a).localeCompare(behaviorSourceKey(b)))){
    const key=behaviorSourceKey(observation),previous=seen.get(key);
    if(previous){
      if(previous.context_key!==observation.context_key||Date.parse(previous.occurred_at)!==Date.parse(observation.occurred_at)){
        const invalid=journal.invalid_profiles??=[];
        if(!invalid.some(p=>p.customer_id===observation.customer_id&&p.scope===observation.scope))invalid.push({customer_id:observation.customer_id,scope:observation.scope,reason:'Conflicting source feedback. Habit learning is paused; standard checks remain active.'});
      }
      continue;
    }
    const saved={...structuredClone(observation),sequence:++journal.sequence};
    journal.observations.push(saved);seen.set(key,saved);
  }
  return journal;
}

export function journalBehaviorProfile(journal:BehaviorJournal,options:BuildBehaviorProfileOptions){
  const invalid=journal.invalid_profiles?.find(p=>p.customer_id===options.customerId&&p.scope===options.scope);
  const profile=safeBehaviorProfile(invalid?[]:journal.observations,{...options,controls:journal.controls,availableThroughSequence:journal.sequence});
  return invalid?{...profile,warning:invalid.reason}:profile;
}

export function validateBehaviorJournal(journal:BehaviorJournal|undefined):void {
  if(journal===undefined)return;
  if(journal.schema_version!==1||!Number.isSafeInteger(journal.sequence)||journal.sequence<0||!Array.isArray(journal.observations)||!Array.isArray(journal.controls))throw Error('behavior_journal_invalid');
  if(journal.invalid_profiles!==undefined&&(!Array.isArray(journal.invalid_profiles)||journal.invalid_profiles.some(p=>!p.customer_id||!['local','live'].includes(p.scope)||!p.reason)))throw Error('behavior_journal_invalid_profiles');
  if(journal.reviews!==undefined&&!Array.isArray(journal.reviews))throw Error('behavior_journal_reviews_invalid');
  const entries=[...journal.observations,...journal.controls,...(journal.reviews??[])].sort((a,b)=>(a.sequence??0)-(b.sequence??0));
  if(entries.length!==journal.sequence||entries.some((entry,index)=>entry.sequence!==index+1))throw Error('behavior_journal_sequence_invalid');
  const keys=new Set<string>();
  for(const observation of journal.observations){
    const key=behaviorSourceKey(observation);if(keys.has(key))throw Error('behavior_journal_duplicate_source');keys.add(key);
    if(!['local','live'].includes(observation.scope)||!['C15','C18','C19'].includes(observation.filter_id)||!observation.customer_id||!observation.actor_id||!observation.context_key||!observation.source_id||!observation.authorization_id||!Number.isFinite(Date.parse(observation.occurred_at))||!Number.isFinite(Date.parse(observation.recorded_at)))throw Error('behavior_journal_observation_invalid');
  }
  for(const control of journal.controls)if(!['local','live'].includes(control.scope)||!['C15','C18','C19'].includes(control.filter_id)||!['forget','suspend','resume'].includes(control.action)||!control.customer_id||!control.actor_id||!control.context_key||!Number.isFinite(Date.parse(control.at)))throw Error('behavior_journal_control_invalid');
  for(const review of journal.reviews??[])if(!['local','live'].includes(review.scope)||!['C15','C18','C19'].includes(review.filter_id)||!['confirmed','rejected'].includes(review.verdict)||!review.customer_id||!review.actor_id||!review.context_key||!review.source_id||!review.authorization_id||!Number.isFinite(Date.parse(review.at)))throw Error('behavior_journal_review_invalid');
}
