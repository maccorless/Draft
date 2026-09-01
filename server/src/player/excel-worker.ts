/**
 * Excel (XLSX) parsing worker — runs in a node:worker_threads Worker.
 * Receives file bytes via workerData.excelBuffer (Buffer / ArrayBuffer).
 * Posts { rows, errors } back to the parent thread.
 *
 * Uses SheetJS (xlsx) for reading. Column mapping is inferred from headers
 * (case-insensitive); the same field names as the CSV worker are recognised:
 *   name, position, nfl_team, aav_minor, projected_points, tier, espn_player_id
 */
import { workerData, parentPort } from 'node:worker_threads';
import * as XLSX from 'xlsx';

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

function run(): void {
  const raw: Buffer | number[] = workerData.excelBuffer as Buffer | number[];
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];

  let workbook: XLSX.WorkBook;
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    workbook = XLSX.read(buf, { type: 'buffer' });
  } catch (err) {
    errors.push({ row: 0, message: `Failed to parse Excel file: ${String(err)}` });
    parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
    return;
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    errors.push({ row: 0, message: 'Excel file has no sheets' });
    parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
    return;
  }

  const sheet = workbook.Sheets[sheetName]!;
  // Produce array of objects with header keys
  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

  if (rawRows.length === 0) {
    errors.push({ row: 0, message: 'Excel sheet has no data rows' });
    parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
    return;
  }

  // Normalise header names once
  const firstRow = rawRows[0]!;
  const colMap = buildColMap(Object.keys(firstRow));

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2; // 1-based, row 1 is header
    const raw2 = rawRows[i]!;

    const name = strCol(raw2, colMap.name);
    const position = strCol(raw2, colMap.position);
    const nflTeam = strCol(raw2, colMap.nfl_team);
    const aavRaw = raw2[colMap.aav_minor ?? ''];

    if (!name) {
      errors.push({ row: rowNum, message: 'Missing player name' });
      continue;
    }
    if (!position) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: missing position` });
      continue;
    }

    const aav = aavRaw !== null && aavRaw !== undefined ? parseInt(String(aavRaw), 10) : NaN;
    if (isNaN(aav) || aav < 0) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: aav_minor must be a non-negative integer, got '${String(aavRaw)}'` });
      continue;
    }

    let projectedPoints: number | null = null;
    const ppRaw = raw2[colMap.projected_points ?? ''];
    if (ppRaw !== null && ppRaw !== undefined) {
      const pp = parseFloat(String(ppRaw));
      projectedPoints = isNaN(pp) ? null : pp;
    }

    let tier: number | null = null;
    const tierRaw = raw2[colMap.tier ?? ''];
    if (tierRaw !== null && tierRaw !== undefined) {
      const t = parseInt(String(tierRaw), 10);
      tier = isNaN(t) ? null : t;
    }

    const espnIdRaw = raw2[colMap.espn_player_id ?? ''];
    const espnPlayerId = espnIdRaw !== null && espnIdRaw !== undefined ? String(espnIdRaw) : null;

    rows.push({
      name,
      position,
      nfl_team: nflTeam,
      aav_minor: aav,
      projected_points: projectedPoints,
      tier,
      espn_player_id: espnPlayerId,
    });
  }

  parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
}

/** Build column name → header string mapping. Case-insensitive. */
function buildColMap(headers: string[]): Record<string, string | undefined> {
  const map: Record<string, string | undefined> = {};
  const FIELDS = ['name', 'position', 'nfl_team', 'aav_minor', 'projected_points', 'tier', 'espn_player_id'];
  for (const field of FIELDS) {
    const match = headers.find((h) => h.toLowerCase().trim() === field);
    map[field] = match;
  }
  return map;
}

function strCol(row: Record<string, unknown>, col: string | undefined): string {
  if (!col) return '';
  const v = row[col];
  return v !== null && v !== undefined ? String(v).trim() : '';
}

run();
