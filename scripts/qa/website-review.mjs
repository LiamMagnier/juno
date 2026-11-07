// Local real-component fixture review. Does not authenticate or call models.
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local development server.');
const output = path.resolve(process.argv[3] || 'test-results/website-review');
const pages = ['projects', 'project', 'library', 'artifacts', 'connections', 'agents', 'automations', 'skills', 'instructions', 'memory', 'compare', 'code', 'settings', 'notifications', 'search'];
const browser = await chromium.launch({ executablePath: process.env.ORBIT_CHROMIUM || undefined, headless: true });
const failures = [], captures = [], checks = [];
const capture = async (page, file) => {
  await page.screenshot({ path: path.join(output, file), animations: 'disabled', style: 'nextjs-portal { visibility: hidden; }' });
  captures.push(file);
};
try {
  for (const mode of ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark']) {
    await mkdir(path.join(output, mode), { recursive: true });
    const context = await browser.newContext({ viewport: mode.startsWith('mobile') ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mode.startsWith('mobile'), hasTouch: mode.startsWith('mobile'), colorScheme: mode.endsWith('dark') ? 'dark' : 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    let route = '';
    page.on('pageerror', error => failures.push(`${mode}/${route}: ${error.message}`));
    for (route of pages) {
      await page.goto(new URL(route === 'project' ? '/dev/pages/project/p-atlas' : `/dev/pages?page=${route}`, base).href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.locator('#juno-main').waitFor({ state: 'attached' });
      await page.evaluate(() => document.fonts.ready);
      if (route === 'notifications' || route === 'search') await page.waitForTimeout(900);
      else await page.waitForTimeout(450);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) failures.push(`${mode}/${route}: horizontal document overflow`);
      await capture(page, `${mode}/${route}.png`);
      console.log(`${mode}/${route}`);
    }
    if (mode === 'desktop-light') {
      for (const [routeName, label, query] of [['projects','Search projects','Atlas'], ['library','Search the library','Pricing'], ['connections','Search apps','GitHub']]) {
        await page.goto(new URL(`/dev/pages?page=${routeName}`, base).href, { waitUntil: 'domcontentloaded' });
        const search = page.getByRole('searchbox', { name: label });
        await search.fill(query);
        await page.getByRole('button', { name: `Clear ${label.toLowerCase()}` }).click();
        await expect(search).toBeFocused();
        await expect(search).toHaveValue('');
        await search.fill(query);
        await search.press('Escape');
        await expect(search).toHaveValue('');
        checks.push(`${routeName}: clear and Escape retain search focus`);
      }
      await page.goto(new URL('/dev/pages?page=projects', base).href);
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await capture(page, 'desktop-light/new-project-dialog.png');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeFocused();
      checks.push('Project dialog: Escape dismisses and restores trigger focus');
    }
    await context.close();
  }
  // Empty, loading and failure states are real components fed deterministic data.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await mkdir(path.join(output, 'states'), { recursive: true });
  for (const state of ['empty', 'loading', 'error']) {
    for (const route of ['projects', 'library', 'connections', 'automations', 'skills']) {
      await page.goto(new URL(`/dev/pages?page=${route}&state=${state}`, base).href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.locator('#juno-main').waitFor({ state: 'attached' });
      await page.waitForTimeout(550);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route}/${state} overflows`);
      await capture(page, `states/${route}-${state}.png`);
      console.log(`${route}/${state}`);
    }
  }
  await context.close();
  const report = { capturedAt: new Date().toISOString(), pages, checks, failures, captures, limitation: 'Local deterministic fixtures; no production credentials, live models, native runtime, or actual desktop stream.' };
  await writeFile(path.join(output, 'review.json'), JSON.stringify(report, null, 2));
  const cards = [];
  for (const name of pages) {
    let before = '';
    try { await access(path.join(output, 'before', `${name}.png`)); before = `<figure><img src="before/${name}.png" loading="lazy"><figcaption>Before</figcaption></figure>`; } catch {}
    cards.push(`<section id="${name}"><h2>${name}</h2><div class="pair">${before}<figure><img src="desktop-light/${name}.png" loading="lazy"><figcaption>After · desktop</figcaption></figure></div><details><summary>Dark & mobile</summary><div class="pair"><img src="desktop-dark/${name}.png" loading="lazy"><img src="mobile-light/${name}.png" loading="lazy"><img src="mobile-dark/${name}.png" loading="lazy"></div></details></section>`);
  }
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Alevr design review</title><style>body{font:15px/1.6 system-ui;margin:0;background:#f3f4f5;color:#17191e}header,main{max-width:1440px;margin:auto;padding:36px}h1{font-size:40px;letter-spacing:-.045em}h2{text-transform:capitalize;font-size:24px}nav{display:flex;flex-wrap:wrap;gap:16px}a{color:#3544be}section{margin-block:48px;scroll-margin-top:24px}.pair{display:flex;align-items:flex-start;gap:16px;overflow:auto}figure{margin:0;flex:1;min-width:300px}img{width:100%;border:1px solid #d6d8df;border-radius:12px;vertical-align:top}.pair>img{min-width:260px;max-width:48%;height:auto}figcaption{padding:8px;color:#5c6370}summary{cursor:pointer;padding:12px 0}details img{margin-top:8px}@media(max-width:700px){header,main{padding:20px}.pair{flex-direction:column}.pair>img{max-width:100%;min-width:0}}</style><header><h1>Alevr · design review</h1><p>Real components, captured in light, dark and phone layouts. Before/after images show the website refinement; Orbit's lifecycle review is captured separately. These fixtures do not verify live account or computer operations.</p><nav>${pages.map(p=>`<a href="#${p}">${p}</a>`).join('')}</nav></header><main>${cards.join('')}</main></html>`);
  assert.deepEqual(failures, [], 'Browser review failures');
  console.log(`PASS: ${captures.length} captures; ${checks.length} interaction checks.`);
} finally { await browser.close(); }
