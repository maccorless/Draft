'use strict';
/**
 * Environment variable checker — runs as the very first import in main.ts
 * before any module reads configuration.
 *
 * If any required variable is missing, exits immediately with:
 *   ERR_CDR_78_EX_CONFIG: missing <VAR1>, <VAR2>
 *   cp .env.example .env
 */

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV'];

const missing = REQUIRED.filter((name) => !process.env[name]);

if (missing.length > 0) {
  process.stderr.write(
    `ERR_CDR_78_EX_CONFIG: missing ${missing.join(', ')}\n` +
      `cp .env.example .env\n`,
  );
  process.exit(1);
}
