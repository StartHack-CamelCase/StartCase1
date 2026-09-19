import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InstructionDecoding } from '../packages/contracts/src/instruction-decoding.js';
import { preparePermissions } from '../packages/local-runtime/src/services/wallet-preparation.js';
import { fixture } from './simulation-fixture.js';

const saved=JSON.parse(readFileSync(new URL('./fixtures/wallet-official-decodings.json',import.meta.url),'utf8')) as {observed_variants:Array<{scenario_id:string;decoding:InstructionDecoding}>};
const examples=[
 {id:'LOCAL_DEC_f471b167-c0df-44fb-ad61-2d0c6f750f50',description:'Cardholder requests shoe size 43.',qualifier:'Cardholder requests shoe size 43 and waterproof shoes.'},
 {id:'LOCAL_DEC_38fbbc61-e398-4662-8bf8-a0dd05420a31',description:'Pause if someone other than the cardholder appears to be driving the session',qualifier:'Pause if someone other than the cardholder appears to be driving the session and require a fingerprint.'},
 {id:'LOCAL_DEC_aa4fd332-8258-4274-a893-2bde33fc8243',description:'Requested product is a 27-inch monitor the cardholder chose.',qualifier:'Requested product is a 27-inch monitor the cardholder chose with a lifetime warranty.'},
 {id:'LOCAL_DEC_445b5595-b164-434d-9fda-41bc2910fc6b',description:'Do not add anything not explicitly requested',qualifier:'Do not add anything not explicitly requested unless it is free.'},
];
function sample(id:string){return structuredClone(saved.observed_variants.find(s=>s.decoding.decoding_id===id)!.decoding);}
function prepare(decoding:InstructionDecoding){const ctx=fixture();return preparePermissions(ctx.pack,decoding.instruction,decoding,ctx.now);}

describe('source-grounded cardholder request paraphrases',()=>{
 it.each(examples)('retains extra restrictions in $id',({id,description,qualifier})=>{
  const decoding=sample(id),requirement=decoding.unmapped_requirements.find(r=>r.description===description)!;
  requirement.description=qualifier;
  expect(prepare(decoding).clarifications).toContainEqual(expect.objectContaining({diagnostic:expect.objectContaining({decoded_value:qualifier})}));
 });

 it.each(examples)('does not cover a positive paraphrase quoted from a negated source in $id',({id,description})=>{
  const decoding=sample(id),requirement=decoding.unmapped_requirements.find(r=>r.description===description)!;
  decoding.instruction=decoding.instruction.replace(requirement.source_excerpt,`Do not ${requirement.source_excerpt}`);
  expect(prepare(decoding).clarifications).toContainEqual(expect.objectContaining({diagnostic:expect.objectContaining({decoded_value:description})}));
 });

 it.each([
  [examples[0]!.id,'Cardholder requests shoe size 44.'],
  [examples[2]!.id,'Requested product is a 24-inch monitor the cardholder chose.'],
 ])('requires the decoded dimension to match its source and executable rule: %s', (id,description)=>{
  const decoding=sample(id);decoding.unmapped_requirements[0]!.description=description;
  expect(prepare(decoding).clarifications).toContainEqual(expect.objectContaining({diagnostic:expect.objectContaining({decoded_value:description})}));
 });

 it('does not invent a selected catalogue product when multiple monitors share the requested dimension',()=>{
  const ctx=fixture(),decoding=sample(examples[2]!.id);
  const monitor=ctx.pack.items.find(item=>item.item_id==='IT0017')!;
  ctx.pack.items=[...ctx.pack.items,{...monitor,item_id:'IT_TEST_OTHER' as typeof monitor.item_id}];
  const prepared=preparePermissions(ctx.pack,decoding.instruction,decoding,ctx.now);
  expect(prepared.config!.parameters.allowed_item_ids).toBeNull();
  expect(prepared.clarifications).toContainEqual(expect.objectContaining({diagnostic:expect.objectContaining({decoded_value:examples[2]!.description})}));
 });

 it('does not cover an extras prohibition whose source includes an exception',()=>{
  const decoding=sample(examples[3]!.id),requirement=decoding.unmapped_requirements.find(r=>r.description===examples[3]!.description)!;
  const amended='Do not add anything I did not ask for unless it is free.';
  decoding.instruction=decoding.instruction.replace(requirement.source_excerpt,amended);
  requirement.source_excerpt=amended;
  expect(prepare(decoding).clarifications).toContainEqual(expect.objectContaining({diagnostic:expect.objectContaining({decoded_value:requirement.description})}));
 });
});
