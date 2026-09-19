import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AppError, errorMessage } from "../../../packages/contracts/src/index.js";
import {
  createLocalRuntime,
  type LocalRuntime,
  type LocalRuntimeOptions,
} from "../../../packages/local-runtime/src/runtime.js";
import { IdempotencyStore } from "./idempotency.js";
import { registerApiRoutes } from "./routes.js";
import { registerSimulationRoutes } from "./simulation-routes.js";
import { createHumanChannel } from "./human-channel.js";
import { registerWalletRoutes } from "./wallet-routes.js";

export type LocalAppOptions = LocalRuntimeOptions & {
  webDir?: string;
  logger?: boolean;
};

export async function createLocalApp(options: LocalAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  const rootDir = options.rootDir ?? process.cwd();
  const webDir = options.webDir ?? resolve(rootDir, "dist/apps/local-web/web");
  let runtime: LocalRuntime | null = null;
  let startupError: unknown = null;

  try {
    runtime = await createLocalRuntime(options);
  } catch (error) {
    startupError = error;
  }

  await app.register(fastifyStatic, {
    root: webDir,
    prefix: "/static/",
    wildcard: false,
    decorateReply: true,
  });

  app.addHook("onRequest", async (request) => {
    if (
      request.url.startsWith("/api/") &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== undefined
    ) {
      let origin: URL;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        throw new AppError(403, "origin_forbidden", "The request origin is invalid.");
      }
      if (origin.protocol !== "http:" || origin.host !== request.headers.host) {
        throw new AppError(403, "origin_forbidden", "Cross-origin changes are not allowed.");
      }
    }
  });

  app.get("/api/health", async (_request, reply) => {
    if (runtime === null) {
      reply.code(503);
      return {
        status: "unavailable",
        mode: "offline",
        app_version: "0.1.0",
        pack: { available: false, error: errorMessage(startupError) },
      };
    }
    return {
      status: "ok",
      mode: "offline",
      app_version: "0.1.0",
      pack: {
        available: true,
        version: runtime.pack.pack_version,
        manifest_hashes_verified: runtime.pack.manifest_hashes_verified,
        scenarios: runtime.pack.scenarios.length,
        attempts: runtime.pack.attempts.length,
      },
    };
  });

  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/") && request.url !== "/api/health" && runtime === null) {
      throw new AppError(503, "data_pack_unavailable", "Le pack local est indisponible.", {
        cause: errorMessage(startupError),
      });
    }
  });

  registerApiRoutes(
    app,
    () => {
      if (runtime === null) {
        throw new AppError(503, "data_pack_unavailable", "Le pack local est indisponible.");
      }
      return runtime;
    },
    new IdempotencyStore(),
  );

  const humanChannel = createHumanChannel();
  const availableRuntime = () => {
    if (runtime === null) throw new AppError(503, "runtime_unavailable", "Le stockage est indisponible.");
    return runtime;
  };
  registerSimulationRoutes(app, availableRuntime, humanChannel);
  registerWalletRoutes(app, availableRuntime, humanChannel);
  app.addHook("onClose", async () => { await runtime?.close(); });
  const serveIndex = async (_request: unknown, reply: { type: (value: string) => unknown; sendFile: (path: string) => unknown }) => {
    reply.type("text/html; charset=utf-8");
    return reply.sendFile("index.html");
  };
  app.get("/", serveIndex);
  app.get("/scenarios/:scenarioId", serveIndex);
  app.get("/runs/:runId", serveIndex);
  app.get("/safety/:mandateId", serveIndex);
  app.get("/simulations/:runId", serveIndex);
  app.get("/wallet", serveIndex);
  app.get("/wallet/new", serveIndex);
  app.get("/wallet/runs/:runId", serveIndex);

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404);
      return {
        error: {
          code: "route_not_found",
          message: "Cette route API n'existe pas.",
        },
      };
    }
    reply.code(404).type("text/plain; charset=utf-8");
    return "Page introuvable";
  });

  app.setErrorHandler(async (error, request, reply) => {
    const appError = error instanceof AppError ? error : null;
    const frameworkStatus =
      error !== null && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    const clientStatus = typeof frameworkStatus === 'number' && Number.isInteger(frameworkStatus) && frameworkStatus >= 400 && frameworkStatus < 500 ? frameworkStatus : null;
    const statusCode = appError?.statusCode ?? clientStatus ?? 500;
    const clientErrors: Record<number, { code: string; message: string }> = {
      400: { code: 'invalid_json', message: 'The request JSON is invalid.' },
      413: { code: 'payload_too_large', message: 'The request body is too large.' },
      415: { code: 'unsupported_media_type', message: 'Use application/json for the request body.' },
    };
    const clientError = clientErrors[statusCode];
    const code = appError?.code ?? clientError?.code ?? (clientStatus ? 'invalid_request' : 'internal_error');
    const message =
      appError?.message ??
      clientError?.message ??
      (clientStatus ? 'The request is invalid.' : "The request could not be completed. Your saved activity is preserved.");
    request.log.error({ err: error, code }, "request failed");
    const payload: {
      error: { code: string; message: string; details?: Record<string, unknown> };
    } = { error: { code, message } };
    if (appError?.details !== undefined) payload.error.details = appError.details;
    reply.code(statusCode).type("application/json; charset=utf-8");
    return payload;
  });

  return app;
}
