import { describe, expect, it } from 'vitest';
import type { MLExample, MLFeatureVector } from '../packages/contracts/src/behavior-ml.js';
import { trainBehaviorML, scoreBehaviorML, evaluateBehaviorMLProgressively, validateMLFeatureVector, FEATURE_NAMES } from '../packages/local-runtime/src/learning/behavior-ml-model.js';

const options={filterId:'C15' as const,scope:'local' as const};
function vector(label=0):number[]{const x=Array<number>(FEATURE_NAMES.length).fill(0);x[0]=label;x[4]=2*label-1;return x;}
function example(id:string,label:0|1,patch:Partial<MLExample>={}):MLExample{return {id,customer_id:'C1',scope:'local',filter_id:'C15',predicted_at:'2026-08-01T10:00:00Z',label_at:'2026-08-01T11:00:00Z',features:vector(label),label,...patch};}
const balanced=()=>Array.from({length:10},(_,i)=>example(`source-${i}`,i<5?0:1));

describe('regularized shadow logistic regression',()=>{
  it('abstains until both classes contain five distinct eligible cases',()=>{
    expect(trainBehaviorML([],options)).toMatchObject({status:'insufficient_data',samples:0,positive:0,negative:0});
    const nine=trainBehaviorML(balanced().slice(0,9),options);
    expect(nine).toMatchObject({status:'insufficient_data',samples:9,positive:4,negative:5});
    expect(scoreBehaviorML(nine,vector())).toBeNull();
    expect(trainBehaviorML(balanced(),options)).toMatchObject({status:'trained',positive:5,negative:5});
    expect(trainBehaviorML(Array.from({length:30},(_,i)=>example(`yes-${i}`,1)),options).status).toBe('insufficient_data');
  });

  it('fits an informative bounded feature without mutating input and yields stable artifacts',()=>{
    const examples=balanced(),before=structuredClone(examples),a=trainBehaviorML(examples,options),b=trainBehaviorML([...examples].reverse(),options);
    expect(a).toEqual(b);expect(examples).toEqual(before);
    expect(a.version).toMatch(/^[a-f0-9]{64}$/);
    expect(scoreBehaviorML(a,vector(1))).toBeGreaterThan(0.85);
    expect(scoreBehaviorML(a,vector(0))).toBeLessThan(0.15);
    expect(Object.isFrozen(a)).toBe(true);expect(Object.isFrozen(a.coefficients)).toBe(true);
  });

  it('does not use class reweighting: an uninformative model retains the empirical prior',()=>{
    const rows=Array.from({length:20},(_,i)=>example(`same-${i}`,i<5?0:1,{features:Array<number>(12).fill(0)}));
    const model=trainBehaviorML(rows,options);
    expect(model.coefficients).toEqual(Array<number>(12).fill(0));
    expect(scoreBehaviorML(model,Array<number>(12).fill(0))).toBeCloseTo(0.75,12);
  });

  it('isolates filters and scopes but permits shared coefficients across customers',()=>{
    const examples=balanced(),model=trainBehaviorML(examples,options);
    expect(trainBehaviorML([...examples,...examples.map(e=>({...e,filter_id:'C19' as const,features:vector(1-e.label)})),...examples.map(e=>({...e,scope:'live' as const,features:vector(1-e.label)}))],options)).toEqual(model);
    const differentCustomer=examples.map(e=>({...e,customer_id:'C2'}));
    expect(trainBehaviorML([...examples,...differentCustomer],options).samples).toBe(20);
  });

  it('deduplicates retries before availability gates and rejects conflicting immutable snapshots',()=>{
    const rows=balanced(),model=trainBehaviorML(rows,options),duplicates=trainBehaviorML([...rows,...rows],options);
    expect(duplicates).toMatchObject({samples:10,excluded:10,version:model.version,coefficients:model.coefficients});
    const sameSource=Array.from({length:50},()=>rows[0]!);
    expect(trainBehaviorML(sameSource,options)).toMatchObject({status:'insufficient_data',samples:1,excluded:49});
    expect(trainBehaviorML([...rows,{...rows[0]!,features:vector(1)}],options)).toMatchObject({samples:9,excluded:2,status:'insufficient_data'});
    expect(trainBehaviorML([...rows,{...rows[0]!,label:1}],options)).toMatchObject({samples:9,excluded:2,status:'insufficient_data'});
  });

  it('uses only labels already available, with no self-label or same-instant feedback leakage',()=>{
    const rows=balanced();
    expect(trainBehaviorML(rows,{...options,asOf:'2026-08-01T11:00:00Z'}).samples).toBe(0);
    expect(trainBehaviorML(rows,{...options,asOf:'2026-08-01T11:00:00.001Z'}).samples).toBe(10);
    const invalid=[example('beforeprediction',1,{label_at:'2026-08-01T09:59:59Z'}),example('date-invalid',0,{predicted_at:'2026-02-30T10:00:00Z'}),example('no-label-date',0,{label_at:'unknown'})];
    expect(trainBehaviorML([...rows,...invalid],options)).toMatchObject({samples:10,excluded:3});
    const withFutureConflict=[...rows,{...rows[0]!,features:vector(1),label_at:'2026-09-01T12:00:00Z'}];
    expect(trainBehaviorML(withFutureConflict,{...options,asOf:'2026-08-02T00:00:00Z'})).toMatchObject({version:trainBehaviorML(rows,{...options,asOf:'2026-08-02T00:00:00Z'}).version,samples:10});
  });

  it('resolves corrections using their availability date rather than retroactively changing past training',()=>{
    const rows=balanced(),correction={...rows[0]!,label:1 as const,label_at:'2026-08-03T00:00:00Z'};
    const before=trainBehaviorML([...rows,correction],{...options,asOf:'2026-08-02T00:00:00Z'}),after=trainBehaviorML([...rows,correction],{...options,asOf:'2026-08-04T00:00:00Z'});
    expect(before).toMatchObject({status:'trained',positive:5,negative:5,version:trainBehaviorML(rows,options).version});
    expect(after).toMatchObject({status:'insufficient_data',positive:6,negative:4,samples:10});
    expect(after.version).not.toBe(before.version);
  });

  it('allows an unambiguous later correction to resolve an earlier same-clock label conflict',()=>{
    const rows=balanced(),conflict={...rows[0]!,label:1 as const},correction={...rows[0]!,label_at:'2026-08-03T00:00:00Z'};
    expect(trainBehaviorML([...rows,conflict,correction],{...options,asOf:'2026-08-02T00:00:00Z'})).toMatchObject({status:'insufficient_data',samples:9});
    expect(trainBehaviorML([...rows,conflict,correction],{...options,asOf:'2026-08-04T00:00:00Z'})).toMatchObject({status:'trained',samples:10,positive:5,negative:5});
  });

  it('enforces fixed feature dimensions, finite bounded values and a frozen validated copy',()=>{
    const x=vector(),valid=validateMLFeatureVector(x);expect(valid).toEqual(x);expect(valid).not.toBe(x);expect(Object.isFrozen(valid)).toBe(true);
    const invalid:unknown[]=[[],Array(12),[...x,0],x.slice(1),x.map((v,i)=>i===0?-0.1:v),x.map((v,i)=>i===4?-1.1:v),x.map((v,i)=>i===9?1.1:v),x.map((v,i)=>i===3?NaN:v),x.map((v,i)=>i===2?Infinity:v)];
    for(const value of invalid)expect(()=>validateMLFeatureVector(value)).toThrow('behavior_ml_features_invalid');
    const boundary=vector();boundary[4]=-1;boundary[5]=1;boundary[9]=-1;expect(()=>validateMLFeatureVector(boundary)).not.toThrow();
    expect(trainBehaviorML([...balanced(),example('badfeatures',1,{features:[Infinity]})],options)).toMatchObject({samples:10,excluded:1});
  });

  it('uses a numerically stable sigmoid at extreme valid logits',()=>{
    const m=trainBehaviorML(balanced(),options),zero=Array<number>(12).fill(0);
    expect(scoreBehaviorML({...m,coefficients:zero,intercept:1000},zero)).toBe(1);
    expect(scoreBehaviorML({...m,coefficients:zero,intercept:-1000},zero)).toBe(0);
    expect(()=>scoreBehaviorML({...m,intercept:Infinity},zero)).toThrow('behavior_ml_model_invalid');
    expect(()=>scoreBehaviorML({...m,coefficients:Array(12)},zero)).toThrow('behavior_ml_model_invalid');
  });
});

describe('progressive chronological evaluation',()=>{
  it('has null metrics rather than invented accuracy when no model could score',()=>{
    expect(evaluateBehaviorMLProgressively([],options)).toEqual({total:0,scored:0,insufficient:0,excluded:0,positive:0,negative:0,brier:null,log_loss:null});
    expect(evaluateBehaviorMLProgressively(balanced(),options)).toMatchObject({total:10,scored:0,insufficient:10,brier:null,log_loss:null});
  });

  it('scores a whole prediction-time group before consuming any labels from that instant',()=>{
    const rows=balanced(),time='2026-08-01T11:00:00Z';
    const simultaneous=[example('same0',0,{predicted_at:time,label_at:time}),example('same1',1,{predicted_at:time,label_at:time})];
    const later=[example('later0',0,{predicted_at:'2026-08-02T10:00:00Z',label_at:'2026-08-02T11:00:00Z'}),example('later1',1,{predicted_at:'2026-08-02T10:00:00Z',label_at:'2026-08-02T11:00:00Z'})];
    const metrics=evaluateBehaviorMLProgressively([...rows,...simultaneous,...later],options);
    expect(metrics).toMatchObject({total:14,scored:2,insufficient:12,positive:1,negative:1});
    expect(metrics.brier).toBeLessThan(0.03);expect(metrics.log_loss).toBeLessThan(0.2);
    expect(evaluateBehaviorMLProgressively([...later,...simultaneous,...rows].reverse(),options)).toEqual(metrics);
  });

  it('trains on the old known label before a later correction while evaluating the final verdict',()=>{
    const rows=balanced();
    const target=example('target',1,{predicted_at:'2026-08-02T10:00:00Z',label_at:'2026-08-02T11:00:00Z'});
    const correction={...rows[0]!,label:1 as const,label_at:'2026-08-03T10:00:00Z'};
    const without=evaluateBehaviorMLProgressively([...rows,target],options),withCorrection=evaluateBehaviorMLProgressively([...rows,target,correction],options);
    expect(withCorrection).toMatchObject({scored:1,insufficient:10,brier:without.brier,log_loss:without.log_loss});
    // Flattening to the latest labels would remove a past negative and incorrectly abstain.
    expect(evaluateBehaviorMLProgressively([...rows.slice(1),correction,target],options).scored).toBe(0);
  });

  it('returns exact Brier and log loss on held-out predictions with a constant empirical prior',()=>{
    const zero:MLFeatureVector=Array<number>(12).fill(0);
    const training=balanced().map(row=>({...row,features:zero}));
    const target=example('heldout',1,{features:zero,predicted_at:'2026-08-02T10:00:00Z',label_at:'2026-08-02T11:00:00Z'});
    const metrics=evaluateBehaviorMLProgressively([...training,target],options);
    expect(metrics).toMatchObject({scored:1,positive:1,negative:0});expect(metrics.brier).toBe(0.25);expect(metrics.log_loss).toBeCloseTo(Math.log(2),14);
  });
});
