/**
 * Service-worker runtime caching configuration for "Event Access".
 *
 * SECURITY RULES (enforced by tests/unit/pwa-sw-config.test.ts):
 *  1. Every same-origin request under /api/ MUST be handled NetworkOnly.
 *     A service worker must NEVER serve a cached/replayed API response —
 *     scan validation, usher/admin auth, rescan, revoke and activation are
 *     authoritative server transactions, and a stale cached response could
 *     (for example) replay an old ACCESS GRANTED result.
 *  2. No cacheable strategy (CacheFirst / StaleWhileRevalidate /
 *     NetworkFirst) may match any /api/ path — even for GETs.
 *
 * NOTE: this deliberately does NOT use @serwist/next's `defaultCache`,
 * whose production preset includes a NetworkFirst (timeout-fallback-to-cache)
 * rule for same-origin GET /api/* — which would violate rule 2. Keep this
 * file custom and auditable.
 */
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'serwist';
import type { RuntimeCaching } from 'serwist';

export const SENSITIVE_API_PREFIX = '/api/';

/**
 * Cache names are versioned per release: when a newly deployed service
 * worker activates it deletes every cache from earlier versions (see
 * sw.ts), so an installed older PWA can never keep serving an obsolete
 * application shell indefinitely.
 */
// MUST be bumped on every deploy that changes app code. Runtime caches are
// namespaced by this string, and sw.ts deletes caches from other versions
// on activation — if it isn't bumped, every already-installed PWA keeps
// serving the PREVIOUS build's HTML (StaleWhileRevalidate showed the stale
// shell first) with no self-heal. That is exactly how ushers ended up on
// an old scan page: camera never scanned, manual entry missing.
export const APP_CACHE_VERSION = 'event-access/v1.3.3';

/**
 * All runtime caching rules, in matching order. The /api NetworkOnly rule is
 * first so it always wins for API requests; everything else is static-asset
 * only. Navigations (HTML/RSC) are handled by the `document` entries below —
 * they exclude /api explicitly as well, but HTML is not security-sensitive:
 * all authority lives in the network-only APIs.
 */
export const runtimeCacheEntries: RuntimeCaching[] = [
  {
    // HARD RULE: security-sensitive APIs are network-only. Never cached,
    // never replayed, no timeout fallback to a stale copy.
    matcher: ({ sameOrigin, url: { pathname } }) => sameOrigin && pathname.startsWith(SENSITIVE_API_PREFIX),
    handler: new NetworkOnly(),
  },
  {
    // Next.js build output chunks — immutable, safe to cache-first.
    matcher: /\/_next\/static\/.+$/i,
    handler: new CacheFirst({
      cacheName: `${APP_CACHE_VERSION}/static`,
      plugins: [new ExpirationPlugin({ maxEntries: 96, maxAgeSeconds: 30 * 24 * 60 * 60, maxAgeFrom: 'last-used' })],
    }),
  },
  {
    // Static image assets (icons, artwork previews).
    matcher: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
    handler: new StaleWhileRevalidate({
      cacheName: `${APP_CACHE_VERSION}/images`,
      plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 720 * 60 * 60, maxAgeFrom: 'last-used' })],
    }),
  },
  {
    // Stylesheets.
    matcher: /\.(?:css|less)$/i,
    handler: new StaleWhileRevalidate({
      cacheName: `${APP_CACHE_VERSION}/styles`,
      plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 1440 * 60, maxAgeFrom: 'last-used' })],
    }),
  },
  {
    // Document (HTML) navigations — NetworkFirst: when online, ushers ALWAYS
    // get the freshly deployed app shell (an old scan page on event day is
    // the worst failure mode this PWA can have); the cached copy is only a
    // fallback for offline. Explicitly excludes /api.
    matcher: ({ request, url: { pathname }, sameOrigin }) =>
      request.destination === 'document' &&
      sameOrigin &&
      !pathname.startsWith(SENSITIVE_API_PREFIX),
    handler: new NetworkFirst({
      cacheName: `${APP_CACHE_VERSION}/html`,
      plugins: [new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 24 * 60 * 60, maxAgeFrom: 'last-used' })],
    }),
  },
];
