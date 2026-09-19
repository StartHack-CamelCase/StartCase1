import {configuredInstructionDecoder,readyWalletPreparation} from './helpers/configured-instruction-decoder.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {createLocalRuntime} from '../packages/local-runtime/src/runtime.js';
import {fixture} from './simulation-fixture.js';
import {preparePermissions} from '../packages/local-runtime/src/services/wallet-preparation.js';
import type {InstructionDecoding} from '../packages/contracts/src/instruction-decoding.js';
import type {WalletRunView} from '../packages/contracts/src/wallet.js';
import type {HumanActor} from '../packages/contracts/src/simulation.js';

const instruction='Buy groceries for at most CHF 25. The order must be returnable.';
it('retains a decoded returnability requirement when no minimum return period was supplied',()=>{
 const {pack,now}=fixture();
 const decoding:InstructionDecoding={instruction,variables:[{field:'authorization.order_returnable',operator:'=',status:'present',value:'true',scope:null,currency:null,period_days:null,note:null,source_excerpt:'The order must be returnable.'}],unmapped_requirements:[],decoding_id:'nullable-test',schema_version:1,prompt_version:'test',source_schema_hash:'test',model_requested:'test',model_returned:'test',response_id:'test',created_at:now,duration_ms:0,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0}};
 const prep=preparePermissions(pack,instruction,decoding,now);
 expect(prep.config!.parameters).toMatchObject({max_order_chf:'25',min_return_days:null,manual_review_requirements:[{source_excerpt:instruction,description:instruction}]});
 expect(prep.clarifications).toEqual(expect.arrayContaining([expect.objectContaining({key:'unresolved:parameter:min_return_days',resolution:'purchase_review'})]));
});

it('never lets manual review erase a known amount or return period, or substitute a partial instruction',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nullable-protection-'));
 const runtime=await createLocalRuntime({stateDir:join(dir,'state'),outputDir:join(dir,'output'),instructionDecoder:configuredInstructionDecoder(),liveOptions:{environment:'disabled',baseUrl:'',apiKey:''}});
 try{
  const actor:HumanActor={actor_id:'test-human',role:'simulated_human',channel:'local_ui',authenticated_by_server:true,customer_id:runtime.wallet.actorCustomer('SCEN0000')};
  const cases=[
   {text:instruction,key:'min_return_days',excerpt:'The order must be returnable.',error:'Required parameter'},
   {text:'Buy groceries for at most CHF 25. Return within at least 14 days.',key:'min_return_days',error:'min_return_days'},
   {text:instruction,key:'max_order_chf',error:'max_order_chf'},
  ] as const;
  for(const [index,example] of cases.entries()){
   const draft=await runtime.policies.createDraft('SCEN0000',{instruction:example.text,hard_rules:[],uncertainty_policy:'ask',guidance:[],open_questions:[]},undefined,{localCustomInstruction:true});
   const mandate=await runtime.policies.confirmDraft(draft.draft_id,'local_user');
   const config=runtime.simulations.suggest(mandate.mandate_id,`nullable-protected-suggest-${index}`);
   const source='excerpt' in example?example.excerpt:example.text;
   const parameters={...config.parameters,[example.key]:null,manual_review_requirements:[{source_excerpt:source,description:source}]};
   expect(()=>runtime.simulations.confirm(config.config_id,parameters,config.requirements.map(r=>r.requirement_id),actor,`nullable-protected-confirm-${index}`)).toThrow(example.error);
  }
 }finally{await runtime.close();await rm(dir,{recursive:true,force:true});}
});

it('starts a returnable purchase without inventing a return period and waits for its explicit review',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nullable-purchase-'));
 const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder(),liveOptions:{environment:'disabled',baseUrl:'',apiKey:''}});
 try{
  const session=await app.inject('/api/wallet/session?scenario_id=SCEN0000');
  const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'nullable-prepare'};
  const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0000',mode:'local',instruction}});
  const prep=await readyWalletPreparation(async()=>(await app.inject(`/api/wallet/preparations/${prepared.json().preparation_id}`)).json());
  const confirm=await app.inject({method:'POST',url:`/api/wallet/preparations/${prep.preparation_id}/confirm`,headers:{...headers,'idempotency-key':'nullable-confirm'},payload:{confirmed:true,parameters:prep.config!.parameters}});
  expect(confirm.statusCode,confirm.body).toBe(200);
  const url=`/api/wallet/runs/${confirm.json().run_id}`;
  await expect.poll(async()=>(await app.inject(url)).json<WalletRunView>().purchases.length,{timeout:4000,interval:100}).toBe(1);
  const run=(await app.inject(url)).json<WalletRunView>();
  expect(Number(run.approved_chf)).toBe(0);
  expect(run.purchases[0]!.assessment).toMatchObject({decision:'step_up',execution_state:'awaiting_user'});
  expect(run.purchases[0]!.assessment!.questions).toEqual(expect.arrayContaining([expect.objectContaining({kind:'confirm_requirement',prompt:expect.stringContaining(instruction)})]));
  expect(run.config.parameters.min_return_days).toBeNull();
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
