import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';
import {preparePermissions,applyParameters} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {fixture} from './simulation-fixture.js';

const recorded=JSON.parse(readFileSync(new URL('./fixtures/computer-variant-decodings.json',import.meta.url),'utf8')) as {cases:Array<{id:string;instruction:string;decoding:InstructionDecoding}>};
const expectations:Record<string,{min:string|null;max:string|null;product:string|null}>={
 english_exclusive:{min:'50',max:'199.99',product:'laptop'},
 french_refurbished:{min:'50',max:'200',product:'laptop'},
 range_no_extras:{min:'50',max:'200',product:'desktop_computer'},
 approximate:{min:null,max:null,product:'laptop'},
 no_floor:{min:null,max:'200',product:'computer'},
 accessory_only:{min:null,max:'80',product:null},
 foreign_price:{min:null,max:null,product:'laptop'},
};

describe('observed GPT-5.4 computer variants',()=>{
 it.each(recorded.cases)('retains price/product facts and unsolved requirements for $id',c=>{
  const ctx=fixture(),expected=expectations[c.id]!;
  const before=structuredClone(c.decoding);
  const prepared=preparePermissions(ctx.pack,c.instruction,c.decoding,ctx.now);
  const prep={...prepared,instruction:c.instruction,decoding:c.decoding} as WalletPreparation;
  expect(prep.config!.parameters).toMatchObject({min_order_chf:expected.min,max_order_chf:expected.max,product_type:expected.product});
  expect(prep.config!.parameters.manual_review_requirements).toEqual([{source_excerpt:c.instruction,description:c.instruction}]);
  if(c.id==='approximate')expect(()=>applyParameters(prep,prep.config!.parameters,ctx.pack)).toThrow('What does CHF 150');
  else expect(applyParameters(prep,prep.config!.parameters,ctx.pack)).toEqual(prep.config!.parameters);
  expect(c.decoding).toEqual(before);
 });

 it('does not treat the approximate target or EUR price as a CHF ceiling',()=>{
  const ctx=fixture();
  for(const c of recorded.cases.filter(c=>['approximate','foreign_price'].includes(c.id))){
   const p=preparePermissions(ctx.pack,c.instruction,c.decoding,ctx.now);
   expect(p.config!.parameters.min_order_chf).toBeNull();expect(p.config!.parameters.max_order_chf).toBeNull();
   expect(p.config!.parameters.delivery_deadline).toBeNull();
  }
 });
});
