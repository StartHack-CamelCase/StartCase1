import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HardRule, MandateRecord } from '../packages/contracts/src/policy.js';
import type { SafetyParameters } from '../packages/contracts/src/simulation.js';
import { applyOrderAmountRule, assertNoWeakening, defaultParameters, hasUnsupportedRule, normalizeOrderAmountBound, parseOrderAmountBounds, suggestConfig, validateParameters } from '../packages/local-runtime/src/simulation/config.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import { evaluateCustomer } from '../packages/local-runtime/src/simulation/customer.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { fixture } from './simulation-fixture.js';
import { createLocalRuntime } from '../packages/local-runtime/src/runtime.js';

const compile=(instruction:string,hard_rules:HardRule[]=[])=>suggestConfig({mandate_id:'TEST',version:1,instruction,hard_rules,interpretation:{}} as MandateRecord,'2026-09-19T00:00:00Z');
const purchase=(parameters:SafetyParameters,amount=20)=>{
 const ctx=fixture('AU0001');ctx.config.parameters={...parameters,domestic_country:'CH'};
 Object.assign(ctx.event.authorization,{amount,billing_amount_chf:amount,delivery_fee:Number((amount-13).toFixed(2))});
 return ctx;
};
const amountCheck=(parameters:SafetyParameters,amount=20)=>{const ctx=purchase(parameters,amount);return evaluateCustomer(ctx,evaluateMerchant(ctx)).find(r=>r.filter_id==='C09')!;};

describe('source amount bounds',()=>{
 it.each([
  ['Buy groceries for CHF 20 or less.',null,'20'],
  ['Pay at least CHF 20.','20',null],
  ['Pay exactly CHF 20.','20','20'],
  ['Pay an amount <= CHF 20.',null,'20'],
  ['Pay an amount < CHF 20.',null,'19.99'],
  ['Pay an amount >= CHF 20.','20',null],
  ['Pay an amount > CHF 20.','20.01',null],
  ['Pay an amount = CHF 20.','20','20'],
  ['Montant inférieur à 20 CHF.',null,'19.99'],
  ['Montant supérieur à 20 CHF.','20.01',null],
  ['Montant égal à 20 CHF.','20','20'],
  ['Payer au moins 20 CHF.','20',null],
  ['Payer au plus 20 CHF.',null,'20'],
  ['Pay between CHF 10 and CHF 20.','10','20'],
  ['Pay between 10 and 20 CHF.','10','20'],
  ['Payer entre 10,50 et 20,50 CHF.','10.5','20.5'],
  ['Payer de CHF 10 à CHF 20.','10','20'],
  ['Pay CHF 10–20.','10','20'],
  ['Pay at least CHF 10 and no more than CHF 20.','10','20'],
 ] as const)('parses %s', (instruction,min,max)=>{
  const bounds=parseOrderAmountBounds(instruction);
  expect(bounds).toEqual({min_order_chf:min,max_order_chf:max,rolling_budget:null});
  expect(compile(instruction).parameters).toMatchObject(bounds);
 });

 it('keeps order bounds separate from the rolling budget, in either clause order',()=>{
  for(const instruction of [
   'Keep each order at or below CHF 120 including delivery, and keep the total across any seven days at or below CHF 300.',
   'Keep the total over 7 days at or below CHF 300, and each order between CHF 10 and CHF 120.',
  ])expect(parseOrderAmountBounds(instruction)).toMatchObject({max_order_chf:'120',rolling_budget:{limit_chf:'300',days:7}});
  expect(parseOrderAmountBounds('Keep the total over 7 days at most CHF 300.')).toEqual({min_order_chf:null,max_order_chf:null,rolling_budget:{limit_chf:'300',days:7}});
 });

 it('does not invent a comparator, a floor, or a period budget from unrelated numbers',()=>{
  expect(parseOrderAmountBounds('Return within 14 days. Choose size 43. CHF 20.')).toEqual({min_order_chf:null,max_order_chf:null,rolling_budget:null});
  expect(parseOrderAmountBounds('The order must arrive within seven days.')).toEqual({min_order_chf:null,max_order_chf:null,rolling_budget:null});
  expect(parseOrderAmountBounds('Buy shoes returnable within 14 days for no more than CHF 200.')).toEqual({min_order_chf:null,max_order_chf:'200',rolling_budget:null});
  expect(defaultParameters().min_order_chf).toBeNull();
 });

 it('rounds comparisons toward exactly the representable CHF-cent set',()=>{
  expect(normalizeOrderAmountBound('20.001','<')).toEqual({min_order_chf:null,max_order_chf:'20'});
  expect(normalizeOrderAmountBound('20.009','>')).toEqual({min_order_chf:'20.01',max_order_chf:null});
  expect(()=>normalizeOrderAmountBound('20.001','=')).toThrow('representable in cents');
  expect(()=>normalizeOrderAmountBound('0','<')).toThrow('no nonnegative');
 });
});

describe('native amount rules and execution',()=>{
 it.each([
  ['<',null,'19.99','fail'],['<=',null,'20','pass'],['>','20.01',null,'fail'],['>=','20',null,'pass'],['=','20','20','pass'],
 ] as const)('compiles and executes %s CHF 20 without unsupported-rule bypass', (operator,min,max,outcome)=>{
  const config=compile('A purchase with a structured monetary rule.',[{field:'authorization.billing_amount_chf',operator,value:20,currency:'CHF',scope:'purchase'}]);
  expect(hasUnsupportedRule(config)).toBe(false);
  expect(config.parameters).toMatchObject({min_order_chf:min,max_order_chf:max});
  expect(amountCheck(validateParameters(config.parameters)).outcome).toBe(outcome);
 });

 it('requires equality at both sides of the permitted amount',()=>{
  const p=compile('Pay exactly CHF 20.').parameters;
  expect(amountCheck(p,19.99)).toMatchObject({outcome:'fail',reasons:[expect.objectContaining({code:'C09_PURCHASE_BELOW_MINIMUM',message:expect.stringContaining('minimum')})]});
  expect(amountCheck(p,20).outcome).toBe('pass');
  expect(amountCheck(p,20.01)).toMatchObject({outcome:'fail',reasons:[expect.objectContaining({code:'C09_PURCHASE_LIMIT_EXCEEDED'})]});
  expect(assess(purchase(p,19.99))).toMatchObject({decision:'deny',can_finalize:false});
 });

 it('preserves both source bounds and stricter structured bounds',()=>{
  const p=compile('Pay between CHF 10 and CHF 20.',[{field:'authorization.billing_amount_chf',operator:'>=',value:12,currency:'CHF',scope:'purchase'}]).parameters;
  expect(p).toMatchObject({min_order_chf:'12',max_order_chf:'20'});
  expect(amountCheck({...p,max_order_chf:null},21).outcome).toBe('pass');
  expect(amountCheck({...p,max_order_chf:null},11).outcome).toBe('fail');
 });

 it('never converts a rolling constraint or foreign-currency rule into an order floor',()=>{
  const p=defaultParameters();
  expect(applyOrderAmountRule(p,{field:'authorization.billing_amount_chf',operator:'>=',value:100,currency:'CHF',scope:'period',period_days:7})).toBe(false);
  expect(applyOrderAmountRule(p,{field:'authorization.billing_amount_chf',operator:'>=',value:20,currency:'EUR',scope:'purchase'})).toBe(false);
  expect(p).toEqual(defaultParameters());
  expect(applyOrderAmountRule(p,{field:'authorization.billing_amount_chf',operator:'<',value:100,currency:'CHF',scope:'period',period_days:7})).toBe(true);
  expect(p).toMatchObject({min_order_chf:null,max_order_chf:null,rolling_budget:{days:7,limit_chf:'99.99'}});
 });

 it('does not evaluate the floor against an unverified total',()=>{
  const ctx=fixture('AU0032');ctx.config.parameters.min_order_chf='300';ctx.pack.fxByCurrency=new Map();
  expect(evaluateCustomer(ctx,evaluateMerchant(ctx)).find(r=>r.filter_id==='C09')?.outcome).toBe('not_evaluated');
 });
});

describe('amount validation and legacy records',()=>{
 it.each(['-1','20.001',20,undefined])('rejects a non-monetary minimum %s',min=>{
  expect(()=>validateParameters({...defaultParameters(),min_order_chf:min})).toThrow('Invalid configuration');
 });
 it('rejects crossed bounds and accepts zero or exact equality',()=>{
  expect(()=>validateParameters({...defaultParameters(),min_order_chf:'21',max_order_chf:'20'})).toThrow('less than or equal');
  expect(validateParameters({...defaultParameters(),min_order_chf:'0',max_order_chf:'0'})).toMatchObject({min_order_chf:'0',max_order_chf:'0'});
 });
 it('prevents lowering or deleting a confirmed floor',()=>{
  const p={...defaultParameters(),min_order_chf:'20'};
  for(const min of ['19.99',null,undefined])expect(()=>assertNoWeakening(p,{...p,min_order_chf:min} as SafetyParameters)).toThrow('min_order_chf');
  expect(()=>assertNoWeakening(p,{...p,min_order_chf:'20.01'})).not.toThrow();
 });
 it('normalizes a legacy missing floor without mutating its signed record or checksum',()=>{
  const {min_order_chf:_,...legacy}=defaultParameters();const before=hash(legacy);
  expect(validateParameters(legacy).min_order_chf).toBeNull();
  expect(hash(legacy)).toBe(before);expect(legacy).not.toHaveProperty('min_order_chf');
  expect(amountCheck(legacy as SafetyParameters).outcome).toBe('pass');
  expect(()=>assertNoWeakening(legacy as SafetyParameters,defaultParameters())).not.toThrow();
 });
 it('reopens persisted legacy configurations through the real runtime without rewriting their checksum',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'legacy-amount-floor-'));
  let runtime:Awaited<ReturnType<typeof createLocalRuntime>>|undefined;
  const stored=()=>{const db=new DatabaseSync(join(dir,'state','simulations.sqlite'));try{return db.prepare('SELECT body,checksum FROM state WHERE id=1').get()!;}finally{db.close();}};
  try{
   const options={stateDir:join(dir,'state'),outputDir:join(dir,'output')};
   runtime=await createLocalRuntime(options);
   const legacy=fixture('AU0001').config;
   delete (legacy.parameters as Partial<SafetyParameters>).min_order_chf;
   runtime.simulations.store.transaction('legacy-import',{},state=>{state.configs.push(legacy);return legacy;});
   await runtime.close();runtime=undefined;
   const before=stored();
   runtime=await createLocalRuntime(options);
   expect(runtime.simulations.configs(legacy.mandate_id)[0]?.parameters).not.toHaveProperty('min_order_chf');
   expect(stored()).toEqual(before);
   expect(runtime.simulations.store.transaction('legacy-import',{},()=>null)).toEqual(legacy);
  }finally{await runtime?.close();await rm(dir,{recursive:true,force:true});}
 });
});

describe('editable JSON cannot weaken other confirmed requirements',()=>{
 it('keeps regularity mandatory while allowing a shorter window or more observed dates',()=>{
  const p={...defaultParameters(),regularity:{days:180,distinct_dates:3}};
  for(const regularity of [null,{days:181,distinct_dates:3},{days:180,distinct_dates:2}])expect(()=>assertNoWeakening(p,{...p,regularity})).toThrow('regularity');
  for(const regularity of [{days:180,distinct_dates:3},{days:90,distinct_dates:3},{days:180,distinct_dates:4}])expect(()=>assertNoWeakening(p,{...p,regularity})).not.toThrow();
 });
 it('keeps delivery no later than the requested deadline',()=>{
  const p={...defaultParameters(),delivery_deadline:'2026-09-20'};
  for(const delivery_deadline of [null,'2026-09-21'])expect(()=>assertNoWeakening(p,{...p,delivery_deadline})).toThrow('delivery_deadline');
  for(const delivery_deadline of ['2026-09-20','2026-09-19'])expect(()=>assertNoWeakening(p,{...p,delivery_deadline})).not.toThrow();
 });
 it.each(['bounded_history_required','historical_time_review','unusual_country','unusual_amount'] as const)('cannot disable %s',key=>{
  const p={...defaultParameters(),[key]:true};
  expect(()=>assertNoWeakening(p,{...p,[key]:false})).toThrow(key);
  expect(()=>assertNoWeakening(p,p)).not.toThrow();
  expect(()=>assertNoWeakening(defaultParameters(),p)).not.toThrow();
 });
 it('cannot shorten duplicate review coverage or raise the burst threshold',()=>{
  const p={...defaultParameters(),duplicate_hours:24,burst_threshold:3};
  for(const duplicate_hours of [null,0,23.99])expect(()=>assertNoWeakening(p,{...p,duplicate_hours})).toThrow('duplicate_hours');
  for(const burst_threshold of [null,4])expect(()=>assertNoWeakening(p,{...p,burst_threshold})).toThrow('burst_threshold');
  expect(()=>assertNoWeakening(p,{...p,duplicate_hours:48,burst_threshold:2})).not.toThrow();
  expect(()=>assertNoWeakening(p,p)).not.toThrow();
 });
 it.each([
  [{from_hour:9,to_hour:17},{from_hour:10,to_hour:17},{from_hour:8,to_hour:18}],
  [{from_hour:22,to_hour:6},{from_hour:23,to_hour:6},{from_hour:21,to_hour:7}],
 ] as const)('permits only additional reviewed hours, including windows crossing midnight',(time_review,narrower,wider)=>{
  const p={...defaultParameters(),time_review};
  for(const next of [null,narrower,{from_hour:0,to_hour:0}])expect(()=>assertNoWeakening(p,{...p,time_review:next})).toThrow('time_review');
  expect(()=>assertNoWeakening(p,{...p,time_review:wider})).not.toThrow();
  expect(()=>assertNoWeakening(p,p)).not.toThrow();
  expect(()=>assertNoWeakening(p,{...p,timezone:'UTC'})).toThrow('time_review');
 });
 it('allows adding requirements to previously unset parameters without changing defaults',()=>{
  const p=defaultParameters(),before=hash(p);
  expect(()=>assertNoWeakening(p,{...p,regularity:{days:90,distinct_dates:2},delivery_deadline:'2026-09-20',duplicate_hours:24,burst_threshold:2,time_review:{from_hour:22,to_hour:6}})).not.toThrow();
  expect(hash(p)).toBe(before);
 });
});
