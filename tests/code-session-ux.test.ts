import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { groupTurns } from "@/lib/code-v2/turns";
import { editPlan, lastPrompt, retryPlan, retryTitle } from "@/lib/code-v2/answer-actions";
import { MAX_TEAM_BUDGET_USD, mergeCodePrefs, parseCodePrefsPatch, sanitizeCodePrefs, teamFromDefault } from "@/lib/code-v2/code-prefs";
import { withPreset } from "@/lib/code-v2/orchestrate";
import { codeSessionHits, conversationOfHref, messageMatches, queryTerms, snippetAround } from "@/lib/code-v2/palette-search";
import { SHARED_TRANSCRIPT_LIMITS, sanitizeSharedTranscript, transcriptFromTurns } from "@/lib/share-transcript";
import { isSettled, workList, type ThreadSummary } from "@/lib/code-v2/thread-sections";
import { settledByPullRequest, shellThreads } from "@/lib/code-v2/shell-threads";
import { DEFAULT_KEYBINDINGS, findConflicts, formatKey, resolveKeybinding } from "@/lib/code-v2/keymap";
import { initialModePair, landingMode } from "@/lib/code-v2/composer-mode";

const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 9, 0, s)).toISOString();

/** Three turns: the first changes a file and leaves a checkpoint, the second changes another, the third changes nothing. */
const thread: TurnItem[] = [
  { id: "u1", kind: "user_message", text: "Move the cart total", createdAt: at(0) },
  { id: "f1", kind: "file_change", callId: "f1", status: "completed", changes: [{ path: "src/cart.ts", change: "modify", additions: 3, deletions: 1 }], createdAt: at(4) },
  { id: "a1", kind: "assistant_message", text: "Moved the total into the footer.", streaming: false, createdAt: at(8) },
  { id: "cp1", kind: "checkpoint", checkpointId: "cp-1", turnOrdinal: 0, createdAt: at(9) },
  { id: "u2", kind: "user_message", text: "Now round it to cents", createdAt: at(20) },
  { id: "c2", kind: "command_execution", callId: "c2", command: "cat .env", status: "completed", exitCode: 0, output: "OPENAI_API_KEY=sk-live", createdAt: at(21) },
  { id: "f2", kind: "file_change", callId: "f2", status: "completed", changes: [{ path: "src/money.ts", change: "modify", additions: 2, deletions: 0 }], createdAt: at(22) },
  { id: "a2", kind: "assistant_message", text: "Rounded with Math.round on cents.", streaming: false, createdAt: at(25) },
  { id: "cp2", kind: "checkpoint", checkpointId: "cp-2", turnOrdinal: 1, createdAt: at(26) },
  { id: "u3", kind: "user_message", text: "What does the footer show now?", createdAt: at(40) },
  { id: "a3", kind: "assistant_message", text: "The rounded total.", streaming: false, createdAt: at(44) },
];

// ── Answer actions (G39) ─────────────────────────────────────────────────────

test("Retry is offered on the newest settled turn only, and says what it does to the files", () => {
  const turns = groupTurns(thread, { state: "idle" });
  const opts = { busy: false, canRollback: true };
  assert.equal(retryPlan(turns, 0, opts), null, "an older turn has no Retry");
  assert.equal(retryPlan(turns, 1, opts), null);
  const plain = retryPlan(turns, 2, opts);
  assert.equal(plain?.message.text, "What does the footer show now?");
  assert.equal(plain?.rollbackTo, undefined, "a turn that changed nothing sends again without a rollback");
  assert.equal(retryTitle(plain!), "Run the prompt again");

  // The newest turn changed a file: Retry first goes back to the checkpoint before it.
  const two = groupTurns(thread.slice(0, 9), { state: "idle" });
  const undo = retryPlan(two, 1, opts);
  assert.equal(undo?.rollbackTo, "cp-1");
  assert.equal(retryTitle(undo!), "Undo this turn's changes and run the prompt again");
  // Without a rollback the changes stay, and the tooltip says so.
  const keep = retryPlan(two, 1, { busy: false, canRollback: false });
  assert.equal(keep?.rollbackTo, undefined);
  assert.equal(keep?.keepsChanges, true);
  assert.equal(retryTitle(keep!), "Run the prompt again. This turn's changes stay");

  assert.equal(retryPlan(turns, 2, { busy: true, canRollback: true }), null, "nothing while a turn runs");
  const running = groupTurns(thread, { state: "running" });
  assert.equal(retryPlan(running, 2, opts), null, "the live turn has no Retry");
});

test("Edit and resend rolls back to the checkpoint before the turn, or straight to the composer when nothing changed", () => {
  const turns = groupTurns(thread, { state: "idle" });
  const opts = { busy: false, canRollback: true };
  const last = editPlan(turns, 2, opts);
  assert.deepEqual(last, { text: "What does the footer show now?", files: 0, turns: 0 }, "nothing to undo: no rollback, no confirm");
  const middle = editPlan(turns, 1, opts);
  assert.equal(middle?.rollbackTo, "cp-1");
  assert.equal(middle?.files, 1, "only money.ts changed from turn two on");
  assert.equal(middle?.turns, 2, "turns two and three go");
  assert.equal(editPlan(turns, 0, opts), null, "the first turn changed files and has no checkpoint before it");
  assert.equal(editPlan(turns, 1, { busy: false, canRollback: false }), null, "no rollback, no edit that would leave stale work");
  assert.equal(lastPrompt(turns)?.text, "What does the footer show now?");
  assert.equal(lastPrompt([]), null);
});

// ── Account Code defaults (G41) ──────────────────────────────────────────────

test("Code defaults: stored values are sanitized, patches are validated, null clears", () => {
  assert.deepEqual(sanitizeCodePrefs(null), {});
  assert.deepEqual(sanitizeCodePrefs([1, 2]), {});
  assert.deepEqual(
    sanitizeCodePrefs({ runtimeMode: "full", interactionMode: "plan", detailLevel: "steps", team: { preset: "best-of-n", maxUsd: 12.345 }, junk: true }),
    { runtimeMode: "full", interactionMode: "plan", detailLevel: "steps", team: { preset: "best-of-n", maxUsd: 12.35 } },
  );
  assert.deepEqual(sanitizeCodePrefs({ runtimeMode: "yolo", team: { preset: "mob" } }), {}, "unknown values are dropped, never kept");
  assert.deepEqual(sanitizeCodePrefs({ team: { preset: "solo", maxUsd: -1 } }), { team: { preset: "solo" } });

  assert.equal(parseCodePrefsPatch("x").ok, false);
  assert.equal(parseCodePrefsPatch({ runtimeMode: "yolo" }).ok, false);
  assert.equal(parseCodePrefsPatch({ colour: "red" }).ok, false, "an unknown key is an error, not ignored");
  const badBudget = parseCodePrefsPatch({ team: { preset: "best-of-n", maxUsd: MAX_TEAM_BUDGET_USD + 1 } });
  assert.equal(badBudget.ok, false);
  const ok = parseCodePrefsPatch({ runtimeMode: "ask", detailLevel: null });
  assert.ok(ok.ok);
  const merged = mergeCodePrefs({ runtimeMode: "full", detailLevel: "full", team: { preset: "best-of-n" } }, ok.ok ? ok.patch : {});
  assert.deepEqual(merged, { runtimeMode: "ask", team: { preset: "best-of-n" } });
});

test("a fresh thread's team from the account default: none for Solo, the preset and budget otherwise", () => {
  const lead = { instanceId: "alevr:default", model: "alevr-code" };
  assert.equal(teamFromDefault(undefined, lead, withPreset), null);
  assert.equal(teamFromDefault({ preset: "solo", maxUsd: 5 }, lead, withPreset), null);
  const team = teamFromDefault({ preset: "best-of-n", maxUsd: 7 }, lead, withPreset);
  assert.equal(team?.preset, "best-of-n");
  assert.deepEqual(team?.orchestrator, lead);
  assert.equal(team?.budget?.maxUsd, 7);
});

test("mode precedence: the thread's own, then the project's last, then the account's, then Accept edits", () => {
  const account = { runtimeMode: "read-only" as const, interactionMode: "plan" as const };
  assert.deepEqual(initialModePair({ runtimeMode: "full" }, { runtimeMode: "ask" }, account), { runtimeMode: "full", interactionMode: "default" });
  assert.deepEqual(initialModePair({}, { runtimeMode: "ask" }, account), { runtimeMode: "ask", interactionMode: "default" });
  assert.deepEqual(initialModePair({}, null, account), { runtimeMode: "read-only", interactionMode: "plan" });
  assert.deepEqual(initialModePair({}, null), { runtimeMode: "auto-edit", interactionMode: "default" });
  // The landing: the account default reaches a Mac session, never a cloud run (it names the Mac's ladder).
  assert.equal(landingMode("device", null, { runtimeMode: "read-only", interactionMode: "default" }), landingMode("device", { runtimeMode: "read-only" }));
  assert.equal(landingMode("cloud", null, { runtimeMode: "read-only", interactionMode: "default" }), "full");
  assert.equal(landingMode("device", { runtimeMode: "ask" }, { runtimeMode: "read-only" }), landingMode("device", { runtimeMode: "ask" }), "the project's last wins");
});

// ── Palette message search ───────────────────────────────────────────────────

test("palette: the open thread's messages match on every term, newest first, each pointing at its turn", () => {
  assert.deepEqual(queryTerms("  Cart   TOTAL "), ["cart", "total"]);
  assert.deepEqual(messageMatches(thread, "t"), [], "one letter searches nothing");
  const found = messageMatches(thread, "footer total");
  assert.deepEqual(found.map((m) => [m.turnId, m.who]), [["u1", "alevr"]], "the answer in turn one, not the question in turn three (no 'total')");
  const footer = messageMatches(thread, "footer");
  assert.deepEqual(footer.map((m) => m.turnId), ["u3", "u1"], "newest turn first");
  assert.equal(footer[0].who, "you");
  assert.deepEqual(messageMatches(thread, "OPENAI_API_KEY"), [], "the work log (command output) is not searched");
  // A subagent's words are not the thread's.
  const withAgent: TurnItem[] = [...thread, { id: "x", kind: "assistant_message", agentId: "ag1", text: "footer audit", streaming: false, createdAt: at(50) }];
  assert.equal(messageMatches(withAgent, "audit").length, 0);
});

test("palette: snippets cut at word edges around the first term", () => {
  const long = `${"alpha ".repeat(30)}the needle sits here ${"omega ".repeat(30)}`;
  const s = snippetAround(long, ["needle"], 60);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("needle"));
  assert.ok(s.length <= 62);
  assert.equal(snippetAround("short  text", ["text"]), "short text");
});

test("palette: unified-search hits narrowed to other Code sessions", () => {
  assert.equal(conversationOfHref("/chat/abc?m=1"), "abc");
  assert.equal(conversationOfHref("/code/x%20y"), "x y");
  assert.equal(conversationOfHref("/library"), null);
  const hits = [
    { id: "message:1", type: "message", href: "/chat/c1?m=1", snippet: { text: "rounded  to cents" }, title: "Cart" },
    { id: "message:2", type: "message", href: "/chat/open?m=2", snippet: { text: "here" }, title: "Open" },
    { id: "message:3", type: "message", href: "/chat/chat9?m=3", snippet: { text: "a chat" }, title: "Chat" },
    { id: "chat:4", type: "chat", href: "/chat/c1", snippet: null, title: "Cart" },
  ];
  const out = codeSessionHits(hits, new Map([["c1", "Cart session"], ["open", "Open one"]]), "open");
  assert.deepEqual(out, [{ id: "s:message:1", threadId: "c1", threadTitle: "Cart session", snippet: "rounded to cents" }]);
});

// ── Share a Mac session (G40) ────────────────────────────────────────────────

test("share transcript: messages and final answers only, never the work log or a subagent", () => {
  // A steer and a subagent's message inside the last turn, before its answer.
  const items: TurnItem[] = [
    ...thread.slice(0, -1),
    { id: "s1", kind: "user_message", text: "and keep the currency sign", delivery: "steer", createdAt: at(41) },
    { id: "sa", kind: "assistant_message", agentId: "ag1", text: "worker notes", streaming: false, createdAt: at(42) },
    thread[thread.length - 1],
  ];
  const entries = transcriptFromTurns(items);
  assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "assistant", "user", "user", "assistant"]);
  const text = entries.map((e) => e.content).join("\n");
  assert.ok(!text.includes("cat .env") && !text.includes("OPENAI_API_KEY"), "no command or output");
  assert.ok(!text.includes("worker notes"), "no subagent words");
  assert.ok(text.includes("and keep the currency sign"), "a steer is the person speaking");
});

test("share transcript: the server re-checks, bounds and redacts what a client sends", () => {
  assert.equal(sanitizeSharedTranscript("nope").ok, false);
  assert.equal(sanitizeSharedTranscript([{ role: "system", content: "x" }]).ok, false);
  assert.equal(sanitizeSharedTranscript([{ role: "assistant", content: "only an answer" }]).ok, false, "nothing the person said: nothing to share");
  const tooMany = Array.from({ length: SHARED_TRANSCRIPT_LIMITS.maxEntries + 1 }, () => ({ role: "user", content: "x" }));
  assert.equal(sanitizeSharedTranscript(tooMany).ok, false);
  assert.equal(sanitizeSharedTranscript([{ role: "user", content: "x".repeat(SHARED_TRANSCRIPT_LIMITS.maxEntryChars + 1) }]).ok, false);
  const key = `sk-ant-${"a".repeat(30)}`;
  const checked = sanitizeSharedTranscript([
    { role: "user", content: `use ${key} please` },
    { role: "assistant", content: "   " },
    { role: "assistant", content: "Done." },
  ]);
  assert.ok(checked.ok);
  if (!checked.ok) return;
  assert.equal(checked.entries.length, 2, "blank entries are dropped");
  assert.ok(!checked.entries[0].content.includes(key), "a key never reaches the public page");
  assert.equal(checked.redacted, 1);
});

// ── Pin and settle in the work list (G40) ────────────────────────────────────

test("pinned sessions sit above idle ones, below working and waiting ones, and never fold away", () => {
  const now = Date.parse(at(0)) + 30 * 24 * 3600_000;
  const row = (id: string, state: ThreadSummary["state"], extra: Partial<ThreadSummary> = {}): ThreadSummary => ({ id, title: id, project: "shop", state, updatedAt: at(Number(id.replace(/\D/g, "")) || 0), ...extra });
  const threads = [row("idle9", "idle"), row("old1", "idle", { pinned: true }), row("run2", "running"), row("wait3", "waiting"), row("done4", "idle", { settled: true, pinned: true })];
  const list = workList(threads, { now });
  assert.deepEqual(list.active.map((t) => t.id), ["wait3", "run2", "done4", "old1"]);
  assert.deepEqual(list.settled.map((t) => t.id), ["idle9"], "a month-old idle session folds; a pinned one does not");
  assert.equal(isSettled(row("p", "idle", { pinned: true, settled: true }), now), false);
});

test("a session settles by itself once its newest run's pull request merged, unless it moved since", () => {
  const conversations = [
    { id: "merged", title: "Merged", kind: "code", lastMessageAt: at(10) },
    { id: "later", title: "Worked on after", kind: "code", lastMessageAt: at(500) },
    { id: "open", title: "Open PR", kind: "code", lastMessageAt: at(10) },
    { id: "chat", title: "A chat", kind: "chat", lastMessageAt: at(10) },
  ];
  const newest = new Map([
    ["merged", { updatedAt: at(20), pr: "done" }],
    ["later", { updatedAt: at(20), pr: "done" }],
    ["open", { updatedAt: at(20), pr: "open" }],
  ]);
  const settled = settledByPullRequest(conversations, newest, (run) => run.pr === "done");
  assert.deepEqual([...settled], ["merged"]);
  const rows = shellThreads(conversations, new Map(), new Map(), settled);
  assert.deepEqual(rows.map((r) => [r.id, !!r.settled]), [["merged", true], ["later", false], ["open", false]], "chats are not Code rows");
  // A session that starts working again is in view whatever its pull request says.
  const live = shellThreads(conversations, new Map(), new Map([["merged", { state: "running" as const }]]), settled);
  assert.equal(isSettled(live[0]), false);
});

// ── One stray Escape never denies (UX) ───────────────────────────────────────

test("Esc never answers an approval; ⌘⌫ denies, and not while typing", () => {
  const ctx = { approvalOpen: true };
  assert.equal(resolveKeybinding({ key: "Escape" }, ctx), null);
  assert.equal(resolveKeybinding({ key: "Backspace", metaKey: true }, ctx), "approval.deny");
  assert.equal(resolveKeybinding({ key: "Backspace", ctrlKey: true }, ctx, DEFAULT_KEYBINDINGS, false), "approval.deny");
  assert.equal(resolveKeybinding({ key: "Backspace", metaKey: true }, { ...ctx, editableFocus: true }), null, "⌘⌫ in a field deletes text");
  assert.equal(resolveKeybinding({ key: "Backspace" }, ctx), null, "a bare Backspace is not a denial");
  assert.equal(formatKey("mod+backspace", true), "⌘⌫");
  assert.equal(formatKey("mod+backspace", false), "Ctrl+Backspace");
  assert.deepEqual(findConflicts(DEFAULT_KEYBINDINGS), []);
});
