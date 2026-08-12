/**
 * Playwright configuration for the Electron end-to-end suite.
 *
 * Deliberately minimal. Playwright's Electron support drives a real application
 * process through `_electron.launch`, so almost none of the browser-oriented
 * configuration applies: there is no `webServer` to start, no browser to pick,
 * no device to emulate, and no base URL — the app serves itself from the `juno://`
 * scheme.
 *
 * `npm run test:e2e` runs this. It is intentionally *not* part of `npm test`:
 * these tests need `npm run build` to have produced `out/main/index.js` first,
 * and a suite that fails on a clean checkout teaches people to ignore it. The
 * smoke test skips itself, loudly, when the build output is absent.
 */

import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /* One Electron application at a time. Two instances would race for the
     SQLite database and the agent host's port — the single-instance lock in
     `applyProcessSecurityPolicy` would make the second one quit, and the
     resulting failure would look like a product bug. */
  fullyParallel: false,
  workers: 1,

  /* Launching Electron, waiting for the first window and letting the renderer
     paint is comfortably slower than a page navigation. */
  timeout: 60_000,
  expect: { timeout: 10_000 },

  /* A retried E2E failure is a flake to investigate, not a pass. One retry on
     CI only, so a genuine regression still fails the run twice. */
  retries: isCI ? 1 : 0,
  /* `.only` left in a file silently narrows the suite to one test. */
  forbidOnly: isCI,

  reporter: isCI ? [['github'], ['list']] : [['list']],

  use: {
    /* Artifacts only for failures — a green run should leave nothing behind. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  outputDir: './node_modules/.cache/playwright',
});
