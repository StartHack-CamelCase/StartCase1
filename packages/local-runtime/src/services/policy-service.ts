import { randomUUID } from "node:crypto";
import type { DataPack } from "../../../contracts/src/data.js";
import { AppError } from "../../../contracts/src/errors.js";
import type { DraftId, MandateId, ScenarioId } from "../../../contracts/src/ids.js";
import { asId } from "../../../contracts/src/ids.js";
import type {
  HardRule,
  MandateRecord,
  PolicyContent,
  PolicyDraft,
  PolicyStoreDocument,
  UncertaintyPolicy,
} from "../../../contracts/src/policy.js";
import { PolicyFileStore } from "../storage/policy-file-store.js";
import type { InstructionDecoding } from "../../../contracts/src/instruction-decoding.js";
import { buildRequirementInventory } from "../ai/requirement-inventory.js";
import { parseInstructionDecoding } from "../ai/instruction-schema.js";
import {
  PolicyValidationIssue,
  parseHardRules,
  parsePolicyContent,
} from "../storage/policy-validation.js";

export type PolicyServiceOptions = {
  clock?: () => Date;
  idGenerator?: () => string;
};

export type UpdateMandateInput = {
  expected_version: number;
  hard_rules?: HardRule[];
  uncertainty_policy?: UncertaintyPolicy;
  guidance?: string[];
  open_questions?: string[];
};

type ScenarioSource = Pick<DataPack, "scenariosById">;
type ConfirmationOrigin = MandateRecord["confirmation_origin"];

const UPDATE_KEYS = new Set([
  "expected_version",
  "hard_rules",
  "uncertainty_policy",
  "guidance",
  "open_questions",
]);

function validationError(error: unknown): AppError {
  if (error instanceof PolicyValidationIssue) {
    return new AppError(422, "policy_invalid", "The policy content is invalid.", {
      field: error["path"],
      message: error["message"],
    });
  }
  return new AppError(422, "policy_invalid", "The policy content is invalid.");
}

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(422, "policy_invalid", "The mandate update must be an object.");
  }
  return value as Record<string, unknown>;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AppError(422, "policy_invalid", `${field} must be an array of strings.`, {
      field,
    });
  }
  return [...value] as string[];
}

function parseUpdateInput(value: unknown): UpdateMandateInput {
  const object = plainObject(value);
  for (const key of Object.keys(object)) {
    if (!UPDATE_KEYS.has(key)) {
      throw new AppError(422, "policy_invalid", `Unknown mandate update field: ${key}.`, {
        field: key,
      });
    }
  }
  if (!Object.hasOwn(object, "expected_version")) {
    throw new AppError(422, "policy_invalid", "expected_version is required.", {
      field: "expected_version",
    });
  }
  if (
    !Number.isInteger(object["expected_version"]) ||
    (object["expected_version"] as number) < 1
  ) {
    throw new AppError(422, "policy_invalid", "expected_version must be a positive integer.", {
      field: "expected_version",
    });
  }
  if (Object.keys(object).length === 1) {
    throw new AppError(422, "policy_invalid", "The mandate update contains no changes.");
  }

  const result: UpdateMandateInput = {
    expected_version: object["expected_version"] as number,
  };
  if (Object.hasOwn(object, "hard_rules")) {
    try {
      result.hard_rules = parseHardRules(object["hard_rules"], "hard_rules");
    } catch (error) {
      throw validationError(error);
    }
  }
  if (Object.hasOwn(object, "uncertainty_policy")) {
    const policy = object["uncertainty_policy"];
    if (policy !== "ask" && policy !== "decline" && policy !== "approve") {
      throw new AppError(
        422,
        "policy_invalid",
        "uncertainty_policy must be ask, decline, or approve.",
        { field: "uncertainty_policy" },
      );
    }
    result.uncertainty_policy = policy;
  }
  if (Object.hasOwn(object, "guidance")) {
    result.guidance = parseStringArray(object["guidance"], "guidance");
  }
  if (Object.hasOwn(object, "open_questions")) {
    result.open_questions = parseStringArray(object["open_questions"], "open_questions");
  }
  return result;
}

function sameValue(left: HardRule["value"], right: HardRule["value"]): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => entry === right[index])
    );
  }
  return left === right;
}

function sameRule(left: HardRule, right: HardRule): boolean {
  const optionalKeys = ["currency", "scope", "period_days"] as const;
  return (
    left.field === right.field &&
    left.operator === right.operator &&
    sameValue(left.value, right.value) &&
    optionalKeys.every(
      (key) =>
        Object.hasOwn(left, key) === Object.hasOwn(right, key) && left[key] === right[key],
    )
  );
}

function assertRulesOnlyTighten(existing: HardRule[], candidate: HardRule[]): void {
  if (
    candidate.length < existing.length ||
    existing.some((rule, index) => !sameRule(rule, candidate[index] as HardRule))
  ) {
    throw new AppError(
      422,
      "mandate_rules_cannot_be_weakened",
      "Existing hard rules must remain unchanged and in order; only new rules may be appended.",
    );
  }
}

function assertUncertaintyOnlyTightens(
  existing: UncertaintyPolicy,
  candidate: UncertaintyPolicy,
): void {
  if (candidate === existing) {
    return;
  }
  if ((existing === "ask" || existing === "approve") && candidate === "decline") {
    return;
  }
  throw new AppError(
    422,
    "uncertainty_policy_cannot_be_weakened",
    "The uncertainty policy may only remain unchanged or become decline.",
  );
}

export class PolicyService {
  private document: PolicyStoreDocument | undefined;
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(
    private readonly store: PolicyFileStore,
    private readonly scenarios: ScenarioSource,
    options: PolicyServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  static async create(
    store: PolicyFileStore,
    scenarios: ScenarioSource,
    options: PolicyServiceOptions = {},
  ): Promise<PolicyService> {
    const service = new PolicyService(store, scenarios, options);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<this> {
    this.document = await this.store.load();
    return this;
  }

  async createDraft(scenarioIdValue: ScenarioId | string, contentValue: unknown, decoding?: InstructionDecoding, workflow?: { localCustomInstruction?: boolean; draftId?: DraftId }): Promise<PolicyDraft> {
    const scenarioId = asId<ScenarioId>(scenarioIdValue);
    const scenario = this.scenarios.scenariosById.get(scenarioId);
    if (scenario === undefined) {
      throw new AppError(404, "scenario_not_found", "The scenario does not exist.", {
        scenario_id: scenarioId,
      });
    }

    let content: PolicyContent;
    try {
      content = parsePolicyContent(contentValue);
    } catch (error) {
      throw validationError(error);
    }
    if (content.instruction !== scenario.cardholder_instruction && !workflow?.localCustomInstruction) {
      throw new AppError(
        422,
        "instruction_mismatch",
        "The draft instruction must exactly match the source scenario instruction.",
        { scenario_id: scenarioId },
      );
    }

    if (decoding !== undefined) parseInstructionDecoding(decoding, content.instruction);
    return this.mutate(async (current) => {
      const existing = workflow?.draftId && current.drafts.find(d => d.draft_id === workflow.draftId);
      if (existing) {
        if (JSON.stringify({instruction:existing.instruction,hard_rules:existing.hard_rules,uncertainty_policy:existing.uncertainty_policy,guidance:existing.guidance,open_questions:existing.open_questions}) !== JSON.stringify(content)) throw new AppError(409, 'G01_IDEMPOTENCY_CONFLICT', 'This confirmation already belongs to another policy.');
        return {document:current,result:existing,persist:false};
      }
      const timestamp = this.now();
      const draft: PolicyDraft = {
        ...structuredClone(content),
        draft_id: workflow?.draftId ?? this.newDraftId(current),
        source_scenario_id: scenarioId,
        interpretation: {
          status: decoding === undefined ? "not_started" : "partial",
          producer: decoding === undefined ? null : "model",
          version: decoding?.prompt_version ?? null,
          model_id: decoding?.model_returned ?? null,
          requirements: buildRequirementInventory(content.instruction,decoding??{variables:[],unmapped_requirements:[]}).requirements.map(r=>({requirement_id:r.id,source_excerpt:r.source_excerpt,description:r.questions.join(' ')||'Couverture à vérifier dans la configuration M/C/G.',status:'pending' as const,rule_indexes:[]})),
          ...(decoding === undefined ? {} : { instruction_decoding: structuredClone(decoding) }),
        },
        created_at: timestamp,
        updated_at: timestamp,
        compiler_version: null,
        validation_errors: [],
      };
      return {
        document: { ...current, drafts: [...current.drafts, draft] },
        result: draft,
      };
    });
  }

  getDraft(draftIdValue: DraftId | string): PolicyDraft {
    const draftId = asId<DraftId>(draftIdValue);
    const draft = this.current().drafts.find((candidate) => candidate.draft_id === draftId);
    if (draft === undefined) {
      throw new AppError(404, "draft_not_found", "The policy draft does not exist.", {
        draft_id: draftId,
      });
    }
    return structuredClone(draft);
  }

  listDrafts(): PolicyDraft[] {
    return this.current().drafts.map((draft) => structuredClone(draft));
  }

  listDraftsForScenario(scenarioIdValue: ScenarioId | string): PolicyDraft[] {
    const scenarioId = asId<ScenarioId>(scenarioIdValue);
    return this.current().drafts
      .filter((draft) => draft.source_scenario_id === scenarioId)
      .map((draft) => structuredClone(draft));
  }

  async confirmDraft(
    draftIdValue: DraftId | string,
    originValue: ConfirmationOrigin = "local_user",
  ): Promise<MandateRecord> {
    if (originValue !== "local_user" && originValue !== "test_script") {
      throw new AppError(422, "policy_invalid", "Unsupported confirmation origin.");
    }
    const draftId = asId<DraftId>(draftIdValue);
    return this.mutate(async (current) => {
      const existing = current.mandates.find((mandate) => mandate.draft_id === draftId);
      if (existing !== undefined) {
        return { document: current, result: existing, persist: false };
      }
      const draft = current.drafts.find((candidate) => candidate.draft_id === draftId);
      if (draft === undefined) {
        throw new AppError(404, "draft_not_found", "The policy draft does not exist.", {
          draft_id: draftId,
        });
      }
      const timestamp = this.now();
      const mandate: MandateRecord = {
        instruction: draft.instruction,
        hard_rules: structuredClone(draft.hard_rules),
        uncertainty_policy: draft.uncertainty_policy,
        guidance: [...draft.guidance],
        open_questions: [...draft.open_questions],
        mandate_id: this.newMandateId(current),
        draft_id: draft.draft_id,
        source_scenario_id: draft.source_scenario_id,
        interpretation: structuredClone(draft.interpretation),
        version: 1,
        status: "active",
        confirmed_at: timestamp,
        confirmation_origin: originValue,
        updated_at: timestamp,
        revoked_at: null,
        compiler_version: null,
      };
      return {
        document: { ...current, mandates: [...current.mandates, mandate] },
        result: mandate,
      };
    });
  }

  getMandate(mandateIdValue: MandateId | string): MandateRecord {
    const mandateId = asId<MandateId>(mandateIdValue);
    const mandate = this.current().mandates.find(
      (candidate) => candidate.mandate_id === mandateId,
    );
    if (mandate === undefined) {
      throw new AppError(404, "mandate_not_found", "The mandate does not exist.", {
        mandate_id: mandateId,
      });
    }
    return structuredClone(mandate);
  }

  listMandates(): MandateRecord[] {
    return this.current().mandates.map((mandate) => structuredClone(mandate));
  }

  listMandatesForScenario(scenarioIdValue: ScenarioId | string): MandateRecord[] {
    const scenarioId = asId<ScenarioId>(scenarioIdValue);
    return this.current().mandates
      .filter((mandate) => mandate.source_scenario_id === scenarioId)
      .map((mandate) => structuredClone(mandate));
  }

  async updateMandate(
    mandateIdValue: MandateId | string,
    inputValue: unknown,
  ): Promise<MandateRecord> {
    const mandateId = asId<MandateId>(mandateIdValue);
    const input = parseUpdateInput(inputValue);
    return this.mutate(async (current) => {
      const index = current.mandates.findIndex(
        (candidate) => candidate.mandate_id === mandateId,
      );
      const mandate = current.mandates[index];
      if (mandate === undefined) {
        throw new AppError(404, "mandate_not_found", "The mandate does not exist.", {
          mandate_id: mandateId,
        });
      }
      if (mandate.status !== "active") {
        throw new AppError(409, "mandate_revoked", "The mandate has been revoked.", {
          mandate_id: mandateId,
        });
      }
      if (input.expected_version !== mandate.version) {
        throw new AppError(409, "version_conflict", "The mandate version is stale.", {
          expected_version: input.expected_version,
          current_version: mandate.version,
        });
      }
      if (input.hard_rules !== undefined) {
        assertRulesOnlyTighten(mandate.hard_rules, input.hard_rules);
      }
      if (input.uncertainty_policy !== undefined) {
        assertUncertaintyOnlyTightens(mandate.uncertainty_policy, input.uncertainty_policy);
      }

      const updated: MandateRecord = {
        ...mandate,
        hard_rules:
          input.hard_rules === undefined
            ? structuredClone(mandate.hard_rules)
            : structuredClone(input.hard_rules),
        uncertainty_policy: input.uncertainty_policy ?? mandate.uncertainty_policy,
        guidance: input.guidance === undefined ? [...mandate.guidance] : [...input.guidance],
        open_questions:
          input.open_questions === undefined
            ? [...mandate.open_questions]
            : [...input.open_questions],
        version: mandate.version + 1,
        updated_at: this.now(),
      };
      const mandates = [...current.mandates];
      mandates[index] = updated;
      return { document: { ...current, mandates }, result: updated };
    });
  }

  async revokeMandate(mandateIdValue: MandateId | string): Promise<MandateRecord> {
    const mandateId = asId<MandateId>(mandateIdValue);
    return this.mutate(async (current) => {
      const index = current.mandates.findIndex(
        (candidate) => candidate.mandate_id === mandateId,
      );
      const mandate = current.mandates[index];
      if (mandate === undefined) {
        throw new AppError(404, "mandate_not_found", "The mandate does not exist.", {
          mandate_id: mandateId,
        });
      }
      if (mandate.status === "revoked") {
        return { document: current, result: mandate, persist: false };
      }
      const timestamp = this.now();
      const revoked: MandateRecord = {
        ...mandate,
        status: "revoked",
        version: mandate.version + 1,
        updated_at: timestamp,
        revoked_at: timestamp,
      };
      const mandates = [...current.mandates];
      mandates[index] = revoked;
      return { document: { ...current, mandates }, result: revoked };
    });
  }

  private current(): PolicyStoreDocument {
    if (this.document === undefined) {
      throw new AppError(
        500,
        "policy_service_not_initialized",
        "PolicyService.initialize() must be awaited before use.",
      );
    }
    return this.document;
  }

  private now(): string {
    const date = this.clock();
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
      throw new AppError(500, "clock_invalid", "The policy clock returned an invalid date.");
    }
    return date.toISOString();
  }

  private key(): string {
    const key = this.idGenerator();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) {
      throw new AppError(500, "id_generation_failed", "The generated policy key is invalid.");
    }
    return key;
  }

  private newDraftId(document: PolicyStoreDocument): DraftId {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = asId<DraftId>(`LOCAL_PD_${this.key()}`);
      if (!document.drafts.some((draft) => draft.draft_id === id)) {
        return id;
      }
    }
    throw new AppError(500, "id_generation_failed", "Unable to generate a unique draft ID.");
  }

  private newMandateId(document: PolicyStoreDocument): MandateId {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = asId<MandateId>(`LOCAL_TM_${this.key()}`);
      if (!document.mandates.some((mandate) => mandate.mandate_id === id)) {
        return id;
      }
    }
    throw new AppError(500, "id_generation_failed", "Unable to generate a unique mandate ID.");
  }

  private mutate<TResult>(
    operation: (document: PolicyStoreDocument) => Promise<{
      document: PolicyStoreDocument;
      result: TResult;
      persist?: boolean;
    }>,
  ): Promise<TResult> {
    const task = async (): Promise<TResult> => {
      const current = this.current();
      const outcome = await operation(current);
      if (outcome.persist !== false) {
        await this.store.save(outcome.document);
        this.document = outcome.document;
      }
      return structuredClone(outcome.result);
    };
    const result = this.commandQueue.then(task, task);
    this.commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
