import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPurchaseScenarioRegressions } from '../../../packages/local-runtime/src/simulation/scenario-regressions.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = runPurchaseScenarioRegressions();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
