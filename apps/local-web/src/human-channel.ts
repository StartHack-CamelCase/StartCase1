import { randomBytes } from 'node:crypto';
import type { FastifyReply,FastifyRequest } from 'fastify';
import type { HumanActor } from '../../../packages/contracts/src/simulation.js';
import { AppError } from '../../../packages/contracts/src/errors.js';
export function createHumanChannel(){
 const sessions=new Map<string,{actor:HumanActor;csrf:string;expires:number}>();
 return {
 issue(customerId:string,reply:FastifyReply){
  for(const [key,s] of sessions)if(s.expires<=Date.now())sessions.delete(key);
  const id=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  const actor:HumanActor={actor_id:'LOCAL_UI_'+customerId,role:'simulated_human',customer_id:customerId,channel:'local_ui',authenticated_by_server:true};
  sessions.set(id,{actor,csrf,expires:Date.now()+3600000});reply.header('Set-Cookie',`viseca_ui=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);reply.header('Cache-Control','no-store');return {csrf,actor,mode:'human_simulation',notice:'Demo customer confirmation. This is not bank identity verification.'};
 },
 actor(request:FastifyRequest):HumanActor{const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('viseca_ui='))?.slice('viseca_ui='.length);const session=token?sessions.get(token):undefined;if(!session||session.expires<=Date.now()||request.headers['x-csrf-token']!==session.csrf)throw new AppError(403,'G03_HUMAN_CHANNEL_REQUIRED','Open the customer confirmation page before responding.');return session.actor;}
 };
}
export type HumanChannel=ReturnType<typeof createHumanChannel>;
