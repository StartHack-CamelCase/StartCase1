import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BehaviorJournal } from '../../../contracts/src/behavior-dashboard.js';
import type { BehaviorMLDashboard } from '../../../contracts/src/behavior-ml.js';
import type { BehaviorScope } from '../../../contracts/src/behavior.js';
import { hash } from '../simulation/common.js';
import { projectBehaviorML, type MLDataset } from './behavior-ml-projection.js';

const cache=new Map<string,{at:number;result:Promise<BehaviorMLDashboard>}>();
/** Bounded current cohort: latest 100 stable sources per filter, all corrections
 * of those sources retained. Selection does not depend on the label value. */
export function boundBehaviorMLDataset(dataset:MLDataset):MLDataset {
  const records=dataset.records.filter(r=>['C15','C18','C19'].includes(r.snapshot.filter_id));
  const selected=(['C15','C18','C19'] as const).flatMap(id=>records.filter(r=>r.snapshot.filter_id===id).sort((a,b)=>Date.parse(b.snapshot.predicted_at)-Date.parse(a.snapshot.predicted_at)).slice(0,100));
  const ids=new Set(selected.map(r=>JSON.stringify([r.customer_id,r.scope,r.snapshot.filter_id,r.snapshot.source_id])));
  return {...dataset,examples:dataset.examples.filter(e=>ids.has(JSON.stringify([e.customer_id,e.scope,e.filter_id,e.id])))};
}

export async function analyzeBehaviorMLInWorker(dataset:MLDataset,journal:BehaviorJournal,customerId:string,scope:BehaviorScope,asOf:string):Promise<BehaviorMLDashboard> {
  const bounded=boundBehaviorMLDataset(dataset),key=hash({bounded,journal,customerId,scope,cutoff:Math.floor(Date.parse(asOf)/30_000)});
  const previous=cache.get(key);if(previous&&Date.now()-previous.at<30_000)return structuredClone(await previous.result);
  const result=new Promise<BehaviorMLDashboard>((resolve)=>{
    let worker:Worker|undefined,finished=false;
    const finish=(value:BehaviorMLDashboard)=>{if(finished)return;finished=true;clearTimeout(timer);void worker?.terminate();resolve(value);};
    const fallback=()=>{const value=projectBehaviorML({...bounded,examples:[],records:[]},journal,customerId,scope,asOf);value.notice='Model analysis is temporarily unavailable. No payment decisions are affected. Refresh to retry.';cache.delete(key);finish(value);};
    const timer=setTimeout(fallback,15_000);
    try {
      const compiled=new URL('./behavior-ml-worker.js',import.meta.url);
      worker=existsSync(compiled)
        ?new Worker(compiled,{workerData:{dataset:bounded,journal,customerId,scope,asOf}})
        :new Worker("import('tsx/esm/api').then(({tsImport}) => tsImport(require('node:worker_threads').workerData.module, { parentURL: require('node:url').pathToFileURL(process.cwd() + '/').href }));",{eval:true,workerData:{module:fileURLToPath(new URL('./behavior-ml-worker.ts',import.meta.url)),dataset:bounded,journal,customerId,scope,asOf}});
    } catch { fallback(); return; }
    worker.once('message',(value:BehaviorMLDashboard)=>{value.notice+=' Training and replay use the latest 100 recorded contexts per filter in this environment; older sources remain in the audit. Results are cached for up to 30 seconds.';finish(value);});
    worker.once('error',fallback);worker.once('exit',()=>{if(!finished)fallback();});
  });
  cache.set(key,{at:Date.now(),result});while(cache.size>8)cache.delete(cache.keys().next().value!);
  return structuredClone(await result);
}
