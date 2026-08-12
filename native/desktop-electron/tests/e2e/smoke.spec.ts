/**
 * Launch smoke test.
 *
 * The one thing no unit test can tell you: that the three processes actually
 * come up together. Main starts, the custom `juno://` scheme is registered and
 * serves the renderer, preload runs under `sandbox: true` and exposes its
 * bridge, and a window appears. Every unit test in `tests/unit` is meaningless
 * if this fails.
 *
 * It runs against the **built** app (`out/main/index.js`), not the sources,
 * because the packaging step is part of what is being tested — a preload that
 * fails to bundle is invisible until something loads it.
 *
 * If the app has not been built, the suite skips with an explanation rather
 * than failing. A red suite on a clean checkout is a suite people learn to
 * ignore, and "you have not run `npm run build`" is not a defect report.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const mainEntry = `${appRoot}out/main/index.js`;
const isBuilt = existsSync(mainEntry);

const NOT_BUILT_REASON =
  `Not built: ${mainEntry} does not exist. ` +
  'Run `npm run build` in native/desktop-electron first; `npm run test:e2e` does not build for you.';

if (!isBuilt) {
  /* Playwright records the skip reason as an annotation, which the default
     `list` reporter does not print. Say it on stderr too, so the person who
     just ran the suite is told why it did nothing instead of reading a column
     of dashes. */
  console.warn(`\n[e2e] Skipping the Electron smoke suite.\n[e2e] ${NOT_BUILT_REASON}\n`);
}

test.describe('the packaged app launches', () => {
  test.skip(!isBuilt, NOT_BUILT_REASON);

  let app: ElectronApplication;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [mainEntry],
      cwd: appRoot,
      env: {
        ...process.env,
        /* Marks the run so main can keep its state out of the real user data
           directory. Read by main; harmless if it is not yet honoured. */
        JUNO_E2E: '1',
        NODE_ENV: 'production',
      },
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('opens exactly one window', async () => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windowCount, 'the app should open one window, not zero and not two').toBe(1);
  });

  test('the window carries the product name as its title', async () => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();

    /* Asserted as a pattern rather than an exact string: the title bar is
       custom-drawn and the document title is expected to gain a session or
       workspace suffix. What must never happen is the Electron default
       ("index.html", or the file path), which is what an unset <title> gives
       you and what ships to users if nobody checks. */
    expect(title, `window title was ${JSON.stringify(title)}`).toMatch(/^Juno\b/);
    expect(title).not.toMatch(/\.html?$/i);
    expect(title.trim().length).toBeGreaterThan(0);
  });

  test('the window is visible and not zero-sized', async () => {
    await app.firstWindow();

    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const [first] = BrowserWindow.getAllWindows();
      if (!first) return null;
      const { width, height } = first.getBounds();
      return { width, height, visible: first.isVisible() };
    });

    expect(bounds).not.toBeNull();
    expect(bounds?.visible, 'a window that never shows looks like a hang to the user').toBe(true);
    expect(bounds?.width ?? 0).toBeGreaterThan(400);
    expect(bounds?.height ?? 0).toBeGreaterThan(300);
  });

  test('the renderer is served from the app scheme, not from file://', async () => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    /* `file://` origins are opaque, which is why `src/main/security.ts` chose a
       registered standard scheme. If this ever regresses to `file://`, the CSP
       and the navigation policy both weaken without any of their own tests
       failing. */
    expect(window.url()).toMatch(/^juno:\/\/app(\/|$)/);
  });

  test('the renderer has no access to Node', async () => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    /* The runtime half of `SECURE_WEB_PREFERENCES`. The unit test proves the
       object says `nodeIntegration: false`; only a launched app proves the
       window was actually created with it. */
    const exposure = await window.evaluate(() => ({
      hasRequire: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
      hasProcess: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined',
      hasModule: typeof (globalThis as Record<string, unknown>)['module'] !== 'undefined',
      hasBridge: typeof (globalThis as Record<string, unknown>)['juno'] !== 'undefined',
    }));

    expect(exposure.hasRequire, 'require() is reachable from the renderer').toBe(false);
    expect(exposure.hasProcess, 'process is reachable from the renderer').toBe(false);
    expect(exposure.hasModule, 'module is reachable from the renderer').toBe(false);
    /* The bridge is the *only* thing preload should add. */
    expect(exposure.hasBridge, 'window.juno was not exposed by preload').toBe(true);
  });
});
