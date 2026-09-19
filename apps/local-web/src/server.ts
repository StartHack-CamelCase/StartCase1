import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createLocalApp } from "./app.js";

export async function startServer(): Promise<void> {
  try { loadEnvFile(resolve(process.cwd(), ".env.local")); }
  catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("Could not load the server configuration.");
  }
  const app = await createLocalApp({ logger: true });
  const rawPort = process.env["PORT"] ?? "3210";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  await app.listen({ host: "127.0.0.1", port });
  app.log.info({ url: `http://127.0.0.1:${port}` }, "local inspector ready");

  const close = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

const entry = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (fileURLToPath(import.meta.url) === entry) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
