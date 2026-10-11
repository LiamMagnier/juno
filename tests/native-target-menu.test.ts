import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const checker = resolve("scripts/check-native-targets.mjs");
function check(source: string) {
  const root = mkdtempSync(join(tmpdir(), "alevr-target-gate-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "native/iOS/JunoMobile/App"), { recursive: true });
    writeFileSync(join(root, "scripts/check-native-design-baseline.json"), JSON.stringify({ targets: { total: 0, files: {}, modules: {} } }));
    writeFileSync(join(root, "native/iOS/JunoMobile/App/Fixture.swift"), source);
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the tray's system menu entries inherit native hit targets", () => {
  const result = check(`struct Fixture: View {
    var body: some View {
      NativeTrayMenu(accessibilityLabel: "Project", identifier: "project") {
        Button("New project", action: create)
      } label: { Text("Project") }
    }
  }`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a custom button outside that menu still fails the target gate", () => {
  const result = check(`struct Fixture: View {
    var body: some View {
      VStack {
        NativeTrayMenu(accessibilityLabel: "Project", identifier: "project") {
          Button("New project", action: create)
        } label: { Text("Project") }
        Button("Start", action: start)
      }
    }
  }`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Button label has no .contentShape/);
});
