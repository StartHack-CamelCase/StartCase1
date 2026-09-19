import { describe, expect, it } from 'vitest';
import type { AuthorizationEvent } from '../packages/contracts/src/event.js';
import type { BehaviorControlEvent, BehaviorObservation } from '../packages/contracts/src/behavior.js';
import { buildBehaviorProfile, habitContext, DEFAULT_BEHAVIOR_PARAMETERS, validateBehaviorParameters } from '../packages/local-runtime/src/learning/behavior-profile.js';

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

const sequenced = () => recent().map((o, i) => ({ ...o, sequence: i + 1 }));
const control = (action:BehaviorControlEvent['action'], sequence=4, patch:Partial<BehaviorControlEvent>={}):BehaviorControlEvent => ({
  sequence, customer_id:options.customerId, scope:options.scope, filter_id:'C15', context_key:'device-1', action, at:'2026-09-19T14:00:00Z', actor_id:'owner-1', ...patch,
});

describe('adaptive profile mathematical and temporal invariants',()=>{
  it('validates parameters independently and records deterministic parameter and algorithm versions',()=>{
    const parameters=validateBehaviorParameters(DEFAULT_BEHAVIOR_PARAMETERS);
    parameters.C18.min_distinct_days=4;
    const base=buildBehaviorProfile(recent(),options),changed=buildBehaviorProfile(recent(),{...options,parameters});
    expect(changed.habits).toEqual(base.habits);
    expect(changed.algorithm_version).toBe('behavior-profile-v2');
    expect(changed.parameter_version).not.toBe(base.parameter_version);
    expect(DEFAULT_BEHAVIOR_PARAMETERS.C18.min_distinct_days).toBe(3);
    expect(changed.version).not.toBe(base.version);
    for(const patch of [{min_distinct_days:0},{min_distinct_days:2.5},{min_effective_count:0},{min_effective_count:NaN},{half_life_days:0},{half_life_days:Infinity},{window_days:-1}]){
      expect(()=>validateBehaviorParameters({...parameters,C15:{...parameters.C15,...patch}})).toThrow('behavior_parameters_invalid');
    }
    expect(()=>validateBehaviorParameters({...parameters,C99:parameters.C15})).toThrow();
  });

  it('adjusts one filter without changing evidence or thresholds of another filter',()=>{
    const rows=recent().flatMap(o=>[o,{...o,filter_id:'C19' as const,context_key:'CH'}]);
    const parameters=validateBehaviorParameters(DEFAULT_BEHAVIOR_PARAMETERS);parameters.C19.min_distinct_days=4;
    const profile=buildBehaviorProfile(rows,{...options,parameters});
    expect(profile.habits.map(h=>[h.filter_id,h.learned])).toEqual([['C15',true],['C19',false]]);
    expect(profile.habits[0]!.effective_count).toBe(profile.habits[1]!.effective_count);
  });

  it('requires both distinct days and decayed weight even with custom parameters',()=>{
    const parameters=validateBehaviorParameters(DEFAULT_BEHAVIOR_PARAMETERS);parameters.C15.min_distinct_days=4;parameters.C15.min_effective_count=0.1;
    expect(buildBehaviorProfile(recent(),{...options,parameters}).habits[0]!.learned).toBe(false);
    parameters.C15.min_distinct_days=1;parameters.C15.min_effective_count=3;
    expect(buildBehaviorProfile(recent(),{...options,parameters}).habits[0]!.learned).toBe(false);
  });

  it('never gains evidence when time passes with a fixed past history, including window exits',()=>{
    const rows=[observation('first','2026-09-18T00:01:00Z'),observation('later-same-day','2026-09-18T10:00:00Z'),observation('other-day','2026-09-17T10:00:00Z')];
    const parameters=validateBehaviorParameters(DEFAULT_BEHAVIOR_PARAMETERS);parameters.C15.window_days=2;
    let previous=Infinity;
    for(let offset=0;offset<=96;offset++){
      const asOf=new Date(Date.parse('2026-09-18T12:00:00Z')+offset*3_600_000).toISOString();
      const h=buildBehaviorProfile(rows,{...options,asOf,parameters}).habits[0],weight=h?.effective_count??0;
      expect(weight).toBeLessThanOrEqual(previous);
      if(h)expect(weight).toBeLessThanOrEqual(h.distinct_days);
      previous=weight;
    }
    const afterFirstExpires=buildBehaviorProfile(rows,{...options,asOf:'2026-09-20T01:00:00Z',parameters}).habits[0]!;
    expect(afterFirstExpires).toMatchObject({confirmations:1,distinct_days:0,effective_count:0,learned:false});
  });

  it('halves exactly between window exits under a custom half-life',()=>{
    const rows=recent(),parameters=validateBehaviorParameters(DEFAULT_BEHAVIOR_PARAMETERS);parameters.C15.half_life_days=5;
    const initial=buildBehaviorProfile(rows,{...options,parameters}).habits[0]!.effective_count;
    const later=buildBehaviorProfile(rows,{...options,parameters,asOf:'2026-09-24T12:00:00Z'}).habits[0]!.effective_count;
    expect(later).toBeCloseTo(initial/2,12);
  });

  it('does not confuse simulated time and the knowledge-availability sequence',()=>{
    const rows=sequenced().map(o=>({...o,recorded_at:'2030-01-01T00:00:00Z'}));
    expect(buildBehaviorProfile(rows,{...options,availableThroughSequence:2}).habits[0]).toMatchObject({confirmations:2,learned:false});
    expect(buildBehaviorProfile(rows,{...options,availableThroughSequence:3}).habits[0]!.learned).toBe(true);
    expect(buildBehaviorProfile(recent(),{...options,availableThroughSequence:100}).habits).toEqual([]);
    const future=observation('future',options.asOf,{sequence:1});
    expect(buildBehaviorProfile([future],{...options,availableThroughSequence:100}).habits).toEqual([]);
    expect(()=>buildBehaviorProfile(rows,{...options,availableThroughSequence:-1})).toThrow();
  });

  it('reconstructs the old snapshot without a later feedback record or correction',()=>{
    const rows=sequenced(),before=buildBehaviorProfile(rows.slice(0,2),{...options,availableThroughSequence:2});
    expect(buildBehaviorProfile([...rows,{...rows[0]!,sequence:9,context_key:'contradictory-later-data'}],{...options,controls:[control('forget',8)],availableThroughSequence:2})).toEqual(before);
  });

  it('forgets a generation and cannot resurrect it through a source replay',()=>{
    const rows=sequenced(),controls=[control('forget')];
    const forgotten=buildBehaviorProfile(rows,{...options,controls});
    expect(forgotten.habits[0]).toMatchObject({status:'forgotten',generation_sequence:4,confirmations:0,effective_count:0,learned:false});
    const replays=rows.map(o=>({...o,sequence:o.sequence+10,authorization_id:'replay'}));
    expect(buildBehaviorProfile([...rows,...replays],{...options,controls})).toEqual(forgotten);
    const fresh=rows.map(o=>({...o,source_id:`new-${o.source_id}`,sequence:o.sequence+4}));
    expect(buildBehaviorProfile([...rows,...fresh],{...options,controls}).habits[0]).toMatchObject({status:'learned',confirmations:3,learned:true});
    expect(buildBehaviorProfile(recent(),{...options,controls}).habits[0]!.confirmations).toBe(0);
  });

  it('suspends independently of passing time and needs explicit resume with fresh proof',()=>{
    const rows=sequenced();
    expect(buildBehaviorProfile(rows,{...options,controls:[control('suspend')]}).habits[0]).toMatchObject({status:'suspended',learned:false});
    expect(buildBehaviorProfile(rows,{...options,asOf:'2027-01-01T00:00:00Z',controls:[control('suspend')]}).habits[0]).toMatchObject({status:'suspended',confirmations:0,learned:false});
    expect(buildBehaviorProfile(rows,{...options,controls:[control('suspend'),control('forget',5)]}).habits[0]!.status).toBe('suspended');
    expect(buildBehaviorProfile(rows,{...options,controls:[control('suspend'),control('resume',5)]}).habits[0]).toMatchObject({status:'learning',generation_sequence:5,confirmations:0,learned:false});
  });

  it('orders controls by journal sequence, isolates their scope, and rejects conflicting sequences',()=>{
    const rows=sequenced(),controls=[control('resume',5,{at:'2020-01-01T00:00:00Z'}),control('suspend',4,{at:'2030-01-01T00:00:00Z'})];
    const a=buildBehaviorProfile(rows,{...options,controls});
    expect(buildBehaviorProfile([...rows].reverse(),{...options,controls:[...controls].reverse()})).toEqual(a);
    expect(a.habits[0]!.status).toBe('learning');
    expect(buildBehaviorProfile(rows,{...options,controls:[control('suspend',4,{customer_id:'other'}),control('suspend',5,{scope:'live'})]}).habits[0]!.learned).toBe(true);
    expect(()=>buildBehaviorProfile(rows,{...options,controls:[control('suspend'),control('resume')]})).toThrow('behavior_control_sequence_conflict');
  });

  it('does not let malformed evidence belonging to someone else poison this profile',()=>{
    const bad=observation('', 'not-a-date',{customer_id:'other',actor_id:'',sequence:-9});
    const malformedControl=control('suspend',-1,{customer_id:'other',at:'not-a-date'});
    expect(buildBehaviorProfile([...recent(),bad],{...options,controls:[malformedControl]})).toEqual(buildBehaviorProfile(recent(),options));
    expect(buildBehaviorProfile([...recent(),{...bad,customer_id:options.customerId,scope:'live'}],options)).toEqual(buildBehaviorProfile(recent(),options));
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
