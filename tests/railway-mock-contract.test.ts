import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createMockApi, LOCAL_MOCK_API_KEY } from '../apps/api-mock/src/app.js';
import { loadDataPack } from '../packages/local-runtime/src/data/loader.js';
import { VisecaClient, VisecaHttpError } from '../packages/local-runtime/src/simulation/viseca-client.js';
import { VisecaOutbox, VisecaWorker } from '../packages/local-runtime/src/simulation/viseca-worker.js';

let instruction = '';
const resources: Array<{ app: FastifyInstance; client: VisecaClient; outbox: VisecaOutbox; directory: string }> = [];
beforeAll(async () => { instruction = (await loadDataPack()).scenarios[0]!.cardholder_instruction; });
afterEach(async () => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    resource.client.close();
    resource.outbox.close();
    await resource.app.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function setup(contractProfile: 'documented' | 'railway' = 'railway') {
  const directory = await mkdtemp(join(tmpdir(), 'railway-mock-contract-'));
  const app = await createMockApi({ contractProfile, decisionTimeoutMs: 1_000, humanTimeoutMs: 1_000 });
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new VisecaClient('http://127.0.0.1:4313', LOCAL_MOCK_API_KEY, async (path, init) => {
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}), ...(init?.signal ? { signal: init.signal } : {}) });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
  });
  const outbox = new VisecaOutbox(join(directory, 'outbox.sqlite'));
  resources.push({ app, client, outbox, directory });
  await outbox.load();
  const bootstrap = await client.bootstrap();
  expect(bootstrap['contract_profile']).toBe(contractProfile);
  const draft = await client.createMandate({ instruction, hard_rules: [], uncertainty_policy: 'ask', guidance: [], open_questions: [] });
  const mandate = await client.confirmMandate(String(draft['draft_id']), { confirmed: true });
  const run = await client.createRun({ scenario_id: 'SCEN0000', mandate_id: mandate['mandate_id'] });
  const worker = new VisecaWorker(client, outbox, () => Date.now(), 100);
  await worker.startRun(String(run['run_id']), {}, 1_000);
  const records = async () => (await app.inject({ url: '/v1/authorizations', headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } })).json<{ data: Array<{ status: string; decision: string | null; is_final?: boolean; authorization_id: string }> }>().data;
  return { app, client, worker, posts, records };
}

it.each(['approve', 'decline'] as const)('real client and worker resolve Railway mock with explicit human %s', async decision => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { worker, posts, records } = await setup();
  const pending = await worker.pollOnce(async () => ({ decision: 'step_up' }));
  expect(pending).toMatchObject({ state: 'awaiting_human', reserved: true, accepted: { decision: 'step_up' } });
  expect((await records())[0]).toMatchObject({ status: 'awaiting_customer', decision: 'step_up', is_final: false });
  expect(posts.filter(post => post.path.endsWith('/resolve'))).toEqual([]);
  await worker.resolve(pending!.id, decision, 'synthetic-human-proof', async () => ({ actor_id: 'synthetic-customer', proof: 'synthetic-human-proof' }), async () => true);
  expect((await records())[0]).toMatchObject({ status: decision === 'approve' ? 'approved' : 'declined', decision, is_final: true });
  expect(worker.listEntries()[0]).toMatchObject({ state: 'accepted', reserved: false, accepted: { decision } });
  const resolutions = posts.filter(post => post.path.endsWith('/resolve'));
  expect(resolutions).toHaveLength(1);
  expect(Object.keys(resolutions[0]!.body).sort()).toEqual(['authorization_id', 'decision', 'evidence']);
  expect(worker.listPending()).toEqual([]);
});

it('Railway mock rejects legacy engine_version on resolve without changing pending state', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { client, worker, records } = await setup();
  const pending = await worker.pollOnce(async () => ({ decision: 'step_up' }));
  const before = await records();
  await expect(client.resolve(pending!.id, 'approve', { evidence: [], engine_version: 'legacy-test-engine' })).rejects.toMatchObject({ status: 422 } satisfies Partial<VisecaHttpError>);
  expect(await records()).toEqual(before);
  await worker.resolve(pending!.id, 'decline', 'proof', async () => ({ actor_id: 'test-customer', proof: 'proof' }), async () => true);
  expect((await records())[0]).toMatchObject({ status: 'declined', decision: 'decline', is_final: true });
});

it('documented mock profile preserves its original awaiting_human and resolve payload contract', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { client, worker, records } = await setup('documented');
  const pending = await worker.pollOnce(async () => ({ decision: 'step_up' }));
  expect((await records())[0]).toMatchObject({ status: 'awaiting_human', decision: 'step_up' });
  expect((await records())[0]).not.toHaveProperty('is_final');
  await client.resolve(pending!.id, 'decline', { engine_version: 'documented-profile-test' });
  await worker.reconcile();
  expect(worker.listEntries()[0]).toMatchObject({ state: 'accepted', accepted: { decision: 'decline' }, reserved: false });
});

it.each(['approve', 'decline'] as const)('caller-supplied timeout reason codes cannot relabel accepted %s as a platform timeout', async decision => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { client, records } = await setup();
  const proposal = await client.poll();
  await client.decision(proposal!.data.authorization.authorization_id, decision, { reason_codes: ['decision_deadline_exceeded', 'human_deadline_exceeded'] });
  expect((await records())[0]).toMatchObject({ status: decision === 'approve' ? 'approved' : 'declined', decision, is_final: true });
});

it.each(['automatic', 'human'] as const)('Railway %s timeout reconciles as final decline, retaining the original remote decision', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { worker, records, app } = await setup();
  if (kind === 'human') await worker.pollOnce(async () => ({ decision: 'step_up' }));
  vi.setSystemTime(Date.now() + 1_001);
  const remote = (await records())[0]!;
  expect(remote).toMatchObject({ status: 'timed_out', decision: kind === 'human' ? 'step_up' : null, is_final: true });
  await worker.reconcile();
  expect(worker.listEntries()).toHaveLength(1);
  expect(worker.listEntries()[0]).toMatchObject({ state: 'accepted', accepted: { decision: 'decline' }, reserved: false });
  expect(worker.listPending()).toEqual([]);
  const feed = (await app.inject({ url: '/v1/events', headers: { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` } })).json<{ data: Array<{ type: string; status: string; data: { status: string; is_final: boolean } }> }>().data;
  expect(feed.find(event => event.type === 'authorization.expired')).toMatchObject({ status: 'timed_out', data: { status: 'timed_out', is_final: true } });
});

it.each(['approve', 'decline'] as const)('expired Railway human %s never dispatches resolve and is reconciled final', async decision => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { worker, posts } = await setup();
  const pending = await worker.pollOnce(async () => ({ decision: 'step_up' }));
  vi.setSystemTime(Date.parse(pending!.human_expires_at!));
  await expect(worker.resolve(pending!.id, decision, 'proof', async () => ({ actor_id: 'customer', proof: 'proof' }), async () => true)).rejects.toThrow('human_confirmation_expired');
  expect(posts.filter(post => post.path.endsWith('/resolve'))).toEqual([]);
  await worker.reconcile();
  expect(worker.listEntries()[0]).toMatchObject({ state: 'accepted', accepted: { decision: 'decline' }, reserved: false });
});
