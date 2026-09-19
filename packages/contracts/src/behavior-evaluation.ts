import type { BehaviorScope, HabitFilterId } from './behavior.js';
import type { Assessment, Outcome } from './simulation.js';

export type BehaviorDatasetProvenance = {
  dataset_id: string;
  kind: 'synthetic' | 'observed';
  description: string;
};
export type BehaviorDecisionSnapshot = {
  decision: Assessment['decision'];
  execution_state: Assessment['execution_state'];
  can_finalize: boolean;
  approval_eligible: boolean;
};
/** A paired, read-only counterfactual from the same event and ledger snapshot. */
export type BehaviorLearningComparison = {
  schema_version: 1;
  customer_id: string;
  scope: BehaviorScope;
  source_id: string;
  authorization_id: string;
  occurred_at: string;
  predicted_at: string;
  pre_human: boolean;
  baseline: BehaviorDecisionSnapshot;
  adaptive: BehaviorDecisionSnapshot;
  filters: Array<{ filter_id: HabitFilterId; baseline: Outcome; adaptive: Outcome; suppressed: boolean }>;
  eligible_step_up_avoided: boolean;
  invariant_violations: string[];
};
export type BehaviorEvaluationLabel = {
  verdict: 'confirmed' | 'rejected';
  /** Feedback acquisition time, on the same real clock as predicted_at. */
  observed_at: string;
};
export type BehaviorEvaluationSample = {
  comparison: BehaviorLearningComparison;
  labels: Partial<Record<HabitFilterId, BehaviorEvaluationLabel | 'unknown'>>;
};
export type BehaviorFilterMetrics = {
  filter_id: HabitFilterId;
  baseline_reviews: number;
  suppressed_reviews: number;
  known_baseline_confirmed: number;
  known_baseline_rejected: number;
  unknown_baseline: number;
  known_suppressed_confirmed: number;
  known_suppressed_rejected: number;
  unknown_suppressed: number;
  /** Known labels / baseline reviews; null when denominator is zero. */
  label_coverage: number | null;
  /** Suppressed reviews / baseline reviews. */
  suppression_rate: number | null;
  /** Rejected suppressed / all labelled suppressed. NOT a fraud probability. */
  false_suppression_rate: number | null;
  /** Rejected suppressed / all labelled rejected baseline reviews. */
  missed_rejection_rate: number | null;
  /** Confirmed suppressed / all labelled confirmed baseline reviews. */
  confirmed_alert_reduction: number | null;
};
export type BehaviorComparisonSummary = {
  provenance: BehaviorDatasetProvenance;
  /** Hash of paired baseline inputs/labels; equal across comparable candidates. */
  sample_fingerprint: string;
  prediction_time_range: { from: string; to: string } | null;
  samples: number;
  excluded_post_human: number;
  invalid_label_timing: number;
  duplicate_samples: number;
  baseline_approval_eligible: number;
  adaptive_approval_eligible: number;
  eligible_step_ups_avoided: number;
  invariant_violations: number;
  filters: BehaviorFilterMetrics[];
};
export type BehaviorCandidateEvaluation = {
  candidate_id: string;
  parameters: unknown;
  validation: BehaviorComparisonSummary;
  /** Reserved chronological test; never used to select the candidate. */
  test: BehaviorComparisonSummary;
};
export type BehaviorCandidateSelection = {
  selected_candidate_id: string | null;
  state: 'baseline' | 'shadow' | 'validated';
  validation_scope: 'synthetic_only' | 'observed';
  live_activation_allowed: false;
  reasons: string[];
  minimum_known_per_class_per_filter: number;
};
