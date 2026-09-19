import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { AuthorizationEvent } from "../../../contracts/src/event.js";

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
export type VisecaTransport = (path: string, init?: RequestInit) => Promise<Response>;
export type VisecaEnvelope = { run_id: string; data: AuthorizationEvent };
export class VisecaHttpError extends Error {
  constructor(readonly status:number,code='') { super(`viseca_http_${status}${code?`:${code}`:''}`);this.name='VisecaHttpError'; }
  get definitivelyRejected():boolean{return this.status>=400&&this.status<500&&this.status!==408;}
}

const canonicalValidator=(()=>{const ajv=new Ajv2020({allErrors:true,strict:false});addFormats(ajv);return ajv.compile(JSON.parse(readFileSync(resolve(process.cwd(),'data/schemas/authorization_event.schema.json'),'utf8')));})();
export class VisecaClient {
  private readonly shutdown = new AbortController();
  close():void { this.shutdown.abort(); }
  private readonly validate=canonicalValidator;
  constructor(private readonly baseUrl:string,private readonly apiKey:string|undefined,private readonly transport?:VisecaTransport){}
  static validateEvent(value:unknown):void { if(!canonicalValidator(value))throw Error('viseca_invalid_event'); }
  static fromEnv(transport?: VisecaTransport): VisecaClient {
    if (process.env["VISECA_API_MODE"] === "disabled") throw new Error("viseca_remote_mode_disabled");
    return new VisecaClient(process.env["LEASH_BASE_URL"] ?? "", process.env["TEAM_API_KEY"], transport);
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    this.shutdown.signal.throwIfAborted();
    const headers = new Headers(init.headers); if (this.apiKey?.trim()) headers.set("Authorization", `Bearer ${this.apiKey.trim()}`); headers.set("Accept", "application/json");
    const request = { ...init, redirect: "error" as const, signal:AbortSignal.any([this.shutdown.signal,init.signal??AbortSignal.timeout(30000)]), headers };
    if (this.transport) return this.transport(path, request);
    if (!this.baseUrl.trim()) throw Error("viseca_base_url_missing");
    if (!this.apiKey?.trim()) throw Error("viseca_team_api_key_missing");
    let base:URL;
    try { base=new URL(this.baseUrl.trim()); } catch { throw Error("viseca_base_url_invalid"); }
    const loopback=["localhost","127.0.0.1","[::1]"].includes(base.hostname);
    if ((base.protocol!=="https:"&&!(base.protocol==="http:"&&loopback))||base.username||base.password||base.search||base.hash) throw Error("viseca_base_url_invalid");
    return fetch(`${base.href.replace(/\/$/, "")}${path}`, request);
  }
  async bootstrap(): Promise<Record<string, unknown>> { const response = await this.request("/v1/bootstrap"); return (await this.json(response)) as Record<string, unknown>; }
  async prepare(): Promise<Record<string, unknown>> { const data = await this.bootstrap(); const payload = (data?.["data"] ?? data) as Record<string, unknown>; if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("viseca_bootstrap_invalid"); for (const key of ["timeouts", "decision_timeout_ms", "default_decision_timeout_ms", "decision_timeout_seconds"]) if (key in payload) return data; throw new Error("viseca_bootstrap_missing_timeouts"); }
  static timeouts(value:Record<string,unknown>):{human_window_ms:number;decision_timeout_ms:number} {
    const data=(value['data']??value) as Record<string,unknown>;const timeout=(data['timeouts']??data) as Record<string,unknown>;
    if(!timeout||typeof timeout!=='object'||Array.isArray(timeout))throw Error('viseca_bootstrap_invalid');
    const read=(names:string[],fallback:number)=>{for(const name of names){const n=Number(timeout[name]);if(Number.isFinite(n)&&n>0)return name.endsWith('_seconds')?n*1000:n;}return fallback;};
    return {human_window_ms:read(['human_timeout_ms','human_window_ms','human_approval_timeout_ms','human_timeout_seconds','step_up_timeout_seconds'],120000),decision_timeout_ms:read(['decision_timeout_ms','default_decision_timeout_ms','decision_timeout_seconds'],8000)};
  }
  async createRun(body: Record<string, unknown>): Promise<Record<string, unknown>> { return (await this.post("/v1/scenario-runs", body)) as Record<string, unknown>; }
  async createMandate(body: Record<string, unknown>): Promise<Record<string, unknown>> { return (await this.post("/v1/mandates", body)) as Record<string, unknown>; }
  async confirmMandate(id: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return (await this.post(`/v1/mandates/${encodeURIComponent(id)}/confirm`, body)) as Record<string, unknown>; }
  async getRun(runId: string): Promise<Record<string, unknown>> { return (await this.json(await this.request(`/v1/scenario-runs/${encodeURIComponent(runId)}`))) as Record<string, unknown>; }
  async getMandate(mandateId:string):Promise<Record<string,unknown>>{return (await this.json(await this.request(`/v1/mandates/${encodeURIComponent(mandateId)}`))) as Record<string,unknown>;}
  async revoke(mandateId: string): Promise<unknown> { const response = await this.request(`/v1/mandates/${encodeURIComponent(mandateId)}`, { method: "DELETE" }); return this.json(response); }
  async poll(_runId?: string, signal?:AbortSignal): Promise<VisecaEnvelope | null> { const response = await this.request("/v1/decision-requests/next?wait=25",signal?{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])}:{}); if (response.status === 204) return null; const envelope = await this.json(response) as VisecaEnvelope & {authorization_id?:string}; if (!envelope || typeof envelope.run_id !== "string" || !envelope.run_id || !this.validate(envelope.data) || envelope.authorization_id !== undefined && envelope.authorization_id !== envelope.data.authorization.authorization_id) throw new Error("viseca_invalid_event"); return envelope; }
  async decision(id: string, decision: "approve" | "decline" | "step_up", body: Record<string, unknown> = {}, timeoutMs=5000): Promise<unknown> { const response = await this.request(`/v1/authorizations/${encodeURIComponent(id)}/decision`, { method: "POST", signal:AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs))), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, authorization_id: id, decision }) }); return this.json(response); }
  async resolve(id: string, decision: "approve" | "decline", body: Record<string, unknown>,timeoutMs=5000): Promise<unknown> { return this.json(await this.request(`/v1/authorizations/${encodeURIComponent(id)}/resolve`, { method:"POST", signal:AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs))), headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,authorization_id:id,decision}) })); }
  async reconcile(cursor?: string): Promise<{ authorizations: unknown; events: unknown }> {
    // A cursor is committed by the caller only after the entire bounded read succeeds.
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]);
    try {
      const [authorizations, events] = await Promise.all([
        this.request("/v1/authorizations", { signal }).then(response => this.json(response)),
        this.readEvents(cursor, signal)
      ]);
      liveFeedRows(authorizations);
      return { authorizations, events };
    } finally { cancel.abort(); }
  }
  private async readEvents(cursor: string | undefined, signal: AbortSignal): Promise<{ data: unknown[]; next_cursor: string }> {
    const collected: unknown[] = [], visited = new Set<string>([cursor ?? '0']);
    let current = cursor;
    for (let page = 0; page < 100; page++) {
      const query = current === undefined ? '' : `?since=${encodeURIComponent(current)}`;
      const value = await this.json(await this.request(`/v1/events${query}`, { signal }));
      const envelope = eventPage(value);
      if (collected.length + envelope.rows.length > 10000) throw Error('live_event_pagination_limit');
      collected.push(...envelope.rows);
      const next = envelope.next;
      // A stable cursor marks the end of the feed, including overlapping boundary rows.
      if (next === undefined || next === (current ?? '0')) return { data: collected, next_cursor: current ?? '0' };
      if (visited.has(next)) throw Error('live_event_cursor_cycle');
      visited.add(next); current = next;
    }
    throw Error('live_event_pagination_limit');
  }
  private async post(path: string, body: unknown): Promise<unknown> { return this.json(await this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); }
  private async json(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    let body:Record<string,unknown>|null;
    try { body=await response.json() as Record<string,unknown>; } catch { if(!response.ok)throw new VisecaHttpError(response.status);throw Error('viseca_invalid_json'); }
    if (!response.ok || body?.["error"]) {
      const error=body?.["error"], code=typeof error==='object'&&error!==null?(error as Record<string,unknown>)['code']:error;
      // Only expose a bounded machine code; server messages can echo request secrets.
      const suffix=typeof code==='string'&&/^[a-z][a-z0-9_.-]{0,79}$/i.test(code)&&code!==this.apiKey?`:${code}`:'';
      if(!response.ok)throw new VisecaHttpError(response.status,suffix.slice(1));
      throw Error(`viseca_api_error${suffix}`);
    }
    return body;
  }
}

function eventPage(value:unknown):{rows:unknown[];next:string|undefined}{
  if(Array.isArray(value))return {rows:value,next:undefined};
  if(!value||typeof value!=='object')throw Error('live_feed_response_invalid');
  const outer=value as Record<string,unknown>;
  const body=outer['data']&&typeof outer['data']==='object'&&!Array.isArray(outer['data'])?outer['data'] as Record<string,unknown>:outer;
  const raw=body['next_cursor']??outer['next_cursor'];
  if(raw!==undefined&&raw!==null&&typeof raw!=='string'&&typeof raw!=='number')throw Error('live_event_cursor_invalid');
  const rows=liveFeedRows(value);
  return {rows,next:raw===undefined||raw===null?undefined:String(raw)};
}

/** Empty is a valid list, never a fallback for an unreadable ledger. */
export function liveFeedRows(value:unknown):Record<string,unknown>[] {
 if(Array.isArray(value)){
  if(value.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('live_feed_response_invalid');
  return value as Record<string,unknown>[];
 }
 if(!value||typeof value!=='object')throw Error('live_feed_response_invalid');
 const record=value as Record<string,unknown>;
 for(const key of ['data','events','authorizations'])if(Object.hasOwn(record,key))return liveFeedRows(record[key]);
 throw Error('live_feed_response_invalid');
}
