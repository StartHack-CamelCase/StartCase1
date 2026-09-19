import type {MonetaryInterpretation,MonetaryInterpretations,MonetaryMeaning,MonetaryRangeInterpretation,MonetaryReviewRequirement,WalletClarification} from '../../../packages/contracts/src/wallet.js';
import {isGeneratedMonetaryReview,monetaryReviewResolved} from '../../../packages/contracts/src/monetary-review.js';
import {parsePermissionJson} from './wallet-ui.js';

export type AmountChoice=MonetaryMeaning;
export type AmountChoices=MonetaryInterpretations;
const choiceLabels:Record<AmountChoice,string>={maximum:'Maximum per purchase',minimum:'Minimum per purchase',exact:'Exact amount per purchase',approximate:'Approximate target · set an acceptable range',range:'Custom price range',description:'Transaction description · no spending limit'};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const isAmountChoice=(value:unknown):value is AmountChoice=>typeof value==='string'&&Object.hasOwn(choiceLabels,value);
export const amountClarifications=(clarifications:WalletClarification[])=>clarifications.filter(c=>c.key.startsWith('amount:'));
export const amountChoiceMeaning=(answer:MonetaryInterpretation|undefined):AmountChoice|undefined=>typeof answer==='object'?answer.meaning:answer;
function isRangeAnswer(value:unknown):value is MonetaryRangeInterpretation {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const answer=value as Record<string,unknown>;
 return (answer['meaning']==='approximate'||answer['meaning']==='range')&&typeof answer['min_order_chf']==='string'&&typeof answer['max_order_chf']==='string'&&Object.keys(answer).every(key=>['meaning','min_order_chf','max_order_chf'].includes(key));
}
export function selectAmountChoice(previous:MonetaryInterpretation|undefined,meaning:AmountChoice):MonetaryInterpretation {
 if(meaning!=='approximate'&&meaning!=='range')return meaning;
 return {meaning,min_order_chf:typeof previous==='object'?previous.min_order_chf:'',max_order_chf:typeof previous==='object'?previous.max_order_chf:''};
}

/** Keep incomplete range drafts editable after reload, but never treat them as confirmed answers. */
export function restoreAmountChoices(source:string|null,clarifications:WalletClarification[]):AmountChoices {
 try{
  const saved:unknown=JSON.parse(source??'{}');
  if(!saved||typeof saved!=='object'||Array.isArray(saved))return {};
  const choices:AmountChoices={};
  for(const c of amountClarifications(clarifications)){
   const value=(saved as Record<string,unknown>)[c.key];
   if(isAmountChoice(value))choices[c.key]=selectAmountChoice(undefined,value);
   else if(isRangeAnswer(value))choices[c.key]={...value};
  }
  return choices;
 }catch{return {};}
}
function cents(value:unknown):bigint|null {
 if(value===null||value===undefined)return null;
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))throw Error('Amounts must be CHF values with at most two decimal places.');
 const [whole,fraction='']=value.split('.');
 return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
}
function validateRange(answer:MonetaryRangeInterpretation,question:WalletClarification):void {
 if(!answer.min_order_chf||!answer.max_order_chf)throw Error('Enter both the minimum and maximum acceptable price for every approximate amount or custom range.');
 const min=cents(answer.min_order_chf)!,max=cents(answer.max_order_chf)!;
 if(min>max)throw Error('These amount choices conflict: the minimum exceeds the maximum. Change your range.');
 if(answer.meaning==='approximate'){
  const target=cents(question.diagnostic?.decoded_value);
  if(target===null)throw Error('This amount needs to be decoded again before you can confirm.');
  if(target<min||target>max)throw Error('The acceptable range must include the original approximate target. Choose a custom range to set different bounds.');
 }
}
export function amountChoicesComplete(clarifications:WalletClarification[],choices:AmountChoices):boolean {
 return amountClarifications(clarifications).every(c=>{
  const answer=choices[c.key];
  if(isRangeAnswer(answer)){try{validateRange(answer,c);return true;}catch{return false;}}
  return isAmountChoice(answer)&&answer!=='approximate'&&answer!=='range';
 });
}

/** Always start from the decoded, unambiguous bounds so changing a choice removes its previous effect. */
export function interpretedAmountBounds(base:Record<string,unknown>,clarifications:WalletClarification[],choices:AmountChoices):{min_order_chf:string|null;max_order_chf:string|null} {
 let minimum=(base['min_order_chf'] as string|null|undefined)??null,maximum=(base['max_order_chf'] as string|null|undefined)??null;
 cents(minimum);cents(maximum);
 for(const c of amountClarifications(clarifications)){
  const choice=choices[c.key];
  if(!choice||choice==='description')continue;
  let lower:string|null=null,upper:string|null=null;
  if(typeof choice==='object'){
   if(!isRangeAnswer(choice))throw Error('Choose a valid amount meaning and acceptable range.');
   validateRange(choice,c);lower=choice.min_order_chf;upper=choice.max_order_chf;
  }else{
   if(choice==='approximate'||choice==='range')throw Error('Enter both the minimum and maximum acceptable price for every approximate amount or custom range.');
   const value=c.diagnostic?.decoded_value,amount=cents(value);
   if(amount===null||typeof value!=='string')throw Error('This amount needs to be decoded again before you can confirm.');
   if(choice==='minimum'||choice==='exact')lower=value;
   if(choice==='maximum'||choice==='exact')upper=value;
  }
  if(lower!==null&&(minimum===null||cents(lower)!>cents(minimum)!))minimum=lower;
  if(upper!==null&&(maximum===null||cents(upper)!<cents(maximum)!))maximum=upper;
 }
 if(minimum!==null&&maximum!==null&&cents(minimum)!>cents(maximum)!)throw Error('These amount choices conflict: the minimum exceeds the maximum. Change a choice or edit your original instruction and decode again.');
 return {min_order_chf:minimum,max_order_chf:maximum};
}
function currentReviews(parameters:Record<string,unknown>):MonetaryReviewRequirement[] {
 const reviews=parameters['manual_review_requirements'];
 if(!Array.isArray(reviews)||reviews.some(r=>!r||typeof r!=='object'||typeof r.source_excerpt!=='string'||typeof r.description!=='string'))throw Error('The JSON purchase review requirements must be a list of source excerpts and descriptions.');
 return reviews as MonetaryReviewRequirement[];
}
export function applyAmountChoices(source:string,base:Record<string,unknown>,clarifications:WalletClarification[],choices:AmountChoices,generatedReview?:MonetaryReviewRequirement|null):string {
 if(!amountClarifications(clarifications).length)return source;
 const parameters:Record<string,unknown>={...parsePermissionJson(source),...interpretedAmountBounds(base,clarifications,choices)};
 if(generatedReview){
  const reviews=currentReviews(parameters),resolved=monetaryReviewResolved(clarifications,choices,generatedReview);
  parameters['manual_review_requirements']=resolved?reviews.filter(r=>!isGeneratedMonetaryReview(r,generatedReview)):reviews.some(r=>isGeneratedMonetaryReview(r,generatedReview))?reviews:[...reviews,generatedReview];
 }
 return JSON.stringify(parameters,null,2);
}
export function validateAmountChoices(source:string,base:Record<string,unknown>,clarifications:WalletClarification[],choices:AmountChoices,generatedReview?:MonetaryReviewRequirement|null):void {
 if(!amountClarifications(clarifications).length)return;
 const bounds=interpretedAmountBounds(base,clarifications,choices);
 if(!amountChoicesComplete(clarifications,choices))throw Error('Choose what every quoted amount means before confirming.');
 const parameters=parsePermissionJson(source);
 for(const key of ['min_order_chf','max_order_chf'] as const){
  if(cents(parameters[key])!==cents(bounds[key]))throw Error('The JSON spending bounds do not match your amount choices. Reapply the choices, or edit your original instruction and decode again.');
 }
 if(generatedReview){
  const hasReview=currentReviews(parameters).some(r=>isGeneratedMonetaryReview(r,generatedReview));
  if(hasReview===monetaryReviewResolved(clarifications,choices,generatedReview))throw Error('The JSON purchase review does not match your amount choices. Reapply the choices before confirming.');
 }
}
export function renderAmountChoiceNotes(clarifications:WalletClarification[],choices:AmountChoices):string {
 const notes=amountClarifications(clarifications).flatMap(c=>{
  const quote=esc(c.diagnostic?.source_excerpt??c.label),amount=esc(c.diagnostic?.decoded_value),answer=choices[c.key],meaning=amountChoiceMeaning(answer);
  if(meaning==='approximate'||meaning==='range'){
   const target=meaning==='approximate'?`CHF ${amount} in “${quote}” remains your approximate target. `:'';
   try{if(typeof answer==='object'){validateRange(answer,c);return [`<li>${target}Your acceptable range is CHF ${esc(answer.min_order_chf)}–${esc(answer.max_order_chf)} per purchase, including delivery. Your other limits still apply.</li>`];}}catch{/* Show the incomplete choice without suggesting it is enforceable. */}
   return [`<li>${target}Set both acceptable price bounds before confirming. No tolerance is assumed.</li>`];
  }
  if(meaning==='description')return [`<li>CHF ${amount} in “${quote}” describes a transaction. It adds no spending bound and does not change the scenario’s simulated purchases.</li>`];
  return [];
 });
 return notes.length?`<ul class="retained-points">${notes.join('')}</ul>`:'';
}
export function renderAmountReview(instruction:string,clarifications:WalletClarification[],choices:AmountChoices):string {
 const amounts=amountClarifications(clarifications);
 const original=`<details class="technical-details"${amounts.length?' open':''}><summary>Your original instruction</summary><blockquote style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(instruction)}</blockquote></details>`;
 if(!amounts.length)return original;
 const fields=amounts.map((c,index)=>{
  const answer=choices[c.key],meaning=amountChoiceMeaning(answer),range=typeof answer==='object'?answer:undefined;
  return `<div><label for="amount-choice-${index}">What does CHF ${esc(c.diagnostic?.decoded_value)} mean in “${esc(c.diagnostic?.source_excerpt??c.label)}”?<select id="amount-choice-${index}" data-amount-choice="${esc(c.key)}" required aria-describedby="amount-choice-status"><option value=""${meaning?'':' selected'}>Choose a meaning…</option>${Object.entries(choiceLabels).map(([value,label])=>`<option value="${value}"${meaning===value?' selected':''}>${esc(label)}</option>`).join('')}</select></label><div data-amount-range="${esc(c.key)}"${meaning==='approximate'||meaning==='range'?'':' hidden'}><p>What price range would you be comfortable with?</p><p data-amount-target="${esc(c.key)}"${meaning==='approximate'?'':' hidden'}>Original target: CHF ${esc(c.diagnostic?.decoded_value)}</p><label for="amount-min-${index}">Minimum acceptable (CHF)<input id="amount-min-${index}" type="text" inputmode="decimal" autocomplete="off" data-amount-range-key="${esc(c.key)}" data-amount-bound="min_order_chf" value="${esc(range?.min_order_chf??'')}" aria-describedby="amount-choice-status"></label><label for="amount-max-${index}">Maximum acceptable (CHF)<input id="amount-max-${index}" type="text" inputmode="decimal" autocomplete="off" data-amount-range-key="${esc(c.key)}" data-amount-bound="max_order_chf" value="${esc(range?.max_order_chf??'')}" aria-describedby="amount-choice-status"></label></div></div>`;
 }).join('');
 return `<section class="panel wallet-review" aria-labelledby="amount-review-title"><h3 id="amount-review-title">Clarify the amounts</h3><p>You mentioned a purchase amount. How much flexibility should the agent have? Choose what each quoted amount means before you confirm.</p>${original}<div class="clarification-fields">${fields}</div><p class="help-text">Minimum, maximum, exact amounts and ranges apply per purchase, including delivery, together with your other limits. Approximate amounts need a range you choose. Changing these choices updates the JSON and the retained points.</p><div id="amount-choice-notes" aria-live="polite">${renderAmountChoiceNotes(clarifications,choices)}</div><p id="amount-choice-status" class="help-text" role="status"></p><button class="button button--secondary" type="button" id="reapply-amount-choices">Reapply amount choices to JSON</button></section>`;
}
