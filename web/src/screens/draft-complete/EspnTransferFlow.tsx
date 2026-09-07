/**
 * Guided ESPN roster transfer flow (F-MOD-013-rework-01, PRD §37).
 * Wires to F-MOD-006-rework-01's already-built endpoints
 * (server/src/draft/espn-transfer.ts) — no new server logic here. The
 * application never calls an ESPN API; this only maps team names, tracks
 * which players the commissioner has manually re-entered into ESPN's
 * Offline Draft tool, and flags anything ambiguous or unresolved.
 */
import React, { useEffect, useMemo, useState } from 'react';

interface EspnTransferFlowProps {
  draftId: string;
  leagueId: string;
  token: string;
}

interface TeamMapping {
  team_id: string;
  external_team_id: string | null;
  external_team_name: string | null;
  verified: boolean;
  candidates: string[];
}

interface CanonicalAcquisition {
  player_id: string;
  player_name: string;
  position: string;
  team_id: string;
  team_name: string;
  price_minor: number;
  roster_slot: string;
  resolution_sequence: number;
}

interface ReconciliationItem {
  id: string;
  team_id: string;
  player_id: string;
  status: string;
  recommended_target_slot: string | null;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

export function EspnTransferFlow({ draftId, leagueId, token }: EspnTransferFlowProps): React.ReactElement {
  const [mappings, setMappings] = useState<TeamMapping[]>([]);
  const [acquisitions, setAcquisitions] = useState<CanonicalAcquisition[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationItem[]>([]);
  const [draftInputs, setDraftInputs] = useState<Record<string, { id: string; name: string }>>({});

  const refreshMappings = (): void => {
    authedJson<TeamMapping[]>(`/leagues/${leagueId}/espn-team-mappings`, token)
      .then(({ data }) => setMappings(data ?? []))
      .catch(() => {});
  };

  const refreshExport = (): void => {
    authedJson<CanonicalAcquisition[] | { code: string; message: string }>(`/drafts/${draftId}/canonical-export`, token)
      .then(({ status, data }) => {
        if (status === 200) {
          setAcquisitions(data as CanonicalAcquisition[]);
          setExportError(null);
        } else {
          setExportError((data as { message: string }).message);
        }
      })
      .catch(() => {});
  };

  const refreshReconciliation = (): void => {
    authedJson<{ items: ReconciliationItem[] }>(`/drafts/${draftId}/reconciliation`, token)
      .then(({ data }) => setReconciliation(data?.items ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    refreshMappings();
    refreshExport();
    refreshReconciliation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, leagueId, token]);

  function saveMapping(teamId: string, externalId: string, externalName: string): void {
    if (!externalId || !externalName) return;
    authedJson(`/leagues/${leagueId}/espn-team-mappings/${teamId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ external_team_id: externalId, external_team_name: externalName }),
    })
      .then(refreshMappings)
      .catch(() => {});
  }

  function confirmItem(itemId: string): void {
    authedJson(`/drafts/${draftId}/reconciliation/${itemId}/confirm`, token, { method: 'POST' })
      .then(refreshReconciliation)
      .catch(() => {});
  }

  const unresolvedMappings = useMemo(() => mappings.filter((m) => !m.verified), [mappings]);

  const acquisitionsByTeam = useMemo(() => {
    const grouped = new Map<string, CanonicalAcquisition[]>();
    for (const a of acquisitions) {
      const list = grouped.get(a.team_id) ?? [];
      list.push(a);
      grouped.set(a.team_id, list);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.resolution_sequence - b.resolution_sequence);
    return grouped;
  }, [acquisitions]);

  const reconciliationByTeamPlayer = useMemo(
    () => new Map(reconciliation.map((r) => [`${r.team_id}:${r.player_id}`, r])),
    [reconciliation],
  );

  const allConfirmed = reconciliation.length > 0 && reconciliation.every((r) => r.status === 'CONFIRMED');

  return (
    <section className="draft-complete__espn-transfer" aria-label="Guided ESPN Transfer">
      <h2 className="draft-complete__espn-transfer-heading">Guided ESPN Transfer</h2>
      <p className="draft-complete__espn-transfer-note">
        Winning prices and full bid history remain authoritative in this application — this flow only
        guides manual entry into ESPN's Offline Draft tool and tracks your progress.
      </p>

      <h3>1. Map teams to ESPN</h3>
      {unresolvedMappings.length > 0 && (
        <p className="draft-complete__espn-transfer-warning" role="alert">
          {unresolvedMappings.length} team{unresolvedMappings.length === 1 ? '' : 's'} still need{unresolvedMappings.length === 1 ? 's' : ''} an ESPN mapping before entry order can proceed for {unresolvedMappings.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      <ul className="draft-complete__espn-mapping-list">
        {mappings.map((m) => (
          <li key={m.team_id} data-testid={`espn-mapping-${m.team_id}`}>
            {m.verified ? (
              <span>{m.external_team_name} ✓</span>
            ) : (
              <>
                <select
                  aria-label={`ESPN team for ${m.team_id}`}
                  value={draftInputs[m.team_id]?.name ?? ''}
                  onChange={(e) => setDraftInputs((prev) => ({ ...prev, [m.team_id]: { id: e.target.value, name: e.target.value } }))}
                >
                  <option value="">Select ESPN team…</option>
                  {m.candidates.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const val = draftInputs[m.team_id];
                    if (val) saveMapping(m.team_id, val.id, val.name);
                  }}
                  disabled={!draftInputs[m.team_id]?.name}
                >
                  Confirm mapping
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <h3>2. Enter picks into ESPN Offline Draft (in order)</h3>
      {exportError && <p className="draft-complete__espn-transfer-error" role="alert">{exportError}</p>}
      {unresolvedMappings.length === 0 &&
        Array.from(acquisitionsByTeam.entries()).map(([teamId, picks]) => {
          const teamName = mappings.find((m) => m.team_id === teamId)?.external_team_name ?? picks[0]?.team_name ?? teamId;
          return (
            <div key={teamId} className="draft-complete__espn-transfer-team" data-testid={`espn-team-order-${teamId}`}>
              <h4>{teamName}</h4>
              <ul>
                {picks.map((p) => {
                  const item = reconciliationByTeamPlayer.get(`${p.team_id}:${p.player_id}`);
                  const confirmed = item?.status === 'CONFIRMED';
                  return (
                    <li key={p.player_id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={confirmed || !item}
                          onChange={() => item && confirmItem(item.id)}
                        />
                        {' '}{p.player_name} ({p.position}) — {formatMoney(p.price_minor)} → {p.roster_slot}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

      {reconciliation.length > 0 && (
        <p className="draft-complete__espn-transfer-status" data-testid="espn-transfer-reconciled-status">
          {allConfirmed ? 'All players reconciled.' : `${reconciliation.filter((r) => r.status === 'CONFIRMED').length} of ${reconciliation.length} players confirmed.`}
        </p>
      )}
    </section>
  );
}
