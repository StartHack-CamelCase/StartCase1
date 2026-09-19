import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { Decimal } from "decimal.js";

import {
  asId,
  DataValidationError,
  type AuthorizationEvent,
  type AuthorizationRecord,
  type DataPack,
  type RequestId,
  type RunRecord,
  type RuntimeAuthorizationId,
  type SourceAttempt,
  type SourceAuthorizationId,
} from "../../../contracts/src/index.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

export type BuildAuthorizationRecordInput = {
  attempt: SourceAttempt;
  run: RunRecord;
  priorRecords: readonly AuthorizationRecord[];
  receivedAt: Date;
};

function fail(message: string, details?: Record<string, unknown>): never {
  throw new DataValidationError(message, details);
}

function runtimeId(runKey: string, sourceId: SourceAuthorizationId): RuntimeAuthorizationId {
  return asId<RuntimeAuthorizationId>(`LOCAL_AUTH_${runKey}_${sourceId}`);
}

function requestId(runKey: string, sourceId: SourceAuthorizationId): RequestId {
  return asId<RequestId>(`LOCAL_REQ_${runKey}_${sourceId}`);
}

function numeric(value: string, field: string): number {
  const decimal = new Decimal(value);
  const result = decimal.toNumber();
  if (!Number.isFinite(result)) fail("A decimal value cannot be represented in the canonical event", { field, value });
  return result;
}

export class AuthorizationEventFactory {
  private readonly validateEvent: ValidateFunction<AuthorizationEvent>;

  constructor(
    private readonly pack: DataPack,
    schemaPath: string,
  ) {
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
    } catch (error) {
      fail("Unable to load the authorization event schema", {
        schemaPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validateEvent = ajv.compile<AuthorizationEvent>(schema as object);
  }

  validate(event: unknown): void {
    if (!this.validateEvent(event)) {
      fail("Canonical authorization event does not satisfy authorization_event.schema.json", {
        errors: this.validateEvent.errors ?? [],
      });
    }
  }

  build(input: BuildAuthorizationRecordInput): AuthorizationRecord {
    const { attempt, run, priorRecords, receivedAt } = input;
    if (!Number.isFinite(receivedAt.getTime())) fail("receivedAt is not a valid date-time");
    if (attempt.scenario_id !== run.scenario_id) {
      fail("Attempt and run scenarios differ", {
        source_authorization_id: attempt.authorization_id,
        attempt_scenario_id: attempt.scenario_id,
        run_scenario_id: run.scenario_id,
      });
    }
    if (attempt.authority_id !== run.fixture_authority_id || attempt.card_id !== run.card_id) {
      fail("Attempt identity differs from the run snapshot", {
        source_authorization_id: attempt.authorization_id,
        authority_id: attempt.authority_id,
        card_id: attempt.card_id,
      });
    }
    if (
      run.mandate_snapshot.mandate_id !== run.mandate_id ||
      run.mandate_snapshot.customer_id !== run.customer_id ||
      run.mandate_snapshot.card_id !== run.card_id ||
      run.mandate_snapshot.profile_id !== run.profile_id
    ) {
      fail("Run mandate snapshot identity is inconsistent", { run_id: run.run_id });
    }
    if (run.config.decision_timeout_ms <= 0 || run.config.history_window_minutes <= 0) {
      fail("Run timing configuration is invalid", { run_id: run.run_id });
    }
    for (const record of priorRecords) {
      if (record.run_id !== run.run_id) fail("A prior authorization belongs to another run", { run_id: run.run_id, authorization_id: record.authorization_id });
      if (record.event.authorization.replay_order >= attempt.replay_order) fail("Prior authorization ordering is inconsistent", { run_id: run.run_id, authorization_id: record.authorization_id });
    }

    const merchant = this.pack.merchantsById.get(attempt.merchant_id);
    if (merchant === undefined) fail("Attempt merchant is absent from the loaded pack", { ...attempt.source, merchant_id: attempt.merchant_id });
    const lines = this.pack.itemsByAttempt.get(attempt.authorization_id);
    if (lines === undefined || lines.length === 0) fail("Attempt cart is absent from the loaded pack", { ...attempt.source, authorization_id: attempt.authorization_id });

    const authorizationId = runtimeId(run.run_key, attempt.authorization_id);
    const receivedAtIso = receivedAt.toISOString();
    const deadlineAt = new Date(receivedAt.getTime() + run.config.decision_timeout_ms).toISOString();
    const attemptTime = Date.parse(attempt.timestamp);
    const historyWindowMs = run.config.history_window_minutes * 60_000;
    const recentRecords = priorRecords.filter((record) => {
      const timestamp = Date.parse(record.event.authorization.timestamp);
      return attemptTime - historyWindowMs <= timestamp && timestamp < attemptTime;
    });

    const event: AuthorizationEvent = {
      type: "authorization.request",
      request_id: requestId(run.run_key, attempt.authorization_id),
      deadline_at: deadlineAt,
      authorization: {
        authorization_id: authorizationId,
        source_authorization_id: attempt.authorization_id,
        scenario_id: attempt.scenario_id,
        replay_order: attempt.replay_order,
        mandate_id: run.mandate_id,
        profile_id: run.profile_id,
        card_id: attempt.card_id,
        initiator_type: "agent",
        merchant: {
          merchant_id: merchant.merchant_id,
          merchant_name: merchant.merchant_name,
          merchant_category: merchant.merchant_category,
          merchant_mcc: merchant.merchant_mcc,
          merchant_country: merchant.merchant_country,
          merchant_city: merchant.merchant_city,
          availability: merchant.availability,
          recurring_capable: merchant.recurring_capable,
        },
        timestamp: attempt.timestamp,
        amount: numeric(attempt.amount, "authorization.amount"),
        currency: attempt.currency,
        billing_amount_chf: numeric(attempt.billing_amount_chf, "authorization.billing_amount_chf"),
        items_subtotal: numeric(attempt.items_subtotal, "authorization.items_subtotal"),
        delivery_fee: numeric(attempt.delivery_fee, "authorization.delivery_fee"),
        channel: attempt.channel,
        customer_device_id: attempt.customer_device_id ?? "",
        authority_status: attempt.authority_status,
        card_status_at_attempt: attempt.card_status_at_attempt,
        spend_in_period_before_chf: attempt.spend_in_period_before_chf === null ? null : numeric(attempt.spend_in_period_before_chf, "authorization.spend_in_period_before_chf"),
        recent_attempt_count_10m: attempt.recent_attempt_count_10m,
        fulfillment_method: attempt.fulfillment_method,
        delivery_by: attempt.delivery_by,
        order_returnable: attempt.order_returnable,
        order_cancellable: attempt.order_cancellable,
        related_authorization_id: attempt.related_authorization_id === null ? null : runtimeId(run.run_key, attempt.related_authorization_id),
        related_authorization_status: attempt.related_authorization_status,
        purchase_description: attempt.purchase_description,
        items: lines.map((line) => ({
          line_no: line.line_no,
          item_id: line.item_id,
          item_name: line.item_name,
          item_category: line.item_category,
          quantity: line.quantity,
          unit_price: numeric(line.unit_price, `authorization.items[${line.line_no}].unit_price`),
          currency: line.currency,
          item_details: line.item_details,
        })),
      },
      mandate: structuredClone(run.mandate_snapshot),
      context: {
        approved_spend_in_period_chf: null,
        recent_authorizations: recentRecords.map((record) => ({
          authorization_id: record.authorization_id,
          timestamp: record.event.authorization.timestamp,
          merchant_id: record.event.authorization.merchant.merchant_id,
          billing_amount_chf: record.event.authorization.billing_amount_chf,
          status: record.status,
        })),
      },
      runtime: {
        received_at: receivedAtIso,
        history_window_minutes: run.config.history_window_minutes,
        context_basis: "run_decisions_and_scenario_timestamps",
      },
    };
    this.validate(event);

    return {
      run_id: run.run_id,
      authorization_id: authorizationId,
      source_authorization_id: attempt.authorization_id,
      event,
      provenance: {
        attempt: structuredClone(attempt.source),
        merchant: structuredClone(merchant.source),
        items: lines.map((line) => {
          const catalogue = this.pack.itemsById.get(line.item_id);
          if (catalogue === undefined) fail("Cart catalogue provenance is missing", { ...line.source, item_id: line.item_id });
          return {
            line_no: line.line_no,
            attempt_item: structuredClone(line.source),
            catalogue_item: structuredClone(catalogue.source),
            catalogue_description: catalogue.item_description,
          };
        }),
      },
      phase: "awaiting_analysis",
      status: "pending",
      evaluation_status: "not_evaluated",
      evaluation_reason: "analysis_not_configured",
      emitted_at: receivedAtIso,
      finalized_at: null,
      revision: 1,
    };
  }
}
