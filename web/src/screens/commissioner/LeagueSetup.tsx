/**
 * League Setup — commissioner console "League Setup" section (F-MOD-010).
 * PRD §4.4 (access/passwords), §5 (league/team config incl. §5.1 team media,
 * §5.2 draft scheduling), §10 (multi-source AAV), §41 (pre-draft readiness).
 * screen-information-architecture.md §0.2.
 */
import React, { useCallback, useEffect, useState } from 'react';

import { TeamMediaUpload, type TeamMedia } from '../../components/TeamMediaUpload.js';
import './league-setup.css';

export interface LeagueSetupProps {
  leagueId: string;
  token: string;
  /** The league's active dataset (MOD-001) — needed to target the AAV-sources
   * PUT at the right dataset. AAV source selection is disabled until set. */
  datasetId?: string | null;
}

interface LeagueSummary {
  id: string;
  name: string;
  logo_url: string | null;
  name_lock: boolean;
  scheduled_draft_start_at: string | null;
  status_message: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  draft_order: number;
  icon_url: string | null;
  nomination_audio_url: string | null;
  starting_budget_override_minor: number | null;
  name_lock: boolean;
}

interface RosterSlotRow {
  position: string;
  priority: number;
  is_starter: boolean;
  slot_count: number;
}

interface ReadinessItem {
  key: string;
  label: string;
  status: 'PASS' | 'FAIL';
  detail: string | null;
}

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LeagueSetup({ leagueId, token, datasetId }: LeagueSetupProps): React.ReactElement {
  const [league, setLeague] = useState<LeagueSummary | null>(null);
  const [teamList, setTeamList] = useState<TeamRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [aavSources, setAavSources] = useState<string[]>([]);
  const [readiness, setReadiness] = useState<{ items: ReadinessItem[]; all_ready: boolean } | null>(null);

  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [nameLock, setNameLock] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const [benchSlots, setBenchSlots] = useState('6');
  const [rosterSlots, setRosterSlots] = useState<RosterSlotRow[]>([
    { position: 'QB', priority: 1, is_starter: true, slot_count: 1 },
  ]);

  const [initialBudget, setInitialBudget] = useState('200');
  const [nominationTimer, setNominationTimer] = useState('30');
  const [secondBidTimer, setSecondBidTimer] = useState('15');
  const [rebidTimer, setRebidTimer] = useState('10');
  const [antiSnipeThreshold, setAntiSnipeThreshold] = useState('5');
  const [antiSnipeExtension, setAntiSnipeExtension] = useState('10');

  const [primarySource, setPrimarySource] = useState('');
  const [secondarySource, setSecondarySource] = useState('');

  const [whammyEnabled, setWhammyEnabled] = useState(false);
  const [whammyMaxAmount, setWhammyMaxAmount] = useState('5');
  const [whammyMaxPerTeam, setWhammyMaxPerTeam] = useState('');
  const [whammyMaxPerDraft, setWhammyMaxPerDraft] = useState('');
  const [whammyApprovalRequired, setWhammyApprovalRequired] = useState(false);

  const [passwordScope, setPasswordScope] = useState<'COMMISSIONER' | 'HOST' | 'TEAM'>('COMMISSIONER');
  const [passwordTeamId, setPasswordTeamId] = useState('');
  const [customPassword, setCustomPassword] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState<{ scope: string; password: string } | null>(null);

  function report(text: string): void {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? null : m)), 4000);
  }

  const refreshLeague = useCallback(() => {
    authedJson<LeagueSummary>(`/leagues/${leagueId}`, token)
      .then((l) => {
        setLeague(l);
        setName(l.name);
        setLogoUrl(l.logo_url ?? '');
        setNameLock(l.name_lock);
        setScheduledAt(toDatetimeLocal(l.scheduled_draft_start_at));
        setStatusMessage(l.status_message ?? '');
      })
      .catch(() => {});
  }, [leagueId, token]);

  const refreshTeams = useCallback(() => {
    authedJson<{ teams: TeamRow[] }>(`/leagues/${leagueId}/teams`, token)
      .then((d) => setTeamList(d.teams ?? []))
      .catch(() => {});
  }, [leagueId, token]);

  const refreshAavSources = useCallback(() => {
    authedJson<{ players: Array<{ aav_sources?: Array<{ source: string }> }> }>(`/leagues/${leagueId}/players`, token)
      .then((d) => {
        const sources = new Set<string>();
        for (const p of d.players ?? []) {
          for (const s of p.aav_sources ?? []) sources.add(s.source);
        }
        setAavSources([...sources]);
      })
      .catch(() => {});
  }, [leagueId, token]);

  const refreshReadiness = useCallback(() => {
    authedJson<{ items: ReadinessItem[]; all_ready: boolean }>(`/leagues/${leagueId}/readiness`, token)
      .then(setReadiness)
      .catch(() => {});
  }, [leagueId, token]);

  useEffect(() => {
    refreshLeague();
    refreshTeams();
    refreshAavSources();
    refreshReadiness();
  }, [refreshLeague, refreshTeams, refreshAavSources, refreshReadiness]);

  function submitIdentity(e: React.FormEvent): void {
    e.preventDefault();
    authedJson<LeagueSummary>(`/leagues/${leagueId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        logo_url: logoUrl || null,
        name_lock: nameLock,
        status_message: statusMessage || null,
        scheduled_draft_start_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      }),
    })
      .then((l) => {
        setLeague(l);
        report('League updated');
        refreshReadiness();
      })
      .catch((err: Error) => report(err.message));
  }

  function updateSlot(index: number, patch: Partial<RosterSlotRow>): void {
    setRosterSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addSlot(): void {
    setRosterSlots((prev) => [...prev, { position: '', priority: prev.length + 1, is_starter: true, slot_count: 1 }]);
  }

  function removeSlot(index: number): void {
    setRosterSlots((prev) => prev.filter((_, i) => i !== index));
  }

  function submitRosterConfig(e: React.FormEvent): void {
    e.preventDefault();
    const bench = parseInt(benchSlots, 10);
    if (!Number.isFinite(bench) || rosterSlots.length === 0) return;
    authedJson(`/leagues/${leagueId}/config/roster`, token, {
      method: 'PUT',
      body: JSON.stringify({ bench_slots: bench, slots: rosterSlots }),
    })
      .then(() => {
        report('Roster configuration saved');
        refreshReadiness();
      })
      .catch(() => report('Roster configuration is invalid'));
  }

  function submitAuctionConfig(e: React.FormEvent): void {
    e.preventDefault();
    const budgetMinor = Math.round(parseFloat(initialBudget) * 100);
    const nomMs = parseInt(nominationTimer, 10) * 1000;
    const secondMs = parseInt(secondBidTimer, 10) * 1000;
    const rebidMs = parseInt(rebidTimer, 10) * 1000;
    const snipeThresholdMs = parseInt(antiSnipeThreshold, 10) * 1000;
    const snipeExtMs = parseInt(antiSnipeExtension, 10) * 1000;
    if (![budgetMinor, nomMs, secondMs, rebidMs].every(Number.isFinite)) return;
    authedJson(`/leagues/${leagueId}/config/auction`, token, {
      method: 'PUT',
      body: JSON.stringify({
        initial_budget_minor: budgetMinor,
        nomination_timer_ms: nomMs,
        second_bid_timer_ms: secondMs,
        rebid_timer_ms: rebidMs,
        anti_snipe_threshold_ms: Number.isFinite(snipeThresholdMs) ? snipeThresholdMs : 0,
        anti_snipe_extension_ms: Number.isFinite(snipeExtMs) ? snipeExtMs : 0,
      }),
    })
      .then(() => {
        report('Auction configuration saved');
        refreshReadiness();
      })
      .catch(() => report('Auction configuration is invalid'));
  }

  function submitTeamBudgetOverride(teamId: string, value: string): void {
    const override = value.trim() === '' ? null : Math.round(parseFloat(value) * 100);
    if (override !== null && !Number.isFinite(override)) return;
    authedJson<TeamRow>(`/leagues/${leagueId}/teams/${teamId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ starting_budget_override_minor: override }),
    })
      .then(refreshTeams)
      .catch(() => report('Failed to update starting budget'));
  }

  function toggleTeamNameLock(team: TeamRow): void {
    authedJson<TeamRow>(`/leagues/${leagueId}/teams/${team.id}`, token, {
      method: 'PUT',
      body: JSON.stringify({ name_lock: !team.name_lock }),
    })
      .then(refreshTeams)
      .catch(() => report('Failed to update name lock'));
  }

  function moveTeam(index: number, dir: -1 | 1): void {
    const target = teamList[index + dir];
    const current = teamList[index];
    if (!target || !current) return;
    Promise.all([
      authedJson(`/leagues/${leagueId}/teams/${current.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ draft_order: target.draft_order }),
      }),
      authedJson(`/leagues/${leagueId}/teams/${target.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ draft_order: current.draft_order }),
      }),
    ])
      .then(refreshTeams)
      .catch(() => report('Failed to reorder teams'));
  }

  function submitAavSources(e: React.FormEvent): void {
    e.preventDefault();
    if (!primarySource || !datasetId) return;
    authedJson(`/leagues/${leagueId}/datasets/${datasetId}/aav-sources`, token, {
      method: 'PUT',
      body: JSON.stringify({
        primary_aav_source: primarySource,
        secondary_aav_source: secondarySource || null,
      }),
    })
      .then(() => {
        report('AAV sources saved');
        refreshReadiness();
      })
      .catch((err: Error) => report(err.message));
  }

  function submitWhammyConfig(e: React.FormEvent): void {
    e.preventDefault();
    authedJson(`/leagues/${leagueId}/config/whammy`, token, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: whammyEnabled,
        max_amount_minor: Math.round(parseFloat(whammyMaxAmount || '0') * 100),
        max_per_team: whammyMaxPerTeam ? parseInt(whammyMaxPerTeam, 10) : null,
        max_per_draft: whammyMaxPerDraft ? parseInt(whammyMaxPerDraft, 10) : null,
        commissioner_approval_required: whammyApprovalRequired,
      }),
    })
      .then(() => {
        report('Whammy configuration saved');
        refreshReadiness();
      })
      .catch(() => report('Whammy configuration is invalid'));
  }

  function submitGeneratePassword(e: React.FormEvent): void {
    e.preventDefault();
    if (passwordScope === 'TEAM' && !passwordTeamId) return;
    authedJson<{ scope: string; password: string }>(`/leagues/${leagueId}/passwords/generate`, token, {
      method: 'POST',
      body: JSON.stringify({
        scope: passwordScope,
        team_id: passwordScope === 'TEAM' ? passwordTeamId : undefined,
        custom_password: customPassword || null,
      }),
    })
      .then((res) => {
        setGeneratedPassword(res);
        setCustomPassword('');
      })
      .catch((err: Error) => report(err.message));
  }

  function handleTeamMediaChange(teamId: string, media: TeamMedia): void {
    setTeamList((prev) => prev.map((t) => (t.id === teamId ? { ...t, ...media } : t)));
  }

  return (
    <div className="league-setup">
      {message && <div className="league-setup__toast" role="status">{message}</div>}

      <section className="league-setup__panel" aria-label="League Identity">
        <h2 className="league-setup__heading">League Identity</h2>
        <form className="league-setup__form" onSubmit={submitIdentity}>
          <label htmlFor="league-name">League name</label>
          <input id="league-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="league-logo">Logo URL</label>
          <input id="league-logo" type="text" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
          <label className="league-setup__checkbox-label">
            <input type="checkbox" checked={nameLock} onChange={(e) => setNameLock(e.target.checked)} />
            Lock league name
          </label>
          <label htmlFor="scheduled-start">Scheduled draft start</label>
          <input
            id="scheduled-start"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <label htmlFor="status-message">Status message (shown to owners in the Lobby)</label>
          <textarea
            id="status-message"
            value={statusMessage}
            onChange={(e) => setStatusMessage(e.target.value)}
          />
          <button type="submit">Save League Identity</button>
        </form>
      </section>

      <section className="league-setup__panel" aria-label="Password Generation">
        <h2 className="league-setup__heading">Passwords</h2>
        <form className="league-setup__form" onSubmit={submitGeneratePassword}>
          <label htmlFor="password-scope">Scope</label>
          <select id="password-scope" value={passwordScope} onChange={(e) => setPasswordScope(e.target.value as typeof passwordScope)}>
            <option value="COMMISSIONER">Commissioner</option>
            <option value="HOST">Host</option>
            <option value="TEAM">Team</option>
          </select>
          {passwordScope === 'TEAM' && (
            <>
              <label htmlFor="password-team">Team</label>
              <select id="password-team" value={passwordTeamId} onChange={(e) => setPasswordTeamId(e.target.value)}>
                <option value="">Select team…</option>
                {teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </>
          )}
          <label htmlFor="custom-password">Custom password (optional — leave blank to generate)</label>
          <input id="custom-password" type="text" value={customPassword} onChange={(e) => setCustomPassword(e.target.value)} />
          <button type="submit" disabled={passwordScope === 'TEAM' && !passwordTeamId}>Generate</button>
        </form>
        {generatedPassword && (
          <p className="league-setup__generated-password" data-testid="generated-password">
            {generatedPassword.scope} password: <code>{generatedPassword.password}</code> (shown once — copy it now)
          </p>
        )}
      </section>

      <section className="league-setup__panel" aria-label="Roster Configuration">
        <h2 className="league-setup__heading">Roster Configuration</h2>
        <form className="league-setup__form" onSubmit={submitRosterConfig}>
          <label htmlFor="bench-slots">Bench slots</label>
          <input id="bench-slots" type="number" min={0} value={benchSlots} onChange={(e) => setBenchSlots(e.target.value)} />
          <table className="league-setup__slot-table">
            <thead>
              <tr><th>Position</th><th>Priority</th><th>Starter</th><th>Count</th><th /></tr>
            </thead>
            <tbody>
              {rosterSlots.map((slot, i) => (
                <tr key={i}>
                  <td><input type="text" value={slot.position} onChange={(e) => updateSlot(i, { position: e.target.value })} /></td>
                  <td><input type="number" min={1} value={slot.priority} onChange={(e) => updateSlot(i, { priority: parseInt(e.target.value, 10) || 1 })} /></td>
                  <td><input type="checkbox" checked={slot.is_starter} onChange={(e) => updateSlot(i, { is_starter: e.target.checked })} /></td>
                  <td><input type="number" min={1} value={slot.slot_count} onChange={(e) => updateSlot(i, { slot_count: parseInt(e.target.value, 10) || 1 })} /></td>
                  <td><button type="button" onClick={() => removeSlot(i)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={addSlot}>Add Slot</button>
          <button type="submit">Save Roster Configuration</button>
        </form>
      </section>

      <section className="league-setup__panel" aria-label="Auction Configuration">
        <h2 className="league-setup__heading">Auction Configuration</h2>
        <form className="league-setup__form" onSubmit={submitAuctionConfig}>
          <label htmlFor="initial-budget">Starting budget ($)</label>
          <input id="initial-budget" type="number" min={1} value={initialBudget} onChange={(e) => setInitialBudget(e.target.value)} />
          <label htmlFor="nomination-timer">Nomination timer (s)</label>
          <input id="nomination-timer" type="number" min={1} value={nominationTimer} onChange={(e) => setNominationTimer(e.target.value)} />
          <label htmlFor="second-bid-timer">Second-bid timer (s)</label>
          <input id="second-bid-timer" type="number" min={1} value={secondBidTimer} onChange={(e) => setSecondBidTimer(e.target.value)} />
          <label htmlFor="rebid-timer">Rebid timer (s)</label>
          <input id="rebid-timer" type="number" min={1} value={rebidTimer} onChange={(e) => setRebidTimer(e.target.value)} />
          <label htmlFor="anti-snipe-threshold">Anti-snipe threshold (s)</label>
          <input id="anti-snipe-threshold" type="number" min={0} value={antiSnipeThreshold} onChange={(e) => setAntiSnipeThreshold(e.target.value)} />
          <label htmlFor="anti-snipe-extension">Anti-snipe extension (s)</label>
          <input id="anti-snipe-extension" type="number" min={0} value={antiSnipeExtension} onChange={(e) => setAntiSnipeExtension(e.target.value)} />
          <button type="submit">Save Auction Configuration</button>
        </form>
      </section>

      <section className="league-setup__panel" aria-label="AAV Sources">
        <h2 className="league-setup__heading">AAV Sources</h2>
        <form className="league-setup__form" onSubmit={submitAavSources}>
          <label htmlFor="primary-source">Primary</label>
          <select id="primary-source" value={primarySource} onChange={(e) => setPrimarySource(e.target.value)} disabled={aavSources.length === 0}>
            <option value="">Select source…</option>
            {aavSources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label htmlFor="secondary-source">Secondary</label>
          <select id="secondary-source" value={secondarySource} onChange={(e) => setSecondarySource(e.target.value)} disabled={aavSources.length === 0}>
            <option value="">(none)</option>
            {aavSources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit" disabled={aavSources.length === 0 || !primarySource || !datasetId}>Save AAV Sources</button>
        </form>
      </section>

      <section className="league-setup__panel" aria-label="Whammy Configuration">
        <h2 className="league-setup__heading">Whammy Configuration</h2>
        <form className="league-setup__form" onSubmit={submitWhammyConfig}>
          <label className="league-setup__checkbox-label">
            <input type="checkbox" checked={whammyEnabled} onChange={(e) => setWhammyEnabled(e.target.checked)} />
            Enabled
          </label>
          <label htmlFor="whammy-max-amount">Max amount ($)</label>
          <input id="whammy-max-amount" type="number" min={0} value={whammyMaxAmount} onChange={(e) => setWhammyMaxAmount(e.target.value)} />
          <label htmlFor="whammy-max-per-team">Max per team (blank = unlimited)</label>
          <input id="whammy-max-per-team" type="number" min={0} value={whammyMaxPerTeam} onChange={(e) => setWhammyMaxPerTeam(e.target.value)} />
          <label htmlFor="whammy-max-per-draft">Max per draft (blank = unlimited)</label>
          <input id="whammy-max-per-draft" type="number" min={0} value={whammyMaxPerDraft} onChange={(e) => setWhammyMaxPerDraft(e.target.value)} />
          <label className="league-setup__checkbox-label">
            <input type="checkbox" checked={whammyApprovalRequired} onChange={(e) => setWhammyApprovalRequired(e.target.checked)} />
            Commissioner approval required
          </label>
          <button type="submit">Save Whammy Configuration</button>
        </form>
      </section>

      <section className="league-setup__panel league-setup__team-roster" aria-label="Team Roster">
        <h2 className="league-setup__heading">Teams</h2>
        <table className="league-setup__team-table">
          <thead>
            <tr><th>Order</th><th>Team</th><th>Starting Budget Override ($)</th><th>Name Lock</th><th>Media</th></tr>
          </thead>
          <tbody>
            {teamList.map((team, i) => (
              <tr key={team.id}>
                <td>
                  <button type="button" aria-label="Move up" onClick={() => moveTeam(i, -1)} disabled={i === 0}>↑</button>
                  <button type="button" aria-label="Move down" onClick={() => moveTeam(i, 1)} disabled={i === teamList.length - 1}>↓</button>
                  {team.draft_order}
                </td>
                <td>{team.name}</td>
                <td>
                  <input
                    type="number"
                    aria-label={`Starting budget override for ${team.name}`}
                    defaultValue={team.starting_budget_override_minor !== null ? team.starting_budget_override_minor / 100 : ''}
                    onBlur={(e) => submitTeamBudgetOverride(team.id, e.target.value)}
                  />
                </td>
                <td>
                  <button type="button" aria-pressed={team.name_lock} onClick={() => toggleTeamNameLock(team)}>
                    {team.name_lock ? 'Locked' : 'Unlocked'}
                  </button>
                </td>
                <td>
                  <TeamMediaUpload
                    leagueId={leagueId}
                    teamId={team.id}
                    token={token}
                    media={{ icon_url: team.icon_url, nomination_audio_url: team.nomination_audio_url }}
                    onChange={(media) => handleTeamMediaChange(team.id, media)}
                  />
                </td>
              </tr>
            ))}
            {teamList.length === 0 && (
              <tr><td colSpan={5} className="league-setup__idle-small">No teams yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="league-setup__panel league-setup__readiness" aria-label="Pre-Draft Readiness">
        <h2 className="league-setup__heading">
          Pre-Draft Readiness
          {readiness && (
            <span className={`league-setup__readiness-pill league-setup__readiness-pill--${readiness.all_ready ? 'ready' : 'not-ready'}`}>
              {readiness.all_ready ? 'READY' : 'NOT READY'}
            </span>
          )}
        </h2>
        <ul className="league-setup__readiness-list">
          {readiness?.items.map((item) => (
            <li key={item.key} className={`league-setup__readiness-item league-setup__readiness-item--${item.status.toLowerCase()}`}>
              <span className="league-setup__readiness-dot" aria-hidden="true" />
              <span>{item.label}</span>
              <span className="league-setup__readiness-status">{item.status}</span>
              {item.detail && <span className="league-setup__readiness-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      </section>

      {!league && <p className="league-setup__idle-small">Loading…</p>}
    </div>
  );
}
