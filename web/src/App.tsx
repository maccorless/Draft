import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';

const styles = {
  center: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', minHeight: '100vh', fontFamily: 'sans-serif' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 8, width: 280 },
  input: { padding: '8px 10px', fontSize: 16, border: '1px solid #ccc', borderRadius: 4 },
  btn: { padding: '10px 0', fontSize: 16, background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' },
  error: { color: '#c00', margin: 0, fontSize: 14 },
};
import './screens/auth/auth.css';
import { Lobby } from './screens/lobby/index.js';
import { CommissionerConsole } from './screens/commissioner/index.js';
import { DraftRoom } from './screens/draft-room/index.js';
import { WarRoom } from './screens/war-room/index.js';
import { DraftComplete, type DraftSummaryReport } from './screens/draft-complete/index.js';

// Relative — goes through Vite's dev proxy (web/vite.config.ts) to the backend,
// so it works regardless of which port the backend actually listens on.
const API = '';

// ── Auth state ────────────────────────────────────────────────────────────────

interface League { id: string; name: string }
interface Team { id: string; name: string; draft_order: number }
interface AuthState {
  token: string;
  role: 'COMMISSIONER' | 'OWNER';
  leagueId: string;
  leagueName: string;
  teamId?: string;
  teamName?: string;
}

// Session-scoped (not persisted across browser restarts) — matches the token's
// own ~48h lifetime and lets a second "synchronized window" (Draft Room + War
// Room open together, per PRD) share the same team identity without logging
// in twice, while still respecting the "no account, session-scoped" auth model.
const AUTH_STORAGE_KEY = 'draft.auth';

function loadStoredAuth(): AuthState | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function storeAuth(auth: AuthState | null): void {
  try {
    if (auth) sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    else sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable (e.g. private browsing) — session just won't
    // survive opening a second window; not fatal.
  }
}

// ── Site password screen ──────────────────────────────────────────────────────

export function SiteLogin({ onLeagues }: { onLeagues: (leagues: League[], sitePass: string) => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/auth/site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_password: pass }),
      });
      if (res.status === 429) { setError('Too many attempts — wait a minute and try again'); return; }
      if (!res.ok) { setError('Wrong site password'); return; }
      const { leagues } = await res.json();
      onLeagues(leagues, pass);
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <h1 className="auth-screen__title">Draft Platform</h1>
      <form onSubmit={submit} className="auth-screen__form">
        <label className="auth-screen__label" htmlFor="site-password">Site password</label>
        <input
          id="site-password"
          type="password"
          value={pass}
          onChange={e => setPass(e.target.value)}
          className="auth-screen__input"
          autoFocus
        />
        {error && <p className="auth-screen__error">{error}</p>}
        <button type="submit" disabled={loading} className="auth-screen__button">
          {loading ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

// ── League + role selection ───────────────────────────────────────────────────

export function LeagueLogin({
  leagues, sitePass, onAuth
}: {
  leagues: League[];
  sitePass: string;
  onAuth: (auth: AuthState) => void;
}) {
  const [leagueId, setLeagueId] = useState(leagues[0]?.id ?? '');
  const [role, setRole] = useState<'COMMISSIONER' | 'OWNER'>('COMMISSIONER');
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState('');
  const [teamsError, setTeamsError] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const league = leagues.find(l => l.id === leagueId);

  // Owner path (screen-information-architecture.md §0 step 4): fetch this
  // league's teams so the owner can pick which one they're signing into.
  // No league JWT exists yet at this point — gated by the site password
  // instead, same model as /auth/site.
  React.useEffect(() => {
    if (role !== 'OWNER' || !leagueId) { setTeams([]); return; }
    setTeamsError('');
    fetch(`${API}/auth/league/${leagueId}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_password: sitePass }),
    })
      .then(async res => {
        if (!res.ok) { setTeamsError('Could not load teams for this league'); return; }
        const data = await res.json();
        setTeams(data.teams ?? []);
        setTeamId(data.teams?.[0]?.id ?? '');
      })
      .catch(() => setTeamsError('Could not load teams for this league'));
  }, [role, leagueId, sitePass]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/auth/league/${leagueId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          role === 'OWNER' ? { role, team_id: teamId, password: pass } : { role, password: pass },
        ),
      });
      if (!res.ok) { setError('Wrong password'); return; }
      const { token } = await res.json();
      const team = teams.find(t => t.id === teamId);
      onAuth({
        token,
        role,
        leagueId,
        leagueName: league?.name ?? '',
        teamId: role === 'OWNER' ? teamId : undefined,
        teamName: role === 'OWNER' ? (team?.name ?? 'My Team') : undefined,
      });
    } catch {
      setError('Server error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <h1 className="auth-screen__title">Select League</h1>
      <form onSubmit={submit} className="auth-screen__form">
        <label className="auth-screen__label" htmlFor="league-select">League</label>
        <select
          id="league-select"
          value={leagueId}
          onChange={e => setLeagueId(e.target.value)}
          className="auth-screen__input"
        >
          {leagues.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="auth-screen__label" htmlFor="role-select">Role</label>
        <select
          id="role-select"
          value={role}
          onChange={e => setRole(e.target.value as 'COMMISSIONER' | 'OWNER')}
          className="auth-screen__input"
        >
          <option value="COMMISSIONER">Commissioner</option>
          <option value="OWNER">Owner</option>
        </select>
        {role === 'OWNER' && (
          <>
            <label className="auth-screen__label" htmlFor="team-select">Team</label>
            {teamsError ? (
              <p className="auth-screen__error">{teamsError}</p>
            ) : (
              <select
                id="team-select"
                value={teamId}
                onChange={e => setTeamId(e.target.value)}
                className="auth-screen__input"
              >
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </>
        )}
        <label className="auth-screen__label" htmlFor="league-password">Password</label>
        <input
          id="league-password"
          type="password"
          value={pass}
          onChange={e => setPass(e.target.value)}
          className="auth-screen__input"
        />
        {error && <p className="auth-screen__error">{error}</p>}
        <button
          type="submit"
          disabled={loading || (role === 'OWNER' && !teamId)}
          className="auth-screen__button"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ── Root with auth flow ───────────────────────────────────────────────────────

function CommissionerRoute({ auth }: { auth: AuthState }) {
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [datasetStatus, setDatasetStatus] = useState<'DRAFT' | 'VALIDATED' | 'FROZEN' | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState('');

  React.useEffect(() => {
    fetch(`${API}/leagues/${auth.leagueId}/datasets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: '{}',
    })
      .then(async res => {
        if (!res.ok) { setError(`Failed to create dataset (${res.status})`); return; }
        const data = await res.json();
        setDatasetId(data.id);
        setDatasetStatus(data.status);
      })
      .catch(() => setError('Cannot reach server'));
  }, [auth.leagueId, auth.token]);

  // Draft Control (F-MOD-011) operates whichever draft is currently active —
  // same "pick the most relevant draft" logic DraftGateway uses for owners.
  React.useEffect(() => {
    fetch(`${API}/leagues/${auth.leagueId}/drafts`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
      .then(async res => {
        if (!res.ok) return;
        const data = await res.json();
        const active = pickActiveDraft(data.drafts ?? []);
        setDraftId(active?.id ?? null);
      })
      .catch(() => {});
  }, [auth.leagueId, auth.token]);

  if (error) return <div style={styles.center}><p style={styles.error}>{error}</p></div>;
  if (!datasetId) return <div style={styles.center}><p>Setting up dataset…</p></div>;

  return (
    <CommissionerConsole
      token={auth.token}
      leagueId={auth.leagueId}
      datasetId={datasetId}
      datasetStatus={datasetStatus}
      draftId={draftId}
    />
  );
}

// ── Owner landing: find the league's draft, route to the right place ──────────

interface DraftSummary {
  id: string;
  status: 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETE';
}

const STATUS_PRIORITY: Record<DraftSummary['status'], number> = {
  RUNNING: 0,
  PAUSED: 1,
  CREATED: 2,
  COMPLETE: 3,
};

function pickActiveDraft(drafts: DraftSummary[]): DraftSummary | null {
  if (drafts.length === 0) return null;
  return [...drafts].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])[0] ?? null;
}

function DraftGateway({ auth }: { auth: AuthState }) {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);

  React.useEffect(() => {
    fetch(`${API}/leagues/${auth.leagueId}/drafts`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
      .then(async res => {
        if (!res.ok) { setError(`Failed to load drafts (${res.status})`); return; }
        const data = await res.json();
        setDrafts(data.drafts ?? []);
      })
      .catch(() => setError('Cannot reach server'));
  }, [auth.leagueId, auth.token]);

  // GET /leagues/:id (MOD-010) — status_message and scheduled_draft_start_at
  // for the Lobby header; accepts this OWNER token since MOD-010 widened the
  // route's auth from commissioner-only to any valid league member.
  React.useEffect(() => {
    fetch(`${API}/leagues/${auth.leagueId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
      .then(async res => {
        if (!res.ok) return;
        const data = await res.json();
        setStatusMessage(data.status_message ?? null);
        setScheduledAt(data.scheduled_draft_start_at ?? null);
      })
      .catch(() => {});
  }, [auth.leagueId, auth.token]);

  if (error) return <div style={styles.center}><p style={styles.error}>{error}</p></div>;
  if (drafts === null) return <div style={styles.center}><p>Loading…</p></div>;

  const active = pickActiveDraft(drafts);

  if (active && (active.status === 'RUNNING' || active.status === 'PAUSED')) {
    return <Navigate to={`/draft-room?draftId=${active.id}`} replace />;
  }

  // screen-information-architecture.md §18: an owner authenticating after
  // the draft has ended lands at the Draft Summary Report directly, never
  // at the Pre-Draft Lobby (which is UPCOMING-only, §0.1).
  if (active && active.status === 'COMPLETE') {
    return <Navigate to={`/draft-complete?draftId=${active.id}`} replace />;
  }

  return (
    <div>
      <Lobby
        leagueName={auth.leagueName}
        teamName={auth.teamName ?? 'My Team'}
        scheduledAt={scheduledAt}
        draftStatus={active?.status ?? 'CREATED'}
        leagueId={auth.leagueId}
        teamId={auth.teamId ?? null}
        token={auth.token}
        draftId={active?.id ?? null}
        statusMessage={statusMessage}
      />
      {active && (
        <div style={{ ...styles.center, minHeight: 'auto', paddingBottom: 32 }}>
          <a
            href={`/war-room?draftId=${active.id}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#1a73e8' }}
          >
            Open War Room ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ── Draft Room / War Room routes (draftId from URL — each is its own window) ──

function DraftRoomRoute({ auth }: { auth: AuthState }) {
  const [params] = useSearchParams();
  const draftId = params.get('draftId');
  if (!draftId) return <div style={styles.center}><p style={styles.error}>Missing draftId</p></div>;
  return <DraftRoom draftId={draftId} leagueId={auth.leagueId} token={auth.token} teamId={auth.teamId ?? null} />;
}

function WarRoomRoute({ auth }: { auth: AuthState }) {
  const [params] = useSearchParams();
  const draftId = params.get('draftId');
  if (!draftId) return <div style={styles.center}><p style={styles.error}>Missing draftId</p></div>;
  return <WarRoom draftId={draftId} leagueId={auth.leagueId} token={auth.token} teamId={auth.teamId ?? null} />;
}

// ── Draft Complete route ───────────────────────────────────────────────────────

function DraftCompleteRoute({ auth }: { auth: AuthState }) {
  const [params] = useSearchParams();
  const draftId = params.get('draftId');
  const [report, setReport] = useState<DraftSummaryReport | null>(null);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (!draftId) return;
    fetch(`${API}/drafts/${draftId}/report`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
      .then(async (res) => {
        if (!res.ok) { setError(`Failed to load report (${res.status})`); return; }
        setReport(await res.json());
      })
      .catch(() => setError('Cannot reach server'));
  }, [draftId, auth.token]);

  if (!draftId) return <div style={styles.center}><p style={styles.error}>Missing draftId</p></div>;
  if (error) return <div style={styles.center}><p style={styles.error}>{error}</p></div>;
  if (!report) return <div style={styles.center}><p>Loading report…</p></div>;

  return (
    <DraftComplete
      draftId={draftId}
      report={report}
      isCommissioner={auth.role === 'COMMISSIONER'}
      currentTeamId={auth.teamId ?? null}
    />
  );
}

// ponytail: localhost-only dev shortcut, skips the two login screens using the seed.ts credentials
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
// Must match server/db/seed.ts's SITE_PASSWORD / COMMISSIONER_PASSWORD exactly.
const DEV_SITE_PASSWORD = 'draft2026!';
const DEV_COMMISSIONER_PASSWORD = 'commissioner2026!';

// Commissioner-only: OWNER auto-login would need a team_id, which requires an
// authed call to fetch — chicken-and-egg for a pre-login shortcut.
function DevAutoLogin({ onAuth }: { onAuth: (auth: AuthState) => void }) {
  const [error, setError] = useState('');

  React.useEffect(() => {
    (async () => {
      try {
        const siteRes = await fetch(`${API}/auth/site`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ site_password: DEV_SITE_PASSWORD }),
        });
        if (!siteRes.ok) { setError(`Dev auto-login failed at site step (${siteRes.status}) — re-run npm run db:seed?`); return; }
        const { leagues }: { leagues: League[] } = await siteRes.json();
        const league = leagues[0];
        if (!league) { setError('No leagues found — run npm run db:seed (from server/), or use Reload Test Data in the Commissioner Console'); return; }

        const leagueRes = await fetch(`${API}/auth/league/${league.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'COMMISSIONER', password: DEV_COMMISSIONER_PASSWORD }),
        });
        if (!leagueRes.ok) { setError(`Dev auto-login failed at league step (${leagueRes.status})`); return; }
        const { token } = await leagueRes.json();
        onAuth({ token, role: 'COMMISSIONER', leagueId: league.id, leagueName: league.name });
      } catch {
        setError('Cannot reach server');
      }
    })();
  }, [onAuth]);

  return <div style={styles.center}><p>{error || 'Signing in…'}</p></div>;
}

export function App() {
  const [step, setStep] = useState<'site' | 'league' | 'app'>('site');
  const [leagues, setLeagues] = useState<League[]>([]);
  const [sitePass, setSitePass] = useState('');
  const [auth, setAuthState] = useState<AuthState | null>(() => loadStoredAuth());

  function setAuth(a: AuthState | null): void {
    storeAuth(a);
    setAuthState(a);
  }

  if (!auth && IS_LOCALHOST) {
    return <DevAutoLogin onAuth={setAuth} />;
  }

  if (!auth && step === 'site') {
    return <SiteLogin onLeagues={(l, p) => { setLeagues(l); setSitePass(p); setStep('league'); }} />;
  }
  if (step === 'league' || !auth) {
    return <LeagueLogin leagues={leagues} sitePass={sitePass} onAuth={a => { setAuth(a); setStep('app'); }} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={
          auth.role === 'COMMISSIONER'
            ? <Navigate to="/commissioner" replace />
            : <Navigate to="/lobby" replace />
        } />
        <Route path="/commissioner" element={<CommissionerRoute auth={auth} />} />
        <Route path="/lobby" element={<DraftGateway auth={auth} />} />
        <Route path="/draft-room" element={<DraftRoomRoute auth={auth} />} />
        <Route path="/war-room" element={<WarRoomRoute auth={auth} />} />
        <Route path="/draft-complete" element={<DraftCompleteRoute auth={auth} />} />
      </Routes>
    </BrowserRouter>
  );
}
