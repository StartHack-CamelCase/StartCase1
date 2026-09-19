import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { SourceAttempt } from '../packages/contracts/src/data.js';
import type { HumanActor } from '../packages/contracts/src/simulation.js';
import { AuthorizationEventFactory, loadDataPack } from '../packages/local-runtime/src/data/index.js';
import { PolicyService } from '../packages/local-runtime/src/services/policy-service.js';
import { PolicyFileStore } from '../packages/local-runtime/src/storage/policy-file-store.js';
import { SimulationService } from '../packages/local-runtime/src/simulation/service.js';
import { BehaviorProfileService } from '../packages/local-runtime/src/services/behavior-profile-service.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';

it('persists three explicit device confirmations and applies the habit after a real service restart without counting retries', async () => {
  const official = await loadDataPack({ dataDir: resolve('data') });
  const officialHash = hash({ attempts: official.attempts, items: official.attemptItems, history: official.history });
  const pack = structuredClone(official);
  const base = pack.attempts.find(attempt => attempt.authorization_id === 'AU0001')!;
  const originalLines = pack.itemsByAttempt.get(base.authorization_id)!;
  const authority = pack.authoritiesById.get(base.authority_id)!;
  const device = 'DVC-HABIT-PERSISTENCE-TEST';
  expect(pack.history.some(row => row.customer_device_id === device)).toBe(false);

  // Synthetic rows live only in this cloned pack; all joins and schema checks remain real.
  const attempts: SourceAttempt[] = Array.from({ length: 10 }, (_, index) => ({
    ...base,
    authorization_id: `BEHAVIOR_PERSIST_${index + 1}` as SourceAttempt['authorization_id'],
    timestamp: new Date(Date.parse(base.timestamp) + index * 86_400_000).toISOString(),
    replay_order: index + 1,
    customer_device_id: device,
  }));
  const lines = attempts.flatMap(attempt => originalLines.map(line => ({ ...line, authorization_id: attempt.authorization_id })));
  pack.attempts = [...pack.attempts.filter(attempt => attempt.scenario_id !== base.scenario_id), ...attempts];
  pack.attemptItems = [...pack.attemptItems, ...lines];
  pack.attemptsByScenario = new Map([...pack.attemptsByScenario, [base.scenario_id, attempts]]);
  pack.itemsByAttempt = new Map([...pack.itemsByAttempt, ...attempts.map(attempt => [attempt.authorization_id, lines.filter(line => line.authorization_id === attempt.authorization_id)] as const)]);

  const directory = await mkdtemp(join(tmpdir(), 'behavior-learning-persistence-'));
  const sqlitePath = join(directory, 'simulations.sqlite');
  const clock = () => new Date('2026-09-19T12:00:00.000Z');
  const actor: HumanActor = { actor_id: 'habit-test-owner', role: 'simulated_human', customer_id: authority.customer_id, channel: 'local_ui', authenticated_by_server: true };
  const factory = new AuthorizationEventFactory(pack, resolve('data/schemas/authorization_event.schema.json'));
  let service: SimulationService | undefined;
  try {
    let policies = await PolicyService.create(new PolicyFileStore(directory), pack, { clock });
    const draft = await policies.createDraft(base.scenario_id, {
      instruction: 'Buy groceries for CHF 30 or less. Ask me when uncertain.',
      hard_rules: [], uncertainty_policy: 'ask', guidance: [], open_questions: [],
    }, undefined, { localCustomInstruction: true });
    const mandate = await policies.confirmDraft(draft.draft_id, 'test_script');
    service = new SimulationService(pack, policies, factory, sqlitePath, clock);
    const proposed = service.suggest(mandate.mandate_id, 'habit-suggest');
    const config = service.confirm(proposed.config_id, {
      ...proposed.parameters, domestic_country: 'CH', watch_devices: true, learn_confirmed_habits: true,
    }, proposed.requirements.map(requirement => requirement.requirement_id), actor, 'habit-config-confirm');
    const run = service.create(config.config_id, 'habit-create');

    let lastAnswer: { authorizationId: string; input: Parameters<SimulationService['answer']>[2]; key: string } | undefined;
    for (let index = 0; index < 3; index++) {
      const pending = service.next(run.run_id, `habit-next-${index}`).assessment!;
      expect(pending.decision).toBe('step_up');
      expect(pending.results.find(result => result.filter_id === 'C15')?.outcome).toBe('needs_review');
      expect(pending.behavior_learning?.applied_filter_ids).toEqual([]);
      const question = pending.questions.find(question => question.filter_ids.includes('C15'))!;
      expect(question.kind).toBe('confirm_risk');
      const input = { expected_revision: pending.revision, offer_hash: pending.offer_hash, question_id: question.question_id, value: 'confirm' };
      const key = `habit-answer-${index}`;
      const confirmed = service.answer(run.run_id, pending.authorization_id, input, actor, key);
      expect(confirmed.assessment.decision).toBe('approve');
      expect(confirmed.assessment.behavior_learning?.confirmations).toHaveLength(1);
      expect(service.answer(run.run_id, pending.authorization_id, input, actor, key)).toEqual(confirmed);
      expect(service.get(run.run_id).purchases[index]!.answers).toHaveLength(1);
      expect(service.get(run.run_id).commitments).toHaveLength(index + 1);
      lastAnswer = { authorizationId: pending.authorization_id, input, key };
    }

    const beforeRestart = service.get(run.run_id);
    expect(beforeRestart.audit.filter(entry => entry.event === 'human_response_recorded')).toHaveLength(3);
    service.close(); service = undefined;

    // Recreate both services from their real durable stores, without cached instances.
    policies = await PolicyService.create(new PolicyFileStore(directory), pack, { clock });
    service = new SimulationService(pack, policies, new AuthorizationEventFactory(pack, resolve('data/schemas/authorization_event.schema.json')), sqlitePath, clock);
    expect(service.get(run.run_id)).toEqual(beforeRestart);
    const retry = service.answer(run.run_id, lastAnswer!.authorizationId, lastAnswer!.input, actor, lastAnswer!.key);
    expect(retry.assessment.decision).toBe('approve');
    expect(service.get(run.run_id).audit.filter(entry => entry.event === 'human_response_recorded')).toHaveLength(3);

    const fourth = service.next(run.run_id, 'habit-next-3');
    expect(fourth.assessment?.decision).toBe('approve');
    expect(fourth.assessment?.behavior_learning?.applied_filter_ids).toEqual(['C15']);
    expect(fourth.assessment?.results.find(result => result.filter_id === 'C15')?.reasons[0]?.code).toBe('C15_CONFIRMED_HABIT');
    expect(fourth.assessment?.behavior_learning?.profile.habits).toEqual([expect.objectContaining({
      filter_id: 'C15', context_key: device, confirmations: 3, distinct_days: 3, learned: true,
    })]);
    expect(fourth.assessment?.behavior_learning?.confirmations).toEqual([]);
    expect(fourth.run.purchases[3]!.answers).toEqual([]);
    expect(fourth.run.commitments).toHaveLength(4);
    expect(service.next(run.run_id, 'habit-next-3')).toEqual(fourth);
    expect(service.get(run.run_id).commitments).toHaveLength(4);

    const profiles=()=>new BehaviorProfileService(pack,service!,()=>[],()=>[],clock);
    const current=()=>profiles().detail(base.scenario_id,'local');
    const context={scenario_id:base.scenario_id,scope:'local' as const,filter_id:'C15' as const,context_key:device};
    const forgotten=profiles().control({...context,action:'forget',expected_revision:current().revision},actor,'forget-device');
    expect(forgotten.profile.habits[0]).toMatchObject({status:'forgotten',learned:false,distinct_days:0});
    const forgottenRevision=forgotten.revision;
    expect(profiles().control({...context,action:'forget',expected_revision:forgottenRevision-1},actor,'forget-device').revision).toBe(forgottenRevision);
    service.close();service=undefined;
    service=new SimulationService(pack,policies,new AuthorizationEventFactory(pack,resolve('data/schemas/authorization_event.schema.json')),sqlitePath,clock);
    expect(current().profile.habits[0]).toMatchObject({status:'forgotten',learned:false,distinct_days:0});
    service.answer(run.run_id,lastAnswer!.authorizationId,lastAnswer!.input,actor,lastAnswer!.key);
    expect(current().profile.habits[0]?.distinct_days).toBe(0);
    const confirmNext=(index:number)=>{
      const pending=service!.next(run.run_id,`habit-next-${index}`).assessment!;
      expect(pending.decision).toBe('step_up');
      const question=pending.questions.find(q=>q.filter_ids.includes('C15'))!;
      const result=service!.answer(run.run_id,pending.authorization_id,{expected_revision:pending.revision,offer_hash:pending.offer_hash,question_id:question.question_id,value:'confirm'},actor,`habit-answer-${index}`);
      expect(result.assessment.decision).toBe('approve');return result.assessment;
    };
    confirmNext(4);
    expect(current().profile.habits[0]?.distinct_days).toBe(1);
    profiles().control({...context,action:'suspend',expected_revision:current().revision},actor,'suspend-device');
    expect(confirmNext(5).behavior_learning?.confirmations).toEqual([]);
    expect(current().profile.habits[0]).toMatchObject({status:'suspended',learned:false});
    profiles().control({...context,action:'resume',expected_revision:current().revision},actor,'resume-device');
    for(const index of [6,7,8])confirmNext(index);
    const tenth=service.next(run.run_id,'habit-next-9').assessment!;
    expect(tenth.decision).toBe('approve');expect(tenth.behavior_learning?.applied_filter_ids).toEqual(['C15']);
    const beforeFeedback=current();
    expect(beforeFeedback.metrics.unknown_suppressions).toBeGreaterThan(0);
    const review={scenario_id:base.scenario_id,scope:'local' as const,filter_id:'C15' as const,authorization_id:tenth.authorization_id};
    const verified=profiles().feedback({...review,verdict:'confirmed',expected_revision:beforeFeedback.revision},actor,'verify-learned-device');
    expect(verified.metrics.verified_suppressions).toBe(1);
    expect(verified.profile.habits[0]?.distinct_days).toBe(3); // Explicit audit feedback does not train on automatic approvals.
    const rejected=profiles().feedback({...review,verdict:'rejected',expected_revision:verified.revision},actor,'reject-learned-device');
    expect(rejected.metrics.contradicted_suppressions).toBe(1);
    expect(rejected.profile.habits[0]).toMatchObject({status:'suspended',learned:false});
    expect(()=>profiles().control({...context,action:'resume',expected_revision:beforeFeedback.revision},actor,'stale-profile-change')).toThrow('profile changed');
    expect(()=>profiles().control({...context,action:'resume',expected_revision:rejected.revision},{...actor,customer_id:'OTHER'},'wrong-owner-change')).toThrow('customer profile');

    expect(pack.history).toEqual(official.history);
    expect(hash({ attempts: official.attempts, items: official.attemptItems, history: official.history })).toBe(officialHash);
    expect(official.attempts.some(attempt => attempt.authorization_id.startsWith('BEHAVIOR_PERSIST_'))).toBe(false);
  } finally {
    service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
