/**
 * ESPN AAV PDF adapter (MOD-007).
 * Delegates CPU-bound PDF parsing to espn-pdf-worker.ts via node:worker_threads.
 * Defensive by design: parse errors per page/row are collected, never fatal.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PlayerAdapter, AdapterResult, ImportSource } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH_JS = join(__dirname, '../espn-pdf-worker.js');
const WORKER_PATH_TS = join(__dirname, '../espn-pdf-worker.ts');

export class EspnPdfAdapter implements PlayerAdapter {
  readonly source: ImportSource = 'ESPN_PDF';

  parse(input: Buffer | Record<string, unknown>): Promise<AdapterResult> {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
    return new Promise((resolve, reject) => {
      const jsExists = existsSync(WORKER_PATH_JS);
      const workerScript = jsExists ? WORKER_PATH_JS : WORKER_PATH_TS;
      const worker = new Worker(workerScript, {
        workerData: { pdfBuffer: buf },
        execArgv: workerScript.endsWith('.ts') ? ['--import', 'tsx/esm'] : [],
      });
      worker.on('message', (result: AdapterResult) => resolve(result));
      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`ESPN PDF worker exited with code ${code}`));
      });
    });
  }
}
