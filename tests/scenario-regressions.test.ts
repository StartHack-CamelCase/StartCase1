import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_FILTER_IDS } from '../packages/contracts/src/simulation.js';
import { AuthorizationEventFactory } from '../packages/local-runtime/src/data/event-builder.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { buildPurchaseScenarioCases, createSyntheticPurchaseHarness, PURCHASE_SCENARIO_POLICY, runPurchaseScenarioRegressions, type SyntheticPurchaseInput } from '../packages/local-runtime/src/simulation/scenario-regressions.js';

afterEach(() => vi.unstubAllGlobals());

describe('seven actual purchases under one fixed policy', () => {
  it('uses seven distinct synthetic events and no network or instruction decoding', () => {
    const network = vi.fn(() => { throw new Error('This regression harness must stay offline.'); });
    vi.stubGlobal('fetch', network);
    const report = runPurchaseScenarioRegressions();
    expect(network).not.toHaveBeenCalled();
    expect(report.passed).toBe(true);
    expect(report.cases).toHaveLength(7);
    expect(new Set(report.cases.map(c => c.policy_hash))).toEqual(new Set([hash(report.fixed_policy)]));
    expect(report.cases.map(c => c.event.authorization.billing_amount_chf)).toEqual([120, 20, 60, 15, 18, 45, 25]);
    expect(new Set(report.cases.map(c => c.event.request_id)).size).toBe(7);
    expect(new Set(report.cases.map(c => c.event.authorization.authorization_id)).size).toBe(7);
    expect(report.cases.every(c => c.event.mandate.instruction === PURCHASE_SCENARIO_POLICY)).toBe(true);
    expect(report.cases.some(c => /Alpine/i.test(c.event.authorization.merchant.merchant_name))).toBe(false);
    expect(report.fixed_policy.parameters).toMatchObject({ min_order_chf: null, max_order_chf: '100', rolling_budget: { days: 7, limit_chf: '250' } });
    for (const c of report.cases) {
      expect(c.passed, c.description).toBe(true);
      expect(c.assessment.results.map(r => r.filter_id).sort()).toEqual([...ACTIVE_FILTER_IDS].sort());
    }
  });

  it.each(buildPurchaseScenarioCases().map(c => [c.id, c] as const))('%s fires the intended checks on the actual purchase', (_id, testCase) => {
    const validator = new AuthorizationEventFactory(testCase.context.pack, resolve('data/schemas/authorization_event.schema.json'));
    expect(() => validator.validate(testCase.context.event)).not.toThrow();
    for (const prior of testCase.context.run.purchases) expect(() => validator.validate(prior.event)).not.toThrow();
    const result = assess(testCase.context);
    expect(result.decision).toBe(testCase.expected_decision);
    expect(result.technical_filter_ids).toEqual([]);
    for (const expected of testCase.expected_checks) expect(result.results.find(r => r.filter_id === expected.filter_id)).toMatchObject(expected);
  });

  it('evaluates CHF245 of engine-approved commitments plus the actual CHF18 candidate', () => {
    const testCase = buildPurchaseScenarioCases().find(c => c.id === 'rolling_budget')!;
    expect(testCase.context.run.purchases).toHaveLength(10);
    expect(testCase.context.run.purchases.every(p => p.assessments.at(-1)!.execution_state === 'approved')).toBe(true);
    expect(testCase.context.event.authorization.spend_in_period_before_chf).toBeNull();
    const result = assess(testCase.context);
    expect(result.results.find(r => r.filter_id === 'C09')!.outcome).toBe('pass');
    expect(result.results.find(r => r.filter_id === 'C10')).toMatchObject({ outcome: 'fail', evidence: [expect.objectContaining({ observed: [{ end: testCase.context.event.authorization.timestamp, spent: '263.00' }], expected: { days: 7, limit_chf: '250' } })] });
    testCase.context.run.commitments = [];
    expect(assess(testCase.context).results.find(r => r.filter_id === 'C10')!.outcome).toBe('pass');
  });

  it('checks a new request against a genuinely approved prior CHF25 purchase', () => {
    const ctx = buildPurchaseScenarioCases().find(c => c.id === 'duplicate')!.context;
    const prior = ctx.run.purchases[0]!;
    expect(prior.assessments.at(-1)!.execution_state).toBe('approved');
    expect(prior.event.authorization.billing_amount_chf).toBe(25);
    expect(ctx.event.authorization.billing_amount_chf).toBe(25);
    expect(prior.event.request_id).not.toBe(ctx.event.request_id);
    expect(prior.event.authorization.authorization_id).not.toBe(ctx.event.authorization.authorization_id);
    expect(assess(ctx).results.find(r => r.filter_id === 'C13')).toMatchObject({ outcome: 'needs_review', evidence: [expect.objectContaining({ observed: [prior.event.authorization.authorization_id] })] });
    ctx.run.purchases = [];
    expect(assess(ctx).results.find(r => r.filter_id === 'C13')!.outcome).toBe('pass');
  });

  it('preserves an explicit review limitation for the unfamiliar-merchant exception', () => {
    const report = runPurchaseScenarioRegressions();
    const shampoo = report.cases.find(c => c.id === 'unfamiliar_shampoo')!;
    expect(shampoo.event.authorization.items[0]!.item_category).toBe('personal_care');
    expect(shampoo.assessment.blocking_filter_ids).toEqual([]);
    expect(shampoo.assessment.results.find(r => r.filter_id === 'M01')!.outcome).toBe('pass');
    expect(shampoo.assessment.questions).toContainEqual(expect.objectContaining({ fact_key: 'M02', kind: 'amend_mandate' }));
    expect(report.limitations[0]).toContain('cannot be encoded');
  });

  it('makes CHF45 unusual using real price references and sufficient comparable observations', () => {
    const ctx = buildPurchaseScenarioCases().find(c => c.id === 'unusual_groceries')!.context;
    const result = assess(ctx);
    expect(result.results.find(r => r.filter_id === 'C09')!.outcome).toBe('pass');
    expect(result.results.find(r => r.filter_id === 'C20')).toMatchObject({ outcome: 'needs_review', evidence: [expect.objectContaining({ observed: { amount: '45.00', n: 20, median: '10.00', threshold: '30.00' } })] });
  });

  it('accepts custom transactions and retains approvals without creating another instruction', () => {
    const harness = createSyntheticPurchaseHarness();
    const input: SyntheticPurchaseInput = { id: 'custom-first', amount_chf: 25, timestamp: '2026-09-19T11:30:00Z',
      merchant: { id: 'SYNTHETIC_MIGROS', name: 'Migros', category: 'groceries', mcc: '5411' },
      item: { id: 'MY_GROCERY_BASKET', name: 'My grocery basket', category: 'groceries', minimum_price_chf: '10', typical_price_chf: '25', maximum_price_chf: '30' },
    };
    expect(harness.submit(input).assessment.execution_state).toBe('approved');
    const repeat = harness.submit({ ...input, id: 'custom-second', timestamp: '2026-09-19T11:50:00Z' });
    expect(repeat.assessment.decision).toBe('step_up');
    expect(repeat.assessment.doubt_filter_ids).toContain('C13');
    expect(harness.run.commitments).toHaveLength(1);
    expect(harness.run.purchases).toHaveLength(2);
    expect(harness.config.instruction).toBe(PURCHASE_SCENARIO_POLICY);
    expect(() => harness.submit(input)).toThrow('already been submitted');
  });
});
