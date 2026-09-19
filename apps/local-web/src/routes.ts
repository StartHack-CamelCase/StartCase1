import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AppError,
  asId,
  type MandateRecord,
  type ScenarioId,
} from "../../../packages/contracts/src/index.js";
import type { LocalRuntime } from "../../../packages/local-runtime/src/runtime.js";
import type { HumanChannel } from "./human-channel.js";
import { runId, runtimeAuthorizationId } from "../../../packages/local-runtime/src/services/run-service.js";
import { scenarioId } from "../../../packages/local-runtime/src/services/scenario-service.js";
import { IdempotencyStore, type CachedHttpResponse } from "./idempotency.js";
import {
  draftId,
  mandateId,
  parsePolicyContent,
  requiredString,
  strictObject,
  stringArray,
} from "./request-validation.js";

type RuntimeProvider = () => LocalRuntime;

export function registerApiRoutes(
  app: FastifyInstance,
  runtime: RuntimeProvider,
  idempotency: IdempotencyStore,
  channel?: HumanChannel,
): void {
  const requireOwner = (request: FastifyRequest, sourceScenario: string): void => {
    // Preserve the standalone offline inspector contract. Once connected, all
    // permission changes also require the wallet's customer-bound session.
    if (!runtime().wallet.options().live_configured) return;
    const actor = channel?.actor(request);
    if (actor?.customer_id !== runtime().wallet.actorCustomer(sourceScenario)) throw new AppError(403, "human_session_required", "Open the matching customer confirmation page before changing these permissions.");
  };
  app.addHook('preHandler', async request => {
    const path = request.url.split('?')[0]!;
    const draft = path.match(/^\/api\/mandate-drafts\/([^/]+)\/confirm$/);
    const mandate = path.match(/^\/api\/mandates\/([^/]+)$/);
    if (draft && request.method === 'POST') requireOwner(request, runtime().policies.getDraft(draftId(decodeURIComponent(draft[1]!))).source_scenario_id);
    if (mandate && ['PATCH', 'DELETE'].includes(request.method)) requireOwner(request, runtime().policies.getMandate(mandateId(decodeURIComponent(mandate[1]!))).source_scenario_id);
  });
  app.get("/api/scenarios", async () => ({ scenarios: runtime().scenarios.list() }));

  app.get<{ Params: { scenarioId: string } }>("/api/scenarios/:scenarioId/instruction-decoding", async (request) =>
    runtime().instructions.get(scenarioId(request.params.scenarioId)),
  );
  app.post<{ Params: { scenarioId: string } }>("/api/scenarios/:scenarioId/decode-instruction", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      const body = strictObject(request.body ?? {}, ["retry"]);
      if (body["retry"] !== undefined && typeof body["retry"] !== "boolean") throw new AppError(400, "invalid_field", "retry doit être un booléen.");
      const result = await runtime().instructions.decode(scenarioId(request.params.scenarioId), body["retry"] === true);
      return { statusCode: 200, payload: result };
    }),
  );

  app.get<{
    Params: { scenarioId: string };
    Querystring: { draftId?: string; mandateId?: string };
  }>("/api/scenarios/:scenarioId", async (request) => {
    const selection: Parameters<LocalRuntime["scenarios"]["get"]>[1] = {};
    if (request.query.draftId !== undefined) selection.draftId = draftId(request.query.draftId);
    if (request.query.mandateId !== undefined) selection.mandateId = mandateId(request.query.mandateId);
    return runtime().scenarios.get(scenarioId(request.params.scenarioId), selection);
  });

  app.post("/api/mandate-drafts", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      const body = strictObject(request.body, [
        "scenario_id",
        "instruction",
        "hard_rules",
        "uncertainty_policy",
        "guidance",
        "open_questions",
        "instruction_decoding_id",
      ]);
      const id = scenarioId(requiredString(body["scenario_id"], "scenario_id"));
      const content = parsePolicyContent(body);
      const decoding = body["instruction_decoding_id"] === undefined ? undefined : runtime().instructions.getCompleted(id, requiredString(body["instruction_decoding_id"], "instruction_decoding_id"));
      const draft = await runtime().policies.createDraft(id, content, decoding);
      return { statusCode: 201, payload: draft };
    }),
  );

  app.get<{ Params: { draftId: string } }>("/api/mandate-drafts/:draftId", async (request) =>
    runtime().policies.getDraft(draftId(request.params.draftId)),
  );

  app.post<{ Params: { draftId: string } }>(
    "/api/mandate-drafts/:draftId/confirm",
    async (request, reply) =>
      mutate(request, reply, idempotency, async () => {
        const body = strictObject(request.body, ["confirmed"]);
        if (body["confirmed"] !== true) {
          throw new AppError(400, "confirmation_required", "Le champ confirmed doit valoir true.");
        }
        const mandate = await runtime().policies.confirmDraft(
          draftId(request.params.draftId),
          "local_user",
        );
        return { statusCode: 201, payload: mandate };
      }),
  );

  app.get<{ Params: { mandateId: string } }>("/api/mandates/:mandateId", async (request) =>
    runtime().policies.getMandate(mandateId(request.params.mandateId)),
  );

  app.patch<{ Params: { mandateId: string } }>("/api/mandates/:mandateId", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      const body = strictObject(request.body, [
        "expected_version",
        "hard_rules",
        "uncertainty_policy",
        "guidance",
        "open_questions",
      ]);
      if (!Number.isInteger(body["expected_version"]) || (body["expected_version"] as number) < 1) {
        throw new AppError(400, "invalid_field", "expected_version doit être un entier positif.");
      }
      const current = runtime().policies.getMandate(mandateId(request.params.mandateId));
      const candidate = parsePolicyContent({
        instruction: current.instruction,
        hard_rules: body["hard_rules"] ?? current.hard_rules,
        uncertainty_policy: body["uncertainty_policy"] ?? current.uncertainty_policy,
        guidance: body["guidance"] ?? current.guidance,
        open_questions: body["open_questions"] ?? current.open_questions,
      });
      const fields: {
        expected_version: number;
        hard_rules?: typeof candidate.hard_rules;
        uncertainty_policy?: typeof candidate.uncertainty_policy;
        guidance?: string[];
        open_questions?: string[];
      } = { expected_version: body["expected_version"] as number };
      if ("hard_rules" in body) fields.hard_rules = candidate.hard_rules;
      if ("uncertainty_policy" in body) fields.uncertainty_policy = candidate.uncertainty_policy;
      if ("guidance" in body) fields.guidance = stringArray(body["guidance"], "guidance");
      if ("open_questions" in body) {
        fields.open_questions = stringArray(body["open_questions"], "open_questions");
      }
      const mandate = await runtime().policies.updateMandate(
        mandateId(request.params.mandateId),
        fields,
      );
      return { statusCode: 200, payload: mandate };
    }),
  );

  app.delete<{ Params: { mandateId: string } }>("/api/mandates/:mandateId", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      const id = mandateId(request.params.mandateId);
      const mandate = await runtime().policies.revokeMandate(id);
      runtime().simulations.revokeMandate(id, String(request.headers["idempotency-key"]) + ":simulation");
      await runtime().runs.cancelForMandate(id);
      return { statusCode: 200, payload: mandate };
    }),
  );

  app.post("/api/runs", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      const body = strictObject(request.body, ["scenario_id", "mandate_id", "mode"]);
      if (body["mode"] !== "inspection") {
        throw new AppError(
          409,
          "analysis_not_configured",
          "Seul le mode inspection est disponible dans ce socle.",
        );
      }
      const view = await runtime().runs.create({
        scenario_id: scenarioId(requiredString(body["scenario_id"], "scenario_id")),
        mandate_id: mandateId(requiredString(body["mandate_id"], "mandate_id")),
        mode: "inspection",
      });
      return { statusCode: 201, payload: view };
    }),
  );

  app.get("/api/runs", async () => ({ runs: runtime().runs.list() }));

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request) =>
    runtime().runs.get(runId(request.params.runId)),
  );

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/next", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      strictObject(request.body ?? {}, []);
      const result = await runtime().runs.next(runId(request.params.runId), String(request.headers["idempotency-key"]));
      return { statusCode: 200, payload: result };
    }),
  );

  app.get<{ Params: { runId: string; authorizationId: string } }>(
    "/api/runs/:runId/authorizations/:authorizationId",
    async (request) =>
      runtime().runs.getAuthorization(
        runId(request.params.runId),
        runtimeAuthorizationId(request.params.authorizationId),
      ),
  );

  app.post<{ Params: { runId: string; authorizationId: string } }>(
    "/api/runs/:runId/authorizations/:authorizationId/resolve",
    async (request, reply) =>
      mutate(request, reply, idempotency, async () => {
        strictObject(request.body, ["decision", "expected_revision", "customer_message"]);
        return runtime().runs.assertResolutionUnavailable(
          runId(request.params.runId),
          runtimeAuthorizationId(request.params.authorizationId),
        );
      }),
  );

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (request, reply) =>
    mutate(request, reply, idempotency, async () => {
      strictObject(request.body ?? {}, []);
      const view = await runtime().runs.cancel(runId(request.params.runId));
      return { statusCode: 200, payload: view };
    }),
  );
}

async function mutate<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  idempotency: IdempotencyStore,
  command: () => Promise<CachedHttpResponse<T>>,
): Promise<T> {
  const header = request.headers["idempotency-key"];
  if (Array.isArray(header) || header === undefined) {
    throw new AppError(
      400,
      "idempotency_key_required",
      "Une mutation nécessite l'en-tête Idempotency-Key.",
    );
  }
  const result = await idempotency.execute(
    header,
    { method: request.method, path: request.url, body: request.body ?? null },
    command,
  );
  reply.code(result.statusCode);
  return result.payload;
}
