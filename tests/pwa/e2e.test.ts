import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createHmac, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { initializeApp as adminInitializeApp, deleteApp as adminDeleteApp } from 'firebase-admin/app';
import { getFirestore as adminGetFirestore } from 'firebase-admin/firestore';
import QRCode from 'qrcode';
import sharp from 'sharp';

/**
 * E2E PWA + routing/authentication suite against the real production build
 * served by `next start`, backed by the Firestore + Firebase Auth
 * emulators. Proves:
 *  - unified entry page (ADMIN | USHER) with the approved wording only
 *  - PIN-only usher login (Flo-style PIN pad: dots, keypad, auto-submit,
 *    shake feedback, welcome overlay) — no name, no event selection
 *  - /scan protection (unauthenticated → usher login)
 *  - admin login: ONE deterministic success sequence — wrong credentials
 *    NEVER produce authenticated UI, correct login establishes a stable
 *    server session that survives refresh and navigation, logout ends it
 *  - password-reset request shows clear feedback
 *  - session separation (usher cookie ≠ admin access)
 *  - connectivity indicator + offline scanning NEVER grants access
 *  - manifest validity; SW registration; /api responses (incl.
 *    /api/auth/session) are NEVER served from service-worker cache
 *  - camera-denial path shows a useful instruction
 */
const BASE = process.env.E2E_BASE_URL!;
const USHER_NAME = process.env.E2E_USHER_NAME!;
const USHER_PIN = process.env.E2E_USHER_PIN!;
const EVENT_ID = process.env.E2E_EVENT_ID!;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD!;

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

/**
 * Creates an invitation directly in the Firestore emulator and returns
 * its raw QR credential + digest. Mirrors the generate route's data model
 * (invitations are keyed by the HMAC digest of the QR token).
 */
async function seedE2EInvitation(serial: string, token = `IS26.${randomBytes(32).toString('base64url')}`) {
  // Mirror global-setup's serverEnv resolution EXACTLY — the e2e `next
  // start` server gets these same fallbacks, so digests computed here
  // match the server's lookup keys. (Never read .env.local here: the
  // vitest process doesn't load it, and a real key would mismatch the
  // server's fallback test key.)
  const key = process.env.QR_TOKEN_HMAC_KEY ?? 'e2e-test-secret-key-for-hmac-32bytes!!';
  const projectId = process.env.FIREBASE_PROJECT_ID ?? 'demo-eventaccess';
  const digest = createHmac('sha256', key).update(token, 'utf8').digest('hex');
  // firebase-admin BYPASSES the emulator's deny-all security rules —
  // the client SDK would be PERMISSION_DENIED (that's exactly why the
  // production app is server-only).
  const app = adminInitializeApp({ projectId }, `e2e-inv-${digest.slice(0, 8)}`);
  const db = adminGetFirestore(app);
  const ref = db.collection('invitations').doc(digest);
  await ref.set({
    eventId: EVENT_ID,
    batchId: 'batch-e2e',
    serialNumber: serial,
    status: 'unused',
    guestAllowance: 1,
    imageStoragePath: `events/${EVENT_ID}/invitations/batch-e2e/${serial}.jpg`,
    outputProfile: 'share',
    generatedAt: new Date(),
    generatedBy: 'e2e',
    usedAt: null,
    usedAtClientEstimate: null,
    usedByUsherId: null,
  });
  return { app, db, ref, token, digest, serial };
}

const FFMPEG_OK = spawnSync('ffmpeg', ['-version']).status === 0;

/**
 * Renders the QR as a fake CAMERA FEED. Chromium's
 * --use-file-for-fake-video-capture only reads Y4M video, so: sharp composes
 * the still frame, then ffmpeg converts it to a 2s looping Y4M stream.
 */
async function renderQrFeed(token: string, path: string) {
  // 400px QR centered on a 1280x720 white canvas — comfortably inside the
  // scanner's 70% center decode region, mirroring a card held properly.
  const qr = await QRCode.toBuffer(token, { errorCorrectionLevel: 'Q', margin: 0, width: 400, color: { dark: '#000000ff', light: '#ffffffff' } });
  const qrPng = await sharp(qr).png().toBuffer();
  const still = '/tmp/e2e-qr-feed.jpg';
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ffffff' } })
    .composite([{ input: qrPng, left: 440, top: 160 }])
    .jpeg()
    .toFile(still);
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', still,
     '-r', '30', '-t', '2', '-pix_fmt', 'yuv420p', '-y', path],
    { stdio: 'pipe' }
  );
  if (r.status !== 0) throw new Error(`ffmpeg Y4M conversion failed: ${r.stderr}`);
}

/** Enter a PIN on the Flo-style PIN pad (taps the on-screen keypad). */
async function enterPin(p: Page, pin: string) {
  await p.goto(`${BASE}/usher/login`);
  await expectVisible(p.getByText('Enter your PIN'));
  // 'Enter your PIN' is server-rendered, so it can be visible BEFORE React
  // hydration — taps on the keypad are inert until then. Tap the first
  // digit until a dot actually fills (proof the handlers are live), then
  // finish the PIN. This mirrors a real user seeing the dots respond.
  const filledDots = p.locator('div.rounded-full.bg-stone-900');
  for (let i = 0; i < 50 && (await filledDots.count()) === 0; i++) {
    await p.getByRole('button', { name: `Digit ${pin[0]}` }).click();
    await p.waitForTimeout(100);
  }
  expect(await filledDots.count()).toBeGreaterThan(0);
  for (const d of pin.slice(1)) {
    await p.getByRole('button', { name: `Digit ${d}` }).click();
  }
}

describe('unified entry page (approved wording only)', () => {
  it('/ presents exactly the approved Event Access Control wording', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await expectVisible(page.getByText('Event Access Control'));
    await expectVisible(page.getByText('Please select your user type to login.'));
    await expectVisible(page.getByRole('link', { name: /^ADMIN$/ }));
    await expectVisible(page.getByRole('link', { name: /^USHER$/ }));
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('wedding');
    expect(body).not.toContain('event management & dashboard');
    expect(body).not.toContain('gate qr scanning');
  });

  it('ADMIN choice leads to /login (email/password administrator sign-in)', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /^ADMIN$/ }).click();
    await page.waitForURL(`${BASE}/login`);
    await expectVisible(page.getByText('Administrator sign-in'));
    await expectVisible(page.locator('input[type="email"]'));
    await expectVisible(page.locator('input[type="password"]'));
  });

  it('USHER choice leads to the PIN pad — no name input, no event selector, no email', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: /^USHER$/ }).click();
    await page.waitForURL(`${BASE}/usher/login`);
    await expectVisible(page.getByText('Enter your PIN'));
    // The pad has exactly 10 digit keys (0-9), delete, and confirm.
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(await page.getByRole('button', { name: `Digit ${d}` }).count()).toBe(1);
    }
    await expectVisible(page.getByRole('button', { name: /confirm pin/i }));
    // Nothing else is asked of the usher.
    expect(await page.locator('input, select').count()).toBe(0);
    expect(await page.locator('#usher-name').count()).toBe(0);
  });
});

describe('/scan protection and PIN-only usher authentication', () => {
  it('unauthenticated /scan redirects to /usher/login', async () => {
    await page.goto(`${BASE}/scan`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${BASE}/usher/login`, { timeout: 15000 });
  });

  it('wrong PIN shows Incorrect-PIN feedback (shake + reset) and never reaches the scanner', async () => {
    await enterPin(page, '999999'); // auto-submits at 6 digits
    await page.waitForTimeout(1000);
    await expectVisible(page.getByText('Invalid PIN.'));
    expect(page.url()).toContain('/usher/login');
    // The pad resets for the next attempt.
    await expectVisible(page.getByRole('button', { name: 'Digit 1' }));
  });

  it('correct PIN identifies the usher (welcome overlay) and opens /scan with Online badge', async () => {
    await enterPin(page, USHER_PIN);
    await expectVisible(page.getByText(`Welcome`, { exact: true }), 8000);
    await expectVisible(page.getByText(USHER_NAME), 8000);
    await page.waitForURL(`${BASE}/scan`, { timeout: 15000 });
    await expectVisible(page.getByRole('button', { name: /Start Scanner/ }));
    await expectVisible(page.getByText('Online'), 10000);
  });

  it('usher session does not grant administrator API access', async () => {
    const r = await page.request.get(`${BASE}/api/admin/dashboard/activity?eventId=${EVENT_ID}`);
    expect(r.status()).toBe(401);
    const rMe = await page.request.get(`${BASE}/api/me`);
    const me = await rMe.json().catch(() => ({ admin: null }));
    expect(me.admin).toBeNull();
  });

  it('a valid-format but unknown PIN cannot create an usher session', async () => {
    const r = await page.request.post(`${BASE}/api/usher/signin`, {
      data: { pin: '264264' },
    });
    expect(r.status()).toBe(401);
  });
});

describe('admin login: ONE deterministic success sequence', () => {
  // Isolated context so the admin session cookie never leaks into the
  // usher-scenario context.
  let ctx: BrowserContext;
  let p: Page;

  beforeAll(async () => {
    ctx = await browser.newContext();
    p = await ctx.newPage();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('a wrong password shows an error and can NEVER produce authenticated UI afterwards', async () => {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.locator('#admin-email').fill(ADMIN_EMAIL);
    await p.locator('#admin-password').fill('definitely-wrong-password');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await expectVisible(p.getByText('Invalid email or password.'));
    // The client Firebase state (if any) must NOT count as authenticated:
    // navigating to /admin bounces straight back to /login, and the
    // session endpoint reports no session.
    await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(`${BASE}/login`, { timeout: 15000 });
    const me = await p.request.get(`${BASE}/api/auth/session`);
    expect((await me.json()).admin).toBeNull();
  });

  it('correct credentials establish a server session and reach the dashboard', async () => {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.locator('#admin-email').fill(ADMIN_EMAIL);
    await p.locator('#admin-password').fill(ADMIN_PASSWORD);
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForURL(`${BASE}/admin`, { timeout: 20000 });
    await expectVisible(p.getByText('E2E Root Admin'));
  });

  it('the session survives navigation, several pages and a full refresh', async () => {
    await p.goto(`${BASE}/admin/events`, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(`${BASE}/admin/events`, { timeout: 15000 });
    await p.goto(`${BASE}/admin/ushers`, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(`${BASE}/admin/ushers`, { timeout: 15000 });
    await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await expectVisible(p.getByText('E2E Root Admin'));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await expectVisible(p.getByText('E2E Root Admin'), 20000); // still authenticated
    // Stay a while — the session must not vanish on its own.
    await p.waitForTimeout(4000);
    await expectVisible(p.getByText('E2E Root Admin'));
  });

  it('password-reset request shows immediate, visible confirmation', async () => {
    const p = await (await browser.newContext()).newPage(); // isolated: no admin session
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.locator('#admin-email').fill(ADMIN_EMAIL);
    await p.getByRole('button', { name: /forgot password/i }).click();
    await expectVisible(p.getByText('Password reset email sent. Check your inbox.'), 15000);
    // and the button reflects the sent state instead of doing nothing
    await expectVisible(p.getByRole('button', { name: 'Reset email sent' }));
  });

  it('logout terminates the session: /admin gates afterwards, and a second login works', async () => {
    // Isolated context: the previous test is still signed in, and /login
    // legitimately redirects an already-authenticated admin to /admin.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await p.locator('#admin-email').fill(ADMIN_EMAIL);
      await p.locator('#admin-password').fill(ADMIN_PASSWORD);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(`${BASE}/admin`, { timeout: 20000 });
      await p.getByRole('button', { name: 'Sign out' }).click();
      await p.waitForURL(`${BASE}/`, { timeout: 15000 });
      await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await p.waitForURL(`${BASE}/login`, { timeout: 15000 });

      // login again — the sequence must be repeatable
      await p.locator('#admin-email').fill(ADMIN_EMAIL);
      await p.locator('#admin-password').fill(ADMIN_PASSWORD);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(`${BASE}/admin`, { timeout: 20000 });
      await expectVisible(p.getByText('E2E Root Admin'));
    } finally {
      await ctx.close();
    }
  });
});

describe('dashboard: progressive load, no duplicate session checks, no permission flash', () => {
  it('renders the dashboard with ONE session GET and independent widget panels', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      const sessionGets: string[] = [];
      p.on('request', (r) => {
        if (r.url().includes('/api/auth/session') && r.method() === 'GET') sessionGets.push(r.url());
      });
      await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await p.locator('#admin-email').fill(ADMIN_EMAIL);
      await p.locator('#admin-password').fill(ADMIN_PASSWORD);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(`${BASE}/admin`, { timeout: 20000 });

      // The four widget panels all populate (each via its own request).
      await expectVisible(p.getByText('Scanning —', { exact: false }), 20000);
      await expectVisible(p.getByRole('heading', { name: 'Ushers' }), 20000);
      await expectVisible(p.getByRole('heading', { name: 'Recent scans' }), 20000);
      await expectVisible(p.getByRole('heading', { name: 'Latest batches' }), 20000);

      await p.waitForTimeout(3000);
      // Exactly TWO session GETs for the entire flow — one from the login
      // page's already-authenticated check + ONE for the whole admin area
      // (layout + pages share a single session fetch; regression: 4+).
      expect(sessionGets.length).toBe(2);
      // A ROOT_ADMIN never sees a false permission flash.
      expect(await p.getByText('You lack').count()).toBe(0);
    } finally {
      await ctx.close();
    }
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
  it('serves a valid manifest with the Event Access identity', async () => {
    const r = await page.request.get(`${BASE}/manifest.webmanifest`);
    expect(r.status()).toBe(200);
    const manifest = await r.json();
    expect(manifest.name).toBe('Event Access');
    expect(manifest.short_name).toBe('Event Access');
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

  it('NEVER serves /api responses (including /api/auth/session) from cache when offline', async () => {
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
      await fetch('/api/auth/session').catch(() => undefined);
    });
    await ctx.setOffline(true);
    const result = await p.evaluate(async () => {
      const attempt = async (url: string) => {
        try {
          const r = await fetch(url);
          return { ok: true, status: r.status };
        } catch {
          return { ok: false };
        }
      };
      return {
        usher: await attempt('/api/usher/session'),
        auth: await attempt('/api/auth/session'),
      };
    });
    await ctx.setOffline(false);
    await ctx.close();
    expect(result.usher.ok).toBe(false); // network failure — NOT a cached replay
    expect(result.auth.ok).toBe(false);
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
    await enterPin(p, USHER_PIN);
    await p.waitForURL(`${BASE}/scan`, { timeout: 15000 });
    await p.getByRole('button', { name: /Start Scanner/ }).click();
    // getUserMedia is denied → the catch path must show the permission
    // instruction (NOT a crash or a silent hang).
    await expectVisible(p.getByText(/Could not start the camera|Camera permission was denied/i), 30000);
    await ctx.close();
  });
});

describe('camera start', () => {
  // Regression: the <video> element must be mounted BEFORE qr-scanner
  // starts, or it has no element to attach to and never calls getUserMedia —
  // the browser prompt never appears and the usher sees a bogus "allow
  // camera manually" error. Fake media stream simulates a working camera.
  it('actually starts the camera when permission is granted (prompt would appear on a real device)', async () => {
    const fakeCam = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    try {
      const ctx = await fakeCam.newContext();
      const p = await ctx.newPage();
      await enterPin(p, USHER_PIN);
      await p.waitForURL(`${BASE}/scan`, { timeout: 15000 });

      // <video> is ATTACHED even before scanning starts (visibility is
      // irrelevant — qr-scanner only needs it present in the DOM before
      // start() is called)
      await p.locator('#qr-video').waitFor({ state: 'attached', timeout: 10000 });

      await p.getByRole('button', { name: /Start Scanner/ }).click();
      // the video element actually starts playing = getUserMedia really ran
      await expectVisible(p.locator('#qr-video'), 30000);
      await expectVisible(p.getByRole('button', { name: /Pause scanner/i }), 10000);
      // no error banner
      expect(await p.getByText(/Could not start the camera|Camera permission was denied/i).count()).toBe(0);
      await ctx.close();
    } finally {
      await fakeCam.close();
    }
  });
});

describe('QR decode — the camera actually READS a code and checks it in', () => {
  // The ultimate scanner regression: a real QR image is fed through
  // Chromium's fake camera (--use-file-for-fake-device-capture) so the
  // whole chain runs: getUserMedia → qr-scanner decode → /api/scan
  // transaction → ACCESS GRANTED. Guards against the "camera shows but
  // nothing ever scans" failure mode (native BarcodeDetector path).
  it.skipIf(!FFMPEG_OK)('points the camera at a card and gets ACCESS GRANTED automatically', async () => {
    const inv = await seedE2EInvitation('E2E-00001');
    const feedPath = '/tmp/e2e-qr-feed.y4m';
    await renderQrFeed(inv.token, feedPath);

    const cam = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // NOTE: the flag is use-file-for-fake-VIDEO-capture (a wrong name is
        // silently ignored → the default green rolling-ball feed decodes
        // nothing) and it only reads Y4M, not JPEG/PNG.
        `--use-file-for-fake-video-capture=${feedPath}`,
      ],
    });
    try {
      const ctx = await cam.newContext();
      const p = await ctx.newPage();
      await enterPin(p, USHER_PIN);
      await p.waitForURL(`${BASE}/scan`, { timeout: 15000 });

      await p.getByRole('button', { name: /Start Scanner/ }).click();
      await expectVisible(p.locator('#qr-video'), 30000);

      // decode → submit → server transaction → granted banner
      await expectVisible(p.getByText('ACCESS GRANTED'), 30000);
      await expectVisible(p.getByText(`No. ${inv.serial}`), 5000);

      // the invitation is consumed in the emulator transaction
      const snap = await inv.ref.get();
      expect(snap.data()?.status).toBe('used');
      await ctx.close();
    } finally {
      await cam.close();
      await inv.ref.delete().catch(() => undefined);
      await adminDeleteApp(inv.app).catch(() => undefined);
    }
  });
});

describe('manual serial entry — type the printed serial, get the verdict', () => {
  it('Check button + serial with a hyphen resolves the invitation (legacy shape)', async () => {
    const inv = await seedE2EInvitation('E2E-00002');
    try {
      // Earlier suites may have left this shared page logged in already.
      await page.goto(`${BASE}/scan`);
      await page.waitForTimeout(1500);
      if (page.url().includes('/usher/login')) {
        await enterPin(page, USHER_PIN);
        await page.waitForURL(`${BASE}/scan`, { timeout: 15000 });
      }

      // manual entry is visible on the scan screen WITHOUT starting the camera
      await expectVisible(page.locator('#manual-entry'), 10000);
      await page.locator('#manual-entry').fill('E2E-00002');
      await page.getByRole('button', { name: /^Check$/ }).click();
      await expectVisible(page.getByText('ACCESS GRANTED'), 15000);
      await expectVisible(page.getByText(`No. ${inv.serial}`), 5000);
    } finally {
      await inv.ref.delete().catch(() => undefined);
      await adminDeleteApp(inv.app).catch(() => undefined);
    }
  });

  it('hyphenless serial also works, and an unknown serial is DENIED', async () => {
    const inv = await seedE2EInvitation('E2E-00003');
    try {
      // The previous test's Check is still inside the 2.5s submit cooldown —
      // wait it out or this first submission is silently dropped.
      await page.waitForTimeout(3000);
      await page.locator('#manual-entry').fill('iswed00003'); // wrong serial → denied
      await page.getByRole('button', { name: /^Check$/ }).click();
      await expectVisible(page.getByText('DENIED'), 15000);

      // submitToken enforces a 2.5s cooldown after every submission —
      // wait it out so the next Check is actually sent.
      await page.waitForTimeout(2600);
      await page.locator('#manual-entry').fill('E2E00003'); // correct, hyphenless
      await page.getByRole('button', { name: /^Check$/ }).click();
      await expectVisible(page.getByText('ACCESS GRANTED'), 15000);
    } finally {
      await inv.ref.delete().catch(() => undefined);
      await adminDeleteApp(inv.app).catch(() => undefined);
    }
  });
});
