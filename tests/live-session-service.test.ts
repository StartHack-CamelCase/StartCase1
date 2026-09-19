import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./simulation-fixture.js";
import { LiveSessionService } from "../packages/local-runtime/src/services/live-session-service.js";

const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("LiveSessionService", () => {
  it("prepares bootstrap, explicitly confirms mandate, then creates a run", async () => {
    const calls: string[] = []; const ctx = fixture(); const dir = await mkdtemp(join(tmpdir(), "live-session-"));
    const service = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport: async (path, init) => { calls.push(`${init?.method ?? "GET"} ${path}`); if (path === "/v1/bootstrap") return response({ data: { timeouts: {} } }); if (path === "/v1/mandates") return response({ data: { draft_id: "M1" } }); if (path === "/v1/mandates/M1/confirm") return response({ data: { mandate_id: "M1" } }); if (path === "/v1/scenario-runs") return response({ data: { run_id: "R1" } }); return response(null, 204); } });
    const result = await service.start({ config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }, "confirm-key");
    expect(result).toMatchObject({ mandate_id: "M1", run_id: "R1" }); expect(calls.slice(0, 4)).toEqual(["GET /v1/bootstrap", "POST /v1/mandates", "POST /v1/mandates/M1/confirm", "POST /v1/scenario-runs"]); await service.close();
  });
  it("reports configuration without exposing credentials", async () => { const ctx = fixture(); const service = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "secret", stateDir: await mkdtemp(join(tmpdir(), "live-session-")) }); expect(service.configured()).toBe(true); expect(JSON.stringify(service.list())).not.toContain("secret"); await service.close(); });
  it("does not resend a start after a lost mandate response", async () => { const ctx = fixture(); const dir = await mkdtemp(join(tmpdir(), "live-session-")); let mandates = 0; const transport = async (path: string) => { if (path === "/v1/bootstrap") return response({ data: { timeouts: {} } }); if (path === "/v1/mandates") { mandates++; throw new Error("response_lost"); } return response({ data: { mandate_id: "M1", run_id: "R1" } }); }; const first = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); await expect(first.start({ config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }, "once")).rejects.toThrow("response_lost"); await first.close(); const second = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); await expect(second.start({ config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }, "once")).rejects.toThrow("requires_reconciliation"); expect(mandates).toBe(1); await second.close(); });
  it("rejects the same key when the input fingerprint changes", async () => { const ctx = fixture(); const dir = await mkdtemp(join(tmpdir(), "live-session-")); const transport = async (path: string) => path === "/v1/bootstrap" ? response({ data: { timeouts: {} } }) : path === "/v1/mandates" ? response({ data: { draft_id: "D1" } }) : path.includes("confirm") ? response({ data: { mandate_id: "M1" } }) : response({ data: { run_id: "R1" } }); const service = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); const input = { config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }; await service.start(input, "same"); await expect(service.start({ ...input, confirmed_by: "different-human" }, "same")).rejects.toThrow("idempotency_conflict"); await service.close(); });
  it("rehydrates a completed session and does not repost the same start key", async () => { const ctx = fixture(); const dir = await mkdtemp(join(tmpdir(), "live-session-")); let posts = 0; const transport = async (path: string) => { if (path === "/v1/bootstrap") return response({ data: { timeouts: {} } }); if (path === "/v1/mandates") { posts++; return response({ data: { draft_id: "D1" } }); } if (path.includes("confirm")) return response({ data: { mandate_id: "M1" } }); if (path === "/v1/scenario-runs") { posts++; return response({ data: { run_id: "R1" } }); } if (path.includes("decision-requests")) return response(null, 204); if (path.includes("scenario-runs/R1")) return response({ data: { status: "completed" } }); return response({ data: [] }); }; const input = { config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }; const first = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); const ids = await first.start(input, "restart-key"); await new Promise((resolve) => setTimeout(resolve, 150)); await first.close(); const second = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); await second.initialize(); expect(second.get(ids.session_id).run_id).toBe("R1"); await expect(second.start(input, "restart-key")).resolves.toEqual(ids); expect(posts).toBe(2); await second.close(); });
  it("persists the bootstrap human window in the worker outbox", async () => { const ctx = fixture(); const dir = await mkdtemp(join(tmpdir(), "live-session-")); const transport = async (path: string) => path === "/v1/bootstrap" ? response({ data: { timeouts: { human_timeout_ms: 1000 } } }) : path === "/v1/mandates" ? response({ data: { draft_id: "D1" } }) : path.includes("confirm") ? response({ data: { mandate_id: "M1" } }) : path === "/v1/scenario-runs" ? response({ data: { run_id: "R1" } }) : path.includes("decision-requests") ? response(null, 204) : response({ data: { status: "completed" } }); const service = new LiveSessionService(ctx.pack, { baseUrl: "http://fake", apiKey: "test", stateDir: dir, transport }); const ids = await service.start({ config: ctx.config, scenario_id: ctx.event.authorization.scenario_id, instruction: ctx.config.instruction, hard_rules: [], confirmed_by: "human" }, "window-key"); await new Promise((resolve) => setTimeout(resolve, 50)); await service.close(); const db = new DatabaseSync(join(dir, `${ids.session_id}.sqlite`)); const body = String((db.prepare("SELECT body FROM outbox WHERE id=1").get() as Record<string, unknown>)["body"]); expect(JSON.parse(body).human_window_ms).toBe(1000); db.close(); });
});

it('polls 204 then 200, evaluates a real fixture, and persists only platform-accepted approval',async()=>{
 const ctx=fixture('AU0004');const dir=await mkdtemp(join(tmpdir(),'live-approval-'));const event=structuredClone(ctx.event);
 event.mandate.mandate_id='M1' as never;event.authorization.mandate_id='M1' as never;event.deadline_at=new Date(Date.now()+8000).toISOString();
 let polls=0;const decisions:Record<string,unknown>[]=[];let accepted=false;
 const transport=async(path:string,init?:RequestInit)=>{
  if(path==='/v1/bootstrap')return response({data:{timeouts:{}}});
  if(path==='/v1/mandates')return response({data:{draft_id:'D1'}});
  if(path==='/v1/mandates/D1/confirm')return response({data:{mandate_id:'M1'}});
  if(path==='/v1/scenario-runs'){const db=new DatabaseSync(join(dir,'live-sessions.sqlite'),{readOnly:true});const saved=JSON.parse(String(db.prepare('SELECT body FROM sessions').get()!['body']));expect(saved.stage).toBe('run_intended');const outbox=new DatabaseSync(join(dir,`${saved.session_id}.sqlite`),{readOnly:true});expect(outbox.prepare("SELECT name FROM sqlite_master WHERE name='outbox'").get()).toBeTruthy();outbox.close();db.close();return response({data:{run_id:'R1'}});}
  if(path.includes('decision-requests'))return ++polls===2?response({run_id:'R1',data:event}):response(null,204);
  if(path.endsWith('/decision')){const body=JSON.parse(String(init?.body));decisions.push(body);accepted=true;return response({data:{status:'approved',decision:body.decision}});}
  if(path==='/v1/scenario-runs/R1')return response({data:{status:accepted?'completed':'running'}});
  return response({data:[]});
 };
 const service=new LiveSessionService(ctx.pack,{baseUrl:'http://fake',apiKey:'test',stateDir:dir,transport});
 const ids=await service.start({config:ctx.config,scenario_id:event.authorization.scenario_id,instruction:ctx.config.instruction,hard_rules:[],confirmed_by:'human'},'real-engine');
 await expect.poll(()=>service.get(ids.session_id).last_poll_status).toBe(204);
 await expect.poll(()=>service.get(ids.session_id).status,{timeout:3000}).toBe('completed');
 const view=service.get(ids.session_id);expect(polls).toBeGreaterThanOrEqual(2);expect(decisions).toHaveLength(1);expect(decisions[0]?.['decision']).toBe('approve');expect(view.entries[0]?.accepted?.decision).toBe('approve');expect(view.entries[0]?.reserved).toBe(false);expect((view.entries[0]?.proposal?.snapshot as {results:unknown[]}).results).toHaveLength(50);
 await service.close();const resumed=new LiveSessionService(ctx.pack,{stateDir:dir,transport});await resumed.initialize();expect(resumed.get(ids.session_id).entries[0]?.accepted?.decision).toBe('approve');await resumed.close();
});

it('restores a lost human response immediately after restart even while the next long poll is blocked',async()=>{
 const ctx=fixture();ctx.config.parameters.always_ask=true;const dir=await mkdtemp(join(tmpdir(),'live-pending-restart-'));
 const event=structuredClone(ctx.event);event.mandate.mandate_id='M1' as never;event.authorization.mandate_id='M1' as never;event.deadline_at=new Date(Date.now()+8000).toISOString();
 let delivered=false,restarting=false,resolutions=0,starts=0,blockedPolls=0;
 const transport=async(path:string,init?:RequestInit):Promise<Response>=>{
  if(path==='/v1/bootstrap')return response({data:{timeouts:{}}});
  if(path==='/v1/mandates'){starts++;return response({data:{draft_id:'D1'}});}
  if(path==='/v1/mandates/D1/confirm')return response({data:{mandate_id:'M1'}});
  if(path==='/v1/scenario-runs')return response({data:{run_id:'R1'}});
  if(path.includes('decision-requests')){if(!delivered){delivered=true;return response({run_id:'R1',data:event});}blockedPolls++;return new Promise((_,reject)=>{if(init?.signal?.aborted)reject(Error('aborted'));else init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}
  if(path.endsWith('/decision'))return response({data:{decision:'step_up',status:'accepted'}});
  if(path.endsWith('/resolve')){resolutions++;throw Error('connection_lost');}
  if(path==='/v1/authorizations')return response({data:restarting?[{run_id:'R1',authorization_id:event.authorization.authorization_id,status:'awaiting_human'}]:[]});
  if(path==='/v1/scenario-runs/R1')return response({data:{status:'running'}});
  return response({data:[]});
 };
 const first=new LiveSessionService(ctx.pack,{baseUrl:'http://fake',apiKey:'test',stateDir:dir,transport});
 const ids=await first.start({config:ctx.config,scenario_id:event.authorization.scenario_id,instruction:ctx.config.instruction,hard_rules:[],confirmed_by:'human'},'lost-human');
 await expect.poll(()=>first.get(ids.session_id).entries[0]?.state).toBe('awaiting_human');
 const expiry=first.get(ids.session_id).entries[0]!.human_expires_at;
 await expect(first.respond(ids.session_id,event.authorization.authorization_id,'approve',null,async()=>({actor_id:'human',proof:'one-click'}),async()=>true)).rejects.toThrow('human_submission_unknown');
 await first.close();restarting=true;
 const second=new LiveSessionService(ctx.pack,{baseUrl:'http://fake',apiKey:'test',stateDir:dir,transport});
 try{await second.initialize();await expect.poll(()=>second.get(ids.session_id).entries[0]?.state,{timeout:500}).toBe('awaiting_human');expect(second.get(ids.session_id).entries[0]).toMatchObject({reserved:true,human_expires_at:expiry});expect(resolutions).toBe(1);expect(starts).toBe(1);expect(blockedPolls).toBeGreaterThan(0);}
 finally{await second.close();}
});

it('drains an in-flight delivered proposal before marking a remote run completed',async()=>{
 const ctx=fixture();const dir=await mkdtemp(join(tmpdir(),'live-terminal-race-'));const event=structuredClone(ctx.event);event.mandate.mandate_id='M1' as never;event.authorization.mandate_id='M1' as never;event.deadline_at=new Date(Date.now()+8000).toISOString();
 let release!:(r:Response)=>void;const pending=new Promise<Response>(resolve=>{release=resolve;});let remoteRead=false,decisions=0;
 const transport=async(path:string):Promise<Response>=>{
  if(path==='/v1/bootstrap')return response({data:{timeouts:{}}});if(path==='/v1/mandates')return response({data:{draft_id:'D1'}});if(path.includes('/confirm'))return response({data:{mandate_id:'M1'}});if(path==='/v1/scenario-runs')return response({data:{run_id:'R1'}});
  if(path.includes('decision-requests'))return pending;
  if(path.endsWith('/decision')){decisions++;return response({data:{decision:'approve',status:'approved'}});}
  if(path==='/v1/scenario-runs/R1'){remoteRead=true;return response({data:{status:'completed'}});}
  return response({data:[]});
 };
 const service=new LiveSessionService(ctx.pack,{baseUrl:'http://fake',apiKey:'test',stateDir:dir,transport});
 const ids=await service.start({config:ctx.config,scenario_id:event.authorization.scenario_id,instruction:ctx.config.instruction,hard_rules:[],confirmed_by:'human'},'terminal-race');
 try{await expect.poll(()=>remoteRead).toBe(true);expect(service.get(ids.session_id).status).not.toBe('completed');release(response({run_id:'R1',data:event}));await expect.poll(()=>service.get(ids.session_id).status).toBe('completed');expect(decisions).toBe(1);expect(service.get(ids.session_id).entries[0]?.accepted?.decision).toBe('approve');}
 finally{release(new Response(null,{status:204}));await service.close();}
});
