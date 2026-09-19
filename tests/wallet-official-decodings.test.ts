import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InstructionDecoding } from '../packages/contracts/src/instruction-decoding.js';
import type { SafetyParameters } from '../packages/contracts/src/simulation.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';
import { parseInstructionDecoding } from '../packages/local-runtime/src/ai/instruction-schema.js';
import { applyParameters, hardRulesFromParameters, preparePermissions } from '../packages/local-runtime/src/services/wallet-preparation.js';
import { fixture } from './simulation-fixture.js';

type ObservedDecoding={scenario_id:string;decoding:InstructionDecoding};
type SavedFixture={schema_version:1;description:string;scenarios:ObservedDecoding[];observed_variants?:ObservedDecoding[]};
const saved=JSON.parse(readFileSync(new URL('./fixtures/wallet-official-decodings.json',import.meta.url),'utf8')) as SavedFixture;
const allObserved=[...saved.scenarios,...saved.observed_variants??[]];
const expected:Record<string,Partial<SafetyParameters>>={
 SCEN0000:{max_order_chf:'20',allowed_item_categories:['groceries'],max_quantity_per_order:1,regularity:{days:180,distinct_dates:3}},
 SCEN0001:{max_order_chf:'120',rolling_budget:{limit_chf:'300',days:7},allowed_item_categories:['groceries','household'],fulfillment_method:'delivery',max_quantity_per_order:null},
 SCEN0002:{max_order_chf:'200',allowed_item_categories:['sporting_goods'],allowed_merchant_categories:['sporting_goods'],product_type:'road_running_shoes',attributes:[{name:'size',values:['43'],unit:null}],numeric_size_convention:'shared_numeric',min_return_days:14,max_quantity_per_order:1,mission_quantity:1},
 SCEN0003:{max_order_chf:'250',allowed_item_categories:['clothing'],familiar_merchant:true,regularity:null,watch_devices:true,burst_threshold:3,historical_time_review:true,unusual_country:true,max_quantity_per_order:null},
 SCEN0004:{max_order_chf:'400',allowed_item_categories:['electronics'],product_type:'monitor',attributes:[{name:'inches',values:['27'],unit:'inch'}],allowed_item_ids:['IT0017'],familiar_merchant:true,no_extras:true,max_quantity_per_order:1,mission_quantity:1},
};

describe('previously observed AI decodings for the public challenge scenarios',()=>{
 it('covers exactly the five official instructions and includes the reported household decoding unchanged',()=>{
  const ctx=fixture();
  expect(saved.scenarios.map(s=>s.scenario_id).sort()).toEqual(ctx.pack.scenarios.map(s=>s.scenario_id).sort());
  expect(new Set(allObserved.map(s=>s.decoding.decoding_id)).size).toBe(allObserved.length);
  for(const sample of allObserved){
   const scenario=ctx.pack.scenariosById.get(sample.scenario_id as never)!;
   expect(sample.decoding.instruction).toBe(scenario.cardholder_instruction);
   expect(parseInstructionDecoding(sample.decoding,scenario.cardholder_instruction)).toEqual(sample.decoding);
  }
  const household=saved.scenarios.find(s=>s.scenario_id==='SCEN0001')!.decoding;
  expect(household).toMatchObject({decoding_id:'LOCAL_DEC_cfad5f9c-0dc9-4d43-8cb7-ecd638690b98',prompt_version:'instruction-variables-v11',unmapped_requirements:[{source_excerpt:household.instruction,description:'Household groceries are requested.',reason:'no_native_field'}]});
 });

 it.each(allObserved)('$scenario_id / $decoding.decoding_id compiles its actual saved AI output without extra setup questions',({scenario_id,decoding})=>{
  const ctx=fixture(),before=structuredClone(decoding);
  const prepared=preparePermissions(ctx.pack,decoding.instruction,decoding,ctx.now);
  expect(prepared.clarifications).toEqual([]);
  expect(prepared.config!.parameters).toMatchObject({min_order_chf:null,allowed_currencies:null,...expected[scenario_id]});
  // Passing review must produce a complete executable parameter object, not merely hide a warning.
  expect(applyParameters(prepared as WalletPreparation,prepared.config!.parameters,ctx.pack)).toEqual(prepared.config!.parameters);
  expect(hardRulesFromParameters(prepared.config!.parameters)).toContainEqual({field:'authorization.billing_amount_chf',operator:'<=',value:Number(expected[scenario_id]!.max_order_chf),currency:'CHF',scope:'purchase'});
  if(scenario_id==='SCEN0001')expect(hardRulesFromParameters(prepared.config!.parameters)).toContainEqual({field:'authorization.billing_amount_chf',operator:'<=',value:300,currency:'CHF',scope:'period',period_days:7});
  expect(decoding).toEqual(before);
 });
});
