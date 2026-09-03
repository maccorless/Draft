import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@draft/shared-types': path.resolve(__dirname, '../shared-types/src/index.ts'),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
      '/leagues': 'http://127.0.0.1:3001',
      '/auth': 'http://127.0.0.1:3001',
      '/players': 'http://127.0.0.1:3001',
      '/drafts': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
    },
  },
});
