import type {WalletRunView} from '../../../packages/contracts/src/wallet.js';
import {renderPurchaseCard,purchaseSkeleton,runLoading} from './wallet-run-view.js';
import {advanceServerClock,canConfirmQuestions,collectLiveAnswers,confirmationSeconds,countdownText,hasConflictingPurchaseOperation,pendingPurchaseOperation,retryEligible} from './wallet-ui.js';
import type {PendingOperation} from './operation-state.js';

type Options={host:HTMLElement;runId:string;load:()=>Promise<WalletRunView>;openSession:(scenarioId:string)=>Promise<void>;mutate:(path:string,body:unknown)=>Promise<unknown>;pendingRequest:(path:string)=>PendingOperation|null;notice:(error:unknown)=>void;clearNotice:()=>void;onDispose:(dispose:()=>void)=>void};
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(n:string|number)=>new Intl.NumberFormat('en-CH',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n));
const json=(value:unknown)=>`<pre class="json-view">${esc(JSON.stringify(value,null,2))}</pre>`;

export async function mountRunPage(o:Options):Promise<void> {
 let disposed=false,pollTimer:ReturnType<typeof setTimeout>|undefined,countdownTimer:ReturnType<typeof setInterval>|undefined;
 let readSequence=0,scrollFrame=0;
 const listeners=new AbortController();let resize:ResizeObserver|undefined;
 o.onDispose(()=>{disposed=true;clearTimeout(pollTimer);clearInterval(countdownTimer);cancelAnimationFrame(scrollFrame);listeners.abort();resize?.disconnect();});
 o.host.setAttribute('aria-live','off');o.host.innerHTML=runLoading();
 const initialStarted=performance.now();let view=await o.load();if(disposed)return;
 const initialReceived=performance.now();let clockSample={at:initialReceived,server:advanceServerClock(view.server_time,initialStarted,initialReceived,Number.isFinite(Date.parse(view.server_time??''))?0:Date.now())};
 const now=()=>clockSample.server+performance.now()-clockSample.at;
 await o.openSession(view.scenario_id);if(disposed)return;
 const pending=new Set<string>(),reconciling=new Set<string>(),cards=new Map<string,{element:HTMLElement;signature:string}>(),unseen=new Set<string>();
 o.host.innerHTML=`<div class="wallet-flow wallet-run"><a class="back-link" href="/">← Wallet home</a><header class="page-header"><p class="eyebrow">${view.mode==='local'?'Local simulation':'Viseca simulator'}</p><h1>Your agent’s purchase activity</h1><p id="run-status" role="status"></p></header><section class="wallet-summary"><div><span>Approved total · whole run</span><strong id="summary-approved"></strong></div><div><span>Awaiting a decision</span><strong id="summary-waiting"></strong></div><div><span>Purchases checked</span><strong id="summary-count"></strong></div></section><div class="run-toolbar"><details class="technical-details" id="confirmed-permissions"><summary>Your confirmed permissions</summary><div></div></details><a class="button button--secondary" href="/wallet/new?scenario_id=${esc(view.scenario_id)}">Review permissions</a><button class="button button--secondary" id="revoke-wallet">Revoke permissions</button></div><p class="help-text" id="transport-note"></p><section class="purchase-carousel" aria-label="Purchase proposals"><header><div><h2>Purchase proposals</h2><p>Scroll across to review each purchase.</p></div><div class="carousel-controls"><button type="button" class="button button--secondary" id="previous-purchase" aria-label="Previous purchase" aria-controls="purchase-feed">←</button><span class="carousel-position" id="carousel-position"></span><button type="button" class="button button--secondary" id="next-purchase" aria-label="Next purchase" aria-controls="purchase-feed">→</button><button type="button" class="button button--secondary new-purchases" id="new-purchases" hidden></button></div></header><p id="purchase-announcement" class="sr-only" role="status"></p><section class="purchase-feed" id="purchase-feed" tabindex="0" role="region" aria-label="Purchase cards. Use the arrow keys to browse."></section></section><details class="technical-details" id="run-audit"><summary>Audit timeline</summary><div></div></details></div>`;
 const root=o.host.querySelector<HTMLElement>('.wallet-run')!,rail=root.querySelector<HTMLElement>('#purchase-feed')!;
 const waiting=document.createElement('template');waiting.innerHTML=purchaseSkeleton(true);const slot=waiting.content.firstElementChild as HTMLElement;
 const previous=root.querySelector<HTMLButtonElement>('#previous-purchase')!,next=root.querySelector<HTMLButtonElement>('#next-purchase')!,newButton=root.querySelector<HTMLButtonElement>('#new-purchases')!;
 let configSignature='',auditSignature='',initialized=false;
 const text=(selector:string,value:string)=>{const node=root.querySelector<HTMLElement>(selector)!;if(node.textContent!==value)node.textContent=value;};
 const busy=(id:string)=>pending.has(id)||pending.has('*')||(view.mode==='live'&&pending.size>0);
 const actionBlocked=(id:string)=>busy(id)||(id!=='*'&&hasConflictingPurchaseOperation(view.mode,o.runId,id,o.pendingRequest));
 const recoveryFor=(id:string)=>pendingPurchaseOperation(view.mode,o.runId,id,o.pendingRequest);
 function syncTimers(){
  for(const [id,{element}] of cards){
   const timer=element.querySelector<HTMLElement>('.consent-countdown');
   if(timer){const seconds=confirmationSeconds(timer.dataset['expiresAt'],now());const value=countdownText(seconds);const label=seconds===0?'Confirmation expired':'Time left to confirm';
    const valueNode=timer.querySelector<HTMLElement>('.countdown-value')!,labelNode=timer.querySelector<HTMLElement>('.countdown-label')!;
    if(valueNode.textContent!==value)valueNode.textContent=value;if(labelNode.textContent!==label)labelNode.textContent=label;
    timer.dataset['urgent']=String(seconds!==null&&seconds<=30);
    element.querySelectorAll<HTMLButtonElement>('[data-review-action]').forEach(button=>button.disabled=actionBlocked(id)||seconds===null||seconds===0||view.status==='revoked');
   }
   element.setAttribute('aria-busy',String(busy(id)));
   element.querySelectorAll<HTMLButtonElement>('.retry-purchase').forEach(button=>button.disabled=actionBlocked(id));
   element.querySelectorAll<HTMLButtonElement>('.retry-saved-request').forEach(button=>button.disabled=actionBlocked(id));
  }
  root.querySelector<HTMLButtonElement>('#revoke-wallet')!.disabled=pending.size>0||view.status==='revoked';
 }
 function controls(){
  const all=[...cards.values()].map(c=>c.element),bounds=rail.getBoundingClientRect();
  let closest=0,distance=Infinity;
  all.forEach((card,i)=>{const rect=card.getBoundingClientRect(),d=Math.abs(rect.left-bounds.left);if(d<distance){distance=d;closest=i;}if(Math.min(rect.right,bounds.right)-Math.max(rect.left,bounds.left)>rect.width/2)unseen.delete(card.dataset['purchase']!);});
  previous.disabled=rail.scrollLeft<=2;next.disabled=!all.length||all.at(-1)!.getBoundingClientRect().right<=bounds.right+2;
  text('#carousel-position',all.length?`${closest+1} / ${all.length}`:'Waiting for proposals');
  newButton.hidden=unseen.size===0;newButton.textContent=`${unseen.size} new ${unseen.size===1?'purchase':'purchases'} →`;
  return closest;
 }
 function scrollToCard(index:number){const card=[...cards.values()][index]?.element;if(!card)return;const left=rail.scrollLeft+card.getBoundingClientRect().left-rail.getBoundingClientRect().left;rail.scrollTo({left,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
 function audit(){const details=root.querySelector<HTMLDetailsElement>('#run-audit')!;if(!details.open)return;const signature=JSON.stringify(view.audit);if(signature===auditSignature)return;auditSignature=signature;details.querySelector('div')!.innerHTML=json(view.audit.map(a=>({time:a.at,event:a.event,authorization:a.authorization_id,actor:a.actor})));}
 function replaceCard(element:HTMLElement,markup:string,sameOffer:boolean){
  const fields=new Map<string,string>();if(sameOffer)element.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea').forEach(field=>fields.set(field.name,field.value));
  const opened=new Set([...element.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.dataset['detail']));
  const active=document.activeElement,hadFocus=active instanceof HTMLElement&&element.contains(active),focused=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?{name:active.name,start:active.selectionStart,end:active.selectionEnd}:null;
  const scrollTop=element.scrollTop,template=document.createElement('template');template.innerHTML=markup;const replacement=template.content.firstElementChild!;element.innerHTML=replacement.innerHTML;element.setAttribute('aria-label',replacement.getAttribute('aria-label')??'Purchase');
  element.querySelectorAll<HTMLDetailsElement>('details').forEach(d=>d.open=opened.has(d.dataset['detail']));
  let restored=false;element.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea').forEach(field=>{if(fields.has(field.name))field.value=fields.get(field.name)!;if(focused?.name===field.name&&sameOffer){field.focus({preventScroll:true});if(focused.start!==null&&focused.end!==null)field.setSelectionRange(focused.start,focused.end);restored=true;}});
  element.scrollTop=scrollTop;if(hadFocus&&!restored)element.focus({preventScroll:true});
 }
 function cardMarkup(p:WalletRunView['purchases'][number],recovery:PendingOperation|null):string {
  const markup=renderPurchaseCard(p,view.mode,view.status);if(!recovery)return markup;
  const template=document.createElement('template');template.innerHTML=markup;const card=template.content.firstElementChild!;
  card.querySelector('.human-form')?.remove();card.querySelector('.retry-purchase')?.remove();
  card.querySelector('.technical-details')!.insertAdjacentHTML('beforebegin',`<div class="request-recovery"><p>The response to your last request was interrupted. Retry that saved request to recover its result.</p><button type="button" class="button button--secondary retry-saved-request" data-authorization="${esc(p.authorization_id)}">Retry saved request</button></div>`);
  return card.outerHTML;
 }
 function update(v:WalletRunView){
  if(disposed)return;view=v;
  text('#run-status',v.status==='awaiting_customer'?'A purchase needs your review.':v.status==='completed'?'All proposals have been checked.':v.status==='revoked'?'You revoked these permissions.':'Watching for purchase proposals automatically.');
  text('#summary-approved',`CHF ${money(v.approved_chf)}`);text('#summary-waiting',String(v.reservations));text('#summary-count',String(v.purchases.length));
  text('#transport-note',v.transport.note+(v.mode==='live'?` Last poll: ${v.transport.last_status??'waiting'}.`:''));
  const config=JSON.stringify(v.config);if(config!==configSignature){configSignature=config;root.querySelector('#confirmed-permissions div')!.innerHTML=`<blockquote>${esc(v.config.instruction)}</blockquote><p class="mono">Mandate: ${esc(v.mandate_id)}</p><p class="mono">Run: ${esc(v.platform_run_id??v.run_id)}</p>${json(v.config.parameters)}`;}
  const left=rail.scrollLeft;let added=0;
  for(const p of v.purchases){
   const recovery=recoveryFor(p.authorization_id);
   const key=JSON.stringify([p.merchant_name,p.description,p.amount_chf,p.items,p.assessment?.assessment_id,p.assessment?.revision,p.assessment?.execution_state,p.assessment?.decision,p.assessment?.lock?.expires_at,p.platform_status,v.status==='revoked',recovery?.key]);
   const existing=cards.get(p.authorization_id);
   if(existing){if(existing.signature!==key&&!busy(p.authorization_id)){replaceCard(existing.element,cardMarkup(p,recovery),existing.element.dataset['offerHash']===(p.assessment?.offer_hash??''));existing.signature=key;existing.element.dataset['offerHash']=p.assessment?.offer_hash??'';}continue;}
   const template=document.createElement('template');template.innerHTML=cardMarkup(p,recovery);const element=template.content.firstElementChild as HTMLElement;element.tabIndex=-1;element.dataset['offerHash']=p.assessment?.offer_hash??'';
   rail.insertBefore(element,slot.parentNode===rail?slot:null);cards.set(p.authorization_id,{element,signature:key});if(initialized){unseen.add(p.authorization_id);added++;}
  }
  const waitingForMore=v.has_more_proposals??['active','running','awaiting_customer'].includes(v.status);
  if(waitingForMore){if(slot.parentNode!==rail)rail.append(slot);}else slot.remove();
  rail.scrollLeft=left;if(added)text('#purchase-announcement',`${added} new ${added===1?'purchase':'purchases'} received. ${v.purchases.length} total.`);
  initialized=true;syncTimers();controls();audit();
 }
 async function refresh(){const sequence=++readSequence,started=performance.now();try{const result=await o.load();if(disposed||sequence!==readSequence)return;const received=performance.now();clockSample={at:received,server:advanceServerClock(result.server_time,started,received,now())};for(const id of reconciling)pending.delete(id);reconciling.clear();update(result);}catch(error){if(!disposed&&sequence===readSequence)o.notice(error);}}
 async function perform(id:string,work:()=>Promise<unknown>){if(actionBlocked(id)||(id==='*'&&pending.size>0))return;pending.add(id);++readSequence;o.clearNotice();syncTimers();try{await work();}catch(error){if(!disposed)o.notice(error);}finally{if(!disposed){reconciling.add(id);await refresh();}}}
 root.addEventListener('submit',event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement)||!form.matches('.human-form'))return;event.preventDefault();
  const p=view.purchases.find(p=>p.authorization_id===form.dataset['authorization']),a=p?.assessment;if(!p||!a||a.execution_state!=='awaiting_user'||a.decision!=='step_up'||view.status==='revoked')return;
  if((confirmationSeconds(a.lock?.expires_at,now())??0)<=0){syncTimers();return;}
  const questions=a.questions.filter(q=>q.state==='open');if(!canConfirmQuestions(questions))return;
  void perform(p.authorization_id,async()=>{const answers=collectLiveAnswers(new FormData(form),questions);return vMutate(p.authorization_id,a.revision,a.offer_hash,answers);});
 },{signal:listeners.signal});
 function vMutate(authorizationId:string,revision:number,offerHash:string,answers:ReturnType<typeof collectLiveAnswers>){return view.mode==='local'?o.mutate(`/api/simulations/${o.runId}/authorizations/${authorizationId}/human-responses`,{answers,expected_revision:revision,offer_hash:offerHash}):o.mutate(`/api/wallet/runs/${o.runId}/human-responses`,{authorization_id:authorizationId,decision:'approve',answers});}
 root.addEventListener('click',event=>{
  const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button'):null;if(!button||button.disabled)return;
  if(button===previous){scrollToCard(Math.max(0,controls()-1));return;}if(button===next){scrollToCard(Math.min(cards.size-1,controls()+1));return;}
  if(button===newButton){scrollToCard([...cards.keys()].findIndex(id=>unseen.has(id)));return;}
  if(button.id==='revoke-wallet'){void perform('*',()=>o.mutate(`/api/wallet/runs/${o.runId}/revoke`,{}));return;}
  const p=view.purchases.find(p=>p.authorization_id===button.dataset['authorization']);if(!p)return;
  if(button.matches('.retry-saved-request')){const saved=recoveryFor(p.authorization_id);if(saved)void perform(p.authorization_id,()=>o.mutate(saved.path,JSON.parse(saved.body??'{}')));return;}
  if(button.matches('.retry-purchase')&&retryEligible(p.assessment,view.mode)&&view.status!=='revoked'){void perform(p.authorization_id,()=>o.mutate(`/api/simulations/${o.runId}/authorizations/${p.authorization_id}/reassess`,{expected_revision:p.assessment!.revision}));return;}
  if(button.matches('.decline-purchase'))void perform(p.authorization_id,()=>view.mode==='local'?o.mutate(`/api/simulations/${o.runId}/authorizations/${p.authorization_id}/cancel`,{}):o.mutate(`/api/wallet/runs/${o.runId}/human-responses`,{authorization_id:p.authorization_id,decision:'decline',answers:[]}));
 },{signal:listeners.signal});
 rail.addEventListener('scroll',()=>{cancelAnimationFrame(scrollFrame);scrollFrame=requestAnimationFrame(controls);},{passive:true,signal:listeners.signal});
 rail.addEventListener('keydown',event=>{if(event.target!==rail||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();scrollToCard(Math.max(0,Math.min(cards.size-1,controls()+(event.key==='ArrowLeft'?-1:1))));},{signal:listeners.signal});
 root.querySelector('#run-audit')!.addEventListener('toggle',audit,{signal:listeners.signal});
 resize=new ResizeObserver(controls);resize.observe(rail);
 update(view);countdownTimer=setInterval(syncTimers,250);
 const poll=async()=>{await refresh();if(!disposed)pollTimer=setTimeout(()=>void poll(),1500);};pollTimer=setTimeout(()=>void poll(),1500);
 document.title='Purchase activity | Viseca';
}
