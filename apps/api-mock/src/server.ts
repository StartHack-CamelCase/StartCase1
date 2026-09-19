import { resolve } from "node:path";
import { createMockApi } from "./app.js";

const port = Number(process.env["API_MOCK_PORT"] ?? "4313");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("API_MOCK_PORT must be a valid TCP port.");
const contractProfile = process.env["API_MOCK_CONTRACT_PROFILE"] ?? "documented";
if (contractProfile !== "documented" && contractProfile !== "railway") throw new Error("API_MOCK_CONTRACT_PROFILE must be documented or railway.");
const app = await createMockApi({ stateDir: resolve(process.env["API_MOCK_STATE_DIR"] ?? ".local-state/api-mock"), contractProfile });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`Local Viseca contract emulator: http://127.0.0.1:${port}\nNo external API is called. This emulates the documented contract; hosted behavior remains to be verified.\n`);
process.stdout.write(`Contract profile: ${contractProfile}\n`);
