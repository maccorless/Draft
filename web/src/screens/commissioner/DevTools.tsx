/**
 * League Setup — dev-only "Reload Test Data" control.
 *
 * Wipes the local dev database and reseeds one league, 12 teams, and the full
 * 2026 salary-cap player pool (server/db/seed-data.ts, via POST /dev/reseed).
 * The endpoint only exists when the server is running with NODE_ENV !==
 * 'production'; this button only renders on localhost as a second guard.
 */
import React, { useState } from 'react';
import './dev-tools.css';

interface ReseedResult {
  leagueId: string;
  draftId: string;
  teamCount: number;
  playerCount: number;
  sitePassword: string;
  commissionerPassword: string;
  teamPassword: string;
}

type ReseedState = 'idle' | 'loading' | 'done' | 'error';

const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const AUTH_STORAGE_KEY = 'draft.auth';

export function DevTools(): React.ReactElement | null {
  const [state, setState] = useState<ReseedState>('idle');
  const [result, setResult] = useState<ReseedResult | null>(null);
  const [error, setError] = useState('');

  if (!IS_LOCALHOST) return null;

  async function reload(): Promise<void> {
    if (
      !window.confirm(
        'This wipes ALL data in the local dev database and reseeds a fresh test league. Continue?',
      )
    ) {
      return;
    }
    setState('loading');
    setError('');
    try {
      const res = await fetch('/dev/reseed', { method: 'POST' });
      if (!res.ok) {
        setError(`Reseed failed (${res.status})`);
        setState('error');
        return;
      }
      const data = (await res.json()) as ReseedResult;
      setResult(data);
      setState('done');
      // The signed-in session's league_id no longer exists — clear it and
      // reload so the app re-enters DevAutoLogin against the new league.
      try {
        sessionStorage.removeItem(AUTH_STORAGE_KEY);
      } catch {
        // sessionStorage unavailable — the manual reload below still works.
      }
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setError('Cannot reach server');
      setState('error');
    }
  }

  return (
    <section className="dev-tools" aria-label="Developer tools">
      <h3 className="dev-tools__heading">Reload Test Data</h3>
      <p className="dev-tools__body">
        Wipes the local dev database and reseeds one league, 12 teams, and the full
        2026 player pool with real salary-cap values. Local development only.
      </p>
      <button
        type="button"
        className="dev-tools__button"
        onClick={() => void reload()}
        disabled={state === 'loading'}
        data-testid="reload-test-data-button"
      >
        {state === 'loading' ? 'Reloading…' : 'Reload Test Data'}
      </button>

      {state === 'error' && (
        <p className="dev-tools__error" role="alert">
          {error}
        </p>
      )}

      {state === 'done' && result && (
        <div className="dev-tools__result" data-testid="reload-test-data-result">
          <p>
            Done — {result.playerCount} players, {result.teamCount} teams seeded.
            Reloading…
          </p>
        </div>
      )}
    </section>
  );
}
