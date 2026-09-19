import { createHash } from "node:crypto";
import { AppError } from "../../../packages/contracts/src/index.js";

export type CachedHttpResponse<T> = {
  statusCode: number;
  payload: T;
};

type CacheEntry = {
  signature: string;
  response: Promise<CachedHttpResponse<unknown>>;
};

export class IdempotencyStore {
  private readonly entries = new Map<string, CacheEntry>();

  async execute<T>(
    key: string,
    request: { method: string; path: string; body: unknown },
    command: () => Promise<CachedHttpResponse<T>>,
  ): Promise<CachedHttpResponse<T>> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "L'en-tête Idempotency-Key doit contenir entre 8 et 200 caractères sûrs.",
      );
    }
    const signature = fingerprint(request);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new AppError(
          409,
          "idempotency_conflict",
          "Cette clé d'idempotence a déjà été utilisée pour une autre requête.",
        );
      }
      return (await existing.response) as CachedHttpResponse<T>;
    }

    const response = command();
    this.entries.set(key, { signature, response });
    try {
      return await response;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}

function fingerprint(request: { method: string; path: string; body: unknown }): string {
  return createHash("sha256")
    .update(request.method)
    .update("\n")
    .update(request.path)
    .update("\n")
    .update(stableJson(request.body))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
