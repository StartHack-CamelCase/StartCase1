import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthorizationEvent } from '../../../contracts/src/event.js';
import { ENGINE_VERSION, hash } from './common.js';
import { VisecaClient } from './viseca-client.js';

export type LiveDecision='approve'|'decline'|'step_up';
export type LiveState='proposed'|'intended'|'submission_unknown'|'accepted'|'deadline_missed'|'awaiting_human';
export type Evaluation={decision:'approve'|'deny'|'step_up'|null;reason_codes?:string[];customer_message?:string;evidence?:unknown[];snapshot?:unknown};
type Intent={id:string;operation:'decision'|'resolve';decision:LiveDecision;at:string;actor_id?:string;consent_hash?:string};
export type LiveEntry={id:string;event:AuthorizationEvent;state:LiveState;decision?:LiveDecision;reserved:boolean;snapshot:unknown;proposal:Evaluation|null;intent:Intent|null;accepted:{decision:LiveDecision;at:string;response:unknown}|null;human_expires_at:string|null;history:Array<{at:string;kind:string;details:unknown}>};
export type LiveStore={run_start?:{fingerprint:string;status:'intended'|'unknown'|'created';existing_run_ids?:string[]};schema_version:1;run_id:string;snapshot:unknown;entries:LiveEntry[];cursor:string;human_window_ms:number};
export class VisecaOutbox {
 private readonly db:DatabaseSync;private revision=0;private data:LiveStore={schema_version:1,run_id:'',snapshot:null,entries:[],cursor:'0',human_window_ms:120000};
 constructor(path:string){mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL,checksum TEXT NOT NULL)');}
 async load():Promise<LiveStore>{const row=this.db.prepare('SELECT * FROM outbox WHERE id=1').get();if(row){const value=JSON.parse(String(row['body'])) as LiveStore;if(hash(value)!==row['checksum'])throw Error('viseca_outbox_corrupt');this.validate(value);this.data=value;this.revision=Number(row['revision']);}return structuredClone(this.data);}
 async save(data=this.data):Promise<void>{this.validate(data);this.db.exec('BEGIN IMMEDIATE');try{const row=this.db.prepare('SELECT revision FROM outbox WHERE id=1').get();if(Number(row?.['revision']??0)!==this.revision)throw Error('viseca_outbox_concurrent_writer');const body=JSON.stringify(data);this.db.prepare('INSERT INTO outbox VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,checksum=excluded.checksum').run(this.revision+1,body,hash(data));this.db.exec('COMMIT');this.revision++;this.data=data;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get value():LiveStore{return this.data;}
 close():void{this.db.close();}
 private validate(data:LiveStore):void{if(data.schema_version!==1||typeof data.run_id!=='string'||!Array.isArray(data.entries)||typeof data.cursor!=='string'||!(data.human_window_ms>0))throw Error('viseca_outbox_corrupt');if(data.run_start&&(typeof data.run_start.fingerprint!=='string'||!['intended','unknown','created'].includes(data.run_start.status)||data.run_start.existing_run_ids!==undefined&&(!Array.isArray(data.run_start.existing_run_ids)||data.run_start.existing_run_ids.some(id=>typeof id!=='string'))))throw Error('viseca_outbox_corrupt');const ids=new Set<string>();for(const e of data.entries){VisecaClient.validateEvent(e.event);if(e.id!==e.event.authorization.authorization_id||ids.has(e.id)||hash(e.snapshot)!==hash(data.snapshot)||!Array.isArray(e.history)||!['proposed','intended','submission_unknown','accepted','deadline_missed','awaiting_human'].includes(e.state))throw Error('viseca_outbox_corrupt');ids.add(e.id);if(e.accepted&&!['approve','decline','step_up'].includes(e.accepted.decision))throw Error('viseca_outbox_corrupt');if(e.state==='accepted'&&(!e.accepted||e.reserved))throw Error('viseca_outbox_ledger_invalid');}}
}
export type TrustedHuman={actor_id:string;proof:string};
export type HumanAuthorizer=(sessionProof:unknown,authorizationId:string)=>Promise<TrustedHuman>;
export type BeforeLiveSubmission=(decision:LiveDecision)=>void;

type PendingPost = { id:string; intent_id:string; decision:LiveDecision; body:Record<string,unknown>; deadline:number; previous_intent?:Intent|null };
type ReconciliationStart = {run_id:string;cursor:string;recoverable:Map<string,string>};
export class VisecaWorker {
 private queue:Promise<unknown>=Promise.resolve();
 private readonly pollShutdown=new AbortController();
 private pollFlight:Promise<LiveEntry|null>|undefined;
 private initialized=false;
 constructor(private readonly client:VisecaClient,private readonly outbox:VisecaOutbox,private readonly now=()=>Date.now(),private readonly marginMs=700,private readonly beforeSubmit:BeforeLiveSubmission=()=>{}){}
 polling():boolean{return this.pollFlight!==undefined;}
 stopPolling():void{this.pollShutdown.abort();}
 async startRun(runId:string,snapshot:unknown,humanWindowMs=120000):Promise<void>{
  const run=this.outbox.value;
  if(run.run_id&&(run.run_id!==runId||hash(run.snapshot)!==hash(snapshot)))throw Error('immutable_live_snapshot_conflict');
  run.run_id=runId;run.snapshot=structuredClone(snapshot);run.human_window_ms=humanWindowMs;
  if(!this.initialized)for(const entry of run.entries)if(entry.state==='intended'){
   entry.state='submission_unknown';entry.reserved=true;this.record(entry,'interrupted_submission',{intent_id:entry.intent?.id});
  }
  this.initialized=true;await this.outbox.save();
 }
 /** A long poll does not own the mutation queue. Human replies can be sent immediately. */
 pollOnce(evaluate:(event:AuthorizationEvent,snapshot:unknown)=>Promise<Evaluation>):Promise<LiveEntry|null>{
  if(this.pollFlight)return this.pollFlight;
  const flight=this.pollOutsideQueue(evaluate);this.pollFlight=flight;
  void flight.finally(()=>{if(this.pollFlight===flight)this.pollFlight=undefined;}).catch(()=>undefined);
  return flight;
 }
 private async pollOutsideQueue(evaluate:(event:AuthorizationEvent,snapshot:unknown)=>Promise<Evaluation>):Promise<LiveEntry|null>{
  const runId=this.outbox.value.run_id;if(!runId)throw Error('live_run_not_prepared');
  const recovered=this.outbox.value.entries.find(entry=>entry.state==='proposed'&&!entry.intent);
  if(recovered)return this.processEvent(recovered.event,runId,evaluate);
  const envelope=await this.client.poll(runId,this.pollShutdown.signal);if(!envelope)return null;
  if(envelope.run_id!==runId)throw Error('unexpected_live_run');
  return this.processEvent(envelope.data,runId,evaluate);
 }
 async processRecovered(evaluate:(event:AuthorizationEvent,snapshot:unknown)=>Promise<Evaluation>):Promise<void>{
  const run=this.outbox.value;
  for(const entry of [...run.entries])if(entry.state==='proposed'&&!entry.intent)await this.processEvent(entry.event,run.run_id,evaluate);
 }
 private async processEvent(event:AuthorizationEvent,runId:string,evaluate:(event:AuthorizationEvent,snapshot:unknown)=>Promise<Evaluation>):Promise<LiveEntry>{
  const id=event.authorization.authorization_id;
  const pending=await this.serial(async():Promise<PendingPost|null>=>{
   const run=this.outbox.value;if(run.run_id!==runId)throw Error('unexpected_live_run');
   const prior=run.entries.find(e=>e.id===id);
   if(prior){if(hash(prior.event.authorization)!==hash(event.authorization)||hash(prior.event.mandate)!==hash(event.mandate))throw Error('live_event_identity_conflict');if(prior.state!=='proposed'||prior.intent)return null;}
   // Reserve before evaluating; concurrent requests cannot spend this capacity.
   const entry:LiveEntry=prior??{id,event,state:'proposed',reserved:true,snapshot:structuredClone(run.snapshot),proposal:null,intent:null,accepted:null,human_expires_at:null,history:[]};
   if(!prior)run.entries.push(entry);this.record(entry,prior?'resumed_before_submission':'received',{});await this.outbox.save();
   const deadline=Date.parse(event.deadline_at);
   if(deadline-this.now()<=this.marginMs){entry.state='deadline_missed';this.record(entry,'deadline_missed',{});await this.outbox.save();return null;}
   let timer:ReturnType<typeof setTimeout>|undefined;
   const fallback:Evaluation={decision:null,reason_codes:['G06_PREREQUISITE_UNAVAILABLE'],customer_message:'Processing paused: a required check is unavailable.'};
   const evaluation=await Promise.race([
    Promise.resolve().then(()=>evaluate(event,structuredClone(entry.snapshot))).catch(()=>fallback),
    new Promise<Evaluation>(resolve=>{timer=setTimeout(()=>resolve(fallback),Math.max(1,deadline-this.now()-this.marginMs));})
   ]);if(timer)clearTimeout(timer);
   entry.proposal=structuredClone(evaluation);
   const decision:LiveDecision=evaluation.decision==='deny'?'decline':evaluation.decision??'step_up';
   entry.decision=decision;entry.intent={id:randomUUID(),operation:'decision',decision,at:this.iso()};entry.state='intended';
   this.record(entry,'submission_intended',entry.intent);await this.outbox.save();
   if(deadline-this.now()<=50){entry.state='deadline_missed';this.record(entry,'deadline_missed',{});await this.outbox.save();return null;}
   return {id,intent_id:entry.intent.id,decision,deadline,body:{reason_codes:evaluation.reason_codes??[],customer_message:evaluation.customer_message,evidence:evaluation.evidence,engine_version:ENGINE_VERSION}};
  });
  if(!pending)return this.entry(id);
  // POST is also outside the queue. Its durable reservation remains until accepted.
  try{this.beforeSubmit(pending.decision);}catch(error){await this.blockPost(pending,error);return this.entry(id);}
  try{
   const response=await this.client.decision(id,pending.decision,pending.body,Math.max(1,pending.deadline-this.now()));
   await this.finishPost(pending,response);
  }catch(error){await this.failPost(pending,error,'submission_unknown');}
  return this.entry(id);
 }
 async resolve(id:string,decision:'approve'|'decline',sessionProof:unknown,authorizeHuman:HumanAuthorizer,revalidate:(entry:LiveEntry,actor:TrustedHuman,decision:'approve'|'decline')=>Promise<boolean|{approved:boolean;evidence:unknown[]}>):Promise<unknown>{
  const receivedAt=this.now();
  const pending=await this.serial(async():Promise<PendingPost>=>{
   const entry=this.outbox.value.entries.find(e=>e.id===id);
   if(!entry||entry.state!=='awaiting_human'||entry.accepted?.decision!=='step_up')throw Error('human_resolution_not_pending');
   const deadline=Date.parse(entry.human_expires_at??'');
   if(!Number.isFinite(deadline)||receivedAt>=deadline||this.now()>=deadline)throw Error('human_confirmation_expired');
   const actor=await authorizeHuman(sessionProof,id);
   if(!actor?.actor_id||!actor.proof)throw Error('human_resolution_rejected');
   const verification=await revalidate(structuredClone(entry),actor,decision);
   if(!(typeof verification==='boolean'?verification:verification.approved))throw Error('human_resolution_rejected');
   const humanEvidence=typeof verification==='boolean'?[]:verification.evidence;
   if(this.now()>=deadline)throw Error('human_confirmation_expired');
   const consent_hash=hash([actor.actor_id,actor.proof,id,entry.event,entry.snapshot]);
   const blockedIntents=new Set(entry.history.filter(h=>h.kind==='submission_blocked').map(h=>(h.details as {intent_id:string}).intent_id));
   if(entry.history.some(h=>h.kind==='human_intent'&&(h.details as Intent).consent_hash===consent_hash&&!blockedIntents.has((h.details as Intent).id)))throw Error('human_confirmation_used');
   this.record(entry,'human_revalidated',{received_at:new Date(receivedAt).toISOString(),evidence:humanEvidence});
   const previous_intent=structuredClone(entry.intent);
   entry.intent={id:randomUUID(),operation:'resolve',decision,at:this.iso(),actor_id:actor.actor_id,consent_hash};
   entry.decision=decision;entry.state='intended';entry.reserved=true;this.record(entry,'human_intent',entry.intent);await this.outbox.save();
   return {id,intent_id:entry.intent.id,decision,deadline,previous_intent,body:{evidence:[{type:'human_review',actor:actor.actor_id},...humanEvidence]}};
  });
  try{
   if(this.now()>=pending.deadline)throw Error('human_confirmation_expired');
   // Synchronous guard and request dispatch share one JS turn: revocation cannot slip between them.
   this.beforeSubmit(decision);
  }catch(error){await this.blockPost(pending,error);throw error;}
  try{
   const response=await this.client.resolve(id,decision,pending.body,Math.max(1,pending.deadline-this.now()));
   await this.finishPost(pending,response);return response;
  }catch(error){await this.failPost(pending,error,'human_submission_unknown');throw Error(error instanceof Error&&['human_confirmation_expired','mandate_revoked','mandate_revocation_pending'].includes(error.message)?error.message:'human_submission_unknown');}
 }
 private async finishPost(pending:PendingPost,response:unknown):Promise<void>{await this.serial(async()=>{
  const entry=this.outbox.value.entries.find(e=>e.id===pending.id)!;
  if(entry.intent?.id!==pending.intent_id)return;
  if(entry.accepted&&entry.accepted.decision!=='step_up')return;
  const body=payload(response),remoteId=body['authorization_id'];
  if(remoteId!==undefined&&remoteId!==entry.id)throw Error('viseca_decision_identity_conflict');
  // The platform result, not our proposal, is the authoritative budget outcome.
  const decision=acceptedDecision(body)??(body['accepted']===true&&!body['status']&&!body['decision']?pending.decision:undefined);
  if(!decision)throw Error('viseca_decision_acceptance_unknown');
  this.accept(entry,decision,response);await this.outbox.save();
 });}
 /** A synchronous local guard proves that no HTTP request was dispatched. */
 private async blockPost(pending:PendingPost,error:unknown):Promise<void>{await this.serial(async()=>{
  const entry=this.outbox.value.entries.find(e=>e.id===pending.id)!;
  if(entry.intent?.id!==pending.intent_id||entry.state!=='intended')return;
  const human=entry.intent.operation==='resolve';
  this.record(entry,'submission_blocked',{error:error instanceof Error?error.message:'local_guard',intent_id:pending.intent_id,operation:entry.intent.operation});
  entry.state=human?'awaiting_human':'proposed';entry.reserved=true;
  entry.intent=human?(pending.previous_intent??null):null;
  if(human)entry.decision='step_up';
  await this.outbox.save();
 });}
 private async failPost(pending:PendingPost,error:unknown,kind:string):Promise<void>{await this.serial(async()=>{
  const entry=this.outbox.value.entries.find(e=>e.id===pending.id)!;
  if(entry.intent?.id!==pending.intent_id||entry.state!=='intended')return;
  entry.state='submission_unknown';this.record(entry,kind,{error:error instanceof Error?error.message:'network',intent_id:pending.intent_id});await this.outbox.save();
 });}
 /** Network reads must not delay a time-bound human response either. */
 async reconcile(cursor?:string):Promise<{cursor:string;accepted:string[]}>{
  const run=this.outbox.value;
  const started:ReconciliationStart={run_id:run.run_id,cursor:cursor??run.cursor,recoverable:new Map(run.entries.filter(e=>e.state==='submission_unknown'&&e.intent?.operation==='resolve').map(e=>[e.id,e.intent!.id]))};
  const result=await this.client.reconcile(started.cursor);
  return this.serial(async()=>{
   const current=this.outbox.value;if(current.run_id!==started.run_id)throw Error('unexpected_live_run');
   const accepted:string[]=[];
   const imported:LiveEntry[]=[];
   // A lost poll response can still be recovered from its canonical request in the feed.
   for(const row of rows(result.events)){
    if(row['run_id']!==current.run_id||row['type']!=='authorization.request')continue;
    const event=row['data'] as AuthorizationEvent;
    try{VisecaClient.validateEvent(event);}catch{throw Error('live_feed_request_invalid');}
    const id=event.authorization.authorization_id;
    if(row['authorization_id']!==undefined&&row['authorization_id']!==id)throw Error('live_event_identity_conflict');
    const prior=current.entries.find(entry=>entry.id===id)??imported.find(entry=>entry.id===id);
    if(prior){if(hash(prior.event.authorization)!==hash(event.authorization)||hash(prior.event.mandate)!==hash(event.mandate))throw Error('live_event_identity_conflict');continue;}
    const entry:LiveEntry={id,event:structuredClone(event),state:'proposed',reserved:true,snapshot:structuredClone(current.snapshot),proposal:null,intent:null,accepted:null,human_expires_at:null,history:[]};
    this.record(entry,'recovered_from_event_feed',{});imported.push(entry);
   }
   // Historical events can prove finality. Only the current authorization view can reopen a lost reply.
   const sources=[...rows(result.events).map(row=>({row,current:false})),...rows(result.authorizations).map(row=>({row,current:true}))];
   // Never silently drop a remote outcome that would make the spending ledger incomplete.
   for(const {row} of sources){const data=payload(row);if((row['run_id']??data['run_id'])!==current.run_id)continue;const id=String(row['authorization_id']??data['authorization_id']??'');if(id&&!current.entries.some(e=>e.id===id)&&!imported.some(e=>e.id===id))throw Error('live_authorization_history_incomplete');}
   current.entries.push(...imported);
   for(const source of sources){
    const row=source.row,data=payload(row),remoteRun=row['run_id']??data['run_id'];
    if(remoteRun!==current.run_id)continue;
    const id=String(row['authorization_id']??data['authorization_id']??'');const entry=current.entries.find(e=>e.id===id);if(!entry)continue;
    const decision=acceptedDecision({...row,...data});
    if(!decision||entry.accepted&&entry.accepted.decision!=='step_up')continue;
    if(entry.accepted?.decision===decision){
     if(decision==='step_up'&&source.current&&entry.state==='submission_unknown'&&entry.intent?.id===started.recoverable.get(id)&&Date.parse(entry.human_expires_at??'')>this.now()){
      entry.state='awaiting_human';entry.reserved=true;this.record(entry,'human_reply_not_finalized',{intent_id:entry.intent?.id,source:'authorizations'});
     }
     continue;
    }
    this.accept(entry,decision,row);this.record(entry,'reconciled',{decision});accepted.push(id);
   }
   const events=payload(result.events);const next=events['next_cursor']??(result.events as Record<string,unknown>|null)?.['next_cursor'];
   // Do not let overlapping GETs move the cursor backwards.
   if(current.cursor===started.cursor&&(typeof next==='string'||typeof next==='number'))current.cursor=String(next);
   await this.outbox.save();return {cursor:current.cursor,accepted};
  });
 }
 listPending():LiveEntry[]{return structuredClone(this.outbox.value.entries.filter(e=>e.state==='awaiting_human'||e.state==='submission_unknown'||e.state==='deadline_missed'||e.state==='intended'||e.state==='proposed'));}
 listEntries():LiveEntry[]{return structuredClone(this.outbox.value.entries);}
 private entry(id:string):LiveEntry{return structuredClone(this.outbox.value.entries.find(e=>e.id===id)!);}
 private accept(entry:LiveEntry,decision:LiveDecision,response:unknown):void{
  if(entry.accepted&&entry.accepted.decision!=='step_up')return;
  entry.accepted={decision,at:this.iso(),response};entry.state=decision==='step_up'?'awaiting_human':'accepted';entry.reserved=decision==='step_up';
  if(decision==='step_up'){
   const firstIntent=entry.history.find(h=>h.kind==='submission_intended'&&(h.details as Intent)?.decision==='step_up');
   const fallback=Date.parse(firstIntent?.at??this.iso())+this.outbox.value.human_window_ms;
   const body=payload(response);const remote=Date.parse(String(body['human_expires_at']??body['human_deadline_at']??body['expires_at']??''));
   const previous=Date.parse(entry.human_expires_at??'');
   entry.human_expires_at=new Date(Math.min(fallback,Number.isFinite(remote)?remote:Infinity,Number.isFinite(previous)?previous:Infinity)).toISOString();
  }
  this.record(entry,'platform_accepted',{decision,response});
 }
 private record(entry:LiveEntry,kind:string,details:unknown):void{entry.history.push({at:this.iso(),kind,details:structuredClone(details)});}
 private iso():string{return new Date(this.now()).toISOString();}
 private serial<T>(operation:()=>Promise<T>):Promise<T>{const result=this.queue.then(operation);this.queue=result.catch(()=>{});return result;}
}
function payload(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object')return {};const record=value as Record<string,unknown>;return record['data']&&typeof record['data']==='object'&&!Array.isArray(record['data'])?record['data'] as Record<string,unknown>:record;}
function rows(value:unknown):Record<string,unknown>[]{if(Array.isArray(value))return value.filter(v=>v&&typeof v==='object') as Record<string,unknown>[];if(value&&typeof value==='object'){const v=value as Record<string,unknown>;for(const key of ['data','authorizations','events'])if(Array.isArray(v[key]))return rows(v[key]);if(v['data']&&typeof v['data']==='object')return rows(v['data']);}return [];}
function acceptedDecision(body:Record<string,unknown>):LiveDecision|undefined{
 const status=String(body['status']??''),decision=String(body['decision']??'');
 if(body['accepted']===false)return undefined;
 if(status==='approved')return 'approve';
 if(['declined','cancelled','expired'].includes(status))return 'decline';
 if(status==='timed_out')return body['is_final']!==false&&['','step_up','decline'].includes(decision)?'decline':undefined;
 if(['step_up','awaiting_human'].includes(status))return 'step_up';
 // The hosted Railway API names this non-final state awaiting_customer.
 // A conflicting final marker or decision is not proof of an accepted step-up.
 if(status==='awaiting_customer')return (decision===''||decision==='step_up')&&body['is_final']!==true?'step_up':undefined;
 if((status==='accepted'||body['accepted']===true)&&['approve','decline','step_up'].includes(decision))return decision as LiveDecision;
 return undefined;
}
