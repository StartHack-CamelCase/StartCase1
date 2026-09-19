import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createLocalApp,type LocalAppOptions} from '../apps/local-web/src/app.js';
import {createMockApi,LOCAL_MOCK_API_KEY} from '../apps/api-mock/src/app.js';

const resources:Array<{dir:string;mock:FastifyInstance;apps:FastifyInstance[]}>=[];
afterEach(async()=>{for(const r of resources.splice(0)){for(const app of r.apps)await app.close();await r.mock.close();await rm(r.dir,{recursive:true,force:true});}});
async function setup(fault:'reject'|'lost-run'){
 const dir=await mkdtemp(join(tmpdir(),'wallet-start-recovery-'));
 const mock=await createMockApi({stateDir:join(dir,'platform')});
 const r={dir,mock,apps:[] as FastifyInstance[]};resources.push(r);let fail=true;let runPosts=0;
 const options:LocalAppOptions={stateDir:join(dir,'wallet'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{configured:false,model:'disabled',decode:async()=>{throw Error('No API');}},liveOptions:{environment:'mock',baseUrl:'http://127.0.0.1:4313',apiKey:LOCAL_MOCK_API_KEY,transport:async(path,init)=>{
  if(fail&&fault==='reject'&&path==='/v1/mandates'&&init?.method==='POST'){fail=false;return new Response(JSON.stringify({error:{code:'invalid_instruction'}}),{status:400});}
  if(path==='/v1/scenario-runs'&&init?.method==='POST')runPosts++;
  const response=await mock.inject({url:path,method:(init?.method??'GET') as 'GET'|'POST'|'DELETE',headers:Object.fromEntries(new Headers(init?.headers)),...(init?.signal?{signal:init.signal}:{}),...(init?.body?{payload:String(init.body)}:{})});
  if(fail&&fault==='lost-run'&&path==='/v1/scenario-runs'&&init?.method==='POST'){fail=false;throw Error('run response lost');}
  return new Response(response.statusCode===204?null:response.body,{status:response.statusCode});
 }}};
 const open=async()=>{const app=await createLocalApp(options);r.apps.push(app);return app;};const app=await open();
 const s=await app.inject('/api/wallet/session?scenario_id=SCEN0000');const headers={cookie:String(s.headers['set-cookie']).split(';')[0]!,'x-csrf-token':s.json().csrf,'idempotency-key':'start-audit-001'};
 const instruction=(await app.inject('/api/wallet/options')).json().scenarios.find((s:{scenario_id:string})=>s.scenario_id==='SCEN0000').instruction;
 const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0000',mode:'live',instruction}});
 const id=prepared.json().preparation_id;
 const confirm={method:'POST' as const,url:`/api/wallet/preparations/${id}/confirm`,headers,payload:{confirmed:true,parameters:prepared.json().config.parameters,mode:'live'}};
 const response=await app.inject(confirm);expect(response.statusCode).toBeGreaterThanOrEqual(400);
 return {app,r,open,id,headers,confirm,runPosts:()=>runPosts};
}
it('shows rejected starts and permits a corrected retry without a permanent lock',async()=>{
 const x=await setup('reject');
 const starts=(await x.app.inject('/api/wallet/api-starts')).json().starts;
 expect(starts).toMatchObject([{preparation_id:x.id,stage:'rejected',retryable:true}]);
 const unauthorized=await x.app.inject({method:'POST',url:`/api/wallet/preparations/${x.id}/reconcile`,headers:{'idempotency-key':'unauthorized-check'},payload:{}});
 expect(unauthorized.statusCode).toBe(403);
 const retry=await x.app.inject(x.confirm);expect(retry.statusCode,retry.body).toBe(200);
 expect(x.runPosts()).toBe(1);
 expect((await x.app.inject('/api/wallet/api-starts')).json().starts).toEqual([]);
});
it('links a recovered platform run to the wallet without repeating its creation',async()=>{
 const x=await setup('lost-run');
 expect((await x.app.inject('/api/wallet/api-starts')).json().starts).toMatchObject([{preparation_id:x.id,retryable:false}]);
 const recovered=await x.app.inject({method:'POST',url:`/api/wallet/preparations/${x.id}/reconcile`,headers:x.headers,payload:{}});
 expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().run_id).toBeTruthy();
 expect((await x.app.inject('/api/wallet/runs')).json().runs).toHaveLength(1);
 expect(x.runPosts()).toBe(1);
});
it('restores the wallet association when a run creation reply was lost before restart',async()=>{
 const x=await setup('lost-run');await x.app.close();x.r.apps.splice(x.r.apps.indexOf(x.app),1);
 const restored=await x.open();const runs=(await restored.inject('/api/wallet/runs')).json().runs;
 expect(runs).toHaveLength(1);expect(runs[0].mode).toBe('live');expect(x.runPosts()).toBe(1);
 expect((await restored.inject('/api/wallet/api-starts')).json().starts).toEqual([]);
});
