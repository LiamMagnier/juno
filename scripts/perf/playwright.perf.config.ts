import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * Runs e2e specs against a server you started yourself (no webServer block):
 *   PERF_BASE_URL=http://localhost:3201 PERF_STORAGE_STATE=/path/state.json \
 *     npx playwright test --config scripts/perf/playwright.perf.config.ts e2e/transcript-window.spec.ts
 * Chrome stable (`channel: "chrome"`): the bundled Chromium dies after ~30 s here.
 */
export default defineConfig({
  testDir: path.join(__dirname, "..", "..", "e2e"),
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: process.env.PERF_BASE_URL ?? "http://localhost:3201",
    storageState: process.env.PERF_STORAGE_STATE ?? path.join(__dirname, "..", "..", "e2e", ".auth", "e2e-user.json"),
  },
});
