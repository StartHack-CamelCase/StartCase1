import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { WalletMode } from '../../../packages/contracts/src/wallet.js';
import type { LiveHumanResponse } from '../../../packages/local-runtime/src/services/wallet-service.js';
import type { LocalRuntime } from '../../../packages/local-runtime/src/runtime.js';
import type { HumanChannel } from './human-channel.js';
import { AppError } from '../../../packages/contracts/src/errors.js';
import { strictObject,requiredString } from './request-validation.js';
import type { BehaviorControlRequest,BehaviorFeedbackRequest } from '../../../packages/contracts/src/behavior-dashboard.js';
export function registerWalletRoutes(app:FastifyInstance,runtime:()=>LocalRuntime,channel:HumanChannel):void{
 const key=(req:FastifyRequest)=>{const value=req.headers['idempotency-key'];if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{8,200}$/.test(value))throw new AppError(400,'G01_IDEMPOTENCY_KEY_REQUIRED','A request key is required.');return value;};
 const selectedMode=(req:FastifyRequest):WalletMode|undefined=>{const m=(req.query as Record<string,unknown>)['mode'];if(m===undefined)return undefined;if(m!=='local'&&m!=='live')throw new AppError(400,'mode_invalid','Choose offline or online.');return m;};
 const assertMode=(req:FastifyRequest,mode:unknown)=>{const selected=selectedMode(req);if(selected!==undefined&&mode!==selected)throw new AppError(404,'mode_resource_not_found','This item belongs to another data mode.');};
 // Reject stale tabs before reading or mutating data from the other source.
 app.addHook('preHandler',async req=>{
  if(!req.url.startsWith('/api/wallet/'))return;
  const selected=selectedMode(req);if(selected===undefined)return;
  const pathname=req.url.split('?')[0]!;
  const run=pathname.match(/^\/api\/wallet\/runs\/([^/]+)/);
  const prep=pathname.match(/^\/api\/wallet\/preparations\/([^/]+)/);
  if(run)assertMode(req,runtime().wallet.getRun(decodeURIComponent(run[1]!)).mode);
  if(prep)assertMode(req,runtime().wallet.getPreparation(decodeURIComponent(prep[1]!)).mode);
  if(pathname==='/api/wallet/prepare')assertMode(req,(req.body as Record<string,unknown>|null)?.['mode']);
  if(pathname.startsWith('/api/wallet/profiles/'))assertMode(req,req.method==='GET'?(req.query as Record<string,unknown>)['scope']:(req.body as Record<string,unknown>|null)?.['scope']);
 });
 app.get('/api/wallet/api-starts',async req=>({starts:selectedMode(req)==='local'?[]:runtime().wallet.apiStarts()}));
 app.post<{Params:{id:string}}>('/api/wallet/preparations/:id/reconcile',async req=>{key(req);strictObject(req.body??{},[]);return runtime().wallet.reconcilePreparation(req.params.id,channel.actor(req));});
 app.get('/api/wallet/options',async()=>runtime().wallet.options());
 app.get('/api/wallet/profiles',async()=>({profiles:runtime().wallet.behavior.options()}));
 app.get<{Querystring:{scenario_id:string;scope:string}}>('/api/wallet/profiles/detail',async req=>{if(req.query.scope!=='local'&&req.query.scope!=='live')throw new AppError(400,'PROFILE_SCOPE_INVALID','Choose local or live.');return runtime().wallet.behavior.detail(requiredString(req.query.scenario_id,'scenario_id'),req.query.scope);});
 app.post('/api/wallet/profiles/control',async req=>{const b=strictObject(req.body,['scenario_id','scope','filter_id','context_key','action','expected_revision']);const actor=channel.actor(req);const requestKey=key(req);const input={scenario_id:requiredString(b['scenario_id'],'scenario_id'),scope:b['scope'],filter_id:b['filter_id'],context_key:requiredString(b['context_key'],'context_key'),action:b['action'],expected_revision:b['expected_revision']} as BehaviorControlRequest;return runtime().wallet.behavior.control(input,actor,requestKey);});
 app.post('/api/wallet/profiles/feedback',async req=>{const b=strictObject(req.body,['scenario_id','scope','authorization_id','filter_id','verdict','expected_revision']);return runtime().wallet.behavior.feedback({scenario_id:requiredString(b['scenario_id'],'scenario_id'),scope:b['scope'],authorization_id:requiredString(b['authorization_id'],'authorization_id'),filter_id:b['filter_id'],verdict:b['verdict'],expected_revision:b['expected_revision']} as BehaviorFeedbackRequest,channel.actor(req),key(req));});
 app.get<{Querystring:{scenario_id:string}}>('/api/wallet/session',async(req,reply)=>channel.issue(runtime().wallet.actorCustomer(req.query.scenario_id),reply,req));
 app.post('/api/wallet/prepare',async(req,reply)=>{const b=strictObject(req.body,['scenario_id','instruction','mode']);const a=channel.actor(req);const scenario_id=requiredString(b['scenario_id'],'scenario_id');if(a.customer_id!==runtime().wallet.actorCustomer(scenario_id))throw new AppError(403,'customer_mismatch','Open this scenario before preparing permissions.');if(b['mode']!=='local'&&b['mode']!=='live')throw new AppError(400,'mode_invalid','Choose local simulation or Viseca.');const p=runtime().wallet.prepare({scenario_id,instruction:requiredString(b['instruction'],'instruction'),mode:b['mode']},key(req));reply.code(202);return p;});
 app.get<{Params:{id:string}}>('/api/wallet/preparations/:id',async req=>runtime().wallet.getPreparation(req.params.id));
 app.post<{Params:{id:string}}>('/api/wallet/preparations/:id/confirm',async req=>{key(req);const b=strictObject(req.body,['confirmed','parameters','mode']);if(b['confirmed']!==true)throw new AppError(422,'customer_confirmation_required','Please review the permissions and confirm before starting.');const values=b['parameters'];if(values===null||typeof values!=='object'||Array.isArray(values))throw new AppError(400,'parameters_invalid','Permission JSON must be an object.');if(b['mode']!==undefined&&b['mode']!=='local'&&b['mode']!=='live')throw new AppError(400,'mode_invalid','Choose offline or online.');return runtime().wallet.confirm(req.params.id,values as Record<string,unknown>,channel.actor(req),b['mode']);});
 app.get('/api/wallet/runs',async req=>({runs:runtime().wallet.listRuns().filter(run=>selectedMode(req)===undefined||run.mode===selectedMode(req))}));
 app.get<{Params:{id:string}}>('/api/wallet/runs/:id',async req=>runtime().wallet.getRun(req.params.id));
 app.post<{Params:{id:string}}>('/api/wallet/runs/:id/revoke',async req=>{strictObject(req.body??{},[]);return runtime().wallet.revoke(req.params.id,channel.actor(req),key(req));});
 app.post<{Params:{id:string}}>('/api/wallet/runs/:id/human-responses/reconcile',async req=>{if(runtime().wallet.getRun(req.params.id).mode!=='live')throw new AppError(409,'wallet_run_mode_mismatch','Choose an online run.');return runtime().wallet.reconcileLiveResponse(req.params.id,responseInput(req.body),channel.actor(req),key(req));});
 app.post<{Params:{id:string}}>('/api/wallet/runs/:id/human-responses',async req=>{if(runtime().wallet.getRun(req.params.id).mode!=='live')throw new AppError(409,'wallet_run_mode_mismatch','Choose an online run.');return runtime().wallet.respondLive(req.params.id,responseInput(req.body),channel.actor(req),key(req));});
}

function responseInput(body:unknown):LiveHumanResponse {
 const b=strictObject(body,['authorization_id','decision','answers','offer_hash','expected_revision']);if(b['decision']!=='approve'&&b['decision']!=='decline')throw new AppError(400,'decision_invalid','Choose approve or decline.');if(!Array.isArray(b['answers']))throw new AppError(400,'answers_invalid','Responses must be a list.');const answers=b['answers'].map(value=>{const a=strictObject(value,['question_id','value','source_ref','source_excerpt']);return {question_id:requiredString(a['question_id'],'question_id'),value:requiredString(a['value'],'value'),...(a['source_ref']===undefined?{}:{source_ref:requiredString(a['source_ref'],'source_ref')}),...(a['source_excerpt']===undefined?{}:{source_excerpt:requiredString(a['source_excerpt'],'source_excerpt')})};});
 return {authorization_id:requiredString(b['authorization_id'],'authorization_id'),decision:b['decision'],...(b['decision']==='approve'?{offer_hash:requiredString(b['offer_hash'],'offer_hash'),expected_revision:typeof b['expected_revision']==='number'?b['expected_revision']:-1}:{}),answers};
}
