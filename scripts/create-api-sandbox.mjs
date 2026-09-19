import { constants } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Snapshot the actual working files, including uncommitted work. Each copy has
// its own dependencies, output, database and secrets; never overwrite a lab.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'viseca-api';
if (!/^[a-z][a-z0-9-]{0,48}$/.test(name)) {
  throw new Error('Nom attendu : lettres minuscules, chiffres et tirets.');
}
const target = resolve(source, '.parallel', name);
const excluded = new Set(['.git', '.parallel', '.local-state', '.viseca', 'output', 'dist', 'coverage', '.DS_Store', '.agents', '.codex']);
const include = (path) => !['.git', '.DS_Store'].includes(basename(path)) && !basename(path).startsWith('.env') && !basename(path).endsWith('.log');
await mkdir(dirname(target), { recursive: true });
try {
  await mkdir(target, { mode: 0o700 });
} catch (error) {
  if (error.code === 'EEXIST') throw new Error(`La copie existe déjà : ${target}. Utiliser un autre nom pour préserver ses fichiers et son token.`);
  throw error;
}
for (const entry of await readdir(source)) {
  if (excluded.has(entry) || !include(entry)) continue;
  await cp(resolve(source, entry), resolve(target, entry), {
    recursive: true,
    filter: include,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
}
// pnpm's executable shims embed absolute NODE_PATH and cmd-shim-target values.
// Rebase copied shims, including nested .bin directories, to this snapshot.
async function rebaseShims(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await rebaseShims(path);
    else if (entry.isFile() && basename(directory) === '.bin') {
      const original = await readFile(path, 'utf8');
      const rebased = original.replaceAll(`${source}/`, `${target}/`);
      if (rebased !== original) await writeFile(path, rebased);
    }
  }
}
await rebaseShims(target);
await writeFile(resolve(target, '.env.local'), [
  '# Configuration privée de la copie API. Coller le team token sur la ligne suivante.',
  'TEAM_API_KEY=',
  'LEASH_BASE_URL=https://leash-api-production.up.railway.app',
  'PORT=3212',
  'AI_ENABLED=false',
  '',
].join('\n'), { mode: 0o600, flag: 'wx' });
await writeFile(resolve(target, 'API_SANDBOX.json'), JSON.stringify({
  created_at: new Date().toISOString(),
  source,
  source_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  includes_uncommitted_files: true,
  port: 3212,
  remote_team_queue_is_shared: true,
}, null, 2) + '\n');
console.log(`Copie indépendante créée : ${target}\nToken : ${resolve(target, '.env.local')}\nDepuis cette copie : npm run api:lab -- health ; npm run api:lab -- reads\nInterface : npm run dev:local (port 3212 ; ajuster PORT pour une autre copie).`);
