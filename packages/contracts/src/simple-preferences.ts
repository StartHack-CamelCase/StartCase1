import type { HabitFilterId } from './behavior.js';

export type SimplePreferenceContext = {
  filter_id: HabitFilterId;
  context_key: string;
  confirmed: number;
  rejected: number;
  samples: number;
  /** Smoothed explicit preference estimate; null means abstention, not zero. */
  score: number | null;
  /** Posterior dispersion under Beta-Bernoulli assumptions, not a safety bound. */
  standard_deviation: number | null;
  status: 'no_feedback' | 'learning' | 'suspended' | 'forgotten';
  reason: string | null;
};

export type SimplePreferencesDashboard = {
  algorithm: 'beta_bernoulli_v1';
  observation_only: true;
  formula: string;
  contexts: SimplePreferenceContext[];
  totals: { confirmed: number; rejected: number; contexts: number };
  notice: string;
};
