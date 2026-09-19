import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import { hasUnsupportedRule, suggestConfig } from '../packages/local-runtime/src/simulation/config.js';
import type { MandateRecord } from '../packages/contracts/src/policy.js';
import { createLocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { fixture } from './simulation-fixture.js';

const resources:{close:()=>Promise<void>;dir:string}[]=[];
afterEach(async()=>{for(const r of resources.splice(0)){await r.close();await rm(r.dir,{recursive:true,force:true});}});

describe('hard-rule compilation guard',()=>{
 it('represents an unsupported operator as G06 independent of its wording',async()=>{
  const mandate={mandate_id:'M',version:1,instruction:'purchase limit',hard_rules:[{field:'authorization.billing_amount_chf',operator:'!=',value:1,currency:'CHF',scope:'purchase'}],interpretation:{instruction_decoding:{unmapped_requirements:[]}}} as unknown as MandateRecord;
  const config=suggestConfig(mandate,new Date().toISOString());
  expect(config.requirements.some(r=>r.filter_ids.includes('G06'))).toBe(true);
  expect(hasUnsupportedRule(config)).toBe(true);
  expect(config.parameters.max_order_chf).toBe(null);
 });

 it('refuses an unsupported operator at confirmation before any run exists',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hard-rule-http-'));
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web')});
  resources.push({dir,close:()=>app.close()});
  const detail=(await app.inject('/api/scenarios/SCEN0000')).json<any>();
  const created=await app.inject({method:'POST',url:'/api/mandate-drafts',headers:{'idempotency-key':'draft0001'},payload:{scenario_id:'SCEN0000',instruction:detail.initial_policy.instruction,hard_rules:[{field:'authorization.billing_amount_chf',operator:'!=',value:1,currency:'CHF',scope:'purchase'}],uncertainty_policy:'ask',guidance:[],open_questions:[]}});
  expect(created.statusCode).toBe(201);
  const draft=created.json<any>();
  const response=await app.inject({method:'POST',url:`/api/mandate-drafts/${draft.draft_id}/confirm`,headers:{'idempotency-key':'mandate01'},payload:{confirmed:true}});
  expect(response.statusCode).toBe(201);
  const mandate=response.json<any>();
  const cfg=(await app.inject({method:'POST',url:`/api/mandates/${mandate.mandate_id}/safety-configs`,headers:{'idempotency-key':'config001'},payload:{}})).json<any>();
  const session=await app.inject(`/api/ui-session?mandate_id=${mandate.mandate_id}`);const cookie=String(session.headers['set-cookie']).split(';')[0]!;
  const guarded=await app.inject({method:'POST',url:`/api/safety-configs/${cfg.config_id}/confirm`,headers:{cookie,'x-csrf-token':session.json<any>().csrf,'idempotency-key':'confirmhard'},payload:{parameters:cfg.parameters,reviewed_requirement_ids:cfg.requirements.map((r:any)=>r.requirement_id)}});
  expect(guarded.statusCode).toBe(409);
  expect(guarded.json().error.code).toBe('G06_RULE_INVALID');
 });
});

it('keeps legacy history readable but blocks a formerly confirmed unsafe mandate before a CHF 20 purchase',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-hard-rule-'));
 const runtime=await createLocalRuntime({stateDir:join(dir,'state'),outputDir:join(dir,'output')});
 resources.push({dir,close:()=>runtime.close()});
 const instruction=runtime.pack.scenarios.find(s=>s.scenario_id==='SCEN0000')!.cardholder_instruction;
 const draft=await runtime.policies.createDraft('SCEN0000' as never,{instruction,hard_rules:[{field:'authorization.billing_amount_chf',operator:'!=',value:1,currency:'CHF',scope:'purchase'}],uncertainty_policy:'ask',guidance:[],open_questions:[]});
 const mandate=await runtime.policies.confirmDraft(draft.draft_id,'local_user');
 const config=runtime.simulations.suggest(mandate.mandate_id,'suggest-legacy');
 // Emulate an old confirmed record whose unsupported requirement was lost.
 config.status='confirmed';config.requirements=config.requirements.filter(r=>!r.filter_ids.includes('G06'));config.confirmed_by='legacy-human';config.confirmed_at=config.created_at;
 const run=fixture('AU0001').run;run.config=config;run.mandate_snapshot={...run.mandate_snapshot,mandate_id:mandate.mandate_id,instruction,hard_rules:mandate.hard_rules};run.mandate_version=mandate.version;
 runtime.simulations.store.transaction('legacy-import',{},state=>{state.configs=state.configs.map(c=>c.config_id===config.config_id?config:c);state.runs.push(run);return null;});
 expect(runtime.pack.attemptsByScenario.get('SCEN0000' as never)![0]!.billing_amount_chf).toBe('20.00');
 expect(runtime.simulations.get(run.run_id).purchases).toHaveLength(0);
 expect(()=>runtime.simulations.create(config.config_id,'legacy-create')).toThrow('cannot be enforced');
 expect(()=>runtime.simulations.exportConfig(config.config_id)).toThrow('cannot be enforced');
 expect(()=>runtime.simulations.next(run.run_id,'legacy-next')).toThrow('cannot be enforced');
 expect(runtime.simulations.get(run.run_id)).toMatchObject({purchases:[],commitments:[],reservations:[]});
});
