import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFER_PROMPT_VERSION, validateOfferExtraction, type OfferDecoder } from '../packages/local-runtime/src/ai/offer-extraction.js';
import { OfferExtractionService } from '../packages/local-runtime/src/services/offer-extraction-service.js';

const input={offer_hash:'h',sources:[{source_ref:'s',text:'shoe\nsize 43'}],requested_fields:['item_name']};
const output={facts:[{field:'item_name',line_no:1,status:'stated',value:'shoe',unit:null,source_excerpt:'shoe',source_ref:'s'}]};
describe('offer extraction',()=>{
 it('rejects decision and bad citations',()=>{expect(()=>validateOfferExtraction({...output,decision:'approve'},input)).toThrow();expect(()=>validateOfferExtraction({facts:[{...output.facts[0],source_excerpt:'nope'}]},input)).toThrow();});
 it('rejects duplicate fields',()=>expect(()=>validateOfferExtraction({facts:[...output.facts,...output.facts]}, {...input,requested_fields:['item_name','item_name']})).toThrow());
 it('deduplicates concurrent jobs and separates source hashes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'offer-')),path=join(dir,'jobs.json');
  const decode=vi.fn<OfferDecoder['decode']>(async i=>({output:{facts:[{...output.facts[0],value:i.sources[0]!.text.split('\n')[0],source_excerpt:i.sources[0]!.text.split('\n')[0]}]},response_id:'r'}));
  const s=new OfferExtractionService({model:'gpt-5-nano',configured:true,decode},path);
  try{
   await s.initialize();const [a,b]=await Promise.all([s.start(input),s.start(input)]);expect(a.id).toBe(b.id);
   const c=await s.start({...input,sources:[{source_ref:'s',text:'different'}]},true);expect(c.id).not.toBe(a.id);
   await s.close();
   expect(decode).toHaveBeenCalledTimes(2);
   const persisted=JSON.parse(await readFile(path,'utf8')) as Array<{status:string}>;
   expect(persisted).toHaveLength(2);expect(persisted.every(job=>job.status==='completed')).toBe(true);
  }finally{await s.close();await rm(dir,{recursive:true,force:true});}
 });
 it('reloads processing as interrupted without retry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'offer-')),path=join(dir,'jobs.json');
  const decode=vi.fn<OfferDecoder['decode']>(async()=>({output,response_id:'unexpected'}));
  const decoder:OfferDecoder={model:'gpt-5-nano',configured:true,decode};
  const key=createHash('sha256').update(JSON.stringify([input,decoder.model,OFFER_PROMPT_VERSION])).digest('hex');
  const persisted={id:'OFFER_EXT_interrupted',key,input,status:'processing',result:null,error:null};
  const s=new OfferExtractionService(decoder,path);
  try{
   // Simulate a crashed process from its durable record, with no orphaned in-process decoder promise.
   await writeFile(path,JSON.stringify([persisted]));await s.initialize();
   expect(s.get(persisted.id)?.status).toBe('interrupted');
   await expect(s.start(input)).rejects.toMatchObject({code:'offer_extraction_retry_required'});
   expect(decode).not.toHaveBeenCalled();
  }finally{await s.close();await rm(dir,{recursive:true,force:true});}
 });
 it('shutdown awaits an already-starting job and its final durable result before allowing teardown',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'offer-')),path=join(dir,'jobs.json');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const decode=vi.fn<OfferDecoder['decode']>(async()=>{await held;return {output,response_id:'released'};});
  const s=new OfferExtractionService({model:'gpt-5-nano',configured:true,decode},path);
  try{
   await s.initialize();const starting=s.start(input);let closed=false;
   const closing=s.close().then(()=>{closed=true;});
   const job=await starting;expect(job.status).toBe('processing');expect(closed).toBe(false);
   await expect(s.start(input)).rejects.toMatchObject({code:'offer_extraction_closed'});
   release();await closing;
   expect(s.get(job.id)?.status).toBe('completed');
   expect(JSON.parse(await readFile(path,'utf8'))[0]).toMatchObject({id:job.id,status:'completed',result:{metadata:{response_id:'released'}}});
  }finally{release();await s.close();await rm(dir,{recursive:true,force:true});}
 });
});
