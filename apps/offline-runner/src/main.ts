import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AppError,
  asId,
  errorMessage,
  type ScenarioId,
} from "../../../packages/contracts/src/index.js";
import { createLocalRuntime } from "../../../packages/local-runtime/src/runtime.js";

const NON_INTERPRETED_GUIDANCE =
  "Mandat de simulation CLI non interprété. Aucune règle n'a été extraite automatiquement.";
const NON_INTERPRETED_QUESTION =
  "La transcription métier de l'instruction doit encore être définie et validée.";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-data") {
    const result = await inspectInTemporaryRuntime(undefined, true);
    console.log(
      `Pack ${result.packVersion} valide: ${result.hashes} empreintes, ${result.scenarios} scénarios, ${result.events} événements canoniques.`,
    );
    return;
  }
  if (command === "inspect") {
    const scenario = option(args, "--scenario");
    if (scenario === null || !/^SCEN[0-9]{4}$/.test(scenario)) {
      throw new AppError(400, "scenario_required", "Utilisation: inspect --scenario SCEN0000");
    }
    await inspectInTemporaryRuntime([asId<ScenarioId>(scenario)], false);
    return;
  }
  if (command === "inspect-all") {
    await inspectInTemporaryRuntime(undefined, false);
    return;
  }
  throw new AppError(
    400,
    "unknown_command",
    "Commandes: validate-data, inspect --scenario SCEN0000, inspect-all",
  );
}

async function inspectInTemporaryRuntime(
  selected: ScenarioId[] | undefined,
  quiet: boolean,
): Promise<{ packVersion: string; hashes: number; scenarios: number; events: number }> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "viseca-local-inspection-"));
  try {
    const runtime = await createLocalRuntime({
      rootDir: resolve(process.cwd()),
      stateDir: join(temporaryRoot, "state"),
      outputDir: join(temporaryRoot, "output"),
    });
    const scenarioIds = selected ?? runtime.pack.scenarios.map((scenario) => scenario.scenario_id);
    let eventCount = 0;

    for (const scenarioId of scenarioIds) {
      const detail = runtime.scenarios.get(scenarioId);
      const draft = await runtime.policies.createDraft(scenarioId, {
        instruction: detail.scenario.cardholder_instruction,
        hard_rules: [],
        uncertainty_policy: "ask",
        guidance: [NON_INTERPRETED_GUIDANCE],
        open_questions: [NON_INTERPRETED_QUESTION],
      });
      const mandate = await runtime.policies.confirmDraft(draft.draft_id, "test_script");
      let view = await runtime.runs.create({
        scenario_id: scenarioId,
        mandate_id: mandate.mandate_id,
        mode: "inspection",
      });

      if (!quiet) {
        console.log(`\n${detail.scenario.scenario_id} - ${detail.scenario.scenario_name}`);
        console.log(`Instruction: ${detail.scenario.cardholder_instruction}`);
        console.log("Interprétation: Non interprété");
      }

      while (true) {
        const next = await runtime.runs.next(view.run.run_id);
        view = next.view;
        if (next.authorization === null) break;
        eventCount += 1;
        if (!quiet) {
          const authorization = next.authorization.event.authorization;
          console.log(
            `${String(authorization.replay_order).padStart(2, "0")}/${view.counts.total}  ${authorization.merchant.merchant_name}  ${authorization.amount.toFixed(2)} ${authorization.currency}  Non évalué`,
          );
          for (const item of authorization.items) {
            console.log(`       ${item.quantity} × ${item.item_name}: ${item.item_details}`);
          }
        }
      }
      if (!quiet) {
        const purchaseLabel = view.counts.emitted === 1 ? "achat parcouru" : "achats parcourus";
        const unevaluatedLabel =
          view.counts.not_evaluated === 1 ? "non évalué" : "non évalués";
        console.log(
          `Inspection terminée: ${view.counts.emitted} ${purchaseLabel}, 0 approuvés, ${view.counts.not_evaluated} ${unevaluatedLabel}.`,
        );
      }
    }

    return {
      packVersion: runtime.pack.pack_version,
      hashes: runtime.pack.manifest_hashes_verified,
      scenarios: scenarioIds.length,
      events: eventCount,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
