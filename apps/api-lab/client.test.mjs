import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, normalizeBaseUrl, READ_PATHS, redact, requestApi, saveReport, validatePath } from './client.mjs';

const execFile = promisify(execFileCallback);
const token = 'fixture-team-key-never-display';
const baseUrl = 'https://example.test';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('disabled remote mode refuses the CLI before any network request or report', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'viseca-api-disabled-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(execFile(process.execPath, [cli, 'reads'], {
    cwd, env: { ...process.env, TEAM_API_KEY: token, LEASH_BASE_URL: baseUrl, VISECA_API_MODE: 'disabled' },
  }), error => {
    assert.match(error.stderr, /API distante désactivée/);
    assert.equal(error.stderr.includes(token), false);
    return true;
  });
  await assert.rejects(stat(join(cwd, '.viseca')), error => error.code === 'ENOENT');
});

test('authenticated JSON GET uses bearer, timeout and redirect rejection', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', fetchImpl: async (url, init) => {
    assert.equal(url, `${baseUrl}/v1/bootstrap`);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
    return json({ scenarios: ['SCEN0000'] });
  } });
  assert.equal(report.status, 200);
  assert.equal(report.ok, true);
  assert.deepEqual(report.response.data, { scenarios: ['SCEN0000'] });
  assert.equal(JSON.stringify(report).includes(token), false);
});

test('health never sends bearer even when a token exists', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/healthz', fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return json({ status: 'ok' });
  } });
  assert.equal(report.ok, true);
});

test('POST sends one JSON request and does not retry a failed response', async () => {
  let calls = 0;
  const body = { instruction: 'Exact customer words', uncertainty_policy: 'ask' };
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/mandates', method: 'POST', body, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.body, JSON.stringify(body));
    return json({ error: { message: 'Temporary failure' } }, 503);
  } });
  assert.equal(calls, 1);
  assert.equal(report.ok, false);
  assert.equal(report.error.type, 'http_error');
  assert.equal(report.status, 503);
  assert.equal(report.error.reconcile_before_retry, true);
});

test('successful HTTP status with unreadable mutation JSON requires reconciliation before repeating', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/mandates', method: 'POST', body: {}, fetchImpl: async () => new Response('{"draft_id":', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(report.ok, false);
  assert.equal(report.status, 200);
  assert.equal(report.error.type, 'invalid_json');
  assert.equal(report.error.reconcile_before_retry, true);
});

test('204 succeeds without trying to parse a response body', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/decision-requests/next?wait=25', fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(report.ok, true);
  assert.deepEqual(report.response, { format: 'empty', data: null });
});

test('HTTP errors retain sanitized JSON details and fail even with a JSON body', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', fetchImpl: async () => json({ error: { message: `Invalid credential ${token}`, nested: [{ team_token: 'different-secret' }] } }, 401) });
  assert.equal(report.ok, false);
  assert.equal(report.status, 401);
  assert.equal(report.error.type, 'http_error');
  assert.equal(report.response.data.error.message, 'Invalid credential [REDACTED]');
  assert.equal(report.response.data.error.nested[0].team_token, '[REDACTED]');
  assert.equal(JSON.stringify(report).includes(token), false);
});

test('an error envelope with status 200 still fails', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', fetchImpl: async () => json({ error: { code: 'broken' } }) });
  assert.equal(report.ok, false);
  assert.equal(report.error.type, 'api_error');
});

test('malformed JSON fails and preserves a sanitized body', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', fetchImpl: async () => new Response(`{"broken": "${token}`, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(report.ok, false);
  assert.equal(report.error.type, 'invalid_json');
  assert.equal(report.response.data.includes(token), false);
});

test('CSV is returned as CSV, with token masking', async () => {
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/reference-data/authorization-history.csv', fetchImpl: async () => new Response(`id,note\nAU0001,${token}\n`, { headers: { 'content-type': 'text/csv' } }) });
  assert.equal(report.ok, true);
  assert.equal(report.response.format, 'csv');
  assert.equal(report.response.data, 'id,note\nAU0001,[REDACTED]\n');
});

test('transport timeout is sanitized and mutations advise reconciliation', async () => {
  let calls = 0;
  const report = await requestApi({ baseUrl, apiKey: token, path: '/v1/mandates', method: 'POST', body: {}, fetchImpl: async () => {
    calls++;
    const error = new Error(`Timeout for Bearer ${token}`);
    error.name = 'TimeoutError';
    throw error;
  } });
  assert.equal(calls, 1);
  assert.equal(report.error.type, 'timeout');
  assert.equal(report.error.reconcile_before_retry, true);
  assert.equal(report.error.message.includes(token), false);
});

test('redaction traverses arrays, keys, strings and encoded secrets without losing purchase IDs', () => {
  const secret = 'secret+/=';
  const safe = redact({ authorization: { authorization_id: 'LIVE001', note: secret }, authorization_count: 3, Authorization: 'Bearer another-key', api_key: 'other', nested: [{ accessToken: 'other', text: encodeURIComponent(secret) }], [secret]: secret }, [secret]);
  assert.deepEqual(safe.authorization, { authorization_id: 'LIVE001', note: '[REDACTED]' });
  assert.equal(safe.Authorization, '[REDACTED]');
  assert.equal(safe.api_key, '[REDACTED]');
  assert.equal(safe.authorization_count, 3);
  assert.equal(safe.nested[0].accessToken, '[REDACTED]');
  assert.equal(safe.nested[0].text, '[REDACTED]');
  assert.equal(safe['[REDACTED]'], '[REDACTED]');
});

test('paths cannot escape the base origin or invoke team reset', () => {
  for (const path of ['https://other.test/v1/bootstrap', '//other.test/v1/bootstrap', '/v1/../healthz', '/v1/%2e%2e/healthz', '/v1/x%2fy', '/v1/\\x', '/v1//x', '/v1/x#fragment', '/v1/team/reset', '/v1/team/reset?yes=true', '/v1/team/reset/', '/v1/x\n']) {
    assert.throws(() => validatePath(path), undefined, path);
  }
  assert.equal(validatePath('/v1/events?since=0'), '/v1/events?since=0');
  assert.throws(() => validatePath('/healthz'));
  assert.equal(validatePath('/healthz', { allowHealth: true }), '/healthz');
});

test('base URL rejects credentials, insecure remote HTTP and hidden URL components', () => {
  for (const value of ['https://key@example.test', 'http://example.test', 'https://example.test/v1', 'https://example.test?key=secret', 'https://example.test/#fragment']) assert.throws(() => normalizeBaseUrl(value));
  assert.equal(normalizeBaseUrl('https://example.test/'), baseUrl);
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});

test('missing token and invalid options fail before transport', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json({}); };
  await assert.rejects(requestApi({ baseUrl, apiKey: '', path: '/v1/bootstrap', fetchImpl }));
  await assert.rejects(requestApi({ baseUrl, apiKey: '<your team key>', path: '/v1/bootstrap', fetchImpl }));
  await assert.rejects(requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', method: 'GET', body: {}, fetchImpl }));
  await assert.rejects(requestApi({ baseUrl, apiKey: token, path: '/v1/bootstrap', timeoutMs: 0, fetchImpl }));
  assert.equal(calls, 0);
});

test('read-only batch excludes polling and undocumented mandate listing', () => {
  assert.equal(READ_PATHS.includes('/v1/decision-requests/next?wait=25'), false);
  assert.equal(READ_PATHS.includes('/v1/mandates'), false);
  assert.equal(READ_PATHS.length, 5);
});

test('env loading supports quoted tokens and gives shell variables precedence', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'viseca-api-env-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, '.env.local'), `LEASH_BASE_URL="https://example.test"\nTEAM_API_KEY="${token}"\n`);
  assert.equal(loadConfig({ cwd, env: {} }).apiKey, token);
  assert.equal(loadConfig({ cwd, env: { TEAM_API_KEY: 'shell-value' } }).apiKey, 'shell-value');
});

test('persisted JSON and CSV reports are private and mask secrets', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'viseca-api-report-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const files = await saveReport({ started_at: new Date().toISOString(), method: 'GET', response: { format: 'csv', data: `id,key\nAU001,${token}\n` }, error: { api_key: token } }, { cwd, secrets: [token] });
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes(token), false);
  }
  assert.equal((await stat(join(cwd, '.viseca/api-lab'))).mode & 0o777, 0o700);
});

test('CLI reads works against HTTP, reports CSV and never polls; draft stops at one POST', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'viseca-api-cli-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url.endsWith('.csv')) {
      res.setHeader('Content-Type', 'text/csv');
      res.end('authorization_id,amount\nAU0001,12.50\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.method === 'POST' ? { draft_id: 'draft-fixture' } : { status: 'ok', echo: token }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, TEAM_API_KEY: token, LEASH_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const reads = await execFile(process.execPath, [cli, 'reads'], { cwd, env });
  assert.deepEqual(requests.map((request) => request.path), READ_PATHS);
  assert.equal(requests.every((request) => request.authorization === `Bearer ${token}`), true);
  assert.equal(reads.stdout.includes(token), false);
  const draft = await execFile(process.execPath, [cli, 'draft'], { cwd, env });
  assert.equal(requests.length, 6);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).path, '/v1/mandates');
  assert.equal(JSON.parse(requests.at(-1).body).instruction, 'Buy one ordinary grocery item for CHF 20 or less from a shop I use regularly. Ask me when uncertain.');
  assert.equal(draft.stdout.includes('draft-fixture'), true);
  const files = await readdir(join(cwd, '.viseca/api-lab'));
  assert.equal(files.filter((file) => file.endsWith('.json')).length, 6);
  assert.equal(files.filter((file) => file.endsWith('.csv')).length, 1);
  await assert.rejects(execFile(process.execPath, [cli, 'request', 'POST', '/v1/mandates/draft-fixture/confirm'], { cwd, env }), (error) => {
    assert.match(error.stderr, /exigent --file/);
    return true;
  });
  assert.equal(requests.length, 6);
});

test('real transport rejects redirects without contacting the redirect destination', async (t) => {
  let redirectsFollowed = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/bootstrap') {
      res.writeHead(302, { Location: '/unexpected' });
      res.end();
    } else {
      redirectsFollowed++;
      res.end('should never be fetched');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const report = await requestApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: token, path: '/v1/bootstrap' });
  assert.equal(report.ok, false);
  assert.equal(report.error.type, 'transport_error');
  assert.equal(redirectsFollowed, 0);
});
