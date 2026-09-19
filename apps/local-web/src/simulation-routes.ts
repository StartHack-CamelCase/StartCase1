import { createHumanChannel, type HumanChannel } from './human-channel.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../../packages/contracts/src/errors.js';
import type { HumanActor } from '../../../packages/contracts/src/simulation.js';
import type { LocalRuntime } from '../../../packages/local-runtime/src/runtime.js';
import { strictObject, requiredString, stringArray } from './request-validation.js';

export function registerSimulationRoutes(app:FastifyInstance,runtime:()=>LocalRuntime,channel:HumanChannel=createHumanChannel()):void {
 const key=(request:FastifyRequest):string=>{const k=request.headers['idempotency-key'];if(typeof k!=='string'||!/^[A-Za-z0-9._:-]{8,200}$/.test(k))throw new AppError(400,'G01_IDEMPOTENCY_KEY_REQUIRED','An idempotency key is required.');return k;};
 const actor=channel.actor;
 app.get<{Querystring:{mandate_id:string}}>('/api/ui-session',async(req,reply)=>{const m=runtime().policies.getMandate(req.query.mandate_id);const detail=runtime().scenarios.get(m.source_scenario_id);return channel.issue(detail.customer.customer_id,reply);});
 app.get<{Params:{id:string}}>('/api/mandates/:id/safety-configs',async req=>({configs:runtime().simulations.configs(req.params.id)}));
 app.post<{Params:{id:string}}>('/api/mandates/:id/safety-configs',async(req,reply)=>{strictObject(req.body??{},[]);const c=runtime().simulations.suggest(req.params.id,key(req));reply.code(201);return c;});
 app.post<{Params:{id:string}}>('/api/safety-configs/:id/confirm',async req=>{const b=strictObject(req.body,['parameters','reviewed_requirement_ids']);return runtime().simulations.confirm(req.params.id,b['parameters'],stringArray(b['reviewed_requirement_ids'],'reviewed_requirement_ids'),actor(req),key(req));});
 app.get<{Params:{id:string}}>('/api/safety-configs/:id/export',async(req,reply)=>{reply.header('Content-Disposition','attachment; filename=viseca-binding.json');return runtime().simulations.exportConfig(req.params.id);});
 app.get('/api/simulations',async()=>({runs:runtime().simulations.list()}));
 app.post('/api/simulations',async(req,reply)=>{const b=strictObject(req.body,['config_id']);reply.code(201);return runtime().simulations.create(requiredString(b['config_id'],'config_id'),key(req));});
 app.get<{Params:{id:string}}>('/api/simulations/:id',async req=>runtime().simulations.get(req.params.id));
 app.post<{Params:{id:string}}>('/api/simulations/:id/next',async req=>{strictObject(req.body??{},[]);return runtime().simulations.next(req.params.id,key(req));});
 app.post<{Params:{id:string}}>('/api/simulations/:id/config',async req=>{const b=strictObject(req.body,['config_id']);return runtime().simulations.useConfig(req.params.id,requiredString(b['config_id'],'config_id'),key(req),actor(req));});
 app.post<{Params:{id:string;authorizationId:string}}>('/api/simulations/:id/authorizations/:authorizationId/reassess',async req=>{const b=strictObject(req.body,['expected_revision']);if(!Number.isSafeInteger(b['expected_revision']))throw new AppError(400,'REQUEST_INVALID','An integer revision is required.');return runtime().simulations.reevaluate(req.params.id,req.params.authorizationId,b['expected_revision'] as number,key(req));});
 app.post<{Params:{id:string;authorizationId:string}}>('/api/simulations/:id/authorizations/:authorizationId/human-responses',async req=>{
  const b=strictObject(req.body,['expected_revision','offer_hash','answers','question_id','value','source_ref','source_excerpt']);
  if(!Number.isSafeInteger(b['expected_revision']))throw new AppError(400,'REQUEST_INVALID','An integer revision is required.');
  const context={expected_revision:b['expected_revision'] as number,offer_hash:requiredString(b['offer_hash'],'offer_hash')};
  const response=(value:unknown)=>{const answer=strictObject(value,['question_id','value','source_ref','source_excerpt']);return {question_id:requiredString(answer['question_id'],'question_id'),value:requiredString(answer['value'],'value'),...(answer['source_ref']===undefined?{}:{source_ref:requiredString(answer['source_ref'],'source_ref')}),...(answer['source_excerpt']===undefined?{}:{source_excerpt:requiredString(answer['source_excerpt'],'source_excerpt')})};};
  if(Object.hasOwn(b,'answers')){
   if(!Array.isArray(b['answers'])||['question_id','value','source_ref','source_excerpt'].some(field=>Object.hasOwn(b,field)))throw new AppError(400,'RESPONSE_INVALID','Provide an answers list without single-response fields.');
   return runtime().simulations.answerBatch(req.params.id,req.params.authorizationId,{...context,answers:b['answers'].map(response)},actor(req),key(req));
  }
  const {expected_revision:_,offer_hash:__,...single}=b;
  return runtime().simulations.answer(req.params.id,req.params.authorizationId,{...context,...response(single)},actor(req),key(req));
 });
 app.post<{Params:{id:string;authorizationId:string}}>('/api/simulations/:id/authorizations/:authorizationId/cancel',async req=>{strictObject(req.body??{},[]);return runtime().simulations.cancel(req.params.id,req.params.authorizationId,actor(req),key(req));});
 app.post<{Params:{id:string;authorizationId:string}}>('/api/simulations/:id/authorizations/:authorizationId/extractions',async(req,reply)=>{const b=strictObject(req.body??{},['retry']);reply.code(202);key(req);const run=runtime().simulations.get(req.params.id);const p=run.purchases.find(p=>p.event.authorization.authorization_id===req.params.authorizationId);if(!p)throw new AppError(404,'PURCHASE_NOT_FOUND','Achat introuvable.');const a=p.assessments.at(-1)!;return runtime().offers.start({offer_hash:a.offer_hash,sources:p.event.authorization.items.map(i=>({source_ref:`items.${i.line_no}.item_details`,text:i.item_details})),requested_fields:[...new Set(a.questions.filter(q=>q.kind==='provide_evidence').map(q=>q.fact_key))]},b['retry']===true);});
 app.get<{Params:{id:string}}>('/api/offer-extractions/:id',async req=>runtime().offers.get(req.params.id));
 app.get('/api/live/status',async()=>({configured:Boolean(process.env['LEASH_BASE_URL']&&process.env['TEAM_API_KEY']),scope:'viseca_simulator',notice:'Viewing this status does not contact the hosted simulator.'}));
}
