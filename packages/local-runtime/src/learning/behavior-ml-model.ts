import { createHash } from 'node:crypto';
import { BEHAVIOR_ML_FEATURE_VERSION, FEATURE_NAMES } from '../../../contracts/src/behavior-ml.js';
import type { BehaviorMLMetrics, BehaviorMLModel, MLExample, MLFeatureVector } from '../../../contracts/src/behavior-ml.js';
import type { BehaviorScope, HabitFilterId } from '../../../contracts/src/behavior.js';

export { BEHAVIOR_ML_FEATURE_VERSION, FEATURE_NAMES } from '../../../contracts/src/behavior-ml.js';
export const BEHAVIOR_ML_MINIMUM_PER_CLASS = 5;
const ALGORITHM_VERSION = 'behavior-logistic-l2-v1';
const L2 = 0.05;
const LEARNING_RATE = 0.25;
const ITERATIONS = 400;
const signedFeatures = new Set([4, 5, 9]);
const digest = (value:unknown):string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a:string,b:string):number => a < b ? -1 : a > b ? 1 : 0;
export type BehaviorMLTrainingOptions = { filterId: HabitFilterId; scope: BehaviorScope; asOf?: string };

type ValidExample = { value: MLExample; prediction: number; labelTime: number; identity: string };
function text(value:unknown):value is string { return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }
function instant(value:unknown):number {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const parsed=Date.parse(value);if(!Number.isFinite(parsed))return NaN;
  const [datePart,timePart]=value.split('T'),[year,month,day]=datePart!.split('-').map(Number),time=timePart!.slice(0,8).split(':').map(Number);
  const leap=year!%4===0&&(year!%100!==0||year!%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return month!>=1&&month!<=12&&day!>=1&&day!<=days[month!-1]!&&time[0]!<24&&time[1]!<60&&time[2]!<60?parsed:NaN;
}
/** Freeze a validated copy. Features 4,5,9 are signed; the others lie in [0,1]. */
export function validateMLFeatureVector(input:unknown):MLFeatureVector {
  if(!Array.isArray(input)||input.length!==FEATURE_NAMES.length||FEATURE_NAMES.some((_,i)=>typeof input[i]!=='number'||!Number.isFinite(input[i])||input[i]>1||input[i]<(signedFeatures.has(i)?-1:0)))throw Error('behavior_ml_features_invalid');
  return Object.freeze(input.map(value=>Object.is(value,-0)?0:value));
}
function optionsCutoff(options:BehaviorMLTrainingOptions):number {
  if(!options||!['C15','C18','C19'].includes(options.filterId)||!['local','live'].includes(options.scope))throw Error('behavior_ml_options_invalid');
  const cutoff=options.asOf===undefined?Infinity:instant(options.asOf);
  if(!Number.isFinite(cutoff)&&cutoff!==Infinity)throw Error('behavior_ml_cutoff_invalid');
  return cutoff;
}
/** Latest label known at the cutoff wins. Identity and feature snapshots stay fixed.
 * Availability filtering precedes conflict detection to avoid future corrections
 * changing the training set that was available for an earlier prediction. */
function eligibleExamples(examples:readonly MLExample[],options:BehaviorMLTrainingOptions):{rows:ValidExample[];excluded:number} {
  if(!Array.isArray(examples))throw Error('behavior_ml_examples_invalid');
  const cutoff=optionsCutoff(options),groups=new Map<string,ValidExample[]>();let targeted=0;
  for(const raw of examples){
    if(raw?.filter_id!==options.filterId||raw?.scope!==options.scope)continue;
    targeted++;
    const labelTime=instant(raw.label_at);
    if(!Number.isFinite(labelTime)||labelTime>=cutoff)continue;
    const prediction=instant(raw.predicted_at);
    if(!text(raw.id)||!text(raw.customer_id)||!Number.isFinite(prediction)||labelTime<prediction||(raw.label!==0&&raw.label!==1))continue;
    let features:MLFeatureVector;try{features=validateMLFeatureVector(raw.features);}catch{continue;}
    const value:MLExample={id:raw.id,customer_id:raw.customer_id,scope:raw.scope,filter_id:raw.filter_id,predicted_at:new Date(prediction).toISOString(),label_at:new Date(labelTime).toISOString(),features,label:raw.label};
    const identity=JSON.stringify([value.customer_id,value.id]),group=groups.get(identity)??[];
    group.push({value,prediction,labelTime,identity});groups.set(identity,group);
  }
  const rows:ValidExample[]=[];
  for(const group of groups.values()){
    const first=group[0]!;
    // The same purchase cannot be replayed with a more favorable feature vector.
    if(group.some(row=>row.prediction!==first.prediction||row.value.features.some((value,i)=>value!==first.value.features[i])))continue;
    group.sort((a,b)=>a.labelTime-b.labelTime);
    const latest=group.at(-1)!;
    // An unambiguous later correction can resolve an earlier same-clock conflict.
    if(group.some(row=>row.labelTime===latest.labelTime&&row.value.label!==latest.value.label))continue;
    rows.push(latest);
  }
  rows.sort((a,b)=>compare(a.identity,b.identity));
  return {rows,excluded:targeted-rows.length};
}
function sigmoid(logit:number):number {
  if(logit>=0){const e=Math.exp(-logit);return 1/(1+e);}
  const e=Math.exp(logit);return e/(1+e);
}
function logit(model:Pick<BehaviorMLModel,'coefficients'|'intercept'>,features:MLFeatureVector):number {
  return model.coefficients.reduce((sum,w,i)=>sum+w*features[i]!,model.intercept);
}
/** Stable cross-entropy directly from the logit, including saturated scores. */
function logLoss(z:number,label:0|1):number { return Math.max(z,0)-label*z+Math.log1p(Math.exp(-Math.abs(z))); }

/** Pure batch training. This function must not run on the payment decision path.
 * Five examples of each class is an engineering gate, not statistical validation.
 * Objective: mean(logloss) + L2/2 * ||coefficients||²; intercept is unpenalized. */
export function trainBehaviorML(examples:readonly MLExample[],options:BehaviorMLTrainingOptions):BehaviorMLModel {
  const {rows,excluded}=eligibleExamples(examples,options),samples=rows.length;
  const positive=rows.reduce((sum,row)=>sum+row.value.label,0),negative=samples-positive;
  const coefficients=Array<number>(FEATURE_NAMES.length).fill(0);let intercept=0;
  const status:BehaviorMLModel['status']=positive>=BEHAVIOR_ML_MINIMUM_PER_CLASS&&negative>=BEHAVIOR_ML_MINIMUM_PER_CLASS?'trained':'insufficient_data';
  if(status==='trained'){
    intercept=Math.log(positive/negative);
    for(let step=0;step<ITERATIONS;step++){
      const gradient=coefficients.map(value=>L2*value);let interceptGradient=0;
      for(const row of rows){
        const z=coefficients.reduce((sum,w,i)=>sum+w*row.value.features[i]!,intercept),residual=sigmoid(z)-row.value.label;
        interceptGradient+=residual/samples;
        for(let i=0;i<gradient.length;i++)gradient[i]=gradient[i]!+residual*row.value.features[i]!/samples;
      }
      intercept-=LEARNING_RATE*interceptGradient;
      for(let i=0;i<coefficients.length;i++)coefficients[i]=coefficients[i]!-LEARNING_RATE*gradient[i]!;
    }
  }
  const base={status,filter_id:options.filterId,scope:options.scope,feature_version:BEHAVIOR_ML_FEATURE_VERSION,coefficients:Object.freeze(coefficients),intercept,positive,negative,samples,excluded};
  // Excluded retries do not change the model identity or coefficients.
  const version=digest({algorithm:ALGORITHM_VERSION,feature_version:base.feature_version,filter:options.filterId,scope:options.scope,l2:L2,learning_rate:LEARNING_RATE,iterations:ITERATIONS,minimum_per_class:BEHAVIOR_ML_MINIMUM_PER_CLASS,training:rows.map(row=>row.value),coefficients,intercept,status});
  return Object.freeze({...base,version});
}

/** Output is an uncalibrated confirmation score, never a fraud/safety probability. */
export function scoreBehaviorML(model:BehaviorMLModel,features:MLFeatureVector):number|null {
  const x=validateMLFeatureVector(features);
  if(model.status!=='trained')return null;
  if(model.feature_version!==BEHAVIOR_ML_FEATURE_VERSION||model.coefficients.length!==FEATURE_NAMES.length||FEATURE_NAMES.some((_,i)=>!Number.isFinite(model.coefficients[i]))||!Number.isFinite(model.intercept))throw Error('behavior_ml_model_invalid');
  const z=logit(model,x);if(!Number.isFinite(z))throw Error('behavior_ml_model_invalid');
  return sigmoid(z);
}

/** Test before learning its feedback, with same-instant predictions grouped.
 * Training retains all label versions so a later correction cannot leak backwards.
 * Outcomes use the latest available verdict for the retrospective metric only. */
export function evaluateBehaviorMLProgressively(examples:readonly MLExample[],options:BehaviorMLTrainingOptions):BehaviorMLMetrics {
  const {rows,excluded}=eligibleExamples(examples,options),groups=new Map<number,ValidExample[]>();
  for(const row of rows){const group=groups.get(row.prediction)??[];group.push(row);groups.set(row.prediction,group);}
  const result:BehaviorMLMetrics={total:rows.length,scored:0,insufficient:0,excluded,positive:0,negative:0,brier:null,log_loss:null};
  let squaredError=0,crossEntropy=0;
  for(const [prediction,group] of [...groups].sort((a,b)=>a[0]-b[0])){
    const model=trainBehaviorML(examples,{filterId:options.filterId,scope:options.scope,asOf:new Date(prediction).toISOString()});
    for(const row of group){
      const score=scoreBehaviorML(model,row.value.features);
      if(score===null){result.insufficient++;continue;}
      result.scored++;result.positive+=row.value.label;result.negative+=1-row.value.label;
      squaredError+=(score-row.value.label)**2;crossEntropy+=logLoss(logit(model,row.value.features),row.value.label);
    }
  }
  if(result.scored){result.brier=squaredError/result.scored;result.log_loss=crossEntropy/result.scored;}
  return result;
}
