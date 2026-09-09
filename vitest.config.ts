import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The PWA e2e suite has its own config/global setup (vitest.pwa.config.ts)
    exclude: ['tests/pwa/**', '**/node_modules/**', '**/.git/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
