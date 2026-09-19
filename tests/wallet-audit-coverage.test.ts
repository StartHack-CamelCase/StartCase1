import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {createLocalApp} from '../apps/local-web/src/app.js';
import {fixture} from './simulation-fixture.js';
import {preparePermissions,applyClarifications} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {unsupportedLocalClauses} from '../packages/local-runtime/src/simulation/instruction-coverage.js';
import type {WalletPreparation} from '../packages/contracts/src/wallet.js';

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
])('blocks every unrecognized clause instead of treating it as reviewed: %s',instruction=>{
 const {pack,now}=fixture();
 const result=preparePermissions(pack,instruction,null,now);
 expect(result.clarifications.some(c=>c.key.startsWith('unresolved:local:'))).toBe(true);
 expect(result.config!.requirements.some(r=>r.description.startsWith('Unsupported instruction:'))).toBe(true);
 expect(()=>applyClarifications({...result,instruction,decoding:null} as WalletPreparation,{},pack)).toThrow('edit the unclear instruction');
 // A preparation saved by the old version remains blocked even without its clarification.
 expect(()=>applyClarifications({...result,instruction,decoding:null,clarifications:[]} as unknown as WalletPreparation,{},pack)).toThrow('edit the unclear instruction');
});

it('cannot confirm the audited merchant prohibition or create an automatic purchase',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wallet-coverage-audit-'));
 const app=await createLocalApp({stateDir:join(directory,'state'),outputDir:join(directory,'output'),webDir:resolve('apps/local-web/web'),instructionDecoder:{configured:false,model:'disabled',decode:async()=>{throw Error('No API');}},liveOptions:{environment:'disabled',baseUrl:'',apiKey:''}});
 try{
  const session=await app.inject('/api/wallet/session?scenario_id=SCEN0001');
  const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,'x-csrf-token':session.json().csrf,'idempotency-key':'coverage-prepare-001'};
  const prepared=await app.inject({method:'POST',url:'/api/wallet/prepare',headers,payload:{scenario_id:'SCEN0001',mode:'local',instruction:'Order groceries for delivery for CHF 120 or less. Do not buy from Alpine Basket. Ask me when uncertain.'}});
  const confirmed=await app.inject({method:'POST',url:`/api/wallet/preparations/${prepared.json().preparation_id}/confirm`,headers:{...headers,'idempotency-key':'coverage-confirm-001'},payload:{confirmed:true,parameters:prepared.json().config.parameters}});
  expect(confirmed.statusCode,confirmed.body).toBe(422);
  expect(confirmed.json().error.code).toBe('instruction_needs_clarification');
  expect((await app.inject('/api/wallet/runs')).json().runs).toEqual([]);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
