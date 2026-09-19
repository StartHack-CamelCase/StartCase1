import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DataPack } from "../../../contracts/src/data.js";
import type { SafetyConfig } from "../../../contracts/src/simulation.js";
import type { HardRule } from "../../../contracts/src/policy.js";
import { VisecaClient } from "../simulation/viseca-client.js";
import { evaluateLive, validateLiveBinding, type LiveBinding } from "../simulation/live-engine.js";
import { hash } from "../simulation/common.js";
import { SerialExecutor } from "./serial-executor.js";
import { VisecaOutbox, VisecaWorker, type LiveEntry, type TrustedHuman, type HumanAuthorizer } from "../simulation/viseca-worker.js";

export type LiveSessionStart = { config: SafetyConfig; scenario_id: string; instruction: string; hard_rules: HardRule[]; confirmed_by: string };
export type LiveSessionView = { session_id: string; mandate_id: string; run_id: string; status: string; last_poll_status: 204 | 200 | null; entries: LiveEntry[] };
type SavedSession = { key:string; fingerprint:string; stage:string; session_id:string; mandate_id:string; run_id:string; binding:LiveBinding; human_window_ms:number; status:string; last_poll_status:204|200|null };
type Session = { saved:SavedSession; outbox:VisecaOutbox; worker:VisecaWorker; stop:boolean; remoteTerminal?:string|undefined; loop?:Promise<void>; reconciliation?:Promise<void> };
export type LiveSessionOptions = { baseUrl?: string; apiKey?: string; transport?: (path: string, init?: RequestInit) => Promise<Response>; stateDir: string };

export class LiveSessionService {
  private readonly sessions = new Map<string, Session>();
  private readonly client: VisecaClient;
  private readonly db: DatabaseSync;
  private readonly starts = new SerialExecutor();
  private initialized:Promise<void>|undefined;
  private closed=false;
  private readonly responses=new Set<Promise<unknown>>();
  constructor(private readonly pack: DataPack, private readonly options: LiveSessionOptions) {
    mkdirSync(options.stateDir,{recursive:true});this.client=new VisecaClient(options.baseUrl??"",options.apiKey,options.transport);
    this.db=new DatabaseSync(join(options.stateDir,"live-sessions.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS starts (key TEXT PRIMARY KEY, stage TEXT NOT NULL, mandate_id TEXT, run_id TEXT, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL)");
  }
  configured(): boolean { return Boolean(this.options.baseUrl && this.options.apiKey); }
  initialize():Promise<void>{return this.initialized??=this.restore();}
  private async restore():Promise<void>{for(const row of this.db.prepare('SELECT body,checksum FROM sessions').all()){
    const saved=JSON.parse(String(row['body'])) as SavedSession;if(hash(saved)!==row['checksum'])throw Error('live_session_state_corrupt');
    if(saved.stage==='running')await this.attach(saved);
  }}
  private save(saved:SavedSession):void{this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,checksum=excluded.checksum').run(saved.key,JSON.stringify(saved),hash(saved));}
  async start(input:LiveSessionStart,key:string):Promise<{session_id:string;mandate_id:string;run_id:string}>{await this.initialize();return this.starts.run(async()=>{
    if(this.closed)throw Error('live_service_closed');
    if(input.config.status!=="confirmed"||!input.confirmed_by||input.instruction!==input.config.instruction)throw Error("live_confirmed_binding_required");
    const fingerprint=hash(input);const row=this.db.prepare('SELECT body,checksum FROM sessions WHERE key=?').get(key);
    if(row){const saved=JSON.parse(String(row['body'])) as SavedSession;if(hash(saved)!==row['checksum'])throw Error('live_session_state_corrupt');if(saved.fingerprint!==fingerprint)throw Error('live_start_idempotency_conflict');if(saved.stage!=='running')throw Error('live_start_submission_unknown_requires_reconciliation');return this.ids(saved);}
    if(this.db.prepare('SELECT key FROM starts WHERE key=?').get(key))throw Error('legacy_live_start_requires_reconciliation');
    // The platform's queue is team-wide. Only one run may consume it at a time.
    if([...this.sessions.values()].some(s=>!['completed','cancelled','failed'].includes(s.saved.status)))throw Error('live_run_already_active');
    const binding=validateLiveBinding({config:structuredClone(input.config),live_mandate_id:'PENDING',scenario_id:input.scenario_id,hard_rules:input.hard_rules,history_hash:hash(this.pack.history),pack_version:this.pack.pack_version},this.pack);
    const timeouts=VisecaClient.timeouts(await this.client.prepare());
    const saved:SavedSession={key,fingerprint,stage:'mandate_intended',session_id:`LIVE_SESSION_${randomUUID()}`,mandate_id:'',run_id:'',binding,human_window_ms:timeouts.human_window_ms,status:'starting',last_poll_status:null};this.save(saved);
    const draft=payload(await this.client.createMandate({instruction:input.instruction,hard_rules:input.hard_rules,uncertainty_policy:'ask',guidance:[],open_questions:[]}));
    const draftId=String(draft['draft_id']??'');if(!draftId)throw Error('remote_draft_id_missing');
    saved.mandate_id=draftId;saved.stage='confirmation_intended';this.save(saved);
    const confirmed=payload(await this.client.confirmMandate(draftId,{confirmed:true}));saved.mandate_id=String(confirmed['mandate_id']??'');if(!saved.mandate_id)throw Error('confirmed_mandate_id_missing');
    saved.binding.live_mandate_id=saved.mandate_id;validateLiveBinding(saved.binding,this.pack);
    // Prepare durable storage and the worker before releasing any platform events.
    const outbox=new VisecaOutbox(join(this.options.stateDir,`${saved.session_id}.sqlite`));await outbox.load();const worker=new VisecaWorker(this.client,outbox);
    saved.stage='run_intended';this.save(saved);
    try{const run=payload(await this.client.createRun({scenario_id:input.scenario_id,mandate_id:saved.mandate_id}));saved.run_id=String(run['run_id']??'');if(!saved.run_id)throw Error('remote_run_id_missing');
      await worker.startRun(saved.run_id,saved.binding,saved.human_window_ms);saved.stage='running';saved.status='running';this.save(saved);
      const session:Session={saved,outbox,worker,stop:false};this.sessions.set(saved.session_id,session);this.launch(session);return this.ids(saved);
    }catch(error){outbox.close();throw error;}
  });}
  private ids(s:SavedSession){return {session_id:s.session_id,mandate_id:s.mandate_id,run_id:s.run_id};}
  private async attach(saved:SavedSession):Promise<void>{validateLiveBinding(saved.binding,this.pack);const outbox=new VisecaOutbox(join(this.options.stateDir,`${saved.session_id}.sqlite`));await outbox.load();const worker=new VisecaWorker(this.client,outbox);await worker.startRun(saved.run_id,saved.binding,saved.human_window_ms);const s:Session={saved,outbox,worker,stop:false};this.sessions.set(saved.session_id,s);if(this.configured()&&!['completed','cancelled','failed'].includes(saved.status))this.launch(s);}
  get(id:string):LiveSessionView{const s=this.sessions.get(id);if(!s)throw Error('live_session_not_found');return {...this.ids(s.saved),status:s.saved.status,last_poll_status:s.saved.last_poll_status,entries:s.worker.listEntries()};}
  list():LiveSessionView[]{return [...this.sessions.keys()].map(id=>this.get(id));}
  learningEntries():LiveEntry[]{return [...this.sessions.values()].flatMap(s=>s.worker.listEntries());}
  async respond(id:string,authorizationId:string,decision:'approve'|'decline',proof:unknown,authorize:HumanAuthorizer,revalidate:(entry:LiveEntry,actor:TrustedHuman,decision:'approve'|'decline')=>Promise<boolean|{approved:boolean;evidence:unknown[]}>):Promise<unknown>{
    const s=this.sessions.get(id);if(!s)throw Error('live_session_not_found');if(this.closed)throw Error('live_service_closed');
    const work=s.worker.resolve(authorizationId,decision,proof,authorize,async(entry,actor,choice)=>{if(s.saved.status==='revoked'&&choice==='approve')throw Error('mandate_revoked');return revalidate(entry,actor,choice);});
    this.responses.add(work);try{return await work;}finally{this.responses.delete(work);}
  }
  async revoke(id:string):Promise<void>{const s=this.sessions.get(id);if(!s)throw Error('live_session_not_found');await this.client.revoke(s.saved.mandate_id);s.saved.status='revoked';this.save(s.saved);/* Pending outcomes still require platform reconciliation. */}
  async close():Promise<void>{if(this.closed)return;this.closed=true;for(const s of this.sessions.values())s.stop=true;this.client.close();await Promise.allSettled([...[...this.sessions.values()].flatMap(s=>[s.loop,s.reconciliation]),...this.responses]);for(const s of this.sessions.values())s.outbox.close();this.sessions.clear();this.db.close();}
  private launch(s:Session):void{s.loop=this.loop(s);s.reconciliation=this.reconcileLoop(s);}
  private updateStatus(s:Session):void{if(['revoked','completed','cancelled','failed'].includes(s.saved.status))return;const entries=s.worker.listEntries();s.saved.status=entries.some(e=>e.state==='submission_unknown')?'submission_unknown':entries.some(e=>e.state==='awaiting_human')?'awaiting_customer':'running';}
  private async loop(s:Session):Promise<void>{while(!s.stop){try{
    const entry=await s.worker.pollOnce(async(event,snapshot)=>{if(s.stop)throw Error('live_service_stopping');if(s.saved.status==='revoked')return {decision:'deny',reason_codes:['G05_MANDATE_REVOKED'],customer_message:'This permission has been revoked.'};return evaluateLive(this.pack,snapshot as LiveBinding,event,s.saved.run_id,s.worker.listEntries(),new Date().toISOString(),[],this.learningEntries());});
    if(s.stop)break;s.saved.last_poll_status=entry?200:204;this.updateStatus(s);
    // Drain the in-flight poll before accepting a terminal run status.
    if(s.remoteTerminal&&!s.worker.listPending().length){s.saved.status=s.remoteTerminal;s.stop=true;}
    this.save(s.saved);if(!s.stop)await delay(100);
  }catch{if(s.stop)break;if(s.saved.status!=='revoked')s.saved.status='connection_interrupted';this.save(s.saved);await delay(500);}}}
  private async reconcileLoop(s:Session):Promise<void>{while(!s.stop){try{
    // Reconcile immediately after restart and independently of an empty 25-second poll.
    await s.worker.reconcile();if(s.stop)break;
    const remote=payload(await this.client.getRun(s.saved.run_id));if(s.stop)break;const status=String(remote['status']??'');
    s.remoteTerminal=['completed','finished','cancelled','failed'].includes(status)?(status==='finished'?'completed':status):undefined;
    this.updateStatus(s);
    this.save(s.saved);if(!s.stop)await delay(1000);
  }catch{if(s.stop)break;if(s.saved.status!=='revoked')s.saved.status='connection_interrupted';this.save(s.saved);await delay(1000);}}}

}
function payload(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object')return {};const v=value as Record<string,unknown>;return (v['data']??v) as Record<string,unknown>;}
function delay(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
