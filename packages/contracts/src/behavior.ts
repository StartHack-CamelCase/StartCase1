export type HabitFilterId = 'C15' | 'C18' | 'C19';
export type BehaviorScope = 'local' | 'live';
export type BehaviorFilterParameters = {
  min_distinct_days: number;
  min_effective_count: number;
  half_life_days: number;
  window_days: number;
};
export type BehaviorParameters = Record<HabitFilterId, BehaviorFilterParameters>;

export const DEFAULT_BEHAVIOR_PARAMETERS: BehaviorParameters = Object.freeze({
  C15: Object.freeze({ min_distinct_days: 3, min_effective_count: 2, half_life_days: 30, window_days: 90 }),
  C18: Object.freeze({ min_distinct_days: 3, min_effective_count: 2, half_life_days: 30, window_days: 90 }),
  C19: Object.freeze({ min_distinct_days: 3, min_effective_count: 2, half_life_days: 30, window_days: 90 }),
});

/** Validation returns an independent, canonical copy suitable for hashing. */
export function validateBehaviorParameters(value: unknown): BehaviorParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'C15,C18,C19') throw new Error('behavior_parameters_invalid');
  const output = {} as BehaviorParameters;
  for (const id of ['C15', 'C18', 'C19'] as const) {
    const p = (value as Record<string, unknown>)[id];
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'half_life_days,min_distinct_days,min_effective_count,window_days') throw new Error('behavior_parameters_invalid');
    const fields = p as Record<string, unknown>;
    const days = fields['min_distinct_days'];
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) throw new Error('behavior_parameters_invalid');
    for (const key of ['min_effective_count', 'half_life_days', 'window_days']) {
      const number = fields[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) throw new Error('behavior_parameters_invalid');
    }
    output[id] = { min_distinct_days: days, min_effective_count: fields['min_effective_count'] as number, half_life_days: fields['half_life_days'] as number, window_days: fields['window_days'] as number };
  }
  return output;
}

/** An authenticated confirmation of a specific context, not a fraud label. */
export type BehaviorObservation = {
  customer_id: string;
  scope: BehaviorScope;
  source_id: string;
  authorization_id: string;
  filter_id: HabitFilterId;
  context_key: string;
  /** Simulated purchase time; used for decay and local calendar dates. */
  occurred_at: string;
  /** Real recording time; provenance only, separate from the simulated clock. */
  recorded_at: string;
  actor_id: string;
  /** Durable order in which feedback became available, never a simulated clock. */
  sequence?: number;
};

export type BehaviorControlEvent = {
  sequence: number;
  customer_id: string;
  scope: BehaviorScope;
  filter_id: HabitFilterId;
  context_key: string;
  action: 'forget' | 'suspend' | 'resume';
  /** Receipt time for provenance. Ordering is exclusively by journal sequence. */
  at: string;
  actor_id: string;
};

export type BehaviorHabit = {
  filter_id: HabitFilterId;
  context_key: string;
  confirmations: number;
  distinct_days: number;
  effective_count: number;
  /** Empty for a control-only context with no eligible confirmation. */
  last_confirmed_at: string;
  learned: boolean;
  source_ids: string[];
  status?: 'learning' | 'learned' | 'forgotten' | 'suspended';
  generation_sequence?: number;
  last_control_at?: string;
};

export type BehaviorProfile = {
  warning?: string;
  customer_id: string;
  scope: BehaviorScope;
  timezone: string;
  version: string;
  as_of: string;
  habits: BehaviorHabit[];
  algorithm_version?: string;
  parameter_version?: string;
  parameters?: BehaviorParameters;
  available_through_sequence?: number;
};
