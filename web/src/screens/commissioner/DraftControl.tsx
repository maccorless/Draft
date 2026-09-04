/**
 * Draft Control — commissioner live-operation panel (F-MOD-011).
 * screen-information-architecture.md §9.1/§9.2/§9.6, PRD.md §30.
 *
 * Pause/resume and Manual/Auto-Agent toggle reuse MOD-002/MOD-004 REST
 * endpoints; nominate/bid-for-owner reuse the existing WS commands extended
 * with on_behalf_of_team_id. Timer extend, budget adjustment, reassign,
 * health, and audit-log are this module's own endpoints.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuctionSocket } from '../../lib/useAuctionSocket.js';
import './draft-control.css';

interface DraftControlProps {
  draftId: string;
  leagueId: string;
  token: string;
}

interface GridTeam {
  team_id: string;
  team_name: string;
  remaining_budget_minor: number;
  control_mode: 'MANUAL' | 'AUTO_AGENT';
}

interface DatasetPlayer {
  dataset_entry_id: string;
  name: string;
  position: string;
}

interface DraftHealth {
  status: string;
  round_or_cycle: number | null;
  auctions_completed: number;
  current_player_auction_id: string | null;
  current_deadline_at: string | null;
  connected_team_count: number;
  auto_agent_team_count: number;
  reconnecting_team_count: number;
  warnings: string[];
}

interface AuditLogEntry {
  event_type: string;
  occurred_at: string;
  team_id: string | null;
  payload?: Record<string, unknown>;
}

function formatMoney(minor: number): string {
  return `$${Math.round(minor / 100)}`;
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

export function DraftControl({ draftId, leagueId, token }: DraftControlProps): React.ReactElement {
  const ws = useAuctionSocket(draftId, token);

  const [teams, setTeams] = useState<GridTeam[]>([]);
  const [players, setPlayers] = useState<DatasetPlayer[]>([]);
  const [health, setHealth] = useState<DraftHealth | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const [extendSeconds, setExtendSeconds] = useState('30');
  const [nominateTeamId, setNominateTeamId] = useState('');
  const [nominatePlayerId, setNominatePlayerId] = useState('');
  const [bidTeamId, setBidTeamId] = useState('');
  const [bidAmount, setBidAmount] = useState('');
  const [adjustTeamId, setAdjustTeamId] = useState('');
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [reassignPlayerId, setReassignPlayerId] = useState('');
  const [reassignTeamId, setReassignTeamId] = useState('');
  const [reassignPrice, setReassignPrice] = useState('');

  const refreshTeams = useCallback(() => {
    authedJson<{ teams: GridTeam[] }>(`/drafts/${draftId}/roster-grid`, token)
      .then((d) => setTeams(d.teams ?? []))
      .catch(() => {});
  }, [draftId, token]);

  const refreshHealth = useCallback(() => {
    authedJson<DraftHealth>(`/drafts/${draftId}/health`, token)
      .then(setHealth)
      .catch(() => {});
  }, [draftId, token]);

  const refreshAuditLog = useCallback(() => {
    authedJson<{ entries: AuditLogEntry[] }>(`/drafts/${draftId}/audit-log`, token)
      .then((d) => setAuditLog(d.entries ?? []))
      .catch(() => {});
  }, [draftId, token]);

  useEffect(() => {
    authedJson<{ players: DatasetPlayer[] }>(`/leagues/${leagueId}/players`, token)
      .then((d) => setPlayers(d.players ?? []))
      .catch(() => {});
  }, [leagueId, token]);

  useEffect(() => {
    refreshTeams();
    refreshHealth();
    refreshAuditLog();
  }, [refreshTeams, refreshHealth, refreshAuditLog]);

  // Re-poll health/teams/audit-log whenever anything of consequence happens.
  useEffect(() => {
    refreshHealth();
    refreshTeams();
    refreshAuditLog();
  }, [
    ws.draftStatus,
    ws.currentAuction?.player_auction_id,
    ws.recentAwards.length,
    refreshHealth,
    refreshTeams,
    refreshAuditLog,
  ]);

  function report(text: string): void {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? null : m)), 4000);
  }

  function pauseDraft(): void {
    authedJson(`/drafts/${draftId}/pause`, token, { method: 'POST' })
      .then(() => report('Draft paused'))
      .catch(() => report('Failed to pause draft'));
  }

  function resumeDraft(): void {
    authedJson(`/drafts/${draftId}/resume`, token, { method: 'POST' })
      .then(() => report('Draft resumed'))
      .catch(() => report('Failed to resume draft'));
  }

  function extendTimer(e: React.FormEvent): void {
    e.preventDefault();
    const seconds = parseInt(extendSeconds, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    authedJson(`/drafts/${draftId}/timers/extend`, token, {
      method: 'POST',
      body: JSON.stringify({ seconds }),
    })
      .then(() => report(`Timer extended by ${seconds}s`))
      .catch(() => report('No open auction to extend'));
  }

  function nominateForOwner(e: React.FormEvent): void {
    e.preventDefault();
    if (!nominateTeamId || !nominatePlayerId) return;
    ws.send({
      type: 'NOMINATE_COMMAND',
      payload: {
        player_dataset_entry_id: nominatePlayerId,
        opening_bid_minor: 100,
        on_behalf_of_team_id: nominateTeamId,
      },
    });
    setNominatePlayerId('');
  }

  function bidForOwner(e: React.FormEvent): void {
    e.preventDefault();
    const amountMinor = Math.round(parseFloat(bidAmount) * 100);
    if (!bidTeamId || !ws.currentAuction || !Number.isFinite(amountMinor) || amountMinor <= 0) return;
    ws.send({
      type: 'BID_COMMAND',
      payload: {
        player_auction_id: ws.currentAuction.player_auction_id,
        bid_amount_minor: amountMinor,
        bid_type: 'ABSOLUTE',
        on_behalf_of_team_id: bidTeamId,
      },
    });
    setBidAmount('');
  }

  function toggleControlMode(teamId: string, mode: 'MANUAL' | 'AUTO_AGENT'): void {
    authedJson(`/drafts/${draftId}/teams/${teamId}/control-mode`, token, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    })
      .then(refreshTeams)
      .catch(() => report('Failed to change control mode'));
  }

  function submitBudgetAdjustment(e: React.FormEvent): void {
    e.preventDefault();
    const deltaMinor = Math.round(parseFloat(adjustDelta) * 100);
    if (!adjustTeamId || !adjustReason.trim() || !Number.isFinite(deltaMinor) || deltaMinor === 0) return;
    authedJson(`/drafts/${draftId}/teams/${adjustTeamId}/budget-adjustment`, token, {
      method: 'POST',
      body: JSON.stringify({ delta_minor: deltaMinor, reason: adjustReason.trim() }),
    })
      .then(() => {
        report('Budget adjusted');
        setAdjustDelta('');
        setAdjustReason('');
        refreshTeams();
      })
      .catch(() => report('Budget adjustment failed'));
  }

  function submitReassign(e: React.FormEvent): void {
    e.preventDefault();
    if (!reassignPlayerId && !reassignTeamId) return;
    const priceMinor = reassignPrice ? Math.round(parseFloat(reassignPrice) * 100) : null;
    authedJson(`/drafts/${draftId}/auctions/current/reassign`, token, {
      method: 'POST',
      body: JSON.stringify({
        new_player_dataset_entry_id: reassignPlayerId || null,
        award_to_team_id: reassignTeamId || null,
        award_price_minor: priceMinor,
      }),
    })
      .then(() => {
        report('Auction reassigned');
        setReassignPlayerId('');
        setReassignTeamId('');
        setReassignPrice('');
      })
      .catch(() => report('No open auction to reassign'));
  }

  const teamName = useMemo(() => {
    const map = new Map(teams.map((t) => [t.team_id, t.team_name]));
    return (id: string): string => map.get(id) ?? id;
  }, [teams]);

  return (
    <div className="draft-control">
      {message && <div className="draft-control__toast" role="status">{message}</div>}

      <section className="draft-control__panel" aria-label="Draft Health">
        <h2 className="draft-control__heading">Draft Health</h2>
        {health ? (
          <dl className="draft-control__health-stats">
            <div><dt>Status</dt><dd data-testid="health-status">{health.status}</dd></div>
            <div><dt>Round</dt><dd>{health.round_or_cycle ?? '—'}</dd></div>
            <div><dt>Picks made</dt><dd>{health.auctions_completed}</dd></div>
            <div><dt>Connected</dt><dd>{health.connected_team_count}</dd></div>
            <div><dt>Auto-Agent</dt><dd>{health.auto_agent_team_count}</dd></div>
            <div><dt>Reconnecting</dt><dd>{health.reconnecting_team_count}</dd></div>
          </dl>
        ) : (
          <p className="draft-control__idle">Loading…</p>
        )}
        {health && health.warnings.length > 0 && (
          <ul className="draft-control__warnings">
            {health.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </section>

      <section className="draft-control__panel" aria-label="Draft Controls">
        <h2 className="draft-control__heading">Controls</h2>
        <div className="draft-control__buttons">
          <button onClick={pauseDraft} disabled={health?.status !== 'RUNNING'}>Pause</button>
          <button onClick={resumeDraft} disabled={health?.status !== 'PAUSED'}>Resume</button>
        </div>

        <form className="draft-control__form" onSubmit={extendTimer}>
          <label htmlFor="extend-seconds">Extend timer (seconds)</label>
          <input
            id="extend-seconds"
            type="number"
            min={1}
            value={extendSeconds}
            onChange={(e) => setExtendSeconds(e.target.value)}
          />
          <button type="submit" disabled={!ws.currentAuction}>Extend</button>
        </form>
      </section>

      <section className="draft-control__panel" aria-label="Nominate or Bid on Behalf of an Owner">
        <h2 className="draft-control__heading">Act on Behalf of a Team</h2>

        <form className="draft-control__form" onSubmit={nominateForOwner}>
          <label htmlFor="nominate-team">Team</label>
          <select id="nominate-team" value={nominateTeamId} onChange={(e) => setNominateTeamId(e.target.value)}>
            <option value="">Select team…</option>
            {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
          </select>
          <label htmlFor="nominate-player">Player</label>
          <select id="nominate-player" value={nominatePlayerId} onChange={(e) => setNominatePlayerId(e.target.value)}>
            <option value="">Select player…</option>
            {players.map((p) => <option key={p.dataset_entry_id} value={p.dataset_entry_id}>{p.name} ({p.position})</option>)}
          </select>
          <button type="submit" disabled={!!ws.currentAuction || !nominateTeamId || !nominatePlayerId}>
            Nominate for Team
          </button>
        </form>

        <form className="draft-control__form" onSubmit={bidForOwner}>
          <label htmlFor="bid-team">Team</label>
          <select id="bid-team" value={bidTeamId} onChange={(e) => setBidTeamId(e.target.value)}>
            <option value="">Select team…</option>
            {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
          </select>
          <label htmlFor="bid-amount">Bid amount ($)</label>
          <input id="bid-amount" type="number" min={1} value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} />
          <button type="submit" disabled={!ws.currentAuction || !bidTeamId || !bidAmount}>
            Bid for Team
          </button>
        </form>
      </section>

      <section className="draft-control__panel" aria-label="Manual / Auto-Agent Control">
        <h2 className="draft-control__heading">Team Control Mode</h2>
        <ul className="draft-control__team-grid">
          {teams.map((t) => (
            <li key={t.team_id} className="draft-control__team-row">
              <span>{t.team_name}</span>
              <span className="draft-control__mono">{formatMoney(t.remaining_budget_minor)}</span>
              <button
                onClick={() => toggleControlMode(t.team_id, t.control_mode === 'MANUAL' ? 'AUTO_AGENT' : 'MANUAL')}
                aria-pressed={t.control_mode === 'AUTO_AGENT'}
              >
                {t.control_mode === 'AUTO_AGENT' ? 'Auto-Agent' : 'Manual'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="draft-control__panel" aria-label="Budget Adjustment">
        <h2 className="draft-control__heading">Budget Adjustment</h2>
        <form className="draft-control__form" onSubmit={submitBudgetAdjustment}>
          <label htmlFor="adjust-team">Team</label>
          <select id="adjust-team" value={adjustTeamId} onChange={(e) => setAdjustTeamId(e.target.value)}>
            <option value="">Select team…</option>
            {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
          </select>
          <label htmlFor="adjust-delta">Delta ($, negative to debit)</label>
          <input id="adjust-delta" type="number" value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} />
          <label htmlFor="adjust-reason">Reason</label>
          <input id="adjust-reason" type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} />
          <button type="submit" disabled={!adjustTeamId || !adjustDelta || !adjustReason.trim()}>
            Apply Adjustment
          </button>
        </form>
      </section>

      <section className="draft-control__panel" aria-label="Reassign Open Auction">
        <h2 className="draft-control__heading">Reassign Current Auction</h2>
        {ws.currentAuction ? (
          <form className="draft-control__form" onSubmit={submitReassign}>
            <p className="draft-control__idle-small">Currently: {ws.currentAuction.player_name}</p>
            <label htmlFor="reassign-player">Change player to</label>
            <select id="reassign-player" value={reassignPlayerId} onChange={(e) => setReassignPlayerId(e.target.value)}>
              <option value="">(no change)</option>
              {players.map((p) => <option key={p.dataset_entry_id} value={p.dataset_entry_id}>{p.name} ({p.position})</option>)}
            </select>
            <label htmlFor="reassign-team">Award to team</label>
            <select id="reassign-team" value={reassignTeamId} onChange={(e) => setReassignTeamId(e.target.value)}>
              <option value="">(no change)</option>
              {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
            </select>
            <label htmlFor="reassign-price">Price ($)</label>
            <input id="reassign-price" type="number" min={1} value={reassignPrice} onChange={(e) => setReassignPrice(e.target.value)} />
            <button type="submit" disabled={!reassignPlayerId && !reassignTeamId}>Apply Reassign</button>
          </form>
        ) : (
          <p className="draft-control__idle-small">No open auction to reassign.</p>
        )}
      </section>

      <section className="draft-control__panel draft-control__audit-log" aria-label="Audit Log">
        <h2 className="draft-control__heading">Audit Log</h2>
        <table className="draft-control__audit-table">
          <thead>
            <tr><th>When</th><th>Event</th><th>Team</th></tr>
          </thead>
          <tbody>
            {auditLog.map((entry, i) => (
              <tr key={i}>
                <td className="draft-control__mono">{new Date(entry.occurred_at).toLocaleTimeString()}</td>
                <td>{entry.event_type}</td>
                <td>{entry.team_id ? teamName(entry.team_id) : ''}</td>
              </tr>
            ))}
            {auditLog.length === 0 && (
              <tr><td colSpan={3} className="draft-control__idle-small">No activity yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
