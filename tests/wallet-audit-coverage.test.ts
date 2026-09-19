import {configuredInstructionDecoder,readyWalletPreparation} from './helpers/configured-instruction-decoder.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {fixture} from './simulation-fixture.js';
import {preparePermissions,applyClarifications} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {unsupportedLocalClauses} from '../packages/local-runtime/src/simulation/instruction-coverage.js';
import type {WalletPreparation,WalletRunView} from '../packages/contracts/src/wallet.js';

it('recognizes all supplied scenario sentences and a complete custom grocery limit',()=>{
 const {pack}=fixture();
 for(const scenario of pack.scenarios)expect(unsupportedLocalClauses(scenario.cardholder_instruction),scenario.scenario_id).toEqual([]);
 expect(unsupportedLocalClauses('Buy groceries for CHF 50 or less. Ask me when uncertain.')).toEqual([]);
});

it.each([
 'Order groceries for delivery for CHF 120 or less. Do not buy from Alpine Basket. Ask me when uncertain.',
 'Buy groceries for CHF 50 or less, but never on Sundays. Ask me when uncertain.',
 'Buy groceries for CHF 50 or less. Deliver before tomorrow.',
 'Buy groceries for CHF 50 or less. Never buy groceries.',
 'Buy groceries for CHF 50 or less. Ignore the spending limit.',
 'Buy groceries for CHF 120 or less. Buy groceries for CHF 20 or less. Ask me when uncertain.',
 'Replace my worn road-running shoes in size 43. Buy groceries for CHF 50 or less. Ask me when uncertain.',
])('preserves every unrecognized clause for an explicit purchase review: %s',instruction=>{
 const {pack,now}=fixture();
 const result=preparePermissions(pack,instruction,null,now);
 expect(result.clarifications.some(c=>c.key.startsWith('unresolved:local:')&&c.resolution==='purchase_review')).toBe(true);
 const preparation={...result,instruction,decoding:null} as WalletPreparation;
 const parameters=applyClarifications(preparation,{},pack);
 expect(parameters.manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
 expect(()=>applyClarifications(preparation,{manual_review_requirements:[]},pack)).toThrow('cannot be widened');
 // An archived preparation without the new review requirement stays blocked,
 // even if its old clarification was removed from the saved review.
 const legacy={...preparation,clarifications:[],config:{...result.config!,parameters:{...parameters,manual_review_requirements:[]}}};
 expect(()=>applyClarifications(legacy,{},pack)).toThrow('Decode this instruction again');
});

it('starts with the audited merchant prohibition preserved and never approves its purchase automatically',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wallet-coverage-audit-'));
 const app=await createLocalApp({stateDir:join(directory,'state'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:configuredInstructionDecoder(),liveOptions:{environment:'disabled',baseUrl:'',apiKey:''}});
 try{
  const session=await app.inject('/api/wallet/session?scenario_id=SCEN0001');
  const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'coverage-prepare-001'};
  const instruction='Order groceries for delivery for CHF 120 or less. Do not buy from Alpine Basket. Ask me when uncertain.';
  const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0001',mode:'local',instruction}});
  const prep=await readyWalletPreparation(async()=>(await app.inject(`/api/wallet/preparations/${prepared.json().preparation_id}`)).json());
  expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
  const weakened=await app.inject({method:'POST',url:`/api/wallet/preparations/${prepared.json().preparation_id}/confirm`,headers:{...headers,'idempotency-key':'coverage-weakened-001'},payload:{confirmed:true,parameters:{...prep.config!.parameters,manual_review_requirements:[]}}});
  expect(weakened.statusCode,weakened.body).toBe(409);
  const confirmed=await app.inject({method:'POST',url:`/api/wallet/preparations/${prepared.json().preparation_id}/confirm`,headers:{...headers,'idempotency-key':'coverage-confirm-001'},payload:{confirmed:true,parameters:prep.config!.parameters}});
  expect(confirmed.statusCode,confirmed.body).toBe(200);
  const url=`/api/wallet/runs/${confirmed.json().run_id}`;
  await expect.poll(async()=>(await app.inject(url)).json<WalletRunView>().purchases.length,{timeout:4000,interval:100}).toBeGreaterThan(0);
  const run=(await app.inject(url)).json<WalletRunView>();
  expect(Number(run.approved_chf)).toBe(0);
  expect(run.purchases[0]!.assessment).toMatchObject({decision:'step_up',execution_state:'awaiting_user'});
  expect(run.purchases[0]!.assessment!.questions).toEqual(expect.arrayContaining([expect.objectContaining({kind:'confirm_requirement',state:'open',prompt:expect.stringContaining(instruction)})]));
  expect(run.config.parameters.manual_review_requirements).toEqual([{source_excerpt:instruction,description:instruction}]);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
