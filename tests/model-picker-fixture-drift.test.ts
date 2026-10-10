import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * The one bundled copy of the catalogue on the native side is the Mac model
 * picker's snapshot fixture (ModelPickerWebFixtures.swift). The apps
 * themselves read /api/v1/models at runtime; this file only feeds the
 * offscreen snapshots that are compared with the web's /dev/model-picker.
 * It is generated from src/lib/models.ts, and this test fails the moment the
 * two disagree, so a catalogue change can never leave the Mac pictures showing
 * last week's models. Fix with:
 *
 *   npx tsx scripts/export-model-picker-fixture.mts > native/macOS/JunoDesktop/Tests/Snapshots/ModelPickerWebFixtures.swift
 *
 * (`npm run models:sync -- --apply` does it for you.)
 */
test("the Mac picker fixture is exactly what the catalogue generates", { timeout: 120_000 }, () => {
  const env = { ...process.env };
  delete env.FIXTURE_DAY;
  delete env.JUNO_CATALOG_TODAY;
  const generated = execFileSync("npx", ["tsx", "scripts/export-model-picker-fixture.mts"], { cwd: process.cwd(), encoding: "utf8", env });
  const committed = readFileSync(path.join(process.cwd(), "native/macOS/JunoDesktop/Tests/Snapshots/ModelPickerWebFixtures.swift"), "utf8");
  assert.ok(generated.trim() === committed.trim(), "ModelPickerWebFixtures.swift has drifted from src/lib/models.ts: regenerate it (see the comment above)");
});
