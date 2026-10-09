import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyUsageLimit, parseResetFromText, earliestExhaustedReset, normalizeReset } from "../src/providers/limits.js";
import { SessionLog, type SessionMeta } from "../src/protocol/session-log.js";
import { applySessionEvent } from "../src/protocol/reducer.js";
import { claudeSetup, codexSetup, acpSetup, defaultInstances, ACP_PRESETS } from "../src/providers/presets.js";
import { acpModeFor, autoDecision, pickOption, acpToolItem } from "../src/providers/acp.js";
import { codexLimitWindows, codexTurnPolicy } from "../src/providers/codex.js";
import { claudeLimitWindows, claudePermissionMode, toolItem, summarizeTool } from "../src/providers/claude-agent.js";
import { engineMode, splitModel } from "../src/providers/alevr.js";
import { parseVersion, shellQuote } from "../src/providers/detect.js";
import { stricterMode } from "../src/sessions/session-manager.js";
import { tempDir } from "./helpers.js";

const NOW = new Date("2026-10-08T12:00:00Z");

test("usage limits: codes, vendor prose and transient throttling", () => {
  assert.deepEqual(classifyUsageLimit({ code: "usageLimitExceeded", now: NOW }), { limited: true });
  const piped = classifyUsageLimit({ message: "Claude AI usage limit reached|1791460800", now: NOW });
  assert.equal(piped.limited, true);
  assert.equal(piped.resetsAt, new Date(1791460800 * 1000).toISOString());
  const rel = classifyUsageLimit({ message: "You've hit your usage limit. Try again in 2 hours 30 minutes.", now: NOW });
  assert.equal(rel.limited, true);
  assert.equal(rel.resetsAt, new Date(NOW.getTime() + 2.5 * 3600_000).toISOString());
  assert.equal(classifyUsageLimit({ message: "Quota exceeded for this account.", now: NOW }).limited, true);
  assert.equal(classifyUsageLimit({ message: "RESOURCE_EXHAUSTED: rate", now: NOW }).limited, true);
  assert.equal(classifyUsageLimit({ message: "429 Too Many Requests, retrying in 2s", now: NOW }).limited, false);
  assert.equal(classifyUsageLimit({ message: "TypeError: x is undefined", now: NOW }).limited, false);
  assert.equal(classifyUsageLimit({ message: "Weekly limit reached — resets at 3:05 PM", now: NOW }).limited, true);
});

test("usage limits: reset parsing", () => {
  const at = parseResetFromText("limit reached, try again at 3pm", NOW);
  assert.ok(at);
  assert.equal(new Date(at!).getHours(), 15);
  assert.equal(parseResetFromText("nothing here", NOW), undefined);
  assert.equal(normalizeReset(1_000, NOW), undefined, "a reset decades ago is a parsing accident");
  assert.equal(normalizeReset("2026-10-08T13:00:00Z", NOW), "2026-10-08T13:00:00.000Z");
  const reset = earliestExhaustedReset(
    [
      { usedPct: 100, resetsAt: "2026-10-08T15:00:00Z" },
      { usedPct: 100, resetsAt: "2026-10-08T13:00:00Z" },
      { usedPct: 40, resetsAt: "2026-10-08T12:30:00Z" },
    ],
    NOW,
  );
  assert.equal(reset, "2026-10-08T13:00:00.000Z");
});

function meta(id: string): SessionMeta {
  return {
    id,
    cwd: "/tmp",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    selection: { instanceId: "alevr", model: "anthropic:claude-opus-5-5" },
    runtimeMode: "ask",
    interactionMode: "default",
    turnCount: 0,
  };
}

test("session log: gap-free sequences, coalesced deltas, replay and snapshot", async () => {
  const root = tempDir("log");
  const log = SessionLog.create(root, meta("s_one"), 30);
  const seen: number[] = [];
  log.subscribe((e) => seen.push(e.sequence));
  log.emit({ type: "turn.started", turnId: "t1", selection: { instanceId: "alevr", model: "m" } });
  log.emit({ type: "item.added", item: { id: "m1", kind: "assistant_message", createdAt: NOW.toISOString(), text: "", streaming: true } });
  for (const ch of "hello world") log.emit({ type: "item.delta", itemId: "m1", field: "text", append: ch });
  assert.equal(seen.length, 2, "deltas wait for the coalescing window");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [1, 2, 3], "eleven deltas became one event");
  log.emit({ type: "item.delta", itemId: "m1", field: "text", append: "!" });
  log.emit({ type: "turn.completed", turnId: "t1", outcome: "completed" });
  assert.deepEqual(seen, [1, 2, 3, 4, 5], "a non-delta event flushes pending deltas first, in order");
  const snap = log.snapshot;
  assert.equal(snap.state, "idle");
  assert.equal((snap.items[0] as { text: string }).text, "hello world!");
  assert.equal(log.eventsAfter(3)?.map((e) => e.sequence).join(","), "4,5");
  assert.equal(log.eventsAfter(99), null);
  log.close();

  // Torn last line after a crash is dropped; the rest replays.
  fs.appendFileSync(path.join(root, "s_one", "events.jsonl"), '{"sequence":6,"at":"x","event":{"type":"queue.upd');
  const again = SessionLog.load(root, "s_one", 30)!;
  assert.equal(again.sequence, 5);
  assert.equal((again.snapshot.items[0] as { text: string }).text, "hello world!");
  again.emit({ type: "queue.updated", queue: [] });
  assert.equal(again.sequence, 6);
  again.close();
  const third = SessionLog.load(root, "s_one", 30)!;
  assert.equal(third.sequence, 6, "the truncated tail was rewritten cleanly");
  third.close();
});

test("session log: a process that died mid-turn does not come back as running", () => {
  const root = tempDir("log2");
  const log = SessionLog.create(root, meta("s_two"), 0);
  log.emit({ type: "turn.started", turnId: "t1", selection: { instanceId: "alevr", model: "m" } });
  log.close();
  const loaded = SessionLog.load(root, "s_two")!;
  assert.equal(loaded.snapshot.state, "idle");
  assert.equal(loaded.snapshot.activeTurnId, undefined);
});

test("session ids are directory names and refuse traversal", () => {
  const root = tempDir("log3");
  assert.throws(() => SessionLog.create(root, meta("../escape")));
  assert.equal(SessionLog.load(root, "../../etc"), null);
});

test("reducer: limited and failed outcomes", () => {
  const base = { id: "s", cwd: "/", selection: { instanceId: "a", model: "m" }, runtimeMode: "ask" as const, interactionMode: "default" as const, state: "idle" as const, items: [], queue: [] };
  const running = applySessionEvent(base, { type: "turn.started", turnId: "t", selection: base.selection });
  assert.equal(running.state, "running");
  assert.equal(applySessionEvent(running, { type: "turn.completed", turnId: "t", outcome: "limited" }).state, "limited");
  assert.equal(applySessionEvent(running, { type: "turn.completed", turnId: "t", outcome: "failed" }).state, "error");
  const limited = applySessionEvent(base, { type: "session.state", state: "limited", resumeAt: "2026-10-08T13:00:00Z" });
  assert.equal(limited.resumeAt, "2026-10-08T13:00:00Z");
  assert.equal(applySessionEvent(limited, { type: "turn.started", turnId: "t2", selection: base.selection }).resumeAt, undefined);
});

test("presets: honest names, isolated login commands, Antigravity enabled with no ambient credentials", () => {
  const claude = defaultInstances().find((i) => i.kind === "claude-agent")!;
  assert.equal(claude.label, "Claude (your subscription)");
  for (const i of defaultInstances()) assert.ok(!/claude code/i.test(i.label), `${i.label} must not present Claude Code as Alevr's`);
  assert.equal(claudeSetup({ ...claude, configDir: "/Users/me/.claude-work" }, "login").command, "CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login");
  assert.equal(claudeSetup(claude, "install").command, "curl -fsSL https://claude.ai/install.sh | bash");
  const codex = defaultInstances().find((i) => i.kind === "codex")!;
  assert.equal(codexSetup({ ...codex, configDir: "/Users/me/codex home" }, "login").command, "CODEX_HOME='/Users/me/codex home' codex login");
  assert.equal(acpSetup({ id: "acp:grok", kind: "acp", label: "Grok", status: "unknown" }, "login")?.command, "grok login");
  assert.equal(acpSetup({ id: "acp:dsh", kind: "acp", label: "dsh", status: "unknown" }, "login"), null);
  const antigravity = ACP_PRESETS.find((p) => p.preset === "antigravity");
  assert.ok(antigravity);
  assert.equal(antigravity.legalHold, undefined, "the owner enabled Antigravity on 2026-10-09");
  assert.deepEqual(antigravity.envPassthrough, []);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(parseVersion("2.1.50 (Claude Code)"), "2.1.50");
  assert.equal(parseVersion("codex-cli 0.160.0"), "0.160.0");
});

test("mode tables: Codex, Claude, ACP and the engine", () => {
  assert.deepEqual(codexTurnPolicy("ask"), { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } });
  assert.deepEqual(codexTurnPolicy("auto"), { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } });
  assert.deepEqual(codexTurnPolicy("full"), { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(claudePermissionMode("ask", "plan"), "plan");
  assert.equal(claudePermissionMode("auto-edit", "default"), "acceptEdits");
  assert.equal(claudePermissionMode("full", "default"), "bypassPermissions");
  assert.equal(claudePermissionMode("read-only", "default"), "plan");
  assert.equal(engineMode("auto", "default"), "auto-edit");
  assert.equal(engineMode("ask", "plan"), "plan");
  const modes = [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }, { id: "bypassPermissions", name: "Bypass" }];
  assert.equal(acpModeFor("auto-edit", modes), "acceptEdits");
  assert.equal(acpModeFor("full", modes), "bypassPermissions");
  assert.equal(acpModeFor("ask", modes), "default");
  assert.equal(autoDecision("full", "execute"), "accept");
  assert.equal(autoDecision("auto-edit", "edit"), "accept");
  assert.equal(autoDecision("auto-edit", "execute"), undefined);
  assert.equal(autoDecision("read-only", "edit"), "decline");
  assert.equal(autoDecision("read-only", "other"), "decline", "read-only fails closed on unknown kinds");
  assert.equal(autoDecision("read-only", undefined), "decline");
  assert.equal(autoDecision("read-only", "read"), undefined);
  const opts = [{ optionId: "a", name: "Allow", kind: "allow_once" as const }, { optionId: "r", name: "No", kind: "reject_once" as const }];
  assert.equal(pickOption(opts, "acceptForSession")?.optionId, "a", "falls back to the same polarity");
  assert.equal(pickOption(opts, "decline")?.optionId, "r");
  assert.equal(stricterMode("full", "ask"), "ask");
  assert.equal(stricterMode("read-only", "full"), "read-only");
  assert.deepEqual(splitModel("opus"), { lab: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(splitModel("openai:gpt-6.1"), { lab: "openai", model: "gpt-6.1" });
});

test("limit windows from Codex and Claude payloads", () => {
  const codex = codexLimitWindows({ primary: { usedPercent: 100, resetsAt: 1791460800, windowDurationMins: 300 }, secondary: { usedPercent: 12.5, windowDurationMins: 10080 } });
  assert.deepEqual(codex.map((w) => [w.id, w.label, w.usedPct]), [["primary", "5-hour", 100], ["secondary", "Weekly", 12.5]]);
  const claude = claudeLimitWindows({ five_hour: { utilization: 40, resets_at: "2026-10-08T15:00:00Z" }, seven_day: { utilization: null, resets_at: null }, extra: "x" });
  assert.deepEqual(claude.map((w) => [w.id, w.label, w.usedPct]), [["five_hour", "5-hour", 40]]);
});

test("tool calls normalize to turn items", () => {
  const bash = toolItem("Bash", { command: "npm test" }, "tu", "i1", "t1", NOW.toISOString(), "running");
  assert.equal(bash?.kind, "command_execution");
  const edit = toolItem("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b\nc" }, "tu", "i2", "t1", NOW.toISOString(), "completed");
  assert.equal(edit?.kind, "file_change");
  assert.equal(edit?.kind === "file_change" && edit.changes[0].additions, 2);
  assert.equal(toolItem("ExitPlanMode", {}, "x", "y", "t", "", "running"), undefined);
  assert.equal(summarizeTool("mcp__alevr__spawn_subagent", {}), "alevr · spawn_subagent");
  const acpEdit = acpToolItem({ toolCallId: "c", kind: "edit", status: "completed", content: [{ type: "diff", path: "a.ts", oldText: null, newText: "x" }] }, undefined, "i", "t", NOW.toISOString());
  assert.equal(acpEdit?.kind === "file_change" && acpEdit.changes[0].change, "add");
  const acpExec = acpToolItem({ toolCallId: "c", kind: "execute", status: "in_progress", rawInput: { command: ["ls", "-la"] } }, undefined, "i", "t", NOW.toISOString());
  assert.equal(acpExec?.kind === "command_execution" && acpExec.command, "ls -la");
});

test("worktree setup scripts never inherit Alevr's own variables (the env server bearer)", async () => {
  const { scriptEnv } = await import("../src/git/worktrees.js");
  const env = scriptEnv({ PATH: "/bin", HOME: "/Users/x", ALEVR_ENV_TOKEN: "secret", JUNO_X: "1" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/Users/x" });
});
