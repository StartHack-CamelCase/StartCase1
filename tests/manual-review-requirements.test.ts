import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanAnswer, HumanActor } from '../packages/contracts/src/simulation.js';
import { createLocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { assertNoWeakening, defaultParameters, validateParameters } from '../packages/local-runtime/src/simulation/config.js';
import { hash, offerHash } from '../packages/local-runtime/src/simulation/common.js';
import { fixture } from './simulation-fixture.js';

const instruction='Buy one grocery item for CHF 20 or less. Choose an organic item. Ask me when uncertain.';
const requirements=[{source_excerpt:'Choose an organic item.',description:'The item must be organic.'}];
const resources:Array<{close:()=>Promise<void>;dir:string}>=[];
afterEach(async()=>{for(const resource of resources.splice(0)){await resource.close();await rm(resource.dir,{recursive:true,force:true});}});

function context(){
 const ctx=fixture('AU0001');
 ctx.config.instruction=instruction;ctx.config.instruction_hash=hash(instruction);
 ctx.config.parameters={...ctx.config.parameters,max_order_chf:'20',manual_review_requirements:structuredClone(requirements)};
 ctx.offer_hash=offerHash(ctx.event,ctx.config);
 return ctx;
}
function answer(ctx:ReturnType<typeof context>):HumanAnswer{
 const question=assess(ctx).questions.find(q=>q.kind==='confirm_requirement')!;
 return {answer_id:'ANSWER_MANUAL',question_id:question.question_id,fact_key:question.fact_key,kind:question.kind,value:'confirm',source_ref:null,source_excerpt:null,actor:{actor_id:'customer',role:'simulated_human',channel:'local_ui',authenticated_by_server:true,customer_id:ctx.event.mandate.customer_id},offer_hash:ctx.offer_hash,config_revision:ctx.config.revision,created_at:ctx.now,expires_at:new Date(Date.parse(ctx.now)+120000).toISOString(),consumed_by:null};
}

describe('purchase-specific verification of instruction requirements',()=>{
 it('asks one aggregate question and only approves after explicit verification of this purchase',()=>{
  const ctx=context();
  ctx.config.parameters.manual_review_requirements!.push({source_excerpt:'Buy one grocery item for CHF 20 or less.',description:'Verify the complete shopping instruction.'});
  const before=assess(ctx);
  expect(before).toMatchObject({decision:'step_up',execution_state:'awaiting_user',can_finalize:false});
  const questions=before.questions.filter(q=>q.kind==='confirm_requirement');
  expect(questions).toHaveLength(1);expect(questions[0]!.prompt).toContain('The item must be organic.');expect(questions[0]!.prompt).toContain('Verify the complete shopping instruction.');
  ctx.answers=[answer(ctx)];
  expect(assess(ctx)).toMatchObject({can_finalize:true,questions:[]});
 });

 it.each(['expired','used','other_offer','other_customer','other_question','wrong_kind','unauthenticated','future'] as const)('rejects a %s manual verification',kind=>{
  const ctx=context(),response=answer(ctx);
  if(kind==='expired')response.expires_at=ctx.now;
  if(kind==='used')response.consumed_by='older-assessment';
  if(kind==='other_offer')response.offer_hash='other-offer';
  if(kind==='other_customer')response.actor.customer_id='someone-else';
  if(kind==='other_question')response.question_id='another-question';
  if(kind==='wrong_kind')response.kind='confirm_risk';
  if(kind==='unauthenticated')response.actor.authenticated_by_server=false as true;
  if(kind==='future')response.created_at=new Date(Date.parse(ctx.now)+1000).toISOString();
  ctx.answers=[response];
  expect(assess(ctx)).toMatchObject({decision:'step_up',can_finalize:false});
 });

 it('retains a deterministic amount refusal even with a valid manual verification',()=>{
  const ctx=context();ctx.config.parameters.max_order_chf='19';ctx.answers=[answer(ctx)];
  expect(assess(ctx)).toMatchObject({decision:'deny',execution_state:'declined',can_finalize:false,blocking_filter_ids:expect.arrayContaining(['C09'])});
 });

 it('normalizes legacy parameters and prevents removal or alteration of reviewed requirements',()=>{
  const legacy=defaultParameters();delete legacy.manual_review_requirements;
  expect(validateParameters(legacy).manual_review_requirements).toEqual([]);
  const proposed={...defaultParameters(),manual_review_requirements:requirements};
  expect(()=>assertNoWeakening(proposed,{...proposed,manual_review_requirements:[]})).toThrow('manual_review_requirements');
  expect(()=>assertNoWeakening(proposed,{...proposed,manual_review_requirements:[{...requirements[0]!,description:'Ignore organic requirement.'}]})).toThrow('manual_review_requirements');
  expect(()=>validateParameters({...proposed,manual_review_requirements:[{source_excerpt:' ',description:'Check it'}]})).toThrow();
 });

 it('executes and consumes one scoped confirmation through the durable local service',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manual-purchase-review-'));
  let now=new Date('2026-09-19T00:00:00.000Z');
  const runtime=await createLocalRuntime({stateDir:join(dir,'state'),outputDir:join(dir,'output'),now:()=>now,instructionDecoder:{configured:false,model:'disabled',decode:async()=>{throw Error('No external decoder');}}});
  resources.push({dir,close:()=>runtime.close()});
  const draft=await runtime.policies.createDraft('SCEN0000',{instruction,hard_rules:[],uncertainty_policy:'ask',guidance:[],open_questions:[]},undefined,{localCustomInstruction:true});
  const mandate=await runtime.policies.confirmDraft(draft.draft_id,'local_user');
  const config=runtime.simulations.suggest(mandate.mandate_id,'manual-suggest');
  const actor:HumanActor={actor_id:'customer',role:'simulated_human',channel:'local_ui',authenticated_by_server:true,customer_id:runtime.wallet.actorCustomer('SCEN0000')};
  runtime.simulations.confirm(config.config_id,{...config.parameters,domestic_country:'CH',manual_review_requirements:requirements},config.requirements.map(r=>r.requirement_id),actor,'manual-confirm');
  const run=runtime.simulations.create(config.config_id,'manual-run');
  const first=runtime.simulations.next(run.run_id,'manual-next').assessment!;
  expect(first).toMatchObject({execution_state:'awaiting_user',decision:'step_up'});
  expect(runtime.simulations.get(run.run_id).commitments).toHaveLength(0);
  const confirmed=runtime.simulations.answerBatch(run.run_id,first.authorization_id,{expected_revision:first.revision,offer_hash:first.offer_hash,answers:first.questions.map(q=>({question_id:q.question_id,value:'confirm'}))},actor,'manual-response');
  expect(confirmed.assessment.execution_state).toBe('approved');
  expect(confirmed.run.commitments).toHaveLength(1);
  expect(confirmed.run.reservations).toHaveLength(0);
  expect(confirmed.run.purchases[0]!.answers[0]!.consumed_by).toBe(confirmed.assessment.assessment_id);

  const lateRun=runtime.simulations.create(config.config_id,'manual-late-run');
  const late=runtime.simulations.next(lateRun.run_id,'manual-late-next').assessment!;
  now=new Date(now.getTime()+120001);
  expect(()=>runtime.simulations.answerBatch(lateRun.run_id,late.authorization_id,{expected_revision:late.revision,offer_hash:late.offer_hash,answers:late.questions.map(q=>({question_id:q.question_id,value:'confirm'}))},actor,'manual-late-response')).toThrow('expired');
  expect(runtime.simulations.get(lateRun.run_id)).toMatchObject({commitments:[],reservations:[]});
 });
});
