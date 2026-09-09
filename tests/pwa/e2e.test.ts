import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

/**
 * E2E PWA + routing/authentication suite against the real production build
 * served by `next start`, backed by the Firestore emulator. Proves:
 *  - unified entry page (ADMIN | USHER)
 *  - /login (admin) and /usher/login (usher) flows
 *  - /scan protection (unauthenticated → usher login)
 *  - usher PIN sign-in reaches the scanner; wrong PIN rejected
 *  - session separation (usher cookie ≠ admin access)
 *  - connectivity indicator + offline scanning NEVER grants access
 *  - manifest validity; SW registration; /api responses are NEVER served
 *    from service-worker cache (offline fetch must FAIL, not replay)
 *  - camera-denial path shows a useful instruction
 */
const BASE = process.env.E2E_BASE_URL!;
const USHER_NAME = process.env.E2E_USHER_NAME!;
const USHER_PIN = process.env.E2E_USHER_PIN!;
const EVENT_ID = process.env.E2E_EVENT_ID!;

let browser: Browser;
let page: Page;
let context: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext();
  page = await context.newPage();
});

afterAll(async () => {
  await browser.close();
});

/** Wait for a locator to become visible; fails the test if it never does. */
async function expectVisible(locator: Locator, timeout = 15000) {
  await locator.waitFor({ state: 'visible', timeout });
}

async function usherLogin(p: Page, pin = USHER_PIN) {
  await p.goto(`${BASE}/usher/login`);
  await p.locator('#usher-name').fill(USHER_NAME);
  await p.locator('#usher-pin').fill(pin);
  await p.getByRole('button', { name: 'Sign In' }).click();
}

describe('unified entry page', () => {
  it('/ presents the Welcome page with ADMIN and USHER choices', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await expectVisible(page.getByText('Welcome to I & S Access'));
    await expectVisible(page.getByRole('link', { name: /ADMIN/ }));
    await expectVisible(page.getByRole('link', { name: /USHER/ }));
  });

  it('ADMIN choice leads to /login (email/password administrator sign-in)', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /ADMIN/ }).click();
    await page.waitForURL(`${BASE}/login`);
    await expectVisible(page.getByText('Administrator sign-in'));
    await expectVisible(page.locator('input[type="email"]'));
    await expectVisible(page.locator('input[type="password"]'));
  });

  it('USHER choice leads to /usher/login (name + PIN, no email/password)', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /USHER/ }).click();
    await page.waitForURL(`${BASE}/usher/login`);
    await expectVisible(page.getByText('Usher Sign In'));
    await expectVisible(page.locator('#usher-name'));
    await expectVisible(page.locator('#usher-pin'));
    expect(await page.locator('input[type="email"]').count()).toBe(0);
  });
});

describe('/scan protection and usher authentication', () => {
  it('unauthenticated /scan redirects to /usher/login', async () => {
    await page.goto(`${BASE}/scan`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${BASE}/usher/login`, { timeout: 15000 });
  });

  it('wrong PIN is rejected and does not reach the scanner', async () => {
    await usherLogin(page, '000000');
    await page.waitForURL(`${BASE}/usher/login`);
    await expectVisible(page.getByText('Invalid name or PIN.'));
  });

  it('correct PIN takes the usher to /scan with the scanner UI and Online badge', async () => {
    await usherLogin(page);
    await page.waitForURL(`${BASE}/scan`, { timeout: 15000 });
    await expectVisible(page.getByRole('button', { name: /Start Scanner/ }));
    await expectVisible(page.getByText('Online'), 10000);
  });

  it('usher session does not grant administrator API access', async () => {
    const r = await page.request.get(`${BASE}/api/admin/dashboard?eventId=${EVENT_ID}`);
    expect(r.status()).toBe(401);
    const rMe = await page.request.get(`${BASE}/api/me`);
    const me = await rMe.json().catch(() => ({ admin: null }));
    expect(me.admin).toBeNull();
  });

  it('administrator-style credentials do not create an usher session', async () => {
    const r = await page.request.post(`${BASE}/api/usher/signin`, {
      data: { eventId: EVENT_ID, name: 'root@event.admin', pin: '135790' },
    });
    expect(r.status()).toBe(401);
  });
});

describe('connectivity: server authority is mandatory', () => {
  it('shows No Internet when offline, and an offline scan NEVER grants access', async () => {
    await page.goto(`${BASE}/scan`, { waitUntil: 'domcontentloaded' });
    await expectVisible(page.getByRole('button', { name: /Start Scanner/ }));
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expectVisible(page.getByText('No Internet'), 10000);
    await page.locator('#manual-entry').fill('IS26.SOMEQRTESTTOKEN123');
    await page.keyboard.press('Enter');
    await expectVisible(page.getByText(/No Internet — invitation NOT validated/i), 10000);
    expect(await page.getByText('ACCESS GRANTED').count()).toBe(0);
    await context.setOffline(false);
    // Serwist's reloadOnOnline reloads the page when connectivity returns —
    // tolerate that navigation, then the badge must be Online again.
    await page.waitForTimeout(2000);
    await page.waitForURL(`${BASE}/scan`, { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await expectVisible(page.getByText('Online').first(), 20000);
  });
});

describe('PWA: manifest, service worker, cache policy', () => {
  it('serves a valid manifest with the approved identity', async () => {
    const r = await page.request.get(`${BASE}/manifest.webmanifest`);
    expect(r.status()).toBe(200);
    const manifest = await r.json();
    expect(manifest.name).toBe('I & S Access');
    expect(manifest.short_name).toBe('I&S Access');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect((manifest.icons ?? []).some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
  });

  it('registers the service worker and serves /sw.js', async () => {
    const swRes = await page.request.get(`${BASE}/sw.js`);
    expect(swRes.status()).toBe(200);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.scope;
    });
    expect(scope).toBe(`${BASE}/`);
    await page.reload({ waitUntil: 'networkidle' });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    expect(controlled).toBe(true);
  });

  it('NEVER serves /api responses from service-worker cache when offline', async () => {
    // Fresh, unauthenticated context so the / smart-shortcut does not
    // redirect us away mid-navigation.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Warm the API request while online (so a caching policy WOULD store it
    // if any existed), then go offline and retry — it must FAIL, not replay.
    await p.evaluate(async () => {
      await fetch('/api/usher/session').catch(() => undefined);
    });
    await ctx.setOffline(true);
    const result = await p.evaluate(async () => {
      try {
        const r = await fetch('/api/usher/session');
        return { ok: true, status: r.status };
      } catch {
        return { ok: false };
      }
    });
    await ctx.setOffline(false);
    await ctx.close();
    expect(result.ok).toBe(false); // network failure — NOT a cached replay
  });

  it('does cache immutable static chunks (fast app shell)', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const chunkUrl = await p.evaluate(() => {
      const el = Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s as HTMLScriptElement).src)
        .find((src) => src.includes('/_next/static/'));
      return el ?? null;
    });
    if (!chunkUrl) {
      await ctx.close();
      return;
    }
    await ctx.setOffline(true);
    const status = await p.evaluate(async (url: string) => {
      const r = await fetch(url);
      return r.status;
    }, chunkUrl);
    await ctx.setOffline(false);
    await ctx.close();
    expect(status).toBe(200); // served from cache-first
  });
});

describe('camera denial', () => {
  it('shows a useful instruction instead of a broken scanner', async () => {
    const ctx = await browser.newContext({ permissions: [] });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/usher/login`);
    await p.locator('#usher-name').fill(USHER_NAME);
    await p.locator('#usher-pin').fill(USHER_PIN);
    await p.getByRole('button', { name: 'Sign In' }).click();
    await p.waitForURL(`${BASE}/scan`, { timeout: 15000 });
    await p.getByRole('button', { name: /Start Scanner/ }).click();
    // Headless Chromium denies getUserMedia → the catch path must show the
    // permission instruction. Real-device camera behavior is verified on
    // owner phones.
    await expectVisible(p.getByText(/Could not start the camera/i), 30000);
    await ctx.close();
  });
});
