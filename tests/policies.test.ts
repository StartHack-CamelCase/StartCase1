import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../packages/contracts/src/data.js";
import type { ScenarioId } from "../packages/contracts/src/ids.js";
import { asId } from "../packages/contracts/src/ids.js";
import type { PolicyContent } from "../packages/contracts/src/policy.js";
import { PolicyService } from "../packages/local-runtime/src/services/policy-service.js";
import { PolicyFileStore } from "../packages/local-runtime/src/storage/policy-file-store.js";

const SCENARIO_ID = asId<ScenarioId>("SCEN0000");
const INSTRUCTION = "  Achète exactement une unité de café — sans reformuler.\nMerci.  ";

function scenario(): Scenario {
  return {
    scenario_id: SCENARIO_ID,
    scenario_name: "Instruction exacte",
    cardholder_instruction: INSTRUCTION,
    control_question: "Le texte est-il intact ?",
    control_theme: "provenance",
    event_count: 1,
    short_rationale: "Test",
    source: { file: "scenario_catalogue.csv", row: 2 },
  };
}

function policy(overrides: Partial<PolicyContent> = {}): PolicyContent {
  return {
    instruction: INSTRUCTION,
    hard_rules: [],
    uncertainty_policy: "ask",
    guidance: [],
    open_questions: [],
    ...overrides,
  };
}

function deterministicDependencies() {
  let id = 0;
  let tick = 0;
  return {
    idGenerator: () => `key_${++id}`,
    clock: () => new Date(Date.UTC(2026, 8, 19, 8, 0, tick++)),
  };
}

describe("PolicyService and PolicyFileStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "viseca-policies-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function service(dependencies = deterministicDependencies()): Promise<PolicyService> {
    const scenariosById = new Map([[SCENARIO_ID, scenario()]]);
    return PolicyService.create(new PolicyFileStore(directory), { scenariosById }, dependencies);
  }

  it("copies the source instruction exactly and creates a non-interpreted draft", async () => {
    const policies = await service();
    const draft = await policies.createDraft(SCENARIO_ID, policy());

    expect(draft.instruction).toBe(INSTRUCTION);
    expect(draft.hard_rules).toEqual([]);
    expect(draft.interpretation).toEqual({
      status: "not_started",
      producer: null,
      version: null,
      model_id: null,
      requirements: expect.arrayContaining([expect.objectContaining({status:"pending",source_excerpt:expect.any(String)})]),
    });
    expect(draft.compiler_version).toBeNull();
    expect(draft.validation_errors).toEqual([]);
    expect(draft.draft_id).toMatch(/^LOCAL_PD_/);

    const stored = JSON.parse(await readFile(join(directory, "policies.json"), "utf8")) as {
      drafts: Array<{ instruction: string }>;
    };
    expect(stored.drafts[0]?.instruction).toBe(INSTRUCTION);
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("strictly validates policy content, hard rules, and the source instruction", async () => {
    const policies = await service();

    await expect(
      policies.createDraft(SCENARIO_ID, { ...policy(), extra: true }),
    ).rejects.toMatchObject({ statusCode: 422, code: "policy_invalid" });
    await expect(
      policies.createDraft(
        SCENARIO_ID,
        policy({
          hard_rules: [
            {
              field: "purchase.total",
              operator: "<=",
              value: 20,
              unexpected: "not accepted",
            } as never,
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "policy_invalid" });
    await expect(
      policies.createDraft(SCENARIO_ID, policy({ instruction: INSTRUCTION.trim() })),
    ).rejects.toMatchObject({ statusCode: 422, code: "instruction_mismatch" });
    await expect(
      policies.createDraft(
        SCENARIO_ID,
        policy({
          hard_rules: [
            {
              field: "purchase.total",
              operator: "<=",
              value: [20] as never,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "policy_invalid" });
  });

  it("confirms a draft once even when confirmation is repeated concurrently", async () => {
    const policies = await service();
    const draft = await policies.createDraft(SCENARIO_ID, policy());

    const [first, second] = await Promise.all([
      policies.confirmDraft(draft.draft_id, "local_user"),
      policies.confirmDraft(draft.draft_id, "local_user"),
    ]);

    expect(second.mandate_id).toBe(first.mandate_id);
    expect(first.draft_id).toBe(draft.draft_id);
    expect(first.instruction).toBe(INSTRUCTION);
    expect(first.interpretation.status).toBe("not_started");
    expect(first.mandate_id).toMatch(/^LOCAL_TM_/);
    expect(first.mandate_id).not.toBe(draft.draft_id);
    expect(policies.listMandatesForScenario(SCENARIO_ID)).toHaveLength(1);
  });

  it("reloads drafts and mandates after a service restart", async () => {
    const dependencies = deterministicDependencies();
    const firstService = await service(dependencies);
    const draft = await firstService.createDraft(SCENARIO_ID, policy());
    const mandate = await firstService.confirmDraft(draft.draft_id, "test_script");

    const reloaded = await service(dependencies);

    expect(reloaded.getDraft(draft.draft_id)).toEqual(draft);
    expect(reloaded.getMandate(mandate.mandate_id)).toEqual(mandate);
    expect(reloaded.listDrafts()).toHaveLength(1);
    expect(reloaded.listMandates()).toHaveLength(1);
  });

  it("uses distinct IDs for separate drafts and confirmations", async () => {
    const policies = await service();
    const firstDraft = await policies.createDraft(SCENARIO_ID, policy());
    const secondDraft = await policies.createDraft(SCENARIO_ID, policy());
    const firstMandate = await policies.confirmDraft(firstDraft.draft_id);
    const secondMandate = await policies.confirmDraft(secondDraft.draft_id);

    expect(new Set([firstDraft.draft_id, secondDraft.draft_id]).size).toBe(2);
    expect(new Set([firstMandate.mandate_id, secondMandate.mandate_id]).size).toBe(2);
  });

  it("versions tightening updates and rejects stale or weakening updates", async () => {
    const policies = await service();
    const initialRule = {
      field: "purchase.total",
      operator: "<=" as const,
      value: 200,
      currency: "CHF" as const,
      scope: "purchase" as const,
    };
    const draft = await policies.createDraft(
      SCENARIO_ID,
      policy({ hard_rules: [initialRule], guidance: ["Texte informatif"] }),
    );
    const mandate = await policies.confirmDraft(draft.draft_id);
    const addedRule = {
      field: "purchase.total",
      operator: "<=" as const,
      value: 180,
      currency: "CHF" as const,
      scope: "purchase" as const,
    };

    const updated = await policies.updateMandate(mandate.mandate_id, {
      expected_version: 1,
      hard_rules: [initialRule, addedRule],
      uncertainty_policy: "decline",
      guidance: ["Restriction ajoutée manuellement"],
    });
    expect(updated.version).toBe(2);
    expect(updated.hard_rules).toEqual([initialRule, addedRule]);
    expect(updated.uncertainty_policy).toBe("decline");
    expect(updated.guidance).toEqual(["Restriction ajoutée manuellement"]);
    expect(updated.open_questions).toEqual([]);
    expect(updated.instruction).toBe(INSTRUCTION);

    await expect(
      policies.updateMandate(mandate.mandate_id, {
        expected_version: 1,
        guidance: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "version_conflict" });
    await expect(
      policies.updateMandate(mandate.mandate_id, {
        expected_version: 2,
        hard_rules: [addedRule],
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "mandate_rules_cannot_be_weakened",
    });
    await expect(
      policies.updateMandate(mandate.mandate_id, {
        expected_version: 2,
        uncertainty_policy: "ask",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "uncertainty_policy_cannot_be_weakened",
    });
  });

  it("revokes idempotently and persists the same terminal mandate", async () => {
    const dependencies = deterministicDependencies();
    const policies = await service(dependencies);
    const draft = await policies.createDraft(SCENARIO_ID, policy());
    const mandate = await policies.confirmDraft(draft.draft_id);

    const first = await policies.revokeMandate(mandate.mandate_id);
    const second = await policies.revokeMandate(mandate.mandate_id);

    expect(first.status).toBe("revoked");
    expect(first.version).toBe(2);
    expect(first.revoked_at).not.toBeNull();
    expect(second).toEqual(first);
    await expect(
      policies.updateMandate(mandate.mandate_id, {
        expected_version: 2,
        guidance: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "mandate_revoked" });

    const reloaded = await service(dependencies);
    expect(reloaded.getMandate(mandate.mandate_id)).toEqual(first);
  });

  it("refuses a malformed policies.json instead of silently dropping data", async () => {
    await writeFile(
      join(directory, "policies.json"),
      JSON.stringify({ schema_version: 1, drafts: [], mandates: [], unknown: true }),
      "utf8",
    );

    await expect(service()).rejects.toMatchObject({
      statusCode: 500,
      code: "policy_store_invalid",
    });
  });
});

