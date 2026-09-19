import type { BehaviorHabit, BehaviorScope, HabitFilterId } from '../../../packages/contracts/src/behavior.js';
import type { BehaviorControlRequest, BehaviorFeedbackRequest, BehaviorProfileDashboard, BehaviorProfileOption } from '../../../packages/contracts/src/behavior-dashboard.js';

export type HabitStatus = 'learned' | 'learning' | 'forgotten' | 'suspended';
export type ProfileSavedMutation = { path: string; body: BehaviorControlRequest | BehaviorFeedbackRequest };
export type ProfileViewState = {
  options: BehaviorProfileOption[];
  scenarioId: string;
  scope: BehaviorScope;
  dashboard: BehaviorProfileDashboard | null;
  loading: boolean;
  mutating: boolean;
  initialized: boolean;
  error: string | null;
  recovery: ProfileSavedMutation | null;
  recoveryInvalid: boolean;
};
type Parameters = { min_distinct_days: number; min_effective_count: number; half_life_days: number; window_days: number };
const groups: Array<{ id: HabitFilterId; title: string; description: string }> = [
  { id: 'C15', title: 'Recognized devices', description: 'Devices you explicitly confirmed using.' },
  { id: 'C18', title: 'Usual purchase times', description: 'Weekday or weekend patterns, in four-hour windows.' },
  { id: 'C19', title: 'Merchant countries', description: 'Merchant locations you confirmed shopping from.' },
];
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const number = (value: number): string => new Intl.NumberFormat('en-CH', { maximumFractionDigits: 2 }).format(value);
const date = (value: string, timezone: string): string => {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return 'Date unavailable'; }
};

export function habitStatus(habit: BehaviorHabit): HabitStatus {
  const status = (habit as BehaviorHabit & { status?: HabitStatus }).status;
  return status === 'forgotten' || status === 'suspended' ? status : habit.learned ? 'learned' : 'learning';
}

export function habitControlActions(habit: BehaviorHabit): BehaviorControlRequest['action'][] {
  const status = habitStatus(habit);
  return status === 'suspended' ? ['resume', 'forget'] : status === 'forgotten' ? ['suspend'] : ['suspend', 'forget'];
}

function contextLabel(habit: BehaviorHabit): string {
  if (habit.filter_id !== 'C18') return habit.context_key;
  const [timezone, kind, window] = habit.context_key.split('|');
  return timezone && ['weekday', 'weekend'].includes(kind ?? '') && /^\d+-\d+$/.test(window ?? '')
    ? `${kind === 'weekday' ? 'Weekdays' : 'Weekends'} · ${window!.replace('-', '–')} h · ${timezone}`
    : habit.context_key;
}

function meter(label: string, value: number, threshold: number, id: string): string {
  const max = Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
  const measured = Number.isFinite(value) && value > 0 ? value : 0;
  return `<div class="profile-evidence"><div><label id="${id}" for="${id}-meter">${esc(label)}</label><strong>${esc(number(measured))} / ${esc(number(max))}</strong></div><meter id="${id}-meter" min="0" max="${max}" value="${Math.min(measured, max)}" aria-labelledby="${id}" aria-valuetext="${esc(`${number(measured)} of ${number(max)} required ${label.toLowerCase()}`)}">${esc(number(measured))} of ${esc(number(max))}</meter></div>`;
}

function renderHabit(habit: BehaviorHabit, index: number, dashboard: BehaviorProfileDashboard, disabled: boolean): string {
  const status = habitStatus(habit);
  const profile = dashboard.profile as typeof dashboard.profile & { parameters?: Partial<Record<HabitFilterId, Parameters>> };
  const parameters = profile.parameters?.[habit.filter_id];
  const explanations: Record<HabitStatus, string> = {
    learned: 'This context can satisfy its behavior check when learning is enabled. All spending permissions still apply.',
    learning: 'More evidence is needed before this context can satisfy its behavior check.',
    forgotten: 'Previous evidence no longer counts. Only new confirmed purchases can teach this context again.',
    suspended: 'This context is not used or taught while suspended. Resume starts fresh; previous evidence is not restored.',
  };
  const names = { forget: 'Forget', suspend: 'Suspend', resume: 'Resume from scratch' };
  return `<article class="profile-habit" data-habit-index="${index}" aria-label="${esc(`${groups.find(g => g.id === habit.filter_id)!.title}: ${contextLabel(habit)}`)}"><header><h3>${esc(contextLabel(habit))}</h3><span class="profile-state profile-state--${status}">${status[0]!.toUpperCase() + status.slice(1)}</span></header><p class="profile-habit__explanation">${explanations[status]}</p><div class="profile-evidence-grid">${parameters ? meter('Distinct days', habit.distinct_days, parameters.min_distinct_days, `habit-${index}-days`) + meter('Recent evidence weight', habit.effective_count, parameters.min_effective_count, `habit-${index}-weight`) : `<p>${esc(number(habit.distinct_days))} distinct days · ${esc(number(habit.effective_count))} recent evidence weight. Thresholds are unavailable for this snapshot.</p>`}</div><p class="profile-habit__meta">${esc(number(habit.confirmations))} confirmations · Last confirmed: ${habit.last_confirmed_at ? `<time datetime="${esc(habit.last_confirmed_at)}">${esc(date(habit.last_confirmed_at, dashboard.profile.timezone))}</time>` : 'None in the current learning period'}</p>${parameters ? `<p class="profile-habit__meta">Evidence window: ${esc(number(parameters.window_days))} days · Evidence weight halves every ${esc(number(parameters.half_life_days))} days.</p>` : ''}<div class="profile-habit__actions">${habitControlActions(habit).map(action => `<button type="button" class="button button--secondary" id="habit-${index}-${action}" data-profile-action="${action}" data-habit-index="${index}" ${disabled ? 'disabled' : ''}>${names[action]}</button>`).join('')}</div><p class="profile-control-help">${status === 'suspended' ? 'Resume permits new learning; it does not reinstate earlier confirmations.' : 'Suspend pauses use and new learning. Forget resets the evidence; the decision audit stays available.'}</p></article>`;
}

export function renderLearnedDecisionReviews(dashboard: BehaviorProfileDashboard, disabled: boolean): string {
  const reviews = dashboard.reviews ?? [];
  return `<section class="profile-decision-reviews" aria-labelledby="profile-reviews-heading"><div class="profile-section-heading"><h2 id="profile-reviews-heading">Review learned decisions</h2><p>Tell us whether a learned context was appropriate for a recent approved purchase. Your answer measures the decision; it does not count as a new learning confirmation.</p></div>${reviews.length ? `<div class="profile-review-list">${reviews.map((review, index) => `<article class="profile-decision-review"><div><h3>${esc(groups.find(group => group.id === review.filter_id)?.title ?? review.filter_id)} · ${esc(review.context_key)}</h3><p><time datetime="${esc(review.occurred_at)}">${esc(date(review.occurred_at, dashboard.profile.timezone))}</time> · Purchase ${esc(review.authorization_id)}</p></div>${review.verdict ? `<p class="profile-review-verdict">${review.verdict === 'confirmed' ? 'You confirmed this context was appropriate.' : 'You marked this context as inappropriate. The habit was suspended.'}</p>` : `<div class="profile-review-actions"><button type="button" class="button button--secondary" id="profile-review-${index}-confirmed" data-review-index="${index}" data-profile-feedback="confirmed" ${disabled ? 'disabled' : ''}>This context was appropriate</button><button type="button" class="button button--secondary" id="profile-review-${index}-rejected" data-review-index="${index}" data-profile-feedback="rejected" ${disabled ? 'disabled' : ''}>This context was not appropriate</button></div>`}</article>`).join('')}</div>` : '<p class="profile-empty-context">No learned decisions are available to review in this scope yet.</p>'}<p class="help-text">An inappropriate context suspends that habit. This feedback does not change the completed purchase or its confirmed spending permissions.</p></section>`;
}

export function renderBehaviorProfileDashboard(dashboard: BehaviorProfileDashboard, controlsDisabled = false): string {
  const metrics = dashboard.metrics;
  return `<div class="profile-dashboard"><section class="profile-summary" aria-labelledby="profile-summary-heading"><div><p class="eyebrow">Your confirmed habits</p><h2 id="profile-summary-heading">${esc(dashboard.customer_id)}</h2><p>Evaluated at simulated purchase time <time datetime="${esc(dashboard.profile.as_of)}">${esc(date(dashboard.profile.as_of, dashboard.profile.timezone))}</time> · ${esc(dashboard.profile.timezone)}</p></div><span class="profile-scope">${dashboard.scope === 'local' ? 'Local simulation' : 'Viseca simulator'}</span></section>${dashboard.notice ? `<p class="profile-notice">${esc(dashboard.notice)}</p>` : ''}${dashboard.profile.warning ? `<p class="notice notice--warning" role="status">${esc(dashboard.profile.warning)}</p>` : ''}<section class="profile-impact" aria-labelledby="profile-impact-heading"><div class="profile-section-heading"><h2 id="profile-impact-heading">What learning changed</h2><p>Counts describe decisions in this scope. They are not fraud-detection accuracy.</p></div><dl class="profile-metrics"><div><dt>Purchases compared</dt><dd>${esc(number(metrics.evaluations))}</dd></div><div><dt>Behavior alerts suppressed</dt><dd>${esc(number(metrics.alerts_avoided))}</dd></div><div><dt>Purchase interruptions avoided</dt><dd>${esc(number(metrics.interruptions_avoided))}</dd></div></dl><p class="help-text">A suppressed behavior alert may still leave other checks requiring your confirmation.</p><div class="profile-outcomes" aria-label="Evidence about suppressed alerts"><span><strong>${esc(number(metrics.verified_suppressions))}</strong> verified</span><span><strong>${esc(number(metrics.contradicted_suppressions))}</strong> contradicted</span><span><strong>${esc(number(metrics.unknown_suppressions))}</strong> unknown</span></div><p class="help-text">Unknown outcomes are not successful predictions. Verification describes available feedback, not proof that a purchase was fraud-free.</p></section>${renderLearnedDecisionReviews(dashboard, controlsDisabled)}<section class="profile-permissions" aria-labelledby="profile-permissions-heading"><div class="profile-section-heading"><h2 id="profile-permissions-heading">Explicit spending permissions</h2><p>Confirmed permissions for each saved run. Learned habits do not change these limits.</p></div>${dashboard.permissions.length ? dashboard.permissions.map((permission, index) => `<details class="profile-permission-run" ${dashboard.permissions.length === 1 ? 'open' : ''}><summary><span>Run ${index + 1} · ${esc(permission.run_id)}</span><span>${esc((permission as typeof permission & { status?: string }).status ?? 'Saved')} · Learning ${permission.learning_enabled ? 'enabled' : 'off'}</span></summary><p class="profile-habit__meta">Mandate ${esc(permission.mandate_id)}</p><dl class="profile-permission-list">${permission.items.map(item => `<div><dt>${esc(item.label)}</dt><dd><strong>${esc(item.value)}</strong>${item.description ? `<p>${esc(item.description)}</p>` : ''}</dd></div>`).join('')}</dl></details>`).join('') : '<div class="profile-empty"><h3>No saved permissions in this scope</h3><p>Review a permission draft and choose whether to enable learning before starting a run.</p></div>'}<a class="profile-inline-link" href="/wallet/new?scenario_id=${encodeURIComponent(dashboard.scenario_id)}">Review a new permission draft →</a></section><section class="profile-habits" aria-labelledby="profile-habits-heading"><div class="profile-section-heading"><h2 id="profile-habits-heading">Learned behavior</h2><p>Progress reflects confirmed evidence, not a security percentage. Each context needs both enough distinct days and enough recent evidence.</p></div>${groups.map(group => { const habits = dashboard.profile.habits.map((habit, index) => ({ habit, index })).filter(item => item.habit.filter_id === group.id); return `<section class="profile-habit-group" aria-labelledby="profile-group-${group.id}"><div class="profile-group-heading"><h3 id="profile-group-${group.id}">${group.title}</h3><p>${group.description}</p></div>${habits.length ? `<div class="profile-habit-list">${habits.map(({ habit, index }) => renderHabit(habit, index, dashboard, controlsDisabled)).join('')}</div>` : `<p class="profile-empty-context">No confirmed ${group.id === 'C15' ? 'device' : group.id === 'C18' ? 'purchase-time' : 'merchant-country'} habits in this scope yet.</p>`}</section>`; }).join('')}</section><footer class="profile-snapshot"><details><summary>Profile snapshot details</summary><dl><div><dt>Version</dt><dd class="mono">${esc(dashboard.profile.version)}</dd></div><div><dt>Revision</dt><dd>${esc(dashboard.revision)}</dd></div><div><dt>Scope</dt><dd>${esc(dashboard.scope)}</dd></div></dl></details></footer></div>`;
}

export function renderBehaviorProfilesPage(state: ProfileViewState, fixedScope = false): string {
  const pending = state.recovery;
  const disabled = state.loading || state.mutating || !!pending || state.recoveryInvalid;
  return `<div class="wallet-flow profiles-page"><a class="back-link" href="/">← Wallet home</a><header class="page-header"><p class="eyebrow">Your preferences, over time</p><h1>Your profiles</h1><p>Review the habits you confirmed and control what the wallet remembers.</p></header><section class="profile-picker" aria-label="Choose a synthetic customer profile"><div><label for="profile-scenario">Synthetic customer / scenario</label><select id="profile-scenario" ${state.mutating || !state.options.length ? 'disabled' : ''}>${state.options.map(option => `<option value="${esc(option.scenario_id)}" ${option.scenario_id === state.scenarioId ? 'selected' : ''}>${esc(option.customer_id)} · ${esc(option.scenario_name)} (${esc(option.scenario_id)})</option>`).join('')}</select></div><div><label for="profile-scope">Activity scope</label><select id="profile-scope" ${state.mutating || fixedScope ? 'disabled' : ''}><option value="local" ${state.scope === 'local' ? 'selected' : ''}>Local simulation</option><option value="live" ${state.scope === 'live' ? 'selected' : ''}>Viseca simulator</option></select></div><button type="button" class="button button--secondary" id="refresh-profiles" ${state.loading || state.mutating ? 'disabled' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button></section><p class="profile-scope-help">Offline and online histories stay separate. Use the switch in the header to change data source. Learning is enabled only through your confirmed spending permissions.</p><div id="profile-page-status" role="status" tabindex="-1">${state.error ? `<p class="notice notice--warning">${esc(state.error)}</p>` : ''}${state.mutating ? '<p>Saving your profile preference…</p>' : ''}</div>${pending ? `<section class="profile-recovery" aria-label="Unresolved profile request"><p>A saved ${esc('action' in pending.body ? pending.body.action : 'feedback')} request for ${esc(pending.body.scenario_id)} (${esc(pending.body.scope)}) still needs its result. Retry that exact request before changing another habit.</p><button type="button" class="button button--secondary" id="retry-profile-control" ${state.mutating ? 'disabled' : ''}>Retry saved request</button></section>` : ''}${state.dashboard ? renderBehaviorProfileDashboard(state.dashboard, disabled) : state.loading || !state.initialized ? '<div class="profile-empty" role="status"><h2>Loading this profile…</h2><p>Reading confirmed permissions and recorded feedback.</p></div>' : !state.options.length ? '<div class="profile-empty"><h2>No synthetic profiles available</h2><p>Profiles will appear when scenario data is available.</p></div>' : '<div class="profile-empty"><h2>This profile could not be loaded</h2><p>Use Refresh to try again. Your saved permissions and feedback are preserved.</p></div>'}</div>`;
}
