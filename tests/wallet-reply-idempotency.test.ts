import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {build} from 'esbuild';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,beforeAll,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createLocalApp,type LocalAppOptions} from '../apps/local-web/src/app.js';
import {createMockApi,LOCAL_MOCK_API_KEY} from '../apps/api-mock/src/app.js';
import type {WalletRunView} from '../packages/contracts/src/wallet.js';
import {OperationJournal,journaledMutation,type PendingOperation} from '../apps/local-web/web/operation-state.js';

const resources:Array<{directory:string;apps:FastifyInstance[];mock:FastifyInstance}>=[];
afterEach(async()=>{for(const r of resources.splice(0)){for(const app of r.apps)await app.close();await r.mock.close();await rm(r.directory,{recursive:true,force:true});}});
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'wallet-reply-'));
 const mock=await createMockApi({stateDir:join(directory,'platform'),humanTimeoutMs:120000});
 const r={directory,mock,apps:[] as FastifyInstance[]};resources.push(r);
 let loseResolve=false,loseBeforeResolve=false,pauseReads=false;const resolves:string[]=[];const resolutionRequests:Array<{decision:string;reachedPlatform:boolean}>=[];
 const options:LocalAppOptions={stateDir:join(directory,'wallet'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{configured:false,model:'disabled',decode:async()=>{throw Error('No API');}},liveOptions:{environment:'mock',baseUrl:'http://127.0.0.1:4313',apiKey:LOCAL_MOCK_API_KEY,transport:async(path,init)=>{
  init?.signal?.throwIfAborted();
  if(pauseReads&&(path.startsWith('/v1/events')||path==='/v1/authorizations'))return new Response('{}',{status:503});
  if(path.endsWith('/resolve')){
   resolutionRequests.push({decision:JSON.parse(String(init?.body)).decision,reachedPlatform:!loseBeforeResolve});
   if(loseBeforeResolve){loseBeforeResolve=false;throw Error('response lost before platform');}
  }
  const response=await mock.inject({method:(init?.method??'GET') as 'GET'|'POST'|'DELETE',url:path,...(init?.signal?{signal:init.signal}:{}),headers:Object.fromEntries(new Headers(init?.headers)),...(init?.body?{payload:String(init.body)}:{})});
  if(path.endsWith('/resolve')){resolves.push(path);if(loseResolve){loseResolve=false;throw Error('response lost after acceptance');}}
  return new Response(response.statusCode===204?null:response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 }}};
 const open=async()=>{const app=await createLocalApp(options);r.apps.push(app);return app;};
 const app=await open();
 const headers=await session(app);
 const scenario=(await app.inject('/api/wallet/options')).json().scenarios.find((s:{scenario_id:string})=>s.scenario_id==='SCEN0003');
 const prep=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0003',instruction:scenario.instruction,mode:'live'}});
 const started=await app.inject({method:'POST',url:`/api/wallet/preparations/${prep.json().preparation_id}/confirm`,headers,payload:{confirmed:true,parameters:prep.json().config.parameters,mode:'live'}});
 expect(started.statusCode,started.body).toBe(200);
 const runId=started.json().run_id as string;
 await expect.poll(async()=>(await view(app,runId)).purchases.filter(p=>p.platform_status==='awaiting_human').length,{timeout:8000}).toBeGreaterThanOrEqual(2);
 return {app,r,open,headers,runId,resolves,resolutionRequests,loseNextResolve:()=>{loseResolve=true;},loseBeforePlatform:()=>{loseBeforeResolve=true;pauseReads=true;},resumeReads:()=>{pauseReads=false;}};
}
async function session(app:FastifyInstance){
 const s=await app.inject('/api/wallet/session?scenario_id=SCEN0003');
 return {cookie:String(s.headers['set-cookie']).split(';')[0]!,'x-csrf-token':s.json().csrf as string,'idempotency-key':'wallet-reply-prepare'};
}
async function view(app:FastifyInstance,id:string):Promise<WalletRunView>{return (await app.inject(`/api/wallet/runs/${id}`)).json();}
function request(x:Awaited<ReturnType<typeof setup>>,authorization_id:string,key='wallet-reply-first'){
 return {method:'POST' as const,url:`/api/wallet/runs/${x.runId}/human-responses`,headers:{...x.headers,'idempotency-key':key},payload:{authorization_id,decision:'decline',answers:[]}};
}
it('replays simultaneous and restarted human replies without another POST and rejects key reuse',async()=>{
 const x=await setup();const pending=(await view(x.app,x.runId)).purchases.filter(p=>p.platform_status==='awaiting_human');
 const req=request(x,pending[0]!.authorization_id);
 const [first,replay]=await Promise.all([x.app.inject(req),x.app.inject(req)]);
 expect(first.statusCode,first.body).toBe(200);expect(replay.json()).toEqual(first.json());
 expect(x.resolves.filter(p=>p.includes(pending[0]!.authorization_id))).toHaveLength(1);
 const changed=await x.app.inject(request(x,pending[1]!.authorization_id));
 expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('G01_IDEMPOTENCY_CONFLICT');
 await x.app.close();x.r.apps.splice(x.r.apps.indexOf(x.app),1);
 const restored=await x.open();const headers=await session(restored);
 const afterRestart=await restored.inject({...req,headers:{...headers,'idempotency-key':req.headers['idempotency-key']}});
 expect(afterRestart.statusCode,afterRestart.body).toBe(200);expect(afterRestart.json()).toEqual(first.json());
 expect(x.resolves.filter(p=>p.includes(pending[0]!.authorization_id))).toHaveLength(1);
 const next=await restored.inject({...request(x,pending[1]!.authorization_id,'wallet-reply-second'),headers:{...headers,'idempotency-key':'wallet-reply-second'}});
 expect(next.statusCode,next.body).toBe(200);
});
it('recovers an accepted human reply whose platform response was lost, without resubmitting',async()=>{
 const x=await setup();const id=(await view(x.app,x.runId)).purchases.find(p=>p.platform_status==='awaiting_human')!.authorization_id;
 x.loseNextResolve();const req=request(x,id);
 const uncertain=await x.app.inject(req);expect(uncertain.statusCode,uncertain.body).toBe(503);
 await expect.poll(async()=>(await view(x.app,x.runId)).purchases.find(p=>p.authorization_id===id)?.platform_status,{timeout:5000}).toBe('accepted');
 const replay=await x.app.inject(req);expect(replay.statusCode,replay.body).toBe(200);
 expect(replay.json<WalletRunView>().purchases.find(p=>p.authorization_id===id)?.assessment?.execution_state).toBe('declined');
 expect(x.resolves.filter(p=>p.includes(id))).toHaveLength(1);
});
it('unblocks the next purchase by reconciling the saved wallet response without replaying it',async()=>{
 const x=await setup();const pending=(await view(x.app,x.runId)).purchases.filter(p=>p.platform_status==='awaiting_human');
 const storage=new Map<string,string>();let sequence=0;
 const journal=new OperationJournal({getItem:k=>storage.get(k)??null,setItem:(k,v)=>{storage.set(k,v);},removeItem:k=>{storage.delete(k);}},()=>`journal-reply-${++sequence}`);
 const path=`/api/wallet/runs/${x.runId}/human-responses`;let loseReply=true;
 const send=async(operation:PendingOperation)=>{
  const response=await x.app.inject({method:'POST',url:path,headers:{...x.headers,'idempotency-key':operation.key},payload:JSON.parse(operation.body!)});
  expect(response.statusCode,response.body).toBe(200);
  if(loseReply){loseReply=false;throw Error('wallet response lost');}
  return response.json();
 };
 const recover=async(operation:PendingOperation)=>{
  const response=await x.app.inject({method:'POST',url:`${path}/reconcile`,headers:{...x.headers,'idempotency-key':operation.key},payload:JSON.parse(operation.body!)});
  expect(response.statusCode,response.body).toBe(200);expect(response.json().status).toBe('settled');return {allowNext:true};
 };
 const body=(index:number)=>({authorization_id:pending[index]!.authorization_id,decision:'decline',answers:[]});
 await expect(journaledMutation(journal,path,body(0),send,recover)).rejects.toThrow('wallet response lost');
 expect(journal.pending(path)).not.toBeNull();
 await journaledMutation(journal,path,body(1),send,recover);
 expect(journal.pending(path)).toBeNull();
 expect(x.resolves.filter(p=>p.includes(pending[0]!.authorization_id))).toHaveLength(1);
 expect(x.resolves.filter(p=>p.includes(pending[1]!.authorization_id))).toHaveLength(1);
});


let frontendBundle='';
beforeAll(async()=>{
 const original=await readFile(resolve('apps/local-web/web/app.ts'),'utf8');
 const source=original.replace("window.addEventListener('popstate',()=>void route());void route();","const testPage=new PageContext('live');globalThis.__mutate=(path,body)=>testPage.mutate(path,body);globalThis.__setCsrf=value=>{testPage.csrf=value;};");
 expect(source).not.toBe(original);
 const compiled=await build({stdin:{contents:source,loader:'ts',resolveDir:resolve('apps/local-web/web')},bundle:true,format:'iife',platform:'browser',write:false});
 frontendBundle=compiled.outputFiles[0]!.text;
});
function browser(x:Awaited<ReturnType<typeof setup>>){
 const storage=new Map<string,string>();let loss:'before'|'after'|undefined;
 const calls:Array<{path:string;key:string;body:Record<string,unknown>;reachedServer:boolean}>=[];
 const context=vm.createContext({document:{querySelector:()=>({addEventListener(){}})},window:{addEventListener(){}},URL,URLSearchParams,DOMException,AbortController,localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},crypto:{randomUUID},Intl,setTimeout,clearTimeout,fetch:async(path:string,init?:RequestInit)=>{
  const headers={...x.headers,...Object.fromEntries(new Headers(init?.headers))};
  const call={path:new URL(path,'http://wallet.local').pathname,key:headers['idempotency-key'],body:JSON.parse(String(init?.body)),reachedServer:false};calls.push(call);
  if(loss==='before'){loss=undefined;throw Error('browser request lost before server');}
  call.reachedServer=true;
  const response=await x.app.inject({method:'POST',url:path,headers,payload:String(init?.body)});
  if(loss==='after'){loss=undefined;throw Error('browser response lost after server');}
  return new Response(response.body,{status:response.statusCode});
 }});
 vm.runInContext(frontendBundle,context);
 (context['__setCsrf'] as (value:string)=>void)(x.headers['x-csrf-token']);
 const path=`/api/wallet/runs/${x.runId}/human-responses`;
 return {calls,storage,path,loseNext:(when:'before'|'after')=>{loss=when;},mutate:(body:unknown)=>(context['__mutate'] as (path:string,body:unknown)=>Promise<WalletRunView>)(path,body)};
}
async function riskApproval(x:Awaited<ReturnType<typeof setup>>){
 await expect.poll(async()=>(await view(x.app,x.runId)).purchases.length,{timeout:10000}).toBe(11);
 const run=await view(x.app,x.runId);
 const purchase=run.purchases.find(p=>p.assessment?.execution_state==='awaiting_user'&&p.assessment.questions.length>0&&p.assessment.questions.every(q=>q.kind==='confirm_risk'))!;
 expect(purchase).toBeDefined();
 const assessment=purchase.assessment!;
 return {run,purchase,body:{authorization_id:purchase.authorization_id,decision:'approve',offer_hash:assessment.offer_hash,expected_revision:assessment.revision,answers:assessment.questions.map(q=>({question_id:q.question_id,value:'confirm'}))}};
}

it('a decline abandons an approval lost before receipt and blocks its late arrival across restart',async()=>{
 const x=await setup(),ui=browser(x),approval=await riskApproval(x);
 ui.loseNext('before');await expect(ui.mutate(approval.body)).rejects.toThrow('Connection interrupted');
 const declined=await ui.mutate({authorization_id:approval.purchase.authorization_id,decision:'decline',answers:[]});
 expect(declined.purchases.find(p=>p.authorization_id===approval.purchase.authorization_id)?.assessment?.execution_state).toBe('declined');
 expect(declined.approved_chf).toBe(approval.run.approved_chf);
 expect(x.resolutionRequests).toEqual([{decision:'decline',reachedPlatform:true}]);
 const first=ui.calls[0]!;
 const late=await x.app.inject({method:'POST',url:ui.path,headers:{...x.headers,'idempotency-key':first.key},payload:approval.body});
 expect(late.statusCode).toBe(409);expect(late.json().error.code).toBe('human_response_abandoned');
 await x.app.close();x.r.apps.splice(x.r.apps.indexOf(x.app),1);
 const restored=await x.open(),headers=await session(restored);
 const lateAgain=await restored.inject({method:'POST',url:ui.path,headers:{...headers,'idempotency-key':first.key},payload:approval.body});
 expect(lateAgain.statusCode).toBe(409);expect(lateAgain.json().error.code).toBe('human_response_abandoned');
 expect(x.resolves).toHaveLength(1);
});

it('reads an accepted approval after a lost reply, reports finality for decline, and permits the next purchase',async()=>{
 const x=await setup(),ui=browser(x),approval=await riskApproval(x);
 ui.loseNext('after');await expect(ui.mutate(approval.body)).rejects.toThrow('Connection interrupted');
 await expect(ui.mutate({authorization_id:approval.purchase.authorization_id,decision:'decline',answers:[]})).rejects.toThrow('already finalized');
 expect(x.resolutionRequests).toEqual([{decision:'approve',reachedPlatform:true}]);
 expect(ui.calls.filter(c=>c.path===ui.path&&c.reachedServer)).toHaveLength(1);
 const next=(await view(x.app,x.runId)).purchases.find(p=>p.platform_status==='awaiting_human')!;
 await ui.mutate({authorization_id:next.authorization_id,decision:'decline',answers:[]});
 expect(x.resolutionRequests.map(r=>r.decision)).toEqual(['approve','decline']);
});

it('waits on an uncertain submission, then permits decline only after authoritative reopening',async()=>{
 const x=await setup(),ui=browser(x),approval=await riskApproval(x);
 x.loseBeforePlatform();await expect(ui.mutate(approval.body)).rejects.toThrow('still being reconciled');
 const decline={authorization_id:approval.purchase.authorization_id,decision:'decline',answers:[]};
 await expect(ui.mutate(decline)).rejects.toThrow('not confirmed the previous response');
 expect(x.resolutionRequests).toEqual([{decision:'approve',reachedPlatform:false}]);
 x.resumeReads();
 await expect.poll(async()=>(await view(x.app,x.runId)).purchases.find(p=>p.authorization_id===approval.purchase.authorization_id)?.platform_status,{timeout:8000}).toBe('awaiting_human');
 const result=await ui.mutate(decline);
 expect(result.purchases.find(p=>p.authorization_id===approval.purchase.authorization_id)?.assessment?.execution_state).toBe('declined');
 expect(x.resolutionRequests).toEqual([{decision:'approve',reachedPlatform:false},{decision:'decline',reachedPlatform:true}]);
});

it('requires the matching owner and CSRF before reconciling or abandoning a response key',async()=>{
 const x=await setup(),approval=await riskApproval(x);
 const route=`/api/wallet/runs/${x.runId}/human-responses/reconcile`;
 const wrong=await x.app.inject('/api/wallet/session?scenario_id=SCEN0000');
 const requests=[{'idempotency-key':'reconcile-owner-001'}, {...x.headers,'x-csrf-token':'wrong'}, {cookie:String(wrong.headers['set-cookie']).split(';')[0]!,'x-csrf-token':wrong.json().csrf,'idempotency-key':'reconcile-owner-001'}];
 for(const headers of requests)expect((await x.app.inject({method:'POST',url:route,headers,payload:approval.body})).statusCode).toBe(403);
 const accepted=await x.app.inject({method:'POST',url:route,headers:{...x.headers,'idempotency-key':'reconcile-owner-001'},payload:approval.body});
 expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().status).toBe('abandoned');
 expect(x.resolves).toEqual([]);
});
