import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { BehaviorProfileService } from './behavior-profile-service.js';
import { liveHabitObservations } from '../learning/learned-habits.js';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';
import type { DataPack } from '../../../contracts/src/data.js';
import type { HumanActor, HumanAnswer, Assessment, SimRun } from '../../../contracts/src/simulation.js';
import type { WalletMode, WalletPreparation, WalletRunView } from '../../../contracts/src/wallet.js';
import { AppError } from '../../../contracts/src/errors.js';
import { asId } from '../../../contracts/src/ids.js';
import { hash, offerHash, result } from '../simulation/common.js';
import { validateParameters } from '../simulation/config.js';
import { evaluateLive, type LiveBinding } from '../simulation/live-engine.js';
import type { PolicyService } from './policy-service.js';
import type { SimulationService } from '../simulation/service.js';
import type { InstructionDecodingService } from './instruction-decoding-service.js';
import { WalletStore } from '../storage/wallet-store.js';
import { preparePermissions, applyParameters, hardRulesFromParameters, permissionSummary, validateMonetaryInterpretations } from './wallet-preparation.js';
import { SerialExecutor } from './serial-executor.js';
import type { LiveEntry } from '../simulation/viseca-worker.js';
import { LiveSessionService } from './live-session-service.js';
import { liveConnectionFromEnv, type LiveConnectionOptions } from './live-configuration.js';

// Version of local permission compilation, independent of the model prompt.
export const WALLET_PERMISSION_COMPILER_VERSION='wallet-permissions-merged-v13';
type Dependencies={pack:DataPack;policies:PolicyService;simulations:SimulationService;instructions:InstructionDecodingService};
export type LiveHumanResponse={authorization_id:string;decision:'approve'|'decline';offer_hash?:string;expected_revision?:number;answers:Array<{question_id:string;value:string;source_ref?:string;source_excerpt?:string}>};
export type HumanResponseRecovery={status:'settled'|'abandoned'|'pending';result?:WalletRunView};
export class WalletService {
 private readonly store:WalletStore;
 readonly live:LiveSessionService;
 readonly behavior:BehaviorProfileService;
 private readonly confirmations=new SerialExecutor();
 private readonly humanResponses=new SerialExecutor();
 private readonly preparing=new Set<Promise<void>>();
 private readonly timer:ReturnType<typeof setInterval>;
 private closed=false;
 private readonly lastTransport=new Map<string,204|200>();
 private readonly localErrors=new Map<string,string>();
 constructor(private readonly runtime:Dependencies,stateDir:string,private readonly now=()=>new Date(),autoInterval=1800,private readonly connection:LiveConnectionOptions=liveConnectionFromEnv()){
  this.store=new WalletStore(join(stateDir,'wallet.sqlite'));
  const environment=connection.environment==='mock'?'mock':'remote';
  const liveStateDir=environment==='remote'&&hasLegacyLiveSessions(stateDir)?stateDir:join(stateDir,`live-${environment}`);
  this.live=new LiveSessionService(runtime.pack,{...connection,...(connection.environment==='disabled'?{baseUrl:'',apiKey:''}:{}),stateDir:liveStateDir,behaviorJournal:entries=>runtime.simulations.behaviorJournal(liveHabitObservations(entries))});
  this.behavior=new BehaviorProfileService(runtime.pack,runtime.simulations,()=>this.live.learningEntries(),()=>this.listRuns(),now);
  for(const p of this.store.list())if(p.status==='processing'){p.status='failed';p.error='Preparation was interrupted. Decode the instruction again when you are ready.';this.store.save(p);}
  this.timer=setInterval(()=>this.tick(),autoInterval);this.timer.unref();
 }
 async initialize():Promise<void>{await this.live.initialize();this.linkRestoredStarts();}
 private liveEnvironmentMatches(p:WalletPreparation):boolean{return p.mode!=='live'||(p.live_environment??'remote')===(this.connection.environment==='mock'?'mock':'remote');}
 private linkRestoredStarts():void{for(const p of this.store.list()){if(p.mode!=='live'||!this.liveEnvironmentMatches(p)||!p.confirmation||p.confirmation.run_id)continue;const start=this.live.getStart(`${p.preparation_id}:live`);if(start?.stage==='running'){p.confirmation.run_id=start.session_id;p.confirmation.mandate_id=start.mandate_id;this.store.save(p);}}}
 apiStarts(){return this.live.listStarts().map(start=>({...start,preparation_id:this.store.list().find(p=>`${p.preparation_id}:live`===start.key)?.preparation_id??null}));}
 async reconcilePreparation(id:string,actor:HumanActor){const p=this.store.get(id);this.assertOwner(actor,p.scenario_id);if(p.mode!=='live'||!p.confirmation)throw new AppError(409,'live_start_not_found','There is no submitted API start to check.');await this.live.reconcileStarts();this.linkRestoredStarts();return {preparation_id:id,run_id:this.store.get(id).confirmation?.run_id??null,start:this.live.getStart(`${id}:live`)??null};}
 options(){const sample=this.runtime.pack.scenarios[0]!;const info=this.runtime.instructions.get(sample.scenario_id);return {scenarios:this.runtime.pack.scenarios.map(s=>({scenario_id:s.scenario_id,scenario_name:s.scenario_name,instruction:s.cardholder_instruction})),model:info.model,ai_configured:info.configured,live_configured:this.live.configured(),live_environment:this.live.configured()?(this.connection.environment??'remote'):'disabled'};}
 actorCustomer(scenarioId:string):string{const first=this.runtime.pack.attemptsByScenario.get(asId(scenarioId))?.[0];const c=first&&this.runtime.pack.authoritiesById.get(first.authority_id)?.customer_id;if(!c)throw new AppError(404,'scenario_not_found','Choose one of the supplied scenarios.');return c;}
 prepare(input:{scenario_id:string;instruction:string;mode:WalletMode},key:string):WalletPreparation {
  this.actorCustomer(input.scenario_id);if(!input.instruction.trim()||input.instruction.length>8000)throw new AppError(400,'instruction_invalid','Enter an instruction between 1 and 8,000 characters.');
  if(input.mode==='live'&&!this.live.configured())throw new AppError(503,'live_not_configured','Viseca access is not configured. You can use local simulation now.');
  const id='WALLET_PREP_'+hash(key).slice(0,32);const existing=this.store.list().find(p=>p.preparation_id===id);
  if(existing){if(!this.liveEnvironmentMatches(existing))throw new AppError(409,'preparation_environment_mismatch','Prepare new permissions for the selected API environment.');if(existing.instruction!==input.instruction||existing.mode!==input.mode||existing.scenario_id!==input.scenario_id)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','This request key belongs to another instruction.');return this.refreshPreparation(existing);}
  const p:WalletPreparation={preparation_id:id,...input,...(input.mode==='live'?{live_environment:this.connection.environment==='mock'?'mock' as const:'remote' as const}:{}),status:'processing',model:this.runtime.instructions.get(asId(input.scenario_id)).model,error:null,config:null,permissions:[],clarifications:[],warnings:[],decoding:null,created_at:this.now().toISOString()};this.store.save(p);
  const work=this.finishPreparation(p);this.preparing.add(work);void work.finally(()=>this.preparing.delete(work));return structuredClone(p);
 }
 getPreparation(id:string):WalletPreparation{return this.refreshPreparation(this.store.get(id));}
 private failedPreparation(p:WalletPreparation,message:string):WalletPreparation {
  p.status='failed';p.error=message;p.config=null;p.permissions=[];p.clarifications=[];p.warnings=[];p.amount_review_requirement=null;
  p.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;this.store.save(p);return p;
 }
 private refreshPreparation(p:WalletPreparation):WalletPreparation {
  // Only unconfirmed reviews may be recompiled; saved consent and AI evidence stay immutable.
  if(p.status!=='ready'||p.confirmation)return p;
  if(!p.decoding||p.warnings.some(w=>w.startsWith('AI decoding was unavailable: '))||p.clarifications.some(c=>c.key==='unresolved:decoding'))return this.failedPreparation(p,'This saved preparation did not complete OpenAI decoding. Retry decoding to prepare permissions.');
  if(p.compiler_version===WALLET_PERMISSION_COMPILER_VERSION)return p;
  const previousConfig=p.config;
  Object.assign(p,preparePermissions(this.runtime.pack,p.instruction,p.decoding,previousConfig?.created_at??p.created_at));
  if(previousConfig&&p.config)p.config.config_id=previousConfig.config_id;
  p.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;this.store.save(p);return p;
 }
 private async finishPreparation(p:WalletPreparation):Promise<void>{try{
  const view=this.runtime.instructions.getForInstruction(asId(p.scenario_id),p.instruction);
  if(!view.configured)throw new AppError(503,'instruction_decoding_unavailable','OpenAI decoding is not configured. Configure OpenAI before preparing permissions.');
  p.decoding=await this.runtime.instructions.decodeText(asId(p.scenario_id),p.instruction,true);
  Object.assign(p,preparePermissions(this.runtime.pack,p.instruction,p.decoding,this.now().toISOString()));p.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;p.status='ready';this.store.save(p);
 }catch(error){this.failedPreparation(p,error instanceof AppError?error.message:'OpenAI decoding did not complete. Your instruction is saved; retry decoding.');}}
 async confirm(id:string,values:Record<string,unknown>,actor:HumanActor,expectedMode?:WalletMode,amountInterpretations:unknown={}):Promise<{run_id:string;mandate_id:string;mode:WalletMode}>{return this.confirmations.run(async()=>{
  const saved=this.store.get(id);this.assertOwner(actor,saved.scenario_id);const p=this.refreshPreparation(saved);if(p.status!=='ready')throw new AppError(409,'permission_review_not_ready',p.status==='failed'?'OpenAI decoding must succeed before you can confirm permissions. Retry decoding.':'Wait until the OpenAI permission review is ready.');
  if(!p.decoding&&!p.confirmation?.run_id)throw new AppError(409,'permission_review_not_ready','OpenAI decoding must succeed before starting a new run. Retry decoding.');
  if(!this.liveEnvironmentMatches(p))throw new AppError(409,'preparation_environment_mismatch','Prepare new permissions for the selected API environment.');
  if(expectedMode!==undefined&&p.mode!==expectedMode)throw new AppError(409,'preparation_mode_mismatch','The selected mode changed. Prepare and review the permissions again.');
  const parameters=applyParameters(p,values,this.runtime.pack,amountInterpretations);const meanings=validateMonetaryInterpretations(p,amountInterpretations);const monetaryConsent=Object.keys(meanings).length?{amount_interpretations:meanings}:{};const fingerprint=hash({parameters,actor_id:actor.actor_id,...monetaryConsent});
  // Older consent predates min_order_chf. Compare a normalized copy without
  // rewriting the signed parameters or their original fingerprint.
  if(p.confirmation&&p.confirmation.fingerprint!==fingerprint&&hash({parameters:validateParameters(p.confirmation.parameters),actor_id:p.confirmation.actor_id,...(p.confirmation.amount_interpretations?{amount_interpretations:p.confirmation.amount_interpretations}:{})})!==fingerprint)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','These permissions were already confirmed with different choices.');
  if(p.confirmation?.run_id)return {run_id:p.confirmation.run_id,mandate_id:p.confirmation.mandate_id!,mode:p.mode};
  p.confirmation??={fingerprint,parameters,actor_id:actor.actor_id,...monetaryConsent};this.store.save(p);
  const hard_rules=hardRulesFromParameters(parameters);const draftId=asId<'LOCAL_PD'>('LOCAL_PD_WALLET_'+hash(id).slice(0,24));
  // The local policy record mirrors the reviewed instruction in both modes;
  // the scenario selects proposals, while the mandate defines permissions.
  const draft=await this.runtime.policies.createDraft(p.scenario_id,{instruction:p.instruction,hard_rules,uncertainty_policy:'ask',guidance:permissionSummary(parameters).map(x=>`${x.label}: ${x.value}. ${x.description}`),open_questions:[]},p.decoding??undefined,{localCustomInstruction:true,draftId:draftId as never});p.confirmation.draft_id=draft.draft_id;this.store.save(p);
  const mandate=await this.runtime.policies.confirmDraft(draft.draft_id,'local_user');p.confirmation.mandate_id=mandate.mandate_id;this.store.save(p);
  const config=this.runtime.simulations.suggest(mandate.mandate_id,`${id}:config`);
  const current=this.runtime.simulations.configs(mandate.mandate_id).find(c=>c.config_id===config.config_id)!;
  const confirmed=current.status==='confirmed'?current:this.runtime.simulations.confirm(config.config_id,parameters,config.requirements.map(r=>r.requirement_id),actor,`${id}:confirm`);p.confirmation.config_id=confirmed.config_id;this.store.save(p);
  if(p.mode==='live'){try{const live=await this.live.start({config:confirmed,scenario_id:p.scenario_id,instruction:p.instruction,hard_rules,confirmed_by:actor.actor_id},`${id}:live`);p.confirmation.run_id=live.session_id;p.confirmation.mandate_id=live.mandate_id;}catch(error){throw liveRequestError(error);}}
  else p.confirmation.run_id=this.runtime.simulations.create(confirmed.config_id,`${id}:run`).run_id;
  this.store.save(p);return {run_id:p.confirmation.run_id,mandate_id:p.confirmation.mandate_id,mode:p.mode};
 });}
 tick():void{if(this.closed)return;for(const p of this.store.list()){const id=p.confirmation?.run_id;if(!id||p.mode!=='local')continue;try{const r=this.runtime.simulations.get(id);if(r.status!=='active')continue;const result=this.runtime.simulations.next(id,`auto:${id}:${r.next_index}`);this.lastTransport.set(id,result.assessment?200:204);this.localErrors.delete(id);}catch(error){this.localErrors.set(id,error instanceof AppError?error.code:'local_processing_failed');}}}
 listRuns():WalletRunView[]{const preps=this.store.list().filter(p=>p.confirmation?.run_id&&this.liveEnvironmentMatches(p));return preps.map(p=>this.getRun(p.confirmation!.run_id!));}
 getRun(id:string):WalletRunView {
  const p=this.store.list().find(p=>p.confirmation?.run_id===id);
  if(p?.mode==='live'){
   if(!this.liveEnvironmentMatches(p))throw new AppError(409,'wallet_environment_mismatch','This run belongs to another API environment.');
   const session=this.live.get(id);const config=this.runtime.simulations.configs(p.config?.mandate_id??'').find(c=>c.config_id===p.confirmation!.config_id)??this.runtime.simulations.store.select(state=>state.configs.find(c=>c.config_id===p.confirmation!.config_id))!;
   const now=this.now();
   const pending=session.entries.some(e=>e.state==='awaiting_human'&&Date.parse(e.human_expires_at??'')>now.getTime());
   const binding:LiveBinding={config:{...config,mandate_id:session.mandate_id},live_mandate_id:session.mandate_id,scenario_id:p.scenario_id,hard_rules:hardRulesFromParameters(config.parameters),history_hash:hash(this.runtime.pack.history),pack_version:this.runtime.pack.pack_version};
   const habits=pending?this.live.learningEntries():[];
   const journal=pending?this.runtime.simulations.behaviorJournal(liveHabitObservations(habits)):undefined;
   const assessments=new Map(session.entries.map(entry=>{
    if(entry.state!=='awaiting_human'||Date.parse(entry.human_expires_at??'')<=now.getTime())return [entry.id,liveAssessment(entry,now.getTime())] as const;
    const current=evaluateLive(this.runtime.pack,binding,entry.event,session.run_id,session.entries,now.toISOString(),[],habits,journal).snapshot as Assessment|undefined;
    return [entry.id,current?pendingLiveAssessment(entry,current,now.getTime()):unavailableLiveAssessment(entry,now.getTime())] as const;
   }));
   return {run_id:id,server_time:this.now().toISOString(),has_more_proposals:!['completed','cancelled','failed','revoked'].includes(session.status),platform_run_id:session.run_id,mode:'live',status:session.status,mandate_status:session.mandate_status,mandate_id:session.mandate_id,scenario_id:p.scenario_id,approved_chf:session.entries.filter(e=>e.accepted?.decision==='approve').reduce((n,e)=>n.add(e.event.authorization.billing_amount_chf),new Decimal(0)).toFixed(2),reservations:session.entries.filter(e=>e.reserved).length,config,audit:session.entries.flatMap(e=>e.history.map(h=>({sequence:0,at:h.at,scenario_timestamp:e.event.authorization.timestamp,actor:e.intent?.actor_id??'server',event:h.kind,authorization_id:e.id,assessment_id:null,filter_ids:[],details:h.details,correlation_id:e.id}))).sort((a,b)=>a.at.localeCompare(b.at)).map((a,i)=>({...a,sequence:i+1})),transport:{environment:this.connection.environment??'remote',last_status:session.last_poll_status,last_error:session.last_error??null,note:this.connection.environment==='mock'?'Local API emulator. No requests are sent to Viseca. Final approvals count only after API acceptance.':'Viseca API. Final approvals count only after platform acceptance.'},purchases:session.entries.map(e=>{const a=e.event.authorization;return {authorization_id:e.id,merchant_id:a.merchant.merchant_id,merchant_name:a.merchant.merchant_name,amount_chf:String(a.billing_amount_chf),currency:a.currency,description:a.purchase_description,items:a.items,assessment:assessments.get(e.id)??null,platform_status:e.state};})};
  }
  const r=this.runtime.simulations.get(id);return this.localView(r);
 }
 private localView(r:SimRun):WalletRunView{const waiting=r.purchases.some(p=>p.assessments.at(-1)?.execution_state==='awaiting_user');return {run_id:r.run_id,server_time:this.now().toISOString(),has_more_proposals:r.status==='active',mode:'local',status:r.status==='revoked'?'revoked':this.localErrors.has(r.run_id)?'suspended':waiting?'awaiting_customer':r.status,mandate_id:r.config.mandate_id,scenario_id:r.scenario_id,approved_chf:r.commitments.reduce((n,c)=>n.add(c.amount_chf),new Decimal(0)).toFixed(2),reservations:r.reservations.length,config:r.config,audit:r.audit,transport:{last_status:this.lastTransport.get(r.run_id)??null,last_error:this.localErrors.get(r.run_id)??null,note:'Automatic local replay of the official synthetic purchases. No remote payment is executed.'},purchases:r.purchases.map(p=>{const a=p.event.authorization;return {authorization_id:a.authorization_id,merchant_id:a.merchant.merchant_id,merchant_name:a.merchant.merchant_name,amount_chf:String(a.billing_amount_chf),currency:a.currency,description:a.purchase_description,items:a.items,assessment:p.assessments.at(-1)??null};})};}
 async revoke(id:string,actor:HumanActor,key:string):Promise<WalletRunView>{const view=this.getRun(id);this.assertOwner(actor,view.scenario_id);if(view.mode==='live')await this.live.revoke(id);else{await this.runtime.policies.revokeMandate(view.mandate_id);this.runtime.simulations.revokeMandate(view.mandate_id,key);}return this.getRun(id);}
 /** Inspect the durable result without resubmitting a platform decision. A tombstone
  * prevents a request lost before receipt from arriving after a replacement. */
 async reconcileLiveResponse(id:string,input:LiveHumanResponse,actor:HumanActor,key:string):Promise<HumanResponseRecovery>{return this.humanResponses.run(async()=>{
  if(this.closed)throw new AppError(503,'wallet_closed','The wallet is restarting. Check this saved response again.');
  const view=this.getRun(id);this.assertOwner(actor,view.scenario_id);
  if(view.mode!=='live')throw new AppError(409,'live_response_required','This response belongs to an API run.');
  const fingerprint=hash({id,input,actor_id:actor.actor_id,customer_id:actor.customer_id});
  const command=this.store.response(key);
  if(command&&command.fingerprint!==fingerprint)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','This request key belongs to another response.');
  if(command?.abandoned)return {status:'abandoned'};
  if(command?.result)return {status:'settled',result:command.result};
  const entry=this.live.get(id).entries.find(e=>e.id===input.authorization_id);
  const submitted=command&&entry?.intent?.operation==='resolve'&&entry.intent.consent_hash===hash([actor.actor_id,command.proof,entry.id,entry.event,entry.snapshot]);
  if(submitted){
   if(entry.state==='accepted'){command.result=view;this.store.saveResponse(command);return {status:'settled',result:view};}
   const reopened=entry.state==='awaiting_human'&&entry.history.some(h=>h.kind==='human_reply_not_finalized'&&(h.details as {intent_id?:string}).intent_id===entry.intent!.id);
   if(!reopened)return {status:'pending'};
  }
  this.store.saveResponse({...command,key,fingerprint,proof:command?.proof??randomUUID(),result:null,abandoned:true});
  return {status:'abandoned'};
 });}
 async respondLive(id:string,input:LiveHumanResponse,actor:HumanActor,key:string):Promise<WalletRunView>{return this.humanResponses.run(async()=>{
  if(this.closed)throw new AppError(503,'wallet_closed','The wallet is restarting. Retry this saved response.');
  const view=this.getRun(id);this.assertOwner(actor,view.scenario_id);const p=this.store.list().find(p=>p.confirmation?.run_id===id)!;const session=this.live.get(id);const config={...view.config,mandate_id:session.mandate_id};
  const fingerprint=hash({id,input,actor_id:actor.actor_id,customer_id:actor.customer_id});
  let command=this.store.response(key);
  if(command&&command.fingerprint!==fingerprint)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','This request key belongs to another response.');
  if(command?.abandoned)throw new AppError(409,'human_response_abandoned','This saved response was abandoned. Use the current purchase review.');
  if(command?.result)return command.result;
  const entry=session.entries.find(e=>e.id===input.authorization_id);
  if(command&&entry?.intent?.operation==='resolve'&&entry.intent.consent_hash===hash([actor.actor_id,command.proof,entry.id,entry.event,entry.snapshot])){
   if(entry.state==='accepted'){
    // Recovery after the platform/outbox committed but before this result was saved.
    command.result=this.getRun(id);this.store.saveResponse(command);return command.result;
   }
   if(entry.state!=='awaiting_human')throw new AppError(503,'human_response_pending','The API result is still being reconciled. Retry this saved response shortly.');
   // Only an authoritative reconciliation can reopen a previously submitted reply.
   if(!entry.history.some(h=>h.kind==='human_reply_not_finalized'&&(h.details as {intent_id?:string}).intent_id===entry.intent!.id))throw new AppError(503,'human_response_pending','The API result is still being reconciled.');
   command.proof=randomUUID();
  }
  command??={key,fingerprint,proof:randomUUID(),result:null};this.store.saveResponse(command);
  const binding:LiveBinding={config,live_mandate_id:session.mandate_id,scenario_id:p.scenario_id,hard_rules:hardRulesFromParameters(config.parameters),history_hash:hash(this.runtime.pack.history),pack_version:this.runtime.pack.pack_version};
  try{await this.live.respond(id,input.authorization_id,input.decision,actor,async()=>({actor_id:actor.actor_id,proof:command.proof}),async entry=>{
   if(input.decision==='decline')return true;
   const latest=evaluateLive(this.runtime.pack,binding,entry.event,session.run_id,this.live.get(id).entries,this.now().toISOString(),[],this.live.learningEntries(),this.runtime.simulations.behaviorJournal(liveHabitObservations(this.live.learningEntries())));
   const current=latest.snapshot as Assessment|undefined;
   if(!current)return false;
   const a=pendingLiveAssessment(entry,current,this.now().getTime());
   if(input.offer_hash!==a.offer_hash||input.expected_revision!==a.revision)throw new AppError(409,'live_offer_changed','This purchase changed. Review its updated details, then choose Accept or Decline.');
   if(a.decision==='deny'||a.technical_filter_ids.length)return false;
   assertLiveAnswerCoverage(a.questions,input.answers);
   const answers:HumanAnswer[]=a.questions.map(q=>{
    const supplied=input.answers.find(x=>x.question_id===q.question_id)!;
    if(!['confirm_risk','confirm_requirement'].includes(q.kind))throw new AppError(422,'purchase_needs_correction','This purchase is waiting for verification. You can decline it now.');
    if(supplied.value!=='confirm')throw new AppError(422,'explicit_confirmation_required','Choose Accept or Decline for this purchase.');
    return {answer_id:randomUUID(),question_id:q.question_id,fact_key:q.fact_key,kind:q.kind,value:'confirm',source_ref:null,source_excerpt:null,actor,offer_hash:offerHash(entry.event,config),config_revision:config.revision,created_at:this.now().toISOString(),expires_at:new Date(Math.min(this.now().getTime()+config.parameters.consent_ttl_seconds*1000,Date.parse(entry.human_expires_at!))).toISOString(),consumed_by:null};
   });
   const verified=evaluateLive(this.runtime.pack,binding,entry.event,session.run_id,this.live.get(id).entries,this.now().toISOString(),answers,this.live.learningEntries(),this.runtime.simulations.behaviorJournal(liveHabitObservations(this.live.learningEntries())));const learned=(verified.snapshot as Assessment|undefined)?.behavior_learning?.confirmations??[];return {approved:verified.decision==='approve',evidence:[...(verified.evidence??[]),...learned.map(observation=>({type:'confirmed_habit_observation',observation}))]};
  });}catch(error){
   if(error instanceof AppError){this.store.removeResponse(key);throw error;}
   const message=error instanceof Error?error.message:'';
   if(['human_resolution_not_pending','human_confirmation_expired','human_resolution_rejected','human_confirmation_used','mandate_revoked','mandate_revocation_pending','live_approval_suspended','live_history_read_only'].includes(message)){this.store.removeResponse(key);throw new AppError(409,message,'This purchase can no longer accept this response. Refresh its current status.');}
   throw new AppError(503,'human_response_pending','The API result is still being reconciled. Retry this saved response shortly.');
  }
  command.result=this.getRun(id);this.store.saveResponse(command);return command.result;
 });}
 private assertOwner(actor:HumanActor,scenarioId:string):void{if(actor.role!=='simulated_human'||!actor.authenticated_by_server||actor.customer_id!==this.actorCustomer(scenarioId))throw new AppError(403,'human_session_required','Open the customer confirmation page before continuing.');}
 async close():Promise<void>{this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.preparing]);await this.live.close();await this.humanResponses.run(async()=>{});this.store.close();}
}

export function liveAssessment(e:LiveEntry,now=Date.now()):Assessment|null {
 const a=e.proposal?.snapshot as Assessment|undefined;if(!a?.schema_version)return null;
 const result=structuredClone(a);if(e.accepted?.decision==='approve'&&result.behavior_learning)result.behavior_learning.confirmations=liveHabitObservations([e]);const final=e.accepted?.decision==='approve'||e.accepted?.decision==='decline';
 const expired=!final&&e.accepted?.decision==='step_up'&&e.human_expires_at!==null&&Date.parse(e.human_expires_at)<=now;
 result.execution_state=e.accepted?.decision==='approve'?'approved':e.accepted?.decision==='decline'?'declined':expired?'expired':e.state==='awaiting_human'?'awaiting_user':'technical_hold';
 if(!final&&!expired&&result.lock&&e.human_expires_at)result.lock.expires_at=e.human_expires_at;
 if(final){result.decision=e.accepted!.decision==='approve'?'approve':'deny';result.questions=[];result.lock=null;result.can_finalize=false;}
 else if(expired){result.decision=null;result.questions=[];result.lock=null;result.can_finalize=false;}
 return result;
}
/** Refresh only the pending view. The original proposal and accepted history stay
 * immutable; consent is bound to the exact current questions, not a stale poll. */
export function unavailableLiveAssessment(entry:LiveEntry,now=Date.now()):Assessment|null {
 const original=entry.proposal?.snapshot as Assessment|undefined;
 if(!original?.schema_version)return null;
 const current=structuredClone(original);
 const hold=result('G06','not_evaluated','G06_PREREQUISITE_UNAVAILABLE','Current purchase verification is unavailable.');
 current.results=current.results.map(check=>check.filter_id==='G06'?hold:check);
 current.technical_filter_ids=[...new Set([...current.technical_filter_ids,'G06' as const])];
 current.questions=[];current.can_finalize=false;current.evaluation_complete=false;
 return pendingLiveAssessment(entry,current,now);
}

export function pendingLiveAssessment(entry:LiveEntry,current:Assessment,now=Date.now()):Assessment {
 const assessment=structuredClone(current);
 if(assessment.can_finalize&&assessment.questions.length===0){
  const fact_key='purchase_confirmation';
  assessment.questions=[{question_id:'Q_'+hash([assessment.offer_hash,fact_key]).slice(0,20),fact_key,kind:'confirm_risk',filter_ids:[],evidence_ids:[],prompt:'Accept this purchase?',offer_hash:assessment.offer_hash,state:'open',answer_id:null}];
  assessment.decision='step_up';
 }
 // No clock, random assessment ID or unrelated card may invalidate this review.
 assessment.revision=parseInt(hash([assessment.offer_hash,assessment.questions.map(q=>[q.question_id,q.kind,q.prompt]),assessment.blocking_filter_ids,assessment.technical_filter_ids]).slice(0,12),16);
 assessment.assessment_id=`${(entry.proposal?.snapshot as Assessment|undefined)?.assessment_id??entry.id}:review:${assessment.revision}`;
 if(!assessment.lock&&entry.human_expires_at)assessment.lock={lock_id:`LOCK_${entry.id}`,kind:'pending_step_up',assessment_id:assessment.assessment_id,offer_hash:assessment.offer_hash,mandate_version:assessment.rule_snapshot.mandate_version,config_revision:assessment.rule_snapshot.config_revision,reason_filter_ids:[],reason_codes:[],evidence_ids:[],question_ids:assessment.questions.map(q=>q.question_id),observed_expected:[],created_at:entry.accepted?.at??assessment.recorded_at,expires_at:entry.human_expires_at,resolution:'answer_typed_questions'};
 const projected=liveAssessment({...entry,proposal:{...entry.proposal,decision:assessment.decision,snapshot:assessment}},now)!;
 if(projected.execution_state==='awaiting_user'&&(assessment.technical_filter_ids.length||assessment.decision==='deny'))projected.execution_state='technical_hold';
 projected.can_finalize=false;
 return projected;
}

function liveRequestError(error:unknown):AppError {
 if(error instanceof AppError)return error;
 const code=error instanceof Error?error.message:'';
 if(/viseca_http_40[13]|viseca_authentication/.test(code))return new AppError(502,'viseca_authentication_failed','The API rejected the team credential. Check the server configuration before trying again.');
 if(code.includes('submission_unknown')||code.includes('requires_reconciliation'))return new AppError(409,'viseca_reconciliation_required','The API may have received this request. Reconcile its result before starting another run.');
 if(code==='live_run_already_active')return new AppError(409,code,'Another API run is active. Finish it before starting another scenario.');
 if(code.includes('not_configured'))return new AppError(503,'live_not_configured','Configure the API connection or start the local API emulator.');
 return new AppError(502,'viseca_request_failed','The API request failed. Saved permissions are preserved; inspect the connection before retrying.');
}

/** A profile change can add a question after the UI was rendered. Never turn an
 * old click into consent for a newly required fact. */
export function assertLiveAnswerCoverage(questions:Assessment['questions'],answers:Array<{question_id:string;value:string}>):void {
 const expected=new Set(questions.map(q=>q.question_id)),provided=new Set(answers.map(a=>a.question_id));
 if(expected.size!==answers.length||provided.size!==answers.length||answers.some(a=>!expected.has(a.question_id))||questions.some(q=>['confirm_risk','confirm_requirement'].includes(q.kind)&&answers.find(a=>a.question_id===q.question_id)?.value!=='confirm'))throw new AppError(409,'G05_QUESTIONS_CHANGED','This purchase changed. Review its updated details, then choose Accept or Decline.');
}

function hasLegacyLiveSessions(stateDir:string):boolean {
 const path=join(stateDir,'live-sessions.sqlite');if(!existsSync(path))return false;
 const database=new DatabaseSync(path,{readOnly:true});
 try{return Number(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.['count']??0)>0||Number(database.prepare('SELECT COUNT(*) AS count FROM starts').get()?.['count']??0)>0;}
 catch{return true;} // Unknown legacy schema must be checked, never silently discarded.
 finally{database.close();}
}
