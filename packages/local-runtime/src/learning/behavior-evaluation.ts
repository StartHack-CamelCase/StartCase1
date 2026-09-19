import type {
  BehaviorCandidateEvaluation, BehaviorCandidateSelection, BehaviorComparisonSummary,
  BehaviorDatasetProvenance, BehaviorDecisionSnapshot, BehaviorEvaluationSample,
  BehaviorFilterMetrics, BehaviorLearningComparison,
} from '../../../contracts/src/behavior-evaluation.js';
import type { HabitFilterId } from '../../../contracts/src/behavior.js';
import type { Assessment } from '../../../contracts/src/simulation.js';
import { hash, offerHash, type EvaluationContext } from '../simulation/common.js';
import { assess } from '../simulation/evaluator.js';

const FILTERS: readonly HabitFilterId[] = ['C15', 'C18', 'C19'];
const fraction = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
const snapshot = (assessment: Assessment): BehaviorDecisionSnapshot => ({
  decision: assessment.decision, execution_state: assessment.execution_state,
  can_finalize: assessment.can_finalize,
  approval_eligible: assessment.can_finalize || assessment.decision === 'approve' && assessment.execution_state === 'approved',
});

/** No commits, feedback writes, reservations or HTTP calls. Persist this BEFORE
 * the human response: after resolution there is no original interruption to measure. */
export function assessBehaviorLearningComparison(ctx: EvaluationContext, adaptiveAssessment: Assessment): BehaviorLearningComparison {
  if (adaptiveAssessment.event_hash !== hash(ctx.event) || adaptiveAssessment.authorization_id !== ctx.event.authorization.authorization_id || adaptiveAssessment.facts_hash !== hash([ctx.event, ctx.answers]) || adaptiveAssessment.offer_hash !== offerHash(ctx.event, ctx.config) || adaptiveAssessment.ledger_revision !== ctx.run.revision) {
    throw new Error('behavior_comparison_event_mismatch');
  }
  const baselineAssessment = assess({ ...ctx, config: { ...ctx.config, parameters: { ...ctx.config.parameters, learn_confirmed_habits: false } } });
  const baseline = snapshot(baselineAssessment), adaptive = snapshot(adaptiveAssessment);
  const invariant_violations: string[] = [];
  for (const raw of baselineAssessment.results) {
    const adapted = adaptiveAssessment.results.find(value => value.filter_id === raw.filter_id);
    // C25 is derived from remaining questions. Commit guards legitimately change
    // when the caller snapshots the adaptive assessment after atomic finalization.
    if (FILTERS.includes(raw.filter_id as HabitFilterId) || raw.filter_id === 'C25' || raw.filter_id.startsWith('G')) continue;
    if (!adapted || adapted.outcome !== raw.outcome) invariant_violations.push(`unchanged_filter:${raw.filter_id}`);
  }
  for (const id of [...baselineAssessment.blocking_filter_ids, ...baselineAssessment.technical_filter_ids]) {
    const before = baselineAssessment.results.find(value => value.filter_id === id)!;
    const after = adaptiveAssessment.results.find(value => value.filter_id === id);
    if (!after || after.outcome !== before.outcome) invariant_violations.push(`blocking_filter:${id}`);
  }
  if ((baselineAssessment.blocking_filter_ids.length || baselineAssessment.technical_filter_ids.length) && adaptive.approval_eligible) invariant_violations.push('aggregate:blocked_approval');
  const filters = FILTERS.map(filter_id => {
    const raw = baselineAssessment.results.find(value => value.filter_id === filter_id);
    const adapted = adaptiveAssessment.results.find(value => value.filter_id === filter_id);
    if (!raw || !adapted) throw new Error('behavior_comparison_filter_missing');
    const permittedChange = raw.outcome === 'needs_review' && adapted.outcome === 'pass' && adaptiveAssessment.behavior_learning?.applied_filter_ids.includes(filter_id) && adapted.reasons.some(reason => reason.code === `${filter_id}_CONFIRMED_HABIT`) && !(filter_id === 'C18' && ctx.config.parameters.time_review !== null);
    if (raw.outcome !== adapted.outcome && !permittedChange) invariant_violations.push(`learning_filter:${filter_id}`);
    return { filter_id, baseline: raw.outcome, adaptive: adapted.outcome, suppressed: raw.outcome === 'needs_review' && adapted.outcome === 'pass' };
  });
  return {
    schema_version: 1, customer_id: ctx.event.mandate.customer_id, scope: ctx.behavior_scope ?? 'local',
    source_id: `${ctx.pack.pack_version}:${ctx.event.authorization.source_authorization_id}`,
    authorization_id: ctx.event.authorization.authorization_id, occurred_at: ctx.event.authorization.timestamp,
    predicted_at: ctx.now, pre_human: ctx.answers.length === 0,
    baseline, adaptive, filters,
    eligible_step_up_avoided: baseline.decision === 'step_up' && !baseline.approval_eligible && adaptive.approval_eligible,
    invariant_violations: [...new Set(invariant_violations)],
  };
}

const metrics = (filter_id: HabitFilterId): BehaviorFilterMetrics => ({
  filter_id, baseline_reviews: 0, suppressed_reviews: 0,
  known_baseline_confirmed: 0, known_baseline_rejected: 0, unknown_baseline: 0,
  known_suppressed_confirmed: 0, known_suppressed_rejected: 0, unknown_suppressed: 0,
  label_coverage: null, suppression_rate: null, false_suppression_rate: null,
  missed_rejection_rate: null, confirmed_alert_reduction: null,
});

/** Unknown labels stay in coverage/suppression denominators but never become
 * successes. Duplicate replay sources cannot improve reported precision. */
export function summarizeBehaviorComparisons(samples: readonly BehaviorEvaluationSample[], provenance: BehaviorDatasetProvenance): BehaviorComparisonSummary {
  const report: BehaviorComparisonSummary = {
    provenance: structuredClone(provenance), sample_fingerprint: '', prediction_time_range: null, samples: 0, excluded_post_human: 0,
    invalid_label_timing: 0, duplicate_samples: 0,
    baseline_approval_eligible: 0, adaptive_approval_eligible: 0, eligible_step_ups_avoided: 0,
    invariant_violations: 0, filters: FILTERS.map(metrics),
  };
  const seen = new Map<string, string>();
  const cohort: unknown[] = [];
  for (const sample of samples) {
    const c = sample.comparison;
    if (!c.pre_human) { report.excluded_post_human++; continue; }
    if (!Number.isFinite(Date.parse(c.predicted_at))) throw new Error('behavior_comparison_prediction_time_invalid');
    const identity = JSON.stringify([c.customer_id, c.scope, c.source_id]);
    const fingerprint = hash({ comparison: { ...c, authorization_id: undefined }, labels: sample.labels });
    const previous = seen.get(identity);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('behavior_comparison_duplicate_conflict');
      report.duplicate_samples++; continue;
    }
    seen.set(identity, fingerprint); report.samples++;
    cohort.push({ identity, predicted_at: c.predicted_at, occurred_at: c.occurred_at, baseline: c.baseline, filters: c.filters.map(value => ({ filter_id: value.filter_id, baseline: value.baseline })), labels: sample.labels });
    const normalizedTime = new Date(c.predicted_at).toISOString();
    if (!report.prediction_time_range) report.prediction_time_range = { from: normalizedTime, to: normalizedTime };
    else {
      if (normalizedTime < report.prediction_time_range.from) report.prediction_time_range.from = normalizedTime;
      if (normalizedTime > report.prediction_time_range.to) report.prediction_time_range.to = normalizedTime;
    }
    report.baseline_approval_eligible += Number(c.baseline.approval_eligible);
    report.adaptive_approval_eligible += Number(c.adaptive.approval_eligible);
    report.eligible_step_ups_avoided += Number(c.eligible_step_up_avoided);
    report.invariant_violations += c.invariant_violations.length;
    for (const values of c.filters) {
      const m = report.filters.find(value => value.filter_id === values.filter_id);
      if (!m) throw new Error('behavior_comparison_filter_invalid');
      if (values.baseline !== 'needs_review') continue;
      m.baseline_reviews++;
      if (values.suppressed) m.suppressed_reviews++;
      const label = sample.labels[values.filter_id];
      const timingValid = label !== undefined && label !== 'unknown' && Number.isFinite(Date.parse(label.observed_at)) && Date.parse(label.observed_at) >= Date.parse(c.predicted_at);
      if (label !== undefined && label !== 'unknown' && !timingValid) report.invalid_label_timing++;
      if (!timingValid) {
        m.unknown_baseline++;
        if (values.suppressed) m.unknown_suppressed++;
      } else if (label.verdict === 'confirmed') {
        m.known_baseline_confirmed++;
        if (values.suppressed) m.known_suppressed_confirmed++;
      } else if (label.verdict === 'rejected') {
        m.known_baseline_rejected++;
        if (values.suppressed) m.known_suppressed_rejected++;
      } else throw new Error('behavior_comparison_label_invalid');
    }
  }
  for (const m of report.filters) {
    m.label_coverage = fraction(m.known_baseline_confirmed + m.known_baseline_rejected, m.baseline_reviews);
    m.suppression_rate = fraction(m.suppressed_reviews, m.baseline_reviews);
    m.false_suppression_rate = fraction(m.known_suppressed_rejected, m.known_suppressed_confirmed + m.known_suppressed_rejected);
    m.missed_rejection_rate = fraction(m.known_suppressed_rejected, m.known_baseline_rejected);
    m.confirmed_alert_reduction = fraction(m.known_suppressed_confirmed, m.known_baseline_confirmed);
  }
  report.sample_fingerprint = hash(cohort.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return report;
}

/** Deliberately conservative demonstration gate, not a fraud certification.
 * Selection sees validation only. The selected candidate's later test is a gate;
 * a failure never selects a different candidate using the reserved test. */
export function selectBehaviorCandidate(candidates: readonly BehaviorCandidateEvaluation[], minimumKnownPerClassPerFilter = 20): BehaviorCandidateSelection {
  if (!Number.isInteger(minimumKnownPerClassPerFilter) || minimumKnownPerClassPerFilter < 1) throw new Error('behavior_candidate_minimum_invalid');
  if (new Set(candidates.map(value => value.candidate_id)).size !== candidates.length) throw new Error('behavior_candidate_id_duplicate');
  const kind = candidates[0]?.validation.provenance.kind ?? 'synthetic';
  if (candidates.some(value => value.validation.provenance.kind !== kind || value.test.provenance.kind !== kind)) throw new Error('behavior_candidate_provenance_mismatch');
  for (const phase of ['validation', 'test'] as const) {
    const first = candidates[0]?.[phase];
    if (candidates.some(value => value[phase].provenance.dataset_id !== first?.provenance.dataset_id || value[phase].sample_fingerprint !== first.sample_fingerprint)) throw new Error('behavior_candidate_cohort_mismatch');
  }
  if (candidates.some(value => value.validation.prediction_time_range && value.test.prediction_time_range && Date.parse(value.validation.prediction_time_range.to) >= Date.parse(value.test.prediction_time_range.from))) throw new Error('behavior_candidate_holdout_not_later');
  const base: BehaviorCandidateSelection = { selected_candidate_id: null, state: 'baseline', validation_scope: kind === 'synthetic' ? 'synthetic_only' : 'observed', live_activation_allowed: false, reasons: [], minimum_known_per_class_per_filter: minimumKnownPerClassPerFilter };
  const eligible = candidates.filter(value => evidenceProblems(value.validation, minimumKnownPerClassPerFilter).length === 0)
    .sort((a, b) => b.validation.eligible_step_ups_avoided - a.validation.eligible_step_ups_avoided || a.candidate_id.localeCompare(b.candidate_id));
  const candidate = eligible[0];
  if (!candidate) return { ...base, reasons: ['No candidate has sufficient labelled validation coverage and a safe measured improvement.'] };
  const problems = evidenceProblems(candidate.test, minimumKnownPerClassPerFilter);
  return { ...base, selected_candidate_id: candidate.candidate_id, state: problems.length ? 'shadow' : 'validated', reasons: problems.length ? problems : [kind === 'synthetic' ? 'Validated on a reserved synthetic test only; this does not establish real-world safety.' : 'Passed this observed-data gate; automatic activation requires a separately governed deployment.'] };
}

function evidenceProblems(report: BehaviorComparisonSummary, minimum: number): string[] {
  const problems: string[] = [];
  if (report.invariant_violations) problems.push('Safety invariants changed.');
  if (report.invalid_label_timing) problems.push('Feedback timing is invalid.');
  if (report.eligible_step_ups_avoided === 0) problems.push('No complete interruption avoided.');
  for (const filter of FILTERS) {
    const m = report.filters.find(value => value.filter_id === filter);
    if (!m || m.known_baseline_confirmed < minimum || m.known_baseline_rejected < minimum || m.unknown_baseline > 0) {
      problems.push(`${filter}: insufficient labelled coverage.`); continue;
    }
    if (m.known_suppressed_rejected > 0) problems.push(`${filter}: a rejected context was suppressed.`);
    if (m.known_suppressed_confirmed === 0) problems.push(`${filter}: no confirmed alert reduction.`);
  }
  return problems;
}
