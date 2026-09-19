import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { AuthorizationEvent } from "../../../contracts/src/event.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
export type VisecaTransport = (path: string, init?: RequestInit) => Promise<Response>;
export type VisecaEnvelope = { run_id: string; data: AuthorizationEvent };

const canonicalValidator=(()=>{const ajv=new Ajv2020({allErrors:true,strict:false});addFormats(ajv);return ajv.compile(JSON.parse(readFileSync(resolve(process.cwd(),'data/schemas/authorization_event.schema.json'),'utf8')));})();
export class VisecaClient {
  private readonly shutdown = new AbortController();
  close():void { this.shutdown.abort(); }
  private readonly validate=canonicalValidator;
  constructor(private readonly baseUrl:string,private readonly apiKey:string|undefined,private readonly transport:VisecaTransport=(path,init)=>fetch(`${baseUrl}${path}`,init)){}
  static validateEvent(value:unknown):void { if(!canonicalValidator(value))throw Error('viseca_invalid_event'); }
  static fromEnv(transport?: VisecaTransport): VisecaClient {
    return new VisecaClient(process.env["LEASH_BASE_URL"] ?? "", process.env["TEAM_API_KEY"], transport);
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers); if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`); headers.set("Accept", "application/json");
    return this.transport(path, { ...init, signal:AbortSignal.any([this.shutdown.signal,init.signal??AbortSignal.timeout(30000)]), headers });
  }
  async bootstrap(): Promise<Record<string, unknown>> { const response = await this.request("/v1/bootstrap"); return (await this.json(response)) as Record<string, unknown>; }
  async prepare(): Promise<Record<string, unknown>> { const data = await this.bootstrap(); const payload = (data["data"] ?? data) as Record<string, unknown>; if (!payload || typeof payload !== "object") throw new Error("viseca_bootstrap_invalid"); for (const key of ["timeouts", "decision_timeout_ms", "default_decision_timeout_ms"]) if (key in payload) return data; throw new Error("viseca_bootstrap_missing_timeouts"); }
  static timeouts(value:Record<string,unknown>):{human_window_ms:number;decision_timeout_ms:number} {
    const data=(value['data']??value) as Record<string,unknown>;const timeout=(data['timeouts']??data) as Record<string,unknown>;
    const read=(names:string[],fallback:number)=>{for(const name of names){const n=Number(timeout[name]);if(Number.isFinite(n)&&n>0)return name.endsWith('_seconds')?n*1000:n;}return fallback;};
    return {human_window_ms:read(['human_timeout_ms','human_window_ms','human_approval_timeout_ms','human_timeout_seconds','step_up_timeout_seconds'],120000),decision_timeout_ms:read(['decision_timeout_ms','default_decision_timeout_ms','decision_timeout_seconds'],8000)};
  }
  async createRun(body: Record<string, unknown>): Promise<Record<string, unknown>> { return (await this.post("/v1/scenario-runs", body)) as Record<string, unknown>; }
  async createMandate(body: Record<string, unknown>): Promise<Record<string, unknown>> { return (await this.post("/v1/mandates", body)) as Record<string, unknown>; }
  async confirmMandate(id: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return (await this.post(`/v1/mandates/${encodeURIComponent(id)}/confirm`, body)) as Record<string, unknown>; }
  async getRun(runId: string): Promise<Record<string, unknown>> { return (await this.json(await this.request(`/v1/scenario-runs/${encodeURIComponent(runId)}`))) as Record<string, unknown>; }
  async revoke(mandateId: string): Promise<unknown> { const response = await this.request(`/v1/mandates/${encodeURIComponent(mandateId)}`, { method: "DELETE" }); return this.json(response); }
  async poll(_runId?: string): Promise<VisecaEnvelope | null> { const response = await this.request("/v1/decision-requests/next?wait=25"); if (response.status === 204) return null; const envelope = await this.json(response) as VisecaEnvelope; if (!envelope || typeof envelope.run_id !== "string" || !this.validate(envelope.data)) throw new Error("viseca_invalid_event"); return envelope; }
  async decision(id: string, decision: "approve" | "decline" | "step_up", body: Record<string, unknown> = {}, timeoutMs=5000): Promise<unknown> { const response = await this.request(`/v1/authorizations/${encodeURIComponent(id)}/decision`, { method: "POST", signal:AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs))), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, authorization_id: id, decision }) }); return this.json(response); }
  async resolve(id: string, decision: "approve" | "decline", body: Record<string, unknown>,timeoutMs=5000): Promise<unknown> { return this.json(await this.request(`/v1/authorizations/${encodeURIComponent(id)}/resolve`, { method:"POST", signal:AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs))), headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,authorization_id:id,decision}) })); }
  async reconcile(cursor?: string): Promise<{ authorizations: unknown; events: unknown }> { const query = cursor ? `?since=${encodeURIComponent(cursor)}` : ""; const [authorizations, events] = await Promise.all([this.request("/v1/authorizations").then(response=>this.json(response)), this.request(`/v1/events${query}`).then(response=>this.json(response))]); return { authorizations, events }; }
  private async post(path: string, body: unknown): Promise<unknown> { return this.json(await this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); }
  private async json(response: Response): Promise<unknown> { if (!response.ok) throw new Error(`viseca_http_${response.status}`); if (response.status === 204) return null; const body=await response.json() as Record<string,unknown>;if(body?.["error"])throw Error("viseca_api_error");return body; }
}
