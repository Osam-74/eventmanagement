import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * E2E PWA suite: builds the production app, serves it with `next start`
 * against the Firestore emulator, and drives it with headless Chromium.
 * Run via `npm run test:pwa:emulator` (wraps in firebase emulators:exec).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/pwa/**/*.test.ts'],
    globalSetup: 'tests/pwa/global-setup.ts',
    testTimeout: 240000,
    hookTimeout: 240000,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
