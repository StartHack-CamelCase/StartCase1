import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DataPack } from "../../../contracts/src/data.js";
import type { SafetyConfig } from "../../../contracts/src/simulation.js";
import type { HardRule } from "../../../contracts/src/policy.js";
import type { AuthorizationEvent } from "../../../contracts/src/event.js";
import { VisecaClient, VisecaHttpError } from "../simulation/viseca-client.js";
import { evaluateLive, validateLiveBinding, validatePersistedLiveBinding, type LiveBinding } from "../simulation/live-engine.js";
import { hash } from "../simulation/common.js";
import { SerialExecutor } from "./serial-executor.js";
import { VisecaOutbox, VisecaWorker, type LiveEntry, type TrustedHuman, type HumanAuthorizer, type Evaluation } from "../simulation/viseca-worker.js";

export type LiveSessionStart = { config: SafetyConfig; scenario_id: string; instruction: string; hard_rules: HardRule[]; confirmed_by: string };
export type LiveMandateStatus = 'active'|'revocation_pending'|'revocation_unknown'|'revoked';
export type LiveSessionView = { session_id: string; mandate_id: string; run_id: string; status: string; mandate_status:LiveMandateStatus; last_poll_status: 204 | 200 | null; last_error:string|null; entries: LiveEntry[] };
export type LiveStartView = { key:string; session_id:string; scenario_id:string; stage:string; status:string; draft_id:string; mandate_id:string; run_id:string; retryable:boolean; last_error:string|null };
type SavedSession = { key:string; fingerprint:string; stage:string; rejected_stage?:string; session_id:string; draft_id?:string; mandate_id:string; mandate_status?:LiveMandateStatus; run_id:string; binding:LiveBinding; human_window_ms:number; status:string; last_poll_status:204|200|null; last_error?:string|null };
type Session = { saved:SavedSession; outbox:VisecaOutbox; worker:VisecaWorker; stop:boolean; recovering:boolean; historical?:boolean; loop?:Promise<void>; reconciliation?:Promise<void>; revocation?:Promise<void>; remoteTerminal?:string };
export type LiveSessionOptions = { baseUrl?: string; apiKey?: string; transport?: (path: string, init?: RequestInit) => Promise<Response>; stateDir: string; behaviorJournal?:(entries:LiveEntry[])=>BehaviorJournal };
const terminal = (status:string) => ['completed','cancelled','failed'].includes(status);

export class LiveSessionService {
  private readonly sessions = new Map<string, Session>();
  private readonly client: VisecaClient;
  private readonly db: DatabaseSync;
  private readonly starts = new SerialExecutor();
  private initialized:Promise<void>|undefined;
  private closed=false;
  private readonly responses=new Set<Promise<unknown>>();
  constructor(private readonly pack: DataPack, private readonly options: LiveSessionOptions) {
    mkdirSync(options.stateDir,{recursive:true});
    this.client=new VisecaClient(options.baseUrl??"",options.apiKey,options.transport);
    this.db=new DatabaseSync(join(options.stateDir,"live-sessions.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS starts (key TEXT PRIMARY KEY, stage TEXT NOT NULL, mandate_id TEXT, run_id TEXT, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL)");
  }
  configured(): boolean { return Boolean(this.options.baseUrl?.trim() && this.options.apiKey?.trim()); }
  initialize():Promise<void>{if(this.closed)return Promise.reject(Error('live_service_closed'));return this.initialized??=this.restore();}
  private savedSessions():SavedSession[]{return this.db.prepare('SELECT body,checksum FROM sessions').all().map(row=>{
    const saved=JSON.parse(String(row['body'])) as SavedSession;
    if(hash(saved)!==row['checksum'])throw Error('live_session_state_corrupt');
    // Older journals combined run and mandate state. Recheck their run on restoration.
    if(!saved.mandate_status){saved.mandate_status=saved.status==='revoked'?'revoked':'active';if(saved.status==='revoked')saved.status='running';}
    return saved;
  });}
  private async restore():Promise<void>{
    const saved=this.savedSessions();
    for(const entry of saved)if(entry.stage==='running')await this.attach(entry,true);
    if(this.configured())for(const entry of saved)if(!['running','rejected','run_ready'].includes(entry.stage))await this.reconcileStart(entry);
  }
  private save(saved:SavedSession):void{this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,checksum=excluded.checksum').run(saved.key,JSON.stringify(saved),hash(saved));}
  private startView(saved:SavedSession):LiveStartView{return {key:saved.key,session_id:saved.session_id,scenario_id:saved.binding.scenario_id,stage:saved.stage,status:saved.status,draft_id:saved.draft_id??'',mandate_id:saved.mandate_id,run_id:saved.run_id,retryable:['rejected','run_ready'].includes(saved.stage),last_error:saved.last_error??null};}
  listStarts():LiveStartView[]{return this.savedSessions().filter(saved=>saved.stage!=='running').map(saved=>this.startView(saved));}
  getStart(key:string):LiveStartView|undefined{const saved=this.savedSessions().find(entry=>entry.key===key);return saved?this.startView(saved):undefined;}
  async reconcileStarts():Promise<LiveStartView[]>{await this.initialize();return this.starts.run(async()=>{
    if(this.closed)throw Error('live_service_closed');
    for(const saved of this.savedSessions())if(!['running','rejected','run_ready'].includes(saved.stage))await this.reconcileStart(saved);
    return this.listStarts();
  });}
  async start(input:LiveSessionStart,key:string):Promise<{session_id:string;mandate_id:string;run_id:string}>{
    await this.initialize();
    return this.starts.run(async()=>{
      if(this.closed)throw Error('live_service_closed');
      if(input.config.status!=="confirmed"||!input.confirmed_by||input.instruction!==input.config.instruction)throw Error("live_confirmed_binding_required");
      const fingerprint=hash(input);let saved=this.savedSessions().find(entry=>entry.key===key);
      if(saved){
        if(saved.fingerprint!==fingerprint)throw Error('live_start_idempotency_conflict');
        if(saved.stage==='running')return this.ids(saved);
        if(!['rejected','run_ready'].includes(saved.stage)){await this.reconcileStart(saved);if(saved.stage==='running')return this.ids(saved);}
        if(!['rejected','run_ready'].includes(saved.stage))throw Error('live_start_submission_unknown_requires_reconciliation');
      }
      if(!this.configured()&&!this.options.transport)throw Error('live_api_not_configured');
      if(this.db.prepare('SELECT key FROM starts WHERE key=?').get(key))throw Error('legacy_live_start_requires_reconciliation');
      if(this.savedSessions().some(entry=>entry.key!==key&&!['running','rejected'].includes(entry.stage)))throw Error('live_start_submission_unknown_requires_reconciliation');
      // A rejected request owns no live run. Completed runs release the team queue even after revocation.
      if([...this.sessions.values()].some(session=>!terminal(session.saved.status)))throw Error('live_run_already_active');
      if(!saved){
        const binding=validateLiveBinding({config:structuredClone(input.config),live_mandate_id:'PENDING',scenario_id:input.scenario_id,hard_rules:input.hard_rules,history_hash:hash(this.pack.history),pack_version:this.pack.pack_version},this.pack);
        const bootstrap=await this.client.prepare();const metadata=payload(bootstrap);if(metadata['pack_version']!==undefined&&metadata['pack_version']!==this.pack.pack_version)throw Error('live_reference_pack_changed');
        const timeouts=VisecaClient.timeouts(bootstrap);
        saved={key,fingerprint,stage:'mandate_intended',session_id:`LIVE_SESSION_${randomUUID()}`,draft_id:'',mandate_id:'',mandate_status:'active',run_id:'',binding,human_window_ms:timeouts.human_window_ms,status:'starting',last_poll_status:null};
      }else{
        if(saved.stage==='rejected')saved.stage=saved.rejected_stage??'mandate_intended';
        if(saved.stage==='run_ready')saved.stage='run_intended';
        saved.status='starting';saved.last_error=null;
      }
      this.save(saved);
      return this.submitStart(saved);
    });
  }
  private async submitStart(saved:SavedSession):Promise<{session_id:string;mandate_id:string;run_id:string}>{
    try{
      if(saved.stage==='mandate_intended'){
        const draft=payload(await this.client.createMandate({instruction:saved.binding.config.instruction,hard_rules:saved.binding.hard_rules,uncertainty_policy:'ask',guidance:[],open_questions:[]}));
        saved.draft_id=identifier(draft['draft_id'],'remote_draft_id_missing');saved.stage='confirmation_intended';this.save(saved);
      }
      if(saved.stage==='confirmation_intended'){
        const draftId=saved.draft_id||saved.mandate_id;
        if(!draftId)throw Error('remote_draft_id_missing');
        const confirmed=payload(await this.client.confirmMandate(draftId,{confirmed:true}));
        saved.mandate_id=identifier(confirmed['mandate_id'],'confirmed_mandate_id_missing');
        saved.binding.live_mandate_id=saved.mandate_id;validateLiveBinding(saved.binding,this.pack);
        saved.stage='run_intended';this.save(saved);
      }
      if(saved.stage!=='run_intended')throw Error('live_start_stage_invalid');
      // Create durable storage before the platform can emit the first purchase.
      const outbox=new VisecaOutbox(join(this.options.stateDir,`${saved.session_id}.sqlite`));
      try{
        await outbox.load();
        const run=payload(await this.client.createRun({scenario_id:saved.binding.scenario_id,mandate_id:saved.mandate_id}));
        saved.run_id=identifier(run['run_id'],'remote_run_id_missing');this.save(saved);
        const worker=this.worker(saved,outbox);await worker.startRun(saved.run_id,saved.binding,saved.human_window_ms);
        saved.stage='running';saved.status='running';saved.last_error=null;this.save(saved);
        const session:Session={saved,outbox,worker,stop:this.closed,recovering:false};this.sessions.set(saved.session_id,session);
        if(!this.closed)this.launch(session);return this.ids(saved);
      }catch(error){outbox.close();throw error;}
    }catch(error){
      saved.last_error=safeError(error);
      if(error instanceof VisecaHttpError&&error.definitivelyRejected){saved.rejected_stage=saved.stage;saved.stage='rejected';saved.status='rejected';}
      else saved.status='submission_unknown';
      this.save(saved);throw error;
    }
  }
  /** Reads only: an ambiguous mutation is never blindly submitted again. */
  private async reconcileStart(saved:SavedSession):Promise<void>{
    if(this.closed)return;
    try{
      const remote=await this.client.reconcile('0');const events=rows(remote.events);
      if(saved.stage==='confirmation_intended'){
        const candidates=new Set(events.filter(row=>row['type']==='mandate.confirmed').map(row=>String(payload(row)['mandate_id']??'')).filter(Boolean));
        const matches:string[]=[];
        for(const id of candidates){const mandate=payload(await this.client.getMandate(id));if(mandate['draft_id']===(saved.draft_id||saved.mandate_id)&&policyMatches(mandate,saved))matches.push(id);}
        if(matches.length===1){saved.mandate_id=matches[0]!;saved.binding.live_mandate_id=saved.mandate_id;saved.stage='run_ready';saved.status='ready';saved.last_error=null;this.save(saved);return;}
        if(matches.length>1)throw Error('live_start_reconciliation_conflict');
      }
      if(saved.stage==='run_intended'){
        const candidates=new Set<string>();if(saved.run_id)candidates.add(saved.run_id);
        for(const row of events){
          const data=payload(row),eventMandate=payload(data['mandate']);
          const mandateId=data['mandate_id']??eventMandate['mandate_id'];
          if(mandateId===saved.mandate_id&&typeof (row['run_id']??data['run_id'])==='string')candidates.add(String(row['run_id']??data['run_id']));
        }
        if(candidates.size>1)throw Error('live_start_reconciliation_conflict');
        if(candidates.size===1){
          const runId=[...candidates][0]!,run=payload(await this.client.getRun(runId));
          if(run['mandate_id']!==saved.mandate_id||run['scenario_id']!==saved.binding.scenario_id)throw Error('live_start_reconciliation_conflict');
          saved.run_id=runId;saved.status='running';saved.last_error=null;this.save(saved);
          await this.attach(saved,true);saved.stage='running';this.save(saved);return;
        }
      }
      saved.status='submission_unknown';saved.last_error='live_start_submission_unknown_requires_reconciliation';this.save(saved);
    }catch(error){saved.status='submission_unknown';saved.last_error=safeError(error);this.save(saved);}
  }
  private ids(saved:SavedSession){return {session_id:saved.session_id,mandate_id:saved.mandate_id,run_id:saved.run_id};}
  private assertSubmissionAllowed(saved:SavedSession,decision:'approve'|'decline'|'step_up'):void{
    if(this.closed)throw Error('live_service_closed');
    if(this.sessions.get(saved.session_id)?.historical)throw Error('live_history_read_only');
    if(decision!=='approve')return;
    const session=this.sessions.get(saved.session_id);
    if(terminal(saved.status)||['queue_conflict','authentication_required','reconciliation_required'].includes(saved.status)||session?.stop||session?.recovering)throw Error('live_approval_suspended');
    if(saved.mandate_status!=='active')throw Error(saved.mandate_status==='revoked'?'mandate_revoked':'mandate_revocation_pending');
  }
  private worker(saved:SavedSession,outbox:VisecaOutbox):VisecaWorker{
    return new VisecaWorker(this.client,outbox,()=>Date.now(),700,decision=>this.assertSubmissionAllowed(saved,decision));
  }
  private async attach(saved:SavedSession,restored=false):Promise<void>{
    if(this.sessions.has(saved.session_id))return;
    const historical=restored&&terminal(saved.status);
    if(historical)validatePersistedLiveBinding(saved.binding,this.pack);else validateLiveBinding(saved.binding,this.pack);
    const outbox=new VisecaOutbox(join(this.options.stateDir,`${saved.session_id}.sqlite`));
    try{
      const stored=await outbox.load();const worker=this.worker(saved,outbox);
      if(historical){
        // Display final history as recorded. startRun performs recovery writes
        // appropriate only for an executable session, not historical consent.
        if(stored.run_id!==saved.run_id||hash(stored.snapshot)!==hash(saved.binding)||stored.human_window_ms!==saved.human_window_ms)throw Error('immutable_live_snapshot_conflict');
      }else await worker.startRun(saved.run_id,saved.binding,saved.human_window_ms);
      const session:Session={saved,outbox,worker,stop:this.closed,recovering:restored,historical};this.sessions.set(saved.session_id,session);
      if(!this.closed&&this.configured()&&!terminal(saved.status))this.launch(session,restored);
    }catch(error){outbox.close();throw error;}
  }
  get(id:string):LiveSessionView{
    const session=this.sessions.get(id);if(!session)throw Error('live_session_not_found');const saved=session.saved;
    const mandateStatus=saved.mandate_status??'active';
    const status=!terminal(saved.status)&&mandateStatus!=='active'?mandateStatus:saved.status;
    return {...this.ids(saved),status,mandate_status:mandateStatus,last_poll_status:saved.last_poll_status,last_error:saved.last_error??null,entries:session.worker.listEntries()};
  }
  learningEntries():LiveEntry[]{return [...this.sessions.values()].flatMap(session=>session.worker.listEntries());}
  list():LiveSessionView[]{return [...this.sessions.keys()].map(id=>this.get(id));}
  async respond(id:string,authorizationId:string,decision:'approve'|'decline',proof:unknown,authorize:HumanAuthorizer,revalidate:(entry:LiveEntry,actor:TrustedHuman,decision:'approve'|'decline')=>Promise<boolean|{approved:boolean;evidence:unknown[]}>):Promise<unknown>{
    const session=this.sessions.get(id);if(!session)throw Error('live_session_not_found');if(this.closed)throw Error('live_service_closed');
    this.assertSubmissionAllowed(session.saved,decision);
    const work=session.worker.resolve(authorizationId,decision,proof,authorize,async(entry,actor,choice)=>{
      this.assertSubmissionAllowed(session.saved,choice);
      return revalidate(entry,actor,choice);
    });
    this.responses.add(work);try{return await work;}finally{this.responses.delete(work);}
  }
  async revoke(id:string):Promise<void>{
    const session=this.sessions.get(id);if(!session)throw Error('live_session_not_found');if(this.closed)throw Error('live_service_closed');
    if(session.revocation)return session.revocation;if(session.saved.mandate_status==='revoked')return;
    const previous=session.saved.mandate_status??'active';
    // Persist the local stop before yielding to HTTP or any human revalidation.
    session.saved.mandate_status='revocation_pending';this.save(session.saved);
    const work=(async()=>{
      try{await this.client.revoke(session.saved.mandate_id);session.saved.mandate_status='revoked';session.saved.last_error=null;}
      catch(error){session.saved.mandate_status=error instanceof VisecaHttpError&&error.definitivelyRejected?previous:'revocation_unknown';session.saved.last_error=safeError(error);throw error;}
      finally{this.save(session.saved);}
    })();
    session.revocation=work;this.responses.add(work);
    try{await work;}finally{this.responses.delete(work);delete session.revocation;}
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;for(const session of this.sessions.values()){session.stop=true;session.worker.stopPolling();}this.client.close();
    await Promise.allSettled([this.initialized]);await this.starts.run(async()=>{});
    for(const session of this.sessions.values()){session.stop=true;session.worker.stopPolling();}
    await Promise.allSettled([...[...this.sessions.values()].flatMap(session=>[session.loop,session.reconciliation]),...this.responses]);
    for(const session of this.sessions.values())session.outbox.close();this.sessions.clear();this.db.close();
  }
  private launch(session:Session,restored=false):void{
    if(!restored){session.loop=this.loop(session);session.reconciliation=this.reconcileLoop(session);return;}
    session.loop=(async()=>{
      while(!session.stop){try{await this.refresh(session);break;}catch(error){this.recordError(session,error);if(!session.stop)await delay(500);}}
      if(!session.stop){session.reconciliation=this.reconcileLoop(session);await this.loop(session);}
    })();
  }
  private evaluate(session:Session,event:AuthorizationEvent,snapshot:unknown):Promise<Evaluation>{
    if(session.stop)return Promise.reject(Error('live_service_stopping'));
    if(session.saved.mandate_status!=='active')return Promise.resolve({decision:'deny',reason_codes:['G05_MANDATE_REVOKED'],customer_message:'This spending permission has been stopped.'});
    return Promise.resolve(evaluateLive(this.pack,snapshot as LiveBinding,event,session.saved.run_id,session.worker.listEntries(),new Date().toISOString(),[],this.learningEntries(),this.options.behaviorJournal?.(this.learningEntries())));
  }
  private updateStatus(session:Session):void{
    if(terminal(session.saved.status))return;const entries=session.worker.listEntries();
    session.saved.status=entries.some(entry=>entry.state==='submission_unknown')?'submission_unknown':entries.some(entry=>entry.state==='awaiting_human')?'awaiting_customer':'running';
  }
  private async loop(session:Session):Promise<void>{while(!session.stop){try{
    const entry=await session.worker.pollOnce((event,snapshot)=>this.evaluate(session,event,snapshot));
    if(session.stop)break;session.saved.last_poll_status=entry?200:204;this.updateStatus(session);if(session.remoteTerminal&&!session.worker.listPending().length){session.saved.status=session.remoteTerminal;session.stop=true;session.worker.stopPolling();}this.save(session.saved);if(!session.stop)await delay(100);
  }catch(error){if(session.stop)break;if(session.remoteTerminal&&!session.worker.listPending().length){session.saved.status=session.remoteTerminal;session.stop=true;this.save(session.saved);break;}this.recordError(session,error);if(!session.stop)await delay(500);}}}
  private async reconcileLoop(session:Session):Promise<void>{while(!session.stop){try{
    await this.refresh(session);if(!session.stop)await delay(1000);
  }catch(error){if(session.stop)break;this.recordError(session,error);if(!session.stop)await delay(1000);}}}
  private async refresh(session:Session):Promise<void>{
    await session.worker.reconcile();if(session.stop)return;
    if(['revocation_unknown','revocation_pending'].includes(session.saved.mandate_status??'')&&!session.revocation){
      const mandate=payload(await this.client.getMandate(session.saved.mandate_id));if(mandate['status']==='revoked')session.saved.mandate_status='revoked';
    }
    const remote=payload(await this.client.getRun(session.saved.run_id));if(session.stop)return;const status=String(remote['status']??'');
    if(terminal(status)||status==='finished'){
      if(session.worker.listPending().length)throw Error('live_run_terminal_with_pending_authorizations');
      session.remoteTerminal=status==='finished'?'completed':status;session.worker.stopPolling();
      if(!session.worker.polling()){session.saved.status=session.remoteTerminal;session.stop=true;session.worker.stopPolling();}
    }else{
      // Lift a persisted suspension only after both the ledger and run have been read successfully.
      // A failed read must not turn a recovered proposal into an unknown POST that never happened.
      if((session.recovering||['queue_conflict','authentication_required','reconciliation_required'].includes(session.saved.status))&&status!=='running')throw Error('live_run_not_confirmed_running');
      session.recovering=false;this.updateStatus(session);session.saved.last_error=null;this.save(session.saved);
      await session.worker.processRecovered((event,snapshot)=>this.evaluate(session,event,snapshot));if(session.stop)return;
      this.updateStatus(session);
    }
    session.saved.last_error=null;this.save(session.saved);
  }
  private recordError(session:Session,error:unknown):void{
    if(session.stop)return;const message=error instanceof Error?error.message:'live_connection_failed';session.saved.last_error=safeError(error);
    if(message==='unexpected_live_run'){session.saved.status='queue_conflict';session.stop=true;}
    else if(/^viseca_http_(401|403)/.test(message)){session.saved.status='authentication_required';session.stop=true;}
    else if(['live_feed_response_invalid','live_feed_request_invalid','live_authorization_history_incomplete','live_event_identity_conflict','live_event_pagination_limit','live_event_cursor_cycle','live_event_cursor_invalid','live_run_terminal_with_pending_authorizations','live_run_not_confirmed_running'].includes(message)){session.saved.status='reconciliation_required';session.stop=true;}
    else session.saved.status='connection_interrupted';
    if(session.stop)session.worker.stopPolling();this.save(session.saved);
  }
}
function payload(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return {};const record=value as Record<string,unknown>;return record['data']&&typeof record['data']==='object'&&!Array.isArray(record['data'])?record['data'] as Record<string,unknown>:record;}
function rows(value:unknown):Record<string,unknown>[]{if(Array.isArray(value))return value.filter(entry=>entry&&typeof entry==='object') as Record<string,unknown>[];const record=payload(value);for(const key of ['data','events','authorizations'])if(Array.isArray(record[key]))return rows(record[key]);return [];}
function identifier(value:unknown,error:string):string{if(typeof value!=='string'||!value)throw Error(error);return value;}
function policyMatches(mandate:Record<string,unknown>,saved:SavedSession):boolean{return mandate['instruction']===saved.binding.config.instruction&&hash(mandate['hard_rules'])===hash(saved.binding.hard_rules)&&mandate['uncertainty_policy']==='ask';}
function safeError(error:unknown):string{const message=error instanceof Error?error.message:'';return /^(viseca_|live_|unexpected_live_run|remote_|confirmed_)/.test(message)?message.slice(0,180):'live_connection_failed';}
function delay(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
