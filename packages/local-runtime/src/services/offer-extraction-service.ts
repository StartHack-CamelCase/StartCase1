import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, open } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../../../contracts/src/index.js";
import { validateOfferExtraction, OFFER_PROMPT_VERSION, type OfferDecoder, type OfferExtraction, type OfferExtractionInput } from "../ai/offer-extraction.js";
type Job = { id: string; key: string; input: OfferExtractionInput; status: "processing" | "completed" | "failed" | "interrupted"; result: OfferExtraction | null; error: string | null };
export class OfferExtractionService {
  private writes:Promise<void>=Promise.resolve(); private jobs = new Map<string, Job>(); private pending = new Map<string, Promise<Job>>();
  private readonly workers=new Set<Promise<unknown>>();
  private closed=false;
  constructor(private readonly decoder: OfferDecoder, private readonly filePath: string) {}
  async initialize(): Promise<void> { try { const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Job[]; for (const job of parsed) { if (job.status === "processing") { job.status = "interrupted"; job.error = "Extraction interrompue ; relance explicite requise."; } this.jobs.set(job.id, job); } await this.save(); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
  get(id: string): Job | null { const job = this.jobs.get(id); return job ? structuredClone(job) : null; }
  async start(input: OfferExtractionInput, retry = false): Promise<Job> {
    if(this.closed)throw new AppError(503,'offer_extraction_closed','Offer extraction is shutting down.');
    const key = createHash("sha256").update(JSON.stringify([input, this.decoder.model, OFFER_PROMPT_VERSION])).digest("hex");
    const active = this.pending.get(key); if (active) return structuredClone(await active);
    const old = [...this.jobs.values()].reverse().find((j) => j.key === key);
    if (old?.status === "completed") return structuredClone(old);
    if (old && !retry) throw new AppError(409, "offer_extraction_retry_required", "Relance explicite requise.");
    const job: Job = { id: `OFFER_EXT_${randomUUID()}`, key, input, status: "processing", result: null, error: null };
    const startup = (async()=>{ this.jobs.set(job.id, job); await this.save(); return job; })();
    this.pending.set(key, startup);
    // Register the entire lifecycle before yielding so shutdown also covers an initial save still in flight.
    const worker=startup.then(()=>this.run(job)).finally(()=>{this.pending.delete(key);this.workers.delete(worker);});
    this.workers.add(worker);void worker.catch(()=>undefined);
    return structuredClone(await startup);
  }
  async close():Promise<void>{this.closed=true;await Promise.allSettled([...this.workers]);await this.writes;}
  private async run(job:Job):Promise<Job>{const started=Date.now();try{const response=job.input.sources.every(s=>!s.text.trim())?{output:{facts:job.input.requested_fields.map(field=>({field,line_no:0,status:'missing',value:null,unit:null,source_excerpt:null,source_ref:null}))},response_id:'local-empty',usage:null}:await this.decoder.decode(job.input);job.result={...validateOfferExtraction(response.output,job.input),metadata:{model:this.decoder.model,response_id:response.response_id,duration_ms:Date.now()-started,usage:response.usage??null}};job.status='completed';}catch(e){job.status='failed';job.error=e instanceof Error?e.message:'Extraction échouée.';}await this.save();return structuredClone(job);}
  private save():Promise<void>{const operation=this.writes.then(async()=>{await mkdir(dirname(this.filePath),{recursive:true});const tmp=`${this.filePath}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify([...this.jobs.values()],null,2),{flag:'wx'});const handle=await open(tmp,'r+');try{await handle.sync();}finally{await handle.close();}await rename(tmp,this.filePath);const directory=await open(dirname(this.filePath),'r');try{await directory.sync();}finally{await directory.close();}});this.writes=operation.catch(()=>{});return operation;}
}
