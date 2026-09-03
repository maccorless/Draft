import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

const styles = {
  center: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', minHeight: '100vh', fontFamily: 'sans-serif' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 8, width: 280 },
  input: { padding: '8px 10px', fontSize: 16, border: '1px solid #ccc', borderRadius: 4 },
  btn: { padding: '10px 0', fontSize: 16, background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' },
  error: { color: '#c00', margin: 0, fontSize: 14 },
};
import { Lobby } from './screens/lobby/index.js';
import { CommissionerConsole } from './screens/commissioner/index.js';

// Relative — goes through Vite's dev proxy (web/vite.config.ts) to the backend,
// so it works regardless of which port the backend actually listens on.
const API = '';

// ── Auth state ────────────────────────────────────────────────────────────────

interface League { id: string; name: string }
interface AuthState {
  token: string;
  role: 'COMMISSIONER' | 'OWNER';
  leagueId: string;
  leagueName: string;
  teamName?: string;
}

// ── Site password screen ──────────────────────────────────────────────────────

function SiteLogin({ onLeagues }: { onLeagues: (leagues: League[], sitePass: string) => void }) {
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
    <div style={styles.center}>
      <h1>Draft Platform</h1>
      <form onSubmit={submit} style={styles.form}>
        <label>Site password</label>
        <input type="password" value={pass} onChange={e => setPass(e.target.value)}
          style={styles.input} autoFocus />
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" disabled={loading} style={styles.btn}>
          {loading ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

// ── League + role selection ───────────────────────────────────────────────────

function LeagueLogin({
  leagues, sitePass, onAuth
}: {
  leagues: League[];
  sitePass: string;
  onAuth: (auth: AuthState) => void;
}) {
  const [leagueId, setLeagueId] = useState(leagues[0]?.id ?? '');
  const [role, setRole] = useState<'COMMISSIONER' | 'OWNER'>('COMMISSIONER');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const league = leagues.find(l => l.id === leagueId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/auth/league/${leagueId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, password: pass }),
      });
      if (!res.ok) { setError('Wrong password'); return; }
      const { token } = await res.json();
      onAuth({ token, role, leagueId, leagueName: league?.name ?? '', teamName: role === 'OWNER' ? 'My Team' : undefined });
    } catch {
      setError('Server error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.center}>
      <h1>Select League</h1>
      <form onSubmit={submit} style={styles.form}>
        <label>League</label>
        <select value={leagueId} onChange={e => setLeagueId(e.target.value)} style={styles.input}>
          {leagues.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label>Role</label>
        <select value={role} onChange={e => setRole(e.target.value as 'COMMISSIONER' | 'OWNER')} style={styles.input}>
          <option value="COMMISSIONER">Commissioner</option>
          <option value="OWNER">Owner</option>
        </select>
        <label>Password</label>
        <input type="password" value={pass} onChange={e => setPass(e.target.value)} style={styles.input} />
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" disabled={loading} style={styles.btn}>
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

  if (error) return <div style={styles.center}><p style={styles.error}>{error}</p></div>;
  if (!datasetId) return <div style={styles.center}><p>Setting up dataset…</p></div>;

  return (
    <CommissionerConsole
      token={auth.token}
      leagueId={auth.leagueId}
      datasetId={datasetId}
      datasetStatus={datasetStatus}
    />
  );
}

// ponytail: localhost-only dev shortcut, skips the two login screens using the seed.ts credentials
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const DEV_SITE_PASSWORD = 'draft2026';
const DEV_COMMISSIONER_PASSWORD = 'commish2026';

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
        if (!siteRes.ok) { setError(`Dev auto-login failed at site step (${siteRes.status}) — re-run seed.ts?`); return; }
        const { leagues }: { leagues: League[] } = await siteRes.json();
        const league = leagues[0];
        if (!league) { setError('No leagues found — run server/src/seed.ts'); return; }

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
  const [auth, setAuth] = useState<AuthState | null>(null);

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
        <Route path="/lobby" element={
          <Lobby
            leagueName={auth.leagueName}
            teamName={auth.teamName ?? 'My Team'}
            scheduledAt={null}
            draftStatus="CREATED"
          />
        } />
      </Routes>
    </BrowserRouter>
  );
}
