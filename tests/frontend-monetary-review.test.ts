import {describe,expect,it} from 'vitest';
import type {WalletClarification} from '../packages/contracts/src/wallet.js';
import {amountChoicesComplete,applyAmountChoices,interpretedAmountBounds,renderAmountReview,restoreAmountChoices,selectAmountChoice,validateAmountChoices} from '../apps/local-web/web/monetary-review.js';
import {renderPermissionHighlights} from '../apps/local-web/web/permission-review-view.js';

const question=(value:string,key='amount:0',quote=`CHF ${value}`):WalletClarification=>({key,label:'What does this amount mean?',type:'select',required:true,value:'',diagnostic:{field:'authorization.billing_amount_chf',decoded_value:value,source_excerpt:quote,reason:'The amount has no explicit comparator.'}});
const base={min_order_chf:null,max_order_chf:null,forbid_recurring:true};

describe('explicit monetary interpretation review',()=>{
 it.each(['120','20','60','15','18','45','25'])('does not preselect a restriction for the ambiguous CHF %s example',value=>{
  const questions=[question(value)],html=renderAmountReview(`CHF ${value} purchase`,questions,{});
  expect(html).toContain('<option value="" selected>Choose a meaning');
  for(const choice of ['maximum','minimum','exact','approximate','range','description'])expect(html).toContain(`value="${choice}"`);
  expect(interpretedAmountBounds(base,questions,{})).toEqual({min_order_chf:null,max_order_chf:null});
  expect(amountChoicesComplete(questions,{})).toBe(false);
  expect(()=>validateAmountChoices(JSON.stringify(base),base,questions,{})).toThrow('every quoted amount');
 });
 it('applies each explicit meaning and updates the retained points',()=>{
  const questions=[question('120')],source=JSON.stringify({...base,allowed_currencies:['CHF'],custom_field:'preserved'});
  const maximum=applyAmountChoices(source,base,questions,{'amount:0':'maximum'});
  expect(JSON.parse(maximum)).toEqual({...base,max_order_chf:'120',allowed_currencies:['CHF'],custom_field:'preserved'});
  expect(renderPermissionHighlights(maximum)).toContain('Maximum per purchase: CHF 120');
  expect(interpretedAmountBounds(base,questions,{'amount:0':'minimum'})).toEqual({min_order_chf:'120',max_order_chf:null});
  expect(interpretedAmountBounds(base,questions,{'amount:0':'exact'})).toEqual({min_order_chf:'120',max_order_chf:'120'});
  const changed=applyAmountChoices(maximum,base,questions,{'amount:0':'minimum'});
  expect(JSON.parse(changed)).toMatchObject({min_order_chf:'120',max_order_chf:null,custom_field:'preserved'});
  expect(()=>validateAmountChoices(changed,base,questions,{'amount:0':'minimum'})).not.toThrow();
 });
 it('intersects multiple answers with original explicit limits and removes a previous answer cleanly',()=>{
  const bounded={...base,min_order_chf:'10',max_order_chf:'100'},questions=[question('20'),question('60','amount:1')];
  expect(interpretedAmountBounds(bounded,questions,{'amount:0':'minimum','amount:1':'maximum'})).toEqual({min_order_chf:'20',max_order_chf:'60'});
  expect(interpretedAmountBounds(bounded,questions,{'amount:0':'description','amount:1':{meaning:'approximate',min_order_chf:'50',max_order_chf:'70'}})).toEqual({min_order_chf:'50',max_order_chf:'70'});
  expect(interpretedAmountBounds(bounded,[question('120')],{'amount:0':'maximum'})).toEqual({min_order_chf:'10',max_order_chf:'100'});
  expect(()=>interpretedAmountBounds(bounded,[question('120')],{'amount:0':'exact'})).toThrow('minimum exceeds the maximum');
  expect(()=>interpretedAmountBounds(base,questions,{'amount:0':'exact','amount:1':'exact'})).toThrow('minimum exceeds the maximum');
 });
 it('asks for explicit approximate bounds without inventing a tolerance and leaves descriptions unrestricted',()=>{
  const questions=[question('120')];
  expect(interpretedAmountBounds(base,questions,{'amount:0':'description'})).toEqual({min_order_chf:null,max_order_chf:null});
  expect(selectAmountChoice('maximum','approximate')).toEqual({meaning:'approximate',min_order_chf:'',max_order_chf:''});
  expect(()=>interpretedAmountBounds(base,questions,{'amount:0':'approximate'})).toThrow('both the minimum and maximum');
  const approximate=renderAmountReview('About CHF 120',questions,{'amount:0':'approximate'});
  expect(approximate).toContain('Original target: CHF 120');
  expect(approximate).toContain('What price range would you be comfortable with?');
  expect(approximate).toContain('No tolerance is assumed');
  expect(approximate).toContain('value="" aria-describedby="amount-choice-status"');
  const description=renderAmountReview('CHF 120 purchase',questions,{'amount:0':'description'});
  expect(description).toContain('does not change the scenario’s simulated purchases');
 });
 it('applies and restores customer supplied approximate and custom ranges with the original target intact',()=>{
  const questions=[question('25')];
  for(const meaning of ['approximate','range'] as const){
   const choices={'amount:0':{meaning,min_order_chf:'20',max_order_chf:'30'}};
   const source=applyAmountChoices(JSON.stringify(base),base,questions,choices);
   expect(JSON.parse(source)).toMatchObject({min_order_chf:'20',max_order_chf:'30'});
   expect(()=>validateAmountChoices(source,base,questions,choices)).not.toThrow();
   const restored=restoreAmountChoices(JSON.stringify(choices),questions);
   expect(restored).toEqual(choices);expect(amountChoicesComplete(questions,restored)).toBe(true);
   const html=renderAmountReview('Buy about CHF 25 groceries',questions,restored);
   expect(html).toContain(`value="${meaning}" selected`);expect(html).toContain('value="20"');expect(html).toContain('value="30"');
   expect(html).toContain('Your acceptable range is CHF 20–30');
   expect(questions[0]!.diagnostic!.decoded_value).toBe('25');
   expect(JSON.parse(applyAmountChoices(source,base,questions,{'amount:0':'maximum'}))).toMatchObject({min_order_chf:null,max_order_chf:'25'});
  }
  expect(interpretedAmountBounds(base,questions,{'amount:0':{meaning:'range',min_order_chf:'40',max_order_chf:'50'}})).toEqual({min_order_chf:'40',max_order_chf:'50'});
 });
 it('preserves incomplete range drafts on reload while blocking confirmation',()=>{
  const questions=[question('25')],choices={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:''}} as const;
  const restored=restoreAmountChoices(JSON.stringify(choices),questions);
  expect(restored).toEqual(choices);expect(amountChoicesComplete(questions,restored)).toBe(false);
  expect(()=>validateAmountChoices(JSON.stringify(base),base,questions,restored)).toThrow('both the minimum and maximum');
  expect(restoreAmountChoices('{"amount:0":"approximate"}',questions)).toEqual({'amount:0':{meaning:'approximate',min_order_chf:'',max_order_chf:''}});
  expect(restoreAmountChoices('{"amount:0":{"meaning":"range","min_order_chf":20,"max_order_chf":"30"}}',questions)).toEqual({});
 });
 it('rejects malformed, inverted, conflicting and mismatched acceptable ranges',()=>{
  const questions=[question('25')];
  for(const minimum of ['-1','20.001',' 20','2e1','not money']){
   const choices={'amount:0':{meaning:'range',min_order_chf:minimum,max_order_chf:'30'}} as const;
   expect(amountChoicesComplete(questions,choices)).toBe(false);
   expect(()=>interpretedAmountBounds(base,questions,choices)).toThrow('Amounts must be CHF');
  }
  expect(()=>interpretedAmountBounds(base,questions,{'amount:0':{meaning:'range',min_order_chf:'30',max_order_chf:'20'}})).toThrow('minimum exceeds the maximum');
  expect(()=>interpretedAmountBounds(base,questions,{'amount:0':{meaning:'approximate',min_order_chf:'26',max_order_chf:'30'}})).toThrow('include the original approximate target');
  const choices={'amount:0':{meaning:'range',min_order_chf:'20',max_order_chf:'30'}} as const;
  expect(()=>interpretedAmountBounds({...base,max_order_chf:'15'},questions,choices)).toThrow('minimum exceeds the maximum');
  expect(interpretedAmountBounds({...base,min_order_chf:'22',max_order_chf:'28'},questions,choices)).toEqual({min_order_chf:'22',max_order_chf:'28'});
  expect(()=>validateAmountChoices('{"min_order_chf":"20","max_order_chf":"31"}',base,questions,choices)).toThrow('do not match your amount choices');
 });
 it('removes only the compiler-identified amount review after a complete range and restores it for a description',()=>{
  const instruction='Buy about CHF 25 groceries.',generated={source_excerpt:instruction,description:instruction},other={source_excerpt:'groceries',description:'Check these groceries for each purchase.'};
  const parameters={...base,manual_review_requirements:[generated,other]},questions=[question('25')],choices={'amount:0':{meaning:'approximate',min_order_chf:'20',max_order_chf:'30'}} as const;
  const source=applyAmountChoices(JSON.stringify(parameters),parameters,questions,choices,generated);
  expect(JSON.parse(source)).toMatchObject({min_order_chf:'20',max_order_chf:'30',manual_review_requirements:[other]});
  expect(renderPermissionHighlights(source)).not.toContain(instruction);
  expect(()=>validateAmountChoices(source,parameters,questions,choices,generated)).not.toThrow();
  expect(()=>validateAmountChoices(JSON.stringify({...parameters,min_order_chf:'20',max_order_chf:'30'}),parameters,questions,choices,generated)).toThrow('purchase review does not match');
  const restored=restoreAmountChoices(JSON.stringify(choices),questions);
  expect(applyAmountChoices(source,parameters,questions,restored,generated)).toBe(source);
  const described=applyAmountChoices(source,parameters,questions,{'amount:0':'description'},generated);
  expect(JSON.parse(described)).toMatchObject({min_order_chf:null,max_order_chf:null,manual_review_requirements:[other,generated]});
  expect(()=>validateAmountChoices(described,parameters,questions,{'amount:0':'description'},generated)).not.toThrow();
  expect(JSON.parse(applyAmountChoices(JSON.stringify(parameters),parameters,questions,choices))).toMatchObject({manual_review_requirements:[generated,other]});
 });
 it('requires all answers after reload and discards invalid or unrelated saved choices',()=>{
  const questions=[question('20'),question('60','amount:1')];
  const partial=restoreAmountChoices('{"amount:0":"maximum","amount:1":"bad","amount:999":"minimum"}',questions);
  expect(partial).toEqual({'amount:0':'maximum'});
  expect(amountChoicesComplete(questions,partial)).toBe(false);
  const complete=restoreAmountChoices('{"amount:0":"maximum","amount:1":"description"}',questions);
  expect(amountChoicesComplete(questions,complete)).toBe(true);
  for(const invalid of [null,'{','null','[]','true'])expect(restoreAmountChoices(invalid,questions)).toEqual({});
 });
 it('blocks JSON that disagrees with the selected meaning and compares decimal amounts exactly',()=>{
  const questions=[question('20.10')],answers={'amount:0':'exact'} as const;
  expect(()=>validateAmountChoices('{"min_order_chf":"20.1","max_order_chf":"20.10"}',base,questions,answers)).not.toThrow();
  for(const source of ['{"min_order_chf":null,"max_order_chf":"20.10"}','{"min_order_chf":"20.10","max_order_chf":"20.11"}']){
   expect(()=>validateAmountChoices(source,base,questions,answers)).toThrow('do not match your amount choices');
  }
  expect(()=>applyAmountChoices('{broken',base,questions,answers)).toThrow('Invalid JSON');
  expect(()=>interpretedAmountBounds(base,[question('not a number')],answers)).toThrow('Amounts must be CHF');
 });
 it('preserves the exact original instruction and quoted evidence as escaped text',()=>{
  const instruction='  CHF 120 <img src=x>\n& "groceries"  ',html=renderAmountReview(instruction,[question('120','amount:0','CHF 120 <img src=x>')],{});
  expect(html).toContain('  CHF 120 &lt;img src=x&gt;\n&amp; &quot;groceries&quot;  ');
  expect(html).toContain('What does CHF 120 mean in “CHF 120 &lt;img src=x&gt;”?');
  expect(html).not.toContain('<img');
  expect(renderAmountReview(instruction,[],{})).toContain('Your original instruction');
 });
 it('distinguishes two amounts quoted from the same original clause',()=>{
  const instruction='CHF 20 groceries and CHF 60 household supplies';
  const html=renderAmountReview(instruction,[question('20','amount:0',instruction),question('60','amount:1',instruction)],{});
  expect(html).toContain(`What does CHF 20 mean in “${instruction}”?`);
  expect(html).toContain(`What does CHF 60 mean in “${instruction}”?`);
 });
});
