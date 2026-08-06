#!/usr/bin/env node
/**
 * Build the design editor bundle the Mac app hosts.
 *
 * The Mac loads this from disk — never from the network — so the editor a user
 * opens offline is the editor that shipped in the app they installed, and no
 * remote origin can ever serve code into a window that has a bridge to native
 * code. That property is the reason this script exists at all.
 *
 * Output (all self-contained, all local):
 *   native/macOS/JunoDesktop/Resources/DesignEditor/index.html
 *   native/macOS/JunoDesktop/Resources/DesignEditor/editor.js
 *   native/macOS/JunoDesktop/Resources/DesignEditor/editor.css
 *
 *   node scripts/build-design-editor.mjs            # build
 *   node scripts/build-design-editor.mjs --check    # verify freshness in CI
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "native/macOS/JunoDesktop/Resources/DesignEditor");
const entry = join(root, "src/components/design/host/main.tsx");

/** Stamped into the bundle and reported to the host in the `ready` message, so
 *  a mismatched pair is diagnosable from the pane rather than from a guess.
 *
 *  `main.tsx` belongs in this list even though it is only the entry point: the
 *  missing `TooltipProvider` that kept the canvas blank on both platforms lived
 *  there and nowhere else, so a fix to it left the stamped version identical and
 *  `--check` called a stale bundle up to date. A version that cannot change when
 *  the mount changes is not a version. */
/**
 * Every source the bundle is built from, hashed.
 *
 * This was a hand-written list of seven files, and the list is the whole
 * mechanism: `design:editor:check` does nothing but confirm the hash it
 * computes appears in the built `index.html`, so a file missing from the list
 * is a file whose changes leave a stale bundle looking up to date. The
 * inspector, the effects panel, the motion panel, the canvas and the Ask Juno
 * bar were all absent — i.e. most of the editor could change without the Mac
 * and iPhone ever being told to rebuild.
 *
 * That is not hypothetical here. The Mac's design pane rendered nothing for as
 * long as it existed because a fix lived in a file the hash could not see, and
 * the check called the old bundle current.
 *
 * So it walks the directories instead of naming files. A new panel is picked up
 * by existing, which is the only version of this that stays true.
 */
function editorSources() {
  const roots = ["src/lib/design", "src/components/design"];
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) found.push(next);
    }
  };
  for (const relative of roots) walk(relative);
  return found;
}

function editorVersion() {
  const hash = createHash("sha256");
  // Sorted, and the path goes in with the bytes: two files swapping contents
  // is a change, and a concatenation without separators would not notice.
  for (const relative of editorSources()) {
    hash.update(relative);
    hash.update(readFileSync(join(root, relative)));
  }
  return `1.0.0+${hash.digest("hex").slice(0, 12)}`;
}

const INDEX_HTML = (version) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <!--
      A restrictive policy on the trusted editor itself. 'self' only: the bundle
      and its stylesheet come from the app's own resource directory, and there is
      no connect-src at all — the editor cannot reach the network even if a
      dependency tried to. User-authored artwork never becomes markup here (the
      renderer escapes it), and any user-executable preview belongs in an
      isolated child frame, which is what frame-src permits and nothing else.
    -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'"
    />
    <title>Juno Design</title>
    <link rel="stylesheet" href="editor.css" />
  </head>
  <body data-juno-design-editor-version="${version}">
    <div id="root"></div>
    <script src="editor.js"></script>
  </body>
</html>
`;

function build() {
  const version = editorVersion();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // esbuild arrives with the toolchain rather than as a direct dependency; fail
  // with the fix rather than a module-not-found stack.
  const esbuild = join(root, "node_modules/.bin/esbuild");
  if (!existsSync(esbuild)) {
    console.error("[design-editor] esbuild not found. Run `npm install` first.");
    process.exit(1);
  }

  execFileSync(
    esbuild,
    [
      entry,
      "--bundle",
      "--format=iife",
      "--platform=browser",
      "--target=safari17",
      "--minify",
      "--legal-comments=none",
      `--outfile=${join(outDir, "editor.js")}`,
      // The app's own "@/..." alias, so the host bundle and the website compile
      // the identical sources.
      `--alias:@=${join(root, "src")}`,
      `--define:__JUNO_DESIGN_EDITOR_VERSION__=${JSON.stringify(version)}`,
      "--define:process.env.NODE_ENV=\"production\"",
      "--loader:.tsx=tsx",
      "--loader:.ts=ts",
      "--jsx=automatic",
    ],
    { stdio: "inherit", cwd: root }
  );

  // Tailwind, scanned against the editor's own sources only. The website's
  // stylesheet is not reused: it carries the marketing site, the chat surface
  // and every page's utilities, and none of that belongs in a design canvas.
  const tailwind = join(root, "node_modules/.bin/tailwindcss");
  const cssEntry = join(outDir, ".editor.src.css");
  writeFileSync(
    cssEntry,
    `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${readFileSync(join(root, "src/components/design/host/editor.css"), "utf8")}`
  );
  if (existsSync(tailwind)) {
    execFileSync(
      tailwind,
      ["-i", cssEntry, "-o", join(outDir, "editor.css"), "--minify", "--content", "./src/components/design/**/*.{ts,tsx}"],
      { stdio: "inherit", cwd: root }
    );
  } else {
    // Without Tailwind the editor still *works* — the canvas is SVG and the
    // engine is untouched — so ship the hand-written layer rather than nothing,
    // and say what is missing.
    console.warn("[design-editor] tailwindcss not found; writing base styles only.");
    writeFileSync(join(outDir, "editor.css"), readFileSync(join(root, "src/components/design/host/editor.css")));
  }
  rmSync(cssEntry, { force: true });

  writeFileSync(join(outDir, "index.html"), INDEX_HTML(version));
  console.log(`[design-editor] built ${outDir} (version ${version})`);
  return version;
}

if (process.argv.includes("--check")) {
  const indexPath = join(outDir, "index.html");
  if (!existsSync(indexPath)) {
    console.error("[design-editor] bundle missing. Run: npm run design:editor");
    process.exit(1);
  }
  const expected = editorVersion();
  const current = readFileSync(indexPath, "utf8");
  if (!current.includes(expected)) {
    console.error(`[design-editor] bundle is stale (expected ${expected}). Run: npm run design:editor`);
    process.exit(1);
  }
  console.log("[design-editor] up to date");
} else {
  build();
}
