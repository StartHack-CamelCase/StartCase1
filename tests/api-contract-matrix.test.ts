import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { Decimal } from "decimal.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, LOCAL_MOCK_API_KEY } from "../apps/api-mock/src/app.js";
import { loadDataPack } from "../packages/local-runtime/src/data/loader.js";
import { AuthorizationEventFactory } from "../packages/local-runtime/src/data/event-builder.js";
import { asId, type AuthorizationEvent, type DataPack, type PolicyContent, type ScenarioId } from "../packages/contracts/src/index.js";

// These are synthetic customer answers for protocol tests, never production decisions.
type Decision = "approve" | "decline" | "step_up";
type FinalDecision = Exclude<Decision, "step_up">;
type RuntimeAuthorization = { authorization_id: string; run_id: string; source_authorization_id: string; status: string; decision: Decision | null; reason_codes: string[]; finalized_at: string | null; human_deadline_at: string | null };
type Envelope = { run_id: string; authorization_id: string; event_id: string; data: AuthorizationEvent };
type Feed = { data: Array<{ event_id: string; cursor: number; type: string; authorization_id: string | null; data: unknown }>; next_cursor: string };
let app: FastifyInstance;
let pack: DataPack;
let factory: AuthorizationEventFactory;
const headers = { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` };
const priceRule = { field: "authorization.billing_amount_chf", operator: "<=", value: 20, currency: "CHF", scope: "purchase" } as const;
const metrics = { requests: 0, scenarios_completed: 0, purchases_checked: 0, automated_answers: 0, human_answers: 0, schema_checks: 0, statuses: {} as Record<string, number> };
const scenarioResults: Array<{scenario: string; strategy: string; purchases: number; approved: number; declined: number; approved_chf: string}> = [];
const temporaryApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  pack = await loadDataPack();
  factory = new AuthorizationEventFactory(pack, resolve("data/schemas/authorization_event.schema.json"));
  app = await createMockApi({ decisionTimeoutMs: 60_000, humanTimeoutMs: 120_000 });
});
beforeEach(async () => {
  expect((await request("POST", "/v1/team/reset", {})).statusCode).toBe(200);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryApps.splice(0).map((entry) => entry.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
afterAll(async () => {
  await app.close();
  if (process.env["VISECA_API_MATRIX_REPORT"]) await writeFile(process.env["VISECA_API_MATRIX_REPORT"], JSON.stringify({ metrics, scenarios: scenarioResults }, null, 2) + "\n");
});

async function request(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, target = app) {
  const options: InjectOptions = { method, url, headers };
  if (payload !== undefined) {
    options.payload = JSON.stringify(payload);
    options.headers = { ...headers, "content-type": "application/json" };
  }
  const response = await target.inject(options);
  metrics.requests++;
  metrics.statuses[String(response.statusCode)] = (metrics.statuses[String(response.statusCode)] ?? 0) + 1;
  return response;
}
function policy(scenarioId = "SCEN0000"): PolicyContent {
  return { instruction: pack.scenarios.find((entry) => entry.scenario_id === scenarioId)!.cardholder_instruction, hard_rules: [priceRule], uncertainty_policy: "ask", guidance: [], open_questions: [] };
}
async function createMandate(scenarioId = "SCEN0000", content = policy(scenarioId), target = app) {
  const draft = await request("POST", "/v1/mandates", content, target);
  expect(draft.statusCode, draft.body).toBe(201);
  const confirmed = await request("POST", `/v1/mandates/${draft.json().draft_id}/confirm`, { confirmed: true }, target);
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return confirmed.json<{ mandate_id: string; version: number }>();
}
async function start(scenarioId = "SCEN0000", target = app, content = policy(scenarioId)) {
  const mandate = await createMandate(scenarioId, content, target);
  const started = await request("POST", "/v1/scenario-runs", { scenario_id: scenarioId, mandate_id: mandate.mandate_id }, target);
  expect(started.statusCode, started.body).toBe(201);
  return { runId: started.json<{ run_id: string }>().run_id, mandateId: mandate.mandate_id };
}
async function poll(target = app): Promise<Envelope> {
  const result = await request("GET", "/v1/decision-requests/next?wait=0", undefined, target);
  expect(result.statusCode, result.body).toBe(200);
  const envelope = result.json<Envelope>();
  factory.validate(envelope.data);
  metrics.schema_checks++;
  return envelope;
}
async function decide(id: string, decision: Decision, target = app) {
  const response = await request("POST", `/v1/authorizations/${id}/decision`, { authorization_id: id, decision }, target);
  if (response.statusCode === 200) metrics.automated_answers++;
  return response;
}
async function answer(id: string, decision: FinalDecision, target = app) {
  const response = await request("POST", `/v1/authorizations/${id}/resolve`, { decision, customer_message: "Explicit synthetic customer answer in API test." }, target);
  if (response.statusCode === 200) metrics.human_answers++;
  return response;
}
async function rows(target = app) { return (await request("GET", "/v1/authorizations", undefined, target)).json<{ data: RuntimeAuthorization[] }>().data; }
async function feed(target = app) { return (await request("GET", "/v1/events?since=0", undefined, target)).json<Feed>(); }

const scenarios = ["SCEN0000", "SCEN0001", "SCEN0002", "SCEN0003", "SCEN0004"];
const strategies = ["approve", "decline", "human_approve", "human_decline", "mixed"] as const;
describe("complete public scenario x answer protocol matrix", () => {
  it.each(scenarios.flatMap((scenario) => strategies.map((strategy) => ({ scenario, strategy }))))("$scenario / $strategy preserves all facts, IDs, final results and event counts", async ({ scenario, strategy }) => {
    const { runId } = await start(scenario);
    const attempts = pack.attemptsByScenario.get(asId<ScenarioId>(scenario))!;
    const accepted = new Map<string, FinalDecision>();
    const liveIds = new Map<string, string>();
    for (let iteration = 0; iteration <= attempts.length; iteration++) {
      const status = (await request("GET", `/v1/scenario-runs/${runId}`)).json<{ status: string }>();
      if (status.status === "completed") break;
      const envelope = await poll();
      expect(envelope.run_id).toBe(runId);
      const event = envelope.data;
      const purchase = event.authorization;
      const attempt = attempts.find((entry) => entry.authorization_id === purchase.source_authorization_id)!;
      expect(attempt).toBeDefined();
      expect(liveIds.has(purchase.source_authorization_id)).toBe(false);
      liveIds.set(purchase.source_authorization_id, envelope.authorization_id);
      expect(envelope.authorization_id).toBe(purchase.authorization_id);
      expect(envelope.authorization_id).not.toBe(purchase.source_authorization_id);
      expect(purchase.timestamp).toBe(attempt.timestamp);
      expect(purchase.billing_amount_chf).toBe(Number(attempt.billing_amount_chf));
      expect(purchase.amount).toBe(Number(attempt.amount));
      expect(purchase.delivery_fee).toBe(Number(attempt.delivery_fee));
      expect(purchase.currency).toBe(attempt.currency);
      expect(purchase.items.length).toBeGreaterThan(0);
      expect(purchase.merchant.merchant_mcc).toMatch(/^\d{4}$/);
      expect(event.mandate.instruction).toBe(policy(scenario).instruction);
      expect(Date.parse(event.deadline_at) - Date.parse(event.runtime.received_at)).toBe(60_000);
      if (attempt.related_authorization_id !== null) expect(purchase.related_authorization_id).toBe(liveIds.get(attempt.related_authorization_id));
      const index = purchase.replay_order - 1;
      const human = strategy.startsWith("human_") || strategy === "mixed" && index % 3 === 2;
      const finalDecision: FinalDecision = strategy === "approve" || strategy === "human_approve" || strategy === "mixed" && index % 2 === 0 ? "approve" : "decline";
      const response = await decide(envelope.authorization_id, human ? "step_up" : finalDecision);
      expect(response.statusCode, response.body).toBe(200);
      if (human) {
        expect(response.json().status).toBe("awaiting_human");
        expect(response.json().finalized_at).toBeNull();
        const resolution = await answer(envelope.authorization_id, finalDecision);
        expect(resolution.statusCode, resolution.body).toBe(200);
        expect(resolution.json().status).toBe(finalDecision === "approve" ? "approved" : "declined");
      }
      accepted.set(envelope.authorization_id, finalDecision);
      metrics.purchases_checked++;
    }
    const runtime = (await rows()).filter((entry) => entry.run_id === runId);
    expect(runtime).toHaveLength(attempts.length);
    expect(new Set(runtime.map((entry) => entry.authorization_id)).size).toBe(attempts.length);
    for (const row of runtime) {
      if (accepted.has(row.authorization_id)) expect(row.decision).toBe(accepted.get(row.authorization_id));
      else expect(row).toMatchObject({ status: "declined", decision: "decline" });
      expect(row.finalized_at).not.toBeNull();
    }
    const completed = (await request("GET", `/v1/scenario-runs/${runId}`)).json();
    expect(completed.status).toBe("completed");
    expect(completed.counters).toMatchObject({ total: attempts.length, emitted: attempts.length, pending: 0, awaiting_human: 0, approved: runtime.filter((row) => row.status === "approved").length, declined: runtime.filter((row) => row.status === "declined").length });
    const history = await feed();
    expect(new Set(history.data.map((entry) => entry.event_id)).size).toBe(history.data.length);
    expect(history.data.map((entry) => entry.cursor)).toEqual(history.data.map((_entry, index) => index + 1));
    expect(history.data.filter((entry) => entry.type === "scenario_run.completed")).toHaveLength(1);
    for (const row of runtime) expect(history.data.filter((entry) => entry.authorization_id === row.authorization_id && ["authorization.finalized", "authorization.expired"].includes(entry.type))).toHaveLength(1);
    const empty = await request("GET", "/v1/decision-requests/next?wait=0");
    expect(empty.statusCode).toBe(204);
    expect(empty.body).toBe("");
    scenarioResults.push({ scenario, strategy, purchases: runtime.length, approved: completed.counters.approved, declined: completed.counters.declined, approved_chf: runtime.filter((row) => row.status === "approved").reduce((sum, row) => sum.plus(attempts.find((attempt) => attempt.authorization_id === row.source_authorization_id)!.billing_amount_chf), new Decimal(0)).toFixed(2) });
    metrics.scenarios_completed++;
  });
});

const protectedEndpoints = [
  ["GET", "/v1/bootstrap"], ["GET", "/v1/reference-data"], ["GET", "/v1/reference-data/authorization-history.csv"],
  ["POST", "/v1/mandates"], ["POST", "/v1/mandates/missing/confirm"], ["GET", "/v1/mandates/missing"], ["PATCH", "/v1/mandates/missing"], ["DELETE", "/v1/mandates/missing"],
  ["POST", "/v1/scenario-runs"], ["GET", "/v1/scenario-runs/missing"], ["GET", "/v1/decision-requests/next?wait=0"], ["POST", "/v1/authorizations/missing/decision"], ["POST", "/v1/authorizations/missing/resolve"], ["GET", "/v1/authorizations"], ["GET", "/v1/events"], ["POST", "/v1/team/reset"],
] as const;
describe("authentication of every protected documented endpoint", () => {
  it.each(protectedEndpoints.flatMap(([method, url]) => ["missing", "wrong", "scheme"].map((credential) => ({ method, url, credential }))))("$method $url / $credential key cannot read or mutate state", async ({ method, url, credential }) => {
    const before = await feed();
    const response = await app.inject({ method, url, headers: credential === "missing" ? {} : { authorization: credential === "wrong" ? "Bearer wrong-synthetic-key" : `Basic ${LOCAL_MOCK_API_KEY}` } });
    metrics.requests++;
    metrics.statuses[String(response.statusCode)] = (metrics.statuses[String(response.statusCode)] ?? 0) + 1;
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(response.body).not.toContain(LOCAL_MOCK_API_KEY);
    expect(await feed()).toEqual(before);
  });
});

const invalidPayloads: Array<{ label: string; payload: Record<string, unknown> }> = [
  { label: "decision absent", payload: {} },
  ...["deny", "APPROVE", "", " approve ", null, false, 1, ["approve"], {}].map((decision) => ({ label: `decision ${JSON.stringify(decision)}`, payload: { decision } })),
  ...[null, false, 42, {}, [1], ["ok", false]].map((reason_codes) => ({ label: `reasons ${JSON.stringify(reason_codes)}`, payload: { decision: "approve", reason_codes } })),
  ...[null, 42, {}, []].map((customer_message) => ({ label: `message ${JSON.stringify(customer_message)}`, payload: { decision: "approve", customer_message } })),
  ...[null, false, "evidence", {}].map((evidence) => ({ label: `evidence ${JSON.stringify(evidence)}`, payload: { decision: "approve", evidence } })),
  ...[null, false, 1, []].map((engine_version) => ({ label: `engine ${JSON.stringify(engine_version)}`, payload: { decision: "approve", engine_version } })),
  { label: "unknown field", payload: { decision: "approve", confirmed: true } },
];
describe("strict invalid decision / resolve payloads preserve accepted state", () => {
  it.each((["decision", "resolve"] as const).flatMap((endpoint) => invalidPayloads.map((entry) => ({ endpoint, ...entry }))))("$endpoint / $label", async ({ endpoint, payload }) => {
    await start();
    const envelope = await poll();
    if (endpoint === "resolve") expect((await decide(envelope.authorization_id, "step_up")).statusCode).toBe(200);
    const beforeRows = await rows();
    const beforeFeed = await feed();
    const response = await request("POST", `/v1/authorizations/${envelope.authorization_id}/${endpoint}`, { authorization_id: envelope.authorization_id, ...payload });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBeTypeOf("string");
    expect(await rows()).toEqual(beforeRows);
    expect(await feed()).toEqual(beforeFeed);
  });
  it.each(["decision", "resolve"] as const)("%s rejects mismatched and source IDs", async (endpoint) => {
    await start();
    const envelope = await poll();
    if (endpoint === "resolve") await decide(envelope.authorization_id, "step_up");
    for (const id of ["wrong-live-id", envelope.data.authorization.source_authorization_id, null, 42]) {
      const response = await request("POST", `/v1/authorizations/${envelope.authorization_id}/${endpoint}`, { authorization_id: id, decision: "approve" });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("authorization_id_mismatch");
    }
    expect((await request("POST", `/v1/authorizations/${envelope.data.authorization.source_authorization_id}/${endpoint}`, { authorization_id: envelope.data.authorization.source_authorization_id, decision: "approve" })).statusCode).toBe(404);
  });
});

describe("resolve transitions, retries, concurrent answers, deadlines and isolation", () => {
  it.each((["approve", "decline", "step_up"] as const).flatMap((initial) => (["approve", "decline", "step_up"] as const).map((retry) => ({ initial, retry }))))("automatic $initial then automatic $retry", async ({ initial, retry }) => {
    await start();
    const { authorization_id: id } = await poll();
    expect((await decide(id, initial)).statusCode).toBe(200);
    const before = await feed();
    expect((await decide(id, retry)).statusCode).toBe(initial === retry ? 200 : 409);
    expect(await feed()).toEqual(before);
  });
  it.each((["approve", "decline"] as const).flatMap((first) => (["approve", "decline"] as const).map((second) => ({ first, second }))))("step_up -> $first -> $second commits human answer once", async ({ first, second }) => {
    await start();
    const { authorization_id: id } = await poll();
    await decide(id, "step_up");
    expect((await answer(id, first)).statusCode).toBe(200);
    const before = await feed();
    expect((await answer(id, second)).statusCode).toBe(first === second ? 200 : 409);
    expect(await feed()).toEqual(before);
    expect((await rows())[0]!.decision).toBe(first);
  });
  it.each(["approve", "decline"] as const)("parallel duplicate human %s commits only one event", async (decision) => {
    await start();
    const { authorization_id: id } = await poll();
    await decide(id, "step_up");
    const responses = await Promise.all(Array.from({ length: 12 }, () => answer(id, decision)));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    expect((await feed()).data.filter((event) => event.authorization_id === id && event.type === "authorization.finalized")).toHaveLength(1);
  });
  it("parallel opposite human answers accept exactly one and never overwrite it", async () => {
    await start();
    const { authorization_id: id } = await poll();
    await decide(id, "step_up");
    const responses = await Promise.all([answer(id, "approve"), answer(id, "decline")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const accepted = responses.find((response) => response.statusCode === 200)!.json<RuntimeAuthorization>();
    expect((await rows())[0]).toEqual(accepted);
    expect((await feed()).data.filter((event) => event.authorization_id === id && event.type === "authorization.finalized")).toHaveLength(1);
  });
  it.each(["approve", "decline"] as const)("cannot resolve pending or already automatically %sd purchases", async (decision) => {
    await start();
    const { authorization_id: id } = await poll();
    expect((await answer(id, decision)).statusCode).toBe(409);
    await decide(id, decision);
    expect((await answer(id, decision)).statusCode).toBe(409);
  });
  it.each(["approve", "decline"] as const)("human %s accepts immediately before deadline and rejects at/after deadline", async (decision) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = Date.now();
    for (const offset of [-1, 0, 1]) {
      vi.setSystemTime(clock);
      await request("POST", "/v1/team/reset", {});
      await start();
      const { authorization_id: id } = await poll();
      const stepped = (await decide(id, "step_up")).json<RuntimeAuthorization>();
      vi.setSystemTime(Date.parse(stepped.human_deadline_at!) + offset);
      const resolution = await answer(id, decision);
      expect(resolution.statusCode, resolution.body).toBe(offset < 0 ? 200 : 409);
      const saved = (await rows())[0]!;
      expect(saved.status).toBe(offset < 0 && decision === "approve" ? "approved" : "declined");
      if (offset >= 0) expect(saved.reason_codes).toEqual(["human_deadline_exceeded"]);
    }
  });
  it.each(["approve", "decline", "step_up"] as const)("automated %s obeys exact queue deadline", async (decision) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = Date.now();
    for (const offset of [-1, 0, 1]) {
      vi.setSystemTime(clock);
      await request("POST", "/v1/team/reset", {});
      await start();
      const event = await poll();
      vi.setSystemTime(Date.parse(event.data.deadline_at) + offset);
      const response = await decide(event.authorization_id, decision);
      expect(response.statusCode, response.body).toBe(offset < 0 ? 200 : 409);
      if (offset >= 0) expect((await rows())[0]).toMatchObject({ status: "declined", reason_codes: ["decision_deadline_exceeded"] });
    }
  });
  it("restarts awaiting-human state and preserves resolve idempotence across a second restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "api-matrix-resolve-"));
    temporaryDirectories.push(stateDir);
    let persistent = await createMockApi({ stateDir });
    temporaryApps.push(persistent);
    const { runId } = await start("SCEN0000", persistent);
    const envelope = await poll(persistent);
    const stepped = (await decide(envelope.authorization_id, "step_up", persistent)).json<RuntimeAuthorization>();
    await persistent.close();
    temporaryApps.splice(temporaryApps.indexOf(persistent), 1);
    persistent = await createMockApi({ stateDir });
    temporaryApps.push(persistent);
    expect((await rows(persistent))[0]).toMatchObject({ status: "awaiting_human", human_deadline_at: stepped.human_deadline_at });
    expect((await answer(envelope.authorization_id, "approve", persistent)).statusCode).toBe(200);
    const before = await feed(persistent);
    await persistent.close();
    temporaryApps.splice(temporaryApps.indexOf(persistent), 1);
    persistent = await createMockApi({ stateDir });
    temporaryApps.push(persistent);
    expect((await answer(envelope.authorization_id, "approve", persistent)).statusCode).toBe(200);
    expect((await answer(envelope.authorization_id, "decline", persistent)).statusCode).toBe(409);
    expect(await feed(persistent)).toEqual(before);
    expect((await request("GET", `/v1/scenario-runs/${runId}`, undefined, persistent)).json().status).toBe("completed");
  });
  it("different instances, runs and resets cannot resolve or reuse one another's live IDs", async () => {
    const other = await createMockApi();
    temporaryApps.push(other);
    const first = await start();
    const a = await poll();
    await decide(a.authorization_id, "step_up");
    await start("SCEN0000", other);
    const b = await poll(other);
    expect(b.authorization_id).not.toBe(a.authorization_id);
    expect((await answer(a.authorization_id, "approve", other)).statusCode).toBe(404);
    expect((await answer(b.authorization_id, "approve")).statusCode).toBe(404);
    expect((await rows())[0]!.status).toBe("awaiting_human");
    await answer(a.authorization_id, "decline");
    const second = await start();
    const c = await poll();
    expect(second.runId).not.toBe(first.runId);
    expect(c.authorization_id).not.toBe(a.authorization_id);
    expect(c.data.context.recent_authorizations).toEqual([]);
    const filtered = (await request("GET", `/v1/authorizations?run_id=${second.runId}`)).json<{ data: RuntimeAuthorization[] }>().data;
    expect(filtered.map((row) => row.authorization_id)).toEqual([c.authorization_id]);
    await request("POST", "/v1/team/reset", {});
    expect((await answer(a.authorization_id, "approve")).statusCode).toBe(404);
    expect((await answer(c.authorization_id, "approve")).statusCode).toBe(404);
    expect(await rows()).toEqual([]);
    expect((await rows(other))[0]!.authorization_id).toBe(b.authorization_id);
  });
  it("human approval is counted once in later rolling context and pending/rejected answers count zero", async () => {
    const content: PolicyContent = { ...policy("SCEN0001"), hard_rules: [{ ...priceRule, value: 300, scope: "period", period_days: 7 }] };
    await start("SCEN0001", app, content);
    const first = await poll();
    await decide(first.authorization_id, "step_up");
    const second = await poll();
    expect(second.data.context.approved_spend_in_period_chf).toBe(0);
    await answer(first.authorization_id, "approve");
    await answer(first.authorization_id, "approve");
    await decide(second.authorization_id, "decline");
    const third = await poll();
    expect(third.data.context.approved_spend_in_period_chf).toBe(first.data.authorization.billing_amount_chf);
    await decide(third.authorization_id, "step_up");
    await answer(third.authorization_id, "decline");
    const fourth = await poll();
    expect(fourth.data.context.approved_spend_in_period_chf).toBe(new Decimal(first.data.authorization.billing_amount_chf).toNumber());
  });
});

describe("malformed query, policy and route error matrix", () => {
  it.each(["-1", "26", "NaN", "Infinity", "foo", "1e100"])("rejects poll wait=%s without consuming the queued purchase", async (wait) => {
    await start();
    const response = await request("GET", `/v1/decision-requests/next?wait=${wait}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_wait");
    expect((await poll()).data.authorization.source_authorization_id).toBe("AU0001");
  });
  it.each(["-1", "1.5", "NaN", "Infinity", "999999999999999999999", "1"])("rejects invalid event cursor %s without advancing state", async (cursor) => {
    const response = await request("GET", `/v1/events?since=${cursor}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_cursor");
    expect(await feed()).toEqual({ data: [], next_cursor: "0" });
  });
  it.each(["GET /v1/mandates/missing", "GET /v1/scenario-runs/missing", "POST /v1/mandates/missing/confirm", "DELETE /v1/mandates/missing", "PATCH /v1/mandates/missing", "POST /v1/authorizations/missing/decision", "POST /v1/authorizations/missing/resolve"])("%s returns structured 404 without mutation", async (route) => {
    const [method, url] = route.split(" ");
    const response = await request(method as "GET" | "POST" | "PATCH" | "DELETE", url!, url!.endsWith("/confirm") ? { confirmed: true } : { decision: "approve" });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toMatch(/not_found/);
    expect((await feed()).data).toEqual([]);
  });
  it.each(["ask", "approve", "decline"] as const)("mandate uncertainty %s can only stay unchanged or tighten to decline", async (initial) => {
    const mandate = await createMandate("SCEN0000", { ...policy(), uncertainty_policy: initial });
    for (const next of ["ask", "approve", "decline"] as const) {
      const separate = await createMandate("SCEN0000", { ...policy(), uncertainty_policy: initial });
      const response = await request("PATCH", `/v1/mandates/${separate.mandate_id}`, { uncertainty_policy: next });
      expect(response.statusCode).toBe(next === initial || next === "decline" ? 200 : 409);
    }
    const stored = (await request("GET", `/v1/mandates/${mandate.mandate_id}`)).json();
    expect(stored.uncertainty_policy).toBe(initial);
  });
  it.each([true, null, {}, [1, 2], ["CHF", 3]])("rejects invalid hard-rule value %j without creating a draft", async (value) => {
    const response = await request("POST", "/v1/mandates", { ...policy(), hard_rules: [{ ...priceRule, value }] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_policy");
    expect((await feed()).data).toEqual([]);
  });
  it("does not create a run from a draft, mismatched instruction, unknown scenario or revoked mandate", async () => {
    const draft = (await request("POST", "/v1/mandates", policy())).json<{ draft_id: string }>();
    expect((await request("POST", "/v1/scenario-runs", { scenario_id: "SCEN0000", mandate_id: draft.draft_id })).statusCode).toBe(404);
    const mandate = await createMandate();
    expect((await request("POST", "/v1/scenario-runs", { scenario_id: "SCEN9999", mandate_id: mandate.mandate_id })).statusCode).toBe(404);
    expect((await request("POST", "/v1/scenario-runs", { scenario_id: "SCEN0001", mandate_id: mandate.mandate_id })).json().error.code).toBe("instruction_mismatch");
    await request("DELETE", `/v1/mandates/${mandate.mandate_id}`);
    expect((await request("POST", "/v1/scenario-runs", { scenario_id: "SCEN0000", mandate_id: mandate.mandate_id })).json().error.code).toBe("mandate_revoked");
    expect(await rows()).toEqual([]);
    expect((await feed()).data.some((event) => event.type === "scenario_run.started")).toBe(false);
  });
});
