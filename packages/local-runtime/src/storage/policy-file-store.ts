import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PolicyStoreDocument } from "../../../contracts/src/policy.js";
import { AppError, errorMessage } from "../../../contracts/src/errors.js";
import { parsePolicyStoreDocument } from "./policy-validation.js";

const EMPTY_POLICY_STORE: PolicyStoreDocument = {
  schema_version: 1,
  drafts: [],
  mandates: [],
};

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "state"}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class PolicyFileStore {
  readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "policies.json");
  }

  async load(): Promise<PolicyStoreDocument> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return structuredClone(EMPTY_POLICY_STORE);
      }
      throw new AppError(500, "policy_store_read_failed", "Unable to read the policy store.", {
        path: this.path,
        cause: errorMessage(error),
      });
    }

    try {
      return parsePolicyStoreDocument(JSON.parse(contents) as unknown);
    } catch (error) {
      throw new AppError(500, "policy_store_invalid", "The persisted policy store is invalid.", {
        path: this.path,
        cause: errorMessage(error),
      });
    }
  }

  async save(document: PolicyStoreDocument): Promise<void> {
    let validated: PolicyStoreDocument;
    try {
      validated = parsePolicyStoreDocument(structuredClone(document));
    } catch (error) {
      throw new AppError(500, "policy_store_invalid", "Refusing to persist an invalid policy store.", {
        path: this.path,
        cause: errorMessage(error),
      });
    }

    const write = this.writeQueue.then(async () => {
      try {
        await atomicJsonWrite(this.path, validated);
      } catch (error) {
        throw new AppError(500, "policy_store_write_failed", "Unable to persist policies.", {
          path: this.path,
          cause: errorMessage(error),
        });
      }
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }
}

