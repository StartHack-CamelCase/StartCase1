import type {
  HardRule,
  Interpretation,
  InterpretationRequirement,
  MandateRecord,
  PolicyContent,
  PolicyDraft,
  PolicyStoreDocument,
  UncertaintyPolicy,
} from "../../../contracts/src/policy.js";
import type { Currency, ISODateTime } from "../../../contracts/src/data.js";
import type { DraftId, MandateId, ScenarioId } from "../../../contracts/src/ids.js";
import { asId } from "../../../contracts/src/ids.js";
import { parseInstructionDecoding } from "../ai/instruction-schema.js";

type JsonObject = Record<string, unknown>;

const POLICY_KEYS = [
  "instruction",
  "hard_rules",
  "uncertainty_policy",
  "guidance",
  "open_questions",
] as const;

const HARD_RULE_REQUIRED_KEYS = ["field", "operator", "value"] as const;
const HARD_RULE_OPTIONAL_KEYS = ["currency", "scope", "period_days"] as const;
const OPERATORS = new Set(["<", "<=", "=", "!=", ">", ">=", "in", "not_in"]);
const CURRENCIES = new Set(["CHF", "EUR", "GBP", "USD"]);
const SCOPES = new Set(["purchase", "period"]);
const UNCERTAINTY_POLICIES = new Set(["ask", "decline", "approve"]);

export class PolicyValidationIssue extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PolicyValidationIssue";
    this.path = path;
  }
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyValidationIssue(path, "expected an object");
  }
  return value as JsonObject;
}

function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PolicyValidationIssue(`${path}.${key}`, "unknown field");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new PolicyValidationIssue(`${path}.${key}`, "required field is missing");
    }
  }
}

function stringAt(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    throw new PolicyValidationIssue(path, nonEmpty ? "expected a nonempty string" : "expected a string");
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum?: number): number {
  if (!Number.isInteger(value) || (minimum !== undefined && (value as number) < minimum)) {
    const suffix = minimum === undefined ? "" : ` greater than or equal to ${minimum}`;
    throw new PolicyValidationIssue(path, `expected an integer${suffix}`);
  }
  return value as number;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationIssue(path, "expected an array of strings");
  }
  return value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function dateTimeAt(value: unknown, path: string): ISODateTime {
  const text = stringAt(value, path, true);
  if (!text.endsWith("Z") || Number.isNaN(Date.parse(text))) {
    throw new PolicyValidationIssue(path, "expected a valid UTC ISO 8601 date-time");
  }
  return text;
}

function nullableDateTimeAt(value: unknown, path: string): ISODateTime | null {
  return value === null ? null : dateTimeAt(value, path);
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path, true);
}

function idAt<TId extends string>(value: unknown, path: string): TId {
  return asId<TId>(stringAt(value, path, true));
}

export function parseHardRule(value: unknown, path = "hard_rule"): HardRule {
  const object = objectAt(value, path);
  assertExactKeys(object, HARD_RULE_REQUIRED_KEYS, HARD_RULE_OPTIONAL_KEYS, path);

  const field = stringAt(object["field"], `${path}.field`, true);
  const operator = stringAt(object["operator"], `${path}.operator`);
  if (!OPERATORS.has(operator)) {
    throw new PolicyValidationIssue(`${path}.operator`, "unsupported operator");
  }

  const rawValue = object["value"];
  let parsedValue: number | string | string[];
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    parsedValue = rawValue;
  } else if (typeof rawValue === "string") {
    parsedValue = rawValue;
  } else if (Array.isArray(rawValue)) {
    parsedValue = rawValue.map((entry, index) =>
      stringAt(entry, `${path}.value[${index}]`),
    );
  } else {
    throw new PolicyValidationIssue(
      `${path}.value`,
      "expected a finite number, string, or array containing only strings",
    );
  }

  const result: HardRule = {
    field,
    operator: operator as HardRule["operator"],
    value: parsedValue,
  };

  if (Object.hasOwn(object, "currency")) {
    if (object["currency"] !== null && (typeof object["currency"] !== "string" || !CURRENCIES.has(object["currency"]))) {
      throw new PolicyValidationIssue(`${path}.currency`, "unsupported currency");
    }
    result.currency = object["currency"] as Currency | null;
  }
  if (Object.hasOwn(object, "scope")) {
    if (object["scope"] !== null && (typeof object["scope"] !== "string" || !SCOPES.has(object["scope"]))) {
      throw new PolicyValidationIssue(`${path}.scope`, "unsupported scope");
    }
    result.scope = object["scope"] as "purchase" | "period" | null;
  }
  if (Object.hasOwn(object, "period_days")) {
    result.period_days =
      object["period_days"] === null
        ? null
        : integerAt(object["period_days"], `${path}.period_days`, 1);
  }

  return result;
}

export function parseHardRules(value: unknown, path = "hard_rules"): HardRule[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationIssue(path, "expected an array");
  }
  return value.map((rule, index) => parseHardRule(rule, `${path}[${index}]`));
}

function parseUncertaintyPolicy(value: unknown, path: string): UncertaintyPolicy {
  const policy = stringAt(value, path);
  if (!UNCERTAINTY_POLICIES.has(policy)) {
    throw new PolicyValidationIssue(path, "expected ask, decline, or approve");
  }
  return policy as UncertaintyPolicy;
}

export function parsePolicyContent(value: unknown, path = "policy"): PolicyContent {
  const object = objectAt(value, path);
  assertExactKeys(object, POLICY_KEYS, [], path);
  return {
    instruction: stringAt(object["instruction"], `${path}.instruction`, true),
    hard_rules: parseHardRules(object["hard_rules"], `${path}.hard_rules`),
    uncertainty_policy: parseUncertaintyPolicy(
      object["uncertainty_policy"],
      `${path}.uncertainty_policy`,
    ),
    guidance: stringArrayAt(object["guidance"], `${path}.guidance`),
    open_questions: stringArrayAt(object["open_questions"], `${path}.open_questions`),
  };
}

function parseRequirement(value: unknown, path: string): InterpretationRequirement {
  const object = objectAt(value, path);
  assertExactKeys(
    object,
    ["requirement_id", "source_excerpt", "description", "status", "rule_indexes"],
    [],
    path,
  );
  const status = stringAt(object["status"], `${path}.status`);
  if (status !== "pending" && status !== "mapped") {
    throw new PolicyValidationIssue(`${path}.status`, "expected pending or mapped");
  }
  if (!Array.isArray(object["rule_indexes"])) {
    throw new PolicyValidationIssue(`${path}.rule_indexes`, "expected an array");
  }
  return {
    requirement_id: stringAt(object["requirement_id"], `${path}.requirement_id`, true),
    source_excerpt: stringAt(object["source_excerpt"], `${path}.source_excerpt`),
    description:
      object["description"] === null
        ? null
        : stringAt(object["description"], `${path}.description`),
    status,
    rule_indexes: object["rule_indexes"].map((index, position) =>
      integerAt(index, `${path}.rule_indexes[${position}]`, 0),
    ),
  };
}

function parseInterpretation(value: unknown, path: string): Interpretation {
  const object = objectAt(value, path);
  assertExactKeys(
    object,
    ["status", "producer", "version", "model_id", "requirements"],
    ["instruction_decoding"],
    path,
  );
  const status = stringAt(object["status"], `${path}.status`);
  if (status !== "not_started" && status !== "partial" && status !== "reviewed") {
    throw new PolicyValidationIssue(`${path}.status`, "unsupported interpretation status");
  }
  const producer = object["producer"];
  if (
    producer !== null &&
    producer !== "manual" &&
    producer !== "fixture" &&
    producer !== "model"
  ) {
    throw new PolicyValidationIssue(`${path}.producer`, "unsupported interpretation producer");
  }
  if (!Array.isArray(object["requirements"])) {
    throw new PolicyValidationIssue(`${path}.requirements`, "expected an array");
  }
  return {
    status,
    producer,
    version: nullableStringAt(object["version"], `${path}.version`),
    model_id: nullableStringAt(object["model_id"], `${path}.model_id`),
    requirements: object["requirements"].map((requirement, index) =>
      parseRequirement(requirement, `${path}.requirements[${index}]`),
    ),
    ...(object["instruction_decoding"] === undefined ? {} : { instruction_decoding: parseInstructionDecoding(object["instruction_decoding"]) }),
  };
}

function assertRequirementIndexes(
  interpretation: Interpretation,
  ruleCount: number,
  path: string,
): void {
  for (const [requirementIndex, requirement] of interpretation.requirements.entries()) {
    for (const ruleIndex of requirement.rule_indexes) {
      if (ruleIndex >= ruleCount) {
        throw new PolicyValidationIssue(
          `${path}.requirements[${requirementIndex}].rule_indexes`,
          `rule index ${ruleIndex} is outside hard_rules`,
        );
      }
    }
  }
}

function policySubset(object: JsonObject, path: string): PolicyContent {
  return parsePolicyContent(
    Object.fromEntries(POLICY_KEYS.map((key) => [key, object[key]])),
    path,
  );
}

function parseDraft(value: unknown, path: string): PolicyDraft {
  const object = objectAt(value, path);
  assertExactKeys(
    object,
    [
      ...POLICY_KEYS,
      "draft_id",
      "source_scenario_id",
      "interpretation",
      "created_at",
      "updated_at",
      "compiler_version",
      "validation_errors",
    ],
    [],
    path,
  );
  if (object["compiler_version"] !== null) {
    throw new PolicyValidationIssue(`${path}.compiler_version`, "expected null");
  }
  if (!Array.isArray(object["validation_errors"])) {
    throw new PolicyValidationIssue(`${path}.validation_errors`, "expected an array");
  }
  const policy = policySubset(object, path);
  const interpretation = parseInterpretation(object["interpretation"], `${path}.interpretation`);
  if (interpretation.instruction_decoding !== undefined) parseInstructionDecoding(interpretation.instruction_decoding, policy.instruction);
  assertRequirementIndexes(interpretation, policy.hard_rules.length, `${path}.interpretation`);
  return {
    ...policy,
    draft_id: idAt<DraftId>(object["draft_id"], `${path}.draft_id`),
    source_scenario_id: idAt<ScenarioId>(
      object["source_scenario_id"],
      `${path}.source_scenario_id`,
    ),
    interpretation,
    created_at: dateTimeAt(object["created_at"], `${path}.created_at`),
    updated_at: dateTimeAt(object["updated_at"], `${path}.updated_at`),
    compiler_version: null,
    validation_errors: object["validation_errors"].map((entry, index) => {
      const error = objectAt(entry, `${path}.validation_errors[${index}]`);
      assertExactKeys(
        error,
        ["field", "message"],
        [],
        `${path}.validation_errors[${index}]`,
      );
      return {
        field: stringAt(error["field"], `${path}.validation_errors[${index}].field`),
        message: stringAt(error["message"], `${path}.validation_errors[${index}].message`),
      };
    }),
  };
}

function parseMandate(value: unknown, path: string): MandateRecord {
  const object = objectAt(value, path);
  assertExactKeys(
    object,
    [
      ...POLICY_KEYS,
      "mandate_id",
      "draft_id",
      "source_scenario_id",
      "interpretation",
      "version",
      "status",
      "confirmed_at",
      "confirmation_origin",
      "updated_at",
      "revoked_at",
      "compiler_version",
    ],
    [],
    path,
  );
  if (object["compiler_version"] !== null) {
    throw new PolicyValidationIssue(`${path}.compiler_version`, "expected null");
  }
  const status = stringAt(object["status"], `${path}.status`);
  if (status !== "active" && status !== "revoked") {
    throw new PolicyValidationIssue(`${path}.status`, "expected active or revoked");
  }
  const origin = stringAt(object["confirmation_origin"], `${path}.confirmation_origin`);
  if (origin !== "local_user" && origin !== "test_script") {
    throw new PolicyValidationIssue(
      `${path}.confirmation_origin`,
      "expected local_user or test_script",
    );
  }
  const revokedAt = nullableDateTimeAt(object["revoked_at"], `${path}.revoked_at`);
  if ((status === "revoked") !== (revokedAt !== null)) {
    throw new PolicyValidationIssue(
      `${path}.revoked_at`,
      "must be set exactly when the mandate is revoked",
    );
  }
  const policy = policySubset(object, path);
  const interpretation = parseInterpretation(object["interpretation"], `${path}.interpretation`);
  if (interpretation.instruction_decoding !== undefined) parseInstructionDecoding(interpretation.instruction_decoding, policy.instruction);
  assertRequirementIndexes(interpretation, policy.hard_rules.length, `${path}.interpretation`);
  return {
    ...policy,
    mandate_id: idAt<MandateId>(object["mandate_id"], `${path}.mandate_id`),
    draft_id: idAt<DraftId>(object["draft_id"], `${path}.draft_id`),
    source_scenario_id: idAt<ScenarioId>(
      object["source_scenario_id"],
      `${path}.source_scenario_id`,
    ),
    interpretation,
    version: integerAt(object["version"], `${path}.version`, 1),
    status,
    confirmed_at: dateTimeAt(object["confirmed_at"], `${path}.confirmed_at`),
    confirmation_origin: origin,
    updated_at: dateTimeAt(object["updated_at"], `${path}.updated_at`),
    revoked_at: revokedAt,
    compiler_version: null,
  };
}

export function parsePolicyStoreDocument(value: unknown): PolicyStoreDocument {
  const object = objectAt(value, "policies");
  assertExactKeys(object, ["schema_version", "drafts", "mandates"], [], "policies");
  if (object["schema_version"] !== 1) {
    throw new PolicyValidationIssue("policies.schema_version", "expected schema version 1");
  }
  if (!Array.isArray(object["drafts"]) || !Array.isArray(object["mandates"])) {
    throw new PolicyValidationIssue("policies", "drafts and mandates must be arrays");
  }
  const drafts = object["drafts"].map((draft, index) => parseDraft(draft, `policies.drafts[${index}]`));
  const mandates = object["mandates"].map((mandate, index) =>
    parseMandate(mandate, `policies.mandates[${index}]`),
  );

  const draftsById = new Map(drafts.map((draft) => [draft.draft_id, draft]));
  if (draftsById.size !== drafts.length) {
    throw new PolicyValidationIssue("policies.drafts", "duplicate draft_id");
  }
  const mandatesById = new Map(mandates.map((mandate) => [mandate.mandate_id, mandate]));
  if (mandatesById.size !== mandates.length) {
    throw new PolicyValidationIssue("policies.mandates", "duplicate mandate_id");
  }
  const mandateDraftIds = new Set<string>();
  for (const mandate of mandates) {
    const draft = draftsById.get(mandate.draft_id);
    if (draft === undefined) {
      throw new PolicyValidationIssue(
        "policies.mandates",
        `mandate ${mandate.mandate_id} references an unknown draft`,
      );
    }
    if (mandateDraftIds.has(mandate.draft_id)) {
      throw new PolicyValidationIssue(
        "policies.mandates",
        `more than one mandate references draft ${mandate.draft_id}`,
      );
    }
    mandateDraftIds.add(mandate.draft_id);
    if (
      mandate.source_scenario_id !== draft.source_scenario_id ||
      mandate.instruction !== draft.instruction
    ) {
      throw new PolicyValidationIssue(
        "policies.mandates",
        `mandate ${mandate.mandate_id} does not preserve its draft provenance`,
      );
    }
  }
  return { schema_version: 1, drafts, mandates };
}
