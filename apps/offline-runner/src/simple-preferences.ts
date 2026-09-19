import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BehaviorJournal } from '../../../packages/contracts/src/behavior-dashboard.js';
import type { HabitFilterId } from '../../../packages/contracts/src/behavior.js';
import type { MLDataset } from '../../../packages/local-runtime/src/learning/behavior-ml-projection.js';
import { projectSimplePreferences } from '../../../packages/local-runtime/src/learning/simple-preferences.js';

/** Authored examples only: no files, historical data or runtime state are read. */
export function runSimplePreferencesDemo() {
  const dataset: MLDataset = { records: [], examples: [], excluded_legacy_assessments: 0, excluded_controlled: 0, unknown: 0 };
  const add = (filter_id: HabitFilterId, context_key: string, confirmed: number, rejected: number) => {
    for (let index = 0; index < Math.max(1, confirmed + rejected); index++) {
      const source_id = `SYNTHETIC_SIMPLE:${filter_id}:${context_key}:${index}`;
      dataset.records.push({ customer_id: 'SYNTHETIC_CUSTOMER', scope: 'local', authorization_id: source_id,
        snapshot: { schema_version: 1, feature_version: 'behavior-context-v2', predicted_at: '2026-09-17T10:00:00Z', filter_id, context_key, features: [], source_id, was_suppressed: false, eligible: true, knowledge_sequence: 0 } });
      if (confirmed + rejected) dataset.examples.push({ id: source_id, customer_id: 'SYNTHETIC_CUSTOMER', scope: 'local', filter_id, predicted_at: '2026-09-17T10:00:00Z', label_at: '2026-09-18T10:00:00Z', features: [], label: index < confirmed ? 1 : 0 });
    }
  };
  add('C15', 'personal-device', 10, 0);
  add('C19', 'CH', 8, 2);
  add('C18', 'Europe/Zurich|weekday|20-24', 2, 1);
  add('C15', 'new-device-without-feedback', 0, 0);
  const now = '2026-09-19T12:00:00Z';
  const journal: BehaviorJournal = { schema_version: 1, sequence: 1, observations: [], controls: [
    { sequence: 1, customer_id: 'SYNTHETIC_CUSTOMER', scope: 'local', filter_id: 'C18', context_key: 'Europe/Zurich|weekday|20-24', action: 'suspend', at: now, actor_id: 'SYNTHETIC_OWNER' },
  ] };
  return {
    provenance: 'synthetic_only', no_user_data_read: true, no_runtime_state_written: true, decision_influence: false,
    examples: ['10 confirmations, 0 rejections → 11/12.', '8 confirmations, 2 rejections → 9/12.', 'Suspended context → counts retained, no score.', 'Missing feedback → no score, not an assumed confirmation.'],
    dashboard: projectSimplePreferences(dataset, journal, 'SYNTHETIC_CUSTOMER', 'local', now),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(runSimplePreferencesDemo(), null, 2) + '\n');
}
