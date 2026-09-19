import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstructionVariables } from '../packages/contracts/src/index.js';
import { hasSupportedMonetaryConstraint, loadInstructionFields, parseInstructionModelOutput } from '../packages/local-runtime/src/ai/instruction-schema.js';
import { createOpenAIInstructionDecoder } from '../packages/local-runtime/src/ai/openai-instruction-decoder.js';
import { findAmbiguousMonetaryAmounts, parseOrderAmountBounds } from '../packages/local-runtime/src/simulation/config.js';

const schema = resolve('data/schemas/authorization_event.schema.json');
const scenarios = [
  ['CHF 120 groceries from Migros.', 120],
  ['CHF 20 shampoo from an unfamiliar shop.', 20],
  ['CHF 60 headphones from Digitec.', 60],
  ['CHF 15 Netflix subscription.', 15],
  ['CHF 18 groceries with weekly spending of CHF 245.', 18],
  ['CHF 45 unusually expensive groceries.', 45],
  ['CHF 25 potentially duplicate groceries.', 25],
] as const;
const variable = (instruction: string, value: number, operator: '>=' | '<=' | '=' = '>='): InstructionVariables['variables'][number] => ({
  field: 'authorization.billing_amount_chf', status: 'present', value, operator, currency: 'CHF', scope: 'purchase', period_days: null, source_excerpt: instruction, note: null,
});

describe('purchase amounts need evidence of an intended constraint', () => {
  it.each(scenarios)('keeps %s unresolved for every invented comparator', async (instruction, value) => {
    const { fields } = await loadInstructionFields(schema);
    for (const operator of ['>=', '<=', '='] as const) {
      const raw = variable(instruction, value, operator);
      const decoded = parseInstructionModelOutput({ variables: [raw], unmapped_requirements: [] }, instruction, fields);
      expect(decoded.variables.find(v => v.field === raw.field)).toMatchObject({
        status: 'ambiguous', value: null, operator: null, source_excerpt: instruction,
        note: expect.stringContaining('maximum, minimum, exact amount, approximate target, or transaction description'),
      });
      // The legacy-compilation guard must also reject the original model output.
      expect(hasSupportedMonetaryConstraint(raw, instruction)).toBe(false);
    }
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([{
      source_excerpt: instruction, amount_chf: String(value), description: expect.stringContaining('transaction description'),
    }]);
  });

  it('repairs a provider response without retries or an external model call', async () => {
    const { fields } = await loadInstructionFields(schema);
    const instruction = scenarios[0][0];
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      id: 'resp_purchase_facts', model: 'gpt-5.4-mini', status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ variables: [variable(instruction, 120)], unmapped_requirements: [] }) }] }],
    }));
    const result = await createOpenAIInstructionDecoder({ OPENAI_API_KEY: 'test-secret' }, fetcher).decode(instruction, fields);
    expect((result.output as InstructionVariables).variables.find(v => v.field === 'authorization.billing_amount_chf')?.status).toBe('ambiguous');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).instructions;
    expect(prompt).toContain('A bare amount is NOT a spending constraint');
    expect(prompt).toContain('Already-spent or historical totals are context facts');
  });

  it.each([
    ['Buy approximately CHF 20 of groceries.', '20'],
    ['Acheter environ 20,50 CHF de courses.', '20.5'],
    ['Buy CHF 20 of groceries. Spend at most CHF 100 per purchase.', '20'],
  ])('keeps approximate or descriptive amounts distinct from other bounds: %s', (instruction, amount) => {
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([expect.objectContaining({ amount_chf: amount })]);
    expect(hasSupportedMonetaryConstraint(variable(instruction, Number(amount), '<='), instruction)).toBe(false);
  });

  it.each([
    'Never exceed CHF 100 per purchase or CHF 250 in any rolling seven-day period.',
    'Never exceed CHF 100 per purchase and CHF 250 in any rolling seven-day period.',
    'Never exceed CHF 100 per purchase. Keep the total across any seven days at or below CHF 250.',
  ])('keeps both explicit policy limits: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: '100', rolling_budget: { days: 7, limit_chf: '250' } });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    expect(hasSupportedMonetaryConstraint(variable(instruction, 100, '<='), instruction)).toBe(true);
    expect(hasSupportedMonetaryConstraint({ ...variable(instruction, 250, '<='), field: 'context.approved_spend_in_period_chf', scope: 'period', period_days: 7 }, instruction)).toBe(true);
  });

  it('does not flatten a merchant exception into a global ceiling, even with a shortened excerpt', async () => {
    const instruction = 'Never exceed CHF 100 per purchase or CHF 250 in any rolling seven-day period. Only use familiar merchants, except for legitimate unfamiliar merchants when the total is below CHF 30.';
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: '100', rolling_budget: { days: 7, limit_chf: '250' } });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    expect(hasSupportedMonetaryConstraint({ ...variable(instruction, 30, '<='), source_excerpt: 'below CHF 30' }, instruction)).toBe(false);
    const { fields } = await loadInstructionFields(schema);
    const decoded = parseInstructionModelOutput({ variables: [variable(instruction, 30, '<=')], unmapped_requirements: [] }, instruction, fields);
    expect(decoded.variables.find(v => v.field === 'authorization.billing_amount_chf')?.status).toBe('ambiguous');
  });

  it.each([
    'For unfamiliar merchants, keep the total below CHF 30.',
    'Keep the total below CHF 30, if the merchant is unfamiliar.',
    'If the merchant is unfamiliar, keep the total below CHF 30.',
  ])('preserves conditional scope across commas: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
  });

  it('does not inherit a purchase comparator across separate sentences', () => {
    const instruction = 'Never exceed CHF 100 per purchase. CHF 250 total across seven days.';
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: '100', rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([expect.objectContaining({ amount_chf: '250' })]);
  });

  it.each([
    'Already spent CHF 245.',
    'I have already spent CHF 245.',
    'Current spending is CHF 245.',
    'Weekly spending of CHF 245.',
  ])('does not turn historical context into a rule or a new amount question: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: null, max_order_chf: null, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    expect(hasSupportedMonetaryConstraint({ ...variable(instruction, 245, '<='), field: 'context.approved_spend_in_period_chf', scope: 'period', period_days: 7 }, instruction)).toBe(false);
  });

  it('does not borrow a comparator from another amount in the same source excerpt', async () => {
    const instruction = 'CHF 120 groceries from Migros. Spend at most CHF 100 per purchase.';
    const { fields } = await loadInstructionFields(schema);
    const decoded = parseInstructionModelOutput({ variables: [variable(instruction, 120, '<=')], unmapped_requirements: [] }, instruction, fields);
    expect(decoded.variables.find(v => v.field === 'authorization.billing_amount_chf')?.status).toBe('ambiguous');
    expect(parseOrderAmountBounds(instruction).max_order_chf).toBe('100');
  });
});
