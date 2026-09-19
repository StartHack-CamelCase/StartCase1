export type DataMode = 'local' | 'live';
export type LiveEnvironment = 'mock' | 'remote' | 'disabled';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const MODE_KEY = 'viseca.data-mode.v1';

export function readDataMode(storage: Pick<Storage, 'getItem'>): DataMode {
  return storage.getItem(MODE_KEY) === 'live' ? 'live' : 'local';
}
export function saveDataMode(storage: Pick<Storage, 'setItem'>, mode: DataMode): void {
  storage.setItem(MODE_KEY, mode);
}

/** Preserve existing offline drafts while isolating API requests and reviews. */
export function modeStorage(storage: StorageLike, mode: DataMode): StorageLike {
  const key = (value: string) => mode === 'local' ? value : `viseca.online:${value}`;
  return { getItem: name => storage.getItem(key(name)), setItem: (name, value) => storage.setItem(key(name), value), removeItem: name => storage.removeItem(key(name)) };
}
export function modePath(path: string, mode: DataMode): string {
  const url = new URL(path, 'http://wallet.local');
  url.searchParams.set('mode', mode);
  return url.pathname + url.search + url.hash;
}
export function modeLanding(pathname: string, search: string): string {
  if (pathname === '/wallet/profiles' || pathname === '/wallet/new') {
    const query = new URLSearchParams(search); query.delete('scope'); query.delete('mode');
    return pathname + (query.size ? `?${query}` : '');
  }
  return '/';
}
export function connectionLabel(mode: DataMode, environment: LiveEnvironment): string {
  return mode === 'local' ? 'Offline · local data' : environment === 'mock' ? 'Online · local API emulator' : environment === 'disabled' ? 'Online · API not configured' : 'Online · Viseca API';
}

/** Every continuation remains bound to the page and data source that created it. */
export class PageRequestScope {
  private readonly controller = new AbortController();
  constructor(readonly mode: DataMode, private readonly transport: typeof fetch = fetch) {}
  get active(): boolean { return !this.controller.signal.aborted; }
  dispose(): void { this.controller.abort(); }
  assertActive(): void { if (!this.active) throw new DOMException('The page or data source changed.', 'AbortError'); }
  async request(path: string, init?: RequestInit): Promise<Response> {
    this.assertActive();
    const transport = this.transport;
    const response = await transport(modePath(path, this.mode), { ...init, signal: this.controller.signal });
    this.assertActive();
    return response;
  }
}

export function preparationMatches(preparation: { scenario_id: string; instruction: string; mode: DataMode }, expected: { scenario_id: string; instruction: string; mode: DataMode }): boolean {
  return preparation.scenario_id === expected.scenario_id && preparation.instruction === expected.instruction && preparation.mode === expected.mode;
}
