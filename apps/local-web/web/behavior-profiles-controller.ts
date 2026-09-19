import type { BehaviorScope } from '../../../packages/contracts/src/behavior.js';
import type { BehaviorControlRequest, BehaviorFeedbackRequest, BehaviorProfileDashboard, BehaviorProfileOption } from '../../../packages/contracts/src/behavior-dashboard.js';
import type { PendingOperation } from './operation-state.js';
import { habitControlActions, renderBehaviorProfilesPage, type ProfileViewState } from './behavior-profiles-view.js';

const CONTROL_PATH = '/api/wallet/profiles/control';
const FEEDBACK_PATH = '/api/wallet/profiles/feedback';
type Dependencies = {
  loadProfiles: () => Promise<{ profiles: BehaviorProfileOption[] }>;
  loadDetail: (scenarioId: string, scope: BehaviorScope) => Promise<BehaviorProfileDashboard>;
  openSession: (scenarioId: string) => Promise<void>;
  mutate: (path: string, body: unknown) => Promise<unknown>;
  pendingRequest: (path: string) => PendingOperation | null;
  clearNotice: () => void;
  render: (state: ProfileViewState) => void;
  initialScenarioId?: string;
  initialScope?: BehaviorScope;
};

/** An interrupted mutation may only be retried with its original revision/body. */
export function savedBehaviorControl(pending: PendingOperation | null): BehaviorControlRequest | null {
  if (!pending) return null;
  if (pending.path !== CONTROL_PATH || pending.method !== 'POST' || !pending.body) throw Error('The saved profile request cannot be read. Reconcile it before changing a habit.');
  let body: unknown;
  try { body = JSON.parse(pending.body); } catch { throw Error('The saved profile request cannot be read. Reconcile it before changing a habit.'); }
  const value = body as BehaviorControlRequest | null;
  if (!value || typeof value.scenario_id !== 'string' || !value.scenario_id || !['local', 'live'].includes(value.scope) || !['C15', 'C18', 'C19'].includes(value.filter_id) || typeof value.context_key !== 'string' || !value.context_key || !['forget', 'suspend', 'resume'].includes(value.action) || !Number.isInteger(value.expected_revision) || value.expected_revision < 0) throw Error('The saved profile request cannot be read. Reconcile it before changing a habit.');
  return value;
}

export function savedBehaviorFeedback(pending: PendingOperation | null): BehaviorFeedbackRequest | null {
  if (!pending) return null;
  if (pending.path !== FEEDBACK_PATH || pending.method !== 'POST' || !pending.body) throw Error('The saved feedback request cannot be read. Reconcile it before changing a habit.');
  let body: unknown;
  try { body = JSON.parse(pending.body); } catch { throw Error('The saved feedback request cannot be read. Reconcile it before changing a habit.'); }
  const value = body as BehaviorFeedbackRequest | null;
  if (!value || typeof value.scenario_id !== 'string' || !value.scenario_id || !['local', 'live'].includes(value.scope) || !['C15', 'C18', 'C19'].includes(value.filter_id) || typeof value.authorization_id !== 'string' || !value.authorization_id || !['confirmed', 'rejected'].includes(value.verdict) || !Number.isInteger(value.expected_revision) || value.expected_revision < 0) throw Error('The saved feedback request cannot be read. Reconcile it before changing a habit.');
  return value;
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'This profile could not be updated. Try refreshing its saved state.'; }
function conflict(error: unknown): boolean { return !!error && typeof error === 'object' && 'status' in error && error.status === 409; }

/** Async page state is kept separate from the DOM so races and retries stay testable. */
export class BehaviorProfilesController {
  private disposed = false;
  private readSequence = 0;
  private state: ProfileViewState;

  constructor(private readonly deps: Dependencies) {
    this.state = { options: [], scenarioId: '', scope: deps.initialScope ?? 'local', dashboard: null, loading: true, mutating: false, initialized: false, error: null, recovery: null, recoveryInvalid: false };
  }

  snapshot(): ProfileViewState { return structuredClone(this.state); }
  dispose(): void { this.disposed = true; ++this.readSequence; }

  private publish(): void {
    if (this.disposed) return;
    try {
      const control = savedBehaviorControl(this.deps.pendingRequest(CONTROL_PATH));
      const feedback = savedBehaviorFeedback(this.deps.pendingRequest(FEEDBACK_PATH));
      this.state.recovery = control ? { path: CONTROL_PATH, body: control } : feedback ? { path: FEEDBACK_PATH, body: feedback } : null;
      this.state.recoveryInvalid = false;
    }
    catch (error) { this.state.recovery = null; this.state.recoveryInvalid = true; this.state.error = message(error); }
    this.deps.render(this.snapshot());
  }

  async initialize(): Promise<void> {
    const sequence = ++this.readSequence;
    this.publish();
    try {
      const result = await this.deps.loadProfiles();
      if (this.disposed || sequence !== this.readSequence) return;
      this.state.options = result.profiles;
      this.state.initialized = true;
      const selected = result.profiles.find(option => option.scenario_id === this.deps.initialScenarioId) ?? result.profiles[0];
      if (!selected) { this.state.loading = false; this.publish(); return; }
      await this.select(selected.scenario_id, this.state.scope);
    } catch (error) {
      if (this.disposed || sequence !== this.readSequence) return;
      this.state.loading = false; this.state.initialized = true; this.state.error = message(error); this.publish();
    }
  }

  async select(scenarioId: string, scope: BehaviorScope): Promise<void> {
    if (this.disposed || this.state.mutating || !['local', 'live'].includes(scope) || !this.state.options.some(option => option.scenario_id === scenarioId)) return;
    this.state.scenarioId = scenarioId; this.state.scope = scope; this.state.dashboard = null; this.state.error = null;
    await this.refresh();
  }

  async refresh(preserveError = false): Promise<void> {
    if (this.disposed || this.state.mutating) return;
    if (!this.state.scenarioId) { await this.initialize(); return; }
    const sequence = ++this.readSequence, { scenarioId, scope } = this.state;
    this.state.loading = true;
    if (!preserveError) this.state.error = null;
    this.publish();
    try {
      await this.deps.openSession(scenarioId);
      if (this.disposed || sequence !== this.readSequence) return;
      const dashboard = await this.deps.loadDetail(scenarioId, scope);
      if (this.disposed || sequence !== this.readSequence) return;
      if (dashboard.scenario_id !== scenarioId || dashboard.scope !== scope) throw Error('The returned profile does not match this selection. Refresh to try again.');
      this.state.dashboard = dashboard;
    } catch (error) {
      if (!this.disposed && sequence === this.readSequence) this.state.error = message(error);
    } finally {
      if (!this.disposed && sequence === this.readSequence) { this.state.loading = false; this.publish(); }
    }
  }

  async control(index: number, action: BehaviorControlRequest['action']): Promise<void> {
    if (this.disposed || this.state.mutating || this.state.loading || !this.state.dashboard) return;
    this.publish();
    if (this.state.recovery || this.state.recoveryInvalid) return;
    const habit = this.state.dashboard.profile.habits[index];
    if (!habit || !habitControlActions(habit).includes(action)) return;
    await this.perform(CONTROL_PATH, { scenario_id: this.state.scenarioId, scope: this.state.scope, filter_id: habit.filter_id, context_key: habit.context_key, action, expected_revision: this.state.dashboard.revision });
  }

  async feedback(index: number, verdict: BehaviorFeedbackRequest['verdict']): Promise<void> {
    if (this.disposed || this.state.mutating || this.state.loading || !this.state.dashboard || !['confirmed', 'rejected'].includes(verdict)) return;
    this.publish();
    if (this.state.recovery || this.state.recoveryInvalid) return;
    const review = this.state.dashboard.reviews?.[index];
    if (!review || review.verdict === verdict) return;
    await this.perform(FEEDBACK_PATH, { scenario_id: this.state.scenarioId, scope: this.state.scope, authorization_id: review.authorization_id, filter_id: review.filter_id, verdict, expected_revision: this.state.dashboard.revision });
  }

  async retrySaved(): Promise<void> {
    if (this.disposed || this.state.mutating) return;
    this.publish();
    if (this.state.recovery) await this.perform(this.state.recovery.path, this.state.recovery.body);
  }

  private async perform(path: string, body: BehaviorControlRequest | BehaviorFeedbackRequest): Promise<void> {
    ++this.readSequence;
    this.state.mutating = true; this.state.loading = false; this.state.error = null;
    this.deps.clearNotice(); this.publish();
    try {
      // A saved request may concern another selection. Authenticate its exact owner.
      await this.deps.openSession(body.scenario_id);
      if (this.disposed) return;
      await this.deps.mutate(path, body);
    } catch (error) {
      if (!this.disposed) this.state.error = conflict(error)
        ? 'This profile changed. Its latest state has been refreshed. Review it before choosing the action again.'
        : message(error);
    } finally {
      if (!this.disposed) {
        this.state.mutating = false; this.publish();
        // Read the accepted state. A 409 is never replayed with a newer revision.
        await this.refresh(true);
      }
    }
  }
}

export type MountBehaviorProfilesOptions = Omit<Dependencies, 'render'> & {
  host: HTMLElement;
  notice: (error: unknown) => void;
  onDispose: (dispose: () => void) => void;
  fixedScope?: boolean;
};

export async function mountBehaviorProfilesPage(options: MountBehaviorProfilesOptions): Promise<void> {
  const listeners = new AbortController();
  let rememberedFocus: string | null = null;
  options.host.setAttribute('aria-live', 'off');
  const controller = new BehaviorProfilesController({ ...options, render(state) {
    const active = document.activeElement;
    const focusedId = active instanceof HTMLElement && options.host.contains(active) ? active.id : null;
    if (focusedId) rememberedFocus = focusedId;
    const openRuns = new Set([...options.host.querySelectorAll<HTMLDetailsElement>('.profile-permission-run')].map((item, index) => item.open ? index : -1));
    options.host.innerHTML = renderBehaviorProfilesPage(state, options.fixedScope);
    options.host.setAttribute('aria-busy', String(state.loading || state.mutating));
    options.host.querySelectorAll<HTMLDetailsElement>('.profile-permission-run').forEach((item, index) => { if (openRuns.has(index)) item.open = true; });
    if (rememberedFocus && !state.mutating && !state.loading) {
      const target = document.getElementById(rememberedFocus);
      (target && options.host.contains(target) ? target : options.host.querySelector<HTMLElement>('#profile-page-status'))?.focus({ preventScroll: true });
      rememberedFocus = null;
    }
  } });
  options.onDispose(() => { listeners.abort(); controller.dispose(); });
  options.host.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !['profile-scenario', 'profile-scope'].includes(target.id)) return;
    const scenarioId = options.host.querySelector<HTMLSelectElement>('#profile-scenario')!.value;
    const scope = options.host.querySelector<HTMLSelectElement>('#profile-scope')!.value;
    if (scope !== 'local' && scope !== 'live') return;
    if (options.fixedScope && scope !== options.initialScope) return;
    const url = new URL(location.href); url.searchParams.set('scenario_id', scenarioId); url.searchParams.set('scope', scope); history.replaceState(null, '', url);
    void controller.select(scenarioId, scope).catch(options.notice);
  }, { signal: listeners.signal });
  options.host.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled) return;
    if (button.id === 'refresh-profiles') { void controller.refresh().catch(options.notice); return; }
    if (button.id === 'retry-profile-control') { void controller.retrySaved().catch(options.notice); return; }
    const verdict = button.dataset['profileFeedback'], reviewIndex = Number(button.dataset['reviewIndex']);
    if ((verdict === 'confirmed' || verdict === 'rejected') && Number.isInteger(reviewIndex)) { void controller.feedback(reviewIndex, verdict).catch(options.notice); return; }
    const action = button.dataset['profileAction'], index = Number(button.dataset['habitIndex']);
    if (['forget', 'suspend', 'resume'].includes(action ?? '') && Number.isInteger(index)) void controller.control(index, action as BehaviorControlRequest['action']).catch(options.notice);
  }, { signal: listeners.signal });
  document.title = 'Your profiles | Viseca';
  await controller.initialize();
}
