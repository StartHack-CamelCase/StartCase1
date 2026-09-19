import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, type DataPack, type InstructionDecoding, type InstructionDecodingView, type ScenarioId } from "../../../contracts/src/index.js";
import { INSTRUCTION_PROMPT_VERSION, INSTRUCTION_VALIDATION_VERSION, loadInstructionFields, parseInstructionDecoding, validateInstructionFields, type InstructionField } from "../ai/instruction-schema.js";
import type { InstructionDecoder } from "../ai/openai-instruction-decoder.js";
import { SerialExecutor } from "./serial-executor.js";
import { buildRequirementInventory, REQUIREMENT_INVENTORY_VERSION } from "../ai/requirement-inventory.js";

type StoredRecord = {
  key: string;
  instruction: string;
  status: Exclude<InstructionDecodingView["status"], "not_started">;
  result: InstructionDecoding | null;
  error: InstructionDecodingView["error"];
};

export class InstructionDecodingService {
  private readonly records = new Map<string, StoredRecord>();
  private readonly pending = new Map<string, Promise<InstructionDecoding>>();
  private readonly writes = new SerialExecutor();
  private fields: InstructionField[] = [];
  private sourceHash = "";

  constructor(
    private readonly pack: Pick<DataPack, "scenariosById">,
    private readonly decoder: InstructionDecoder,
    private readonly filePath: string,
  ) {}

  async initialize(schemaPath: string): Promise<void> {
    const { fields, hash } = await loadInstructionFields(schemaPath);
    this.fields = fields;
    this.sourceHash = hash;
    let content: string;
    try { content = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new AppError(500, "instruction_store_unavailable", "Unable to read stored decodings.");
    }
    let interrupted = false;
    try {
      const stored = JSON.parse(content) as { schema_version: number; records: StoredRecord[] };
      if (stored.schema_version !== 1 || !Array.isArray(stored.records)) throw new Error("Invalid store");
      for (const entry of stored.records) {
        if (typeof entry.key !== "string" || !/^[a-f0-9]{64}$/.test(entry.key) || this.records.has(entry.key) || typeof entry.instruction !== "string" || !["processing", "completed", "failed", "interrupted"].includes(entry.status)) throw new Error("Invalid record");
        if (entry.status === "completed") {
          entry.result = parseInstructionDecoding(entry.result, entry.instruction);
          const resultKey = createHash("sha256").update(JSON.stringify([entry.instruction, entry.result.model_requested, entry.result.source_schema_hash, entry.result.prompt_version,entry.result.validation_version,entry.result.requirement_inventory?.version])).digest("hex");
          // Keep old completed records as an auditable archive when prompt/schema versions change.
          if (entry.key !== resultKey || entry.result.prompt_version !== INSTRUCTION_PROMPT_VERSION || entry.result.validation_version !== INSTRUCTION_VALIDATION_VERSION) entry.error = { code: "instruction_decoding_stale", message: "Result retained for traceability; a new review is required after the version change." };
          if(entry.result.prompt_version===INSTRUCTION_PROMPT_VERSION&&entry.result.validation_version===INSTRUCTION_VALIDATION_VERSION&&entry.result.source_schema_hash===this.sourceHash){try{validateInstructionFields({variables:entry.result.variables,unmapped_requirements:entry.result.unmapped_requirements},entry.instruction,this.fields);}catch{entry.error={code:'instruction_decoding_stale',message:'Proposal invalidated by current validation; trace retained.'};}}
          if (entry.error !== null && entry.error.code !== "instruction_decoding_stale") throw new Error("Completed record has error");
        } else if (entry.result !== null) throw new Error("Incomplete record has result");
        if (entry.error !== null && (typeof entry.error?.code !== "string" || typeof entry.error?.message !== "string")) throw new Error("Invalid recorded error");
        if (entry.status === "processing") {
          entry.status = "interrupted";
          entry.error = { code: "instruction_decoding_interrupted", message: "The server stopped during decoding. No automatic retry was performed." };
          interrupted = true;
        }
        this.records.set(entry.key, entry);
      }
    } catch {
      throw new AppError(500, "instruction_store_invalid", "The stored decoding file is invalid.");
    }
    if (interrupted) await this.save();
  }

  get(scenarioId: ScenarioId): InstructionDecodingView {
    const instruction = this.instruction(scenarioId);
    const stored = this.records.get(this.key(instruction));
    return structuredClone({ configured: this.decoder.configured, model: this.decoder.model, status: stored?.status ?? "not_started", result: stored?.result ?? null, error: stored?.error ?? null });
  }

  getForInstruction(scenarioId: ScenarioId, instruction: string): InstructionDecodingView {
    this.instruction(scenarioId);
    const stored = this.records.get(this.key(instruction));
    return structuredClone({ configured: this.decoder.configured, model: this.decoder.model, status: stored?.status ?? "not_started", result: stored?.result ?? null, error: stored?.error ?? null });
  }

  async decodeText(scenarioId: ScenarioId, instruction: string, _retry = false): Promise<InstructionDecoding> {
    this.instruction(scenarioId);
    const key = this.key(instruction);
    const pending = this.pending.get(key); if (pending !== undefined) return structuredClone(await pending);
    if (!this.decoder.configured) throw new AppError(503, "instruction_decoding_unavailable", "OpenAI decoding is not configured. Configure the server before preparing permissions.");
    // A new decode action always calls the provider. Saved results are audit
    // records only; in-flight duplicates and replayed HTTP commands still coalesce.
    const current = this.records.get(key);
    if (current) {
      const archiveKey = createHash("sha256").update(`archive:${key}:${current.result?.decoding_id ?? randomUUID()}`).digest("hex");
      this.records.set(archiveKey, { ...structuredClone(current), key: archiveKey });
    }
    const attempt = this.perform(key, instruction); this.pending.set(key, attempt);
    try { return structuredClone(await attempt); } finally { this.pending.delete(key); }
  }

  getCompleted(scenarioId: ScenarioId, decodingId: string): InstructionDecoding {
    const instruction = this.instruction(scenarioId);
    const result = [...this.records.values()].find((record) => record.status === "completed" && record.instruction === instruction && record.result?.decoding_id === decodingId)?.result;
    if (result === undefined || result === null) throw new AppError(409, "instruction_decoding_mismatch", "This decoding does not match the scenario instruction.");
    if(result.prompt_version!==INSTRUCTION_PROMPT_VERSION||result.validation_version!==INSTRUCTION_VALIDATION_VERSION||result.requirement_inventory?.version!==REQUIREMENT_INVENTORY_VERSION)throw new AppError(409,'instruction_decoding_stale','This stale proposal is archived and cannot activate a new mandate.');
    validateInstructionFields({variables:result.variables,unmapped_requirements:result.unmapped_requirements},instruction,this.fields);
    return structuredClone(result);
  }

  async decode(scenarioId: ScenarioId, retry = false): Promise<InstructionDecoding> {
    return this.decodeText(scenarioId, this.instruction(scenarioId), retry);
  }

  private async perform(key: string, instruction: string): Promise<InstructionDecoding> {
    this.records.set(key, { key, instruction, status: "processing", result: null, error: null });
    // Persist the explicit action before bounded provider attempts. GET/restart never calls the provider.
    await this.save();
    const started = Date.now();
    let result: InstructionDecoding;
    try {
      const deadline = Date.now() + 120_000;
      let response!: Awaited<ReturnType<InstructionDecoder["decode"]>>;
      let variables!: ReturnType<typeof validateInstructionFields>;
      let feedback: string | undefined;
      let invalidAttempts = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await this.decoder.decode(instruction, this.fields, {
            timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())),
            ...(feedback ? { feedback } : {}),
          });
          try { variables = validateInstructionFields(response.output, instruction, this.fields); }
          catch (error) {
            const candidate = response.output as { variables?: Array<Record<string, unknown>>; unmapped_requirements?: unknown[] };
            if (!Array.isArray(candidate?.variables)) throw error;
            for (const variable of candidate.variables) {
              if (variable["currency"] !== null && variable["currency"] !== undefined && (variable["field"] === "authorization.currency" || !/amount|spend|price|cost|plafond|ceiling|limit/i.test(String(variable["field"]))) && !/(?:in|en|currency|devise)\s+(?:CHF|EUR|GBP|USD)/i.test(instruction)) {
                variable["currency"] = null;
                variable["note"] = `${typeof variable["note"] === "string" ? variable["note"] + " " : ""}Review: unsupported transaction currency claim was removed conservatively.`;
              }
            }
            variables = validateInstructionFields(response.output, instruction, this.fields);
          }
          break;
        } catch (error) {
          const safe = error instanceof AppError ? error : null;
          const invalid = safe?.code === "instruction_decoding_invalid" || safe?.code === "instruction_decoding_incomplete";
          if (invalid) invalidAttempts++;
          const retryable = safe?.details?.["retryable"] === true
            || ["instruction_decoding_timeout", "instruction_decoding_network"].includes(safe?.code ?? "")
            || (invalid && invalidAttempts < 2);
          const delay = Math.min(2000, Math.max(250 * 2 ** attempt, Number(safe?.details?.["retry_after_ms"]) || 0));
          if (!retryable || attempt === 2 || Date.now() + delay >= deadline) throw error;
          if (invalid) feedback = `The previous output failed validation: ${safe!.message} Return a corrected complete decoding of the same original instruction, with literal excerpts from the allowed enum. Do not remove or weaken any requirement.`;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      result = {
        ...variables,
        decoding_id: `LOCAL_DEC_${randomUUID()}`,
        instruction,
        schema_version: 1,
        prompt_version: INSTRUCTION_PROMPT_VERSION,
        validation_version: INSTRUCTION_VALIDATION_VERSION,
        source_schema_hash: this.sourceHash,
        model_requested: this.decoder.model,
        model_returned: response.model,
        response_id: response.response_id,
        created_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        usage: response.usage,
        requirement_inventory: buildRequirementInventory(instruction, variables),
      };
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError(502, "instruction_decoding_failed", "OpenAI decoding could not be completed. Retry decoding; no permissions were prepared.");
      this.records.set(key, { key, instruction, status: "failed", result: null, error: { code: safe.code, message: safe.message } });
      await this.save();
      throw safe;
    }
    this.records.set(key, { key, instruction, status: "completed", result, error: null });
    await this.save();
    return result;
  }

  private instruction(scenarioId: ScenarioId): string {
    const scenario = this.pack.scenariosById.get(scenarioId);
    if (scenario === undefined) throw new AppError(404, "scenario_not_found", "The requested scenario does not exist.");
    return scenario.cardholder_instruction;
  }

  private key(instruction: string): string {
    return createHash("sha256").update(JSON.stringify([instruction, this.decoder.model, this.sourceHash, INSTRUCTION_PROMPT_VERSION,INSTRUCTION_VALIDATION_VERSION,REQUIREMENT_INVENTORY_VERSION])).digest("hex");
  }

  private async save(): Promise<void> {
    return this.writes.run(async () => {
      const temporary = join(dirname(this.filePath), `.decodings.${randomUUID()}.tmp`);
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(temporary, JSON.stringify({ schema_version: 1, records: [...this.records.values()] }, null, 2), { encoding: "utf8", flag: "wx" });
        await rename(temporary, this.filePath);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new AppError(500, "instruction_store_write_failed", "The decoding could not be stored locally.");
      }
    });
  }
}
