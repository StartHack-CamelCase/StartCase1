import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {createLocalRuntime,type LocalRuntime} from '../packages/local-runtime/src/runtime.js';
import type {HumanActor} from '../packages/contracts/src/simulation.js';
import {fixture} from './simulation-fixture.js';
import {assess} from '../packages/local-runtime/src/simulation/evaluator.js';
import {hash} from '../packages/local-runtime/src/simulation/common.js';

const resources:{runtime:LocalRuntime;dir:string}[]=[];
afterEach(async()=>{for(const {runtime,dir} of resources.splice(0)){await runtime.close();await rm(dir,{recursive:true,force:true});}});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'simulation-offline-port-'));
 const runtime=await createLocalRuntime({stateDir:join(dir,'state'),outputDir:join(dir,'output')});resources.push({runtime,dir});
 const instruction=runtime.pack.scenariosById.get('SCEN0000' as never)!.cardholder_instruction;
 const draft=await runtime.policies.createDraft('SCEN0000' as never,{instruction,hard_rules:[],uncertainty_policy:'ask',guidance:[],open_questions:[]});
 const mandate=await runtime.policies.confirmDraft(draft.draft_id,'local_user');
 const config=runtime.simulations.suggest(mandate.mandate_id,'suggest-safe');
 const attempt=runtime.pack.attemptsByScenario.get('SCEN0000' as never)![0]!;
 const authority=runtime.pack.authoritiesById.get(attempt.authority_id)!;
 const actor:HumanActor={actor_id:'customer',customer_id:authority.customer_id,role:'simulated_human',authenticated_by_server:true,channel:'local_ui'};
 const confirmed=runtime.simulations.confirm(config.config_id,{...config.parameters,always_ask:true,domestic_country:'CH'},config.requirements.map(r=>r.requirement_id),actor,'confirm-safe');
 return {runtime,actor,config:confirmed,mandate};
}

it('freezes only the run customer history while preserving the pack coverage window',async()=>{
 const {runtime,config}=await setup();const run=runtime.simulations.create(config.config_id,'history-run');
 const expected=runtime.pack.history.filter(row=>row.customer_id===run.customer_id);
 expect(expected.length).toBeGreaterThan(0);expect(expected.length).toBeLessThan(runtime.pack.history.length);
 expect(run.history).toEqual(expected);expect(run.history_hash).toBe(hash(expected));expect(run.history_coverage.rows).toBe(expected.length);
 const dates=runtime.pack.history.map(row=>row.timestamp).sort();expect(run.history_coverage).toMatchObject({from:dates[0],to:dates.at(-1)});
 expect(runtime.simulations.store.select(state=>Object.keys(state.commands))).toEqual([]);
 expect(runtime.simulations.store.read().commands['history-run']?.response).toEqual(run);
});

it('customer-scoped history preserves all fifty filter outcomes for every supplied authorization',()=>{
 for(let index=1;index<=45;index++){
  const context=fixture('AU'+String(index).padStart(4,'0'));context.config.parameters.familiar_merchant=true;context.config.parameters.watch_devices=true;
  const before=assess(context);context.run.history=context.run.history.filter(row=>row.customer_id===context.event.mandate.customer_id);const after=assess(context);
  expect(after.results.map(row=>[row.filter_id,row.outcome,row.reasons.map(reason=>reason.code)]),context.event.authorization.source_authorization_id).toEqual(before.results.map(row=>[row.filter_id,row.outcome,row.reasons.map(reason=>reason.code)]));
 }
});

it('blocks a persisted G06 marker regardless of its wording on answer, reevaluation and useConfig, while retaining cancellation',async()=>{
 const {runtime,config,actor}=await setup(),run=runtime.simulations.create(config.config_id,'unsafe-old-run');
 const first=runtime.simulations.next(run.run_id,'unsafe-old-purchase').assessment!;expect(first.decision).toBe('step_up');
 // Model an older application that marked a non-executable configuration confirmed.
 runtime.simulations.store.transaction('import-unsafe-marker',{},state=>{
  const config=state.configs.find(c=>c.config_id===run.config.config_id)!;
  config.requirements.push({requirement_id:'LEGACY_G06',source_excerpt:'uncompiled',description:'Contrôle hérité',filter_ids:['G06'],parameter_keys:[],status:'confirmed',question:null,author:'legacy',revision:1});
  state.runs.find(r=>r.run_id===run.run_id)!.config=structuredClone(config);return null;
 });
 const input={expected_revision:first.revision,offer_hash:first.offer_hash,question_id:first.questions[0]!.question_id,value:'confirm'};
 expect(()=>runtime.simulations.answer(run.run_id,first.authorization_id,input,actor,'unsafe-answer')).toThrow('cannot be enforced');
 expect(()=>runtime.simulations.reevaluate(run.run_id,first.authorization_id,first.revision,'unsafe-reevaluate')).toThrow('cannot be enforced');
 expect(()=>runtime.simulations.useConfig(run.run_id,config.config_id,'unsafe-use-config',actor)).toThrow('cannot be enforced');
 expect(()=>runtime.simulations.exportConfig(config.config_id)).toThrow('cannot be enforced');
 expect(runtime.simulations.get(run.run_id).commitments).toEqual([]);
 const cancelled=runtime.simulations.cancel(run.run_id,first.authorization_id,actor,'unsafe-cancel');
 expect(cancelled.purchases[0]!.assessments.at(-1)?.execution_state).toBe('cancelled');expect(cancelled.reservations).toEqual([]);
 expect(()=>runtime.simulations.reevaluate(run.run_id,first.authorization_id,cancelled.purchases[0]!.assessments.at(-1)!.revision,'cancel-stays-terminal')).toThrow('rejected by the customer');
});
