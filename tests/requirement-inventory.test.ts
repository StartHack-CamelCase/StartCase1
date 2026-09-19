import { describe, expect, it } from "vitest";
import { buildRequirementInventory } from "../packages/local-runtime/src/ai/requirement-inventory.js";
import type { InstructionVariables } from "../packages/contracts/src/index.js";
import { loadInstructionFields, validateInstructionFields } from "../packages/local-runtime/src/ai/instruction-schema.js";
import { resolve } from "node:path";

const empty: InstructionVariables = { variables: [], unmapped_requirements: [] };
const ROOT = resolve(import.meta.dirname, "..");

describe("requirement inventory A1", () => {
  it.each([
    "Buy road running shoes, size 43, from a specialist sports retailer.",
    "Purchase athletic footwear size 43 at a specialist sports shop.",
    "Only familiar merchants; returns accepted within 14 days; include delivery.",
    "Maximum 200 CHF, ask me when uncertain.",
    "Buy shoes, no extras, preserve session integrity.",
  ])("keeps every semantic clause reviewable: %s", (instruction) => {
    const inventory = buildRequirementInventory(instruction, empty);
    expect(inventory.requirements.length).toBeGreaterThan(0);
    expect(inventory.requirements.some((item) => item.status === "uncovered")).toBe(true);
  });

  it("does not let a mapped product hide omitted size or returns", () => {
    const instruction = "Buy shoes size 43 and return within 14 days.";
    const result = buildRequirementInventory(instruction, {
      variables: [{ field: "authorization.items[].item_name", status: "present", value: "shoes", operator: null, currency: null, scope: "purchase", period_days: null, source_excerpt: "shoes", note: null }],
      unmapped_requirements: [],
    });
    expect(result.requirements.some((x) => /size|return|retour|43|14/i.test(x.source_excerpt) && x.status === "uncovered")).toBe(true);
  });
});

describe("requirement validation A2", () => {
  it("keeps CHF ceiling separate from purchase currency", async () => {
    const { fields } = await loadInstructionFields(resolve(ROOT, "data/schemas/authorization_event.schema.json"));
    const variables = fields.map(({ field }) => ({ field, status: "absent" as const, value: null, operator: null, currency: null, scope: null, period_days: null, source_excerpt: null, note: null }));
    const amount = variables.find((v) => v.field === "authorization.billing_amount_chf");
    expect(amount).toBeDefined();
    Object.assign(amount!, { status: "present", value: 200, operator: "<=", currency: "CHF", scope: "purchase", source_excerpt: "200 CHF" });
    expect(validateInstructionFields({ variables, unmapped_requirements: [] }, "Maximum 200 CHF", fields)).toBeTruthy();
  });
});
