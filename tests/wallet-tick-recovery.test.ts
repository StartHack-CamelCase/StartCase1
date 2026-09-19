import {configuredInstructionDecoder} from './helpers/configured-instruction-decoder.js';
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalRuntime } from "../packages/local-runtime/src/runtime.js";

describe("wallet tick continues after a pending proposal", () => {
  it("processes later proposals without counting pending funds as approved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wallet-tick-"));
    const runtime = await createLocalRuntime({ rootDir: resolve("."), dataDir: resolve("data"), stateDir: join(dir, "state"), outputDir: join(dir, "output"), now: () => new Date("2026-09-19T08:00:00.000Z"), instructionDecoder:configuredInstructionDecoder() });
    const scenario = runtime.pack.scenarios.find((candidate) => candidate.scenario_id === "SCEN0003")!;
    const prep = runtime.wallet.prepare({ scenario_id: scenario.scenario_id, instruction: scenario.cardholder_instruction, mode: "local" }, "tick-prep");
    while (runtime.wallet.getPreparation(prep.preparation_id).status === "processing") await new Promise((resolve) => setTimeout(resolve, 5));
    const authority = runtime.pack.authoritiesById.get(runtime.pack.attemptsByScenario.get(scenario.scenario_id)![0]!.authority_id)!;
    const result = await runtime.wallet.confirm(prep.preparation_id, runtime.wallet.getPreparation(prep.preparation_id).config!.parameters as unknown as Record<string,unknown>, { actor_id: "tick-human", role: "simulated_human", customer_id: authority.customer_id, channel: "local_ui", authenticated_by_server: true });
    for (let i = 0; i < 4; i++) runtime.wallet.tick();
    const view = runtime.wallet.getRun(result.run_id);
    expect(view.purchases).toHaveLength(4);
    expect(view.purchases[2]!.assessment?.execution_state).toBe("awaiting_user");
    expect(view.purchases[3]!.assessment?.execution_state).toBe("awaiting_user");
    expect(view.approved_chf).toBe("334.05");
    expect(view.reservations).toBe(2);
    expect(runtime.simulations.get(result.run_id).reservations.map(r=>r.amount_chf)).toEqual(["165.00","232.00"]);
    for(let i=4;i<8;i++)runtime.wallet.tick();
    const continued=runtime.wallet.getRun(result.run_id);
    expect(continued.purchases).toHaveLength(8);
    expect(continued.purchases[2]!.assessment?.execution_state).toBe('awaiting_user');
    expect(continued.purchases[7]!.assessment?.execution_state).toBe('approved');
    expect(continued.approved_chf).toBe('429.05');
    await runtime.close(); await rm(dir, { recursive: true, force: true });
  });
});
