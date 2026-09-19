import {configuredInstructionDecoder} from './helpers/configured-instruction-decoder.js';
import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {preparePermissions,applyParameters} from '../packages/local-runtime/src/services/wallet-preparation.js';
import type {WalletPreparation,MonetaryMeaning} from '../packages/contracts/src/wallet.js';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import {fixture} from './simulation-fixture.js';
import {assess} from '../packages/local-runtime/src/simulation/evaluator.js';
import {hash,offerHash} from '../packages/local-runtime/src/simulation/common.js';

const instructions=[
 'CHF 120 groceries from Migros.',
 'CHF 20 shampoo from unfamiliar shop.',
 'CHF 60 headphones from Digitec.',
 'CHF 15 Netflix subscription.',
 'CHF 18 groceries with weekly spending of CHF 245.',
 'CHF 45 unusually expensive groceries.',
 'CHF 25 potentially duplicate groceries.',
];
function prepare(instruction:string,decoding:InstructionDecoding|null=null){
 const ctx=fixture();const prepared=preparePermissions(ctx.pack,instruction,decoding,ctx.now);
 return {ctx,prep:{...prepared,instruction,decoding} as WalletPreparation};
}

describe('monetary meaning requires separate, explicit consent',()=>{
 it.each(instructions)('asks about the amount without inventing spending limits: %s',instruction=>{
  const {ctx,prep}=prepare(instruction);
  expect(prep.config!.instruction).toBe(instruction);
  expect(prep.config!.parameters).toMatchObject({min_order_chf:null,max_order_chf:null,rolling_budget:null});
  const questions=prep.clarifications.filter(c=>c.key.startsWith('amount:'));
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({required:true,type:'select',value:''});
  expect(questions[0]!.options!.map(o=>o.value)).toEqual(['maximum','minimum','exact','approximate','description','range']);
  expect(()=>applyParameters(prep,prep.config!.parameters,ctx.pack)).toThrow(/What does CHF/);
  const accepted=applyParameters(prep,prep.config!.parameters,ctx.pack,{'amount:0':'description'});
  expect(accepted.min_order_chf).toBeNull();expect(accepted.max_order_chf).toBeNull();
 });

 it.each([
  ['maximum',null,'120'],['minimum','120',null],['exact','120','120'],['description',null,null],
 ] as Array<[MonetaryMeaning,string|null,string|null]>)('honours the reviewed %s meaning', (meaning,min,max)=>{
  const {ctx,prep}=prepare(instructions[0]!);
  const values={...prep.config!.parameters,min_order_chf:min,max_order_chf:max};
  expect(applyParameters(prep,values,ctx.pack,{'amount:0':meaning})).toEqual(values);
 });

 it.each(['approximate','range'] as const)('enforces both customer supplied bounds for %s',meaning=>{
  const {ctx,prep}=prepare('Buy about CHF 25 groceries.'),choices={'amount:0':{meaning,min_order_chf:'20.00',max_order_chf:'30.00'}};
  const values={...prep.config!.parameters,min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[]};
  expect(applyParameters(prep,values,ctx.pack,choices)).toEqual(values);
  expect(prep.clarifications.find(c=>c.key==='amount:0')!.diagnostic!.decoded_value).toBe('25');
  expect(prep.instruction).toBe('Buy about CHF 25 groceries.');
  expect(()=>applyParameters(prep,{...values,max_order_chf:'31'},ctx.pack,choices)).toThrow('must match');
 });

 it('rejects incomplete, malformed, inverted and incompatible range consent',()=>{
  const {ctx,prep}=prepare('Buy about CHF 25 groceries.');
  for(const answer of ['approximate','range',{meaning:'approximate'},{meaning:'range',min_order_chf:'20'},
   {meaning:'range',min_order_chf:'',max_order_chf:'30'},
   {meaning:'range',min_order_chf:20,max_order_chf:'30'},
   {meaning:'range',min_order_chf:'20.001',max_order_chf:'30'},
   {meaning:'range',min_order_chf:'-20',max_order_chf:'30'},
   {meaning:'range',min_order_chf:'2e1',max_order_chf:'30'},
   {meaning:'range',min_order_chf:'30',max_order_chf:'20'},
   {meaning:'approximate',min_order_chf:'26',max_order_chf:'30'},
   {meaning:'range',min_order_chf:'20',max_order_chf:'30',target_amount_chf:'26'},
  ])expect(()=>applyParameters(prep,prep.config!.parameters,ctx.pack,{'amount:0':answer})).toThrow();
  const choices={'amount:0':{meaning:'range',min_order_chf:'20',max_order_chf:'30'}};
  prep.config!.parameters.max_order_chf='15';
  expect(()=>applyParameters(prep,{...prep.config!.parameters,manual_review_requirements:[]},ctx.pack,choices)).toThrow('conflicts with another confirmed limit');
 });

 it.each(['Buy about CHF 25 groceries.','Buy some groceries for CHF 25.','Buy groceries for approximately CHF 25. Ask me when uncertain.'])('resolves only the generated monetary review for a plain request: %s',instruction=>{
  const {ctx,prep}=prepare(instruction),choices={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}};
  expect(prep.amount_review_requirement).toEqual({source_excerpt:instruction,description:instruction});
  expect(prep.clarifications.some(c=>c.key.startsWith('unresolved:'))).toBe(false);
  const extra={source_excerpt:'groceries',description:'Verify these groceries for each purchase.'};
  const values={...prep.config!.parameters,min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[extra]};
  expect(applyParameters(prep,values,ctx.pack,choices).manual_review_requirements).toEqual([extra]);
  expect(applyParameters(prep,prep.config!.parameters,ctx.pack,{'amount:0':'description'}).manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
  expect(()=>applyParameters(prep,{...values,manual_review_requirements:prep.config!.parameters.manual_review_requirements},ctx.pack,choices)).toThrow('temporary purchase review');
 });

 it.each(['Buy about CHF 25 organic groceries.','Buy about CHF 25 groceries from a big shop.','Buy about CHF 25 groceries with fast delivery.','Buy about CHF 25 groceries. Never buy spoiled food.'])('preserves purchase review for additional source uncertainty: %s',instruction=>{
  const {ctx,prep}=prepare(instruction),choices={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}};
  expect(prep.amount_review_requirement).toBeNull();
  const values={...prep.config!.parameters,min_order_chf:'20',max_order_chf:'30'};
  expect(applyParameters(prep,values,ctx.pack,choices).manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
  expect(()=>applyParameters(prep,{...values,manual_review_requirements:[]},ctx.pack,choices)).toThrow('manual_review_requirements');
 });

 it('preserves failed decoder and unmapped requirement review even for a plain price source',()=>{
  const instruction='Buy about CHF 25 groceries.',ctx=fixture();
  const decoding:InstructionDecoding={decoding_id:'unmapped',schema_version:1,prompt_version:'test',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:ctx.now,duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0},instruction,variables:[],unmapped_requirements:[{source_excerpt:instruction,description:'Confirm the complete purchase intent.',reason:'no_native_field'}]};
  for(const prepared of [preparePermissions(ctx.pack,instruction,null,ctx.now,'The decoder failed.'),preparePermissions(ctx.pack,instruction,decoding,ctx.now)]){
   expect(prepared.amount_review_requirement).toBeNull();
   const prep={...prepared,instruction,decoding} as WalletPreparation,values={...prep.config!.parameters,min_order_chf:'20',max_order_chf:'30'};
   const choices={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}};
   expect(applyParameters(prep,values,ctx.pack,choices).manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
   expect(()=>applyParameters(prep,{...values,manual_review_requirements:[]},ctx.pack,choices)).toThrow('manual_review_requirements');
  }
 });

 it('automatically clears an in-range grocery purchase and denies prices outside the confirmed range',()=>{
  const instruction='Buy about CHF 25 groceries.',ctx=fixture('AU0001');
  const prep={...preparePermissions(ctx.pack,instruction,null,ctx.now),instruction,decoding:null} as WalletPreparation;
  const parameters=applyParameters(prep,{...prep.config!.parameters,min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[]},ctx.pack,{'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}});
  ctx.config.parameters=parameters;ctx.config.instruction=instruction;ctx.config.instruction_hash=hash(instruction);ctx.offer_hash=offerHash(ctx.event,ctx.config);
  expect(assess(ctx)).toMatchObject({can_finalize:true,questions:[]});
  for(const price of [19.99,30.01]){
   ctx.event.authorization.amount=price;ctx.event.authorization.billing_amount_chf=price;
   ctx.event.authorization.items_subtotal=Number((price-7).toFixed(2));ctx.event.authorization.items[0]!.unit_price=Number((price-7).toFixed(2));
   ctx.offer_hash=offerHash(ctx.event,ctx.config);
   expect(assess(ctx)).toMatchObject({decision:'deny',execution_state:'declined',blocking_filter_ids:expect.arrayContaining(['C09'])});
  }
 });

 it('rejects contradictory JSON and unrecognized or missing choices',()=>{
  const {ctx,prep}=prepare(instructions[0]!);
  expect(()=>applyParameters(prep,prep.config!.parameters,ctx.pack,{'amount:0':'maximum'})).toThrow(/must match/);
  expect(()=>applyParameters(prep,{...prep.config!.parameters,min_order_chf:'120'},ctx.pack,{'amount:0':'description'})).toThrow(/must match/);
  for(const choices of [null,[],{'amount:0':'auto'},{'amount:0':'description','amount:1':'minimum'}])expect(()=>applyParameters(prep,prep.config!.parameters,ctx.pack,choices)).toThrow();
 });

 it('removes unsupported legacy model floors and ceilings while preserving decoding provenance',()=>{
  for(const operator of ['>=','<=','='] as const){
   const instruction=instructions[0]!;
   const decoded:InstructionDecoding={decoding_id:'legacy',schema_version:1,prompt_version:'legacy',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:'2026-09-19T00:00:00Z',duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0},instruction,variables:[{field:'authorization.billing_amount_chf',status:'present',value:120,operator,currency:'CHF',scope:'purchase',period_days:null,source_excerpt:instruction,note:null}],unmapped_requirements:[]};
   const before=structuredClone(decoded),{prep}=prepare(instruction,decoded);
   expect(prep.config!.parameters).toMatchObject({min_order_chf:null,max_order_chf:null});
   expect(decoded).toEqual(before);
   expect(prep.clarifications.some(c=>c.key==='amount:0')).toBe(true);
  }
 });

 it('persists the exact instruction and interpretation and starts only after matching consent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wallet-monetary-'));
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder()});
  try{
   const scenario_id='SCEN0000',instruction=instructions[0]!;
   const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'monetary-prepare'};
   const created=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode:'local'}});
   expect(created.statusCode,created.body).toBe(202);
   const url=`/api/wallet/preparations/${created.json().preparation_id}`;
   let prep:WalletPreparation;
   await vi.waitFor(async()=>{prep=(await app.inject(url)).json();expect(prep.status).toBe('ready');});
   const payload={confirmed:true,parameters:prep!.config!.parameters,mode:'local'};
   const missing=await app.inject({method:'POST',url:url+'/confirm',headers,payload});
   expect(missing.statusCode,missing.body).toBe(422);
   expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
   const confirmed=await app.inject({method:'POST',url:url+'/confirm',headers,payload:{...payload,amount_interpretations:{'amount:0':'description'}}});
   expect(confirmed.statusCode,confirmed.body).toBe(200);
   const saved=(await app.inject(url)).json<WalletPreparation>();
   expect(saved.instruction).toBe(instruction);
   expect(saved.confirmation?.amount_interpretations).toEqual({'amount:0':'description'});
   const retry=await app.inject({method:'POST',url:url+'/confirm',headers,payload:{...payload,amount_interpretations:{'amount:0':'description'}}});
   expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual(confirmed.json());
   const changed=await app.inject({method:'POST',url:url+'/confirm',headers,payload:{...payload,parameters:{...payload.parameters,min_order_chf:'100',max_order_chf:'140'},amount_interpretations:{'amount:0':{meaning:'approximate',min_order_chf:'100',max_order_chf:'140'}}}});
   expect(changed.statusCode,changed.body).toBe(409);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });

 it('rejects incomplete direct API range submissions and persists the confirmed target and endpoints',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wallet-price-range-'));
  // This fixture has only the explicit monetary ambiguity; the compiler must
  // remove its temporary review after the customer supplies both endpoints.
  const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder('range-test-decoder',{unmappedRequirements:[]})});
  try{
   const scenario_id='SCEN0000',instruction='Buy about CHF 25 groceries.';
   const session=await app.inject(`/api/wallet/session?scenario_id=${scenario_id}`);
   const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'range-prepare'};
   const created=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id,instruction,mode:'local'}});
   expect(created.statusCode,created.body).toBe(202);
   const url=`/api/wallet/preparations/${created.json().preparation_id}`;
   let prep:WalletPreparation;
   await vi.waitFor(async()=>{prep=(await app.inject(url)).json();expect(prep.status).toBe('ready');});
   const parameters={...prep!.config!.parameters,min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[]},payload={confirmed:true,parameters,mode:'local'};
   let index=0;
   for(const answer of ['approximate',{meaning:'range',min_order_chf:'20'},{meaning:'range',min_order_chf:'35',max_order_chf:'30'},{meaning:'approximate',min_order_chf:'26',max_order_chf:'30'},{meaning:'range',min_order_chf:'20',max_order_chf:'31'}]){
    const rejected=await app.inject({method:'POST',url:url+'/confirm',headers:{...headers,'idempotency-key':`invalid-range-${index++}`},payload:{...payload,amount_interpretations:{'amount:0':answer}}});
    expect(rejected.statusCode,rejected.body).toBe(422);
   }
   expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
   const amount_interpretations={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}};
   const confirmed=await app.inject({method:'POST',url:url+'/confirm',headers:{...headers,'idempotency-key':'valid-range'},payload:{...payload,amount_interpretations}});
   expect(confirmed.statusCode,confirmed.body).toBe(200);
   const saved=(await app.inject(url)).json<WalletPreparation>();
   expect(saved.instruction).toBe(instruction);
   expect(saved.confirmation?.amount_interpretations).toEqual(amount_interpretations);
   expect(saved.confirmation?.parameters).toMatchObject({min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[]});
   expect(saved.clarifications.find(c=>c.key==='amount:0')!.diagnostic!.decoded_value).toBe('25');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });
});
