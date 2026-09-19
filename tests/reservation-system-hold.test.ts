import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import { createLocalRuntime } from '../packages/local-runtime/src/runtime.js';
import type { HumanActor, HumanAnswer, SafetyParameters } from '../packages/contracts/src/simulation.js';

function reserved(parameters: Partial<SafetyParameters> = { rolling_budget: { days: 7, limit_chf: '100' } }) {
  const ctx = fixture('AU0001');
  Object.assign(ctx.config.parameters, parameters);
  ctx.run.reservations = [{ authorization_id: 'OTHER', amount_chf: '90', timestamp: ctx.event.authorization.timestamp, quantity: 1, budget_scope_id: ctx.run.budget_scope_id, offer_hash: 'OTHER_OFFER', expires_at: '2026-09-20T00:00:00Z' }];
  return ctx;
}

describe('budget reservations are system holds, never customer evidence questions', () => {
  it.each([
    { rolling_budget: { days: 7, limit_chf: '100' } },
    { daily_budget_chf: '100' },
    { monthly_budget_chf: '100' },
    { mission_quantity: 1 },
  ])('pauses a conflicting capacity check without a C12 question: %j', parameters => {
    const assessment = assess(reserved(parameters));
    expect(assessment).toMatchObject({ decision: null, execution_state: 'technical_hold', can_finalize: false, questions: [], technical_filter_ids: expect.arrayContaining(['C12']), lock: { resolution: 'retry_or_repair' } });
    expect(assessment.results.find(result => result.filter_id === 'C12')).toMatchObject({ outcome: 'not_evaluated', question_ids: [], reasons: [expect.objectContaining({ code: 'C12_BUDGET_RESERVED_ELSEWHERE', effect: 'technical_hold', resolution_kind: 'retry_or_repair' })], evidence: [expect.objectContaining({ source_type: 'ledger' })] });
    expect(assessment.blocking_filter_ids).not.toContain('C10');
  });

  it.each(['confirm_risk', 'confirm_requirement', 'provide_evidence'] as const)('cannot release a ledger reservation using a forged %s response', kind => {
    const ctx = reserved();
    const answer: HumanAnswer = { answer_id: 'FAKE', question_id: 'Q_' + hash([ctx.offer_hash, 'C12']).slice(0, 20), fact_key: 'C12', kind, value: 'confirm', source_ref: 'customer', source_excerpt: 'The budget is free.', actor: { actor_id: 'customer', role: 'simulated_human', channel: 'local_ui', authenticated_by_server: true, customer_id: ctx.event.mandate.customer_id }, offer_hash: ctx.offer_hash, config_revision: ctx.config.revision, created_at: ctx.now, expires_at: '2026-09-20T00:00:00Z', consumed_by: null };
    ctx.answers = [answer];
    expect(assess(ctx)).toMatchObject({ execution_state: 'technical_hold', can_finalize: false, questions: [], technical_filter_ids: expect.arrayContaining(['C12']) });
    expect(ctx.run.commitments).toEqual([]);
    expect(ctx.run.reservations).toHaveLength(1);
  });

  it.each(['release', 'expire', 'commit'] as const)('rechecks the ledger after reservations %s', change => {
    const ctx = reserved();
    expect(assess(ctx).execution_state).toBe('technical_hold');
    if (change === 'expire') ctx.now = ctx.run.reservations[0]!.expires_at;
    else { if (change === 'commit') ctx.run.commitments = ctx.run.reservations.map(reservation => ({ ...reservation })); ctx.run.reservations = []; }
    const reassessed = assess(ctx);
    if (change === 'commit') expect(reassessed).toMatchObject({ decision: 'deny', blocking_filter_ids: expect.arrayContaining(['C10']), can_finalize: false });
    else expect(reassessed).toMatchObject({ can_finalize: true, questions: [], technical_filter_ids: [] });
  });

  it('never converts missing card capabilities into customer permission', () => {
    for (const check of ['C04', 'C05', 'C06'] as const) {
      const ctx = fixture('AU0001');
      const card = { ...ctx.pack.cardsById.get(ctx.event.authorization.card_id)! };
      if (check === 'C04') card.status = 'blocked';
      if (check === 'C05') card.online_enabled = undefined as never;
      if (check === 'C06') { card.international_enabled = undefined as never; ctx.event.authorization.merchant.merchant_country = 'DE'; }
      ctx.pack.cardsById = new Map(ctx.pack.cardsById).set(card.card_id, card);
      const assessment = assess(ctx);
      expect(assessment.technical_filter_ids).toContain(check);
      expect(assessment.questions.some(question => question.filter_ids.includes(check))).toBe(false);
      expect(assessment.can_finalize).toBe(false);
    }
  });

  it('releases an earlier reservation through cancellation, then offers only the later purchase confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reservation-retry-'));
    const runtime = await createLocalRuntime({ stateDir: join(directory, 'state'), outputDir: join(directory, 'output'), now: () => new Date('2026-09-19T00:00:00Z'), instructionDecoder: { configured: false, model: 'disabled', decode: async () => { throw Error('No external AI calls'); } } });
    try {
      const instruction = 'Spend at most CHF 150 per purchase. Ask me before every purchase.';
      const draft = await runtime.policies.createDraft('SCEN0001', { instruction, hard_rules: [], uncertainty_policy: 'ask', guidance: [], open_questions: [] }, undefined, { localCustomInstruction: true });
      const mandate = await runtime.policies.confirmDraft(draft.draft_id, 'local_user');
      const config = runtime.simulations.suggest(mandate.mandate_id, 'reservation-suggest');
      const actor: HumanActor = { actor_id: 'customer', role: 'simulated_human', channel: 'local_ui', authenticated_by_server: true, customer_id: runtime.wallet.actorCustomer('SCEN0001') };
      runtime.simulations.confirm(config.config_id, { ...config.parameters, domestic_country: 'CH', rolling_budget: { days: 7, limit_chf: '150' } }, config.requirements.map(requirement => requirement.requirement_id), actor, 'reservation-confirm');
      const run = runtime.simulations.create(config.config_id, 'reservation-run');
      const first = runtime.simulations.next(run.run_id, 'reservation-first').assessment!;
      const second = runtime.simulations.next(run.run_id, 'reservation-second').assessment!;
      expect(first.execution_state).toBe('awaiting_user');
      expect(second.execution_state).toBe('technical_hold');
      expect(second.questions.some(question => question.filter_ids.includes('C12'))).toBe(false);
      expect(runtime.simulations.get(run.run_id).reservations.map(reservation => reservation.authorization_id)).toEqual([first.authorization_id]);
      runtime.simulations.cancel(run.run_id, first.authorization_id, actor, 'reservation-cancel-first');
      const retried = runtime.simulations.reevaluate(run.run_id, second.authorization_id, second.revision, 'reservation-retry-second');
      expect(retried.assessment.execution_state).toBe('awaiting_user');
      expect(retried.assessment.technical_filter_ids).not.toContain('C12');
      expect(retried.assessment.questions.every(question => question.kind === 'confirm_risk')).toBe(true);
      expect(retried.run.reservations.map(reservation => reservation.authorization_id)).toEqual([second.authorization_id]);
      const final = runtime.simulations.answerBatch(run.run_id, second.authorization_id, { expected_revision: retried.assessment.revision, offer_hash: retried.assessment.offer_hash, answers: retried.assessment.questions.map(question => ({ question_id: question.question_id, value: 'confirm' })) }, actor, 'reservation-accept-second');
      expect(final.assessment.execution_state).toBe('approved');
      expect(final.run.commitments.map(commitment => commitment.authorization_id)).toEqual([second.authorization_id]);
      expect(final.run.reservations).toEqual([]);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
