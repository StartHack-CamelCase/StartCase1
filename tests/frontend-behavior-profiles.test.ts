import { describe, expect, it, vi } from 'vitest';
import type { BehaviorScope } from '../packages/contracts/src/behavior.js';
import type { BehaviorControlRequest, BehaviorProfileDashboard } from '../packages/contracts/src/behavior-dashboard.js';
import { BehaviorProfilesController, savedBehaviorControl, savedBehaviorFeedback } from '../apps/local-web/web/behavior-profiles-controller.js';
import { habitControlActions, renderBehaviorProfileDashboard, renderBehaviorProfilesPage } from '../apps/local-web/web/behavior-profiles-view.js';
import { OperationJournal, type PendingOperation } from '../apps/local-web/web/operation-state.js';

function dashboard(scope: BehaviorScope = 'local', revision = 7): BehaviorProfileDashboard {
  return {
    customer_id: 'CU0001', scenario_id: 'SCEN0000', scope, revision,
    profile: {
      customer_id: 'CU0001', scope, timezone: 'Europe/Zurich', version: 'profile-version-1', as_of: '2026-08-12T10:00:00Z',
      parameters: {
        C15: { min_distinct_days: 3, min_effective_count: 2, half_life_days: 30, window_days: 90 },
        C18: { min_distinct_days: 5, min_effective_count: 4, half_life_days: 15, window_days: 60 },
        C19: { min_distinct_days: 4, min_effective_count: 3, half_life_days: 20, window_days: 80 },
      },
      habits: [
        { filter_id: 'C15', context_key: 'device-1', confirmations: 3, distinct_days: 3, effective_count: 2.6, last_confirmed_at: '2026-08-11T10:00:00Z', learned: true, source_ids: ['a', 'b', 'c'] },
        { filter_id: 'C18', context_key: 'Europe/Zurich|weekday|8-12', confirmations: 2, distinct_days: 2, effective_count: 1.6, last_confirmed_at: '2026-08-11T10:00:00Z', learned: false, source_ids: ['b', 'c'] },
        { filter_id: 'C19', context_key: 'FR', confirmations: 0, distinct_days: 0, effective_count: 0, last_confirmed_at: '', learned: false, status: 'suspended', source_ids: [] },
      ],
    },
    permissions: [{ run_id: 'run-1', mandate_id: 'mandate-1', status: 'completed', learning_enabled: true, items: [{ key: 'max_order_chf', label: 'Maximum purchase', value: 'CHF 30', description: 'Including delivery.' }] }],
    controls: [],
    metrics: { evaluations: 8, alerts_avoided: 3, interruptions_avoided: 1, verified_suppressions: 1, contradicted_suppressions: 0, unknown_suppressions: 2, by_filter: [] },
    reviews: [{ authorization_id: 'AUTH-1', source_id: 'SOURCE-1', filter_id: 'C15', context_key: 'device-1', occurred_at: '2026-08-11T10:00:00Z', verdict: null }],
    notice: 'Synthetic customer data. No real payments.',
  };
}

function harness() {
  const deps = {
    loadProfiles: vi.fn(async () => ({ profiles: [{ customer_id: 'CU0001', scenario_id: 'SCEN0000', scenario_name: 'Connection check' }] })),
    loadDetail: vi.fn(async (_scenario: string, scope: BehaviorScope) => dashboard(scope)),
    openSession: vi.fn(async (_scenario: string) => {}),
    mutate: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => dashboard()),
    pendingRequest: vi.fn((_path: string): PendingOperation | null => null),
    clearNotice: vi.fn(), render: vi.fn(),
  };
  return { deps, controller: new BehaviorProfilesController(deps) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('profile dashboard rendering', () => {
  it('separates saved permissions, simulated time, learned contexts and decision evidence', () => {
    const html = renderBehaviorProfileDashboard(dashboard());
    expect(html).toContain('Explicit spending permissions');
    expect(html).toContain('Run 1 · run-1');
    expect(html).toContain('completed · Learning enabled');
    expect(html).toContain('Maximum purchase');
    expect(html).toContain('CHF 30');
    expect(html).toContain('Learned behavior');
    expect(html).toContain('simulated purchase time');
    expect(html).toContain('Behavior alerts suppressed');
    expect(html).toContain('Purchase interruptions avoided');
    expect(html).toContain('Unknown outcomes are not successful predictions');
    expect(html).not.toContain('%');
  });

  it('renders per-filter thresholds and accessible evidence meters without truncating textual evidence', () => {
    const html = renderBehaviorProfileDashboard(dashboard());
    expect(html).toContain('id="habit-0-days-meter" min="0" max="3" value="3"');
    expect(html).toContain('id="habit-0-weight-meter" min="0" max="2" value="2"');
    expect(html).toContain('2.6 / 2');
    expect(html).toContain('id="habit-1-days-meter" min="0" max="5" value="2"');
    expect(html).toContain('id="habit-1-weight-meter" min="0" max="4" value="1.6"');
    expect(html).toContain('Evidence window: 60 days');
    expect(html).toContain('halves every 15 days');
    expect(html).toContain('aria-valuetext="2 of 5 required distinct days"');
  });

  it('offers resume only for suspended contexts and explains fresh learning and retained audit', () => {
    const data = dashboard();
    expect(habitControlActions(data.profile.habits[0]!)).toEqual(['suspend', 'forget']);
    expect(habitControlActions(data.profile.habits[2]!)).toEqual(['resume', 'forget']);
    data.profile.habits[0]!.status = 'forgotten';
    expect(habitControlActions(data.profile.habits[0]!)).toEqual(['suspend']);
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Forgotten'); expect(html).toContain('Suspended');
    expect(html.match(/data-profile-action="resume"/g)).toHaveLength(1);
    expect(html).toContain('previous evidence is not restored');
    expect(html).toContain('the decision audit stays available');
  });

  it('shows empty states and unavailable historical parameters without inventing progress', () => {
    const data = dashboard(); data.profile.habits = []; data.permissions = []; data.reviews = [];
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('No saved permissions in this scope');
    expect(html).toContain('No confirmed device habits');
    expect(html).toContain('No confirmed purchase-time habits');
    expect(html).toContain('No confirmed merchant-country habits');
    expect(html).toContain('No learned decisions are available');
    expect(html).toContain('/wallet/new?scenario_id=SCEN0000');
    expect(html).not.toContain('<meter');
    const legacy = dashboard(); delete legacy.profile.parameters;
    expect(renderBehaviorProfileDashboard(legacy)).toContain('Thresholds are unavailable');
  });

  it('requires explicit feedback and does not offer the same verdict a second time', () => {
    const data = dashboard();
    let html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('This context was appropriate');
    expect(html).toContain('This context was not appropriate');
    expect(html).toContain('does not count as a new learning confirmation');
    data.reviews![0]!.verdict = 'rejected';
    html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('The habit was suspended');
    expect(html).not.toContain('data-profile-feedback=');
  });

  it('escapes untrusted context, server notices, permission values and profile choices', () => {
    const data = dashboard(); data.profile.habits[0]!.context_key = '<img src=x onerror=alert(1)>';
    data.permissions[0]!.items[0]!.value = '<script>bad()</script>'; data.notice = '<b>unsafe</b>';
    const html = renderBehaviorProfileDashboard(data);
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<b>unsafe');
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
    const { controller } = harness(); const state = controller.snapshot();
    state.options = [{ customer_id: 'C', scenario_id: 'S" autofocus', scenario_name: '<svg>' }];
    expect(renderBehaviorProfilesPage(state)).toContain('S&quot; autofocus');
    expect(renderBehaviorProfilesPage(state)).not.toContain('<svg>');
  });
});

describe('profile page coordination', () => {
  it('never creates feedback or control mutations while reading profiles', async () => {
    const { deps, controller } = harness();
    await controller.initialize(); await controller.refresh();
    expect(deps.mutate).not.toHaveBeenCalled();
    expect(controller.snapshot().dashboard?.scope).toBe('local');
  });

  it('ignores a delayed previous-scope response', async () => {
    const { deps, controller } = harness(); await controller.initialize();
    const old = deferred<BehaviorProfileDashboard>();
    deps.loadDetail.mockImplementation(async (_scenario, scope) => scope === 'local' ? old.promise : dashboard('live'));
    const first = controller.refresh(); await Promise.resolve();
    await controller.select('SCEN0000', 'live');
    old.resolve(dashboard('local')); await first;
    expect(controller.snapshot().scope).toBe('live');
    expect(controller.snapshot().dashboard?.scope).toBe('live');
  });

  it('stops rendering after disposal and never dispatches a mutation after navigation during session setup', async () => {
    const { deps, controller } = harness(); await controller.initialize();
    const session = deferred<void>(); deps.openSession.mockImplementation(async () => session.promise);
    const work = controller.control(0, 'forget'); const renders = deps.render.mock.calls.length;
    controller.dispose(); session.resolve(); await work;
    expect(deps.mutate).not.toHaveBeenCalled();
    expect(deps.render).toHaveBeenCalledTimes(renders);
  });

  it('refreshes a conflicting revision without silently resubmitting the mutation', async () => {
    const { deps, controller } = harness(); await controller.initialize();
    deps.mutate.mockRejectedValue({ status: 409 });
    deps.loadDetail.mockResolvedValue(dashboard('local', 8));
    await controller.control(0, 'forget');
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    expect(deps.mutate.mock.calls[0]![1]).toMatchObject({ expected_revision: 7, action: 'forget' });
    expect(controller.snapshot().dashboard?.revision).toBe(8);
    expect(controller.snapshot().error).toContain('Review it before choosing the action again');
  });

  it('retries an interrupted request with the original key and body and blocks other mutations meanwhile', async () => {
    const memory = new Map<string, string>();
    const journal = new OperationJournal({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } }, () => 'same-key');
    const { deps, controller } = harness();
    deps.pendingRequest.mockImplementation(path => journal.pending(path));
    let fail = true;
    const keys: string[] = [];
    deps.mutate.mockImplementation(async (path, body) => {
      const operation = journal.begin(path, 'POST', body); keys.push(operation.key);
      if (fail) throw Error('Connection interrupted');
      journal.acknowledged(operation); return dashboard('local', 8);
    });
    await controller.initialize(); await controller.control(0, 'suspend');
    expect(controller.snapshot().recovery?.body).toMatchObject({ action: 'suspend', expected_revision: 7 });
    await controller.control(1, 'forget'); await controller.feedback(0, 'confirmed');
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    deps.loadDetail.mockResolvedValue(dashboard('local', 8)); await controller.refresh();
    fail = false; await controller.retrySaved();
    expect(keys).toEqual(['same-key', 'same-key']);
    expect(deps.mutate.mock.calls[1]![1]).toEqual(deps.mutate.mock.calls[0]![1]);
    expect(controller.snapshot().recovery).toBeNull();
  });

  it('sends feedback only for an explicit unreviewed context and never turns it into a control request', async () => {
    const { deps, controller } = harness(); await controller.initialize();
    const updated = dashboard('local', 8); updated.reviews![0]!.verdict = 'rejected';
    deps.loadDetail.mockResolvedValue(updated);
    await controller.feedback(0, 'rejected');
    expect(deps.mutate).toHaveBeenCalledWith('/api/wallet/profiles/feedback', { scenario_id: 'SCEN0000', scope: 'local', authorization_id: 'AUTH-1', filter_id: 'C15', verdict: 'rejected', expected_revision: 7 });
    await controller.feedback(0, 'confirmed');
    expect(deps.mutate).toHaveBeenCalledTimes(1);
  });

  it('refuses resume for an active habit and recovers after an initial list failure', async () => {
    const { deps, controller } = harness();
    deps.loadProfiles.mockRejectedValueOnce(Error('Connection unavailable'));
    await controller.initialize(); expect(controller.snapshot().error).toContain('Connection unavailable');
    await controller.refresh();
    expect(controller.snapshot().dashboard?.customer_id).toBe('CU0001');
    await controller.control(0, 'resume'); expect(deps.mutate).not.toHaveBeenCalled();
    await controller.control(2, 'resume'); expect(deps.mutate).toHaveBeenCalledTimes(1);
  });

  it('validates saved request bodies before replay', () => {
    const body: BehaviorControlRequest = { scenario_id: 'SCEN0000', scope: 'local', filter_id: 'C15', context_key: 'device-1', action: 'forget', expected_revision: 7 };
    const operation: PendingOperation = { key: 'key', path: '/api/wallet/profiles/control', method: 'POST', body: JSON.stringify(body), created_at: '2026-09-19T00:00:00Z' };
    expect(savedBehaviorControl(operation)).toEqual(body);
    expect(() => savedBehaviorControl({ ...operation, body: '{' })).toThrow();
    expect(() => savedBehaviorControl({ ...operation, body: JSON.stringify({ ...body, expected_revision: -1 }) })).toThrow();
    expect(() => savedBehaviorFeedback(operation)).toThrow();
    expect(savedBehaviorControl(null)).toBeNull();
  });

  it('blocks habit changes while feedback is unresolved and retries that feedback for its original scenario', async () => {
    const { deps, controller } = harness();
    const body = { scenario_id: 'SCEN0002', scope: 'live', authorization_id: 'OTHER-AUTH', filter_id: 'C18', verdict: 'confirmed', expected_revision: 4 };
    let pending: PendingOperation | null = { key: 'feedback-key', path: '/api/wallet/profiles/feedback', method: 'POST', body: JSON.stringify(body), created_at: '2026-09-19T00:00:00Z' };
    deps.pendingRequest.mockImplementation(path => path === '/api/wallet/profiles/feedback' ? pending : null);
    deps.mutate.mockImplementation(async () => { pending = null; return dashboard(); });
    await controller.initialize();
    await controller.control(0, 'forget'); expect(deps.mutate).not.toHaveBeenCalled();
    await controller.retrySaved();
    expect(deps.openSession).toHaveBeenCalledWith('SCEN0002');
    expect(deps.mutate).toHaveBeenCalledWith('/api/wallet/profiles/feedback', body);
    expect(controller.snapshot().dashboard?.scenario_id).toBe('SCEN0000');
  });
});
