#!/usr/bin/env node
/**
 * Generates the native asset catalogs' Juno navigation icons from the *web's*
 * icon source, so the two can never drift.
 *
 * `src/lib/app-icons.ts` is the canonical mapping from a destination (home,
 * projects, artifacts, …) to its glyph. Those glyphs are Lucide icons, not a
 * bespoke Juno set — so "use the website's icons" means shipping the very same
 * Lucide geometry, read out of the installed `lucide-react` rather than
 * redrawn or approximated by an SF Symbol. Lucide is ISC-licensed, which
 * permits redistribution inside the app bundle.
 *
 * Output: one `.imageset` per destination containing a 24x24 SVG, registered
 * with `preserves-vector-representation` (so it stays crisp at any Dynamic Type
 * size) and `template-rendering-intent` (so SwiftUI tints it with the current
 * foreground colour — which is what makes a single asset work in both light and
 * dark, exactly as the web's `dark:invert` does for the mark).
 *
 * Run: node scripts/generate-native-icons.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lucideDir = join(root, "node_modules/lucide-react/dist/esm/icons");

/** Destination -> Lucide icon file, mirroring `src/lib/app-icons.ts` exactly. */
const ICONS = {
  home: "home",
  code: "code-2",
  library: "library",
  artifacts: "layers-3",
  projects: "folder",
  tasks: "calendar-clock",
  connections: "plug",
  pulls: "git-pull-request",
  conversation: "message-circle",
  new: "plus",
  search: "search",
};

const TARGETS = [
  join(root, "native/iOS/JunoMobile/Resources/Assets.xcassets/Navigation"),
  join(root, "native/macOS/JunoMac/Resources/Assets.xcassets/Navigation"),
];

/** Follows `export { default } from './other.mjs'` re-exports to the real node. */
function readIconNode(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`re-export cycle at ${name}`);
  seen.add(name);
  const file = join(lucideDir, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`no Lucide icon '${name}'`);
  const src = readFileSync(file, "utf8");

  const reexport = src.match(/export \{ default \} from '\.\/([^']+)\.mjs'/);
  if (reexport) return readIconNode(reexport[1], seen);

  const body = src.match(/const __iconNode = (\[[\s\S]*?\n\]);/);
  if (!body) throw new Error(`no __iconNode in ${name}`);
  // The literal is plain JSON-ish JS (tag + attribute object per element).
  return new Function(`return ${body[1]}`)();
}

/** Lucide's canonical presentation attributes, per its own <svg> wrapper. */
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
  ' fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

function toSVG(node) {
  const els = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `  <${tag} ${a}/>`;
    })
    .join("\n");
  return `${SVG_OPEN}\n${els}\n</svg>\n`;
}

const contents = (svgName) =>
  JSON.stringify(
    {
      images: [{ filename: svgName, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  ) + "\n";

let count = 0;
for (const target of TARGETS) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // Deliberately *not* `provides-namespace`. A namespaced group compiles the
  // asset as "Navigation/nav-projects", so `Image("nav-projects")` resolves to
  // nothing — and a missing image in SwiftUI renders as empty space with no
  // error, so the mistake is invisible until someone looks at the screen. The
  // sibling Providers catalog is flat for the same reason.
  writeFileSync(
    join(target, "Contents.json"),
    JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n",
  );

  for (const [destination, lucideName] of Object.entries(ICONS)) {
    const set = join(target, `nav-${destination}.imageset`);
    mkdirSync(set, { recursive: true });
    const svg = `nav-${destination}.svg`;
    writeFileSync(join(set, svg), toSVG(readIconNode(lucideName)));
    writeFileSync(join(set, "Contents.json"), contents(svg));
    count += 1;
  }
}

console.log(`Generated ${count} navigation icons across ${TARGETS.length} asset catalogs.`);
console.log(`Source: lucide-react (ISC) via src/lib/app-icons.ts`);
