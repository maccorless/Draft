/**
 * CSV adapter (MOD-007) — wraps the Phase 2a csv-worker.ts for interface compliance.
 *
 * The actual parsing logic lives in csv-worker.ts (MOD-001). This file exists
 * so CsvAdapter implements PlayerAdapter alongside the three new adapters.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PlayerAdapter, AdapterResult, ImportSource } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH_JS = join(__dirname, '../csv-worker.js');
const WORKER_PATH_TS = join(__dirname, '../csv-worker.ts');

export class CsvAdapter implements PlayerAdapter {
  readonly source: ImportSource = 'CSV';

  parse(input: Buffer | Record<string, unknown>): Promise<AdapterResult> {
    const csvContent = Buffer.isBuffer(input) ? input.toString('utf-8') : String(input);
    return new Promise((resolve, reject) => {
      const jsExists = existsSync(WORKER_PATH_JS);
      const workerScript = jsExists ? WORKER_PATH_JS : WORKER_PATH_TS;
      const worker = new Worker(workerScript, {
        workerData: { csvContent },
        execArgv: workerScript.endsWith('.ts') ? ['--import', 'tsx/esm'] : [],
      });
      worker.on('message', (result: AdapterResult) => resolve(result));
      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`CSV worker exited with code ${code}`));
      });
    });
  }
}
