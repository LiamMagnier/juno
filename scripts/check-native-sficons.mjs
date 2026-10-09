import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/*
 * The iPhone and iPad apps draw the website's icons, never SF Symbols.
 *
 * Owner, Oct 2026: "remove all the SF icons and use website ones". Every glyph
 * the iOS app supplies is a `JunoIcon` — the website's own drawings, generated
 * into symbol sets by scripts/generate-native-icons.mjs — drawn with
 * `JunoIconView`, `JunoSymbol`, `Image(_ icon:)` or `Label(_:image:)` with
 * `JunoIcon.<case>.assetName(...)`. The system still draws its own glyphs
 * (share sheet, keyboard, alerts, navigation chevrons, swipe-action chrome),
 * and those never appear in our source as `systemName:` at all.
 *
 * This gate is a hard zero, not a ratchet: any `Image(systemName:)`,
 * `systemName:` or call-site `systemImage:` argument in iOS app code fails,
 * unless the file and count are in ALLOW below with the reason. See
 * docs/native/ICON_MIGRATION_IOS.md.
 *
 *   node scripts/check-native-sficons.mjs          fail on any new use
 *   node scripts/check-native-sficons.mjs --list   print every use it sees
 */

const ROOTS = ["native/iOS/JunoMobile/App", "native/iOS/JunoMobile/Widgets"];

/** file (relative) → [allowed count, reason]. Keep it empty. */
const ALLOW = {};

const PATTERNS = [
  /Image\(\s*systemName:/,
  /\bsystemName:\s*["A-Za-z(]/,
  // An argument label, not a property named systemImage (`var systemImage:`).
  /[(,]\s*systemImage:/,
  /^\s*systemImage:/,
];

function swiftFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (entry.endsWith(".swift")) out.push(full);
  }
  return out;
}

const list = process.argv.includes("--list");
const hits = new Map();
for (const root of ROOTS) {
  for (const file of swiftFiles(path.join(process.cwd(), root))) {
    const rel = path.relative(process.cwd(), file);
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!PATTERNS.some((pattern) => pattern.test(code))) return;
      if (!hits.has(rel)) hits.set(rel, []);
      hits.get(rel).push(`${rel}:${index + 1}  ${line.trim()}`);
    });
  }
}

let total = 0;
const failures = [];
for (const [file, lines] of hits) {
  total += lines.length;
  const allowed = ALLOW[file]?.[0] ?? 0;
  if (lines.length > allowed) failures.push(...lines);
  if (list) lines.forEach((line) => console.log(line));
}

if (failures.length > 0) {
  console.error(
    `\n  ✗ [sficons] ${failures.length} SF Symbol use(s) in iOS app code. Use the website's icons:\n`
      + `    JunoIconView(.case, size:), JunoSymbol(.case), or Label(title, image: JunoIcon.case.assetName(.regular)).\n`
      + `    Missing a web glyph? Add it through scripts/generate-native-icons.mjs, never hand-drawn.\n\n`
      + failures.map((line) => `  ${line}`).join("\n")
      + "\n",
  );
  process.exit(1);
}

console.log(`[sficons] holding at ${total} SF Symbol use(s) in iOS app code — the website's icons everywhere.`);
