import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../../../contracts/src/errors.js';
import type { SimulationDocument } from '../../../contracts/src/simulation.js';
import { hash } from './common.js';

type Command = SimulationDocument['commands'][string];
type Row = Record<string, unknown>;
export class SimulationStore {
 private readonly db: DatabaseSync;
 private cache: { revision: number; dataVersion: number; state: SimulationDocument } | undefined;
 constructor(path: string, private readonly validate: (state: SimulationDocument) => void, private readonly fault?: (point: 'before_write' | 'after_write' | 'after_commit') => void) {
  mkdirSync(dirname(path), { recursive: true });
  this.db = new DatabaseSync(path);
  try {
   this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL, checksum TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, checksum TEXT NOT NULL);');
   const initial: SimulationDocument = { schema_version: 1, configs: [], runs: [], commands: {} };
   this.db.prepare('INSERT OR IGNORE INTO state VALUES(1,0,?,?)').run(JSON.stringify(initial), hash(initial));
   this.migrateLegacy();
   this.snapshot();
  } catch (error) { this.db.close(); throw this.integrityError(error); }
 }
 private integrityError(error: unknown): AppError {
  this.cache = undefined;
  return error instanceof AppError ? error : new AppError(503, 'G07_AUDIT_INTEGRITY_FAILED', 'The simulation ledger could not be verified. Saved data has been preserved.', { cause: error instanceof Error ? error.message : 'invalid' });
 }
 private decodeCommand(row: Row): Command {
  const key = String(row['key']);
  // A wrapper also preserves an undefined response (legacy void commands).
  const saved = JSON.parse(String(row['response'])) as { response?: unknown };
  const command = { fingerprint: String(row['fingerprint']), response: saved.response };
  if (hash({ key, ...command }) !== row['checksum']) throw Error('command checksum');
  return command;
 }
 private insertCommand(key: string, entry: Command): void {
  this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(key, entry.fingerprint, JSON.stringify({ response: entry.response }), hash({ key, ...entry }));
 }
 private migrateLegacy(): void {
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const row = this.db.prepare('SELECT body,checksum FROM state WHERE id=1').get()!;
   const doc = JSON.parse(String(row['body'])) as SimulationDocument;
   if (hash(doc) !== row['checksum']) throw Error('legacy checksum');
   this.validate(doc);
   const entries = Object.entries(doc.commands);
   for (const [key, entry] of entries) {
    const previous = this.db.prepare('SELECT * FROM commands WHERE key=?').get(key);
    if (previous) {
     if (hash(this.decodeCommand(previous)) !== hash(entry)) throw Error('legacy command collision');
    } else this.insertCommand(key, entry);
   }
   if (entries.length) {
    doc.commands = {};
    this.db.prepare('UPDATE state SET revision=revision+1,body=?,checksum=? WHERE id=1').run(JSON.stringify(doc), hash(doc));
   }
   this.db.exec('COMMIT');
  } catch (error) { this.db.exec('ROLLBACK'); throw error; }
 }
 private snapshot(): SimulationDocument {
  try {
   const dataVersion = Number(this.db.prepare('PRAGMA data_version').get()!['data_version']);
   const revision = Number(this.db.prepare('SELECT revision FROM state WHERE id=1').get()!['revision']);
   if (this.cache?.revision === revision && this.cache.dataVersion === dataVersion) return this.cache.state;
   const row = this.db.prepare('SELECT body,checksum FROM state WHERE id=1').get()!;
   const doc = JSON.parse(String(row['body'])) as SimulationDocument;
   if (hash(doc) !== row['checksum'] || Object.keys(doc.commands).length) throw Error('checksum');
   this.validate(doc);
   this.cache = { revision, dataVersion, state: doc };
   return doc;
  } catch (error) { throw this.integrityError(error); }
 }
 // Compatibility/export view only. Normal projections and writes never load the journal.
 read(): SimulationDocument {
  this.db.exec('BEGIN');
  try {
   const state = structuredClone(this.snapshot());
   for (const row of this.db.prepare('SELECT * FROM commands').all()) state.commands[String(row['key'])] = this.decodeCommand(row);
   this.db.exec('COMMIT');
   return state;
  } catch (error) { this.db.exec('ROLLBACK'); throw this.integrityError(error); }
 }
 select<T>(read: (state: Readonly<SimulationDocument>) => T): T { return structuredClone(read(this.snapshot())); }
 transaction<T>(key: string, body: unknown, mutate: (state: SimulationDocument) => T): T {
  this.db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
   const canonical = this.snapshot();
   const fingerprint = hash(body);
   const row = this.db.prepare('SELECT * FROM commands WHERE key=?').get(key);
   if (row) {
    let old: Command;
    try { old = this.decodeCommand(row); } catch (error) { throw this.integrityError(error); }
    if (old.fingerprint !== fingerprint) throw new AppError(409, 'G01_IDEMPOTENCY_CONFLICT', 'This request key was already used with different content.');
    this.db.exec('COMMIT'); committed = true;
    return structuredClone(old.response) as T;
   }
   const state = structuredClone(canonical);
   const response = structuredClone(mutate(state));
   state.commands = {};
   this.validate(state);
   this.fault?.('before_write');
   this.db.prepare('UPDATE state SET revision=revision+1,body=?,checksum=? WHERE id=1').run(JSON.stringify(state), hash(state));
   this.insertCommand(key, { fingerprint, response });
   this.fault?.('after_write');
   this.db.exec('COMMIT'); committed = true;
   this.cache = undefined;
   this.fault?.('after_commit');
   return response;
  } catch (error) { if (!committed) this.db.exec('ROLLBACK'); throw error; }
 }
 close(): void { this.db.close(); }
}
