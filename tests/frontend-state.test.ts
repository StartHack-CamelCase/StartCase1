import { describe, expect, it } from 'vitest';
import { OperationJournal, selectPolicy, variableValue } from '../apps/local-web/web/operation-state.js';
const store=()=>{const m=new Map<string,string>();return {m,getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),removeItem:(k:string)=>void m.delete(k)};};
describe('frontend operation state',()=>{
 it('persists exact key/body across journal reload and acknowledges',()=>{const s=store();const a=new OperationJournal(s,()=> 'key-1').begin('/x','POST',{a:1});const b=new OperationJournal(s,()=> 'key-2').pending('/x');expect(b).toEqual(a);new OperationJournal(s).acknowledged(a);expect(new OperationJournal(s).pending('/x')).toBeNull();});
 it('rejects body changes while pending',()=>{const s=store();const j=new OperationJournal(s,()=> 'k');j.begin('/x','POST',{a:1});expect(()=>j.begin('/x','POST',{a:2})).toThrow();});
 it('allows a new key after acknowledgement',()=>{const s=store();let n=0;const j=new OperationJournal(s,()=>`k${++n}`);const a=j.begin('/x','POST');j.acknowledged(a);expect(j.begin('/x','POST').key).toBe('k2');});
 it('selects explicit mandate provenance over newer drafts',()=>{const d1:any={draft_id:'d1'},d2:any={draft_id:'d2'};const m1:any={mandate_id:'m1',draft_id:'d1'},m2:any={mandate_id:'m2',draft_id:'d2'};expect(selectPolicy([d1,d2],[m1,m2],null,'m1')).toEqual({draft:d1,mandate:m1});});
 it('does not duplicate CHF on already labelled values',()=>{expect(variableValue('CHF','CHF',null,null,null)).toBe('CHF');expect(variableValue(200,'CHF','purchase',null,'<=')).toBe('<= 200 CHF');});
});
