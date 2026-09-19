import { liveHabitObservations } from '../learning/learned-habits.js';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';
import type { DataPack } from '../../../contracts/src/data.js';
import type { HumanActor, HumanAnswer, Assessment, SimRun } from '../../../contracts/src/simulation.js';
import type { WalletMode, WalletPreparation, WalletRunView } from '../../../contracts/src/wallet.js';
import { AppError } from '../../../contracts/src/errors.js';
import { asId } from '../../../contracts/src/ids.js';
import { hash, offerHash } from '../simulation/common.js';
import { evaluateLive, type LiveBinding } from '../simulation/live-engine.js';
import type { PolicyService } from './policy-service.js';
import type { SimulationService } from '../simulation/service.js';
import type { InstructionDecodingService } from './instruction-decoding-service.js';
import { WalletStore } from '../storage/wallet-store.js';
import { preparePermissions, applyParameters, hardRulesFromParameters, permissionSummary } from './wallet-preparation.js';
import { SerialExecutor } from './serial-executor.js';
import type { LiveEntry } from '../simulation/viseca-worker.js';
import { LiveSessionService } from './live-session-service.js';

type Dependencies={pack:DataPack;policies:PolicyService;simulations:SimulationService;instructions:InstructionDecodingService};
// Bump when permission compilation or coverage changes, independently of the AI prompt.
export const WALLET_PERMISSION_COMPILER_VERSION='wallet-permissions-v3';
export class WalletService {
 private readonly store:WalletStore;
 readonly live:LiveSessionService;
 private readonly confirmations=new SerialExecutor();
 private readonly preparing=new Set<Promise<void>>();
 private readonly timer:ReturnType<typeof setInterval>;
 private closed=false;
 private readonly lastTransport=new Map<string,204|200>();
 constructor(private readonly runtime:Dependencies,stateDir:string,private readonly now=()=>new Date(),autoInterval=1800){
  this.store=new WalletStore(join(stateDir,'wallet.sqlite'));
  this.live=new LiveSessionService(runtime.pack,{stateDir,baseUrl:process.env['LEASH_BASE_URL']??'',apiKey:process.env['TEAM_API_KEY']??''});
  for(const p of this.store.list())if(p.status==='processing'){p.status='failed';p.error='Preparation was interrupted. Decode the instruction again when you are ready.';this.store.save(p);}
  this.timer=setInterval(()=>this.tick(),autoInterval);this.timer.unref();
 }
 async initialize():Promise<void>{await this.live.initialize();}
 options(){const sample=this.runtime.pack.scenarios[0]!;const info=this.runtime.instructions.get(sample.scenario_id);return {scenarios:this.runtime.pack.scenarios.map(s=>({scenario_id:s.scenario_id,scenario_name:s.scenario_name,instruction:s.cardholder_instruction})),model:info.model,ai_configured:info.configured,live_configured:this.live.configured()};}
 actorCustomer(scenarioId:string):string{const first=this.runtime.pack.attemptsByScenario.get(asId(scenarioId))?.[0];const c=first&&this.runtime.pack.authoritiesById.get(first.authority_id)?.customer_id;if(!c)throw new AppError(404,'scenario_not_found','Choose one of the supplied scenarios.');return c;}
 prepare(input:{scenario_id:string;instruction:string;mode:WalletMode},key:string):WalletPreparation {
  this.actorCustomer(input.scenario_id);if(!input.instruction.trim()||input.instruction.length>8000)throw new AppError(400,'instruction_invalid','Enter an instruction between 1 and 8,000 characters.');
  if(input.mode==='live'){if(!this.live.configured())throw new AppError(503,'live_not_configured','Viseca access is not configured. You can use local simulation now.');if(this.runtime.pack.scenariosById.get(asId(input.scenario_id))!.cardholder_instruction!==input.instruction)throw new AppError(422,'challenge_instruction_mismatch','The hosted challenge requires this scenario’s exact original instruction. Restore it or choose local simulation.');}
  const id='WALLET_PREP_'+hash(key).slice(0,32);const existing=this.store.list().find(p=>p.preparation_id===id);
  if(existing){if(existing.instruction!==input.instruction||existing.mode!==input.mode||existing.scenario_id!==input.scenario_id)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','This request key belongs to another instruction.');return this.refreshPreparation(existing);}
  const p:WalletPreparation={preparation_id:id,...input,status:'processing',model:this.runtime.instructions.get(asId(input.scenario_id)).model,error:null,config:null,permissions:[],clarifications:[],warnings:[],decoding:null,created_at:this.now().toISOString()};this.store.save(p);
  const work=this.finishPreparation(p);this.preparing.add(work);void work.finally(()=>this.preparing.delete(work));return structuredClone(p);
 }
 getPreparation(id:string):WalletPreparation{return this.refreshPreparation(this.store.get(id));}
 private refreshPreparation(p:WalletPreparation):WalletPreparation {
  // Recompile saved reviews locally; confirmed permissions and AI evidence stay immutable.
  if(p.status!=='ready'||p.confirmation||p.compiler_version===WALLET_PERMISSION_COMPILER_VERSION)return p;
  const previousConfig=p.config;
  Object.assign(p,preparePermissions(this.runtime.pack,p.instruction,p.decoding,previousConfig?.created_at??p.created_at));
  if(previousConfig&&p.config)p.config.config_id=previousConfig.config_id;
  p.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;this.store.save(p);return p;
 }
 private async finishPreparation(p:WalletPreparation):Promise<void>{try{
  const view=this.runtime.instructions.getForInstruction(asId(p.scenario_id),p.instruction);
  p.decoding=view.configured?await this.runtime.instructions.decodeText(asId(p.scenario_id),p.instruction,['failed','interrupted'].includes(view.status)||Boolean(view.error)):null;
  Object.assign(p,preparePermissions(this.runtime.pack,p.instruction,p.decoding,this.now().toISOString()));p.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;p.status='ready';this.store.save(p);
 }catch(error){p.status='failed';p.error=error instanceof AppError?error.message:'We could not prepare reliable permissions. Your instruction is saved; please try again.';this.store.save(p);}}
 async confirm(id:string,values:Record<string,unknown>,actor:HumanActor):Promise<{run_id:string;mandate_id:string;mode:WalletMode}>{return this.confirmations.run(async()=>{
  const saved=this.store.get(id);this.assertOwner(actor,saved.scenario_id);const p=this.refreshPreparation(saved);if(p.status!=='ready')throw new AppError(409,'permission_review_not_ready','Wait until the permission review is ready.');
  const parameters=applyParameters(p,values,this.runtime.pack);const fingerprint=hash({parameters,actor_id:actor.actor_id});if(p.confirmation&&p.confirmation.fingerprint!==fingerprint)throw new AppError(409,'G01_IDEMPOTENCY_CONFLICT','These permissions were already confirmed with different choices.');
  if(p.confirmation?.run_id)return {run_id:p.confirmation.run_id,mandate_id:p.confirmation.mandate_id!,mode:p.mode};
  p.confirmation??={fingerprint,parameters,actor_id:actor.actor_id};this.store.save(p);
  const hard_rules=hardRulesFromParameters(parameters);const draftId=asId<'LOCAL_PD'>('LOCAL_PD_WALLET_'+hash(id).slice(0,24));
  const draft=await this.runtime.policies.createDraft(p.scenario_id,{instruction:p.instruction,hard_rules,uncertainty_policy:'ask',guidance:permissionSummary(parameters).map(x=>`${x.label}: ${x.value}. ${x.description}`),open_questions:[]},p.decoding??undefined,{localCustomInstruction:p.mode==='local',draftId:draftId as never});p.confirmation.draft_id=draft.draft_id;this.store.save(p);
  const mandate=await this.runtime.policies.confirmDraft(draft.draft_id,'local_user');p.confirmation.mandate_id=mandate.mandate_id;this.store.save(p);
  const config=this.runtime.simulations.suggest(mandate.mandate_id,`${id}:config`);
  const current=this.runtime.simulations.configs(mandate.mandate_id).find(c=>c.config_id===config.config_id)!;
  const confirmed=current.status==='confirmed'?current:this.runtime.simulations.confirm(config.config_id,parameters,config.requirements.map(r=>r.requirement_id),actor,`${id}:confirm`);p.confirmation.config_id=confirmed.config_id;this.store.save(p);
  if(p.mode==='live'){const live=await this.live.start({config:confirmed,scenario_id:p.scenario_id,instruction:p.instruction,hard_rules,confirmed_by:actor.actor_id},`${id}:live`);p.confirmation.run_id=live.session_id;p.confirmation.mandate_id=live.mandate_id;}
  else p.confirmation.run_id=this.runtime.simulations.create(confirmed.config_id,`${id}:run`).run_id;
  this.store.save(p);return {run_id:p.confirmation.run_id,mandate_id:p.confirmation.mandate_id,mode:p.mode};
 });}
  tick():void{if(this.closed)return;for(const p of this.store.list()){const id=p.confirmation?.run_id;if(!id||p.mode!=='local')continue;try{const r=this.runtime.simulations.get(id);if(r.status!=='active')continue;this.runtime.simulations.next(id,`auto:${id}:${r.next_index}`);this.lastTransport.set(id,200);}catch{this.lastTransport.set(id,204);}}}
 listRuns():WalletRunView[]{const preps=this.store.list().filter(p=>p.confirmation?.run_id);return preps.map(p=>this.getRun(p.confirmation!.run_id!));}
 getRun(id:string):WalletRunView {
  const p=this.store.list().find(p=>p.confirmation?.run_id===id);
  if(p?.mode==='live'){
   const session=this.live.get(id);const config=this.runtime.simulations.configs(p.config?.mandate_id??'').find(c=>c.config_id===p.confirmation!.config_id)??this.runtime.simulations.store.select(state=>state.configs.find(c=>c.config_id===p.confirmation!.config_id))!;
   return {run_id:id,server_time:this.now().toISOString(),has_more_proposals:!['completed','cancelled','failed','revoked'].includes(session.status),platform_run_id:session.run_id,mode:'live',status:session.status,mandate_id:session.mandate_id,scenario_id:p.scenario_id,approved_chf:session.entries.filter(e=>e.accepted?.decision==='approve').reduce((n,e)=>n.add(e.event.authorization.billing_amount_chf),new Decimal(0)).toFixed(2),reservations:session.entries.filter(e=>e.reserved).length,config,audit:session.entries.flatMap(e=>e.history.map(h=>({sequence:0,at:h.at,scenario_timestamp:e.event.authorization.timestamp,actor:e.intent?.actor_id??'server',event:h.kind,authorization_id:e.id,assessment_id:null,filter_ids:[],details:h.details,correlation_id:e.id}))).sort((a,b)=>a.at.localeCompare(b.at)).map((a,i)=>({...a,sequence:i+1})),transport:{last_status:session.last_poll_status,note:'Viseca simulator. Final approvals are counted only after platform acceptance.'},purchases:session.entries.map(e=>{const a=e.event.authorization;return {authorization_id:e.id,merchant_id:a.merchant.merchant_id,merchant_name:a.merchant.merchant_name,amount_chf:String(a.billing_amount_chf),currency:a.currency,description:a.purchase_description,items:a.items,assessment:liveAssessment(e,this.now().getTime()),platform_status:e.state};})};
  }
  const r=this.runtime.simulations.get(id);return this.localView(r);
 }
 private localView(r:SimRun):WalletRunView{const waiting=r.purchases.some(p=>p.assessments.at(-1)?.execution_state==='awaiting_user');return {run_id:r.run_id,server_time:this.now().toISOString(),has_more_proposals:r.status==='active',mode:'local',status:r.status==='revoked'?'revoked':waiting?'awaiting_customer':r.status,mandate_id:r.config.mandate_id,scenario_id:r.scenario_id,approved_chf:r.commitments.reduce((n,c)=>n.add(c.amount_chf),new Decimal(0)).toFixed(2),reservations:r.reservations.length,config:r.config,audit:r.audit,transport:{last_status:this.lastTransport.get(r.run_id)??null,note:'Automatic local replay of the official synthetic purchases. No remote payment is executed.'},purchases:r.purchases.map(p=>{const a=p.event.authorization;return {authorization_id:a.authorization_id,merchant_id:a.merchant.merchant_id,merchant_name:a.merchant.merchant_name,amount_chf:String(a.billing_amount_chf),currency:a.currency,description:a.purchase_description,items:a.items,assessment:p.assessments.at(-1)??null};})};}
 async revoke(id:string,actor:HumanActor,key:string):Promise<WalletRunView>{const view=this.getRun(id);this.assertOwner(actor,view.scenario_id);if(view.mode==='live')await this.live.revoke(id);else{await this.runtime.policies.revokeMandate(view.mandate_id);this.runtime.simulations.revokeMandate(view.mandate_id,key);}return this.getRun(id);}
 async respondLive(id:string,input:{authorization_id:string;decision:'approve'|'decline';answers:Array<{question_id:string;value:string;source_ref?:string;source_excerpt?:string}>},actor:HumanActor):Promise<WalletRunView>{
  const view=this.getRun(id);this.assertOwner(actor,view.scenario_id);if(view.mode!=='live')throw new AppError(409,'wallet_run_mode_mismatch','Use the local simulation response endpoint for this run.');const p=this.store.list().find(p=>p.confirmation?.run_id===id)!;const session=this.live.get(id);const config={...view.config,mandate_id:session.mandate_id};
  const binding:LiveBinding={config,live_mandate_id:session.mandate_id,scenario_id:p.scenario_id,hard_rules:hardRulesFromParameters(config.parameters),history_hash:hash(this.runtime.pack.history),pack_version:this.runtime.pack.pack_version};
  await this.live.respond(id,input.authorization_id,input.decision,actor,async()=>({actor_id:actor.actor_id,proof:randomUUID()}),async entry=>{
   if(input.decision==='decline')return true;
   const latest=evaluateLive(this.runtime.pack,binding,entry.event,session.run_id,this.live.get(id).entries,this.now().toISOString(),[],this.live.learningEntries());const a=latest.snapshot as Assessment|undefined;if(!a||a.decision==='deny'||a.technical_filter_ids.length)return false;
   const answers:HumanAnswer[]=a.questions.map(q=>{const supplied=input.answers.find(x=>x.question_id===q.question_id);if(q.kind!=='confirm_risk'&&(!supplied?.source_ref||!supplied.source_excerpt))throw new AppError(422,'evidence_required',q.prompt);return {answer_id:randomUUID(),question_id:q.question_id,fact_key:q.fact_key,kind:q.kind,value:q.kind==='confirm_risk'?'confirm':supplied!.value,source_ref:supplied?.source_ref??null,source_excerpt:supplied?.source_excerpt??null,actor,offer_hash:offerHash(entry.event,config),config_revision:config.revision,created_at:this.now().toISOString(),expires_at:new Date(this.now().getTime()+config.parameters.consent_ttl_seconds*1000).toISOString(),consumed_by:null};});
   const verified=evaluateLive(this.runtime.pack,binding,entry.event,session.run_id,this.live.get(id).entries,this.now().toISOString(),answers,this.live.learningEntries());const learned=(verified.snapshot as Assessment|undefined)?.behavior_learning?.confirmations??[];return {approved:verified.decision==='approve',evidence:[...(verified.evidence??[]),...learned.map(observation=>({type:'confirmed_habit_observation',observation}))]};
  });return this.getRun(id);
 }
 private assertOwner(actor:HumanActor,scenarioId:string):void{if(actor.role!=='simulated_human'||!actor.authenticated_by_server||actor.customer_id!==this.actorCustomer(scenarioId))throw new AppError(403,'human_session_required','Open the customer confirmation page before continuing.');}
 async close():Promise<void>{this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.preparing]);await this.live.close();this.store.close();}
}

export function liveAssessment(e:LiveEntry,now=Date.now()):Assessment|null{
 const a=e.proposal?.snapshot as Assessment|undefined;if(!a?.schema_version)return null;
 const result=structuredClone(a);if(e.accepted?.decision==='approve'&&result.behavior_learning)result.behavior_learning.confirmations=liveHabitObservations([e]);const final=e.accepted?.decision==='approve'||e.accepted?.decision==='decline';
 const expired=!final&&e.accepted?.decision==='step_up'&&e.human_expires_at!==null&&Date.parse(e.human_expires_at)<=now;
 result.execution_state=e.accepted?.decision==='approve'?'approved':e.accepted?.decision==='decline'?'declined':expired?'expired':e.state==='awaiting_human'?'awaiting_user':'technical_hold';
 if(!final&&!expired&&result.lock&&e.human_expires_at)result.lock.expires_at=e.human_expires_at;
 if(final){result.decision=e.accepted!.decision==='approve'?'approve':'deny';result.questions=[];result.lock=null;result.can_finalize=false;}
 else if(expired){result.decision=null;result.questions=[];result.lock=null;result.can_finalize=false;}
 return result;
}
