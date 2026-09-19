import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './simulation-fixture.js';
import { hash } from '../packages/local-runtime/src/simulation/common.js';
import { validateLiveBinding, type LiveBinding } from '../packages/local-runtime/src/simulation/live-engine.js';
import { VisecaOutbox, type LiveEntry } from '../packages/local-runtime/src/simulation/viseca-worker.js';
import { LiveSessionService } from '../packages/local-runtime/src/services/live-session-service.js';

const directories: string[] = [];
const services: LiveSessionService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function storedLegacySession(status: string, corruptInstructionHash = false) {
  const ctx = fixture();
  const instruction = 'I want to buy a computer that costs less than 200 francs, and the minimum price has to be 50 francs.';
  ctx.config.instruction = instruction;
  ctx.config.instruction_hash = corruptInstructionHash ? 'invalid' : hash(instruction);
  ctx.config.requirements[0]!.source_excerpt = instruction;
  ctx.config.parameters.manual_review_requirements = [{ source_excerpt: instruction, description: instruction }];
  // This is the persisted, previously confirmed policy from the older compiler.
  // The updated source parser must not rewrite its historical signed values.
  expect(ctx.config.parameters.min_order_chf).toBeNull();
  const binding: LiveBinding = { config: ctx.config, live_mandate_id: 'M1', scenario_id: ctx.event.authorization.scenario_id, hard_rules: [], history_hash: hash(ctx.pack.history), pack_version: ctx.pack.pack_version };
  const input = { config: ctx.config, scenario_id: binding.scenario_id, instruction, hard_rules: [], confirmed_by: 'human' };
  const saved = { key: 'historical-start', fingerprint: hash(input), stage: 'running', session_id: 'HISTORICAL_SESSION', mandate_id: 'M1', mandate_status: 'active', run_id: 'R1', binding, human_window_ms: 120000, status, last_poll_status: 200, last_error: null };
  const directory = await mkdtemp(join(tmpdir(), 'historical-policy-')); directories.push(directory);
  const database = new DatabaseSync(join(directory, 'live-sessions.sqlite'));
  database.exec('CREATE TABLE sessions (key TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL)');
  database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(saved.key, JSON.stringify(saved), hash(saved));
  database.close();
  const entry: LiveEntry = { id: ctx.event.authorization.authorization_id, event: ctx.event, state: 'accepted', decision: 'decline', reserved: false, snapshot: binding, proposal: null, intent: null, accepted: { decision: 'decline', at: ctx.now, response: { status: 'declined' } }, human_expires_at: null, history: [{ at: ctx.now, kind: 'remote_accepted', details: { decision: 'decline' } }] };
  const outbox = new VisecaOutbox(join(directory, `${saved.session_id}.sqlite`));
  await outbox.save({ schema_version: 1, run_id: saved.run_id, snapshot: binding, entries: [entry], cursor: '7', human_window_ms: saved.human_window_ms });
  outbox.close();
  const rows = () => {
    const sessions = new DatabaseSync(join(directory, 'live-sessions.sqlite'), { readOnly: true });
    const ledger = new DatabaseSync(join(directory, `${saved.session_id}.sqlite`), { readOnly: true });
    try { return { session: sessions.prepare('SELECT * FROM sessions').get(), ledger: ledger.prepare('SELECT * FROM outbox').get() }; }
    finally { sessions.close(); ledger.close(); }
  };
  const transport = vi.fn<NonNullable<ConstructorParameters<typeof LiveSessionService>[1]['transport']>>(async () => { throw Error('Unexpected external call'); });
  const service = new LiveSessionService(ctx.pack, { baseUrl: 'http://fake', apiKey: 'test', transport, stateDir: directory }); services.push(service);
  return { ctx, saved, input, binding, directory, entry, rows, transport, service };
}

describe('historical live sessions retain their confirmed compiler interpretation', () => {
  it.each(['completed', 'cancelled', 'failed'])('restores %s history without reinterpreting consent, rewriting the outbox, or contacting the platform', async status => {
    const x = await storedLegacySession(status);
    expect(() => validateLiveBinding(x.binding, x.ctx.pack)).toThrow('min_order_chf');
    const before = x.rows();
    await x.service.initialize();
    expect(x.service.get(x.saved.session_id)).toMatchObject({ status, run_id: 'R1', entries: [x.entry] });
    expect(x.service.get(x.saved.session_id).entries[0]!.snapshot).toEqual(x.binding);
    expect(x.rows()).toEqual(before);
    expect(x.transport).not.toHaveBeenCalled();
    // Historical viewing cannot turn a stale policy into a new executable run.
    await expect(x.service.start(x.input, 'new-start')).rejects.toThrow('min_order_chf');
    for (const decision of ['approve', 'decline'] as const) await expect(x.service.respond(x.saved.session_id, x.entry.id, decision, null, async () => ({ actor_id: 'human', proof: 'test' }), async () => true)).rejects.toThrow('live_history_read_only');
    expect(x.rows()).toEqual(before);
    expect(x.transport).not.toHaveBeenCalled();
  });

  it('retains strict validation for active saved sessions with outdated permissions', async () => {
    const x = await storedLegacySession('running');
    const before = x.rows();
    await expect(x.service.initialize()).rejects.toThrow('min_order_chf');
    expect(x.rows()).toEqual(before);
    expect(x.transport).not.toHaveBeenCalled();
  });

  it('still rejects a corrupt source hash in terminal history', async () => {
    const x = await storedLegacySession('completed', true);
    await expect(x.service.initialize()).rejects.toThrow('live_confirmed_binding_required');
    expect(x.transport).not.toHaveBeenCalled();
  });

  it('still rejects a terminal outbox that belongs to a different saved binding', async () => {
    const x = await storedLegacySession('completed');
    const outbox = new VisecaOutbox(join(x.directory, `${x.saved.session_id}.sqlite`));
    const stored = await outbox.load();
    stored.run_id = 'OTHER_RUN';
    await outbox.save(stored); outbox.close();
    await expect(x.service.initialize()).rejects.toThrow('immutable_live_snapshot_conflict');
    expect(x.transport).not.toHaveBeenCalled();
  });
});
