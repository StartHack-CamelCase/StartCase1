import { parentPort, workerData } from 'node:worker_threads';
import { projectBehaviorML } from './behavior-ml-projection.js';

const {dataset,journal,customerId,scope,asOf}=workerData;
parentPort!.postMessage(projectBehaviorML(dataset,journal,customerId,scope,asOf));
parentPort!.close();
