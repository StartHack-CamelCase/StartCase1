import {journalBehaviorProfile} from '../learning/behavior-journal.js';
import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import { assessBehaviorLearningComparison } from '../learning/behavior-evaluation.js';
import type { EvaluationContext } from './common.js';
import type { DataPack } from '../../../contracts/src/data.js';
import type { AuthorizationEvent } from '../../../contracts/src/event.js';
import type { HardRule, MandateRecord } from '../../../contracts/src/policy.js';
import type { Assessment, HumanAnswer, SafetyConfig, SimRun } from '../../../contracts/src/simulation.js';
import { hash, offerHash } from './common.js';
import { assess } from './evaluator.js';
import { safeBehaviorProfile, liveHabitObservations } from '../learning/learned-habits.js';
import { validateParameters, suggestConfig, assertNoWeakening } from './config.js';
import type { Evaluation, LiveEntry } from './viseca-worker.js';

export type LiveBinding={config:SafetyConfig;live_mandate_id:string;scenario_id:string;hard_rules:HardRule[];history_hash:string;pack_version:string};
/** Verify saved consent and its reference data without reinterpreting source
 * text. Historical terminal sessions must retain the policy actually signed. */
export function validatePersistedLiveBinding(value:unknown,pack:DataPack):LiveBinding {
 const b=value as LiveBinding;if(!b||!b.config||b.config.status!=='confirmed'||!b.config.confirmed_by||!b.live_mandate_id||!b.scenario_id||!Array.isArray(b.hard_rules)||b.config.requirements.some(r=>r.status!=='confirmed')||b.config.instruction_hash!==hash(b.config.instruction))throw Error('live_confirmed_binding_required');
 if((b.config.parameters.manual_review_requirements??[]).some(requirement=>!b.config.instruction.includes(requirement.source_excerpt)))throw Error('live_confirmed_binding_required');
 validateParameters(b.config.parameters);if(b.history_hash!==hash(pack.history)||b.pack_version!==pack.pack_version)throw Error('live_reference_pack_changed');return structuredClone(b);
}
export function validateLiveBinding(value:unknown,pack:DataPack):LiveBinding {
 const b=validatePersistedLiveBinding(value,pack);
 const proposal=suggestConfig({instruction:b.config.instruction,hard_rules:b.hard_rules,interpretation:{},mandate_id:b.live_mandate_id,version:b.config.mandate_version} as MandateRecord,b.config.created_at);if(proposal.requirements.some(r=>r.filter_ids.includes('G06')&&r.parameter_keys.length===0))throw Error('live_unsupported_rule');assertNoWeakening(proposal.parameters,b.config.parameters);return b;
}
/** Pure projection: only remote final approvals become commitments. Unknown submissions reserve. */
export function evaluateLive(pack:DataPack,binding:LiveBinding,event:AuthorizationEvent,runId:string,entries:LiveEntry[],now:string,answers:HumanAnswer[]=[],habitEntries:readonly LiveEntry[]=entries,behaviorJournal?:BehaviorJournal):Evaluation {
 const fail=(code:string):Evaluation=>({decision:null,reason_codes:[code],customer_message:'A required check is unavailable. Verify the confirmed permissions and purchase data.'});
 if(event.mandate.mandate_id!==binding.live_mandate_id||event.authorization.scenario_id!==binding.scenario_id||event.mandate.instruction!==binding.config.instruction||event.mandate.uncertainty_policy!=='ask'||hash(event.mandate.hard_rules)!==hash(binding.hard_rules))return fail('G05_LIVE_SNAPSHOT_MISMATCH');
 const first=entries[0];if(first&&hash(first.event.mandate)!==hash(event.mandate))return fail('G05_LIVE_SNAPSHOT_CHANGED');
 const source=pack.attempts.find(a=>a.authorization_id===event.authorization.source_authorization_id);if(!source||source.scenario_id!==binding.scenario_id)return fail('C01_SOURCE_PROVENANCE_MISSING');
 const config={...structuredClone(binding.config),mandate_id:binding.live_mandate_id};const history=structuredClone(pack.history);const dates=history.map(h=>h.timestamp).sort();
 const run:SimRun={schema_version:1,scope:'local_simulation',run_id:runId,run_key:runId,scenario_id:binding.scenario_id,customer_id:event.mandate.customer_id,card_id:event.mandate.card_id,authority_id:source.authority_id,mandate_snapshot:structuredClone(event.mandate),mandate_version:config.mandate_version,config,budget_scope_id:runId,status:'active',next_index:entries.length,revision:entries.length,history,history_hash:binding.history_hash,history_coverage:{from:dates[0]!,to:dates.at(-1)!,rows:history.length},purchases:[],commitments:[],reservations:[],audit:[],created_at:now};
 for(const entry of entries){if(entry.id===event.authorization.authorization_id)continue;const a=entry.event.authorization;const ledger={authorization_id:entry.id,amount_chf:String(a.billing_amount_chf),timestamp:a.timestamp,quantity:a.items.reduce((n,i)=>n+i.quantity,0),budget_scope_id:runId};
  if(entry.accepted?.decision==='approve')run.commitments.push(ledger);
  else if(reservesLiveCapacity(entry))run.reservations.push({...ledger,offer_hash:offerHash(entry.event,config),expires_at:'9999-12-31T00:00:00.000Z'});
  const previous=entry.proposal?.snapshot as Assessment|undefined;if(previous?.schema_version===1&&Array.isArray(previous.results)){const final=structuredClone(previous);final.execution_state=entry.accepted?.decision==='approve'?'approved':entry.accepted?.decision==='decline'?'declined':entry.state==='awaiting_human'?'awaiting_user':'technical_hold';run.purchases.push({event:entry.event,assessments:[final],answers:[]});}
 }
 const behaviorOptions={customerId:event.mandate.customer_id,scope:'live' as const,asOf:event.authorization.timestamp,timezone:config.parameters.timezone};
 const behavior_profile=config.parameters.learn_confirmed_habits===true?(behaviorJournal?journalBehaviorProfile(behaviorJournal,behaviorOptions):safeBehaviorProfile(liveHabitObservations(habitEntries),behaviorOptions)):undefined;
 const ctx:EvaluationContext={behavior_scope:'live',...(behavior_profile?{behavior_profile}:{}),pack,event,config,run,now,offer_hash:offerHash(event,config),answers,phase:'commit'};const a=assess(ctx);if(a.behavior_learning)a.behavior_learning.comparison=assessBehaviorLearningComparison(ctx,a);
 return {decision:a.can_finalize?'approve':a.decision,reason_codes:a.results.flatMap(r=>r.reasons.filter(reason=>reason.effect!=='none').map(reason=>reason.code)),customer_message:a.results.flatMap(r=>r.reasons.filter(reason=>reason.effect!=='none').map(reason=>reason.message)).join('\n')||'All required purchase checks passed.',evidence:a.evidence,snapshot:a};
}

/** A platform step-up reserves the request, but a purchase held by C12 never
 * acquired spending capacity. It must not deadlock the purchase ahead of it.
 * Unknown or dispatched approvals retain capacity until platform reconciliation. */
export function reservesLiveCapacity(entry:LiveEntry):boolean {
 if(!entry.reserved)return false;
 if(entry.state!=='awaiting_human'||entry.accepted?.decision!=='step_up'||entry.intent?.decision==='approve')return true;
 const assessment=entry.proposal?.snapshot as Assessment|undefined;
 const capacity=assessment?.results?.find(result=>result.filter_id==='C12');
 return !(capacity&&['needs_review','not_evaluated'].includes(capacity.outcome)&&capacity.reasons.some(reason=>reason.code==='C12_BUDGET_RESERVED_ELSEWHERE'));
}
