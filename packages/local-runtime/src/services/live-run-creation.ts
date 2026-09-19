import { hash } from '../simulation/common.js';
import type { LiveBinding } from '../simulation/live-engine.js';
import { liveFeedRows, type VisecaClient } from '../simulation/viseca-client.js';
import type { VisecaOutbox } from '../simulation/viseca-worker.js';

/** CLI starts own a durable intent before their first network mutation. A lost
 * response can only be recovered by a matching authoritative run, never a POST. */
export async function createLiveRunDurably(client:VisecaClient,outbox:VisecaOutbox,binding:LiveBinding):Promise<string> {
 const fingerprint=hash(binding),saved=outbox.value;
 if(saved.run_start){
  if(saved.run_start.fingerprint!==fingerprint)throw Error('live_start_binding_conflict');
  if(saved.run_start.status==='created'&&saved.run_id)return saved.run_id;
  if(!saved.run_start.existing_run_ids)throw Error('live_start_submission_unknown_requires_reconciliation');
  const reconciled=await client.reconcile('0');
  const candidates=new Set<string>();
  for(const row of liveFeedRows(reconciled.events)){
   const data=payload(row),mandate=payload(data['mandate']);
   const id=row['run_id']??data['run_id'];
   if((data['mandate_id']??mandate['mandate_id'])===binding.live_mandate_id&&typeof id==='string'&&id&&!saved.run_start.existing_run_ids.includes(id))candidates.add(id);
  }
  if(candidates.size!==1)throw Error('live_start_submission_unknown_requires_reconciliation');
  const runId=[...candidates][0]!,remote=payload(await client.getRun(runId));
  if(remote['mandate_id']!==binding.live_mandate_id||remote['scenario_id']!==binding.scenario_id)throw Error('live_start_reconciliation_conflict');
  saved.run_id=runId;saved.snapshot=structuredClone(binding);saved.run_start.status='created';await outbox.save();return runId;
 }
 if(saved.run_id)throw Error('immutable_live_snapshot_conflict');
 const before=await client.reconcile('0');
 const existingRunIds=liveFeedRows(before.events).map(row=>row['run_id']??payload(row)['run_id']).filter((id):id is string=>typeof id==='string');
 saved.run_start={fingerprint,status:'intended',existing_run_ids:[...new Set(existingRunIds)]};await outbox.save();
 try{
  const result=payload(await client.createRun({scenario_id:binding.scenario_id,mandate_id:binding.live_mandate_id}));
  const runId=result['run_id'];if(typeof runId!=='string'||!runId)throw Error('remote_run_id_missing');
  saved.run_id=runId;saved.snapshot=structuredClone(binding);saved.run_start.status='created';await outbox.save();return runId;
 }catch(error){saved.run_start.status='unknown';await outbox.save();throw error;}
}

function payload(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const record=value as Record<string,unknown>;
 return record['data']&&typeof record['data']==='object'&&!Array.isArray(record['data'])?record['data'] as Record<string,unknown>:record;
}
