import {configuredInstructionDecoder,readyWalletPreparation} from './helpers/configured-instruction-decoder.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {createMockApi,LOCAL_MOCK_API_KEY} from '../apps/api-mock/src/app.js';
import type {WalletRunView} from '../packages/contracts/src/wallet.js';
import {collectLiveAnswers,canConfirmQuestions} from '../apps/local-web/web/wallet-ui.js';
import {renderReview} from '../apps/local-web/web/wallet-run-view.js';

const resources:Array<{dir:string;app:FastifyInstance;mock:FastifyInstance}>=[];
afterEach(async()=>{for(const {dir,app,mock} of resources.splice(0)){await app.close();await mock.close();await rm(dir,{recursive:true,force:true});}});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'wallet-binary-'));
 const mock=await createMockApi({stateDir:join(dir,'platform'),humanTimeoutMs:120000});
 const resolutions:Array<{id:string;decision:string}>=[];
 const app=await createLocalApp({stateDir:join(dir,'wallet'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder(),liveOptions:{environment:'mock',baseUrl:'http://127.0.0.1:4313',apiKey:LOCAL_MOCK_API_KEY,transport:async(path,init)=>{
  const response=await mock.inject({method:(init?.method??'GET') as 'GET'|'POST'|'DELETE',url:path,...(init?.signal?{signal:init.signal}:{}),headers:Object.fromEntries(new Headers(init?.headers)),...(init?.body?{payload:String(init.body)}:{})});
  if(path.endsWith('/resolve'))resolutions.push({id:path.split('/').at(-2)!,decision:JSON.parse(String(init?.body)).decision});
  return new Response(response.statusCode===204?null:response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 }}});
 resources.push({dir,app,mock});
 const session=await app.inject('/api/wallet/session?scenario_id=SCEN0004');
 const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf};
 const instruction='Buy one 27-inch monitor for CHF 400 or less. Ask me before every purchase.';
 const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers:{...headers,'idempotency-key':'binary-prepare'},payload:{scenario_id:'SCEN0004',instruction,mode:'live'}});
 const prep=await readyWalletPreparation(async()=>(await app.inject(`/api/wallet/preparations/${prepared.json().preparation_id}`)).json());expect(prepared.statusCode,prepared.body).toBe(202);
 const started=await app.inject({method:'POST',url:`/api/wallet/preparations/${prep.preparation_id}/confirm`,headers:{...headers,'idempotency-key':'binary-confirm'},payload:{confirmed:true,parameters:prep.config!.parameters,mode:'live'}});
 expect(started.statusCode,started.body).toBe(200);
 const id=started.json().run_id as string;
 const view=async()=>(await app.inject(`/api/wallet/runs/${id}`)).json<WalletRunView>();
 await expect.poll(async()=>(await view()).purchases.length,{timeout:12000}).toBe(11);
 const respond=(purchase:WalletRunView['purchases'][number],decision:'approve'|'decline',key:string,answers=decision==='approve'?collectLiveAnswers(purchase.assessment!.questions):[])=>app.inject({method:'POST',url:`/api/wallet/runs/${id}/human-responses`,headers:{...headers,'idempotency-key':key},payload:{authorization_id:purchase.authorization_id,decision,offer_hash:purchase.assessment!.offer_hash,expected_revision:purchase.assessment!.revision,answers}});
 return {app,id,view,respond,resolutions};
}
const available=(view:WalletRunView)=>view.purchases.find(p=>p.assessment?.execution_state==='awaiting_user'&&canConfirmQuestions(p.assessment.questions))!;
const held=(view:WalletRunView)=>view.purchases.find(p=>p.platform_status==='awaiting_human'&&p.assessment?.technical_filter_ids.includes('C12')&&!p.assessment.blocking_filter_ids.length)!;

it('accepts one purchase with a binary click while other simultaneous cards wait for capacity',async()=>{
 const x=await setup(),before=await x.view(),first=available(before);
 expect(first).toBeDefined();expect(held(before)).toBeDefined();
 const html=renderReview(first.assessment!,first.authorization_id,'live');
 expect(html).not.toMatch(/<input|<textarea|<select/);expect(html).toContain('>Accept this purchase<');expect(html).toContain('>Decline this purchase<');
 const response=await x.respond(first,'approve','binary-accept-first');
 expect(response.statusCode,response.body).toBe(200);
 const after=response.json<WalletRunView>();
 expect(after.purchases.find(p=>p.authorization_id===first.authorization_id)?.assessment?.execution_state).toBe('approved');
 expect(after.approved_chf).toBe(Number(first.amount_chf).toFixed(2));
 expect(x.resolutions).toEqual([{id:first.authorization_id,decision:'approve'}]);
 const replay=await x.respond(first,'approve','binary-accept-first');expect(replay.statusCode,replay.body).toBe(200);expect(x.resolutions).toHaveLength(1);
});

it('declining one card automatically releases another card for a binary acceptance',async()=>{
 const x=await setup(),before=await x.view(),first=available(before),waiting=held(before);
 expect(first).toBeDefined();expect(waiting).toBeDefined();
 const declined=await x.respond(first,'decline','binary-decline-first');expect(declined.statusCode,declined.body).toBe(200);
 const next=declined.json<WalletRunView>().purchases.find(p=>p.authorization_id===waiting.authorization_id)!;
 expect(next.assessment?.execution_state).toBe('awaiting_user');expect(canConfirmQuestions(next.assessment!.questions)).toBe(true);
 const accepted=await x.respond(next,'approve','binary-accept-next');expect(accepted.statusCode,accepted.body).toBe(200);
 expect(accepted.json<WalletRunView>().purchases.find(p=>p.authorization_id===next.authorization_id)?.assessment?.execution_state).toBe('approved');
 expect(x.resolutions).toEqual([{id:first.authorization_id,decision:'decline'},{id:next.authorization_id,decision:'approve'}]);
});

it('rejects incomplete confirmations and another card’s answers without sending a platform approval',async()=>{
 const x=await setup(),before=await x.view(),first=available(before),waiting=held(before);
 const partial=await x.respond(first,'approve','binary-partial',[]);expect(partial.statusCode,partial.body).toBe(409);
 expect(partial.json().error.code).toBe('G05_QUESTIONS_CHANGED');
 const wrong=await x.respond(first,'approve','binary-wrong-card',waiting.assessment!.questions.map(q=>({question_id:q.question_id,value:'confirm'})));
 expect(wrong.statusCode,wrong.body).toBe(409);expect(x.resolutions).toEqual([]);
 const good=await x.respond(first,'approve','binary-good-after');expect(good.statusCode,good.body).toBe(200);
});
