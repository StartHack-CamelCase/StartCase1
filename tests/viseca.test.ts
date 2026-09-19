import { describe, expect, it } from "vitest";
import { VisecaClient } from "../packages/local-runtime/src/simulation/viseca-client.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Viseca protocol adapter", () => {
  it("treats 204 as an empty poll and does not parse a body", async () => {
    const client = new VisecaClient("http://fake", undefined, async () => response(204));
    await expect(client.poll("run-live")).resolves.toBeNull();
  });

  it("rejects an envelope whose event is not canonical", async () => {
    const client = new VisecaClient("http://fake", undefined, async () => response(200, { run_id: "r", data: { type: "authorization.request" } }));
    await expect(client.poll("r")).rejects.toThrow("viseca_invalid_event");
  });

  it("uses the live authorization id in both decision URL and body", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new VisecaClient("http://fake", undefined, async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return response(200, { accepted: true });
    });
    await client.decision("live-AU-7", "decline", { reason_codes: ["policy"] });
    expect(calls).toEqual([{ path: "/v1/authorizations/live-AU-7/decision", body: { reason_codes: ["policy"], authorization_id: "live-AU-7", decision: "decline" } }]);
  });
});
