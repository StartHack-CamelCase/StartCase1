import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Decimal } from 'decimal.js';
import { ACTIVE_FILTER_IDS, type Assessment, type HumanActor } from '../../../packages/contracts/src/simulation.js';
import { createLocalRuntime } from '../../../packages/local-runtime/src/runtime.js';
import { ENGINE_VERSION } from '../../../packages/local-runtime/src/simulation/common.js';
import { configuredInstructionDecoder, readyWalletPreparation } from '../../../tests/helpers/configured-instruction-decoder.js';

// Test-only recorded decoding fixtures and isolated state. No model or remote API calls.
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Usage: npm run judging:verify -- [--output report.json]');
}
const directory = await mkdtemp(join(tmpdir(), 'viseca-judging-'));
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is disabled for judging verification.'); };
const runtime = await createLocalRuntime({
  stateDir: join(directory, 'state'), outputDir: join(directory, 'output'),
  instructionDecoder: configuredInstructionDecoder('judging-recorded-fixture'),
  liveOptions: { environment: 'disabled', baseUrl: '', apiKey: '' },
}).catch(async error => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); throw error; });

try {
  const samples: number[] = [];
  const scenarios = [];
  const decisions = { approve: 0, decline: 0, step_up: 0 };
  let confirmations = 0;
  let rejections = 0;
  let revocations = 0;
  let retainedOrdinaryExample: { scenario_id: string; source_id: string } | undefined;
  for (const scenario of runtime.pack.scenarios) {
    const actor: HumanActor = {
      actor_id: 'JUDGING_LOCAL_REVIEWER', role: 'simulated_human',
      customer_id: runtime.wallet.actorCustomer(scenario.scenario_id),
      channel: 'local_ui', authenticated_by_server: true,
    };
    const prepared = runtime.wallet.prepare({ scenario_id: scenario.scenario_id, instruction: scenario.cardholder_instruction, mode: 'local' }, `judge:${scenario.scenario_id}`);
    const ready = await readyWalletPreparation(() => runtime.wallet.getPreparation(prepared.preparation_id));
    assert.equal(ready.status, 'ready', ready.error ?? 'Permissions must be ready locally.');
    assert.ok(ready.config);
    const confirmed = await runtime.wallet.confirm(ready.preparation_id, ready.config.parameters, actor);
    const proposals = [];
    for (const attempt of runtime.pack.attemptsByScenario.get(scenario.scenario_id)!) {
      const key = `judge:${attempt.authorization_id}`;
      const started = performance.now();
      const result = runtime.simulations.next(confirmed.run_id, key);
      const duration = performance.now() - started;
      samples.push(duration);
      const assessment = result.assessment;
      assert.ok(assessment);
      assert.equal(assessment.source_authorization_id, attempt.authorization_id);
      assert.deepEqual(assessment.results.map(r => r.filter_id).sort(), [...ACTIVE_FILTER_IDS].sort());
      assert.equal(assessment.technical_filter_ids.length, 0);
      assert.ok(assessment.event_hash && assessment.offer_hash && assessment.engine_version && assessment.correlation_id);
      assert.ok(assessment.results.every(r => r.algorithm_version));
      assert.deepEqual(runtime.simulations.next(confirmed.run_id, key), result, 'Retries must return the saved operation.');
      const initial = assessment.decision === 'deny' ? 'decline' : assessment.decision;
      assert.ok(initial);
      decisions[initial]++;
      let final: Assessment = assessment;
      if (initial === 'approve') retainedOrdinaryExample ??= { scenario_id: scenario.scenario_id, source_id: attempt.authorization_id };
      if (initial === 'step_up') {
        assert.ok(assessment.questions.length > 0);
        if (assessment.questions.every(q => q.kind === 'confirm_risk')) {
          final = runtime.simulations.answerBatch(confirmed.run_id, assessment.authorization_id, {
            expected_revision: assessment.revision, offer_hash: assessment.offer_hash,
            answers: assessment.questions.map(q => ({ question_id: q.question_id, value: 'confirm' })),
          }, actor, `${key}:answer`).assessment;
          assert.equal(final.execution_state, 'approved');
          confirmations++;
        } else {
          const cancelled = runtime.simulations.cancel(confirmed.run_id, assessment.authorization_id, actor, `${key}:decline`);
          final = cancelled.purchases.at(-1)!.assessments.at(-1)!;
          assert.equal(final.execution_state, 'cancelled');
          rejections++;
        }
      }
      proposals.push({ source_id: attempt.authorization_id, initial_decision: initial, final_state: final.execution_state, blocking_filters: assessment.blocking_filter_ids, review_filters: assessment.doubt_filter_ids, duration_ms: Number(duration.toFixed(3)) });
    }
    const run = runtime.simulations.get(confirmed.run_id);
    assert.equal(run.purchases.length, proposals.length);
    assert.equal(new Set(run.commitments.map(c => c.authorization_id)).size, run.commitments.length);
    assert.equal(run.reservations.length, 0);
    assert.deepEqual(run.audit.map(a => a.sequence), run.audit.map((_, index) => index + 1));
    for (const purchase of run.purchases) {
      assert.equal(purchase.assessments.at(-1)!.execution_state === 'approved', run.commitments.some(c => c.authorization_id === purchase.event.authorization.authorization_id));
    }
    const revoked = await runtime.wallet.revoke(run.run_id, actor, `judge:${scenario.scenario_id}:revoke`);
    assert.equal(revoked.status, 'revoked');
    assert.throws(() => runtime.simulations.next(run.run_id, `judge:${scenario.scenario_id}:after-revoke`), /revoked/);
    assert.deepEqual(runtime.simulations.get(run.run_id).commitments, run.commitments);
    revocations++;
    scenarios.push({ scenario_id: scenario.scenario_id, proposals, approved_chf: run.commitments.reduce((total, c) => total.add(c.amount_chf), new Decimal(0)).toFixed(2), audit_entries: run.audit.length });
  }
  assert.equal(samples.length, runtime.pack.attempts.length);
  assert.ok(Object.values(decisions).every(count => count > 0), 'Demonstrate all three decisions.');
  assert.ok(confirmations > 0 && rejections > 0);
  assert.equal(networkAttempts, 0);
  samples.sort((a, b) => a - b);
  const percentile = (p: number) => Number(samples[Math.ceil(samples.length * p) - 1]!.toFixed(3));
  const max = samples.at(-1)!;
  const report = {
    generated_at: new Date().toISOString(), scope: 'offline_synthetic_acceptance', node: process.version,
    passed: max < 8000, pack_version: runtime.pack.pack_version, engine_version: ENGINE_VERSION,
    scenarios: scenarios.length, proposals: samples.length, filter_checks_per_assessment: ACTIVE_FILTER_IDS.length,
    initial_decisions: decisions, human_risk_confirmations: confirmations, human_rejections: rejections,
    revocations_verified: revocations, network_attempts: networkAttempts,
    invariants: ['all three decisions', 'one operation per idempotency key', '50 versioned checks per assessment', 'offer/event hashes and correlation', 'continuous audit sequence', 'unique commitments for approvals only', 'no residual reservations', 'revocation prevents new purchases and preserves history'],
    latency: { scope: 'synchronous local decision, audit and SQLite commit; excludes preparation, human time and remote transport', samples: samples.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: Number(max.toFixed(3)), reference_deadline_ms: 8000, local_calls_under_reference_deadline: max < 8000 },
    limitations: ['Not an end-to-end hosted deadline measurement or a load test.', 'Synthetic cases do not establish real-world safety, usability or commercial viability.', 'Human identity is simulated; no bank authentication.'],
    ordinary_example: retainedOrdinaryExample, details: scenarios,
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  if (args[1]) await writeFile(resolve(args[1]), output);
  process.stdout.write(output);
  assert.ok(report.passed, 'A local decision exceeded the 8-second reference; inspect the report.');
} finally {
  try { await runtime.close(); } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}
