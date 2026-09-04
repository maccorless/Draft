/**
 * Corrections, Rollback, and Whammy — commissioner UI (F-MOD-012).
 * PRD.md §31 (Correction and Rollback), §33 (Whammy), screen-information-
 * architecture.md §9.4/§9.5. Wires to F-MOD-005 (server/src/draft/
 * corrections.ts) and F-MOD-009 (server/src/draft/whammy.ts) — no new
 * server logic here.
 *
 * Re-apply assist (rollback) decision: the spec cites "the existing
 * manual-award path (MOD-011 Live Interventions)", but MOD-011's
 * POST /auctions/current/reassign only operates on the currently-OPEN
 * auction (server/src/draft/draft-control.ts), and a rolled-back pick's
 * PlayerAuction is reset to PENDING, not OPEN. The actual manual-award
 * mechanism MOD-011 exposes for putting a specific team/price on a specific
 * player is nominate-on-behalf-of-team (WS NOMINATE_COMMAND with
 * on_behalf_of_team_id) — engine.ts sets current_leader_id/current_bid_minor
 * to the nominating team/opening_bid_minor at insert, so nominating with
 * opening_bid_minor = the original price reproduces the exact team+price
 * immediately, without a separate reassign call. That command requires the
 * draft to be RUNNING (not PAUSED), so re-award resumes the draft first if
 * needed — the same real auction/timer flow then governs final resolution,
 * exactly as it does for every other manually-set auction in MOD-011.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './corrections.css';

interface CorrectionsProps {
  draftId: string;
  leagueId: string;
  token: string;
}

interface GridTeam {
  team_id: string;
  team_name: string;
  remaining_budget_minor: number;
}

interface ActivityPick {
  acquisition_id: string;
  player_name: string;
  position: string;
  price_minor: number;
  resolution_sequence: number;
  team_id: string;
  team_name: string;
}

interface DatasetPlayer {
  dataset_entry_id: string;
  name: string;
  position: string;
}

interface PicksReversedEntry {
  acquisition_id: string;
  player_name: string;
  team_id: string;
  price_minor: number;
}

interface ReapplyItem extends PicksReversedEntry {
  done: boolean;
}

interface PendingWhammy {
  whammy_id: string;
  team_id: string;
  amount_minor: number;
}

interface ApiError {
  code: string;
  message: string;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
}

function dollarsToMinor(input: string): number {
  return Math.round(parseFloat(input) * 100);
}

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function postJson<T>(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : undefined) as T;
  return { status: res.status, data };
}

/**
 * Fire-and-forget nomination on behalf of a team, over a one-shot WS
 * connection. Reuses the exact wire protocol useAuctionSocket.ts uses
 * (AUTHENTICATE then NOMINATE_COMMAND) without needing that hook's ongoing
 * reconnect/state-tracking machinery, which this one-shot command doesn't
 * need.
 */
function sendNominateOnBehalf(
  draftId: string,
  token: string,
  teamId: string,
  playerDatasetEntryId: string,
  openingBidMinor: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/drafts/${draftId}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'AUTHENTICATE', payload: { token, last_seen_sequence: -1 } }));
      ws.send(JSON.stringify({
        type: 'NOMINATE_COMMAND',
        payload: {
          player_dataset_entry_id: playerDatasetEntryId,
          opening_bid_minor: openingBidMinor,
          on_behalf_of_team_id: teamId,
        },
      }));
      resolve();
      setTimeout(() => ws.close(), 250);
    };
    ws.onerror = () => reject(new Error('WS connection failed'));
  });
}

export function Corrections({ draftId, leagueId, token }: CorrectionsProps): React.ReactElement {
  const [teams, setTeams] = useState<GridTeam[]>([]);
  const [picks, setPicks] = useState<ActivityPick[]>([]);
  const [players, setPlayers] = useState<DatasetPlayer[]>([]);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // ── Price correction ──────────────────────────────────────────────────────
  const [correctAcqId, setCorrectAcqId] = useState('');
  const [newPriceInput, setNewPriceInput] = useState('');
  const [correctionResult, setCorrectionResult] = useState<{
    acquisition_id: string;
    old_price_minor: number;
    new_price_minor: number;
    team_id: string;
    new_remaining_budget_minor: number;
  } | null>(null);
  const [correctionError, setCorrectionError] = useState<ApiError | null>(null);

  // ── Rollback ───────────────────────────────────────────────────────────────
  const [rollbackCountInput, setRollbackCountInput] = useState('');
  const [rollbackError, setRollbackError] = useState<ApiError | null>(null);
  const [reapplyItems, setReapplyItems] = useState<ReapplyItem[]>([]);
  const [editTeamId, setEditTeamId] = useState('');
  const [editPlayerId, setEditPlayerId] = useState('');
  const [editPriceInput, setEditPriceInput] = useState('');

  // ── Whammy ─────────────────────────────────────────────────────────────────
  const [whammyTeamId, setWhammyTeamId] = useState('');
  const [whammyAmountInput, setWhammyAmountInput] = useState('');
  const [whammyDescription, setWhammyDescription] = useState('');
  const [whammyError, setWhammyError] = useState<string | null>(null);
  const [appliedWhammy, setAppliedWhammy] = useState<{
    team_id: string;
    amount_minor: number;
    new_remaining_budget_minor: number;
  } | null>(null);
  const [pendingWhammies, setPendingWhammies] = useState<PendingWhammy[]>([]);
  const [pendingWhammyErrors, setPendingWhammyErrors] = useState<Record<string, string>>({});

  const refreshTeams = useCallback(() => {
    authedJson<{ teams: GridTeam[] }>(`/drafts/${draftId}/roster-grid`, token)
      .then((d) => setTeams(d.teams ?? []))
      .catch(() => {});
  }, [draftId, token]);

  const refreshPicks = useCallback(() => {
    authedJson<{ recent: ActivityPick[] }>(`/drafts/${draftId}/activity`, token)
      .then((d) => setPicks(d.recent ?? []))
      .catch(() => {});
  }, [draftId, token]);

  const refreshHealth = useCallback(() => {
    authedJson<{ status: string }>(`/drafts/${draftId}/health`, token)
      .then((d) => setDraftStatus(d.status))
      .catch(() => {});
  }, [draftId, token]);

  useEffect(() => {
    authedJson<{ players: DatasetPlayer[] }>(`/leagues/${leagueId}/players`, token)
      .then((d) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [leagueId, token]);

  useEffect(() => {
    refreshTeams();
    refreshPicks();
    refreshHealth();
  }, [refreshTeams, refreshPicks, refreshHealth]);

  function report(text: string): void {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? null : m)), 4000);
  }

  const findPlayerIdByName = useCallback(
    (name: string): string => players.find((p) => p.name === name)?.dataset_entry_id ?? '',
    [players],
  );

  // ── Price correction ──────────────────────────────────────────────────────

  const selectedPick = useMemo(
    () => picks.find((p) => p.acquisition_id === correctAcqId) ?? null,
    [picks, correctAcqId],
  );
  const selectedTeam = useMemo(
    () => (selectedPick ? teams.find((t) => t.team_id === selectedPick.team_id) ?? null : null),
    [teams, selectedPick],
  );
  const newPriceMinor = newPriceInput ? dollarsToMinor(newPriceInput) : null;
  const budgetDeltaMinor =
    selectedPick && newPriceMinor !== null ? selectedPick.price_minor - newPriceMinor : null;
  const previewRemainingMinor =
    selectedTeam && budgetDeltaMinor !== null ? selectedTeam.remaining_budget_minor + budgetDeltaMinor : null;

  function openRollbackForPick(acquisitionId: string): void {
    const idx = picks.findIndex((p) => p.acquisition_id === acquisitionId);
    if (idx === -1) return;
    setRollbackCountInput(String(idx + 1));
    setRollbackError(null);
  }

  function submitCorrection(e: React.FormEvent): void {
    e.preventDefault();
    if (!correctAcqId || newPriceMinor === null || !Number.isFinite(newPriceMinor)) return;
    setCorrectionError(null);
    postJson<{ acquisition_id: string; old_price_minor: number; new_price_minor: number; team_id: string; new_remaining_budget_minor: number } | ApiError>(
      `/drafts/${draftId}/corrections/price`,
      token,
      { acquisition_id: correctAcqId, new_price_minor: newPriceMinor },
    ).then(({ status, data }) => {
      if (status === 200) {
        const result = data as {
          acquisition_id: string;
          old_price_minor: number;
          new_price_minor: number;
          team_id: string;
          new_remaining_budget_minor: number;
        };
        setCorrectionResult(result);
        setTeams((prev) =>
          prev.map((t) =>
            t.team_id === result.team_id ? { ...t, remaining_budget_minor: result.new_remaining_budget_minor } : t,
          ),
        );
        setPicks((prev) =>
          prev.map((p) =>
            p.acquisition_id === result.acquisition_id ? { ...p, price_minor: result.new_price_minor } : p,
          ),
        );
      } else {
        setCorrectionError(data as ApiError);
      }
    }).catch(() => setCorrectionError({ code: 'NETWORK_ERROR', message: 'Request failed' }));
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  const rollbackCount = rollbackCountInput ? parseInt(rollbackCountInput, 10) : 0;
  const rollbackPreviewPicks = useMemo(
    () => (rollbackCount > 0 ? picks.slice(0, rollbackCount) : []),
    [picks, rollbackCount],
  );
  const rollbackCostStatement = useMemo(() => {
    if (rollbackPreviewPicks.length === 0) return null;
    const first = rollbackPreviewPicks[0]!;
    const last = rollbackPreviewPicks[rollbackPreviewPicks.length - 1]!;
    const n = rollbackPreviewPicks.length;
    const range =
      first.resolution_sequence === last.resolution_sequence
        ? `pick #${first.resolution_sequence}`
        : `picks #${first.resolution_sequence} through #${last.resolution_sequence}`;
    return `This will undo ${range} (${n} player${n === 1 ? '' : 's'}). Those players return to the pool.`;
  }, [rollbackPreviewPicks]);

  function confirmRollback(): void {
    if (rollbackCount <= 0) return;
    setRollbackError(null);

    const doRollback = (): void => {
      postJson<{ rolled_back: number; picks_reversed: PicksReversedEntry[] } | ApiError>(
        `/drafts/${draftId}/rollback`,
        token,
        { count: rollbackCount },
      ).then(({ status, data }) => {
        if (status === 200) {
          const result = data as { rolled_back: number; picks_reversed: PicksReversedEntry[] };
          const oldestFirst = [...result.picks_reversed].reverse();
          setReapplyItems(oldestFirst.map((p) => ({ ...p, done: false })));
          if (oldestFirst.length > 0) {
            const firstItem = oldestFirst[0]!;
            setEditTeamId(firstItem.team_id);
            setEditPlayerId(findPlayerIdByName(firstItem.player_name));
            setEditPriceInput(String(firstItem.price_minor / 100));
          }
          setRollbackCountInput('');
          setCorrectionResult(null);
          refreshTeams();
          refreshPicks();
        } else {
          setRollbackError(data as ApiError);
        }
      }).catch(() => setRollbackError({ code: 'NETWORK_ERROR', message: 'Request failed' }));
    };

    if (draftStatus !== 'PAUSED') {
      authedJson(`/drafts/${draftId}/pause`, token, { method: 'POST' })
        .then(() => {
          setDraftStatus('PAUSED');
          doRollback();
        })
        .catch(() => setRollbackError({ code: 'PAUSE_FAILED', message: 'Failed to pause draft' }));
    } else {
      doRollback();
    }
  }

  function reawardItem(index: number): void {
    const item = reapplyItems[index];
    if (!item) return;
    const isFirst = index === 0;
    const teamId = isFirst ? editTeamId : item.team_id;
    const playerDatasetEntryId = isFirst ? editPlayerId : findPlayerIdByName(item.player_name);
    const priceMinor = isFirst ? dollarsToMinor(editPriceInput) : item.price_minor;
    if (!teamId || !playerDatasetEntryId || !Number.isFinite(priceMinor)) {
      report('Select a team and player before re-awarding');
      return;
    }

    const doNominate = (): void => {
      sendNominateOnBehalf(draftId, token, teamId, playerDatasetEntryId, priceMinor)
        .then(() => {
          setReapplyItems((prev) => prev.map((it, i) => (i === index ? { ...it, done: true } : it)));
          report(`Re-award submitted for ${item.player_name}`);
        })
        .catch(() => report('Failed to send re-award nomination'));
    };

    if (draftStatus !== 'RUNNING') {
      authedJson(`/drafts/${draftId}/resume`, token, { method: 'POST' })
        .then(() => {
          setDraftStatus('RUNNING');
          doNominate();
        })
        .catch(() => report('Failed to resume draft'));
    } else {
      doNominate();
    }
  }

  // ── Whammy ─────────────────────────────────────────────────────────────────

  function submitWhammy(e: React.FormEvent): void {
    e.preventDefault();
    const amountMinor = dollarsToMinor(whammyAmountInput);
    if (!whammyTeamId || !whammyDescription.trim() || !Number.isFinite(amountMinor) || amountMinor === 0) return;
    setWhammyError(null);
    postJson<
      | { team_id: string; amount_minor: number; new_remaining_budget_minor: number }
      | { whammy_id: string; status: 'PENDING_APPROVAL'; team_id: string; amount_minor: number }
      | ApiError
    >(`/drafts/${draftId}/whammy`, token, {
      team_id: whammyTeamId,
      amount_minor: amountMinor,
      description: whammyDescription.trim(),
    }).then(({ status, data }) => {
      if (status === 200 && 'status' in data && data.status === 'PENDING_APPROVAL') {
        setPendingWhammies((prev) => [...prev, { whammy_id: data.whammy_id, team_id: data.team_id, amount_minor: data.amount_minor }]);
        setWhammyDescription('');
      } else if (status === 200) {
        const applied = data as { team_id: string; amount_minor: number; new_remaining_budget_minor: number };
        setAppliedWhammy(applied);
        setTeams((prev) =>
          prev.map((t) => (t.team_id === applied.team_id ? { ...t, remaining_budget_minor: applied.new_remaining_budget_minor } : t)),
        );
        setWhammyDescription('');
      } else {
        setWhammyError((data as ApiError).message);
      }
    }).catch(() => setWhammyError('Request failed'));
  }

  function approveWhammy(whammyId: string): void {
    postJson<{ team_id: string; amount_minor: number; new_remaining_budget_minor: number } | ApiError>(
      `/drafts/${draftId}/whammy/${whammyId}/approve`,
      token,
      {},
    ).then(({ status, data }) => {
      if (status === 200) {
        const applied = data as { team_id: string; amount_minor: number; new_remaining_budget_minor: number };
        setAppliedWhammy(applied);
        setTeams((prev) =>
          prev.map((t) => (t.team_id === applied.team_id ? { ...t, remaining_budget_minor: applied.new_remaining_budget_minor } : t)),
        );
        setPendingWhammies((prev) => prev.filter((w) => w.whammy_id !== whammyId));
        setPendingWhammyErrors((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([id]) => id !== whammyId)),
        );
      } else {
        const err = data as ApiError;
        if (err.code === 'WHAMMY_NOT_PENDING') {
          // Already resolved elsewhere — not actionable here. The row (and its
          // inline error slot) is about to disappear, so surface the message
          // via the toast instead of the per-row error, or it would never be seen.
          setPendingWhammies((prev) => prev.filter((w) => w.whammy_id !== whammyId));
          report(err.message);
        } else {
          setPendingWhammyErrors((prev) => ({ ...prev, [whammyId]: err.message }));
        }
      }
    }).catch(() => setPendingWhammyErrors((prev) => ({ ...prev, [whammyId]: 'Request failed' })));
  }

  function rejectWhammy(whammyId: string): void {
    postJson<{ whammy_id: string; status: 'REJECTED' } | ApiError>(
      `/drafts/${draftId}/whammy/${whammyId}/reject`,
      token,
      {},
    ).then(({ status, data }) => {
      if (status === 200) {
        setPendingWhammies((prev) => prev.filter((w) => w.whammy_id !== whammyId));
        report('Whammy rejected');
      } else {
        const err = data as ApiError;
        setPendingWhammies((prev) => prev.filter((w) => w.whammy_id !== whammyId));
        report(err.message);
      }
    }).catch(() => report('Request failed'));
  }

  const teamName = useCallback(
    (id: string): string => teams.find((t) => t.team_id === id)?.team_name ?? id,
    [teams],
  );

  return (
    <div className="corrections">
      {message && <div className="corrections__toast" role="status">{message}</div>}

      <section className="corrections__panel" aria-label="Price Correction">
        <h2 className="corrections__heading">Price Correction</h2>
        <form className="corrections__form" onSubmit={submitCorrection} data-testid="correction-form">
          <label htmlFor="correction-acquisition">Pick</label>
          <select
            id="correction-acquisition"
            data-testid="correction-acquisition-select"
            value={correctAcqId}
            onChange={(e) => {
              setCorrectAcqId(e.target.value);
              setCorrectionResult(null);
              setCorrectionError(null);
            }}
          >
            <option value="">Select a pick…</option>
            {picks.map((p) => (
              <option key={p.acquisition_id} value={p.acquisition_id}>
                #{p.resolution_sequence} {p.player_name} — {p.team_name} ({formatMoney(p.price_minor)})
              </option>
            ))}
          </select>

          {selectedPick && (
            <div className="corrections__preview" data-testid="correction-preview">
              <div data-testid="correction-old-price">Old price: {formatMoney(selectedPick.price_minor)}</div>
              <label htmlFor="correction-new-price">New price ($)</label>
              <input
                id="correction-new-price"
                data-testid="correction-new-price-input"
                type="number"
                min={1}
                value={newPriceInput}
                onChange={(e) => setNewPriceInput(e.target.value)}
              />
              {newPriceMinor !== null && Number.isFinite(newPriceMinor) && (
                <>
                  <div data-testid="correction-new-price-value">New price: {formatMoney(newPriceMinor)}</div>
                  <div data-testid="correction-delta">Budget delta: {formatMoney(budgetDeltaMinor ?? 0)}</div>
                  {previewRemainingMinor !== null && (
                    <div data-testid="correction-remaining">Remaining budget: {formatMoney(previewRemainingMinor)}</div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="corrections__buttons">
            <button type="submit" data-testid="correction-submit" disabled={!correctAcqId || newPriceMinor === null}>
              Confirm Correction
            </button>
            <button
              type="button"
              data-testid="correction-rollback-instead-direct"
              disabled={!correctAcqId}
              onClick={() => openRollbackForPick(correctAcqId)}
            >
              Wrong winner or player? Roll back instead
            </button>
          </div>
        </form>

        {correctionResult && (
          <div className="corrections__result" data-testid="correction-result">
            Corrected {formatMoney(correctionResult.old_price_minor)} → {formatMoney(correctionResult.new_price_minor)}.
            New remaining budget: {formatMoney(correctionResult.new_remaining_budget_minor)}.
          </div>
        )}

        {correctionError && (
          <div className="corrections__error" data-testid="correction-error">
            <p>{correctionError.message}</p>
            {correctionError.code === 'CORRECTION_ILLEGAL' && (
              <button
                type="button"
                data-testid="correction-rollback-instead"
                onClick={() => openRollbackForPick(correctAcqId)}
              >
                Roll back instead
              </button>
            )}
          </div>
        )}
      </section>

      <section className="corrections__panel" aria-label="Rollback">
        <h2 className="corrections__heading">Rollback</h2>
        <div className="corrections__form">
          <label htmlFor="rollback-count">Number of most recent picks to undo</label>
          <input
            id="rollback-count"
            data-testid="rollback-count-input"
            type="number"
            min={1}
            value={rollbackCountInput}
            onChange={(e) => {
              setRollbackCountInput(e.target.value);
              setRollbackError(null);
            }}
          />
        </div>

        {rollbackCostStatement && (
          <div className="corrections__preview" data-testid="rollback-preview">
            <p data-testid="rollback-preview-statement">{rollbackCostStatement}</p>
            <ul data-testid="rollback-preview-list">
              {rollbackPreviewPicks.map((p) => (
                <li key={p.acquisition_id}>
                  #{p.resolution_sequence} {p.player_name} — {p.team_name} ({formatMoney(p.price_minor)})
                </li>
              ))}
            </ul>
            <button type="button" data-testid="rollback-confirm" onClick={confirmRollback}>
              Confirm Rollback
            </button>
          </div>
        )}

        {rollbackError && (
          <div className="corrections__error" data-testid="rollback-error">
            {rollbackError.message}
          </div>
        )}

        {reapplyItems.length > 0 && (
          <div className="corrections__reapply" data-testid="rollback-reapply-list" aria-label="Re-apply Assist">
            <h3 className="corrections__subheading">Re-apply Assist</h3>
            {reapplyItems.map((item, i) => (
              <div key={item.acquisition_id} className="corrections__reapply-item" data-testid={`rollback-reapply-item-${i}`}>
                {i === 0 ? (
                  <>
                    <label htmlFor="reapply-team">Team</label>
                    <select id="reapply-team" data-testid="reapply-team-select" value={editTeamId} onChange={(e) => setEditTeamId(e.target.value)}>
                      <option value="">Select team…</option>
                      {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
                    </select>
                    <label htmlFor="reapply-player">Player</label>
                    <select id="reapply-player" data-testid="reapply-player-select" value={editPlayerId} onChange={(e) => setEditPlayerId(e.target.value)}>
                      <option value="">Select player…</option>
                      {players.map((p) => <option key={p.dataset_entry_id} value={p.dataset_entry_id}>{p.name} ({p.position})</option>)}
                    </select>
                    <label htmlFor="reapply-price">Price ($)</label>
                    <input id="reapply-price" data-testid="reapply-price-input" type="number" min={1} value={editPriceInput} onChange={(e) => setEditPriceInput(e.target.value)} />
                  </>
                ) : (
                  <span>{item.player_name} — {teamName(item.team_id)} ({formatMoney(item.price_minor)})</span>
                )}
                <button
                  type="button"
                  data-testid={`rollback-reapply-reward-${i}`}
                  disabled={item.done}
                  onClick={() => reawardItem(i)}
                >
                  {item.done ? 'Re-awarded' : 'Re-award'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="corrections__panel" aria-label="Whammy">
        <h2 className="corrections__heading">Whammy</h2>
        <form className="corrections__form" onSubmit={submitWhammy} data-testid="whammy-form">
          <label htmlFor="whammy-team">Team</label>
          <select id="whammy-team" data-testid="whammy-team-select" value={whammyTeamId} onChange={(e) => setWhammyTeamId(e.target.value)}>
            <option value="">Select team…</option>
            {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
          </select>
          <label htmlFor="whammy-amount">Amount ($, signed)</label>
          <input
            id="whammy-amount"
            data-testid="whammy-amount-input"
            type="number"
            value={whammyAmountInput}
            onChange={(e) => setWhammyAmountInput(e.target.value)}
          />
          <label htmlFor="whammy-description">Description</label>
          <input
            id="whammy-description"
            data-testid="whammy-description-input"
            type="text"
            value={whammyDescription}
            onChange={(e) => setWhammyDescription(e.target.value)}
          />
          <button type="submit" data-testid="whammy-submit" disabled={!whammyTeamId || !whammyDescription.trim() || !whammyAmountInput}>
            Trigger Whammy
          </button>
        </form>

        {appliedWhammy && (
          <div className="corrections__result" data-testid="whammy-applied">
            Applied {formatMoney(appliedWhammy.amount_minor)} to {teamName(appliedWhammy.team_id)}. New remaining
            budget: {formatMoney(appliedWhammy.new_remaining_budget_minor)}.
          </div>
        )}

        {whammyError && (
          <div className="corrections__error" data-testid="whammy-error">
            {whammyError}
          </div>
        )}

        {pendingWhammies.length > 0 && (
          <ul className="corrections__pending-list" data-testid="whammy-pending-list">
            {pendingWhammies.map((w) => (
              <li key={w.whammy_id} data-testid={`whammy-pending-item-${w.whammy_id}`}>
                <span>{teamName(w.team_id)}: {formatMoney(w.amount_minor)}</span>
                <button type="button" data-testid={`whammy-approve-${w.whammy_id}`} onClick={() => approveWhammy(w.whammy_id)}>
                  Approve
                </button>
                <button type="button" data-testid={`whammy-reject-${w.whammy_id}`} onClick={() => rejectWhammy(w.whammy_id)}>
                  Reject
                </button>
                {pendingWhammyErrors[w.whammy_id] && (
                  <div className="corrections__error" data-testid={`whammy-pending-error-${w.whammy_id}`}>
                    {pendingWhammyErrors[w.whammy_id]}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
