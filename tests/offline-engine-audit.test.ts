import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MandateRecord } from '../packages/contracts/src/policy.js';
import type { Commitment, FilterId, HumanActor, SafetyParameters } from '../packages/contracts/src/simulation.js';
import { defaultParameters, suggestConfig, validateParameters } from '../packages/local-runtime/src/simulation/config.js';
import { affectedRolling, evaluateCustomer } from '../packages/local-runtime/src/simulation/customer.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { createLocalRuntime, type LocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { fixture } from './simulation-fixture.js';

const check = (ctx: ReturnType<typeof fixture>, id: FilterId) => {
  const merchants = evaluateMerchant(ctx);
  return [...merchants, ...evaluateCustomer(ctx, merchants)].find(r => r.filter_id === id)!;
};
const commitment = (ctx: ReturnType<typeof fixture>, overrides: Partial<Commitment> = {}): Commitment => ({
  authorization_id: 'PREVIOUS', amount_chf: '90.00', timestamp: ctx.event.authorization.timestamp,
  quantity: 1, budget_scope_id: ctx.run.budget_scope_id, ...overrides,
});

describe('offline engine audit: merchant commitments and configuration', () => {
  it('enforces recurring payments identified by the structured channel', () => {
    const ctx = fixture('AU0001');
    ctx.event.authorization.channel = 'recurring';
    ctx.config.parameters.forbid_recurring = true;
    expect(check(ctx, 'M16').outcome).toBe('fail');
    ctx.config.parameters.forbid_recurring = false;
    expect(check(ctx, 'M16').outcome).toBe('needs_review');
  });

  it.each([
    ['No subscription included.', 'Monthly subscription renews automatically.'],
    ['No renewal.', 'A subscription is included.'],
    ['Without subscription.', 'Charged every month.'],
  ])('does not let a negation in another basket line hide a recurring charge', (ordinary, recurring) => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.forbid_recurring = true;
    const item = ctx.event.authorization.items[0]!;
    item.item_details = ordinary;
    ctx.event.authorization.items = [item, { ...item, line_no: 2, item_details: recurring }];
    expect(check(ctx, 'M16').outcome).toBe('fail');
  });

  it.each([
    'No subscription; the service renews every month.',
    'No renewal for the device, but a monthly subscription is included.',
  ])('keeps independent positive recurring clauses: %s', text => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.forbid_recurring = true;
    ctx.event.authorization.items[0]!.item_details = text;
    expect(check(ctx, 'M16').outcome).toBe('fail');
  });

  it.each(['No subscription.', 'Without renewal.', 'No monthly subscription.', 'No subscription or renewal.'])('does not invent recurrence from %s', text => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.forbid_recurring = true;
    ctx.event.authorization.items[0]!.item_details = text;
    expect(check(ctx, 'M16').outcome).toBe('not_applicable');
  });

  it.each(['merchant_category', 'merchant_mcc'] as const)('requires review when a merchant declares %s contradicting the reference', field => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.allowed_merchant_categories = ['sporting_goods'];
    ctx.event.authorization.merchant[field] = field === 'merchant_category' ? 'sporting_goods' : '5941';
    const assessment = assess(ctx);
    expect(assessment.can_finalize).toBe(false);
    expect(assessment.doubt_filter_ids).toContain('M01');
  });

  it.each(['27.5-inch', '27,5 pouces'])('keeps the entire fractional display dimension in %s', dimension => {
    const config = suggestConfig({ mandate_id: 'M', version: 1, instruction: `Buy one ${dimension} monitor.`, hard_rules: [], interpretation: {} } as unknown as MandateRecord, '2026-09-19T00:00:00Z');
    expect(config.parameters.attributes).toContainEqual({ name: 'inches', values: ['27.5'], unit: 'inch' });
  });

  it.each(['2026-99-01', '2026-00-10', '2026-02-30', '2026-13-01'])('rejects the invalid delivery date %s with a configuration error', delivery_deadline => {
    expect(() => validateParameters({ ...defaultParameters(), delivery_deadline })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 400 }));
  });
});

describe('offline engine audit: money and missing data', () => {
  it('reconciles decimal cents without binary floating point drift', () => {
    const ctx = fixture('AU0001');
    const item = ctx.event.authorization.items[0]!;
    ctx.event.authorization.items = [{ ...item, quantity: 3, unit_price: 0.1 }];
    Object.assign(ctx.event.authorization, { amount: 0.5, items_subtotal: 0.3, delivery_fee: 0.2, billing_amount_chf: 0.5 });
    expect(check(ctx, 'M19').outcome).toBe('pass');
  });

  it.each(['amount', 'items_subtotal', 'delivery_fee', 'billing_amount_chf'] as const)('detects a one-cent inconsistency in %s', field => {
    const ctx = fixture('AU0001');
    ctx.event.authorization[field] += 0.01;
    expect(check(ctx, 'M19').outcome).toBe('fail');
    expect(assess(ctx).can_finalize).toBe(false);
  });

  it.each([['1.005', 1], ['1.015', 1.02]] as const)('uses half-even rounding for an FX rate of %s', (rate, billed) => {
    const ctx = fixture('AU0032');
    const fx = ctx.pack.fxByCurrency.get('EUR')!;
    ctx.pack.fxByCurrency = new Map(ctx.pack.fxByCurrency).set('EUR', { ...fx, rate: rate as typeof fx.rate });
    ctx.event.authorization.items = [{ ...ctx.event.authorization.items[0]!, quantity: 1, unit_price: 1 }];
    Object.assign(ctx.event.authorization, { amount: 1, items_subtotal: 1, delivery_fee: 0, billing_amount_chf: billed });
    expect(check(ctx, 'M19').outcome).toBe('pass');
  });

  it('holds every amount-dependent budget when the FX reference is absent', () => {
    const ctx = fixture('AU0032');
    Object.assign(ctx.config.parameters, { rolling_budget: { days: 7, limit_chf: '300' }, daily_budget_chf: '300', monthly_budget_chf: '300' });
    ctx.pack.fxByCurrency = new Map();
    const assessment = assess(ctx);
    expect(assessment.execution_state).toBe('technical_hold');
    expect(assessment.can_finalize).toBe(false);
    expect(assessment.technical_filter_ids).toEqual(expect.arrayContaining(['M19', 'C09', 'C10', 'C11', 'C12']));
    ctx.config.parameters.allowed_currencies = ['CHF'];
    expect(check(ctx, 'C09')).toMatchObject({ outcome: 'fail', reasons: expect.arrayContaining([expect.objectContaining({ code: 'C09_TRANSACTION_CURRENCY_FORBIDDEN' })]) });
  });

  it('treats mixed line and payment currencies as unverifiable', () => {
    const ctx = fixture('AU0001');
    ctx.event.authorization.items[0]!.currency = 'EUR';
    expect(check(ctx, 'M19').outcome).toBe('not_evaluated');
    expect(assess(ctx).can_finalize).toBe(false);
  });

  it.each(['cardsById', 'accountsById', 'authoritiesById'] as const)('cannot approve when %s is missing', key => {
    const ctx = fixture('AU0001');
    ctx.pack[key] = new Map();
    expect(assess(ctx)).toMatchObject({ can_finalize: false, execution_state: 'technical_hold' });
  });
});

describe('offline engine audit: temporal budgets and reservations', () => {
  it.each(['foreign_scope', 'same_authorization', 'expired', 'expires_now'] as const)('ignores a reservation that is %s', reason => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.rolling_budget = { days: 7, limit_chf: '100' };
    const reservation = { ...commitment(ctx), offer_hash: 'OTHER', expires_at: '2026-09-20T00:00:00Z' };
    if (reason === 'foreign_scope') reservation.budget_scope_id = 'UNRELATED';
    if (reason === 'same_authorization') reservation.authorization_id = ctx.event.authorization.authorization_id;
    if (reason === 'expired') reservation.expires_at = '2026-09-18T00:00:00Z';
    if (reason === 'expires_now') reservation.expires_at = ctx.now;
    ctx.run.reservations = [reservation];
    expect(check(ctx, 'C12').outcome).toBe('pass');
    expect(check(ctx, 'C10').outcome).toBe('pass');
  });

  it('ignores other scopes and the current authorization in the committed ledger', () => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.rolling_budget = { days: 7, limit_chf: '20' };
    ctx.run.commitments = [commitment(ctx, { budget_scope_id: 'OTHER' }), commitment(ctx, { authorization_id: ctx.event.authorization.authorization_id })];
    expect(check(ctx, 'C10').outcome).toBe('pass');
  });

  it('does not attribute a purchase exactly seven days later to the candidate window', () => {
    const ctx = fixture('AU0001');
    const candidate = commitment(ctx, { amount_chf: '20.00' });
    const future = commitment(ctx, { authorization_id: 'FUTURE', timestamp: new Date(Date.parse(candidate.timestamp) + 7 * 86400000).toISOString() });
    expect(affectedRolling(candidate, [future], 7)).toEqual([{ end: candidate.timestamp, spent: '20.00' }]);
  });

  it('returns the same rolling-window amounts after reversing ledger insertion order', () => {
    const ctx = fixture('AU0001');
    const candidate = commitment(ctx, { amount_chf: '20.00' });
    const entries = [-6, -1, 0, 1, 6, 7].map((days, i) => commitment(ctx, { authorization_id: `ENTRY_${i}`, amount_chf: '10.00', timestamp: new Date(Date.parse(candidate.timestamp) + days * 86400000).toISOString() }));
    const sorted = (entries: Commitment[]) => affectedRolling(candidate, entries, 7).sort((a, b) => a.end.localeCompare(b.end));
    expect(sorted(entries)).toEqual(sorted([...entries].reverse()));
    expect(new Set(sorted(entries).map(w => w.spent))).toEqual(new Set(['50.00']));
    expect(new Set(sorted(entries).map(w => Date.parse(w.end))).size).toBe(3);
  });

  it.each([
    ['daily_budget_chf', '2026-08-01T22:30:00Z', '2026-08-02T00:30:00Z'],
    ['monthly_budget_chf', '2026-07-31T22:30:00Z', '2026-08-01T00:30:00Z'],
  ] as const)('groups %s by Zurich civil time across a UTC boundary', (budget, previous, current) => {
    const ctx = fixture('AU0001');
    ctx.config.parameters[budget] = '100';
    ctx.event.authorization.timestamp = current;
    ctx.run.commitments = [commitment(ctx, { timestamp: previous })];
    expect(check(ctx, 'C11').outcome).toBe('fail');
    ctx.config.parameters.timezone = 'UTC';
    expect(check(ctx, 'C11').outcome).toBe('pass');
  });

  it('keeps both occurrences of a DST repeated local hour in the same civil budget', () => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.daily_budget_chf = '100';
    ctx.event.authorization.timestamp = '2026-10-25T01:30:00Z';
    ctx.run.commitments = [commitment(ctx, { timestamp: '2026-10-25T00:30:00Z' })];
    expect(check(ctx, 'C11').outcome).toBe('fail');
  });

  it('pauses for reserved mission capacity, and denies after it is committed', () => {
    const ctx = fixture('AU0001');
    ctx.config.parameters.mission_quantity = ctx.event.authorization.items.reduce((n, item) => n + item.quantity, 0);
    ctx.run.reservations = [{ ...commitment(ctx), offer_hash: 'OTHER', expires_at: '2026-09-20T00:00:00Z' }];
    expect(check(ctx, 'C12').outcome).toBe('not_evaluated');
    expect(check(ctx, 'C14').outcome).toBe('pass');
    ctx.run.commitments = ctx.run.reservations;
    ctx.run.reservations = [];
    expect(check(ctx, 'C14').outcome).toBe('fail');
  });
});

describe('offline engine audit: every supplied proposal', () => {
  const policies: Partial<SafetyParameters>[] = [
    {}, { max_order_chf: '0' }, { allowed_merchant_ids: [] }, { allowed_item_categories: [] },
    { rolling_budget: { days: 7, limit_chf: '0' } }, { always_ask: true },
    { min_return_days: 14 }, { attributes: [{ name: 'size', values: ['43'], unit: 'EU' }] },
  ];
  it.each(Array.from({ length: 45 }, (_, i) => `AU${String(i + 1).padStart(4, '0')}`))('keeps all 50 outcomes and safe aggregation for %s under eight policies', id => {
    for (const policy of policies) {
      const ctx = fixture(id);
      Object.assign(ctx.config.parameters, policy);
      const assessment = assess(ctx);
      expect(assessment.results).toHaveLength(50);
      expect(new Set(assessment.results.map(r => r.filter_id)).size).toBe(50);
      expect(assessment.can_finalize).toBe(assessment.blocking_filter_ids.length + assessment.doubt_filter_ids.length + assessment.technical_filter_ids.length === 0);
      if (assessment.blocking_filter_ids.length) expect(assessment.decision).toBe('deny');
      if (policy.max_order_chf === '0' || policy.allowed_merchant_ids?.length === 0 || policy.allowed_item_categories?.length === 0 || policy.rolling_budget?.limit_chf === '0') expect(assessment.can_finalize).toBe(false);
    }
  });
});

describe('offline engine audit: interrupted revocation', () => {
  it('cannot consume pre-crash customer consent after a crash between the two persisted revocation steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'offline-revocation-audit-'));
    const external = vi.fn(async () => { throw new Error('Offline audit forbids external requests.'); });
    vi.stubGlobal('fetch', external);
    vi.stubEnv('LEASH_BASE_URL', ''); vi.stubEnv('TEAM_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', '');
    const open = () => createLocalRuntime({ stateDir: join(dir, 'state'), outputDir: join(dir, 'output'), now: () => new Date('2026-09-19T00:00:00Z'), instructionDecoder: { configured: false, model: 'offline-audit', decode: external } });
    let runtime: LocalRuntime | undefined;
    try {
      runtime = await open();
      const scenario = runtime.pack.scenariosById.get('SCEN0001' as never)!;
      const draft = await runtime.policies.createDraft(scenario.scenario_id, { instruction: scenario.cardholder_instruction, hard_rules: [], uncertainty_policy: 'ask', guidance: [], open_questions: [] });
      const mandate = await runtime.policies.confirmDraft(draft.draft_id, 'local_user');
      const config = runtime.simulations.suggest(mandate.mandate_id, 'revocation-suggest');
      const actor: HumanActor = { actor_id: 'offline-reviewer', role: 'simulated_human', customer_id: runtime.wallet.actorCustomer(scenario.scenario_id), channel: 'local_ui', authenticated_by_server: true };
      runtime.simulations.confirm(config.config_id, { ...config.parameters, domestic_country: 'CH', always_ask: true }, config.requirements.map(r => r.requirement_id), actor, 'revocation-confirm');
      const run = runtime.simulations.create(config.config_id, 'revocation-run');
      const pending = runtime.simulations.next(run.run_id, 'revocation-first').assessment!;
      expect(pending.decision).toBe('step_up');

      // This is exactly the durable state left if the process exits after policy
      // persistence, before simulations.revokeMandate can update its own database.
      await runtime.policies.revokeMandate(mandate.mandate_id);
      await runtime.close(); runtime = undefined;
      runtime = await open();
      expect(runtime.policies.getMandate(mandate.mandate_id).status).toBe('revoked');
      expect(runtime.simulations.get(run.run_id).commitments).toEqual([]);
      const result = runtime.simulations.answerBatch(run.run_id, pending.authorization_id, { expected_revision: pending.revision, offer_hash: pending.offer_hash, answers: pending.questions.map(q => ({ question_id: q.question_id, value: 'confirm' })) }, actor, 'after-crash-answer');
      expect(result.assessment?.decision).toBe('deny');
      expect(result.assessment?.blocking_filter_ids).toContain('C02');
      expect(runtime.simulations.get(run.run_id).commitments).toEqual([]);

      // Retrying the original operation safely completes the second durable step.
      await runtime.policies.revokeMandate(mandate.mandate_id);
      runtime.simulations.revokeMandate(mandate.mandate_id, 'revocation-retry');
      const revoked = runtime.simulations.get(run.run_id);
      expect(revoked).toMatchObject({ status: 'revoked', reservations: [], commitments: [] });
      runtime.simulations.revokeMandate(mandate.mandate_id, 'revocation-retry');
      expect(runtime.simulations.get(run.run_id)).toEqual(revoked);
      expect(external).not.toHaveBeenCalled();
    } finally {
      await runtime?.close(); await rm(dir, { recursive: true, force: true });
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });
});
