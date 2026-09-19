import {resolve} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {AppError,type InstructionVariables} from '../packages/contracts/src/index.js';
import {loadInstructionFields,parseInstructionModelOutput} from '../packages/local-runtime/src/ai/instruction-schema.js';
import {createOpenAIInstructionDecoder} from '../packages/local-runtime/src/ai/openai-instruction-decoder.js';
const SCHEMA=resolve('data/schemas/authorization_event.schema.json');
describe('offline decoder corrections without external calls',()=>{
  it.each([false, true])("keeps habitual-merchant requirements without inventing channel ambiguity (existing requirement: %s)", async (existing) => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const instruction = "Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly.";
    const requirement = { source_excerpt: instruction, description: "Merchant must be a shop the cardholder uses regularly.", reason: "no_native_field" };
    const raw = { variables: [{ field: "authorization.merchant.availability", status: "ambiguous", value: null, operator: null, currency: null, scope: null, period_days: null, source_excerpt: instruction, note: '"shop I use regularly" is vague and does not identify a specific merchant or channel.' }], unmapped_requirements: existing ? [requirement] : [] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resp_history", model: "gpt-5.4-mini", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(raw) }] }] }));
    const result = (await createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher).decode(instruction, fields)).output as InstructionVariables;
    expect(result.variables.find(v => v.field === "authorization.merchant.availability")).toMatchObject({ status: "absent", source_excerpt: null, note: null });
    expect(result.unmapped_requirements).toEqual([requirement]);
  });

  it("does not erase a real channel ambiguity when a habitual merchant is also mentioned", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const instruction = "Buy from the online or physical shop I use regularly, whichever channel I meant.";
    const variable = { field: "authorization.merchant.availability", status: "ambiguous", value: null, operator: null, currency: null, scope: null, period_days: null, source_excerpt: instruction, note: "The shop is used regularly, but the requested channel is unclear." };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resp_channel", model: "gpt-5.4-mini", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ variables: [variable], unmapped_requirements: [] }) }] }] }));
    const result = (await createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher).decode(instruction, fields)).output as InstructionVariables;
    expect(result.variables.find(v => v.field === "authorization.merchant.availability")).toEqual(variable);
  });

  it.each([
    ["Pay at least CHF 20 per purchase.", ">=", 20],
    ["Pay more than CHF 20 per purchase.", ">", 20],
    ["Pay exactly CHF 20 per purchase.", "=", 20],
    ["Pay at most CHF 20 per purchase.", "<=", 20],
    ["Pay less than CHF 20 per purchase.", "<", 20],
    ["Payer au moins 20 CHF par achat.", ">=", 20],
    ["Payer exactement 20 CHF par achat.", "=", 20],
  ])("preserves the source amount comparison: %s", async (instruction, operator, value) => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const output = { variables: [{ field: "authorization.billing_amount_chf", status: "present", value, operator, currency: "CHF", scope: "purchase", period_days: null, source_excerpt: instruction, note: null }], unmapped_requirements: [] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resp_bounds", model: "gpt-5.4-mini", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage: {} }));
    const result = await createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher).decode(instruction, fields);
    expect((result.output as InstructionVariables).variables.find(v => v.field === "authorization.billing_amount_chf")).toMatchObject({ value, operator });
    const prompt = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).instructions;
    expect(prompt).toContain("Never turn a floor or an exact price into a ceiling");
  });

  it("preserves both explicit range boundaries without duplicate canonical fields", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const instruction = "Spend between CHF 10 and CHF 20 per purchase.";
    const lower = { source_excerpt: instruction, description: "Purchase amount >= CHF 10", reason: "no_native_field" };
    const output = { variables: [{ field: "authorization.billing_amount_chf", status: "present", value: 20, operator: "<=", currency: "CHF", scope: "purchase", period_days: null, source_excerpt: instruction, note: null }], unmapped_requirements: [lower] };
    const parsed = parseInstructionModelOutput(output, instruction, fields);
    expect(parsed.variables.filter(v => v.status === "present")).toHaveLength(1);
    expect(parsed.unmapped_requirements).toEqual([lower]);
  });

  it.each([
    ["Pay at least CHF 20 per purchase.", "<=", 20],
    ["Pay exactly CHF 20 per purchase.", "<=", 20],
    ["Pay exactly CHF 20 per purchase.", ">=", 20],
    ["Pay less than CHF 20 per purchase.", "<=", 20],
    ["Pay more than CHF 20 per purchase.", ">=", 20],
    ["Spend between CHF 10 and CHF 20 per purchase.", "=", 20],
    ["Spend between CHF 10 and CHF 20 per purchase.", ">=", 5],
  ])("rejects a model comparison that changes the literal amount constraint: %s", async (instruction, operator, value) => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const output = { variables: [{ field: "authorization.billing_amount_chf", status: "present", value, operator, currency: "CHF", scope: "purchase", period_days: null, source_excerpt: instruction, note: null }], unmapped_requirements: [] };
    expect(() => parseInstructionModelOutput(output, instruction, fields)).toThrow(AppError);
  });

});
