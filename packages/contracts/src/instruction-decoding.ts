import type { HardRule } from "./policy.js";

export type DecodedVariable = {
  field: string;
  status: "present" | "absent" | "ambiguous";
  value: HardRule["value"] | null;
  operator: HardRule["operator"] | null;
  currency: NonNullable<HardRule["currency"]> | null;
  scope: NonNullable<HardRule["scope"]> | null;
  period_days: number | null;
  source_excerpt: string | null;
  note: string | null;
};

export type InstructionVariables = {
  variables: DecodedVariable[];
  unmapped_requirements: Array<{
    source_excerpt: string;
    description: string;
    reason: "no_native_field" | "ambiguous";
  }>;
};

export type InstructionDecoding = InstructionVariables & {
  requirement_inventory?: { version: string; requirements: Array<{ id: string; source_excerpt: string; status: "mapped" | "unmapped" | "uncertain" | "uncovered"; mappings: string[]; questions: string[] }> };
  decoding_id: string;
  instruction: string;
  schema_version: 1;
  prompt_version: string;
  validation_version?: string;
  source_schema_hash: string;
  model_requested: string;
  model_returned: string;
  response_id: string;
  created_at: string;
  duration_ms: number;
  usage: { input_tokens: number; output_tokens: number; reasoning_tokens: number };
};

export type InstructionDecodingView = {
  configured: boolean;
  model: string;
  status: "not_started" | "processing" | "completed" | "failed" | "interrupted";
  result: InstructionDecoding | null;
  error: { code: string; message: string } | null;
};
