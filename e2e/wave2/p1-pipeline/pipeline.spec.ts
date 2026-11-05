import { expect, test, type Page } from "@playwright/test";

/**
 * P1-pipeline, visual acceptance (spec appendix, P1 "Visual"). Runs on a
 * production build through the P0 runner (scripts/qa/run-prod-e2e.sh); never
 * against a dev server.
 *
 * Every check here reads the compiled stylesheet as the browser applies it.
 * It needs no account and no seeded thread: it loads the anonymous sign-in
 * page (which ships globals.css like every route) and mounts the fixture DOM
 * it measures, so a missing seed can never make it pass vacuously.
 */

// Only the P0 runner (scripts/qa/run-prod-e2e.sh, which sets ALEVR_QA_RUNNER=1)
// serves a production build. Without it (P0 not on this branch, or a plain
// `playwright test` against a dev server) these checks skip instead of
// measuring the wrong stylesheet.
test.skip(process.env.ALEVR_QA_RUNNER !== "1", "needs the P0 runner (scripts/qa/run-prod-e2e.sh)");

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });

async function open(page: Page, attrs: Record<string, string> = {}) {
  await page.goto("/sign-in");
  await page.evaluate((a) => {
    for (const [name, value] of Object.entries(a)) document.documentElement.setAttribute(name, value);
  }, attrs);
}

async function mount(page: Page, html: string) {
  await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.id = "p1-fixture";
    host.innerHTML = markup;
    document.body.appendChild(host);
  }, html);
}

test("turn entrances carry no filter blur", async ({ page }) => {
  await open(page);
  await mount(page, `<div data-turn-streaming><div class="turn-body"><div id="part">A part</div></div></div>
    <div class="prose-juno" data-streaming><pre id="block">code</pre></div>`);
  for (const id of ["part", "block"]) {
    const style = await page.locator(`#${id}`).evaluate((el) => {
      const s = getComputedStyle(el);
      const keyframes = el.getAnimations().flatMap((a) => ((a.effect as KeyframeEffect | null)?.getKeyframes() ?? []));
      return { name: s.animationName, filters: keyframes.map((k) => String(k.filter ?? "")) };
    });
    expect(style.name).toBe("settle-part");
    expect(style.filters.join(" ")).not.toContain("blur");
  }
});

test("under data-motion=reduced, transforms collapse while opacity transitions remain", async ({ page }) => {
  await open(page, { "data-motion": "reduced" });
  await mount(page, `<button class="control-primary" id="key">Send</button><div class="composer-surface" id="composer"></div>`);
  const shift = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion-shift").trim());
  expect(shift).toBe("0");
  for (const id of ["key", "composer"]) {
    const transition = await page.locator(`#${id}`).evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(transition).not.toBe("none");
  }
  // The press dip (travel) is gone: held down, the key does not scale.
  const key = page.locator("#key");
  await key.hover();
  await page.mouse.down();
  const pressed = await key.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.up();
  expect(pressed === "none" || pressed === "matrix(1, 0, 0, 1, 0, 0)").toBeTruthy();
});

test("at the wide transcript width, prose is capped at 75ch while a pre block spans 992px", async ({ page }) => {
  await open(page, { "data-transcript-width": "wide" });
  await mount(page, `<div style="padding-inline:0"><div class="transcript-column" style="width:100%;margin-inline:auto">
      <div class="prose-juno"><p id="para">${"A long paragraph that should wrap at the measure. ".repeat(12)}</p>
      <pre id="pre">const x = 1;</pre></div></div></div>
    <span id="ch" class="prose-juno" style="display:inline-block;width:75ch;position:absolute;visibility:hidden"></span>`);
  const sizes = await page.evaluate(() => ({
    para: document.getElementById("para")!.getBoundingClientRect().width,
    pre: document.getElementById("pre")!.getBoundingClientRect().width,
    ch75: document.getElementById("ch")!.getBoundingClientRect().width,
  }));
  expect(sizes.para).toBeLessThanOrEqual(sizes.ch75 + 0.5);
  expect(Math.round(sizes.pre)).toBe(992);
});

test("at the medium width, prose fills the column (no 75ch cap)", async ({ page }) => {
  await open(page);
  await mount(page, `<div class="transcript-column" style="width:100%;margin-inline:auto"><div class="prose-juno"><p id="para">${"Words ".repeat(200)}</p></div></div>`);
  const width = await page.locator("#para").evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(768);
});

test("the view-transition root has no animation; the app-page group runs 120 out and 160 in", async ({ page }) => {
  await open(page);
  const rules = await page.evaluate(() => {
    const found: Record<string, string> = {};
    const visit = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) {
          const sel = rule.selectorText;
          // The longhand first: WebKit serialises the `animation: none`
          // shorthand as "auto" (its duration), while the name reads "none" everywhere.
          if (/::view-transition-(old|new)\(root\)/.test(sel)) found.root = rule.style.animationName || rule.style.animation;
          if (/\[data-vt="thread"\]::view-transition-old\(app-page\)/.test(sel) && !found.out) found.out = rule.style.animation;
          if (/\[data-vt="thread"\]::view-transition-new\(app-page\)/.test(sel) && !found.in) found.in = rule.style.animation;
        } else if ("cssRules" in rule && !(rule instanceof CSSMediaRule)) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* cross-origin sheet */
      }
    }
    const tokens = getComputedStyle(document.documentElement);
    return { found, fast: tokens.getPropertyValue("--dur-fast").trim(), exit: tokens.getPropertyValue("--dur-exit").trim() };
  });
  expect(rules.found.root).toMatch(/none/);
  expect(rules.found.out).toContain("var(--dur-fast)");
  expect(rules.found.in).toContain("var(--dur-exit)");
  expect(rules.fast).toBe("120ms");
  expect(rules.exit).toBe("160ms");
});

test("the new status colours resolve through the role tokens", async ({ page }) => {
  await open(page);
  const roles = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const read = (token: string) => {
      probe.style.color = `hsl(var(${token}))`;
      return getComputedStyle(probe).color;
    };
    return { needsYou: read("--status-needs-you"), blocked: read("--status-blocked"), running: read("--status-running") };
  });
  expect(roles.needsYou).toBe("rgb(211, 99, 23)");
  expect(roles.blocked).toBe("rgb(184, 30, 40)");
  expect(roles.running).toBe("rgb(45, 73, 201)");
});

test("the in-app Increase contrast toggle applies the high-contrast tokens", async ({ page }) => {
  await open(page, { "data-contrast": "more" });
  const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim());
  expect(muted).toBe("217 5% 28%");
  await open(page, { "data-contrast": "standard" });
  const standard = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim());
  expect(standard).toBe("217.500 3.704% 42.353%");
});

test("the caption lift: text-caption and text-micro are 12px", async ({ page }) => {
  await open(page);
  await mount(page, `<span id="c" class="text-caption">c</span><span id="m" class="text-micro">m</span>`);
  const sizes = await page.evaluate(() => ["c", "m"].map((id) => getComputedStyle(document.getElementById(id)!).fontSize));
  expect(sizes).toEqual(["12px", "12px"]);
});
