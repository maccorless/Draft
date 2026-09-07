/**
 * Teams tab — Commissioner Console (CC-1a).
 * Add, edit name/password, remove, and upload nomination audio per team.
 * Uses existing API contracts:
 *   POST   /leagues/:leagueId/teams                    — create
 *   GET    /leagues/:leagueId/teams                    — list
 *   PUT    /leagues/:leagueId/teams/:teamId            — update name/budget/order
 *   DELETE /leagues/:leagueId/teams/:teamId            — remove (409 if draft started)
 *   POST   /leagues/:leagueId/passwords/generate       — reset team password
 *   POST   /leagues/:leagueId/teams/:teamId/media      — upload nomination audio
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface TeamsTabProps {
  leagueId: string;
  token: string;
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

async function authedJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { code?: string; message?: string } | null;
    const err = new Error(body?.message ?? `Request failed (${res.status})`);
    (err as Error & { code?: string }).code = body?.code;
    throw err;
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export function TeamsTab({ leagueId, token }: TeamsTabProps): React.ReactElement {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add-team form
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newBudget, setNewBudget] = useState('');

  // Per-row edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editBudget, setEditBudget] = useState('');

  // Per-row delete confirm
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // One-time generated password reveal
  const [shownPassword, setShownPassword] = useState<{ teamId: string; password: string } | null>(null);

  // Feedback
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Audio upload refs keyed by teamId (one hidden input per row)
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [audioUploadTeamId, setAudioUploadTeamId] = useState<string | null>(null);

  function flash(msg: string): void {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg((m) => (m === msg ? null : m)), 4000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await authedJson<{ teams: TeamRow[] }>(
        `/leagues/${leagueId}/teams`,
        token,
      );
      setTeams(data.teams.sort((a, b) => a.draft_order - b.draft_order));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [leagueId, token]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd(): Promise<void> {
    if (!newName.trim() || !newPassword.trim()) {
      setOpError('Name and password are required.');
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      const nextOrder = teams.length > 0
        ? Math.max(...teams.map((t) => t.draft_order)) + 1
        : 1;
      await authedJson<unknown>(`/leagues/${leagueId}/teams`, token, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), team_password: newPassword.trim(), draft_order: nextOrder }),
      });
      setNewName('');
      setNewPassword('');
      setNewBudget('');
      setAdding(false);
      flash('Team added.');
      await load();
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(team: TeamRow): void {
    setEditingId(team.id);
    setEditName(team.name);
    setEditPassword('');
    setEditBudget(
      team.starting_budget_override_minor !== null
        ? String(team.starting_budget_override_minor / 100)
        : '',
    );
    setOpError(null);
    setShownPassword(null);
  }

  async function handleSaveEdit(teamId: string): Promise<void> {
    setBusy(true);
    setOpError(null);
    try {
      const budgetMinor = editBudget.trim()
        ? Math.round(parseFloat(editBudget) * 100)
        : null;

      // Name / budget update via PUT
      await authedJson<unknown>(`/leagues/${leagueId}/teams/${teamId}`, token, {
        method: 'PUT',
        body: JSON.stringify({
          name: editName.trim() || undefined,
          starting_budget_override_minor: budgetMinor,
        }),
      });

      // Password change via generate endpoint (plaintext shown once)
      if (editPassword.trim()) {
        const result = await authedJson<{ password: string }>(
          `/leagues/${leagueId}/passwords/generate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ scope: 'TEAM', team_id: teamId, custom_password: editPassword.trim() }),
          },
        );
        setShownPassword({ teamId, password: result.password });
      }

      setEditingId(null);
      flash('Team updated.');
      await load();
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(teamId: string): Promise<void> {
    setBusy(true);
    setOpError(null);
    try {
      await authedJson<unknown>(`/leagues/${leagueId}/teams/${teamId}`, token, {
        method: 'DELETE',
      });
      setConfirmDeleteId(null);
      flash('Team removed.');
      await load();
    } catch (err) {
      const errWithCode = err as Error & { code?: string };
      if (errWithCode.code === 'DRAFT_ALREADY_STARTED') {
        setOpError('Cannot remove during or after draft.');
      } else {
        setOpError(errWithCode.message);
      }
      setConfirmDeleteId(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleAudioFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !audioUploadTeamId) return;
    const teamId = audioUploadTeamId;
    setAudioUploadTeamId(null);
    setBusy(true);
    setOpError(null);
    try {
      const form = new FormData();
      form.append('nomination_audio', file);
      const res = await fetch(`/leagues/${leagueId}/teams/${teamId}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `Upload failed (${res.status})`);
      }
      flash('Audio uploaded.');
      await load();
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function triggerAudioUpload(teamId: string): void {
    setAudioUploadTeamId(teamId);
    setTimeout(() => audioInputRef.current?.click(), 0);
  }

  if (loading) {
    return <p className="league-setup__idle-small">Loading teams...</p>;
  }
  if (loadError) {
    return <p className="league-setup__idle-small" style={{ color: 'var(--color-danger)' }}>{loadError}</p>;
  }

  const confirmTeam = teams.find((t) => t.id === confirmDeleteId);

  return (
    <div className="league-setup">
      {/* Hidden audio input shared across all rows */}
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/mpeg,.mp3"
        style={{ display: 'none' }}
        aria-hidden="true"
        onChange={handleAudioFile}
      />

      <div className="league-setup__panel" style={{ gridColumn: '1 / -1' }}>
        <h2 className="league-setup__heading">Teams</h2>

        {opError && (
          <p role="alert" style={{ color: 'var(--color-danger)', marginBottom: 'var(--space-3)' }}>
            {opError}
          </p>
        )}
        {successMsg && (
          <p role="status" style={{ color: 'var(--color-success)', marginBottom: 'var(--space-3)' }}>
            {successMsg}
          </p>
        )}

        {teams.length === 0 && !adding && (
          <p className="league-setup__idle-small">No teams yet. Add the first one below.</p>
        )}

        {teams.length > 0 && (
          <div style={{ overflowX: 'auto', marginBottom: 'var(--space-4)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Password</th>
                  <th style={thStyle}>Budget Override</th>
                  <th style={thStyle}>Nomination Audio</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((team) => {
                  const isEditing = editingId === team.id;
                  const isConfirming = confirmDeleteId === team.id;
                  const shownPw = shownPassword?.teamId === team.id ? shownPassword.password : null;

                  if (isEditing) {
                    return (
                      <tr key={team.id} style={{ background: 'var(--color-surface-raised)' }}>
                        <td style={tdStyle}>{team.draft_order}</td>
                        <td style={tdStyle}>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            style={inputStyle}
                            aria-label="Team name"
                          />
                        </td>
                        <td style={tdStyle}>
                          <input
                            type="text"
                            value={editPassword}
                            onChange={(e) => setEditPassword(e.target.value)}
                            placeholder="New password (leave blank to keep)"
                            style={inputStyle}
                            aria-label="New team password"
                          />
                        </td>
                        <td style={tdStyle}>
                          <input
                            type="number"
                            value={editBudget}
                            onChange={(e) => setEditBudget(e.target.value)}
                            placeholder="default"
                            min={0}
                            style={{ ...inputStyle, width: '80px' }}
                            aria-label="Budget override in dollars"
                          />
                        </td>
                        <td style={tdStyle}>
                          {team.nomination_audio_url
                            ? <span title={team.nomination_audio_url}>Uploaded</span>
                            : <span style={{ color: 'var(--color-text-subtle)' }}>none</span>}
                        </td>
                        <td style={tdStyle}>
                          <button
                            type="button"
                            onClick={() => void handleSaveEdit(team.id)}
                            disabled={busy}
                            style={btnStyle}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingId(null); setOpError(null); }}
                            disabled={busy}
                            style={{ ...btnStyle, marginLeft: 'var(--space-2)' }}
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={team.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={tdStyle}>{team.draft_order}</td>
                      <td style={tdStyle}>{team.name}</td>
                      <td style={tdStyle}>
                        {shownPw ? (
                          <span style={{ fontFamily: 'monospace', color: 'var(--color-accent)' }}>
                            {shownPw}{' '}
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-subtle)' }}>(shown once)</span>
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-text-subtle)' }}>••••••••</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {team.starting_budget_override_minor !== null
                          ? `$${(team.starting_budget_override_minor / 100).toFixed(0)}`
                          : <span style={{ color: 'var(--color-text-subtle)' }}>default</span>}
                      </td>
                      <td style={tdStyle}>
                        {team.nomination_audio_url
                          ? <span title={team.nomination_audio_url}>Uploaded</span>
                          : <span style={{ color: 'var(--color-text-subtle)' }}>none</span>}
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          onClick={() => startEdit(team)}
                          disabled={busy}
                          style={btnStyle}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => triggerAudioUpload(team.id)}
                          disabled={busy}
                          style={{ ...btnStyle, marginLeft: 'var(--space-2)' }}
                          title="Upload MP3 nomination audio"
                        >
                          {team.nomination_audio_url ? 'Replace Audio' : 'Upload Audio'}
                        </button>
                        {isConfirming ? (
                          <>
                            <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                              Remove {confirmTeam?.name}?{' '}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleDelete(team.id)}
                              disabled={busy}
                              style={{ ...btnStyle, marginLeft: 'var(--space-2)', color: 'var(--color-danger)' }}
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              disabled={busy}
                              style={{ ...btnStyle, marginLeft: 'var(--space-2)' }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setConfirmDeleteId(team.id); setOpError(null); }}
                            disabled={busy}
                            style={{ ...btnStyle, marginLeft: 'var(--space-2)' }}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {adding ? (
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
            <label style={labelStyle}>
              Name *
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={inputStyle}
                autoFocus
                aria-label="New team name"
              />
            </label>
            <label style={labelStyle}>
              Password *
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                style={inputStyle}
                aria-label="New team password"
              />
            </label>
            <label style={labelStyle}>
              Budget Override ($)
              <input
                type="number"
                value={newBudget}
                onChange={(e) => setNewBudget(e.target.value)}
                placeholder="default"
                min={0}
                style={{ ...inputStyle, width: '100px' }}
                aria-label="Budget override in dollars"
              />
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <button type="button" onClick={() => void handleAdd()} disabled={busy} style={btnStyle}>
                Add Team
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setNewName(''); setNewPassword(''); setNewBudget(''); setOpError(null); }}
                disabled={busy}
                style={btnStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setAdding(true); setOpError(null); }}
            disabled={busy}
            style={btnStyle}
          >
            + Add Team
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Inline style tokens (matches commissioner CSS variable names) ─────────────

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--color-text-subtle)',
  fontWeight: 'var(--font-weight-semibold)' as React.CSSProperties['fontWeight'],
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  verticalAlign: 'middle',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 'var(--space-1) var(--space-2)',
  background: 'var(--color-input-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-sm)',
};

const btnStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
  fontSize: 'var(--text-sm)',
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-subtle)',
};
