import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {AppError} from '../packages/contracts/src/errors.js';
import type {WalletPreparation,WalletRunView} from '../packages/contracts/src/wallet.js';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import {preparePermissions} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {checkCoverageText,renderPurchaseCard} from '../apps/local-web/web/wallet-run-view.js';
import {fixture} from './simulation-fixture.js';
import {configuredInstructionDecoder} from './helpers/configured-instruction-decoder.js';

const instruction='I want to buy a computer from a big shop that is on fast delivery and that costs less than 200 francs, and the minimum price has to be 50 francs. ';

describe('reported computer request end to end',()=>{
 it('enforces price and product when the decoder omits them and the scenario proposes groceries',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'computer-wallet-'));
  const app=await createLocalApp({stateDir:join(directory,'state'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder()});
  try{
   const scenario_id='SCEN0000';
   const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'computer-regression-prepare'};
   const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode:'local'}});
   expect(prepared.statusCode,prepared.body).toBe(202);
   const url=`/api/wallet/preparations/${prepared.json().preparation_id}`;
   let p:WalletPreparation;
   await vi.waitFor(async()=>{p=(await app.inject(url)).json();expect(p.status).toBe('ready');});
   expect(p!.config!.parameters).toMatchObject({min_order_chf:'50',max_order_chf:'199.99',product_type:'computer',allowed_item_categories:['electronics'],fulfillment_method:'delivery',delivery_deadline:null,allowed_merchant_ids:null});
   expect(p!.instruction).toBe(instruction);
   expect(p!.clarifications.filter(c=>c.key.startsWith('amount:'))).toEqual([]);
   expect(p!.clarifications).toEqual(expect.arrayContaining([expect.objectContaining({key:'unresolved:merchant-size'}),expect.objectContaining({key:'unresolved:delivery-speed'})]));
   const started=await app.inject({method:'POST',url:url+'/confirm',headers,payload:{confirmed:true,parameters:p!.config!.parameters,mode:'local'}});
   expect(started.statusCode,started.body).toBe(200);
   const id=started.json().run_id;
   const next=await app.inject({method:'POST',url:`/api/simulations/${id}/next`,headers:{...headers,'idempotency-key':'computer-regression-next'},payload:{}});
   expect(next.statusCode,next.body).toBe(200);
   const view=(await app.inject(`/api/wallet/runs/${id}`)).json<WalletRunView>();
   const purchase=view.purchases[0]!;
   expect(purchase.merchant_name).toBe('Alpine Basket');expect(purchase.amount_chf).toBe('20');
   expect(purchase.assessment).toMatchObject({decision:'deny',execution_state:'declined'});
   expect(purchase.assessment!.blocking_filter_ids).toEqual(expect.arrayContaining(['C09','M09']));
   expect(renderPurchaseCard(purchase,'local',view.status,scenario_id)).not.toContain('Confirm this purchase');
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
 });

 it('blocks preparation when the decoder fails, without exposing confirmable fallback permissions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'computer-wallet-failure-'));
  const app=await createLocalApp({stateDir:join(directory,'state'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{model:'decoder-fixture',configured:true,decode:vi.fn(async()=>{throw new AppError(502,'instruction_decoding_invalid','A decoded field appears more than once.');})}});
  try{
   const session=await app.inject('/api/wallet/session?scenario_id=SCEN0000');
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'computer-failure-prepare'};
   const response=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0000',instruction,mode:'local'}});
   expect(response.statusCode,response.body).toBe(202);
   const url=`/api/wallet/preparations/${response.json().preparation_id}`;
   await vi.waitFor(async()=>expect((await app.inject(url)).json<WalletPreparation>().status).toBe('failed'));
   const failed=(await app.inject(url)).json<WalletPreparation>();
   expect(failed).toMatchObject({instruction,status:'failed',config:null,decoding:null});
   const confirmed=await app.inject({method:'POST',url:url+'/confirm',headers,payload:{confirmed:true,parameters:{},mode:'local'}});
   expect(confirmed.statusCode).toBeGreaterThanOrEqual(400);
   expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
 });

 it('retains undefined merchant-size and delivery-speed requirements even if the decoder omits them',()=>{
  const ctx=fixture();
  const decoding={instruction,variables:[{field:'authorization.items[].item_name',status:'present',value:'computer',operator:'=',currency:null,scope:null,period_days:null,source_excerpt:instruction,note:null}],unmapped_requirements:[]} as unknown as InstructionDecoding;
  const result=preparePermissions(ctx.pack,instruction,decoding,ctx.now);
  expect(result.config!.parameters.manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
  expect(result.clarifications.some(c=>c.key==='unresolved:authorization.items[].item_name')).toBe(false);
  expect(result.clarifications.some(c=>c.key==='unresolved:merchant-size')).toBe(true);
  expect(result.clarifications.some(c=>c.key==='unresolved:delivery-speed')).toBe(true);
 });

 it('distinguishes exercised checks from inapplicable or unavailable checks',()=>{
  const results=['pass','pass','fail','needs_review','not_applicable','not_evaluated'].map(outcome=>({outcome})) as Parameters<typeof checkCoverageText>[0]['results'];
  expect(checkCoverageText({results})).toBe('2 passed · 1 failed · 1 need review · 1 not applicable · 1 not evaluated');
 });
});
