import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

try { loadEnvFile(resolve('.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = process.env.TEAM_API_KEY?.trim();
if (!token || token === 'local-viseca-test') {
  throw new Error('Set the real team credential in .env.local before starting remote mode.');
}
const url = new URL(process.env.LEASH_BASE_URL ?? '');
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('LEASH_BASE_URL must be a clean HTTPS origin.');
}
// Serve the existing offline wallet and its isolated live journal in one app.
const child = spawn(process.execPath, ['./dist/apps/local-web/src/server.js'], {
  stdio: 'inherit',
  env: { ...process.env, VISECA_API_MODE: 'remote', PORT: process.env.PORT ?? '3210', LOCAL_STATE_DIR: resolve(process.env.LOCAL_STATE_DIR ?? '.local-state'), LOCAL_OUTPUT_DIR: resolve(process.env.LOCAL_OUTPUT_DIR ?? 'output') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('Unable to start the API wallet.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
