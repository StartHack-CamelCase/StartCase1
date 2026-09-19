import type { WalletRunView } from '../../../packages/contracts/src/wallet.js';
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
 return questions.length>0&&questions.every(q=>q.kind==='confirm_risk'||q.kind==='confirm_requirement');
}
export function retryEligible(a:Assessment|null,mode:string):boolean{return mode==='local'&&!!a&&['expired','technical_hold'].includes(a.execution_state)&&a.decision!=='approve';}
export function collectLiveAnswers(questions:ReadonlyArray<{question_id:string;kind:string}>){
 if(!canConfirmQuestions(questions))throw Error('This purchase needs verification, a corrected quote, permissions, or service before confirmation.');
 return questions.map(q=>({question_id:q.question_id,value:'confirm'}));
}
export function purchaseReviewSnapshot(a:Pick<Assessment,'revision'|'offer_hash'|'questions'>):string {
 return JSON.stringify([a.revision,a.offer_hash,a.questions.filter(q=>q.state==='open').map(q=>[q.question_id,q.kind,q.prompt])]);
}
/** A binary answer belongs only to the card and exact review currently shown. */
export function purchaseConfirmation(view:WalletRunView,authorizationId:string|undefined,snapshot:string|undefined){
 if(!allowsPurchaseResponse(view))return null;
 const purchase=view.purchases.find(p=>p.authorization_id===authorizationId),assessment=purchase?.assessment;
 if(!purchase||!assessment||assessment.execution_state!=='awaiting_user'||assessment.decision!=='step_up'||snapshot!==purchaseReviewSnapshot(assessment))return null;
 const questions=assessment.questions.filter(q=>q.state==='open');
 if(!canConfirmQuestions(questions))return null;
 return {purchase,assessment,answers:collectLiveAnswers(questions)};
}

export function parsePermissionJson(text:string):Record<string,unknown> {
 let value:unknown;
 try{value=JSON.parse(text);}catch{throw Error('Invalid JSON. Fix the syntax before confirming.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Permission JSON must be an object.');
 return value as Record<string,unknown>;
}

export function runStatusText(status:string):string {
 return ({awaiting_customer:'A purchase needs your review.',revocation_pending:'Revocation is being confirmed. New approvals are paused.',revocation_unknown:'The API has not confirmed revocation. New approvals remain paused; check the saved status before proceeding.',reconciliation_required:'Purchase history is incomplete. Processing is paused until the API records can be reconciled.',completed:'All proposals have been checked.',revoked:'You revoked these permissions.',connection_interrupted:'Connection interrupted. Your decisions are saved; the app is reconnecting.',submission_unknown:'Waiting for the API to confirm a submitted decision. It will not be sent twice.',authentication_required:'The API rejected the team credential. Correct the server configuration and restart.',queue_conflict:'Another run is using this team queue. Processing has stopped to avoid consuming its purchases.',failed:'The API run stopped. Review the saved activity.',cancelled:'The API run was cancelled.'} as Record<string,string>)[status]??'Watching for purchase proposals automatically.';
}
export function allowsPurchaseResponse(view:{mode:string;status:string;mandate_status?:string}):boolean {
 if(view.mode==='local')return view.status!=='revoked';
 return ['active','running','awaiting_customer'].includes(view.status)&&(!view.mandate_status||view.mandate_status==='active');
}
export function liveApprovalBody(authorizationId:string,assessment:Pick<Assessment,'revision'|'offer_hash'>,answers:ReturnType<typeof collectLiveAnswers>){
 return {authorization_id:authorizationId,decision:'approve' as const,offer_hash:assessment.offer_hash,expected_revision:assessment.revision,answers};
}

/** Expiry can change the displayed outcome without incrementing its revision. */
export function runRenderSignature(view: WalletRunView): string {
 return JSON.stringify({ status: view.status, mandate_status: view.mandate_status, config_revision: view.config.revision, approved: view.approved_chf, purchases: view.purchases.map(purchase => [purchase.authorization_id, purchase.assessment?.revision, purchase.assessment?.execution_state, purchase.assessment?.decision, purchase.platform_status]), reservations: view.reservations, transport: view.mode === 'live' ? [view.transport.last_status, view.transport.last_error] : null });
}
