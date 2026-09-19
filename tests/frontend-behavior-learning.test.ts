import {describe,expect,it} from 'vitest';
import type {Assessment} from '../packages/contracts/src/simulation.js';
import {habitLearningPreference,setHabitLearningPreference} from '../apps/local-web/web/behavior-learning-ui.js';
import {renderHabitLearning,renderPurchaseCard} from '../apps/local-web/web/wallet-run-view.js';

describe('explicit habit-learning preference',()=>{
 it('defaults old drafts to off and restores only a real boolean opt-in',()=>{
  expect(habitLearningPreference('{"max_order_chf":"200"}')).toBe(false);
  expect(habitLearningPreference('{"learn_confirmed_habits":false}')).toBe(false);
  expect(habitLearningPreference('{"learn_confirmed_habits":true}')).toBe(true);
  for(const value of ['"true"','1','null','[]'])expect(()=>habitLearningPreference(`{"learn_confirmed_habits":${value}}`)).toThrow('must be true or false');
 });
 it('preserves edited permissions through opt-in, restore and opt-out',()=>{
  const original={max_order_chf:'180',attributes:[{name:'color',values:['black'],unit:null}],custom_field:'keep for server validation'};
  const enabled=setHabitLearningPreference(JSON.stringify(original),true);
  expect(JSON.parse(enabled)).toEqual({...original,learn_confirmed_habits:true});
  expect(habitLearningPreference(enabled)).toBe(true);
  const disabled=setHabitLearningPreference(enabled,false);
  expect(JSON.parse(disabled)).toEqual({...original,learn_confirmed_habits:false});
  expect(habitLearningPreference(disabled)).toBe(false);
 });
 it('never repairs or replaces malformed JSON when toggling learning',()=>{
  for(const text of ['{"max_order_chf":','[]','null']){
   expect(()=>habitLearningPreference(text)).toThrow();
   expect(()=>setHabitLearningPreference(text,true)).toThrow();
  }
 });
});

function assessment(state:Assessment['execution_state']='approved'):Assessment {
 const behavior_learning:NonNullable<Assessment['behavior_learning']>={enabled:true,profile:{customer_id:'CUSTOMER',scope:'local',version:'profile-v1',as_of:'2026-08-20T12:00:00Z',timezone:'Europe/Zurich',habits:[
  {filter_id:'C15',context_key:'DEVICE',confirmations:3,distinct_days:3,effective_count:3,last_confirmed_at:'2026-08-19T12:00:00Z',learned:true,source_ids:['A','B','C']},
  {filter_id:'C19',context_key:'FR',confirmations:2,distinct_days:2,effective_count:2,last_confirmed_at:'2026-08-19T12:00:00Z',learned:false,source_ids:['B','C']},
 ]},applied_filter_ids:['C15'],confirmations:[{customer_id:'CUSTOMER',scope:'local',source_id:'D',authorization_id:'AUTH',filter_id:'C19',context_key:'FR',occurred_at:'2026-08-20T12:00:00Z',recorded_at:'2026-09-19T12:00:00Z',actor_id:'HUMAN'}]};
 return {
  execution_state:state,decision:state==='approved'?'approve':state==='declined'?'deny':'step_up',results:[],questions:[],
  behavior_learning,
 } as unknown as Assessment;
}

describe('habit learning on purchase cards',()=>{
 it('keeps historical or disabled assessments free of learning claims',()=>{
  expect(renderHabitLearning({} as Assessment)).toBe('');
  const a=assessment();a.behavior_learning!.enabled=false;
  expect(renderHabitLearning(a)).toBe('');
 });
 it('shows snapshot progress, the specific learned check and policy limits',()=>{
  const html=renderHabitLearning(assessment());
  expect(html).toContain('Habits at this check:');
  expect(html).toContain('1 learned · 1 still learning');
  expect(html).toContain('3 confirmations on 3 different days');
  expect(html).toContain('2 confirmations on 2 different days');
  expect(html).toContain('Learned habits were used for this check: Device familiarity');
  expect(html).toContain('Spending limits and all other checks still apply');
  expect(html).toContain('Profile profile-v1');
  expect(html).toContain('new confirmations apply to future checks');
 });
 it('claims a saved confirmation only after final approval',()=>{
  expect(renderHabitLearning(assessment())).toContain('Confirmation saved for future habit learning');
  for(const state of ['awaiting_user','declined','expired','technical_hold','cancelled'] as const){
   expect(renderHabitLearning(assessment(state))).not.toContain('Confirmation saved');
  }
  const a=assessment();a.behavior_learning!.confirmations=[];
  expect(renderHabitLearning(a)).not.toContain('Confirmation saved');
 });
 it('shows an empty snapshot honestly and escapes profile context',()=>{
  const a=assessment();a.behavior_learning!.profile.habits=[];a.behavior_learning!.applied_filter_ids=[];
  const empty=renderHabitLearning(a);
  expect(empty).toContain('No confirmed habits yet');
  expect(empty).not.toContain('Learned habits were used');
  const populated=assessment();populated.behavior_learning!.profile.habits[0]!.context_key='<script>bad()</script>';
  const html=renderHabitLearning(populated);
  expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
 });
 it('includes learning in the actual purchase card',()=>{
  const html=renderPurchaseCard({authorization_id:'AUTH',merchant_id:'MERCHANT',merchant_name:'Shop',description:'Purchase',amount_chf:'20',currency:'CHF',items:[],assessment:assessment()},'local','completed');
  expect(html).toContain('Habits at this check');
  expect(html).toContain('Why this decision?');
 });
});
