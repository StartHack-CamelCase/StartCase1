import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AuthorizationRecord,
  MandateRecord,
  Scenario,
} from "../packages/contracts/src/index.js";
import {
  createLocalRuntime,
  type LocalRuntime,
  type LocalRuntimeOptions,
} from "../packages/local-runtime/src/runtime.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type RuntimeFixture = {
  directory: string;
  options: LocalRuntimeOptions;
  runtime: LocalRuntime;
};

async function runtimeFixture(): Promise<RuntimeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "viseca-runs-test-"));
  temporaryDirectories.push(directory);
  let keySequence = 0;
  let clockSequence = 0;
  const options: LocalRuntimeOptions = {
    rootDir: ROOT,
    dataDir: DATA_DIR,
    stateDir: join(directory, "state"),
    outputDir: join(directory, "output"),
    createKey: () => `TEST${String(++keySequence).padStart(6, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 19, 8, 0, clockSequence++)),
  };
  return { directory, options, runtime: await createLocalRuntime(options) };
}

function firstScenario(runtime: LocalRuntime): Scenario {
  const scenario = runtime.pack.scenarios[0];
  if (scenario === undefined) throw new Error("The data pack has no scenario");
  return scenario;
}

function scenarioWithMostAttempts(runtime: LocalRuntime): Scenario {
  const scenario = runtime.pack.scenarios.reduce<Scenario | undefined>((largest, candidate) =>
    largest === undefined || candidate.event_count > largest.event_count ? candidate : largest,
  undefined);
  if (scenario === undefined) throw new Error("The data pack has no scenario");
  return scenario;
}

async function createMandate(
  runtime: LocalRuntime,
  scenario: Scenario,
): Promise<MandateRecord> {
  const draft = await runtime.policies.createDraft(scenario.scenario_id, {
    instruction: scenario.cardholder_instruction,
    hard_rules: [],
    uncertainty_policy: "ask",
    guidance: [],
    open_questions: [],
  });
  return runtime.policies.confirmDraft(draft.draft_id, "test_script");
}

async function createRun(runtime: LocalRuntime, scenario: Scenario) {
  const mandate = await createMandate(runtime, scenario);
  const view = await runtime.runs.create({
    scenario_id: scenario.scenario_id,
    mandate_id: mandate.mandate_id,
    mode: "inspection",
  });
  return { mandate, view };
}

function requireAuthorization(
  authorization: AuthorizationRecord | null,
): AuthorizationRecord {
  if (authorization === null) throw new Error("Expected an emitted authorization");
  return authorization;
}

function jsonLines(contents: string): unknown[] {
  const trimmed = contents.trim();
  return trimmed.length === 0
    ? []
    : trimmed.split("\n").map((line) => JSON.parse(line) as unknown);
}

describe("RunService and RunFileStore", () => {
  it("refuses storage paths that overlap the immutable data pack, including through symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "viseca-runtime-paths-test-"));
    temporaryDirectories.push(directory);

    await expect(
      createLocalRuntime({
        dataDir: DATA_DIR,
        stateDir: DATA_DIR,
        outputDir: join(directory, "output"),
      }),
    ).rejects.toMatchObject({ code: "runtime_path_conflict" });

    const dataLink = join(directory, "data-link");
    await symlink(DATA_DIR, dataLink, "dir");
    await expect(
      createLocalRuntime({
        dataDir: DATA_DIR,
        stateDir: join(dataLink, "state"),
        outputDir: join(directory, "output"),
      }),
    ).rejects.toMatchObject({ code: "runtime_path_conflict" });
  });

  it("keeps authorization IDs stable inside a run and distinct between runs", async () => {
    const { runtime } = await runtimeFixture();
    const scenario = firstScenario(runtime);
    const mandate = await createMandate(runtime, scenario);

    const firstRun = await runtime.runs.create({
      scenario_id: scenario.scenario_id,
      mandate_id: mandate.mandate_id,
      mode: "inspection",
    });
    const firstRecord = requireAuthorization(
      (await runtime.runs.next(firstRun.run.run_id)).authorization,
    );
    const firstDetail = runtime.runs.getAuthorization(
      firstRun.run.run_id,
      firstRecord.authorization_id,
    );

    expect(firstDetail.record.authorization_id).toBe(firstRecord.authorization_id);
    expect(runtime.runs.get(firstRun.run.run_id).authorizations[0]?.authorization_id).toBe(
      firstRecord.authorization_id,
    );

    await runtime.runs.cancel(firstRun.run.run_id);
    const secondRun = await runtime.runs.create({
      scenario_id: scenario.scenario_id,
      mandate_id: mandate.mandate_id,
      mode: "inspection",
    });
    const secondRecord = requireAuthorization(
      (await runtime.runs.next(secondRun.run.run_id)).authorization,
    );

    expect(secondRun.run.run_id).not.toBe(firstRun.run.run_id);
    expect(secondRun.run.profile_id).not.toBe(firstRun.run.profile_id);
    expect(secondRecord.source_authorization_id).toBe(firstRecord.source_authorization_id);
    expect(secondRecord.authorization_id).not.toBe(firstRecord.authorization_id);
    expect(secondRecord.event.request_id).not.toBe(firstRecord.event.request_id);
  });

  it("serializes concurrent next commands without duplicates or skipped replay orders", async () => {
    const { runtime } = await runtimeFixture();
    const scenario = scenarioWithMostAttempts(runtime);
    const { view } = await createRun(runtime, scenario);

    const results = await Promise.all(
      Array.from({ length: view.counts.total }, () => runtime.runs.next(view.run.run_id)),
    );
    const records = results.map((result) => requireAuthorization(result.authorization));

    expect(records.map((record) => record.event.authorization.replay_order)).toEqual(
      Array.from({ length: view.counts.total }, (_, index) => index + 1),
    );
    expect(new Set(records.map((record) => record.authorization_id)).size).toBe(
      view.counts.total,
    );
    expect(new Set(records.map((record) => record.source_authorization_id)).size).toBe(
      view.counts.total,
    );

    const completed = runtime.runs.get(view.run.run_id);
    expect(completed.run.status).toBe("completed");
    expect(completed.counts).toMatchObject({
      emitted: view.counts.total,
      not_emitted: 0,
      approved: 0,
      declined: 0,
      not_evaluated: view.counts.total,
    });
    expect((await runtime.runs.next(view.run.run_id)).authorization).toBeNull();
  });

  it("inspects all 45 purchases across five scenarios without making decisions", async () => {
    const { runtime } = await runtimeFixture();
    const records: AuthorizationRecord[] = [];

    for (const scenario of runtime.pack.scenarios) {
      const { view } = await createRun(runtime, scenario);
      const results = await Promise.all(
        Array.from({ length: view.counts.total }, () => runtime.runs.next(view.run.run_id)),
      );
      records.push(...results.map((result) => requireAuthorization(result.authorization)));

      const completed = runtime.runs.get(view.run.run_id);
      expect(completed.run.status).toBe("completed");
      expect(completed.counts).toEqual({
        total: view.counts.total,
        emitted: view.counts.total,
        not_emitted: 0,
        approved: 0,
        declined: 0,
        pending: view.counts.total,
        not_evaluated: view.counts.total,
        cancelled: 0,
      });
      expect(completed.total_approved_chf).toBe("0.00");
      expect(completed.budgets).toEqual([]);
    }

    expect(runtime.pack.scenarios).toHaveLength(5);
    expect(records).toHaveLength(45);
    expect(new Set(records.map((record) => record.authorization_id)).size).toBe(45);
    expect(
      records.every(
        (record) =>
          record.status === "pending" &&
          record.phase === "awaiting_analysis" &&
          record.evaluation_status === "not_evaluated" &&
          record.evaluation_reason === "analysis_not_configured" &&
          record.finalized_at === null,
      ),
    ).toBe(true);
  });

  it("persists completed runs, events and traces and reloads the same inspection", async () => {
    const { directory, options, runtime } = await runtimeFixture();
    const scenario = firstScenario(runtime);
    const { mandate, view } = await createRun(runtime, scenario);

    await Promise.all(
      Array.from({ length: view.counts.total }, () => runtime.runs.next(view.run.run_id)),
    );
    const beforeReload = runtime.runs.get(view.run.run_id);
    const reloaded = await createLocalRuntime(options);

    expect(reloaded.runs.get(view.run.run_id)).toEqual(beforeReload);
    expect(reloaded.policies.getMandate(mandate.mandate_id)).toEqual(mandate);
    expect(reloaded.runs.getAuthorization(
      view.run.run_id,
      beforeReload.authorizations[0]!.authorization_id,
    ).record.evaluation_status).toBe("not_evaluated");

    const runDirectory = join(directory, "output", view.run.run_id);
    const events = jsonLines(await readFile(join(runDirectory, "events.jsonl"), "utf8"));
    const traces = jsonLines(await readFile(join(runDirectory, "trace.jsonl"), "utf8"));
    expect(events).toHaveLength(view.counts.total);
    expect(traces).toHaveLength(view.counts.total + 2);
    expect(traces.at(-1)).toMatchObject({ kind: "inspection_completed" });
  });

  it("marks an active run interrupted exactly once when the runtime restarts", async () => {
    const { directory, options, runtime } = await runtimeFixture();
    const scenario = scenarioWithMostAttempts(runtime);
    const { view } = await createRun(runtime, scenario);
    const emitted = requireAuthorization(
      (await runtime.runs.next(view.run.run_id)).authorization,
    );

    expect(runtime.runs.get(view.run.run_id).run.status).toBe("ready");
    const reloaded = await createLocalRuntime(options);
    const interrupted = reloaded.runs.get(view.run.run_id);

    expect(interrupted.run.status).toBe("interrupted");
    expect(interrupted.run.finished_at).not.toBeNull();
    expect(interrupted.authorizations[0]?.authorization_id).toBe(emitted.authorization_id);
    expect(interrupted.authorizations[0]?.evaluation_status).toBe("not_evaluated");
    await expect(reloaded.runs.next(view.run.run_id)).rejects.toMatchObject({
      statusCode: 409,
      code: "run_not_active",
    });

    const reloadedAgain = await createLocalRuntime(options);
    expect(reloadedAgain.runs.get(view.run.run_id).run.status).toBe("interrupted");
    const traces = jsonLines(
      await readFile(
        join(directory, "output", view.run.run_id, "trace.jsonl"),
        "utf8",
      ),
    );
    expect(traces.filter((trace) => (trace as { kind?: string }).kind === "run_interrupted"))
      .toHaveLength(1);
  });
});
