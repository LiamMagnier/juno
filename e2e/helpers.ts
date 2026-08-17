import { type Page } from "@playwright/test";

export const E2E_EMAIL = "e2e@juno.test";
export const E2E_PASSWORD = "E2E-Test-Password-2026!";

/** The composer text field shared by the workspace layouts. */
export function composer(page: Page) {
  return page.locator("textarea, input[placeholder*='Ask'], [contenteditable]").first();
}