import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import type { BehaviorScope } from '../../../contracts/src/behavior.js';
import type { Assessment, SimulationDocument } from '../../../contracts/src/simulation.js';
import { ML_FEATURE_VERSION, SIMPLE_CONTEXT_VERSION, type BehaviorMLDashboard, type MLExample, type MLFeatureSnapshot } from '../../../contracts/src/behavior-ml.js';
import type { LiveEntry } from '../simulation/viseca-worker.js';
import { trainBehaviorML, scoreBehaviorML, evaluateBehaviorMLProgressively, validateMLFeatureVector } from './behavior-ml-model.js';

export type MLContextRecord = { customer_id: string; scope: BehaviorScope; authorization_id: string; snapshot: MLFeatureSnapshot };
export type MLDataset = { records: MLContextRecord[]; examples: MLExample[]; excluded_legacy_assessments: number; excluded_controlled: number; unknown: number };

function controlState(journal: BehaviorJournal, record: MLContextRecord, cutoff=Infinity) {
  let generation = 0, suspended = false;
  for (const c of journal.controls.filter(c => c.customer_id === record.customer_id && c.scope === record.scope && c.filter_id === record.snapshot.filter_id && c.context_key === record.snapshot.context_key && Date.parse(c.at)<=cutoff).sort((a,b) => a.sequence-b.sequence)) {
    if (c.action === 'forget' || c.action === 'resume') generation = c.sequence;
    if (c.action === 'suspend') suspended = true;
    if (c.action === 'resume') suspended = false;
  }
  return { generation, suspended, invalid: journal.invalid_profiles?.some(p => p.customer_id === record.customer_id && p.scope === record.scope) === true };
}

/** No retrospective feature reconstruction: a legacy decision without a frozen
 * snapshot cannot enter supervised training. Identity is a replay-stable source. */
export function collectBehaviorMLDataset(state: SimulationDocument, entries: readonly LiveEntry[], journal: BehaviorJournal, scope: BehaviorScope, asOf?: string, options: {includeSuspendedLabels?:boolean} = {}): MLDataset {
  const cutoff=asOf===undefined?Infinity:Date.parse(asOf);
  if(!Number.isFinite(cutoff)&&cutoff!==Infinity)throw Error('behavior_ml_cutoff_invalid');
  const candidates: Array<{customer_id:string;scope:BehaviorScope;assessment:Assessment}> = scope === 'local'
    ? state.runs.flatMap(r => r.purchases.flatMap(p => p.assessments.map(assessment => ({customer_id:r.customer_id,scope,assessment}))))
    : entries.flatMap(e => {const assessment=e.proposal?.snapshot as Assessment|undefined;return assessment?.schema_version===1?[{customer_id:e.event.mandate.customer_id,scope,assessment}]:[];});
  const snapshots=(a:Assessment)=>Array.isArray(a.behavior_learning?.ml_features)?a.behavior_learning.ml_features:[];
  const knowledge=(a:Assessment)=>Math.min(...snapshots(a).flatMap(s=>Number.isSafeInteger(s?.knowledge_sequence)&&s.knowledge_sequence>=0?[s.knowledge_sequence]:[]),Infinity);
  candidates.sort((a,b) => knowledge(a.assessment)-knowledge(b.assessment)||Date.parse(a.assessment.recorded_at)-Date.parse(b.assessment.recorded_at));
  const records: MLContextRecord[] = [], seen = new Set<string>();
  const sourceKey=(customer:string,filter:string,source:string)=>JSON.stringify([customer,scope,filter,source]);
  const authorizations=new Map<string,Array<{authorization_id:string;context_key:string;predicted_at:string;review_source_id:string|undefined}>>();
  let excluded_legacy_assessments = 0;
  for (const {customer_id,assessment:a} of candidates) {
    if (!a.behavior_learning?.enabled || a.behavior_learning.profile.scope !== scope) continue;
    if (!a.behavior_learning.ml_features?.length && a.behavior_learning.comparison?.pre_human && a.behavior_learning.comparison.filters.some(f=>f.baseline==='needs_review')) excluded_legacy_assessments++;
    for (const snapshot of snapshots(a)) {
      if (!snapshot || !['C15','C18','C19'].includes(snapshot.filter_id) || typeof snapshot.source_id!=='string' || !snapshot.source_id.trim() || typeof snapshot.context_key!=='string' || !snapshot.context_key.trim() || typeof snapshot.eligible!=='boolean' || typeof snapshot.was_suppressed!=='boolean' || !Number.isFinite(Date.parse(snapshot.predicted_at)) || snapshot.schema_version !== 1 || !([ML_FEATURE_VERSION,SIMPLE_CONTEXT_VERSION] as string[]).includes(snapshot.feature_version) || snapshot.predicted_at !== a.recorded_at || !Number.isSafeInteger(snapshot.knowledge_sequence) || snapshot.knowledge_sequence < 0) continue;
      try { if(snapshot.feature_version===SIMPLE_CONTEXT_VERSION){if(!Array.isArray(snapshot.features)||snapshot.features.length!==0)continue;}else validateMLFeatureVector(snapshot.features); } catch { continue; }
      const key = sourceKey(customer_id,snapshot.filter_id,snapshot.source_id);
      // Replaying one source creates another authorization. Preserve its link to
      // the original context before deduplication so later feedback is not lost.
      const aliases=authorizations.get(key)??[];
      aliases.push({authorization_id:a.authorization_id,context_key:snapshot.context_key,predicted_at:snapshot.predicted_at,review_source_id:a.behavior_learning.comparison?.source_id});
      authorizations.set(key,aliases);
      if (seen.has(key)) continue; seen.add(key);
      records.push({customer_id,scope,authorization_id:a.authorization_id,snapshot});
    }
  }
  const examples: MLExample[] = []; let excluded_controlled=0,unknown=0;
  for (const record of records) {
    const s=record.snapshot,controls=controlState(journal,record,cutoff);
    if(controls.invalid || s.knowledge_sequence<controls.generation){excluded_controlled++;continue;}
    const base={id:s.source_id,customer_id:record.customer_id,scope,filter_id:s.filter_id,predicted_at:s.predicted_at,features:s.features};
    const aliases=authorizations.get(sourceKey(record.customer_id,s.filter_id,s.source_id))!;
    const matching=(value:{customer_id:string;scope:BehaviorScope;authorization_id:string;filter_id:string;context_key:string;source_id:string},at:string,review=false)=>
      value.customer_id===record.customer_id&&value.scope===scope&&value.filter_id===s.filter_id&&value.context_key===s.context_key&&
      aliases.some(alias=>alias.authorization_id===value.authorization_id&&alias.context_key===s.context_key&&Date.parse(alias.predicted_at)<=Date.parse(at)&&value.source_id===(review?alias.review_source_id:s.source_id));
    const labels:MLExample[]=([
      ...journal.observations.filter(o=>matching(o,o.recorded_at)).map(o=>({...base,label:1 as const,label_at:o.recorded_at})),
      ...(journal.reviews??[]).filter(r=>matching(r,r.at,true)).map(r=>({...base,label:r.verdict==='confirmed'?1 as const:0 as const,label_at:r.at})),
    ] as MLExample[]).filter(e=>Date.parse(e.label_at)<cutoff);
    if(!labels.length)unknown++;
    // Retain negative teaching when a rejection suspends its context. Suspension
    // prevents promotion; forgetting/resuming removes the entire old generation.
    const latest=[...labels].sort((a,b)=>Date.parse(a.label_at)-Date.parse(b.label_at)).at(-1);
    if(options.includeSuspendedLabels||(!controls.suspended && s.eligible)||latest?.label===0)examples.push(...labels);
  }
  return {records,examples,excluded_legacy_assessments,excluded_controlled,unknown};
}

/** Fitting and retrospective scoring run only when profiles are inspected.
 * They cannot supply an approve/decline/step-up decision. */
export function projectBehaviorML(dataset: MLDataset, journal: BehaviorJournal, customerId: string, scope: BehaviorScope, asOf: string): BehaviorMLDashboard {
  const models=(['C15','C18','C19'] as const).map(filter_id=>{
    const model=trainBehaviorML(dataset.examples,{filterId:filter_id,scope,asOf});
    return {model,metrics:evaluateBehaviorMLProgressively(dataset.examples.filter(e=>Date.parse(e.label_at)<Date.parse(asOf)),{filterId:filter_id,scope})};
  });
  const predictions=dataset.records.filter(r=>r.customer_id===customerId&&r.scope===scope).sort((a,b)=>Date.parse(b.snapshot.predicted_at)-Date.parse(a.snapshot.predicted_at)).slice(0,20).map(r=>{
    const s=r.snapshot,model=models.find(m=>m.model.filter_id===s.filter_id)!.model,controls=controlState(journal,r,Date.parse(asOf));
    const abstention_reason=controls.invalid?'Profile evidence is inconsistent.':controls.suspended?'This context is suspended.':s.knowledge_sequence<controls.generation?'This context belongs to a forgotten generation.':!s.eligible?'Learning was suspended when these facts were recorded.':model.status!=='trained'?'More explicit confirmations and rejections are needed.':null;
    const label=dataset.examples.filter(e=>e.id===s.source_id&&e.customer_id===r.customer_id&&e.scope===scope&&e.filter_id===s.filter_id&&Date.parse(e.label_at)<Date.parse(asOf)).sort((a,b)=>Date.parse(a.label_at)-Date.parse(b.label_at)).at(-1);
    return {authorization_id:r.authorization_id,filter_id:s.filter_id,context_key:s.context_key,score:abstention_reason?null:scoreBehaviorML(model,s.features),model_version:model.status==='trained'?model.version:null,observed_label:label?(label.label===1?'confirmed' as const:'rejected' as const):null,retrospective:true as const,abstention_reason};
  });
  return {mode:'shadow',decision_influence:false,feature_version:ML_FEATURE_VERSION,
    models:models.map(({model,metrics})=>({filter_id:model.filter_id,status:model.status,version:model.version,positive:model.positive,negative:model.negative,samples:model.samples,excluded:model.excluded,metrics})),predictions,
    notice:`Observation only: no payment decisions are changed. Models pool opted-in profiles within ${scope}; displayed contexts belong to this customer. Scores are uncalibrated and recomputed with the current model. Metrics are a chronological replay of the currently eligible cohort, not historical deployed performance. ${dataset.unknown} contexts have no explicit label; ${dataset.excluded_legacy_assessments} assessments lack usable frozen features; ${dataset.excluded_controlled} contexts are excluded by controls. At least five distinct sources per class and filter are required to fit; this is not proof of accuracy. Missing feedback is never a success.`};
}
