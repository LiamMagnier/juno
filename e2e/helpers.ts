import { type Page } from "@playwright/test";

// Local defaults keep the deterministic seed flow convenient; CI/production
// smoke runs must provide their own controlled account through environment
// variables rather than silently reusing a test credential.
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Password-2026!";

/** The composer text field shared by the workspace layouts. */
export function composer(page: Page) {
  return page.locator("#juno-composer-textarea, textarea").first();
}
