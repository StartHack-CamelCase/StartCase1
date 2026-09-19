import {expect,it} from 'vitest';
import {fixture} from './simulation-fixture.js';
import {assess} from '../packages/local-runtime/src/simulation/evaluator.js';
import {liveAssessment,pendingLiveAssessment,unavailableLiveAssessment} from '../packages/local-runtime/src/services/wallet-service.js';
import {renderReview} from '../apps/local-web/web/wallet-run-view.js';
import {collectLiveAnswers} from '../apps/local-web/web/wallet-ui.js';
import type {LiveEntry} from '../packages/local-runtime/src/simulation/viseca-worker.js';
import type {Assessment} from '../packages/contracts/src/simulation.js';
function pending():LiveEntry {const ctx=fixture();ctx.config.parameters.always_ask=true;const assessment=assess(ctx);expect(assessment.questions.length).toBeGreaterThan(0);return {id:ctx.event.authorization.authorization_id,event:ctx.event,state:'awaiting_human',reserved:true,snapshot:{},proposal:{decision:'step_up',snapshot:assessment},intent:null,accepted:{decision:'step_up',at:ctx.now,response:{}},human_expires_at:new Date(Date.parse(ctx.now)+120000).toISOString(),history:[]};}
it('projects the accepted live deadline instead of the earlier proposal deadline',()=>{const e=pending();const a=e.proposal!.snapshot as Assessment;const original=a.lock!.expires_at!;e.human_expires_at=new Date(Date.parse(original)+25000).toISOString();const view=liveAssessment(e,Date.parse(original)+1000)!;expect(view.execution_state).toBe('awaiting_user');expect(view.lock!.expires_at).toBe(e.human_expires_at);expect(a.lock!.expires_at).toBe(original);});
it.each(['approve','decline'] as const)('projects accepted %s without stale questions or confirmation controls',decision=>{const entry=pending();entry.accepted!.decision=decision;entry.reserved=false;entry.state='accepted';const view=liveAssessment(entry);expect(view).toMatchObject({execution_state:decision==='approve'?'approved':'declined',decision:decision==='approve'?'approve':'deny',questions:[],lock:null,can_finalize:false});expect((entry.proposal!.snapshot as {questions:unknown[]}).questions.length).toBeGreaterThan(0);});
it('hides expired live confirmation controls while retaining the remote reservation until reconciliation',()=>{const entry=pending();const view=liveAssessment(entry,Date.parse(entry.human_expires_at!));expect(view).toMatchObject({execution_state:'expired',decision:null,questions:[],lock:null,can_finalize:false});expect(entry.reserved).toBe(true);expect(entry.accepted!.decision).toBe('step_up');});

it('replaces unavailable fresh verification with a system hold and keeps only the pending remote decline',()=>{
 const entry=pending(),original=structuredClone(entry.proposal!.snapshot),now=Date.parse(entry.human_expires_at!)-60_000;
 const view=unavailableLiveAssessment(entry,now)!;
 expect(view).toMatchObject({execution_state:'technical_hold',can_finalize:false,evaluation_complete:false,questions:[],technical_filter_ids:expect.arrayContaining(['G06']),lock:{expires_at:entry.human_expires_at}});
 const html=renderReview(view,entry.id,'live',false,undefined,entry.state);
 expect(html).toContain('data-review-action="decline"');expect(html).not.toContain('data-review-action="approve"');
 expect(html).toContain(`data-expires-at="${entry.human_expires_at}"`);expect(html).not.toMatch(/<(?:input|textarea|select)\b/);
 expect(entry.proposal!.snapshot).toEqual(original);
 expect(unavailableLiveAssessment(entry,Date.parse(entry.human_expires_at!))).toMatchObject({execution_state:'expired',questions:[],lock:null});
});

it('keeps pending review identities stable across fresh assessments but changes them when the required questions change',()=>{
 const entry=pending(),ctx=fixture();ctx.config.parameters.always_ask=true;
 const first=assess(ctx),firstView=pendingLiveAssessment(entry,first,Date.parse(ctx.now));
 ctx.now=new Date(Date.parse(ctx.now)+1000).toISOString();ctx.run.revision++;
 const second=assess(ctx),secondView=pendingLiveAssessment(entry,second,Date.parse(ctx.now));
 expect(second.assessment_id).not.toBe(first.assessment_id);
 expect(secondView.revision).toBe(firstView.revision);expect(secondView.assessment_id).toBe(firstView.assessment_id);
 second.questions.push({...second.questions[0]!,question_id:'NEW_REQUIRED_FACT',fact_key:'new_requirement',kind:'confirm_requirement',prompt:'Confirm this additional requirement.'});
 const changed=pendingLiveAssessment(entry,second,Date.parse(ctx.now));
 expect(changed.revision).not.toBe(firstView.revision);expect(changed.assessment_id).not.toBe(firstView.assessment_id);
 expect(first.questions.some(q=>q.question_id==='NEW_REQUIRED_FACT')).toBe(false);
});

it('creates an explicit binary confirmation when current checks pass without questions, even with no old proposal',()=>{
 const ctx=fixture(),current=assess(ctx),entry=pending();entry.proposal=null;
 expect(current).toMatchObject({can_finalize:true,questions:[],lock:null});
 const projected=pendingLiveAssessment(entry,current,Date.parse(ctx.now));
 expect(projected).toMatchObject({execution_state:'awaiting_user',decision:'step_up',can_finalize:false,lock:{expires_at:entry.human_expires_at}});
 expect(projected.questions).toEqual([expect.objectContaining({kind:'confirm_risk',fact_key:'purchase_confirmation',state:'open',offer_hash:current.offer_hash})]);
 expect(collectLiveAnswers(projected.questions)).toEqual([{question_id:projected.questions[0]!.question_id,value:'confirm'}]);
 const html=renderReview(projected,entry.id,'live',false,undefined,entry.state);
 expect(html).toContain('data-review-action="approve"');expect(html).toContain('data-review-action="decline"');expect(html).not.toMatch(/<(?:input|textarea|select)\b/);
 expect(pendingLiveAssessment(entry,assess(ctx),Date.parse(ctx.now)+1000).revision).toBe(projected.revision);
 expect(current).toMatchObject({can_finalize:true,questions:[],lock:null});
});
