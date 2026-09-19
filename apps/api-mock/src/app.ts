import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";

import { asId, type AuthorizationEvent, type MandateId, type PolicyContent, type ProfileId, type RunId, type RunRecord, type ScenarioId } from "../../../packages/contracts/src/index.js";
import { loadDataPack } from "../../../packages/local-runtime/src/data/loader.js";
import { AuthorizationEventFactory } from "../../../packages/local-runtime/src/data/event-builder.js";
import { parsePolicyContent, PolicyValidationIssue } from "../../../packages/local-runtime/src/storage/policy-validation.js";

/** A local contract emulator, not a claim that undocumented hosted behavior is identical. */
export const LOCAL_MOCK_API_KEY = "local-viseca-test";
export type MockApiOptions = { dataDir?: string; stateDir?: string; decisionTimeoutMs?: number; humanTimeoutMs?: number };
type Json = Record<string, unknown>;
type Decision = "approve" | "decline" | "step_up";
type Draft = PolicyContent & { draft_id: string; created_at: string; mandate_id: string | null };
type Mandate = PolicyContent & { mandate_id: string; draft_id: string; status: "active" | "revoked"; version: number; confirmed_at: string; updated_at: string; revoked_at: string | null };
type Authorization = {
  run_id: string; authorization_id: string; source_authorization_id: string;
  status: "pending" | "awaiting_human" | "approved" | "declined";
  decision: Decision | null; event: AuthorizationEvent; event_id: string;
  decision_payload: Json | null; resolution_payload: Json | null;
  human_deadline_at: string | null; finalized_at: string | null; reason_codes: string[];
};
type FeedEvent = { event_id: string; cursor: number; run_id: string | null; authorization_id: string | null; type: string; status: string; occurred_at: string; data: unknown };
type State = { schema_version: 1; pack_version: string; drafts: Draft[]; mandates: Mandate[]; runs: RunRecord[]; authorizations: Authorization[]; queue: string[]; events: FeedEvent[]; cursor: number };

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
function body(value: unknown, allowed: string[], required: string[] = []): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_body", "Expected a JSON object.");
  const result = value as Json;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(400, "unknown_field", `Unexpected field: ${key}`);
  for (const key of required) if (!Object.hasOwn(result, key)) fail(400, "missing_field", `Required field: ${key}`);
  return result;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(400, "invalid_field", `${field} must be a nonempty string.`);
  return value;
}
function publicRecord(record: Authorization): Json {
  return {
    run_id: record.run_id, authorization_id: record.authorization_id, source_authorization_id: record.source_authorization_id,
    status: record.status, decision: record.decision, reason_codes: record.reason_codes,
    deadline_at: record.event.deadline_at, human_deadline_at: record.human_deadline_at, finalized_at: record.finalized_at,
  };
}
function policyOnly(value: PolicyContent): PolicyContent {
  return structuredClone({ instruction: value.instruction, hard_rules: value.hard_rules, uncertainty_policy: value.uncertainty_policy, guidance: value.guidance, open_questions: value.open_questions });
}
function decisionBody(value: unknown, id: string, human: boolean): Json {
  const result = body(value, ["authorization_id", "decision", "reason_codes", "customer_message", "evidence", "engine_version"], human ? ["decision"] : ["authorization_id", "decision"]);
  if (result["authorization_id"] !== undefined && result["authorization_id"] !== id) fail(400, "authorization_id_mismatch", "URL and body authorization IDs must match.");
  if (typeof result["decision"] !== "string" || !(human ? ["approve", "decline"] : ["approve", "decline", "step_up"]).includes(result["decision"])) fail(400, "invalid_decision", "Unsupported decision.");
  for (const field of ["customer_message", "engine_version"]) if (result[field] !== undefined && typeof result[field] !== "string") fail(400, "invalid_field", `${field} must be a string.`);
  if (result["reason_codes"] !== undefined && (!Array.isArray(result["reason_codes"]) || result["reason_codes"].some((entry) => typeof entry !== "string"))) fail(400, "invalid_field", "reason_codes must be strings.");
  if (result["evidence"] !== undefined && !Array.isArray(result["evidence"])) fail(400, "invalid_field", "evidence must be an array.");
  return structuredClone(result);
}

export async function createMockApi(options: MockApiOptions = {}): Promise<FastifyInstance> {
  const dataDir = resolve(options.dataDir ?? "data");
  const decisionTimeout = options.decisionTimeoutMs ?? 8_000;
  const humanTimeout = options.humanTimeoutMs ?? 120_000;
  for (const value of [decisionTimeout, humanTimeout]) if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error("mock_invalid_timeout");
  const pack = await loadDataPack({ dataDir });
  const factory = new AuthorizationEventFactory(pack, resolve(dataDir, "schemas/authorization_event.schema.json"));
  const freshState = (): State => ({ schema_version: 1, pack_version: pack.pack_version, drafts: [], mandates: [], runs: [], authorizations: [], queue: [], events: [], cursor: 0 });
  let state = freshState();
  let statePath: string | undefined;
  let lockPath: string | undefined;
  let lockFd: number | undefined;
  const releaseLock = () => {
    if (lockFd !== undefined) { closeSync(lockFd); lockFd = undefined; if (lockPath) unlinkSync(lockPath); }
  };
  if (options.stateDir !== undefined) {
    const stateDir = resolve(options.stateDir);
    mkdirSync(stateDir, { recursive: true });
    statePath = resolve(stateDir, "mock-api.json");
    lockPath = resolve(stateDir, "mock-api.lock");
    if (existsSync(lockPath)) {
      const owner = Number(readFileSync(lockPath, "utf8"));
      if (!Number.isSafeInteger(owner) || owner < 1) throw new Error("mock_state_lock_invalid");
      try { process.kill(owner, 0); throw new Error("mock_state_in_use"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lockPath); else throw error; }
    }
    lockFd = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockFd, String(process.pid));
    try {
      if (existsSync(statePath)) {
        const saved = JSON.parse(readFileSync(statePath, "utf8")) as State;
        if (saved.schema_version !== 1 || saved.pack_version !== pack.pack_version || ![saved.drafts, saved.mandates, saved.runs, saved.authorizations, saved.queue, saved.events].every(Array.isArray) || !Number.isSafeInteger(saved.cursor)) throw new Error("mock_state_invalid");
        for (const draft of saved.drafts) parsePolicyContent(policyOnly(draft));
        for (const mandate of saved.mandates) parsePolicyContent(policyOnly(mandate));
        const ids = new Set<string>();
        for (const authorization of saved.authorizations) {
          factory.validate(authorization.event);
          if (authorization.authorization_id !== authorization.event.authorization.authorization_id || ids.has(authorization.authorization_id) || !saved.runs.some((run) => run.run_id === authorization.run_id)) throw new Error("mock_state_invalid");
          ids.add(authorization.authorization_id);
        }
        state = saved;
        // A disconnected client may not have received an earlier delivery. Live IDs remain stable.
        state.queue = state.authorizations.filter((entry) => entry.status === "pending").map((entry) => entry.authorization_id);
      }
    } catch (error) { releaseLock(); throw error; }
  }
  const persist = () => {
    if (!statePath) return;
    const temporary = `${statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, statePath);
  };
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const nowIso = () => new Date().toISOString();
  const newId = (kind: string) => `MOCK_${kind}_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  function emit(type: string, status: string, data: unknown, runId: string | null = null, authorizationId: string | null = null): FeedEvent {
    const event: FeedEvent = { event_id: newId("EVENT"), cursor: ++state.cursor, run_id: runId, authorization_id: authorizationId, type, status, occurred_at: nowIso(), data: structuredClone(data) };
    state.events.push(event);
    return event;
  }
  function runView(run: RunRecord): Json {
    const authorizations = state.authorizations.filter((record) => record.run_id === run.run_id);
    return {
      run_id: run.run_id, scenario_id: run.scenario_id, mandate_id: run.mandate_id, status: run.status,
      mandate_snapshot: structuredClone(run.mandate_snapshot), fixture_profiles: [{ profile_id: run.profile_id, customer_id: run.customer_id, card_id: run.card_id, authority_id: run.fixture_authority_id }],
      started_at: run.started_at, finished_at: run.finished_at, total_events: run.total_attempts,
      counters: { total: run.total_attempts, emitted: run.emitted_count, pending: authorizations.filter((record) => record.status === "pending").length, awaiting_human: authorizations.filter((record) => record.status === "awaiting_human").length, approved: authorizations.filter((record) => record.status === "approved").length, declined: authorizations.filter((record) => record.status === "declined").length },
    };
  }
  function finalize(record: Authorization, decision: "approve" | "decline", reason?: string): void {
    record.decision = decision;
    record.status = decision === "approve" ? "approved" : "declined";
    record.finalized_at = nowIso();
    if (reason) record.reason_codes = [reason];
    state.queue = state.queue.filter((id) => id !== record.authorization_id);
    emit(reason ? "authorization.expired" : "authorization.finalized", record.status, publicRecord(record), record.run_id, record.authorization_id);
  }
  function advance(run: RunRecord): void {
    if (run.status !== "running") return;
    if (state.authorizations.some((record) => record.run_id === run.run_id && record.status === "pending")) return;
    const attempts = pack.attemptsByScenario.get(run.scenario_id) ?? [];
    while (run.next_replay_order <= run.total_attempts) {
      const attempt = attempts[run.next_replay_order - 1];
      if (!attempt) throw new Error("mock_attempt_missing");
      const event = factory.build({ attempt, run, priorRecords: [], receivedAt: new Date() }).event;
      const prior = state.authorizations.filter((record) => record.run_id === run.run_id);
      const attemptMs = Date.parse(event.authorization.timestamp);
      event.context.recent_authorizations = prior.filter((record) => {
        const delta = attemptMs - Date.parse(record.event.authorization.timestamp);
        return delta > 0 && delta <= run.config.history_window_minutes * 60_000;
      }).map((record) => ({ authorization_id: record.event.authorization.authorization_id, timestamp: record.event.authorization.timestamp, merchant_id: record.event.authorization.merchant.merchant_id, billing_amount_chf: record.event.authorization.billing_amount_chf, status: record.status === "awaiting_human" ? "pending" : record.status }));
      // There is no unique period when several different period rules coexist; preserve null in that case.
      const periods = new Set(run.mandate_snapshot.hard_rules.filter((rule) => rule.scope === "period" && rule.period_days).map((rule) => rule.period_days!));
      if (periods.size === 1) {
        const periodMs = [...periods][0]! * 86_400_000;
        event.context.approved_spend_in_period_chf = prior.filter((record) => record.status === "approved" && Date.parse(record.event.authorization.timestamp) <= attemptMs && Date.parse(record.event.authorization.timestamp) >= attemptMs - periodMs).reduce((sum, record) => sum.plus(record.event.authorization.billing_amount_chf), new Decimal(0)).toNumber();
      }
      factory.validate(event);
      const record: Authorization = { run_id: run.run_id, authorization_id: event.authorization.authorization_id, source_authorization_id: attempt.authorization_id, status: "pending", decision: null, event, event_id: "", decision_payload: null, resolution_payload: null, human_deadline_at: null, finalized_at: null, reason_codes: [] };
      state.authorizations.push(record);
      run.next_replay_order++;
      run.emitted_count++;
      const authority = pack.authoritiesById.get(attempt.authority_id)!;
      const mandate = state.mandates.find((entry) => entry.mandate_id === run.mandate_id)!;
      // Authority dates are scenario-clock facts, not current wall-clock dates.
      const blocked = mandate.status !== "active" ? "mandate_revoked" : attempt.authority_status !== "active" || authority.initial_status !== "active" || attemptMs < Date.parse(authority.valid_from) || attemptMs > Date.parse(authority.valid_until) ? "authority_inactive" : attempt.card_status_at_attempt !== "active" ? "card_blocked" : null;
      if (blocked) { finalize(record, "decline", blocked); continue; }
      record.event_id = emit("authorization.request", "pending", event, run.run_id, record.authorization_id).event_id;
      state.queue.push(record.authorization_id);
      return;
    }
    if (!state.authorizations.some((record) => record.run_id === run.run_id && ["pending", "awaiting_human"].includes(record.status))) {
      run.status = "completed";
      run.finished_at = nowIso();
      emit("scenario_run.completed", "completed", runView(run), run.run_id);
    }
  }
  function sweep(): void {
    const now = Date.now();
    for (const record of state.authorizations) {
      if (record.status === "pending" && Date.parse(record.event.deadline_at) <= now) finalize(record, "decline", "decision_deadline_exceeded");
      else if (record.status === "awaiting_human" && Date.parse(record.human_deadline_at!) <= now) finalize(record, "decline", "human_deadline_exceeded");
    }
    for (const run of state.runs) advance(run);
  }
  function scheduleDeadlines(): void {
    if (timer) clearTimeout(timer);
    const deadlines = state.authorizations.flatMap((record) => record.status === "pending" ? [Date.parse(record.event.deadline_at)] : record.status === "awaiting_human" ? [Date.parse(record.human_deadline_at!)] : []);
    if (deadlines.length && !closed) {
      timer = setTimeout(settleInBackground, Math.max(1, Math.min(...deadlines) - Date.now()));
      timer.unref();
    }
    wake();
  }
  function settleInBackground(): void {
    try { settle(); }
    catch (error) {
      app.log.error({ err: error }, "Unable to commit local emulator deadlines; retaining the last committed state.");
      if (!closed) { timer = setTimeout(settleInBackground, 250); timer.unref(); }
    }
  }
  // Mutations, canonical events, the queue and its cursor form a single commit.
  // No handler awaits inside this transaction, so another request cannot observe
  // the candidate state before validation and the atomic file replacement finish.
  function transaction<T>(operation: () => T): T {
    const previous = state;
    state = structuredClone(previous);
    let result: T;
    try {
      sweep();
      result = operation();
      sweep();
      persist();
    } catch (error) { state = previous; throw error; }
    scheduleDeadlines();
    return result;
  }
  function settle(): void { transaction(() => undefined); }
  function getMandate(id: string): Mandate {
    return state.mandates.find((entry) => entry.mandate_id === id) ?? fail(404, "mandate_not_found", "Mandate not found.");
  }
  function getAuthorization(id: string): Authorization {
    return state.authorizations.find((entry) => entry.authorization_id === id) ?? fail(404, "authorization_not_found", "Authorization not found.");
  }
  function envelope(record: Authorization): Json {
    return { run_id: record.run_id, event_id: record.event_id, type: "authorization.request", authorization_id: record.authorization_id, status: "pending", occurred_at: record.event.runtime.received_at, data: structuredClone(record.event) };
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PolicyValidationIssue) return reply.code(400).send({ error: { code: "invalid_policy", message: error.message } });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: { code: status >= 500 ? "mock_internal_error" : "invalid_request", message: status >= 500 ? "Local emulator failed." : (error as Error).message } });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Viseca-Mode", "local-contract-emulator");
    if (request.url.split("?")[0] === "/healthz") return;
    if (request.headers.authorization !== `Bearer ${LOCAL_MOCK_API_KEY}`) return reply.code(401).send({ error: { code: "unauthorized", message: "Use the local emulator token." } });
    settle();
  });
  app.addHook("preClose", async () => { closed = true; if (timer) clearTimeout(timer); wake(); });
  app.addHook("onClose", async () => { releaseLock(); });
  app.get("/healthz", async () => ({ status: "ok", version: "local-contract-emulator-1", mode: "mock", emulation: true }));
  app.get("/v1/bootstrap", async () => ({
    api_version: "v1", data_version: pack.pack_version, team_id: "LOCAL_TEST_TEAM", mode: "mock", emulation: true,
    scenarios: pack.scenarios.map(({ source: _source, ...scenario }) => scenario),
    timeouts: { decision_timeout_ms: decisionTimeout, human_timeout_ms: humanTimeout, max_poll_wait_seconds: 25 },
    limits: { active_runs: 1, team_queue_consumers: 1 }, features: { team_reset: true, human_resolution: true },
    emulation_notes: ["The hosted response format and undocumented behavior still require live verification.", "Purchases are queued sequentially after each automated answer; human requests may remain pending.", "Expired decisions decline locally; revocation preserves purchases already queued or awaiting a human."],
  }));
  app.get("/v1/reference-data", async () => ({
    data_version: pack.pack_version, scenarios: pack.scenarios.map(({ source: _source, ...entry }) => entry),
    customers: pack.customers.map(({ source: _source, ...entry }) => entry), cards: pack.cards.map(({ source: _source, ...entry }) => entry),
    merchants: pack.merchants.map(({ source: _source, ...entry }) => entry),
    fx_rates: pack.fxRates.map(({ source: _source, ...entry }) => ({ ...entry, rate: Number(entry.rate) })),
    authorization_history: { path: "/v1/reference-data/authorization-history.csv", rows: pack.history.length, content_type: "text/csv" },
  }));
  app.get("/v1/reference-data/authorization-history.csv", async (_request, reply) => reply.type("text/csv; charset=utf-8").send(readFileSync(resolve(dataDir, "authorization_history.csv"), "utf8")));
  app.post("/v1/mandates", async (request, reply) => {
    const draft = transaction(() => {
      const content = parsePolicyContent(request.body);
      if (!content.instruction.trim()) fail(400, "invalid_instruction", "Instruction must not be blank.");
      const draft: Draft = { ...content, draft_id: newId("DRAFT"), created_at: nowIso(), mandate_id: null };
      state.drafts.push(draft);
      emit("mandate.drafted", "draft", { draft_id: draft.draft_id });
      return draft;
    });
    return reply.code(201).send(draft);
  });
  app.post<{ Params: { id: string } }>("/v1/mandates/:id/confirm", async (request) => transaction(() => {
    const input = body(request.body, ["confirmed"], ["confirmed"]);
    if (input["confirmed"] !== true) fail(400, "confirmation_required", "Explicit confirmed: true is required.");
    const draft = state.drafts.find((entry) => entry.draft_id === request.params.id) ?? fail(404, "draft_not_found", "Draft not found.");
    if (draft.mandate_id) return getMandate(draft.mandate_id);
    const mandate: Mandate = { ...policyOnly(draft), mandate_id: newId("MANDATE"), draft_id: draft.draft_id, status: "active", version: 1, confirmed_at: nowIso(), updated_at: nowIso(), revoked_at: null };
    state.mandates.push(mandate);
    draft.mandate_id = mandate.mandate_id;
    emit("mandate.confirmed", "active", { mandate_id: mandate.mandate_id });
    return mandate;
  }));
  app.get<{ Params: { id: string } }>("/v1/mandates/:id", async (request) => getMandate(request.params.id));
  app.patch<{ Params: { id: string } }>("/v1/mandates/:id", async (request) => transaction(() => {
    const mandate = getMandate(request.params.id);
    if (mandate.status !== "active") fail(409, "mandate_revoked", "A revoked mandate cannot be changed.");
    const input = body(request.body, ["hard_rules", "uncertainty_policy", "guidance", "open_questions"]);
    const updated = parsePolicyContent({ ...policyOnly(mandate), ...input });
    const remaining = [...updated.hard_rules];
    for (const existing of mandate.hard_rules) {
      const index = remaining.findIndex((rule) => isDeepStrictEqual(rule, existing));
      if (index < 0) fail(409, "policy_must_tighten", "Every existing hard rule must remain unchanged.");
      remaining.splice(index, 1);
    }
    if (updated.uncertainty_policy !== mandate.uncertainty_policy && updated.uncertainty_policy !== "decline") fail(409, "policy_must_tighten", "Uncertainty policy can only change to decline.");
    Object.assign(mandate, updated, { version: mandate.version + 1, updated_at: nowIso() });
    emit("mandate.updated", "active", { mandate_id: mandate.mandate_id, version: mandate.version });
    return mandate;
  }));
  app.delete<{ Params: { id: string } }>("/v1/mandates/:id", async (request) => transaction(() => {
    const mandate = getMandate(request.params.id);
    if (mandate.status !== "revoked") {
      mandate.status = "revoked";
      mandate.revoked_at = mandate.updated_at = nowIso();
      emit("mandate.revoked", "revoked", { mandate_id: mandate.mandate_id });
    }
    return mandate;
  }));
  app.post("/v1/scenario-runs", async (request, reply) => {
    const run = transaction(() => {
      const input = body(request.body, ["scenario_id", "mandate_id"], ["scenario_id", "mandate_id"]);
      const scenarioId = asId<ScenarioId>(string(input["scenario_id"], "scenario_id"));
      const scenario = pack.scenariosById.get(scenarioId) ?? fail(404, "scenario_not_found", "Scenario not found.");
      const mandate = getMandate(string(input["mandate_id"], "mandate_id"));
      if (mandate.status !== "active") fail(409, "mandate_revoked", "A revoked mandate cannot start a run.");
      if (mandate.instruction !== scenario.cardholder_instruction) fail(409, "instruction_mismatch", "Preserve the scenario's exact original instruction.");
      if (state.runs.some((run) => run.status === "running")) fail(409, "active_run_exists", "Only one run may use the local team queue at a time.");
      const attempt = pack.attemptsByScenario.get(scenarioId)![0]!;
      const authority = pack.authoritiesById.get(attempt.authority_id)!;
      const key = randomUUID().replaceAll("-", "").toUpperCase();
      const profileId = asId<ProfileId>(`MOCK_PROFILE_${key}`);
      const run: RunRecord = {
        run_id: asId<RunId>(`MOCK_RUN_${key}`), run_key: key, scenario_id: scenarioId, mode: "inspection",
        mandate_id: asId<MandateId>(mandate.mandate_id), mandate_version: mandate.version,
        mandate_snapshot: { mandate_id: asId<MandateId>(mandate.mandate_id), status: "active", customer_id: authority.customer_id, card_id: authority.card_id, profile_id: profileId, instruction: mandate.instruction, hard_rules: structuredClone(mandate.hard_rules), uncertainty_policy: mandate.uncertainty_policy },
        fixture_authority_id: authority.authority_id, customer_id: authority.customer_id, card_id: authority.card_id, profile_id: profileId,
        status: "running", next_replay_order: 1, total_attempts: scenario.event_count, emitted_count: 0, started_at: nowIso(), finished_at: null,
        config: { decision_timeout_ms: decisionTimeout, history_window_minutes: 10 }, pack_version: pack.pack_version, engine_version: null, facts_version: null, commands: [],
      };
      state.runs.push(run);
      emit("scenario_run.started", "running", runView(run), run.run_id);
      return run;
    });
    return reply.code(201).send(runView(run));
  });
  app.get<{ Params: { id: string } }>("/v1/scenario-runs/:id", async (request) => runView(state.runs.find((entry) => entry.run_id === request.params.id) ?? fail(404, "run_not_found", "Run not found.")));
  let polling = false;
  app.get<{ Querystring: { wait?: string } }>("/v1/decision-requests/next", async (request, reply) => {
    const seconds = request.query.wait === undefined ? 0 : Number(request.query.wait);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 25) fail(400, "invalid_wait", "wait must be between 0 and 25 seconds.");
    if (polling) fail(409, "queue_consumer_exists", "Only one long poll may consume this team's queue.");
    polling = true;
    const deadline = Date.now() + seconds * 1_000;
    try {
      while (!closed && !request.raw.aborted && !reply.raw.destroyed) {
        const delivery = transaction(() => { const id = state.queue.shift(); return id ? envelope(getAuthorization(id)) : null; });
        if (delivery) return delivery;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((done) => {
          const finish = () => {
            clearTimeout(timeout);
            waiters.delete(finish);
            request.raw.removeListener("aborted", finish);
            reply.raw.removeListener("close", finish);
            done();
          };
          const timeout = setTimeout(finish, remaining);
          waiters.add(finish);
          request.raw.once("aborted", finish);
          reply.raw.once("close", finish);
        });
      }
      return reply.code(204).send();
    } finally { polling = false; }
  });
  app.post<{ Params: { id: string } }>("/v1/authorizations/:id/decision", async (request) => transaction(() => {
    const record = getAuthorization(request.params.id);
    const input = decisionBody(request.body, record.authorization_id, false);
    if (record.decision_payload) {
      if (!isDeepStrictEqual(record.decision_payload, input)) fail(409, "decision_conflict", "A different automated decision was already accepted.");
      return publicRecord(record);
    }
    if (record.status !== "pending") fail(409, "authorization_not_pending", "This authorization no longer accepts automated decisions.");
    record.decision_payload = input;
    record.reason_codes = (input["reason_codes"] as string[] | undefined) ?? [];
    const decision = input["decision"] as Decision;
    if (decision === "step_up") {
      record.decision = decision;
      record.status = "awaiting_human";
      record.human_deadline_at = new Date(Date.now() + humanTimeout).toISOString();
      state.queue = state.queue.filter((id) => id !== record.authorization_id);
      emit("authorization.step_up", "awaiting_human", publicRecord(record), record.run_id, record.authorization_id);
    } else finalize(record, decision);
    return publicRecord(record);
  }));
  app.post<{ Params: { id: string } }>("/v1/authorizations/:id/resolve", async (request) => transaction(() => {
    const record = getAuthorization(request.params.id);
    const input = decisionBody(request.body, record.authorization_id, true);
    if (record.resolution_payload) {
      if (!isDeepStrictEqual(record.resolution_payload, input)) fail(409, "resolution_conflict", "A different human answer was already accepted.");
      return publicRecord(record);
    }
    if (record.status !== "awaiting_human") fail(409, "human_resolution_not_pending", "Only a pending step_up can be resolved.");
    record.resolution_payload = input;
    if (input["reason_codes"]) record.reason_codes = input["reason_codes"] as string[];
    finalize(record, input["decision"] as "approve" | "decline");
    return publicRecord(record);
  }));
  app.get<{ Querystring: { run_id?: string } }>("/v1/authorizations", async (request) => ({ data: state.authorizations.filter((record) => !request.query.run_id || record.run_id === request.query.run_id).map(publicRecord) }));
  app.get<{ Querystring: { since?: string } }>("/v1/events", async (request) => {
    const since = request.query.since === undefined ? 0 : Number(request.query.since);
    if (!Number.isSafeInteger(since) || since < 0 || since > state.cursor) fail(400, "invalid_cursor", "since must be an existing nonnegative event cursor.");
    return { data: state.events.filter((event) => event.cursor > since), next_cursor: String(state.cursor) };
  });
  app.post("/v1/team/reset", async () => transaction(() => { state = freshState(); return { reset: true, next_cursor: "0" }; }));
  try {
    settle();
    await app.ready();
    return app;
  } catch (error) {
    closed = true;
    if (timer) clearTimeout(timer);
    releaseLock();
    throw error;
  }
}
