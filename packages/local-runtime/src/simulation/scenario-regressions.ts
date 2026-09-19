import { Decimal } from 'decimal.js';
import type { Account, Card, CatalogueItem, Customer, DataPack, FixtureAuthority, HistoricalAuthorization, Merchant } from '../../../contracts/src/data.js';
import type { AuthorizationEvent, MandateSnapshot } from '../../../contracts/src/event.js';
import { asId } from '../../../contracts/src/ids.js';
import type { Assessment, FilterId, Requirement, SafetyConfig, SimRun } from '../../../contracts/src/simulation.js';
import { defaultParameters, validateParameters } from './config.js';
import { hash, offerHash, type EvaluationContext } from './common.js';
import { assess, stampCommitted } from './evaluator.js';

/** A transaction harness: one reviewed policy, authored events, no instruction decoder or API. */
export const PURCHASE_SCENARIO_POLICY = 'You may purchase groceries, household essentials and personal care products. Never exceed CHF 100 per purchase or CHF 250 in any rolling seven-day period. Only use familiar merchants, except for legitimate unfamiliar merchants when the total is below CHF 30. Never buy subscriptions, alcohol, gift cards, cryptocurrency or gambling products. Ask me about unusually expensive products or uncertain purchases. Do not approve duplicate orders without checking with me.';

export const PURCHASE_SCENARIO_LIMITATIONS = [
  'The unfamiliar-merchant exception cannot be encoded by the current familiar_merchant boolean. An unfamiliar merchant is sent to explicit review even below CHF 30; a matching synthetic merchant reference establishes identity, not independent proof of legitimacy.',
  'Duplicate detection is exercised within the configured 24-hour test horizon. The policy does not specify a horizon, so these tests do not establish protection against older duplicates.',
  'Unusual spending is tested with 20 comparable historical grocery payments of CHF 10 and a catalogue reference range. These are authored test facts, not real customer or merchant data.',
] as const;

const NOW = '2026-09-19T12:00:00.000Z';
const source = { file: 'synthetic:seven-purchase-scenarios', row: 1 };
const customer: Customer = { customer_id: asId('SYNTHETIC_CUSTOMER'), persona_name: 'Synthetic scenario owner', home_region: 'CH', background: 'Authored test identity', shopping_preferences: '', typical_spending: 'CHF 10 groceries', budget_style: '', travel_pattern: '', source };
const account: Account = { account_id: asId('SYNTHETIC_ACCOUNT'), customer_id: customer.customer_id, account_type: 'debit', account_purpose: 'personal', base_currency: 'CHF', status: 'active', opened_on: '2020-01-01', per_transaction_limit_chf: '1000', monthly_limit_chf: '5000', source };
const card: Card = { card_id: asId('SYNTHETIC_CARD'), account_id: account.account_id, card_type: 'debit', card_purpose: 'personal', status: 'active', first_used_on: '2020-01-01', expires_on: '2030-01-01', online_enabled: true, international_enabled: true, virtual_card: false, source };
const authority: FixtureAuthority = { authority_id: asId('SYNTHETIC_AUTHORITY'), customer_id: customer.customer_id, card_id: card.card_id, valid_from: '2026-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z', initial_status: 'active', source };
function merchant(id: string, name: string, category: string, mcc: string): Merchant {
  return { merchant_id: asId(id), merchant_name: name, merchant_category: category, merchant_mcc: mcc, merchant_country: 'CH', merchant_city: 'Zurich', availability: 'store_and_online', recurring_capable: category === 'subscriptions' ? 'true' : 'false', source };
}
const merchants = {
  migros: merchant('SYNTHETIC_MIGROS', 'Migros', 'groceries', '5411'),
  unfamiliar: merchant('SYNTHETIC_CARE_SHOP', 'New Care Shop', 'personal_care', '5977'),
  digitec: merchant('SYNTHETIC_DIGITEC', 'Digitec', 'electronics', '5732'),
  netflix: merchant('SYNTHETIC_NETFLIX', 'Netflix', 'subscriptions', '4899'),
};
function item(id: string, name: string, category: string, maximum = '150'): CatalogueItem {
  return { item_id: asId(id), item_name: name, item_category: category, item_description: name, unit_price_min_chf: '1', unit_price_typical_chf: '10', unit_price_max_chf: maximum, source };
}
const items = {
  groceries: item('SYNTHETIC_GROCERIES', 'Grocery basket', 'groceries'),
  shampoo: item('SYNTHETIC_SHAMPOO', 'Shampoo', 'personal_care', '30'),
  headphones: item('SYNTHETIC_HEADPHONES', 'Headphones', 'electronics', '100'),
  subscription: item('SYNTHETIC_SUBSCRIPTION', 'Netflix monthly subscription', 'subscriptions', '25'),
  expensive: item('SYNTHETIC_EXPENSIVE_GROCERIES', 'Ordinary grocery pack at an unusual price', 'groceries', '30'),
};

function historyRow(index: number, seller: Merchant, timestamp: string): HistoricalAuthorization {
  return {
    authorization_id: asId(`SYNTHETIC_HISTORY_${index}`), customer_id: customer.customer_id, account_id: account.account_id, card_id: card.card_id,
    initiator_type: 'human', timestamp, transaction_type: 'purchase', status: 'approved', amount: '10.00', currency: 'CHF', billing_amount_chf: '10.00',
    merchant_id: seller.merchant_id, merchant_name: seller.merchant_name, merchant_category: seller.merchant_category, merchant_mcc: seller.merchant_mcc,
    merchant_country: seller.merchant_country, merchant_city: seller.merchant_city, channel: 'in_store', card_present: true, recurring: false,
    customer_device_id: 'SYNTHETIC_DEVICE', description: 'Authored prior payment', related_transaction_id: null,
    account_type: account.account_type, account_purpose: account.account_purpose, base_currency: account.base_currency,
    per_transaction_limit_chf: account.per_transaction_limit_chf, monthly_limit_chf: account.monthly_limit_chf,
    card_purpose: card.card_purpose, card_status: card.status, online_enabled: true, international_enabled: true, virtual_card: false,
    customer_home_region: customer.home_region, customer_budget_style: customer.budget_style, customer_persona_name: customer.persona_name,
    approved_spend_before_chf: '0', approved_merchant_transaction_count_before: index, approved_device_transaction_count_before: index, last_approved_at: null, source,
  };
}

function fixedConfig(): SafetyConfig {
  const parameters = validateParameters({ ...defaultParameters(), max_order_chf: '100', rolling_budget: { days: 7, limit_chf: '250' },
    familiar_merchant: true, allowed_item_categories: ['groceries', 'household', 'personal_care'], forbid_recurring: true,
    unusual_amount: true, duplicate_hours: 24, domestic_country: 'CH',
  });
  const clauses: Array<[string, FilterId[], string[]]> = [
    ['You may purchase groceries, household essentials and personal care products.', ['M09'], ['allowed_item_categories']],
    ['Never exceed CHF 100 per purchase or CHF 250 in any rolling seven-day period.', ['C09', 'C10'], ['max_order_chf', 'rolling_budget']],
    ['Only use familiar merchants, except for legitimate unfamiliar merchants when the total is below CHF 30.', ['M01', 'M02'], ['familiar_merchant']],
    ['Never buy subscriptions, alcohol, gift cards, cryptocurrency or gambling products.', ['M09', 'M16'], ['allowed_item_categories', 'forbid_recurring']],
    ['Ask me about unusually expensive products or uncertain purchases.', ['M17', 'C20', 'C25'], ['unusual_amount']],
    ['Do not approve duplicate orders without checking with me.', ['C13'], ['duplicate_hours']],
  ];
  const requirements: Requirement[] = clauses.map(([excerpt, filters, keys], index) => ({ requirement_id: `SYNTHETIC_REQUIREMENT_${index}`, source_excerpt: excerpt,
    description: index === 2 ? `${excerpt} Conservative review fallback: the below-CHF30 exception is unsupported.` : index === 5 ? `${excerpt} Test coverage: repeats within 24 hours.` : excerpt,
    filter_ids: filters, parameter_keys: keys, status: 'confirmed', question: null, author: 'synthetic-test-author', revision: 1,
  }));
  return { schema_version: 1, config_id: 'SYNTHETIC_FIXED_POLICY', mandate_id: 'SYNTHETIC_MANDATE', mandate_version: 1, revision: 1,
    instruction: PURCHASE_SCENARIO_POLICY, instruction_hash: hash(PURCHASE_SCENARIO_POLICY), status: 'confirmed', requirements, parameters,
    created_at: NOW, confirmed_at: NOW, confirmed_by: 'synthetic-test-author',
  };
}

function environment(caseId: string): Omit<EvaluationContext, 'event' | 'offer_hash'> {
  const config = fixedConfig();
  const history = Array.from({ length: 20 }, (_, i) => historyRow(i, merchants.migros, new Date(Date.parse(NOW) - (i + 8) * 86400000).toISOString()));
  history.push(historyRow(20, merchants.digitec, '2026-08-01T12:00:00Z'), historyRow(21, merchants.netflix, '2026-08-02T12:00:00Z'));
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const allMerchants = Object.values(merchants), allItems = Object.values(items);
  const pack: DataPack = {
    pack_version: 'synthetic-seven-scenarios-v1', manifest_file_count: 0, manifest_hashes_verified: 0,
    customers: [customer], accounts: [account], cards: [card], merchants: allMerchants, items: allItems, fxRates: [], scenarios: [], authorities: [authority], attempts: [], attemptItems: [], history,
    customersById: new Map([[customer.customer_id, customer]]), accountsById: new Map([[account.account_id, account]]), cardsById: new Map([[card.card_id, card]]),
    merchantsById: new Map(allMerchants.map(m => [m.merchant_id, m])), itemsById: new Map(allItems.map(i => [i.item_id, i])),
    scenariosById: new Map(), authoritiesById: new Map([[authority.authority_id, authority]]), fxByCurrency: new Map(), attemptsByScenario: new Map(), itemsByAttempt: new Map(), historyByCard: new Map([[card.card_id, history]]),
  };
  const mandate: MandateSnapshot = { mandate_id: asId(config.mandate_id), status: 'active', customer_id: customer.customer_id, card_id: card.card_id,
    instruction: config.instruction, uncertainty_policy: 'ask', profile_id: asId('SYNTHETIC_PROFILE'), hard_rules: [
      { field: 'authorization.billing_amount_chf', operator: '<=', value: 100, currency: 'CHF', scope: 'purchase' },
      { field: 'authorization.billing_amount_chf', operator: '<=', value: 250, currency: 'CHF', scope: 'period', period_days: 7 },
      { field: 'authorization.items.item_category', operator: 'in', value: ['groceries', 'household', 'personal_care'] },
    ],
  };
  const run: SimRun = { schema_version: 1, scope: 'local_simulation', run_id: `SYNTHETIC_RUN_${caseId}`, run_key: caseId, scenario_id: 'SCEN9000',
    customer_id: customer.customer_id, card_id: card.card_id, authority_id: authority.authority_id, mandate_snapshot: mandate, mandate_version: 1, config,
    budget_scope_id: 'SYNTHETIC_BUDGET', status: 'active', next_index: 0, revision: 1, history, history_hash: hash(history),
    history_coverage: { from: history[0]!.timestamp, to: NOW, rows: history.length }, purchases: [], commitments: [], reservations: [], audit: [], created_at: NOW,
  };
  // Keep every case independent, including synthetic reference maps and historical rows.
  return structuredClone({ pack, config, run, now: NOW, answers: [], phase: 'assess' });
}

function transaction(env: ReturnType<typeof environment>, id: string, seller: Merchant, product: CatalogueItem, amount: number, timestamp = NOW, recurring = false): EvaluationContext {
  const { source: _source, ...merchantFacts } = seller;
  const event: AuthorizationEvent = { type: 'authorization.request', request_id: asId(`SYNTHETIC_REQUEST_${id}`), deadline_at: '2026-09-19T12:00:08.000Z',
    authorization: { authorization_id: asId(`SYNTHETIC_AUTH_${id}`), source_authorization_id: asId(`SYNTHETIC_SOURCE_${id}`), scenario_id: asId(env.run.scenario_id),
      replay_order: env.run.purchases.length + 1, mandate_id: asId(env.config.mandate_id), profile_id: env.run.mandate_snapshot.profile_id, card_id: card.card_id,
      initiator_type: 'agent', merchant: merchantFacts, timestamp, amount, currency: 'CHF', billing_amount_chf: amount, items_subtotal: amount, delivery_fee: 0,
      channel: recurring ? 'recurring' : 'ecommerce', customer_device_id: 'SYNTHETIC_DEVICE', authority_status: 'active', card_status_at_attempt: 'active',
      spend_in_period_before_chf: null, recent_attempt_count_10m: 0, fulfillment_method: 'delivery', delivery_by: null, order_returnable: 'not_applicable', order_cancellable: 'true',
      related_authorization_id: null, related_authorization_status: null, purchase_description: `CHF ${amount} ${product.item_name} from ${seller.merchant_name}`,
      items: [{ line_no: 1, item_id: product.item_id, item_name: product.item_name, item_category: product.item_category, quantity: 1, unit_price: amount, currency: 'CHF',
        item_details: recurring ? 'Monthly subscription with automatic renewal.' : product.item_description }],
    },
    mandate: structuredClone(env.run.mandate_snapshot), context: { approved_spend_in_period_chf: null, recent_authorizations: [] },
    runtime: { received_at: NOW, history_window_minutes: 10, context_basis: 'run_decisions_and_scenario_timestamps' },
  };
  return { ...env, event, offer_hash: offerHash(event, env.config) };
}

/** Seed only purchases the real engine approves under the very same policy. */
function approvePrior(ctx: EvaluationContext): void {
  const assessment = assess({ ...ctx, phase: 'commit' });
  if (!assessment.can_finalize) throw new Error(`Synthetic prior purchase ${ctx.event.authorization.authorization_id} was not approvable: ${[...assessment.blocking_filter_ids, ...assessment.doubt_filter_ids, ...assessment.technical_filter_ids].join(', ')}`);
  stampCommitted(assessment);
  ctx.run.purchases.push({ event: structuredClone(ctx.event), assessments: [assessment], answers: [] });
  ctx.run.commitments.push({ authorization_id: ctx.event.authorization.authorization_id, amount_chf: new Decimal(ctx.event.authorization.billing_amount_chf).toFixed(2),
    timestamp: ctx.event.authorization.timestamp, quantity: 1, budget_scope_id: ctx.run.budget_scope_id });
  ctx.run.revision++;
}

export type SyntheticPurchaseInput = {
  id: string;
  amount_chf: number;
  timestamp?: string;
  recurring?: boolean;
  merchant: { id: string; name: string; category: string; mcc: string; country?: string; city?: string };
  item: { id: string; name: string; category: string; details?: string; minimum_price_chf: string; typical_price_chf: string; maximum_price_chf: string };
};

/** Feed authored purchases into the real engine with one unchanged policy.
 * Submitted approvals are retained for subsequent budgets/duplicates, in memory
 * only. The caller supplies synthetic reference facts; this is not a payment API.
 */
export function createSyntheticPurchaseHarness(options: { id?: string; history?: HistoricalAuthorization[] } = {}) {
  const env = environment(options.id ?? 'custom');
  if (options.history) {
    env.run.history = structuredClone(options.history);
    env.run.history_hash = hash(env.run.history);
    const times = env.run.history.map(h => h.timestamp).sort();
    env.run.history_coverage = { from: times[0] ?? NOW, to: NOW, rows: times.length };
    env.pack.history = env.run.history;
    env.pack.historyByCard = new Map([[card.card_id, env.run.history]]);
  }
  return {
    config: env.config,
    run: env.run,
    submit(input: SyntheticPurchaseInput) {
      if (!input.id.trim() || !Number.isFinite(input.amount_chf) || input.amount_chf <= 0 || !new Decimal(input.amount_chf).mul(100).isInteger()) throw new Error('A synthetic purchase needs a unique ID and a positive CHF amount in cents.');
      if (input.timestamp && !Number.isFinite(Date.parse(input.timestamp))) throw new Error('The synthetic purchase timestamp is invalid.');
      if (env.run.purchases.some(p => p.event.authorization.authorization_id === `SYNTHETIC_AUTH_${input.id}`)) throw new Error('The synthetic purchase ID has already been submitted.');
      const seller: Merchant = { ...merchant(input.merchant.id, input.merchant.name, input.merchant.category, input.merchant.mcc), merchant_country: input.merchant.country ?? 'CH', merchant_city: input.merchant.city ?? 'Zurich' };
      const product: CatalogueItem = { ...item(input.item.id, input.item.name, input.item.category), item_description: input.item.details ?? input.item.name,
        unit_price_min_chf: input.item.minimum_price_chf, unit_price_typical_chf: input.item.typical_price_chf, unit_price_max_chf: input.item.maximum_price_chf };
      env.pack.merchants = [...env.pack.merchants.filter(m => m.merchant_id !== seller.merchant_id), seller];
      env.pack.merchantsById = new Map(env.pack.merchantsById).set(seller.merchant_id, seller);
      env.pack.items = [...env.pack.items.filter(i => i.item_id !== product.item_id), product];
      env.pack.itemsById = new Map(env.pack.itemsById).set(product.item_id, product);
      const ctx = transaction(env, input.id, seller, product, input.amount_chf, input.timestamp ?? NOW, input.recurring ?? false);
      const assessment = assess({ ...ctx, phase: 'commit' });
      if (assessment.can_finalize) {
        stampCommitted(assessment);
        env.run.commitments.push({ authorization_id: ctx.event.authorization.authorization_id, amount_chf: new Decimal(input.amount_chf).toFixed(2),
          timestamp: ctx.event.authorization.timestamp, quantity: 1, budget_scope_id: env.run.budget_scope_id });
      }
      env.run.purchases.push({ event: structuredClone(ctx.event), assessments: [assessment], answers: [] });
      env.run.revision++;
      return { event: ctx.event, assessment };
    },
  };
}

export type PurchaseScenarioCase = { id: string; description: string; context: EvaluationContext; expected_decision: Assessment['decision']; expected_checks: Array<{ filter_id: FilterId; outcome: 'fail' | 'needs_review' }> };
export function buildPurchaseScenarioCases(): PurchaseScenarioCase[] {
  const cases: PurchaseScenarioCase[] = [];
  const add = (id: string, description: string, seller: Merchant, product: CatalogueItem, amount: number, expected: PurchaseScenarioCase['expected_decision'], checks: PurchaseScenarioCase['expected_checks'], env = environment(id), recurring = false) => {
    cases.push({ id, description, context: transaction(env, id, seller, product, amount, NOW, recurring), expected_decision: expected, expected_checks: checks });
  };
  add('purchase_cap', 'CHF 120 groceries from Migros', merchants.migros, items.groceries, 120, 'deny', [{ filter_id: 'C09', outcome: 'fail' }]);
  add('unfamiliar_shampoo', 'CHF 20 shampoo from an unfamiliar shop', merchants.unfamiliar, items.shampoo, 20, 'step_up', [{ filter_id: 'M02', outcome: 'needs_review' }]);
  add('headphones_category', 'CHF 60 headphones from Digitec', merchants.digitec, items.headphones, 60, 'deny', [{ filter_id: 'M09', outcome: 'fail' }]);
  add('subscription', 'CHF 15 Netflix subscription', merchants.netflix, items.subscription, 15, 'deny', [{ filter_id: 'M09', outcome: 'fail' }, { filter_id: 'M16', outcome: 'fail' }], environment('subscription'), true);

  const budget = environment('rolling_budget');
  // Nine CHF25 approvals plus one CHF20 approval, all inside seven days.
  // Different products prevent the budget setup from creating duplicate orders.
  for (let i = 0; i < 10; i++) {
    const product = item(`SYNTHETIC_PRIOR_GROCERY_${i}`, `Prior grocery product ${i + 1}`, 'groceries', '30');
    budget.pack.items.push(product);
    budget.pack.itemsById = new Map(budget.pack.itemsById).set(product.item_id, product);
    approvePrior(transaction(budget, `BUDGET_PRIOR_${i}`, merchants.migros, product, i === 9 ? 20 : 25, new Date(Date.parse(NOW) - (10 - i) * 3600000).toISOString()));
  }
  add('rolling_budget', 'CHF 18 groceries after CHF 245 already approved this week', merchants.migros, items.groceries, 18, 'deny', [{ filter_id: 'C10', outcome: 'fail' }], budget);
  add('unusual_groceries', 'CHF 45 unusually expensive groceries', merchants.migros, items.expensive, 45, 'step_up', [{ filter_id: 'M17', outcome: 'needs_review' }, { filter_id: 'C20', outcome: 'needs_review' }]);

  const duplicate = environment('duplicate');
  approvePrior(transaction(duplicate, 'DUPLICATE_FIRST', merchants.migros, items.groceries, 25, '2026-09-19T11:40:00.000Z'));
  add('duplicate', 'CHF 25 duplicate groceries with a different request ID', merchants.migros, items.groceries, 25, 'step_up', [{ filter_id: 'C13', outcome: 'needs_review' }], duplicate);
  return cases;
}

export function runPurchaseScenarioRegressions() {
  const cases = buildPurchaseScenarioCases().map(testCase => {
    const { context, expected_checks, ...description } = testCase;
    const assessment = assess(context);
    const checks = expected_checks.map(expected => ({ ...expected, actual_outcome: assessment.results.find(r => r.filter_id === expected.filter_id)!.outcome }));
    return { ...description, policy_hash: hash(context.config), event: context.event,
      prior_approved_chf: context.run.commitments.reduce((total, entry) => total.plus(entry.amount_chf), new Decimal(0)).toFixed(2),
      prior_purchases: context.run.purchases.map(p => ({ request_id: p.event.request_id, authorization_id: p.event.authorization.authorization_id, amount_chf: p.event.authorization.billing_amount_chf, assessment: p.assessments.at(-1)! })),
      checks, passed: assessment.decision === description.expected_decision && checks.every(c => c.actual_outcome === c.outcome) && assessment.technical_filter_ids.length === 0, assessment,
    };
  });
  return { provenance: 'synthetic_only', external_api_calls: false, instruction_decoder_used: false, fixed_policy: fixedConfig(), limitations: PURCHASE_SCENARIO_LIMITATIONS,
    passed: cases.every(c => c.passed), cases };
}
