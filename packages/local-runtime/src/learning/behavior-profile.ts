import { createHash } from 'node:crypto';
import type { AuthorizationEvent } from '../../../contracts/src/event.js';
import { DEFAULT_BEHAVIOR_PARAMETERS, validateBehaviorParameters } from '../../../contracts/src/behavior.js';
import type { BehaviorControlEvent, BehaviorHabit, BehaviorObservation, BehaviorParameters, BehaviorProfile, BehaviorScope, HabitFilterId } from '../../../contracts/src/behavior.js';

export { DEFAULT_BEHAVIOR_PARAMETERS, validateBehaviorParameters } from '../../../contracts/src/behavior.js';
export const BEHAVIOR_ALGORITHM_VERSION = 'behavior-profile-v2';
const DAY_MS = 86_400_000;
const FILTERS: readonly string[] = ['C15', 'C18', 'C19'];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type BuildBehaviorProfileOptions = {
  customerId: string;
  scope: BehaviorScope;
  /** Simulated decision time: observations at this instant are not yet history. */
  asOf: string;
  timezone: string;
  controls?: readonly BehaviorControlEvent[];
  parameters?: BehaviorParameters;
  /** Feedback without a journal sequence is unavailable when a cutoff is used. */
  availableThroughSequence?: number;
};

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function sequence(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function instant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('behavior_timestamp_invalid');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const time = Date.parse(value);
  if (!parts || !Number.isFinite(time)) throw new Error('behavior_timestamp_invalid');
  const [, year, month, day, hour, minute, second] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]! || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new Error('behavior_timestamp_invalid');
  return time;
}
function formatter(timezone: string): Intl.DateTimeFormat {
  if (!identifier(timezone)) throw new Error('behavior_timezone_invalid');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }); }
  catch { throw new Error('behavior_timezone_invalid'); }
}
function localParts(time: number, format: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(format.formatToParts(new Date(time)).map(part => [part.type, part.value]));
}
function contextKey(filterId: HabitFilterId, context: string): string { return JSON.stringify([filterId, context]); }

/** Exact identifiers are retained; no merchant text or permission is interpreted. */
export function habitContext(filterId: HabitFilterId, event: AuthorizationEvent, timezone: string): string | null {
  if (!FILTERS.includes(filterId) || !event?.authorization) throw new Error('behavior_event_invalid');
  if (filterId === 'C15') return identifier(event.authorization.customer_device_id) ? event.authorization.customer_device_id : null;
  if (filterId === 'C19') return identifier(event.authorization.merchant?.merchant_country) ? event.authorization.merchant.merchant_country : null;
  const format = formatter(timezone), parts = localParts(instant(event.authorization.timestamp), format);
  const startHour = Math.floor(Number(parts['hour']) / 4) * 4;
  const dayType = parts['weekday'] === 'Sat' || parts['weekday'] === 'Sun' ? 'weekend' : 'weekday';
  return `${format.resolvedOptions().timeZone}|${dayType}|${startHour}-${startHour + 4}`;
}

type ValidObservation = { observation: BehaviorObservation; occurred: number; recorded: number };
function validateObservation(observation: BehaviorObservation): ValidObservation {
  if (!observation || typeof observation !== 'object' || !['local', 'live'].includes(observation.scope) || !FILTERS.includes(observation.filter_id) ||
    !['customer_id', 'source_id', 'authorization_id', 'context_key', 'actor_id'].every(key => identifier(observation[key as keyof BehaviorObservation])) ||
    (observation.sequence !== undefined && !sequence(observation.sequence))) throw new Error('behavior_observation_invalid');
  return { observation, occurred: instant(observation.occurred_at), recorded: instant(observation.recorded_at) };
}
type ControlState = { filterId: HabitFilterId; context: string; generation: number; suspended: boolean; last: BehaviorControlEvent };
function controlsByContext(options: BuildBehaviorProfileOptions): Map<string, ControlState> {
  if (options.controls !== undefined && !Array.isArray(options.controls)) throw new Error('behavior_controls_invalid');
  const unique = new Map<number, BehaviorControlEvent>();
  for (const control of options.controls ?? []) {
    if (control && ((identifier(control.customer_id) && control.customer_id !== options.customerId) || (['local', 'live'].includes(control.scope) && control.scope !== options.scope))) continue;
    if (options.availableThroughSequence !== undefined && sequence(control?.sequence) && control.sequence > options.availableThroughSequence) continue;
    if (!control || !sequence(control.sequence) || !['local', 'live'].includes(control.scope) || !FILTERS.includes(control.filter_id) ||
      !['forget', 'suspend', 'resume'].includes(control.action) || !identifier(control.customer_id) || !identifier(control.context_key) || !identifier(control.actor_id)) throw new Error('behavior_control_invalid');
    instant(control.at);
    const normalized = { sequence: control.sequence, customer_id: control.customer_id, scope: control.scope, filter_id: control.filter_id, context_key: control.context_key, action: control.action, at: new Date(instant(control.at)).toISOString(), actor_id: control.actor_id };
    const previous = unique.get(control.sequence);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new Error('behavior_control_sequence_conflict');
    unique.set(control.sequence, normalized);
  }
  const states = new Map<string, ControlState>();
  for (const control of [...unique.values()].sort((a, b) => a.sequence - b.sequence)) {
    const key = contextKey(control.filter_id, control.context_key), old = states.get(key);
    const state: ControlState = { filterId: control.filter_id, context: control.context_key, generation: old?.generation ?? 0, suspended: old?.suspended ?? false, last: control };
    if (control.action === 'forget' || control.action === 'resume') state.generation = control.sequence;
    if (control.action === 'suspend') state.suspended = true;
    if (control.action === 'resume') state.suspended = false;
    states.set(key, state);
  }
  return states;
}

/** Pure, deterministic aggregation. Callers authenticate and journal feedback. */
export function buildBehaviorProfile(observations: readonly BehaviorObservation[], options: BuildBehaviorProfileOptions): BehaviorProfile {
  if (!options || !identifier(options.customerId) || !['local', 'live'].includes(options.scope) || !Array.isArray(observations) ||
    (options.availableThroughSequence !== undefined && (!Number.isSafeInteger(options.availableThroughSequence) || options.availableThroughSequence < 0))) throw new Error('behavior_profile_input_invalid');
  const asOf = instant(options.asOf), format = formatter(options.timezone);
  const parameters = validateBehaviorParameters(options.parameters ?? DEFAULT_BEHAVIOR_PARAMETERS);
  const controls = controlsByContext(options), unique = new Map<string, ValidObservation>();
  for (const input of observations) {
    // A damaged record belonging to another client/environment is not our evidence.
    if (input && ((identifier(input.customer_id) && input.customer_id !== options.customerId) || (['local', 'live'].includes(input.scope) && input.scope !== options.scope))) continue;
    if (options.availableThroughSequence !== undefined && (input?.sequence === undefined || (sequence(input.sequence) && input.sequence > options.availableThroughSequence))) continue;
    const value = validateObservation(input), observation = value.observation;
    const key = JSON.stringify([observation.source_id, observation.filter_id]), previous = unique.get(key);
    if (previous) {
      if (previous.observation.context_key !== observation.context_key || previous.occurred !== value.occurred) throw new Error('behavior_observation_identity_conflict');
      // Deduplicate BEFORE generation filtering: replay cannot revive an old source.
      const first = previous.observation.sequence ?? 0, next = observation.sequence ?? 0;
      if (next < first || (next === first && value.recorded < previous.recorded)) unique.set(key, value);
    } else unique.set(key, value);
  }
  const groups = new Map<string, ValidObservation[]>();
  for (const value of unique.values()) {
    const key = contextKey(value.observation.filter_id, value.observation.context_key), control = controls.get(key);
    if (value.occurred >= asOf || (control && (value.observation.sequence === undefined || value.observation.sequence <= control.generation))) continue;
    const group = groups.get(key) ?? []; group.push(value); groups.set(key, group);
  }
  // Explicit controls remain visible even after all evidence has expired.
  for (const key of controls.keys()) if (!groups.has(key)) groups.set(key, []);
  const habits: BehaviorHabit[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.occurred - b.occurred || compare(a.observation.source_id, b.observation.source_id));
    const control = controls.get(key), filterId = group[0]?.observation.filter_id ?? control!.filterId;
    const context = group[0]?.observation.context_key ?? control!.context;
    const p = parameters[filterId], representatives = new Map<string, ValidObservation>();
    // Choose the first daily representative over ALL history in the generation.
    // Windowing first would let later same-day evidence replace an expired proof.
    for (const value of group) {
      const parts = localParts(value.occurred, format), date = `${parts['year']}-${parts['month']}-${parts['day']}`;
      if (!representatives.has(date)) representatives.set(date, value);
    }
    const withinWindow = (v: ValidObservation): boolean => (asOf - v.occurred) / DAY_MS <= p.window_days;
    const contributing = [...representatives.values()].filter(withinWindow), recent = group.filter(withinWindow);
    if (!recent.length && !control) continue;
    const effectiveCount = contributing.reduce((sum, value) => sum + Math.pow(2, -((asOf - value.occurred) / DAY_MS) / p.half_life_days), 0);
    const learned = control?.suspended !== true && contributing.length >= p.min_distinct_days && effectiveCount >= p.min_effective_count;
    habits.push({ filter_id: filterId, context_key: context, confirmations: recent.length, distinct_days: contributing.length,
      effective_count: effectiveCount, last_confirmed_at: recent.length ? new Date(recent.at(-1)!.occurred).toISOString() : '', learned,
      source_ids: recent.map(value => value.observation.source_id).sort(compare),
      status: control?.suspended ? 'suspended' : learned ? 'learned' : recent.length ? 'learning' : control?.last.action === 'forget' ? 'forgotten' : 'learning',
      generation_sequence: control?.generation ?? 0, ...(control ? { last_control_at: control.last.at } : {}) });
  }
  habits.sort((a, b) => compare(a.filter_id, b.filter_id) || compare(a.context_key, b.context_key));
  const profile = { customer_id: options.customerId, scope: options.scope, timezone: format.resolvedOptions().timeZone, as_of: new Date(asOf).toISOString(), habits,
    algorithm_version: BEHAVIOR_ALGORITHM_VERSION, parameter_version: hash(parameters), parameters,
    ...(options.availableThroughSequence !== undefined ? { available_through_sequence: options.availableThroughSequence } : {}) };
  return { ...profile, version: hash(profile) };
}
