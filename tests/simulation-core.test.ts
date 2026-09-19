import { describe,it,expect } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { evaluateMerchant } from '../packages/local-runtime/src/simulation/merchant.js';
import { evaluateCustomer, affectedRolling } from '../packages/local-runtime/src/simulation/customer.js';
import { aggregate,assess } from '../packages/local-runtime/src/simulation/evaluator.js';
import { result } from '../packages/local-runtime/src/simulation/common.js';
import type { FilterId, Commitment } from '../packages/contracts/src/simulation.js';
function merchant(id:string,p:Parameters<typeof fixture>[0]=undefined){return evaluateMerchant(fixture(p)).find(r=>r.filter_id===id)!;}
const get=(ctx:ReturnType<typeof fixture>,id:FilterId)=>{const m=evaluateMerchant(ctx);return [...m,...evaluateCustomer(ctx,m)].find(r=>r.filter_id===id)!;};
describe('MCG semantic recipe',()=>{
 it('ordinary fixture yields exactly 50 completed slots and no invented restrictions',()=>{const c=fixture('AU0001');const a=assess(c);expect(a.results).toHaveLength(50);expect(new Set(a.results.map(r=>r.filter_id)).size).toBe(50);expect(a.blocking_filter_ids).toEqual([]);expect(a.can_finalize).toBe(true);expect(a.decision).toBe(null);});
 it('126 includes delivery and exceeds 120, preserving M19 pass',()=>{const c=fixture();c.config.parameters.max_order_chf='120';expect(get(c,'M19').outcome).toBe('pass');expect(get(c,'C09').outcome).toBe('fail');expect(get(c,'C09').reasons[0]!.message).toContain('126.00');});
 it('EUR 260 converts to247 withinCHF250, without forcing purchaseCHF',()=>{const c=fixture('AU0032');c.config.parameters.max_order_chf='250';expect(get(c,'M19').outcome).toBe('pass');expect(get(c,'C09').outcome).toBe('pass');c.config.parameters.allowed_currencies=['CHF'];expect(get(c,'C09').outcome).toBe('fail');});
 it('unavailable FX suspends dependent budgets without inventing a violation',()=>{const c=fixture('AU0032');c.config.parameters.max_order_chf='1';c.pack.fxByCurrency=new Map();expect(get(c,'M19').outcome).toBe('not_evaluated');expect(get(c,'C09').outcome).toBe('not_evaluated');expect(assess(c).decision).toBe(null);});
 it.each([['AU0013','fail'],['AU0019','pass']] as const)('size checked on offer %s', (id,status)=>{const c=fixture(id);c.config.parameters.attributes=[{name:'size',values:['43'],unit:null}];c.config.parameters.numeric_size_convention='shared_numeric';expect(get(c,'M11').outcome).toBe(status);});
 it('a sourced choice resolves only an offered alternative and preserves its author',()=>{
  const c=fixture('AU0019');c.config.parameters.attributes=[{name:'size',values:['43'],unit:'EU'}];
  c.event.authorization.items[0]!.item_details='Size EU 42 or 43';
  expect(get(c,'M11').outcome).toBe('needs_review');
  c.answers=[{answer_id:'A',question_id:'Q',fact_key:'M11:size:1',kind:'choose_variant',value:'43',source_ref:'quote:selected-variant',source_excerpt:'Selected size EU 43',actor:{actor_id:'reviewer',role:'simulated_human',customer_id:c.run.customer_id,channel:'local_ui',authenticated_by_server:true},offer_hash:c.offer_hash,config_revision:1,created_at:c.now,expires_at:'2026-09-20T00:00:00Z',consumed_by:null}];
  expect(get(c,'M11').outcome).toBe('pass');expect(get(c,'M11').evidence[0]?.author).toBe('reviewer');
  c.answers[0]!.value='44';c.answers[0]!.source_excerpt='Selected size EU 44';
  expect(get(c,'M11').outcome).toBe('needs_review');
 });
 it('human selection cannot overwrite the certain wrong size',()=>{
  const c=fixture('AU0013');c.config.parameters.attributes=[{name:'size',values:['43'],unit:'EU'}];c.event.authorization.items[0]!.item_details='Selected size EU 42';
  c.answers=[{answer_id:'A',question_id:'Q',fact_key:'M11:size:1',kind:'choose_variant',value:'43',source_ref:'quote:other',source_excerpt:'Selected size EU 43',actor:{actor_id:'reviewer',role:'simulated_human',customer_id:c.run.customer_id,channel:'local_ui',authenticated_by_server:true},offer_hash:c.offer_hash,config_revision:1,created_at:c.now,expires_at:'2026-09-20T00:00:00Z',consumed_by:null}];
  expect(get(c,'M11').outcome).toBe('fail');expect(get(c,'M11').evidence[0]?.author).toBe(null);
 });
 it.each([['AU0015','fail'],['AU0016','needs_review'],['AU0019','pass']] as const)('return clause %s', (id,status)=>{const c=fixture(id);c.config.parameters.min_return_days=14;expect(get(c,'M13').outcome).toBe(status);});
 it('contradictory genuine return term needs review',()=>{const c=fixture('AU0019');c.config.parameters.min_return_days=14;c.event.authorization.order_returnable='false';c.event.authorization.items[0]!.item_details='Returns accepted within 30 days.';expect(get(c,'M13').outcome).toBe('needs_review');});
 it('two independent certain reasons retained',()=>{const c=fixture('AU0041');c.config.parameters.max_order_chf='400';c.config.parameters.no_extras=true;c.config.parameters.allowed_item_ids=['IT0017'];const a=assess(c);expect(a.decision).toBe('deny');expect(a.blocking_filter_ids).toEqual(expect.arrayContaining(['M12','C09']));expect(a.lock?.reason_filter_ids).toEqual(expect.arrayContaining(['M12','C09']));});
 it('other card familiarity is positive',()=>{const c=fixture('AU0044');c.config.parameters.familiar_merchant=true;expect(get(c,'M02').outcome).toBe('pass');expect(get(c,'M03').reasons[0]?.code).toBe('M03_FAMILIARITY_FOUND_OTHER_CARD');});
 it('known Italy is not unusual',()=>{const c=fixture('AU0025');c.config.parameters.unusual_country=true;expect(get(c,'C19').outcome).toBe('pass');});
 it('new device differs from known device within same frozen history',()=>{const c=fixture('AU0026');c.config.parameters.watch_devices=true;expect(get(c,'C15').outcome).toBe('needs_review');const d=fixture('AU0031');d.config.parameters.watch_devices=true;expect(get(d,'C15').outcome).toBe('pass');});
 it('late insertion checks future rolling window, not only candidate window',()=>{const c=fixture();c.config.parameters.rolling_budget={days:7,limit_chf:'300'};c.run.commitments=[{authorization_id:'LATER',amount_chf:'200.00',timestamp:new Date(Date.parse(c.event.authorization.timestamp)+86400000).toISOString(),quantity:1,budget_scope_id:c.run.budget_scope_id}];expect(get(c,'C10').outcome).toBe('fail');});
 it('exact168h lower bound excluded',()=>{const c:Commitment={authorization_id:'now',amount_chf:'100',timestamp:'2026-08-08T00:00:00Z',quantity:1,budget_scope_id:'b'};const older={...c,authorization_id:'old',amount_chf:'250',timestamp:'2026-08-01T00:00:00Z'};expect(affectedRolling(c,[older],7)[0]?.spent).toBe('100.00');});
 it('reservation contention only reviews; approved spend proves rejection',()=>{const c=fixture('AU0001');c.config.parameters.rolling_budget={days:7,limit_chf:'100'};c.run.reservations=[{authorization_id:'other',amount_chf:'90',timestamp:c.event.authorization.timestamp,quantity:1,budget_scope_id:c.run.budget_scope_id,offer_hash:'other',expires_at:'2026-09-20T00:00:00Z'}];expect(get(c,'C10').outcome).toBe('pass');expect(get(c,'C12').outcome).toBe('needs_review');c.run.commitments=c.run.reservations.map(r=>({...r}));c.run.reservations=[];expect(get(c,'C10').outcome).toBe('fail');});
 it('five protected signals never become refusal by accumulation',()=>{const results=(['C08','C18','C19','C20','C22'] as const).map(id=>result(id,'needs_review',`${id}_TEST`,'Signal'));expect(aggregate(results).decision).toBe('step_up');for(const id of ['C08','C18','C19','C20','C22'] as const)expect(()=>result(id,'fail','INVALID','Invalid')).toThrow();});
 it('technical coexistence retains useful questions and independent denials',()=>{const doubt=result('C18','needs_review','TIME','time'),tech=result('G06','not_evaluated','ERROR','storage'),deny=result('C09','fail','LIMIT','limit');expect(aggregate([doubt,tech])).toMatchObject({decision:'step_up',state:'technical_hold'});expect(aggregate([doubt,tech,deny])).toMatchObject({decision:'deny',state:'declined'});});
});
