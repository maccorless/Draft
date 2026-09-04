/**
 * Multi-source AAV resolution (F-MOD-016).
 *
 * A dataset can have player_aav_sources rows from more than one source. The
 * commissioner picks a Primary (and optional Secondary) among sources that
 * are actually loaded; until they do, a dataset with exactly one loaded
 * source uses it as an implicit primary so existing single-source datasets
 * (and the empty-nomination-queue auto-nominate path) keep working.
 */
import type postgres from 'postgres';

/**
 * Resolves the effective primary AAV source for a dataset: the commissioner's
 * explicit selection, or — until one is made — the sole source loaded so far.
 * Returns null if no source is loaded yet, or multiple are loaded with none selected.
 */
export async function resolveEffectivePrimarySource(
  sql: postgres.Sql,
  datasetId: string,
): Promise<string | null> {
  const [dataset] = await sql<[{ primary_aav_source: string | null }]>`
    SELECT primary_aav_source FROM draft_datasets WHERE id = ${datasetId} LIMIT 1
  `;
  if (dataset?.primary_aav_source) return dataset.primary_aav_source;

  const sources = await sql<Array<{ source: string }>>`
    SELECT DISTINCT source FROM player_aav_sources WHERE dataset_id = ${datasetId}
  `;
  return sources.length === 1 ? sources[0]!.source : null;
}

export interface ResolvedPlayerAav {
  aav_minor: number;
  tier: number | null;
  projected_points: number | null;
}

/**
 * Resolves one player's AAV/tier/projected_points from the dataset's
 * effective primary source. Returns null if that player has no row for
 * that source (or no source could be resolved for the dataset at all).
 */
export async function resolvePlayerPrimaryAav(
  sql: postgres.Sql,
  datasetId: string,
  playerId: string,
): Promise<ResolvedPlayerAav | null> {
  const source = await resolveEffectivePrimarySource(sql, datasetId);
  if (!source) return null;

  const [row] = await sql<[{ aav_minor: number; tier: number | null; projected_points: string | null }]>`
    SELECT aav_minor, tier, projected_points
    FROM player_aav_sources
    WHERE dataset_id = ${datasetId} AND player_id = ${playerId} AND source = ${source}
    LIMIT 1
  `;
  if (!row) return null;

  return {
    aav_minor: Math.trunc(Number(row.aav_minor)),
    tier: row.tier,
    projected_points: row.projected_points !== null ? parseFloat(row.projected_points) : null,
  };
}
