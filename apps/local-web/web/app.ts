import {OperationJournal,journaledMutation} from './operation-state.js';
import type {WalletPreparation,WalletRunView} from '../../../packages/contracts/src/wallet.js';
import type {RunView} from '../../../packages/contracts/src/index.js';
import {parsePermissionJson} from './wallet-ui.js';
import {renderPermissionHighlights} from './permission-review-view.js';
import {amountClarifications,applyAmountChoices,isAmountChoice,renderAmountChoiceNotes,renderAmountReview,restoreAmountChoices,selectAmountChoice,validateAmountChoices} from './monetary-review.js';
import {mountRunPage} from './wallet-run-controller.js';
import {mountBehaviorProfilesPage} from './behavior-profiles-controller.js';
import {mountFilterDocumentationPage} from './filter-documentation-view.js';
import type {BehaviorProfileDashboard,BehaviorProfileOption} from '../../../packages/contracts/src/behavior-dashboard.js';
import {habitLearningPreference,setHabitLearningPreference} from './behavior-learning-ui.js';
import {PageRequestScope,connectionLabel,modeLanding,modeStorage,preparationMatches,readDataMode,saveDataMode,type DataMode,type LiveEnvironment} from './data-mode.js';
const app=document.querySelector<HTMLElement>('#app')!;
const flash=document.querySelector<HTMLElement>('#flash-region')!;
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(n:string|number)=>new Intl.NumberFormat('en-CH',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n));
let timer:ReturnType<typeof setTimeout>|undefined;
let disposePage:(()=>void)|undefined;
let current:PageContext|undefined;
let dataMode=readDataMode(localStorage);
let environment:LiveEnvironment='disabled';
type Options={scenarios:Array<{scenario_id:string;scenario_name:string;instruction:string}>;model:string;ai_configured:boolean;live_configured:boolean;live_environment:LiveEnvironment};
type ApiStart={preparation_id:string|null;session_id:string;scenario_id:string;stage:string;status:string;retryable:boolean;last_error:string|null};
class ApiError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
class PageContext extends PageRequestScope {
 readonly storage:ReturnType<typeof modeStorage>;
 readonly journal:OperationJournal;
 private csrf='';
 constructor(mode:DataMode){super(mode);this.storage=modeStorage(sessionStorage,mode);this.journal=new OperationJournal(this.storage);}
 async api<T>(path:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{response=await this.request(path,init);}catch(error){this.assertActive();throw error instanceof DOMException&&error.name==='AbortError'?error:new Error('Connection interrupted. Retry this request to recover its result.');}
  const body=await response.json().catch(()=>({}));this.assertActive();
  if(!response.ok)throw new ApiError(response.status,body.error?.code??'request_failed',body.error?.message??'The request could not be completed.');return body as T;
 }
 async session(scenarioId:string){this.csrf=(await this.api<{csrf:string}>(`/api/wallet/session?scenario_id=${encodeURIComponent(scenarioId)}`)).csrf;}
 async mutate<T>(path:string,body:unknown):Promise<T>{
  this.assertActive();const humanResponse=/^\/api\/wallet\/runs\/[^/]+\/human-responses$/.test(path);
  return journaledMutation(this.journal,path,body,async operation=>{try{return await this.api<T>(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':operation.key,'x-csrf-token':this.csrf},body:operation.body});}catch(error){if(error instanceof ApiError&&error.status<500)this.journal.acknowledged(operation);throw error;}},humanResponse?async previous=>{
   const recovery=await this.api<{status:'settled'|'abandoned'|'pending'}>(`${path}/reconcile`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':previous.key,'x-csrf-token':this.csrf},body:previous.body});
   if(recovery.status==='pending')throw Error('The API has not confirmed the previous response. Check its saved status before changing your decision.');
   const samePurchase=JSON.parse(previous.body!).authorization_id===(body as {authorization_id:string}).authorization_id;
   return {allowNext:recovery.status==='abandoned'||!samePurchase};
  }:undefined);
 }
}
function updateConnection(){
 const toggle=document.querySelector<HTMLButtonElement>('#data-mode-switch')!;toggle.setAttribute('aria-checked',String(dataMode==='live'));
 document.querySelector('#data-mode-status')!.textContent=connectionLabel(dataMode,environment);
 document.querySelector('#offline-mode-label')!.classList.toggle('active',dataMode==='local');document.querySelector('#online-mode-label')!.classList.toggle('active',dataMode==='live');
 const heading=document.querySelector('#data-mode-heading'),description=document.querySelector('#data-mode-description');
 if(heading)heading.textContent=dataMode==='local'?'Offline · Replay local purchases':environment==='mock'?'Online · Test with the local API emulator':environment==='disabled'?'Online · API access is not configured':'Online · Run through the Viseca test API';
 if(description)description.textContent=dataMode==='local'?'Purchases come from the local demo data. Checks and decisions stay on this computer; nothing is sent to the Viseca API.':environment==='mock'?'Purchases come from an API emulator on this computer. Decisions and your confirmations are sent to that emulator. No remote Viseca connection is used.':environment==='disabled'?'Online runs cannot start until API access is configured on the server. Choose Offline to replay local purchases.':'Purchases come from the remote Viseca test API. Decisions and your confirmations are sent back to it; approvals count after the API accepts them. Internet access is required.';
 document.querySelector('#environment-footer')!.textContent=dataMode==='local'?'Synthetic data · Offline local simulation · No real payments':environment==='mock'?'Synthetic data · Local API emulator · No real payments':environment==='disabled'?'Synthetic data · API not configured · No real payments':'Synthetic data · Viseca API simulator · No real payments';
}
function notice(ctx:PageContext,error:unknown){if(!ctx.active)return;const message=error instanceof Error?error.message:'Please try again.';flash.innerHTML=`<div class="notice notice--warning" role="status"><p>${esc(message)}</p></div>`;}
async function action(ctx:PageContext,button:HTMLButtonElement,work:()=>Promise<void>){if(!ctx.active)return;button.disabled=true;flash.innerHTML='';try{await work();}catch(error){notice(ctx,error);}finally{if(ctx.active)button.disabled=false;}}
function json(value:unknown){return `<pre class="json-view">${esc(JSON.stringify(value,null,2))}</pre>`;}
function navigate(ctx:PageContext,url:string){ctx.assertActive();location.href=url;}
async function route(){
 // Fragment navigation within the guide must preserve the current search and open entries.
 if(location.pathname==='/documentation/filters'&&current?.active&&current.mode===dataMode&&app.querySelector('.filter-doc'))return;
 current?.dispose();clearTimeout(timer);disposePage?.();disposePage=undefined;
 const ctx=new PageContext(dataMode);current=ctx;updateConnection();app.setAttribute('aria-live','polite');app.setAttribute('aria-busy','true');app.innerHTML='<p class="help-text" role="status">Loading your selected data…</p>';flash.innerHTML='';
 try{
  const p=location.pathname.split('/').filter(Boolean);
  const documentation=location.pathname==='/documentation/filters';
  const modeGuide=document.querySelector<HTMLElement>('.mode-guide');if(modeGuide)modeGuide.hidden=documentation;
  for(const [id,active] of [['nav-scenarios',!documentation&&location.pathname!=='/wallet/profiles'],['nav-profiles',location.pathname==='/wallet/profiles'],['nav-documentation',documentation]] as const){const link=document.querySelector(`#${id}`);if(active)link?.setAttribute('aria-current','page');else link?.removeAttribute('aria-current');}
  if(!p.length||location.pathname==='/wallet')await home(ctx);
  else if(documentation){disposePage=mountFilterDocumentationPage(app);void options(ctx).catch(()=>{});}
  else if(location.pathname==='/wallet/profiles')await profilesPage(ctx);
  else if(location.pathname==='/wallet/new'||p[0]==='scenarios')await wizard(ctx,p[0]==='scenarios'?p[1]:undefined);
  else if(p[0]==='wallet'&&p[1]==='runs'&&p[2])await runPage(ctx,p[2]);
  else if(p[0]==='simulations'&&p[1])await runPage(ctx,p[1]);
  else if(p[0]==='runs'&&p[1])await inspection(ctx,p[1]);
  else if(p[0]==='safety')app.innerHTML='<h1>Review your spending permissions</h1><p>Start the permission review from a scenario.</p><a class="button" href="/">Choose a scenario</a>';
  else throw Error('This page could not be found.');
 }catch(error){if(!ctx.active)return;app.innerHTML='<section class="panel"><div class="panel__body"><h1>Let’s reconnect</h1><p>The page could not be loaded. Your saved activity is preserved.</p><button class="button" id="reload-page">Try again</button><a class="button button--secondary" href="/">Wallet home</a></div></section>';notice(ctx,error);document.querySelector('#reload-page')?.addEventListener('click',()=>void route());}
 finally{if(ctx.active)app.setAttribute('aria-busy','false');}
}
async function options(ctx:PageContext){const result=await ctx.api<Options>('/api/wallet/options');environment=result.live_environment??'disabled';updateConnection();return result;}
async function home(ctx:PageContext){
 const [o,recent,pending]=await Promise.all([options(ctx),ctx.api<{runs:WalletRunView[]}>('/api/wallet/runs'),ctx.mode==='live'?ctx.api<{starts:ApiStart[]}>('/api/wallet/api-starts'):Promise.resolve({starts:[]})]);ctx.assertActive();
 const runs=recent.runs.filter(run=>run.mode===ctx.mode);
 document.title='Wallet control | Viseca';
 app.innerHTML=`<header class="wallet-hero"><p class="eyebrow">Your agent. Your rules.</p><h1>Shop with confidence.<br>Stay in control.</h1><p>Tell us what your agent can buy. Review the permissions once. We check every purchase and ask you only when it matters.</p><a class="button" href="/wallet/new?scenario_id=${esc(o.scenarios[0]?.scenario_id??'SCEN0001')}">Set my spending permissions</a><a class="profile-home-link" href="/wallet/profiles">View my profiles →</a></header><section class="section-block"><div class="section-heading"><h2>Try a shopping scenario</h2><p>${ctx.mode==='local'?'Offline scenarios and local purchase data.':environment==='mock'?'API scenarios run against the local emulator.':'Online scenarios use the Viseca API.'}</p></div>${ctx.mode==='live'&&!o.live_configured?'<p class="notice notice--warning">API access is not configured. Enable it on the server to start an online run, or switch to Offline to use local data.</p>':''}<div class="wallet-options">${o.scenarios.map(s=>`<a class="wallet-option" href="/wallet/new?scenario_id=${esc(s.scenario_id)}"><span class="mono">${esc(s.scenario_id)}</span><strong>${esc(s.scenario_name)}</strong><span>${esc(s.instruction)}</span><span class="wallet-option__action">Review permissions →</span></a>`).join('')}</div></section><section class="section-block"><h2>Your recent ${ctx.mode==='local'?'offline':'online'} activity</h2>${runs.length?`<div class="wallet-options">${runs.map(r=>`<a class="wallet-option" href="/wallet/runs/${esc(r.run_id)}"><strong>${esc(r.scenario_id)} · ${ctx.mode==='local'?'Local simulation':'Viseca API'}</strong><span>${esc(r.status.replaceAll('_',' '))} · CHF ${money(r.approved_chf)} approved</span></a>`).join('')}</div>`:'<p class="help-text">No activity in this data source yet.</p>'}</section>`;
 renderApiStarts(ctx,pending.starts);
}
function renderApiStarts(ctx:PageContext,starts:ApiStart[]){
 if(ctx.mode!=='live'||!starts.length)return;
 const section=document.createElement('section');section.className='section-block';
 section.innerHTML=`<h2>API starts to review</h2>${starts.map(s=>`<article class="panel"><div class="panel__body"><h3>${esc(s.scenario_id)}</h3><p>${s.retryable?'The start was not completed. Review your saved permissions before retrying.':'The API outcome is uncertain. Check its saved status before starting another run.'}</p><p class="mono">${esc(s.status)} · ${esc(s.stage)}</p>${s.preparation_id?`<button class="button" data-check-start="${esc(s.preparation_id)}" data-scenario="${esc(s.scenario_id)}">Check API status</button>${s.retryable?` <button class="button button--secondary" data-review-start="${esc(s.preparation_id)}" data-scenario="${esc(s.scenario_id)}">Review and retry</button>`:''}`:''}</div></article>`).join('')}`;
 app.append(section);
 section.querySelectorAll<HTMLButtonElement>('[data-check-start]').forEach(button=>button.addEventListener('click',()=>void action(ctx,button,async()=>{await ctx.session(button.dataset['scenario']!);const result=await ctx.mutate<{run_id:string|null}>(`/api/wallet/preparations/${encodeURIComponent(button.dataset['checkStart']!)}/reconcile`,{});if(result.run_id)navigate(ctx,`/wallet/runs/${encodeURIComponent(result.run_id)}`);else await home(ctx);})));
 section.querySelectorAll<HTMLButtonElement>('[data-review-start]').forEach(button=>button.addEventListener('click',()=>{ctx.assertActive();const scenario=button.dataset['scenario']!;ctx.storage.setItem(`wallet-preparation:${scenario}`,button.dataset['reviewStart']!);navigate(ctx,`/wallet/new?scenario_id=${encodeURIComponent(scenario)}`);}));
}
async function wizard(ctx:PageContext,preselected?:string){
 const o=await options(ctx);
 const requested=preselected??new URLSearchParams(location.search).get('scenario_id');const scenario=o.scenarios.find(s=>s.scenario_id===requested)??o.scenarios[0];
 if(!scenario)throw Error('No scenarios are available in this data source.');const id=scenario.scenario_id;
 await ctx.session(id);
 const savedId=ctx.storage.getItem(`wallet-preparation:${id}`);let restored:WalletPreparation|null=null;
 if(savedId){try{restored=await ctx.api<WalletPreparation>(`/api/wallet/preparations/${encodeURIComponent(savedId)}`);}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;ctx.storage.removeItem(`wallet-preparation:${id}`);}}
 ctx.assertActive();
 const saved=ctx.storage.getItem(`wallet-instruction:${id}`);let revision=0;
 app.innerHTML=`<div class="wallet-flow"><a class="back-link" href="/">← All scenarios</a><div class="flow-steps" aria-label="Progress"><span class="active">1 · Your instruction</span><span>2 · Review permissions</span><span>3 · Purchase activity</span></div><header class="page-header"><h1>What can your agent buy?</h1><p>${esc(scenario.scenario_name)} · Describe the limits. You will review everything before it starts.</p><p class="help-text">The scenario supplies the simulated purchases. Your instruction defines what is allowed.</p></header><section class="panel wallet-form"><p class="data-source-summary">${esc(connectionLabel(ctx.mode,environment))}</p><label for="wallet-instruction">Your instruction</label><textarea id="wallet-instruction" rows="5">${esc(saved??restored?.instruction??scenario.instruction)}</textarea><p class="help-text">${o.ai_configured?'Each new decoding sends your instruction to OpenAI. Review the resulting permissions before starting.':'OpenAI decoding is not configured. Configure OpenAI before preparing permissions.'}</p><p class="help-text">Price limits without a currency use CHF.</p>${ctx.mode==='live'&&!o.live_configured?'<p class="notice notice--warning">API access is not configured. Switch to Offline to work with local data.</p>':''}<button class="button" id="prepare-wallet" ${ctx.mode==='live'&&!o.live_configured?'disabled':''}>Decode instruction</button><div id="wallet-prepare-recovery"></div><p id="wallet-status" role="status" aria-live="polite"></p></section><div id="wallet-prep"></div></div>`;
 document.title='Your permissions | Viseca';
 const input=document.querySelector<HTMLTextAreaElement>('#wallet-instruction')!,status=document.querySelector<HTMLElement>('#wallet-status')!,host=document.querySelector<HTMLElement>('#wallet-prep')!,button=document.querySelector<HTMLButtonElement>('#prepare-wallet')!,recoveryHost=document.querySelector<HTMLElement>('#wallet-prepare-recovery')!;
 const expected=()=>({scenario_id:id,instruction:input.value,mode:ctx.mode});
 const invalidate=()=>{revision++;clearTimeout(timer);host.innerHTML='';ctx.storage.removeItem(`wallet-preparation:${id}`);status.textContent='Settings changed. Decode your instruction again before confirming.';};
 input.addEventListener('input',()=>{if(!ctx.active)return;ctx.storage.setItem(`wallet-instruction:${id}`,input.value);invalidate();});
 const poll=async(preparationId:string,version:number,settings:ReturnType<typeof expected>):Promise<void>=>{
  if(!ctx.active||version!==revision)return;
  const preparation=await ctx.api<WalletPreparation>(`/api/wallet/preparations/${encodeURIComponent(preparationId)}`);
  if(!ctx.active||version!==revision)return;
  if(!preparationMatches(preparation,settings))throw Error('The saved review does not match this data source and instruction. Decode your instruction again.');
  if(preparation.status==='processing'){status.textContent='Reading your instruction and checking its meaning…';timer=setTimeout(()=>void poll(preparationId,version,settings).catch(error=>{if(version===revision)notice(ctx,error);}),900);return;}
  status.textContent=preparation.status==='ready'?(amountClarifications(preparation.clarifications).length?'Clarification required. Choose what each quoted amount means before confirming.':preparation.clarifications.some(c=>c.key.startsWith('unresolved:')&&c.resolution!=='purchase_review')?'The decoder could not map every constraint to an executable rule. See the details below.':'Ready to review. Nothing starts until you confirm.'):'Your instruction is saved. You can try decoding again.';
  renderPreparation(ctx,preparation,()=>ctx.active&&version===revision&&preparationMatches(preparation,expected()),decodeAgain);
 };
 const submit=async(body:ReturnType<typeof expected>)=>{
  const version=++revision;clearTimeout(timer);host.innerHTML='';status.textContent='OpenAI is reading your instruction and checking its meaning…';
  try{const preparation=await ctx.mutate<WalletPreparation>('/api/wallet/prepare',body);if(!ctx.active||version!==revision)return;ctx.storage.setItem(`wallet-preparation:${id}`,preparation.preparation_id);await poll(preparation.preparation_id,version,body);}
  finally{if(ctx.active)renderRecovery();}
 };
 const renderRecovery=()=>{
  const pending=ctx.journal.pending('/api/wallet/prepare');
  recoveryHost.innerHTML=pending?'<aside class="notice notice--warning"><p>A preparation request was interrupted. Resume its saved settings, or discard it to use your current settings. Preparing permissions does not start a run.</p><button class="button button--secondary" id="resume-preparation">Resume saved preparation</button> <button class="button button--secondary" id="discard-preparation">Discard saved preparation</button></aside>':'';
  if(!pending)return;
  recoveryHost.querySelector<HTMLButtonElement>('#resume-preparation')!.addEventListener('click',event=>void action(ctx,event.currentTarget as HTMLButtonElement,async()=>{
   const body=JSON.parse(pending.body!) as ReturnType<typeof expected>;
   if(!o.scenarios.some(s=>s.scenario_id===body.scenario_id)||typeof body.instruction!=='string'||body.mode!==ctx.mode)throw Error('The saved preparation belongs to different settings. Discard it and prepare your current instruction.');
   if(ctx.mode==='live'&&!o.live_configured)throw Error('API access is not configured. Switch to Offline to work with local data.');
   ctx.storage.setItem(`wallet-instruction:${body.scenario_id}`,body.instruction);
   if(body.scenario_id!==id){navigate(ctx,`/wallet/new?scenario_id=${encodeURIComponent(body.scenario_id)}`);return;}
   input.value=body.instruction;invalidate();await submit(body);
  }));
  recoveryHost.querySelector<HTMLButtonElement>('#discard-preparation')!.addEventListener('click',()=>{if(!ctx.active)return;ctx.journal.acknowledged(pending);invalidate();renderRecovery();status.textContent='Saved preparation discarded. Decode your current instruction when ready.';});
 };
 const decodeAgain=()=>void action(ctx,button,async()=>{if(ctx.journal.pending('/api/wallet/prepare')){renderRecovery();throw Error('Resume or discard the saved preparation before preparing different settings.');}await submit(expected());});
 button.addEventListener('click',decodeAgain);
 renderRecovery();
 if(restored){if(preparationMatches(restored,expected()))await poll(restored.preparation_id,revision,expected());else invalidate();}
}
function renderPreparation(ctx:PageContext,p:WalletPreparation,isCurrent:()=>boolean,retryDecoding:()=>void){
 const host=document.querySelector<HTMLElement>('#wallet-prep')!;
 if(p.status!=='ready'||!p.config){host.innerHTML=`<section class="notice notice--warning"><h2>OpenAI decoding did not complete</h2><p>${esc(p.error??'Reliable permissions could not be prepared.')}</p><p>Your instruction is saved. Permissions cannot be confirmed until OpenAI decoding succeeds.</p><button type="button" class="button" id="retry-decoding">Retry decoding</button></section>`;host.querySelector<HTMLButtonElement>('#retry-decoding')!.addEventListener('click',()=>{if(isCurrent())retryDecoding();});return;}
 const storageKey=`wallet-json:${p.preparation_id}`;
 const amountStorageKey=`wallet-amount-choices:${p.preparation_id}`,amounts=amountClarifications(p.clarifications),amountChoices=restoreAmountChoices(ctx.storage.getItem(amountStorageKey),p.clarifications),baseParameters=p.config.parameters;
 let source=ctx.storage.getItem(storageKey)??JSON.stringify(Object.assign({min_order_chf:null,learn_confirmed_habits:false},baseParameters),null,2);
 try{source=applyAmountChoices(source,baseParameters,p.clarifications,amountChoices,p.amount_review_requirement);}catch{/* Keep an invalid draft editable; confirmation stays blocked below. */}
 const unresolved=p.clarifications.filter(c=>c.key.startsWith('unresolved:')&&c.resolution!=='purchase_review').map(c=>c.diagnostic??{field:c.key.slice('unresolved:'.length),reason:c.label});
 const purchaseReview=p.clarifications.filter(c=>c.resolution==='purchase_review').map(c=>c.diagnostic??{field:c.key.slice('unresolved:'.length),reason:c.label});
 const diagnostics={...(unresolved.length?{unmapped_constraints:unresolved}:{}),...(purchaseReview.length?{purchase_review_requirements:purchaseReview}:{}),...(p.warnings.length?{notes:p.warnings}:{})};
 const provenance=p.decoding?`<div class="help-text"><p>Decoded with OpenAI · ${esc(p.decoding.model_returned??p.decoding.model_requested)} · <time datetime="${esc(p.decoding.created_at)}">${esc(new Date(p.decoding.created_at).toLocaleString('en-CH'))}</time></p>${p.decoding.response_id?`<details class="technical-details"><summary>Decoding receipt</summary><p>Response ID: <code>${esc(p.decoding.response_id)}</code></p></details>`:''}</div>`:'';
 host.innerHTML=`<section class="wallet-permission-review" aria-label="Review your spending permissions">
 <header class="permission-review-heading"><div><h2>Your spending permissions</h2><p>Review the retained points, then switch to JSON.</p></div>
 <div class="permission-view-control"><span id="permission-summary-label" class="active">Points retained</span><button type="button" id="permission-view-switch" class="permission-view-switch" role="switch" aria-checked="false" aria-label="Show permission JSON" aria-controls="permission-summary-card permission-json-card"><span class="permission-view-switch__thumb" aria-hidden="true"></span></button><span id="permission-json-label">JSON</span></div></header>
 ${provenance}${renderAmountReview(p.instruction,p.clarifications,amountChoices)}
 <section id="permission-summary-card" class="panel permission-review-card" aria-label="Retained instruction points"><div id="permission-highlights" aria-live="polite" aria-atomic="true">${renderPermissionHighlights(source,p.instruction)}</div></section>
 <section id="permission-json-card" class="panel wallet-json-review permission-review-card" aria-label="Permission JSON" hidden><h3>Permission JSON</h3><p>${unresolved.length?'Some constraints need clarification before you can start. Review the details below.':purchaseReview.length?'Some requirements need your confirmation for each purchase. They are preserved in the JSON.':'Review or edit these permissions before starting.'}</p><form id="confirm-form"><label class="sr-only" for="permission-json">Permission JSON</label><textarea id="permission-json" class="permission-json" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" rows="24" required>${esc(source)}</textarea><label class="confirmation-check" for="learn-confirmed-habits"><input type="checkbox" id="learn-confirmed-habits" aria-describedby="habit-learning-description habit-learning-status"> Learn my confirmed habits</label><p class="help-text" id="habit-learning-description">Use only risk checks I explicitly confirm for purchases that are finally approved. Learn device, purchase-time and merchant-country habits after confirmations on at least 3 different days. Confirmations expire after 90 days. Spending limits, explicit time rules and other permissions stay unchanged.</p><p class="help-text" id="habit-learning-status" role="status"></p><div class="button-row"><button type="button" class="button button--secondary" id="format-json">Format JSON</button><button type="submit" class="button button--confirm" id="confirm-wallet" ${unresolved.length?'disabled':''}>Confirm JSON and start</button></div><p class="help-text">${p.mode==='local'?'Local simulation. No real money moves.':environment==='mock'?'Starts a run against the local API emulator. No real money moves.':'Confirms a mandate and starts a run on the Viseca API simulator.'}</p></form>${p.warnings.length||unresolved.length||purchaseReview.length?`<details class="technical-details" ${unresolved.length?'open':''}><summary>${unresolved.length?'Unmapped constraints':purchaseReview.length?'Purchase review requirements':'Decoder notes'}</summary>${json(diagnostics)}</details>`:''}</section></section>`;
 const input=document.querySelector<HTMLTextAreaElement>('#permission-json')!;
 const learning=document.querySelector<HTMLInputElement>('#learn-confirmed-habits')!;
 const learningStatus=document.querySelector<HTMLElement>('#habit-learning-status')!;
 const viewSwitch=document.querySelector<HTMLButtonElement>('#permission-view-switch')!;
 const summaryCard=document.querySelector<HTMLElement>('#permission-summary-card')!;
 const jsonCard=document.querySelector<HTMLElement>('#permission-json-card')!;
 const confirmButton=document.querySelector<HTMLButtonElement>('#confirm-wallet')!;
 let confirming=false;
 let showJson=false;
 const syncView=()=>{
  summaryCard.hidden=showJson;jsonCard.hidden=!showJson;
  viewSwitch.setAttribute('aria-checked',String(showJson));
  document.querySelector('#permission-summary-label')!.classList.toggle('active',!showJson);
  document.querySelector('#permission-json-label')!.classList.toggle('active',showJson);
 };
 viewSwitch.addEventListener('click',()=>{if(!isCurrent())return;showJson=!showJson;syncView();});
 syncView();
 const syncLearning=()=>{try{learning.checked=habitLearningPreference(input.value);learning.disabled=false;learningStatus.textContent='';}catch{learning.checked=false;learning.disabled=true;learningStatus.textContent='Fix the permission JSON to review or change habit learning.';}};
 const syncAmounts=()=>{
  let amountError='';try{validateAmountChoices(input.value,baseParameters,p.clarifications,amountChoices,p.amount_review_requirement);}catch(error){amountError=error instanceof Error?error.message:'Review your amount choices.';}
  confirmButton.disabled=confirming||!!unresolved.length||!!amountError;
  const status=document.querySelector<HTMLElement>('#amount-choice-status');if(status)status.textContent=amountError||'All amounts are clarified. Review the updated retained points and JSON before confirming.';
  const notes=document.querySelector<HTMLElement>('#amount-choice-notes');if(notes)notes.innerHTML=renderAmountChoiceNotes(p.clarifications,amountChoices);
  const preparationStatus=document.querySelector<HTMLElement>('#wallet-status');if(amounts.length&&preparationStatus)preparationStatus.textContent=amountError?`Clarification required. ${amountError}`:unresolved.length?'Some constraints still need clarification. See the details below.':'Ready to review. Your amount choices are reflected below; nothing starts until you confirm.';
 };
 const saveReview=()=>{if(!isCurrent())return;ctx.storage.setItem(storageKey,input.value);syncLearning();syncAmounts();const preview=document.querySelector<HTMLElement>('#permission-highlights');if(preview)preview.innerHTML=renderPermissionHighlights(input.value,p.instruction);};
 const applyAmounts=(reportError=true)=>{if(!isCurrent())return;try{input.value=applyAmountChoices(input.value,baseParameters,p.clarifications,amountChoices,p.amount_review_requirement);saveReview();}catch(error){syncAmounts();if(reportError)notice(ctx,error);}};
 host.querySelectorAll<HTMLSelectElement>('[data-amount-choice]').forEach(select=>select.addEventListener('change',()=>{
  if(!isCurrent())return;const key=select.dataset['amountChoice']!;if(isAmountChoice(select.value))amountChoices[key]=selectAmountChoice(amountChoices[key],select.value);else delete amountChoices[key];
  host.querySelectorAll<HTMLElement>('[data-amount-range]').forEach(group=>{if(group.dataset['amountRange']===key)group.hidden=select.value!=='approximate'&&select.value!=='range';});
  host.querySelectorAll<HTMLElement>('[data-amount-target]').forEach(target=>{if(target.dataset['amountTarget']===key)target.hidden=select.value!=='approximate';});
  host.querySelectorAll<HTMLInputElement>('[data-amount-range-key]').forEach(field=>{if(field.dataset['amountRangeKey']===key){const answer=amountChoices[key],bound=field.dataset['amountBound'];field.value=typeof answer==='object'&&(bound==='min_order_chf'||bound==='max_order_chf')?answer[bound]:'';}});
  ctx.storage.setItem(amountStorageKey,JSON.stringify(amountChoices));applyAmounts(false);
 }));
 host.querySelectorAll<HTMLInputElement>('[data-amount-range-key]').forEach(field=>field.addEventListener('input',()=>{
  if(!isCurrent())return;const key=field.dataset['amountRangeKey']!,bound=field.dataset['amountBound'],answer=amountChoices[key];
  if(typeof answer!=='object'||(bound!=='min_order_chf'&&bound!=='max_order_chf'))return;
  answer[bound]=field.value;ctx.storage.setItem(amountStorageKey,JSON.stringify(amountChoices));applyAmounts(false);
 }));
 host.querySelector<HTMLButtonElement>('#reapply-amount-choices')?.addEventListener('click',()=>applyAmounts());
 input.addEventListener('input',saveReview);
 learning.addEventListener('change',()=>{try{input.value=setHabitLearningPreference(input.value,learning.checked);saveReview();}catch(error){syncLearning();notice(ctx,error);}});
 syncLearning();syncAmounts();
 document.querySelector<HTMLButtonElement>('#format-json')!.addEventListener('click',()=>{try{input.value=JSON.stringify(parsePermissionJson(input.value),null,2);saveReview();flash.innerHTML='';}catch(error){syncLearning();notice(ctx,error);}});
 document.querySelector<HTMLFormElement>('#confirm-form')!.addEventListener('submit',event=>{event.preventDefault();if(unresolved.length||confirming||!isCurrent())return;confirming=true;void action(ctx,confirmButton,async()=>{if(!isCurrent())throw Error('The settings changed. Decode your instruction again before confirming.');validateAmountChoices(input.value,baseParameters,p.clarifications,amountChoices,p.amount_review_requirement);const parameters=parsePermissionJson(input.value);const result=await ctx.mutate<{run_id:string}>(`/api/wallet/preparations/${p.preparation_id}/confirm`,{confirmed:true,parameters,mode:ctx.mode,...(amounts.length?{amount_interpretations:amountChoices}:{})});navigate(ctx,`/wallet/runs/${encodeURIComponent(result.run_id)}`);}).finally(()=>{confirming=false;if(isCurrent())syncAmounts();});});
}
async function runPage(ctx:PageContext,id:string){
 await mountRunPage({host:app,runId:id,load:async()=>{const view=await ctx.api<WalletRunView>(`/api/wallet/runs/${encodeURIComponent(id)}`);if(view.mode!==ctx.mode)throw Error('This run belongs to the other data source. Switch modes to view it.');if(view.mode==='live'){environment=view.transport.environment??environment;updateConnection();}return view;},openSession:scenario=>ctx.session(scenario),mutate:(path,body)=>ctx.mutate(path,body),pendingRequest:path=>ctx.journal.pending(path),notice:error=>notice(ctx,error),clearNotice:()=>{if(ctx.active)flash.innerHTML='';},onDispose:dispose=>{disposePage=dispose;}});
}
async function profilesPage(ctx:PageContext){
 await options(ctx);
 const selected=new URLSearchParams(location.search).get('scenario_id');
 await mountBehaviorProfilesPage({host:app,loadProfiles:()=>ctx.api<{profiles:BehaviorProfileOption[]}>('/api/wallet/profiles'),loadDetail:async(scenarioId,scope)=>{if(scope!==ctx.mode)throw Error('Change the data source with the Online / Offline switch.');return ctx.api<BehaviorProfileDashboard>(`/api/wallet/profiles/detail?scenario_id=${encodeURIComponent(scenarioId)}&scope=${scope}`);},openSession:scenario=>ctx.session(scenario),mutate:(path,body)=>{if((body as {scope?:string}).scope!==ctx.mode)throw Error('The saved profile change belongs to the other data source.');return ctx.mutate(path,body);},pendingRequest:path=>ctx.journal.pending(path),notice:error=>notice(ctx,error),clearNotice:()=>{if(ctx.active)flash.innerHTML='';},onDispose:dispose=>{disposePage=dispose;},...(selected?{initialScenarioId:selected}:{}),initialScope:ctx.mode,fixedScope:true});
}
async function inspection(ctx:PageContext,id:string){
 if(ctx.mode!=='local')throw Error('Saved inspections use offline data. Switch to Offline to view this inspection.');
 const v=await ctx.api<RunView>(`/api/runs/${encodeURIComponent(id)}`);app.innerHTML=`<a href="/" class="back-link">← Wallet home</a><header class="page-header"><p class="eyebrow">Saved inspection</p><h1>${esc(v.run.scenario_id)} · ${esc(v.run.status)}</h1><p>This historical inspection did not make payment decisions.</p></header><section class="panel"><div class="panel__body"><p>${v.counts.emitted} purchases recorded</p><blockquote>${esc(v.run.mandate_snapshot.instruction)}</blockquote><details><summary>Saved inspection data</summary>${json(v)}</details></div></section>`;
}
document.querySelector('#data-mode-switch')!.addEventListener('click',()=>{dataMode=dataMode==='local'?'live':'local';saveDataMode(localStorage,dataMode);history.replaceState(null,'',modeLanding(location.pathname,location.search));void route();});
window.addEventListener('storage',event=>{if(event.key!==null&&event.key!=='viseca.data-mode.v1')return;const mode=readDataMode(localStorage);if(mode===dataMode)return;dataMode=mode;history.replaceState(null,'',modeLanding(location.pathname,location.search));void route();});
window.addEventListener('popstate',()=>void route());void route();
