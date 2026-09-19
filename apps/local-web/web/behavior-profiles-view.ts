import type { BehaviorHabit, BehaviorScope, HabitFilterId } from '../../../packages/contracts/src/behavior.js';
import type { BehaviorControlRequest, BehaviorFeedbackRequest, BehaviorProfileDashboard, BehaviorProfileOption } from '../../../packages/contracts/src/behavior-dashboard.js';
import type { BehaviorMLDashboard } from '../../../packages/contracts/src/behavior-ml.js';
import type { SimplePreferencesDashboard } from '../../../packages/contracts/src/simple-preferences.js';

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

function contextLabel(habit: Pick<BehaviorHabit, 'filter_id' | 'context_key'>): string {
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

function renderLearningStatus(dashboard: BehaviorProfileDashboard): string {
  const enabled = dashboard.permissions.filter(permission => permission.learning_enabled).length;
  const title = enabled ? 'How your preferences are used' : 'Habit learning is not enabled in your saved runs';
  const activation = enabled
    ? `Learning was enabled in ${enabled} of ${dashboard.permissions.length} saved runs. Each new run uses the choice in its confirmed permissions.`
    : 'To start, open a new permission draft, switch to JSON, check “Learn my confirmed habits”, confirm the permissions, then complete purchases. Earlier runs with learning off do not become learning evidence.';
  return `<section class="profile-learning-status" aria-labelledby="profile-learning-status-heading"><div class="profile-section-heading"><h2 id="profile-learning-status-heading">${title}</h2><p>${activation}</p></div><p>Answers in “Review behavioral contexts” update your preference score. Confirmations given during purchases teach the habits shown in “Learned behavior”, after the purchase is approved.</p><p>Only a learned habit can avoid a future behavior alert, when learning is enabled for that run. The required distinct days and recent evidence appear below. Replaying the same purchase does not add evidence.</p>${!enabled ? `<a class="profile-inline-link" href="/wallet/new?scenario_id=${encodeURIComponent(dashboard.scenario_id)}">Set up habit learning →</a>` : ''}</section>`;
}

export function renderLearnedDecisionReviews(dashboard: BehaviorProfileDashboard, disabled: boolean): string {
  const reviews = dashboard.reviews ?? [];
  const cards = reviews.map((review, index) => {
    const suspended = dashboard.profile.habits.some(habit => habit.filter_id === review.filter_id && habit.context_key === review.context_key && habitStatus(habit) === 'suspended');
    const choices = (['confirmed', 'rejected'] as const).filter(verdict => verdict !== review.verdict);
    return `<article class="profile-decision-review"><div><h3>${esc(groups.find(group => group.id === review.filter_id)?.title ?? review.filter_id)} · ${esc(contextLabel(review))}</h3><p><time datetime="${esc(review.occurred_at)}">${esc(date(review.occurred_at, dashboard.profile.timezone))}</time> · Purchase ${esc(review.authorization_id)}</p>${typeof review.was_suppressed === 'boolean' ? `<p class="profile-review-origin">${review.was_suppressed ? 'Alert suppressed by a learned habit' : 'Behavioral alert was not suppressed'}</p>` : ''}</div>${review.verdict ? `<p class="profile-review-verdict">${review.verdict === 'confirmed' ? 'You confirmed this context was appropriate.' : 'You marked this context as inappropriate. The habit was suspended.'}</p>` : ''}<div class="profile-review-actions">${choices.map(verdict => `<button type="button" class="button button--secondary" id="profile-review-${index}-${verdict}" data-review-index="${index}" data-profile-feedback="${verdict}" ${disabled ? 'disabled' : ''}>${review.verdict ? (verdict === 'confirmed' ? 'Change to appropriate' : 'Change to inappropriate') : (verdict === 'confirmed' ? 'This context was appropriate' : 'This context was not appropriate')}</button>`).join('')}</div>${review.verdict ? `<p class="help-text">A correction replaces your previous answer; it does not add another purchase.${suspended ? ' This habit remains suspended. Use “Resume from scratch” below to allow new learning.' : ''}</p>` : ''}</article>`;
  }).join('');
  return `<section class="profile-decision-reviews" aria-labelledby="profile-reviews-heading"><div class="profile-section-heading"><h2 id="profile-reviews-heading">Review behavioral contexts</h2><p>Tell us whether a behavioral context was appropriate for a recent purchase, including contexts that raised an alert. Your answer updates the preference for this context; it does not count as a new learning confirmation.</p></div>${cards ? `<div class="profile-review-list">${cards}</div>` : '<p class="profile-empty-context">No behavioral contexts are available to review in this scope yet.</p>'}<p class="help-text">An inappropriate context suspends that habit. This feedback does not change the purchase decision or its confirmed spending permissions. A context label is not proof that a purchase was fraud-free.</p></section>`;
}

const validCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const count = (value: number): string => validCount(value) ? esc(number(value)) : 'Unavailable';
const decimal = (value: number): string => new Intl.NumberFormat('en-CH', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);

export function renderSimplePreferences(preferences: SimplePreferencesDashboard | undefined): string {
  if (!preferences) return '';
  const statusLabels = { no_feedback: 'No feedback', learning: 'Learning', suspended: 'Suspended', forgotten: 'Forgotten' };
  const explanations = {
    no_feedback: 'Learning starts after your first explicit feedback.',
    learning: 'Score unavailable for this snapshot.',
    suspended: 'No score while this context is suspended.',
    forgotten: 'Previous feedback no longer counts. New feedback starts a fresh score.',
  };
  const contexts = preferences.contexts.map(context => {
    const validEvidence = validCount(context.confirmed) && validCount(context.rejected) && validCount(context.samples)
      && context.samples > 0 && context.confirmed + context.rejected === context.samples && Number.isSafeInteger(context.samples + 2);
    const expectedScore = validEvidence ? (context.confirmed + 1) / (context.samples + 2) : null;
    const scored = context.status === 'learning' && expectedScore !== null && typeof context.score === 'number'
      && Number.isFinite(context.score) && context.score >= 0 && context.score <= 1 && Math.abs(context.score - expectedScore) < 1e-9;
    const scoreText = scored ? decimal(context.score!) : '';
    const equals = scored && Math.abs(Number(scoreText) - context.score!) < 1e-12 ? '=' : '≈';
    return `<article class="profile-preference"><header><div><p>${esc(groups.find(group => group.id === context.filter_id)?.title ?? context.filter_id)}</p><h3>${esc(contextLabel(context))}</h3></div><span class="profile-preference-status">${statusLabels[context.status]}</span></header><dl class="profile-preference-counts"><div><dt>Yes · appropriate</dt><dd>${count(context.confirmed)}</dd></div><div><dt>No · inappropriate</dt><dd>${count(context.rejected)}</dd></div></dl>${scored ? `<p class="profile-preference-score"><span>Preference score</span><strong>${count(context.confirmed + 1)} / ${count(context.samples + 2)} ${equals} ${esc(scoreText)}</strong></p>` : `<p class="profile-preference-empty">${explanations[context.status]}</p>`}${context.reason ? `<p class="profile-preference-reason">${esc(context.reason)}</p>` : ''}</article>`;
  }).join('');
  return `<section class="profile-simple-learning" aria-labelledby="profile-simple-heading"><div class="profile-section-heading"><h2 id="profile-simple-heading">Simple learning</h2><p>More confirmations raise a preference score; rejections lower it. Payment rules stay unchanged.</p></div><p class="profile-simple-formula"><span>Preference score</span><code>(confirmations + 1) / (confirmations + rejections + 2)</code></p><p class="profile-simple-explanation">The two starting counts keep a few answers from producing an extreme score. This describes your preference for an exact context, not a fraud probability.</p><p class="profile-simple-totals">${count(preferences.totals.confirmed)} confirmations · ${count(preferences.totals.rejected)} rejections · ${count(preferences.totals.contexts)} contexts</p>${contexts ? `<div class="profile-preference-list">${contexts}</div>` : '<p class="profile-empty-context">No feedback yet. Learning starts after your first explicit feedback on a behavioral context.</p>'}${preferences.notice ? `<p class="profile-simple-notice">${esc(preferences.notice)}</p>` : ''}</section>`;
}

function renderModelMetrics(metrics: BehaviorMLDashboard['models'][number]['metrics']): string {
  const hasDenominator = validCount(metrics.scored) && metrics.scored > 0;
  const coverage = validCount(metrics.scored) && validCount(metrics.total) && metrics.scored <= metrics.total
    ? `${count(metrics.scored)} of ${count(metrics.total)} labelled examples scored.` : 'Evaluation coverage unavailable.';
  const brier = hasDenominator && typeof metrics.brier === 'number' && Number.isFinite(metrics.brier) && metrics.brier >= 0 && metrics.brier <= 1;
  const logLoss = hasDenominator && typeof metrics.log_loss === 'number' && Number.isFinite(metrics.log_loss) && metrics.log_loss >= 0;
  if (!brier && !logLoss) return `<p class="profile-ml-empty">${coverage} Evaluation unavailable — no usable measured scores yet.</p>`;
  return `<div class="profile-ml-evaluation"><p>Chronological evaluation on the current eligible cohort · <strong>${count(metrics.scored)} scored examples</strong>.</p><p class="profile-ml-caption">${coverage}</p><dl>${brier ? `<div><dt>Brier score</dt><dd>${esc(decimal(metrics.brier!))}</dd></div>` : ''}${logLoss ? `<div><dt>Log loss</dt><dd>${esc(decimal(metrics.log_loss!))}</dd></div>` : ''}</dl><p class="profile-ml-caption">Lower is better. These measure agreement with context feedback, not payment safety.</p></div>`;
}

export function renderBehaviorMachineLearning(learning: BehaviorMLDashboard | undefined): string {
  if (!learning) return '';
  const models = learning.models.map(model => {
    const trained = model.status === 'trained' && !!model.version?.trim();
    return `<article class="profile-ml-model"><header><h3>${esc(groups.find(group => group.id === model.filter_id)?.title ?? model.filter_id)} <span>${esc(model.filter_id)}</span></h3><span class="profile-ml-status">${trained ? 'Trained · shadow only' : 'Insufficient data'}</span></header><dl class="profile-ml-counts"><div><dt>Confirmed labels</dt><dd>${count(model.positive)}</dd></div><div><dt>Rejected labels</dt><dd>${count(model.negative)}</dd></div><div><dt>Accepted training examples</dt><dd>${count(model.samples)}</dd></div><div><dt>Excluded examples</dt><dd>${count(model.excluded)}</dd></div></dl>${trained ? '' : '<p class="profile-ml-empty">No active model. Both confirmed and rejected context labels are needed before training.</p>'}${renderModelMetrics(model.metrics)}${model.version ? `<details class="profile-ml-version"><summary>Model version</summary><p class="mono">${esc(model.version)}</p></details>` : ''}</article>`;
  }).join('');
  const predictions = learning.predictions.map(prediction => {
    const scored = typeof prediction.score === 'number' && Number.isFinite(prediction.score) && prediction.score >= 0 && prediction.score <= 1 && !!prediction.model_version?.trim();
    const feedback = prediction.observed_label === 'confirmed' ? 'Context confirmed appropriate' : prediction.observed_label === 'rejected' ? 'Context rejected as inappropriate' : 'No explicit context feedback';
    return `<li class="profile-ml-prediction"><div><h4>${esc(groups.find(group => group.id === prediction.filter_id)?.title ?? prediction.filter_id)} · ${esc(prediction.context_key)}</h4><p>Purchase ${esc(prediction.authorization_id)}</p></div><dl><div><dt>Uncalibrated confirmation score</dt><dd>${scored ? esc(decimal(prediction.score!)) : 'Not scored'}</dd></div><div><dt>Observed human feedback</dt><dd>${feedback}</dd></div></dl>${!scored ? `<p class="profile-ml-caption">${esc(prediction.abstention_reason || 'No usable model score is available for this context.')}</p>` : ''}</li>`;
  }).join('');
  return `<section class="profile-machine-learning" aria-labelledby="profile-ml-heading"><div class="profile-section-heading"><p class="eyebrow">Observation only</p><h2 id="profile-ml-heading">Shadow machine learning</h2><p>The model observes contexts and explicit feedback. Its scores do not change approvals, declines or confirmation requests.</p></div><p class="profile-ml-disclaimer">Scores are uncalibrated context confirmation scores on a 0–1 scale. They are not safety probabilities. An approved purchase does not automatically become a positive label.</p>${learning.notice ? `<p class="profile-ml-caption">${esc(learning.notice)}</p>` : ''}${models ? `<div class="profile-ml-models">${models}</div>` : '<p class="profile-empty-context">No model data is available for this profile and scope yet.</p>'}<div class="profile-ml-predictions"><h3>Retrospective context scores</h3><p class="profile-ml-caption">These contexts are scored with the current model, not the model available at purchase time. Scores and human feedback are shown separately, including when they disagree.</p>${predictions ? `<ol>${predictions}</ol>` : '<p class="profile-empty-context">No context scores are available in this scope yet. A model needs explicit labels before it can score contexts.</p>'}</div><details class="profile-ml-version"><summary>Feature definition version</summary><p class="mono">${esc(learning.feature_version)}</p></details></section>`;
}

export function renderBehaviorProfileDashboard(dashboard: BehaviorProfileDashboard, controlsDisabled = false): string {
  const metrics = dashboard.metrics;
  return `<div class="profile-dashboard"><section class="profile-summary" aria-labelledby="profile-summary-heading"><div><p class="eyebrow">Your confirmed habits</p><h2 id="profile-summary-heading">${esc(dashboard.customer_id)}</h2><p>Evaluated at simulated purchase time <time datetime="${esc(dashboard.profile.as_of)}">${esc(date(dashboard.profile.as_of, dashboard.profile.timezone))}</time> · ${esc(dashboard.profile.timezone)}</p></div><span class="profile-scope">${dashboard.scope === 'local' ? 'Local simulation' : 'Viseca simulator'}</span></section>${renderLearningStatus(dashboard)}${dashboard.notice ? `<p class="profile-notice">${esc(dashboard.notice)}</p>` : ''}${dashboard.profile.warning ? `<p class="notice notice--warning" role="status">${esc(dashboard.profile.warning)}</p>` : ''}<section class="profile-impact" aria-labelledby="profile-impact-heading"><div class="profile-section-heading"><h2 id="profile-impact-heading">What learning changed</h2><p>Counts describe decisions in this scope. They are not fraud-detection accuracy.</p></div><dl class="profile-metrics"><div><dt>Purchases compared</dt><dd>${esc(number(metrics.evaluations))}</dd></div><div><dt>Behavior alerts suppressed</dt><dd>${esc(number(metrics.alerts_avoided))}</dd></div><div><dt>Purchase interruptions avoided</dt><dd>${esc(number(metrics.interruptions_avoided))}</dd></div></dl><p class="help-text">A suppressed behavior alert may still leave other checks requiring your confirmation.</p><div class="profile-outcomes" aria-label="Evidence about suppressed alerts"><span><strong>${esc(number(metrics.verified_suppressions))}</strong> verified</span><span><strong>${esc(number(metrics.contradicted_suppressions))}</strong> contradicted</span><span><strong>${esc(number(metrics.unknown_suppressions))}</strong> unknown</span></div><p class="help-text">Unknown outcomes are not successful predictions. Verification describes available feedback, not proof that a purchase was fraud-free.</p></section>${renderLearnedDecisionReviews(dashboard, controlsDisabled)}${dashboard.simple_preferences ? renderSimplePreferences(dashboard.simple_preferences) : renderBehaviorMachineLearning(dashboard.machine_learning)}<section class="profile-permissions" aria-labelledby="profile-permissions-heading"><div class="profile-section-heading"><h2 id="profile-permissions-heading">Explicit spending permissions</h2><p>Confirmed permissions for each saved run. Learned habits do not change these limits.</p></div>${dashboard.permissions.length ? dashboard.permissions.map((permission, index) => `<details class="profile-permission-run" ${dashboard.permissions.length === 1 ? 'open' : ''}><summary><span>Run ${index + 1} · ${esc(permission.run_id)}</span><span>${esc((permission as typeof permission & { status?: string }).status ?? 'Saved')} · Learning ${permission.learning_enabled ? 'enabled' : 'off'}</span></summary><p class="profile-habit__meta">Mandate ${esc(permission.mandate_id)}</p><dl class="profile-permission-list">${permission.items.map(item => `<div><dt>${esc(item.label)}</dt><dd><strong>${esc(item.value)}</strong>${item.description ? `<p>${esc(item.description)}</p>` : ''}</dd></div>`).join('')}</dl></details>`).join('') : '<div class="profile-empty"><h3>No saved permissions in this scope</h3><p>Review a permission draft and choose whether to enable learning before starting a run.</p></div>'}<a class="profile-inline-link" href="/wallet/new?scenario_id=${encodeURIComponent(dashboard.scenario_id)}">Review a new permission draft →</a></section><section class="profile-habits" aria-labelledby="profile-habits-heading"><div class="profile-section-heading"><h2 id="profile-habits-heading">Learned behavior</h2><p>Progress reflects confirmed evidence, not a security percentage. Each context needs both enough distinct days and enough recent evidence.</p></div>${groups.map(group => { const habits = dashboard.profile.habits.map((habit, index) => ({ habit, index })).filter(item => item.habit.filter_id === group.id); return `<section class="profile-habit-group" aria-labelledby="profile-group-${group.id}"><div class="profile-group-heading"><h3 id="profile-group-${group.id}">${group.title}</h3><p>${group.description}</p></div>${habits.length ? `<div class="profile-habit-list">${habits.map(({ habit, index }) => renderHabit(habit, index, dashboard, controlsDisabled)).join('')}</div>` : `<p class="profile-empty-context">No confirmed ${group.id === 'C15' ? 'device' : group.id === 'C18' ? 'purchase-time' : 'merchant-country'} habits in this scope yet.</p>`}</section>`; }).join('')}</section><footer class="profile-snapshot"><details><summary>Profile snapshot details</summary><dl><div><dt>Version</dt><dd class="mono">${esc(dashboard.profile.version)}</dd></div><div><dt>Revision</dt><dd>${esc(dashboard.revision)}</dd></div><div><dt>Scope</dt><dd>${esc(dashboard.scope)}</dd></div></dl></details></footer></div>`;
}

export function renderBehaviorProfilesPage(state: ProfileViewState, fixedScope = false): string {
  const pending = state.recovery;
  const disabled = state.loading || state.mutating || !!pending || state.recoveryInvalid;
  return `<div class="wallet-flow profiles-page"><a class="back-link" href="/">← Wallet home</a><header class="page-header"><p class="eyebrow">Your preferences, over time</p><h1>Your profiles</h1><p>Review the habits you confirmed and control what the wallet remembers.</p></header><section class="profile-picker" aria-label="Choose a synthetic customer profile"><div><label for="profile-scenario">Synthetic customer / scenario</label><select id="profile-scenario" ${state.mutating || !state.options.length ? 'disabled' : ''}>${state.options.map(option => `<option value="${esc(option.scenario_id)}" ${option.scenario_id === state.scenarioId ? 'selected' : ''}>${esc(option.customer_id)} · ${esc(option.scenario_name)} (${esc(option.scenario_id)})</option>`).join('')}</select></div><div><label for="profile-scope">Activity scope</label><select id="profile-scope" ${state.mutating || fixedScope ? 'disabled' : ''}><option value="local" ${state.scope === 'local' ? 'selected' : ''}>Local simulation</option><option value="live" ${state.scope === 'live' ? 'selected' : ''}>Viseca simulator</option></select></div><button type="button" class="button button--secondary" id="refresh-profiles" ${state.loading || state.mutating ? 'disabled' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button></section><p class="profile-scope-help">Offline and online histories stay separate. Use the switch in the header to change data source. Learning is enabled only through your confirmed spending permissions.</p><div id="profile-page-status" role="status" tabindex="-1">${state.error ? `<p class="notice notice--warning">${esc(state.error)}</p>` : ''}${state.mutating ? '<p>Saving your profile preference…</p>' : ''}</div>${pending ? `<section class="profile-recovery" aria-label="Unresolved profile request"><p>A saved ${esc('action' in pending.body ? pending.body.action : 'feedback')} request for ${esc(pending.body.scenario_id)} (${esc(pending.body.scope)}) still needs its result. Retry that exact request before changing another habit.</p><button type="button" class="button button--secondary" id="retry-profile-control" ${state.mutating ? 'disabled' : ''}>Retry saved request</button></section>` : ''}${state.dashboard ? renderBehaviorProfileDashboard(state.dashboard, disabled) : state.loading || !state.initialized ? '<div class="profile-empty" role="status"><h2>Loading this profile…</h2><p>Reading confirmed permissions and recorded feedback.</p></div>' : !state.options.length ? '<div class="profile-empty"><h2>No synthetic profiles available</h2><p>Profiles will appear when scenario data is available.</p></div>' : '<div class="profile-empty"><h2>This profile could not be loaded</h2><p>Use Refresh to try again. Your saved permissions and feedback are preserved.</p></div>'}</div>`;
}
