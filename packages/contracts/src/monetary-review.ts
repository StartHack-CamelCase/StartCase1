import type {MonetaryInterpretations,MonetaryReviewRequirement,WalletClarification} from './wallet.js';

/** The compiler alone identifies this generated review. Call after validating
 * the answers: resolving the price cannot erase unrelated purchase conditions. */
export function monetaryReviewResolved(clarifications:WalletClarification[],answers:MonetaryInterpretations,generated:MonetaryReviewRequirement|null|undefined):boolean {
 if(!generated||clarifications.some(c=>c.key.startsWith('unresolved:')))return false;
 const questions=clarifications.filter(c=>c.key.startsWith('amount:'));
 return questions.length>0&&questions.every(c=>{
  const answer=answers[c.key];
  return answer==='minimum'||answer==='maximum'||answer==='exact'||typeof answer==='object'&&(answer.meaning==='approximate'||answer.meaning==='range')&&!!answer.min_order_chf&&!!answer.max_order_chf;
 });
}
export function isGeneratedMonetaryReview(requirement:MonetaryReviewRequirement,generated:MonetaryReviewRequirement):boolean {
 return requirement.source_excerpt===generated.source_excerpt&&requirement.description===generated.description;
}
