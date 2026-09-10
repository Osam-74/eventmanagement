// Reproduce: login → logout → second login (the failing e2e path)
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3222';
const EMAIL = 'perf-root@example.test';
const PASSWORD = 'perf-root-pass-12345';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const p = await ctx.newPage();
p.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text().slice(0, 160)));

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/admin', { timeout: 20000 });
}

await login(p);
console.log('login 1 OK:', p.url());
await p.waitForTimeout(2000);
console.log('body1:', (await p.textContent('body'))?.slice(0, 120).replace(/\s+/g, ' '));

await p.getByRole('button', { name: 'Sign out' }).click();
await p.waitForURL(`${BASE}/`, { timeout: 15000 });
console.log('signed out, url:', p.url());

await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.locator('input[type="email"]').fill(EMAIL);
await p.locator('input[type="password"]').fill(PASSWORD);
await p.getByRole('button', { name: 'Sign in' }).click();
try {
  await p.waitForURL('**/admin', { timeout: 20000 });
} catch {
  console.log('SECOND LOGIN DID NOT REACH /admin; url:', p.url());
}
await p.waitForTimeout(5000);
console.log('final url:', p.url());
console.log('innerText:', (await p.evaluate(() => document.body.innerText)).slice(0, 500).replace(/\s+/g, ' '));
await browser.close();
