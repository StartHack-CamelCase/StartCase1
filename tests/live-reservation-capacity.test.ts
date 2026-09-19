import { describe, expect, it } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { evaluateLive, reservesLiveCapacity, type LiveBinding } from '../packages/local-runtime/src/simulation/live-engine.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import type { Assessment, HumanAnswer } from '../packages/contracts/src/simulation.js';
import type { Evaluation, LiveEntry } from '../packages/local-runtime/src/simulation/viseca-worker.js';

function setup() {
  const first = fixture('AU0002'), second = fixture('AU0003');
  first.config.parameters.rolling_budget = { days: 7, limit_chf: '150' };
  first.config.parameters.always_ask = true;
  const binding: LiveBinding = { config: first.config, live_mandate_id: first.event.mandate.mandate_id, scenario_id: first.event.authorization.scenario_id, hard_rules: first.event.mandate.hard_rules, history_hash: hash(first.pack.history), pack_version: first.pack.pack_version };
  const evaluate = (event: typeof first.event, entries: LiveEntry[], answers: HumanAnswer[] = []) => evaluateLive(first.pack, binding, event, 'LIVE', entries, first.now, answers);
  const awaiting = (event: typeof first.event, proposal: Evaluation): LiveEntry => ({ id: event.authorization.authorization_id, event, state: 'awaiting_human', decision: 'step_up', reserved: true, snapshot: binding, proposal, intent: { id: `INTENT_${event.authorization.authorization_id}`, operation: 'decision', decision: 'step_up', at: first.now }, accepted: { decision: 'step_up', at: first.now, response: { status: 'awaiting_human' } }, human_expires_at: '2026-09-20T00:00:00Z', history: [] });
  const firstEntry = awaiting(first.event, evaluate(first.event, []));
  const secondEntry = awaiting(second.event, evaluate(second.event, [firstEntry]));
  const answers = (evaluation: Evaluation): HumanAnswer[] => {
    const assessment = evaluation.snapshot as Assessment;
    return assessment.questions.map(question => ({ answer_id: `ANSWER_${question.question_id}`, question_id: question.question_id, fact_key: question.fact_key, kind: question.kind, value: 'confirm', source_ref: null, source_excerpt: null, actor: { actor_id: 'customer', role: 'simulated_human', channel: 'local_ui', authenticated_by_server: true, customer_id: first.event.mandate.customer_id }, offer_hash: assessment.offer_hash, config_revision: binding.config.revision, created_at: first.now, expires_at: '2026-09-20T00:00:00Z', consumed_by: null }));
  };
  return { first, second, binding, firstEntry, secondEntry, evaluate, answers };
}

describe('live spending capacity follows successful ledger allocation', () => {
  it('does not let a later blocked waiter deadlock the first reserved purchase', () => {
    const x = setup(), entries = [x.firstEntry, x.secondEntry];
    expect(reservesLiveCapacity(x.firstEntry)).toBe(true);
    expect(x.secondEntry.proposal!.snapshot).toMatchObject({ execution_state: 'technical_hold', technical_filter_ids: expect.arrayContaining(['C12']) });
    expect(reservesLiveCapacity(x.secondEntry)).toBe(false);
    const first = x.evaluate(x.first.event, entries);
    expect(first.snapshot).toMatchObject({ execution_state: 'awaiting_user', technical_filter_ids: [] });
    expect(x.evaluate(x.first.event, entries, x.answers(first)).decision).toBe('approve');
    // Projection does not rewrite the original pending proposal or reservations.
    expect(entries.map(entry => entry.reserved)).toEqual([true, true]);
    expect(x.secondEntry.proposal!.snapshot).toMatchObject({ technical_filter_ids: expect.arrayContaining(['C12']) });
  });

  it('makes the second purchase confirmable after the first decline is accepted', () => {
    const x = setup();
    x.firstEntry.accepted = { decision: 'decline', at: x.first.now, response: { status: 'declined' } };
    x.firstEntry.state = 'accepted'; x.firstEntry.reserved = false;
    const entries = [x.firstEntry, x.secondEntry], second = x.evaluate(x.second.event, entries);
    expect(second.snapshot).toMatchObject({ execution_state: 'awaiting_user', technical_filter_ids: [] });
    expect(x.evaluate(x.second.event, entries, x.answers(second)).decision).toBe('approve');
  });

  it('turns the second purchase into a hard budget denial after the first approval is accepted', () => {
    const x = setup();
    x.firstEntry.accepted = { decision: 'approve', at: x.first.now, response: { status: 'approved' } };
    x.firstEntry.state = 'accepted'; x.firstEntry.reserved = false;
    const second = x.evaluate(x.second.event, [x.firstEntry, x.secondEntry]);
    expect(second.decision).toBe('deny');
    expect(second.reason_codes).toContain('C10_ROLLING_BUDGET_EXCEEDED');
    expect(second.snapshot).toMatchObject({ blocking_filter_ids: expect.arrayContaining(['C10']), can_finalize: false });
  });

  it.each(['intended', 'submission_unknown'] as const)('retains capacity for an %s approval even when its old proposal was C12-blocked', state => {
    const x = setup();
    x.secondEntry.state = state;
    x.secondEntry.intent = { id: 'APPROVAL', operation: 'resolve', decision: 'approve', at: x.first.now, actor_id: 'customer' };
    expect(reservesLiveCapacity(x.secondEntry)).toBe(true);
    expect(x.evaluate(x.first.event, [x.firstEntry, x.secondEntry]).snapshot).toMatchObject({ execution_state: 'technical_hold', technical_filter_ids: expect.arrayContaining(['C12']), can_finalize: false });
  });

  it('retains unknown capacity when an earlier proposal has no reliable assessment snapshot', () => {
    const x = setup();
    x.firstEntry.proposal = null;
    expect(reservesLiveCapacity(x.firstEntry)).toBe(true);
    expect(x.evaluate(x.second.event, [x.firstEntry, x.secondEntry]).snapshot).toMatchObject({ execution_state: 'technical_hold', technical_filter_ids: expect.arrayContaining(['C12']) });
  });

  it('does not release an allocated live reservation merely because its local confirmation timer expired', () => {
    const x = setup();
    x.firstEntry.human_expires_at = x.first.now;
    expect(reservesLiveCapacity(x.firstEntry)).toBe(true);
    const blocked = x.evaluate(x.second.event, [x.firstEntry, x.secondEntry]);
    expect(blocked.snapshot).toMatchObject({ execution_state: 'technical_hold', technical_filter_ids: expect.arrayContaining(['C12']) });
    // Only an authoritative platform terminal result frees it.
    x.firstEntry.accepted = { decision: 'decline', at: x.first.now, response: { status: 'expired' } };
    x.firstEntry.state = 'accepted'; x.firstEntry.reserved = false;
    expect(x.evaluate(x.second.event, [x.firstEntry, x.secondEntry]).snapshot).toMatchObject({ execution_state: 'awaiting_user', technical_filter_ids: [] });
  });

  it('recognizes old C12 evidence questions as unallocated capacity without changing archived questions', () => {
    const x = setup();
    const assessment = x.secondEntry.proposal!.snapshot as Assessment;
    const capacity = assessment.results.find(result => result.filter_id === 'C12')!;
    capacity.outcome = 'needs_review';
    capacity.reasons[0]!.resolution_kind = 'provide_evidence';
    expect(reservesLiveCapacity(x.secondEntry)).toBe(false);
    expect(x.evaluate(x.first.event, [x.firstEntry, x.secondEntry]).snapshot).toMatchObject({ technical_filter_ids: [] });
    expect(capacity.outcome).toBe('needs_review');
    expect(capacity.reasons[0]!.resolution_kind).toBe('provide_evidence');
  });
});
