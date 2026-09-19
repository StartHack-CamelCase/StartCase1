import { resolve } from 'node:path';
import { loadDataPack, AuthorizationEventFactory } from '../packages/local-runtime/src/data/index.js';
import type { RunRecord } from '../packages/contracts/src/run.js';
import type { SimRun, SafetyConfig } from '../packages/contracts/src/simulation.js';
import { defaultParameters } from '../packages/local-runtime/src/simulation/config.js';
import { hash, offerHash, type EvaluationContext } from '../packages/local-runtime/src/simulation/common.js';
const pack=await loadDataPack({dataDir:resolve('data')});
const factory=new AuthorizationEventFactory(pack,resolve('data/schemas/authorization_event.schema.json'));
export function fixture(sourceId='AU0004'):EvaluationContext {
 const attempt=pack.attempts.find(a=>a.authorization_id===sourceId)!;
 const authority=pack.authoritiesById.get(attempt.authority_id)!;
 const now='2026-09-19T00:00:00.000Z';
 const skeleton:RunRecord={run_id:'TEST_RUN' as never,run_key:'TEST',scenario_id:attempt.scenario_id,mode:'inspection',mandate_id:'TEST_MANDATE' as never,mandate_version:1,mandate_snapshot:{mandate_id:'TEST_MANDATE' as never,status:'active',customer_id:authority.customer_id,card_id:attempt.card_id,instruction:'Test confirmed constraints',hard_rules:[],uncertainty_policy:'ask',profile_id:'TEST_PROFILE' as never},fixture_authority_id:attempt.authority_id,customer_id:authority.customer_id,card_id:attempt.card_id,profile_id:'TEST_PROFILE' as never,status:'ready',next_replay_order:attempt.replay_order,total_attempts:45,emitted_count:0,started_at:now,finished_at:null,config:{decision_timeout_ms:8000,history_window_minutes:10},pack_version:pack.pack_version,engine_version:null,facts_version:null,commands:[]};
 const event=factory.build({attempt,run:skeleton,priorRecords:[],receivedAt:new Date(now)}).event;
 const config:SafetyConfig={schema_version:1,config_id:'CFG_TEST',mandate_id:'TEST_MANDATE',mandate_version:1,revision:1,instruction:skeleton.mandate_snapshot.instruction,instruction_hash:hash(skeleton.mandate_snapshot.instruction),status:'confirmed',parameters:{...defaultParameters(),domestic_country:'CH'},requirements:[{requirement_id:'TEST_REQ',source_excerpt:'Test confirmed constraints',description:'Test permission',filter_ids:['C03'],parameter_keys:[],status:'confirmed',author:'test',revision:1,question:null}],created_at:now,confirmed_by:'test',confirmed_at:now};
 const run:SimRun={schema_version:1,scope:'local_simulation',run_id:'TEST_RUN',run_key:'TEST',scenario_id:attempt.scenario_id,customer_id:authority.customer_id,card_id:attempt.card_id,authority_id:attempt.authority_id,mandate_snapshot:event.mandate,mandate_version:1,config,budget_scope_id:'BUDGET_TEST',status:'active',next_index:0,revision:1,history:pack.history,history_hash:hash(pack.history),history_coverage:{from:pack.history[0]!.timestamp,to:pack.history.at(-1)!.timestamp,rows:pack.history.length},purchases:[],commitments:[],reservations:[],audit:[],created_at:now};
 return {pack:structuredClone(pack),event,config,run,now,offer_hash:offerHash(event,config),answers:[],phase:'assess'};
}
