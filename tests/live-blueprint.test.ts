/**
 * The live blueprint (src/lib/live-blueprint.ts): the incremental structure
 * parser, the build phase it reports, and the reduced-motion plan.
 *
 * Pure only (the repo has no DOM test environment); the last tests read the
 * component's source to hold the wiring the motion rules name.
 *
 * Run: npx tsx --test tests/live-blueprint.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BLUEPRINT_MAX_BLOCKS,
  BUILD_PHASE_COPY,
  BlueprintParser,
  blockLabel,
  blueprintMotionPlan,
  blueprintTilt,
  buildPhase,
  colorIn,
  isBlueprintSource,
  parseBlueprint,
  tailwindInk,
  type Blueprint,
  type BlueprintBlock,
} from "../src/lib/live-blueprint";

const PAGE = `<!DOCTYPE html>
<html>
<head>
<style>
  :root { --brand: #1a2b3c; }
  body { background: #0b0b0f; color: white; }
  .hero { background: var(--brand); }
  .cta { background-color: rgb(255, 90, 0); }
  nav a:hover { color: red; }
</style>
</head>
<body>
<nav class="top"><a href="/">Logo</a><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ul><a class="btn cta" href="#">Sign up</a></nav>
<section class="hero"><h1>Hi</h1><p>One</p><p>Two</p><img src="x.png"><button class="cta">Go</button></section>
<section>
  <h2>Features</h2>
  <div class="grid grid-cols-3">
    <div class="card"><h3>a</h3><p>x</p></div>
    <div class="card"><h3>b</h3></div>
    <div class="card"></div>
  </div>
</section>
<form><input type="email"><input type="hidden" name="t"><input type="text"><button type="submit">Send</button></form>
<footer><p>c</p></footer>
<script>document.querySelector('button').addEventListener('click', () => {});</script>
</body>
</html>`;

const APP = `import { useState } from "react";

export default function App() {
  const [items, setItems] = useState<Card[]>([]);
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <Navbar />
      <header className="p-8 bg-indigo-600">
        <h1 className="text-4xl">Title</h1>
        <p>Sub</p>
        <button onClick={() => { setItems([]); }} className="rounded-full bg-[#ff5a00]">Start</button>
      </header>
      <main>
        <div className="grid md:grid-cols-3 gap-4">
          <ProductCard name="a" />
          <ProductCard name="b" />
        </div>
        <canvas id="scene" />
      </main>
      <Footer />
    </div>
  );
}
`;

/** A blueprint as a compact outline: "kind×count[ink]" rows with their children. */
function outline(bp: Blueprint): string[] {
  const one = (b: BlueprintBlock) => `${blockLabel(b)}${b.ink ? `[${b.ink}]` : ""}`;
  return bp.blocks.map((b) => [one(b), ...b.children.map(one)].join(" > "));
}

/** The blocks without ids (a fresh parse numbers them the same, but compare shape). */
function shape(bp: Blueprint): unknown {
  const strip = (b: BlueprintBlock): unknown => ({ ...b, id: undefined, children: b.children.map(strip) });
  return { ...bp, blocks: bp.blocks.map(strip) };
}

function feedInChunks(source: string, sizes: number[], react: boolean): Blueprint {
  const parser = new BlueprintParser(react);
  let at = 0;
  let i = 0;
  let last: Blueprint | null = null;
  while (at < source.length) {
    at = Math.min(source.length, at + sizes[i++ % sizes.length]);
    last = parser.feed(source.slice(0, at));
  }
  return last!;
}

describe("which artifacts get a blueprint", () => {
  it("pages that render in the web sandbox", () => {
    assert.equal(isBlueprintSource("HTML"), true);
    assert.equal(isBlueprintSource("REACT"), true);
    assert.equal(isBlueprintSource("CODE", "html"), true);
    assert.equal(isBlueprintSource("CODE", "tsx"), true);
    assert.equal(isBlueprintSource("CODE", "jsx"), true);
  });
  it("documents, code-only and pictures keep their own state", () => {
    for (const type of ["MARKDOWN", "DOCUMENT", "SPREADSHEET", "PRESENTATION", "DESIGN", "SVG", "MERMAID"] as const) {
      assert.equal(isBlueprintSource(type), false, type);
    }
    assert.equal(isBlueprintSource("CODE", "python"), false);
    assert.equal(isBlueprintSource("CODE", "javascript"), false);
    assert.equal(isBlueprintSource("CODE", null), false);
  });
});

describe("reading an HTML page", () => {
  const bp = parseBlueprint(PAGE, "HTML");

  it("draws the rows in reading order, with what is inside them", () => {
    assert.deepEqual(outline(bp), [
      "nav > link ×3 > button[rgb(255, 90, 0)]",
      "hero[#1a2b3c] > h1 > text ×2 > image > button[rgb(255, 90, 0)]",
      "section > h2 > cards ×3",
      "form > input ×2 > button",
      "footer > text",
    ]);
  });

  it("knows the page is styled and what its ground is", () => {
    assert.equal(bp.styled, true);
    assert.equal(bp.pageInk, "#0b0b0f");
  });

  it("points each block at the line that made it", () => {
    const hero = bp.blocks[1];
    assert.equal(hero.line, PAGE.slice(0, hero.offset).split("\n").length);
    assert.match(hero.snippet, /^<section class="hero">/);
  });

  it("counts every block once", () => {
    const count = (list: BlueprintBlock[]): number => list.reduce((n, b) => n + 1 + count(b.children), 0);
    assert.equal(bp.total, count(bp.blocks));
    assert.equal(bp.overflow, 0);
  });
});

describe("reading a React component", () => {
  const bp = parseBlueprint(APP, "REACT");

  it("reads components by name, skips type arguments, takes Tailwind colours", () => {
    assert.deepEqual(outline(bp), [
      "nav",
      "header[hsl(239 80% 46%)] > h1 > text > button[#ff5a00]",
      "cards ×2",
      "canvas",
      "footer",
    ]);
    assert.equal(bp.pageInk, "hsl(215 20% 12%)");
  });

  it("an empty grid counts its items from none", () => {
    const empty = parseBlueprint(`export default () => (<div className="grid grid-cols-3"></div>)`, "REACT");
    assert.equal(empty.blocks[0].kind, "cards");
    assert.equal(empty.blocks[0].count, 0);
    assert.equal(blockLabel(empty.blocks[0]), "cards");
  });
});

describe("the parse is incremental", () => {
  for (const [name, source, react] of [
    ["html", PAGE, false],
    ["react", APP, true],
  ] as const) {
    it(`${name}: any chunking gives the one-shot result`, () => {
      const whole = parseBlueprint(source, react ? "REACT" : "HTML");
      for (const sizes of [[1], [7], [3, 17, 2, 41], [256]]) {
        assert.deepEqual(shape(feedInChunks(source, sizes, react)), shape(whole), `chunks ${sizes.join(",")}`);
      }
    });
  }

  it("keeps block ids stable as the stream grows", () => {
    const parser = new BlueprintParser(false);
    const early = parser.feed(PAGE.slice(0, PAGE.indexOf("<section>")));
    const late = parser.feed(PAGE);
    assert.deepEqual(
      early.blocks.map((b) => b.id),
      late.blocks.slice(0, early.blocks.length).map((b) => b.id)
    );
  });

  it("starts over when the text is replaced rather than extended", () => {
    const parser = new BlueprintParser(false);
    parser.feed(PAGE);
    const replaced = parser.feed("<footer><p>only</p></footer>");
    assert.deepEqual(outline(replaced), ["footer > text"]);
  });

  it("ignores a tag that has not finished arriving", () => {
    const bp = parseBlueprint(`<body><section><h1>Hi</h1><img src="a.pn`, "HTML");
    // (A first section that opens with an h1 is the hero.)
    assert.deepEqual(outline(bp), ["hero > h1"]);
  });

  it("stops growing at the cap and says how many it left out", () => {
    const many = Array.from({ length: 80 }, (_, i) => `<section><h2>${i}</h2></section>`).join("\n");
    const bp = parseBlueprint(many, "HTML");
    assert.equal(bp.total, BLUEPRINT_MAX_BLOCKS);
    assert.equal(bp.overflow, 160 - BLUEPRINT_MAX_BLOCKS);
  });
});

describe("the build phase comes from the stream", () => {
  const at = (source: string, react = false) => buildPhase(parseBlueprint(source, react ? "REACT" : "HTML"), true);

  it("starting: nothing structural yet", () => {
    assert.equal(buildPhase(null, true), "start");
    assert.equal(at(""), "start");
    assert.equal(at("<!DOCTYPE html><html><head><title>Shop</title>"), "start");
  });
  it("styling: inside an unclosed <style>", () => {
    assert.equal(at("<html><head><style>\n.hero { background: #000;"), "styling");
  });
  it("laying out: writing markup once a block exists", () => {
    assert.equal(at("<html><body><nav><a href='/'>x</a></nav><section><h1>Hi"), "layout");
  });
  it("wiring: inside a <script>, or writing hooks and handlers", () => {
    assert.equal(at("<body><section><h1>x</h1></section><script>\nconst el = document"), "wiring");
    assert.equal(at(`${APP}\nfunction Panel() {\n  const [open, setOpen] = useState(false);`, true), "wiring");
  });
  it("setting up: component code before any markup", () => {
    assert.equal(at(`import { useState } from "react";\n\nexport default function App() {\n  const title = "Shop";`, true), "setup");
  });
  it("rendering: the stream finished, the preview is booting", () => {
    assert.equal(buildPhase(parseBlueprint(PAGE, "HTML"), false), "rendering");
    assert.equal(buildPhase(null, false), "rendering");
  });
  it("every phase has plain words", () => {
    for (const [phase, words] of Object.entries(BUILD_PHASE_COPY)) {
      assert.match(words, /^[A-Z][a-z ]+$/, phase);
    }
  });
});

describe("colour", () => {
  it("reads the first colour of a CSS value", () => {
    assert.equal(colorIn("#fff"), "#fff");
    assert.equal(colorIn("linear-gradient(90deg, rgb(1, 2, 3), #000)"), "rgb(1, 2, 3)");
    assert.equal(colorIn("var(--x)", new Map([["--x", "#123456"]])), "#123456");
    assert.equal(colorIn("var(--missing)", new Map()), null);
    assert.equal(colorIn("none"), null);
  });
  it("reads Tailwind background classes, variants and arbitrary values", () => {
    assert.equal(tailwindInk("bg-blue-600"), "hsl(217 88% 46%)");
    assert.equal(tailwindInk("hover:bg-rose-500/80"), "hsl(350 85% 55%)");
    assert.equal(tailwindInk("bg-[#0b0b0f]"), "#0b0b0f");
    assert.equal(tailwindInk("bg-white"), "#ffffff");
    assert.equal(tailwindInk("text-blue-600"), null);
    assert.equal(tailwindInk("bg-brand-600"), null);
  });
});

describe("reduced motion", () => {
  it("keeps the information and drops the travel", () => {
    assert.deepEqual(blueprintMotionPlan(true), { tilt: false, drawOn: false, maxTiltDeg: 0 });
    const full = blueprintMotionPlan(false);
    assert.equal(full.tilt, true);
    assert.equal(full.drawOn, true);
    assert.ok(full.maxTiltDeg > 0 && full.maxTiltDeg <= 3);
  });
  it("the lean is zero under reduced motion and clamped otherwise", () => {
    assert.deepEqual(blueprintTilt(1, -1, blueprintMotionPlan(true)), { rx: 0, ry: 0 });
    const plan = blueprintMotionPlan(false);
    assert.deepEqual(blueprintTilt(5, -5, plan), { rx: plan.maxTiltDeg, ry: plan.maxTiltDeg });
    assert.deepEqual(blueprintTilt(Number.NaN, 0, plan), { rx: -0, ry: 0 });
  });

  const root = join(__dirname, "..");
  const component = readFileSync(join(root, "src/components/canvas/live-blueprint.tsx"), "utf8");
  const css = readFileSync(join(root, "src/components/canvas/live-blueprint.css"), "utf8");

  it("the component asks lib/motion-preference, never the media query", () => {
    assert.match(component, /import \{ useReducedMotion \} from "@\/lib\/motion-preference"/);
    assert.doesNotMatch(component, /matchMedia|prefers-reduced-motion/);
    assert.match(component, /blueprintMotionPlan\(reduced\)/);
  });
  it("the stylesheet drops draw-on and travel under [data-reduced], and times everything on tokens", () => {
    assert.match(css, /\.bp-root:not\(\[data-reduced\]\) \.bp-outline rect/);
    assert.match(css, /\.bp-root\[data-reduced\] \.bp-row \{\s*animation-name: bp-fade;/);
    assert.match(css, /\.bp-root\[data-reduced\]\[data-state="closed"\] \{\s*animation-name: bp-fade-out;/);
    assert.doesNotMatch(css, /\b\d+m?s\b/, "durations come from --dur-* tokens");
    assert.doesNotMatch(css, /cubic-bezier/, "curves come from --ease-* tokens");
  });
});
