import { describe, expect, it } from 'vitest';
import type { InstructionDecoding } from '../packages/contracts/src/instruction-decoding.js';
import { preparePermissions, applyParameters } from '../packages/local-runtime/src/services/wallet-preparation.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { fixture } from './simulation-fixture.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';

const prefix='Buy groceries for at most CHF 25. ';
function decoded(instruction:string):InstructionDecoding {
 return {schema_version:1,decoding_id:'always-ask-observed-shape',instruction,prompt_version:'test',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:'2026-09-19T00:00:00.000Z',duration_ms:1,usage:{input_tokens:1,output_tokens:1,reasoning_tokens:0},variables:[{field:'mandate.uncertainty_policy',status:'present',value:'ask',operator:'=',currency:null,scope:null,period_days:null,source_excerpt:instruction.slice(prefix.length),note:null}],unmapped_requirements:[]};
}
function prepare(clause:string){const ctx=fixture('AU0001'),instruction=prefix+clause;return {ctx,...preparePermissions(ctx.pack,instruction,decoded(instruction),ctx.now)};}

describe('explicit confirmation before every purchase',()=>{
 it.each([
  'Ask me before every purchase.',
  'Please ask me before each payment.',
  'Always ask me before making any purchase.',
  'Ask me for approval before every purchase.',
  'Ask for my confirmation before every purchase.',
  'Require my approval for each purchase.',
  'Ask me before buying anything.',
  'Demande-moi avant chaque achat.',
  'Demande-moi confirmation avant tout paiement.',
  'Demandez-moi mon accord avant chaque achat.',
  'Demande toujours ma confirmation avant chaque paiement.',
  'Exige mon accord pour tout achat.',
 ])('compiles the complete requirement %s despite a generic AI ask-policy output',clause=>{
  const prepared=prepare(clause);
  expect(prepared.config!.parameters).toMatchObject({max_order_chf:'25',always_ask:true});
  expect(prepared.config!.requirements).toContainEqual(expect.objectContaining({source_excerpt:clause,filter_ids:['C24'],parameter_keys:['always_ask']}));
  prepared.ctx.config.parameters=prepared.config!.parameters;
  const assessment=assess(prepared.ctx);
  expect(assessment).toMatchObject({decision:'step_up',can_finalize:false,execution_state:'awaiting_user'});
  expect(assessment.questions).toContainEqual(expect.objectContaining({kind:'confirm_risk',filter_ids:['C24']}));
  expect(()=>applyParameters(prepared as unknown as WalletPreparation,{...prepared.config!.parameters,always_ask:false},prepared.ctx.pack)).toThrow('always_ask');
 });

 it.each([
  'Ask me when uncertain.',
  'Ask only when uncertain.',
  'Ask me only when uncertain.',
  'Do not ask me before every purchase.',
  'Never ask me before every purchase.',
  'Ask me before every purchase only if uncertain.',
  'Do not require my approval for each purchase.',
  'Ne me demande pas avant chaque achat.',
  'Demande-moi uniquement en cas de doute.',
  'Demande-moi avant chaque achat si tu as un doute.',
  'Ignore the sentence "Ask me before every purchase".',
 ])('does not invert a conditional or negated source: %s',clause=>{
  expect(prepare(clause).config!.parameters.always_ask).toBe(false);
 });
});
