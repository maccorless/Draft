import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Single configuration point for the backend's address: PORT comes from the
// repo-root .env (envDir below), the same variable server/src/main.ts reads
// (`process.env['PORT'] ?? '3000'`) to pick its own listen port. Every proxy
// entry derives from this one BACKEND_ORIGIN — there is no second hardcoded
// port anywhere in this file, so the frontend and backend cannot drift apart.
export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '..');
  const env = loadEnv(mode, repoRoot, '');
  const backendPort = env['PORT'] || '3000';
  const BACKEND_ORIGIN = `http://127.0.0.1:${backendPort}`;
  const BACKEND_WS_ORIGIN = `ws://127.0.0.1:${backendPort}`;

  return {
    plugins: [react()],
    envDir: repoRoot,
    resolve: {
      alias: {
        '@draft/shared-types': path.resolve(__dirname, '../shared-types/src/index.ts'),
      },
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': BACKEND_ORIGIN,
        '/ws': { target: BACKEND_WS_ORIGIN, ws: true },
        '/leagues': BACKEND_ORIGIN,
        '/auth': BACKEND_ORIGIN,
        '/players': BACKEND_ORIGIN,
        '/drafts': BACKEND_ORIGIN,
        '/health': BACKEND_ORIGIN,
        '/dev': BACKEND_ORIGIN,
      },
    },
  };
});
