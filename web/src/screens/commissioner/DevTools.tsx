/**
 * League Setup — dev-only test-data management controls.
 *
 * Three layers of dev data (server/db/seed-data.ts):
 *   1. Core league (league/teams/roster+auction config) — never wiped here.
 *   2. Player/AAV master data — wiped/reloaded by "Reload Player Data".
 *   3. The draft instance itself — wiped/reset by "Reset Draft", the
 *      everyday test-run action.
 * "Reload Test Data" remains the nuclear option that rebuilds all three.
 * Every endpoint here only exists when the server runs with NODE_ENV !==
 * 'production'; these buttons only render on localhost as a second guard.
 */
import React, { useState } from 'react';
import './dev-tools.css';

type ActionState = 'idle' | 'loading' | 'done' | 'error';

const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const AUTH_STORAGE_KEY = 'draft.auth';

function clearSessionAndReload(): void {
  try {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable — the manual reload below still works.
  }
  setTimeout(() => window.location.reload(), 1500);
}

interface DevAction {
  key: string;
  endpoint: string;
  confirmMessage: string;
  heading: string;
  body: string;
  buttonLabel: string;
  loadingLabel: string;
  describeResult: (data: Record<string, unknown>) => string;
}

const ACTIONS: DevAction[] = [
  {
    key: 'reset-draft',
    endpoint: '/dev/reset-draft',
    confirmMessage:
      'This wipes the current draft (bids, rosters, budget ledger) and starts a fresh CREATED draft. League, teams, and player data are untouched. Continue?',
    heading: 'Reset Draft',
    body: 'Wipes the current draft instance only and creates a fresh CREATED draft against the existing player dataset. Fastest everyday reset for testing.',
    buttonLabel: 'Reset Draft',
    loadingLabel: 'Resetting…',
    describeResult: () => 'Done — fresh draft created.',
  },
  {
    key: 'reload-players',
    endpoint: '/dev/reload-players',
    confirmMessage:
      'This wipes the player/AAV dataset AND the current draft, then reloads players from the CSV. League and teams are untouched. Continue?',
    heading: 'Reload Player Data',
    body: 'Wipes the player pool and current draft, then reloads the full 2026 player pool from CSV into a fresh dataset and draft. Use when player/AAV data changes.',
    buttonLabel: 'Reload Player Data',
    loadingLabel: 'Reloading…',
    describeResult: (data) => `Done — ${data['playerCount']} players reloaded, fresh draft created.`,
  },
  {
    key: 'reseed',
    endpoint: '/dev/reseed',
    confirmMessage: 'This wipes ALL data in the local dev database and reseeds a fresh test league. Continue?',
    heading: 'Reload Test Data',
    body: 'Wipes the local dev database and reseeds the league, 12 teams, and the full 2026 player pool with real salary-cap values. Local development only.',
    buttonLabel: 'Reload Test Data',
    loadingLabel: 'Reloading…',
    describeResult: (data) => `Done — ${data['playerCount']} players, ${data['teamCount']} teams seeded. Reloading…`,
  },
];

function DevAction({ action }: { action: DevAction }): React.ReactElement {
  const [state, setState] = useState<ActionState>('idle');
  const [resultText, setResultText] = useState('');
  const [error, setError] = useState('');

  async function run(): Promise<void> {
    if (!window.confirm(action.confirmMessage)) return;
    setState('loading');
    setError('');
    try {
      const res = await fetch(action.endpoint, { method: 'POST' });
      if (!res.ok) {
        setError(`${action.heading} failed (${res.status})`);
        setState('error');
        return;
      }
      const data = (await res.json()) as Record<string, unknown>;
      setResultText(action.describeResult(data));
      setState('done');
      // The signed-in session's draft/league state changed underneath it —
      // clear and reload so the app re-enters cleanly.
      clearSessionAndReload();
    } catch {
      setError('Cannot reach server');
      setState('error');
    }
  }

  return (
    <div className="dev-tools__action">
      <h3 className="dev-tools__heading">{action.heading}</h3>
      <p className="dev-tools__body">{action.body}</p>
      <button
        type="button"
        className="dev-tools__button"
        onClick={() => void run()}
        disabled={state === 'loading'}
        data-testid={`${action.key}-button`}
      >
        {state === 'loading' ? action.loadingLabel : action.buttonLabel}
      </button>

      {state === 'error' && (
        <p className="dev-tools__error" role="alert">
          {error}
        </p>
      )}

      {state === 'done' && (
        <div className="dev-tools__result" data-testid={`${action.key}-result`}>
          <p>{resultText}</p>
        </div>
      )}
    </div>
  );
}

export function DevTools(): React.ReactElement | null {
  if (!IS_LOCALHOST) return null;

  return (
    <section className="dev-tools" aria-label="Developer tools">
      {ACTIONS.map((action) => (
        <DevAction key={action.key} action={action} />
      ))}
    </section>
  );
}
