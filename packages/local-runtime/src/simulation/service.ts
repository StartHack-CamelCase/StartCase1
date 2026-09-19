import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { DataPack } from '../../../contracts/src/data.js';
import { AppError } from '../../../contracts/src/errors.js';
import type { RunRecord } from '../../../contracts/src/run.js';
import type { Assessment, HumanActor, SafetyConfig, SimPurchase, SimRun, SimulationDocument } from '../../../contracts/src/simulation.js';
import { ACTIVE_FILTER_IDS } from '../../../contracts/src/simulation.js';
import type { PolicyService } from '../services/policy-service.js';
import { AuthorizationEventFactory } from '../data/event-builder.js';
import { hash, offerHash, type EvaluationContext } from './common.js';
import { suggestConfig, validateParameters, assertNoWeakening, hasUnsupportedRule } from './config.js';
import { assess, stampCommitted } from './evaluator.js';
import { SimulationStore } from './store.js';
import { safeBehaviorProfile, localHabitObservations } from '../learning/learned-habits.js';
import { synchronizeBehaviorJournal, validateBehaviorJournal, journalBehaviorProfile } from '../learning/behavior-journal.js';
import { assessBehaviorLearningComparison } from '../learning/behavior-evaluation.js';
import type { BehaviorObservation } from '../../../contracts/src/behavior.js';
import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';

export type SimulationHumanResponse={question_id:string;value:string;source_ref?:string;source_excerpt?:string};
type AssessmentResponseContext={expected_revision:number;offer_hash:string};
export type SimulationHumanResponseBatch=AssessmentResponseContext&{answers:SimulationHumanResponse[]};

export class SimulationService {
 readonly store:SimulationStore;
 constructor(private readonly pack:DataPack,private readonly policies:PolicyService,private readonly factory:AuthorizationEventFactory,path:string,private readonly clock=()=>new Date(),fault?:(point:'before_write'|'after_write'|'after_commit')=>void){this.store=new SimulationStore(path,doc=>this.validateDocument(doc),fault);}
 close():void{this.store.close();}
 behaviorJournal(extra:readonly BehaviorObservation[]=[]):BehaviorJournal {
  const snapshot=this.store.select(state=>({journal:state.behavior_journal,observations:localHabitObservations(state.runs)}));
  const priorHash=hash(snapshot.journal);
  const temporary={behavior_journal:snapshot.journal} as SimulationDocument;
  const observations=[...snapshot.observations,...extra];
  const journal=synchronizeBehaviorJournal(temporary,observations);
  if(hash(journal)!==priorHash)this.store.transaction(`behavior-sync:${hash(observations)}`,{action:'behavior-sync',observations},state=>{synchronizeBehaviorJournal(state,[...localHabitObservations(state.runs),...extra]);return null;});
  return this.store.select(state=>state.behavior_journal??journal);
 }
 list():SimRun[]{return this.store.select(state=>state.runs.map(r=>r.run_id)).map(id=>this.get(id));}
 get(runId:string):SimRun{const r=this.store.select(state=>this.run(state as SimulationDocument,runId));if(!r.purchases.some(p=>{const a=p.assessments.at(-1);return a?.decision==='step_up'&&a.lock?.expires_at&&Date.parse(a.lock.expires_at)<=this.clock().getTime();}))return r;return this.store.transaction(`expiration:${runId}:${r.revision}`,{action:'expire',runId,revision:r.revision},state=>{const run=this.run(state,runId);this.expire(run);return run;});}
 exportConfig(configId:string):unknown{const config=this.store.select(state=>state.configs.find(c=>c.config_id===configId));if(!config||config.status!=='confirmed')throw new AppError(409,'C03_REQUIREMENT_UNRESOLVED','Confirmed configuration required.');this.assertExecutableConfig(config);const mandate=this.policies.getMandate(config.mandate_id);if(mandate.status!=='active'||mandate.version!==config.mandate_version)throw new AppError(409,'G05_REVISION_CONFLICT','Mandate changed or revoked.');return {config,live_mandate_id:null,scenario_id:mandate.source_scenario_id,hard_rules:mandate.hard_rules,history_hash:hash(this.pack.history),pack_version:this.pack.pack_version};}
 configs(mandateId:string):SafetyConfig[]{return this.store.select(state=>state.configs.filter(c=>c.mandate_id===mandateId));}
 suggest(mandateId:string,key:string):SafetyConfig {return this.store.transaction(key,{action:'suggest',mandateId},state=>{const c=suggestConfig(this.policies.getMandate(mandateId),this.now());state.configs.push(c);return c;});}
 confirm(configId:string,parameters:unknown,reviewed:string[],actor:HumanActor,key:string):SafetyConfig {
 return this.store.transaction(key,{action:'confirm',configId,parameters,reviewed,actor},state=>{const c=state.configs.find(c=>c.config_id===configId);if(!c)throw new AppError(404,'CONFIG_NOT_FOUND','Configuration not found.');const mandate=this.policies.getMandate(c.mandate_id);if(mandate.status!=='active'||mandate.version!==c.mandate_version)throw new AppError(409,'G05_REVISION_CONFLICT','The mandate changed. Prepare new permissions.');this.assertOwner(actor,mandate.source_scenario_id);if(mandate.uncertainty_policy!=='ask')throw new AppError(409,'C25_RECONFIRM_REQUIRED','Create and confirm new permissions with the ask policy.');const p=validateParameters(parameters);
 if(c.status==='confirmed')throw new AppError(409,'CONFIG_IMMUTABLE','Confirmed permissions are immutable. Prepare a new version.');this.assertExecutableConfig({...c,parameters:p});
 if(c.requirements.some(r=>!reviewed.includes(r.requirement_id)))throw new AppError(409,'C03_REQUIREMENT_UNRESOLVED','All requirements must be reviewed.');
 const completeManualReview=(p.manual_review_requirements??[]).some(requirement=>requirement.source_excerpt===c.instruction&&requirement.description===c.instruction);
 for(const r of c.requirements){if(r.filter_ids.includes('G06')&&r.parameter_keys.length===0)throw new AppError(409,'G06_RULE_INVALID',r.description);for(const key of r.parameter_keys){const value=p[key as keyof typeof p],original=c.parameters[key as keyof typeof p];if(value===null||(key==='attributes'&&Array.isArray(value)&&!value.length)){const originallyMissing=original===null||(key==='attributes'&&Array.isArray(original)&&!original.length);if(!completeManualReview||!originallyMissing)throw new AppError(409,'C03_REQUIREMENT_UNRESOLVED',`Required parameter to specify: ${key}.`);}}}
 if(c.parameters.max_order_chf!==null&&p.max_order_chf!==null&&new Decimal(p.max_order_chf).gt(c.parameters.max_order_chf))throw new AppError(409,'C03_PERMISSION_AMENDMENT_REQUIRED','The proposed ceiling exceeds the instruction; explicitly amend the mandate.');
 assertNoWeakening(c.parameters,p);
 c.parameters=p;c.requirements=c.requirements.map(r=>({...r,status:'confirmed',question:null,author:actor.actor_id}));c.status='confirmed';c.confirmed_by=actor.actor_id;c.confirmed_at=this.now();return c;});}
 create(configId:string,key:string):SimRun {return this.store.transaction(key,{action:'create',configId},state=>{const c=state.configs.find(c=>c.config_id===configId);if(!c||c.status!=='confirmed')throw new AppError(409,'C03_REQUIREMENT_UNRESOLVED','A fully confirmed configuration is required.');this.assertExecutableConfig(c);const mandate=this.policies.getMandate(c.mandate_id);if(mandate.status!=='active'||mandate.version!==c.mandate_version)throw new AppError(409,'C02_MANDATE_INACTIVE','Mandate changed or revoked.');const attempts=this.pack.attemptsByScenario.get(mandate.source_scenario_id)!;const authority=this.pack.authoritiesById.get(attempts[0]!.authority_id)!;const keyId=randomUUID();const from=this.pack.history.map(h=>h.timestamp).sort();const history=structuredClone(this.pack.history.filter(h=>h.customer_id===authority.customer_id));const run:SimRun={schema_version:1,scope:'local_simulation',run_id:'SIM_'+keyId,run_key:keyId,scenario_id:mandate.source_scenario_id,customer_id:authority.customer_id,card_id:authority.card_id,authority_id:authority.authority_id,mandate_snapshot:{mandate_id:mandate.mandate_id,status:'active',customer_id:authority.customer_id,card_id:authority.card_id,profile_id:`LOCAL_PROFILE_${keyId}` as never,instruction:mandate.instruction,hard_rules:mandate.hard_rules,uncertainty_policy:'ask'},mandate_version:mandate.version,config:structuredClone(c),budget_scope_id:'BUDGET_'+keyId,status:'active',next_index:0,revision:1,history,history_hash:hash(history),history_coverage:{from:from[0]!,to:from.at(-1)!,rows:history.length},purchases:[],commitments:[],reservations:[],audit:[],created_at:this.now()};this.audit(run,'run_started',null,null,{config_id:c.config_id});state.runs.push(run);return run;});}
 next(runId:string,key:string):{run:SimRun;assessment:Assessment|null} {return this.store.transaction(key,{action:'next',runId},state=>{const run=this.run(state,runId);this.assertExecutableConfig(run.config);this.expire(run);if(run.status==='revoked')throw new AppError(409,'C02_MANDATE_INACTIVE','The mandate is revoked.');const attempts=this.pack.attemptsByScenario.get(run.scenario_id as never)!;const attempt=attempts[run.next_index];if(!attempt)return {run,assessment:null};this.checkMandate(run);const skeleton:RunRecord={run_id:run.run_id as never,run_key:run.run_key,scenario_id:run.scenario_id as never,mode:'inspection',mandate_id:run.mandate_snapshot.mandate_id,mandate_version:run.mandate_version,mandate_snapshot:run.mandate_snapshot,fixture_authority_id:run.authority_id as never,customer_id:run.customer_id as never,card_id:run.card_id as never,profile_id:run.mandate_snapshot.profile_id,status:'ready',next_replay_order:run.next_index+1,total_attempts:attempts.length,emitted_count:run.next_index,started_at:run.created_at,finished_at:null,config:{decision_timeout_ms:8000,history_window_minutes:10},pack_version:this.pack.pack_version,engine_version:null,facts_version:null,commands:[]};const event=this.factory.build({attempt,run:skeleton,priorRecords:[],receivedAt:this.clock()}).event;const purchase:SimPurchase={event,assessments:[],answers:[]};run.purchases.push(purchase);run.next_index++;const assessment=this.evaluateInside(run,purchase,state);if(run.next_index===attempts.length)run.status='completed';return {run,assessment};});}
 reevaluate(runId:string,authorizationId:string,revision:number,key:string):{run:SimRun;assessment:Assessment} {return this.store.transaction(key,{action:'reevaluate',runId,authorizationId,revision},state=>{const run=this.run(state,runId);this.expire(run);const purchase=this.purchase(run,authorizationId);const old=purchase.assessments.at(-1)!;if(old.revision!==revision)throw new AppError(409,'G05_REVISION_CONFLICT','The revision changed.');if(old.execution_state==='approved')throw new AppError(409,'G04_CONFIRMATION_ALREADY_USED','This purchase is already authorized.');if(old.execution_state==='cancelled')throw new AppError(409,'G05_PURCHASE_CANCELLED','This purchase was rejected by the customer. A new purchase is required.');this.checkMandate(run);return {run,assessment:this.evaluateInside(run,purchase,state)};});}
 answer(runId:string,authorizationId:string,input:AssessmentResponseContext&SimulationHumanResponse,actor:HumanActor,key:string):{run:SimRun;assessment:Assessment} {
  // Keep the legacy command fingerprint so already committed single-answer retries still replay exactly.
  return this.recordAnswers(runId,authorizationId,input,[input],actor,key,false);
 }
 answerBatch(runId:string,authorizationId:string,input:SimulationHumanResponseBatch,actor:HumanActor,key:string):{run:SimRun;assessment:Assessment} {
  return this.recordAnswers(runId,authorizationId,input,input.answers,actor,key,true);
 }
 private recordAnswers(runId:string,authorizationId:string,input:AssessmentResponseContext,answers:SimulationHumanResponse[],actor:HumanActor,key:string,complete:boolean):{run:SimRun;assessment:Assessment} {
  // Expiry has its own durable transaction, even when a late response is rejected below.
  this.get(runId);
  return this.store.transaction(key,{action:complete?'answer_batch':'answer',runId,authorizationId,input,actor},state=>{
   const run=this.run(state,runId);this.assertExecutableConfig(run.config);this.assertActor(actor,run.customer_id);this.expire(run);
   const purchase=this.purchase(run,authorizationId),old=purchase.assessments.at(-1)!;
   if(old.execution_state==='expired')throw new AppError(409,'G04_CONFIRMATION_EXPIRED','The confirmation expired. Re-evaluate the purchase.');
   if(old.revision!==input.expected_revision)throw new AppError(409,'G05_REVISION_CONFLICT','This assessment changed.');
   if(old.offer_hash!==input.offer_hash)throw new AppError(409,'G02_OFFER_CHANGED','This offer changed.');
   if(old.decision!=='step_up'||old.execution_state==='approved')throw new AppError(409,'G05_REVISION_CONFLICT','This purchase cannot be confirmed.');
   if(!Array.isArray(answers)||answers.length===0)throw new AppError(400,'RESPONSES_INCOMPLETE','Answer every pending question for this purchase.');
   const questions=old.questions.filter(q=>q.state==='open');
   const seen=new Set<string>();
   const checked=answers.map(answer=>{
    if(!answer||typeof answer.question_id!=='string'||typeof answer.value!=='string'||!answer.value.trim())throw new AppError(400,'RESPONSE_INVALID','Each response needs a question and a nonempty value.');
    if(seen.has(answer.question_id))throw new AppError(400,'DUPLICATE_RESPONSE','Provide one response per pending question.');seen.add(answer.question_id);
    const question=questions.find(q=>q.question_id===answer.question_id);
    if(!question)throw new AppError(400,'QUESTION_NOT_FOUND','The response does not match a pending question for this assessment.');
    return {answer,question};
   });
   if(complete&&questions.some(q=>!seen.has(q.question_id)))throw new AppError(400,'RESPONSES_INCOMPLETE','Answer every pending question for this purchase.');
   if(!complete&&checked[0]!.answer.value==='cancel'){this.cancelInside(run,purchase,actor.actor_id,'human_cancelled');return {run,assessment:purchase.assessments.at(-1)!};}
   // Validate the entire batch before recording any consent or audit entry.
   for(const {answer,question} of checked){
    if(question.kind==='amend_mandate'||question.kind==='retry_or_repair')throw new AppError(409,'G06_PREREQUISITE_UNAVAILABLE','This question requires a mandate change or technical repair.');
    if(answer.value==='cancel'||['confirm_risk','confirm_requirement'].includes(question.kind)&&answer.value!=='confirm')throw new AppError(400,'RESPONSE_INVALID','Confirm this purchase, or use its decline action.');
    if(!['confirm_risk','confirm_requirement'].includes(question.kind)&&(!answer.source_ref?.trim()||!answer.source_excerpt?.trim()||['yes','oui','confirm'].includes(answer.value.trim().toLowerCase())))throw new AppError(400,'G06_EVIDENCE_REQUIRED','A yes does not create a fact: provide a source and excerpt.');
   }
   this.checkMandate(run);
   const now=this.now(),expires_at=new Date(Date.parse(now)+run.config.parameters.consent_ttl_seconds*1000).toISOString();
   for(const {answer,question} of checked){
    purchase.answers.push({answer_id:'ANSWER_'+randomUUID(),question_id:question.question_id,fact_key:question.fact_key,kind:question.kind,value:answer.value,source_ref:answer.source_ref??null,source_excerpt:answer.source_excerpt??null,actor,offer_hash:old.offer_hash,config_revision:run.config.revision,created_at:now,expires_at,consumed_by:null});
    this.audit(run,'human_response_recorded',purchase,old,{question_id:question.question_id,actor},actor.actor_id);
   }
   return {run,assessment:this.evaluateInside(run,purchase,state)};
  });
 }
 cancel(runId:string,id:string,actor:HumanActor,key:string):SimRun{return this.store.transaction(key,{action:'cancel',runId,id,actor},state=>{const run=this.run(state,runId);this.assertActor(actor,run.customer_id);const purchase=this.purchase(run,id);if(purchase.assessments.at(-1)?.execution_state==='approved')throw new AppError(409,'G05_FINALIZED','An approved purchase remains in the history.');this.cancelInside(run,purchase,actor.actor_id,'human_cancelled');return run;});}
 revokeMandate(mandateId:string,key:string):void{this.store.transaction(key,{action:'revoke',mandateId},state=>{for(const run of state.runs.filter(r=>r.config.mandate_id===mandateId)){run.status='revoked';run.mandate_snapshot.status='revoked';for(const purchase of run.purchases)if(!['approved','declined','cancelled','expired'].includes(purchase.assessments.at(-1)!.execution_state))this.evaluateInside(run,purchase,state);this.audit(run,'mandate_revoked',null,null,{mandate_id:mandateId});}return null;});}
 useConfig(runId:string,configId:string,key:string,actor:HumanActor):SimRun {
  return this.store.transaction(key,{action:'useConfig',runId,configId,actor},state=>{
   const run=this.run(state,runId);this.assertActor(actor,run.customer_id);this.expire(run);
   const c=state.configs.find(c=>c.config_id===configId);
   if(!c||c.status!=='confirmed'||c.mandate_id!==run.config.mandate_id)throw new AppError(409,'CONFIG_INVALID','Confirmed configuration for the same mandate is required.');
   this.assertExecutableConfig(c);
   const mandate=this.policies.getMandate(c.mandate_id);
   if(mandate.status!=='active'||mandate.version!==c.mandate_version)throw new AppError(409,'C02_MANDATE_INACTIVE','Mandate revoked or changed.');
   // Reapplying the same immutable configuration must preserve pending consent
   // and its capacity. A new configuration rebuilds both in one transaction.
   if(hash(run.config)===hash(c))return run;
   const pending=run.purchases.filter(p=>!['approved','declined','cancelled','expired'].includes(p.assessments.at(-1)!.execution_state));
   run.config=structuredClone(c);run.mandate_version=c.mandate_version;
   for(const purchase of run.purchases)for(const answer of purchase.answers)if(answer.consumed_by===null)answer.expires_at=this.now();
   run.mandate_snapshot={...run.mandate_snapshot,hard_rules:mandate.hard_rules,instruction:mandate.instruction};
   run.reservations=[];this.audit(run,'config_revised',null,null,{config_id:configId,budget_scope_id:run.budget_scope_id});
   for(const purchase of pending)this.evaluateInside(run,purchase,state);
   return run;
  });
 }
 private assertExecutableConfig(config:SafetyConfig):void{
 if((config.parameters.manual_review_requirements??[]).some(requirement=>!config.instruction.includes(requirement.source_excerpt)))throw new AppError(409,'C03_REQUIREMENT_UNRESOLVED','Manual review requirements must quote the confirmed instruction.');
 const mandate=this.policies.getMandate(config.mandate_id);const compiled=suggestConfig(mandate,config.created_at);
 if(hasUnsupportedRule(config)||hasUnsupportedRule(compiled))throw new AppError(409,'G06_RULE_INVALID','A hard rule cannot be enforced by this engine. Update the permissions before starting or approving purchases.');
 assertNoWeakening(compiled.parameters,config.parameters);
 }

 private evaluateInside(run:SimRun,purchase:SimPurchase,state:SimulationDocument):Assessment {
 const now=this.now();const offer_hash=offerHash(purchase.event,run.config);const answers=purchase.answers.filter(a=>a.offer_hash===offer_hash&&a.config_revision===run.config.revision&&Date.parse(a.expires_at)>Date.parse(now)&&a.consumed_by===null);const journal=synchronizeBehaviorJournal(state,localHabitObservations(state.runs));const behavior_profile=run.config.parameters.learn_confirmed_habits===true?journalBehaviorProfile(journal,{customerId:run.customer_id,scope:'local',asOf:purchase.event.authorization.timestamp,timezone:run.config.parameters.timezone}):undefined;const ctx:EvaluationContext={...(behavior_profile?{behavior_profile}:{}),pack:this.pack,event:purchase.event,config:run.config,run,now,offer_hash,answers,phase:'commit'};const assessment=assess(ctx);if(assessment.behavior_learning)assessment.behavior_learning.comparison=assessBehaviorLearningComparison(ctx,assessment);run.revision++;this.audit(run,'assessment_started',purchase,assessment,{});
 run.reservations=run.reservations.filter(r=>r.authorization_id!==assessment.authorization_id);
 if(assessment.can_finalize){stampCommitted(assessment);for(const a of answers)a.consumed_by=assessment.assessment_id;run.commitments.push({authorization_id:assessment.authorization_id,amount_chf:new Decimal(String(purchase.event.authorization.billing_amount_chf)).toFixed(2),timestamp:assessment.scenario_timestamp,quantity:purchase.event.authorization.items.reduce((n,i)=>n+i.quantity,0),budget_scope_id:run.budget_scope_id});this.audit(run,'reservation_committed',purchase,assessment,{amount_chf:purchase.event.authorization.billing_amount_chf});}
 else if(assessment.decision==='step_up'&&assessment.execution_state!=='technical_hold'&&assessment.results.find(r=>r.filter_id==='C12')?.outcome==='pass'){run.reservations.push({authorization_id:assessment.authorization_id,amount_chf:new Decimal(String(purchase.event.authorization.billing_amount_chf)).toFixed(2),timestamp:assessment.scenario_timestamp,quantity:purchase.event.authorization.items.reduce((n,i)=>n+i.quantity,0),budget_scope_id:run.budget_scope_id,offer_hash,expires_at:assessment.lock!.expires_at!});this.audit(run,'reservation_created',purchase,assessment,{});}
 if(assessment.decision==='deny'){for(const a of purchase.answers)if(a.consumed_by===null)a.expires_at=now;this.audit(run,'reservation_released',purchase,assessment,{});}
 purchase.assessments.push(assessment);synchronizeBehaviorJournal(state,localHabitObservations([run]));for(const r of assessment.results)this.audit(run,'filter_evaluated',purchase,assessment,r);this.audit(run,assessment.decision==='step_up'?'step_up_requested':assessment.execution_state==='technical_hold'?'technical_error':'decision_finalized',purchase,assessment,{decision:assessment.decision,state:assessment.execution_state});if(assessment.lock)this.audit(run,'lock_changed',purchase,assessment,assessment.lock);return assessment;
 }
 private expire(run:SimRun):void{for(const p of run.purchases){const a=p.assessments.at(-1);if(a?.decision==='step_up'&&a.lock?.expires_at&&Date.parse(a.lock.expires_at)<=this.clock().getTime())this.cancelInside(run,p,'server','expired');}}
 private cancelInside(run:SimRun,p:SimPurchase,actor:string,event:string):void{const old=p.assessments.at(-1)!;const a:Assessment={...structuredClone(old),assessment_id:'ASSESS_'+randomUUID(),revision:old.revision+1,decision:null,execution_state:event==='expired'?'expired':'cancelled',lock:null,can_finalize:false,recorded_at:this.now()};p.assessments.push(a);for(const answer of p.answers)if(answer.consumed_by===null)answer.expires_at=this.now();run.reservations=run.reservations.filter(r=>r.authorization_id!==a.authorization_id);run.revision++;this.audit(run,event,p,a,{},actor);this.audit(run,'reservation_released',p,a,{});}
 private checkMandate(run:SimRun):void{this.assertExecutableConfig(run.config);const m=this.policies.getMandate(run.config.mandate_id);if(m.status==='revoked'){run.status='revoked';run.mandate_snapshot.status='revoked';}else if(m.version!==run.config.mandate_version)throw new AppError(409,'G05_REVISION_CONFLICT','The mandate changed. Review and confirm new permissions.');}
 private audit(run:SimRun,event:string,p:SimPurchase|null,a:Assessment|null,details:unknown,actor='server'):void{run.audit.push({sequence:run.audit.length+1,at:this.now(),scenario_timestamp:p?.event.authorization.timestamp??null,actor,event,authorization_id:p?.event.authorization.authorization_id??null,assessment_id:a?.assessment_id??null,filter_ids:a?.blocking_filter_ids??[],details,correlation_id:a?.correlation_id??randomUUID()});}
 private assertOwner(actor:HumanActor,scenarioId:string):void{const attempt=this.pack.attemptsByScenario.get(scenarioId as never)?.[0];const customer=attempt?this.pack.authoritiesById.get(attempt.authority_id)?.customer_id:null;this.assertActor(actor,customer??'');}
 private assertActor(actor:HumanActor,customer:string):void{if(actor.role!=='simulated_human'||actor.authenticated_by_server!==true||actor.channel!=='local_ui'||actor.customer_id!==customer)throw new AppError(403,'G03_HUMAN_CHANNEL_REQUIRED','Simulated human channel and matching owner are required.');}
 private run(doc:SimulationDocument,id:string):SimRun{const r=doc.runs.find(r=>r.run_id===id);if(!r)throw new AppError(404,'SIMULATION_NOT_FOUND','Simulation not found.');return r;}
 private purchase(run:SimRun,id:string):SimPurchase{const p=run.purchases.find(p=>p.event.authorization.authorization_id===id);if(!p)throw new AppError(404,'PURCHASE_NOT_FOUND','Purchase not found in this run.');return p;}
 private now():string{return this.clock().toISOString();}
 private validateDocument(doc:SimulationDocument):void {
 validateBehaviorJournal(doc.behavior_journal);
 if(doc.schema_version!==1||!Array.isArray(doc.configs)||!Array.isArray(doc.runs)||!doc.commands)throw new Error('simulation document invalid');
 for(const c of doc.configs){validateParameters(c.parameters);if(hash(c.instruction)!==c.instruction_hash)throw new Error('instruction hash');}
 for(const run of doc.runs){if(hash(run.history)!==run.history_hash)throw new Error('frozen history corrupt');if(run.audit.some((e,i)=>e.sequence!==i+1))throw new Error('audit sequence');const ids=new Set<string>();for(const p of run.purchases){this.factory.validate(p.event);if(ids.has(p.event.authorization.authorization_id))throw new Error('duplicate purchase');ids.add(p.event.authorization.authorization_id);if(p.event.authorization.scenario_id!==run.scenario_id||p.event.mandate.customer_id!==run.customer_id)throw new Error('provenance mismatch');for(const a of p.assessments){if(a.results.length!==50||new Set(a.results.map(r=>r.filter_id)).size!==50||a.results.some(r=>!ACTIVE_FILTER_IDS.includes(r.filter_id)))throw new Error('incomplete assessment');if(a.run_id!==run.run_id||a.authorization_id!==p.event.authorization.authorization_id)throw new Error('assessment provenance');}}
 const committed=new Set<string>();for(const c of run.commitments){if(committed.has(c.authorization_id)||!ids.has(c.authorization_id))throw new Error('commitment identity');committed.add(c.authorization_id);const a=run.purchases.find(p=>p.event.authorization.authorization_id===c.authorization_id)?.assessments.at(-1);if(a?.decision!=='approve')throw new Error('commitment without approval');}for(const r of run.reservations){if(committed.has(r.authorization_id)||!ids.has(r.authorization_id))throw new Error('reservation identity');}}
 }
}
