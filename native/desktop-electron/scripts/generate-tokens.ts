/**
 * Project the web design system onto the Electron renderer.
 *
 * THE SOURCE OF TRUTH IS NOT HERE. It is exactly the pair the existing Swift
 * generator reads — `src/app/globals.css` for colour, motion, elevation, depth
 * and stacking, and `tailwind.config.ts` for the ladders that were never CSS
 * variables in the first place (radius, type scale, keyframes, animations).
 * Nothing in this file invents a value, and nothing in
 * `src/renderer/styles/tokens.css` was typed by a human.
 *
 * WHY THIS EXISTS AT ALL. `scripts/generate-design-tokens.ts` at the repo root
 * already solves this problem for Swift, and its own header says why: the hand
 * conversion that preceded it "described an intention, not a mechanism". A
 * second desktop client transcribing 70-odd HSL triples into a stylesheet would
 * be that same intention again, one platform later. So this is the same
 * mechanism aimed at CSS.
 *
 * WHY IT IS A SECOND SCRIPT RATHER THAN A FLAG ON THE FIRST. The root generator
 * is a top-level script: it parses, derives and writes on import, and exports
 * nothing. There is no parser to import, so `parseBlocks`/`declsFor` below are
 * carried over from it deliberately and near-verbatim (the one extension is
 * noted on `parseBlocks`). Factoring out a shared module would mean editing
 * `scripts/generate-design-tokens.ts`, which this change does not own. The
 * duplication is bounded and cheap: both scripts read the same file, and both
 * fail CI under `--check`, so a parser that drifted would show up as a diff in
 * a generated artifact rather than as a silent difference of opinion.
 *
 * WHY CSS AND NOT A TS MODULE. The renderer is Tailwind v3 against the same
 * semantic names the web uses, so `bg-card` has to resolve through
 * `hsl(var(--card) / <alpha-value>)` exactly as it does on the web. Emitting the
 * raw HSL triples verbatim keeps the alpha-value machinery, the per-accent
 * `[data-accent]` cascade and the `.dark` swap working with no translation step
 * — and, unlike the Swift projection, loses nothing to a colour-space
 * conversion, because the browser at the other end is the same browser.
 *
 *   npx tsx scripts/generate-tokens.ts           # write
 *   npx tsx scripts/generate-tokens.ts --check   # verify, exit 1 (with a diff) on drift
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");

const CSS_PATH = resolve(REPO_ROOT, "src/app/globals.css");
const TAILWIND_PATH = resolve(REPO_ROOT, "tailwind.config.ts");
const OUT_PATH = resolve(DESKTOP_ROOT, "src/renderer/styles/tokens.css");

// ---------------------------------------------------------------------------
// Parsing — carried over from scripts/generate-design-tokens.ts
// ---------------------------------------------------------------------------

type Block = { selector: string; conditions: string[]; decls: Map<string, string> };

/**
 * `@layer` is transparent — it groups without changing when a rule applies, so
 * a `:root` inside it is the same `:root`. Every other at-rule is CONDITIONAL,
 * and a `:root` inside one is a different set of values that only sometimes
 * applies.
 */
const TRANSPARENT_AT_RULE = /^@layer\b/;

/**
 * Walk brace depth, tracking the at-rule chain each block sits inside.
 *
 * ONE EXTENSION over the root generator's copy. That one DROPS conditional
 * blocks, because Swift has no `@media` and a reduced-motion `--dur-slow` would
 * silently overwrite the real one. CSS does have `@media`, and the desktop needs
 * those three flattened curves as much as the web does — so conditional blocks
 * are kept here, tagged with the at-rule chain that guards them, and the callers
 * below ask for unconditional or for one specific condition. Same walk, same
 * distinction, one more thing done with the answer.
 */
function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const stack: string[] = [];
  let buffer = "";

  const flushDecls = () => {
    const prelude = stack[stack.length - 1];
    if (prelude === undefined || prelude.startsWith("@")) return;
    const conditions = stack
      .slice(0, -1)
      .filter((p) => p.startsWith("@") && !TRANSPARENT_AT_RULE.test(p));

    const decls = new Map<string, string>();
    for (const raw of buffer.split(";")) {
      const i = raw.indexOf(":");
      if (i === -1) continue;
      const name = raw.slice(0, i).trim();
      if (!name.startsWith("--")) continue;
      decls.set(name.slice(2), raw.slice(i + 1).trim());
    }
    if (decls.size) blocks.push({ selector: prelude, conditions, decls });
  };

  for (const ch of stripped) {
    if (ch === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (ch === "}") {
      flushDecls();
      stack.pop();
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

/** Merge every block for `selector`, in source order, under `conditions`. */
function declsFor(blocks: Block[], selector: string, conditions: string[] = []): Map<string, string> {
  const want = conditions.join(" && ");
  const merged = new Map<string, string>();
  for (const b of blocks) {
    if (b.selector !== selector) continue;
    if (b.conditions.join(" && ") !== want) continue;
    for (const [k, v] of b.decls) merged.set(k, v);
  }
  return merged;
}

/**
 * `@property` registrations, lifted verbatim.
 *
 * These are not decoration. An unregistered custom property is a raw token: it
 * flips from one value to the next with nothing in between, so a composer aura
 * whose tint is unregistered CUTS from the accent to the model's colour instead
 * of crossfading. The registration carries the syntax and the initial value that
 * make the interpolation legal, and re-typing either on the desktop is how the
 * two clients end up animating differently. Bodies have no nested braces, so a
 * scan is sufficient and a parser would be theatre.
 */
const PROPERTY_RULE = /@property\s+(--[\w-]+)\s*\{([^}]*)\}/g;

function parseRegisteredProperties(css: string): Array<{ name: string; body: string[] }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ name: string; body: string[] }> = [];
  for (const match of stripped.matchAll(PROPERTY_RULE)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    const decls = body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => d.length > 0);
    if (decls.length) out.push({ name, body: decls });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read the sources
// ---------------------------------------------------------------------------

const css = readFileSync(CSS_PATH, "utf8");
const blocks = parseBlocks(css);
const registered = parseRegisteredProperties(css);

const rootDecls = declsFor(blocks, ":root");
const darkDecls = declsFor(blocks, ".dark");

if (rootDecls.size === 0) throw new Error("No :root token block found in globals.css");
if (darkDecls.size === 0) throw new Error("No .dark token block found in globals.css");

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
const reducedMotionDecls = declsFor(blocks, ":root", [REDUCED_MOTION]);
if (reducedMotionDecls.size === 0) {
  throw new Error(
    `No ":root" block under "${REDUCED_MOTION}" in globals.css — Tier B of the reduced-motion ` +
      "policy (--motion-shift / --motion-scale-from / the flattened curves) would be lost."
  );
}

const ACCENTS = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;

const accents = ACCENTS.map((accent) => {
  const light = declsFor(blocks, `:root[data-accent="${accent}"]`);
  const dark = declsFor(blocks, `.dark[data-accent="${accent}"]`);
  if (light.size === 0) throw new Error(`Accent "${accent}" has no :root[data-accent] block`);
  if (dark.size === 0) throw new Error(`Accent "${accent}" has no .dark[data-accent] block`);
  return { accent, light, dark };
});

// ---------------------------------------------------------------------------
// The ladders that never were CSS variables — from the web's tailwind.config.ts
//
// Loaded by DYNAMIC import on a computed path, not `import x from "../../.."`.
// Two reasons, both structural rather than stylistic: the desktop's
// `tsconfig.node.json` pins `rootDir` to this package, so a static import of a
// file three directories up is a compile error (TS6059); and the web config
// pulls in `tailwindcss-animate`, which is a root dependency and deliberately
// not a desktop one. A computed specifier keeps the file out of the desktop's
// type graph while still executing the real thing at generate time — the values
// below are the web's own objects, not a copy of them.
// ---------------------------------------------------------------------------

const twNamespace: unknown = await import(/* @vite-ignore */ pathToFileURL(TAILWIND_PATH).href);

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const twExtend = asRecord(asRecord(asRecord(asRecord(twNamespace)["default"])["theme"])["extend"]);

const stringEntries = (v: unknown): Array<[string, string]> =>
  Object.entries(asRecord(v)).filter((e): e is [string, string] => typeof e[1] === "string");

/**
 * CSS-wide keywords cannot travel through a custom property. `border-radius:
 * var(--radius-inherit)` where the variable holds `inherit` is invalid at
 * computed-value time, not an inherited radius — the keyword only works when it
 * is written literally at the call site. The web's `borderRadius.inherit` is
 * mapped straight through in the desktop Tailwind config instead of via a token.
 */
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

const radii = stringEntries(twExtend["borderRadius"]).filter(
  ([, value]) => !CSS_WIDE_KEYWORDS.has(value)
);
if (!radii.length) throw new Error("No borderRadius ladder found in tailwind.config.ts");

/** `text-body` is `["0.9375rem", { lineHeight: "1.6" }]` — a size plus up to three riders. */
type FontSizeMeta = { lineHeight?: string; letterSpacing?: string; fontWeight?: string };
type TypeStep = { name: string; size: string; meta: FontSizeMeta };

const typeScale: TypeStep[] = Object.entries(asRecord(twExtend["fontSize"])).flatMap(
  ([name, raw]): TypeStep[] => {
    if (typeof raw === "string") return [{ name, size: raw, meta: {} }];
    if (!Array.isArray(raw)) return [];
    const [size, meta] = raw as [unknown, unknown];
    if (typeof size !== "string") return [];
    const m = asRecord(meta);
    const pick = (key: string): string | undefined =>
      typeof m[key] === "string" ? (m[key] as string) : undefined;
    const lineHeight = pick("lineHeight");
    const letterSpacing = pick("letterSpacing");
    const fontWeight = pick("fontWeight");
    return [
      {
        name,
        size,
        meta: {
          ...(lineHeight === undefined ? {} : { lineHeight }),
          ...(letterSpacing === undefined ? {} : { letterSpacing }),
          ...(fontWeight === undefined ? {} : { fontWeight }),
        },
      },
    ];
  }
);
if (!typeScale.length) throw new Error("No fontSize scale found in tailwind.config.ts");

const animations = stringEntries(twExtend["animation"]);
if (!animations.length) throw new Error("No animation shorthands found in tailwind.config.ts");

type Keyframes = Array<[string, Array<[string, string]>]>;

const keyframes: Keyframes = Object.entries(asRecord(twExtend["keyframes"])).map(
  ([name, steps]): [string, Array<[string, string]>] => [
    name,
    Object.entries(asRecord(steps)).flatMap(([offset, props]): Array<[string, string]> =>
      stringEntries(props).map(([prop, value]) => [`${offset}||${prop}`, value] as [string, string])
    ),
  ]
);
if (!keyframes.length) throw new Error("No keyframes found in tailwind.config.ts");

// Sanity: the durations and easings the web's Tailwind layer names must all
// exist as tokens in globals.css, or a `duration-base` utility on the desktop
// would compile to a variable nothing declares.
for (const [name] of stringEntries(twExtend["transitionDuration"])) {
  if (!rootDecls.has(`dur-${name}`)) {
    throw new Error(`tailwind.config.ts names duration "${name}" but globals.css has no --dur-${name}`);
  }
}
for (const [name] of stringEntries(twExtend["transitionTimingFunction"])) {
  if (!rootDecls.has(`ease-${name}`)) {
    throw new Error(`tailwind.config.ts names easing "${name}" but globals.css has no --ease-${name}`);
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * The digest fingerprints the PROJECTION, not the source bytes.
 *
 * The Swift generator hashes globals.css wholesale, which is right for it: it
 * emits a hand-audited subset and the hash is a receipt that it ran against that
 * exact file. Here the same choice would fail CI every time somebody edits one
 * of the 2,000 lines of commentary in globals.css that this file, by design,
 * does not read. Hashing what is actually projected keeps the receipt honest
 * (any value change moves it) without manufacturing drift out of prose.
 */
const digest = createHash("sha256")
  .update(
    JSON.stringify({
      registered,
      root: [...rootDecls],
      dark: [...darkDecls],
      reducedMotion: [...reducedMotionDecls],
      accents: accents.map((a) => ({ accent: a.accent, light: [...a.light], dark: [...a.dark] })),
      radii,
      typeScale,
      animations,
      keyframes,
    })
  )
  .digest("hex")
  .slice(0, 16);

const rel = (p: string) => relative(REPO_ROOT, p).split("\\").join("/");

const out: string[] = [];
const push = (line = "") => out.push(line);
const declLines = (decls: Iterable<[string, string]>, indent = "  ") => {
  for (const [name, value] of decls) push(`${indent}--${name}: ${value};`);
};

push(`/* Generated by native/desktop-electron/scripts/generate-tokens.ts — DO NOT EDIT.`);
push(` *`);
push(` * Source: ${rel(CSS_PATH)} (colour, motion, elevation, depth, stacking)`);
push(` *       + ${rel(TAILWIND_PATH)} (radius ladder, type scale, keyframes, animations)`);
push(` *`);
push(` * The same two files the Swift projection reads. Regenerate with \`npm run tokens\`;`);
push(` * \`npm run tokens:check\` fails CI when this file no longer matches its sources.`);
push(` *`);
push(` * tokens-digest: ${digest}`);
push(` */`);
push();

push("/* ---- Registered custom properties -------------------------------------- */");
push("/* Typed so they interpolate rather than flip. Lifted verbatim from the @property");
push("   rules in globals.css — syntax and initial value included, because a token that");
push("   animates differently per client is worse than one that does not animate. */");
for (const { name, body } of registered) {
  push(`@property ${name} {`);
  for (const decl of body) push(`  ${decl};`);
  push("}");
}
push();

push("/* ---- Light — warm paper ------------------------------------------------- */");
push(":root {");
declLines(rootDecls);
push();
push("  /* Radius ladder — from tailwind.config.ts, where the web declares it. */");
for (const [name, value] of radii) push(`  --radius-${name}: ${value};`);
push();
push("  /* Type scale — size plus its riders, so a step cannot be half-adopted. */");
for (const step of typeScale) {
  push(`  --text-${step.name}: ${step.size};`);
  if (step.meta.lineHeight !== undefined) push(`  --text-${step.name}-leading: ${step.meta.lineHeight};`);
  if (step.meta.letterSpacing !== undefined) push(`  --text-${step.name}-tracking: ${step.meta.letterSpacing};`);
  if (step.meta.fontWeight !== undefined) push(`  --text-${step.name}-weight: ${step.meta.fontWeight};`);
}
push();
push("  /* Animation shorthands. Each one still reads --dur-* / --ease-* by name, so a");
push("     reduced-motion override of a curve reaches every animation built on it. */");
for (const [name, value] of animations) push(`  --anim-${name}: ${value};`);
push("}");
push();

push("/* ---- Dark — true black -------------------------------------------------- */");
push(".dark {");
declLines(darkDecls);
push("}");
push();

push("/* ---- Accents — override --primary / --ring / their foreground and ink ---- */");
for (const { accent, light, dark } of accents) {
  const inline = (decls: Map<string, string>) =>
    [...decls].map(([k, v]) => `--${k}: ${v};`).join(" ");
  push(`:root[data-accent="${accent}"] { ${inline(light)} }`);
  push(`.dark[data-accent="${accent}"] { ${inline(dark)} }`);
}
push();

push("/* ---- Reduced motion, Tier B -------------------------------------------- */");
push("/* Travel and overshoot collapse to identity; opacity and colour keep their");
push("   timing. Emitted twice on purpose. The media query is the web's own rule. The");
push("   attribute is the desktop's: macOS exposes this preference to the main process,");
push("   which stamps it on <html>, and that path has to set the same values or the two");
push("   ways of asking for the same thing would disagree.");
push("");
push("   MATCH THE VALUE, NOT THE PRESENCE. applyAppearanceToDocument writes");
push('   String(appearance.reduceMotion), so the attribute is ALWAYS on <html> — as');
push('   "false" when the preference is off. A bare [data-reduce-motion] selector would');
push("   therefore match every window in the product and flatten motion for everyone.");
push('   :root[data-reduce-motion="true"] is (0,2,0) against :root\'s (0,1,0), so it');
push("   still wins wherever it appears. Behavioural Tier C rules live in base.css. */");
push(`${REDUCED_MOTION} {`);
push("  :root {");
declLines(reducedMotionDecls, "    ");
push("  }");
push("}");
push();
push(':root[data-reduce-motion="true"] {');
declLines(reducedMotionDecls);
push("}");
push();

push("/* ---- Keyframes ---------------------------------------------------------- */");
push("/* Projected from tailwind.config.ts rather than declared in the desktop config,");
push("   so the bodies cannot drift. Every travelling step reads --motion-shift /");
push("   --motion-scale-from with its own original value as the fallback — that is the");
push("   entire mechanism behind Tier B above. */");
for (const [name, steps] of keyframes) {
  push(`@keyframes ${name} {`);
  const byOffset = new Map<string, Array<[string, string]>>();
  for (const [key, value] of steps) {
    const [offset = "", prop = ""] = key.split("||");
    const bucket = byOffset.get(offset) ?? [];
    bucket.push([prop, value]);
    byOffset.set(offset, bucket);
  }
  for (const [offset, props] of byOffset) {
    const body = props
      .map(([prop, value]) => `${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`)
      .join(" ");
    push(`  ${offset} { ${body} }`);
  }
  push("}");
}

const expected = `${out.join("\n")}\n`;

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

/** Trim the matching head and tail, then show the disagreement. */
function diff(committed: string, regenerated: string, limit = 60): string {
  const a = committed.split("\n");
  const b = regenerated.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const from = a.slice(head, a.length - tail);
  const to = b.slice(head, b.length - tail);
  const lines = [`@@ line ${head + 1} @@  -committed  +regenerated`];
  for (const line of from.slice(0, limit)) lines.push(`  -${line}`);
  if (from.length > limit) lines.push(`  … ${from.length - limit} more removed`);
  for (const line of to.slice(0, limit)) lines.push(`  +${line}`);
  if (to.length > limit) lines.push(`  … ${to.length - limit} more added`);
  return lines.join("\n");
}

const summary =
  `${rootDecls.size} light tokens, ${darkDecls.size} dark overrides, ${accents.length} accents, ` +
  `${radii.length} radii, ${typeScale.length} type steps, ${keyframes.length} keyframes, ` +
  `${animations.length} animations (digest ${digest})`;

/**
 * A scale the desktop Tailwind config never names is a scale nobody can type.
 * Not fatal — a token can legitimately be consumed by hand-written CSS — but it
 * is the exact shape of "the web grew a step and the desktop did not notice",
 * so it is said out loud on every run.
 */
function unreferencedScales(): string[] {
  let config: string;
  try {
    config = readFileSync(resolve(DESKTOP_ROOT, "tailwind.config.ts"), "utf8");
  } catch {
    return [];
  }
  const wanted = [
    ...radii.map(([name]) => `--radius-${name}`),
    ...typeScale.map((step) => `--text-${step.name}`),
    ...animations.map(([name]) => `--anim-${name}`),
  ];
  return wanted.filter((token) => !config.includes(token));
}

if (process.argv.includes("--check")) {
  let committed: string | null = null;
  try {
    committed = readFileSync(OUT_PATH, "utf8");
  } catch {
    console.error(`[desktop-tokens] MISSING ${rel(OUT_PATH)}`);
    console.error("[desktop-tokens] Run: npm run tokens");
    process.exit(1);
  }
  if (committed !== expected) {
    console.error(`[desktop-tokens] DRIFT ${rel(OUT_PATH)} no longer matches its sources.\n`);
    console.error(diff(committed, expected));
    console.error("\n[desktop-tokens] Run: npm run tokens");
    process.exit(1);
  }
  const orphans = unreferencedScales();
  if (orphans.length) {
    console.warn(`[desktop-tokens] warn: not named by tailwind.config.ts — ${orphans.join(", ")}`);
  }
  console.log(`[desktop-tokens] up to date — ${summary}`);
} else {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, expected);
  const orphans = unreferencedScales();
  if (orphans.length) {
    console.warn(`[desktop-tokens] warn: not named by tailwind.config.ts — ${orphans.join(", ")}`);
  }
  console.log(`[desktop-tokens] wrote ${rel(OUT_PATH)} — ${summary}`);
}
