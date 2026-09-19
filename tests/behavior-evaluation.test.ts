import { describe, expect, it } from 'vitest';
import type { BehaviorCandidateEvaluation, BehaviorEvaluationSample, BehaviorLearningComparison } from '../packages/contracts/src/behavior-evaluation.js';
import type { BehaviorObservation, HabitFilterId } from '../packages/contracts/src/behavior.js';
import { assessBehaviorLearningComparison, selectBehaviorCandidate, summarizeBehaviorComparisons } from '../packages/local-runtime/src/learning/behavior-evaluation.js';
import { buildBehaviorProfile } from '../packages/local-runtime/src/learning/behavior-profile.js';
import { offerHash } from '../packages/local-runtime/src/simulation/common.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { fixture } from './simulation-fixture.js';

const provenance = { dataset_id: 'SYNTHETIC_TEST', kind: 'synthetic' as const, description: 'Explicit unit-test labels, not official correctness labels.' };
function learnedContext() {
  const ctx = fixture('AU0001');
  ctx.event.authorization.timestamp = '2026-08-24T10:00:00.000Z';
  ctx.event.authorization.customer_device_id = 'synthetic-learned-device';
  ctx.config.parameters.learn_confirmed_habits = true;
  ctx.config.parameters.watch_devices = true;
  const observations: BehaviorObservation[] = [21, 22, 23].map(day => ({ customer_id: ctx.run.customer_id, scope: 'local', source_id: `SYNTHETIC_TRAIN_${day}`, authorization_id: `SYNTHETIC_TRAIN_${day}`, filter_id: 'C15', context_key: 'synthetic-learned-device', occurred_at: `2026-08-${day}T10:00:00.000Z`, recorded_at: '2026-09-18T00:00:00.000Z', actor_id: 'test-human' }));
  ctx.behavior_profile = buildBehaviorProfile(observations, { customerId: ctx.run.customer_id, scope: 'local', asOf: ctx.event.authorization.timestamp, timezone: ctx.config.parameters.timezone });
  ctx.offer_hash = offerHash(ctx.event, ctx.config);
  return ctx;
}
function paired(): BehaviorLearningComparison {
  const ctx = learnedContext();
  return assessBehaviorLearningComparison(ctx, assess(ctx));
}
function sample(source: string, verdict?: 'confirmed' | 'rejected'): BehaviorEvaluationSample {
  const comparison = { ...paired(), source_id: source, authorization_id: source };
  return { comparison, labels: verdict ? { C15: { verdict, observed_at: '2026-09-19T00:01:00.000Z' } } : {} };
}

describe('paired habit evaluation', () => {
  it('compares the same ledger without mutating context or reserving anything', () => {
    const ctx = learnedContext(), before = structuredClone(ctx);
    const report = assessBehaviorLearningComparison(ctx, assess(ctx));
    expect(report.filters.find(value => value.filter_id === 'C15')).toEqual({ filter_id: 'C15', baseline: 'needs_review', adaptive: 'pass', suppressed: true });
    expect(report.eligible_step_up_avoided).toBe(true);
    expect(report.invariant_violations).toEqual([]);
    expect(ctx).toEqual(before);
  });
  it('does not count a removed alert as an avoided interruption when another question remains', () => {
    const ctx = learnedContext(); ctx.config.parameters.always_ask = true;
    const report = assessBehaviorLearningComparison(ctx, assess(ctx));
    expect(report.filters.find(value => value.filter_id === 'C15')!.suppressed).toBe(true);
    expect(report.adaptive.decision).toBe('step_up');
    expect(report.eligible_step_up_avoided).toBe(false);
    expect(report.invariant_violations).toEqual([]);
  });
  it('does not count a hard decline as an avoided interruption and detects an illicit override', () => {
    const ctx = learnedContext(); ctx.config.parameters.max_order_chf = '1';
    const assessment = assess(ctx);
    expect(assessBehaviorLearningComparison(ctx, assessment).eligible_step_up_avoided).toBe(false);
    assessment.results.find(value => value.filter_id === 'C09')!.outcome = 'pass';
    expect(assessBehaviorLearningComparison(ctx, assessment).invariant_violations).toContain('blocking_filter:C09');
  });
  it('uses explicit denominators and leaves unlabelled suppressed cases unknown', () => {
    const report = summarizeBehaviorComparisons([sample('A', 'confirmed'), sample('B', 'rejected'), sample('C')], provenance);
    const m = report.filters[0]!;
    expect(m.baseline_reviews).toBe(3); expect(m.suppressed_reviews).toBe(3);
    expect(m.label_coverage).toBeCloseTo(2 / 3);
    expect(m.false_suppression_rate).toBe(0.5);
    expect(m.missed_rejection_rate).toBe(1);
    expect(m.unknown_suppressed).toBe(1);
    expect(report.filters[1]!.false_suppression_rate).toBeNull();
  });
  it('excludes post-human snapshots, deduplicates retries and refuses contradictory replay metrics', () => {
    const first = sample('A', 'confirmed'), answered = sample('B', 'confirmed'); answered.comparison.pre_human = false;
    const report = summarizeBehaviorComparisons([first, structuredClone(first), answered], provenance);
    expect(report.samples).toBe(1); expect(report.duplicate_samples).toBe(1); expect(report.excluded_post_human).toBe(1);
    const conflict = structuredClone(first); conflict.labels.C15 = { verdict: 'rejected', observed_at: '2026-09-19T00:01:00.000Z' };
    expect(() => summarizeBehaviorComparisons([first, conflict], provenance)).toThrow('duplicate_conflict');
  });
  it('does not accept pre-prediction labels as post-decision evidence', () => {
    const early = sample('A', 'confirmed'); early.labels.C15 = { verdict: 'confirmed', observed_at: '2026-09-18T00:00:00.000Z' };
    const report = summarizeBehaviorComparisons([early], provenance);
    expect(report.invalid_label_timing).toBe(1);
    expect(report.filters[0]!.known_suppressed_confirmed).toBe(0);
    expect(report.filters[0]!.unknown_suppressed).toBe(1);
  });
});

function candidate(candidate_id: string, suppressRejected = false): BehaviorCandidateEvaluation {
  const summaries = {} as Pick<BehaviorCandidateEvaluation, 'validation' | 'test'>;
  const template = paired();
  for (const phase of ['validation', 'test'] as const) {
    const samples: BehaviorEvaluationSample[] = [];
    for (const filter of ['C15', 'C18', 'C19'] as HabitFilterId[]) for (const verdict of ['confirmed', 'rejected'] as const) for (let n = 0; n < 20; n++) {
      const suppressed = verdict === 'confirmed' || suppressRejected;
      const comparison = structuredClone(template);
      comparison.source_id = `${phase}_${filter}_${verdict}_${n}`;
      comparison.predicted_at = phase === 'validation' ? '2026-09-19T00:01:00.000Z' : '2026-09-19T00:03:00.000Z';
      comparison.adaptive.approval_eligible = suppressed;
      comparison.eligible_step_up_avoided = suppressed;
      comparison.filters = comparison.filters.map(value => ({ filter_id: value.filter_id, baseline: value.filter_id === filter ? 'needs_review' : 'not_applicable', adaptive: value.filter_id === filter ? suppressed ? 'pass' : 'needs_review' : 'not_applicable', suppressed: value.filter_id === filter && suppressed }));
      samples.push({ comparison, labels: { [filter]: { verdict, observed_at: phase === 'validation' ? '2026-09-19T00:02:00.000Z' : '2026-09-19T00:04:00.000Z' } } });
    }
    summaries[phase] = summarizeBehaviorComparisons(samples, { ...provenance, dataset_id: phase });
  }
  return { candidate_id, parameters: {}, ...summaries };
}

describe('chronological candidate gate', () => {
  it('defaults to baseline without adequate evidence, even if apparent precision is perfect', () => {
    const c = candidate('few');
    c.validation.filters[0]!.known_baseline_rejected = 0;
    expect(selectBehaviorCandidate([c]).state).toBe('baseline');
    expect(selectBehaviorCandidate([]).live_activation_allowed).toBe(false);
  });
  it('rejects false suppressions and labels synthetic validation without activating anything', () => {
    const selected = selectBehaviorCandidate([candidate('fast', true), candidate('safe')]);
    expect(selected.selected_candidate_id).toBe('safe');
    expect(selected.state).toBe('validated');
    expect(selected.validation_scope).toBe('synthetic_only');
    expect(selected.live_activation_allowed).toBe(false);
  });
  it('never chooses a runner-up based on reserved test results', () => {
    const best = candidate('a'), runner = candidate('b');
    best.test.filters[0]!.known_suppressed_rejected = 1;
    const selected = selectBehaviorCandidate([best, runner]);
    expect(selected.selected_candidate_id).toBe('a');
    expect(selected.state).toBe('shadow');
  });
  it('requires the same cohort across candidates and a test strictly later than validation', () => {
    const a = candidate('a'), b = candidate('b');
    b.validation.sample_fingerprint = 'different-corpus';
    expect(() => selectBehaviorCandidate([a, b])).toThrow('cohort_mismatch');
    a.test.prediction_time_range = structuredClone(a.validation.prediction_time_range);
    expect(() => selectBehaviorCandidate([a])).toThrow('holdout_not_later');
  });
});
