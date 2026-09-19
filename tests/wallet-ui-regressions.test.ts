import { describe, expect, it } from 'vitest';
import { allowsPurchaseResponse, liveApprovalBody, runRenderSignature, runStatusText, collectLiveAnswers, retryEligible, purchaseConfirmation, purchaseReviewSnapshot } from '../apps/local-web/web/wallet-ui.js';
import { renderPurchaseCard, renderReview } from '../apps/local-web/web/wallet-run-view.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { filterMessage } from '../packages/contracts/src/filter-messages.js';
import type { Assessment } from '../packages/contracts/src/simulation.js';
import type { WalletRunView } from '../packages/contracts/src/wallet.js';
import { fixture } from './simulation-fixture.js';

function runView(state: Assessment['execution_state'] = 'awaiting_user', mode: WalletRunView['mode'] = 'local'): WalletRunView {
 const context = fixture('AU0001'); context.config.parameters.always_ask = true;
 const assessment = assess(context); assessment.execution_state = state;
 const authorization = context.event.authorization;
 return { server_time: context.now, has_more_proposals: false, run_id: 'UI_RUN', mode, status: 'active', mandate_status: 'active', mandate_id: context.config.mandate_id, scenario_id: 'SCEN0000', approved_chf: '0', reservations: 0, audit: [], config: context.config, transport: { last_status: 204, note: 'Injected UI test; no network.' }, purchases: [{ authorization_id: authorization.authorization_id, merchant_id: authorization.merchant.merchant_id, merchant_name: authorization.merchant.merchant_name, amount_chf: String(authorization.billing_amount_chf), currency: authorization.currency, description: authorization.purchase_description, items: authorization.items, assessment }] };
}

describe('local recovery controls in the actual wallet frontend', () => {
 it('renders an expiration without a revision change and binds retry eligibility to its current assessment', () => {
  const view=runView(),purchase=view.purchases[0]!,signature=runRenderSignature(view),revision=purchase.assessment!.revision;
  expect(renderPurchaseCard(purchase,'local','active')).not.toContain('retry-purchase');
  purchase.assessment!.execution_state='expired';
  expect(runRenderSignature(view)).not.toBe(signature);
  expect(purchase.assessment!.revision).toBe(revision);
  const html=renderPurchaseCard(purchase,'local','active');
  expect(html).toContain('Re-evaluate purchase');expect(html).not.toContain('class="human-form"');
  purchase.assessment!.execution_state='awaiting_user';
  expect(renderPurchaseCard(purchase,'local','active')).not.toContain('retry-purchase');
 });
 it('offers recovery for local technical holds, never live or revoked purchases', () => {
  const purchase = runView('technical_hold').purchases[0]!;
  expect(renderPurchaseCard(purchase, 'local', 'active')).toContain('Re-evaluate purchase');
  expect(renderPurchaseCard(purchase, 'local', 'revoked')).not.toContain('retry-purchase');
  expect(renderPurchaseCard(purchase, 'live', 'active')).not.toContain('retry-purchase');
  for (const state of ['approved', 'declined', 'cancelled', 'awaiting_user'] as const) expect(retryEligible({ ...purchase.assessment!, execution_state: state }, 'local')).toBe(false);
 });
 it.each(['M02', 'M04'])('does not ask for unusable free-form evidence for frozen history: %s', filterId => {
  const context = fixture(); context.run.history = [];
  if (filterId === 'M02') context.config.parameters.familiar_merchant = true;
  else context.config.parameters.regularity = { days: 180, distinct_dates: 3 };
  const assessment = assess(context);
  const question = assessment.questions.find(q => q.filter_ids.includes(filterId as 'M02' | 'M04'))!;
  expect(question.kind).toBe('amend_mandate');
  const html = renderReview({ ...assessment, questions: [question] }, assessment.authorization_id, 'local');
  expect(html).toContain('Review permissions for a new run');
  expect(html).not.toContain('Verified value');
  expect(html).not.toContain('Verify and continue');
  expect(html).not.toContain('type="submit"');
 });
});

describe('explicit live answers and minimum amount messages', () => {
 it('keeps the binary acceptance explicit without inventing product evidence', () => {
  expect(collectLiveAnswers([{ question_id: 'size', kind: 'confirm_requirement' }, { question_id: 'returns', kind: 'confirm_requirement' }, { question_id: 'device', kind: 'confirm_risk' }])).toEqual([
   { question_id: 'size', value: 'confirm' },
   { question_id: 'returns', value: 'confirm' },
   { question_id: 'device', value: 'confirm' },
  ]);
 });
 it('keeps required system verification outside the binary acceptance button', () => {
  const risk=runView().purchases[0]!.assessment!;const html=renderReview(risk,risk.authorization_id,'live');expect(html).toContain('Accept this purchase');expect(html).toContain('accept the risks listed above');
  for (const kind of ['provide_evidence', 'choose_variant', 'replace_quote', 'amend_mandate', 'retry_or_repair']) expect(() => collectLiveAnswers([{ question_id: 'repair', kind }])).toThrow('before confirmation');
 });
 it('shows the actual amount and the confirmed minimum', () => {
  expect(filterMessage('C09', 'C09_PURCHASE_BELOW_MINIMUM', '18.50', '20')).toBe('C09: Total CHF 18.50 is below the confirmed CHF 20.00 minimum, including delivery.');
 });
});

describe('binary decisions belong to the displayed purchase card', () => {
 it.each(['local','live'] as const)('accepts only the selected card and its current open questions in %s mode',mode=>{
  const view=runView('awaiting_user',mode),first=view.purchases[0]!,second=structuredClone(first);
  second.authorization_id='ANOTHER_PURCHASE';second.assessment!.authorization_id=second.authorization_id;
  second.assessment!.offer_hash='second-offer';second.assessment!.revision=2;
  second.assessment!.questions=second.assessment!.questions.map(q=>({...q,question_id:`second-${q.question_id}`,offer_hash:'second-offer'}));
  second.assessment!.questions.push({...second.assessment!.questions[0]!,question_id:'already-resolved',state:'resolved',answer_id:'prior-answer'});
  view.purchases.push(second);
  const firstSnapshot=purchaseReviewSnapshot(first.assessment!),secondSnapshot=purchaseReviewSnapshot(second.assessment!);
  const confirmation=purchaseConfirmation(view,second.authorization_id,secondSnapshot)!;
  expect(confirmation.purchase.authorization_id).toBe(second.authorization_id);
  expect(confirmation.answers).toEqual(second.assessment!.questions.filter(q=>q.state==='open').map(q=>({question_id:q.question_id,value:'confirm'})));
  expect(confirmation.answers.some(answer=>first.assessment!.questions.some(q=>q.question_id===answer.question_id))).toBe(false);
  expect(liveApprovalBody(confirmation.purchase.authorization_id,confirmation.assessment,confirmation.answers)).toMatchObject({authorization_id:second.authorization_id,offer_hash:'second-offer',expected_revision:2});
  expect(purchaseConfirmation(view,first.authorization_id,secondSnapshot)).toBeNull();
  expect(purchaseConfirmation(view,'missing-card',firstSnapshot)).toBeNull();
  expect(purchaseConfirmation(view,first.authorization_id,firstSnapshot)).not.toBeNull();
  const html=view.purchases.map(p=>renderPurchaseCard(p,mode,'active')).join('');
  expect(html.match(/data-review-action="approve"/g)).toHaveLength(2);
  expect(html.match(/data-review-action="decline"/g)).toHaveLength(2);
  expect(html).not.toMatch(/<(?:input|textarea|select)\b/);
 });
 it('requires a fresh review after the offer or questions change, even without a revision bump',()=>{
  const view=runView(),purchase=view.purchases[0]!,a=purchase.assessment!,snapshot=purchaseReviewSnapshot(a);
  a.offer_hash='replacement-offer';expect(purchaseConfirmation(view,purchase.authorization_id,snapshot)).toBeNull();
  const replacement=purchaseReviewSnapshot(a);
  a.questions.push({...a.questions[0]!,question_id:'new-requirement',kind:'confirm_requirement',prompt:'Review this additional requirement.'});
  expect(purchaseConfirmation(view,purchase.authorization_id,replacement)).toBeNull();
  expect(purchaseConfirmation(view,purchase.authorization_id,purchaseReviewSnapshot(a))?.answers).toEqual(expect.arrayContaining([{question_id:'new-requirement',value:'confirm'}]));
  const oldWording=purchaseReviewSnapshot(a);a.questions[0]!.prompt='The purchase must satisfy an updated requirement.';
  expect(purchaseConfirmation(view,purchase.authorization_id,oldWording)).toBeNull();
  a.execution_state='technical_hold';expect(purchaseConfirmation(view,purchase.authorization_id,purchaseReviewSnapshot(a))).toBeNull();
 });
 it('keeps a pending budget hold declinable without allowing acceptance',()=>{
  const view=runView('technical_hold','live'),purchase=view.purchases[0]!,a=purchase.assessment!;
  purchase.platform_status='awaiting_human';
  const budget=a.results.find(r=>r.filter_id==='C12')!;
  budget.outcome='not_evaluated';budget.reasons[0]!.code='C12_BUDGET_RESERVED_ELSEWHERE';budget.reasons[0]!.effect='technical_hold';
  const html=renderPurchaseCard(purchase,'live','awaiting_customer');
  expect(html).toContain('Waiting for available budget');expect(html).toContain('checked again automatically');
  expect(html).toContain('data-review-action="decline"');expect(html).not.toContain('data-review-action="approve"');
  expect(html).not.toMatch(/<(?:input|textarea|select)\b/);
  expect(purchaseConfirmation(view,purchase.authorization_id,purchaseReviewSnapshot(a))).toBeNull();
  a.execution_state='awaiting_user';budget.outcome='pass';
  expect(renderPurchaseCard(purchase,'live','awaiting_customer')).toContain('data-review-action="approve"');
 });
 it('keeps a now-denied pending remote purchase declinable until the platform records a decision',()=>{
  const view=runView('technical_hold','live'),purchase=view.purchases[0]!;
  purchase.platform_status='awaiting_human';purchase.assessment!.decision='deny';
  const html=renderPurchaseCard(purchase,'live','awaiting_customer');
  expect(html).toContain('data-review-action="decline"');expect(html).not.toContain('data-review-action="approve"');
  purchase.platform_status='declined';expect(renderPurchaseCard(purchase,'live','active')).not.toContain('data-review-action="decline"');
  purchase.platform_status='awaiting_human';purchase.assessment!.lock=null;
  expect(renderPurchaseCard(purchase,'live','active')).not.toContain('consent-countdown');
 });
});

 it.each(['revocation_pending','revocation_unknown','reconciliation_required','submission_unknown','authentication_required','queue_conflict','revoked','failed','cancelled'])('blocks API purchase responses while %s and explains the reason',status=>{
  expect(allowsPurchaseResponse({mode:'live',status,mandate_status:'active'})).toBe(false);
  expect(runStatusText(status)).not.toContain('Watching for purchase');
 });
 it('includes the reviewed offer hash and revision in live approval payloads',()=>{
  const a=runView().purchases[0]!.assessment!,answers=[{question_id:'risk',value:'confirm'}];
  expect(liveApprovalBody(a.authorization_id,a,answers)).toEqual({authorization_id:a.authorization_id,decision:'approve',offer_hash:a.offer_hash,expected_revision:a.revision,answers});
  expect(allowsPurchaseResponse({mode:'live',status:'awaiting_customer',mandate_status:'active'})).toBe(true);
  expect(allowsPurchaseResponse({mode:'live',status:'awaiting_customer',mandate_status:'revoked'})).toBe(false);
 });
