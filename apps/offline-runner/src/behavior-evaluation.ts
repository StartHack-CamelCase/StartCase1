import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BEHAVIOR_PARAMETERS, type BehaviorControlEvent, type BehaviorObservation, type BehaviorParameters, type HabitFilterId } from '../../../packages/contracts/src/behavior.js';
import type { BehaviorCandidateEvaluation, BehaviorDatasetProvenance, BehaviorEvaluationSample } from '../../../packages/contracts/src/behavior-evaluation.js';
import type { RunRecord } from '../../../packages/contracts/src/run.js';
import type { SafetyConfig, SimRun } from '../../../packages/contracts/src/simulation.js';
import { AuthorizationEventFactory, loadDataPack } from '../../../packages/local-runtime/src/data/index.js';
import { assessBehaviorLearningComparison, selectBehaviorCandidate, summarizeBehaviorComparisons } from '../../../packages/local-runtime/src/learning/behavior-evaluation.js';
import { buildBehaviorProfile, habitContext } from '../../../packages/local-runtime/src/learning/behavior-profile.js';
import { defaultParameters } from '../../../packages/local-runtime/src/simulation/config.js';
import { hash, offerHash, type EvaluationContext } from '../../../packages/local-runtime/src/simulation/common.js';
import { assess } from '../../../packages/local-runtime/src/simulation/evaluator.js';

const FILTERS: readonly HabitFilterId[] = ['C15', 'C18', 'C19'];
type SyntheticCase = 'established' | 'insufficient' | 'expired' | 'suspended' | 'hard_limit';

/** The official purchase is a schema-compatible structural seed only. All
 * customers, history, feedback and evaluation labels below are synthetic. */
async function structuralSeed(rootDir: string): Promise<EvaluationContext> {
  const pack = await loadDataPack({ dataDir: resolve(rootDir, 'data') });
  const attempt = pack.attempts.find(value => value.authorization_id === 'AU0001');
  if (!attempt) throw new Error('synthetic_seed_missing');
  const authority = pack.authoritiesById.get(attempt.authority_id)!;
  const now = '2026-09-19T00:00:00.000Z';
  const skeleton: RunRecord = {
    run_id: 'SYNTHETIC_RUN' as never, run_key: 'SYNTHETIC', scenario_id: attempt.scenario_id, mode: 'inspection', mandate_id: 'SYNTHETIC_MANDATE' as never, mandate_version: 1,
    mandate_snapshot: { mandate_id: 'SYNTHETIC_MANDATE' as never, status: 'active', customer_id: authority.customer_id, card_id: attempt.card_id, instruction: 'Synthetic evaluation only', hard_rules: [], uncertainty_policy: 'ask', profile_id: 'SYNTHETIC_PROFILE' as never },
    fixture_authority_id: attempt.authority_id, customer_id: authority.customer_id, card_id: attempt.card_id, profile_id: 'SYNTHETIC_PROFILE' as never,
    status: 'ready', next_replay_order: 0, total_attempts: 1, emitted_count: 0, started_at: now, finished_at: null, config: { decision_timeout_ms: 8000, history_window_minutes: 10 },
    pack_version: 'SYNTHETIC_LEARNING_CORPUS_V1', engine_version: null, facts_version: null, commands: [],
  };
  const factory = new AuthorizationEventFactory(pack, resolve(rootDir, 'data/schemas/authorization_event.schema.json'));
  const event = factory.build({ attempt, run: skeleton, priorRecords: [], receivedAt: new Date(now) }).event;
  const config: SafetyConfig = {
    schema_version: 1, config_id: 'SYNTHETIC_CONFIG', mandate_id: 'SYNTHETIC_MANDATE', mandate_version: 1, revision: 1,
    instruction: skeleton.mandate_snapshot.instruction, instruction_hash: hash(skeleton.mandate_snapshot.instruction), status: 'confirmed',
    parameters: { ...defaultParameters(), domestic_country: 'CH', learn_confirmed_habits: true },
    requirements: [{ requirement_id: 'SYNTHETIC_REQUIREMENT', source_excerpt: 'Synthetic evaluation only', description: 'Synthetic', filter_ids: ['C03'], parameter_keys: [], status: 'confirmed', author: 'synthetic-generator', revision: 1, question: null }],
    created_at: now, confirmed_by: 'synthetic-generator', confirmed_at: now,
  };
  const run: SimRun = {
    schema_version: 1, scope: 'local_simulation', run_id: 'SYNTHETIC_RUN', run_key: 'SYNTHETIC', scenario_id: attempt.scenario_id, customer_id: authority.customer_id,
    card_id: attempt.card_id, authority_id: attempt.authority_id, mandate_snapshot: event.mandate, mandate_version: 1, config, budget_scope_id: 'SYNTHETIC_BUDGET',
    status: 'active', next_index: 0, revision: 1, history: pack.history, history_hash: hash(pack.history), history_coverage: { from: pack.history[0]!.timestamp, to: pack.history.at(-1)!.timestamp, rows: pack.history.length }, purchases: [], commitments: [], reservations: [], audit: [], created_at: now,
  };
  return { pack, event, config, run, now, offer_hash: offerHash(event, config), answers: [], phase: 'assess' };
}

function episode(seed: EvaluationContext, filter: HabitFilterId, kind: SyntheticCase, index: number, phase: 'validation' | 'test', parameters: BehaviorParameters): BehaviorEvaluationSample {
  const ctx = structuredClone(seed);
  const identity = `SYNTHETIC_${filter}_${kind}_${index}`;
  const customer = `${identity}_CUSTOMER`;
  const day = phase === 'validation' ? 20 : 21;
  ctx.pack.pack_version = 'SYNTHETIC_LEARNING_CORPUS_V1';
  ctx.event.mandate.customer_id = customer as never; ctx.run.customer_id = customer as never;
  const card = ctx.pack.cardsById.get(ctx.event.authorization.card_id)!;
  ctx.pack.accountsById.get(card.account_id)!.customer_id = customer as never;
  ctx.pack.authoritiesById.get(ctx.run.authority_id as never)!.customer_id = customer as never;
  ctx.event.authorization.authorization_id = `${identity}_${phase}` as never;
  ctx.event.authorization.source_authorization_id = `${identity}_${phase}` as never;
  ctx.event.authorization.timestamp = `2026-08-${day}T18:00:00.000Z`;
  ctx.now = phase === 'validation' ? '2026-09-19T00:01:00.000Z' : '2026-09-19T00:03:00.000Z';
  ctx.event.authorization.customer_device_id = `${identity}_device`;
  ctx.event.authorization.merchant.merchant_country = 'FR';
  ctx.pack.merchantsById.get(ctx.event.authorization.merchant.merchant_id)!.merchant_country = 'FR';
  ctx.run.history = Array.from({ length: 24 }, (_, i) => ({ ...ctx.pack.history[0]!, historical_authorization_id: `${identity}_H${i}` as never, customer_id: customer as never, card_id: ctx.run.card_id as never, timestamp: new Date(Date.UTC(2026, 6, i + 1, 8)).toISOString(), status: 'approved' as const, transaction_type: 'purchase' as const, customer_device_id: 'historical-device', merchant_country: 'CH' }));
  ctx.run.history_hash = hash(ctx.run.history);
  ctx.config.parameters.watch_devices = filter === 'C15';
  ctx.config.parameters.historical_time_review = filter === 'C18';
  ctx.config.parameters.unusual_country = filter === 'C19';
  if (kind === 'hard_limit') ctx.config.parameters.max_order_chf = '1';
  const context = habitContext(filter, ctx.event, ctx.config.parameters.timezone)!;
  const count = kind === 'insufficient' ? 2 : 3;
  const training: BehaviorObservation[] = Array.from({ length: count }, (_, i) => ({
    customer_id: customer, scope: 'local', source_id: `${identity}_TRAIN_${i}`, authorization_id: `${identity}_TRAIN_${i}`, filter_id: filter, context_key: context,
    occurred_at: `2026-${kind === 'expired' ? '05' : '08'}-${17 + i}T18:00:00.000Z`, recorded_at: '2026-09-19T00:00:00.000Z', actor_id: 'synthetic-explicit-customer', sequence: i + 1,
  }));
  const controls: BehaviorControlEvent[] = kind === 'suspended' ? [{ customer_id: customer, scope: 'local', filter_id: filter, context_key: context, action: 'suspend', sequence: 4, at: '2026-09-19T00:00:30.000Z', actor_id: 'synthetic-explicit-customer' }] : [];
  ctx.behavior_profile = buildBehaviorProfile(training, { customerId: customer, scope: 'local', asOf: ctx.event.authorization.timestamp, timezone: ctx.config.parameters.timezone, parameters, controls, availableThroughSequence: 4 });
  ctx.offer_hash = offerHash(ctx.event, ctx.config);
  const adaptive = assess(ctx);
  const comparison = assessBehaviorLearningComparison(ctx, adaptive);
  return { comparison, labels: { [filter]: { verdict: kind === 'established' || kind === 'hard_limit' ? 'confirmed' : 'rejected', observed_at: phase === 'validation' ? '2026-09-19T00:02:00.000Z' : '2026-09-19T00:04:00.000Z' } } };
}

/** Repeatable functional experiment, not an estimate of population error rates.
 * Training is frozen before validation and test. Labels are generated separately
 * from engine outcomes and never fed into profile construction or selection. */
export async function runSyntheticBehaviorEvaluation(rootDir = resolve(process.cwd())) {
  const seed = await structuralSeed(rootDir);
  const parameterSets = [
    { candidate_id: 'current_3_days', parameters: structuredClone(DEFAULT_BEHAVIOR_PARAMETERS) },
    { candidate_id: 'faster_2_days', parameters: Object.fromEntries(FILTERS.map(id => [id, { ...DEFAULT_BEHAVIOR_PARAMETERS[id], min_distinct_days: 2, min_effective_count: 1 }])) as BehaviorParameters },
    { candidate_id: 'stricter_4_days', parameters: Object.fromEntries(FILTERS.map(id => [id, { ...DEFAULT_BEHAVIOR_PARAMETERS[id], min_distinct_days: 4, min_effective_count: 3 }])) as BehaviorParameters },
  ];
  const candidates: BehaviorCandidateEvaluation[] = [];
  for (const candidate of parameterSets) {
    const summaries = {} as Pick<BehaviorCandidateEvaluation, 'validation' | 'test'>;
    for (const phase of ['validation', 'test'] as const) {
      const samples: BehaviorEvaluationSample[] = [];
      for (const filter of FILTERS) for (const kind of ['established', 'insufficient', 'expired', 'suspended', 'hard_limit'] as const) {
        for (let index = 0; index < 20; index++) samples.push(episode(seed, filter, kind, index, phase, candidate.parameters));
      }
      const provenance: BehaviorDatasetProvenance = { dataset_id: `synthetic-learning-v1-${phase}`, kind: 'synthetic', description: 'Independent synthetic customers and labels. Three prior confirmation days, two-day contradictions, expired evidence, explicit suspension, and a hard price limit. No official scenario ID is used as a correctness label.' };
      summaries[phase] = summarizeBehaviorComparisons(samples, provenance);
    }
    candidates.push({ ...candidate, ...summaries });
  }
  return {
    schema_version: 1,
    provenance: { kind: 'synthetic', generator: 'synthetic-learning-v1', structural_seed: 'AU0001, schema and purchase shape only', no_runtime_state_written: true },
    chronology: { training: 'Synthetic purchase dates 2026-08-17 through 2026-08-19 (expired controls in May); all feedback acquired before either prediction.', validation: 'Purchase date 2026-08-20.', test: 'Reserved purchase date 2026-08-21; never used to rank candidates.' },
    limitations: ['Synthetic checks do not estimate real-world fraud or customer accuracy.', 'Repeated functional cases are not independent statistical evidence.', 'No candidate is activated in live or local decision state.', 'The test is an acceptance gate only; its failure never selects an alternative candidate.'],
    candidates, selection: selectBehaviorCandidate(candidates),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSyntheticBehaviorEvaluation().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
