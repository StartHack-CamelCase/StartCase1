import type { Assessment } from '../../../packages/contracts/src/simulation.js';
import type {PendingOperation} from './operation-state.js';
export function pendingPurchaseOperation(mode:string,runId:string,authorizationId:string,find:(path:string)=>PendingOperation|null):PendingOperation|null {
 const paths=mode==='live'?[`/api/wallet/runs/${runId}/human-responses`]:['human-responses','reassess','cancel'].map(action=>`/api/simulations/${runId}/authorizations/${authorizationId}/${action}`);
 for(const path of paths){const operation=find(path);if(operation&&(mode!=='live'||JSON.parse(operation.body??'{}').authorization_id===authorizationId))return operation;}
 return null;
}
export function hasConflictingPurchaseOperation(mode:string,runId:string,authorizationId:string,find:(path:string)=>PendingOperation|null):boolean {
 if(mode!=='live')return false;
 const operation=find(`/api/wallet/runs/${runId}/human-responses`);
 return operation!==null&&JSON.parse(operation.body??'{}').authorization_id!==authorizationId;
}
export function advanceServerClock(serverTime:string|undefined,started:number,received:number,previous:number):number {
 const server=Date.parse(serverTime??'');
 // Count transit time conservatively; a delayed snapshot must never extend consent.
 return Number.isFinite(server)?Math.max(previous,server+Math.max(0,received-started)):previous;
}
export function confirmationSeconds(expiresAt:string|null|undefined,now=Date.now()):number|null {
 if(!expiresAt)return null;
 const deadline=Date.parse(expiresAt);
 return Number.isFinite(deadline)?Math.max(0,Math.ceil((deadline-now)/1000)):null;
}
export function countdownText(seconds:number|null):string {
 if(seconds===null)return '—';
 return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
}
export function canConfirmQuestions(questions:ReadonlyArray<{kind:string}>):boolean {
 return questions.length>0&&questions.every(q=>['confirm_risk','provide_evidence','choose_variant'].includes(q.kind));
}
export function retryEligible(a:Assessment|null,mode:string):boolean{return mode==='local'&&!!a&&['expired','technical_hold'].includes(a.execution_state)&&a.decision!=='approve';}
export function collectLiveAnswers(data:FormData,questions:ReadonlyArray<{question_id:string;kind:string}>){return questions.map(q=>{
 if(q.kind==='confirm_risk')return {question_id:q.question_id,value:'confirm'};
 if(!['provide_evidence','choose_variant'].includes(q.kind))throw Error('This purchase needs a corrected quote, permissions, or service before confirmation.');
 const value=String(data.get(`value:${q.question_id}`)??'').trim();const source_ref=String(data.get(`source_ref:${q.question_id}`)??'').trim();const source_excerpt=String(data.get(`source_excerpt:${q.question_id}`)??'').trim();
 if(!value||!source_ref||!source_excerpt)throw Error('Provide a verified value and its source for every question before confirming.');
 return {question_id:q.question_id,value,source_ref,source_excerpt};
});}

export function parsePermissionJson(text:string):Record<string,unknown> {
 let value:unknown;
 try{value=JSON.parse(text);}catch{throw Error('Invalid JSON. Fix the syntax before confirming.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Permission JSON must be an object.');
 return value as Record<string,unknown>;
}
