import {describe,expect,it} from 'vitest';
import {advanceServerClock,retryEligible,collectLiveAnswers,parsePermissionJson,confirmationSeconds,countdownText,pendingPurchaseOperation,hasConflictingPurchaseOperation} from '../apps/local-web/web/wallet-ui.js';
import {OperationJournal} from '../apps/local-web/web/operation-state.js';
import {renderReview,renderPurchaseCard} from '../apps/local-web/web/wallet-run-view.js';
import type {WalletRunView} from '../packages/contracts/src/wallet.js';
import type {Assessment,Question} from '../packages/contracts/src/simulation.js';
describe('wallet retry eligibility',()=>{
 it('allows local expired and technical holds',()=>{expect(retryEligible({execution_state:'expired',decision:null} as never,'local')).toBe(true);expect(retryEligible({execution_state:'technical_hold',decision:null} as never,'local')).toBe(true);});
 it('never offers retry for live or approved states',()=>{expect(retryEligible({execution_state:'expired',decision:null} as never,'live')).toBe(false);expect(retryEligible({execution_state:'approved',decision:'approve'} as never,'local')).toBe(false);expect(retryEligible({execution_state:'awaiting_user',decision:'step_up'} as never,'local')).toBe(false);});
});

it('sends distinct evidence for every live question in one response',()=>{const data=new FormData();for(const [id,value,source] of [['size','43','size chart'],['returns','14','return policy']]){data.set(`value:${id}`,value!);data.set(`source_ref:${id}`,source!);data.set(`source_excerpt:${id}`,`${source}: ${value}`);}expect(collectLiveAnswers(data,[{question_id:'size',kind:'choose_variant'},{question_id:'returns',kind:'provide_evidence'},{question_id:'device',kind:'confirm_risk'}])).toEqual([{question_id:'size',value:'43',source_ref:'size chart',source_excerpt:'size chart: 43'},{question_id:'returns',value:'14',source_ref:'return policy',source_excerpt:'return policy: 14'},{question_id:'device',value:'confirm'}]);});
it('does not submit a partial set of evidence or substitute yes for a quote repair',()=>{const data=new FormData();data.set('value:one','43');data.set('source_ref:one','size chart');data.set('source_excerpt:one','Size 43');expect(()=>collectLiveAnswers(data,[{question_id:'one',kind:'provide_evidence'},{question_id:'two',kind:'provide_evidence'}])).toThrow('every question');expect(()=>collectLiveAnswers(data,[{question_id:'quote',kind:'replace_quote'}])).toThrow('corrected quote');});

it('passes the entire JSON object without dropping edited fields',()=>{expect(parsePermissionJson('{"min_order_chf":"20","max_order_chf":"20","unknown":1}')).toEqual({min_order_chf:'20',max_order_chf:'20',unknown:1});expect(()=>parsePermissionJson('{broken')).toThrow('Invalid JSON');for(const input of ['[]','null','20','"text"'])expect(()=>parsePermissionJson(input)).toThrow('must be an object');});

it('uses the actual expiry for a countdown, including elapsed background time and the exact deadline',()=>{
 const end='2026-09-19T12:02:00.000Z';
 expect(countdownText(confirmationSeconds(end,Date.parse('2026-09-19T12:00:00Z')))).toBe('2:00');
 expect(countdownText(confirmationSeconds(end,Date.parse('2026-09-19T12:01:59.100Z')))).toBe('0:01');
 expect(countdownText(confirmationSeconds(end,Date.parse(end)))).toBe('0:00');
 expect(confirmationSeconds(end,Date.parse(end)+5000)).toBe(0);
 expect(confirmationSeconds(null)).toBeNull();expect(confirmationSeconds('bad deadline')).toBeNull();
});
it('counts response transit and never moves the consent clock backwards on a delayed snapshot',()=>{const stamp='2026-09-19T12:00:00Z',epoch=Date.parse(stamp);expect(advanceServerClock(stamp,0,8000,epoch)).toBe(epoch+8000);expect(advanceServerClock(stamp,8000,9000,epoch+9000)).toBe(epoch+9000);});
it('recovers the exact saved reassessment after a lost response, even when the visible revision advanced',()=>{
 const values=new Map<string,string>();const journal=new OperationJournal({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);}},()=> 'saved-request');
 const path='/api/simulations/RUN/authorizations/AUTH/reassess';const original=journal.begin(path,'POST',{expected_revision:2});
 expect(()=>journal.begin(path,'POST',{expected_revision:4})).toThrow('Retry the saved request');
 const recover=pendingPurchaseOperation('local','RUN','AUTH',p=>journal.pending(p))!;
 expect(journal.begin(recover.path,'POST',JSON.parse(recover.body!))).toEqual(original);journal.acknowledged(recover);
 expect(pendingPurchaseOperation('local','RUN','AUTH',p=>journal.pending(p))).toBeNull();expect(()=>journal.begin(path,'POST',{expected_revision:4})).not.toThrow();
});
it('holds other live purchases until the shared interrupted response is recovered, while keeping its owner and local purchases available',()=>{
 const values=new Map<string,string>();const journal=new OperationJournal({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);}},()=> 'live-saved-request');
 const path='/api/wallet/runs/RUN/human-responses';const original=journal.begin(path,'POST',{authorization_id:'A',decision:'approve',answers:[{question_id:'device',value:'confirm'}]});
 const find=(p:string)=>journal.pending(p);
 expect(hasConflictingPurchaseOperation('live','RUN','B',find)).toBe(true);
 expect(hasConflictingPurchaseOperation('live','RUN','A',find)).toBe(false);
 expect(hasConflictingPurchaseOperation('local','RUN','B',find)).toBe(false);
 expect(hasConflictingPurchaseOperation('live','OTHER_RUN','B',find)).toBe(false);
 const recover=pendingPurchaseOperation('live','RUN','A',find)!;
 expect(journal.begin(recover.path,'POST',JSON.parse(recover.body!))).toEqual(original);journal.acknowledged(recover);
 expect(hasConflictingPurchaseOperation('live','RUN','B',find)).toBe(false);
 expect(()=>journal.begin(path,'POST',{authorization_id:'B',decision:'approve',answers:[]})).not.toThrow();
});
const question=(id:string,kind:Question['kind']):Question=>({question_id:id,kind,fact_key:id,filter_ids:[],evidence_ids:[],prompt:`Review ${id}`,offer_hash:'offer',state:'open',answer_id:null});
const pending=(questions:Question[])=>({execution_state:'awaiting_user',decision:'step_up',questions,results:[],lock:{expires_at:'2026-09-19T12:02:00Z'}} as unknown as Assessment);
it.each(['local','live'])('shows one confirmation for several risks and evidence in %s mode',mode=>{
 const html=renderReview(pending([question('device','confirm_risk'),question('burst','confirm_risk'),question('size','choose_variant')]),'AUTH',mode);
 expect(html.match(/<form\b/g)).toHaveLength(1);expect(html.match(/data-review-action="approve"/g)).toHaveLength(1);
 expect(html).toContain('Review device');expect(html).toContain('Review burst');expect(html).toContain('name="value:size"');
 expect(html.match(/data-review-action="decline"/g)).toHaveLength(1);expect(html).toContain('data-expires-at="2026-09-19T12:02:00Z"');
});
it('does not offer an ineffective partial approval when a rule needs repair or amendment',()=>{
 const html=renderReview(pending([question('device','confirm_risk'),question('history','amend_mandate')]),'AUTH','local',false,'SCEN0003');
 expect(html).toContain('Permissions need review');expect(html).toContain('href="/wallet/new?scenario_id=SCEN0003"');expect(html).toContain('Review permissions for a new run');
 expect(html).not.toContain('Time left to confirm');expect(html).toContain('data-review-type="resolution"');expect(html).toContain('Time until this request expires');
 expect(html).not.toContain('data-review-action="approve"');expect(html).toContain('data-review-action="decline"');
});
it('removes all review controls for expired, approved and revoked purchases',()=>{
 for(const state of ['expired','approved','cancelled'] as const)expect(renderReview({...pending([question('device','confirm_risk')]),execution_state:state},'AUTH','local')).toBe('');
 expect(renderReview(pending([question('device','confirm_risk')]),'AUTH','local',true)).toBe('');
});

it('keeps the missing permission actionable after Cobalt expires instead of offering the same ineffective reassessment',()=>{
 const assessment={...pending([question('device','confirm_risk'),question('history','amend_mandate')]),execution_state:'expired',lock:null} as Assessment;
 const purchase:WalletRunView['purchases'][number]={authorization_id:'AUTH',merchant_id:'ME0058',merchant_name:'Cobalt Coatworks',description:'Coat',amount_chf:'245',currency:'CHF',items:[],assessment};
 for(const mode of ['local','live']){
  const html=renderPurchaseCard(purchase,mode,'completed','SCEN0003');
  expect(html).toContain('Review history');expect(html).toContain('Review permissions for a new run');
  expect(html).not.toContain('retry-purchase');expect(html).not.toContain('data-review-action="approve"');expect(html).not.toContain('consent-countdown');
 }
 const revoked=renderPurchaseCard(purchase,'local','revoked','SCEN0003');
 expect(revoked).not.toContain('Review permissions for a new run');
 const riskOnly=renderPurchaseCard({...purchase,assessment:{...assessment,questions:[question('device','confirm_risk')]}},'local','completed','SCEN0003');
 expect(riskOnly).toContain('retry-purchase');expect(riskOnly).not.toContain('Review permissions for a new run');
});
it('does not describe a quote repair as either an available confirmation or a permission amendment',()=>{
 const html=renderReview(pending([question('quote','replace_quote'),question('device','confirm_risk')]),'AUTH','local',false,'SCEN0003');
 expect(html).toContain('A corrected offer is needed');expect(html).toContain('Verification needed');
 expect(html).not.toContain('data-review-action="approve"');expect(html).not.toContain('Review permissions for a new run');
});
