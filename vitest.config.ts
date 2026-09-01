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
    reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml' }]],
  },
});
