import type { Currency, ISODateTime } from "./data.js";
import type { DraftId, MandateId, ScenarioId } from "./ids.js";
import type { InstructionDecoding } from "./instruction-decoding.js";

export type UncertaintyPolicy = "ask" | "decline" | "approve";

export type HardRule = {
  field: string;
  operator: "<" | "<=" | "=" | "!=" | ">" | ">=" | "in" | "not_in";
  value: number | string | string[];
  currency?: Currency | null;
  scope?: "purchase" | "period" | null;
  period_days?: number | null;
};

export type PolicyContent = {
  instruction: string;
  hard_rules: HardRule[];
  uncertainty_policy: UncertaintyPolicy;
  guidance: string[];
  open_questions: string[];
};

export type InterpretationRequirement = {
  requirement_id: string;
  source_excerpt: string;
  description: string | null;
  status: "pending" | "mapped";
  rule_indexes: number[];
};

export type Interpretation = {
  status: "not_started" | "partial" | "reviewed";
  producer: "manual" | "fixture" | "model" | null;
  version: string | null;
  model_id: string | null;
  requirements: InterpretationRequirement[];
  instruction_decoding?: InstructionDecoding;
};

export type PolicyDraft = PolicyContent & {
  draft_id: DraftId;
  source_scenario_id: ScenarioId;
  interpretation: Interpretation;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  compiler_version: null;
  validation_errors: Array<{ field: string; message: string }>;
};

export type MandateRecord = PolicyContent & {
  mandate_id: MandateId;
  draft_id: DraftId;
  source_scenario_id: ScenarioId;
  interpretation: Interpretation;
  version: number;
  status: "active" | "revoked";
  confirmed_at: ISODateTime;
  confirmation_origin: "local_user" | "test_script";
  updated_at: ISODateTime;
  revoked_at: ISODateTime | null;
  compiler_version: null;
};

export type PolicyStoreDocument = {
  schema_version: 1;
  drafts: PolicyDraft[];
  mandates: MandateRecord[];
};
