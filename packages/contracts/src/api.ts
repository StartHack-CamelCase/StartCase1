import type { Card, Customer, FixtureAuthority, Scenario } from "./data.js";
import type { MandateRecord, PolicyDraft } from "./policy.js";
import type { RunView } from "./run.js";

export type ScenarioSummary = {
  scenario: Scenario;
  event_count: number;
  customer: Pick<Customer, "customer_id" | "persona_name" | "home_region">;
  card: Pick<Card, "card_id" | "card_type" | "card_purpose" | "status">;
  authority: FixtureAuthority;
};

export type ScenarioDetail = ScenarioSummary & {
  initial_policy: {
    instruction: string;
    hard_rules: [];
    uncertainty_policy: "ask";
    guidance: string[];
    open_questions: string[];
    interpretation: {
      status: "not_started";
      producer: null;
      version: null;
      model_id: null;
      requirements: [];
    };
  };
  drafts: PolicyDraft[];
  mandates: MandateRecord[];
};

export type RunListItem = {
  view: RunView;
  current: boolean;
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
