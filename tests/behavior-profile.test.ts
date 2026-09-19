import { describe, expect, it } from 'vitest';
import type { AuthorizationEvent } from '../packages/contracts/src/event.js';
import type { BehaviorObservation } from '../packages/contracts/src/behavior.js';
import { buildBehaviorProfile, habitContext } from '../packages/local-runtime/src/learning/behavior-profile.js';

const options = { customerId: 'customer-1', scope: 'local' as const, asOf: '2026-09-19T12:00:00.000Z', timezone: 'Europe/Zurich' };
function observation(sourceId: string, occurredAt: string, overrides: Partial<BehaviorObservation> = {}): BehaviorObservation {
  return { customer_id: 'customer-1', scope: 'local', source_id: sourceId, authorization_id: `authorization-${sourceId}`, filter_id: 'C15', context_key: 'device-1', occurred_at: occurredAt, recorded_at: '2026-09-19T13:00:00.000Z', actor_id: 'owner-1', ...overrides };
}
const recent = () => [17, 18, 19].map(day => observation(`day-${day}`, `2026-09-${day}T08:00:00.000Z`));
const event = (timestamp: string, device = 'Device-A', country = 'CH') => ({ authorization: { timestamp, customer_device_id: device, merchant: { merchant_country: country } } }) as AuthorizationEvent;

describe('behavior profile aggregation', () => {
  it('keeps cold start empty and a single confirmation unlearned', () => {
    expect(buildBehaviorProfile([], options).habits).toEqual([]);
    expect(buildBehaviorProfile(recent().slice(0, 1), options).habits[0]).toMatchObject({ confirmations: 1, distinct_days: 1, learned: false });
  });

  it('learns after three recent distinct local dates without mixing scopes or customers', () => {
    const foreign = recent().flatMap(o => [{ ...o, customer_id: 'other' }, { ...o, scope: 'live' as const }]);
    const profile = buildBehaviorProfile([...recent(), ...foreign], options);
    expect(profile.habits).toHaveLength(1);
    expect(profile.habits[0]).toMatchObject({ confirmations: 3, distinct_days: 3, learned: true });
    expect(profile.habits[0]!.effective_count).toBeGreaterThan(2);
    expect(buildBehaviorProfile(foreign, { ...options, customerId: 'missing' }).habits).toEqual([]);
  });

  it('deduplicates source and filter and is deterministic under input reordering', () => {
    const rows = recent();
    const original = buildBehaviorProfile(rows, options);
    const duplicate = { ...rows[0]!, authorization_id: 'replayed-authorization', actor_id: 'replay-actor', recorded_at: '2026-09-20T12:00:00.000Z' };
    expect(buildBehaviorProfile([...rows, duplicate].reverse(), options)).toEqual(original);
    expect(original.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a source reused for a contradictory context or simulated time', () => {
    const row = recent()[0]!;
    expect(() => buildBehaviorProfile([row, { ...row, context_key: 'other-device' }], options)).toThrow('behavior_observation_identity_conflict');
    expect(() => buildBehaviorProfile([row, { ...row, occurred_at: '2026-09-18T08:00:00.000Z' }], options)).toThrow('behavior_observation_identity_conflict');
    expect(() => buildBehaviorProfile([row, { ...row, occurred_at: '2026-09-20T08:00:00.000Z' }], options)).toThrow('behavior_observation_identity_conflict');
  });

  it('caps influence at one observation per local date, filter and context', () => {
    const burst = Array.from({ length: 100 }, (_, i) => observation(`burst-${i}`, `2026-09-18T${String(1 + i % 20).padStart(2, '0')}:00:00.000Z`));
    const profile = buildBehaviorProfile(burst, options);
    expect(profile.habits[0]).toMatchObject({ confirmations: 100, distinct_days: 1, learned: false });
    expect(profile.habits[0]!.effective_count).toBeLessThan(1);
    expect(profile.habits[0]!.effective_count).toBe(buildBehaviorProfile(burst.slice(0, 1), options).habits[0]!.effective_count);
  });

  it('uses local dates rather than UTC dates for the daily influence cap', () => {
    const rows = [observation('a', '2026-09-17T23:30:00.000Z'), observation('b', '2026-09-18T00:30:00.000Z')];
    expect(buildBehaviorProfile(rows, options).habits[0]!.distinct_days).toBe(1);
    expect(buildBehaviorProfile(rows, { ...options, timezone: 'UTC' }).habits[0]!.distinct_days).toBe(2);
  });

  it('excludes current and future purchases and observations older than ninety days', () => {
    const profile = buildBehaviorProfile([
      observation('now', options.asOf), observation('future', '2026-09-20T00:00:00.000Z'),
      observation('old', '2026-06-20T12:00:00.000Z'),
    ], options);
    expect(profile.habits).toEqual([]);
  });

  it('decays influence by half every thirty days and retires stale habits', () => {
    const row = observation('thirty-days', '2026-08-20T12:00:00.000Z');
    expect(buildBehaviorProfile([row], options).habits[0]!.effective_count).toBeCloseTo(0.5, 12);
    const later = buildBehaviorProfile(recent(), { ...options, asOf: '2026-10-19T12:00:00.000Z' });
    expect(later.habits[0]).toMatchObject({ distinct_days: 3, learned: false });
    expect(buildBehaviorProfile(recent(), { ...options, asOf: '2027-01-01T00:00:00.000Z' }).habits).toEqual([]);
  });

  it('keeps filter and context evidence independent', () => {
    const base = recent();
    const profile = buildBehaviorProfile([...base, ...base.map(o => ({ ...o, filter_id: 'C19' as const, context_key: 'CH' })), observation('other', '2026-09-18T08:00:00.000Z', { context_key: 'device-2' })], options);
    expect(profile.habits.map(h => [h.filter_id, h.context_key, h.learned])).toEqual([['C15', 'device-1', true], ['C15', 'device-2', false], ['C19', 'CH', true]]);
  });

  it('validates identities, dates, scope, filter and timezone without mutating input', () => {
    const rows = recent(), before = structuredClone(rows);
    buildBehaviorProfile(rows, options);
    expect(rows).toEqual(before);
    for (const patch of [{ actor_id: '' }, { source_id: '' }, { occurred_at: '2026-02-30T08:00:00Z' }, { recorded_at: 'not-a-date' }, { scope: 'unknown' }, { filter_id: 'C09' }]) {
      expect(() => buildBehaviorProfile([{ ...rows[0]!, ...patch } as BehaviorObservation], options)).toThrow();
    }
    expect(() => buildBehaviorProfile([], { ...options, timezone: 'not-a-zone' })).toThrow('behavior_timezone_invalid');
  });
});

describe('habit context', () => {
  it('preserves exact device and country identities without learning from missing values', () => {
    const e = event('2026-09-18T10:00:00Z');
    expect(habitContext('C15', e, 'Europe/Zurich')).toBe('Device-A');
    expect(habitContext('C19', e, 'Europe/Zurich')).toBe('CH');
    expect(habitContext('C15', event('2026-09-18T10:00:00Z', ''), 'Europe/Zurich')).toBeNull();
    expect(habitContext('C19', event('2026-09-18T10:00:00Z', 'd', ''), 'Europe/Zurich')).toBeNull();
  });

  it('separates weekday/weekend and four-hour buckets using the policy timezone', () => {
    expect(habitContext('C18', event('2026-09-18T21:00:00Z'), 'Europe/Zurich')).toBe('Europe/Zurich|weekday|20-24');
    expect(habitContext('C18', event('2026-09-18T23:00:00Z'), 'Europe/Zurich')).toBe('Europe/Zurich|weekend|0-4');
    expect(habitContext('C18', event('2026-09-18T23:00:00Z'), 'UTC')).toBe('UTC|weekday|20-24');
  });
});
