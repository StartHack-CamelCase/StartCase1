import { randomUUID } from 'node:crypto';
import { ACTIVE_FILTER_IDS, GUARD_FILTER_IDS, type Assessment, type FilterResult, type Question, type Reason } from '../../../contracts/src/simulation.js';
import { ENGINE_VERSION, hash, hasAnswerOwner, isUsableAnswer, na, offerHash, pass, result, type EvaluationContext } from './common.js';
import { evaluateMerchant } from './merchant.js';
import { evaluateCustomer } from './customer.js';
import { applyLearnedHabits } from '../learning/learned-habits.js';

/** Only offer facts the customer can personally verify may become an attestation.
 * Identity, payment capability, history and contradictory contract terms still
 * require system verification or a corrected quote. */
function offerAttestationPrompt(ctx:EvaluationContext,reason:Reason):string|null {
 const p=ctx.config.parameters,line=Number(/:(\d+)$/.exec(reason.fact_key)?.[1]);
 const item=ctx.event.authorization.items.find(i=>i.line_no===line);
 const subject=item?`item ${item.line_no} “${item.item_name}”`:'every item in this purchase';
 switch(reason.code){
  case 'M09_ITEM_CATEGORY_UNRESOLVED':return p.allowed_item_categories?.length?`Confirm that ${subject} belongs to an allowed category: ${p.allowed_item_categories.join(' or ')}.`:null;
  case 'M10_PRODUCT_TYPE_UNRESOLVED':return p.product_type?`Confirm that ${subject} is the requested ${p.product_type.replaceAll('_',' ')}.`:null;
  case 'M11_ATTRIBUTE_MISSING':case 'M11_VARIANT_SELECTION_REQUIRED':case 'M11_ATTRIBUTE_CONFLICT':{
   const attribute=p.attributes.find(a=>reason.fact_key===`M11:${a.name}:${line}`);
   if(!attribute)return null;
   const unit=attribute.unit??(attribute.name==='size'&&p.numeric_size_convention!=='shared_numeric'?p.numeric_size_convention:null);
   return `Confirm that the selected variant of ${subject} has ${attribute.name==='inches'?'screen size':attribute.name}: ${attribute.values.join(' or ')}${unit?' '+unit:''}.`;
  }
  case 'M13_RETURN_TERMS_UNCLEAR':return p.min_return_days===null?null:`Confirm that ${subject} can be returned for at least ${p.min_return_days} days.`;
  case 'M14_CANCELLATION_CONDITION_UNVERIFIED':return p.require_cancellation?'Confirm that this specific purchase can be cancelled.':null;
  case 'M15_DELIVERY_TERMS_MISSING':return p.delivery_deadline?`Confirm that delivery of this purchase is promised no later than ${p.delivery_deadline}.`:null;
  default:return null;
 }
}

function applyPurchaseAttestations(ctx:EvaluationContext,results:FilterResult[]):void {
 for(const r of results){
  if(r.outcome!=='needs_review')continue;
  for(const reason of r.reasons){
   if(reason.effect!=='step_up')continue;
   const prompt=offerAttestationPrompt(ctx,reason);
   if(prompt&&(reason.resolution_kind==='provide_evidence'||reason.resolution_kind==='choose_variant')){
    reason.resolution_kind='confirm_requirement';reason.message=`${prompt} Accept only if you have verified this requirement for the current offer; otherwise decline.`;
   }else if(reason.code==='M16_RECURRING_CONSENT_MISSING'&&!ctx.config.parameters.forbid_recurring){
    reason.resolution_kind='confirm_risk';reason.message='Confirm that you explicitly authorize the subscription or recurring charges disclosed in this specific offer. Otherwise decline.';
   }else if(reason.code==='M13_RETURN_TERMS_CONFLICT'||reason.code==='M16_RECURRING_TERMS_CONFLICT')reason.resolution_kind='replace_quote';
   if(reason.resolution_kind!=='confirm_risk'&&reason.resolution_kind!=='confirm_requirement')continue;
   const answer=ctx.answers.find(a=>a.fact_key===reason.fact_key&&a.kind===reason.resolution_kind&&a.value==='confirm');
   if(!answer)continue;
   const evidence={id:`EV_${hash(['customer_attestation',answer.answer_id,r.filter_id,reason.code]).slice(0,20)}`,source_type:'human_review' as const,source_ref:answer.answer_id,field:reason.fact_key,source_hash:hash(answer),excerpt:null,observed:{attestation:'confirm',question_id:answer.question_id,offer_hash:answer.offer_hash,confirmed_at:answer.created_at},expected:r.evidence.filter(e=>reason.evidence_ids.includes(e.id)).map(e=>e.expected),method:'customer_attestation',author:answer.actor.actor_id};
   r.evidence.push(evidence);reason.evidence_ids.push(evidence.id);reason.effect='none';
   // The customer authorizes this exact offer; no absent number, variant or
   // external source is manufactured and uncertain evidence remains uncertain.
   reason.message+=' Customer attestation recorded for this exact offer.';
  }
  if(!r.reasons.some(reason=>reason.effect==='step_up'))r.outcome='pass';
 }
}

export function aggregate(results:FilterResult[]):{decision:Assessment['decision'];state:Assessment['execution_state'];blocking:string[];doubts:string[];technical:string[]} {
 const blocking=results.filter(r=>r.outcome==='fail'&&r.reasons.some(v=>v.effect==='deny'&&v.certainty==='established')).map(r=>r.filter_id);
 const doubts=results.filter(r=>r.outcome==='needs_review').map(r=>r.filter_id);
 const technical=results.filter(r=>r.outcome==='not_evaluated'&&r.required_at_current_phase).map(r=>r.filter_id);
 return {decision:blocking.length?'deny':doubts.length?'step_up':null,state:blocking.length?'declined':technical.length?'technical_hold':doubts.length?'awaiting_user':'evaluating',blocking,doubts,technical};
}
export function assess(ctx:EvaluationContext):Assessment {
 const suppliedAnswers=ctx.answers;
 const invalidOwner=suppliedAnswers.some(answer=>!hasAnswerOwner(ctx,answer));
 const invalidScope=suppliedAnswers.some(answer=>!isUsableAnswer(ctx,answer));
 ctx={...ctx,answers:suppliedAnswers.filter(answer=>isUsableAnswer(ctx,answer))};
 const merchants=evaluateMerchant(ctx);const results=[...merchants,...evaluateCustomer(ctx,merchants)];
 applyPurchaseAttestations(ctx,results);
 const behavior_learning=applyLearnedHabits(ctx,results);
 const guards:FilterResult[]=[pass('G01','Request received under an idempotency key.'),pass('G02','Offer and mandate fingerprint verified.',ctx.offer_hash),ctx.answers.length?pass('G03','Author and ownership verified by the simulated human channel.'):na('G03','No human response used at this phase.'),ctx.answers.length?pass('G04','Responses are unused, valid, and linked to this offer.'):na('G04','No consent to consume at this phase.'),result('G05','not_evaluated','G05_COMMIT_PENDING','Finalization will be atomic.',null,null,{required:false}),ctx.technical_errors?.length?result('G06','not_evaluated','G06_PREREQUISITE_UNAVAILABLE','A technical dependency is unavailable.',ctx.technical_errors):pass('G06','Contracts and dependencies verified.'),result('G07','not_evaluated','G07_COMMIT_PENDING','Report and audit will be recorded together.',null,null,{required:false}),pass('G08','Aggregation without scoring or compensation.')];
 if(invalidOwner)guards[2]=result('G03','not_evaluated','G03_HUMAN_CHANNEL_REQUIRED','A response lacks authenticated customer ownership.',suppliedAnswers.filter(answer=>!hasAnswerOwner(ctx,answer)).map(answer=>({answer_id:answer.answer_id,actor:answer.actor})),{customer_id:ctx.event.mandate.customer_id,role:'simulated_human',channel:'local_ui',authenticated_by_server:true});
 if(invalidScope)guards[3]=result('G04','not_evaluated','G04_RESPONSE_INVALID','A response is expired, consumed, future-dated or bound to another offer, question or configuration.',suppliedAnswers.filter(answer=>!isUsableAnswer(ctx,answer)).map(answer=>({answer_id:answer.answer_id,question_id:answer.question_id,offer_hash:answer.offer_hash,config_revision:answer.config_revision,created_at:answer.created_at,expires_at:answer.expires_at,consumed_by:answer.consumed_by})),{offer_hash:ctx.offer_hash,config_revision:ctx.config.revision,evaluated_at:ctx.now});
 for(const r of guards){r.phase_expected=r.filter_id==='G05'||r.filter_id==='G07'?['commit']:['assess','resolve','commit'];r.phase_evaluated=r.outcome==='not_evaluated'?null:ctx.phase;}
 results.push(...guards);
 for(const id of ACTIVE_FILTER_IDS)if(!results.some(r=>r.filter_id===id))results.push(result(id,'not_evaluated','G06_REQUIRED_CHECK_MISSING','Required check is missing.'));
 const ids=results.map(r=>r.filter_id);if(new Set(ids).size!==50||ids.length!==50)throw new Error('Invalid control registry: each of the 50 slots must appear once');
 const grouped=new Map<string,Question>();
 for(const r of results){for(const reason of r.reasons){reason.requirement_ids=ctx.config.requirements.filter(req=>req.filter_ids.includes(r.filter_id)).map(req=>req.requirement_id);if(r.outcome!=='needs_review'||reason.effect!=='step_up'||r.filter_id==='C25')continue;const key=reason.fact_key;let q=grouped.get(key);if(!q){q={question_id:'Q_'+hash([ctx.offer_hash,key]).slice(0,20),fact_key:key,kind:reason.resolution_kind,filter_ids:[],evidence_ids:[],prompt:reason.message,offer_hash:ctx.offer_hash,state:'open',answer_id:null};grouped.set(key,q);}q.filter_ids=[...new Set([...q.filter_ids,r.filter_id])];q.evidence_ids=[...new Set([...q.evidence_ids,...reason.evidence_ids])];r.question_ids.push(q.question_id);}}
 const c25=results.find(r=>r.filter_id==='C25')!;if(grouped.size){Object.assign(c25,result('C25','needs_review','C25_CLARIFICATION_REQUIRED','Questions are grouped by fact.',grouped.size,null,{resolution:'provide_evidence'}));c25.question_ids=[...grouped.values()].map(q=>q.question_id);}else Object.assign(c25,pass('C25','No unresolved material question.'));
 const agg=aggregate(results);const assessmentId='ASSESS_'+randomUUID();const previous=ctx.run.purchases.find(p=>p.event.authorization.authorization_id===ctx.event.authorization.authorization_id)?.assessments.at(-1);
 const blocking=results.filter(r=>agg.blocking.includes(r.filter_id)),doubts=results.filter(r=>agg.doubts.includes(r.filter_id)),technical=results.filter(r=>agg.technical.includes(r.filter_id));
 const lockReasons=blocking.length?blocking:technical.length?technical:doubts;
 const evidence=results.flatMap(r=>r.evidence);
 return {...(behavior_learning?{behavior_learning}:{}),schema_version:1,scope:'local_simulation',assessment_id:assessmentId,run_id:ctx.run.run_id,authorization_id:ctx.event.authorization.authorization_id,source_authorization_id:ctx.event.authorization.source_authorization_id,revision:(previous?.revision??0)+1,decision:agg.decision,execution_state:agg.state,evaluation_complete:!technical.length,can_finalize:!blocking.length&&!doubts.length&&!technical.length,rule_snapshot:{mandate_id:ctx.config.mandate_id,mandate_version:ctx.config.mandate_version,config_revision:ctx.config.revision},event_hash:hash(ctx.event),offer_hash:offerHash(ctx.event,ctx.config),facts_hash:hash([ctx.event,suppliedAnswers]),engine_version:ENGINE_VERSION,ledger_revision:ctx.run.revision,results,blocking_filter_ids:blocking.map(r=>r.filter_id),doubt_filter_ids:doubts.map(r=>r.filter_id),technical_filter_ids:technical.map(r=>r.filter_id),evidence,questions:[...grouped.values()],lock:!lockReasons.length?null:{lock_id:'LOCK_'+randomUUID(),kind:blocking.length?'denied_version':technical.length?'technical_hold':'pending_step_up',assessment_id:assessmentId,offer_hash:ctx.offer_hash,mandate_version:ctx.config.mandate_version,config_revision:ctx.config.revision,reason_filter_ids:lockReasons.map(r=>r.filter_id),reason_codes:lockReasons.flatMap(r=>r.reasons.map(v=>v.code)),evidence_ids:lockReasons.flatMap(r=>r.evidence.map(v=>v.id)),question_ids:[...grouped.values()].map(q=>q.question_id),observed_expected:lockReasons.flatMap(r=>r.evidence),created_at:ctx.now,expires_at:blocking.length||technical.length?null:new Date(Date.parse(ctx.now)+ctx.config.parameters.consent_ttl_seconds*1000).toISOString(),resolution:blocking.length?'replace_quote_or_amend_mandate_then_reevaluate':technical.length?'retry_or_repair':'answer_typed_questions'},recorded_at:ctx.now,scenario_timestamp:ctx.event.authorization.timestamp,correlation_id:randomUUID()};
}
export function stampCommitted(assessment:Assessment):void {for(const id of ['G01','G02','G05','G06','G07','G08'] as const){const index=assessment.results.findIndex(r=>r.filter_id===id);const r=pass(id,id==='G07'?'Rapport et audit inscrits dans la même transaction.':'Contrôle final verified.');r.phase_evaluated='commit';r.phase_expected=['commit'];assessment.results[index]=r;}if(assessment.can_finalize){assessment.decision='approve';assessment.execution_state='approved';assessment.can_finalize=false;}}
