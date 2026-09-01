/**
 * FantasyPros API adapter (MOD-007).
 *
 * Fetches player projections from FantasyPros and normalises them to ParsedRow.
 * Runs in the main thread (I/O-bound, not CPU-bound) — no worker thread needed.
 *
 * Environment variables used:
 *   FANTASYPROS_API_KEY — required, validated at startup by env-check.cjs
 *   FANTASYPROS_API_URL — optional override for the base URL (used in tests)
 *
 * FantasyPros response format:
 *   { players: [{ player_name, player_position_id, player_team_id, avg, rank }] }
 *
 * aav_minor is set to 0 for FantasyPros imports (this source provides projections,
 * not auction values — AAVs come from the ESPN PDF adapter).
 */
import type { PlayerAdapter, AdapterResult, ParsedRow, ImportSource } from './types.js';

const FP_BASE_URL = 'https://api.fantasypros.com/v2/json/nfl/2024';

interface FpPlayer {
  player_name?: string;
  player_position_id?: string;
  player_team_id?: string;
  avg?: string | number;
  rank?: number;
}

interface FpResponse {
  players?: FpPlayer[];
}

export class FantasyProsAdapter implements PlayerAdapter {
  readonly source: ImportSource = 'FANTASYPROS';

  async parse(input: Buffer | Record<string, unknown>): Promise<AdapterResult> {
    const opts = Buffer.isBuffer(input) ? {} : (input as Record<string, unknown>);
    const scoringFormat = String(opts['scoring_format'] ?? 'PPR').toUpperCase();
    const apiKey = process.env['FANTASYPROS_API_KEY'] ?? '';
    // Allow test overrides via env var without touching production config
    const baseUrl = process.env['FANTASYPROS_API_URL'] ?? FP_BASE_URL;

    const url = `${baseUrl}/consensus-rankings?type=proj&scoring=${scoringFormat}&api_key=${apiKey}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (fetchErr) {
      throw new Error(`FantasyPros fetch failed: ${String(fetchErr)}`);
    }

    if (!response.ok) {
      throw new Error(`FantasyPros API returned ${response.status}: ${response.statusText}`);
    }

    let data: FpResponse;
    try {
      data = (await response.json()) as FpResponse;
    } catch (jsonErr) {
      throw new Error(`FantasyPros returned invalid JSON: ${String(jsonErr)}`);
    }

    const players = data.players ?? [];
    const rows: ParsedRow[] = [];
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const rowNum = i + 1;

      const name = p.player_name?.trim() ?? '';
      const position = p.player_position_id?.trim().toUpperCase() ?? '';
      const team = p.player_team_id?.trim().toUpperCase() ?? '';

      if (!name) {
        errors.push({ row: rowNum, message: `Row ${rowNum}: missing player_name` });
        continue;
      }
      if (!position) {
        errors.push({ row: rowNum, message: `Row ${rowNum}: missing player_position_id` });
        continue;
      }

      const avg = p.avg !== undefined ? parseFloat(String(p.avg)) : null;

      rows.push({
        name,
        position,
        nfl_team: team,
        aav_minor: 0, // FantasyPros provides projections, not AAVs
        projected_points: avg !== null && !isNaN(avg) ? avg : null,
        tier: null,
        espn_player_id: null,
      });
    }

    return { rows, errors };
  }
}
