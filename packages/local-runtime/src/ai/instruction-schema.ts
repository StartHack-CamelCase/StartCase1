import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Decimal } from "decimal.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { AppError, type InstructionDecoding, type InstructionVariables } from "../../../contracts/src/index.js";
import { normalizeOrderAmountBound, parseOrderAmountBounds } from "../simulation/config.js";

type Schema = Record<string, unknown>;
export type InstructionField = { field: string; schema: Schema; instruction_eligible: boolean };
export const INSTRUCTION_PROMPT_VERSION = "instruction-variables-v11";
export const INSTRUCTION_VALIDATION_VERSION = "instruction-validation-v5";

// These are assigned by the pack/runtime, not instruction constraints. In particular,
// a single requested product does not provide a source basket line number or ID.
const SOURCE_OWNED_FIELDS = new Set([
  "authorization.authorization_id", "authorization.source_authorization_id",
  "authorization.scenario_id", "authorization.replay_order", "authorization.mandate_id",
  "authorization.profile_id", "authorization.card_id", "authorization.initiator_type",
  "authorization.timestamp", "authorization.spend_in_period_before_chf",
  "authorization.recent_attempt_count_10m", "authorization.items[].line_no", "authorization.items[].item_id",
]);

const nullableText = { type: ["string", "null"] };
const variableProperties = {
  field: { type: "string" },
  status: { type: "string", enum: ["present", "absent", "ambiguous"] },
  value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }] },
  operator: { type: ["string", "null"], enum: ["<", "<=", "=", "!=", ">", ">=", "in", "not_in", null] },
  currency: { type: ["string", "null"], enum: ["CHF", "EUR", "GBP", "USD", null] },
  scope: { type: ["string", "null"], enum: ["purchase", "period", null] },
  period_days: { type: ["integer", "null"], minimum: 1 },
  source_excerpt: nullableText,
  note: nullableText,
};

export const instructionVariablesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["variables", "unmapped_requirements"],
  properties: {
    variables: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: Object.keys(variableProperties), properties: variableProperties },
    },
    unmapped_requirements: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["source_excerpt", "description", "reason"],
        properties: {
          source_excerpt: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          reason: { type: "string", enum: ["no_native_field", "ambiguous"] },
        },
      },
    },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormatsImport as unknown as (instance: Ajv2020) => void)(ajv);
const validateVariables = ajv.compile<InstructionVariables>(instructionVariablesSchema);

// The model returns a sparse list; the runtime validates and reconstructs absent fields.
export function instructionModelSchema(fields: InstructionField[], instruction: string): Schema {
 const excerpts=[...new Set([instruction,...instruction.split(/(?<=[.,;!?])\s+/).filter(part=>part.trim()!=="")])];
 return {type:"object",additionalProperties:false,required:["variables","unmapped_requirements"],properties:{
  variables:{type:"array",minItems:0,maxItems:fields.length,items:{type:"object",additionalProperties:false,required:Object.keys(variableProperties),properties:{...variableProperties,field:{type:"string",enum:fields.map(f=>f.field)},source_excerpt:{type:["string","null"],enum:[...excerpts,null]}}}},
  unmapped_requirements:{...instructionVariablesSchema.properties.unmapped_requirements,items:{...instructionVariablesSchema.properties.unmapped_requirements.items,properties:{...instructionVariablesSchema.properties.unmapped_requirements.items.properties,source_excerpt:{type:"string",enum:excerpts}}}}
 }};
}

export function parseInstructionModelOutput(value: unknown, instruction: string, fields: InstructionField[]): InstructionVariables {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const root = value as Record<string, unknown>;
    const vars = root["variables"];
    if (Array.isArray(vars)) { const allowed = new Set(fields.map(({ field }) => field)); if (vars.some(item => !item || typeof item !== "object" || !allowed.has(String((item as Record<string, unknown>)["field"])))) throw new AppError(502, "instruction_decoding_invalid", "The sparse decoding contains an unknown field."); }
    if (vars !== null && typeof vars === "object" && !Array.isArray(vars)) {
      const source = vars as Record<string, unknown>;
      const absent = { status: "absent", value: null, operator: null, currency: null, scope: null, period_days: null, source_excerpt: null, note: null };
      root["variables"] = fields.map(({ field }) => ({ field, ...(source[field] ?? absent) }));
    }
  }
  const validate = ajv.compile(instructionModelSchema(fields, instruction));
  if (!validate(value)) throw new AppError(502, "instruction_decoding_invalid", "The decoding does not match the expected field inventory.");
  const output = value as { variables: Array<InstructionVariables["variables"][number]>; unmapped_requirements: InstructionVariables["unmapped_requirements"] };
  const entries = new Map(output.variables.map(v=>[v.field,v]));
  if(entries.size!==output.variables.length)throw new AppError(502,"instruction_decoding_invalid","A decoded field appears more than once.");
  const complete=fields.map(({field})=>entries.get(field)??{field,status:"absent" as const,value:null,operator:null,currency:null,scope:null,period_days:null,source_excerpt:null,note:null});
  return validateInstructionFields({ variables: complete, unmapped_requirements: output.unmapped_requirements }, instruction, fields);
}

export function parseInstructionVariables(value: unknown, instruction: string): InstructionVariables {
  if (!validateVariables(value)) {
    throw new AppError(502, "instruction_decoding_invalid", "The decoding does not match the expected structure.");
  }
  for (const variable of value.variables) {
    if (variable.status === "absent") {
      if (Object.entries(variable).some(([key, child]) => key !== "field" && key !== "status" && child !== null)) {
        throw new AppError(502, "instruction_decoding_invalid", "An absent variable cannot have a default value.");
      }
    } else {
      assertExcerpt(variable.source_excerpt, instruction);
      if (variable.status === "present" && variable.value === null) {
        throw new AppError(502, "instruction_decoding_invalid", "A present variable must have a value.");
      }
      if (variable.status === "ambiguous" && (variable.value !== null || variable.operator !== null || variable.note === null)) {
        throw new AppError(502, "instruction_decoding_invalid", "An ambiguous variable must remain valueless and include an explanation.");
      }
    }
    if (variable.period_days !== null && variable.scope !== "period") {
      throw new AppError(502, "instruction_decoding_invalid", "A period duration requires period scope.");
    }
  }
  for (const requirement of value.unmapped_requirements) assertExcerpt(requirement.source_excerpt, instruction);
  return structuredClone(value);
}

export function parseInstructionDecoding(value: unknown, instruction?: string): InstructionDecoding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid instruction decoding");
  const object = value as Record<string, unknown>;
  const keys = ["variables", "unmapped_requirements", "decoding_id", "instruction", "schema_version", "prompt_version", "source_schema_hash", "model_requested", "model_returned", "response_id", "created_at", "duration_ms", "usage"];
  if (keys.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !keys.includes(key) && key !== "requirement_inventory" && key !== "validation_version")) throw new Error("Invalid decoding fields");
  for (const key of ["decoding_id", "instruction", "prompt_version", "source_schema_hash", "model_requested", "model_returned", "response_id", "created_at"]) {
    if (typeof object[key] !== "string" || object[key] === "") throw new Error(`Invalid decoding ${key}`);
  }
  if (object["schema_version"] !== 1 || !Number.isFinite(Date.parse(object["created_at"] as string)) || !Number.isSafeInteger(object["duration_ms"]) || (object["duration_ms"] as number) < 0) throw new Error("Invalid decoding metadata");
  if (instruction !== undefined && object["instruction"] !== instruction) throw new Error("Decoding instruction mismatch");
  const usage = object["usage"] as Record<string, unknown> | null;
  if (usage === null || typeof usage !== "object" || Object.keys(usage).length !== 3 || ["input_tokens", "output_tokens", "reasoning_tokens"].some((key) => !Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)) throw new Error("Invalid decoding usage");
  parseInstructionVariables({ variables: object["variables"], unmapped_requirements: object["unmapped_requirements"] }, object["instruction"] as string);
  return structuredClone(value) as InstructionDecoding;
}

function assertExcerpt(excerpt: string | null, instruction: string): void {
  if (excerpt === null || excerpt.trim() === "" || !instruction.includes(excerpt)) {
    throw new AppError(502, "instruction_decoding_invalid", "Decoding evidence does not match the original instruction.");
  }
}

export async function loadInstructionFields(schemaPath: string): Promise<{ fields: InstructionField[]; hash: string }> {
  const raw = await readFile(schemaPath, "utf8");
  const root = JSON.parse(raw) as Schema;
  const definitions = root["$defs"] as Record<string, Schema>;
  const properties = root["properties"] as Record<string, Schema>;
  const fields: InstructionField[] = [];
  function visit(schema: Schema, path: string): void {
    if (typeof schema["$ref"] === "string") {
      const name = schema["$ref"].split("/").at(-1) ?? "";
      visit(definitions[name]!, path);
    } else if (schema["type"] === "object") {
      for (const [key, child] of Object.entries(schema["properties"] as Record<string, Schema>)) visit(child, `${path}.${key}`);
    } else if (schema["type"] === "array") {
      visit(schema["items"] as Schema, `${path}[]`);
    } else {
      fields.push({ field: path, schema, instruction_eligible: !SOURCE_OWNED_FIELDS.has(path) });
    }
  }
  visit(properties["authorization"]!, "authorization");
  const mandate = properties["mandate"]!["properties"] as Record<string, Schema>;
  visit(mandate["uncertainty_policy"]!, "mandate.uncertainty_policy");
  const context = properties["context"]!["properties"] as Record<string, Schema>;
  visit(context["approved_spend_in_period_chf"]!, "context.approved_spend_in_period_chf");
  return { fields, hash: createHash("sha256").update(raw).digest("hex") };
}

export function validateInstructionFields(value: unknown, instruction: string, fields: InstructionField[]): InstructionVariables {
  const decoded = parseInstructionVariables(value, instruction);
  const byField = new Map(decoded.variables.map((variable) => [variable.field, variable]));
  if (byField.size !== fields.length || decoded.variables.length !== fields.length || fields.some(({ field }) => !byField.has(field))) {
    throw new AppError(502, "instruction_decoding_invalid", "Each schema field must appear exactly once.");
  }
  for (const descriptor of fields) {
    const variable = byField.get(descriptor.field)!;
    if(!descriptor.instruction_eligible&&variable.status!=='absent')throw new AppError(502,'instruction_decoding_invalid','Technical identifiers and counters cannot come from the instruction.',{field:descriptor.field});
    if (variable.value === null) continue;
    // Values describe constraints, so a zero ceiling is valid even for a positive transaction field.
    const typeSchema = Object.fromEntries(Object.entries(descriptor.schema).filter(([key]) => ["type", "enum", "const", "format", "pattern"].includes(key)));
    const validateType = ajv.compile(typeSchema);
    const values = Array.isArray(variable.value) ? variable.value : [variable.value];
    if (!values.every((entry) => validateType(entry))) {
      throw new AppError(502, "instruction_decoding_invalid", "A variable type does not match the source schema.", { field: descriptor.field });
    }
    if (variable.currency !== null && !/amount|spend|price|cost|plafond|ceiling|limit/i.test(descriptor.field)) throw new AppError(502, "instruction_decoding_invalid", "Currency can only be attached to a monetary field.", { field: descriptor.field });
    if(descriptor.field==='authorization.billing_amount_chf'&&variable.currency!==null&&variable.currency!=='CHF')throw new AppError(502,'instruction_decoding_invalid','The CHF billing constraint must remain expressed in CHF.');
    if(descriptor.field==='authorization.billing_amount_chf'&&variable.scope!=='period')assertOrderAmountComparison(variable,instruction);
    if(descriptor.field==='authorization.currency'&&!values.every(currency=>new RegExp(`(?:\\b(?:in|en)\\s+${currency}\\b|\\b${currency}\\s+(?:only|uniquement|exclusivement)\\b|\\b(?:currency|devise)\\s*(?:(?:is|est|:)\\s*)?${currency}\\b)`,'i').test(variable.source_excerpt??'')))throw new AppError(502,'instruction_decoding_invalid','A currency restriction must be explicitly requested; a CHF ceiling is insufficient.');

  }
  decoded.variables = fields.map(({ field }) => byField.get(field)!);
  return decoded;
}

/** A literal amount comparison must survive model transcription unchanged.
 * Ranges may use one canonical variable; preparation combines both source bounds.
 * Compare in cents, the same precision used by the payment permission compiler. */
function assertOrderAmountComparison(variable: InstructionVariables["variables"][number], instruction: string): void {
  if (variable.status !== "present" || typeof variable.value !== "number") return;
  const excerpt = parseOrderAmountBounds(variable.source_excerpt ?? instruction);
  const source = excerpt.min_order_chf !== null || excerpt.max_order_chf !== null ? excerpt : parseOrderAmountBounds(instruction);
  if (source.min_order_chf === null && source.max_order_chf === null) return;
  const normalized = normalizeOrderAmountBound(String(variable.value), variable.operator ?? "");
  const minimum = normalized?.min_order_chf ?? null;
  const maximum = normalized?.max_order_chf ?? null;
  const exact = source.min_order_chf !== null && source.max_order_chf !== null && new Decimal(source.min_order_chf).eq(source.max_order_chf);
  if ((minimum === null && maximum === null)
    || (exact && variable.operator !== "=")
    || (minimum !== null && (source.min_order_chf === null || !new Decimal(minimum).eq(source.min_order_chf)))
    || (maximum !== null && (source.max_order_chf === null || !new Decimal(maximum).eq(source.max_order_chf)))) {
    throw new AppError(502, "instruction_decoding_invalid", "The decoded amount comparison does not match the instruction.", { field: variable.field });
  }
}
