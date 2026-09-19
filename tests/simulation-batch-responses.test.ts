import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLocalApp } from '../apps/local-web/src/app.js';
import type { MandateRecord, PolicyDraft, ScenarioDetail } from '../packages/contracts/src/index.js';
import type { Assessment, SafetyConfig, SimRun } from '../packages/contracts/src/simulation.js';
import type { SimulationHumanResponse } from '../packages/local-runtime/src/simulation/service.js';

const resources:Array<{app:FastifyInstance;dir:string}>=[];
afterEach(async()=>{for(const {app,dir} of resources.splice(0)){await app.close();await rm(dir,{recursive:true,force:true});}});

async function setup(options:{evidence?:boolean;unanswerable?:boolean}={}){
 let now=new Date('2026-09-19T00:00:00.000Z');
 const dir=await mkdtemp(join(tmpdir(),'mcg-batch-responses-'));
 const app=await createLocalApp({now:()=>now,stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{model:'test',configured:false,decode:async()=>{throw Error('No external AI calls');}}});
 resources.push({app,dir});
 const detail=(await app.inject('/api/scenarios/SCEN0000')).json<ScenarioDetail>();
 const createdDraft=await app.inject({method:'POST',url:'/api/mandate-drafts',headers:{'idempotency-key':'batch-draft'},payload:{scenario_id:'SCEN0000',instruction:detail.initial_policy.instruction,hard_rules:[],uncertainty_policy:'ask',guidance:[],open_questions:[]}});
 expect(createdDraft.statusCode,createdDraft.body).toBe(201);const draft=createdDraft.json<PolicyDraft>();
 const mandate=(await app.inject({method:'POST',url:`/api/mandate-drafts/${draft.draft_id}/confirm`,headers:{'idempotency-key':'batch-mandate'},payload:{confirmed:true}})).json<MandateRecord>();
 const config=(await app.inject({method:'POST',url:`/api/mandates/${mandate.mandate_id}/safety-configs`,headers:{'idempotency-key':'batch-config'},payload:{}})).json<SafetyConfig>();
 const session=await app.inject(`/api/ui-session?mandate_id=${mandate.mandate_id}`);
 const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf};
 const confirmed=await app.inject({method:'POST',url:`/api/safety-configs/${config.config_id}/confirm`,headers:{...headers,'idempotency-key':'batch-config-confirm'},payload:{parameters:{...config.parameters,domestic_country:'CH',always_ask:true,time_review:{from_hour:0,to_hour:23},...(options.evidence?{attributes:[{name:'color',values:['green'],unit:null}]}:{}),...(options.unanswerable?{no_extras:true}:{})},reviewed_requirement_ids:config.requirements.map(r=>r.requirement_id)}});
 expect(confirmed.statusCode,confirmed.body).toBe(200);
 const createdRun=await app.inject({method:'POST',url:'/api/simulations',headers:{'idempotency-key':'batch-run'},payload:{config_id:config.config_id}});
 expect(createdRun.statusCode,createdRun.body).toBe(201);const run=createdRun.json<SimRun>();
 const started=await app.inject({method:'POST',url:`/api/simulations/${run.run_id}/next`,headers:{'idempotency-key':'batch-next'},payload:{}});
 expect(started.statusCode,started.body).toBe(200);const assessment=started.json<{assessment:Assessment}>().assessment;
 expect(assessment.decision).toBe('step_up');expect(assessment.questions.map(q=>q.fact_key)).toEqual(expect.arrayContaining(['C18','C24']));
 const answers:SimulationHumanResponse[]=assessment.questions.map(q=>({question_id:q.question_id,value:q.kind==='confirm_risk'?'confirm':'green',...(q.kind==='provide_evidence'?{source_ref:'test-quote:color',source_excerpt:'Selected color: green.'}:{})}));
 const url=`/api/simulations/${run.run_id}/authorizations/${assessment.authorization_id}/human-responses`;
 const payload={expected_revision:assessment.revision,offer_hash:assessment.offer_hash,answers};
 const send=(body:Record<string,unknown>=payload,key='batch-human-response')=>app.inject({method:'POST',url,headers:{...headers,'idempotency-key':key},payload:body});
 const current=async()=>(await app.inject(`/api/simulations/${run.run_id}`)).json<SimRun>();
 const persisted=()=>{const db=new DatabaseSync(join(dir,'state','simulations.sqlite'),{readOnly:true});try{return db.prepare('SELECT revision,body,checksum FROM state WHERE id=1').get()!;}finally{db.close();}};
 return {app,dir,headers,run,mandate,assessment,answers,payload,send,current,persisted,advance:(ms:number)=>{now=new Date(now.getTime()+ms);}};
}

describe('atomic local purchase confirmation',()=>{
 it('confirms all risks with one reassessment and consumes all answers in one commitment',async()=>{
  const x=await setup();expect(x.answers).toHaveLength(2);
  const response=await x.send();expect(response.statusCode,response.body).toBe(200);
  const result=response.json<{run:SimRun;assessment:Assessment}>(),purchase=result.run.purchases[0]!;
  expect(result.assessment).toMatchObject({decision:'approve',execution_state:'approved',revision:x.assessment.revision+1,questions:[]});
  expect(purchase.assessments).toHaveLength(2);expect(purchase.answers).toHaveLength(2);
  expect(purchase.answers.every(answer=>answer.consumed_by===result.assessment.assessment_id&&answer.actor.authenticated_by_server&&answer.offer_hash===x.assessment.offer_hash)).toBe(true);
  expect(new Set(purchase.answers.map(answer=>answer.created_at)).size).toBe(1);
  expect(result.run.commitments).toHaveLength(1);expect(result.run.reservations).toEqual([]);
  expect(result.run.audit.filter(entry=>entry.event==='human_response_recorded')).toHaveLength(2);
  expect(result.run.audit.filter(entry=>entry.event==='assessment_started')).toHaveLength(2);
  const stored=x.persisted();expect((await x.send()).json()).toEqual(result);expect(x.persisted()).toEqual(stored);
  const conflicting=await x.send({...x.payload,answers:[...x.answers].reverse()});expect(conflicting.statusCode).toBe(409);
  expect((await x.current()).commitments).toHaveLength(1);
 });

 it('rolls back the whole batch when a later answer has no evidence, then accepts a corrected retry',async()=>{
  const x=await setup({evidence:true});
  const evidence=x.answers.find(answer=>answer.source_ref)!,risks=x.answers.filter(answer=>!answer.source_ref);
  const stored=x.persisted();
  const rejected=await x.send({...x.payload,answers:[...risks,{question_id:evidence.question_id,value:'green'}]});
  expect(rejected.statusCode,rejected.body).toBe(400);expect(rejected.json().error.code).toBe('G06_EVIDENCE_REQUIRED');expect(x.persisted()).toEqual(stored);
  const run=await x.current();expect(run.purchases[0]!.answers).toEqual([]);expect(run.purchases[0]!.assessments).toHaveLength(1);expect(run.commitments).toEqual([]);
  const accepted=await x.send({...x.payload,answers:[...risks,evidence]});expect(accepted.statusCode,accepted.body).toBe(200);
  const result=accepted.json<{run:SimRun;assessment:Assessment}>();expect(result.assessment.decision).toBe('approve');expect(result.run.purchases[0]!.answers).toHaveLength(3);expect(result.run.purchases[0]!.assessments).toHaveLength(2);
  expect(result.assessment.results.find(r=>r.filter_id==='M11')?.evidence[0]?.source_type).toBe('human_review');
 });

 it('does not let a simple yes create a missing product fact',async()=>{
  const x=await setup({evidence:true});const stored=x.persisted();
  const response=await x.send({...x.payload,answers:x.answers.map(answer=>answer.source_ref?{...answer,value:' YES '}:answer)});
  expect(response.statusCode,response.body).toBe(400);expect(response.json().error.code).toBe('G06_EVIDENCE_REQUIRED');expect(x.persisted()).toEqual(stored);
 });

 it('reevaluates supplied evidence and declines a certain mismatch despite confirmed risks',async()=>{
  const x=await setup({evidence:true});
  const response=await x.send({...x.payload,answers:x.answers.map(answer=>answer.source_ref?{...answer,source_excerpt:'Selected color: red.'}:answer)});
  expect(response.statusCode,response.body).toBe(200);const result=response.json<{run:SimRun;assessment:Assessment}>();
  expect(result.assessment.decision).toBe('deny');expect(result.assessment.blocking_filter_ids).toContain('M11');expect(result.run.commitments).toEqual([]);
 });

 it.each(['missing','duplicate','unknown'] as const)('rejects a %s pending-question response without recording any consent',async failure=>{
  const x=await setup(),stored=x.persisted();
  const answers=failure==='missing'?x.answers.slice(1):failure==='duplicate'?[...x.answers,x.answers[0]!]:x.answers.map((answer,i)=>i?answer:{...answer,question_id:'unknown-question'});
  const response=await x.send({...x.payload,answers});expect(response.statusCode,response.body).toBe(400);
  expect(response.json().error.code).toBe({missing:'RESPONSES_INCOMPLETE',duplicate:'DUPLICATE_RESPONSE',unknown:'QUESTION_NOT_FOUND'}[failure]);
  expect(x.persisted()).toEqual(stored);
 });

 it('rejects a batch containing an amendment question without retaining the other risk confirmations',async()=>{
  const x=await setup({unanswerable:true});expect(x.assessment.questions.some(q=>q.kind==='amend_mandate')).toBe(true);const stored=x.persisted();
  const response=await x.send();expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('G06_PREREQUISITE_UNAVAILABLE');expect(x.persisted()).toEqual(stored);
 });

 it('durably expires a late batch and releases its reservation without spending',async()=>{
  const x=await setup();x.advance(120000);
  const response=await x.send();expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('G04_CONFIRMATION_EXPIRED');
  const run=await x.current();expect(run.purchases[0]!.answers).toEqual([]);expect(run.purchases[0]!.assessments.at(-1)?.execution_state).toBe('expired');expect(run.commitments).toEqual([]);expect(run.reservations).toEqual([]);expect(run.audit.some(entry=>entry.event==='expired')).toBe(true);
 });

 it('accepts an on-time batch at 119 seconds without extending the waiting queue',async()=>{
  const x=await setup();x.advance(119000);const response=await x.send();expect(response.statusCode,response.body).toBe(200);expect(response.json().assessment.decision).toBe('approve');
 });

 it('rejects a stale revision or different offer even when its question IDs still look valid',async()=>{
  const x=await setup();
  const wrongOffer=await x.send({...x.payload,offer_hash:'different-offer'});expect(wrongOffer.statusCode).toBe(409);expect(wrongOffer.json().error.code).toBe('G02_OFFER_CHANGED');
  const revised=await x.app.inject({method:'POST',url:`/api/simulations/${x.run.run_id}/authorizations/${x.assessment.authorization_id}/reassess`,headers:{...x.headers,'idempotency-key':'batch-reassess'},payload:{expected_revision:x.assessment.revision}});expect(revised.statusCode,revised.body).toBe(200);
  const stored=x.persisted(),stale=await x.send();expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('G05_REVISION_CONFLICT');expect(x.persisted()).toEqual(stored);expect((await x.current()).purchases[0]!.answers).toEqual([]);
 });

 it('requires the authenticated customer channel for a batch',async()=>{
  const x=await setup();const response=await x.app.inject({method:'POST',url:`/api/simulations/${x.run.run_id}/authorizations/${x.assessment.authorization_id}/human-responses`,headers:{'idempotency-key':'batch-forged'},payload:x.payload});
  expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe('G03_HUMAN_CHANNEL_REQUIRED');expect((await x.current()).purchases[0]!.answers).toEqual([]);
 });
});
