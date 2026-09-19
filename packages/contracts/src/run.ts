import type { AuthorizationEvent, MandateSnapshot } from "./event.js";
import type { DecimalString, ISODateTime, SourceLocation } from "./data.js";
import type {
  AuthorityId,
  CardId,
  CustomerId,
  MandateId,
  ProfileId,
  RunId,
  RuntimeAuthorizationId,
  ScenarioId,
  SourceAuthorizationId,
} from "./ids.js";

export type RunStatus =
  | "ready"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type RunRecord = {
  run_id: RunId;
  run_key: string;
  scenario_id: ScenarioId;
  mode: "inspection";
  mandate_id: MandateId;
  mandate_version: number;
  mandate_snapshot: MandateSnapshot;
  fixture_authority_id: AuthorityId;
  customer_id: CustomerId;
  card_id: CardId;
  profile_id: ProfileId;
  status: RunStatus;
  next_replay_order: number;
  total_attempts: number;
  emitted_count: number;
  started_at: ISODateTime;
  finished_at: ISODateTime | null;
  config: {
    decision_timeout_ms: number;
    history_window_minutes: number;
  };
  pack_version: string;
  engine_version: null;
  facts_version: null;
  commands: Array<{ key: string; authorization_id: RuntimeAuthorizationId | null; authorization?: AuthorizationRecord | null; view: RunView }>;
};

export type AuthorizationProvenance = {
  attempt: SourceLocation;
  merchant: SourceLocation;
  items: Array<{
    line_no: number;
    attempt_item: SourceLocation;
    catalogue_item: SourceLocation;
    catalogue_description: string;
  }>;
};

export type AuthorizationRecord = {
  run_id: RunId;
  authorization_id: RuntimeAuthorizationId;
  source_authorization_id: SourceAuthorizationId;
  event: AuthorizationEvent;
  provenance: AuthorizationProvenance;
  phase: "awaiting_analysis" | "final";
  status: "pending" | "cancelled";
  evaluation_status: "not_evaluated";
  evaluation_reason: "analysis_not_configured";
  emitted_at: ISODateTime;
  finalized_at: ISODateTime | null;
  revision: number;
};

export type RunTraceEntry = {
  schema_version: 1;
  sequence: number;
  recorded_at: ISODateTime;
  run_id: RunId;
  authorization_id: RuntimeAuthorizationId | null;
  kind: "run_started" | "authorization_emitted" | "inspection_completed" | "run_cancelled" | "run_interrupted";
  message: string;
};

export type PersistedRunState = {
  schema_version: 1 | 2;
  traces?: RunTraceEntry[];
  run: RunRecord;
  records: AuthorizationRecord[];
  trace_sequence: number;
};

export type RunCounts = {
  total: number;
  emitted: number;
  not_emitted: number;
  approved: 0;
  declined: 0;
  pending: number;
  not_evaluated: number;
  cancelled: number;
};

export type AuthorizationSummary = {
  authorization_id: RuntimeAuthorizationId;
  source_authorization_id: SourceAuthorizationId;
  replay_order: number;
  timestamp: ISODateTime;
  merchant_name: string;
  amount: DecimalString;
  currency: string;
  billing_amount_chf: DecimalString;
  status: "pending" | "cancelled";
  phase: "awaiting_analysis" | "final";
  evaluation_status: "not_evaluated";
  revision: number;
};

export type RunView = {
  run: RunRecord;
  counts: RunCounts;
  total_approved_chf: "0.00";
  budgets: [];
  authorizations: AuthorizationSummary[];
};

export type AuthorizationDetail = {
  record: AuthorizationRecord;
  display: {
    merchant_name: string;
    merchant_location: string;
    amount: DecimalString;
    currency: string;
    billing_amount_chf: DecimalString;
    purchase_description: string;
    items: Array<{
      line_no: number;
      item_name: string;
      item_category: string;
      quantity: number;
      unit_price: DecimalString;
      currency: string;
      item_details: string;
      catalogue_description: string;
    }>;
  };
};
