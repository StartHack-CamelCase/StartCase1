import {randomUUID} from 'node:crypto';
import recordedFixture from '../fixtures/wallet-official-decodings.json' with {type:'json'};
import type {InstructionDecoding,InstructionVariables} from '../../packages/contracts/src/instruction-decoding.js';
import type {InstructionDecoder} from '../../packages/local-runtime/src/ai/openai-instruction-decoder.js';
import type {WalletPreparation} from '../../packages/contracts/src/wallet.js';
import {validateInstructionFields} from '../../packages/local-runtime/src/ai/instruction-schema.js';
import {unsupportedLocalClauses} from '../../packages/local-runtime/src/simulation/instruction-coverage.js';

const recorded=recordedFixture as {scenarios:Array<{decoding:InstructionDecoding}>};

/** Successful configured decoder for integration tests, with no external calls.
 * Exact official instructions replay recorded extraction; custom text keeps all
 * unknown facts absent, except a literally stated uncertainty policy, and
 * reports unrecognized source clauses honestly as unresolved requirements. */
export function configuredInstructionDecoder(model='configured-test-decoder',options:{unmappedRequirements?:InstructionVariables['unmapped_requirements']}={}):InstructionDecoder {
 return {model,configured:true,decode:async(instruction,fields)=>{
  const saved=recorded.scenarios.find(({decoding})=>decoding.instruction===instruction)?.decoding;
  const variables:InstructionVariables['variables']=fields.map(({field})=>structuredClone(saved?.variables.find(v=>v.field===field)??{field,status:'absent',value:null,operator:null,currency:null,scope:null,period_days:null,source_excerpt:null,note:null}));
  const uncertainty=instruction.match(/Ask me when uncertain[.!]?/i);
  if(!saved&&uncertainty){const variable=variables.find(v=>v.field==='mandate.uncertainty_policy');if(variable)Object.assign(variable,{status:'present',value:'ask',operator:'=',source_excerpt:uncertainty[0]});}
  const unmapped=options.unmappedRequirements??saved?.unmapped_requirements??unsupportedLocalClauses(instruction).map(source_excerpt=>({source_excerpt,description:source_excerpt,reason:'no_native_field' as const}));
  const output=validateInstructionFields({variables,unmapped_requirements:structuredClone(unmapped)},instruction,fields);
  return {output,model,response_id:`test_response_${randomUUID()}`,usage:{input_tokens:0,output_tokens:0,reasoning_tokens:0}};
 }};
}

/** Wait for the same asynchronous preparation boundary used by the wallet UI. */
export async function readyWalletPreparation(load:()=>WalletPreparation|Promise<WalletPreparation>):Promise<WalletPreparation> {
 const deadline=Date.now()+5000;
 for(;;){
  const preparation=await load();
  if(preparation.status==='ready')return preparation;
  if(preparation.status!=='processing')throw new Error(`Preparation ${preparation.preparation_id} ${preparation.status}: ${preparation.error??'unknown error'}`);
  if(Date.now()>=deadline)throw new Error(`Preparation ${preparation.preparation_id} did not finish.`);
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}
