import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import path from "node:path";
import { checkBaseUrl, filterToAllowlist, readTestEnv } from "./scripts/qa/lib/safe-env.mjs";

/*
 * Playwright runs only through the QA runner (spec §14, P0 (3)):
 *
 *   npm run test:e2e -- [playwright args]      →  bash scripts/qa/run-prod-e2e.sh
 *
 * The runner refuses non-local databases, .env files and remote base URLs,
 * creates a disposable *_test database, picks a free port, and starts this
 * config with an allowlisted environment and ALEVR_QA_RUNNER=1. Without that
 * variable the config throws before any web server starts, so a plain
 * `npx playwright test` can no longer launch `npm run dev` or reuse whatever
 * happens to be listening on port 3000.
 *
 * The server is always a production build (`node scripts/qa/serve-prod.mjs`:
 * next build, then next start on 127.0.0.1:$E2E_PORT), never reused.
 */

if (process.env.ALEVR_QA_RUNNER !== "1") {
  throw new Error(
    "Playwright must be started by the QA runner: npm run test:e2e (bash scripts/qa/run-prod-e2e.sh). " +
      "It refuses unsafe databases and env files, builds production, and tears everything down. " +
      "Plain `npx playwright test` is refused so it can never start a dev server or reuse port 3000."
  );
}

const ROOT = __dirname;
const isCI = !!process.env.CI;

const baseUrlProblem = checkBaseUrl(process.env.E2E_BASE_URL);
if (baseUrlProblem) throw new Error(baseUrlProblem);
const externalBaseURL = process.env.E2E_BASE_URL || "";
const port = Number(process.env.E2E_PORT || 0);
if (!externalBaseURL && !(Number.isInteger(port) && port > 0)) {
  throw new Error("E2E_PORT is not set. The QA runner picks a free port and sets it; start Playwright through npm run test:e2e.");
}
const baseURL = externalBaseURL || `http://127.0.0.1:${port}`;

const storageState = path.join(ROOT, "e2e", ".auth", "e2e-user.json");
// Local runs may use an installed Chrome instead of Playwright's download
// (run-prod-e2e.sh --chromium-channel chrome). CI uses the bundled browsers.
const chromiumChannel = process.env.ALEVR_QA_CHROMIUM_CHANNEL || undefined;
const withChannel = <T extends object>(device: T): T => (chromiumChannel ? { ...device, channel: chromiumChannel } : device);

// The pre-wave-2 suites keep their projects; the wave-2 suites (e2e/wave2/**)
// run on the matrix projects below instead.
const legacyIgnore = [/auth\.spec\.ts/, /wave2[\\/]/];
const wave2Match = /wave2[\\/].*\.spec\.ts$/;

const phone = { width: 390, height: 844 };

const config: PlaywrightTestConfig = {
  testDir: "./e2e",
  // Playwright empties its output folder at the start of a run. Keeping it in
  // a subfolder leaves the runner's gate reports (test-results/design-gates),
  // screenshots (test-results/visual-matrix) and geometry alone.
  outputDir: "test-results/playwright",
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : 1,
  reporter: isCI
    ? [["list"], ["json", { outputFile: "test-results/playwright-report.json" }], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // Signs in once through the real credential UI against the seeded account
    // and saves the session for every authenticated project below.
    {
      name: "setup",
      testMatch: /setup\.ts/,
      use: withChannel({ ...devices["Desktop Chrome"] }),
    },
    {
      name: "chromium",
      use: withChannel({ ...devices["Desktop Chrome"], storageState }),
      dependencies: ["setup"],
      testIgnore: legacyIgnore,
    },
    ...(isCI
      ? [
          {
            name: "firefox",
            use: { ...devices["Desktop Firefox"], storageState },
            dependencies: ["setup"],
            testIgnore: legacyIgnore,
          },
        ]
      : []),
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], storageState },
      dependencies: ["setup"],
      testIgnore: legacyIgnore,
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 14"], storageState },
      dependencies: ["setup"],
      testIgnore: legacyIgnore,
    },
    {
      name: "iPad Safari",
      use: { ...devices["iPad Pro 11"], storageState },
      dependencies: ["setup"],
      testIgnore: legacyIgnore,
    },
    // The anonymous sign-in surface, without storage state.
    {
      name: "anon-auth",
      testMatch: /auth\.spec\.ts/,
      use: withChannel({ ...devices["Desktop Chrome"] }),
    },
    // Wave-2 matrix projects (spec §14): themes and reduced motion are
    // test.use variants (e2e/support/screenshot-matrix.ts).
    {
      name: "chromium-1440",
      testMatch: wave2Match,
      use: withChannel({ ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState }),
      dependencies: ["setup"],
    },
    {
      name: "chromium-390",
      testMatch: wave2Match,
      use: withChannel({ ...devices["Pixel 7"], viewport: phone, screen: phone, deviceScaleFactor: 3, storageState }),
      dependencies: ["setup"],
    },
    {
      name: "webkit-390",
      testMatch: wave2Match,
      use: { ...devices["iPhone 14"], viewport: phone, screen: phone, storageState },
      dependencies: ["setup"],
    },
  ],
};

if (!externalBaseURL) {
  const testEnv = readTestEnv(ROOT);
  config.webServer = {
    command: "node scripts/qa/serve-prod.mjs",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    // `next build` runs inside the server's start-up, so this covers the build.
    timeout: 45 * 60_000,
    // The allowlist, never ...process.env. Playwright still merges its own
    // environment underneath, which the runner has already allowlisted, and
    // serve-prod.mjs filters again before it starts Next.
    env: { ...filterToAllowlist(process.env, testEnv), ...testEnv },
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    stdout: "pipe",
    stderr: "pipe",
  };
}

export default defineConfig(config);
