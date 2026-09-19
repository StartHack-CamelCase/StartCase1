import test from 'node:test';
import assert from 'node:assert/strict';
import { localOnlyFetch } from './local-network-only.mjs';

test('local demo blocks external destinations before the HTTP transport', async () => {
  let calls = 0;
  const fetcher = localOnlyFetch(async () => { calls++; return new Response(); });
  for (const url of ['https://example.com/v1/bootstrap', 'http://example.com', 'http://127.0.0.1.example.com', 'http://user:password@127.0.0.1', 'http://localhost', 'file:///etc/hosts']) {
    await assert.rejects(fetcher(url), /remote network requests are disabled/);
  }
  assert.equal(calls, 0);
});

test('loopback calls are allowed and cannot follow redirects to remote APIs', async () => {
  const seen = [];
  const fetcher = localOnlyFetch(async (input, init) => { seen.push(init); return new Response('{}'); });
  await fetcher('http://127.0.0.1:4313/v1/bootstrap', { method: 'GET', redirect: 'follow' });
  await fetcher(new Request('http://[::1]:4313/healthz'));
  assert.equal(seen.length, 2);
  assert.ok(seen.every(init => init.redirect === 'error'));
  assert.equal(process.env.AI_ENABLED, 'false');
  assert.equal(process.env.OPENAI_API_KEY, '');
});
