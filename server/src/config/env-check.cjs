'use strict';
/**
 * Environment variable checker — runs as the very first import in main.ts
 * before any module reads configuration.
 *
 * If any required variable is missing, exits immediately with:
 *   ERR_CDR_78_EX_CONFIG: missing <VAR1>, <VAR2>
 *   cp .env.example .env
 */

// FANTASYPROS_API_KEY is optional — that feature fails gracefully without it.
// SENDGRID_API_KEY/SENDGRID_FROM_EMAIL are required — F-MOD-006-rework-01 sends
// real email via SendGrid and cannot silently no-op on a missing sender identity.
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV', 'SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'];

// FRONTEND_ORIGIN (comma-separated allowed origins for CORS) is required only
// in production — a production boot with no configured frontend origin must
// fail fast at startup rather than silently rejecting every browser request
// at runtime. Optional in dev/test, where the localhost Vite origins apply.
const REQUIRED_IN_PRODUCTION = ['FRONTEND_ORIGIN'];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (process.env['NODE_ENV'] === 'production') {
  for (const name of REQUIRED_IN_PRODUCTION) {
    if (!process.env[name]) missing.push(name);
  }
}

if (missing.length > 0) {
  process.stderr.write(
    `ERR_CDR_78_EX_CONFIG: missing ${missing.join(', ')}\n` +
      `cp .env.example .env\n`,
  );
  process.exit(1);
}
