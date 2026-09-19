import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import { createMockApi, LOCAL_MOCK_API_KEY } from '../apps/api-mock/src/app.js';
import type { WalletPreparation, WalletRunView } from '../packages/contracts/src/wallet.js';
import type { AuthorizationEvent } from '../packages/contracts/src/event.js';
import type { LocalAppOptions } from '../apps/local-web/src/app.js';
import { SimulationStore } from '../packages/local-runtime/src/simulation/store.js';

type Call = { method: string; path: string; body: Record<string, unknown> | null; authorization: string | null };
type SessionHeaders = { cookie: string; 'x-csrf-token': string; 'idempotency-key': string };
const resources: Array<{ apps: FastifyInstance[]; mock: FastifyInstance; directory: string }> = [];
const engineResults: Array<{ scenario: string; human_choice: string; purchases: number; approved: number; declined: number; resolved: number; approved_chf: string }> = [];
afterAll(async () => { if (process.env['VISECA_API_ENGINE_REPORT']) await writeFile(process.env['VISECA_API_ENGINE_REPORT'], JSON.stringify(engineResults, null, 2) + '\n'); });

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const app of resource.apps.reverse()) await app.close();
    await resource.mock.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function setup(apiKey = LOCAL_MOCK_API_KEY) {
  const directory = await mkdtemp(join(tmpdir(), 'viseca-api-readiness-'));
  const mock = await createMockApi({ dataDir: resolve('data'), stateDir: join(directory, 'platform'), decisionTimeoutMs: 8_000, humanTimeoutMs: 120_000 });
  const resource = { apps: [] as FastifyInstance[], mock, directory };
  resources.push(resource);
  const calls: Call[] = [];
  const decode = vi.fn(async (): Promise<never> => { throw new Error('Readiness tests must never call an AI service.'); });
  const transport = async (path: string, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, authorization: headers['authorization'] ?? null });
    // Forward cancellation to the injected request itself, so an abandoned
    // long poll cannot consume the next authorization after its client stops.
    const response = await mock.inject({
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: path,
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return new Response(response.statusCode === 204 ? null : response.body, {
      status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type'] ?? '') },
    });
  };
  const options: LocalAppOptions = {
    dataDir: resolve('data'), stateDir: join(directory, 'wallet'), outputDir: join(directory, 'output'), webDir: resolve('apps/local-web/web'),
    instructionDecoder: { model: 'disabled-readiness-model', configured: false, decode },
    liveOptions: { baseUrl: 'http://127.0.0.1:4313', apiKey, transport, environment: 'mock' },
  };
  const open = async () => { const app = await createLocalApp(options); resource.apps.push(app); return app; };
  const app = await open();
  return { app, mock, calls, decode, resource, open };
}

async function session(app: FastifyInstance, scenarioId: string): Promise<SessionHeaders> {
  const response = await app.inject(`/api/wallet/session?scenario_id=${scenarioId}`);
  expect(response.statusCode, response.body).toBe(200);
  return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json<{ csrf: string }>().csrf, 'idempotency-key': `readiness-${scenarioId}-prepare` };
}

async function prepare(app: FastifyInstance, scenarioId: string) {
  const options = (await app.inject('/api/wallet/options')).json<{ live_configured: boolean; ai_configured: boolean; scenarios: Array<{ scenario_id: string; instruction: string }> }>();
  expect(options.live_configured).toBe(true);
  expect(options.ai_configured).toBe(false);
  const instruction = options.scenarios.find((entry) => entry.scenario_id === scenarioId)!.instruction;
  const headers = await session(app, scenarioId);
  const response = await app.inject({ method: 'POST', url: '/api/wallet/prepare', headers, payload: { scenario_id: scenarioId, instruction, mode: 'live' } });
  expect(response.statusCode, response.body).toBe(202);
  const preparationId = response.json<WalletPreparation>().preparation_id;
  await expect.poll(async () => (await app.inject(`/api/wallet/preparations/${preparationId}`)).json<WalletPreparation>().status).toBe('ready');
  const preparation = (await app.inject(`/api/wallet/preparations/${preparationId}`)).json<WalletPreparation>();
  expect(preparation.instruction).toBe(instruction);
  expect(preparation.mode).toBe('live');
  return { preparation, headers, instruction };
}

function confirm(app: FastifyInstance, preparation: WalletPreparation, headers: SessionHeaders, key = 'readiness-confirm-001') {
  return app.inject({ method: 'POST', url: `/api/wallet/preparations/${preparation.preparation_id}/confirm`, headers: { ...headers, 'idempotency-key': key }, payload: { confirmed: true, parameters: preparation.config!.parameters } });
}

async function runView(app: FastifyInstance, id: string): Promise<WalletRunView> {
  const response = await app.inject(`/api/wallet/runs/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WalletRunView>();
}

const mutations = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

describe('wallet API readiness against the local HTTP protocol simulator', () => {
  it.each(['SCEN0000', 'SCEN0001', 'SCEN0002', 'SCEN0003', 'SCEN0004'].flatMap(scenarioId => (['approve', 'decline'] as const).map(humanChoice => ({ scenarioId, humanChoice }))))('$scenarioId full engine / explicit human $humanChoice reconciles all purchases and money', async ({ scenarioId, humanChoice }) => {
    const context = await setup();
    const prepared = await prepare(context.app, scenarioId);
    const parameters = structuredClone(prepared.preparation.config!.parameters);
    if (scenarioId === 'SCEN0004') parameters.allowed_item_ids = ['IT0017'];
    const confirmation = await context.app.inject({ method: 'POST', url: `/api/wallet/preparations/${prepared.preparation.preparation_id}/confirm`, headers: { ...prepared.headers, 'idempotency-key': `full-engine-${scenarioId}-${humanChoice}` }, payload: { confirmed: true, mode: 'live', parameters } });
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    const id = confirmation.json<{ run_id: string }>().run_id;
    const total = { SCEN0000: 1, SCEN0001: 10, SCEN0002: 12, SCEN0003: 11, SCEN0004: 11 }[scenarioId]!;
    await expect.poll(async () => (await runView(context.app, id)).purchases.length, { timeout: 10_000, interval: 30 }).toBe(total);
    const observed = await runView(context.app, id);
    const pending = observed.purchases.filter(purchase => purchase.assessment?.execution_state === 'awaiting_user');
    for (const purchase of pending) {
      const assessment = purchase.assessment!;
      // Explicit synthetic customer approvals apply only to answerable risk questions.
      // Missing product facts require corrected evidence; these cases are rejected.
      const decision = humanChoice === 'approve' && assessment.questions.every(question => question.kind === 'confirm_risk') ? 'approve' : 'decline';
      const response = await context.app.inject({ method: 'POST', url: `/api/wallet/runs/${id}/human-responses`, headers: { ...prepared.headers, 'idempotency-key': `full-engine-answer-${purchase.authorization_id}` }, payload: { authorization_id: purchase.authorization_id, decision, ...(decision === 'approve' ? { offer_hash: assessment.offer_hash, expected_revision: assessment.revision, answers: assessment.questions.map(question => ({ question_id: question.question_id, value: 'confirm' })) } : { answers: [] }) } });
      // A preceding approval can legitimately exhaust capacity for a later pending offer.
      if (response.statusCode === 422 && decision === 'approve') {
        expect(response.json().error.code).toMatch(/human_resolution_rejected|live_approval_rejected|explicit_answers_required|approval/i);
        const rejected = await context.app.inject({ method: 'POST', url: `/api/wallet/runs/${id}/human-responses`, headers: { ...prepared.headers, 'idempotency-key': `full-engine-decline-${purchase.authorization_id}` }, payload: { authorization_id: purchase.authorization_id, decision: 'decline', answers: [] } });
        expect(rejected.statusCode, rejected.body).toBe(200);
      } else expect(response.statusCode, response.body).toBe(200);
    }
    await expect.poll(async () => (await runView(context.app, id)).status, { timeout: 8_000, interval: 30 }).toBe('completed');
    const finished = await runView(context.app, id);
    expect(finished.purchases).toHaveLength(total);
    expect(finished.reservations).toBe(0);
    for (const purchase of finished.purchases) {
      expect(purchase.assessment?.results).toHaveLength(50);
      expect(['approved', 'declined']).toContain(purchase.assessment?.execution_state);
      if (purchase.assessment!.results.some(result => result.outcome === 'fail' && purchase.assessment!.blocking_filter_ids.includes(result.filter_id))) expect(purchase.assessment?.execution_state).toBe('declined');
    }
    const platform = (await context.mock.inject({ url: '/v1/authorizations', headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } })).json<{ data: Array<{ authorization_id: string; status: string }> }>().data;
    expect(platform).toHaveLength(total);
    for (const purchase of finished.purchases) expect(platform.find(row => row.authorization_id === purchase.authorization_id)?.status).toBe(purchase.assessment?.execution_state);
    const events = (await context.mock.inject({ url: '/v1/events?since=0', headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } })).json<{ data: Array<{ type: string; data: AuthorizationEvent }> }>().data.filter(event => event.type === 'authorization.request').map(event => event.data);
    const approvedIds = new Set(platform.filter(row => row.status === 'approved').map(row => row.authorization_id));
    const approvedEvents = events.filter(event => approvedIds.has(event.authorization.authorization_id));
    for (const event of approvedEvents) {
      const cents = Math.round(event.authorization.billing_amount_chf * 100);
      if (parameters.min_order_chf !== null) expect(cents).toBeGreaterThanOrEqual(Math.round(Number(parameters.min_order_chf) * 100));
      if (parameters.max_order_chf !== null) expect(cents).toBeLessThanOrEqual(Math.round(Number(parameters.max_order_chf) * 100));
      if (parameters.rolling_budget) {
        const end = Date.parse(event.authorization.timestamp), start = end - parameters.rolling_budget.days * 86_400_000;
        const windowCents = approvedEvents.filter(prior => Date.parse(prior.authorization.timestamp) >= start && Date.parse(prior.authorization.timestamp) <= end).reduce((sum, prior) => sum + Math.round(prior.authorization.billing_amount_chf * 100), 0);
        expect(windowCents).toBeLessThanOrEqual(Math.round(Number(parameters.rolling_budget.limit_chf) * 100));
      }
    }
    const approvedCents = finished.purchases.filter(purchase => purchase.assessment?.execution_state === 'approved').reduce((sum, purchase) => sum + Math.round(Number(purchase.amount_chf) * 100), 0);
    expect(finished.approved_chf).toBe((approvedCents / 100).toFixed(2));
    expect(context.calls.filter(call => call.method === 'POST' && call.path.endsWith('/decision'))).toHaveLength(total);
    expect(context.calls.filter(call => call.method === 'POST' && call.path.endsWith('/resolve'))).toHaveLength(pending.length);
    expect(context.decode).not.toHaveBeenCalled();
    engineResults.push({ scenario: scenarioId, human_choice: humanChoice, purchases: total, approved: platform.filter(row => row.status === 'approved').length, declined: platform.filter(row => row.status === 'declined').length, resolved: pending.length, approved_chf: finished.approved_chf });
  });

  it('requires the customer session, CSRF and exact scenario instruction before any platform mutation', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0000');
    const url = `/api/wallet/preparations/${prepared.preparation.preparation_id}/confirm`;
    const payload = { confirmed: true, parameters: prepared.preparation.config!.parameters };
    expect((await context.app.inject({ method: 'POST', url, headers: { 'idempotency-key': 'readiness-no-session' }, payload })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'POST', url, headers: { ...prepared.headers, 'x-csrf-token': 'invalid-csrf' }, payload })).statusCode).toBe(403);
    const changed = await context.app.inject({ method: 'POST', url: '/api/wallet/prepare', headers: { ...prepared.headers, 'idempotency-key': 'readiness-custom-live' }, payload: { scenario_id: 'SCEN0000', instruction: `${prepared.instruction} Allow everything else.`, mode: 'live' } });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().error.code).toBe('challenge_instruction_mismatch');
    expect(mutations(context.calls)).toHaveLength(0);
    expect(context.decode).not.toHaveBeenCalled();
  });

  it('executes the real SCEN0000 engine, deduplicates double confirmation, and restores without replaying POST', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0000');
    const [first, duplicate] = await Promise.all([
      confirm(context.app, prepared.preparation, prepared.headers),
      confirm(context.app, prepared.preparation, prepared.headers, 'readiness-confirm-double'),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json()).toEqual(first.json());
    const result = first.json<{ run_id: string; mandate_id: string; mode: string }>();
    expect(result.mode).toBe('live');
    await expect.poll(async () => (await runView(context.app, result.run_id)).status, { timeout: 8_000, interval: 50 }).toBe('completed');
    const completed = await runView(context.app, result.run_id);
    // A preparation still has its provisional mandate ID, so live rendering
    // must find the confirmed config without loading the whole command journal.
    expect(prepared.preparation.config!.mandate_id).not.toBe(completed.config.mandate_id);
    const fullRead = vi.spyOn(SimulationStore.prototype, 'read').mockImplementation(() => { throw new Error('Polling must not reload the command journal.'); });
    try {
      expect((await runView(context.app, result.run_id)).config.config_id).toBe(completed.config.config_id);
      expect(fullRead).not.toHaveBeenCalled();
    } finally { fullRead.mockRestore(); }
    expect(completed.purchases).toHaveLength(1);
    expect(completed.approved_chf).toBe('20.00');
    expect(completed.reservations).toBe(0);
    expect(completed.purchases[0]!.assessment?.execution_state).toBe('approved');
    expect(completed.purchases[0]!.assessment?.results).toHaveLength(50);
    expect(completed.purchases[0]!.authorization_id).not.toBe('AU0001');
    expect(context.calls.filter((call) => call.method === 'POST' && call.path === '/v1/mandates')).toHaveLength(1);
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/confirm'))).toHaveLength(1);
    expect(context.calls.filter((call) => call.method === 'POST' && call.path === '/v1/scenario-runs')).toHaveLength(1);
    const decisions = context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/decision'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.body).toMatchObject({ authorization_id: completed.purchases[0]!.authorization_id, decision: 'approve' });
    expect(context.calls.every((call) => call.authorization === `Bearer ${LOCAL_MOCK_API_KEY}`)).toBe(true);
    expect(context.decode).not.toHaveBeenCalled();

    const beforeRestart = mutations(context.calls).length;
    await context.app.close();
    context.resource.apps.splice(context.resource.apps.indexOf(context.app), 1);
    const restored = await context.open();
    const restoredHeaders = await session(restored, 'SCEN0000');
    expect((await runView(restored, result.run_id)).approved_chf).toBe('20.00');
    const retry = await confirm(restored, prepared.preparation, restoredHeaders, 'readiness-confirm-after-restart');
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(result);
    expect(mutations(context.calls)).toHaveLength(beforeRestart);
    expect((await restored.inject('/api/wallet/runs')).json().runs).toHaveLength(1);
  });

  it('enforces SCEN0001 purchase and rolling budgets with all ten real engine decisions', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0001');
    const confirmed = await confirm(context.app, prepared.preparation, prepared.headers);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const { run_id: runId } = confirmed.json<{ run_id: string }>();
    await expect.poll(async () => (await runView(context.app, runId)).purchases.length, { timeout: 10_000, interval: 50 }).toBe(10);
    const observed = await runView(context.app, runId);
    expect(observed.config.parameters.max_order_chf).toBe('120');
    expect(observed.config.parameters.rolling_budget).toEqual({ days: 7, limit_chf: '300' });
    expect(observed.purchases.every((purchase) => purchase.assessment?.results.length === 50)).toBe(true);
    const reasonCodes = observed.purchases.flatMap((purchase) => purchase.assessment?.results.flatMap((result) => result.reasons.map((reason) => reason.code)) ?? []);
    expect(reasonCodes).toContain('C09_PURCHASE_LIMIT_EXCEEDED');
    expect(reasonCodes).toContain('C10_ROLLING_BUDGET_EXCEEDED');
    await expect.poll(async () => (await runView(context.app, runId)).status, { timeout: 8_000, interval: 50 }).toBe('completed');
    const completed = await runView(context.app, runId);
    const approved = completed.purchases.filter((purchase) => purchase.assessment?.execution_state === 'approved');
    expect(approved.length).toBeGreaterThan(0);
    expect(completed.approved_chf).toBe((approved.reduce((sum, purchase) => sum + Math.round(Number(purchase.amount_chf) * 100), 0) / 100).toFixed(2));
    for (const purchase of completed.purchases) {
      const budgetViolation = purchase.assessment!.results.some((result) => ['C09', 'C10'].includes(result.filter_id) && result.outcome === 'fail');
      if (budgetViolation) expect(purchase.assessment!.execution_state).toBe('declined');
    }
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/decision'))).toHaveLength(10);
    expect(context.decode).not.toHaveBeenCalled();
  });

  it('keeps SCEN0003 step-ups pending until explicit human rejection through resolve', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0003');
    const confirmed = await confirm(context.app, prepared.preparation, prepared.headers);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const { run_id: runId } = confirmed.json<{ run_id: string }>();
    await expect.poll(async () => (await runView(context.app, runId)).purchases.length, { timeout: 10_000, interval: 50 }).toBe(11);
    const observed = await runView(context.app, runId);
    const pending = observed.purchases.filter((purchase) => purchase.assessment?.execution_state === 'awaiting_user');
    expect(pending.length).toBeGreaterThan(0);
    expect(observed.reservations).toBeGreaterThan(0);
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resolve'))).toHaveLength(0);
    const approvedBefore = observed.approved_chf;
    const needsAnswers = pending.find((purchase) => purchase.assessment!.questions.length > 0)!;
    expect(needsAnswers).toBeDefined();
    const withoutAnswers = await context.app.inject({ method: 'POST', url: `/api/wallet/runs/${runId}/human-responses`, headers: { ...prepared.headers, 'idempotency-key': 'readiness-no-human-answers' }, payload: { authorization_id: needsAnswers.authorization_id, decision: 'approve', answers: [], offer_hash: needsAnswers.assessment!.offer_hash, expected_revision: needsAnswers.assessment!.revision } });
    expect(withoutAnswers.statusCode, withoutAnswers.body).toBe(422);
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resolve'))).toHaveLength(0);
    for (const purchase of pending) {
      const rejected = await context.app.inject({ method: 'POST', url: `/api/wallet/runs/${runId}/human-responses`, headers: { ...prepared.headers, 'idempotency-key': `readiness-decline-${purchase.authorization_id}` }, payload: { authorization_id: purchase.authorization_id, decision: 'decline', answers: [] } });
      expect(rejected.statusCode, rejected.body).toBe(200);
      const returned = rejected.json<WalletRunView>().purchases.find((entry) => entry.authorization_id === purchase.authorization_id)!;
      expect(returned.assessment?.execution_state).toBe('declined');
    }
    await expect.poll(async () => (await runView(context.app, runId)).status, { timeout: 8_000, interval: 50 }).toBe('completed');
    const completed = await runView(context.app, runId);
    expect(completed.approved_chf).toBe(approvedBefore);
    expect(completed.reservations).toBe(0);
    const resolutions = context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resolve'));
    expect(resolutions).toHaveLength(pending.length);
    expect(resolutions.every((call) => call.body?.['decision'] === 'decline')).toBe(true);
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/decision'))).toHaveLength(11);
    expect(context.decode).not.toHaveBeenCalled();
  });

  it('reports bad platform credentials clearly and does not create a remote mandate', async () => {
    const invalidKey = 'invalid-local-mock-credential';
    const context = await setup(invalidKey);
    const prepared = await prepare(context.app, 'SCEN0000');
    const response = await confirm(context.app, prepared.preparation, prepared.headers);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const error = response.json<{ error: { code: string; message: string } }>().error;
    expect(`${error.code} ${error.message}`).toMatch(/auth|credential|token|401/i);
    expect(response.body).not.toContain(invalidKey);
    expect(response.body).not.toContain(LOCAL_MOCK_API_KEY);
    expect(mutations(context.calls)).toHaveLength(0);
    expect((await context.app.inject('/api/wallet/runs')).json().runs).toHaveLength(0);
  });

  it('accepts a SCEN0003 approval only after every actual risk question has an explicit answer', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0003');
    const confirmed = await confirm(context.app, prepared.preparation, prepared.headers);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const { run_id: runId } = confirmed.json<{ run_id: string }>();
    await expect.poll(async () => (await runView(context.app, runId)).purchases.length, { timeout: 10_000, interval: 50 }).toBe(11);
    const before = await runView(context.app, runId);
    const eligible = before.purchases.filter((purchase) => purchase.assessment?.execution_state === 'awaiting_user' && purchase.assessment.questions.length > 0 && purchase.assessment.questions.every((question) => question.kind === 'confirm_risk'));
    eligible.sort((left, right) => right.assessment!.questions.length - left.assessment!.questions.length);
    expect(eligible.length, JSON.stringify(before.purchases.map((purchase) => ({ id: purchase.authorization_id, state: purchase.assessment?.execution_state, questions: purchase.assessment?.questions })))).toBeGreaterThan(0);
    const purchase = eligible[0]!;
    const assessment = purchase.assessment!;
    const answers = assessment.questions.map((question) => ({ question_id: question.question_id, value: 'confirm' }));
    const payload = { authorization_id: purchase.authorization_id, decision: 'approve', offer_hash: assessment.offer_hash, expected_revision: assessment.revision, answers };
    const url = `/api/wallet/runs/${runId}/human-responses`;
    const incomplete = await context.app.inject({ method: 'POST', url, headers: { ...prepared.headers, 'idempotency-key': 'readiness-subset-risk-answers' }, payload: { ...payload, answers: answers.slice(0, -1) } });
    expect(incomplete.statusCode, incomplete.body).toBe(422);
    expect(incomplete.json().error.code).toBe('explicit_answers_required');
    expect(context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resolve'))).toHaveLength(0);
    const pending = await runView(context.app, runId);
    expect(pending.approved_chf).toBe(before.approved_chf);
    expect(pending.reservations).toBe(before.reservations);

    const accepted = await context.app.inject({ method: 'POST', url, headers: { ...prepared.headers, 'idempotency-key': 'readiness-all-risk-answers' }, payload });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = accepted.json<WalletRunView>();
    const finalized = after.purchases.find((entry) => entry.authorization_id === purchase.authorization_id)!;
    expect(finalized.assessment?.execution_state).toBe('approved');
    expect(finalized.assessment?.decision).toBe('approve');
    expect(finalized.assessment?.questions).toEqual([]);
    expect(finalized.assessment?.lock).toBeNull();
    expect(after.approved_chf).toBe(((Math.round(Number(before.approved_chf) * 100) + Math.round(Number(purchase.amount_chf) * 100)) / 100).toFixed(2));
    expect(after.reservations).toBe(before.reservations - 1);
    const resolution = context.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resolve'));
    expect(resolution).toHaveLength(1);
    expect(resolution[0]!.path).toBe(`/v1/authorizations/${purchase.authorization_id}/resolve`);
    expect(resolution[0]!.body).toMatchObject({ authorization_id: purchase.authorization_id, decision: 'approve' });
    const platform = await context.mock.inject({ method: 'GET', url: '/v1/authorizations', headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } });
    expect(platform.statusCode, platform.body).toBe(200);
    expect(platform.json<{ data: Array<{ authorization_id: string; status: string; decision: string }> }>().data.find((entry) => entry.authorization_id === purchase.authorization_id)).toMatchObject({ status: 'approved', decision: 'approve' });
    expect(context.decode).not.toHaveBeenCalled();
  });

  it('revokes the platform mandate from the wallet while retaining accepted purchase history', async () => {
    const context = await setup();
    const prepared = await prepare(context.app, 'SCEN0000');
    const confirmed = await confirm(context.app, prepared.preparation, prepared.headers);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const result = confirmed.json<{ run_id: string; mandate_id: string }>();
    await expect.poll(async () => (await runView(context.app, result.run_id)).status, { timeout: 8_000, interval: 50 }).toBe('completed');
    const revoked = await context.app.inject({ method: 'POST', url: `/api/wallet/runs/${result.run_id}/revoke`, headers: { ...prepared.headers, 'idempotency-key': 'readiness-revoke-live-mandate' }, payload: {} });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const after = revoked.json<WalletRunView>();
    expect(after.status).toBe('completed');
    expect(after.mandate_status).toBe('revoked');
    expect(after.approved_chf).toBe('20.00');
    expect(after.reservations).toBe(0);
    expect(after.purchases[0]!.assessment?.execution_state).toBe('approved');
    expect(context.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/v1/mandates/${result.mandate_id}`]);
    const platform = await context.mock.inject({ method: 'GET', url: `/v1/mandates/${result.mandate_id}`, headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } });
    expect(platform.statusCode, platform.body).toBe(200);
    expect(platform.json().status).toBe('revoked');
  });
});
