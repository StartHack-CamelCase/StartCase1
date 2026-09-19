import { describe, expect, it } from 'vitest';
import { allowsPurchaseResponse, liveApprovalBody, runRenderSignature, runStatusText, collectLiveAnswers, retryEligible } from '../apps/local-web/web/wallet-ui.js';
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
 it('preserves distinct sourced answers and checked consent', () => {
  const data = new FormData();
  for (const [id, value, source] of [['size', '43', 'size chart'], ['returns', '14', 'return policy']]) {
   data.set(`value:${id}`, value!); data.set(`source_ref:${id}`, source!); data.set(`source_excerpt:${id}`, `${source}: ${value}`);
  }
  data.set('value:device', 'confirm');
  expect(collectLiveAnswers(data, [{ question_id: 'size', kind: 'choose_variant' }, { question_id: 'returns', kind: 'provide_evidence' }, { question_id: 'device', kind: 'confirm_risk' }])).toEqual([
   { question_id: 'size', value: '43', source_ref: 'size chart', source_excerpt: 'size chart: 43' },
   { question_id: 'returns', value: '14', source_ref: 'return policy', source_excerpt: 'return policy: 14' },
   { question_id: 'device', value: 'confirm' },
  ]);
 });
 it('requires complete evidence and a correction for questions the confirmation button cannot resolve', () => {
  const data = new FormData();
  const risk=runView().purchases[0]!.assessment!;const html=renderReview(risk,risk.authorization_id,'live');expect(html).toContain('Confirm this purchase');expect(html).toContain('accept the risks listed above');
  expect(() => collectLiveAnswers(data, [{ question_id: 'proof', kind: 'provide_evidence' }])).toThrow('every question');
  for (const kind of ['replace_quote', 'amend_mandate', 'retry_or_repair']) expect(() => collectLiveAnswers(data, [{ question_id: 'repair', kind }])).toThrow('corrected quote');
 });
 it('shows the actual amount and the confirmed minimum', () => {
  expect(filterMessage('C09', 'C09_PURCHASE_BELOW_MINIMUM', '18.50', '20')).toBe('C09: Total CHF 18.50 is below the confirmed CHF 20.00 minimum, including delivery.');
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
