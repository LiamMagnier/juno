#!/usr/bin/env node
/**
 * The native-parity label gate (spec §A4.6, MACOS_LIQUID_GLASS_REDESIGN.md).
 *
 * A handful of web files decide things the Mac and iPhone apps mirror by hand:
 * the chat request the apps send, the sidebar's rows, which drawing each icon
 * concept wears, and the colour and type tokens. The generators catch a drifted
 * *projection* (design:tokens:check, native:icons:check); nothing catches the
 * rest — a field added to the chat body, a row moved in the sidebar. So a pull
 * request that touches one of these files has to say, with a label, whether
 * the native side was handled:
 *
 *   native: done   the apps were updated (in this PR or a linked one)
 *   native: n/a    the change does not reach the apps
 *
 * The watched paths are listed twice, here and in CODEOWNERS, so a reviewer is
 * requested as well as the label enforced. This script fails if the two lists
 * drift apart.
 *
 * Run:
 *   node scripts/check-native-parity-label.mjs
 *       Locally: diffs origin/main...HEAD and reads labels from --labels.
 *   node scripts/check-native-parity-label.mjs --base <ref> --head <ref> --labels "native: done"
 *   node scripts/check-native-parity-label.mjs --files a.ts,b.css --labels "native: n/a"
 *   In CI (`pull_request`): base, head and labels come from GITHUB_EVENT_PATH.
 *
 * Exit: 0 when no watched file changed or a parity label is present, 1 when a
 * watched file changed without one (or CODEOWNERS drifted), 2 on bad usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The web files §A4.6 names. A trailing slash watches a directory. */
export const WATCHED = [
  "src/lib/chat/request.ts",
  "src/app/api/chat/",
  "src/components/app/app-sidebar.tsx",
  "src/lib/app-icons.ts",
  "src/components/ui/icons.tsx",
  "src/app/globals.css",
];

export const LABELS = ["native: done", "native: n/a"];

export function isWatched(file) {
  return WATCHED.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));
}

/** Watched paths CODEOWNERS does not own explicitly, as `/path` patterns. */
export function missingFromCodeowners(codeowners) {
  const owned = new Set(
    codeowners
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0].replace(/^\//, "")),
  );
  return WATCHED.filter((path) => !owned.has(path));
}

function parseArgs(argv) {
  const args = { base: null, head: null, labels: null, files: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--base", "--head", "--labels", "--files"].includes(flag) || value === undefined) {
      console.error(`[native-parity] unknown or incomplete argument: ${flag}`);
      process.exit(2);
    }
    args[flag.slice(2)] = value;
    i++;
  }
  return args;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function gitChangedFiles(base, head) {
  // Three dots: what the branch changed since it left `base`, not what `base`
  // gained since — the same set a pull request's "Files changed" shows.
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const codeownersPath = join(root, "CODEOWNERS");
  const codeowners = existsSync(codeownersPath) ? readFileSync(codeownersPath, "utf8") : "";
  const unowned = missingFromCodeowners(codeowners);
  if (unowned.length > 0) {
    console.error(
      `[native-parity] CODEOWNERS does not list ${unowned.map((p) => `/${p}`).join(", ")}.\n`
        + "  The watched list here and the parity section of CODEOWNERS must name the same paths.",
    );
    process.exit(1);
  }

  let base = args.base;
  let head = args.head;
  let labels = args.labels === null ? null : splitList(args.labels);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const pr = event.pull_request;
    if (pr) {
      base ??= pr.base?.sha;
      head ??= pr.head?.sha;
      labels ??= (pr.labels ?? []).map((label) => label.name);
    }
  }
  base ??= "origin/main";
  head ??= "HEAD";
  labels ??= [];

  let files;
  try {
    files = args.files === null ? gitChangedFiles(base, head) : splitList(args.files);
  } catch (error) {
    console.error(`[native-parity] could not diff ${base}...${head}: ${error.message.split("\n")[0]}`);
    process.exit(2);
  }

  const touched = files.filter(isWatched);
  if (touched.length === 0) {
    console.log(`[native-parity] no watched web file changed (${files.length} files checked).`);
    return;
  }

  const present = labels.filter((label) => LABELS.includes(label.toLowerCase().trim()));
  if (present.length > 0) {
    console.log(
      `[native-parity] ${touched.length} watched file(s) changed; labelled "${present[0]}":\n`
        + touched.map((file) => `    ${file}`).join("\n"),
    );
    return;
  }

  console.error(
    `[native-parity] this change touches web files the native apps mirror:\n`
      + touched.map((file) => `    ${file}`).join("\n")
      + `\n\n  Add one label to the pull request:\n`
      + `    "native: done"  the Mac and iPhone apps were updated to match (here or in a linked PR)\n`
      + `    "native: n/a"   the change does not reach the apps\n`
      + `  Why: docs/native/MACOS_LIQUID_GLASS_REDESIGN.md §A4.6.\n`,
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
