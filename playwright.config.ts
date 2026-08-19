import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const storageState = path.join(process.cwd(), "e2e", ".auth", "e2e-user.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: "list",
  use: {
    baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    // Signs in once through the real credential UI and saves the session for
    // every browser project below. auth.spec.ts opts back out to anonymous via
    // `test.use` so the sign-in surfaces are tested unauthenticated.
    {
      name: "setup",
      testMatch: /setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], storageState },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], storageState },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 14"], storageState },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    {
      name: "iPad Safari",
      use: { ...devices["iPad Pro 11"], storageState },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    // The anonymous sign-in surface, once per browser, without storage state.
    {
      name: "anon-auth",
      testMatch: /auth\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});