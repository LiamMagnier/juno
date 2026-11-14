import { expect, test, type Page } from "@playwright/test";
import { SETTINGS_SECTIONS, WEB_SETTINGS_SECTIONS } from "../src/components/settings/settings-sections";
import { readQaFixtures, routeRenderProblem } from "./support/fixtures";

const VIEWPORTS = [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1440, height: 720 }];
const SETTINGS_ROUTES = [...SETTINGS_SECTIONS, ...WEB_SETTINGS_SECTIONS];
const ROUTE_GROUPS = {
  workspace: ["/chat", "/activity", "/projects", "/library", "/library?view=files", "/library?view=trash", "/artifacts", "/agents", "/agents/new", "/crew", "/compare", "/roadmap"],
  configuration: ["/customize", "/customize/instructions", "/connections", "/memory", "/profile", "/skills", "/skills/new", "/skills/import", "/skills/teach", "/automations", "/automations/new", "/permissions", "/upgrade", "/upgrade/welcome"],
  code: ["/code", "/code/customize", "/code/pulls"],
};
const PUBLIC_ROUTES = ["/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/auth-error", "/check-email", "/download", "/offline", "/vs", "/legal/cgu", "/legal/cgv", "/legal/confidentialite", "/legal/mentions-legales", "/share/e2e-showroom-share-token"];

async function checkLayout(page: Page, routes: string[], anonymous = false) {
  // Reduced motion removes the entrance from geometry measurements.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of routes) {
    await test.step(route, async () => {
      await page.setViewportSize(VIEWPORTS[0]);
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect.soft(routeRenderProblem({ requested: route, finalUrl: page.url(), status: response?.status() ?? 0, anonymous })).toBeNull();
      await expect.soft(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        const geometry = await page.evaluate(() => {
          const rect = document.querySelector(".juno-frame")?.getBoundingClientRect();
          return { width: document.documentElement.scrollWidth, shellBottom: rect?.bottom ?? null };
        });
        expect.soft(geometry.width, `${route} at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
        if (geometry.shellBottom !== null) {
          expect.soft(geometry.shellBottom, `${route} shell at ${viewport.height}px`).toBeLessThanOrEqual(viewport.height + 1);
        }
      }
    });
  }
}

test.describe("responsive website routes", () => {
  for (const [group, routes] of Object.entries(ROUTE_GROUPS)) {
    test(`${group} stays inside phone, landscape and desktop viewports`, async ({ page }) => {
      test.setTimeout(120_000);
      await checkLayout(page, routes);
    });
  }

  for (const { id, label } of SETTINGS_ROUTES) {
    test(`settings ${id} stays inside phone, landscape and desktop viewports`, async ({ page }) => {
      await checkLayout(page, [`/settings?section=${id}`]);
      await expect(page.getByRole("region", { name: label, exact: true })).toBeVisible();
    });
  }

  test("saved chat, research and Code sessions fit the viewport", async ({ page }) => {
    const fixture = readQaFixtures();
    test.skip(!fixture.qaThreadId || !fixture.researchRunId || !fixture.qaCodeSessionId, "Requires seeded conversations and a research run");
    await page.goto(`/research/${fixture.researchRunId}`);
    await expect(page).toHaveURL(new RegExp(`/chat/[^?]+\\?researchRun=${fixture.researchRunId}$`));
    const researchRoute = new URL(page.url());
    await checkLayout(page, [`/chat/${fixture.qaThreadId}`, `${researchRoute.pathname}${researchRoute.search}`, `/code/${fixture.qaCodeSessionId}`]);
  });

  test("the seeded project and its new-project dialog fit a phone", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto("/projects");
    const create = page.getByRole("button", { name: "New project", exact: true });
    await create.click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    const project = page.getByRole("link", { name: /E2E Showroom/ }).first();
    await expect(project).toBeVisible();
    const path = await project.getAttribute("href");
    expect(path).toMatch(/^\/projects\/[^/]+$/);
    await checkLayout(page, [path!]);
    await expect(page.getByRole("heading", { name: "E2E Showroom", exact: true })).toBeVisible();
  });

  test("public pages fit the viewport", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const page = await browser.newPage({ baseURL });
    try {
      await checkLayout(page, PUBLIC_ROUTES, true);
    } finally {
      await page.close();
    }
  });
});
