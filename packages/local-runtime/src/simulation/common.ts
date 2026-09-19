import { createHash } from 'node:crypto';
import type { BehaviorProfile } from '../../../contracts/src/behavior.js';
import { filterMessage } from '../../../contracts/src/filter-messages.js';
import type { DataPack, HistoricalAuthorization } from '../../../contracts/src/data.js';
import type { AuthorizationEvent } from '../../../contracts/src/event.js';
import type { Assessment, Evidence, FilterId, FilterResult, HumanAnswer, Outcome, Reason, SafetyConfig, SimRun } from '../../../contracts/src/simulation.js';
export const ENGINE_VERSION = 'mcg-1.0.1';
export function canonical(value:unknown):string { if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`; if(value && typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')}}`;return JSON.stringify(value)??'null'; }
export function hash(value:unknown):string{return createHash('sha256').update(canonical(value)).digest('hex');}
export type EvaluationContext = {behavior_scope?:'local'|'live';behavior_profile?:BehaviorProfile;pack:DataPack;event:AuthorizationEvent;config:SafetyConfig;run:SimRun;now:string;offer_hash:string;answers:HumanAnswer[];phase:'assess'|'resolve'|'commit';technical_errors?:string[]};
export function hasAnswerOwner(ctx:EvaluationContext,answer:HumanAnswer):boolean {
 return answer.actor?.authenticated_by_server===true&&answer.actor.role==='simulated_human'&&answer.actor.channel==='local_ui'&&answer.actor.customer_id===ctx.event.mandate.customer_id;
}
/** Enforce the consent boundary in the shared engine as well as HTTP services.
 * Evidence, risk consent and learned feedback must have the same provenance. */
export function isUsableAnswer(ctx:EvaluationContext,answer:HumanAnswer):boolean {
 return hasAnswerOwner(ctx,answer)&&answer.offer_hash===ctx.offer_hash&&answer.config_revision===ctx.config.revision&&answer.question_id==='Q_'+hash([ctx.offer_hash,answer.fact_key]).slice(0,20)&&answer.consumed_by===null&&Date.parse(answer.created_at)<=Date.parse(ctx.now)&&Date.parse(answer.expires_at)>Date.parse(ctx.now);
}
export const REVIEW_IDS = new Set<FilterId>(['M01','M17','M20','C08','C13','C15','C16','C18','C19','C20','C22','C24','C25']);
export function result(id:FilterId,outcome:Outcome,code:string,message:string,observed:unknown=null,expected:unknown=null,options:Partial<{source_type:Evidence['source_type'];author:string;source_ref:string;field:string;excerpt:string;kind:FilterResult['kind'];resolution:Reason['resolution_kind'];fact_key:string;required:boolean;depends_on:FilterId[];coverage:FilterResult['coverage']}>= {}):FilterResult {
  if(outcome==='fail'&&REVIEW_IDS.has(id))throw new Error(`Review-only filter cannot fail: ${id}`);
  const evidence:Evidence={id:`EV_${hash([id,code,observed,expected,options]).slice(0,20)}`,source_type:options.source_type??'event',source_ref:options.source_ref??code,field:options.field??id,source_hash:hash([observed,expected,options.excerpt]),excerpt:options.excerpt??null,observed,expected,method:ENGINE_VERSION,author:options.author??null};
  const effect=outcome==='fail'?'deny':outcome==='needs_review'?'step_up':outcome==='not_evaluated'&&options.required!==false?'technical_hold':'none';
  return {filter_id:id,domain:id.startsWith('M')?'merchant':id.startsWith('C')?'customer':'guard',kind:options.kind??(REVIEW_IDS.has(id)?'review_signal':id.startsWith('G')||id==='M19'?'integrity':'hard_requirement'),phase_expected:['assess'],phase_evaluated:'assess',required_at_current_phase:options.required??true,outcome,coverage:options.coverage??'available',reasons:[{code,message:filterMessage(id,code,observed,expected),effect,certainty:outcome==='fail'||outcome==='pass'?'established':outcome==='not_evaluated'?'unavailable':'uncertain',evidence_ids:[evidence.id],requirement_ids:[],resolution_kind:options.resolution??(outcome==='fail'?'replace_quote':outcome==='not_evaluated'?'retry_or_repair':outcome==='needs_review'?'provide_evidence':'none'),fact_key:options.fact_key??id}],evidence:[evidence],question_ids:[],depends_on:options.depends_on??[],algorithm_version:ENGINE_VERSION};
}
export function na(id:FilterId,message='No restriction of this type confirmed.'):FilterResult{return result(id,'not_applicable',`${id}_NOT_APPLICABLE`,message,null,null,{required:false,kind:'information'});}
export function pass(id:FilterId,message='Criterion verified.',observed:unknown=null,expected:unknown=null):FilterResult{return result(id,'pass',`${id}_SATISFIED`,message,observed,expected);}
export function customerHistory(ctx:EvaluationContext):HistoricalAuthorization[]{const t=Date.parse(ctx.event.authorization.timestamp);return ctx.run.history.filter(h=>h.customer_id===ctx.event.mandate.customer_id&&h.transaction_type==='purchase'&&h.status==='approved'&&Date.parse(h.timestamp)<t);}
export function lastAssessment(run:SimRun,id:string):Assessment|undefined{return run.purchases.find(p=>p.event.authorization.authorization_id===id)?.assessments.at(-1);}
export function offerHash(event:AuthorizationEvent,config:SafetyConfig):string {const {authorization:a,mandate}=event;const {replay_order:_,recent_attempt_count_10m:__,spend_in_period_before_chf:___,...offer}=a;return hash({offer:{...offer,items:[...a.items].sort((x,y)=>x.line_no-y.line_no)},mandate,config_id:config.config_id,config_revision:config.revision});}
