import {configuredInstructionDecoder,readyWalletPreparation} from './helpers/configured-instruction-decoder.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createLocalApp} from '../apps/local-web/src/app.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';

const resources:Array<{app:FastifyInstance;dir:string}>=[];
afterEach(async()=>{for(const {app,dir} of resources.splice(0)){await app.close();await rm(dir,{recursive:true,force:true});}});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'viseca-data-mode-'));
 const transport=vi.fn(async()=>{throw Error('Offline actions must not reach the API');});
 const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder(),liveOptions:{environment:'mock',baseUrl:'http://127.0.0.1:4313',apiKey:'fake-test-key',transport}});
 resources.push({app,dir});
 const options=(await app.inject('/api/wallet/options?mode=local')).json();
 async function session(scenario:string,cookie?:string){const r=await app.inject({url:`/api/wallet/session?scenario_id=${scenario}&mode=local`,...(cookie?{headers:{cookie}}:{})});expect(r.statusCode).toBe(200);return {cookie:String(r.headers['set-cookie']).split(';')[0]!,'x-csrf-token':r.json().csrf,'idempotency-key':`mode-session-${scenario}`};}
 const headers=await session('SCEN0000');
 const payload={scenario_id:'SCEN0000',instruction:options.scenarios[0].instruction,mode:'local'};
 const response=await app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers,payload});expect(response.statusCode,response.body).toBe(202);
 const prep=await readyWalletPreparation(async()=>(await app.inject(`/api/wallet/preparations/${response.json().preparation_id}?mode=local`)).json<WalletPreparation>());expect(prep.status).toBe('ready');
 return {app,headers,prep,payload,transport,session,options};
}

describe('data mode HTTP boundaries',()=>{
 it('keeps offline activity available while hiding it from online views and rejecting stale-mode mutations',async()=>{
  const x=await setup();
  const confirm=await x.app.inject({method:'POST',url:`/api/wallet/preparations/${x.prep.preparation_id}/confirm?mode=local`,headers:x.headers,payload:{confirmed:true,parameters:x.prep.config!.parameters,mode:'local'}});expect(confirm.statusCode,confirm.body).toBe(200);const id=confirm.json().run_id;
  expect((await x.app.inject('/api/wallet/runs?mode=local')).json().runs.map((r:{run_id:string})=>r.run_id)).toEqual([id]);
  expect((await x.app.inject('/api/wallet/runs?mode=live')).json().runs).toEqual([]);
  expect((await x.app.inject(`/api/wallet/runs/${id}?mode=live`)).statusCode).toBe(404);
  const revoke=await x.app.inject({method:'POST',url:`/api/wallet/runs/${id}/revoke?mode=live`,headers:x.headers,payload:{}});expect(revoke.statusCode).toBe(404);
  expect((await x.app.inject(`/api/wallet/runs/${id}?mode=local`)).json().status).not.toBe('revoked');
  expect((await x.app.inject(`/api/wallet/preparations/${x.prep.preparation_id}?mode=live`)).statusCode).toBe(404);
  expect((await x.app.inject('/api/wallet/api-starts?mode=local')).json()).toEqual({starts:[]});
  expect(x.transport).not.toHaveBeenCalled();
 });
 it('rejects contradictory source and profile scope before a preparation or control is applied',async()=>{
  const x=await setup();
  const mismatch=await x.app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers:x.headers,payload:{...x.payload,mode:'live'}});expect(mismatch.statusCode).toBe(404);
  for(const mode of ['local','live']){
   const scope=mode==='local'?'live':'local';
   expect((await x.app.inject(`/api/wallet/profiles/detail?scenario_id=SCEN0000&scope=${scope}&mode=${mode}`)).statusCode).toBe(404);
   expect((await x.app.inject({method:'POST',url:`/api/wallet/profiles/control?mode=${mode}`,headers:x.headers,payload:{scenario_id:'SCEN0000',scope,filter_id:'C15',context_key:'test',action:'forget',expected_revision:0}})).statusCode).toBe(404);
  }
  expect((await x.app.inject('/api/wallet/runs?mode=unknown')).statusCode).toBe(400);
  expect(x.transport).not.toHaveBeenCalled();
 });
 it('retains both customer tabs without changing the authority of their CSRF tokens',async()=>{
  const x=await setup();
  const same=await x.session('SCEN0000',x.headers.cookie);expect(same.cookie).toBe(x.headers.cookie);expect(same['x-csrf-token']).toBe(x.headers['x-csrf-token']);
  const other=await x.session('SCEN0002',x.headers.cookie);expect(other.cookie).toBe(x.headers.cookie);expect(other['x-csrf-token']).not.toBe(x.headers['x-csrf-token']);
  const first=await x.app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers:{...x.headers,'idempotency-key':'mode-first-tab-repeated'},payload:x.payload});expect(first.statusCode,first.body).toBe(202);
  const wrong=await x.app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers:{...other,'idempotency-key':'mode-wrong-owner-tab'},payload:x.payload});expect(wrong.statusCode).toBe(403);
  const second=await x.app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers:{...other,'idempotency-key':'mode-second-customer-tab'},payload:{scenario_id:'SCEN0002',instruction:x.options.scenarios[2].instruction,mode:'local'}});expect(second.statusCode,second.body).toBe(202);
  const stranger=await x.session('SCEN0000');
  const stolen=await x.app.inject({method:'POST',url:'/api/wallet/prepare?mode=local',headers:{...x.headers,cookie:stranger.cookie,'idempotency-key':'mode-cross-browser-csrf'},payload:x.payload});expect(stolen.statusCode).toBe(403);
 });
});
