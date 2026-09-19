import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import type { DecodedVariable, InstructionDecoding } from '../packages/contracts/src/instruction-decoding.js';
import type { SafetyParameters } from '../packages/contracts/src/simulation.js';
import type { WalletPreparation, WalletRunView } from '../packages/contracts/src/wallet.js';
import { WALLET_PERMISSION_COMPILER_VERSION } from '../packages/local-runtime/src/services/wallet-service.js';
import { WalletStore } from '../packages/local-runtime/src/storage/wallet-store.js';
import { configuredInstructionDecoder } from './helpers/configured-instruction-decoder.js';

const instruction='Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly. Ask me when uncertain.';
const resources:Array<{app:FastifyInstance;dir:string}>=[];
afterEach(async()=>{for(const r of resources.splice(0)){await r.app.close();await rm(r.dir,{recursive:true,force:true});}});

function legacyDecoding():InstructionDecoding {
 const variable=(field:string,value:DecodedVariable['value'],source_excerpt:string,extra:Partial<DecodedVariable>={}):DecodedVariable=>({field,status:'present',value,operator:null,currency:null,scope:null,period_days:null,source_excerpt,note:null,...extra});
 return {
  decoding_id:'legacy-v9-scen0000',instruction,schema_version:1,prompt_version:'instruction-variables-v9',source_schema_hash:'legacy-schema-hash',model_requested:'gpt-5.4-mini',model_returned:'gpt-5.4-mini',response_id:'legacy-response',created_at:'2026-09-18T21:00:00.000Z',duration_ms:3038,usage:{input_tokens:100,output_tokens:100,reasoning_tokens:0},
  variables:[
   variable('authorization.merchant.merchant_category','shop I use regularly','shop I use regularly'),
   variable('authorization.billing_amount_chf',20,'CHF 20 or less',{operator:'<=',currency:'CHF',scope:'purchase'}),
   variable('authorization.items[].item_category','ordinary grocery item','ordinary grocery item'),
   variable('authorization.items[].quantity',1,'one ordinary grocery item'),
   variable('mandate.uncertainty_policy','ask','Ask me when uncertain.'),
  ],
  unmapped_requirements:[{source_excerpt:'shop I use regularly',description:'Use a regular shop, based on habitual prior purchases.',reason:'no_native_field'}],
 };
}

async function setup(scenarioId='SCEN0000',sourceInstruction=instruction){
 const dir=await mkdtemp(join(tmpdir(),'wallet-preparation-refresh-'));
 const decoder=configuredInstructionDecoder();const decode=vi.fn(decoder.decode);
 const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{...decoder,decode}});
 resources.push({app,dir});
 const session=await app.inject(`/api/wallet/session?scenario_id=${scenarioId}`);
 const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'legacy-prepare-request'};
 const input={scenario_id:scenarioId,instruction:sourceInstruction,mode:'local'};
 const response=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:input});
 expect(response.statusCode,response.body).toBe(202);
 let prep!:WalletPreparation;
 await vi.waitFor(async()=>{prep=(await app.inject(`/api/wallet/preparations/${response.json().preparation_id}`)).json<WalletPreparation>();expect(prep.status).toBe('ready');});
 expect(decode).toHaveBeenCalledTimes(1);decode.mockClear();
 const parameters=structuredClone(prep.config!.parameters);
 const legacy=structuredClone(prep);
 delete legacy.compiler_version;
 legacy.decoding=legacyDecoding();legacy.model='gpt-5.4-mini';legacy.created_at='2026-09-18T21:00:00.000Z';
 legacy.config!.created_at=legacy.created_at;
 delete (legacy.config!.parameters as Partial<SafetyParameters>).min_order_chf;
 legacy.config!.parameters.regularity=null;
 legacy.clarifications=[{key:'unresolved:authorization.merchant.merchant_category',label:'This constraint needs a supported rule before starting: shop I use regularly',type:'text',required:true,value:''}];
 legacy.warnings=['An old compiler could not map the regular-shop requirement.'];
 const save=(value:WalletPreparation)=>{const store=new WalletStore(join(dir,'state','wallet.sqlite'));try{store.save(value);}finally{store.close();}};
 const stored=()=>{const db=new DatabaseSync(join(dir,'state','wallet.sqlite'),{readOnly:true});try{return db.prepare('SELECT body,checksum FROM preparations WHERE id=?').get(legacy.preparation_id)!;}finally{db.close();}};
 save(legacy);
 const get=()=>app.inject(`/api/wallet/preparations/${legacy.preparation_id}`);
 const confirm=(value:SafetyParameters)=>app.inject({method:'POST',url:`/api/wallet/preparations/${legacy.preparation_id}/confirm`,headers:{...headers,'idempotency-key':'legacy-confirm-request'},payload:{confirmed:true,parameters:value}});
 return {app,dir,decode,headers,input,legacy,parameters,save,stored,get,confirm};
}

describe('refreshing stale unconfirmed permission JSON',()=>{
 it.each([true,false])('invalidates saved fallback permissions even with a current compiler (warning saved: %s)',async warningSaved=>{
  const text='Buy about CHF 25 groceries.';
  const x=await setup('SCEN0000',text);
  x.legacy.decoding=null;
  x.legacy.compiler_version=WALLET_PERMISSION_COMPILER_VERSION;
  x.legacy.amount_review_requirement=null;
  x.legacy.warnings=warningSaved?['AI decoding was unavailable: A decoded field appears more than once.']:[];
  x.legacy.clarifications=[{key:'unresolved:decoding',label:'Review the complete instruction for each purchase.',type:'text',required:true,value:'',resolution:'purchase_review'}];
  x.save(x.legacy);
  const refreshed=(await x.get()).json<WalletPreparation>();
  expect(refreshed.status).toBe('failed');
  expect(refreshed.error).toMatch(/OpenAI decoding.*Retry decoding/);
  expect(refreshed.compiler_version).toBe(WALLET_PERMISSION_COMPILER_VERSION);
  expect(refreshed.amount_review_requirement).toBeNull();
  expect(refreshed.config).toBeNull();
  expect(refreshed.permissions).toEqual([]);
  expect(refreshed.clarifications).toEqual([]);
  expect(refreshed.warnings).toEqual([]);
  const confirmation=await x.confirm(x.parameters);
  expect(confirmation.statusCode,confirmation.body).toBe(409);
  expect(confirmation.json().error.code).toBe('permission_review_not_ready');
  expect((await x.app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('preserves partial legacy consent but cannot start a new run without a successful decoding',async()=>{
  const x=await setup();
  x.legacy.decoding=null;
  x.legacy.confirmation={fingerprint:'frozen-confirmation',parameters:x.parameters,actor_id:'prior-human'};
  x.save(x.legacy);const saved=x.stored();
  const response=await x.confirm(x.parameters);
  expect(response.statusCode,response.body).toBe(409);
  expect(response.json().error.code).toBe('permission_review_not_ready');
  expect(x.stored()).toEqual(saved);
  expect((await x.app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it.each([
  ['SCEN0002','LOCAL_DEC_f471b167-c0df-44fb-ad61-2d0c6f750f50'],
  ['SCEN0003','LOCAL_DEC_38fbbc61-e398-4662-8bf8-a0dd05420a31'],
  ['SCEN0004','LOCAL_DEC_aa4fd332-8258-4274-a893-2bde33fc8243'],
  ['SCEN0004','LOCAL_DEC_445b5595-b164-434d-9fda-41bc2910fc6b'],
 ])('repairs the saved %s cardholder paraphrase without calling AI again',async(scenarioId,decodingId)=>{
  const fixtures=JSON.parse(readFileSync(new URL('./fixtures/wallet-official-decodings.json',import.meta.url),'utf8')) as {observed_variants:Array<{decoding:InstructionDecoding}>};
  const decoding=fixtures.observed_variants.find(s=>s.decoding.decoding_id===decodingId)!.decoding;
  const x=await setup(scenarioId,decoding.instruction);
  x.legacy.compiler_version='wallet-permissions-merged-v4';x.legacy.decoding=structuredClone(decoding);x.save(x.legacy);
  const refreshed=(await x.get()).json<WalletPreparation>();
  expect(refreshed.compiler_version).toBe(WALLET_PERMISSION_COMPILER_VERSION);
  expect(refreshed.clarifications).toEqual([]);
  expect(refreshed.decoding).toEqual(decoding);
  const started=await x.confirm(refreshed.config!.parameters);expect(started.statusCode,started.body).toBe(200);
  const run=(await x.app.inject(`/api/wallet/runs/${started.json().run_id}`)).json<WalletRunView>();
  expect(run.config.parameters).toEqual(refreshed.config!.parameters);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('repairs a saved v1 household review and starts with both budgets and delivery intact',async()=>{
  const household='Order our household groceries for delivery. Keep each order at or below CHF 120 including delivery, and keep the total across any seven days at or below CHF 300. Ask me when uncertain.';
  const x=await setup('SCEN0001',household);
  x.legacy.compiler_version='wallet-permissions-v1';
  x.legacy.decoding={...legacyDecoding(),instruction:household,prompt_version:'instruction-variables-v11',variables:[],unmapped_requirements:[{description:'Household groceries are requested.',source_excerpt:household,reason:'no_native_field'}]};
  x.legacy.clarifications=[{key:'unresolved:requirement:0',label:'Unsupported decoded requirement: Household groceries are requested.',type:'text',required:true,value:''}];
  x.save(x.legacy);
  const refreshed=(await x.get()).json<WalletPreparation>();
  expect(refreshed.compiler_version).toBe(WALLET_PERMISSION_COMPILER_VERSION);
  expect(refreshed.clarifications).toEqual([]);
  expect(refreshed.config!.parameters).toMatchObject({min_order_chf:null,max_order_chf:'120',rolling_budget:{days:7,limit_chf:'300'},allowed_item_categories:['groceries','household'],fulfillment_method:'delivery'});
  const started=await x.confirm(refreshed.config!.parameters);expect(started.statusCode,started.body).toBe(200);
  const run=(await x.app.inject(`/api/wallet/runs/${started.json().run_id}`)).json<WalletRunView>();
  expect(run.config.parameters).toEqual(refreshed.config!.parameters);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('refreshes GET from the saved decoding, preserving the source and configuration identity',async()=>{
  const x=await setup();
  const response=await x.get();expect(response.statusCode,response.body).toBe(200);
  const refreshed=response.json<WalletPreparation>();
  expect(refreshed.compiler_version).toBe(WALLET_PERMISSION_COMPILER_VERSION);
  expect(refreshed.config!.parameters).toMatchObject({min_order_chf:null,max_order_chf:'20',regularity:{days:180,distinct_dates:3},allowed_item_categories:['groceries'],max_quantity_per_order:1});
  expect(refreshed.clarifications).toEqual([]);
  expect(refreshed.decoding).toEqual(x.legacy.decoding);
  expect(refreshed).toMatchObject({preparation_id:x.legacy.preparation_id,created_at:x.legacy.created_at,instruction:x.legacy.instruction,model:x.legacy.model,config:{config_id:x.legacy.config!.config_id,created_at:x.legacy.config!.created_at}});
  const saved=x.stored();
  expect((await x.get()).json()).toEqual(refreshed);
  expect(x.stored()).toEqual(saved);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('refreshes an idempotent prepare replay instead of returning the stale review',async()=>{
  const x=await setup();
  const response=await x.app.inject({method:'POST',url:'/api/wallet/prepare',headers:x.headers,payload:x.input});
  expect(response.statusCode,response.body).toBe(202);
  expect(response.json()).toMatchObject({preparation_id:x.legacy.preparation_id,compiler_version:WALLET_PERMISSION_COMPILER_VERSION,clarifications:[],config:{config_id:x.legacy.config!.config_id,parameters:{min_order_chf:null,regularity:{days:180,distinct_dates:3}}},decoding:x.legacy.decoding});
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('refreshes before confirmation without a preceding GET and executes the submitted parameters',async()=>{
  const x=await setup();
  const parameters={...x.parameters,min_order_chf:'20',max_order_chf:'20'};
  const response=await x.confirm(parameters);
  expect(response.statusCode,response.body).toBe(200);
  const result=response.json();
  const run=(await x.app.inject(`/api/wallet/runs/${result.run_id}`)).json<WalletRunView>();
  expect(run.config.parameters).toEqual(parameters);
  expect((await x.get()).json()).toMatchObject({compiler_version:WALLET_PERMISSION_COMPILER_VERSION,decoding:x.legacy.decoding,confirmation:{run_id:result.run_id,parameters}});
  expect((await x.confirm(parameters)).json()).toEqual(result);
  expect(x.decode).not.toHaveBeenCalled();
 });

 it('refreshes before checking a weakened ceiling and creates no run on rejection',async()=>{
  const x=await setup();
  const response=await x.confirm({...x.parameters,max_order_chf:'21'});
  expect(response.statusCode,response.body).toBe(409);
  expect(response.json().error.code).toBe('C03_PERMISSION_AMENDMENT_REQUIRED');
  expect((await x.app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  expect((await x.get()).json()).toMatchObject({compiler_version:WALLET_PERMISSION_COMPILER_VERSION,config:{parameters:{max_order_chf:'20'}}});
  expect(x.decode).not.toHaveBeenCalled();
 });

 it.each(['partial','completed'] as const)('never regenerates a %s confirmation, preserving stored bytes and checksum',async state=>{
  const x=await setup();
  x.legacy.confirmation={fingerprint:'frozen-confirmation',parameters:x.parameters,actor_id:'prior-human',...(state==='completed'?{draft_id:'prior-draft',mandate_id:'prior-mandate',config_id:'prior-config',run_id:'prior-run'}:{})};
  x.save(x.legacy);const saved=x.stored();
  const read=await x.get();expect(read.statusCode,read.body).toBe(200);expect(read.json()).toEqual(x.legacy);
  expect(x.stored()).toEqual(saved);
  const replay=await x.app.inject({method:'POST',url:'/api/wallet/prepare',headers:x.headers,payload:x.input});
  expect(replay.statusCode,replay.body).toBe(202);expect(replay.json()).toEqual(x.legacy);
  expect(x.stored()).toEqual(saved);
  expect(x.decode).not.toHaveBeenCalled();
 });
});
