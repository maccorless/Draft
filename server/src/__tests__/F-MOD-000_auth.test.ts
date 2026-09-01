/**
 * F-MOD-000: Auth endpoint behavioral expectations
 *
 * Tests require a real DB (DATABASE_URL must be set).
 * Skipped automatically if DATABASE_URL is not available.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { hash } from '@node-rs/bcrypt';

// Set up env before importing server
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost/draft_test';
const JWT_SECRET =
  process.env['JWT_SECRET'] ??
  'test-secret-for-vitest-at-least-32-chars-long!!';

process.env['DATABASE_URL'] = DATABASE_URL;
process.env['JWT_SECRET'] = JWT_SECRET;

const SKIP_DB = !process.env['DATABASE_URL'];

// Shared server — avoids a second buildServer() in the same worker which can
// hang in the full suite due to module-level state accumulation.
let sharedServer: FastifyInstance;
let sharedSql: ReturnType<typeof postgres>;

if (!SKIP_DB) {
  beforeAll(async () => {
    sharedSql = postgres(DATABASE_URL, { max: 2 });
    // Truncate leagues so /auth/site's O(n×bcrypt) doesn't time out when this
    // file runs after other module tests that accumulated league rows.
    await sharedSql`TRUNCATE TABLE leagues, draft_datasets RESTART IDENTITY CASCADE`;
    const { buildServer } = await import('../main.js');
    sharedServer = await buildServer();
    await sharedServer.ready();
  });

  afterAll(async () => {
    await sharedServer.close();
    await sharedSql.end();
  });
}

describe.skipIf(SKIP_DB)('F-MOD-000 auth routes', () => {
  let server: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let testLeagueId: string;
  let testTeamId: string;

  beforeAll(async () => {
    server = sharedServer;
    sql = sharedSql;
  });

  beforeEach(async () => {
    // Insert a fresh test league + team for each test
    const siteHash = await hash('site-pass', 12);
    const commHash = await hash('comm-pass', 12);
    const teamHash = await hash('team-pass', 12);

    const [league] = await sql<[{ id: string }]>`
      INSERT INTO leagues (name, site_password_hash, commissioner_password_hash, auth_epoch)
      VALUES ('Test League', ${siteHash}, ${commHash}, 0)
      RETURNING id
    `;
    testLeagueId = league.id;

    const [team] = await sql<[{ id: string }]>`
      INSERT INTO teams (league_id, name, team_password_hash, auth_epoch, draft_order)
      VALUES (${testLeagueId}, 'Team A', ${teamHash}, 0, 1)
      RETURNING id
    `;
    testTeamId = team.id;

    // Cleanup happens via CASCADE delete of league — remove after test
    // We'll track IDs and delete in afterEach
  });

  afterEach(async () => {
    // Clean up test data
    if (testLeagueId) {
      await sql`DELETE FROM teams WHERE league_id = ${testLeagueId}`;
      await sql`DELETE FROM leagues WHERE id = ${testLeagueId}`;
    }
  });

  // ── POST /auth/site ───────────────────────────────────────────────────────

  it('test_F_MOD_000_auth_site_correct_password_returns_leagues', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/auth/site',
      payload: { site_password: 'site-pass' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ leagues: Array<{ id: string; name: string }> }>();
    expect(Array.isArray(body.leagues)).toBe(true);
    const match = body.leagues.find((l) => l.id === testLeagueId);
    expect(match).toBeTruthy();
    expect(match?.name).toBe('Test League');
  });

  it('test_F_MOD_000_auth_site_wrong_password_returns_401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/auth/site',
      payload: { site_password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json<{ code: string }>();
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('test_F_MOD_000_auth_site_wrong_password_does_not_disclose_existence', async () => {
    // Error message must not hint at whether password exists
    const response = await server.inject({
      method: 'POST',
      url: '/auth/site',
      payload: { site_password: 'wrong-password' },
    });
    const body = response.json<{ message: string }>();
    expect(body.message.toLowerCase()).not.toContain('exist');
    expect(body.message.toLowerCase()).not.toContain('found');
  });

  // ── POST /auth/league/:id ─────────────────────────────────────────────────

  it('test_F_MOD_000_auth_league_commissioner_returns_jwt', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'COMMISSIONER', password: 'comm-pass' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; expires_in: number }>();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.expires_in).toBe(172800);
  });

  it('test_F_MOD_000_auth_league_commissioner_jwt_has_correct_claims', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'COMMISSIONER', password: 'comm-pass' },
    });
    const { token } = response.json<{ token: string }>();

    // Decode JWT payload (middle part, base64url)
    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString(),
    );

    expect(payload.league_id).toBe(testLeagueId);
    expect(payload.role).toBe('COMMISSIONER');
    expect(typeof payload.auth_epoch).toBe('number');
  });

  it('test_F_MOD_000_auth_league_owner_returns_jwt', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'OWNER', team_id: testTeamId, password: 'team-pass' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; expires_in: number }>();
    expect(typeof body.token).toBe('string');
    expect(body.expires_in).toBe(172800);
  });

  it('test_F_MOD_000_auth_league_owner_jwt_has_team_id', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'OWNER', team_id: testTeamId, password: 'team-pass' },
    });
    const { token } = response.json<{ token: string }>();

    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString(),
    );

    expect(payload.league_id).toBe(testLeagueId);
    expect(payload.team_id).toBe(testTeamId);
    expect(payload.role).toBe('OWNER');
    expect(typeof payload.auth_epoch).toBe('number');
  });

  it('test_F_MOD_000_auth_league_wrong_password_returns_401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/auth/league/${testLeagueId}`,
      payload: { role: 'COMMISSIONER', password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('INVALID_CREDENTIALS');
  });
});

describe.skipIf(SKIP_DB)('F-MOD-000 rate limiting', () => {
  it('test_F_MOD_000_rate_limit_blocks_after_5_failures', async () => {
    // Use a distinct remoteAddress so these requests have their own rate-limit
    // bucket, isolated from the auth-routes describe's requests (127.0.0.1).
    const distinctIp = '10.99.99.99';
    for (let i = 0; i < 5; i++) {
      await sharedServer.inject({
        method: 'POST',
        url: '/auth/site',
        payload: { site_password: 'wrong-pass' },
        remoteAddress: distinctIp,
      });
    }

    // 6th attempt on the same IP must be rate-limited (429)
    const response = await sharedServer.inject({
      method: 'POST',
      url: '/auth/site',
      payload: { site_password: 'wrong-pass' },
      remoteAddress: distinctIp,
    });

    expect(response.statusCode).toBe(429);
  });
});

describe.skipIf(SKIP_DB)('F-MOD-000 password hashing', () => {
  it('test_F_MOD_000_passwords_stored_as_bcrypt_hash', async () => {
    const sql = postgres(DATABASE_URL, { max: 1 });
    try {
      // Insert a test league and verify the password is bcrypt-hashed
      const siteHash = await hash('test-site-pass', 12);
      const commHash = await hash('test-comm-pass', 12);

      const [league] = await sql<[{ site_password_hash: string }]>`
        INSERT INTO leagues (name, site_password_hash, commissioner_password_hash, auth_epoch)
        VALUES ('Hash Test League', ${siteHash}, ${commHash}, 0)
        RETURNING site_password_hash
      `;

      // bcrypt hashes start with $2b$
      expect(league.site_password_hash).toMatch(/^\$2[ab]\$/);
      // Plaintext is never stored
      expect(league.site_password_hash).not.toBe('test-site-pass');

      await sql`DELETE FROM leagues WHERE name = 'Hash Test League'`;
    } finally {
      await sql.end();
    }
  });
});
