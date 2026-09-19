import { describe, expect, it } from 'vitest';
import type { BehaviorControlEvent, BehaviorObservation, BehaviorScope } from '../packages/contracts/src/behavior.js';
import type { BehaviorJournal, BehaviorReviewEvent } from '../packages/contracts/src/behavior-dashboard.js';
import type { MLExample } from '../packages/contracts/src/behavior-ml.js';
import type { MLContextRecord, MLDataset } from '../packages/local-runtime/src/learning/behavior-ml-projection.js';
import { projectSimplePreferences } from '../packages/local-runtime/src/learning/simple-preferences.js';

const now = '2026-09-19T12:00:00Z';
const predicted = '2026-09-17T10:00:00Z';
const labelled = '2026-09-18T10:00:00Z';
const journal = (controls: BehaviorControlEvent[] = []): BehaviorJournal => ({ schema_version: 1, sequence: 0, observations: [], controls });
const control = (action: BehaviorControlEvent['action'], sequence = 5, at = now): BehaviorControlEvent => ({ sequence, customer_id: 'customer', scope: 'local', filter_id: 'C15', context_key: 'device', action, at, actor_id: 'owner' });
function record(source: string, patch: Partial<MLContextRecord> = {}): MLContextRecord {
  return { customer_id: 'customer', scope: 'local', authorization_id: `auth-${source}`, snapshot: { schema_version: 1, feature_version: 'behavior-context-v2', predicted_at: predicted, filter_id: 'C15', context_key: 'device', features: [], source_id: source, eligible: true, was_suppressed: false, knowledge_sequence: 1 }, ...patch };
}
function example(source: string, label: 0 | 1, patch: Partial<MLExample> = {}): MLExample {
  return { id: source, customer_id: 'customer', scope: 'local', filter_id: 'C15', predicted_at: predicted, label_at: labelled, features: [], label, ...patch };
}
function dataset(confirmed = 0, rejected = 0): MLDataset {
  const examples = Array.from({ length: confirmed + rejected }, (_, i) => example(`s${i}`, i < confirmed ? 1 : 0));
  return { records: examples.map(e => record(e.id)), examples, excluded_legacy_assessments: 0, excluded_controlled: 0, unknown: 0 };
}
const project = (data: MLDataset, j = journal(), customerId = 'customer', scope: BehaviorScope = 'local', asOf = now) => projectSimplePreferences(data, j, customerId, scope, asOf);
const observation = (patch: Partial<BehaviorObservation> = {}): BehaviorObservation => ({ customer_id: 'customer', scope: 'local', source_id: 'legacy', authorization_id: 'auth-legacy', filter_id: 'C15', context_key: 'device', occurred_at: predicted, recorded_at: labelled, actor_id: 'owner', sequence: 1, ...patch });
const review = (patch: Partial<BehaviorReviewEvent> = {}): BehaviorReviewEvent => ({ customer_id: 'customer', scope: 'local', source_id: 'legacy', authorization_id: 'auth-legacy', filter_id: 'C15', context_key: 'device', actor_id: 'owner', sequence: 2, verdict: 'rejected', at: '2026-09-19T10:00:00Z', ...patch });
const legacyJournal = (): BehaviorJournal => ({ ...journal(), sequence: 1, observations: [observation()] });

describe('simple Beta-Bernoulli preference projection', () => {
  it('computes 11/12 from ten confirmations and 9/12 from eight confirmations and two rejections', () => {
    const first = project(dataset(10)).contexts[0]!;
    expect(first).toMatchObject({ confirmed: 10, rejected: 0, samples: 10, score: 11 / 12, status: 'learning' });
    expect(first.standard_deviation).toBeCloseTo(Math.sqrt(11 / (12 * 12 * 13)), 15);
    expect(project(dataset(8, 2)).contexts[0]).toMatchObject({ confirmed: 8, rejected: 2, samples: 10, score: 9 / 12 });
  });

  it('displays no estimate without evidence and has no arbitrary negative-class gate', () => {
    const empty = dataset(); empty.records.push(record('unknown'));
    expect(project(empty).contexts[0]).toMatchObject({ status: 'no_feedback', samples: 0, score: null, standard_deviation: null });
    expect(project(dataset(1)).contexts[0]!.score).toBe(2 / 3);
    expect(project(dataset(0, 1)).contexts[0]!.score).toBe(1 / 3);
  });

  it('increases with a new confirmation and decreases with a new rejection', () => {
    const base = project(dataset(4, 3)).contexts[0]!;
    expect(project(dataset(5, 3)).contexts[0]!.score).toBeGreaterThan(base.score!);
    expect(project(dataset(4, 4)).contexts[0]!.score).toBeLessThan(base.score!);
  });

  it('deduplicates a replay and replaces a corrected verdict instead of adding a sample', () => {
    const data = dataset(1); data.records.push({ ...data.records[0]!, authorization_id: 'replayed-auth' });
    data.examples.push(...Array.from({ length: 10 }, () => ({ ...data.examples[0]! })));
    expect(project(data).contexts[0]).toMatchObject({ confirmed: 1, rejected: 0, samples: 1, score: 2 / 3 });
    data.examples.push({ ...data.examples[0]!, label: 0, label_at: '2026-09-19T10:00:00Z' });
    expect(project(data).contexts[0]).toMatchObject({ confirmed: 0, rejected: 1, samples: 1, score: 1 / 3 });
  });

  it('excludes same-instant contradictory labels and accepts a later explicit correction', () => {
    const data = dataset(1); data.examples.push({ ...data.examples[0]!, label: 0 });
    expect(project(data).contexts[0]).toMatchObject({ samples: 0, score: null, reason: 'Conflicting source feedback was excluded.' });
    data.examples.push({ ...data.examples[0]!, label_at: '2026-09-19T10:00:00Z' });
    expect(project(data).contexts[0]).toMatchObject({ samples: 1, score: 2 / 3 });
  });

  it('keeps customer, environment, filter and exact context independent', () => {
    const data = dataset(1);
    data.records.push(record('country', { snapshot: { ...record('country').snapshot, filter_id: 'C19', context_key: 'CH' } }));
    data.examples.push(example('country', 0, { filter_id: 'C19' }));
    data.records.push(record('second-device', { snapshot: { ...record('second-device').snapshot, context_key: 'other-device' } }));
    data.examples.push(example('second-device', 0));
    const before = project(data);
    data.records.push(record('s0', { customer_id: 'someone-else' }), record('s0', { scope: 'live' }));
    data.examples.push(example('s0', 0, { customer_id: 'someone-else' }), example('s0', 0, { scope: 'live' }));
    expect(project(data)).toEqual(before);
    expect(before.contexts.map(c => [c.filter_id, c.context_key, c.score])).toEqual([['C15', 'device', 2 / 3], ['C15', 'other-device', 1 / 3], ['C19', 'CH', 1 / 3]]);
  });

  it('applies strict label availability while suspension is immediate at the same instant', () => {
    const data = dataset(1); data.examples[0]!.label_at = now;
    expect(project(data).contexts[0]!.samples).toBe(0);
    expect(project(data, journal(), 'customer', 'local', '2026-09-19T12:00:00.001Z').contexts[0]!.samples).toBe(1);
    expect(project(dataset(3, 2), journal([control('suspend')])).contexts[0]).toMatchObject({ status: 'suspended', confirmed: 3, rejected: 2, score: null, standard_deviation: null });
  });

  it('forgets old generations permanently and resumes using only new sources', () => {
    const data = dataset(3), forgotten = journal([control('forget')]);
    expect(project(data, forgotten).contexts[0]).toMatchObject({ status: 'forgotten', samples: 0, score: null });
    data.records.push({ ...data.records[0]!, snapshot: { ...data.records[0]!.snapshot, knowledge_sequence: 7 } });
    data.examples.push({ ...data.examples[0]!, label_at: '2026-09-19T11:00:00Z' });
    expect(project(data, forgotten).contexts[0]!.samples).toBe(0);
    const resumed = journal([control('suspend'), control('resume', 6)]);
    expect(project(data, resumed).contexts[0]).toMatchObject({ samples: 0, status: 'no_feedback', score: null });
    data.records.push(record('fresh', { snapshot: { ...record('fresh').snapshot, knowledge_sequence: 6 } }));
    data.examples.push(example('fresh', 1));
    expect(project(data, resumed).contexts[0]).toMatchObject({ samples: 1, score: 2 / 3 });
    expect(project(data, journal([control('suspend'), control('forget', 6)])).contexts[0]!.status).toBe('suspended');
  });

  it('shows controls-only contexts and abstains on an invalid profile', () => {
    expect(project(dataset(), journal([control('suspend')])).contexts[0]).toMatchObject({ context_key: 'device', status: 'suspended', samples: 0, score: null });
    const invalid = journal(); invalid.invalid_profiles = [{ customer_id: 'customer', scope: 'local', reason: 'conflict' }];
    expect(project(dataset(2, 1), invalid).contexts[0]).toMatchObject({ confirmed: 2, rejected: 1, score: null, standard_deviation: null });
    expect(project(dataset(2, 1), invalid).contexts[0]!.reason).toContain('inconsistent');
  });

  it('never infers context from numeric features and rejects a source mapped to conflicting contexts', () => {
    const data = dataset(1); data.examples[0]!.features = [NaN];
    expect(project(data).contexts[0]!.score).toBe(2 / 3);
    data.records.push(record('s0', { snapshot: { ...record('s0').snapshot, context_key: 'conflicting-device' } }));
    expect(project(data).contexts.every(c => c.samples === 0 && c.score === null)).toBe(true);
  });

  it('is deterministic, preserves input, and never supplies a payment action', () => {
    const data = dataset(3, 2), j = journal(), saved = structuredClone({ data, j });
    const result = project(data, j);
    expect(project({ ...data, records: [...data.records].reverse(), examples: [...data.examples].reverse() }, j)).toEqual(result);
    expect({ data, j }).toEqual(saved);
    expect(result).toMatchObject({ observation_only: true, algorithm: 'beta_bernoulli_v1', totals: { confirmed: 3, rejected: 2, contexts: 1 } });
  });

  it('counts durable legacy confirmations without frozen features or dataset mutations', () => {
    const data = dataset(), j = legacyJournal(), before = structuredClone({ data, j });
    expect(project(data, j).contexts[0]).toMatchObject({ confirmed: 1, rejected: 0, samples: 1, score: 2 / 3 });
    expect({ data, j }).toEqual(before);
    expect(data.records).toEqual([]); expect(data.examples).toEqual([]);
    // Journal input must carry authenticated provenance and durable arrival order.
    const undated = observation(); delete undated.sequence;
    expect(project(data, { ...j, observations: [undated] }).totals.confirmed).toBe(0);
    for (const patch of [{ sequence: 0 }, { sequence: 2 }, { actor_id: '' }, { authorization_id: '' }, { recorded_at: 'invalid' }]) {
      expect(project(data, { ...j, observations: [observation(patch)] }).totals.confirmed).toBe(0);
    }
  });

  it('deduplicates legacy evidence and replaces its verdict with a matching explicit review', () => {
    const j = legacyJournal(); j.sequence = 4;
    j.observations.push(observation({ sequence: 3, authorization_id: 'replay', recorded_at: '2026-09-19T11:00:00Z' }));
    j.reviews = [review()];
    expect(project(dataset(), j).contexts[0]).toMatchObject({ confirmed: 0, rejected: 1, samples: 1, score: 1 / 3 });
    j.reviews.push(review({ sequence: 4, verdict: 'confirmed', at: '2026-09-19T11:30:00Z' }));
    expect(project(dataset(), j).contexts[0]).toMatchObject({ confirmed: 1, rejected: 0, samples: 1 });
    expect(project(dataset(), { ...j, observations: [...j.observations].reverse(), reviews: [...j.reviews].reverse() })).toEqual(project(dataset(), j));
  });

  it('isolates legacy observations and reviews by customer, scope, filter, context, source and authorization', () => {
    const j = legacyJournal(); j.sequence = 2;
    const changes = [{ customer_id: 'other' }, { scope: 'live' as const }, { filter_id: 'C19' as const }, { context_key: 'other' }, { source_id: 'other' }, { authorization_id: 'other' }];
    for (const patch of changes) {
      j.reviews = [review(patch)];
      expect(project(dataset(), j).contexts[0]).toMatchObject({ confirmed: 1, rejected: 0, samples: 1 });
    }
    j.observations.push(observation({ customer_id: 'other' }), observation({ scope: 'live' }), observation({ filter_id: 'C19', context_key: 'CH', sequence: 2 }));
    expect(project(dataset(), j).contexts.map(c => [c.filter_id, c.context_key, c.confirmed])).toEqual([['C15', 'device', 1], ['C19', 'CH', 1]]);
  });

  it('matches timezone-qualified legacy sources to their explicit time review', () => {
    const j = legacyJournal(), context_key = 'Europe/Zurich|weekday|0-4'; j.sequence = 2;
    j.observations = [observation({ filter_id: 'C18', source_id: 'legacy:Europe/Zurich', context_key })];
    j.reviews = [review({ filter_id: 'C18', context_key })];
    expect(project(dataset(), j).contexts[0]).toMatchObject({ filter_id: 'C18', confirmed: 0, rejected: 1, samples: 1 });
    j.reviews[0]!.context_key = 'Europe/Paris|weekday|0-4';
    expect(project(dataset(), j).contexts[0]).toMatchObject({ confirmed: 1, rejected: 0 });
  });

  it('enforces strict availability for legacy confirmations and corrections and preserves suspended counts', () => {
    const j = legacyJournal(); j.observations[0]!.recorded_at = now;
    expect(project(dataset(), j).contexts[0]).toMatchObject({ samples: 0, score: null });
    expect(project(dataset(), j, 'customer', 'local', '2026-09-19T12:00:00.001Z').contexts[0]!.samples).toBe(1);
    j.observations[0]!.recorded_at = labelled; j.sequence = 3; j.reviews = [review({ at: now })]; j.controls = [control('suspend', 3)];
    expect(project(dataset(), j).contexts[0]).toMatchObject({ status: 'suspended', confirmed: 1, rejected: 0, score: null });
    expect(project(dataset(), j, 'customer', 'local', '2026-09-19T12:00:00.001Z').contexts[0]).toMatchObject({ status: 'suspended', confirmed: 0, rejected: 1, score: null });
  });

  it('cannot revive forgotten legacy evidence through journal or frozen-snapshot replays', () => {
    const j = legacyJournal(); j.sequence = 7; j.controls = [control('forget')];
    j.observations.push(observation({ sequence: 7, authorization_id: 'replay' }));
    j.reviews = [review({ sequence: 6 })];
    expect(project(dataset(), j).contexts[0]).toMatchObject({ status: 'forgotten', samples: 0 });
    const data = dataset(); data.records.push(record('legacy', { snapshot: { ...record('legacy').snapshot, knowledge_sequence: 5 } })); data.examples.push(example('legacy', 1));
    expect(project(data, j).contexts[0]).toMatchObject({ status: 'forgotten', samples: 0 });
    j.sequence = 9; j.controls = [control('suspend'), control('resume', 8)];
    j.observations.push(observation({ sequence: 9, source_id: 'fresh', authorization_id: 'fresh-auth' }));
    expect(project(data, j).contexts[0]).toMatchObject({ status: 'learning', samples: 1, confirmed: 1 });
  });

  it('keeps a legacy source count when a later replay adds a frozen snapshot and counts modern sources once', () => {
    const j = legacyJournal(), data = dataset();
    data.records.push(record('legacy', { snapshot: { ...record('legacy').snapshot, predicted_at: '2026-09-19T10:00:00Z', knowledge_sequence: 1 } }));
    expect(project(data, j).contexts[0]).toMatchObject({ samples: 1, confirmed: 1 });
    data.records[0]!.snapshot.knowledge_sequence = 0;
    data.records[0]!.snapshot.predicted_at = predicted;
    data.examples.push(example('legacy', 1));
    expect(project(data, j).contexts[0]).toMatchObject({ samples: 1, confirmed: 1 });
  });

  it('excludes legacy source identity conflicts and abstains for an invalid legacy profile', () => {
    const j = legacyJournal(); j.sequence = 2; j.observations.push(observation({ sequence: 2, context_key: 'conflicting-device' }));
    expect(project(dataset(), j).contexts.every(c => c.samples === 0 && c.reason === 'Conflicting source feedback was excluded.')).toBe(true);
    j.observations.pop(); j.invalid_profiles = [{ customer_id: 'customer', scope: 'local', reason: 'conflict' }];
    expect(project(dataset(), j).contexts[0]).toMatchObject({ confirmed: 1, samples: 1, score: null });
  });
});
