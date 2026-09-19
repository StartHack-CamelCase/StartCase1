import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ApiErrorPayload,
  AuthorizationDetail,
  MandateRecord,
  PolicyDraft,
  RunListItem,
  RunView,
  ScenarioDetail,
  ScenarioSummary,
} from "../packages/contracts/src/index.js";
import { createLocalApp } from "../apps/local-web/src/app.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const WEB_DIR = resolve(ROOT, "apps/local-web/web");
const temporaryDirectories: string[] = [];
const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function appFixture(): Promise<FastifyInstance> {
  const directory = await mkdtemp(join(tmpdir(), "viseca-api-test-"));
  temporaryDirectories.push(directory);
  let keySequence = 0;
  let clockSequence = 0;
  const application = await createLocalApp({
    rootDir: ROOT,
    dataDir: DATA_DIR,
    stateDir: join(directory, "state"),
    outputDir: join(directory, "output"),
    webDir: WEB_DIR,
    logger: false,
    createKey: () => `HTTP${String(++keySequence).padStart(6, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 19, 9, 0, clockSequence++)),
  });
  applications.push(application);
  await application.ready();
  return application;
}

function responseBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

type DraftRequest = {
  scenario_id: string;
  instruction: string;
  hard_rules: [];
  uncertainty_policy: "ask";
  guidance: string[];
  open_questions: string[];
};

async function scenarioDetail(
  application: FastifyInstance,
  scenarioId = "SCEN0000",
): Promise<ScenarioDetail> {
  const response = await application.inject({
    method: "GET",
    url: `/api/scenarios/${scenarioId}`,
  });
  expect(response.statusCode).toBe(200);
  return responseBody<ScenarioDetail>(response);
}

function draftRequest(detail: ScenarioDetail): DraftRequest {
  return {
    scenario_id: detail.scenario.scenario_id,
    instruction: detail.initial_policy.instruction,
    hard_rules: [],
    uncertainty_policy: "ask",
    guidance: [...detail.initial_policy.guidance],
    open_questions: [...detail.initial_policy.open_questions],
  };
}

async function createMandateViaApi(
  application: FastifyInstance,
  keyPrefix: string,
): Promise<{ detail: ScenarioDetail; draft: PolicyDraft; mandate: MandateRecord }> {
  const detail = await scenarioDetail(application);
  const draftResponse = await application.inject({
    method: "POST",
    url: "/api/mandate-drafts",
    headers: { "idempotency-key": `${keyPrefix}-draft` },
    payload: draftRequest(detail),
  });
  expect(draftResponse.statusCode).toBe(201);
  const draft = responseBody<PolicyDraft>(draftResponse);

  const confirmResponse = await application.inject({
    method: "POST",
    url: `/api/mandate-drafts/${draft.draft_id}/confirm`,
    headers: { "idempotency-key": `${keyPrefix}-confirm` },
    payload: { confirmed: true },
  });
  expect(confirmResponse.statusCode).toBe(201);
  return { detail, draft, mandate: responseBody<MandateRecord>(confirmResponse) };
}

async function createRunViaApi(
  application: FastifyInstance,
  mandate: MandateRecord,
  idempotencyKey: string,
): Promise<RunView> {
  const response = await application.inject({
    method: "POST",
    url: "/api/runs",
    headers: { "idempotency-key": idempotencyKey },
    payload: {
      scenario_id: mandate.source_scenario_id,
      mandate_id: mandate.mandate_id,
      mode: "inspection",
    },
  });
  expect(response.statusCode).toBe(201);
  return responseBody<RunView>(response);
}

describe("local HTTP API", () => {
  it("serves health, scenario, draft, confirmation, run, next and purchase detail routes", async () => {
    const application = await appFixture();

    const healthResponse = await application.inject({ method: "GET", url: "/api/health" });
    expect(healthResponse.statusCode).toBe(200);
    expect(responseBody(healthResponse)).toMatchObject({
      status: "ok",
      mode: "offline",
      pack: { available: true, scenarios: 5, attempts: 45 },
    });

    const scenariosResponse = await application.inject({
      method: "GET",
      url: "/api/scenarios",
    });
    expect(scenariosResponse.statusCode).toBe(200);
    const scenarios = responseBody<{ scenarios: ScenarioSummary[] }>(scenariosResponse).scenarios;
    expect(scenarios).toHaveLength(5);
    expect(scenarios.reduce((total, scenario) => total + scenario.event_count, 0)).toBe(45);

    const { detail, draft, mandate } = await createMandateViaApi(application, "flow-001");
    expect(draft.instruction).toBe(detail.scenario.cardholder_instruction);
    expect(draft.hard_rules).toEqual([]);
    expect(draft.interpretation.status).toBe("not_started");

    const storedDraft = await application.inject({
      method: "GET",
      url: `/api/mandate-drafts/${draft.draft_id}`,
    });
    expect(storedDraft.statusCode).toBe(200);
    expect(responseBody<PolicyDraft>(storedDraft)).toEqual(draft);

    const storedMandate = await application.inject({
      method: "GET",
      url: `/api/mandates/${mandate.mandate_id}`,
    });
    expect(storedMandate.statusCode).toBe(200);
    expect(responseBody<MandateRecord>(storedMandate)).toEqual(mandate);

    const run = await createRunViaApi(application, mandate, "flow-001-run");
    expect(run.run.status).toBe("ready");
    expect(run.counts.emitted).toBe(0);

    const runListResponse = await application.inject({ method: "GET", url: "/api/runs" });
    expect(responseBody<{ runs: RunListItem[] }>(runListResponse).runs).toEqual([
      { view: run, current: true },
    ]);
    const runResponse = await application.inject({
      method: "GET",
      url: `/api/runs/${run.run.run_id}`,
    });
    expect(responseBody<RunView>(runResponse)).toEqual(run);

    const nextResponse = await application.inject({
      method: "POST",
      url: `/api/runs/${run.run.run_id}/next`,
      headers: { "idempotency-key": "flow-001-next" },
      payload: {},
    });
    expect(nextResponse.statusCode).toBe(200);
    const next = responseBody<{
      authorization: RunView["authorizations"][number] & {
        event: { authorization: { items: unknown[]; purchase_description: string } };
        evaluation_reason: string;
      };
      view: RunView;
    }>(nextResponse);
    expect(next.authorization).toMatchObject({
      evaluation_status: "not_evaluated",
      evaluation_reason: "analysis_not_configured",
      status: "pending",
      phase: "awaiting_analysis",
    });
    expect(next.view.counts).toMatchObject({ emitted: 1, not_evaluated: 1 });

    const authorizationId = next.authorization.authorization_id;
    const detailResponse = await application.inject({
      method: "GET",
      url: `/api/runs/${run.run.run_id}/authorizations/${authorizationId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const authorization = responseBody<AuthorizationDetail>(detailResponse);
    expect(authorization.record.authorization_id).toBe(authorizationId);
    expect(authorization.record.evaluation_status).toBe("not_evaluated");
    expect(authorization.display.merchant_name.length).toBeGreaterThan(0);
    expect(authorization.display.purchase_description).toBe(
      authorization.record.event.authorization.purchase_description,
    );
    expect(authorization.display.items).toHaveLength(
      authorization.record.event.authorization.items.length,
    );
    expect(
      authorization.display.items.every((item) => item.catalogue_description.length > 0),
    ).toBe(true);
  });

  it("deduplicates the same idempotency key and rejects a conflicting reuse", async () => {
    const application = await appFixture();
    const detail = await scenarioDetail(application);
    const payload = draftRequest(detail);
    const request = {
      method: "POST" as const,
      url: "/api/mandate-drafts",
      headers: { "idempotency-key": "same-intent-001" },
      payload,
    };

    const [firstResponse, repeatedResponse] = await Promise.all([
      application.inject(request),
      application.inject(request),
    ]);
    expect(firstResponse.statusCode).toBe(201);
    expect(repeatedResponse.statusCode).toBe(201);
    expect(responseBody<PolicyDraft>(repeatedResponse)).toEqual(
      responseBody<PolicyDraft>(firstResponse),
    );

    const conflictResponse = await application.inject({
      ...request,
      payload: { ...payload, guidance: [...payload.guidance, "different request"] },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(responseBody<ApiErrorPayload>(conflictResponse).error.code).toBe(
      "idempotency_conflict",
    );

    const refreshed = await scenarioDetail(application);
    expect(refreshed.drafts).toHaveLength(1);
  });

  it("keeps evaluation and payment resolution unavailable with explicit 409 errors", async () => {
    const application = await appFixture();
    const { mandate } = await createMandateViaApi(application, "blocked-001");

    const evaluationResponse = await application.inject({
      method: "POST",
      url: "/api/runs",
      headers: { "idempotency-key": "blocked-evaluation-001" },
      payload: {
        scenario_id: mandate.source_scenario_id,
        mandate_id: mandate.mandate_id,
        mode: "evaluation",
      },
    });
    expect(evaluationResponse.statusCode).toBe(409);
    expect(responseBody<ApiErrorPayload>(evaluationResponse).error.code).toBe(
      "analysis_not_configured",
    );

    const run = await createRunViaApi(application, mandate, "blocked-run-001");
    const nextResponse = await application.inject({
      method: "POST",
      url: `/api/runs/${run.run.run_id}/next`,
      headers: { "idempotency-key": "blocked-next-001" },
      payload: {},
    });
    const next = responseBody<{
      authorization: { authorization_id: string };
      view: RunView;
    }>(nextResponse);

    const resolveResponse = await application.inject({
      method: "POST",
      url: `/api/runs/${run.run.run_id}/authorizations/${next.authorization.authorization_id}/resolve`,
      headers: { "idempotency-key": "blocked-resolve-001" },
      payload: { decision: "approve", expected_revision: 1 },
    });
    expect(resolveResponse.statusCode).toBe(409);
    expect(responseBody<ApiErrorPayload>(resolveResponse).error.code).toBe(
      "analysis_not_configured",
    );

    const unchangedResponse = await application.inject({
      method: "GET",
      url: `/api/runs/${run.run.run_id}/authorizations/${next.authorization.authorization_id}`,
    });
    expect(responseBody<AuthorizationDetail>(unchangedResponse).record).toMatchObject({
      status: "pending",
      phase: "awaiting_analysis",
      evaluation_status: "not_evaluated",
      finalized_at: null,
    });
  });

  it("returns JSON for API 404s and the HTML application for direct navigation", async () => {
    const application = await appFixture();

    for (const url of ["/api/does-not-exist", "/api/runs/LOCAL_RUN_MISSING"]) {
      const response = await application.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(responseBody<ApiErrorPayload>(response).error.code).toMatch(
        /^(route_not_found|run_not_found)$/,
      );
      expect(response.body).not.toContain("<!doctype html>");
    }

    for (const url of [
      "/",
      "/scenarios/SCEN0000?draftId=LOCAL_PD_EXAMPLE",
      "/runs/LOCAL_RUN_EXAMPLE?authorizationId=LOCAL_AUTH_EXAMPLE_AU0001",
    ]) {
      const response = await application.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<title>Wallet control · Viseca</title>");
      expect(response.body).toContain('<div id="app"');
    }
  });
});
