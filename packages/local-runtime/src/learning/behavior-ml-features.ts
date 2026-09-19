import type { BehaviorProfile, HabitFilterId } from '../../../contracts/src/behavior.js';
import type { FilterResult } from '../../../contracts/src/simulation.js';
import { SIMPLE_CONTEXT_VERSION, type MLFeatureSnapshot } from '../../../contracts/src/behavior-ml.js';
import { type EvaluationContext } from '../simulation/common.js';
import { habitContext } from './behavior-profile.js';

const reasons: Record<HabitFilterId, string> = { C15: 'C15_DEVICE_CONFIRMATION_REQUIRED', C18: 'C18_UNUSUAL_TIME', C19: 'C19_COUNTRY_CONFIRMATION_REQUIRED' };

/** Capture only context identity available before the first human reply.
 * Kept in the existing snapshot field for backward-compatible persistence. No model, fitting,
 * labels or free-form merchant text is involved in the payment path. */
export function captureBehaviorMLFeatures(ctx: EvaluationContext, profile: BehaviorProfile, results: readonly FilterResult[]): MLFeatureSnapshot[] {
  if (ctx.answers.length || profile.warning) return [];
  try {
    const a = ctx.event.authorization, timezone = profile.timezone;
    const output: MLFeatureSnapshot[] = [];
    for (const filter_id of ['C15', 'C18', 'C19'] as const) {
      const r = results.find(r => r.filter_id === filter_id);
      if (r?.outcome !== 'needs_review' || !r.reasons.some(r => r.code === reasons[filter_id]) || (filter_id === 'C18' && ctx.config.parameters.time_review !== null)) continue;
      const context_key = habitContext(filter_id, ctx.event, timezone); if (context_key === null) continue;
      const habit = profile.habits.find(h => h.filter_id === filter_id && h.context_key === context_key);
      output.push({ schema_version: 1, feature_version: SIMPLE_CONTEXT_VERSION, predicted_at: ctx.now, filter_id, context_key, features: [],
        source_id: `${ctx.pack.pack_version}:${a.source_authorization_id}${filter_id === 'C18' ? `:${timezone}` : ''}`, knowledge_sequence: profile.available_through_sequence ?? 0,
        was_suppressed: false, eligible: habit?.status !== 'suspended' });
    }
    return output;
  } catch { return []; } // Optional telemetry must never affect ordinary checks.
}
