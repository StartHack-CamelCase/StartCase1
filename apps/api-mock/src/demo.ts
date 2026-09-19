import { resolve } from 'node:path';
import { createMockApi, LOCAL_MOCK_API_KEY } from './app.js';
import { createLocalApp } from '../../local-web/src/app.js';

if (process.env['API_NETWORK_POLICY'] !== 'loopback-only') {
  throw new Error('Start the isolated API demo with npm run api:demo.');
}
const port = Number(process.env['API_DEMO_PORT'] ?? 3212);
const mockPort = Number(process.env['API_MOCK_PORT'] ?? 4313);
if (![port, mockPort].every(n => Number.isInteger(n) && n > 0 && n <= 65535) || port === mockPort) {
  throw new Error('API_DEMO_PORT and API_MOCK_PORT must be distinct valid ports.');
}
const demoRoot = resolve(process.env['API_DEMO_STATE_DIR'] ?? '.viseca/demo');
const mock = await createMockApi({ dataDir: resolve('data'), stateDir: resolve(demoRoot, 'platform') });
let wallet: Awaited<ReturnType<typeof createLocalApp>> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await wallet?.close();
  await mock.close();
}
try {
  await mock.listen({ host: '127.0.0.1', port: mockPort });
  wallet = await createLocalApp({
    stateDir: resolve(demoRoot, 'wallet'),
    outputDir: resolve(demoRoot, 'output'),
    instructionDecoder: { model: 'local-parser', configured: false, decode: async () => { throw new Error('No AI calls in the local API demo.'); } },
    liveOptions: { environment: 'mock', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: LOCAL_MOCK_API_KEY },
  });
  const health = await wallet.inject('/api/health');
  if (health.statusCode !== 200) throw new Error('The wallet could not load its local data. Check the data pack and saved state.');
  await wallet.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ mode: 'local_api_emulator', wallet: `http://127.0.0.1:${port}`, api: `http://127.0.0.1:${mockPort}`, state: demoRoot, remote_requests: 'blocked', ai: 'disabled' }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
} catch (error) {
  await close();
  console.error(error instanceof Error ? error.message : 'The local API demo could not start.');
  process.exitCode = 1;
}
