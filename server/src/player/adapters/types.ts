/**
 * Shared types for all player data adapters (MOD-007).
 *
 * Each adapter (CSV, Excel, ESPN PDF, FantasyPros) implements PlayerAdapter
 * so they share a uniform public contract. The route layer calls them and
 * feeds the results into the same UPSERT pipeline.
 */

export interface ParsedRow {
  name: string;
  position: string;
  nfl_team: string;
  aav_minor: number; // integer cents
  projected_points: number | null;
  tier: number | null;
  espn_player_id: string | null;
}

export interface ParseError {
  row: number;
  message: string;
}

export interface AdapterResult {
  rows: ParsedRow[];
  errors: ParseError[];
}

export type ImportSource = 'CSV' | 'EXCEL' | 'ESPN_PDF' | 'FANTASYPROS';

/**
 * Unified adapter interface.
 * File-based adapters pass Buffer; API adapters pass an options object.
 */
export interface PlayerAdapter {
  readonly source: ImportSource;
  parse(input: Buffer | Record<string, unknown>): Promise<AdapterResult>;
}
