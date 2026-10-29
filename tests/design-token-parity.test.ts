import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import * as sheet from "../src/lib/sheet-gesture";
import { ACCENT_IDS, DURATION, GESTURE, RADIUS, SHELL, SPRING, STATUS_COLOR, TIMING_TOKENS } from "../src/lib/design/tokens.generated";
import { project, render } from "../scripts/generate-design-tokens";

/**
 * The native-parity drift gate (spec §3, "covers every token below"): the
 * generated TypeScript and Swift are exactly what globals.css and the Tailwind
 * config project today, every colour carries its high-contrast values, and the
 * wave 1 constants they replace are unchanged.
 */

const REPO = process.cwd();
const css = readFileSync(resolve(REPO, "src/app/globals.css"), "utf8");
const SWIFT_PATH = "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift";
const TS_PATH = "src/lib/design/tokens.generated.ts";
const swift = readFileSync(resolve(REPO, SWIFT_PATH), "utf8");
const withoutDigest = (text: string) => text.replace(/^\/\/ tokens-digest: [0-9a-f]+$/m, "");

test("the checked-in projections are exactly what the sources project", () => {
  const out = render(project(css));
  assert.equal(withoutDigest(readFileSync(resolve(REPO, TS_PATH), "utf8")), withoutDigest(out.ts), `${TS_PATH} is stale: npm run design:tokens`);
  assert.equal(withoutDigest(swift), withoutDigest(out.swift), `${SWIFT_PATH} is stale: npm run design:tokens`);
});

test("every generated colour has light, dark and both high-contrast values", () => {
  const colours = [...swift.matchAll(/public static let (`?\w+`?) = JunoGeneratedPair\(\n([\s\S]*?)\n {4}\)/g)];
  assert.ok(colours.length > 80, "the colour table was not parsed");
  for (const [, name, body] of colours) {
    for (const half of ["light:", "dark:", "highContrastLight:", "highContrastDark:"]) {
      assert.ok(body.includes(half), `JunoGeneratedColors.${name} has no ${half}`);
    }
  }
  for (const role of ["statusRunning", "statusNeedsYou", "statusNeedsYouInk", "statusReady", "statusBlocked",
    "mutedForegroundOnFill", "inkTertiary", "userBubbleHover", "presenceWash", "signalWash", "cmpInk2", "cmpWell", "cmpWell2", "cmpWell3", "input", "hairline", "selected", "userBubble",
    "fieldSurface", "fieldSurfaceActive", "fieldBorder", "fieldHover", "fieldFocus", "fieldRing"]) {
    assert.match(swift, new RegExp(`public static let ${role} = JunoGeneratedPair`), `${role} is not projected`);
  }
  // The struct keeps its two-argument initialiser for existing callers.
  assert.match(swift, /highContrastLight: JunoColorToken\? = nil/);
});

test("the projection carries the status roles, timing, springs, shell and gesture to both clients", () => {
  assert.deepEqual(Object.keys(STATUS_COLOR), ["running", "needsYou", "needsYouInk", "ready", "blocked"]);
  assert.equal(STATUS_COLOR.needsYou.light, "#d36317");
  assert.equal(STATUS_COLOR.running.hcLight, "#1f38a8");
  assert.deepEqual(DURATION, { press: 70, fast: 120, exit: 160, base: 220, slow: 360, emphasis: 560 });
  assert.equal(TIMING_TOKENS.delay.show, 200);
  assert.equal(TIMING_TOKENS.hold.arm, 500);
  assert.equal(TIMING_TOKENS.loop.galaxyCalm, 4800);
  assert.equal(TIMING_TOKENS.stream.rateMax, 800);
  assert.equal(TIMING_TOKENS.stagger.max, 4);
  assert.deepEqual(Object.keys(SPRING).sort(), ["articulate", "emphasized", "layout", "reward", "snap", "standard"]);
  assert.equal(SHELL.sidebarDefault, 260);
  assert.deepEqual(SHELL.transcriptMax, { narrow: 640, medium: 768, wide: 992 });
  assert.deepEqual(SHELL.drawerDim, { light: 0.12, dark: 0.3 });
  assert.equal(SHELL.edgeStripNative, 16);
  assert.equal(RADIUS.bubble, 12);
  assert.equal(RADIUS.bubbleTuck, 8);
  assert.equal(RADIUS.composer, 26);
  for (const name of ["JunoGeneratedTiming", "JunoGeneratedSprings", "JunoGeneratedShell", "JunoGeneratedGesture"]) {
    assert.match(swift, new RegExp(`public enum ${name} \\{`));
  }
  assert.match(swift, /public static let standard = JunoGeneratedSpring\(visualDuration: 0\.22, bounce: 0\.05, settle: 0\.\d+\)/);
  assert.match(swift, /public static let edgeStripNative: CGFloat = 16\.0/);
  assert.match(swift, /case \.ultramarine: "Cobalt"/);
  assert.deepEqual([...ACCENT_IDS], ["coral", "ultramarine", "juniper", "teal", "violet", "amber", "sage"]);
});

test("wave 1's gesture constants are unchanged, and sheet-gesture.ts agrees with the table", () => {
  assert.deepEqual(GESTURE, {
    slopPx: 8, dismissVelocity: 0.5, dismissFraction: 0.3, openVelocity: 0.3, openFraction: 0.4,
    edgeZonePx: 24, rubberBandLimitPx: 64, rubberBandC: 0.55, settleMinMs: 140, settleMaxMs: 300,
  });
  assert.equal(sheet.INTENT_SLOP_PX, GESTURE.slopPx);
  assert.equal(sheet.DISMISS_VELOCITY, GESTURE.dismissVelocity);
  assert.equal(sheet.DISMISS_FRACTION, GESTURE.dismissFraction);
  assert.equal(sheet.OPEN_VELOCITY, GESTURE.openVelocity);
  assert.equal(sheet.OPEN_FRACTION, GESTURE.openFraction);
  assert.equal(sheet.EDGE_ZONE_PX, GESTURE.edgeZonePx);
  // The rubber band is (1 − 1/(x·c/limit + 1))·limit, with the table's c and limit.
  const x = 40;
  const expected = (1 - 1 / ((x * GESTURE.rubberBandC) / GESTURE.rubberBandLimitPx + 1)) * GESTURE.rubberBandLimitPx;
  assert.ok(Math.abs(sheet.rubberBand(x) - expected) < 1e-9);
  assert.equal(sheet.settleMs(1000, 0.001), GESTURE.settleMaxMs);
  assert.equal(sheet.settleMs(1, 10), GESTURE.settleMinMs);
});

test("the type ladder: the 12px floor, the kbd rung and the new title rungs (§3.5, D16)", () => {
  const { typeRungs } = project(css);
  const rung = (name: string) => {
    const r = typeRungs.find((t) => t.name === name);
    assert.ok(r, `no ${name} rung`);
    return r;
  };
  assert.deepEqual([rung("caption").minSize, rung("caption").lineHeight], [12, 1.4]);
  assert.deepEqual([rung("micro").minSize, rung("micro").lineHeight], [12, 1.4]);
  assert.equal(rung("kbd").minSize, 11);
  assert.deepEqual([rung("label").minSize, rung("label").lineHeight, rung("label").tracking, rung("label").weight], [12, 1.4, 0.01, 500]);
  assert.deepEqual([rung("home-title").minSize, rung("home-title").maxSize, rung("home-title").weight], [34, 50, 400]);
  assert.deepEqual([rung("page-title").minSize, rung("page-title").maxSize, rung("page-title").weight], [32, 44, 500]);
  // Nothing under the floor except the keycap rung.
  for (const t of typeRungs) if (t.name !== "kbd") assert.ok(t.minSize >= 12, `${t.name} is ${t.minSize}px`);
});

test("running both generators twice yields no diff", () => {
  const cwd = mkdtempSync(join(tmpdir(), "juno-p1-generators-"));
  try {
    for (const dir of ["src/app", "contracts/product", "native/Packages/JunoNativeKit/Sources/JunoDesignSystem", "native/macOS/JunoDesktop/App/Generated", "native/iOS/JunoMobile/Resources", "src/lib/strings", "src/components/chat"]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    cpSync(resolve(REPO, "src/app/globals.css"), join(cwd, "src/app/globals.css"));
    const tsx = resolve(REPO, "node_modules/.bin/tsx");
    const tokens = (...args: string[]) => spawnSync(tsx, [resolve(REPO, "scripts/generate-design-tokens.ts"), ...args], { cwd, encoding: "utf8" });
    const first = tokens();
    assert.equal(first.status, 0, first.stderr);
    const snapshot = () => [SWIFT_PATH, TS_PATH, "src/app/globals.css"].map((p) => readFileSync(join(cwd, p), "utf8"));
    const once = snapshot();
    const second = tokens();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(snapshot(), once);
    const check = tokens("--check");
    assert.equal(check.status, 0, check.stderr || check.stdout);
    // The shell contract generator, twice, into scratch outputs: identical runs,
    // identical to what is checked in.
    const outs = {
      swift: join(cwd, "native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift"),
      ts: join(cwd, "src/lib/strings/shell.generated.ts"),
      xcstrings: join(cwd, "native/iOS/JunoMobile/Resources/Shell.xcstrings"),
    };
    const shell = () =>
      spawnSync(
        process.execPath,
        [resolve(REPO, "scripts/generate-shell-contract.mjs"), `--output=${outs.swift}`, `--ts-output=${outs.ts}`, `--xcstrings-output=${outs.xcstrings}`],
        { cwd: REPO, encoding: "utf8" }
      );
    const read = () => Object.values(outs).map((p) => readFileSync(p, "utf8"));
    assert.equal(shell().status, 0);
    const shellOnce = read();
    assert.equal(shell().status, 0);
    assert.deepEqual(read(), shellOnce);
    assert.deepEqual(shellOnce, [
      "native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift",
      "src/lib/strings/shell.generated.ts",
      "native/iOS/JunoMobile/Resources/Shell.xcstrings",
    ].map((p) => readFileSync(resolve(REPO, p), "utf8")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the gate fails when globals.css changes without regenerating", () => {
  const cwd = mkdtempSync(join(tmpdir(), "juno-p1-drift-"));
  try {
    mkdirSync(join(cwd, "src/app"), { recursive: true });
    cpSync(resolve(REPO, "src/app/globals.css"), join(cwd, "src/app/globals.css"));
    const tsx = resolve(REPO, "node_modules/.bin/tsx");
    const run = (...args: string[]) => spawnSync(tsx, [resolve(REPO, "scripts/generate-design-tokens.ts"), ...args], { cwd, encoding: "utf8" });
    assert.equal(run().status, 0);
    const edited = css.replace("--signal: 24 80% 46%;", "--signal: 24 80% 45%;");
    writeFileSync(join(cwd, "src/app/globals.css"), edited);
    const check = run("--check");
    assert.equal(check.status, 1, "an unregenerated colour change must fail --check");
    assert.match(check.stderr, /DRIFT/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
