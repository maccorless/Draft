/**
 * Local dev seed — creates the NFFLWags league with 12 teams.
 * Run: npx tsx src/seed.ts
 *
 * Credentials printed on success.
 */
import postgres from 'postgres';
import { hash } from '@node-rs/bcrypt';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost/draft';

const SITE_PASSWORD = 'draft2026';
const COMMISSIONER_PASSWORD = 'commish2026';
const TEAM_PASSWORD = 'team2026'; // same for all teams for local testing

const TEAMS = [
  'Wags FC', 'Thunder Wolves', 'Grid Iron Gods', 'Blitz Brothers',
  'End Zone Elite', 'Pocket Rockets', 'Red Zone Renegades', 'Turf Titans',
  'Snap Count', 'Fourth Down Force', 'Hail Mary Squad', 'Two Minute Drill',
];

async function seed() {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const [siteHash, commHash, teamHash] = await Promise.all([
      hash(SITE_PASSWORD, 12),
      hash(COMMISSIONER_PASSWORD, 12),
      hash(TEAM_PASSWORD, 12),
    ]);

    const [league] = await sql<[{ id: string }]>`
      INSERT INTO leagues (name, site_password_hash, commissioner_password_hash, auth_epoch)
      VALUES ('NFFLWags', ${siteHash}, ${commHash}, 0)
      RETURNING id
    `;

    for (let i = 0; i < TEAMS.length; i++) {
      await sql`
        INSERT INTO teams (league_id, name, team_password_hash, auth_epoch, draft_order)
        VALUES (${league.id}, ${TEAMS[i]}, ${teamHash}, 0, ${i + 1})
      `;
    }

    console.log('\n✓ NFFLWags seeded');
    console.log(`  League ID:             ${league.id}`);
    console.log(`  Site password:         ${SITE_PASSWORD}`);
    console.log(`  Commissioner password: ${COMMISSIONER_PASSWORD}`);
    console.log(`  Team password (all):   ${TEAM_PASSWORD}`);
    console.log(`  Teams (${TEAMS.length}):             ${TEAMS.join(', ')}\n`);
  } finally {
    await sql.end();
  }
}

seed().catch(err => { console.error(err); process.exit(1); });
