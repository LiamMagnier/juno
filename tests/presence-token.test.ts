import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { ACCENT_IDS } from "@/lib/accents";
import { ACCENT_IDS as GENERATED_ACCENT_IDS, SCRIPT_COLOR } from "@/lib/design/tokens.generated";
import { GLOW_PALETTE, contrastRatio } from "@/components/voice/voice-glow-palette";
import { THEME_COLOR } from "@/components/ui/theme-color";

/*
 * G86: one presence token across web and native, and one accent list.
 *
 * Presence blue was hand-typed as #2d49c9 / #97a6e6 in a dozen files and four
 * scoped variables (--rf-, --mem-, --sx-, --pj-presence, plus the editorial,
 * thinking-mark, thought-panel, composer and image-edit copies). It is now
 * `--presence` / `--presence-ink` in globals.css, projected to Swift and to
 * tokens.generated.ts. These tests hold the token to the brand value, the
 * script projection to the token, and the codebase to the token.
 */

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const globals = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first unconditional `selector {` block. */
function block(selector: string): string {
  const start = globals.indexOf(`  ${selector} {`);
  assert.notEqual(start, -1, `no ${selector} block`);
  const open = globals.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < globals.length; i += 1) {
    if (globals[i] === "{") depth += 1;
    if (globals[i] === "}" && --depth === 0) return globals.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector}`);
}

const decl = (body: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1].trim();

function hslHex(triple: string): string {
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triple);
  assert.ok(m, `not an HSL triple: ${triple}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m0 = l - c / 2;
  return `#${[r, g, b].map((v) => Math.round((v + m0) * 255).toString(16).padStart(2, "0")).join("")}`;
}

test("--presence and --presence-ink are the brand's ultramarine in both themes", () => {
  const light = block(":root");
  const dark = block(".dark");
  assert.equal(hslHex(decl(light, "presence")!), "#2d49c9");
  assert.equal(hslHex(decl(dark, "presence")!), "#97a6e6");
  assert.equal(hslHex(decl(light, "presence-ink")!), "#2d49c9");
  assert.equal(hslHex(decl(dark, "presence-ink")!), "#97a6e6");
});

// Wave 2 (spec D26, sign-off S7): the accent stored as "ultramarine" is Cobalt,
// and it is NOT presence any more. A user's accent painted every control in
// the one colour that means "Alevr is live here"; accents never paint presence.
test("the accent stored as ultramarine is Cobalt, a different colour from presence", () => {
  const light = /:root\[data-accent="ultramarine"\]\s*\{([^}]*)\}/.exec(globals)?.[1] ?? "";
  const dark = /\.dark\[data-accent="ultramarine"\]\s*\{([^}]*)\}/.exec(globals)?.[1] ?? "";
  assert.equal(hslHex(decl(light, "primary")!), "#1468a3");
  assert.notEqual(hslHex(decl(light, "primary")!), hslHex(decl(block(":root"), "presence")!));
  assert.notEqual(hslHex(decl(dark, "primary")!), hslHex(decl(block(".dark"), "presence")!));
});

test("the script projection matches the tokens, and canvas consumers read it", () => {
  assert.deepEqual(SCRIPT_COLOR.presence, { light: "#2d49c9", dark: "#97a6e6" });
  assert.deepEqual(SCRIPT_COLOR.presenceInk, SCRIPT_COLOR.presence);
  assert.equal(SCRIPT_COLOR.background.light, hslHex(decl(block(":root"), "background")!));
  assert.equal(SCRIPT_COLOR.background.dark, hslHex(decl(block(".dark"), "background")!));
  assert.deepEqual(THEME_COLOR, SCRIPT_COLOR.background);
  assert.equal(GLOW_PALETTE.light.alevr.line, SCRIPT_COLOR.presence.light);
  assert.equal(GLOW_PALETTE.dark.alevr.line, SCRIPT_COLOR.presence.dark);
  // The WebGL voice glow reads hex custom properties; they must stay equal to presence.
  assert.match(globals, /\.voice-glow \{[^}]*--voice-glow-alevr: #2d49c9;/);
  assert.match(globals, /\.dark \.voice-glow \{[^}]*--voice-glow-alevr: #97a6e6;/);
});

test("presence ink clears 4.5:1 on the page and the secondary fill in both themes", () => {
  for (const theme of [":root", ".dark"] as const) {
    const body = block(theme);
    const ink = hslHex(decl(body, "presence-ink")!);
    for (const ground of ["background", "secondary"]) {
      const ratio = contrastRatio(ink, hslHex(decl(body, ground)!));
      assert.ok(ratio >= 4.5, `${theme} --presence-ink on --${ground}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("one accent list: accents.ts, the projection and JunoAccent.swift agree", () => {
  assert.deepEqual([...GENERATED_ACCENT_IDS], [...ACCENT_IDS]);
  const swift = read("native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoAccent.swift");
  const enumBody = swift.slice(swift.indexOf("enum JunoAccent"), swift.indexOf("public var id"));
  const cases = [...enumBody.matchAll(/^\s*case\s+([a-z]\w*)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(cases, [...ACCENT_IDS]);
  const generated = read("native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift");
  for (const id of ACCENT_IDS) assert.match(generated, new RegExp(`case \\.${id}:`), `generatedPalette lacks .${id}`);
  assert.match(generated, /public static let presence = JunoGeneratedPair/);
  assert.match(generated, /public static let presenceInk = JunoGeneratedPair/);
});

/**
 * Where the literal may still appear, and why. Everything else reads the token.
 * A forced-dark surface (the marketing slabs, the deep ground) takes the dark
 * value in both themes, which a theme-following variable cannot express.
 */
const ALLOWED: Record<string, string> = {
  "src/app/globals.css": "the token's own doc comment and the voice glow's hex custom properties (WebGL parses hex)",
  "src/lib/design/tokens.generated.ts": "the projection",
  "src/lib/sketch/sketch-core.ts": "the Blue pen in the sketch palette: drawing content, not interface",
  "src/components/chat/sketch/sketch.css": "the hue wheel and the caret on the always-white paper",
  "src/components/chat/sketch/sketch-dialog.tsx": "the custom pen colour's default (the Blue pen)",
  "src/components/home/alv-base.css": "the sign-in panel's forced-dark deep ground",
  "src/components/home/dot-construction.css": "the forced-dark deep ground (.alv-deep)",
  "src/components/home/home.css": "the forced-dark code slab on the homepage",
  "src/components/voice/voice-glow-palette.ts": "the palette rationale comment",
};

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) {
      if (path === "src/app/dev") continue;
      yield* files(path);
    } else if (/\.(css|tsx?|mjs)$/.test(name)) {
      yield path;
    }
  }
}

test("presence is never hand-typed outside the registered places", () => {
  const literal = /#2d49c9|#97a6e6|\b45[ ,]+73[ ,]+201\b|\b151[ ,]+166[ ,]+230\b/i;
  const offenders: string[] = [];
  for (const path of files("src")) {
    const rel = relative(root, join(root, path));
    if (rel in ALLOWED) continue;
    const text = read(path);
    if (literal.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "read --presence / SCRIPT_COLOR.presence instead of typing the colour");
});

test("no scoped presence variable is typed per theme any more", () => {
  const scoped = /--(?:rf|mem|sx|pj|ed|tm|tpp|cp|sk)-presence\s*:/;
  const offenders = [...files("src")].filter((path) => path.endsWith(".css") && scoped.test(read(path)));
  assert.deepEqual(offenders, []);
});
