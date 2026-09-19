import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, type DataPack } from "../../contracts/src/index.js";
import { AuthorizationEventFactory, loadDataPack } from "./data/index.js";
import { PolicyService } from "./services/policy-service.js";
import { RunService, type RunServiceOptions } from "./services/run-service.js";
import { ScenarioService } from "./services/scenario-service.js";
import { PolicyFileStore } from "./storage/policy-file-store.js";
import { RunFileStore } from "./storage/run-file-store.js";
import { createOpenAIInstructionDecoder, type InstructionDecoder } from "./ai/openai-instruction-decoder.js";
import { InstructionDecodingService } from "./services/instruction-decoding-service.js";

import { SimulationService } from "./simulation/service.js";
import { OfferExtractionService } from "./services/offer-extraction-service.js";
import { createOpenAIOfferDecoder } from "./ai/offer-extraction.js";
import { WalletService } from "./services/wallet-service.js";
import type { LiveConnectionOptions } from "./services/live-configuration.js";

export type LocalRuntime = {
  pack: DataPack;
  policies: PolicyService;
  scenarios: ScenarioService;
  runs: RunService;
  instructions: InstructionDecodingService;
  simulations: SimulationService;
  offers: OfferExtractionService;
  wallet: WalletService;
  close(): Promise<void>;
};

export type LocalRuntimeOptions = RunServiceOptions & {
  rootDir?: string;
  dataDir?: string;
  stateDir?: string;
  outputDir?: string;
  instructionDecoder?: InstructionDecoder;
  liveOptions?: LiveConnectionOptions;
};

async function canonicalPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function assertSeparatedPaths(
  leftName: string,
  leftPath: string,
  rightName: string,
  rightPath: string,
): void {
  if (!containsPath(leftPath, rightPath) && !containsPath(rightPath, leftPath)) {
    return;
  }
  throw new AppError(
    500,
    "runtime_path_conflict",
    "Les données source et les stockages locaux doivent utiliser des dossiers distincts.",
    {
      [leftName]: leftPath,
      [rightName]: rightPath,
    },
  );
}

export async function createLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const dataDir = await canonicalPath(options.dataDir ?? resolve(rootDir, "data"));
  const stateDir = await canonicalPath(options.stateDir ?? resolve(rootDir, ".local-state"));
  const outputDir = await canonicalPath(options.outputDir ?? resolve(rootDir, "output"));
  assertSeparatedPaths("data_dir", dataDir, "state_dir", stateDir);
  assertSeparatedPaths("data_dir", dataDir, "output_dir", outputDir);
  assertSeparatedPaths("state_dir", stateDir, "output_dir", outputDir);
  const pack = await loadDataPack({ dataDir });
  const policyStore = new PolicyFileStore(stateDir);
  const policies = await PolicyService.create(policyStore, pack, {
    ...(options.now === undefined ? {} : { clock: options.now }),
    ...(options.createKey === undefined ? {} : { idGenerator: options.createKey }),
  });
  const eventFactory = new AuthorizationEventFactory(
    pack,
    resolve(dataDir, "schemas/authorization_event.schema.json"),
  );
  const runs = new RunService(pack, policies, new RunFileStore(outputDir), eventFactory, options);
  await runs.initialize();
  const scenarios = new ScenarioService(pack, policies);
  const instructions = new InstructionDecodingService(pack, options.instructionDecoder ?? createOpenAIInstructionDecoder(), resolve(stateDir, "instruction-decodings.json"));
  await instructions.initialize(resolve(dataDir, "schemas/authorization_event.schema.json"));
  const simulations = new SimulationService(pack, policies, eventFactory, resolve(stateDir, "simulations.sqlite"), options.now);
  const offers = new OfferExtractionService(createOpenAIOfferDecoder(), resolve(stateDir, "offer-extractions.json"));
  await offers.initialize();
  const wallet = new WalletService({pack,policies,simulations,instructions},stateDir,options.now,1800,options.liveOptions);
  await wallet.initialize();
  return { pack, policies, scenarios, runs, instructions, simulations, offers, wallet, close: async () => { await wallet.close(); await offers.close(); simulations.close(); } };
}
