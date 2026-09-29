import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Web design-system ratchet.
 *
 * Native has source gates for type, motion, glass and hit targets. This gives
 * the React surface the same "do not make the debt worse" property for the
 * highest-signal design islands found in the production audit. Existing legacy
 * files are explicit and reviewable below; any *new* file that introduces one
 * of these private vocabularies fails the ordinary `npm test` lane.
 */
const ROOTS = ["src/app", "src/components"];
const SOURCE = /\.(?:ts|tsx|js|jsx)$/;

const legacyPaletteAllowlist = new Set([
  "src/app/(app)/assistants/page.tsx",
  "src/app/(app)/profile/page.tsx",
  "src/components/chat/file-preview.tsx",
]);

const legacyConfirmAllowlist = new Set([
  "src/app/(app)/assistants/page.tsx",
  "src/app/(app)/projects/[id]/page.tsx",
  "src/app/(app)/profile/page.tsx",
  "src/components/admin/users-admin.tsx",
  "src/components/app/app-sidebar.tsx",
  "src/components/research/run-controls.tsx",
]);

async function filesUnder(root: string): Promise<string[]> {
  const values: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (SOURCE.test(entry.name)) values.push(absolute);
    }
  }
  await walk(root);
  return values;
}

function repoPath(value: string): string {
  return value.split(path.sep).join("/");
}

test("new web surfaces use semantic Juno colors instead of private neutral/coral palettes", async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await filesUnder(root)) {
      const relative = repoPath(file);
      if (legacyPaletteAllowlist.has(relative)) continue;
      const source = await readFile(file, "utf8");
      if (/\b(?:bg|text|border|ring|from|via|to)-(?:neutral|coral)-\d{2,3}\b/.test(source)) {
        offenders.push(relative);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `New raw neutral/coral palette islands found:\n${offenders.map((v) => `- ${v}`).join("\n")}\nUse semantic Juno tokens or add a narrowly-reviewed visualization exception.`,
  );
});

test("new product surfaces do not use browser confirm dialogs", async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await filesUnder(root)) {
      const relative = repoPath(file);
      if (legacyConfirmAllowlist.has(relative)) continue;
      const source = await readFile(file, "utf8");
      // Ignore identifiers such as `confirmLabel`; only direct browser/global
      // calls count. Product decisions belong in Juno Dialog/Sheet primitives.
      if (/(?:\bwindow\s*\.\s*)?\bconfirm\s*\(/.test(source)) offenders.push(relative);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `New browser confirm() dialogs found:\n${offenders.map((v) => `- ${v}`).join("\n")}\nUse the shared Dialog/confirmation surface instead.`,
  );
});
