import {configuredInstructionDecoder,readyWalletPreparation} from './helpers/configured-instruction-decoder.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assessment, HumanActor, SimRun } from '../packages/contracts/src/simulation.js';
import { ACTIVE_FILTER_IDS } from '../packages/contracts/src/simulation.js';
import { createLocalRuntime, type LocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { hardRulesFromParameters, preparePermissions } from '../packages/local-runtime/src/services/wallet-preparation.js';
import { hash, offerHash } from '../packages/local-runtime/src/simulation/common.js';
import { assess, stampCommitted } from '../packages/local-runtime/src/simulation/evaluator.js';
import { fixture } from './simulation-fixture.js';

const scenarios = ['SCEN0000', 'SCEN0001', 'SCEN0002', 'SCEN0003', 'SCEN0004'] as const;
const policies = ['decline_questions', 'confirm_risks_only', 'expire_questions', 'revoke_with_pending'] as const;
const reports: Array<Record<string, unknown>> = [];
const isolatedReports: Array<Record<string, unknown>> = [];
const expectedApprovals = {
  SCEN0000: ['AU0001'], SCEN0001: ['AU0002', 'AU0003', 'AU0005', 'AU0006', 'AU0011'],
  SCEN0002: ['AU0012'], SCEN0003: ['AU0024', 'AU0025', 'AU0031', 'AU0032'], SCEN0004: ['AU0035'],
};
const expectedSpend = { SCEN0000: '20.00', SCEN0001: '387.50', SCEN0002: '165.00', SCEN0003: '676.05', SCEN0004: '289.00' };
// The amounts include delivery and source FX; each offer starts with an empty mission ledger.
const isolatedExpected = [
  ['AU0001', '20.00', 'approved', []],
  ['AU0002', '44.50', 'approved', []],
  ['AU0003', '120.00', 'approved', []],
  ['AU0004', '126.00', 'declined', ['C09']],
  ['AU0005', '70.00', 'approved', []],
  ['AU0006', '65.00', 'approved', []],
  ['AU0007', '62.00', 'declined', ['M09']],
  ['AU0008', '65.50', 'approved', []],
  ['AU0009', '24.00', 'approved', []],
  ['AU0010', '138.00', 'declined', ['C09']],
  ['AU0011', '88.00', 'approved', []],
  ['AU0012', '165.00', 'approved', []],
  ['AU0013', '155.00', 'declined', ['M11']],
  ['AU0014', '145.00', 'declined', ['M13']],
  ['AU0015', '158.00', 'declined', ['M13']],
  ['AU0016', '175.00', 'awaiting_user', []],
  ['AU0017', '180.00', 'declined', ['M10']],
  ['AU0018', '194.00', 'declined', ['M09', 'M12', 'C14']],
  ['AU0019', '168.00', 'approved', []],
  ['AU0020', '120.00', 'declined', ['M10']],
  ['AU0021', '215.00', 'declined', ['C09']],
  ['AU0022', '189.00', 'declined', ['M06']],
  ['AU0023', '179.00', 'approved', []],
  ['AU0024', '145.00', 'approved', []],
  ['AU0025', '189.05', 'approved', []],
  ['AU0026', '165.00', 'awaiting_user', []],
  ['AU0027', '232.00', 'awaiting_user', []],
  ['AU0028', '245.00', 'awaiting_user', []],
  ['AU0029', '245.28', 'awaiting_user', []],
  ['AU0030', '248.00', 'awaiting_user', []],
  ['AU0031', '95.00', 'approved', []],
  ['AU0032', '247.00', 'approved', []],
  ['AU0033', '138.00', 'awaiting_user', []],
  ['AU0034', '268.00', 'declined', ['C09']],
  ['AU0035', '289.00', 'approved', []],
  ['AU0036', '289.00', 'approved', []],
  ['AU0037', '520.00', 'declined', ['C09']],
  ['AU0038', '391.50', 'approved', []],
  ['AU0039', '340.00', 'awaiting_user', []],
  ['AU0040', '299.00', 'awaiting_user', []],
  ['AU0041', '459.00', 'declined', ['M09', 'M10', 'M12', 'C09', 'C14']],
  ['AU0042', '350.00', 'awaiting_user', []],
  ['AU0043', '195.00', 'declined', ['M09', 'M10', 'M12']],
  ['AU0044', '310.00', 'approved', []],
  ['AU0045', '399.90', 'approved', []],
] as const;
const resources: Array<{ runtime: LocalRuntime | null; dir: string }> = [];
let forbiddenFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Keep all progress explicit: the production wallet also has an automatic replay timer.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  forbiddenFetch = vi.fn(async () => { throw new Error('Network calls are forbidden in the offline matrix.'); });
  vi.stubGlobal('fetch', forbiddenFetch);
});

afterEach(async () => {
  try {
    for (const resource of resources.splice(0)) {
      await resource.runtime?.close();
      await rm(resource.dir, { recursive: true, force: true });
    }
    expect(forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

afterAll(async () => {
  // Optional report path lets an audit retain full results without changing repository fixtures.
  const path = process.env['OFFLINE_MATRIX_REPORT'];
  if (path) await writeFile(path, JSON.stringify({ scenarios: 5, official_proposals: 45, cases: reports, isolated_cases: isolatedReports }, null, 2) + '\n');
});

async function setup(scenarioId: string, policy: string) {
  let now = new Date('2026-09-19T00:00:00.000Z');
  const dir = await mkdtemp(join(tmpdir(), 'viseca-offline-matrix-'));
  const options = {
    stateDir: join(dir, 'state'), outputDir: join(dir, 'output'), now: () => now,
    instructionDecoder:configuredInstructionDecoder(),
  };
  const runtime = await createLocalRuntime(options);
  const resource = { runtime: runtime as LocalRuntime | null, dir };
  resources.push(resource);
  const scenario = runtime.pack.scenarios.find(s => s.scenario_id === scenarioId)!;
  const expectedSources = runtime.pack.attemptsByScenario.get(scenario.scenario_id)!.map(a => a.authorization_id);
  const actor: HumanActor = {
    actor_id: `offline-reviewer-${scenarioId}-${policy}`, role: 'simulated_human',
    customer_id: runtime.wallet.actorCustomer(scenarioId), channel: 'local_ui', authenticated_by_server: true,
  };
  const prep = runtime.wallet.prepare({ scenario_id: scenarioId, instruction: scenario.cardholder_instruction, mode: 'local' }, `${scenarioId}:${policy}:prepare`);
  const ready = await readyWalletPreparation(()=>runtime.wallet.getPreparation(prep.preparation_id));
  expect(ready.status, ready.error ?? undefined).toBe('ready');
  expect(ready.clarifications).toEqual([]);
  expect(ready.config!.parameters.learn_confirmed_habits).toBe(false);
  const confirmed = await runtime.wallet.confirm(ready.preparation_id, ready.config!.parameters, actor);
  expect(await runtime.wallet.confirm(ready.preparation_id, ready.config!.parameters, actor)).toEqual(confirmed);
  expect(runtime.simulations.list()).toHaveLength(1);
  return {
    runtime, resource, options, actor, confirmed, expectedSources,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

function assertLedger(run: SimRun) {
  const committed = new Set(run.commitments.map(c => c.authorization_id));
  expect(committed.size).toBe(run.commitments.length);
  expect(run.audit.map(a => a.sequence)).toEqual(run.audit.map((_, i) => i + 1));
  expect(run.history.every(h => h.customer_id === run.customer_id)).toBe(true);
  for (const purchase of run.purchases) {
    const last = purchase.assessments.at(-1)!;
    expect(last.execution_state === 'approved').toBe(committed.has(last.authorization_id));
    for (const assessment of purchase.assessments) {
      expect(assessment.results.map(r => r.filter_id).sort()).toEqual([...ACTIVE_FILTER_IDS].sort());
      if (assessment.execution_state === 'approved') {
        expect(assessment.decision).toBe('approve');
        expect(assessment.blocking_filter_ids).toEqual([]);
        expect(assessment.doubt_filter_ids).toEqual([]);
        expect(assessment.technical_filter_ids).toEqual([]);
        expect(assessment.questions).toEqual([]);
      }
    }
  }
  for (const reservation of run.reservations) expect(committed.has(reservation.authorization_id)).toBe(false);
}

describe.each(policies)('official offline scenarios: %s', policy => {
  it.each(scenarios)('%s completes every supplied proposal and preserves its ledger after restart', async scenarioId => {
    const x = await setup(scenarioId, policy);
    const id = x.confirmed.run_id;
    const initial: Assessment[] = [];
    for (let index = 0; index < x.expectedSources.length; index++) {
      const key = `${policy}:proposal:${index}`;
      const emitted = x.runtime.simulations.next(id, key);
      const assessment = emitted.assessment!;
      expect(assessment.source_authorization_id).toBe(x.expectedSources[index]);
      expect(assessment.technical_filter_ids).toEqual([]);
      initial.push(assessment);
      // Transport retries must replay the same response, with no second purchase or charge.
      expect(x.runtime.simulations.next(id, key)).toEqual(emitted);
      expect(x.runtime.simulations.get(id).purchases).toHaveLength(index + 1);
      if (assessment.decision === 'step_up') {
        if (policy === 'expire_questions') {
          x.advance(x.runtime.simulations.get(id).config.parameters.consent_ttl_seconds * 1000);
          const expired = x.runtime.simulations.get(id).purchases.at(-1)!.assessments.at(-1)!;
          expect(expired.execution_state).toBe('expired');
          expect(x.runtime.simulations.get(id).reservations).toEqual([]);
        } else if (policy !== 'revoke_with_pending') {
          if (policy === 'confirm_risks_only' && assessment.questions.length && assessment.questions.every(q => q.kind === 'confirm_risk')) {
            const response = {
              expected_revision: assessment.revision, offer_hash: assessment.offer_hash,
              answers: assessment.questions.map(q => ({ question_id: q.question_id, value: 'confirm' })),
            };
            const answered = x.runtime.simulations.answerBatch(id, assessment.authorization_id, response, x.actor, `${key}:answer`);
            expect(answered.assessment.execution_state).toBe('approved');
            expect(x.runtime.simulations.answerBatch(id, assessment.authorization_id, response, x.actor, `${key}:answer`)).toEqual(answered);
          } else {
            // Missing facts and required mandate changes cannot be manufactured by a simple yes.
            const cancelled = x.runtime.simulations.cancel(id, assessment.authorization_id, x.actor, `${key}:decline`);
            expect(cancelled.purchases.at(-1)!.assessments.at(-1)!.execution_state).toBe('cancelled');
            expect(x.runtime.simulations.cancel(id, assessment.authorization_id, x.actor, `${key}:decline`)).toEqual(cancelled);
          }
        }
      }
      assertLedger(x.runtime.simulations.get(id));
    }
    expect(x.runtime.simulations.next(id, `${policy}:end`).assessment).toBeNull();
    if (policy === 'revoke_with_pending') {
      const before = x.runtime.simulations.get(id);
      await x.runtime.wallet.revoke(id, x.actor, `${policy}:revoke`);
      const revoked = x.runtime.simulations.get(id);
      expect(revoked.status).toBe('revoked');
      expect(revoked.commitments).toEqual(before.commitments);
      expect(revoked.purchases.every(p => p.assessments.at(-1)!.execution_state !== 'awaiting_user')).toBe(true);
      expect(() => x.runtime.simulations.next(id, `${policy}:after-revoke`)).toThrow('revoked');
    }
    const final = x.runtime.simulations.get(id);
    assertLedger(final);
    expect(final.purchases.map(p => p.event.authorization.source_authorization_id)).toEqual(x.expectedSources);
    expect(final.reservations).toEqual([]);
    expect(final.status).toBe(policy === 'revoke_with_pending' ? 'revoked' : 'completed');
    const view = x.runtime.wallet.getRun(id);
    expect(view.approved_chf).toBe(final.commitments.reduce((sum, c) => sum.add(c.amount_chf), new Decimal(0)).toFixed(2));
    const approvedSources = final.purchases.filter(p => p.assessments.at(-1)!.execution_state === 'approved').map(p => p.event.authorization.source_authorization_id).sort();
    const withRiskConfirmation = scenarioId === 'SCEN0003' && policy === 'confirm_risks_only';
    expect(approvedSources).toEqual([...expectedApprovals[scenarioId], ...(withRiskConfirmation ? ['AU0026'] : [])].sort());
    expect(view.approved_chf).toBe(withRiskConfirmation ? '841.05' : expectedSpend[scenarioId]);
    expect(view.has_more_proposals).toBe(false);
    await x.runtime.close();
    x.resource.runtime = null;
    x.resource.runtime = await createLocalRuntime(x.options);
    expect(x.resource.runtime.simulations.get(id)).toEqual(final);
    expect(x.resource.runtime.wallet.getRun(id)).toEqual(view);
    reports.push({
      scenario_id: scenarioId, policy, proposals: final.purchases.length,
      initial: countStates(initial), final: countStates(final.purchases.map(p => p.assessments.at(-1)!)),
      approved_chf: view.approved_chf, reservations: final.reservations.length,
      evaluations: final.audit.filter(a => a.event === 'assessment_started').length,
      filter_checks: final.audit.filter(a => a.event === 'filter_evaluated').length,
      proposals_detail: final.purchases.map(p => ({
        source: p.event.authorization.source_authorization_id, amount_chf: p.event.authorization.billing_amount_chf,
        assessments: p.assessments.map(a => ({ state: a.execution_state, decision: a.decision, blocking: a.blocking_filter_ids, doubts: a.doubt_filter_ids })),
      })),
    });
  });
});

it.each(isolatedExpected)('%s is assessed independently against its official instruction', (sourceId, amount, state, blocking) => {
  const ctx = fixture(sourceId);
  const instruction = ctx.pack.scenariosById.get(ctx.event.authorization.scenario_id)!.cardholder_instruction;
  const prepared = preparePermissions(ctx.pack, instruction, null, ctx.now);
  expect(prepared.clarifications).toEqual([]);
  ctx.config.parameters = prepared.config!.parameters;
  ctx.config.instruction = instruction;
  ctx.config.instruction_hash = hash(instruction);
  ctx.config.requirements = prepared.config!.requirements.map(r => ({ ...r, status: 'confirmed', author: 'offline-reviewer', question: null }));
  ctx.event.mandate.instruction = instruction;
  ctx.event.mandate.hard_rules = hardRulesFromParameters(ctx.config.parameters);
  ctx.run.mandate_snapshot = ctx.event.mandate;
  ctx.offer_hash = offerHash(ctx.event, ctx.config);
  ctx.phase = 'commit';
  const initial = assess(ctx);
  if (initial.can_finalize) stampCommitted(initial);
  expect(initial.source_authorization_id).toBe(sourceId);
  expect(new Decimal(String(ctx.event.authorization.billing_amount_chf)).toFixed(2)).toBe(amount);
  expect(initial.execution_state).toBe(state);
  expect(initial.blocking_filter_ids).toEqual(blocking);
  expect(initial.results.map(r => r.filter_id).sort()).toEqual([...ACTIVE_FILTER_IDS].sort());
  expect(initial.technical_filter_ids).toEqual([]);
  expect(ctx.run.commitments).toEqual([]);
  let final = initial;
  if (initial.decision === 'step_up' && initial.questions.length && initial.questions.every(q => q.kind === 'confirm_risk')) {
    ctx.answers = initial.questions.map((q, i) => ({
      answer_id: `OFFLINE_ANSWER_${i}`, question_id: q.question_id, fact_key: q.fact_key, kind: q.kind,
      value: 'confirm', source_ref: null, source_excerpt: null,
      actor: { actor_id: 'offline-reviewer', customer_id: ctx.run.customer_id, role: 'simulated_human', channel: 'local_ui', authenticated_by_server: true },
      offer_hash: ctx.offer_hash, config_revision: ctx.config.revision, created_at: ctx.now,
      expires_at: new Date(Date.parse(ctx.now) + 120_000).toISOString(), consumed_by: null,
    }));
    final = assess(ctx);
    expect(final.can_finalize).toBe(true);
    stampCommitted(final);
    expect(final.decision).toBe('approve');
  }
  isolatedReports.push({
    source: sourceId, scenario_id: ctx.event.authorization.scenario_id,
    amount_chf: new Decimal(String(ctx.event.authorization.billing_amount_chf)).toFixed(2),
    initial_state: initial.execution_state, final_state: final.execution_state,
    blocking: initial.blocking_filter_ids, doubts: initial.doubt_filter_ids,
    questions: initial.questions.map(q => ({ fact: q.fact_key, kind: q.kind })),
  });
});

it.each(scenarios)('%s can revoke before its first proposal without creating any charge', async scenarioId => {
  const x = await setup(scenarioId, 'revoke_before_first');
  const revoked = await x.runtime.wallet.revoke(x.confirmed.run_id, x.actor, 'revoke-before-first');
  expect(revoked).toMatchObject({ status: 'revoked', approved_chf: '0.00', reservations: 0, purchases: [] });
  expect(() => x.runtime.simulations.next(x.confirmed.run_id, 'proposal-after-revoke')).toThrow('revoked');
  expect(x.runtime.simulations.get(x.confirmed.run_id).commitments).toEqual([]);
});

function countStates(assessments: Assessment[]) {
  return assessments.reduce<Record<string, number>>((counts, a) => {
    counts[a.execution_state] = (counts[a.execution_state] ?? 0) + 1;
    return counts;
  }, {});
}
