import {
  access,
  open,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { AuthorizationEvent } from "../../../contracts/src/event.js";
import type { RunId } from "../../../contracts/src/ids.js";
import type {
  AuthorizationRecord,
  PersistedRunState,
  RunRecord,
  RunTraceEntry,
} from "../../../contracts/src/run.js";
import { AppError, errorMessage } from "../../../contracts/src/errors.js";
import { parseHardRules } from "./policy-validation.js";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
const eventValidator = (() => { const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const schema = JSON.parse(readFileSync(resolve(process.cwd(), "data/schemas/authorization_event.schema.json"), "utf8")); return ajv.compile(schema); })();

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  object: JsonObject,
  required: readonly string[],
  path: string,
): void {
  const expected = new Set(required);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) {
      throw new Error(`${path}.${key}: unknown field`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      throw new Error(`${path}.${key}: required field is missing`);
    }
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}: expected a nonempty string`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${path}: expected an integer >= ${minimum}`);
  }
  return value as number;
}

function dateTime(value: unknown, path: string): string {
  const result = text(value, path);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) {
    throw new Error(`${path}: expected a valid UTC ISO 8601 date-time`);
  }
  return result;
}

function nullableDateTime(value: unknown, path: string): string | null {
  return value === null ? null : dateTime(value, path);
}

function parseRunRecord(value: unknown, path: string): RunRecord {
  const object = objectAt(value, path);
  if (!Object.hasOwn(object, "commands")) object["commands"] = [];
  exactKeys(
    object,
    [
      "run_id",
      "run_key",
      "scenario_id",
      "mode",
      "mandate_id",
      "mandate_version",
      "mandate_snapshot",
      "fixture_authority_id",
      "customer_id",
      "card_id",
      "profile_id",
      "status",
      "next_replay_order",
      "total_attempts",
      "emitted_count",
      "started_at",
      "finished_at",
      "config",
      "pack_version",
      "engine_version",
      "facts_version",
      "commands",
    ],
    path,
  );
  if (object["mode"] !== "inspection") {
    throw new Error(`${path}.mode: only inspection is supported`);
  }
  const status = text(object["status"], `${path}.status`);
  if (!new Set(["ready", "running", "completed", "cancelled", "failed", "interrupted"]).has(status)) {
    throw new Error(`${path}.status: unsupported run status`);
  }
  if (object["engine_version"] !== null || object["facts_version"] !== null) {
    throw new Error(`${path}: analysis versions must remain null in inspection mode`);
  }
  if (!Array.isArray(object["commands"])) throw new Error(`${path}.commands: expected an array`);

  const snapshot = objectAt(object["mandate_snapshot"], `${path}.mandate_snapshot`);
  exactKeys(
    snapshot,
    [
      "mandate_id",
      "status",
      "customer_id",
      "card_id",
      "instruction",
      "hard_rules",
      "uncertainty_policy",
      "profile_id",
    ],
    `${path}.mandate_snapshot`,
  );
  const snapshotStatus = text(snapshot["status"], `${path}.mandate_snapshot.status`);
  if (!new Set(["active", "superseded", "revoked", "expired"]).has(snapshotStatus)) {
    throw new Error(`${path}.mandate_snapshot.status: unsupported status`);
  }
  const uncertainty = text(
    snapshot["uncertainty_policy"],
    `${path}.mandate_snapshot.uncertainty_policy`,
  );
  if (!new Set(["ask", "decline", "approve"]).has(uncertainty)) {
    throw new Error(`${path}.mandate_snapshot.uncertainty_policy: unsupported value`);
  }
  parseHardRules(snapshot["hard_rules"], `${path}.mandate_snapshot.hard_rules`);

  const config = objectAt(object["config"], `${path}.config`);
  exactKeys(config, ["decision_timeout_ms", "history_window_minutes"], `${path}.config`);
  integer(config["decision_timeout_ms"], `${path}.config["decision_timeout_ms"]`, 1);
  integer(config["history_window_minutes"], `${path}.config["history_window_minutes"]`, 1);

  const totalAttempts = integer(object["total_attempts"], `${path}.total_attempts`);
  const emittedCount = integer(object["emitted_count"], `${path}.emitted_count`);
  if (emittedCount > totalAttempts) {
    throw new Error(`${path}.emitted_count: cannot exceed total_attempts`);
  }

  // All nested values were checked above or when the event was originally built.
  return structuredClone(object) as unknown as RunRecord;
}

function parseAuthorizationRecord(value: unknown, path: string): AuthorizationRecord {
  const object = objectAt(value, path);
  exactKeys(
    object,
    [
      "run_id",
      "authorization_id",
      "source_authorization_id",
      "event",
      "provenance",
      "phase",
      "status",
      "evaluation_status",
      "evaluation_reason",
      "emitted_at",
      "finalized_at",
      "revision",
    ],
    path,
  );
  text(object["run_id"], `${path}.run_id`);
  const authorizationId = text(object["authorization_id"], `${path}.authorization_id`);
  const sourceAuthorizationId = text(
    object["source_authorization_id"],
    `${path}.source_authorization_id`,
  );
  if (object["phase"] !== "awaiting_analysis" && object["phase"] !== "final") {
    throw new Error(`${path}.phase: unsupported phase`);
  }
  if (object["status"] !== "pending" && object["status"] !== "cancelled") {
    throw new Error(`${path}.status: unsupported status`);
  }
  if (object["evaluation_status"] !== "not_evaluated") {
    throw new Error(`${path}.evaluation_status: expected not_evaluated`);
  }
  if (object["evaluation_reason"] !== "analysis_not_configured") {
    throw new Error(`${path}.evaluation_reason: expected analysis_not_configured`);
  }
  dateTime(object["emitted_at"], `${path}.emitted_at`);
  nullableDateTime(object["finalized_at"], `${path}.finalized_at`);
  integer(object["revision"], `${path}.revision`, 1);
  objectAt(object["provenance"], `${path}.provenance`);
  const event = parseAuthorizationEvent(object["event"], `${path}.event`);
  if (
    event.authorization["authorization_id"] !== authorizationId ||
    event.authorization["source_authorization_id"] !== sourceAuthorizationId
  ) {
    throw new Error(`${path}.event: event IDs do not match the record`);
  }
  return structuredClone(object) as unknown as AuthorizationRecord;
}

function parseAuthorizationEvent(value: unknown, path: string): AuthorizationEvent {
  const object = objectAt(value, path);
  if (object["type"] !== "authorization.request") {
    throw new Error(`${path}.type: expected authorization.request`);
  }
  text(object["request_id"], `${path}.request_id`);
  dateTime(object["deadline_at"], `${path}.deadline_at`);
  const authorization = objectAt(object["authorization"], `${path}.authorization`);
  text(authorization["authorization_id"], `${path}.authorization.authorization_id`);
  text(
    authorization["source_authorization_id"],
    `${path}.authorization.source_authorization_id`,
  );
  const mandate = objectAt(object["mandate"], `${path}.mandate`);
  const context = objectAt(object["context"], `${path}.context`);
  const runtime = objectAt(object["runtime"], `${path}.runtime`);
  if (!eventValidator(object)) throw new Error(`${path}: canonical authorization event schema validation failed`);
  if (!Array.isArray(authorization["items"])) throw new Error(`${path}.authorization.items: required array is missing`);
  if (!Array.isArray(context["recent_authorizations"])) throw new Error(`${path}.context.recent_authorizations: required array is missing`);
  text(runtime["received_at"], `${path}.runtime.received_at`);
  text(mandate["mandate_id"], `${path}.mandate.mandate_id`);
  return structuredClone(object) as unknown as AuthorizationEvent;
}

function parsePersistedRunState(value: unknown, path = "run_state"): PersistedRunState {
  const object = objectAt(value, path);
  exactKeys(object, ["schema_version", "run", "records", "trace_sequence", ...(object["schema_version"] === 2 ? ["traces"] : [])], path);
  if (object["schema_version"] !== 1 && object["schema_version"] !== 2) {
    throw new Error(`${path}.schema_version: expected 1`);
  }
  const run = parseRunRecord(object["run"], `${path}.run`);
  if (!Array.isArray(object["records"])) {
    throw new Error(`${path}.records: expected an array`);
  }
  const records = object["records"].map((record, index) =>
    parseAuthorizationRecord(record, `${path}.records[${index}]`),
  );
  const traceSequence = integer(object["trace_sequence"], `${path}.trace_sequence`);
  const ids = new Set<string>();
  for (const record of records) {
    if (record.run_id !== run.run_id) {
      throw new Error(`${path}.records: record belongs to another run`);
    }
    if (ids.has(record.authorization_id)) {
      throw new Error(`${path}.records: duplicate authorization_id`);
    }
    ids.add(record.authorization_id);
  }
  if (run.emitted_count !== records.length) {
    throw new Error(`${path}.run.emitted_count: does not match records.length`);
  }
  for (const record of records) {
    if (record.event.authorization.mandate_id !== run.mandate_id || record.event.authorization.scenario_id !== run.scenario_id) {
      throw new Error(`${path}.records: event references do not match run snapshot`);
    }
  }
  const traces = object["schema_version"] === 2 ? (object["traces"] as unknown[]).map((trace, i) => parseTrace(trace, `traces[${i}]`)) : undefined;
  if (traces && (traces.length !== traceSequence || traces.some((trace, i) => trace.sequence !== i + 1 || trace.run_id !== run.run_id))) throw new Error("Invalid canonical trace sequence");
  for (const record of records) {
    if (record.event.mandate.customer_id !== run.customer_id || record.event.authorization.card_id !== run.card_id || record.event.authorization.profile_id !== run.profile_id) throw new Error("Event identity does not match run");
    if (!Array.isArray(record.provenance.items) || record.provenance.items.length !== record.event.authorization.items.length || record.provenance.items.some((line, i) => line.line_no !== record.event.authorization.items[i]?.line_no || typeof line.catalogue_description !== "string" || !line.attempt_item?.file || !Number.isInteger(line.attempt_item.row))) throw new Error("Invalid cart provenance");
  }
  return { schema_version: object["schema_version"] as 1 | 2, run, records, trace_sequence: traceSequence, ...(traces ? { traces } : {}) };
}

function parseTrace(value: unknown, path = "trace"): RunTraceEntry {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["schema_version", "sequence", "recorded_at", "run_id", "authorization_id", "kind", "message"],
    path,
  );
  if (object["schema_version"] !== 1) {
    throw new Error(`${path}.schema_version: expected 1`);
  }
  integer(object["sequence"], `${path}.sequence`, 1);
  dateTime(object["recorded_at"], `${path}.recorded_at`);
  text(object["run_id"], `${path}.run_id`);
  if (object["authorization_id"] !== null) {
    text(object["authorization_id"], `${path}.authorization_id`);
  }
  if (
    !new Set([
      "run_started",
      "authorization_emitted",
      "inspection_completed",
      "run_cancelled",
      "run_interrupted",
    ]).has(String(object["kind"]))
  ) {
    throw new Error(`${path}.kind: unsupported trace kind`);
  }
  if (typeof object["message"] !== "string") {
    throw new Error(`${path}.message: expected a string`);
  }
  return structuredClone(object) as unknown as RunTraceEntry;
}

function safeRunId(runId: RunId | string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) {
    throw new AppError(400, "invalid_run_id", "The run ID has an invalid format.", {
      run_id: runId,
    });
  }
  return runId;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.run.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const handle = await open(temporaryPath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function atomicTextWrite(path: string, value: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.projection.${randomUUID()}.tmp`);
  try { await writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx" }); await rename(temporaryPath, path); }
  catch (error) { await unlink(temporaryPath).catch(() => undefined); throw error; }
}

export class RunFileStore {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(readonly outputDirectory: string, private readonly fault?: (point: "after_snapshot" | "after_events" | "after_traces") => void) {}

  async loadAll(): Promise<PersistedRunState[]> {
    let entries;
    try {
      entries = await readdir(this.outputDirectory, { withFileTypes: true });
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw new AppError(500, "run_store_read_failed", "Unable to list persisted runs.", {
        path: this.outputDirectory,
        cause: errorMessage(error),
      });
    }

    const states: PersistedRunState[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))) {
      const path = join(this.outputDirectory, entry.name, "run.json");
      try {
        let contents: string;
        try {
          contents = await readFile(path, "utf8");
        } catch (error) {
          // output also contains reports such as audits/. Only an absent
          // snapshot in an unrelated directory is ignorable; a real run with
          // missing or invalid storage must still stop publication.
          if (!entry.name.startsWith("LOCAL_RUN_") && error !== null &&
              typeof error === "object" && "code" in error && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }
        const parsed = JSON.parse(contents) as unknown;
        const state = parsePersistedRunState(parsed, `run(${entry.name})`);
        if (state.run.run_id !== entry.name) {
          throw new Error("directory name does not match run_id");
        }
        // The snapshot is authoritative. Rebuild any missing event projection after
        // validating the complete canonical records; this also repairs partial writes.
        if (state.schema_version === 1) {
          const traces = (await this.readProjection(join(this.outputDirectory, state.run.run_id, "trace.jsonl"))).map(t => parseTrace(t));
          if (traces.length !== state.trace_sequence || traces.some((t,i)=>t.sequence !== i+1)) throw new Error("Legacy audit needs explicit repair");
          state.traces = traces;
        }
        await this.reconcileProjections(state.run.run_id, state.records.map((record) => record.event), state.traces ?? []);
        states.push(state);
      } catch (error) {
        throw new AppError(500, "run_store_invalid", "A persisted run is invalid.", {
          path,
          cause: errorMessage(error),
        });
      }
    }

    return states.sort((left, right) =>
      left.run.started_at.localeCompare(right.run.started_at) ||
      left.run.run_id.localeCompare(right.run.run_id),
    );
  }

  async create(state: PersistedRunState, initialTrace: RunTraceEntry): Promise<void> {
    const validated = parsePersistedRunState({ ...structuredClone(state), schema_version: 2, traces: [initialTrace] });
    const trace = parseTrace(structuredClone(initialTrace));
    if (trace.run_id !== validated.run.run_id || trace.sequence !== validated.trace_sequence) {
      throw new AppError(500, "run_store_invalid", "Initial trace does not match the run state.");
    }
    const runId = safeRunId(validated.run.run_id);

    return this.enqueue(async () => {
      await mkdir(this.outputDirectory, { recursive: true });
      const finalDirectory = join(this.outputDirectory, runId);
      const temporaryDirectory = join(this.outputDirectory, `.${runId}.${randomUUID()}.tmp`);
      try {
        await mkdir(temporaryDirectory);
        await Promise.all([
          atomicJsonWrite(join(temporaryDirectory, "run.json"), validated),
          writeFile(join(temporaryDirectory, "events.jsonl"), "", "utf8"),
          writeFile(
            join(temporaryDirectory, "trace.jsonl"),
            `${JSON.stringify(trace)}\n`,
            "utf8",
          ),
        ]);
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        const code =
          error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        throw new AppError(
          code === "EEXIST" || code === "ENOTEMPTY" ? 409 : 500,
          code === "EEXIST" || code === "ENOTEMPTY"
            ? "run_already_exists"
            : "run_store_write_failed",
          code === "EEXIST" || code === "ENOTEMPTY"
            ? "The run already exists."
            : "Unable to create the persisted run.",
          { run_id: runId, cause: errorMessage(error) },
        );
      }
    });
  }

  async save(state: PersistedRunState): Promise<void> {
    const validated = parsePersistedRunState(structuredClone(state));
    const runId = safeRunId(validated.run.run_id);
    return this.enqueue(async () => {
      const path = join(this.outputDirectory, runId, "run.json");
      try {
        await access(dirname(path));
        await atomicJsonWrite(path, validated);
      } catch (error) {
        throw new AppError(500, "run_store_write_failed", "Unable to persist the run state.", {
          run_id: runId,
          cause: errorMessage(error),
        });
      }
    });
  }

  /** Persist the canonical snapshot first, then reconcile append-only projections.
   * Re-running this operation is safe: events are keyed by request_id and traces by sequence. */
  async loadRun(runId: RunId): Promise<PersistedRunState> {
    const state = (await this.loadAll()).find(state => state.run.run_id === runId);
    if (!state) throw new AppError(404, "run_not_found", "Run introuvable.");
    return state;
  }

  async commit(state: PersistedRunState, events: readonly AuthorizationEvent[] = [], traces: readonly RunTraceEntry[] = []): Promise<void> {
    return this.enqueue(async () => {
      const runId = safeRunId(state.run.run_id);
      const existing = parsePersistedRunState(JSON.parse(await readFile(join(this.outputDirectory, runId, "run.json"), "utf8")));
      const priorTraces = existing.traces ?? (await this.readProjection(join(this.outputDirectory, runId, "trace.jsonl"))).map(t => parseTrace(t));
      const allTraces = [...new Map([...priorTraces, ...traces].map(t => [t.sequence, t])).values()].sort((a,b)=>a.sequence-b.sequence);
      if (existing.run.emitted_count > state.run.emitted_count || existing.trace_sequence > state.trace_sequence) throw new AppError(409,"run_revision_conflict","Le registre a avancé ; rechargez la commande.");
      if(existing.trace_sequence===state.trace_sequence&&JSON.stringify(existing.records)!==JSON.stringify(state.records))throw new AppError(409,'run_revision_conflict','La version persistée diffère ; rejouez la commande.');
      if(state.run.commands.some(c=>existing.run.commands.some(old=>old.key===c.key&&JSON.stringify(old)!==JSON.stringify(c))))throw new AppError(409,'run_revision_conflict','Résultat idempotent déjà enregistré.');
      state.run.commands=[...new Map([...existing.run.commands,...state.run.commands].map(c=>[c.key,c])).values()];
      const validated = parsePersistedRunState({ ...structuredClone(state), schema_version: 2, traces: allTraces });
      for (const event of events) parseAuthorizationEvent(event, "event");
      await this.saveUnlocked(validated);
      this.fault?.("after_snapshot");
      await this.reconcileProjections(runId, validated.records.map(r=>r.event), allTraces);
    });
  }

  async appendEvent(runIdValue: RunId, eventValue: AuthorizationEvent): Promise<void> {
    const runId = safeRunId(runIdValue);
    const event = parseAuthorizationEvent(structuredClone(eventValue), "event");
    return this.enqueue(async () => {
      try {
        await appendFile(
          join(this.outputDirectory, runId, "events.jsonl"),
          `${JSON.stringify(event)}\n`,
          "utf8",
        );
      } catch (error) {
        throw new AppError(500, "run_store_write_failed", "Unable to append the run event.", {
          run_id: runId,
          cause: errorMessage(error),
        });
      }
    });
  }

  async appendTrace(runIdValue: RunId, traceValue: RunTraceEntry): Promise<void> {
    const runId = safeRunId(runIdValue);
    const trace = parseTrace(structuredClone(traceValue));
    if (trace.run_id !== runId) {
      throw new AppError(500, "run_store_invalid", "Trace belongs to another run.");
    }
    return this.enqueue(async () => {
      try {
        await appendFile(
          join(this.outputDirectory, runId, "trace.jsonl"),
          `${JSON.stringify(trace)}\n`,
          "utf8",
        );
      } catch (error) {
        throw new AppError(500, "run_store_write_failed", "Unable to append the run trace.", {
          run_id: runId,
          cause: errorMessage(error),
        });
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const guarded=async()=>{await mkdir(this.outputDirectory,{recursive:true});const guard=new DatabaseSync(join(this.outputDirectory,'.writer.sqlite'));let locked=false;try{guard.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer_guard (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');locked=true;return await operation();}catch(error){if((error as {code?:string}).code?.startsWith('ERR_SQLITE'))throw new AppError(409,'run_writer_busy','Une autre écriture est active ; réessayez la même commande.');throw error;}finally{if(locked)guard.exec('ROLLBACK');guard.close();}};
    const result = this.commandQueue.then(guarded, guarded);
    this.commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async saveUnlocked(validated: PersistedRunState): Promise<void> {
    const path = join(this.outputDirectory, safeRunId(validated.run.run_id), "run.json");
    await access(dirname(path));
    await atomicJsonWrite(path, validated);
  }

  private async reconcileProjections(runId: string, events: readonly AuthorizationEvent[], traces: readonly RunTraceEntry[]): Promise<void> {
    const directory = join(this.outputDirectory, runId);
    // These files are disposable projections; no orphan from them is merged into truth.
    await atomicTextWrite(join(directory, "events.jsonl"), events.map(event=>`${JSON.stringify(event)}\n`).join(""));
    this.fault?.("after_events");
    await atomicTextWrite(join(directory, "trace.jsonl"), traces.map(trace=>`${JSON.stringify(trace)}\n`).join(""));
    this.fault?.("after_traces");
  }

  private async readProjection(path: string): Promise<unknown[]> {
    try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
  }
}
