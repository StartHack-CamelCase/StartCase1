import {configuredInstructionDecoder} from './helpers/configured-instruction-decoder.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createLocalApp } from '../apps/local-web/src/app.js';
import { createMockApi, LOCAL_MOCK_API_KEY } from '../apps/api-mock/src/app.js';
import type { WalletPreparation } from '../packages/contracts/src/wallet.js';

// Exercise the actual frontend handlers and real HTTP routes. This tiny DOM
// driver supplies controls only; it contains no wallet or permission logic.
class Control {
  html = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  textContent = '';
  dataset:Record<string,string>={};
  attributes = new Map<string,string>();
  classes = new Set<string>();
  classList={toggle:(name:string,force?:boolean)=>{const present=force??!this.classes.has(name);if(present)this.classes.add(name);else this.classes.delete(name);return present;},contains:(name:string)=>this.classes.has(name)};
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  querySelector(selector:string):Control|null{return this.controls?.[selector]??null;}
  querySelectorAll(selector:string):Control[]{return this.controlLists[selector]??[];}
  controlLists:Record<string,Control[]>={};
  controls?:Record<string,Control>;
  listeners: Record<string, (event: unknown) => void> = {};
  addEventListener(event: string, callback: (event: unknown) => void) { this.listeners[event] = callback; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; }
}
let bundle = '';
beforeAll(async () => {
  const original = await readFile(resolve('apps/local-web/web/app.ts'), 'utf8');
  const source = original.replace("window.addEventListener('popstate',()=>void route());void route();", "globalThis.__testWizard=scenario=>{current?.dispose();current=new PageContext(dataMode);return wizard(current,scenario);};globalThis.__setMode=mode=>{current?.dispose();dataMode=mode;saveDataMode(localStorage,mode);};");
  expect(source).not.toBe(original);
  const built = await build({ stdin: { contents: source, loader: 'ts', resolveDir: resolve('apps/local-web/web') }, bundle: true, format: 'iife', platform: 'browser', write: false });
  bundle = built.outputFiles[0]!.text;
});
const resources: Array<{ app: FastifyInstance; directory: string; mock?: FastifyInstance }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); await resource.mock?.close(); await rm(resource.directory, { recursive: true, force: true }); } });
async function until(predicate: () => boolean) { for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('UI action did not settle.'); }

async function fixture(scenarioId = 'SCEN0000', withMockApi = false) {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-mode-ui-'));
  const mock = withMockApi ? await createMockApi({ stateDir: join(directory, 'platform') }) : undefined;
  const transport = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (!mock) throw new Error('The frontend test must not start an API run.');
    const response = await mock.inject({ url: path, method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE', headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.signal ? { signal: init.signal } : {}), ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
  });
  const app = await createLocalApp({ stateDir: join(directory, 'state'), outputDir: join(directory, 'output'), webDir: resolve('apps/local-web/web'), instructionDecoder:configuredInstructionDecoder(), liveOptions: { baseUrl: 'http://127.0.0.1:4313', apiKey: mock ? LOCAL_MOCK_API_KEY : 'test', transport, environment: 'mock' } });
  resources.push({ app, directory, ...(mock ? { mock } : {}) });
  const input = new Control(), prepare = new Control(), confirm = new Control(), form = new Control(), host = new Control(), status = new Control(), flash = new Control(), pill = new Control(), root = new Control();
  const recovery = new Control(), resume = new Control(), discard = new Control();const json=new Control(),learning=new Control(),learningStatus=new Control(),format=new Control(),toggle=new Control(),connection=new Control(),footer=new Control();
  const highlights = new Control();
  const amountStatus=new Control(),amountNotes=new Control(),reapplyAmounts=new Control();
  const reviewSwitch = new Control(),summaryCard = new Control(),jsonCard = new Control(),summaryLabel = new Control(),jsonLabel = new Control();
  const reviewControls:Record<string,Control>={'permission-view-switch':reviewSwitch,'permission-summary-card':summaryCard,'permission-json-card':jsonCard,'permission-summary-label':summaryLabel,'permission-json-label':jsonLabel};
  const local = new Control(), live = new Control(); local.value = 'local'; live.value = 'live';
  Object.assign(form, { querySelector: () => confirm });
  Object.defineProperty(root, 'innerHTML', { get: () => root.html, set: (value: string) => { root.html = value;host.innerHTML='';input.value = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(value)?.[1] ?? ''; live.checked = value.includes('value="live" checked'); local.checked = !live.checked; } });
  Object.defineProperty(host, 'innerHTML', { get: () => host.html, set: (value: string) => {
    host.html = value; form.listeners = {};json.value=/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(value)?.[1]?.replaceAll('&quot;','\"').replaceAll('&amp;','&')??'';
    host.controlLists['[data-amount-choice]']=[...value.matchAll(/<select\b[^>]*data-amount-choice="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)].map(match=>{
      const control=new Control();control.dataset['amountChoice']=match[1]!;control.value=/<option value="([^"]*)" selected>/.exec(match[2]!)?.[1]??'';return control;
    });
    for(const [id,control] of Object.entries(reviewControls)){
      const tag=new RegExp(`<[^>]+\\bid="${id}"[^>]*>`).exec(value)?.[0]??'';
      control.listeners={};control.attributes.clear();control.classes.clear();control.hidden=/\shidden(?:\s|=|>)/.test(tag);
      for(const match of tag.matchAll(/([\w-]+)="([^"]*)"/g))control.setAttribute(match[1]!,match[2]!);
      for(const name of (control.getAttribute('class')??'').split(/\s+/).filter(Boolean))control.classes.add(name);
    }
  } });
  const elements: Record<string, Control> = { '#app': root, '#flash-region': flash, '.offline-pill': pill, '#wallet-instruction': input, '#prepare-wallet': prepare, '#wallet-prep': host, '#wallet-status': status, '#confirm-form': form, '#wallet-prepare-recovery': recovery, '#resume-preparation': resume, '#discard-preparation': discard,'#permission-json':json,'#permission-highlights':highlights,'#learn-confirmed-habits':learning,'#habit-learning-status':learningStatus,'#format-json':format,'#confirm-wallet':confirm,'#data-mode-switch':toggle,'#data-mode-status':connection,'#offline-mode-label':local,'#online-mode-label':live,'#environment-footer':footer,...Object.fromEntries(Object.entries(reviewControls).map(([id,control])=>[`#${id}`,control])) };recovery.controls=elements;host.controls=elements;
  Object.assign(elements,{'#amount-choice-status':amountStatus,'#amount-choice-notes':amountNotes,'#reapply-amount-choices':reapplyAmounts});
  const storage = new Map<string, string>();const localStorage=new Map<string,string>();localStorage.set('viseca.data-mode.v1','live');
  let cookie = '';
  let delayPreparation: (() => Promise<void>) | undefined;
  let preparationLoss: 'before' | 'after' | undefined;
  const calls: Array<{ path: string; mode: string | null; method: string; body: Record<string, unknown> | null; key: string | undefined; reachedServer: boolean }> = [];
  const location = { pathname: '/wallet/new', search: `?scenario_id=${scenarioId}`, href: '' };
  const context = vm.createContext({
    document: { querySelector: (selector: string) => selector === 'input[name="mode"]:checked' ? (live.checked ? live : local) : elements[selector], querySelectorAll: (selector: string) => selector === 'input[name="mode"]' ? [local, live] : [] },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location, crypto: { randomUUID }, URL, DOMException, AbortController, URLSearchParams, Intl, setTimeout, clearTimeout,window:{addEventListener(){}},localStorage:{getItem:(key:string)=>localStorage.get(key)??null,setItem:(key:string,value:string)=>localStorage.set(key,value)},
    FormData: class { get(key: string) { return key === 'max_order_chf' ? '20' : null; } getAll() { return []; } },
    fetch: async (path: string, init?: RequestInit) => {
      const headers: Record<string,string> = { ...Object.fromEntries(new Headers(init?.headers).entries()), ...(cookie ? { cookie } : {}) };
      const url = new URL(path,'http://wallet.local');
      const request = { path:url.pathname, mode:url.searchParams.get('mode'), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, key: headers['idempotency-key'], reachedServer: false };
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
  const open = () => (context['__testWizard'] as (scenario: string) => Promise<void>)(scenarioId);
  const changeMode = async(mode:'local'|'live')=>{(context['__setMode'] as (mode:string)=>void)(mode);await open();local.checked=mode==='local';live.checked=mode==='live';};
  const hasSavedPreparation=()=>storage.has(`${localStorage.get('viseca.data-mode.v1')==='live'?'viseca.online:':''}wallet-preparation:${scenarioId}`);
  const clickPrepare = async () => { prepare.listeners['click']!({}); await until(() => !prepare.disabled); if(hasSavedPreparation())await until(()=>host.innerHTML!==''); };
  const submit = async (listener = form.listeners['submit']) => { listener!({ preventDefault() {}, currentTarget: form }); await until(() => !confirm.disabled); };
  const clickResume = async () => { resume.listeners['click']!({ currentTarget: resume }); await until(() => !resume.disabled); if(hasSavedPreparation())await until(()=>host.innerHTML!==''); };
  const discardSaved = () => discard.listeners['click']!({ currentTarget: discard });
  return { app, transport, host, flash, form, prepare, input, root, recovery, local, live, storage, calls, location, open, changeMode, clickPrepare, clickResume, discardSaved, submit, json, highlights,reviewSwitch,summaryCard,jsonCard,summaryLabel,jsonLabel,confirm,amountStatus,status,reapplyAmounts, losePreparation: (when: 'before' | 'after') => { preparationLoss = when; }, delayPrepare: (callback: () => Promise<void>) => { delayPreparation = callback; } };
}

it.each(['SCEN0000', 'SCEN0001', 'SCEN0002', 'SCEN0003', 'SCEN0004'])('wires %s from the actual Online review handlers to mandate confirmation and API run creation', async scenarioId => {
  const ui = await fixture(scenarioId, true); await ui.open(); await ui.clickPrepare();
  expect(ui.host.innerHTML).toContain('Confirm JSON and start');
  expect(ui.host.innerHTML).not.toContain('Unmapped constraints');
  await ui.submit();
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.location.href).toMatch(/^\/wallet\/runs\/LIVE_SESSION_/);
  expect(ui.calls.every(call => call.mode === 'live')).toBe(true);
  const confirmation = ui.calls.find(call => call.path.endsWith('/confirm'))!;
  expect(confirmation.body).toMatchObject({ confirmed: true, mode: 'live' });
  const platformRequests = ui.transport.mock.calls.map(([path, init]) => ({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }));
  expect(platformRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: '/v1/bootstrap', method: 'GET' }),
    expect.objectContaining({ path: '/v1/mandates', method: 'POST', body: expect.objectContaining({ instruction: ui.input.value }) }),
    expect.objectContaining({ path: expect.stringMatching(/^\/v1\/mandates\/[^/]+\/confirm$/), method: 'POST', body: { confirmed: true } }),
    expect.objectContaining({ path: '/v1/scenario-runs', method: 'POST', body: expect.objectContaining({ scenario_id: scenarioId }) }),
  ]));
  const view = (await ui.app.inject(`/api/wallet/runs/${ui.location.href.split('/').at(-1)}?mode=live`)).json();
  expect(view).toMatchObject({ mode: 'live', scenario_id: scenarioId });
  if (scenarioId === 'SCEN0004') expect(view.config.parameters.allowed_item_ids).toEqual(['IT0017']);
});

it.each(['local', 'live'] as const)('preserves a custom instruction through the actual %s review and start handlers', async mode => {
  const ui = await fixture('SCEN0000', mode === 'live'); await ui.open();
  if (mode === 'local') await ui.changeMode('local');
  const instruction = 'Buy one ordinary grocery item for CHF 19 or less from a shop I use regularly.';
  ui.input.value = instruction; ui.input.listeners['input']!({});
  expect(ui.prepare.disabled).toBe(false);
  await ui.clickPrepare();
  expect(ui.calls.find(call => call.path === '/api/wallet/prepare')?.body).toMatchObject({ instruction, mode });
  expect(ui.host.innerHTML).toContain('Confirm JSON and start');
  await ui.submit();
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.location.href).toMatch(/^\/wallet\/runs\//);
  const view = (await ui.app.inject(`/api/wallet/runs/${ui.location.href.split('/').at(-1)}?mode=${mode}`)).json();
  expect(view.config).toMatchObject({ instruction, parameters: { max_order_chf: '19' } });
  if (mode === 'live') {
    const creation = ui.transport.mock.calls.find(([path, init]) => path === '/v1/mandates' && init?.method === 'POST');
    expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({ instruction });
  } else expect(ui.transport).not.toHaveBeenCalled();
});

it('keeps an unsupported Online requirement visible and starts only after the permission JSON is confirmed', async () => {
  const ui = await fixture('SCEN0000', true); await ui.open();
  const instruction = 'Buy one ordinary grocery item for CHF 19 or less from a shop I use regularly. The packaging must be compostable.';
  ui.input.value = instruction; ui.input.listeners['input']!({});
  await ui.clickPrepare();
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.host.innerHTML).toContain('manual_review_requirements');
  expect(ui.host.innerHTML).toContain('Purchase review requirements');
  expect(ui.host.innerHTML).toContain('Some requirements need your confirmation for each purchase.');
  expect(ui.host.innerHTML).not.toContain('Unmapped constraints');
  expect(ui.host.innerHTML).not.toContain('id="confirm-wallet" disabled');
  expect(ui.transport).not.toHaveBeenCalled();
  expect(ui.location.href).toBe('');
  await ui.submit();
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.location.href).toMatch(/^\/wallet\/runs\/LIVE_SESSION_/);
  const view = (await ui.app.inject(`/api/wallet/runs/${ui.location.href.split('/').at(-1)}?mode=live`)).json();
  expect(view.config.parameters.manual_review_requirements).toEqual([{ source_excerpt: instruction, description: instruction }]);
  expect(view.config.parameters.max_order_chf).toBe('19');
});

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


it('updates the readable preview after JSON edits and submits exactly those reviewed values', async () => {
  const ui = await fixture(); await ui.open(); await ui.changeMode('local'); await ui.clickPrepare();
  expect(ui.host.innerHTML).toContain('Points retained');
  const parameters = JSON.parse(ui.json.value);
  parameters.max_order_chf = '17'; parameters.always_ask = true;
  ui.json.value = JSON.stringify(parameters); ui.json.listeners['input']!({});
  expect(ui.highlights.innerHTML).toContain('CHF 17, including delivery');
  expect(ui.highlights.innerHTML).toContain('Required for every purchase that can proceed');
  ui.json.value = '{broken'; ui.json.listeners['input']!({});
  expect(ui.highlights.innerHTML).toContain('Preview unavailable');
  expect(ui.highlights.innerHTML).not.toContain('CHF 17');
  ui.json.value = JSON.stringify(parameters); ui.json.listeners['input']!({});
  expect(ui.calls.some(call => call.path.endsWith('/confirm'))).toBe(false);
  await ui.submit();
  expect(ui.flash.innerHTML).toBe('');
  expect(ui.calls.find(call => call.path.endsWith('/confirm'))?.body?.['parameters']).toEqual(parameters);
  expect(ui.transport).not.toHaveBeenCalled();
});

it('shows retained points first and switches review cards without a request or changing the draft', async () => {
  const ui = await fixture(); await ui.open(); await ui.changeMode('local'); await ui.clickPrepare();
  expect(ui.reviewSwitch.getAttribute('role')).toBe('switch');
  expect(ui.reviewSwitch.getAttribute('aria-checked')).toBe('false');
  expect(ui.summaryCard.hidden).toBe(false);expect(ui.jsonCard.hidden).toBe(true);
  expect(ui.summaryLabel.classList.contains('active')).toBe(true);expect(ui.jsonLabel.classList.contains('active')).toBe(false);
  const source=ui.json.value,requestCount=ui.calls.length;
  ui.reviewSwitch.listeners['click']!({currentTarget:ui.reviewSwitch});
  expect(ui.reviewSwitch.getAttribute('aria-checked')).toBe('true');
  expect(ui.summaryCard.hidden).toBe(true);expect(ui.jsonCard.hidden).toBe(false);
  expect(ui.summaryLabel.classList.contains('active')).toBe(false);expect(ui.jsonLabel.classList.contains('active')).toBe(true);
  expect(ui.json.value).toBe(source);expect(ui.calls).toHaveLength(requestCount);
  const updated={...JSON.parse(source),max_order_chf:'18',always_ask:true};
  ui.json.value=JSON.stringify(updated);ui.json.listeners['input']!({});
  ui.reviewSwitch.listeners['click']!({currentTarget:ui.reviewSwitch});
  expect(ui.reviewSwitch.getAttribute('aria-checked')).toBe('false');
  expect(ui.summaryCard.hidden).toBe(false);expect(ui.jsonCard.hidden).toBe(true);
  expect(ui.highlights.innerHTML).toContain('CHF 18, including delivery');
  expect(ui.highlights.innerHTML).toContain('Required for every purchase that can proceed');
  expect(ui.json.value).toBe(JSON.stringify(updated));expect(ui.calls).toHaveLength(requestCount);
  expect(ui.calls.some(call=>call.path.endsWith('/confirm'))).toBe(false);expect(ui.transport).not.toHaveBeenCalled();
});

it.each(['local','live'] as const)('requires an explicit amount meaning, restores it and sends the reviewed permissions in %s mode',async mode=>{
  const ui=await fixture('SCEN0000',mode==='live');await ui.open();if(mode==='local')await ui.changeMode('local');
  const instruction='CHF 120 groceries from Migros.';
  ui.input.value=instruction;ui.input.listeners['input']!({});await ui.clickPrepare();
  expect(ui.flash.innerHTML).toBe('');expect(ui.host.innerHTML).toContain(instruction);expect(ui.host.innerHTML).toContain('Clarify the amounts');
  expect(ui.confirm.disabled).toBe(true);expect(ui.status.textContent).toContain('Clarification required');
  expect(JSON.parse(ui.json.value)).toMatchObject({min_order_chf:null,max_order_chf:null});
  let select=ui.host.querySelectorAll('[data-amount-choice]')[0]!;
  expect(select.value).toBe('');select.value='maximum';select.listeners['change']!({});
  expect(ui.confirm.disabled).toBe(false);expect(ui.highlights.innerHTML).toContain('Maximum per purchase: CHF 120');
  expect(JSON.parse(ui.json.value)).toMatchObject({min_order_chf:null,max_order_chf:'120'});
  await ui.open();select=ui.host.querySelectorAll('[data-amount-choice]')[0]!;
  expect(select.value).toBe('maximum');expect(ui.confirm.disabled).toBe(false);
  ui.json.value=JSON.stringify({...JSON.parse(ui.json.value),max_order_chf:'121'});ui.json.listeners['input']!({});
  expect(ui.confirm.disabled).toBe(true);expect(ui.amountStatus.textContent).toContain('do not match your amount choices');
  ui.reapplyAmounts.listeners['click']!({});expect(ui.confirm.disabled).toBe(false);
  await ui.submit();expect(ui.flash.innerHTML).toBe('');expect(ui.location.href).toMatch(/^\/wallet\/runs\//);
  const confirmation=ui.calls.find(call=>call.path.endsWith('/confirm'))!;
  expect(confirmation.body).toMatchObject({amount_interpretations:{'amount:0':'maximum'},parameters:{min_order_chf:null,max_order_chf:'120'}});
  const view=(await ui.app.inject(`/api/wallet/runs/${ui.location.href.split('/').at(-1)}?mode=${mode}`)).json();
  expect(view.config.instruction).toBe(instruction);expect(view.config.parameters.max_order_chf).toBe('120');
});
