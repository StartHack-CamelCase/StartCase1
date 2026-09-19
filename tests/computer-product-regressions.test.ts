import { describe, expect, it } from 'vitest';
import type { MandateRecord } from '../packages/contracts/src/policy.js';
import { suggestConfig } from '../packages/local-runtime/src/simulation/config.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { classifyProductKind, parseSupportedProductIntent } from '../packages/local-runtime/src/simulation/product-intent.js';
import { fixture } from './simulation-fixture.js';

const instruction = 'I want to buy a computer from a big shop that is on fast delivery and that costs less than 200 francs, and the minimum price has to be 50 francs.';
const mandate = (text: string) => ({ mandate_id: 'COMPUTER', version: 1, instruction: text, hard_rules: [], interpretation: { instruction_decoding: { unmapped_requirements: [] } } }) as unknown as MandateRecord;

describe('explicit computer product intent', () => {
 it.each([
  [instruction, 'computer'],
  ['Buy a laptop under CHF 200.', 'laptop'],
  ['I need a refurbished desktop computer.', 'desktop_computer'],
  ['Buy a computer with 16GB RAM.', 'computer'],
  ['Je veux acheter un ordinateur portable pour moins de 200 francs.', 'laptop'],
  ['Achète un ordinateur de bureau.', 'desktop_computer'],
  ['I want to buy a laptop that costs less than 200 francs.', 'laptop'],
  ['Buy a desktop PC.', 'desktop_computer'],
  ['Buy a portable computer.', 'laptop'],
  ['Je veux un ordinateur portable reconditionné.', 'laptop'],
  ['Achète-moi un PC portable.', 'laptop'],
  ['Je souhaite acheter un ordinateur portable reconditionné entre 50 et 200 francs suisses, livré sous 48 heures.', 'laptop'],
  ['Buy a laptop between CHF 50 and 200.', 'laptop'],
  ['Buy a laptop between 50 and 200 francs.', 'laptop'],
  ['Buy a desktop computer for CHF 50–200 including delivery. No accessories or subscriptions.', 'desktop_computer'],
  ['Je cherche un PC de bureau.', 'desktop_computer'],
  ['I would like a notebook under CHF 200.', 'laptop'],
  ["I'd like a laptop under CHF 200.", 'laptop'],
  ['Buy a computer without accessories.', 'computer'],
  ['Achète un ordinateur sans accessoires.', 'computer'],
 ])('retains the requested product: %s', (text, kind) => {
  expect(parseSupportedProductIntent(text)).toMatchObject({ productType: kind, itemCategory: 'electronics' });
 });

 it.each([
  "Don't buy a computer.",
  'I do not want to buy a computer.',
  'Buy groceries, not a computer.',
  'I already have a computer. Buy groceries.',
  'Buy a computer monitor.',
  'Buy a laptop charger.',
  'Buy a computer case.',
  'Buy a computer game.',
  'Buy a laptop docking station.',
  'Buy a computer repair service.',
  'Buy a computer memory module.',
  'Buy a laptop replacement display.',
  'Buy a computer gizmo.',
  'Buy a notebook sleeve.',
  'Buy a laptop with a sleeve.',
  'Buy a computer with a keyboard.',
  'Buy a laptop, a sleeve.',
  'Buy a computer for CHF 50.50 and groceries.',
  'Buy a computer and 2 bags.',
  'Je ne veux pas acheter un ordinateur.',
  'Je ne souhaite plus acheter un ordinateur.',
  "Je veux éviter d'acheter un ordinateur.",
  'I refuse to buy a computer.',
  'Achetez-moi un PC portable et une housse.',
  'Buy a case for a computer.',
  'Buy a computer and a monitor.',
  'Buy a computer or a laptop.',
  'Buy a computer and groceries.',
  'Buy a computer and milk.',
  'Buy groceries and a computer.',
  'Buy a computer. Buy groceries.',
  'Buy groceries. Buy a computer.',
  'If I need to buy a computer, ask first.',
 ])('does not invent a single computer-only request: %s', text => {
  expect(parseSupportedProductIntent(text)).toBeNull();
 });

 it('maps the exact reported instruction into enforceable product constraints', () => {
  const config = suggestConfig(mandate(instruction), '2026-09-19T00:00:00Z');
  expect(config.parameters).toMatchObject({ product_type: 'computer', allowed_item_categories: ['electronics'] });
  expect(config.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ filter_ids: expect.arrayContaining(['M09', 'M10']), source_excerpt: 'buy a computer' })]));
 });

 it('keeps a trailing condition separate from the product identity evidence', () => {
  expect(parseSupportedProductIntent('Je veux un ordinateur portable reconditionné.')).toMatchObject({ productType: 'laptop', sourceExcerpt: 'veux un ordinateur portable' });
 });
});

function computerOffer(catalogueName: string, offerName = catalogueName) {
 const ctx = fixture('AU0035');
 const item = ctx.event.authorization.items[0]!;
 ctx.event.authorization.items = [item];
 Object.assign(item, { quantity: 1, unit_price: 100, currency: 'CHF', item_name: offerName, item_details: 'One-off purchase. No subscription. Returns allowed for 30 days.' });
 Object.assign(ctx.event.authorization, { amount: 100, billing_amount_chf: 100, items_subtotal: 100, delivery_fee: 0 });
 const catalogue = ctx.pack.itemsById.get(item.item_id as never)!;
 Object.assign(catalogue, { item_name: catalogueName, item_description: catalogueName, unit_price_min_chf: '50.00', unit_price_max_chf: '200.00' });
 ctx.config.parameters.product_type = 'computer';
 ctx.config.parameters.allowed_item_categories = ['electronics'];
 ctx.config.parameters.min_order_chf = '50';
 ctx.config.parameters.max_order_chf = '199.99';
 return ctx;
}

describe('computer mandate product enforcement', () => {
 it.each([20, 100])('declines groceries even when a purchase meets a generic review requirement (CHF %s)', amount => {
  const ctx = fixture('AU0001');
  ctx.config.parameters = { ...ctx.config.parameters, ...suggestConfig(mandate(instruction), ctx.now).parameters };
  ctx.config.parameters.manual_review_requirements = [{ source_excerpt: 'big shop', description: 'The merchant must be a big shop.' }];
  const item = ctx.event.authorization.items[0]!;
  ctx.event.authorization.items = [item];
  Object.assign(item, { quantity: 1, unit_price: amount });
  Object.assign(ctx.event.authorization, { amount, billing_amount_chf: amount, items_subtotal: amount, delivery_fee: 0 });
  const result = assess(ctx);
  expect(result.results.find(r => r.filter_id === 'M09')?.outcome).toBe('fail');
  expect(result.execution_state).toBe('declined');
  expect(result.can_finalize).toBe(false);
 });

 it.each(['27-inch monitor', 'Laptop charger', 'Computer keyboard', 'Tablet', 'Laptop docking station', 'Computer repair service', 'Computer memory module', 'Laptop replacement display'])('rejects known incompatible electronics at an otherwise valid price: %s', name => {
  const ctx = computerOffer(name);
  const result = assess(ctx);
  expect(result.results.find(r => r.filter_id === 'M09')?.outcome).toBe('pass');
  expect(result.results.find(r => r.filter_id === 'M10')?.outcome).toBe('fail');
  expect(result.execution_state).toBe('declined');
 });

 it.each(['Computer', 'Refurbished laptop', 'Desktop computer', 'Ordinateur portable', 'Computer with 16GB RAM', 'Ordinateur portable reconditionné', 'PC portable', 'Desktop PC', 'Computer without accessories', 'Ordinateur sans accessoires'])('recognizes a known compatible computer at CHF 100: %s', name => {
  const ctx = computerOffer(name);
  const result = assess(ctx);
  expect(result.results.find(r => r.filter_id === 'M10')?.outcome).toBe('pass');
  expect(result.can_finalize).toBe(true);
  expect(result.blocking_filter_ids).toEqual([]);
  expect(result.doubt_filter_ids).toEqual([]);
 });

 it('retains review when the catalogue cannot establish the requested product', () => {
  const ctx = computerOffer('Electronic device', 'Computer');
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
  const itemsById = new Map(ctx.pack.itemsById);
  itemsById.delete(ctx.event.authorization.items[0]!.item_id as never);
  ctx.pack = { ...ctx.pack, itemsById };
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
 });

 it('does not turn conflicting catalogue and offer identities into approval', () => {
  const ctx = computerOffer('Laptop', 'Computer monitor');
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
 });

 it.each(['Not a computer', 'Not a laptop', "This isn't a computer", "Ce n'est pas un ordinateur"])('keeps a negated product identity unresolved even when catalogue reference says laptop: %s', name => {
  const ctx = computerOffer('Laptop', name);
  const result = assess(ctx);
  expect(result.results.find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
  expect(result.can_finalize).toBe(false);
  ctx.pack.itemsById.get(ctx.event.authorization.items[0]!.item_id as never)!.item_name = name;
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
 });

 it.each(['Computer gizmo', 'Laptop 16GB RAM 512GB SSD'])('keeps unsupported name details unresolved instead of guessing a component: %s', name => {
  const ctx = computerOffer(name);
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
 });

 it('requires evidence for a laptop subtype when the catalogue only says computer', () => {
  const ctx = computerOffer('Computer', 'Laptop');
  ctx.config.parameters.product_type = 'laptop';
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('needs_review');
 });

 it('rejects a desktop against an explicit laptop requirement', () => {
  const ctx = computerOffer('Desktop computer');
  ctx.config.parameters.product_type = 'laptop';
  expect(evaluateMerchant(ctx).find(r => r.filter_id === 'M10')?.outcome).toBe('fail');
 });

 it.each([
  ['Computer monitor', 'monitor'], ['Laptop charger', 'computer_accessory'],
  ['Case for a computer', 'computer_accessory'], ['Laptop with a screen', 'laptop'],
  ['Laptop docking station', 'computer_accessory'], ['Computer repair service', 'computer_accessory'],
  ['Computer memory module', 'computer_accessory'], ['Laptop replacement display', 'computer_accessory'],
  ['Computer with 16GB RAM', 'computer'], ['Computer gizmo', null],
  ['Ordinateur portable reconditionné', 'laptop'], ['PC portable', 'laptop'],
  ['PC de bureau', 'desktop_computer'], ['Portable computer', 'laptop'],
  ['Computer without accessories', 'computer'], ['Ordinateur sans accessoires', 'computer'],
  ['Not a computer', null], ['Not a laptop', null], ["Ce n'est pas un ordinateur", null],
  ['Notebook sleeve', 'computer_accessory'],
  ['Laptop 16GB RAM', null], ['Laptop 16GB RAM 512GB SSD', null],
  ['Road-running shoes', 'road'], ['Trail-running shoes', 'trail'], ['27-inch monitor', 'monitor'],
 ])('keeps catalogue type recognition specific: %s', (name, kind) => {
  expect(classifyProductKind(name)).toBe(kind);
 });
});
