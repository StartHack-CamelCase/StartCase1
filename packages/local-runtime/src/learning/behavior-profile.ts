import { createHash } from 'node:crypto';
import type { AuthorizationEvent } from '../../../contracts/src/event.js';
import type { BehaviorHabit, BehaviorObservation, BehaviorProfile, BehaviorScope, HabitFilterId } from '../../../contracts/src/behavior.js';

const DAY_MS = 86_400_000;
const WINDOW_MS = 90 * DAY_MS;
const HALF_LIFE_MS = 30 * DAY_MS;
const FILTERS: readonly string[] = ['C15', 'C18', 'C19'];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export type BuildBehaviorProfileOptions = {
  customerId: string;
  scope: BehaviorScope;
  /** Simulated decision time: observations at this instant are not yet history. */
  asOf: string;
  timezone: string;
};

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

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
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    });
  } catch { throw new Error('behavior_timezone_invalid'); }
}

function localParts(time: number, format: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(format.formatToParts(new Date(time)).map(part => [part.type, part.value]));
}

/** Exact identifiers are retained; no merchant text or permission is interpreted. */
export function habitContext(filterId: HabitFilterId, event: AuthorizationEvent, timezone: string): string | null {
  if (!FILTERS.includes(filterId) || !event?.authorization) throw new Error('behavior_event_invalid');
  if (filterId === 'C15') return identifier(event.authorization.customer_device_id) ? event.authorization.customer_device_id : null;
  if (filterId === 'C19') return identifier(event.authorization.merchant?.merchant_country) ? event.authorization.merchant.merchant_country : null;
  const format = formatter(timezone);
  const parts = localParts(instant(event.authorization.timestamp), format);
  const startHour = Math.floor(Number(parts['hour']) / 4) * 4;
  const dayType = parts['weekday'] === 'Sat' || parts['weekday'] === 'Sun' ? 'weekend' : 'weekday';
  return `${format.resolvedOptions().timeZone}|${dayType}|${startHour}-${startHour + 4}`;
}

type ValidObservation = { observation: BehaviorObservation; occurred: number; recorded: number };

function validateObservation(observation: BehaviorObservation): ValidObservation {
  if (!observation || typeof observation !== 'object' ||
      !['local', 'live'].includes(observation.scope) || !FILTERS.includes(observation.filter_id) ||
      !['customer_id', 'source_id', 'authorization_id', 'context_key', 'actor_id'].every(key => identifier(observation[key as keyof BehaviorObservation]))) {
    throw new Error('behavior_observation_invalid');
  }
  return { observation, occurred: instant(observation.occurred_at), recorded: instant(observation.recorded_at) };
}

/** Pure, deterministic aggregation. Callers must authenticate and attribute feedback. */
export function buildBehaviorProfile(observations: readonly BehaviorObservation[], options: BuildBehaviorProfileOptions): BehaviorProfile {
  if (!options || !identifier(options.customerId) || !['local', 'live'].includes(options.scope) || !Array.isArray(observations)) throw new Error('behavior_profile_input_invalid');
  const asOf = instant(options.asOf), format = formatter(options.timezone);
  const unique = new Map<string, ValidObservation>();
  for (const input of observations) {
    const value = validateObservation(input), observation = value.observation;
    if (observation.customer_id !== options.customerId || observation.scope !== options.scope) continue;
    const key = JSON.stringify([observation.source_id, observation.filter_id]);
    const previous = unique.get(key);
    if (previous) {
      const a = previous.observation;
      // Synthetic scenarios may be replayed under a new authorization and actor.
      // Their stable source still contributes at most once to a habit.
      if (a.context_key !== observation.context_key || previous.occurred !== value.occurred) throw new Error('behavior_observation_identity_conflict');
      // A replay cannot make the source more recent or increase its influence.
      if (value.recorded < previous.recorded) unique.set(key, value);
    } else unique.set(key, value);
  }
  const groups = new Map<string, ValidObservation[]>();
  for (const value of unique.values()) {
    if (value.occurred >= asOf || value.occurred < asOf - WINDOW_MS) continue;
    const key = JSON.stringify([value.observation.filter_id, value.observation.context_key]);
    const group = groups.get(key) ?? [];
    group.push(value); groups.set(key, group);
  }
  const habits: BehaviorHabit[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.occurred - b.occurred || compare(a.observation.source_id, b.observation.source_id));
    const dates = new Set<string>();
    let effectiveCount = 0;
    for (const value of group) {
      const parts = localParts(value.occurred, format);
      const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
      if (dates.has(date)) continue;
      dates.add(date);
      // Use the first observation of the local day, so a burst cannot refresh it.
      effectiveCount += Math.exp(-Math.LN2 * (asOf - value.occurred) / HALF_LIFE_MS);
    }
    const first = group[0]!.observation;
    habits.push({
      filter_id: first.filter_id, context_key: first.context_key,
      confirmations: group.length, distinct_days: dates.size,
      effective_count: effectiveCount,
      last_confirmed_at: new Date(group.at(-1)!.occurred).toISOString(),
      learned: dates.size >= 3 && effectiveCount >= 2,
      source_ids: group.map(value => value.observation.source_id).sort(compare),
    });
  }
  habits.sort((a, b) => compare(a.filter_id, b.filter_id) || compare(a.context_key, b.context_key));
  const profile = { customer_id: options.customerId, scope: options.scope, timezone: format.resolvedOptions().timeZone, as_of: new Date(asOf).toISOString(), habits };
  const version = createHash('sha256').update(JSON.stringify({ algorithm: 'behavior-profile-v1', ...profile })).digest('hex');
  return { ...profile, version };
}
