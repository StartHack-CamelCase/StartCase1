import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createLocalApp} from '../apps/local-web/src/app.js';
import type {WalletPreparation,WalletRunView} from '../packages/contracts/src/wallet.js';
import type {Assessment,SimRun} from '../packages/contracts/src/simulation.js';

it('buys the selected 27-inch monitor once and rejects the official duplicate without a second approval',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wallet-monitor-regression-'));
 const transport=vi.fn(async():Promise<Response>=>{throw Error('No external API allowed');});
 const app=await createLocalApp({stateDir:join(directory,'state'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{configured:false,model:'disabled',decode:async()=>{throw Error('No AI allowed');}},liveOptions:{environment:'disabled',baseUrl:'',apiKey:'',transport}});
 try{
  const session=await app.inject('/api/wallet/session?scenario_id=SCEN0004');
  const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json<{csrf:string}>().csrf,'idempotency-key':'monitor-prepare'};
  const options=(await app.inject('/api/wallet/options')).json<{scenarios:Array<{scenario_id:string;instruction:string}>}>();
  const instruction=options.scenarios.find(s=>s.scenario_id==='SCEN0004')!.instruction;
  const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0004',instruction,mode:'local'}});
  expect(prepared.statusCode,prepared.body).toBe(202);
  const prep=prepared.json<WalletPreparation>();
  expect(prep.permissions).toEqual(expect.arrayContaining([expect.objectContaining({key:'mission_quantity',value:'Up to 1 across this shopping mission'})]));
  const confirmed=await app.inject({method:'POST',url:`/api/wallet/preparations/${prep.preparation_id}/confirm`,headers:{...headers,'idempotency-key':'monitor-confirm'},payload:{confirmed:true,mode:'local',parameters:{...prep.config!.parameters,allowed_item_ids:['IT0017']}}});
  expect(confirmed.statusCode,confirmed.body).toBe(200);
  const id=confirmed.json<{run_id:string}>().run_id;
  // Explicitly advance the same service used by the automatic wallet timer.
  const first=await app.inject({method:'POST',url:`/api/simulations/${id}/next`,headers:{...headers,'idempotency-key':'monitor-first'},payload:{}});
  expect(first.statusCode,first.body).toBe(200);
  const approved=first.json<{assessment:Assessment}>().assessment;
  expect(approved.source_authorization_id).toBe('AU0035');
  expect(approved.execution_state).toBe('approved');
  expect(approved.results.find(r=>r.filter_id==='M11')?.outcome).toBe('pass');
  const second=await app.inject({method:'POST',url:`/api/simulations/${id}/next`,headers:{...headers,'idempotency-key':'monitor-second'},payload:{}});
  expect(second.statusCode,second.body).toBe(200);
  const rejected=second.json<{assessment:Assessment;run:SimRun}>();
  expect(rejected.assessment.source_authorization_id).toBe('AU0036');
  expect(rejected.assessment.execution_state).toBe('declined');
  expect(rejected.assessment.blocking_filter_ids).toContain('C14');
  expect(rejected.run.commitments).toHaveLength(1);
  const wallet=(await app.inject(`/api/wallet/runs/${id}`)).json<WalletRunView>();
  expect(wallet.approved_chf).toBe('289.00');
  expect(wallet.reservations).toBe(0);
  expect(transport).not.toHaveBeenCalled();
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
