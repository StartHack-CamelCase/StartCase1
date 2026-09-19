import { describe, expect, it, vi } from 'vitest';
import type { BehaviorScope } from '../packages/contracts/src/behavior.js';
import type { BehaviorControlRequest, BehaviorProfileDashboard } from '../packages/contracts/src/behavior-dashboard.js';
import type { BehaviorMLDashboard } from '../packages/contracts/src/behavior-ml.js';
import type { SimplePreferencesDashboard } from '../packages/contracts/src/simple-preferences.js';
import { BehaviorProfilesController, savedBehaviorControl, savedBehaviorFeedback } from '../apps/local-web/web/behavior-profiles-controller.js';
import { habitControlActions, renderBehaviorMachineLearning, renderBehaviorProfileDashboard, renderBehaviorProfilesPage, renderSimplePreferences } from '../apps/local-web/web/behavior-profiles-view.js';
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
    expect(html).toContain('No behavioral contexts are available');
    expect(html).toContain('/wallet/new?scenario_id=SCEN0000');
    expect(html).not.toContain('<meter');
    const legacy = dashboard(); delete legacy.profile.parameters;
    expect(renderBehaviorProfileDashboard(legacy)).toContain('Thresholds are unavailable');
  });

  it('allows correcting feedback without offering the same verdict a second time', () => {
    const data = dashboard();
    let html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('This context was appropriate');
    expect(html).toContain('This context was not appropriate');
    expect(html).toContain('does not count as a new learning confirmation');
    data.reviews![0]!.verdict = 'rejected';
    html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('The habit was suspended');
    expect(html).toContain('Change to appropriate');
    expect(html).not.toContain('data-profile-feedback="rejected"');
    expect(html).toContain('A correction replaces your previous answer');
    data.profile.habits[0]!.status = 'suspended';
    data.reviews![0]!.verdict = 'confirmed';
    html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Change to inappropriate');
    expect(html).not.toContain('data-profile-feedback="confirmed"');
    expect(html).toContain('This habit remains suspended');
    expect(renderBehaviorProfileDashboard(data, true)).toMatch(/data-profile-feedback="rejected" disabled/);
  });

  it('explains how to start learning when every saved run has it disabled', () => {
    const data = dashboard(); data.permissions[0]!.learning_enabled = false;
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Habit learning is not enabled in your saved runs');
    expect(html).toContain('Learn my confirmed habits');
    expect(html).toContain('Earlier runs with learning off do not become learning evidence');
    expect(html).toContain('Set up habit learning');
    data.permissions = [];
    expect(renderBehaviorProfileDashboard(data)).toContain('Set up habit learning');
  });

  it('distinguishes score feedback from purchase learning without claiming all runs are opted in', () => {
    const data = dashboard();
    data.permissions.push({ ...data.permissions[0]!, run_id: 'run-2', learning_enabled: false });
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Learning was enabled in 1 of 2 saved runs');
    expect(html).toContain('Each new run uses the choice in its confirmed permissions');
    expect(html).toContain('Only a learned habit can avoid a future behavior alert');
    expect(html).toContain('Replaying the same purchase does not add evidence');
    expect(html).not.toContain('Set up habit learning');
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

function simplePreferences(): SimplePreferencesDashboard {
  return {
    algorithm: 'beta_bernoulli_v1', observation_only: true,
    formula: '(confirmations + 1) / (confirmations + rejections + 2)',
    contexts: [{ filter_id: 'C15', context_key: 'device-1', confirmed: 8, rejected: 2, samples: 10, score: 0.75, standard_deviation: 0.12, status: 'learning', reason: null }],
    totals: { confirmed: 8, rejected: 2, contexts: 1 }, notice: 'Preferences use explicit context feedback only.',
  };
}

describe('simple preference rendering', () => {
  it('makes the count-based calculation visible and keeps the advanced model out of the default view', () => {
    const data = dashboard(); data.simple_preferences = simplePreferences(); data.machine_learning = machineLearning();
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Simple learning');
    expect(html).toContain('More confirmations raise a preference score; rejections lower it. Payment rules stay unchanged.');
    expect(html).toContain('(confirmations + 1) / (confirmations + rejections + 2)');
    expect(html).toContain('Yes · appropriate</dt><dd>8');
    expect(html).toContain('No · inappropriate</dt><dd>2');
    expect(html).toContain('9 / 12 = 0.75');
    expect(html).toContain('not a fraud probability');
    expect(html).not.toMatch(/Shadow machine learning|Brier score|Log loss|coefficients|standard deviation|%/);
  });

  it('shows no score before feedback rather than presenting the prior as a learned preference', () => {
    expect(renderSimplePreferences(undefined)).toBe('');
    const data = simplePreferences();
    data.contexts[0] = { ...data.contexts[0]!, confirmed: 0, rejected: 0, samples: 0, score: 0.5, status: 'no_feedback' };
    data.totals = { confirmed: 0, rejected: 0, contexts: 1 };
    let html = renderSimplePreferences(data);
    expect(html).toContain('Learning starts after your first explicit feedback');
    expect(html).not.toContain('= 0.50');
    expect(html).not.toContain('profile-preference-score');
    data.contexts = []; data.totals.contexts = 0;
    html = renderSimplePreferences(data);
    expect(html).toContain('No feedback yet');
    expect(html).not.toContain('profile-preference-score');
  });

  it.each(['suspended', 'forgotten'] as const)('withholds the score for a %s context even if a stale payload retains positive evidence', status => {
    const data = simplePreferences(); data.contexts[0]!.status = status;
    const html = renderSimplePreferences(data);
    expect(html).toContain(status === 'suspended' ? 'No score while this context is suspended.' : 'Previous feedback no longer counts.');
    expect(html).toContain('Yes · appropriate</dt><dd>8');
    expect(html).not.toContain('9 / 12');
    expect(html).not.toContain('profile-preference-score');
  });

  it('does not print an equation when the supplied score, counts or evidence disagree', () => {
    const data = simplePreferences();
    for (const badScore of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.1, 0.9, null]) {
      data.contexts[0]!.score = badScore;
      const html = renderSimplePreferences(data);
      expect(html).toContain('Score unavailable');
      expect(html).not.toContain('profile-preference-score');
      expect(html).not.toMatch(/NaN|Infinity/);
    }
    data.contexts[0]!.score = 0.75; data.contexts[0]!.samples = 9;
    expect(renderSimplePreferences(data)).not.toContain('profile-preference-score');
  });

  it('marks rounded fractions as approximate and escapes context, reason and notice text', () => {
    const data = simplePreferences();
    data.contexts[0] = { ...data.contexts[0]!, confirmed: 1, rejected: 0, samples: 1, score: 2 / 3, context_key: '<img src=x>', reason: '<b>reason</b>' };
    data.notice = '<script>notice()</script>';
    const html = renderSimplePreferences(data);
    expect(html).toContain('2 / 3 ≈ 0.6667');
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;b&gt;reason'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<img|<b>|<script>/);
  });
});

function machineLearning(): BehaviorMLDashboard {
  return {
    mode: 'shadow', decision_influence: false, feature_version: 'features-v1', notice: 'Synthetic context feedback only.',
    models: [
      { filter_id: 'C15', status: 'trained', version: 'device-model-1', positive: 10, negative: 6, samples: 16, excluded: 2,
        metrics: { scored: 4, total: 16, insufficient: 12, excluded: 2, positive: 2, negative: 2, brier: 0.18, log_loss: 0.53 } },
      { filter_id: 'C18', status: 'insufficient_data', version: 'time-model-1', positive: 3, negative: 0, samples: 3, excluded: 0,
        metrics: { scored: 0, total: 3, insufficient: 3, excluded: 0, positive: 0, negative: 0, brier: null, log_loss: null } },
    ],
    predictions: [
      { authorization_id: 'AUTH-1', filter_id: 'C15', context_key: 'device-1', score: 0.91, model_version: 'device-model-1', observed_label: 'rejected', retrospective: true, abstention_reason: null },
      { authorization_id: 'AUTH-2', filter_id: 'C18', context_key: 'Europe/Zurich|weekday|8-12', score: null, model_version: null, observed_label: null, retrospective: true, abstention_reason: 'More rejected context labels are needed.' },
    ],
  };
}

describe('shadow machine learning rendering', () => {
  it('shows label counts, independent training status and chronological metric denominators without implying payment influence', () => {
    const data = dashboard(); data.machine_learning = machineLearning();
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Shadow machine learning');
    expect(html).toContain('Its scores do not change approvals, declines or confirmation requests');
    expect(html).toContain('An approved purchase does not automatically become a positive label');
    expect(html).toContain('Confirmed labels</dt><dd>10');
    expect(html).toContain('Rejected labels</dt><dd>6');
    expect(html).toContain('Accepted training examples</dt><dd>16');
    expect(html).toContain('Excluded examples</dt><dd>2');
    expect(html).toContain('Trained · shadow only');
    expect(html).toContain('Insufficient data');
    expect(html).toContain('Both confirmed and rejected context labels are needed');
    expect(html).toContain('Chronological evaluation on the current eligible cohort');
    expect(html).toContain('4 scored examples');
    expect(html).toContain('4 of 16 labelled examples scored');
    expect(html).toContain('Brier score</dt><dd>0.18');
    expect(html).toContain('Log loss</dt><dd>0.53');
    expect(html).not.toContain('%');
  });

  it('keeps contrary human feedback alongside a high score without converting it into a successful or safe decision', () => {
    const data = machineLearning();
    data.predictions.push({ ...data.predictions[0]!, authorization_id: 'AUTH-3', score: 0.08, observed_label: 'confirmed' });
    const html = renderBehaviorMachineLearning(data);
    expect(html).toContain('Retrospective context scores');
    expect(html).toContain('current model, not the model available at purchase time');
    expect(html).toContain('Uncalibrated confirmation score</dt><dd>0.91');
    expect(html).toContain('Context rejected as inappropriate');
    expect(html).toContain('Uncalibrated confirmation score</dt><dd>0.08');
    expect(html).toContain('Context confirmed appropriate');
    expect(html).toContain('They are not safety probabilities');
    expect(html).not.toMatch(/accuracy|confidence|safe purchase|successful prediction/i);
    expect(html).not.toContain('profile-state--learned');
  });

  it('distinguishes absent data, an unscored context and unknown human feedback from a zero score', () => {
    expect(renderBehaviorMachineLearning(undefined)).toBe('');
    const data = machineLearning(); data.models = [data.models[1]!]; data.predictions = [data.predictions[1]!];
    let html = renderBehaviorMachineLearning(data);
    expect(html).toContain('No active model');
    expect(html).toContain('0 of 3 labelled examples scored');
    expect(html).toContain('Not scored');
    expect(html).toContain('More rejected context labels are needed');
    expect(html).toContain('No explicit context feedback');
    expect(html).not.toContain('Brier score');
    expect(html).not.toContain('Log loss');
    expect(html).not.toContain('<dd>0.00</dd>');
    data.models = []; data.predictions = [];
    html = renderBehaviorMachineLearning(data);
    expect(html).toContain('No model data is available');
    expect(html).toContain('No context scores are available');
  });

  it('renders genuine zero errors with measured evidence but never metrics without a denominator', () => {
    const data = machineLearning();
    data.models[0]!.metrics.brier = 0; data.models[0]!.metrics.log_loss = 0;
    let html = renderBehaviorMachineLearning(data);
    expect(html).toContain('Brier score</dt><dd>0.00');
    expect(html).toContain('Log loss</dt><dd>0.00');
    data.models[0]!.metrics.scored = 0;
    html = renderBehaviorMachineLearning(data);
    expect(html).not.toContain('Brier score');
    expect(html).not.toContain('Log loss');
    expect(html).toContain('Evaluation unavailable');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.2, 1.2])('does not publish invalid score %s or malformed measurements as usable evidence', invalid => {
    const data = machineLearning(); data.predictions[0]!.score = invalid;
    data.models[0]!.metrics.brier = Number.NaN; data.models[0]!.metrics.log_loss = -1;
    data.models[0]!.positive = Number.POSITIVE_INFINITY;
    const html = renderBehaviorMachineLearning(data);
    expect(html).toContain('Uncalibrated confirmation score</dt><dd>Not scored');
    expect(html).toContain('Confirmed labels</dt><dd>Unavailable');
    expect(html).not.toContain('Brier score');
    expect(html).not.toContain('Log loss');
    expect(html).not.toMatch(/NaN|Infinity|<dd>-0\.2|<dd>1\.2/);
  });

  it('requires an identified model for a score and escapes all server-provided ML text', () => {
    const data = machineLearning(); data.predictions[0]!.model_version = null;
    data.predictions[0]!.context_key = '<svg onload=bad()>';
    data.predictions[0]!.abstention_reason = '<img src=x>';
    data.models[0]!.version = '<script>bad()</script>';
    data.notice = '<b>unsafe</b>';
    const html = renderBehaviorMachineLearning(data);
    expect(html).toContain('Uncalibrated confirmation score</dt><dd>Not scored');
    expect(html).toContain('&lt;svg'); expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;b&gt;unsafe');
    expect(html).not.toMatch(/<svg|<img|<script>|<b>unsafe/);
  });

  it('offers explicit review for both suppressed and raised alerts without changing suppression counters', () => {
    const data = dashboard(); data.reviews![0]!.was_suppressed = true;
    data.reviews!.push({ ...data.reviews![0]!, authorization_id: 'AUTH-2', was_suppressed: false });
    const html = renderBehaviorProfileDashboard(data);
    expect(html).toContain('Review behavioral contexts');
    expect(html).toContain('Alert suppressed by a learned habit');
    expect(html).toContain('Behavioral alert was not suppressed');
    expect(html.match(/data-profile-feedback="confirmed"/g)).toHaveLength(2);
    expect(html).toContain('Behavior alerts suppressed</dt><dd>3');
    expect(html).toContain('Purchase interruptions avoided</dt><dd>1');
    delete data.reviews![0]!.was_suppressed; data.reviews!.pop();
    expect(renderBehaviorProfileDashboard(data)).not.toContain('Alert suppressed by a learned habit');
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

  it('allows an explicit correction with the latest revision and ignores duplicate verdicts', async () => {
    const { deps, controller } = harness(); await controller.initialize();
    const updated = dashboard('local', 8); updated.reviews![0]!.verdict = 'rejected';
    deps.loadDetail.mockResolvedValue(updated);
    await controller.feedback(0, 'rejected');
    expect(deps.mutate).toHaveBeenCalledWith('/api/wallet/profiles/feedback', { scenario_id: 'SCEN0000', scope: 'local', authorization_id: 'AUTH-1', filter_id: 'C15', verdict: 'rejected', expected_revision: 7 });
    await controller.feedback(0, 'rejected');
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    const corrected = dashboard('local', 9); corrected.reviews![0]!.verdict = 'confirmed';
    deps.loadDetail.mockResolvedValue(corrected);
    await controller.feedback(0, 'confirmed');
    expect(deps.mutate).toHaveBeenLastCalledWith('/api/wallet/profiles/feedback', { scenario_id: 'SCEN0000', scope: 'local', authorization_id: 'AUTH-1', filter_id: 'C15', verdict: 'confirmed', expected_revision: 8 });
    expect(controller.snapshot().dashboard?.reviews?.[0]?.verdict).toBe('confirmed');
    await controller.feedback(0, 'confirmed');
    expect(deps.mutate).toHaveBeenCalledTimes(2);
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
