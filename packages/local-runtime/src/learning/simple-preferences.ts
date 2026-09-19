import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import type { BehaviorObservation, BehaviorScope, HabitFilterId } from '../../../contracts/src/behavior.js';
import type { SimplePreferenceContext, SimplePreferencesDashboard } from '../../../contracts/src/simple-preferences.js';
import type { MLContextRecord, MLDataset } from './behavior-ml-projection.js';

const FILTERS: readonly string[] = ['C15', 'C18', 'C19'];
const key = (filter: HabitFilterId, context: string): string => JSON.stringify([filter, context]);
const sourceKey = (customer: string, scope: BehaviorScope, filter: HabitFilterId, id: string): string => JSON.stringify([customer, scope, filter, id]);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) return NaN;
  const [date, time] = value.split('T'), [year, month, day] = date!.split('-').map(Number), parts = time!.slice(0, 8).split(':').map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! && parts[0]! < 24 && parts[1]! < 60 && parts[2]! < 60 ? parsed : NaN;
}
type ContextState = { filter_id: HabitFilterId; context_key: string; generation: number; suspended: boolean; forgotten: boolean; conflict: boolean; confirmed: number; rejected: number };

/** One posterior per exact customer/scope/filter/context. This pure projection
 * never supplies a payment decision and never reads or updates model features. */
export function projectSimplePreferences(dataset: MLDataset, journal: BehaviorJournal, customerId: string, scope: BehaviorScope, asOf: string): SimplePreferencesDashboard {
  const cutoff = instant(asOf);
  if (!text(customerId) || !['local', 'live'].includes(scope) || !Number.isFinite(cutoff)) throw Error('simple_preferences_input_invalid');
  const contexts = new Map<string, ContextState>();
  const context = (filter_id: HabitFilterId, context_key: string): ContextState => {
    const id = key(filter_id, context_key); let state = contexts.get(id);
    if (!state) { state = { filter_id, context_key, generation: 0, suspended: false, forgotten: false, conflict: false, confirmed: 0, rejected: 0 }; contexts.set(id, state); }
    return state;
  };
  let invalid = journal.invalid_profiles?.some(p => p.customer_id === customerId && p.scope === scope) === true;
  const controls = journal.controls.filter(c => c.customer_id === customerId && c.scope === scope).sort((a, b) => a.sequence - b.sequence);
  for (const c of controls) {
    const at = instant(c.at);
    if (!Number.isFinite(at)) { invalid = true; continue; }
    if (at > cutoff) continue;
    if (!FILTERS.includes(c.filter_id) || !text(c.context_key) || !Number.isSafeInteger(c.sequence) || c.sequence < 1 || !['forget', 'suspend', 'resume'].includes(c.action)) { invalid = true; continue; }
    const state = context(c.filter_id, c.context_key);
    if (c.action === 'forget' || c.action === 'resume') { state.generation = c.sequence; state.forgotten = c.action === 'forget'; }
    if (c.action === 'suspend') state.suspended = true;
    if (c.action === 'resume') state.suspended = false;
  }
  const records = new Map<string, MLContextRecord[]>();
  for (const record of dataset.records) {
    if (record.customer_id !== customerId || record.scope !== scope) continue;
    const s = record.snapshot, predicted = instant(s.predicted_at);
    if (!FILTERS.includes(s.filter_id) || !text(s.context_key) || !text(s.source_id) || !Number.isFinite(predicted) || predicted > cutoff || !Number.isSafeInteger(s.knowledge_sequence) || s.knowledge_sequence < 0) continue;
    context(s.filter_id, s.context_key);
    const id = sourceKey(customerId, scope, s.filter_id, s.source_id), group = records.get(id) ?? [];
    group.push(record); records.set(id, group);
  }
  // Accepted, journalled confirmations predate frozen context snapshots in some
  // profiles. They are sufficient for these counts; they never become ML features.
  const observations = new Map<string, Array<BehaviorObservation & { sequence: number }>>();
  const durableSequence = (sequence: number | undefined): sequence is number => Number.isSafeInteger(sequence) && sequence! > 0 && sequence! <= journal.sequence;
  for (const o of journal.observations) {
    if (o.customer_id !== customerId || o.scope !== scope || !FILTERS.includes(o.filter_id) ||
      ![o.source_id, o.authorization_id, o.context_key, o.actor_id].every(text) || !durableSequence(o.sequence) ||
      !Number.isFinite(instant(o.occurred_at)) || !Number.isFinite(instant(o.recorded_at)) || instant(o.recorded_at) > cutoff) continue;
    context(o.filter_id, o.context_key);
    const id = sourceKey(customerId, scope, o.filter_id, o.source_id), group = observations.get(id) ?? [];
    group.push({ ...o, sequence: o.sequence }); observations.set(id, group);
  }
  const labels = new Map<string, Array<{ prediction: number; at: number; label: 0 | 1 }>>();
  for (const e of dataset.examples) {
    if (e.customer_id !== customerId || e.scope !== scope || !FILTERS.includes(e.filter_id) || !text(e.id) || (e.label !== 0 && e.label !== 1)) continue;
    const at = instant(e.label_at), prediction = instant(e.predicted_at);
    if (!Number.isFinite(at) || !Number.isFinite(prediction) || at >= cutoff || at < prediction) continue;
    const id = sourceKey(customerId, scope, e.filter_id, e.id), group = labels.get(id) ?? [];
    group.push({ at, prediction, label: e.label }); labels.set(id, group);
  }
  for (const id of new Set([...records.keys(), ...observations.keys()])) {
    const group = records.get(id) ?? [], confirmations = observations.get(id) ?? [];
    // Choose the original snapshot before generation filtering: an authorization
    // replay cannot make an old source a new confirmation after forgetting it.
    group.sort((a, b) => a.snapshot.knowledge_sequence - b.snapshot.knowledge_sequence || instant(a.snapshot.predicted_at) - instant(b.snapshot.predicted_at));
    confirmations.sort((a, b) => a.sequence - b.sequence || instant(a.recorded_at) - instant(b.recorded_at));
    const s = group[0]?.snapshot, first = confirmations[0], identity = s ?? first!, state = context(identity.filter_id, identity.context_key);
    if (group.some(r => r.snapshot.context_key !== identity.context_key) || confirmations.some(o => o.context_key !== identity.context_key || instant(o.occurred_at) !== instant(first!.occurred_at))) {
      for (const r of group) context(r.snapshot.filter_id, r.snapshot.context_key).conflict = true;
      for (const o of confirmations) context(o.filter_id, o.context_key).conflict = true;
      continue;
    }
    if ((s && s.knowledge_sequence < state.generation) || (first && first.sequence <= state.generation)) continue;
    const versions: Array<{ at: number; label: 0 | 1 }> = s ? (labels.get(id) ?? []).filter(e => e.prediction === instant(s.predicted_at)) : [];
    // An older journal origin remains authoritative when its first snapshot was
    // only captured on a later replay. That replay cannot reset its generation.
    if (first && (!s || first.sequence <= s.knowledge_sequence)) {
      const at = instant(first.recorded_at);
      if (at < cutoff) versions.push({ at, label: 1 });
      const authorizations = new Set([...confirmations.map(o => o.authorization_id), ...group.map(r => r.authorization_id)]);
      const timezone = first.filter_id === 'C18' ? first.context_key.split('|')[0] : undefined;
      const reviewSource = timezone && first.source_id.endsWith(`:${timezone}`) ? first.source_id.slice(0, -timezone.length - 1) : first.source_id;
      for (const review of journal.reviews ?? []) {
        const reviewed = instant(review.at);
        if (review.customer_id !== customerId || review.scope !== scope || review.filter_id !== first.filter_id || review.context_key !== first.context_key ||
          (review.source_id !== first.source_id && review.source_id !== reviewSource) || !authorizations.has(review.authorization_id) || !text(review.actor_id) ||
          !durableSequence(review.sequence) || review.sequence <= first.sequence || !['confirmed', 'rejected'].includes(review.verdict) ||
          !Number.isFinite(reviewed) || reviewed < at || reviewed >= cutoff) continue;
        versions.push({ at: reviewed, label: review.verdict === 'confirmed' ? 1 : 0 });
      }
    }
    versions.sort((a, b) => a.at - b.at);
    const latest = versions.at(-1); if (!latest) continue;
    // Corrections replace one source's verdict; they never add a new sample.
    if (versions.some(e => e.at === latest.at && e.label !== latest.label)) { state.conflict = true; continue; }
    if (latest.label === 1) state.confirmed++; else state.rejected++;
  }
  const rows: SimplePreferenceContext[] = [...contexts.values()].map(c => {
    const samples = c.confirmed + c.rejected;
    const status: SimplePreferenceContext['status'] = c.suspended ? 'suspended' : samples ? 'learning' : c.forgotten ? 'forgotten' : 'no_feedback';
    const reason = invalid ? 'Profile evidence is inconsistent; no preference estimate is displayed.'
      : c.suspended ? 'This context is suspended; its explicit feedback remains visible.'
        : c.conflict ? 'Conflicting source feedback was excluded.'
          : !samples ? c.forgotten ? 'Earlier feedback was forgotten. New sources are required.' : 'No explicit feedback is available for this context.' : null;
    const abstain = invalid || c.suspended || !samples;
    const a = c.confirmed + 1, b = c.rejected + 1, total = a + b;
    return { filter_id: c.filter_id, context_key: c.context_key, confirmed: c.confirmed, rejected: c.rejected, samples,
      score: abstain ? null : a / total, standard_deviation: abstain ? null : Math.sqrt(a * b / (total * total * (total + 1))), status, reason };
  }).sort((a, b) => compare(a.filter_id, b.filter_id) || compare(a.context_key, b.context_key));
  return {
    algorithm: 'beta_bernoulli_v1', observation_only: true, formula: '(confirmed + 1) / (confirmed + rejected + 2)', contexts: rows,
    totals: { confirmed: rows.reduce((sum, c) => sum + c.confirmed, 0), rejected: rows.reduce((sum, c) => sum + c.rejected, 0), contexts: rows.length },
    notice: 'A simple Beta(1,1) model of explicit context preferences, separate for each customer, environment and filter. Corrections replace prior feedback; missing feedback is not a confirmation. The score and dispersion describe this observed sample under the model assumptions, not payment safety or fraud. This model never changes payment decisions.',
  };
}
