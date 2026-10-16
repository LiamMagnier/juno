/**
 * The screenshot matrix (spec §14 "Screenshot matrix per package", P0 (4)).
 *
 * Web: light, dark and high contrast × 1440×900 and 390×844 × reduced motion
 * on and off. Viewports are Playwright projects (chromium-1440, chromium-390,
 * webkit-390); themes and motion are `test.use` variants this module builds,
 * so a spec writes:
 *
 *   describeMatrix("chat home", (variant) => {
 *     test("renders", async ({ page }, testInfo) => {
 *       await page.goto("/chat");
 *       await captureMatrixShot(page, testInfo, { name: "chat-home", variant, baselineDir });
 *     });
 *   });
 *
 * Every capture first waits for `document.getAnimations()` to finish, so the
 * picture is the end state of an entrance, never a frame from the middle of
 * one. Infinite loops (the galaxy, skeleton breathe) cannot finish; Playwright's
 * `animations: "disabled"` holds them at their start for a stable picture.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { decodePng, diffBitmaps, type PixelDiff } from "./png";

export type Theme = "light" | "dark" | "high-contrast" | "high-contrast-dark" | "forced-colors";
export type MotionVariant = "full" | "reduced";

export interface MatrixVariant {
  theme: Theme;
  motion: MotionVariant;
  /** e.g. "dark · reduced motion" */
  label: string;
  /** e.g. "dark-reduced", used in file names */
  key: string;
}

/** The three themes of the spec's matrix. high-contrast-dark and forced-colors are available on request. */
export const MATRIX_THEMES: readonly Theme[] = ["light", "dark", "high-contrast"];
export const MATRIX_MOTION: readonly MotionVariant[] = ["full", "reduced"];

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export function matrixVariants(options: { themes?: readonly Theme[]; motions?: readonly MotionVariant[] } = {}): MatrixVariant[] {
  const themes = options.themes ?? MATRIX_THEMES;
  const motions = options.motions ?? MATRIX_MOTION;
  const out: MatrixVariant[] = [];
  for (const theme of themes) {
    for (const motion of motions) {
      out.push({
        theme,
        motion,
        label: `${theme.replace(/-/g, " ")} · ${motion === "reduced" ? "reduced motion" : "full motion"}`,
        key: `${theme}-${motion}`,
      });
    }
  }
  return out;
}

export interface VariantUse {
  colorScheme: "light" | "dark";
  reducedMotion: "reduce" | "no-preference";
  contrast: "more" | "no-preference";
  forcedColors: "active" | "none";
}

/** The Playwright context options for a variant (pass to `test.use`). */
export function variantUse(variant: Pick<MatrixVariant, "theme" | "motion">): VariantUse {
  const dark = variant.theme === "dark" || variant.theme === "high-contrast-dark";
  const more = variant.theme === "high-contrast" || variant.theme === "high-contrast-dark";
  return {
    colorScheme: dark ? "dark" : "light",
    reducedMotion: variant.motion === "reduced" ? "reduce" : "no-preference",
    contrast: more ? "more" : "no-preference",
    forcedColors: variant.theme === "forced-colors" ? "active" : "none",
  };
}

/** One `test.describe` per variant, each with its `test.use` applied. */
export function describeMatrix(
  title: string,
  body: (variant: MatrixVariant) => void,
  options: { themes?: readonly Theme[]; motions?: readonly MotionVariant[] } = {}
): void {
  for (const variant of matrixVariants(options)) {
    test.describe(`${title} · ${variant.label}`, () => {
      test.use(variantUse(variant));
      body(variant);
    });
  }
}

/**
 * Waits until every finite animation on the page has finished (or `timeout`
 * passes), then two more frames for the last style changes to paint. Returns
 * how many finite animations it waited for.
 */
export async function settleAnimations(page: Page, timeout = 4_000): Promise<number> {
  return page.evaluate(async (limit) => {
    const deadline = performance.now() + limit;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let waited = 0;
    for (;;) {
      const finite = document.getAnimations().filter((animation) => {
        if (animation.playState !== "running" && !animation.pending) return false;
        const timing = animation.effect?.getComputedTiming();
        return !!timing && timing.iterations !== Infinity && Number.isFinite(Number(timing.endTime));
      });
      if (finite.length === 0) break;
      waited += finite.length;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await Promise.race([
        Promise.allSettled(finite.map((animation) => animation.finished)),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
    await frame();
    await frame();
    return waited;
  }, timeout);
}

export interface MatrixShot {
  file: string;
  baseline: string | null;
  status: "captured" | "new-baseline" | "updated" | "match" | "changed";
  diff: PixelDiff | null;
}

function shotsDir(testInfo: TestInfo): string {
  const report = process.env.ALEVR_QA_REPORT_DIR;
  return report ? path.join(path.dirname(report), "visual-matrix") : testInfo.outputPath("visual-matrix");
}

/**
 * Settles animations, captures, and (with `baselineDir`) compares against the
 * baseline `<baselineDir>/<name>/<project>-<variant>.png`. With
 * ALEVR_QA_UPDATE_BASELINES=1 (run-prod-e2e.sh --update-baselines) it writes
 * the baseline instead. Never fails the test itself: the caller decides, via
 * the gate recorder, whether a change is enforced.
 */
export async function captureMatrixShot(
  page: Page,
  testInfo: TestInfo,
  options: { name: string; variant: MatrixVariant; baselineDir?: string; locator?: Locator; fullPage?: boolean; threshold?: number }
): Promise<MatrixShot> {
  await settleAnimations(page);
  const base = `${testInfo.project.name}-${options.variant.key}.png`;
  const file = path.join(shotsDir(testInfo), options.name, base);
  mkdirSync(path.dirname(file), { recursive: true });
  const shotOptions = { animations: "disabled" as const, caret: "hide" as const, scale: "css" as const };
  const png = options.locator
    ? await options.locator.screenshot(shotOptions)
    : await page.screenshot({ ...shotOptions, fullPage: options.fullPage ?? false });
  writeFileSync(file, png);
  await testInfo.attach(`${options.name}-${options.variant.key}`, { body: png, contentType: "image/png" });

  if (!options.baselineDir) return { file, baseline: null, status: "captured", diff: null };
  const baseline = path.join(options.baselineDir, options.name, base);
  if (process.env.ALEVR_QA_UPDATE_BASELINES === "1") {
    const existed = existsSync(baseline);
    mkdirSync(path.dirname(baseline), { recursive: true });
    writeFileSync(baseline, png);
    return { file, baseline, status: existed ? "updated" : "new-baseline", diff: null };
  }
  if (!existsSync(baseline)) return { file, baseline: null, status: "captured", diff: null };
  const diff = diffBitmaps(decodePng(readFileSync(baseline)), decodePng(png), options.threshold ?? 16);
  return { file, baseline, status: diff.differing === 0 ? "match" : "changed", diff };
}
