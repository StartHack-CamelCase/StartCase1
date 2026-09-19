import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { PageRequestScope, connectionLabel, modeLanding, modePath, modeStorage, preparationMatches, readDataMode, saveDataMode } from '../apps/local-web/web/data-mode.js';
import { OperationJournal } from '../apps/local-web/web/operation-state.js';

function storage(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});

describe('persistent data source selection and isolated requests',()=>{
 it('defaults to offline and restores only recognized stored choices',()=>{const s=storage();expect(readDataMode(s)).toBe('local');saveDataMode(s,'live');expect(readDataMode(s)).toBe('live');s.setItem('viseca.data-mode.v1','remote');expect(readDataMode(s)).toBe('local');});
 it('preserves offline drafts and separates preparation and profile journals between sources',()=>{
  const s=storage();s.setItem('wallet-instruction:S','original offline draft');const offline=modeStorage(s,'local'),online=modeStorage(s,'live');expect(offline.getItem('wallet-instruction:S')).toBe('original offline draft');expect(online.getItem('wallet-instruction:S')).toBeNull();online.setItem('wallet-instruction:S','online draft');
  for(const path of ['/api/wallet/prepare','/api/wallet/profiles/control','/api/wallet/runs/R/human-responses']){const local=new OperationJournal(offline,()=>`local:${path}`),live=new OperationJournal(online,()=>`live:${path}`);local.begin(path,'POST',{mode:'local'});expect(live.pending(path)).toBeNull();live.begin(path,'POST',{mode:'live'});expect(local.pending(path)?.body).toBe('{"mode":"local"}');live.acknowledged(live.pending(path)!);expect(local.pending(path)).not.toBeNull();}
  online.removeItem('wallet-instruction:S');expect(offline.getItem('wallet-instruction:S')).toBe('original offline draft');
 });
 it('replaces untrusted mode query while retaining scenario and profile filters',()=>{expect(modePath('/api/wallet/profiles/detail?scope=live&scenario_id=S&mode=local','live')).toBe('/api/wallet/profiles/detail?scope=live&scenario_id=S&mode=live');});
 it.each(['/wallet/runs/OLD','/simulations/OLD','/runs/OLD'])('leaves %s when switching sources',path=>{expect(modeLanding(path,'?mode=live')).toBe('/');});
 it('keeps a scenario or profile selection while discarding old scope parameters',()=>{expect(modeLanding('/wallet/new','?scenario_id=S&mode=live')).toBe('/wallet/new?scenario_id=S');expect(modeLanding('/wallet/profiles','?scenario_id=S&scope=live')).toBe('/wallet/profiles?scenario_id=S');});
 it('distinguishes offline, remote API, disabled API and the local API emulator',()=>{expect(connectionLabel('local','remote')).toBe('Offline · local data');expect(connectionLabel('live','remote')).toBe('Online · Viseca API');expect(connectionLabel('live','mock')).toContain('local API emulator');expect(connectionLabel('live','disabled')).toContain('not configured');});
 it('calls the native transport without rebinding its receiver',async()=>{let receiver:unknown='unset';const transport:typeof fetch=async function(this:unknown){receiver=this;return response({ok:true});};await new PageRequestScope('local',transport).request('/api/wallet/options');expect(receiver).toBeUndefined();});
 it('aborts an outstanding request and prevents a stale continuation from sending another request',async()=>{
  const gate=deferred<Response>(),transport=vi.fn(async(_path:RequestInfo|URL,_init?:RequestInit)=>gate.promise),scope=new PageRequestScope('live',transport);const request=scope.request('/api/wallet/session?scenario_id=OLD');scope.dispose();gate.resolve(response({csrf:'old'}));await expect(request).rejects.toMatchObject({name:'AbortError'});await expect(scope.request('/api/wallet/preparations/OLD/confirm',{method:'POST'})).rejects.toMatchObject({name:'AbortError'});expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
 });
 it('rejects stale reviews for any changed instruction, scenario, or source',()=>{const a={scenario_id:'S',instruction:'Tea only',mode:'local' as const};expect(preparationMatches(a,{...a})).toBe(true);for(const b of [{...a,scenario_id:'T'},{...a,instruction:'Coffee only'},{...a,mode:'live' as const}])expect(preparationMatches(a,b)).toBe(false);});
});

// Run the real bundled handlers with a deliberately small DOM driver. It models
// elements and events only; routing, requests, journals and review logic are real.
let bundle='';
beforeAll(async()=>{
 const original=await readFile(resolve('apps/local-web/web/app.ts'),'utf8');
 const source=original.replace("window.addEventListener('popstate',()=>void route());void route();",'globalThis.__test={route,get current(){return current}};');
 expect(source).not.toBe(original);
 bundle=(await build({stdin:{contents:source,loader:'ts',resolveDir:resolve('apps/local-web/web')},bundle:true,format:'iife',platform:'browser',write:false})).outputFiles[0]!.text;
});
async function until(test:()=>boolean){for(let n=0;n<100;n++){if(test())return;await new Promise(done=>setTimeout(done,2));}throw Error('The UI did not settle');}
function browser(pathname='/wallet/new',storedMode:'local'|'live'='local'){
 const elements=new Map<string,Control>();
 class Control {
  html='';textContent='';value='';disabled=false;checked=false;attributes=new Map<string,string>();listeners=new Map<string,Array<(event:any)=>unknown>>();
  classList={toggle:vi.fn()};
  constructor(readonly id:string){elements.set(id,this);}
  get innerHTML(){return this.html;}
  set innerHTML(value:string){this.html=value;for(const match of value.matchAll(/\bid="([^"]+)"/g))new Control(match[1]!);for(const match of value.matchAll(/<textarea[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))elements.get(match[1]!)!.value=match[2]!.replaceAll('&quot;','"').replaceAll('&amp;','&');}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  addEventListener(type:string,listener:(event:any)=>unknown){this.listeners.set(type,[...(this.listeners.get(type)??[]),listener]);}
  querySelector(selector:string){return elements.get(selector.slice(1))??null;}
  querySelectorAll(){return [];}
  append(child:Control){this.html+=child.innerHTML;}
  emit(type:string){for(const listener of this.listeners.get(type)??[])listener({currentTarget:this,target:this,preventDefault(){}});}
 }
 const app=new Control('app'),flash=new Control('flash-region');for(const id of ['data-mode-switch','data-mode-status','offline-mode-label','online-mode-label','environment-footer'])new Control(id);
 const saved=storage(),local=storage();saveDataMode(local,storedMode);
 const location={pathname,search:pathname==='/wallet/new'?'?scenario_id=S':'',href:pathname};
 const calls:Array<{path:string;init?:RequestInit;body?:Record<string,unknown>}>=[];
 let delayed:((path:string,init?:RequestInit)=>Promise<Response|undefined>)|undefined;
 const prepared=new Map<string,Record<string,unknown>>();
 const options={scenarios:[{scenario_id:'S',scenario_name:'Scenario',instruction:'Tea only'}],model:'local',ai_configured:false,live_configured:true,live_environment:'mock'};
 const context=vm.createContext({URL,URLSearchParams,DOMException,AbortController,Response,Headers,FormData,Intl,Map,Set,console,crypto:{randomUUID:()=>`key-${Math.random()}`},sessionStorage:saved,localStorage:local,location,setTimeout,clearTimeout,HTMLButtonElement:Control,HTMLTextAreaElement:Control,HTMLFormElement:Control,HTMLElement:Control,HTMLInputElement:Control,
  window:{addEventListener(){}},history:{replaceState(_state:unknown,_title:string,path:string){const url=new URL(path,'http://wallet.local');location.pathname=url.pathname;location.search=url.search;location.href=path;}},
  document:{querySelector:(selector:string)=>elements.get(selector.slice(1))??null,createElement:()=>new Control(`created-${Math.random()}`),title:''},
  fetch:async(path:string,init?:RequestInit)=>{
   const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,...(init?{init}:{}),...(body?{body}:{})});const blocked=await delayed?.(path,init);if(blocked)return blocked;
   const url=new URL(path,'http://wallet.local');
   if(url.pathname==='/api/wallet/options')return response(options);
   if(url.pathname==='/api/wallet/session')return response({csrf:`csrf-${url.searchParams.get('mode')}`});
   if(url.pathname==='/api/wallet/runs')return response({runs:[{run_id:'OFFLINE',scenario_id:'S',mode:'local',status:'completed',approved_chf:'10'},{run_id:'ONLINE',scenario_id:'S',mode:'live',status:'running',approved_chf:'20'}]});
   if(url.pathname==='/api/wallet/api-starts')return response({starts:[]});
   if(url.pathname==='/api/wallet/prepare'){const prep={...body,preparation_id:`P-${prepared.size}`,status:'ready',config:{parameters:{max_order_chf:'10',learn_confirmed_habits:false}},warnings:[],clarifications:[]};prepared.set(prep.preparation_id,prep);return response(prep);}
   if(url.pathname.endsWith('/confirm'))return response({run_id:'NEW'});
   if(url.pathname.startsWith('/api/wallet/preparations/'))return response(prepared.get(url.pathname.split('/').at(-1)!));
   throw Error(`Unexpected request: ${path}`);
  }
 });
 vm.runInContext(bundle,context);
 const node=(id:string)=>elements.get(id)!;
 const open=()=>vm.runInContext('globalThis.__test.route()',context) as Promise<void>;
 const toggle=async()=>{node('data-mode-switch').emit('click');await until(()=>app.attributes.get('aria-busy')==='false');};
 const prepare=async()=>{const button=node('prepare-wallet');button.emit('click');await until(()=>!button.disabled);};
 const submit=async(form=node('confirm-form'))=>{form.emit('submit');await until(()=>!node('confirm-wallet').disabled);};
 return {app,flash,saved,local,location,calls,node,open,toggle,prepare,submit,delay:(fn:typeof delayed)=>{delayed=fn;}};
}

describe('actual global toggle and wizard handlers',()=>{
 it('sets the accessible switch, filters history, and keeps offline reads away from API starts',async()=>{
  const ui=browser('/');await ui.open();expect(ui.node('data-mode-switch').attributes.get('aria-checked')).toBe('false');expect(ui.app.innerHTML).toContain('/wallet/runs/OFFLINE');expect(ui.app.innerHTML).not.toContain('/wallet/runs/ONLINE');expect(ui.calls.some(call=>call.path.includes('/api-starts'))).toBe(false);
  await ui.toggle();expect(readDataMode(ui.local)).toBe('live');expect(ui.node('data-mode-switch').attributes.get('aria-checked')).toBe('true');expect(ui.node('data-mode-status').textContent).toContain('local API emulator');expect(ui.app.innerHTML).toContain('/wallet/runs/ONLINE');expect(ui.app.innerHTML).not.toContain('/wallet/runs/OFFLINE');expect(ui.calls.at(-1)?.path).toContain('mode=live');
 });
 it('preserves JSON and learning review, rejects the old submit handler after switching, and confirms only newly reviewed settings',async()=>{
  const ui=browser();await ui.open();await ui.prepare();expect(ui.node('wallet-prep').innerHTML).toContain('Learn my confirmed habits');const oldForm=ui.node('confirm-form');
  await ui.toggle();oldForm.emit('submit');expect(ui.calls.some(call=>call.path.includes('/confirm'))).toBe(false);await ui.prepare();ui.node('permission-json').value='{"max_order_chf":"24","min_order_chf":"3","learn_confirmed_habits":true}';await ui.submit();
  const call=ui.calls.find(call=>call.path.includes('/confirm'))!;expect(call.path).toContain('mode=live');expect(call.body).toEqual({confirmed:true,mode:'live',parameters:{max_order_chf:'24',min_order_chf:'3',learn_confirmed_habits:true}});expect(ui.location.href).toBe('/wallet/runs/NEW');
 });
 it('does not resurrect an in-flight old-mode preparation or send its follow-up poll',async()=>{
  const ui=browser();await ui.open();const gate=deferred<Response>();let reached=false;ui.delay(async path=>{if(path.startsWith('/api/wallet/prepare?')){reached=true;return gate.promise;}return undefined;});ui.node('prepare-wallet').emit('click');await until(()=>reached);await ui.toggle();const count=ui.calls.length;gate.resolve(response({preparation_id:'OLD',mode:'local'}));await new Promise(done=>setTimeout(done,5));expect(ui.calls).toHaveLength(count);expect(ui.saved.getItem('wallet-preparation:S')).toBeNull();expect(ui.node('wallet-prep').innerHTML).toBe('');
 });
 it('does not open an old session when navigation happens during options loading',async()=>{
  const ui=browser();const gate=deferred<Response>();let reached=false;ui.delay(async path=>{if(path==='/api/wallet/options?mode=local'){reached=true;return gate.promise;}return undefined;});const opening=ui.open();await until(()=>reached);await ui.toggle();gate.resolve(response({scenarios:[{scenario_id:'OLD',instruction:'Old',scenario_name:'Old'}],live_configured:true,live_environment:'mock'}));await opening;expect(ui.calls.filter(call=>call.path.includes('/session'))).toHaveLength(1);expect(ui.calls.find(call=>call.path.includes('/session'))!.path).toContain('mode=live');expect(ui.node('wallet-instruction').value).toBe('Tea only');
 });
 it('ignores a delayed offline home list after online has rendered',async()=>{
  const ui=browser('/');const gate=deferred<Response>();let reached=false;ui.delay(async path=>{if(path==='/api/wallet/runs?mode=local'){reached=true;return gate.promise;}return undefined;});const opening=ui.open();await until(()=>reached);await ui.toggle();gate.resolve(response({runs:[{run_id:'STALE',mode:'local'}]}));await opening;expect(ui.app.innerHTML).toContain('/wallet/runs/ONLINE');expect(ui.app.innerHTML).not.toContain('STALE');
 });
 it('keeps typed drafts separate and restores them when toggling back',async()=>{
  const ui=browser();await ui.open();ui.node('wallet-instruction').value='Offline tea';ui.node('wallet-instruction').emit('input');await ui.toggle();expect(ui.node('wallet-instruction').value).toBe('Tea only');ui.node('wallet-instruction').value='Online coffee';ui.node('wallet-instruction').emit('input');await ui.toggle();expect(ui.node('wallet-instruction').value).toBe('Offline tea');await ui.toggle();expect(ui.node('wallet-instruction').value).toBe('Online coffee');
 });
});
