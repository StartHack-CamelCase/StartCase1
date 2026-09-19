import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalApp } from "../apps/local-web/src/app.js";
import { AppError, asId, type InstructionDecoding, type InstructionVariables, type PolicyDraft, type Scenario, type ScenarioDetail, type ScenarioId } from "../packages/contracts/src/index.js";
import { INSTRUCTION_PROMPT_VERSION, instructionModelSchema, loadInstructionFields, parseInstructionModelOutput, validateInstructionFields, type InstructionField } from "../packages/local-runtime/src/ai/instruction-schema.js";
import { createOpenAIInstructionDecoder, type InstructionDecoder } from "../packages/local-runtime/src/ai/openai-instruction-decoder.js";
import { InstructionDecodingService } from "../packages/local-runtime/src/services/instruction-decoding-service.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "data/schemas/authorization_event.schema.json");
const SCENARIO = asId<ScenarioId>("SCEN0000");
const INSTRUCTION = "  Buy shoes in size 43. Pay CHF 20 maximum.\nAsk me when uncertain.  ";
const directories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "viseca-instruction-test-"));
  directories.push(path);
  return path;
}

function variables(fields: InstructionField[]): InstructionVariables {
  return {
    variables: fields.map(({ field }) => ({ field, status: "absent", value: null, operator: null, currency: null, scope: null, period_days: null, source_excerpt: null, note: null })),
    unmapped_requirements: [],
  };
}

function modelOutput(output: InstructionVariables) {
  return { variables: Object.fromEntries(output.variables.map(({ field, ...variable }) => [field, variable])), unmapped_requirements: output.unmapped_requirements };
}

function decoder() {
  const decode = vi.fn(async (_instruction: string, fields: InstructionField[]) => ({
    output: variables(fields), model: "gpt-5-nano-fixture", response_id: "resp_fixture",
    usage: { input_tokens: 12, output_tokens: 34, reasoning_tokens: 5 },
  }));
  return { model: "gpt-5-nano", configured: true, decode };
}

async function service(provider: InstructionDecoder, filePath: string): Promise<InstructionDecodingService> {
  const scenario: Scenario = { scenario_id: SCENARIO, scenario_name: "Test", cardholder_instruction: INSTRUCTION, control_question: "", control_theme: "", event_count: 1, short_rationale: "", source: { file: "scenario_catalogue.csv", row: 2 } };
  const result = new InstructionDecodingService({ scenariosById: new Map([[SCENARIO, scenario]]) }, provider, filePath);
  await result.initialize(SCHEMA);
  return result;
}

async function app(provider: InstructionDecoder, path: string): Promise<FastifyInstance> {
  const result = await createLocalApp({ rootDir: ROOT, stateDir: join(path, "state"), outputDir: join(path, "output"), webDir: join(ROOT, "apps/local-web/web"), instructionDecoder: provider });
  apps.push(result);
  await result.ready();
  return result;
}

function draftPayload(detail: ScenarioDetail, decodingId: string) {
  const { instruction, hard_rules, uncertainty_policy, guidance, open_questions } = detail.initial_policy;
  return { scenario_id: detail.scenario.scenario_id, instruction, hard_rules, uncertainty_policy, guidance, open_questions, instruction_decoding_id: decodingId };
}

describe("instruction decoding contracts", () => {
  it("derives exhaustive field paths from the unmodified canonical schema", async () => {
    const { fields, hash } = await loadInstructionFields(SCHEMA);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fields.map(({ field }) => field)).toEqual(expect.arrayContaining(["authorization.billing_amount_chf", "authorization.items[].quantity", "authorization.order_returnable", "mandate.uncertainty_policy", "context.approved_spend_in_period_chf"]));
    expect(fields.some(({ field }) => /size|colour|color|familiarity|return_days/.test(field))).toBe(false);
    expect(fields.find(({ field }) => field === "authorization.items[].line_no")?.instruction_eligible).toBe(false);
    const output = variables(fields);
    const amount = output.variables.find(({ field }) => field === "authorization.billing_amount_chf")!;
    Object.assign(amount, { status: "present", value: 20, operator: "<=", currency: "CHF", scope: "purchase", source_excerpt: "CHF 20" });
    output.unmapped_requirements.push({ source_excerpt: "size 43", description: "Taille demandée, sans champ dédié.", reason: "no_native_field" });
    const result = validateInstructionFields(output, INSTRUCTION, fields);
    expect(result).toEqual(output);
    expect(result.variables.filter(({ status }) => status === "absent").every(({ value, source_excerpt }) => value === null && source_excerpt === null)).toBe(true);
  });

  it("rejects missing/extra/duplicate fields, defaults, invented evidence and wrong native types", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const invalid: InstructionVariables[] = [];
    const missing = variables(fields); missing.variables.pop(); invalid.push(missing);
    const extra = variables(fields); extra.variables[0]!.field = "invented.shoe_size"; invalid.push(extra);
    const duplicate = variables(fields); duplicate.variables[0] = { ...duplicate.variables[1]! }; invalid.push(duplicate);
    const defaults = variables(fields); defaults.variables[0]!.value = "unknown"; invalid.push(defaults);
    const evidence = variables(fields); Object.assign(evidence.variables[0]!, { status: "present", value: "any", source_excerpt: "fabricated quote" }); invalid.push(evidence);
    const wrongType = variables(fields); Object.assign(wrongType.variables.find(({ field }) => field === "authorization.billing_amount_chf")!, { status: "present", value: "20", source_excerpt: "CHF 20" }); invalid.push(wrongType);
    const ambiguity = variables(fields); Object.assign(ambiguity.variables[0]!, { status: "ambiguous", value: "inferred", source_excerpt: "shoes", note: "Incertain" }); invalid.push(ambiguity);
    for (const output of invalid) expect(() => validateInstructionFields(output, INSTRUCTION, fields)).toThrow(AppError);
  });

  it("requires every canonical field in the provider schema, including absent ones", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const raw = modelOutput(variables(fields));
    expect(parseInstructionModelOutput(raw, INSTRUCTION, fields)).toEqual(variables(fields));
    delete raw.variables[fields[0]!.field];
    expect(parseInstructionModelOutput(raw, INSTRUCTION, fields).variables.find(({ field }) => field === fields[0]!.field)?.status).toBe("absent");
    expect(JSON.stringify(instructionModelSchema(fields, INSTRUCTION))).toContain(fields.at(-1)!.field);
    const paraphrased = modelOutput(variables(fields));
    paraphrased.unmapped_requirements.push({ source_excerpt: "shoe size is 43", description: "Taille", reason: "no_native_field" });
    expect(() => parseInstructionModelOutput(paraphrased, INSTRUCTION, fields)).toThrow(AppError);
    const fabricatedLine = modelOutput(variables(fields));
    Object.assign(fabricatedLine.variables["authorization.items[].line_no"]!, { status: "present", value: 1, source_excerpt: INSTRUCTION });
    expect(() => parseInstructionModelOutput(fabricatedLine, INSTRUCTION, fields)).toThrow(AppError);
  });
});

describe("single remote request adapter", () => {
  it('keeps multiline input verbatim while every schema excerpt is an exact control-free substring',async()=>{
    const {fields}=await loadInstructionFields(SCHEMA);
    const instruction='Buy a monitor\r\n27-inch IPS panel\twith warranty;\nand the price is less to 300';
    const schema=instructionModelSchema(fields,instruction);
    const literals:string[]=[];
    const visit=(value:unknown):void=>{if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;if(Array.isArray(v['enum']))literals.push(...v['enum'].filter((x):x is string=>typeof x==='string'));Object.values(v).forEach(visit);};
    visit(schema);expect(literals.every(value=>!/[\u0000-\u001f]/.test(value))).toBe(true);
    const excerpts=(((schema['properties'] as any).variables.items.properties.source_excerpt.enum) as Array<string|null>).filter((x):x is string=>x!==null);
    expect(excerpts.length).toBeGreaterThan(2);expect(excerpts.every(excerpt=>instruction.includes(excerpt))).toBe(true);
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({id:'resp_multiline',model:'gpt-5.4',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({variables:[],unmapped_requirements:[]})}]}]}));
    await createOpenAIInstructionDecoder({OPENAI_API_KEY:'secret'},fetcher).decode(instruction,fields);
    expect(JSON.parse(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).input).instruction).toBe(instruction);
  });

  it('reports schema rejection accurately and never exposes provider text or credentials',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({error:{code:'invalid_json_schema',param:'text.format.schema',message:'secret raw provider payload'}},{status:400,headers:{'x-request-id':'req_schema'}}));
    await expect(createOpenAIInstructionDecoder({OPENAI_API_KEY:'secret'},fetcher).decode('Buy a monitor',[])).rejects.toMatchObject({code:'instruction_decoding_schema',message:expect.not.stringContaining('secret'),details:{http_status:400,provider_code:'invalid_json_schema',param:'text.format.schema',request_id:'req_schema',retryable:false}});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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

  it("uses the gpt-5.4 reasoning decoder with strict sparse output", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resp_sparse", model: "gpt-5.4-mini", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ variables: {}, unmapped_requirements: [] }) }] }], usage: {} }));
    const adapter = createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher);
    await expect(adapter.decode(INSTRUCTION, fields)).resolves.toMatchObject({ output: { variables: expect.arrayContaining([expect.objectContaining({ status: "absent" })]) } });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.model).toBe("gpt-5.4"); expect(body.reasoning).toEqual({ effort: "medium" }); expect(body.max_output_tokens).toBe(10000); expect(body.store).toBe(false); expect(body.tools).toBeUndefined();
  });
  it("sends only the exact instruction and schema, with strict output and no stored conversation", async () => {
    const { fields } = await loadInstructionFields(SCHEMA);
    const output = variables(fields);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resp_test", model: "gpt-5-nano-2025-08-07", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(modelOutput(output)) }] }], usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } }));
    const adapter = createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher);
    const result = await adapter.decode(INSTRUCTION, fields);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(options!.body));
    expect(JSON.parse(body.input)).toEqual({ instruction: INSTRUCTION, fields });
    expect(body).toMatchObject({ model: "gpt-5.4", store: false, reasoning: { effort: "medium" }, text: { format: { type: "json_schema", strict: true } } });
    expect(body.tools).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-secret");
    expect(result).toMatchObject({ output, response_id: "resp_test", usage: { input_tokens: 10, output_tokens: 20, reasoning_tokens: 5 } });
  });

  it.each([
    [401, { error: { message: "private-provider-details" } }, "instruction_decoding_auth"],
    [429, { error: { message: "private-provider-details" } }, "instruction_decoding_quota"],
    [200, { status: "incomplete", output: [] }, "instruction_decoding_incomplete"],
    [200, { status: "completed", output: [{ content: [{ type: "refusal", refusal: "private-provider-details" }] }] }, "instruction_decoding_refused"],
    [200, { status: "completed", output: [{ content: [{ type: "output_text", text: "not JSON" }] }] }, "instruction_decoding_invalid"],
  ])("handles %s without retries or leaking provider data", async (status, payload, code) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
    const adapter = createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher);
    await expect(adapter.decode(INSTRUCTION, [])).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network errors and never calls OpenAI when disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("private test-secret"); });
    const adapter = createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret" }, fetcher);
    await expect(adapter.decode(INSTRUCTION, [])).rejects.toMatchObject({ code: "instruction_decoding_network", message: expect.not.stringContaining("test-secret") });
    const disabled = createOpenAIInstructionDecoder({ OPENAI_API_KEY: "test-secret", AI_ENABLED: "false" }, fetcher);
    await expect(disabled.decode(INSTRUCTION, [])).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("persistent decoding service and routes", () => {
  it('retries temporary provider failures within the same action, without reusing an old result',async()=>{
    const provider=decoder();
    provider.decode.mockRejectedValueOnce(new AppError(502,'instruction_decoding_provider','Temporarily unavailable',{retryable:true}));
    provider.decode.mockRejectedValueOnce(new AppError(502,'instruction_decoding_network','Connection interrupted'));
    const instance=await service(provider,join(await directory(),'decodings.json'));
    const first=await instance.decodeText(SCENARIO,INSTRUCTION);
    expect(provider.decode).toHaveBeenCalledTimes(3);
    const second=await instance.decodeText(SCENARIO,INSTRUCTION);
    expect(second.decoding_id).not.toBe(first.decoding_id);expect(provider.decode).toHaveBeenCalledTimes(4);
    expect(instance.getCompleted(SCENARIO,first.decoding_id)).toEqual(first);
  });

  it('regenerates an invalid output once and never treats a partial response as permissions',async()=>{
    const provider=decoder();
    provider.decode.mockImplementationOnce(async(_instruction,fields)=>({output:{variables:variables(fields).variables.slice(1),unmapped_requirements:[]},model:'fixture',response_id:'resp_invalid',usage:{input_tokens:1,output_tokens:1,reasoning_tokens:0}}));
    const instance=await service(provider,join(await directory(),'decodings.json'));
    await instance.decodeText(SCENARIO,INSTRUCTION);
    expect(provider.decode).toHaveBeenCalledTimes(2);
    expect((provider.decode.mock.calls[1] as unknown as unknown[])[2]).toMatchObject({feedback:expect.stringContaining('failed validation')});
    expect(instance.get(SCENARIO)).toMatchObject({status:'completed',error:null});
  });

  it.each(['instruction_decoding_auth','instruction_decoding_schema','instruction_decoding_quota'])('does not retry nonrecoverable %s',async code=>{
    const provider=decoder();provider.decode.mockRejectedValue(new AppError(502,code,'Configuration must be corrected',{retryable:false}));
    const instance=await service(provider,join(await directory(),'decodings.json'));
    await expect(instance.decodeText(SCENARIO,INSTRUCTION)).rejects.toMatchObject({code});
    expect(provider.decode).toHaveBeenCalledTimes(1);expect(instance.get(SCENARIO)).toMatchObject({status:'failed',result:null});
  });

  it('bounds exhausted transient retries and permits a later fresh action',async()=>{
    const provider=decoder();provider.decode.mockRejectedValue(new AppError(502,'instruction_decoding_provider','Temporarily unavailable',{retryable:true}));
    const instance=await service(provider,join(await directory(),'decodings.json'));
    await expect(instance.decodeText(SCENARIO,INSTRUCTION)).rejects.toMatchObject({code:'instruction_decoding_provider'});
    expect(provider.decode).toHaveBeenCalledTimes(3);expect(instance.get(SCENARIO)).toMatchObject({status:'failed',result:null});
  });

  it("coalesces only in-flight calls and makes a fresh call after restart while preserving archived provenance", async () => {
    const provider = decoder();
    const path = join(await directory(), "decodings.json");
    const first = await service(provider, path);
    expect(first.get(SCENARIO).status).toBe("not_started");
    const [a, b] = await Promise.all([first.decode(SCENARIO), first.decode(SCENARIO)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ instruction: INSTRUCTION, model_requested: "gpt-5-nano", response_id: "resp_fixture", prompt_version: INSTRUCTION_PROMPT_VERSION });
    expect(a.decoding_id).toMatch(/^LOCAL_DEC_/);
    const reloaded = await service(provider, path);
    expect((await reloaded.decode(SCENARIO, true)).decoding_id).not.toBe(a.decoding_id);
    expect(provider.decode).toHaveBeenCalledTimes(2);
    const changedModel = await service({ ...provider, model: "different-model", configured: false }, path);
    expect(changedModel.get(SCENARIO).result).toBeNull();
    expect(changedModel.getCompleted(SCENARIO, a.decoding_id)).toEqual(a);
    expect(() => reloaded.getCompleted(SCENARIO, "wrong-id")).toThrow(AppError);
    expect(() => reloaded.get(asId<ScenarioId>("SCEN9999"))).toThrow(AppError);
  });

  it("records failure and a new decode retries the provider after restart", async () => {
    const provider = decoder();
    provider.decode.mockRejectedValueOnce(new AppError(502, "instruction_decoding_quota", "Quota atteint."));
    const path = join(await directory(), "decodings.json");
    const first = await service(provider, path);
    await expect(first.decode(SCENARIO)).rejects.toMatchObject({ code: "instruction_decoding_quota" });
    const reloaded = await service(provider, path);
    expect(reloaded.get(SCENARIO).status).toBe("failed");
    expect(provider.decode).toHaveBeenCalledTimes(1);
    await reloaded.decode(SCENARIO);
    expect(provider.decode).toHaveBeenCalledTimes(2);
  });

  it("never saves an incomplete or invented model result as a valid decoding", async () => {
    const provider = decoder();
    provider.decode.mockImplementation(async (_instruction, fields) => {
      const output = variables(fields);
      output.variables.pop();
      return { output, model: "gpt-5-nano-fixture", response_id: "resp_invalid", usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0 } };
    });
    const path = join(await directory(), "decodings.json");
    const instance = await service(provider, path);
    await expect(instance.decode(SCENARIO)).rejects.toMatchObject({ code: "instruction_decoding_invalid" });
    expect(instance.get(SCENARIO)).toMatchObject({ status: "failed", result: null });
    const reloaded = await service(provider, path);
    expect(reloaded.get(SCENARIO).result).toBeNull();
    await expect(reloaded.decode(SCENARIO)).rejects.toMatchObject({ code: "instruction_decoding_invalid" });
    expect(provider.decode).toHaveBeenCalledTimes(4);
  });

  it("marks an interrupted attempt after restart without making another call", async () => {
    const provider = decoder();
    const path = join(await directory(), "decodings.json");
    const first = await service(provider, path);
    await first.decode(SCENARIO);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.records[0].status = "processing";
    stored.records[0].result = null;
    await writeFile(path, JSON.stringify(stored));
    const reloaded = await service(provider, path);
    expect(reloaded.get(SCENARIO)).toMatchObject({ status: "interrupted", result: null });
    expect(provider.decode).toHaveBeenCalledTimes(1);
    await reloaded.decode(SCENARIO);
    expect(provider.decode).toHaveBeenCalledTimes(2);
  });

  it("decodes via API, attaches trusted snapshots to draft/mandate, and leaves purchases unevaluated", async () => {
    const provider = decoder();
    const path = await directory();
    const application = await app(provider, path);
    const endpoint = `/api/scenarios/${SCENARIO}/decode-instruction`;
    const request = { method: "POST" as const, url: endpoint, payload: {}, headers: { "idempotency-key": "decode-1" } };
    const response = await application.inject(request);
    expect(response.statusCode).toBe(200);
    const result = response.json<InstructionDecoding>();
    const repeated = await application.inject({ ...request, headers: { "idempotency-key": "decode-2" } });
    expect(repeated.json().decoding_id).not.toBe(result.decoding_id);
    expect((await application.inject(request)).json()).toEqual(result);
    const detail = (await application.inject({ method: "GET", url: `/api/scenarios/${SCENARIO}` })).json<ScenarioDetail>();
    const draftResponse = await application.inject({ method: "POST", url: "/api/mandate-drafts", headers: { "idempotency-key": "draft-001" }, payload: draftPayload(detail, result.decoding_id) });
    expect(draftResponse.statusCode).toBe(201);
    const draft = draftResponse.json<PolicyDraft>();
    expect(draft.interpretation).toMatchObject({ status: "partial", producer: "model", instruction_decoding: result });
    expect(draft.hard_rules).toEqual([]);
    expect(draft.instruction).toBe(detail.scenario.cardholder_instruction);
    const confirmed = await application.inject({ method: "POST", url: `/api/mandate-drafts/${draft.draft_id}/confirm`, headers: { "idempotency-key": "confirm-1" }, payload: { confirmed: true } });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().interpretation.instruction_decoding).toEqual(result);
    const run = await application.inject({ method: "POST", url: "/api/runs", headers: { "idempotency-key": "run-0001" }, payload: { scenario_id: SCENARIO, mandate_id: confirmed.json().mandate_id, mode: "inspection" } });
    const next = await application.inject({ method: "POST", url: `/api/runs/${run.json().run.run_id}/next`, headers: { "idempotency-key": "next-001" }, payload: {} });
    expect(next.json().authorization.evaluation_status).toBe("not_evaluated");
    await application.close();
    const reloaded = await app(provider, path);
    const persisted = await reloaded.inject({ method: "GET", url: `/api/mandate-drafts/${draft.draft_id}` });
    expect(persisted.json()).toEqual(draft);
    expect((await reloaded.inject({ ...request, headers: { "idempotency-key": "decode-3" } })).json().decoding_id).not.toBe(result.decoding_id);
    expect(provider.decode).toHaveBeenCalledTimes(3);
    expect(provider.decode.mock.calls[0]![0]).toBe(detail.scenario.cardholder_instruction);
  });

  it("rejects unconfigured calls, unknown scenarios, invalid bodies and forged snapshot IDs", async () => {
    const provider = { ...decoder(), configured: false };
    const application = await app(provider, await directory());
    const endpoint = `/api/scenarios/${SCENARIO}/decode-instruction`;
    const request = { method: "POST" as const, url: endpoint, headers: { "idempotency-key": "disabled" }, payload: {} };
    expect((await application.inject(request)).statusCode).toBe(503);
    expect((await application.inject({ ...request, headers: {}, payload: {} })).statusCode).toBe(400);
    expect((await application.inject({ ...request, headers: { "idempotency-key": "bad-retry" }, payload: { retry: "yes" } })).statusCode).toBe(400);
    expect((await application.inject({ ...request, headers: { "idempotency-key": "extra-001" }, payload: { instruction: "override" } })).statusCode).toBe(400);
    expect((await application.inject({ ...request, url: "/api/scenarios/SCEN9999/decode-instruction" })).statusCode).toBe(404);
    const detail = (await application.inject({ method: "GET", url: `/api/scenarios/${SCENARIO}` })).json<ScenarioDetail>();
    const forged = await application.inject({ method: "POST", url: "/api/mandate-drafts", headers: { "idempotency-key": "forged-001" }, payload: draftPayload(detail, "injected") });
    expect(forged.statusCode).toBe(409);
    expect(provider.decode).not.toHaveBeenCalled();
  });
});

 it('archives old currency proposals without rewriting confirmed snapshots or reusing completed results',async()=>{const provider=decoder();const path=join(await directory(),'decodings.json');const initial=await service(provider,path);const result=await initial.decode(SCENARIO);const stored=JSON.parse(await readFile(path,'utf8'));stored.records[0].result.prompt_version='instruction-variables-v6';delete stored.records[0].result.validation_version;const v=stored.records[0].result.variables.find((v:{field:string})=>v.field==='authorization.currency');Object.assign(v,{status:'present',value:'CHF',operator:'=',currency:'CHF',scope:'purchase',source_excerpt:'CHF 20',period_days:null,note:null});await writeFile(path,JSON.stringify(stored));const reloaded=await service(provider,path);expect(()=>reloaded.getCompleted(SCENARIO,result.decoding_id)).toThrow();const refreshed=await reloaded.decode(SCENARIO,true);expect(refreshed.decoding_id).not.toBe(result.decoding_id);expect(provider.decode).toHaveBeenCalledTimes(2);const after=JSON.parse(await readFile(path,'utf8'));expect(after.records.some((r:{result?:{decoding_id:string}})=>r.result?.decoding_id===result.decoding_id)).toBe(true);});
 it('rejects a transaction currency invented from a CHF ceiling, permits explicit pay in CHF',async()=>{const {fields}=await loadInstructionFields(SCHEMA);for(const instruction of ['Maximum 200 CHF','Pay CHF 200 maximum']){const output=variables(fields);Object.assign(output.variables.find(v=>v.field==='authorization.currency')!,{status:'present',value:'CHF',operator:'=',currency:null,scope:'purchase',source_excerpt:instruction});expect(()=>validateInstructionFields(output,instruction,fields)).toThrow();}const instruction='Pay in CHF only';const output=variables(fields);Object.assign(output.variables.find(v=>v.field==='authorization.currency')!,{status:'present',value:'CHF',operator:'=',currency:null,scope:'purchase',source_excerpt:instruction});expect(()=>validateInstructionFields(output,instruction,fields)).not.toThrow();});

it('reconstructs absent fields from a sparse strict response and rejects duplicate or unknown fields',async()=>{
 const {fields}=await loadInstructionFields(SCHEMA);const instruction='Maximum CHF 50.';
 const ceiling={field:'authorization.billing_amount_chf',status:'present',value:50,operator:'<=',currency:'CHF',scope:'purchase',period_days:null,source_excerpt:instruction,note:null};
 const parsed=parseInstructionModelOutput({variables:[ceiling],unmapped_requirements:[]},instruction,fields);
 expect(parsed.variables).toHaveLength(fields.length);expect(parsed.variables.find(v=>v.field==='authorization.currency')?.status).toBe('absent');
 expect(()=>parseInstructionModelOutput({variables:[ceiling,ceiling],unmapped_requirements:[]},instruction,fields)).toThrow();
 expect(()=>parseInstructionModelOutput({variables:[{...ceiling,field:'invented'}],unmapped_requirements:[]},instruction,fields)).toThrow();
 const inspect=(v:unknown):void=>{if(!v||typeof v!=='object')return;const obj=v as Record<string,unknown>;if(obj['type']==='object'){expect(obj['additionalProperties']).toBe(false);expect(obj['required']).toEqual(Object.keys(obj['properties'] as object));}for(const child of Object.values(obj))Array.isArray(child)?child.forEach(inspect):inspect(child);};inspect(instructionModelSchema(fields,instruction));
});
it.each([[null,false],['CHF',false],[null,true],['CHF',true]] as const)('normalizes an invented currency with metadata %s and multiline input %s',async(metadata,multiline)=>{
 const {fields}=await loadInstructionFields(SCHEMA);const sourceExcerpt='Maximum CHF 50.';const instruction=multiline?`Buy a monitor.\n${sourceExcerpt}`:sourceExcerpt;
 const output={variables:[{field:'authorization.billing_amount_chf',status:'present',value:50,operator:'<=',currency:'CHF',scope:'purchase',period_days:null,source_excerpt:sourceExcerpt,note:null},{field:'authorization.currency',status:'present',value:'CHF',operator:'=',currency:metadata,scope:'purchase',period_days:null,source_excerpt:sourceExcerpt,note:null}],unmapped_requirements:[]};
 const decode=createOpenAIInstructionDecoder({OPENAI_API_KEY:'fake'},async()=>new Response(JSON.stringify({id:'response1',model:'gpt-5.4-mini',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]})));
 const result=(await decode.decode(instruction,fields)).output as InstructionVariables;expect(result.variables.find(v=>v.field==='authorization.currency')?.status).toBe('absent');expect(result.variables.find(v=>v.field==='authorization.billing_amount_chf')?.currency).toBe('CHF');expect(result.unmapped_requirements[0]?.description).toContain('Review:');expect(result.unmapped_requirements[0]?.source_excerpt).toBe(sourceExcerpt);
});
