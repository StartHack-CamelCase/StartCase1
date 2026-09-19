import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {AppError} from '../packages/contracts/src/errors.js';
import {fixture} from './simulation-fixture.js';
import {preparePermissions,applyParameters} from '../packages/local-runtime/src/services/wallet-preparation.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';
import {configuredInstructionDecoder} from './helpers/configured-instruction-decoder.js';

function prepare(instruction:string,fallback?:string){const ctx=fixture();const prepared=preparePermissions(ctx.pack,instruction,null,ctx.now,fallback);return {ctx,prepared,review:{...prepared,instruction,decoding:null} as WalletPreparation};}

describe('free instructions keep per-purchase review executable',()=>{
 it('fails closed after OpenAI timeouts and keeps failed preparation replays idempotent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wallet-decoder-outage-'));
  const decode=vi.fn(async()=>{throw new AppError(504,'instruction_decoding_timeout','Decoding timed out.');});
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{model:'outage-test',configured:true,decode}});
  try{
   const scenario_id='SCEN0000';const instruction=(await app.inject('/api/wallet/options')).json().scenarios[0].instruction;
   const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'outage-prepare'};
   const created=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode:'local'}});
   expect(created.statusCode).toBe(202);let preparation:WalletPreparation;
   const get=()=>app.inject(`/api/wallet/preparations/${created.json().preparation_id}`);
   await vi.waitFor(async()=>{preparation=(await get()).json();expect(preparation.status).toBe('failed');});
   expect(preparation!).toMatchObject({config:null,permissions:[],clarifications:[],warnings:[],decoding:null,error:'Decoding timed out.'});
   const firstAttemptCalls=decode.mock.calls.length;expect(firstAttemptCalls).toBeGreaterThan(0);
   const replay=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode:'local'}});
   expect(replay.json()).toEqual(preparation!);expect((await get()).json()).toEqual(preparation!);expect(decode).toHaveBeenCalledTimes(firstAttemptCalls);
   const confirmed=await app.inject({method:'POST',url:`/api/wallet/preparations/${created.json().preparation_id}/confirm`,headers:{...headers,'idempotency-key':'outage-confirm'},payload:{confirmed:true,parameters:{}}});
   expect(confirmed.statusCode,confirmed.body).toBe(409);expect(confirmed.json().error.code).toBe('permission_review_not_ready');
   const retry=await app.inject({method:'POST',url:'/api/wallet/prepare',headers:{...headers,'idempotency-key':'outage-explicit-retry'},payload:{scenario_id,instruction,mode:'local'}});
   expect(retry.json().preparation_id).not.toBe(created.json().preparation_id);
   await vi.waitFor(async()=>{expect((await app.inject(`/api/wallet/preparations/${retry.json().preparation_id}`)).json().status).toBe('failed');});
   expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);expect(decode).toHaveBeenCalledTimes(firstAttemptCalls*2);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });

 it('calls OpenAI afresh for a new preparation of the same instruction and preserves idempotent results',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wallet-fresh-decoding-'));const decoder=configuredInstructionDecoder();const decode=vi.fn(decoder.decode);
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{...decoder,decode}});
  try{
   const scenario_id='SCEN0000';const instruction=(await app.inject('/api/wallet/options')).json().scenarios[0].instruction;
   const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf};const payload={scenario_id,instruction,mode:'local'};
   const prepare=async(key:string)=>{
    const response=await app.inject({method:'POST',url:'/api/wallet/prepare',headers:{...headers,'idempotency-key':key},payload});expect(response.statusCode,response.body).toBe(202);let value!:WalletPreparation;
    await vi.waitFor(async()=>{value=(await app.inject(`/api/wallet/preparations/${response.json().preparation_id}`)).json();expect(value.status).toBe('ready');});return value;
   };
   const first=await prepare('fresh-first');expect(first.decoding?.response_id).toBeTruthy();expect(decode).toHaveBeenCalledTimes(1);
   expect(await prepare('fresh-first')).toEqual(first);expect(decode).toHaveBeenCalledTimes(1);
   const second=await prepare('fresh-second');expect(decode).toHaveBeenCalledTimes(2);
   expect(second.preparation_id).not.toBe(first.preparation_id);expect(second.decoding?.decoding_id).not.toBe(first.decoding?.decoding_id);expect(second.decoding?.response_id).not.toBe(first.decoding?.response_id);
   expect(second.config?.parameters).toEqual(first.config?.parameters);
   expect((await app.inject(`/api/wallet/preparations/${first.preparation_id}`)).json()).toEqual(first);expect(decode).toHaveBeenCalledTimes(2);
   expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });

 it.each(['local','live'] as const)('requires configured OpenAI for %s preparation instead of falling back locally',async mode=>{
  const dir=await mkdtemp(join(tmpdir(),'wallet-openai-required-'));const decode=vi.fn(async()=>{throw Error('An unconfigured decoder cannot be called');});const transport=vi.fn(async()=>{throw Error('Preparation cannot start a purchase');});
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{model:'unconfigured',configured:false,decode},liveOptions:{environment:'mock',baseUrl:'http://127.0.0.1:4313',apiKey:'test',transport}});
  try{
   const scenario_id='SCEN0000';const instruction=(await app.inject('/api/wallet/options')).json().scenarios[0].instruction;const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'unconfigured-prepare'};
   const response=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode}});expect(response.statusCode,response.body).toBe(202);
   const preparation=(await app.inject(`/api/wallet/preparations/${response.json().preparation_id}`)).json<WalletPreparation>();
   expect(preparation).toMatchObject({status:'failed',config:null,permissions:[],clarifications:[],warnings:[],decoding:null});expect(preparation.error).toContain('OpenAI decoding is not configured');
   expect(decode).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });
 it.each([
  ['Buy organic groceries for at most CHF 25. No peanuts.','25'],
  ['Achète des courses pour moins de 19 CHF. Vérifie les ingrédients.','18.99'],
  ['Buy a monitor between CHF 100 and CHF 350 with a five-year warranty.','350'],
 ])('starts %s with its complete instruction preserved and automatic amount checks', (instruction,maximum)=>{
  const {ctx,prepared,review}=prepare(instruction);
  expect(prepared.config!.parameters.max_order_chf).toBe(maximum);
  expect(prepared.config!.parameters.manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
  expect(prepared.clarifications.length).toBeGreaterThan(0);
  expect(prepared.clarifications.every(c=>c.resolution==='purchase_review')).toBe(true);
  expect(applyParameters(review,prepared.config!.parameters,ctx.pack)).toEqual(prepared.config!.parameters);
  for(const manual_review_requirements of [[],[{source_excerpt:instruction,description:'Anything is allowed'}]])expect(()=>applyParameters(review,{...prepared.config!.parameters,manual_review_requirements},ctx.pack)).toThrow();
 });

 it('does not bypass old unresolved reviews that have no executable purchase-review requirement',()=>{
  const {ctx,review}=prepare('Buy organic groceries for at most CHF 25.');
  review.config!.parameters.manual_review_requirements=[];
  expect(()=>applyParameters(review,review.config!.parameters,ctx.pack)).toThrow(/Decode this instruction again/);
 });
});
