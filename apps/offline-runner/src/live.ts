import { createLiveRunDurably } from '../../../packages/local-runtime/src/services/live-run-creation.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { VisecaClient, VisecaOutbox, VisecaWorker, loadDataPack } from '../../../packages/local-runtime/src/index.js';
import { evaluateLive, validateLiveBinding, type LiveBinding } from '../../../packages/local-runtime/src/simulation/live-engine.js';
import { hash, offerHash } from '../../../packages/local-runtime/src/simulation/common.js';
import type { Assessment, HumanAnswer } from '../../../packages/contracts/src/simulation.js';
function option(args:string[],name:string):string|undefined{const i=args.indexOf(name);return i<0?undefined:args[i+1];}
async function main():Promise<void>{
 try{loadEnvFile(resolve('.env.local'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(!process.env['LEASH_BASE_URL']||!process.env['TEAM_API_KEY'])throw Error('LEASH_BASE_URL et TEAM_API_KEY requis ; aucun appel envoyé.');
 const [command,...args]=process.argv.slice(2);const client=VisecaClient.fromEnv();const bootstrap=await client.prepare();const settings=VisecaClient.timeouts(bootstrap);
 if(command==='prepare'){console.log(JSON.stringify({ready:true,timeouts:settings},null,2));return;}
 const file=option(args,'--config');if(!file)throw Error('Usage: live create-run|follow|status --config binding.json [--run-id ID]');
 const pack=await loadDataPack({dataDir:resolve('data')});const loaded=JSON.parse(await readFile(resolve(file),'utf8')) as LiveBinding&{outbox?:string};
 // Freeze installed reference data in the durable run binding, never in the payment deadline.
 const binding=validateLiveBinding({...loaded,history_hash:loaded.history_hash??hash(pack.history),pack_version:loaded.pack_version??pack.pack_version},pack);
 const outbox=new VisecaOutbox(resolve(loaded.outbox??'.viseca/live-outbox.sqlite'));await outbox.load();const worker=new VisecaWorker(client,outbox);
 let runId=option(args,'--run-id');
 if(command==='create-run'){runId=await createLiveRunDurably(client,outbox,binding);console.log(`Run créé ou réconcilié : ${runId}`);}
 if(!runId)throw Error('--run-id requis');
 if(command==='status'){console.log(JSON.stringify(await client.getRun(runId),null,2));outbox.close();return;}
 if(command!=='follow'&&command!=='create-run')throw Error('Commandes : prepare, create-run, follow, status');
 await worker.startRun(runId,binding,settings.human_window_ms);await worker.reconcile();
 const evaluate=(event:Parameters<typeof evaluateLive>[2])=>Promise.resolve(evaluateLive(pack,binding,event,runId!,worker.listEntries(),new Date().toISOString()));
 const rl=createInterface({input:process.stdin,output:process.stdout,terminal:!!process.stdin.isTTY});
 console.log('Suivi actif. Réponse humaine : approve ID [tableau JSON des preuves] ou decline ID. Aucune confirmation automatique.');
 rl.on('line',line=>{void(async()=>{const match=/^(approve|decline)\s+(\S+)(?:\s+(.+))?$/.exec(line.trim());if(!match){console.log('Format : approve ID [preuves JSON] / decline ID');return;}if(!process.stdin.isTTY)throw Error('Une réponse humaine interactive dans le terminal est requise.');const [,decision,id,raw]=match;const proof=randomUUID();const supplied=raw?JSON.parse(raw) as Array<{question_id:string;value:string;source_ref:string;source_excerpt:string}>:[];
  await worker.resolve(id!,decision as 'approve'|'decline',proof,async provided=>{if(provided!==proof)throw Error('Canal humain invalide');return {actor_id:'terminal_human',proof};},async(entry,actor,choice)=>{
   if(choice==='decline')return true;const old=entry.proposal?.snapshot as Assessment|undefined;if(!old?.questions) return false;
   const timestamp=new Date().toISOString();const answers:HumanAnswer[]=old.questions.map(q=>{const source=supplied.find(a=>a.question_id===q.question_id);if(q.kind!=='confirm_risk'&&(!source?.source_ref||!source.source_excerpt))throw Error(`Preuve requise : ${q.question_id} ${q.prompt}`);return {answer_id:randomUUID(),question_id:q.question_id,fact_key:q.fact_key,kind:q.kind,value:source?.value??'confirm',source_ref:source?.source_ref??null,source_excerpt:source?.source_excerpt??null,actor:{actor_id:actor.actor_id,role:'simulated_human',customer_id:entry.event.mandate.customer_id,channel:'local_ui',authenticated_by_server:true},offer_hash:offerHash(entry.event,{...binding.config,mandate_id:binding.live_mandate_id}),config_revision:binding.config.revision,created_at:timestamp,expires_at:entry.human_expires_at!,consumed_by:null};});
   const next=evaluateLive(pack,binding,entry.event,runId!,worker.listEntries(),timestamp,answers);return {approved:next.decision==='approve',evidence:[{human_answers:answers,assessment:next.snapshot}]};
  });console.log(`${id} : réponse enregistrée par Viseca.`);
 })().catch((error:unknown)=>console.error(error instanceof Error?error.message:String(error)));});
 let finished=false;
 while(!finished){const entry=await worker.pollOnce(evaluate);if(entry){console.log(`${entry.id} : ${entry.state} ; accepté=${entry.accepted?.decision??'inconnu'}`);if(entry.state==='awaiting_human')console.log(JSON.stringify({authorization:entry.event.authorization,questions:(entry.proposal?.snapshot as Assessment|undefined)?.questions},null,2));}await worker.reconcile();const status=await client.getRun(runId);const data=(status['data']??status) as Record<string,unknown>;finished=(data['status']==='completed'||data['finished']===true)&&worker.listPending().length===0;}
 rl.close();outbox.close();console.log('Run terminé, résultats distants réconciliés.');
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
