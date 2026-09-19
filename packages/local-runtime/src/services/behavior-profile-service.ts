import type { DataPack } from '../../../contracts/src/data.js';
import type { BehaviorControlRequest, BehaviorFeedbackRequest, BehaviorProfileDashboard, BehaviorProfileOption } from '../../../contracts/src/behavior-dashboard.js';
import type { BehaviorScope, HabitFilterId } from '../../../contracts/src/behavior.js';
import type { HumanActor, SimulationDocument, Assessment } from '../../../contracts/src/simulation.js';
import type { WalletRunView } from '../../../contracts/src/wallet.js';
import type { BehaviorEvaluationSample } from '../../../contracts/src/behavior-evaluation.js';
import { AppError } from '../../../contracts/src/errors.js';
import { asId } from '../../../contracts/src/ids.js';
import type { SimulationService } from '../simulation/service.js';
import type { LiveEntry } from '../simulation/viseca-worker.js';
import { liveHabitObservations,localHabitObservations,safeBehaviorProfile } from '../learning/learned-habits.js';
import { habitContext } from '../learning/behavior-profile.js';
import { synchronizeBehaviorJournal, journalBehaviorProfile } from '../learning/behavior-journal.js';
import { summarizeBehaviorComparisons } from '../learning/behavior-evaluation.js';
import { permissionSummary } from './wallet-preparation.js';

export class BehaviorProfileService {
  constructor(private readonly pack:DataPack,private readonly simulations:SimulationService,private readonly liveEntries:()=>readonly LiveEntry[],private readonly walletRuns:()=>WalletRunView[],private readonly clock=()=>new Date()){}

  options():BehaviorProfileOption[]{return this.pack.scenarios.map(s=>({customer_id:this.customer(s.scenario_id),scenario_id:s.scenario_id,scenario_name:s.scenario_name}));}

  customer(scenarioId:string):string {
    const source=this.pack.attemptsByScenario.get(asId(scenarioId))?.[0];
    const customer=source&&this.pack.authoritiesById.get(source.authority_id)?.customer_id;
    if(!customer)throw new AppError(404,'PROFILE_NOT_FOUND','Choose one of the synthetic customer profiles.');
    return customer;
  }

  detail(scenarioId:string,scope:BehaviorScope,allReviews=false):BehaviorProfileDashboard {
    if(!['local','live'].includes(scope))throw new AppError(400,'PROFILE_SCOPE_INVALID','Choose local or live.');
    const customerId=this.customer(scenarioId);
    // The GET is a pure projection. Older approved feedback is assigned stable
    // prospective sequences in this copy; a subsequent command persists them first.
    const state=this.simulations.store.select(s=>({schema_version:1,configs:s.configs,runs:s.runs,commands:{},...(s.behavior_journal?{behavior_journal:s.behavior_journal}:{})}) as SimulationDocument);
    const entries=this.liveEntries();
    const journal=synchronizeBehaviorJournal(state,[...localHabitObservations(state.runs),...liveHabitObservations(entries)]);
    const runs=state.runs.filter(r=>r.customer_id===customerId);
    const relevantEntries=entries.filter(e=>e.event.mandate.customer_id===customerId);
    const views=this.walletRuns().filter(r=>r.mode===scope&&this.customer(r.scenario_id)===customerId);
    const configs=scope==='local'?runs.map(r=>r.config):views.map(r=>r.config);
    const timezone=configs.at(-1)?.parameters.timezone??'Europe/Zurich';
    const times=scope==='local'?runs.flatMap(r=>r.purchases.map(p=>p.event.authorization.timestamp)):relevantEntries.map(e=>e.event.authorization.timestamp);
    const fallback=this.pack.attemptsByScenario.get(asId(scenarioId))![0]!.timestamp;
    const last=times.length?Math.max(...times.map(Date.parse)):Date.parse(fallback);
    const profile=journalBehaviorProfile(journal,{customerId,scope,asOf:new Date(last+1).toISOString(),timezone});
    const assessments=scope==='local'?runs.flatMap(r=>r.purchases.flatMap(p=>p.assessments)):relevantEntries.map(e=>e.proposal?.snapshot as Assessment|undefined).filter((a):a is Assessment=>Boolean(a?.schema_version));
    const samples:BehaviorEvaluationSample[]=[];const seen=new Set<string>();
    for(const a of [...assessments].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at))){
      const comparison=a.behavior_learning?.comparison;if(!comparison?.pre_human)continue;
      const identity=JSON.stringify([comparison.customer_id,comparison.scope,comparison.source_id]);if(seen.has(identity))continue;seen.add(identity);
      const labels:BehaviorEvaluationSample['labels']={};
      for(const review of journal.reviews??[])if(review.customer_id===customerId&&review.scope===scope&&review.authorization_id===comparison.authorization_id&&review.source_id===comparison.source_id)labels[review.filter_id]={verdict:review.verdict,observed_at:review.at};
      samples.push({comparison,labels});
    }
    const reviews:NonNullable<BehaviorProfileDashboard['reviews']>=[];
    const purchases=scope==='local'?runs.flatMap(r=>r.purchases.filter(p=>p.assessments.at(-1)?.decision==='approve').map(p=>({event:p.event,assessment:p.assessments.find(a=>a.behavior_learning?.comparison?.pre_human&&a.behavior_learning.applied_filter_ids.length),timezone:r.config.parameters.timezone}))):relevantEntries.filter(e=>e.accepted?.decision==='approve').map(e=>({event:e.event,assessment:e.proposal?.snapshot as Assessment|undefined,timezone:(e.proposal?.snapshot as Assessment|undefined)?.behavior_learning?.profile.timezone??timezone}));
    const reviewSeen=new Set<string>();
    for(const purchase of purchases){const a=purchase.assessment;if(!a?.behavior_learning?.comparison?.pre_human)continue;
      for(const filter_id of a.behavior_learning.applied_filter_ids){const context_key=habitContext(filter_id,purchase.event,purchase.timezone);if(context_key===null)continue;const source_id=a.behavior_learning.comparison.source_id;const identity=JSON.stringify([source_id,filter_id]);if(reviewSeen.has(identity))continue;reviewSeen.add(identity);
        const review=journal.reviews?.filter(r=>r.customer_id===customerId&&r.scope===scope&&r.source_id===source_id&&r.filter_id===filter_id).at(-1);
        reviews.push({authorization_id:a.authorization_id,source_id,filter_id,context_key,occurred_at:a.scenario_timestamp,verdict:review?.verdict??null});
      }
    }
    const report=summarizeBehaviorComparisons(samples,{dataset_id:`profile:${customerId}:${scope}`,kind:'observed',description:'Observed prototype decisions. Automatic approvals have no correctness label.'});
    return {customer_id:customerId,scenario_id:scenarioId,scope,revision:journal.sequence,profile,
      permissions:scope==='local'?runs.map(r=>({run_id:r.run_id,mandate_id:r.config.mandate_id,status:r.status,learning_enabled:r.config.parameters.learn_confirmed_habits===true,items:permissionSummary(r.config.parameters)})):views.map(r=>({run_id:r.run_id,mandate_id:r.mandate_id,status:r.status,learning_enabled:r.config.parameters.learn_confirmed_habits===true,items:permissionSummary(r.config.parameters)})),
      reviews:reviews.sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)).slice(0,allReviews?undefined:20),
      controls:journal.controls.filter(c=>c.customer_id===customerId&&c.scope===scope).sort((a,b)=>b.sequence-a.sequence),
      metrics:{evaluations:report.samples,alerts_avoided:report.filters.reduce((n,f)=>n+f.suppressed_reviews,0),interruptions_avoided:report.eligible_step_ups_avoided,
        verified_suppressions:report.filters.reduce((n,f)=>n+f.known_suppressed_confirmed,0),contradicted_suppressions:report.filters.reduce((n,f)=>n+f.known_suppressed_rejected,0),unknown_suppressions:report.filters.reduce((n,f)=>n+f.unknown_suppressed,0),
        by_filter:report.filters.map(f=>({filter_id:f.filter_id,evaluations:f.baseline_reviews,alerts_avoided:f.suppressed_reviews,verified:f.known_suppressed_confirmed,contradicted:f.known_suppressed_rejected,unknown:f.unknown_suppressed}))},
      notice:'Synthetic customer profile. Habits use explicit confirmations; evidence weight is not a safety probability. The profile date follows the last simulated purchase. Saved permissions remain mandatory. Suppressed alerts without a later explicit check remain unverified.'};
  }

  feedback(input:BehaviorFeedbackRequest,actor:HumanActor,key:string):BehaviorProfileDashboard {
    const customerId=this.customer(input.scenario_id);
    if(actor.customer_id!==customerId||actor.role!=='simulated_human'||actor.channel!=='local_ui'||actor.authenticated_by_server!==true)throw new AppError(403,'PROFILE_OWNER_REQUIRED','Open this customer profile before reviewing its habits.');
    if(!['local','live'].includes(input.scope)||!['C15','C18','C19'].includes(input.filter_id)||!['confirmed','rejected'].includes(input.verdict)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw new AppError(400,'PROFILE_FEEDBACK_INVALID','The habit review is invalid.');
    const view=this.detail(input.scenario_id,input.scope,true);
    const source=view.reviews?.find(r=>r.authorization_id===input.authorization_id&&r.filter_id===input.filter_id);
    const live=liveHabitObservations(this.liveEntries());
    this.simulations.store.transaction(key,{action:'behavior-feedback',input,actor},state=>{
      if(!source)throw new AppError(404,'PROFILE_REVIEW_NOT_FOUND','Choose a saved learned decision to review.');
      const journal=synchronizeBehaviorJournal(state,[...localHabitObservations(state.runs),...live]);
      if(journal.sequence!==input.expected_revision)throw new AppError(409,'PROFILE_REVISION_CONFLICT','The profile changed. Refresh it and review this action again.');
      const at=this.clock().toISOString();
      (journal.reviews??=[]).push({sequence:++journal.sequence,customer_id:customerId,scope:input.scope,source_id:source.source_id,authorization_id:source.authorization_id,filter_id:source.filter_id,context_key:source.context_key,verdict:input.verdict,at,actor_id:actor.actor_id});
      if(input.verdict==='rejected')journal.controls.push({sequence:++journal.sequence,customer_id:customerId,scope:input.scope,filter_id:source.filter_id,context_key:source.context_key,action:'suspend',at,actor_id:actor.actor_id});
      return {sequence:journal.sequence};
    });
    return this.detail(input.scenario_id,input.scope);
  }

  control(input:BehaviorControlRequest,actor:HumanActor,key:string):BehaviorProfileDashboard {
    const customerId=this.customer(input.scenario_id);
    if(actor.customer_id!==customerId||actor.role!=='simulated_human'||actor.channel!=='local_ui'||actor.authenticated_by_server!==true)throw new AppError(403,'PROFILE_OWNER_REQUIRED','Open this customer profile before changing its habits.');
    if(!['local','live'].includes(input.scope)||!['C15','C18','C19'].includes(input.filter_id)||!['forget','suspend','resume'].includes(input.action)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0||!input.context_key?.trim()||input.context_key.length>512||/[\u0000-\u001f\u007f]/u.test(input.context_key))throw new AppError(400,'PROFILE_CONTROL_INVALID','The habit change is invalid.');
    const live=liveHabitObservations(this.liveEntries());
    this.simulations.store.transaction(key,{action:'behavior-control',input,actor},state=>{
      const journal=synchronizeBehaviorJournal(state,[...localHabitObservations(state.runs),...live]);
      if(journal.sequence!==input.expected_revision)throw new AppError(409,'PROFILE_REVISION_CONFLICT','The profile changed. Refresh it and review this action again.');
      const matches=(o:{customer_id:string;scope:BehaviorScope;filter_id:HabitFilterId;context_key:string})=>o.customer_id===customerId&&o.scope===input.scope&&o.filter_id===input.filter_id&&o.context_key===input.context_key;
      if(!journal.observations.some(matches)&&!journal.controls.some(matches))throw new AppError(404,'HABIT_NOT_FOUND','This habit is not present in the customer profile.');
      const controls=journal.controls.filter(matches);
      let suspended=false;for(const control of controls){if(control.action==='suspend')suspended=true;if(control.action==='resume')suspended=false;}
      if(input.action==='resume'&&!suspended)throw new AppError(409,'HABIT_NOT_SUSPENDED','Only a suspended habit can be resumed.');
      journal.controls.push({sequence:++journal.sequence,customer_id:customerId,scope:input.scope,filter_id:input.filter_id,context_key:input.context_key,action:input.action,at:this.clock().toISOString(),actor_id:actor.actor_id});
      return {sequence:journal.sequence};
    });
    return this.detail(input.scenario_id,input.scope);
  }
}
