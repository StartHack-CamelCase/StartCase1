// Explicit isolated manual-browser regression harness. Never reads/writes user state.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalApp } from '../apps/local-web/src/app.js';
const dir=await mkdtemp(join(tmpdir(),'viseca-browser-'));
const app=await createLocalApp({stateDir:join(dir,'state'),outputDir:join(dir,'output'),webDir:resolve('dist/apps/local-web/web'),instructionDecoder:{model:'gpt-5-nano',configured:false,decode:async()=>{throw Error('AI disabled in browser test');}} as never});
let droppedKey:string|null=null;
app.addHook('onSend',async(req,reply,payload)=>{if(req.method==='POST'&&/^\/api\/runs\/[^/]+\/next$/.test(req.url)&&reply.statusCode===200){const key=String(req.headers['idempotency-key']);droppedKey??=key;let allow=false;try{await readFile(join(dir,'allow-retry'));allow=true;}catch{}if(key===droppedKey&&!allow){await writeFile(join(dir,'lost-response.json'),String(payload));reply.raw.destroy();}}return payload;});
await app.listen({host:'127.0.0.1',port:3211});
console.log(JSON.stringify({url:'http://127.0.0.1:3211',state:dir}));
process.on('SIGTERM',()=>void app.close());
