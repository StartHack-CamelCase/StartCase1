import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';

// Exercise the actual frontend handlers and real HTTP routes. This tiny DOM
// driver supplies controls only; it contains no wallet or permission logic.
class Control {
  html = '';
  value = '';
  checked = false;
  disabled = false;
  textContent = '';
  classList={toggle(){}};
  setAttribute(){}
  querySelector(selector:string):Control|null{return this.controls?.[selector]??null;}
  controls?:Record<string,Control>;
  listeners: Record<string, (event: unknown) => void> = {};
  addEventListener(event: string, callback: (event: unknown) => void) { this.listeners[event] = callback; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; }
}
let bundle = '';
beforeAll(async () => {
  const original = await readFile(resolve('apps/local-web/web/app.ts'), 'utf8');
  const source = original.replace("window.addEventListener('popstate',()=>void route());void route();", "globalThis.__testWizard=()=>{current?.dispose();current=new PageContext(dataMode);return wizard(current,'SCEN0000');};globalThis.__setMode=mode=>{current?.dispose();dataMode=mode;saveDataMode(localStorage,mode);};");
  expect(source).not.toBe(original);
  const built = await build({ stdin: { contents: source, loader: 'ts', resolveDir: resolve('apps/local-web/web') }, bundle: true, format: 'iife', platform: 'browser', write: false });
  bundle = built.outputFiles[0]!.text;
});
const resources: Array<{ app: FastifyInstance; directory: string }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); await rm(resource.directory, { recursive: true, force: true }); } });
async function until(predicate: () => boolean) { for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('UI action did not settle.'); }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-mode-ui-'));
  const transport = vi.fn(async (): Promise<Response> => { throw new Error('The frontend test must not start an API run.'); });
  const app = await createLocalApp({ stateDir: join(directory, 'state'), outputDir: join(directory, 'output'), webDir: resolve('apps/local-web/web'), instructionDecoder: { model: 'disabled-test', configured: false, decode: async () => { throw new Error('No AI'); } }, liveOptions: { baseUrl: 'http://127.0.0.1:4313', apiKey: 'test', transport, environment: 'mock' } });
  resources.push({ app, directory });
  const input = new Control(), prepare = new Control(), confirm = new Control(), form = new Control(), host = new Control(), status = new Control(), flash = new Control(), pill = new Control(), root = new Control();
  const recovery = new Control(), resume = new Control(), discard = new Control();const json=new Control(),learning=new Control(),learningStatus=new Control(),format=new Control(),toggle=new Control(),connection=new Control(),footer=new Control();
  const local = new Control(), live = new Control(); local.value = 'local'; live.value = 'live';
  Object.assign(form, { querySelector: () => confirm });
  Object.defineProperty(root, 'innerHTML', { get: () => root.html, set: (value: string) => { root.html = value;host.innerHTML='';input.value = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(value)?.[1] ?? ''; live.checked = value.includes('value="live" checked'); local.checked = !live.checked; } });
  Object.defineProperty(host, 'innerHTML', { get: () => host.html, set: (value: string) => { host.html = value; form.listeners = {};json.value=/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(value)?.[1]?.replaceAll('&quot;','\"').replaceAll('&amp;','&')??''; } });
  const elements: Record<string, Control> = { '#app': root, '#flash-region': flash, '.offline-pill': pill, '#wallet-instruction': input, '#prepare-wallet': prepare, '#wallet-prep': host, '#wallet-status': status, '#confirm-form': form, '#wallet-prepare-recovery': recovery, '#resume-preparation': resume, '#discard-preparation': discard,'#permission-json':json,'#learn-confirmed-habits':learning,'#habit-learning-status':learningStatus,'#format-json':format,'#confirm-wallet':confirm,'#data-mode-switch':toggle,'#data-mode-status':connection,'#offline-mode-label':local,'#online-mode-label':live,'#environment-footer':footer };recovery.controls=elements;
  const storage = new Map<string, string>();const localStorage=new Map<string,string>();localStorage.set('viseca.data-mode.v1','live');
  let cookie = '';
  let delayPreparation: (() => Promise<void>) | undefined;
  let preparationLoss: 'before' | 'after' | undefined;
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null; key: string | undefined; reachedServer: boolean }> = [];
  const location = { pathname: '/wallet/new', search: '?scenario_id=SCEN0000', href: '' };
  const context = vm.createContext({
    document: { querySelector: (selector: string) => selector === 'input[name="mode"]:checked' ? (live.checked ? live : local) : elements[selector], querySelectorAll: (selector: string) => selector === 'input[name="mode"]' ? [local, live] : [] },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location, crypto: { randomUUID }, URL, DOMException, AbortController, URLSearchParams, Intl, setTimeout, clearTimeout,window:{addEventListener(){}},localStorage:{getItem:(key:string)=>localStorage.get(key)??null,setItem:(key:string,value:string)=>localStorage.set(key,value)},
    FormData: class { get(key: string) { return key === 'max_order_chf' ? '20' : null; } getAll() { return []; } },
    fetch: async (path: string, init?: RequestInit) => {
      const headers: Record<string,string> = { ...Object.fromEntries(new Headers(init?.headers).entries()), ...(cookie ? { cookie } : {}) };
      const request = { path:new URL(path,'http://wallet.local').pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, key: headers['idempotency-key'], reachedServer: false };
      calls.push(request);
      if (request.path === '/api/wallet/prepare' && preparationLoss === 'before') { preparationLoss = undefined; throw Error('lost before receipt'); }
      request.reachedServer = true;
      const reply = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path, headers, ...(init?.body ? { payload: String(init.body) } : {}) });
      if (reply.headers['set-cookie']) cookie = String(reply.headers['set-cookie']).split(';')[0]!;
      if (request.path === '/api/wallet/prepare' && init?.method === 'POST') {
        await delayPreparation?.();
        if (preparationLoss === 'after') { preparationLoss = undefined; throw Error('lost after receipt'); }
      }
      return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } });
    },
  });
  vm.runInContext(bundle, context);
  const open = () => vm.runInContext('globalThis.__testWizard()', context) as Promise<void>;
  const changeMode = async(mode:'local'|'live')=>{(context['__setMode'] as (mode:string)=>void)(mode);await open();local.checked=mode==='local';live.checked=mode==='live';};
  const clickPrepare = async () => { prepare.listeners['click']!({}); await until(() => !prepare.disabled); };
  const submit = async (listener = form.listeners['submit']) => { listener!({ preventDefault() {}, currentTarget: form }); await until(() => !confirm.disabled); };
  const clickResume = async () => { resume.listeners['click']!({ currentTarget: resume }); await until(() => !resume.disabled); };
  const discardSaved = () => discard.listeners['click']!({ currentTarget: discard });
  return { app, transport, host, flash, form, prepare, input, root, recovery, local, live, storage, calls, location, open, changeMode, clickPrepare, clickResume, discardSaved, submit, losePreparation: (when: 'before' | 'after') => { preparationLoss = when; }, delayPrepare: (callback: () => Promise<void>) => { delayPreparation = callback; } };
}

it('invalidates the live review on mode change and starts only a freshly reviewed local run', async () => {
  const ui = await fixture(); await ui.open(); await ui.clickPrepare();
  expect(ui.host.innerHTML).toContain('Confirm JSON and start');
  const staleSubmit = ui.form.listeners['submit'];
  await ui.changeMode('local');
  expect(ui.host.innerHTML).toBe('');
  expect(ui.storage.has('wallet-preparation:SCEN0000')).toBe(false);
  await ui.submit(staleSubmit);
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.calls.some((call) => call.path.endsWith('/confirm'))).toBe(false);
  await ui.clickPrepare(); await ui.submit();
  const confirmation = ui.calls.find((call) => call.path.endsWith('/confirm'))!;
  expect(confirmation.body?.['mode']).toBe('local');
  const id = decodeURIComponent(ui.location.href.split('/').at(-1)!);
  expect((await ui.app.inject(`/api/wallet/runs/${id}`)).json().mode).toBe('local');
  expect(ui.transport).not.toHaveBeenCalled();
});

it('restores the saved preparation in its selected global data source', async () => {
  const ui = await fixture(); await ui.open(); await ui.changeMode('local'); await ui.clickPrepare();
  const id = ui.storage.get('wallet-preparation:SCEN0000')!;
  expect((await ui.app.inject(`/api/wallet/preparations/${id}`)).json<WalletPreparation>().mode).toBe('local');
  ui.storage.delete('wallet-mode:SCEN0000');
  await ui.open();
  expect(ui.local.checked).toBe(true);
  expect(ui.live.checked).toBe(false);
  expect(ui.host.innerHTML).toContain('Local simulation. No real money moves.');
  expect(ui.transport).not.toHaveBeenCalled();
});

it('does not resurrect an in-flight preparation after its selected mode changed', async () => {
  const ui = await fixture(); await ui.open();
  let release!: () => void;
  let waiting = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  ui.delayPrepare(async () => { waiting = true; await gate; });
  ui.prepare.listeners['click']!({});
  await until(() => waiting);
  await ui.changeMode('local'); release();
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(ui.host.innerHTML).toBe('');
  expect(ui.storage.has('wallet-preparation:SCEN0000')).toBe(false);
  expect(ui.calls.some((call) => call.path.endsWith('/confirm'))).toBe(false);
  expect(ui.transport).not.toHaveBeenCalled();
});


it('lets changed settings discard an interrupted preparation after reload and prepare local permissions', async () => {
  const ui = await fixture(); await ui.open(); ui.losePreparation('before'); await ui.clickPrepare();
  expect(ui.recovery.innerHTML).toContain('Resume saved preparation');
  await ui.open();
  await ui.clickPrepare();
  expect(ui.flash.innerHTML).toContain('Resume or discard');
  ui.discardSaved(); await ui.changeMode('local'); await ui.clickPrepare();
  expect(ui.host.innerHTML).toContain('Local simulation. No real money moves.');
  expect(ui.calls.filter(call => call.path === '/api/wallet/prepare' && call.reachedServer)).toMatchObject([{ body: { mode: 'local' } }]);
  expect(ui.recovery.innerHTML).toBe('');
  expect(ui.transport).not.toHaveBeenCalled();
});

it('resumes the exact saved preparation and restores its settings after a lost response', async () => {
  const ui = await fixture(); await ui.open(); ui.losePreparation('after'); await ui.clickPrepare();
  const first = ui.calls.find(call => call.path === '/api/wallet/prepare')!;
  ui.input.value = 'Other draft'; ui.input.listeners['input']!({});
  await ui.open(); await ui.clickResume();
  expect(ui.host.innerHTML).toContain('local API emulator');
  expect(ui.input.value).toBe(first.body?.['instruction']);
  const preparations = ui.calls.filter(call => call.path === '/api/wallet/prepare');
  expect(preparations).toHaveLength(2);
  expect(preparations[1]!.key).toBe(first.key);
  expect(preparations[1]!.body).toEqual(first.body);
  expect(ui.host.innerHTML).toContain('Confirm JSON and start');
  expect(ui.recovery.innerHTML).toBe('');
  expect(ui.calls.some(call => call.path.endsWith('/confirm'))).toBe(false);
  expect(ui.transport).not.toHaveBeenCalled();
});
