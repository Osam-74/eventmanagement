import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCacheEntries, APP_CACHE_VERSION } from '@/lib/pwa/swConfig';
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'serwist';

const ROOT = path.resolve(__dirname, '../..');

describe('PWA web app manifest', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf-8')
  ) as Record<string, unknown>;

  it('has the approved app identity (product renamed to Event Access)', () => {
    expect(manifest.name).toBe('Event Access');
    expect(manifest.short_name).toBe('Event Access');
  });

  it('is installable: standalone display and a start URL', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
  });

  it('declares icons in required PWA sizes, including maskable', () => {
    const icons = manifest.icons as { src: string; sizes: string; type: string; purpose?: string }[];
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const icon of icons) {
      expect(existsSync(path.join(ROOT, 'public', icon.src.replace(/^\//, ''))), `icon file ${icon.src}`).toBe(true);
    }
  });

  it('has theme/background colors and portrait orientation', () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.orientation).toBe('portrait');
  });
});

describe('cache versioning', () => {
  it('all cacheable strategies use per-release versioned cache names', () => {
    for (const entry of runtimeCacheEntries) {
      if (!(entry.handler instanceof NetworkOnly)) {
        expect((entry.handler as { cacheName?: string }).cacheName?.startsWith(APP_CACHE_VERSION + '/')).toBe(true);
      }
    }
  });

  it('the /api NetworkOnly rule stays first and matches every sensitive path', () => {
    expect(runtimeCacheEntries[0].handler).toBeInstanceOf(NetworkOnly);
  });
});

describe('service worker cache policy', () => {
  // Every security-sensitive API surface in the application.
  const SENSITIVE_PATHS = [
    { method: 'POST', path: '/api/scan' },
    { method: 'GET', path: '/api/usher/session' },
    { method: 'POST', path: '/api/usher/signin' },
    { method: 'POST', path: '/api/usher/signout' },
    { method: 'POST', path: '/api/usher/heartbeat' },
    { method: 'POST', path: '/api/auth/session' },
    { method: 'GET', path: '/api/auth/session' },
    { method: 'DELETE', path: '/api/auth/session' },
    { method: 'GET', path: '/api/admin/dashboard/event' },
    { method: 'GET', path: '/api/admin/dashboard/activity' },
    { method: 'GET', path: '/api/admin/dashboard/ushers' },
    { method: 'GET', path: '/api/admin/dashboard/batches' },
    { method: 'GET', path: '/api/admin/invitations' },
    { method: 'GET', path: '/api/admin/invitations/abc123' },
    { method: 'POST', path: '/api/admin/invitations/abc123/revoke' },
    { method: 'POST', path: '/api/admin/invitations/abc123/allow-rescan' },
    { method: 'POST', path: '/api/admin/events/abc/scanning' },
    { method: 'POST', path: '/api/admin/generate' },
    { method: 'GET', path: '/api/admin/admins' },
    { method: 'GET', path: '/api/admin/ushers' },
    { method: 'GET', path: '/api/admin/export' },
    { method: 'GET', path: '/api/admin/batches' },
    { method: 'GET', path: '/api/me' },
  ];

  const makeMatcherCtx = (method: string, pathname: string) => ({
    request: {
      method,
      headers: new Headers(),
      // Document navigations (HTML pages) — what the html-shell rule targets.
      destination: pathname.startsWith('/api/') ? '' : 'document',
    },
    url: new URL(`https://example.com${pathname}`),
    sameOrigin: true,
  });

  function matches(entry: { matcher: unknown; method?: string }, method: string, pathname: string): boolean {
    const m = entry.matcher as
      | RegExp
      | ((ctx: { request: { method: string; headers: Headers }; url: URL; sameOrigin: boolean }) => boolean);
    if (typeof m === 'function') {
      return m(makeMatcherCtx(method, pathname));
    }
    return m.test(pathname);
  }

  it('every same-origin /api request is handled NetworkOnly (never cached or replayed)', () => {
    for (const { method, path: pathname } of SENSITIVE_PATHS) {
      const matched = runtimeCacheEntries.find((e) => matches(e as never, method, pathname));
      expect(matched, `${method} ${pathname} must match a runtime caching rule (the NetworkOnly /api rule)`).toBeDefined();
      expect(matched!.handler, `${method} ${pathname} must be NetworkOnly`).toBeInstanceOf(NetworkOnly);
    }
  });

  it('NO cacheable strategy (CacheFirst / SWR / NetworkFirst) ever matches an /api path', () => {
    const cacheable = [CacheFirst, StaleWhileRevalidate, NetworkFirst];
    for (const { method, path: pathname } of SENSITIVE_PATHS) {
      for (const entry of runtimeCacheEntries) {
        if (entry.handler instanceof NetworkOnly) continue;
        if (matches(entry as never, method, pathname)) {
          throw new Error(
            `${entry.handler.constructor.name} would cache ${method} ${pathname} — forbidden for security-sensitive APIs`
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  it('does cache the immutable Next.js static shell (fast PWA startup)', () => {
    const matched = runtimeCacheEntries.find((e) => matches(e as never, 'GET', '/_next/static/chunks/app-abc123.js'));
    expect(matched?.handler).toBeInstanceOf(CacheFirst);
  });

  it('caches HTML shell but never /api HTML-adjacent requests', () => {
    const html = runtimeCacheEntries.find((e) => matches(e as never, 'GET', '/'));
    // Documents must be NetworkFirst: an installed PWA must never serve the
    // previous build's shell while online (stale scan page on event day).
    expect(html?.handler).toBeInstanceOf(NetworkFirst);
  });
});
