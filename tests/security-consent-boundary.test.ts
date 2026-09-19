import { describe, expect, it } from 'vitest';
import type { HumanAnswer } from '../packages/contracts/src/simulation.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { hash, offerHash } from '../packages/local-runtime/src/simulation/common.js';
import { fixture } from './simulation-fixture.js';

type Context = ReturnType<typeof fixture>;
type Case = 'risk' | 'attribute' | 'returns';

function setup(kind: Case): { ctx: Context; answer: HumanAnswer; filter: string } {
  const ctx = fixture(kind === 'risk' ? 'AU0001' : 'AU0019');
  if (kind === 'risk') ctx.config.parameters.always_ask = true;
  else if (kind === 'attribute') {
    ctx.config.parameters.attributes = [{ name: 'size', values: ['43'], unit: 'EU' }];
    ctx.event.authorization.items[0]!.item_details = 'Size EU 42 or 43';
  } else {
    ctx.config.parameters.min_return_days = 14;
    ctx.event.authorization.items[0]!.item_details = 'Return window available from customer service.';
  }
  ctx.offer_hash = offerHash(ctx.event, ctx.config);
  const filter = kind === 'risk' ? 'C24' : kind === 'attribute' ? 'M11' : 'M13';
  const question = assess(ctx).questions.find(q => q.filter_ids.includes(filter as never))!;
  expect(question).toBeDefined();
  const answer: HumanAnswer = {
    answer_id: 'ANSWER_SECURITY', question_id: question.question_id, fact_key: question.fact_key,
    kind: question.kind, value: 'confirm',
    source_ref: null,
    source_excerpt: null,
    actor: { actor_id: 'owner', role: 'simulated_human', channel: 'local_ui', authenticated_by_server: true, customer_id: ctx.run.customer_id },
    offer_hash: ctx.offer_hash, config_revision: ctx.config.revision, created_at: ctx.now,
    expires_at: new Date(Date.parse(ctx.now) + 120000).toISOString(), consumed_by: null,
  };
  return { ctx, answer, filter };
}

const invalidAnswers: Array<[string, (answer: HumanAnswer, ctx: Context) => void]> = [
  ['another customer', a => { a.actor.customer_id = 'someone-else'; }],
  ['unauthenticated actor', a => { a.actor.authenticated_by_server = false as true; }],
  ['agent role', a => { a.actor.role = 'agent' as never; }],
  ['agent channel', a => { a.actor.channel = 'agent' as never; }],
  ['another offer', a => { a.offer_hash = 'another-offer'; }],
  ['another config revision', a => { a.config_revision += 1; }],
  ['another question', a => { a.question_id = 'Q_another'; }],
  ['consumed response', a => { a.consumed_by = 'older-assessment'; }],
  ['expired response', (a, ctx) => { a.expires_at = ctx.now; }],
  ['future response', (a, ctx) => { a.created_at = new Date(Date.parse(ctx.now) + 1).toISOString(); }],
  ['invalid creation time', a => { a.created_at = 'invalid'; }],
  ['invalid expiry', a => { a.expires_at = 'invalid'; }],
];

describe.each<Case>(['risk', 'attribute', 'returns'])('shared-engine %s response boundary', kind => {
  it('accepts authenticated, current, unused evidence for the exact typed question', () => {
    const { ctx, answer, filter } = setup(kind);
    ctx.answers = [answer];
    const checked = assess(ctx);
    expect(checked.results.find(r => r.filter_id === filter)?.outcome).toBe('pass');
    expect(checked.technical_filter_ids).toEqual([]);
    // The pure evaluator must not consume consent; the durable commit owns that.
    expect(assess(ctx).results.find(r => r.filter_id === filter)?.outcome).toBe('pass');
    expect(answer.consumed_by).toBeNull();
  });

  it.each(invalidAnswers)('rejects %s even when called without an HTTP service', (_name, alter) => {
    const { ctx, answer, filter } = setup(kind);
    alter(answer, ctx); ctx.answers = [answer];
    const checked = assess(ctx);
    expect(checked.can_finalize).toBe(false);
    expect(checked.results.find(r => r.filter_id === filter)?.outcome).toBe('needs_review');
    expect(checked.technical_filter_ids).toContain('G04');
    expect(checked.results.find(r => r.filter_id === 'G04')?.reasons[0]?.code).toBe('G04_RESPONSE_INVALID');
    expect(checked.results.find(r => r.filter_id === 'G04')?.evidence[0]?.observed).toEqual(expect.arrayContaining([expect.objectContaining({ answer_id: answer.answer_id })]));
    expect(checked.facts_hash).toBe(hash([ctx.event, ctx.answers]));
    if (kind !== 'risk') expect(evaluateMerchant(ctx).find(r => r.filter_id === filter)?.outcome).toBe('needs_review');
  });

  it('does not substitute another response kind for the requested action', () => {
    const { ctx, answer, filter } = setup(kind);
    answer.kind = kind === 'risk' ? 'provide_evidence' : 'confirm_risk';
    ctx.answers = [answer];
    const checked = assess(ctx);
    expect(checked.can_finalize).toBe(false);
    expect(checked.results.find(r => r.filter_id === filter)?.outcome).toBe('needs_review');
  });
});

it('preserves deterministic denial even with valid customer consent', () => {
  const { ctx, answer } = setup('risk');
  ctx.config.parameters.max_order_chf = '1';
  ctx.answers = [answer];
  expect(assess(ctx)).toMatchObject({ decision: 'deny', can_finalize: false, blocking_filter_ids: expect.arrayContaining(['C09']) });
});
