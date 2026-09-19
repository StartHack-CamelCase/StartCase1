import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import { createLocalRuntime, type LocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { WalletStore } from '../packages/local-runtime/src/storage/wallet-store.js';
import { PolicyFileStore } from '../packages/local-runtime/src/storage/policy-file-store.js';
import type { WalletPreparation, WalletRunView } from '../packages/contracts/src/wallet.js';
import type { HumanActor } from '../packages/contracts/src/simulation.js';

const directories: string[] = [];
const apps = new Set<FastifyInstance>();
const runtimes = new Set<LocalRuntime>();
const externalFetch = vi.fn(async () => { throw new Error('External requests are forbidden in this offline audit.'); });
const decode = vi.fn(async () => { throw new Error('AI decoding is forbidden in this offline audit.'); });

beforeEach(() => {
  vi.stubEnv('LEASH_BASE_URL', '');
  vi.stubEnv('TEAM_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubGlobal('fetch', externalFetch);
});

afterEach(async () => {
  try {
    for (const app of apps) await app.close();
    for (const runtime of runtimes) await runtime.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    expect(externalFetch).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    apps.clear(); runtimes.clear(); directories.length = 0;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks();
  }
});

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'viseca-offline-api-audit-'));
  directories.push(dir);
  return dir;
}

function options(dir: string) {
  return {
    rootDir: resolve('.'), dataDir: resolve('data'),
    stateDir: join(dir, 'state'), outputDir: join(dir, 'output'),
    webDir: resolve('apps/local-web/web'),
    now: () => new Date('2026-09-19T09:00:00.000Z'),
    instructionDecoder: { model: 'offline-audit', configured: false, decode },
  };
}

async function appFixture(dir = '') {
  dir ||= await directory();
  const app = await createLocalApp(options(dir));
  apps.add(app);
  await app.ready();
  return { app, dir };
}

async function runtimeFixture(dir = '') {
  dir ||= await directory();
  const runtime = await createLocalRuntime(options(dir));
  runtimes.add(runtime);
  return { runtime, dir };
}

async function session(app: FastifyInstance, scenarioId = 'SCEN0001') {
  const response = await app.inject(`/api/wallet/session?scenario_id=${scenarioId}`);
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': response.json<{ csrf: string }>().csrf,
    'idempotency-key': 'offline-audit-prepare',
  };
}

async function prepared(app: FastifyInstance, scenarioId = 'SCEN0001') {
  const headers = await session(app, scenarioId);
  const choices = (await app.inject('/api/wallet/options')).json<{ scenarios: Array<{ scenario_id: string; instruction: string }> }>();
  const instruction = choices.scenarios.find(s => s.scenario_id === scenarioId)!.instruction;
  const payload = { scenario_id: scenarioId, instruction, mode: 'local' };
  const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers, payload });
  expect(response.statusCode, response.body).toBe(202);
  const prep = (await app.inject(`/api/wallet/preparations/${response.json<WalletPreparation>().preparation_id}`)).json<WalletPreparation>();
  expect(prep.status).toBe('ready');
  const confirm = (parameters: unknown = prep.config!.parameters, requestHeaders = headers) => app.inject({
    method: 'POST', url: `/api/wallet/preparations/${prep.preparation_id}/confirm`,
    headers: { ...requestHeaders, 'idempotency-key': 'offline-audit-confirm' },
    payload: { confirmed: true, parameters },
  });
  return { headers, payload, prep, confirm };
}

function runtimePrepared(runtime: LocalRuntime, scenarioId = 'SCEN0003') {
  const scenario = runtime.pack.scenarios.find(s => s.scenario_id === scenarioId)!;
  const prep = runtime.wallet.prepare({ scenario_id: scenario.scenario_id, instruction: scenario.cardholder_instruction, mode: 'local' }, 'offline-runtime-prepare');
  const actor: HumanActor = { actor_id: `LOCAL_UI_${runtime.wallet.actorCustomer(scenarioId)}`, role: 'simulated_human', customer_id: runtime.wallet.actorCustomer(scenarioId), channel: 'local_ui', authenticated_by_server: true };
  expect(prep.status).toBe('ready');
  return { prep, actor, values: prep.config!.parameters as unknown as Record<string, unknown> };
}

describe('offline wallet API audit', () => {
  it('deduplicates concurrent prepare and confirm requests into exactly one mandate and run', async () => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const repeats = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: x.headers, payload: x.payload })));
    expect(repeats.every(r => r.statusCode === 202 && r.json<WalletPreparation>().preparation_id === x.prep.preparation_id)).toBe(true);
    const confirmations = await Promise.all(Array.from({ length: 12 }, () => x.confirm()));
    expect(confirmations.every(r => r.statusCode === 200)).toBe(true);
    expect(new Set(confirmations.map(r => r.body)).size).toBe(1);
    expect((await app.inject('/api/wallet/runs')).json().runs).toHaveLength(1);
    expect((await app.inject('/api/scenarios/SCEN0001')).json().mandates).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: x.headers, payload: { ...x.payload, instruction: 'Buy groceries under CHF 50.' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('G01_IDEMPOTENCY_CONFLICT');
  });

  it('accepts only one of concurrent confirmations with different permission choices', async () => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const responses = await Promise.all([x.confirm(), x.confirm({ ...x.prep.config!.parameters, max_order_chf: '40' })]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await app.inject('/api/wallet/runs')).json().runs).toHaveLength(1);
  });

  it.each(['missing cookie', 'wrong csrf', 'another customer'] as const)('blocks confirmation with %s', async kind => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const headers = kind === 'another customer' ? await session(app, 'SCEN0004') : { ...x.headers, ...(kind === 'wrong csrf' ? { 'x-csrf-token': 'forged' } : { cookie: '' }) };
    const response = await x.confirm(undefined, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  });

  it.each(['https://attacker.invalid', 'null', 'http://localhost:9001'])(
    'blocks writes from the invalid origin %s', async origin => {
      const { app } = await appFixture();
      const x = await prepared(app);
      const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...x.headers, origin }, payload: x.payload });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('origin_forbidden');
    },
  );

  it.each(['', 'short', 'spaces are invalid', 'a'.repeat(201)])('rejects invalid idempotency key %j', async key => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...x.headers, 'idempotency-key': key }, payload: x.payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('G01_IDEMPOTENCY_KEY_REQUIRED');
  });

  it.each(['   ', 'a'.repeat(8001)])('rejects empty or oversized instructions without creating a run', async instruction => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...x.headers, 'idempotency-key': 'invalid-instruction' }, payload: { ...x.payload, instruction } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('instruction_invalid');
    expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  });

  it('rejects malformed, non-finite, incomplete and unrecognized permission JSON', async () => {
    const { app } = await appFixture();
    const x = await prepared(app);
    for (const parameters of [null, [], {}, { ...x.prep.config!.parameters, unknown: true }, { ...x.prep.config!.parameters, max_order_chf: 'NaN' }, { ...x.prep.config!.parameters, max_order_chf: 'Infinity' }, { ...x.prep.config!.parameters, consent_ttl_seconds: -1 }]) {
      const response = await x.confirm(parameters);
      expect(response.statusCode, response.body).toBe(400);
    }
    expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  });

  it('reports missing resources and invalid scenario selectors as client errors', async () => {
    const { app } = await appFixture();
    for (const url of ['/api/wallet/preparations/missing', '/api/wallet/runs/missing', '/api/wallet/session', '/api/wallet/session?scenario_id=missing', '/api/wallet/session?scenario_id=SCEN0000&scenario_id=SCEN0001']) {
      const response = await app.inject(url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
  });

  it('refuses live mode offline without attempting any network request', async () => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...x.headers, 'idempotency-key': 'offline-live-request' }, payload: { ...x.payload, mode: 'live' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('live_not_configured');
    expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  });

  it.each([
    { label: 'malformed JSON', payload: '{broken', contentType: 'application/json', status: 400 },
    { label: 'unsupported content type', payload: '<xml/>', contentType: 'application/xml', status: 415 },
    { label: 'oversized body', payload: JSON.stringify({ instruction: 'x'.repeat(1_100_000) }), contentType: 'application/json', status: 413 },
  ])('returns a client error for $label', async ({ payload, contentType, status }) => {
    const { app } = await appFixture();
    const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { 'content-type': contentType }, payload });
    expect(response.statusCode, response.body).toBe(status);
  });

  it('rejects a hosted human response aimed at a local run without an internal error', async () => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const started = await x.confirm();
    expect(started.statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: `/api/wallet/runs/${started.json().run_id}/human-responses`, headers: x.headers, payload: { authorization_id: 'wrong-local-authorization', decision: 'approve', answers: [] } });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('wallet_run_mode_mismatch');
  });

  it('retains confirmed permissions across restart and requires a new browser session', async () => {
    const { app, dir } = await appFixture();
    const x = await prepared(app);
    const first = await x.confirm();
    expect(first.statusCode, first.body).toBe(200);
    await app.close(); apps.delete(app);
    const { app: restored } = await appFixture(dir);
    const confirmation = { method: 'POST' as const, url: `/api/wallet/preparations/${x.prep.preparation_id}/confirm`, payload: { confirmed: true, parameters: x.prep.config!.parameters } };
    expect((await restored.inject({ ...confirmation, headers: x.headers })).statusCode).toBe(403);
    const replay = await restored.inject({ ...confirmation, headers: await session(restored) });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await restored.inject('/api/wallet/runs')).json().runs).toHaveLength(1);
    expect((await restored.inject(`/api/wallet/runs/${first.json().run_id}`)).json<WalletRunView>().config.parameters).toEqual(x.prep.config!.parameters);
  });

  it.each(['wallet', 'mandate'] as const)('keeps %s revocation consistent when policy persistence fails and allows the same request to retry', async endpoint => {
    const { app } = await appFixture();
    const x = await prepared(app);
    const started = await x.confirm();
    expect(started.statusCode).toBe(200);
    const { run_id: runId, mandate_id: mandateId } = started.json<{ run_id: string; mandate_id: string }>();
    const request = {
      method: endpoint === 'wallet' ? 'POST' as const : 'DELETE' as const,
      url: endpoint === 'wallet' ? `/api/wallet/runs/${runId}/revoke` : `/api/mandates/${mandateId}`,
      headers: { ...x.headers, 'idempotency-key': 'persistent-revoke-request' }, payload: {},
    };
    const save = vi.spyOn(PolicyFileStore.prototype, 'save').mockRejectedValueOnce(new Error('injected write failure'));
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect((await app.inject(`/api/mandates/${mandateId}`)).json().status).toBe('active');
    expect((await app.inject(`/api/wallet/runs/${runId}`)).json().status).toBe('active');
    save.mockRestore();
    const retry = await app.inject(request);
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await app.inject(`/api/mandates/${mandateId}`)).json().status).toBe('revoked');
    expect((await app.inject(`/api/wallet/runs/${runId}`)).json().status).toBe('revoked');
  });
});

describe('offline wallet persistence and recovery', () => {
  it('does not partially revoke the simulation when saving the mandate fails', async () => {
    const { runtime, dir } = await runtimeFixture();
    const x = runtimePrepared(runtime);
    const started = await runtime.wallet.confirm(x.prep.preparation_id, x.values, x.actor);
    for (let i = 0; i < 4; i++) runtime.wallet.tick();
    const before = runtime.wallet.getRun(started.run_id);
    const save = vi.spyOn(PolicyFileStore.prototype, 'save').mockRejectedValueOnce(new Error('injected policy persistence failure'));
    await expect(runtime.wallet.revoke(started.run_id, x.actor, 'failed-revoke')).rejects.toThrow('injected policy persistence failure');
    expect(runtime.policies.getMandate(started.mandate_id).status).toBe('active');
    expect(runtime.wallet.getRun(started.run_id)).toMatchObject({ status: before.status, reservations: before.reservations, approved_chf: before.approved_chf });
    save.mockRestore();
    await runtime.close(); runtimes.delete(runtime);
    const { runtime: restored } = await runtimeFixture(dir);
    expect(restored.policies.getMandate(started.mandate_id).status).toBe('active');
    expect(restored.wallet.getRun(started.run_id)).toMatchObject({ status: before.status, approved_chf: before.approved_chf, reservations: before.reservations });
    expect(await restored.wallet.revoke(started.run_id, x.actor, 'failed-revoke')).toMatchObject({ status: 'revoked', reservations: 0 });
  });

  it('preserves the revoked mandate if updating simulations fails, and recovers on retry', async () => {
    const { runtime, dir } = await runtimeFixture();
    const x = runtimePrepared(runtime);
    const started = await runtime.wallet.confirm(x.prep.preparation_id, x.values, x.actor);
    const update = vi.spyOn(runtime.simulations, 'revokeMandate').mockImplementationOnce(() => { throw new Error('injected simulation persistence failure'); });
    await expect(runtime.wallet.revoke(started.run_id, x.actor, 'retry-revoke')).rejects.toThrow('injected simulation persistence failure');
    expect(runtime.policies.getMandate(started.mandate_id).status).toBe('revoked');
    expect(() => runtime.simulations.create(runtime.wallet.getRun(started.run_id).config.config_id, 'forbidden-new-run')).toThrow('Mandate changed or revoked');
    update.mockRestore();
    await runtime.close(); runtimes.delete(runtime);
    const { runtime: restored } = await runtimeFixture(dir);
    expect(restored.policies.getMandate(started.mandate_id).status).toBe('revoked');
    restored.wallet.tick();
    const blocked = restored.wallet.getRun(started.run_id);
    expect(blocked.approved_chf).toBe('0.00');
    expect(blocked.purchases.at(-1)?.assessment).toMatchObject({ decision: 'deny', blocking_filter_ids: ['C02'] });
    expect(await restored.wallet.revoke(started.run_id, x.actor, 'retry-revoke')).toMatchObject({ status: 'revoked', reservations: 0 });
  });

  it('resumes a confirmation interrupted after the mandate was saved without duplicating it', async () => {
    const { runtime, dir } = await runtimeFixture();
    const x = runtimePrepared(runtime);
    const create = vi.spyOn(runtime.simulations, 'create').mockImplementationOnce(() => { throw new Error('injected interruption before run persistence'); });
    await expect(runtime.wallet.confirm(x.prep.preparation_id, x.values, x.actor)).rejects.toThrow('injected interruption');
    expect(runtime.policies.listMandates()).toHaveLength(1);
    expect(runtime.simulations.list()).toHaveLength(0);
    create.mockRestore();
    await runtime.close(); runtimes.delete(runtime);
    const { runtime: restored } = await runtimeFixture(dir);
    const started = await restored.wallet.confirm(x.prep.preparation_id, x.values, x.actor);
    expect(restored.policies.listMandates()).toHaveLength(1);
    expect(restored.simulations.list()).toHaveLength(1);
    expect(await restored.wallet.confirm(x.prep.preparation_id, x.values, x.actor)).toEqual(started);
  });

  it('retains purchases, pending reservations and totals after restart, then revokes durably', async () => {
    const { runtime, dir } = await runtimeFixture();
    const x = runtimePrepared(runtime);
    const started = await runtime.wallet.confirm(x.prep.preparation_id, x.values, x.actor);
    for (let i = 0; i < 4; i++) runtime.wallet.tick();
    const before = runtime.wallet.getRun(started.run_id);
    expect(before).toMatchObject({ approved_chf: '334.05', reservations: 2 });
    await runtime.close(); runtimes.delete(runtime);
    const { runtime: restored } = await runtimeFixture(dir);
    const after = restored.wallet.getRun(started.run_id);
    expect(after.purchases).toEqual(before.purchases);
    expect(after).toMatchObject({ approved_chf: before.approved_chf, reservations: before.reservations });
    restored.wallet.tick();
    expect(restored.wallet.getRun(started.run_id).purchases).toHaveLength(5);
    const revoked = await restored.wallet.revoke(started.run_id, x.actor, 'offline-audit-revoke');
    expect(revoked).toMatchObject({ status: 'revoked', reservations: 0, approved_chf: '334.05' });
    restored.wallet.tick();
    expect(restored.wallet.getRun(started.run_id).purchases).toHaveLength(5);
    await restored.close(); runtimes.delete(restored);
    const { runtime: final } = await runtimeFixture(dir);
    expect(final.wallet.getRun(started.run_id)).toMatchObject({ status: 'revoked', reservations: 0, approved_chf: '334.05' });
    expect(final.policies.getMandate(started.mandate_id).status).toBe('revoked');
  });

  it('marks a saved interrupted preparation failed while preserving its instruction', async () => {
    const { runtime, dir } = await runtimeFixture();
    const { prep } = runtimePrepared(runtime);
    await runtime.close(); runtimes.delete(runtime);
    const store = new WalletStore(join(dir, 'state', 'wallet.sqlite'));
    store.save({ ...prep, status: 'processing', config: null });
    store.close();
    const { runtime: restored } = await runtimeFixture(dir);
    expect(restored.wallet.getPreparation(prep.preparation_id)).toMatchObject({ status: 'failed', instruction: prep.instruction });
    expect(restored.wallet.listRuns()).toEqual([]);
  });

  it('detects damaged persisted permissions and leaves the damaged record intact', async () => {
    const { runtime, dir } = await runtimeFixture();
    const { prep } = runtimePrepared(runtime);
    await runtime.close(); runtimes.delete(runtime);
    const path = join(dir, 'state', 'wallet.sqlite');
    const db = new DatabaseSync(path);
    db.prepare('UPDATE preparations SET body=? WHERE id=?').run('{damaged', prep.preparation_id);
    db.close();
    const store = new WalletStore(path);
    try { expect(() => store.get(prep.preparation_id)).toThrow('could not be verified'); } finally { store.close(); }
    const read = new DatabaseSync(path, { readOnly: true });
    try { expect(read.prepare('SELECT body FROM preparations WHERE id=?').get(prep.preparation_id)?.['body']).toBe('{damaged'); } finally { read.close(); }
  });
});
