import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

export const DEFAULT_BASE_URL = 'https://leash-api-production.up.railway.app';
export const READ_PATHS = Object.freeze([
  '/v1/bootstrap',
  '/v1/reference-data',
  '/v1/reference-data/authorization-history.csv',
  '/v1/authorizations',
  '/v1/events?since=0',
]);

// Neither headers nor the unsanitized response are persisted or returned.
export function redact(value, secrets = []) {
  const sensitiveKey = /(?:api[\s_-]*key)|token|secret|password/i;
  const scrubString = (input) => {
    let output = input;
    for (const secret of secrets) {
      if (!secret) continue;
      for (const representation of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
        output = output.split(representation).join('[REDACTED]');
      }
    }
    return output.replace(/\bBearer\s+[^\s"',;<>]+/gi, 'Bearer [REDACTED]');
  };
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      scrubString(key),
      (sensitiveKey.test(key) || (/^(?:proxy-)?authorization$/i.test(key) && typeof entry !== 'object'))
        ? '[REDACTED]'
        : redact(entry, secrets),
    ]));
  }
  return value;
}

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('LEASH_BASE_URL doit être une URL HTTPS valide.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('LEASH_BASE_URL doit être une origine HTTPS sans identifiants, chemin, paramètres ni fragment (HTTP local accepté).');
  }
  return url.origin;
}

export function validatePath(path, { allowHealth = false } = {}) {
  if (allowHealth && path === '/healthz') return path;
  if (typeof path !== 'string' || !/^\/v1(?:\/|\?|$)/.test(path) || /[\\\s\u0000-\u001f#]/.test(path)) {
    throw new Error('Utilisez un chemin relatif /v1/… sans fragment, espace ni antislash.');
  }
  const pathname = path.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new Error('Encodage invalide dans le chemin.'); }
  if (decoded !== pathname || pathname.includes('//') || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Le chemin ne doit contenir ni encodage, ni segment de navigation.');
  }
  if (pathname === '/v1/team/reset' || pathname.startsWith('/v1/team/reset/')) {
    throw new Error('Le reset de l’équipe est exclu de ce laboratoire.');
  }
  return path;
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let local = {};
  try { local = parseEnv(readFileSync(resolve(cwd, '.env.local'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Impossible de lire .env.local.'); }
  const apiKey = env.TEAM_API_KEY ?? local.TEAM_API_KEY ?? '';
  const baseUrl = normalizeBaseUrl(env.LEASH_BASE_URL ?? local.LEASH_BASE_URL ?? DEFAULT_BASE_URL);
  return { baseUrl, apiKey, cwd, mode: env.VISECA_API_MODE ?? local.VISECA_API_MODE ?? 'remote' };
}

export async function requestApi({ baseUrl, apiKey, path, method = 'GET', body, timeoutMs = 30_000, fetchImpl = fetch }) {
  const origin = normalizeBaseUrl(baseUrl);
  const health = path === '/healthz' && method === 'GET';
  validatePath(path, { allowHealth: health });
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Méthode acceptée : GET, POST, PATCH ou DELETE.');
  if (!health && (!apiKey || /^<.*>$/.test(apiKey.trim()) || /[\r\n]/.test(apiKey))) throw new Error('Renseignez TEAM_API_KEY dans .env.local avant un appel authentifié.');
  if (method === 'GET' && body !== undefined) throw new Error('GET ne prend pas de corps JSON.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Le timeout doit être compris entre 1 et 120000 ms.');
  const headers = { Accept: 'application/json, text/csv;q=0.9, text/plain;q=0.8' };
  if (!health) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const report = { started_at: startedAt, method, path, base_url: origin, status: null, ok: false, duration_ms: 0 };
  if (body !== undefined) report.request_body = body;
  try {
    // Mutations are sent once. A timeout is ambiguous; reconcile with GET before repeating.
    const response = await fetchImpl(`${origin}${path}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    report.status = response.status;
    report.content_type = response.headers.get('content-type') ?? '';
    if (response.status === 204) {
      report.response = { format: 'empty', data: null };
    } else {
      const raw = await response.text();
      if (report.content_type.includes('json')) {
        try { report.response = { format: 'json', data: JSON.parse(raw) }; }
        catch {
          report.response = { format: 'text', data: raw };
          report.error = { type: 'invalid_json', message: 'Le serveur annonce du JSON mais le corps ne peut pas être décodé.' };
        }
      } else {
        report.response = { format: report.content_type.includes('csv') || path.split('?')[0].endsWith('.csv') ? 'csv' : 'text', data: raw };
      }
    }
    if (!response.ok) report.error = { type: 'http_error', message: `HTTP ${response.status}` };
    else if (report.response?.format === 'json' && report.response.data?.error) report.error = { type: 'api_error', message: 'Le serveur a retourné un objet error.' };
    if (method !== 'GET' && report.error && (response.status >= 500 || response.ok)) {
      report.error.reconcile_before_retry = true;
    }
    report.ok = response.ok && !report.error;
  } catch (error) {
    report.error = {
      type: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'transport_error',
      message: typeof error?.message === 'string' ? error.message : 'Échec de la requête HTTP.',
      ...(method !== 'GET' ? { reconcile_before_retry: true } : {}),
    };
  }
  report.duration_ms = Math.round(performance.now() - started);
  return redact(report, [apiKey]);
}

export async function saveReport(report, { cwd = process.cwd(), secrets = [] } = {}) {
  const directory = resolve(cwd, '.viseca/api-lab');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const safe = redact(report, secrets);
  const name = `${safe.started_at.replace(/[:.]/g, '-')}-${safe.method}-${randomUUID().slice(0, 8)}`;
  const jsonPath = resolve(directory, `${name}.json`);
  await writeFile(jsonPath, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const files = [jsonPath];
  if (safe.response?.format === 'csv') {
    const csvPath = resolve(directory, `${name}.csv`);
    await writeFile(csvPath, safe.response.data, { mode: 0o600, flag: 'wx' });
    files.push(csvPath);
  }
  return files;
}
