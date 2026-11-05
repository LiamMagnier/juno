import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * The native design gates apply the same per-package enforce globs as the
 * web lint (spec P1 scope 10): a violation inside an enforced glob fails the
 * gate even when the ratchet's baseline already counts it; outside, the
 * ratchet decides as before.
 */

const MOTION = resolve(process.cwd(), "scripts/check-native-motion.mjs");

function fixture(enforce: string[] | null) {
  const dir = mkdtempSync(join(tmpdir(), "juno-p1-native-"));
  const swift = (path: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), "import SwiftUI\nstruct Row: View { var body: some View { Text(\"x\").animation(.easeInOut(duration: 0.3), value: 1) } }\n");
  };
  swift("native/macOS/JunoDesktop/App/Clean/Row.swift");
  swift("native/macOS/JunoDesktop/App/Loose/Row.swift");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  // The ratchet already counts both violations, so without enforcement the gate holds.
  writeFileSync(
    join(dir, "scripts/check-native-design-baseline.json"),
    JSON.stringify({
      motion: {
        total: 2,
        modules: { "JunoDesktop (macOS)": 2 },
        files: { "native/macOS/JunoDesktop/App/Clean/Row.swift": 1, "native/macOS/JunoDesktop/App/Loose/Row.swift": 1 },
      },
    })
  );
  if (enforce) {
    mkdirSync(join(dir, "eslint-rules/enforce"), { recursive: true });
    writeFileSync(join(dir, "eslint-rules/enforce/fixture.json"), JSON.stringify({ package: "fixture", web: [], native: enforce }));
  }
  return dir;
}

test("without an enforce file the ratchet holds at its baseline", () => {
  const dir = fixture(null);
  try {
    const run = spawnSync(process.execPath, [MOTION], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a violation in an enforced native glob fails the gate whatever the baseline says", () => {
  const dir = fixture(["native/macOS/JunoDesktop/App/Clean/**"]);
  try {
    const run = spawnSync(process.execPath, [MOTION], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /files a package enforces/);
    assert.match(run.stdout + run.stderr, /Clean\/Row\.swift/);
    assert.doesNotMatch(run.stdout + run.stderr, /Loose\/Row\.swift:\d+/, "an unlisted file stays under the ratchet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an enforced glob with nothing in it changes nothing", () => {
  const dir = fixture(["native/iOS/JunoMobile/App/Clean/**"]);
  try {
    const run = spawnSync(process.execPath, [MOTION], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
