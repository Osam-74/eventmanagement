/**
 * Service worker for "I & S Access".
 * Cache configuration lives in src/lib/pwa/swConfig.ts (unit-tested):
 * /api/* is strictly NetworkOnly; only static assets and the HTML shell
 * are cached. Security-sensitive responses are never cached or replayed.
 */
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';
import { runtimeCacheEntries } from '@/lib/pwa/swConfig';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: runtimeCacheEntries,
});

serwist.addEventListeners();
