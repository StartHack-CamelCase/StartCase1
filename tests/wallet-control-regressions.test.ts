import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import type { Assessment, SafetyConfig, SimRun } from '../packages/contracts/src/simulation.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';

const resources: Array<{ app: FastifyInstance; directory: string }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); await rm(resource.directory, { recursive: true, force: true }); } });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-controls-'));
  const transport = vi.fn(async (): Promise<Response> => { throw new Error('No API request is expected.'); });
  const app = await createLocalApp({ stateDir: join(directory, 'state'), outputDir: join(directory, 'output'), webDir: resolve('apps/local-web/web'), instructionDecoder: { model: 'disabled-test', configured: false, decode: async () => { throw new Error('No AI request'); } }, liveOptions: { baseUrl: 'http://127.0.0.1:4313', apiKey: 'test', transport, environment: 'mock' } });
  resources.push({ app, directory });
  const owner = await session(app, 'SCEN0000');
  return { app, owner, transport };
}
async function session(app: FastifyInstance, scenario: string) { const reply = await app.inject(`/api/wallet/session?scenario_id=${scenario}`); return { cookie: String(reply.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': reply.json<{ csrf: string }>().csrf }; }
async function draft(app: FastifyInstance) {
  const options = (await app.inject('/api/wallet/options')).json<{ scenarios: Array<{ scenario_id: string; instruction: string }> }>();
  const instruction = options.scenarios.find((scenario) => scenario.scenario_id === 'SCEN0000')!.instruction;
  const response = await app.inject({ method: 'POST', url: '/api/mandate-drafts', headers: { 'idempotency-key': 'controls-draft-001' }, payload: { scenario_id: 'SCEN0000', instruction, hard_rules: [], uncertainty_policy: 'ask', guidance: [], open_questions: [] } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ draft_id: string }>();
}
async function controlledRun() {
  const context = await setup();
  const created = await draft(context.app);
  const confirmed = await context.app.inject({ method: 'POST', url: `/api/mandate-drafts/${created.draft_id}/confirm`, headers: { ...context.owner, 'idempotency-key': 'controls-confirm-001' }, payload: { confirmed: true } });
  expect(confirmed.statusCode, confirmed.body).toBe(201);
  const mandate = confirmed.json<{ mandate_id: string }>();
  const config = await newConfig(context.app, mandate.mandate_id, context.owner, 'first');
  const runResponse = await context.app.inject({ method: 'POST', url: '/api/simulations', headers: { 'idempotency-key': 'controls-create-run' }, payload: { config_id: config.config_id } });
  expect(runResponse.statusCode, runResponse.body).toBe(201);
  const run = runResponse.json<SimRun>();
  const next = await context.app.inject({ method: 'POST', url: `/api/simulations/${run.run_id}/next`, headers: { 'idempotency-key': 'controls-next-001' }, payload: {} });
  expect(next.statusCode, next.body).toBe(200);
  const pending = next.json<{ run: SimRun; assessment: Assessment }>();
  expect(pending.assessment.execution_state).toBe('awaiting_user');
  expect(pending.run.reservations).toHaveLength(1);
  return { ...context, mandate, config, run: pending.run, assessment: pending.assessment };
}
async function newConfig(app: FastifyInstance, mandate: string, headers: Record<string, string>, tag: string, max = '20') {
  const suggested = await app.inject({ method: 'POST', url: `/api/mandates/${mandate}/safety-configs`, headers: { 'idempotency-key': `controls-suggest-${tag}` }, payload: {} });
  const config = suggested.json<SafetyConfig>();
  const confirmed = await app.inject({ method: 'POST', url: `/api/safety-configs/${config.config_id}/confirm`, headers: { ...headers, 'idempotency-key': `controls-config-${tag}` }, payload: { parameters: { ...config.parameters, domestic_country: 'CH', always_ask: true, max_order_chf: max }, reviewed_requirement_ids: config.requirements.map((requirement) => requirement.requirement_id) } });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return confirmed.json<SafetyConfig>();
}

it('keeps a customer cancellation terminal when an agent requests reassessment', async () => {
  const context = await controlledRun();
  const base = `/api/simulations/${context.run.run_id}/authorizations/${context.assessment.authorization_id}`;
  const cancelled = await context.app.inject({ method: 'POST', url: `${base}/cancel`, headers: { ...context.owner, 'idempotency-key': 'controls-cancel-001' }, payload: {} });
  expect(cancelled.statusCode).toBe(200);
  const run = cancelled.json<SimRun>();
  const last = run.purchases[0]!.assessments.at(-1)!;
  const reassessed = await context.app.inject({ method: 'POST', url: `${base}/reassess`, headers: { 'idempotency-key': 'controls-reassess-001' }, payload: { expected_revision: last.revision } });
  expect(reassessed.statusCode, reassessed.body).toBe(409);
  expect(reassessed.json().error.code).toBe('G05_PURCHASE_CANCELLED');
  const persisted = (await context.app.inject(`/api/simulations/${run.run_id}`)).json<SimRun>();
  expect(persisted.purchases[0]!.assessments.at(-1)).toEqual(last);
  expect(persisted.reservations).toEqual([]);
  expect(persisted.commitments).toEqual([]);
});

it('preserves pending reservations and assessment when reapplying the same configuration', async () => {
  const context = await controlledRun();
  const response = await context.app.inject({ method: 'POST', url: `/api/simulations/${context.run.run_id}/config`, headers: { ...context.owner, 'idempotency-key': 'controls-reapply-config' }, payload: { config_id: context.config.config_id } });
  expect(response.statusCode, response.body).toBe(200);
  const current = response.json<SimRun>();
  expect(current.reservations).toEqual(context.run.reservations);
  expect(current.purchases).toEqual(context.run.purchases);
  expect(current.audit).toEqual(context.run.audit);
});

it('rebuilds consent and reservations atomically for a genuinely changed configuration', async () => {
  const context = await controlledRun();
  const changed = await newConfig(context.app, context.mandate.mandate_id, context.owner, 'changed');
  const response = await context.app.inject({ method: 'POST', url: `/api/simulations/${context.run.run_id}/config`, headers: { ...context.owner, 'idempotency-key': 'controls-new-config' }, payload: { config_id: changed.config_id } });
  expect(response.statusCode, response.body).toBe(200);
  const current = response.json<SimRun>();
  const latest = current.purchases[0]!.assessments.at(-1)!;
  expect(latest.execution_state).toBe('awaiting_user');
  expect(latest.offer_hash).not.toBe(context.assessment.offer_hash);
  expect(latest.revision).toBe(context.assessment.revision + 1);
  expect(current.reservations).toHaveLength(1);
  expect(current.reservations[0]!.offer_hash).toBe(latest.offer_hash);
  const stale = await context.app.inject({ method: 'POST', url: `/api/simulations/${context.run.run_id}/authorizations/${latest.authorization_id}/human-responses`, headers: { ...context.owner, 'idempotency-key': 'controls-stale-answer' }, payload: { expected_revision: context.assessment.revision, offer_hash: context.assessment.offer_hash, question_id: context.assessment.questions[0]!.question_id, value: 'confirm' } });
  expect(stale.statusCode).toBe(409);
  const tighter = await newConfig(context.app, context.mandate.mandate_id, context.owner, 'tighter', '19');
  const tightened = await context.app.inject({ method: 'POST', url: `/api/simulations/${context.run.run_id}/config`, headers: { ...context.owner, 'idempotency-key': 'controls-tighter-config' }, payload: { config_id: tighter.config_id } });
  expect(tightened.statusCode, tightened.body).toBe(200);
  expect(tightened.json<SimRun>().purchases[0]!.assessments.at(-1)!.execution_state).toBe('declined');
  expect(tightened.json<SimRun>().reservations).toEqual([]);
});

it('requires the matching human channel for legacy confirmation, patch and revoke even on cache replay', async () => {
  const context = await setup();
  const created = await draft(context.app);
  const wrong = await session(context.app, 'SCEN0002');
  const confirmRequest = { method: 'POST' as const, url: `/api/mandate-drafts/${created.draft_id}/confirm`, headers: { 'idempotency-key': 'controls-legacy-confirm' }, payload: { confirmed: true } };
  for (const headers of [confirmRequest.headers, { ...confirmRequest.headers, ...wrong }, { ...confirmRequest.headers, ...context.owner, 'x-csrf-token': 'wrong' }]) expect((await context.app.inject({ ...confirmRequest, headers })).statusCode).toBe(403);
  const confirmed = await context.app.inject({ ...confirmRequest, headers: { ...confirmRequest.headers, ...context.owner } });
  expect(confirmed.statusCode).toBe(201);
  expect((await context.app.inject({ ...confirmRequest, headers: { ...confirmRequest.headers, ...wrong } })).statusCode).toBe(403);
  const mandate = confirmed.json<{ mandate_id: string }>();
  for (const method of ['PATCH', 'DELETE'] as const) {
    const request = { method, url: `/api/mandates/${mandate.mandate_id}`, headers: { 'idempotency-key': `controls-legacy-${method}` }, ...(method === 'PATCH' ? { payload: { expected_version: 1, guidance: ['Reviewed by the customer.'] } } : {}) };
    expect((await context.app.inject(request)).statusCode).toBe(403);
    expect((await context.app.inject({ ...request, headers: { ...request.headers, ...wrong } })).statusCode).toBe(403);
    expect((await context.app.inject({ ...request, headers: { ...request.headers, ...context.owner } })).statusCode).toBe(200);
    expect((await context.app.inject({ ...request, headers: { ...request.headers, ...wrong } })).statusCode).toBe(403);
  }
  expect((await context.app.inject(`/api/mandates/${mandate.mandate_id}`)).json().status).toBe('revoked');
});

it('rejects a confirmation whose explicit mode differs from the saved preparation before any API call', async () => {
  const context = await setup();
  const options = (await context.app.inject('/api/wallet/options')).json<{ scenarios: Array<{ scenario_id: string; instruction: string }> }>();
  const instruction = options.scenarios.find((scenario) => scenario.scenario_id === 'SCEN0000')!.instruction;
  const prepared = await context.app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...context.owner, 'idempotency-key': 'controls-live-preparation' }, payload: { scenario_id: 'SCEN0000', instruction, mode: 'live' } });
  const preparation = prepared.json<WalletPreparation>();
  const response = await context.app.inject({ method: 'POST', url: `/api/wallet/preparations/${preparation.preparation_id}/confirm`, headers: { ...context.owner, 'idempotency-key': 'controls-mode-mismatch' }, payload: { confirmed: true, mode: 'local', parameters: preparation.config!.parameters } });
  expect(response.statusCode, response.body).toBe(409);
  expect(context.transport).not.toHaveBeenCalled();
  expect((await context.app.inject(`/api/wallet/preparations/${preparation.preparation_id}`)).json<WalletPreparation>().confirmation).toBeUndefined();
  expect((await context.app.inject('/api/wallet/runs')).json().runs).toEqual([]);
});
