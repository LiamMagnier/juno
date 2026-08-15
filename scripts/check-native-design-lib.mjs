import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/*
 * THE MACHINERY BEHIND THE FOUR NATIVE DESIGN GATES.
 *
 * The rework brief names six rules a reviewer must be able to fail a PR against.
 * Four of them are greppable, and until they were greppable they were prose —
 * which is how this tree accumulated three migrations that were each diagnosed
 * precisely, documented at essay length, and then abandoned half-applied.
 * `junoFont` sits at 36% adoption not because anyone disagreed with it but
 * because nothing ever said no to the 286th `Font.system(size:)`.
 *
 * WHY A RATCHET AND NOT A HARD GATE.
 *
 * The tree has hundreds of type violations today. A gate that fails on all of
 * them is a gate somebody deletes from CI on day one, and a deleted gate is
 * strictly worse than no gate: it leaves a green check where a measurement used
 * to be. So each rule records its CURRENT count in a checked-in baseline and
 * fails only when the count goes UP. Migrating a surface lowers the number; the
 * lane that migrates it re-baselines in the same commit. The number is only ever
 * allowed to travel one direction.
 *
 * The baseline stores per-FILE counts, not just a total. The total is what
 * decides pass/fail — files legitimately move between modules during the rework
 * (extracting a shared row out of JunoDesktop into JunoNativeKit is the whole
 * point of Phase 1), and a per-module gate would fire on the move rather than on
 * the regression. The per-file map is what lets a failure say *which* file grew
 * instead of just "285 → 286, good luck".
 */

const root = process.cwd();

/** Every tree that ships Swift to a user. `desktop-electron` is TypeScript. */
const SWIFT_ROOTS = [
  "native/Packages",
  "native/macOS",
  "native/iOS",
];

/*
 * The reporting buckets. Not strictly "platforms" — JunoNativeKit and JunoCode
 * are shared — but this is the split that matters when reading a count, because
 * a violation in a shared package is one both apps inherit and a violation in
 * JunoMobile is one only the phone has. The rework's fourth principle ("iOS and
 * macOS are peers") is legible in the gap between the last two rows.
 */
const MODULES = [
  ["native/Packages/JunoNativeKit", "JunoNativeKit (shared)"],
  ["native/Packages/JunoCode", "JunoCode (shared)"],
  ["native/Packages/JunoWork", "JunoWork (shared)"],
  ["native/macOS/JunoDesktop", "JunoDesktop (macOS)"],
  ["native/iOS/JunoMobile", "JunoMobile (iOS)"],
];

export function moduleFor(relativePath) {
  const hit = MODULES.find(([prefix]) => relativePath.startsWith(prefix));
  return hit ? hit[1] : "other";
}

export const MODULE_NAMES = MODULES.map(([, name]) => name).concat("other");

/** Every compiled Swift file, sorted so output and baselines are stable. */
export function swiftFiles() {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // `.build` holds checked-out dependency sources — thousands of Swift
        // files nobody here can fix. `node_modules` is the Electron shell.
        if (entry.name === ".build" || entry.name === "node_modules" || entry.name === ".git") continue;
        // 236 of this tree's 703 Swift files are tests, and a test is the one
        // place a raw `.easeOut(duration:)` is CORRECT — `JunoDesignTokensTests`
        // has to construct the curve it is asserting the ladder produces. These
        // gates are about what ships to a user's screen.
        if (entry.name === "Tests") continue;
        walk(relativePath);
        continue;
      }
      if (!entry.name.endsWith(".swift")) continue;
      // `Package.swift` is a manifest, not UI.
      if (entry.name === "Package.swift") continue;
      found.push(relativePath);
    }
  };
  for (const directory of SWIFT_ROOTS) walk(directory);
  return found.sort();
}

/*
 * BLANK OUT COMMENTS AND STRING LITERALS, PRESERVING OFFSETS.
 *
 * This is not an optimisation, it is the difference between a usable gate and a
 * useless one. `JunoDesignTokens.swift` explains the motion ladder in prose that
 * names `.easeOut(duration:)` and `.spring(response:)` a dozen times; the
 * typography header quotes `.font(.system(size:))` while telling you not to
 * write it. A gate that counted its own documentation would report violations
 * nobody can fix by changing code.
 *
 * Every comment and literal character is replaced by a space rather than
 * deleted, so line numbers and columns survive and a hit still points at the
 * real `file:line`.
 */
export function blankCommentsAndStrings(source) {
  const out = source.split("");
  const length = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = length;
      blank(i, end);
      i = end;
      continue;
    }
    if (two === "/*") {
      // Swift block comments nest, and this tree uses that.
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        if (source.slice(j, j + 2) === "/*") { depth += 1; j += 2; continue; }
        if (source.slice(j, j + 2) === "*/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (source.slice(i, i + 3) === '"""') {
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '"') {
      let j = i + 1;
      while (j < length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === '"' || source[j] === "\n") { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** `{ path, source, code, lines }` for every Swift file, comments blanked. */
export function swiftSources() {
  return swiftFiles().map((relativePath) => {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const code = blankCommentsAndStrings(source);
    return { path: relativePath, source, code, lines: code.split("\n") };
  });
}

/** 1-indexed line number of a character offset. */
export function lineAt(code, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) {
    if (code[i] === "\n") line += 1;
  }
  return line;
}

/**
 * The nearest enclosing type declaration above an offset.
 *
 * A heuristic, and deliberately so: the glass rule cares whether a file is
 * *content* — a row, a card, a bubble — and in this tree that is usually said by
 * the file name, but a 1,800-line screen file holds a dozen row structs whose
 * names are the only evidence. Walking back to the last `struct`/`class`/
 * `extension` keyword finds them without parsing Swift.
 */
export function enclosingTypeName(code, offset) {
  const head = code.slice(0, offset);
  const pattern = /\b(?:struct|final class|class|actor|extension|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let name = null;
  let match;
  while ((match = pattern.exec(head)) !== null) name = match[1];
  return name;
}

/**
 * Every `{`-delimited region opened on a line matching `opener`.
 *
 * Returns `{ startLine, endLine }` pairs, 1-indexed and inclusive. Brace
 * counting, not parsing — string literals and comments are already blanked, so
 * the only thing that can throw this off is a brace inside a character class in
 * a regex literal, which Swift does not have.
 */
export function bracedRegions(lines, opener) {
  const regions = [];
  const open = [];
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const armed = opener.test(line);
    let sawOpen = false;
    for (const character of line) {
      if (character === "{") {
        depth += 1;
        if (armed && !sawOpen) {
          open.push({ depth, startLine: index + 1 });
          sawOpen = true;
        }
      } else if (character === "}") {
        while (open.length > 0 && open[open.length - 1].depth === depth) {
          const region = open.pop();
          regions.push({ startLine: region.startLine, endLine: index + 1 });
        }
        depth -= 1;
      }
    }
  }
  for (const region of open) {
    regions.push({ startLine: region.startLine, endLine: lines.length });
  }
  return regions;
}

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

const BASELINE_PATH = "scripts/check-native-design-baseline.json";

function readBaselines() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function writeBaselines(all) {
  const ordered = {};
  for (const key of Object.keys(all).sort()) ordered[key] = all[key];
  fs.writeFileSync(
    path.join(root, BASELINE_PATH),
    `${JSON.stringify(ordered, null, 2)}\n`,
  );
}

function tally(violations) {
  const files = {};
  const modules = {};
  for (const violation of violations) {
    files[violation.path] = (files[violation.path] ?? 0) + 1;
    const bucket = moduleFor(violation.path);
    modules[bucket] = (modules[bucket] ?? 0) + 1;
  }
  const orderedFiles = {};
  for (const key of Object.keys(files).sort()) orderedFiles[key] = files[key];
  const orderedModules = {};
  for (const name of MODULE_NAMES) {
    if (modules[name] !== undefined) orderedModules[name] = modules[name];
  }
  return { total: violations.length, modules: orderedModules, files: orderedFiles };
}

/**
 * Run one rule against the tree, compare it to its baseline, and exit.
 *
 * `rule` is the baseline key and the `[tag]` in every line of output. `why` is
 * the one paragraph a person who just failed this gate needs in order to know
 * what to write instead — it prints on failure and on `--explain`, never on a
 * quiet pass.
 */
export function gate({ rule, headline, why, violations, argv = process.argv.slice(2) }) {
  const wantsBaseline = argv.includes("--baseline");
  const wantsList = argv.includes("--list") || argv.includes("--explain");
  const measured = tally(violations);
  const all = readBaselines();
  const previous = all[rule];

  const show = (subset) => {
    for (const violation of subset) {
      console.log(`  ${violation.path}:${violation.line}  ${violation.reason}`);
    }
  };

  if (wantsBaseline) {
    all[rule] = measured;
    writeBaselines(all);
    const moved = previous ? measured.total - previous.total : null;
    console.log(
      `[${rule}] baseline recorded: ${measured.total} violation(s)`
        + (moved === null ? "" : ` (${moved >= 0 ? "+" : ""}${moved} vs the previous baseline)`),
    );
    for (const [name, count] of Object.entries(measured.modules)) {
      console.log(`    ${count.toString().padStart(4)}  ${name}`);
    }
    return 0;
  }

  if (!previous) {
    console.error(`\n  ✗ [${rule}] has no recorded baseline.`);
    console.error(`    Run: node scripts/check-native-${rule}.mjs --baseline`);
    console.error(`    A rule with no baseline cannot ratchet, and a gate that cannot`);
    console.error(`    ratchet gets switched off — see ${BASELINE_PATH}.\n`);
    return 1;
  }

  if (measured.total > previous.total) {
    const grown = Object.keys(measured.files)
      .filter((file) => (measured.files[file] ?? 0) > (previous.files?.[file] ?? 0))
      .sort();
    console.error(
      `\n  ✗ [${rule}] went UP: ${previous.total} → ${measured.total}. ${headline}\n`,
    );
    console.error(`${why}\n`);
    console.error(`  New violations, by file:`);
    for (const file of grown) {
      const before = previous.files?.[file] ?? 0;
      console.error(`    ${file}  ${before} → ${measured.files[file]}`);
      show(violations.filter((violation) => violation.path === file));
    }
    console.error(
      `\n  This gate ratchets: it only ever fails when the count RISES. Fix the`
        + `\n  lines above, or — if you are deliberately raising the ceiling — say so`
        + `\n  out loud by re-recording the baseline:`
        + `\n    node scripts/check-native-${rule}.mjs --baseline\n`,
    );
    return 1;
  }

  if (wantsList) {
    console.log(`[${rule}] ${measured.total} violation(s) against a baseline of ${previous.total}:`);
    show(violations);
    console.log("");
    console.log(why);
    console.log("");
  }

  if (measured.total < previous.total) {
    console.log(
      `[${rule}] ${measured.total} violation(s), DOWN from ${previous.total}.`
        + ` Lock the new ceiling in: node scripts/check-native-${rule}.mjs --baseline`,
    );
    return 0;
  }

  console.log(`[${rule}] holding at ${previous.total} violation(s) — none added. ${headline}`);
  return 0;
}
