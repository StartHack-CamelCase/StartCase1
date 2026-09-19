import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  AppError,
  asId,
  type AuthorizationDetail,
  type AuthorizationRecord,
  type DataPack,
  type MandateId,
  type MandateSnapshot,
  type PersistedRunState,
  type ProfileId,
  type RunId,
  type RunListItem,
  type RunRecord,
  type RuntimeAuthorizationId,
  type RunTraceEntry,
  type RunView,
  type ScenarioId,
} from "../../../contracts/src/index.js";
import type { AuthorizationEventFactory } from "../data/event-builder.js";
import type { RunFileStore } from "../storage/run-file-store.js";
import type { PolicyService } from "./policy-service.js";
import { SerialExecutor } from "./serial-executor.js";

export type RunServiceOptions = {
  now?: () => Date;
  createKey?: () => string;
};

export type CreateRunInput = {
  scenario_id: ScenarioId;
  mandate_id: MandateId;
  mode: "inspection";
};

export type NextInspectionResult = {
  authorization: AuthorizationRecord | null;
  view: RunView;
};

const ACTIVE_STATUSES = new Set<RunRecord["status"]>(["ready", "running"]);

export class RunService {
  private readonly states = new Map<RunId, PersistedRunState>();
  private readonly commands = new SerialExecutor();
  private readonly now: () => Date;
  private readonly createKey: () => string;

  constructor(
    private readonly pack: DataPack,
    private readonly policies: PolicyService,
    private readonly store: RunFileStore,
    private readonly eventFactory: AuthorizationEventFactory,
    options: RunServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createKey = options.createKey ?? (() => randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase());
  }

  async initialize(): Promise<void> {
    const loaded = await this.store.loadAll();
    for (const state of loaded) {
      if (this.states.has(state.run.run_id)) {
        throw new AppError(503, "run_store_invalid", "Un identifiant de run est dupliqué sur disque.", {
          run_id: state.run.run_id,
        });
      }
      if (ACTIVE_STATUSES.has(state.run.status)) {
        const interruptedAt = this.now().toISOString();
        state.run.status = "interrupted";
        state.run.finished_at = interruptedAt;
        const trace = this.nextTrace(
          state,
          "run_interrupted",
          "Le processus précédent s'est arrêté. Le run reste consultable en lecture seule.",
        );
        await this.store.commit(state, [], [trace]);
      }
      this.states.set(state.run.run_id, state);
    }
  }

  async create(input: CreateRunInput): Promise<RunView> {
    return this.commands.run(async () => {
      if (input.mode !== "inspection") {
        throw new AppError(
          409,
          "analysis_not_configured",
          "Le mode d'évaluation n'est pas disponible. Utilisez le mode inspection.",
        );
      }
      const active = [...this.states.values()].find((state) => ACTIVE_STATUSES.has(state.run.status));
      if (active !== undefined) {
        throw new AppError(409, "active_run_exists", "Un autre run d'inspection est déjà actif.", {
          run_id: active.run.run_id,
        });
      }

      const mandate = this.policies.getMandate(input.mandate_id);
      if (mandate.status !== "active") {
        throw new AppError(409, "mandate_revoked", "Le mandat a été révoqué.");
      }
      if (mandate.source_scenario_id !== input.scenario_id) {
        throw new AppError(409, "scenario_mandate_mismatch", "Le mandat ne provient pas de ce scénario.");
      }
      const attempts = this.pack.attemptsByScenario.get(input.scenario_id) ?? [];
      const firstAttempt = attempts[0];
      if (firstAttempt === undefined) {
        throw new AppError(404, "scenario_not_found", "Le scénario demandé ne contient aucun achat.");
      }
      const authority = this.pack.authoritiesById.get(firstAttempt.authority_id);
      if (authority === undefined) {
        throw new AppError(503, "data_pack_invalid", "L'autorité du scénario est introuvable.");
      }

      const key = this.uniqueRunKey();
      const runId = asId<RunId>(`LOCAL_RUN_${key}`);
      const profileId = asId<ProfileId>(`LOCAL_PROFILE_${key}`);
      const mandateSnapshot: MandateSnapshot = {
        mandate_id: mandate.mandate_id,
        status: "active",
        customer_id: authority.customer_id,
        card_id: authority.card_id,
        instruction: mandate.instruction,
        hard_rules: structuredClone(mandate.hard_rules),
        uncertainty_policy: mandate.uncertainty_policy,
        profile_id: profileId,
      };
      const startedAt = this.now().toISOString();
      const run: RunRecord = {
        run_id: runId,
        run_key: key,
        scenario_id: input.scenario_id,
        mode: "inspection",
        mandate_id: mandate.mandate_id,
        mandate_version: mandate.version,
        mandate_snapshot: mandateSnapshot,
        fixture_authority_id: authority.authority_id,
        customer_id: authority.customer_id,
        card_id: authority.card_id,
        profile_id: profileId,
        status: "ready",
        next_replay_order: 1,
        total_attempts: attempts.length,
        emitted_count: 0,
        started_at: startedAt,
        finished_at: null,
        config: {
          decision_timeout_ms: 8_000,
          history_window_minutes: 10,
        },
        pack_version: this.pack.pack_version,
        engine_version: null,
        facts_version: null,
        commands: [],
      };
      const state: PersistedRunState = {
        schema_version: 1,
        run,
        records: [],
        trace_sequence: 1,
      };
      const trace: RunTraceEntry = {
        schema_version: 1,
        sequence: 1,
        recorded_at: startedAt,
        run_id: runId,
        authorization_id: null,
        kind: "run_started",
        message: "Run d'inspection créé. Aucun achat n'a encore été émis.",
      };
      await this.store.create(state, trace);
      this.states.set(runId, state);
      return this.view(state);
    });
  }

  list(): RunListItem[] {
    const activeRunId = [...this.states.values()]
      .filter((state) => ACTIVE_STATUSES.has(state.run.status))
      .sort((left, right) => right.run.started_at.localeCompare(left.run.started_at))[0]?.run.run_id;
    return [...this.states.values()]
      .sort((left, right) => right.run.started_at.localeCompare(left.run.started_at))
      .map((state) => ({ view: this.view(state), current: state.run.run_id === activeRunId }));
  }

  get(runId: RunId): RunView {
    return this.view(this.requireState(runId));
  }

  getAuthorization(runId: RunId, authorizationId: RuntimeAuthorizationId): AuthorizationDetail {
    const state = this.requireState(runId);
    const record = state.records.find((candidate) => candidate.authorization_id === authorizationId);
    if (record === undefined) {
      throw new AppError(404, "authorization_not_found", "Cet achat n'appartient pas au run indiqué.");
    }
    const provenanceByLine = new Map(record.provenance.items.map((item) => [item.line_no, item]));
    return {
      record,
      display: {
        merchant_name: record.event.authorization.merchant.merchant_name,
        merchant_location: `${record.event.authorization.merchant.merchant_city}, ${record.event.authorization.merchant.merchant_country}`,
        amount: money(record.event.authorization.amount),
        currency: record.event.authorization.currency,
        billing_amount_chf: money(record.event.authorization.billing_amount_chf),
        purchase_description: record.event.authorization.purchase_description,
        items: record.event.authorization.items.map((item) => ({
          line_no: item.line_no,
          item_name: item.item_name,
          item_category: item.item_category,
          quantity: item.quantity,
          unit_price: money(item.unit_price),
          currency: item.currency,
          item_details: item.item_details,
          catalogue_description: provenanceByLine.get(item.line_no)?.catalogue_description ?? "",
        })),
      },
    };
  }

  async next(runId: RunId, idempotencyKey?: string): Promise<NextInspectionResult> {
    return this.commands.run(async () => {
      const state = await this.store.loadRun(runId);
      this.states.set(runId, state);
      if (idempotencyKey !== undefined) {
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "La clé d'idempotence est invalide.");
        const prior = state.run.commands.find((command) => command.key === idempotencyKey);
        if (prior !== undefined) return { authorization: prior.authorization ?? (prior.authorization_id === null ? null : state.records.find((record) => record.authorization_id === prior.authorization_id) ?? null), view: structuredClone(prior.view) };
      }
      if (state.run.status === "completed") {
        const view = this.view(state);
        if (idempotencyKey !== undefined) { state.run.commands.push({ key: idempotencyKey, authorization_id: null, view }); await this.store.commit(state); }
        return { authorization: null, view };
      }
      if (!ACTIVE_STATUSES.has(state.run.status)) {
        throw new AppError(409, "run_not_active", "Ce run est terminé et reste disponible en lecture seule.");
      }
      const attempts = this.pack.attemptsByScenario.get(state.run.scenario_id) ?? [];
      const attempt = attempts.find(
        (candidate) => candidate.replay_order === state.run.next_replay_order,
      );
      if (attempt === undefined) {
        state.run.status = "completed";
        state.run.finished_at = this.now().toISOString();
        const trace = this.nextTrace(
          state,
          "inspection_completed",
          "Tous les achats source ont été parcourus. Aucun achat n'a été évalué.",
        );
        await this.store.commit(state, [], [trace]);
        return { authorization: null, view: this.view(state) };
      }

      const receivedAt = this.now();
      const record = this.eventFactory.build({
        attempt,
        run: state.run,
        priorRecords: state.records,
        receivedAt,
      });
      const nextState = structuredClone(state);
      nextState.records.push(record);
      nextState.run.emitted_count = nextState.records.length;
      nextState.run.next_replay_order = attempt.replay_order + 1;
      nextState.run.status = nextState.run.emitted_count === nextState.run.total_attempts ? "completed" : "ready";
      if (nextState.run.status === "completed") {
        nextState.run.finished_at = receivedAt.toISOString();
      }

      const emittedTrace = this.nextTrace(
        nextState,
        "authorization_emitted",
        "Achat émis pour inspection avec le statut Non évalué.",
        record.authorization_id,
      );
      const traces = [emittedTrace];
      if (nextState.run.status === "completed") {
        const completedTrace = this.nextTrace(
          nextState,
          "inspection_completed",
          "Tous les achats source ont été parcourus. Aucun achat n'a été évalué.",
        );
        traces.push(completedTrace);
      }
      const resultView = this.view(nextState);
      if (idempotencyKey !== undefined) nextState.run.commands.push({ key: idempotencyKey, authorization_id: record.authorization_id, authorization:structuredClone(record), view: resultView });
      await this.store.commit(nextState, [record.event], traces);
      this.states.set(runId, nextState);
      return { authorization: record, view: resultView };
    });
  }

  async cancel(runId: RunId, message = "Run d'inspection annulé localement."): Promise<RunView> {
    return this.commands.run(async () => {
      const state = this.requireState(runId);
      if (state.run.status === "cancelled") {
        return this.view(state);
      }
      if (state.run.status === "interrupted" || state.run.status === "failed") {
        throw new AppError(409, "run_not_active", "Ce run est en lecture seule.");
      }
      if (state.run.status === "completed") {
        return this.view(state);
      }
      const cancelledAt = this.now().toISOString();
      const nextState = structuredClone(state);
      nextState.run.status = "cancelled";
      nextState.run.finished_at = cancelledAt;
      for (const record of nextState.records) {
        if (record.status === "pending") {
          record.status = "cancelled";
          record.phase = "final";
          record.finalized_at = cancelledAt;
          record.revision += 1;
        }
      }
      const trace = this.nextTrace(nextState, "run_cancelled", message);
      await this.store.commit(nextState, [], [trace]);
      this.states.set(runId, nextState);
      return this.view(nextState);
    });
  }

  async cancelForMandate(mandateId: MandateId): Promise<void> {
    const active = [...this.states.values()].find(
      (state) => state.run.mandate_id === mandateId && ACTIVE_STATUSES.has(state.run.status),
    );
    if (active !== undefined) {
      await this.cancel(active.run.run_id, "Run annulé après la révocation locale du mandat.");
    }
  }

  assertResolutionUnavailable(runId: RunId, authorizationId: RuntimeAuthorizationId): never {
    this.getAuthorization(runId, authorizationId);
    throw new AppError(
      409,
      "analysis_not_configured",
      "Les décisions et résolutions de paiement sont indisponibles en mode inspection.",
    );
  }

  private requireState(runId: RunId): PersistedRunState {
    const state = this.states.get(runId);
    if (state === undefined) {
      throw new AppError(404, "run_not_found", "Le run demandé n'existe pas.");
    }
    return state;
  }

  private uniqueRunKey(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const key = this.createKey();
      const id = asId<RunId>(`LOCAL_RUN_${key}`);
      if (!this.states.has(id)) return key;
    }
    throw new AppError(500, "id_generation_failed", "Impossible de générer un identifiant de run unique.");
  }

  private nextTrace(
    state: PersistedRunState,
    kind: RunTraceEntry["kind"],
    message: string,
    authorizationId: RuntimeAuthorizationId | null = null,
  ): RunTraceEntry {
    state.trace_sequence += 1;
    return {
      schema_version: 1,
      sequence: state.trace_sequence,
      recorded_at: this.now().toISOString(),
      run_id: state.run.run_id,
      authorization_id: authorizationId,
      kind,
      message,
    };
  }

  private view(state: PersistedRunState): RunView {
    const pending = state.records.filter((record) => record.status === "pending").length;
    const cancelled = state.records.filter((record) => record.status === "cancelled").length;
    return {
      run: { ...structuredClone(state.run), commands: [] },
      counts: {
        total: state.run.total_attempts,
        emitted: state.records.length,
        not_emitted: state.run.total_attempts - state.records.length,
        approved: 0,
        declined: 0,
        pending,
        not_evaluated: pending,
        cancelled,
      },
      total_approved_chf: "0.00",
      budgets: [],
      authorizations: state.records.map((record) => ({
        authorization_id: record.authorization_id,
        source_authorization_id: record.source_authorization_id,
        replay_order: record.event.authorization.replay_order,
        timestamp: record.event.authorization.timestamp,
        merchant_name: record.event.authorization.merchant.merchant_name,
        amount: money(record.event.authorization.amount),
        currency: record.event.authorization.currency,
        billing_amount_chf: money(record.event.authorization.billing_amount_chf),
        status: record.status,
        phase: record.phase,
        evaluation_status: "not_evaluated",
        revision: record.revision,
      })),
    };
  }
}

function money(value: number): string {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
}

export function runId(value: string): RunId {
  if (!/^LOCAL_RUN_[A-Z0-9]+$/.test(value)) {
    throw new AppError(400, "invalid_run_id", "L'identifiant de run est invalide.");
  }
  return asId<RunId>(value);
}

export function runtimeAuthorizationId(value: string): RuntimeAuthorizationId {
  if (!/^LOCAL_AUTH_[A-Z0-9]+_AU[0-9]{4}$/.test(value)) {
    throw new AppError(400, "invalid_authorization_id", "L'identifiant d'achat est invalide.");
  }
  return asId<RuntimeAuthorizationId>(value);
}
