/**
 * Service worker for "Event Access".
 * Cache configuration lives in src/lib/pwa/swConfig.ts (unit-tested):
 * /api/* is strictly NetworkOnly; only static assets and the HTML shell
 * are cached. Security-sensitive responses are never cached or replayed.
 */
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';
import { APP_CACHE_VERSION, runtimeCacheEntries } from '@/lib/pwa/swConfig';

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

/**
 * Cache upgrade: when this service worker activates, it deletes every
 * cache that does not belong to the current version — including all
 * v1.2.0 (and earlier) runtime caches — so an installed older PWA can
 * never keep serving an obsolete application shell indefinitely.
 */
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const stale = names.filter((n) => n.startsWith('event-access/') && !n.startsWith(APP_CACHE_VERSION));
      // Runtime cache names used before versioned naming (v1.2.0 and earlier).
      const legacy = ['next-static-assets', 'static-image-assets', 'static-style-assets', 'html-shell'];
      await Promise.all([...stale, ...legacy].map((n) => caches.delete(n)));
    })()
  );
});
