import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { AppError } from '../packages/contracts/src/errors.js';
import type { InstructionDecoding } from '../packages/contracts/src/instruction-decoding.js';
import type { HumanActor } from '../packages/contracts/src/simulation.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';
import { createLocalRuntime, type LocalRuntime } from '../packages/local-runtime/src/runtime.js';
import { preparePermissions, applyParameters } from '../packages/local-runtime/src/services/wallet-preparation.js';
import { createLiveRunDurably } from '../packages/local-runtime/src/services/live-run-creation.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import { VisecaClient } from '../packages/local-runtime/src/simulation/viseca-client.js';
import { VisecaOutbox, VisecaWorker } from '../packages/local-runtime/src/simulation/viseca-worker.js';

const directories:string[]=[];
const runtimes:LocalRuntime[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const runtime of runtimes.splice(0))await runtime.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function directory(){const path=await mkdtemp(join(tmpdir(),'viseca-backend-merge-'));directories.push(path);return path;}
function decoded(instruction:string,variables:InstructionDecoding['variables']=[],requirements:InstructionDecoding['unmapped_requirements']=[]):InstructionDecoding {
 return {instruction,variables,unmapped_requirements:requirements,decoding_id:'audit-merge',schema_version:1,prompt_version:'audit',source_schema_hash:'audit',model_requested:'fixture',model_returned:'fixture',response_id:'fixture',created_at:'2026-09-19T00:00:00Z',duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0}};
}

it.each(['!=','not_in'] as const)('A01 refuses a category exclusion that was never compiled: %s',operator=>{
 const {pack,now}=fixture(),instruction='Buy groceries and household goods, but do not buy household items.';
 const decoding=decoded(instruction,[{field:'authorization.items[].item_category',operator,status:'present',value:operator==='not_in'?['household']:'household',scope:null,currency:null,period_days:null,note:null,source_excerpt:'do not buy household items'}]);
 const review=preparePermissions(pack,instruction,decoding,now);
 expect(review.clarifications).toEqual(expect.arrayContaining([expect.objectContaining({key:'unresolved:authorization.items[].item_category'})]));
 expect(()=>applyParameters({...review,instruction,decoding} as WalletPreparation,review.config!.parameters,pack)).toThrow('Cannot start');
});

it.each([
 ['Replace my road-running shoes in size 43 with a wide fit.','size 43 with a wide fit'],
 ['Buy groceries for delivery using refrigerated shipping.','delivery using refrigerated shipping'],
 ['Buy a 27-inch monitor with an OLED screen.','27-inch OLED screen'],
 ['Buy black shoes in size 43 with waterproof fabric.','size 43 and waterproof fabric'],
 ['Buy groceries with return within 14 days and free collection.','return within 14 days and free collection'],
])('A02 keeps the full unsupported compound requirement: %s',(instruction,description)=>{
 const {pack,now}=fixture(),decoding=decoded(instruction,[],[{description,source_excerpt:instruction,reason:'no_native_field'}]);
 const review=preparePermissions(pack,instruction,decoding,now);
 expect(review.clarifications.some(row=>row.key==='unresolved:requirement:0')).toBe(true);
});

it.each(['size 43','Shoe size requirement: size 43'])('retains fully represented positive size requirements: %s',description=>{
 const {pack,now}=fixture(),instruction='Replace my road-running shoes in size 43.';
 const review=preparePermissions(pack,instruction,decoded(instruction,[],[{description,source_excerpt:instruction,reason:'no_native_field'}]),now);
 expect(review.clarifications).toEqual([]);
});

for(const endpoint of ['events','authorizations'])it.each([null,{}, {data:'unreadable event listing',next_cursor:'9'}, {data:[null]}, {data:{unrecognized:[]}}])(`A03 rejects malformed ${endpoint} without committing its cursor: %j`,async malformed=>{
 const {event,now}=fixture(),path=await directory();
 const client=new VisecaClient('http://fixture','fixture',async url=>Response.json(url.includes(`/v1/${endpoint}`)?malformed:{data:[]}));
 const outbox=new VisecaOutbox(join(path,'outbox.sqlite'));await outbox.load();const worker=new VisecaWorker(client,outbox,()=>Date.parse(now));
 try{await worker.startRun('RUN',{});await expect(worker.reconcile()).rejects.toThrow('live_feed_response_invalid');expect(outbox.value.cursor).toBe('0');expect(outbox.value.entries).toEqual([]);}finally{client.close();outbox.close();}
});

it('accepts genuinely empty API feeds',async()=>{
 const client=new VisecaClient('http://fixture','fixture',async()=>Response.json({data:[]}));
 try{await expect(client.reconcile('0')).resolves.toMatchObject({events:{data:[],next_cursor:'0'},authorizations:{data:[]}});}finally{client.close();}
});

async function localRun(){
 const path=await directory();const runtime=await createLocalRuntime({stateDir:join(path,'state'),outputDir:join(path,'output'),liveOptions:{environment:'disabled',baseUrl:'',apiKey:''},instructionDecoder:{model:'fixture',configured:false,decode:async()=>{throw Error('unexpected AI call');}}});runtimes.push(runtime);
 const scenario=runtime.pack.scenarios[0]!,review=runtime.wallet.prepare({scenario_id:scenario.scenario_id,instruction:scenario.cardholder_instruction,mode:'local'},'backend-merge');
 await expect.poll(()=>runtime.wallet.getPreparation(review.preparation_id).status).toBe('ready');
 const actor:HumanActor={actor_id:'fixture-human',customer_id:runtime.wallet.actorCustomer(scenario.scenario_id),role:'simulated_human',channel:'local_ui',authenticated_by_server:true};
 const started=await runtime.wallet.confirm(review.preparation_id,runtime.wallet.getPreparation(review.preparation_id).config!.parameters,actor,'local');return {runtime,actor,...started};
}

it('A04 never reports revocation before the mandate write succeeds',async()=>{
 const {runtime,actor,run_id,mandate_id}=await localRun();
 const revoke=vi.spyOn(runtime.policies,'revokeMandate').mockRejectedValueOnce(new Error('policy_store_write_failed'));
 await expect(runtime.wallet.revoke(run_id,actor,'revoke-test')).rejects.toThrow('policy_store_write_failed');
 expect(runtime.wallet.getRun(run_id).status).not.toBe('revoked');expect(runtime.policies.getMandate(mandate_id).status).toBe('active');
 revoke.mockRestore();await runtime.wallet.revoke(run_id,actor,'revoke-test');expect(runtime.wallet.getRun(run_id).status).toBe('revoked');expect(runtime.policies.getMandate(mandate_id).status).toBe('revoked');
});

it('A06 shows a processing failure as suspended with its cause, and clears it after successful recovery',async()=>{
 const {runtime,run_id}=await localRun();
 const next=vi.spyOn(runtime.simulations,'next').mockImplementationOnce(()=>{throw new AppError(409,'G06_RULE_INVALID','Unsupported native rule');});
 runtime.wallet.tick();expect(runtime.wallet.getRun(run_id)).toMatchObject({status:'suspended',transport:{last_error:'G06_RULE_INVALID'}});
 next.mockRestore();runtime.wallet.tick();expect(runtime.wallet.getRun(run_id).transport.last_error).toBeNull();expect(runtime.wallet.getRun(run_id).purchases.length).toBeGreaterThan(0);
});

it('A09 persists an unknown CLI creation and never repeats its POST after restart',async()=>{
 const ctx=fixture(),path=join(await directory(),'outbox.sqlite');let posts=0;
 const client=new VisecaClient('http://fixture','fixture',async(url,init)=>{if(init?.method==='POST'){posts++;throw Error('response_lost');}return Response.json({data:[]});});
 const binding={config:ctx.config,live_mandate_id:ctx.config.mandate_id,scenario_id:ctx.run.scenario_id,hard_rules:[],history_hash:hash(ctx.pack.history),pack_version:ctx.pack.pack_version};
 const first=new VisecaOutbox(path);await first.load();await expect(createLiveRunDurably(client,first,binding)).rejects.toThrow('response_lost');expect(first.value.run_start?.status).toBe('unknown');first.close();
 const restored=new VisecaOutbox(path);await restored.load();try{await expect(createLiveRunDurably(client,restored,binding)).rejects.toThrow('live_start_submission_unknown_requires_reconciliation');expect(posts).toBe(1);}finally{restored.close();client.close();}
});

it.each([true,false])('A09 reconciles only a new matching run, excluding older executions (new run visible: %s)',async visible=>{
 const ctx=fixture(),path=join(await directory(),'outbox.sqlite');let sent=false,posts=0;
 const binding={config:ctx.config,live_mandate_id:ctx.config.mandate_id,scenario_id:ctx.run.scenario_id,hard_rules:[],history_hash:hash(ctx.pack.history),pack_version:ctx.pack.pack_version};
 const row=(run_id:string)=>({run_id,data:{mandate_id:binding.live_mandate_id,scenario_id:binding.scenario_id}});
 const client=new VisecaClient('http://fixture','fixture',async(url,init)=>{
  if(init?.method==='POST'){sent=true;posts++;throw Error('response_lost');}
  if(url.startsWith('/v1/events'))return Response.json({data:[row('OLD_RUN'),...(sent&&visible?[row('NEW_RUN')]:[])]});
  if(url==='/v1/scenario-runs/NEW_RUN')return Response.json({data:{run_id:'NEW_RUN',mandate_id:binding.live_mandate_id,scenario_id:binding.scenario_id}});
  return Response.json({data:[]});
 });
 const outbox=new VisecaOutbox(path);await outbox.load();
 try{
  await expect(createLiveRunDurably(client,outbox,binding)).rejects.toThrow('response_lost');
  if(visible){await expect(createLiveRunDurably(client,outbox,binding)).resolves.toBe('NEW_RUN');await expect(createLiveRunDurably(client,outbox,binding)).resolves.toBe('NEW_RUN');}
  else await expect(createLiveRunDurably(client,outbox,binding)).rejects.toThrow('live_start_submission_unknown_requires_reconciliation');
  expect(posts).toBe(1);
 }finally{outbox.close();client.close();}
});
