import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HabitFilterId } from '../../../packages/contracts/src/behavior.js';
import { FEATURE_NAMES, ML_FEATURE_VERSION, type MLExample } from '../../../packages/contracts/src/behavior-ml.js';
import { BEHAVIOR_ML_MINIMUM_PER_CLASS, evaluateBehaviorMLProgressively, trainBehaviorML } from '../../../packages/local-runtime/src/learning/behavior-ml-model.js';

const FILTERS = ['C15', 'C18', 'C19'] as const satisfies readonly HabitFilterId[];
const DAY = 86_400_000;
const PER_FILTER = 120;
const START = Date.parse('2026-01-01T10:00:00.000Z');
const GENERATOR = 'synthetic-behavior-ml-v1';

/** Fixed integer PRNG: no clock, random runtime seed, data pack or user state. */
function randomSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4_294_967_296; };
}

/** Authored, overlapping preferences, generated independently of model outputs.
 * These are functional examples of explicit context feedback, not fraud labels. */
export function syntheticBehaviorMLExamples(): MLExample[] {
  return FILTERS.flatMap((filter_id, filterIndex) => {
    const random = randomSequence(46021 + filterIndex * 104729);
    return Array.from({ length: PER_FILTER }, (_, index): MLExample => {
      const predicted = START + Math.floor(index / 8) * DAY;
      const days = Math.floor(random() * 25), recency = random(), effective = days * (1 - recency) * 0.7;
      const hour = random() * 24, angle = 2 * Math.PI * hour / 24;
      const contextFrequency = random(), categoryFrequency = random(), amountRatio = 2 * random() - 1;
      const weekend = Number([0, 6].includes(new Date(predicted).getUTCDay()));
      const novelty = (1 - contextFrequency) * (1 - categoryFrequency);
      const features = Object.freeze([
        Math.log1p(days) / Math.log(31), Math.log1p(effective) / Math.log(31), recency, Number(days === 0),
        Math.sin(angle), Math.cos(angle), weekend, contextFrequency, categoryFrequency,
        amountRatio, novelty, Number(days >= 3 && effective >= 2),
      ]);
      // A separate authored preference process. Bernoulli sampling creates
      // overlap; the nonlinear amount term is deliberately imperfect for logit.
      const filterEffect = filter_id === 'C15' ? 0.6 * contextFrequency
        : filter_id === 'C18' ? 0.5 * Math.cos(angle) - 0.2 * weekend
          : 0.6 * categoryFrequency - 0.3 * amountRatio;
      const latentPreference = -0.4 + 1.2 * features[0]! + 0.7 * contextFrequency - 1.1 * recency
        - 0.8 * Number(days === 0) + 0.35 * categoryFrequency - 0.8 * Math.abs(amountRatio) - novelty + filterEffect;
      const propensity = 1 / (1 + Math.exp(-latentPreference));
      const label = (random() < propensity ? 1 : 0) as 0 | 1;
      // Some feedback arrives after the next prediction group, so an evaluator
      // cannot just train on all prior purchase timestamps.
      const delay = (0.5 + random() * 48) * 3_600_000;
      return {
        id: `${GENERATOR}:${filter_id}:${String(index).padStart(3, '0')}`,
        customer_id: 'SYNTHETIC_ML_CUSTOMER', scope: 'local', filter_id,
        predicted_at: new Date(predicted).toISOString(), label_at: new Date(predicted + delay).toISOString(),
        features, label,
      };
    });
  });
}

/** A reproducible demonstration of fitting actual coefficients and strictly
 * chronological scoring. Nothing is activated or written into runtime state. */
export function runSyntheticBehaviorML() {
  const examples = syntheticBehaviorMLExamples();
  const asOf = '2026-02-01T00:00:00.000Z';
  return {
    schema_version: 1,
    provenance: {
      kind: 'synthetic_only', generator: GENERATOR,
      description: 'Entirely authored feature vectors and stochastic-but-seeded context preferences, with overlapping classes and delayed feedback. No official scenario name or decision is used as a correctness label.',
      no_user_data_read: true, no_runtime_state_written: true,
      examples: examples.length, examples_per_filter: PER_FILTER,
      data_fingerprint: createHash('sha256').update(JSON.stringify(examples)).digest('hex'),
    },
    mode: 'shadow', decision_influence: false, feature_version: ML_FEATURE_VERSION, feature_names: FEATURE_NAMES,
    training: {
      algorithm: 'regularized logistic regression, independent model per filter',
      as_of: asOf, minimum_distinct_examples_per_class: BEHAVIOR_ML_MINIMUM_PER_CLASS,
      minimum_is_engineering_gate_only: true, automatic_activation_allowed: false,
    },
    chronology: {
      prediction_groups_per_filter: 15, cases_per_group: 8,
      feedback_delay: 'Seeded 30 minutes to less than 48.5 hours after prediction.',
      evaluation: 'Each prediction group is scored using only labels acquired strictly before that group. Brier and log loss divide by scored cases; initial cases without sufficient prior feedback are excluded from that denominator and counted separately.',
      current_model: 'The reported coefficients fit all feedback available at as_of. They are not the coefficients used for every historical progressive prediction.',
    },
    models: FILTERS.map(filterId => {
      const options = { filterId, scope: 'local' as const, asOf };
      const model = trainBehaviorML(examples, options), metrics = evaluateBehaviorMLProgressively(examples, options);
      return { ...model, coefficient_names: FEATURE_NAMES, metrics };
    }),
    limitations: [
      'These synthetic metrics demonstrate the implementation; they do not estimate real-world customer accuracy or fraud detection.',
      'A logistic score is an uncalibrated estimate of explicit context confirmation, never a safety or fraud probability.',
      'Training labels come from an authored process with noise, not from the fitted model or a payment decision.',
      'No benchmark, population guarantee, automatic threshold selection or activation follows from this report.',
    ],
  };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1]?.trim())) throw Error('Usage: offline:ml-evaluate [--output PATH]');
  const json = JSON.stringify(runSyntheticBehaviorML(), null, 2) + '\n';
  if (args[1]) { const path = resolve(args[1]); await writeFile(path, json, 'utf8'); console.log(`Synthetic ML report written to ${path}`); }
  else process.stdout.write(json);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
