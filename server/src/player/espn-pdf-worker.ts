/**
 * ESPN AAV PDF parsing worker — runs in a node:worker_threads Worker.
 * Receives PDF bytes via workerData.pdfBuffer.
 * Posts { rows, errors } back to the parent thread.
 *
 * Uses pdfjs-dist for text extraction. Parsing is defensive: per-page errors
 * are logged but do not abort the rest of the import.
 *
 * Expected text format per line (flexible):
 *   "Patrick Mahomes QB KC 12500"
 *   "Patrick Mahomes QB KC $12,500"
 *   Any line with: Name  Position  Team  Dollar-Amount
 */
import { workerData, parentPort } from 'node:worker_threads';

interface ParsedRow {
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number;
  projected_points: number | null;
  tier: number | null;
  espn_player_id: string | null;
}

interface ParseError {
  row: number;
  message: string;
}

interface WorkerResult {
  rows: ParsedRow[];
  errors: ParseError[];
}

const VALID_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'D/ST', 'DST', 'PK'];

/**
 * Try to parse a text line as an ESPN player AAV entry.
 * Returns null if the line doesn't match the expected pattern.
 */
function parseEspnLine(line: string): ParsedRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const pos of VALID_POSITIONS) {
    // Match: "Name words  POS  TEAM  $amount" (dollar sign + commas optional)
    const escapedPos = pos.replace('/', '\\/');
    const regex = new RegExp(`^(.+?)\\s+${escapedPos}\\s+(\\w{1,4})\\s+\\$?([\\d,]+)\\s*$`, 'i');
    const match = regex.exec(trimmed);
    if (match) {
      const name = match[1]!.trim();
      const team = match[2]!.trim().toUpperCase();
      const aavStr = match[3]!.replace(/,/g, '');
      const aav = parseInt(aavStr, 10);

      if (!isNaN(aav) && aav >= 0 && name.length > 0) {
        const normalPos = pos === 'D/ST' || pos === 'DST' ? 'DEF' : pos.toUpperCase();
        return {
          name,
          position: normalPos,
          nfl_team: team,
          aav_minor: aav,
          projected_points: null,
          tier: null,
          espn_player_id: null,
        };
      }
    }
  }
  return null;
}

async function run(): Promise<void> {
  const rawBuffer: Buffer | number[] = workerData.pdfBuffer as Buffer | number[];
  const pdfBuffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];

  // Dynamic import so pdfjs-dist is loaded after GlobalWorkerOptions can be set
  let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Disable pdfjs's own web-worker — we are already in a worker thread.
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  } catch (importErr) {
    errors.push({ row: 0, message: `Failed to load PDF parser: ${String(importErr)}` });
    parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
    return;
  }

  let pdfDoc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
  try {
    const data = new Uint8Array(pdfBuffer);
    // pdfjs-dist auto-disables its worker when it detects a Node.js environment
    // (see PDFWorker's static init block) — no explicit option needed or supported.
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  } catch (parseErr) {
    // Defensive: PDF failed to parse at all — return errors, not a 500.
    errors.push({ row: 0, message: `Failed to parse PDF: ${String(parseErr)}` });
    parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
    return;
  }

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();
      const lineText = (content.items as Array<{ str: string }>)
        .map((item) => item.str)
        .join(' ');

      // Split on likely line breaks (runs of spaces / vertical tabs)
      const lines = lineText.split(/\s{3,}|\t|\n|\r/).filter((l) => l.trim().length > 3);
      for (const line of lines) {
        const parsed = parseEspnLine(line);
        if (parsed) rows.push(parsed);
        // Non-matching lines are silently ignored — not every text fragment is a player
      }
    } catch (pageErr) {
      errors.push({ row: pageNum, message: `Page ${pageNum} error: ${String(pageErr)}` });
    }
  }

  parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
}

run().catch((fatalErr) => {
  parentPort?.postMessage({
    rows: [],
    errors: [{ row: 0, message: `Worker fatal error: ${String(fatalErr)}` }],
  } satisfies WorkerResult);
});
