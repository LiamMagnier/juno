import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSER_MODES,
  applyComposerMode,
  availableComposerModes,
  composerModeInfo,
  composerModeOf,
  cycleComposerMode,
  initialModePair,
  projectModeKey,
  setComposerMode,
} from "@/lib/code-v2/composer-mode";
import type { InteractionMode, RuntimeMode } from "@/lib/code-v2/contracts";
import { readFileSync } from "node:fs";

test("the composer offers the five modes, in ladder order, each with one line", () => {
  assert.deepEqual(
    COMPOSER_MODES.map((m) => m.label),
    ["Ask", "Accept edits", "Auto", "Plan", "Full access"],
  );
  for (const m of COMPOSER_MODES) {
    assert.ok(m.description.length > 0 && !m.description.includes("\n"));
    assert.ok(!m.description.includes("—"), "no em dashes in copy");
  }
});

test("each mode round-trips through the contract's runtime and interaction pair", () => {
  for (const m of COMPOSER_MODES) {
    const pair = applyComposerMode(m.mode, "auto-edit");
    assert.equal(composerModeOf(pair.runtimeMode, pair.interactionMode), m.mode);
  }
  assert.deepEqual(applyComposerMode("full", "ask"), { runtimeMode: "full", interactionMode: "default" });
  assert.deepEqual(applyComposerMode("accept-edits", "full"), { runtimeMode: "auto-edit", interactionMode: "default" });
});

test("Plan keeps the mode the approved plan builds with, never read-only", () => {
  assert.deepEqual(applyComposerMode("plan", "full"), { runtimeMode: "full", interactionMode: "plan" });
  assert.deepEqual(applyComposerMode("plan", "read-only"), { runtimeMode: "auto-edit", interactionMode: "plan" });
  assert.equal(composerModeOf("read-only", "default"), "read-only");
  assert.equal(composerModeInfo("read-only").label, "Read only");
});

test("only the modes an instance can enforce are offered and cycled", () => {
  const acp: RuntimeMode[] = ["ask", "auto-edit", "full"];
  assert.deepEqual(
    availableComposerModes(acp, false).map((m) => m.mode),
    ["ask", "accept-edits", "full"],
  );
  assert.equal(cycleComposerMode("accept-edits", acp, false), "full");
  assert.equal(cycleComposerMode("full", acp, false), "ask");
  assert.equal(cycleComposerMode("auto", undefined, true), "plan");
  assert.equal(cycleComposerMode("plan", undefined, true), "full");
});

test("a thread's own choice wins, then the project's last, then Accept edits", () => {
  assert.deepEqual(initialModePair({ runtimeMode: "ask" }, { runtimeMode: "full", interactionMode: "default" }), {
    runtimeMode: "ask",
    interactionMode: "default",
  });
  assert.deepEqual(initialModePair({}, { runtimeMode: "full" }), { runtimeMode: "full", interactionMode: "default" });
  assert.deepEqual(initialModePair({}, null), { runtimeMode: "auto-edit", interactionMode: "default" });
  assert.equal(projectModeKey("  "), null);
  assert.equal(projectModeKey("storefront"), "alevr.code.mode.project.storefront");
});

test("setting a mode is one write when the thread offers it", () => {
  const writes: unknown[] = [];
  setComposerMode({ setRuntimeMode: (m: RuntimeMode) => writes.push(m), setInteractionMode: (m: InteractionMode) => writes.push(m), setModes: (p) => writes.push(p) }, "full", "ask");
  assert.deepEqual(writes, [{ runtimeMode: "full", interactionMode: "default" }]);
  const split: unknown[] = [];
  setComposerMode({ setRuntimeMode: (m: RuntimeMode) => split.push(m), setInteractionMode: (m: InteractionMode) => split.push(m) }, "plan", "auto");
  assert.deepEqual(split, ["auto", "plan"]);
});

test("the v2 composer keeps the mode on the row and uses Chat's dictation and Code's call", () => {
  const src = readFileSync("src/components/code/v2/composer.tsx", "utf8");
  assert.match(src, /aria-label=\{`Mode: \$\{modeInfo\.label\}`\}/);
  assert.match(src, /<DictationSwap active=\{dictating\}/);
  // The call is the composer, as in Chat: voiceCallParts through useCodeVoiceCall, the glow around the shell.
  assert.match(src, /useCodeVoiceCall\(\{ open: voice\.open, onClose: voice\.close, briefing: voiceBriefing, send: voiceSend/);
  assert.match(src, /<VoiceComposerGlow call=\{call\}>/);
  assert.match(src, /call\.end/);
  assert.doesNotMatch(src, /<CodeVoicePanel/);
  assert.match(src, /aria-label="Voice conversation"/);
  assert.doesNotMatch(src, /useSpeechRecognition/);
  // A spoken line takes the same road as a typed one while a turn runs.
  assert.match(src, /if \(canSteer\) void actions\.steer\(text\);\s*else actions\.queue\(text\);/);
});

test("the landing: cloud runs carry Plan, Accept edits or Full access; a new thread starts on the choice", async () => {
  const m = await import("../src/lib/code-v2/composer-mode");
  assert.equal(m.cloudPermissionMode("plan"), "plan");
  assert.equal(m.cloudPermissionMode("accept-edits"), "auto-edit");
  assert.equal(m.cloudPermissionMode("full"), "full");
  assert.equal(m.cloudPermissionMode("ask"), null);
  assert.deepEqual(
    m.availableComposerModes(m.CLOUD_RUNTIME_APPROVALS, true).map((x) => x.mode),
    ["accept-edits", "plan", "full"],
  );
  assert.equal(m.landingMode("cloud", null), "full", "cloud runs keep the Full access they always had");
  assert.equal(m.landingMode("device", null), "accept-edits");
  assert.equal(m.landingMode("device", { runtimeMode: "full", interactionMode: "default" }), "full", "the project's last choice");
  assert.equal(m.landingMode("cloud", { runtimeMode: "ask", interactionMode: "default" }), "full", "a cloud run cannot ask, so its default stands");
  assert.equal(m.threadPrefsKey("c1"), "alevr.code.prefs.c1");
  assert.deepEqual(m.seededThreadPrefs({ selection: { instanceId: "alevr" } }, "full"), {
    selection: { instanceId: "alevr" },
    runtimeMode: "full",
    interactionMode: "default",
  });
  assert.deepEqual(m.seededThreadPrefs(null, "plan"), { runtimeMode: "auto-edit", interactionMode: "plan" });
});
