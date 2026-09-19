import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstructionVariables, MandateRecord } from '../packages/contracts/src/index.js';
import { hasSupportedMonetaryConstraint, loadInstructionFields, parseInstructionModelOutput } from '../packages/local-runtime/src/ai/instruction-schema.js';
import { createOpenAIInstructionDecoder } from '../packages/local-runtime/src/ai/openai-instruction-decoder.js';
import { findAmbiguousMonetaryAmounts, findExplicitMonetaryConstraints, parseOrderAmountBounds, suggestConfig } from '../packages/local-runtime/src/simulation/config.js';
import { evaluateCustomer } from '../packages/local-runtime/src/simulation/customer.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { fixture } from './simulation-fixture.js';

const computerRequest = 'I want to buy a computer from a big shop that is on fast delivery and that costs less than 200 francs, and the minimum price has to be 50 francs. ';
const schema = resolve('data/schemas/authorization_event.schema.json');
const variable = (instruction: string, value: number, operator: '<' | '<=' | '=' | '>' | '>=' = '<'): InstructionVariables['variables'][number] => ({
  field: 'authorization.billing_amount_chf', status: 'present', value, operator, currency: 'CHF', scope: 'purchase', period_days: null, source_excerpt: instruction, note: null,
});

describe('Swiss monetary language in source constraints and model evidence', () => {
  it.each([
    [computerRequest, '50', '199.99'],
    ['Buy a computer costing less than 200 Swiss francs, with a minimum price of 50 Swiss francs.', '50', '199.99'],
    ['Acheter un ordinateur à moins de 200 francs suisses ; le prix minimum doit être 50 francs suisses.', '50', '199.99'],
    ['The minimum price must be Fr. 50 and the maximum price has to be Fr. 200.', '50', '200'],
    ['The price cannot exceed 200 frs and the minimum cost is 50 frs.', '50', '200'],
    ['Le prix ne doit pas dépasser 200 francs et le prix minimum est 50 francs.', '50', '200'],
    ['The price must be greater than or equal to 50 francs and less than or equal to 200 francs.', '50', '200'],
    ['Pay between 50 francs and 200 francs.', '50', '200'],
    ['Pay between Swiss francs 50 and Swiss francs 200.', '50', '200'],
    ['Payer entre 50,50 et 199,50 francs suisses.', '50.5', '199.5'],
    ['Pay Fr. 50–200.', '50', '200'],
    ['Pay exactly 50,25 francs.', '50.25', '50.25'],
    ['Pay above 50 francs but below 200 francs.', '50.01', '199.99'],
    ["Pay under 1'200 Swiss francs.", null, '1199.99'],
    ['Pay less than 1’200,50 francs suisses.', null, '1200.49'],
  ] as const)('extracts precise bounds without dropping the currency or comparator: %s', (instruction, min, max) => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: min, max_order_chf: max, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    const constraints = findExplicitMonetaryConstraints(instruction);
    expect(constraints.length).toBeGreaterThan(0);
    for (const constraint of constraints) expect(instruction).toContain(constraint.source_excerpt);
  });

  it('keeps the exact request enforceable even if the model omits its monetary variables', () => {
    const parameters = suggestConfig({ mandate_id: 'computer', version: 1, instruction: computerRequest, interpretation: {}, hard_rules: [] } as unknown as MandateRecord, '2026-09-19T00:00:00Z').parameters;
    expect(parameters).toMatchObject({ min_order_chf: '50', max_order_chf: '199.99', allowed_currencies: null });
    for (const [amount, outcome] of [[20, 'fail'], [49.99, 'fail'], [50, 'pass'], [199.99, 'pass'], [200, 'fail']] as const) {
      const ctx = fixture('AU0001');
      ctx.config.parameters = { ...parameters, domestic_country: 'CH' };
      Object.assign(ctx.event.authorization, { amount, billing_amount_chf: amount, delivery_fee: Number((amount - 13).toFixed(2)) });
      expect(evaluateCustomer(ctx, evaluateMerchant(ctx)).find(result => result.filter_id === 'C09')?.outcome, `CHF ${amount}`).toBe(outcome);
    }
  });

  it('preserves an ideal model response for the exact request through provider-response validation', async () => {
    const { fields } = await loadInstructionFields(schema);
    const upper = variable(computerRequest, 200, '<');
    const lower = { source_excerpt: computerRequest, description: 'Purchase amount >= CHF 50', reason: 'no_native_field' as const };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      id: 'resp_computer_francs', model: 'test-model', status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ variables: [upper], unmapped_requirements: [lower] }) }] }],
    }));
    const result = await createOpenAIInstructionDecoder({ OPENAI_API_KEY: 'test-secret' }, fetcher).decode(computerRequest, fields);
    const parsed = result.output as InstructionVariables;
    expect(parsed.variables.find(v => v.field === upper.field)).toEqual(upper);
    expect(parsed.unmapped_requirements).toContainEqual(lower);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hasSupportedMonetaryConstraint(variable(computerRequest, 50, '>='), computerRequest)).toBe(true);
    expect(hasSupportedMonetaryConstraint(variable(computerRequest, 199.99, '<='), computerRequest)).toBe(true);
    expect(() => parseInstructionModelOutput({ variables: [variable(computerRequest, 200, '<=')], unmapped_requirements: [] }, computerRequest, fields)).toThrow('does not match');
  });

  it.each([false, true])('repairs duplicated lower/upper canonical amount fields without dropping other constraints (lower first: %s)', async lowerFirst => {
    const { fields } = await loadInstructionFields(schema);
    const upper = variable(computerRequest, 200, '<'), lower = variable(computerRequest, 50, '>=');
    const comparisons = lowerFirst ? [lower, upper] : [upper, lower];
    const product = { ...upper, field: 'authorization.items[].item_name', value: 'computer', operator: '=' as const, currency: null };
    const manual = { source_excerpt: computerRequest, description: 'Merchant must be a big shop.', reason: 'no_native_field' as const };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      id: 'resp_duplicate_range', model: 'test-model', status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ variables: [...comparisons, product], unmapped_requirements: [manual] }) }] }],
    }));
    const parsed = (await createOpenAIInstructionDecoder({ OPENAI_API_KEY: 'test-secret' }, fetcher).decode(computerRequest, fields)).output as InstructionVariables;
    expect(parsed.variables.find(v => v.field === upper.field)).toEqual(comparisons[0]);
    expect(parsed.variables.find(v => v.field === product.field)).toEqual(product);
    expect(parsed.unmapped_requirements).toEqual([manual, {
      source_excerpt: computerRequest, description: lowerFirst ? 'Purchase amount < CHF 200' : 'Purchase amount >= CHF 50', reason: 'no_native_field',
    }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects contradictory, invented and unrelated duplicate comparisons', async () => {
    const { fields } = await loadInstructionFields(schema);
    const contradictory = 'Pay at least 200 francs and less than 50 francs.';
    expect(() => parseInstructionModelOutput({ variables: [variable(contradictory, 200, '>='), variable(contradictory, 50, '<')], unmapped_requirements: [] }, contradictory, fields)).toThrow('contradictory range');
    for (const extra of [variable(computerRequest, 50, '<='), variable(computerRequest, 300, '<'), { ...variable(computerRequest, 50, '>='), currency: 'EUR' }]) {
      expect(() => parseInstructionModelOutput({ variables: [variable(computerRequest, 200, '<'), extra], unmapped_requirements: [] }, computerRequest, fields)).toThrow('appears more than once');
    }
    const product = { ...variable(computerRequest, 200, '<'), field: 'authorization.items[].item_name', value: 'computer', currency: null, operator: '=' };
    expect(() => parseInstructionModelOutput({ variables: [product, { ...product, value: 'groceries' }], unmapped_requirements: [] }, computerRequest, fields)).toThrow('appears more than once');
  });

  it.each([
    ['Never exceed 100 francs per purchase or 250 francs in any rolling seven-day period.', '100', '250'],
    ['Spend less than Swiss francs 100 per purchase and Swiss francs 250 in any rolling seven-day period.', '99.99', '249.99'],
    ['Ne jamais dépasser 100 francs suisses par achat ou francs suisses 250 sur sept jours.', '100', '250'],
  ])('preserves shared ceilings and rolling scope: %s', (instruction, max, limit) => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: max, rolling_budget: { days: 7, limit_chf: limit } });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
  });

  it.each([
    ['Buy a computer for 200 francs.', '200'],
    ['Buy approximately 200 Swiss francs of groceries.', '200'],
    ['Acheter environ 50,50 francs suisses de courses.', '50.5'],
    ['CHF 100 groceries; buy a laptop for 200 francs.', '100'],
  ])('does not invent a bound from a bare or approximate amount: %s', (instruction, amount) => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toContainEqual(expect.objectContaining({ amount_chf: amount }));
    expect(hasSupportedMonetaryConstraint(variable(instruction, Number(amount), '<='), instruction)).toBe(false);
  });

  it('does not borrow a supported CHF comparator for a bare francs amount during model validation', async () => {
    const instruction = 'Buy a computer for 200 francs. Spend at most CHF 300 per purchase.';
    const { fields } = await loadInstructionFields(schema);
    const result = parseInstructionModelOutput({ variables: [variable(instruction, 200, '<=')], unmapped_requirements: [] }, instruction, fields);
    expect(result.variables.find(v => v.field === 'authorization.billing_amount_chf')).toMatchObject({ status: 'ambiguous', value: null, operator: null });
    expect(parseOrderAmountBounds(instruction).max_order_chf).toBe('300');
  });

  it.each([
    'For unfamiliar merchants, keep the total below 30 francs.',
    'Keep the total below 30 francs suisses, if the merchant is unfamiliar.',
    'If the merchant is unfamiliar, keep the total below Fr. 30.',
    'Already spent 245 Swiss francs.',
    'Weekly spending of 245 francs.',
    'Current spending is frs 245.',
  ])('does not promote conditional thresholds or historical context to global constraints: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
  });

  it.each([
    'Pay less than 200 francs CFA.',
    'Pay less than 200 francs CFP.',
    'Pay less than 200 francs (CFA).',
    'Pay less than 200 Congolese francs.',
    'Pay less than 200 francs congolais.',
    'Pay less than 200 French francs.',
    'Use Congolese francs. The maximum price must be 200 francs.',
    'The purchase currency is XOF. Spend less than 200 francs.',
    'Payer en francs CFA et dépenser moins de 200 frs.',
  ])('does not convert an explicitly foreign franc currency to CHF: %s', async instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findExplicitMonetaryConstraints(instruction)).toEqual([]);
    expect(hasSupportedMonetaryConstraint(variable(instruction, 200, '<'), instruction)).toBe(false);
    const { fields } = await loadInstructionFields(schema);
    const decoded = parseInstructionModelOutput({ variables: [variable(instruction, 200, '<')], unmapped_requirements: [] }, instruction, fields);
    expect(decoded.variables.find(v => v.field === 'authorization.billing_amount_chf')?.status).toBe('ambiguous');
  });

  it.each(['CHF 200', '200 Swiss francs', '200 francs suisses'])('retains explicit %s limits when another franc currency is also named', amount => {
    const instruction = `The shop prices products in francs CFA. My billing limit is less than ${amount}.`;
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: '199.99', rolling_budget: null });
    expect(hasSupportedMonetaryConstraint(variable(instruction, 200, '<'), instruction)).toBe(true);
  });

  it.each([
    'There is no minimum price of 50 francs.',
    'Buy without a minimum price of 50 francs.',
    'There is no maximum price of 50 francs.',
    'Il ne faut pas de prix minimum de 50 francs.',
  ])('does not enforce a negated named bound: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([expect.objectContaining({ amount_chf: '50', description: expect.stringContaining('negated') })]);
    expect(hasSupportedMonetaryConstraint(variable(instruction, 50, '>='), instruction)).toBe(false);
  });
});
