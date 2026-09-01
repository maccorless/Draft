import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['web/**', 'jsdom'],
    ],
    include: [
      'server/src/**/*.test.ts',
      'shared-types/src/**/*.test.ts',
      'web/src/**/*.test.tsx',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Integration tests share draft_test DB — run files sequentially to prevent state leakage
    fileParallelism: false,
    globalSetup: './vitest.globalSetup.ts',
    reporters: ['dot', ['junit', { outputFile: 'test-results/junit.xml' }]],
    // Provide placeholder values for all required env vars so tests that import
    // buildServer do not fail the startup env check. Real values live in .env
    // and are never committed. Tests that need specific behavior override these.
    env: {
      SENDGRID_API_KEY: 'test-sendgrid-key-placeholder',
      FANTASYPROS_API_KEY: 'test-fantasypros-key-placeholder',
    },
  },
});
