import { chromium } from '@playwright/test';
const OUT = process.argv[2]; const BASE = 'http://localhost:3000';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const routes = ['/projects','/library','/memory','/settings','/profile','/code','/code/new','/code/pulls','/work','/work/schedules','/work/skills','/work/permissions','/connections','/assistants','/compare','/tasks','/artifacts','/upgrade','/design','/roadmap','/admin','/admin/users'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await ctx.addInitScript(() => { try { localStorage.setItem('juno:consent:v1', JSON.stringify({essential:true,analytics:false,ts:Date.now()})); localStorage.setItem('juno:onboarded:v1','1'); } catch {} });
if (!ONLY || ONLY.includes('public')) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.screenshot({ path: `${OUT}/00-landing.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${OUT}/00-landing-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(BASE + '/sign-in', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/01-sign-in.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${OUT}/01-sign-in-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(BASE + '/sign-up', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/01-sign-up.png` });
  await page.goto(BASE + '/forgot-password', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/01-forgot.png` });
  await page.goto(BASE + '/legal/cgu', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/02-legal.png` });
}
await page.goto(BASE + '/sign-in');
await page.waitForSelector('input[name="email"]:not([disabled])');
await page.fill('input[name="email"]', 'e2e@juno.test');
await page.fill('input[name="password"]', 'E2E-Test-Password-2026!');
await page.click('button[type="submit"]');
await page.waitForURL(/\/chat/, { timeout: 60000 });
await page.evaluate(() => localStorage.setItem('juno:onboarded:v1', '1'));
// project detail id
let projectId = null;
try {
  const res = await page.request.get(BASE + '/api/projects');
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.projects ?? []);
  projectId = list[0]?.id ?? null;
} catch {}
const all = [...routes];
if (projectId) all.push(`/projects/${projectId}`);
for (const theme of ['light','dark']) {
  await page.emulateMedia({ colorScheme: theme });
  for (const r of all) {
    if (ONLY && !ONLY.includes(r)) continue;
    try {
      await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${theme}-${r.replace(/\//g,'_').replace(/[^a-z0-9_-]/gi,'')}.png` });
    } catch (e) { console.log('fail', r, e.message.split('\n')[0]); }
  }
  // settings modal
  if (!ONLY || ONLY.includes('modal')) {
    try {
      await page.goto(BASE + '/chat', { waitUntil: 'networkidle', timeout: 60000 });
      for (const sec of ['general','memory','billing']) {
        await page.evaluate((s) => window.dispatchEvent(new CustomEvent('juno:settings', { detail: s })), sec);
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${OUT}/${theme}-modal-${sec}.png` });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } catch (e) { console.log('fail modal', e.message.split('\n')[0]); }
  }
}
await browser.close();
console.log('done');
