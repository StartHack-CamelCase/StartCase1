import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstructionVariables, MandateRecord } from '../packages/contracts/src/index.js';
import { loadInstructionFields, parseInstructionModelOutput } from '../packages/local-runtime/src/ai/instruction-schema.js';
import { findAmbiguousMonetaryAmounts, findExplicitMonetaryConstraints, findMentionedMonetaryAmounts, parseOrderAmountBounds, suggestConfig } from '../packages/local-runtime/src/simulation/config.js';

const instruction = 'Buy a computer of this spec : 1 × 27-inch computer monitor 27-inch IPS panel, 2-year seller warranty; returns accepted within 14 days, and the price is less to 300';
const money = (text: string, value: number, operator: '<' | '<=' | '>=' = '<'): InstructionVariables['variables'][number] => ({ field: 'authorization.billing_amount_chf', status: 'present', value, operator, currency: 'CHF', scope: 'purchase', period_days: null, source_excerpt: text, note: null });

describe('explicit prices use the CHF wallet billing convention', () => {
  it('retains the reported monitor price while keeping specification numbers out of monetary evidence', async () => {
    const bounds = { min_order_chf: null, max_order_chf: '299.99', rolling_budget: null };
    expect(parseOrderAmountBounds(instruction)).toEqual(bounds);
    expect(findMentionedMonetaryAmounts(instruction)).toEqual(['300']);
    expect(findExplicitMonetaryConstraints(instruction)).toEqual([{ source_excerpt: 'and the price is less to 300', value: '300', operator: '<', scope: 'purchase', period_days: null }]);
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    const config = suggestConfig({ instruction, hard_rules: [], interpretation: {}, mandate_id: 'MONITOR', version: 1 } as unknown as MandateRecord, '2026-09-19T00:00:00Z');
    expect(config.parameters).toMatchObject({ ...bounds, allowed_currencies: null, product_type: 'monitor', attributes: [{ name: 'inches', values: ['27'], unit: 'inch' }], min_return_days: 14 });
    const { fields } = await loadInstructionFields(resolve('data/schemas/authorization_event.schema.json'));
    const output = parseInstructionModelOutput({ variables: [money(instruction, 300)], unmapped_requirements: [] }, instruction, fields);
    expect(output.variables.find(variable => variable.field === 'authorization.billing_amount_chf')).toEqual(money(instruction, 300));
    expect(output.variables.find(variable => variable.field === 'authorization.currency')?.status).toBe('absent');
    for (const value of [1, 27, 2, 14]) expect(() => parseInstructionModelOutput({ variables: [money(instruction, value)], unmapped_requirements: [] }, instruction, fields)).toThrow('does not match');
    expect(() => parseInstructionModelOutput({ variables: [money(instruction, 300, '<=')], unmapped_requirements: [] }, instruction, fields)).toThrow('does not match');
  });

  it.each([
    ['The price is less than 300.', null, '299.99'],
    ['The price is less to 300.', null, '299.99'],
    ['The price is less to CHF 300.', null, '299.99'],
    ['The cost must be at least 50.', '50', null],
    ['The budget is at most 300.', null, '300'],
    ['Le prix doit être moins de 300.', null, '299.99'],
    ['Le coût est au moins 50.', '50', null],
    ['The price is less to 300.50.', null, '300.49'],
  ] as const)('recognizes a monetary context and explicit comparator: %s', (text, min, max) => {
    expect(parseOrderAmountBounds(text)).toEqual({ min_order_chf: min, max_order_chf: max, rolling_budget: null });
  });

  it.each([
    'Buy a 27-inch monitor with a 2-year warranty and returns within 14 days.',
    'The price is below 27 inches.',
    'The cost is less to 14 days.',
    'The budget is below 300 GB.',
    'The price is below 300%.',
    'The prior price is below 300.',
    'The price was below 300.',
    'If delivery is available, the price is below 300.',
    'The price is below 300 when the shop is unfamiliar.',
    'The price is less to 300 EUR.',
    'The budget is below 300 dollars.',
    'The price is below 300 SEK.',
    'Pay in INR. The price is below 300.',
    'The cost is below 300 rupees.',
    'Pay in GBP. The price is below 300.',
  ])('does not invent CHF constraints for measurements, history, conditional rules or foreign currencies: %s', text => {
    expect(parseOrderAmountBounds(text)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
  });

  it.each(['The price is 300.', 'The cost is 300.', 'The budget is 300.', '300', 'Buy a monitor for 300.'])('still rejects invented comparators for a bare amount: %s', async text => {
    expect(parseOrderAmountBounds(text)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    const { fields } = await loadInstructionFields(resolve('data/schemas/authorization_event.schema.json'));
    const output = parseInstructionModelOutput({ variables: [money(text, 300, '<=')], unmapped_requirements: [] }, text, fields);
    expect(output.variables.find(variable => variable.field === 'authorization.billing_amount_chf')).toMatchObject({ status: 'ambiguous', value: null, operator: null });
  });
});
