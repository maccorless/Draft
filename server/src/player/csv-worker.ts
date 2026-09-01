/**
 * CSV parsing worker — runs in a node:worker_threads Worker.
 * Receives CSV content as a string via workerData.csvContent.
 * Posts { rows, errors } back to the parent thread.
 *
 * Expected CSV header row (case-insensitive):
 *   name, position, nfl_team, aav_minor, projected_points, tier, espn_player_id
 *
 * aav_minor must be an integer (cents). All other fields are optional.
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

// Simple RFC 4180–compatible CSV parser for a single row.
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i).trim());
        break;
      } else {
        fields.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
  }
  return fields;
}

function run(): void {
  const csvContent: string = workerData.csvContent as string;
  const lines = csvContent
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    parentPort?.postMessage({ rows: [], errors: [{ row: 0, message: 'CSV has no data rows' }] } satisfies WorkerResult);
    return;
  }

  const headerLine = lines[0]!;
  const headers = parseRow(headerLine).map((h) => h.toLowerCase().trim());

  const idx = {
    name: headers.indexOf('name'),
    position: headers.indexOf('position'),
    nfl_team: headers.indexOf('nfl_team'),
    aav_minor: headers.indexOf('aav_minor'),
    projected_points: headers.indexOf('projected_points'),
    tier: headers.indexOf('tier'),
    espn_player_id: headers.indexOf('espn_player_id'),
  };

  if (idx.name === -1 || idx.position === -1 || idx.aav_minor === -1) {
    parentPort?.postMessage({
      rows: [],
      errors: [{ row: 1, message: 'CSV missing required columns: name, position, aav_minor' }],
    } satisfies WorkerResult);
    return;
  }

  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // 1-based, header is row 1
    const fields = parseRow(lines[i]!);

    const name = fields[idx.name]?.trim() ?? '';
    const position = fields[idx.position]?.trim() ?? '';
    const nflTeam = idx.nfl_team >= 0 ? (fields[idx.nfl_team]?.trim() ?? '') : '';
    const aavRaw = fields[idx.aav_minor]?.trim() ?? '';

    if (!name) {
      errors.push({ row: rowNum, message: 'Missing player name' });
      continue;
    }
    if (!position) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: missing position` });
      continue;
    }

    const aav = parseInt(aavRaw, 10);
    if (isNaN(aav) || aav < 0) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: aav_minor must be a non-negative integer, got '${aavRaw}'` });
      continue;
    }

    let projectedPoints: number | null = null;
    if (idx.projected_points >= 0 && fields[idx.projected_points]?.trim()) {
      const pp = parseFloat(fields[idx.projected_points]!.trim());
      projectedPoints = isNaN(pp) ? null : pp;
    }

    let tier: number | null = null;
    if (idx.tier >= 0 && fields[idx.tier]?.trim()) {
      const t = parseInt(fields[idx.tier]!.trim(), 10);
      tier = isNaN(t) ? null : t;
    }

    const espnPlayerId =
      idx.espn_player_id >= 0 && fields[idx.espn_player_id]?.trim()
        ? fields[idx.espn_player_id]!.trim()
        : null;

    rows.push({ name, position, nfl_team: nflTeam, aav_minor: aav, projected_points: projectedPoints, tier, espn_player_id: espnPlayerId });
  }

  parentPort?.postMessage({ rows, errors } satisfies WorkerResult);
}

run();
