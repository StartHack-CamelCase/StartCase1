import {expect,it} from 'vitest';
import {assertLiveAnswerCoverage} from '../packages/local-runtime/src/services/wallet-service.js';
import {journalBehaviorProfile,synchronizeBehaviorJournal} from '../packages/local-runtime/src/learning/behavior-journal.js';
import type {Question,SimulationDocument} from '../packages/contracts/src/simulation.js';
import type {BehaviorObservation} from '../packages/contracts/src/behavior.js';
it('requires fresh explicit consent when suspending a learned device introduces a new live question',()=>{
 const oldQuestions=[{question_id:'country-question',kind:'confirm_risk'}] as Question[];
 const submitted=[{question_id:'country-question',value:'confirm'}];
 expect(()=>assertLiveAnswerCoverage(oldQuestions,submitted)).not.toThrow();
 const current=[...oldQuestions,{question_id:'device-question',kind:'confirm_risk'}] as Question[];
 expect(()=>assertLiveAnswerCoverage(current,submitted)).toThrow('confirmations changed');
 expect(()=>assertLiveAnswerCoverage(current,[...submitted,{question_id:'device-question',value:'confirm'}])).not.toThrow();
 expect(()=>assertLiveAnswerCoverage(current,[...submitted,{question_id:'device-question',value:'reject'}])).toThrow();
 expect(()=>assertLiveAnswerCoverage(current,[...submitted,...submitted])).toThrow();
});
it('quarantines conflicting optional feedback to its customer and preserves durable restrictions',()=>{
 const state:SimulationDocument={schema_version:1,configs:[],runs:[],commands:{}};
 const observation:BehaviorObservation={customer_id:'CLIENT-A',scope:'local',source_id:'source-1',authorization_id:'AUTH',filter_id:'C15',context_key:'device-1',occurred_at:'2026-08-01T12:00:00Z',recorded_at:'2026-09-19T12:00:00Z',actor_id:'human'};
 const journal=synchronizeBehaviorJournal(state,[observation]);
 journal.controls.push({sequence:++journal.sequence,customer_id:'CLIENT-A',scope:'local',filter_id:'C15',context_key:'device-1',action:'suspend',at:'2026-09-19T12:00:01Z',actor_id:'human'});
 expect(()=>synchronizeBehaviorJournal(state,[{...observation,context_key:'conflicting-device'}])).not.toThrow();
 const options={scope:'local' as const,asOf:'2026-08-02T12:00:00Z',timezone:'Europe/Zurich'};
 const affected=journalBehaviorProfile(journal,{...options,customerId:'CLIENT-A'});
 expect(affected.warning).toBeDefined();expect(affected.habits[0]).toMatchObject({status:'suspended',learned:false});
 expect(journalBehaviorProfile(journal,{...options,customerId:'CLIENT-B'}).warning).toBeUndefined();
 expect(journal.observations).toHaveLength(1);
});
