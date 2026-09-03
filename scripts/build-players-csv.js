/**
 * Converts data/cheatsheet.csv (2026 salary-cap values, one column group per
 * position) into data/players-2026.csv in the format the CSV import adapter
 * expects: name,position,nfl_team,aav_minor,projected_points,tier,espn_player_id
 *
 * Run from repo root: node scripts/build-players-csv.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data/cheatsheet.csv');
const OUT = path.join(ROOT, 'data/players-2026.csv');

const TEAM_ABBREV = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAC',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter((l) => l.length);
// Line 0 is a title row, line 1 is the header row; data starts at line 2.
const rows = lines.slice(2).map((l) => l.split(','));

// [position label to emit, column index of "Name - TEAM", column index of "$VALUE"]
// Source column group order: Overall, QB, RB, WR, TE, K, DST, DB.
// DB (IDP) has no roster slot in this app and is dropped. DST is normalized to
// DEF to match the roster slot definition and the ESPN-PDF adapter convention.
const groups = [
  ['QB', 6, 8],
  ['RB', 12, 14],
  ['WR', 18, 20],
  ['TE', 24, 26],
  ['K', 30, 32],
  ['DEF', 36, 38],
];

const players = [];

for (const [position, nameIdx, valueIdx] of groups) {
  const bucket = [];
  for (const r of rows) {
    const rawName = r[nameIdx]?.trim();
    if (!rawName) continue;
    const rawValue = r[valueIdx]?.trim() ?? '';
    const dollars = parseInt(rawValue.replace('$', ''), 10);
    if (isNaN(dollars)) continue;

    let name, nfl_team;
    if (position === 'DEF') {
      // DST column holds the full team name directly, no " - TEAM" suffix.
      name = rawName;
      nfl_team = TEAM_ABBREV[rawName];
      if (!nfl_team) throw new Error(`Unmapped defense team name: "${rawName}"`);
    } else {
      const dash = rawName.lastIndexOf(' - ');
      if (dash === -1) throw new Error(`Could not split name/team: "${rawName}"`);
      name = rawName.slice(0, dash).trim();
      nfl_team = rawName.slice(dash + 3).trim();
    }

    bucket.push({ name, position, nfl_team, aav_minor: dollars * 100 });
  }

  // Derived tier: rank-based sixths within each position, by AAV descending.
  // Source data has no explicit tier column.
  bucket.sort((a, b) => b.aav_minor - a.aav_minor);
  const tierCount = 6;
  bucket.forEach((p, i) => {
    p.tier = Math.min(tierCount, Math.floor((i / bucket.length) * tierCount) + 1);
  });
  players.push(...bucket);
}

players.sort((a, b) => b.aav_minor - a.aav_minor);

const header = 'name,position,nfl_team,aav_minor,projected_points,tier,espn_player_id';
const csvLines = [header];
for (const p of players) {
  const name = p.name.includes(',') ? `"${p.name}"` : p.name;
  csvLines.push(`${name},${p.position},${p.nfl_team},${p.aav_minor},,${p.tier},`);
}

fs.writeFileSync(OUT, csvLines.join('\n') + '\n');

const byPos = {};
for (const p of players) byPos[p.position] = (byPos[p.position] ?? 0) + 1;
console.log(`Wrote ${players.length} players to ${path.relative(ROOT, OUT)}`);
console.log(byPos);
