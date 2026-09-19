import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockApi, LOCAL_MOCK_API_KEY, type MockApiOptions } from "../apps/api-mock/src/app.js";
import { loadDataPack } from "../packages/local-runtime/src/data/loader.js";
import { AuthorizationEventFactory } from "../packages/local-runtime/src/data/event-builder.js";
import type { DataPack, PolicyContent } from "../packages/contracts/src/index.js";

let pack: DataPack;
let factory: AuthorizationEventFactory;
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const headers = { authorization: `Bearer ${LOCAL_MOCK_API_KEY}` };
const priceRule = { field: "authorization.billing_amount_chf", operator: "<=", value: 20, currency: "CHF", scope: "purchase" } as const;
beforeAll(async () => {
  pack = await loadDataPack();
  factory = new AuthorizationEventFactory(pack, resolve("data/schemas/authorization_event.schema.json"));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(options: MockApiOptions = {}) {
  const app = await createMockApi(options);
  apps.push(app);
  return app;
}
function policy(scenarioId = "SCEN0000"): PolicyContent {
  return { instruction: pack.scenarios.find((scenario) => scenario.scenario_id === scenarioId)!.cardholder_instruction, hard_rules: [priceRule], uncertainty_policy: "ask", guidance: ["Review these limits."], open_questions: [] };
}
async function mandate(app: FastifyInstance, scenarioId = "SCEN0000", content = policy(scenarioId)): Promise<string> {
  const draft = await app.inject({ method: "POST", url: "/v1/mandates", headers, payload: content });
  expect(draft.statusCode).toBe(201);
  const confirmation = await app.inject({ method: "POST", url: `/v1/mandates/${draft.json().draft_id}/confirm`, headers, payload: { confirmed: true } });
  expect(confirmation.statusCode).toBe(200);
  return confirmation.json().mandate_id;
}
async function run(app: FastifyInstance, scenarioId = "SCEN0000", id?: string) {
  const mandateId = id ?? await mandate(app, scenarioId);
  const response = await app.inject({ method: "POST", url: "/v1/scenario-runs", headers, payload: { scenario_id: scenarioId, mandate_id: mandateId } });
  expect(response.statusCode).toBe(201);
  return { mandateId, runId: response.json().run_id as string };
}
async function poll(app: FastifyInstance) {
  const response = await app.inject({ method: "GET", url: "/v1/decision-requests/next?wait=0", headers });
  expect(response.statusCode).toBe(200);
  return response.json();
}
function decide(app: FastifyInstance, id: string, decision: "approve" | "decline" | "step_up") {
  return app.inject({ method: "POST", url: `/v1/authorizations/${id}/decision`, headers, payload: { authorization_id: id, decision } });
}

describe("local Viseca contract emulator", () => {
  it("authenticates every documented endpoint except health and exposes local mode", async () => {
    const app = await setup();
    const health = await app.inject("/healthz");
    expect(health.json()).toMatchObject({ status: "ok", mode: "mock", emulation: true });
    for (const authorization of [undefined, "Bearer camelcase", "Bearer organizer-key", "local-viseca-test"]) {
      const response = await app.inject({ url: "/v1/bootstrap", ...(authorization ? { headers: { authorization } } : {}) });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthorized");
    }
    const bootstrap = (await app.inject({ url: "/v1/bootstrap", headers })).json();
    expect(bootstrap.timeouts).toMatchObject({ decision_timeout_ms: 8000, human_timeout_ms: 120000 });
    expect(bootstrap.scenarios).toHaveLength(5);
    const reference = (await app.inject({ url: "/v1/reference-data", headers })).json();
    expect(reference.authorization_history.rows).toBe(pack.history.length);
    const csv = await app.inject({ url: reference.authorization_history.path, headers });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.startsWith("authorization_id,customer_id,")).toBe(true);
  });

  it("rejects invalid mandate fields, preserves instructions and requires explicit confirmation", async () => {
    const app = await setup();
    for (const payload of [
      { ...policy(), customer_id: "CU0001" },
      { ...policy(), hard_rules: [{ ...priceRule, value: true }] },
      { ...policy(), hard_rules: [{ ...priceRule, explanation: "extra" }] },
      { ...policy(), instruction: " " },
    ]) expect((await app.inject({ method: "POST", url: "/v1/mandates", headers, payload })).statusCode).toBe(400);
    const draft = (await app.inject({ method: "POST", url: "/v1/mandates", headers, payload: policy() })).json();
    expect(draft.instruction).toBe(policy().instruction);
    for (const payload of [{}, { confirmed: false }, { confirmed: "true" }]) expect((await app.inject({ method: "POST", url: `/v1/mandates/${draft.draft_id}/confirm`, headers, payload })).statusCode).toBe(400);
    const confirmed = await app.inject({ method: "POST", url: `/v1/mandates/${draft.draft_id}/confirm`, headers, payload: { confirmed: true } });
    const repeated = await app.inject({ method: "POST", url: `/v1/mandates/${draft.draft_id}/confirm`, headers, payload: { confirmed: true } });
    expect(repeated.json().mandate_id).toBe(confirmed.json().mandate_id);
    expect((await app.inject({ url: `/v1/mandates/${confirmed.json().mandate_id}`, headers })).json().guidance).toEqual(policy().guidance);
  });

  it("queues a strict canonical event and completes from a submitted decision without external fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External fetch is forbidden"));
    const app = await setup();
    const { runId } = await run(app);
    const event = await poll(app);
    expect(event).toMatchObject({ run_id: runId, type: "authorization.request", status: "pending", authorization_id: event.data.authorization.authorization_id });
    expect(event.event_id).toBeTypeOf("string");
    factory.validate(event.data);
    expect(event.authorization_id).not.toBe(event.data.authorization.source_authorization_id);
    expect(event.data.authorization.delivery_by).toBe("2026-08-10");
    expect(Date.parse(event.data.deadline_at) - Date.parse(event.data.runtime.received_at)).toBe(8000);
    expect(event.data.authorization.timestamp).toBe("2026-08-09T10:04:00Z");
    expect((await decide(app, event.authorization_id, "approve")).json()).toMatchObject({ status: "approved", decision: "approve" });
    const result = (await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json();
    expect(result).toMatchObject({ status: "completed", counters: { total: 1, emitted: 1, approved: 1, pending: 0 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a truly empty 204 and treats the team queue as a single consumer", async () => {
    const app = await setup();
    const empty = await app.inject({ url: "/v1/decision-requests/next?wait=0", headers });
    expect(empty.statusCode).toBe(204);
    expect(empty.body).toBe("");
    const waiting = Promise.resolve(app.inject({ url: "/v1/decision-requests/next?wait=0.5", headers }));
    await new Promise((done) => setTimeout(done, 10));
    expect((await app.inject({ url: "/v1/decision-requests/next?wait=0", headers })).statusCode).toBe(409);
    const started = await run(app);
    const response = await waiting;
    expect(response.statusCode).toBe(200);
    expect(response.json().run_id).toBe(started.runId);
    expect((await app.inject({ method: "POST", url: "/v1/scenario-runs", headers, payload: { scenario_id: "SCEN0000", mandate_id: started.mandateId } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/v1/decision-requests/next?wait=26", headers })).statusCode).toBe(400);
  });

  it("enforces decision URL/body identity and rejects incompatible retries", async () => {
    const app = await setup();
    await run(app);
    const event = await poll(app);
    const path = `/v1/authorizations/${event.authorization_id}/decision`;
    for (const payload of [{ authorization_id: "wrong", decision: "approve" }, { decision: "approve" }, { authorization_id: event.authorization_id, decision: "deny" }, { authorization_id: event.authorization_id, decision: "approve", reason_codes: [42] }]) expect((await app.inject({ method: "POST", url: path, headers, payload })).statusCode).toBe(400);
    expect((await decide(app, event.authorization_id, "approve")).statusCode).toBe(200);
    expect((await decide(app, event.authorization_id, "approve")).statusCode).toBe(200);
    expect((await decide(app, event.authorization_id, "decline")).statusCode).toBe(409);
    const rows = (await app.inject({ url: "/v1/authorizations", headers })).json().data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorization_id: event.authorization_id, status: "approved" });
  });

  it("keeps a step_up unresolved until /resolve and accepts each human answer once", async () => {
    const app = await setup();
    const { runId } = await run(app);
    const event = await poll(app);
    expect((await app.inject({ method: "POST", url: `/v1/authorizations/${event.authorization_id}/resolve`, headers, payload: { decision: "approve" } })).statusCode).toBe(409);
    const stepped = (await decide(app, event.authorization_id, "step_up")).json();
    expect(stepped.status).toBe("awaiting_human");
    expect(Date.parse(stepped.human_deadline_at)).toBeGreaterThan(Date.now() + 119000);
    expect((await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json().status).toBe("running");
    expect((await decide(app, event.authorization_id, "approve")).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/authorizations/${event.authorization_id}/resolve`, headers, payload: { decision: "step_up" } })).statusCode).toBe(400);
    const resolveHuman = (decision: string) => app.inject({ method: "POST", url: `/v1/authorizations/${event.authorization_id}/resolve`, headers, payload: { decision, customer_message: "Explicit simulated customer answer for test." } });
    expect((await resolveHuman("decline")).json().status).toBe("declined");
    expect((await resolveHuman("decline")).statusCode).toBe(200);
    expect((await resolveHuman("approve")).statusCode).toBe(409);
    expect((await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json().status).toBe("completed");
  });

  it("delivers subsequent purchases while a human answer remains pending and counts only final approvals", async () => {
    const app = await setup();
    const content = { ...policy("SCEN0001"), hard_rules: [{ ...priceRule, value: 200, scope: "period" as const, period_days: 7 }] };
    await run(app, "SCEN0001", await mandate(app, "SCEN0001", content));
    const first = await poll(app);
    await decide(app, first.authorization_id, "step_up");
    const second = await poll(app);
    expect(second.data.authorization.replay_order).toBe(2);
    expect(second.data.context.approved_spend_in_period_chf).toBe(0);
    await decide(app, second.authorization_id, "approve");
    const third = await poll(app);
    expect(third.data.context.approved_spend_in_period_chf).toBe(second.data.authorization.billing_amount_chf);
  });

  it("allows only restrictive policy patches and preserves a run's existing snapshot", async () => {
    const app = await setup();
    const content = { ...policy("SCEN0001"), uncertainty_policy: "approve" as const };
    const id = await mandate(app, "SCEN0001", content);
    await run(app, "SCEN0001", id);
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/v1/mandates/${id}`, headers, payload: payload as object });
    expect((await patch({ hard_rules: [] })).statusCode).toBe(409);
    expect((await patch({ hard_rules: [{ ...priceRule, value: 10 }] })).statusCode).toBe(409);
    expect((await patch({ uncertainty_policy: "ask" })).statusCode).toBe(409);
    expect((await patch({ instruction: "Changed" })).statusCode).toBe(400);
    const updated = await patch({ hard_rules: [priceRule, { ...priceRule, value: 10 }], uncertainty_policy: "decline", guidance: [] });
    expect(updated.statusCode).toBe(200);
    const first = await poll(app);
    await decide(app, first.authorization_id, "approve");
    const second = await poll(app);
    expect(second.data.mandate.hard_rules).toHaveLength(1);
    expect(second.data.mandate.uncertainty_policy).toBe("approve");
    expect(second.data.mandate.guidance).toBeUndefined();
  });

  it("revokes future purchases without claiming cancellation of already queued work", async () => {
    const app = await setup();
    const { mandateId, runId } = await run(app, "SCEN0001");
    const first = await poll(app);
    expect((await app.inject({ method: "DELETE", url: `/v1/mandates/${mandateId}`, headers })).json().status).toBe("revoked");
    expect((await decide(app, first.authorization_id, "approve")).statusCode).toBe(200);
    const result = (await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json();
    expect(result.status).toBe("completed");
    expect(result.counters.approved).toBe(1);
    expect(result.counters.declined).toBe(result.counters.total - 1);
    expect((await app.inject({ method: "POST", url: "/v1/scenario-runs", headers, payload: { scenario_id: "SCEN0001", mandate_id: mandateId } })).statusCode).toBe(409);
  });

  it("expires the automated deadline from queue time even before delivery", async () => {
    const app = await setup({ decisionTimeoutMs: 1000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { runId } = await run(app);
    vi.setSystemTime(start + 1100);
    const next = await app.inject({ url: "/v1/decision-requests/next?wait=0", headers });
    expect(next.statusCode).toBe(204);
    const result = (await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json();
    expect(result).toMatchObject({ status: "completed", counters: { declined: 1 } });
    const record = (await app.inject({ url: "/v1/authorizations", headers })).json().data[0];
    expect(record.reason_codes).toEqual(["decision_deadline_exceeded"]);
    expect((await decide(app, record.authorization_id, "approve")).statusCode).toBe(409);
  });

  it("expires the human window and rejects a late approval", async () => {
    const app = await setup({ humanTimeoutMs: 1000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    await run(app);
    const event = await poll(app);
    await decide(app, event.authorization_id, "step_up");
    vi.setSystemTime(Date.now() + 1100);
    expect((await app.inject({ method: "POST", url: `/v1/authorizations/${event.authorization_id}/resolve`, headers, payload: { decision: "approve" } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/v1/authorizations", headers })).json().data[0]).toMatchObject({ status: "declined", reason_codes: ["human_deadline_exceeded"] });
  });

  it("uses stable event cursors, persists state, and resets identifiers", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "viseca-mock-"));
    directories.push(stateDir);
    let app = await setup({ stateDir });
    const { runId } = await run(app);
    const event = await poll(app);
    await decide(app, event.authorization_id, "approve");
    const feed = (await app.inject({ url: "/v1/events?since=0", headers })).json();
    expect(feed.data.some((entry: { status: string }) => entry.status === "approved")).toBe(true);
    expect((await app.inject({ url: `/v1/events?since=${feed.next_cursor}`, headers })).json().data).toEqual([]);
    await expect(createMockApi({ stateDir })).rejects.toThrow("mock_state_in_use");
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    app = await setup({ stateDir });
    expect((await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json().status).toBe("completed");
    expect((await app.inject({ url: "/v1/authorizations", headers })).json().data).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/v1/team/reset", headers })).json()).toMatchObject({ reset: true, next_cursor: "0" });
    expect((await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).statusCode).toBe(404);
    await run(app);
    expect((await poll(app)).authorization_id).not.toBe(event.authorization_id);
  });

  it("can emit every supplied scenario using schema-valid numeric and nullable facts", async () => {
    const app = await setup();
    let authorizations = 0;
    for (const scenario of pack.scenarios) {
      const { runId } = await run(app, scenario.scenario_id);
      for (;;) {
        const result = (await app.inject({ url: `/v1/scenario-runs/${runId}`, headers })).json();
        if (result.status === "completed") { authorizations += result.counters.total; break; }
        const event = await poll(app);
        factory.validate(event.data);
        const related = event.data.authorization.related_authorization_id;
        if (related !== null) expect(related).toMatch(/^LOCAL_AUTH_[A-Z0-9]+_AU\d{4}$/);
        // A transport smoke test supplies a decision; the emulator never chooses policy answers.
        expect((await decide(app, event.authorization_id, "decline")).statusCode).toBe(200);
      }
    }
    expect(authorizations).toBe(45);
  });

  it("rejects non-string policy enums before storing drafts or patches and restarts cleanly", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "viseca-mock-invalid-policy-"));
    directories.push(stateDir);
    let app = await setup({ stateDir });
    for (const field of ["currency", "scope"] as const) {
      for (const value of [[field === "currency" ? "CHF" : "purchase"], [], {}, true, 20]) {
        const response = await app.inject({ method: "POST", url: "/v1/mandates", headers, payload: { ...policy(), hard_rules: [{ ...priceRule, [field]: value }] } });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error.code).toBe("invalid_policy");
      }
    }
    expect((await app.inject({ url: "/v1/events", headers })).json().data).toEqual([]);
    const id = await mandate(app);
    for (const invalidRule of [{ ...priceRule, currency: ["CHF"] }, { ...priceRule, scope: ["purchase"] }]) {
      expect((await app.inject({ method: "PATCH", url: `/v1/mandates/${id}`, headers, payload: { hard_rules: [priceRule, invalidRule] } })).statusCode).toBe(400);
    }
    expect((await app.inject({ url: `/v1/mandates/${id}`, headers })).json().hard_rules).toEqual([priceRule]);
    expect((await app.inject({ url: "/v1/bootstrap", headers })).statusCode).toBe(200);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    app = await setup({ stateDir });
    await run(app, "SCEN0000", id);
    expect((await decide(app, (await poll(app)).authorization_id, "approve")).json().status).toBe("approved");
    expect((await app.inject({ method: "POST", url: "/v1/team/reset", headers })).statusCode).toBe(200);
  });

  it("rejects non-string decision and resolution enums without changing pending state", async () => {
    const app = await setup();
    await run(app);
    const event = await poll(app);
    const id = event.authorization_id;
    const automated = ["approve", "decline", "step_up"].map((value) => [value]);
    for (const decision of [...automated, [], {}, true, 1, null]) {
      expect((await app.inject({ method: "POST", url: `/v1/authorizations/${id}/decision`, headers, payload: { authorization_id: id, decision } })).statusCode).toBe(400);
      expect((await app.inject({ url: "/v1/authorizations", headers })).json().data[0]).toMatchObject({ status: "pending", decision: null });
    }
    expect((await decide(app, id, "step_up")).json().status).toBe("awaiting_human");
    for (const decision of [["approve"], ["decline"], [], {}, true, 1, null]) {
      expect((await app.inject({ method: "POST", url: `/v1/authorizations/${id}/resolve`, headers, payload: { decision } })).statusCode).toBe(400);
      expect((await app.inject({ url: "/v1/authorizations", headers })).json().data[0]).toMatchObject({ status: "awaiting_human", decision: "step_up" });
    }
    expect((await app.inject({ method: "POST", url: `/v1/authorizations/${id}/resolve`, headers, payload: { decision: "approve" } })).json().status).toBe("approved");
  });

  it.each(["canonical validation", "file replacement"])("rolls back a run when %s fails and preserves healthy persisted state", async (failure) => {
    const stateDir = await mkdtemp(join(tmpdir(), "viseca-mock-atomic-"));
    directories.push(stateDir);
    let app = await setup({ stateDir });
    const mandateId = await mandate(app);
    const before = (await app.inject({ url: "/v1/events", headers })).json();
    const original = AuthorizationEventFactory.prototype.build;
    const temporaryPath = join(stateDir, "mock-api.json.tmp");
    const build = vi.spyOn(AuthorizationEventFactory.prototype, "build").mockImplementationOnce(function (this: AuthorizationEventFactory, input) {
      if (failure === "canonical validation") throw new Error("Injected canonical event validation failure");
      const record = original.call(this, input);
      // An unwritable replacement target causes the commit to fail after events
      // have been generated, without changing any production path or fixture.
      mkdirSync(temporaryPath);
      return record;
    });
    const response = await app.inject({ method: "POST", url: "/v1/scenario-runs", headers, payload: { scenario_id: "SCEN0000", mandate_id: mandateId } });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    build.mockRestore();
    await rm(temporaryPath, { recursive: true, force: true });
    expect((await app.inject({ url: "/v1/events", headers })).json()).toEqual(before);
    expect((await app.inject({ url: "/v1/authorizations", headers })).json().data).toEqual([]);
    const saved = JSON.parse(await readFile(join(stateDir, "mock-api.json"), "utf8"));
    expect(saved.runs).toEqual([]);
    expect(saved.queue).toEqual([]);
    expect(saved.authorizations).toEqual([]);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    app = await setup({ stateDir });
    await run(app, "SCEN0000", mandateId);
    expect((await decide(app, (await poll(app)).authorization_id, "approve")).json().status).toBe("approved");
  });

  it("releases an aborted injected long poll before the next purchase is queued", async () => {
    const app = await setup();
    const controller = new AbortController();
    const waiting = Promise.resolve(app.inject({ url: "/v1/decision-requests/next?wait=25", headers, signal: controller.signal }));
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((done) => setTimeout(done, 10));
    controller.abort();
    await rejected;
    await new Promise((done) => setImmediate(done));
    expect((await app.inject({ url: "/v1/decision-requests/next?wait=0", headers })).statusCode).toBe(204);
    const { runId } = await run(app);
    expect((await poll(app)).run_id).toBe(runId);
  });
});
