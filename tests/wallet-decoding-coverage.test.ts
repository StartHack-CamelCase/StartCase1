import {it,expect} from 'vitest';
import {fixture} from './simulation-fixture.js';
import {preparePermissions,applyClarifications,hardRulesFromParameters} from '../packages/local-runtime/src/services/wallet-preparation.js';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';
const decoding=(field:string,value:string):InstructionDecoding=>({variables:[{field,status:'present',value,operator:'=',currency:null,scope:null,period_days:null,source_excerpt:'Buy only from Merchant X.',note:null}],unmapped_requirements:[],decoding_id:'test',instruction:'Buy only from Merchant X.',schema_version:1,prompt_version:'test',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:'2026-09-19T00:00:00Z',duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0}});
it('recognizes a redundant one-grocery-item requirement only when both category and quantity are enforced',()=>{const ctx=fixture();const decoded=decoding('mandate.uncertainty_policy','ask');decoded.variables=[];decoded.unmapped_requirements=[{source_excerpt:'Buy one ordinary grocery item.',description:'Purchase must be for one ordinary grocery item.',reason:'ambiguous'}];const prep=preparePermissions(ctx.pack,'Buy one ordinary grocery item for CHF 20 or less. Ask me when uncertain.',decoded,ctx.now);expect(prep.clarifications.some(c=>c.key.startsWith('unresolved:'))).toBe(false);expect(prep.config?.parameters).toMatchObject({allowed_item_categories:['groceries'],max_quantity_per_order:1});const missingQuantity=preparePermissions(ctx.pack,'Buy groceries for CHF 20 or less. Ask me when uncertain.',decoded,ctx.now);expect(missingQuantity.clarifications.some(c=>c.key.startsWith('unresolved:'))).toBe(true);decoded.unmapped_requirements[0]!.description='Purchase must be for one allergen-free grocery item.';expect(preparePermissions(ctx.pack,'Buy one ordinary grocery item for CHF 20 or less.',decoded,ctx.now).clarifications.some(c=>c.key.startsWith('unresolved:'))).toBe(true);});

it('covers an archived regular-shop mistranslation using its enforced history rule without changing decoding provenance',()=>{
 const ctx=fixture();const instruction='Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly. Ask me when uncertain.';
 const d=decoding('authorization.merchant.merchant_category','shop I use regularly');d.instruction=instruction;d.prompt_version='instruction-variables-v9';d.variables[0]={...d.variables[0]!,operator:null,source_excerpt:instruction};d.unmapped_requirements=[{source_excerpt:instruction,description:'The merchant should be a shop the user uses regularly; this is a habitual-merchant constraint and no dedicated field exists.',reason:'ambiguous'}];
 const before=structuredClone(d);const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);
 expect(prepared.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);expect(prepared.config!.parameters).toMatchObject({regularity:{days:180,distinct_dates:3},allowed_merchant_categories:null,max_order_chf:'20'});expect(d).toEqual(before);
 expect(applyClarifications({...prepared,instruction:d.instruction,decoding:d} as WalletPreparation,{},ctx.pack).regularity).toEqual({days:180,distinct_dates:3});
});

it.each(['authorization.merchant.merchant_category','authorization.merchant.merchant_name'])('covers only a literal familiar-shop predicate in %s',field=>{
 const ctx=fixture();const instruction='Buy groceries from a shop I used before.';const d=decoding(field,'shop I used before');d.instruction=instruction;d.variables[0]!.source_excerpt=instruction;
 const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);expect(prepared.config!.parameters.familiar_merchant).toBe(true);expect(prepared.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);
 d.variables[0]!.value='shop I used before and locally owned';d.instruction='Buy groceries from a shop I used before and locally owned.';d.variables[0]!.source_excerpt=d.instruction;
 expect(preparePermissions(ctx.pack,d.instruction,d,ctx.now).clarifications.some(c=>c.key===`unresolved:${field}`)).toBe(true);
});

it.each([
 ['Buy groceries from a shop I use regularly and locally owned.','shop I use regularly and locally owned'],
 ['Buy groceries regularly from a pharmacy.','pharmacy'],
 ['Buy groceries from my regular shop.','my regular shop'],
])('does not cover additional merchant constraints or an unenforced history rule: %s',(instruction,value)=>{
 const ctx=fixture();const d=decoding('authorization.merchant.merchant_category',value);d.instruction=instruction;d.variables[0]!.source_excerpt=instruction;
 expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:authorization.merchant.merchant_category')).toBe(true);
});

it.each(['!=','not_in'] as const)('does not satisfy an excluded habitual merchant with positive regularity: %s',operator=>{
 const ctx=fixture();const instruction='Do not buy from a shop I use regularly.';const d=decoding('authorization.merchant.merchant_category','shop I use regularly');d.instruction=instruction;d.variables[0]={...d.variables[0]!,operator,source_excerpt:instruction};
 const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);expect(prepared.config!.parameters.regularity).not.toBeNull();expect(prepared.clarifications.some(c=>c.key==='unresolved:authorization.merchant.merchant_category')).toBe(true);
});

it('covers the actual household-budget decoding while preserving every compiled budget and delivery constraint',()=>{
 const ctx=fixture();const instruction=ctx.pack.scenariosById.get('SCEN0001' as never)!.cardholder_instruction;const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.prompt_version='instruction-variables-v11';
 const base={...d.variables[0]!,source_excerpt:instruction};d.variables=[base,{...base,field:'authorization.billing_amount_chf',value:120,operator:'<=',currency:'CHF',scope:'purchase'},{...base,field:'context.approved_spend_in_period_chf',value:300,operator:'<=',currency:'CHF',scope:'period',period_days:7},{...base,field:'authorization.fulfillment_method',value:'delivery'}];
 d.unmapped_requirements=[{description:'Household groceries are requested.',source_excerpt:instruction,reason:'no_native_field'}];const before=structuredClone(d);const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);
 expect(prepared.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);expect(applyClarifications({...prepared,instruction:d.instruction,decoding:d} as WalletPreparation,{},ctx.pack)).toMatchObject({allowed_item_categories:['groceries','household'],min_order_chf:null,max_order_chf:'120',rolling_budget:{days:7,limit_chf:'300'},fulfillment_method:'delivery'});expect(d).toEqual(before);
});

it.each([
 ['Order our household groceries for delivery.','Order household groceries.'],
 ['Order our household groceries for delivery.','The order must contain household groceries.'],
 ['Buy groceries.','Groceries are required.'],
 ['Buy clothes.','Items must be clothing.'],
 ['Purchase clothing.','Allow only clothes.'],
])('covers plain category request paraphrases: %s / %s',(instruction,description)=>{
 const ctx=fixture();const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.variables[0]!.source_excerpt=instruction;d.unmapped_requirements=[{description,source_excerpt:instruction,reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);
});

it.each([
 'Organic household groceries are requested.',
 'Gluten-free household groceries are requested.',
 'Household groceries are not allowed.',
 'Household groceries are requested only from Merchant X.',
 'Household groceries and clothing are requested.',
 'Household groceries except milk are requested.',
])('does not discard a qualifier or exclusion from a category request: %s',description=>{
 const ctx=fixture();const instruction='Order our household groceries for delivery.';const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description,source_excerpt:instruction,reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:requirement:0')).toBe(true);
});

it.each(['Do not order household groceries.','Order organic household groceries.','Order groceries.'])('requires the literal source to positively support the category: %s',instruction=>{
 const ctx=fixture();const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description:'Household groceries are requested.',source_excerpt:instruction,reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:requirement:0')).toBe(true);
});

it('does not cover a category when compiled permissions allow unrelated purchases',()=>{
 const ctx=fixture();const instruction='Order our household groceries.';const d=decoding('authorization.items[].item_category','electronics');d.instruction=instruction;d.variables[0]!.source_excerpt=instruction;d.unmapped_requirements=[{description:'Household groceries are requested.',source_excerpt:instruction,reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:requirement:0')).toBe(true);
});

it.each(['Merchant must be a shop the cardholder uses regularly','Merchant must be a shop the cardholder uses regularly / has bought from before.'])('uses the literal familiarity source instead of the model regularity paraphrase: %s',description=>{
 const ctx=fixture();const instruction=ctx.pack.scenariosById.get('SCEN0003' as never)!.cardholder_instruction;const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description,source_excerpt:'from shops I have used before.',reason:'no_native_field'}];const before=structuredClone(d);const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);
 expect(prepared.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);expect(prepared.config!.parameters).toMatchObject({familiar_merchant:true,regularity:null,max_order_chf:'250',allowed_item_categories:['clothing'],watch_devices:true});expect(d).toEqual(before);
});

it('preserves a real regularity requirement even when the model calls it familiarity',()=>{
 const ctx=fixture();const instruction='Buy groceries from a shop I use regularly.';const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description:'Merchant must be familiar from previous purchases.',source_excerpt:'from a shop I use regularly.',reason:'no_native_field'}];const prepared=preparePermissions(ctx.pack,instruction,d,ctx.now);
 expect(prepared.clarifications.filter(c=>c.key.startsWith('unresolved:'))).toEqual([]);expect(prepared.config!.parameters).toMatchObject({regularity:{days:180,distinct_dates:3},familiar_merchant:false});
});

it.each(['Merchant must be a shop the cardholder uses regularly and locally owned.','Merchant must not be a shop the cardholder uses regularly.','Use a regular organic shop.'])('retains unsupported qualifications or negation in a history requirement: %s',description=>{
 const ctx=fixture();const instruction='Buy groceries from a shop I use regularly.';const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description,source_excerpt:instruction,reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:requirement:0')).toBe(true);
});

it('does not treat a partial quote from a negated source as a positive familiarity requirement',()=>{
 const ctx=fixture();const instruction='Do not buy from shops I have used before.';const d=decoding('mandate.uncertainty_policy','ask');d.instruction=instruction;d.unmapped_requirements=[{description:'Merchant must be a shop the cardholder uses regularly',source_excerpt:'from shops I have used before.',reason:'no_native_field'}];expect(preparePermissions(ctx.pack,instruction,d,ctx.now).clarifications.some(c=>c.key==='unresolved:requirement:0')).toBe(true);
});
