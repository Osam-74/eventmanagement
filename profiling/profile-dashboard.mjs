// Production-build dashboard profiler.
// Logs in via the real /login UI as ROOT_ADMIN against the Auth emulator,
// then navigates to /admin (and /admin/generate) and records every network
// request: url, status, size (encodedDataLength), duration, duplicates.
import { chromium } from 'playwright';

const BASE = process.env.PROF_BASE_URL ?? 'http://127.0.0.1:3222';
const EMAIL = 'perf-root@example.test';
const PASSWORD = 'perf-root-pass-12345';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const requests = new Map(); // requestId -> record
const order = [];
cdp.on('Network.requestWillBeSent', (e) => {
  const { requestId, request, timestamp, redirectResponse } = e;
  if (redirectResponse) return; // count only the final leg
  const rec = requests.get(requestId) ?? { url: request.url, method: request.method, start: timestamp, status: null, size: null, end: null, failed: null };
  requests.set(requestId, rec);
  order.push(requestId);
});
cdp.on('Network.responseReceived', (e) => {
  const rec = requests.get(e.requestId);
  if (rec) { rec.status = e.response.status; rec.headers = e.response.headers; }
});
cdp.on('Network.loadingFinished', (e) => {
  const rec = requests.get(e.requestId);
  if (rec) { rec.end = e.timestamp; rec.size = e.encodedDataLength; }
});
cdp.on('Network.loadingFailed', (e) => {
  const rec = requests.get(e.requestId);
  if (rec) { rec.failed = e.errorText; rec.end = e.timestamp; }
});
await cdp.send('Network.enable');

const t0 = Date.now();
console.log('[login] going to /login');
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL('**/admin', { timeout: 30000 });
console.log(`[login] landed on ${page.url()} after ${Date.now() - t0}ms`);

const snap = (label) => {
  const recs = order.map((id) => requests.get(id)).filter(Boolean);
  const api = recs.filter((r) => r.url.includes('/api/'));
  const summary = api.map((r) => ({
    url: r.url.replace(BASE, ''),
    status: r.status,
    ms: r.end != null ? Math.round((r.end - r.start) * 1000) : null,
    size: r.size,
    failed: r.failed,
  }));
  console.log(`\n=== ${label} — ${api.length} API requests ===`);
  console.log(JSON.stringify(summary, null, 1));
  // duplicates by url
  const counts = {};
  for (const r of api) counts[r.url] = (counts[r.url] ?? 0) + 1;
  const dups = Object.entries(counts).filter(([, n]) => n > 1);
  console.log(`duplicates: ${dups.length ? JSON.stringify(dups) : 'none'}`);
};

// --- Profile /admin initial load: reload with a clean client-side state? No —
// we want the realistic first-entry AFTER login (exactly what the user does).
// The login redirect already landed us on /admin; capture what already fired:
await page.waitForTimeout(12000); // let initial load + 2 poll ticks happen
snap('AFTER LOGIN LANDING ON /admin (12s window)');
console.log('flash "You lack":', await page.locator('text=You lack').count());
console.log('flash "Create or select an event":', await page.locator('text=Create or select an event').count());
console.log('still "Loading dashboard":', await page.locator('text=Loading dashboard').count());
const shellMs = await page.evaluate(() => performance.now());
console.log('time on page now (ms):', Math.round(shellMs));

// --- Second navigation: /admin/generate (client-side nav, not reload)
requests.clear();
order.length = 0;
await page.click('a[href="/admin/generate"]');
await page.waitForTimeout(6000);
snap('NAVIGATE TO /admin/generate (6s window)');
console.log('flash "You lack" on generate:', await page.locator('text=You lack').count());

// --- Full reload of /admin (repeat-visit profile)
requests.clear();
order.length = 0;
await page.goto(`${BASE}/admin`, { waitUntil: 'commit' });
await page.waitForTimeout(10000);
snap('FULL RELOAD /admin (10s window)');
console.log('after reload — "Create or select an event":', await page.locator('text=Create or select an event').count());
console.log('after reload — "Loading dashboard":', await page.locator('text=Loading dashboard').count());
console.log('after reload — "Scanning —":', await page.locator('text=Scanning —').count());

await browser.close();
