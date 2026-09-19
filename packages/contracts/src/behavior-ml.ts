import type { BehaviorScope, HabitFilterId } from './behavior.js';

/** Order is part of the model artifact; values are normalized before prediction. */
export const FEATURE_NAMES = [
  'log_distinct_days', 'log_effective_count', 'recency', 'no_confirmation',
  'hour_sin', 'hour_cos', 'weekend', 'context_frequency', 'category_frequency',
  'amount_log_ratio', 'novelty_interaction', 'previously_learned',
] as const;
export const BEHAVIOR_ML_FEATURE_VERSION = 'behavior-ml-features-v1';
export const ML_FEATURE_VERSION = BEHAVIOR_ML_FEATURE_VERSION;
/** The simple preference model needs identity and feedback, not numeric features. */
export const SIMPLE_CONTEXT_VERSION = 'behavior-context-v2';
/** Exact length and bounds are checked at runtime. Inputs are never mutated. */
export type MLFeatureVector = readonly number[];
export type MLFeatureSnapshot = {
  schema_version: 1;
  feature_version: string;
  predicted_at: string;
  filter_id: HabitFilterId;
  context_key: string;
  features: MLFeatureVector;
  source_id: string;
  was_suppressed: boolean;
  eligible: boolean;
  /** Journal position available when the frozen prediction features were captured. */
  knowledge_sequence: number;
};
export type MLExample = {
  /** Stable source identity; retries must retain it. */
  id: string;
  customer_id: string;
  scope: BehaviorScope;
  filter_id: HabitFilterId;
  predicted_at: string;
  label_at: string;
  features: MLFeatureVector;
  /** Explicitly rejected / confirmed context, never a payment or fraud label. */
  label: 0 | 1;
};
export type BehaviorMLModel = {
  status: 'insufficient_data' | 'trained';
  filter_id: HabitFilterId;
  scope: BehaviorScope;
  version: string;
  feature_version: string;
  coefficients: MLFeatureVector;
  intercept: number;
  positive: number;
  negative: number;
  samples: number;
  /** Target-scope/filter rows excluded, superseded, duplicated or unavailable. */
  excluded: number;
};
export type BehaviorMLMetrics = {
  /** Distinct labelled cases in the retrospective evaluation cohort. */
  total: number;
  /** Cases scored with a model built from strictly earlier available feedback. */
  scored: number;
  insufficient: number;
  excluded: number;
  /** Class counts among scored cases, the metric denominator. */
  positive: number;
  negative: number;
  brier: number | null;
  log_loss: number | null;
};
export type BehaviorMLDashboard = {
  mode: 'shadow';
  decision_influence: false;
  feature_version: string;
  models: Array<{
    filter_id: HabitFilterId;
    status: BehaviorMLModel['status'];
    version: string;
    positive: number;
    negative: number;
    samples: number;
    excluded: number;
    metrics: BehaviorMLMetrics;
  }>;
  predictions: Array<{
    authorization_id: string;
    filter_id: HabitFilterId;
    context_key: string;
    score: number | null;
    model_version: string | null;
    observed_label: 'confirmed' | 'rejected' | null;
    /** This display uses today's model, not a claimed historic prediction. */
    retrospective: true;
    abstention_reason: string | null;
  }>;
  notice: string;
};
