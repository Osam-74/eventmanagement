// EXACT e2e logout-test sequence, with network + console tracing
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3222';
const EMAIL = 'perf-root@example.test';
const PASSWORD = 'perf-root-pass-12345';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const p = await ctx.newPage();
p.on('response', async (r) => {
  if (r.url().includes('/api/auth/session')) {
    let body = '';
    try { body = JSON.stringify(await r.json()).slice(0, 120); } catch {}
    console.log(`[net] ${r.request().method()} ${r.url().replace(BASE, '')} -> ${r.status()} ${body}`);
    const sc = r.headers()['set-cookie'] ?? '';
    if (sc) console.log('        set-cookie:', sc.slice(0, 90));
  } else if (r.status() === 401) {
    console.log('[401]', r.request().method(), r.url().replace(BASE, ''));
  }
});
let fullLoads = 0;
p.on('framenavigated', (f) => { if (f === p.mainFrame()) { fullLoads++; console.log('[nav#'+fullLoads+']', f.url().replace(BASE, '')); } });
p.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('[console]', m.type(), m.text().slice(0, 200)));

console.log('--- step 1: first login');
await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.locator('input[type="email"]').fill(EMAIL);
await p.locator('input[type="password"]').fill(PASSWORD);
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL('**/admin', { timeout: 20000 });

console.log('--- step 2: immediate sign out');
await p.getByRole('button', { name: 'Sign out' }).click();
try { await p.waitForURL(`${BASE}/`, { timeout: 15000 }); } catch (e) { console.log('(!) never landed on / — at', p.url()); }
await p.waitForTimeout(2000);
console.log('post-signout url:', p.url());

console.log('--- step 3: goto /admin (expect client gate redirect to /login)');
await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await p.waitForURL('**/login', { timeout: 15000 });
console.log('gated to:', p.url());

console.log('--- step 4: second login (client nav, NO reload)');await p.waitForTimeout(1000);
await p.locator('input[type="email"]').fill(EMAIL);
await p.locator('input[type="password"]').fill(PASSWORD);
await p.getByRole('button', { name: 'Sign in' }).click();
try {
  await p.waitForURL('**/admin', { timeout: 20000 });
  console.log('reached /admin');
} catch {
  console.log('NEVER reached /admin — at', p.url());
}
await p.waitForTimeout(12000);
console.log('final url:', p.url());
console.log('innerText:', (await p.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\s+/g, ' '));
await browser.close();
