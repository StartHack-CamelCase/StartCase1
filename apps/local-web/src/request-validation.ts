import {
  AppError,
  CURRENCIES,
  asId,
  type DraftId,
  type Currency,
  type HardRule,
  type MandateId,
  type PolicyContent,
  type RuntimeAuthorizationId,
} from "../../../packages/contracts/src/index.js";

export function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  context = "corps de requête",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "invalid_body", `Le ${context} doit être un objet JSON.`);
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new AppError(400, "unknown_field", "Le corps contient des champs inconnus.", {
      fields: unknown,
    });
  }
  return object;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(400, "invalid_field", `Le champ ${field} doit être une chaîne non vide.`, {
      field,
    });
  }
  return value;
}

export function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError(400, "invalid_field", `Le champ ${field} doit être une liste de chaînes.`, {
      field,
    });
  }
  return value as string[];
}

export function parsePolicyContent(object: Record<string, unknown>): PolicyContent {
  const policy = object["uncertainty_policy"];
  if (policy !== "ask" && policy !== "decline" && policy !== "approve") {
    throw new AppError(400, "invalid_field", "La politique d'incertitude est invalide.", {
      field: "uncertainty_policy",
    });
  }
  const rawRules = object["hard_rules"];
  if (!Array.isArray(rawRules)) {
    throw new AppError(400, "invalid_field", "hard_rules doit être une liste.", {
      field: "hard_rules",
    });
  }
  return {
    instruction: requiredString(object["instruction"], "instruction"),
    hard_rules: rawRules.map((rule, index) => parseHardRule(rule, index)),
    uncertainty_policy: policy,
    guidance: stringArray(object["guidance"], "guidance"),
    open_questions: stringArray(object["open_questions"], "open_questions"),
  };
}

function parseHardRule(value: unknown, index: number): HardRule {
  const object = strictObject(
    value,
    ["field", "operator", "value", "currency", "scope", "period_days"],
    `hard_rules[${index}]`,
  );
  const operator = object["operator"];
  if (!["<", "<=", "=", "!=", ">", ">=", "in", "not_in"].includes(String(operator))) {
    throw new AppError(422, "invalid_policy", "Un opérateur de règle est invalide.", { index });
  }
  const ruleValue = object["value"];
  const validValue =
    (typeof ruleValue === "number" && Number.isFinite(ruleValue)) ||
    typeof ruleValue === "string" ||
    (Array.isArray(ruleValue) && ruleValue.every((item) => typeof item === "string"));
  if (!validValue) {
    throw new AppError(422, "invalid_policy", "La valeur d'une règle est invalide.", { index });
  }
  const result: HardRule = {
    field: requiredString(object["field"], `hard_rules[${index}].field`),
    operator: operator as HardRule["operator"],
    value: ruleValue as HardRule["value"],
  };
  if ("currency" in object) {
    const currency = object["currency"];
    if (currency !== null && !CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) {
      throw new AppError(422, "invalid_policy", "La devise d'une règle est invalide.", { index });
    }
    result.currency = currency as Currency | null;
  }
  if ("scope" in object) {
    const scope = object["scope"];
    if (scope !== null && scope !== "purchase" && scope !== "period") {
      throw new AppError(422, "invalid_policy", "La portée d'une règle est invalide.", { index });
    }
    result.scope = scope;
  }
  if ("period_days" in object) {
    const days = object["period_days"];
    if (days !== null && (!Number.isInteger(days) || (days as number) < 1)) {
      throw new AppError(422, "invalid_policy", "La période d'une règle est invalide.", { index });
    }
    result.period_days = days as number | null;
  }
  return result;
}

export function draftId(value: string): DraftId {
  if (!/^LOCAL_PD_[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(400, "invalid_draft_id", "L'identifiant de brouillon est invalide.");
  }
  return asId<DraftId>(value);
}

export function mandateId(value: string): MandateId {
  if (!/^LOCAL_TM_[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(400, "invalid_mandate_id", "L'identifiant de mandat est invalide.");
  }
  return asId<MandateId>(value);
}

export function authorizationId(value: string): RuntimeAuthorizationId {
  if (!/^LOCAL_AUTH_[A-Za-z0-9]+_AU[0-9]{4}$/.test(value)) {
    throw new AppError(400, "invalid_authorization_id", "L'identifiant d'achat est invalide.");
  }
  return asId<RuntimeAuthorizationId>(value);
}
