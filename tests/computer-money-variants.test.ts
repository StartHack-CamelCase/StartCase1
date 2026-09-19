import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAmbiguousMonetaryAmounts, findExplicitMonetaryConstraints, parseOrderAmountBounds } from '../packages/local-runtime/src/simulation/config.js';
import { hasSupportedMonetaryConstraint, loadInstructionFields, parseInstructionModelOutput } from '../packages/local-runtime/src/ai/instruction-schema.js';
import type { InstructionVariables } from '../packages/contracts/src/index.js';

const money = (instruction: string, value: number, operator: '<' | '<=' | '=' | '>' | '>=' = '<='): InstructionVariables['variables'][number] => ({ field: 'authorization.billing_amount_chf', status: 'present', value, operator, currency: 'CHF', scope: 'purchase', period_days: null, source_excerpt: instruction, note: null });
const noBounds = { min_order_chf: null, max_order_chf: null, rolling_budget: null };

describe('computer request monetary variations', () => {
  it.each([
    ['Buy a laptop between 50 and 200 francs.', '50', '200'],
    ['Buy a computer for 50–200 CHF.', '50', '200'],
    ['Buy a laptop for CHF 50 to CHF 200.', '50', '200'],
    ['Acheter un ordinateur de 50 à 200 francs.', '50', '200'],
    ['Buy a computer strictly between 50 and 200 Swiss francs.', '50.01', '199.99'],
    ['Buy a laptop for CHF 50 to CHF 200, exclusive.', '50.01', '199.99'],
    ['Buy a laptop between 50 and 200 francs, excluding the endpoints.', '50.01', '199.99'],
    ['Un ordinateur entre 50 et 200 francs, bornes exclues.', '50.01', '199.99'],
    ['Acheter un ordinateur strictement entre 50,25 et 200,75 francs.', '50.26', '200.74'],
    ['Buy a laptop for more than 50 but less than 200 francs.', '50.01', '199.99'],
    ['Buy a laptop above 50 and below 200 CHF.', '50.01', '199.99'],
    ['Buy a laptop above 50 and below CHF 200.', '50.01', '199.99'],
    ['Buy a laptop at least 50 and at most 200 francs.', '50', '200'],
    ['Buy a laptop less than 200 but more than 50 Swiss francs.', '50.01', '199.99'],
    ['Acheter un ordinateur pour plus de 50 mais moins de 200 francs.', '50.01', '199.99'],
    ['Acheter un ordinateur pour au moins 50 et au plus 200 francs.', '50', '200'],
    ['Buy a laptop for 50 CHF and above.', '50', null],
    ['Buy a laptop for 200 CHF and below.', null, '200'],
    ['Acheter un ordinateur pour 200 francs et moins.', null, '200'],
    ['Do not spend less than 50 francs on a computer.', '50', null],
    ['A computer must not cost more than 200 francs.', null, '200'],
    ['The laptop price must never be below 50 francs.', '50', null],
    ['The computer price cannot go over 200 francs.', null, '200'],
    ['Un ordinateur ne doit pas coûter plus de 200 francs.', null, '200'],
    ['Acheter un ordinateur pour pas moins de 50 francs.', '50', null],
    ['Ne jamais dépenser moins de 50 francs pour un ordinateur.', '50', null],
    ['A laptop above 50 francs and below 200 francs.', '50.01', '199.99'],
    ['Un ordinateur à 50 francs minimum et 200 francs maximum.', '50', '200'],
  ] as const)('preserves the intended bounds: %s', (instruction, minimum, maximum) => {
    expect(parseOrderAmountBounds(instruction)).toEqual({ min_order_chf: minimum, max_order_chf: maximum, rolling_budget: null });
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
    for (const evidence of findExplicitMonetaryConstraints(instruction)) {
      expect(instruction).toContain(evidence.source_excerpt);
      expect(hasSupportedMonetaryConstraint(money(instruction, Number(evidence.value), evidence.operator), instruction)).toBe(true);
    }
  });

  it.each([
    'Buy a laptop for between CHF 50 and 200 EUR.',
    'Buy a computer for CHF 50–200 USD.',
    'Buy a computer for CHF 50 to 200 euros.',
    'Buy a laptop between 50 euros and 200 CHF.',
    'Buy a laptop for approximately 50–200 francs.',
    'Buy a laptop for roughly between 50 and 200 francs.',
    'Buy a laptop between 50 and 200 francs, approximately.',
    'Buy a computer for no more than about 200 francs.',
    'Buy a computer for at least approximately 50 francs.',
    'Buy a computer for approximately under 200 francs.',
    'Buy a laptop for roughly 200 francs or less.',
    'Buy a computer for 200 francs, approximately.',
    'Do not spend between 50 and 200 francs on a laptop.',
    'A laptop must not cost exactly 200 francs.',
  ])('keeps approximate, excluded, and mixed-currency ranges unresolved: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual(noBounds);
    expect(findAmbiguousMonetaryAmounts(instruction).length).toBeGreaterThan(0);
    expect(findExplicitMonetaryConstraints(instruction)).toEqual([]);
  });

  it('accepts the corrected negated comparison and rejects its inverted model output', async () => {
    const instruction = 'A computer must not cost more than 200 francs.';
    const { fields } = await loadInstructionFields(resolve('data/schemas/authorization_event.schema.json'));
    const result = parseInstructionModelOutput({ variables: [money(instruction, 200, '<=')], unmapped_requirements: [] }, instruction, fields);
    expect(result.variables.find(variable => variable.field === 'authorization.billing_amount_chf')).toEqual(money(instruction, 200, '<='));
    expect(() => parseInstructionModelOutput({ variables: [money(instruction, 200, '>')], unmapped_requirements: [] }, instruction, fields)).toThrow('does not match');
  });

  it('keeps source-wide conditional scope when the two bounds share their currency', () => {
    const instruction = 'For unfamiliar merchants, buy a laptop above 50 and below 200 CHF.';
    expect(parseOrderAmountBounds(instruction)).toEqual(noBounds);
    expect(findExplicitMonetaryConstraints(instruction)).toEqual([]);
  });

  it('preserves independent CHF constraints while leaving an explicitly foreign currency bound alone', () => {
    expect(parseOrderAmountBounds('Buy a laptop for at least CHF 50 and at most 200 EUR.')).toEqual({ ...noBounds, min_order_chf: '50' });
    expect(parseOrderAmountBounds('Buy a laptop for at least 50 EUR and at most CHF 200.')).toEqual({ ...noBounds, max_order_chf: '200' });
  });

  it.each([
    'Previously spent between 50 and 200 francs on a laptop.',
    'Current spending is CHF 50 to CHF 200.',
    'I have already spent more than 50 francs on a computer.',
    'I have already spent above 50 and below 200 CHF on a laptop.',
  ])('does not reinterpret a historical range or comparison as current permission: %s', instruction => {
    expect(parseOrderAmountBounds(instruction)).toEqual(noBounds);
    expect(findExplicitMonetaryConstraints(instruction)).toEqual([]);
    expect(findAmbiguousMonetaryAmounts(instruction)).toEqual([]);
  });
});
