export type HabitFilterId = 'C15' | 'C18' | 'C19';
export type BehaviorScope = 'local' | 'live';

/** An authenticated confirmation of a specific context, not a fraud label. */
export type BehaviorObservation = {
  customer_id: string;
  scope: BehaviorScope;
  source_id: string;
  authorization_id: string;
  filter_id: HabitFilterId;
  context_key: string;
  /** Simulated purchase time; used for windows and ordering. */
  occurred_at: string;
  /** Real recording time; provenance only, separate from the simulated clock. */
  recorded_at: string;
  actor_id: string;
};

export type BehaviorHabit = {
  filter_id: HabitFilterId;
  context_key: string;
  confirmations: number;
  distinct_days: number;
  effective_count: number;
  last_confirmed_at: string;
  learned: boolean;
  source_ids: string[];
};

export type BehaviorProfile = {
  warning?: string;
  customer_id: string;
  scope: BehaviorScope;
  timezone: string;
  version: string;
  as_of: string;
  habits: BehaviorHabit[];
};
