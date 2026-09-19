import {describe,expect,it} from 'vitest';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';
import {applyParameters,preparePermissions} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {assess} from '../packages/local-runtime/src/simulation/evaluator.js';
import {hash,offerHash} from '../packages/local-runtime/src/simulation/common.js';
import {fixture} from './simulation-fixture.js';

const bare='Buy a computer under CHF 200 and at least CHF 50.';
const variants=[
 {label:'relative delivery tomorrow',instruction:'Buy a computer under CHF 200 and at least CHF 50 with delivery tomorrow.',qualifier:'delivery tomorrow'},
 {label:'relative delivery in two days',instruction:'Buy a computer under CHF 200 and at least CHF 50 with delivery within 2 days.',qualifier:'delivery within 2 days'},
 {label:'fast shipping synonym',instruction:'Buy a computer under CHF 200 and at least CHF 50 with fast shipping.',qualifier:'fast shipping'},
 {label:'large retailer synonym',instruction:'Buy a computer under CHF 200 and at least CHF 50 from a large retailer.',qualifier:'large retailer'},
 {label:'merchant reputation',instruction:'Buy a computer under CHF 200 and at least CHF 50 from a reputable shop.',qualifier:'reputable shop'},
 {label:'refurbished condition',instruction:'Buy a refurbished computer under CHF 200 and at least CHF 50.',qualifier:'refurbished'},
 {label:'minimum RAM specification',instruction:'Buy a computer under CHF 200 and at least CHF 50 with 16GB RAM.',qualifier:'16GB RAM'},
 {label:'existing fast delivery wording',instruction:'Buy a computer under CHF 200 and at least CHF 50 with fast delivery.',qualifier:'fast delivery'},
];
function partialDecoding(instruction:string):InstructionDecoding {
 // A valid but incomplete model response is different from an unavailable decoder.
 return {instruction,decoding_id:'DEC_COMPUTER_QUALIFIER',schema_version:1,prompt_version:'test',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:'2026-09-19T00:00:00Z',duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0},variables:[{field:'authorization.items[].item_name',status:'present',value:'computer',operator:'=',currency:null,scope:null,period_days:null,source_excerpt:'computer',note:null}],unmapped_requirements:[]};
}
function preparation(instruction:string,mode:'omitted'|'fallback'|'reported'='omitted',qualifier='') {
 const ctx=fixture('AU0035');
 const decoding=mode==='fallback'?null:partialDecoding(instruction);
 if(decoding&&mode==='reported')decoding.unmapped_requirements=[{source_excerpt:qualifier,description:`The purchase must satisfy: ${qualifier}.`,reason:'no_native_field'}];
 const prep={...preparePermissions(ctx.pack,instruction,decoding,ctx.now),instruction,decoding} as WalletPreparation;
 return {ctx,prep};
}
function computerOffer(instruction:string,mode:'omitted'|'fallback'|'reported'='omitted',qualifier='') {
 const {ctx,prep}=preparation(instruction,mode,qualifier);
 ctx.config.parameters=applyParameters(prep,prep.config!.parameters,ctx.pack);
 ctx.config.instruction=instruction;ctx.config.instruction_hash=hash(instruction);
 const item=ctx.event.authorization.items[0]!;ctx.event.authorization.items=[item];
 Object.assign(item,{quantity:1,unit_price:100,currency:'CHF',item_name:'Computer',item_details:'New computer with 4GB RAM. One-off purchase. No subscription. Returns allowed for 30 days.'});
 Object.assign(ctx.event.authorization,{amount:100,billing_amount_chf:100,items_subtotal:100,delivery_fee:0,fulfillment_method:'delivery',delivery_by:'2026-12-31'});
 Object.assign(ctx.pack.itemsById.get(item.item_id as never)!,{item_name:'Computer',item_description:'New computer with 4GB RAM',unit_price_min_chf:'1.00',unit_price_max_chf:'1000.00'});
 ctx.offer_hash=offerHash(ctx.event,ctx.config);
 return {ctx,prep};
}

describe('computer qualifiers remain enforced when the model omits them',()=>{
 it('does not force purchase review solely because a clear purchase is a computer',()=>{
  const {ctx,prep}=computerOffer(bare);
  expect(prep.config!.parameters).toMatchObject({min_order_chf:'50',max_order_chf:'199.99',product_type:'computer',allowed_item_categories:['electronics'],manual_review_requirements:[]});
  expect(prep.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);
  expect(assess(ctx)).toMatchObject({can_finalize:true,questions:[]});
 });

 it.each(variants)('retains $label when omitted by a successful decoder',({instruction,qualifier})=>{
  const {ctx,prep}=computerOffer(instruction);
  expect(prep.config!.parameters).toMatchObject({min_order_chf:'50',max_order_chf:'199.99',product_type:'computer',allowed_item_categories:['electronics']});
  const review=prep.config!.parameters.manual_review_requirements??[];
  expect(review.length).toBeGreaterThan(0);
  expect(review.some(r=>(r.source_excerpt+' '+r.description).includes(qualifier))).toBe(true);
  expect(assess(ctx)).toMatchObject({can_finalize:false,decision:'step_up'});
 });

 it.each(variants)('preserves $label in the local fallback and in explicit model findings',({instruction,qualifier})=>{
  for(const mode of ['fallback','reported'] as const){
   const {ctx,prep}=computerOffer(instruction,mode,qualifier);
   expect(prep.config!.parameters.manual_review_requirements?.some(r=>(r.source_excerpt+' '+r.description).includes(qualifier))).toBe(true);
   expect(assess(ctx).can_finalize).toBe(false);
  }
 });

 it.each(variants)('keeps both hard price bounds active during $label review',({instruction})=>{
  for(const price of [49.99,200]){
   const {ctx}=computerOffer(instruction);
   Object.assign(ctx.event.authorization,{amount:price,billing_amount_chf:price,items_subtotal:price});
   ctx.event.authorization.items[0]!.unit_price=price;ctx.offer_hash=offerHash(ctx.event,ctx.config);
   expect(assess(ctx)).toMatchObject({can_finalize:false,decision:'deny',execution_state:'declined',blocking_filter_ids:expect.arrayContaining(['C09'])});
  }
 });

 it.each(variants.filter(v=>/delivery|shipping/.test(v.label)))('does not invent a delivery date for $label',({instruction})=>{
  const {prep}=preparation(instruction);
  expect(prep.config!.parameters.delivery_deadline).toBeNull();
 });

 it('keeps condition and RAM out of unsupported numeric attribute fields',()=>{
  for(const variant of variants.filter(v=>/condition|RAM/.test(v.label))){
   const {prep}=preparation(variant.instruction);
   expect(prep.config!.parameters.attributes).toEqual([]);
  }
 });

 it('rejects an accessory basket under a computer-only request with an explicit accessories exclusion',()=>{
  const {ctx}=computerOffer('Buy a computer under CHF 200 and at least CHF 50. No accessories.');
  const item=ctx.event.authorization.items[0]!;
  Object.assign(item,{item_name:'Laptop charger',item_details:'One-off purchase. No subscription.'});
  Object.assign(ctx.pack.itemsById.get(item.item_id as never)!,{item_name:'Laptop charger',item_description:'A charger accessory.'});
  ctx.offer_hash=offerHash(ctx.event,ctx.config);
  expect(assess(ctx)).toMatchObject({decision:'deny',can_finalize:false,blocking_filter_ids:expect.arrayContaining(['M10'])});
 });
});
