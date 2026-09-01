/**
 * F-MOD-000: Env checker validates required variables at boot
 *
 * Behavioral expectations:
 * - Missing DATABASE_URL → exits with ERR_CDR_78_EX_CONFIG naming the var
 * - Missing JWT_SECRET → exits with ERR_CDR_78_EX_CONFIG naming the var
 * - All missing variables are named at once
 * - .env.example contains named placeholder entries for all 5 required vars
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const ENV_CHECK = path.join(__dirname, '../config/env-check.cjs');

/** Spawn node with env-check.cjs, providing specific env vars */
function runEnvCheck(env: Record<string, string>) {
  return spawnSync(process.execPath, [ENV_CHECK], {
    env: { ...env }, // no inherited env — test only what we pass
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('F-MOD-000 env checker', () => {
  it('test_F_MOD_000_env_check_exits_when_database_url_missing', () => {
    const result = runEnvCheck({ JWT_SECRET: 'test-secret' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_CDR_78_EX_CONFIG');
    expect(result.stderr).toContain('DATABASE_URL');
  });

  it('test_F_MOD_000_env_check_exits_when_jwt_secret_missing', () => {
    const result = runEnvCheck({ DATABASE_URL: 'postgres://localhost/test' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_CDR_78_EX_CONFIG');
    expect(result.stderr).toContain('JWT_SECRET');
  });

  it('test_F_MOD_000_env_check_names_all_missing_vars_at_once', () => {
    // Both missing at the same time
    const result = runEnvCheck({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_CDR_78_EX_CONFIG');
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).toContain('JWT_SECRET');
  });

  it('test_F_MOD_000_env_check_instructs_cp_env_example', () => {
    const result = runEnvCheck({});
    expect(result.stderr).toContain('cp .env.example .env');
  });

  it('test_F_MOD_000_env_check_passes_when_all_required_vars_present', () => {
    const result = runEnvCheck({
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'test-secret-at-least-32-chars-long',
    });
    expect(result.status).toBe(0);
  });
});

describe('F-MOD-000 .env.example', () => {
  it('test_F_MOD_000_env_example_contains_all_required_placeholders', () => {
    const envExample = readFileSync(
      path.join(PROJECT_ROOT, '.env.example'),
      'utf8',
    );
    const requiredVars = [
      'DATABASE_URL',
      'JWT_SECRET',
      'SENDGRID_API_KEY',
      'FANTASYPROS_API_KEY',
      'NODE_ENV',
    ];
    for (const varName of requiredVars) {
      expect(envExample).toContain(varName);
    }
  });

  it('test_F_MOD_000_env_example_has_no_real_secrets', () => {
    const envExample = readFileSync(
      path.join(PROJECT_ROOT, '.env.example'),
      'utf8',
    );
    // Values should be empty (NAME=) — not filled with real secrets
    const lines = envExample
      .split('\n')
      .filter((l) => !l.startsWith('#') && l.includes('='));
    for (const line of lines) {
      const value = line.split('=').slice(1).join('=').trim();
      // Placeholder values must be empty or non-secret-looking
      expect(value).not.toMatch(/^sk-|^postgres:\/\/[^:]+:[^@]+@|^eyJ/);
    }
  });
});
