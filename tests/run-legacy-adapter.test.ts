import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildLegacyRunView, canonicalToolId, humaniseToolName } from "@/lib/run/legacy";
import { buildRunView } from "@/lib/run/timeline";
import type { ClientActivityEvent } from "@/types/chat";

import { turnScript } from "./fixtures/turn-scripts";

/*
 * Messages persisted before the rework are rendered, never backfilled
 * (INV-20, SPEC §7.7). Production rows cannot be captured offline, so the
 * fixtures are rows exactly as the emitters at d0997af2 wrote them:
 * `createToolActivity` (route.ts:379-423: "Using {server}" opened with the
 * namespaced name, closed with the tool detail; task rows "Starting a task" →
 * "Started a task" / "Task not started"), "Preparing web search"
 * (:2762-2767), `requestApproval`'s "… needs approval" rows (:2896-2908) and
 * one "Visited source" row per provider source (:3028-3037).
 */

let n = 0;
/** A row as `createSseSender` stamped it: an id and a time, no seq. */
function legacy(row: Omit<ClientActivityEvent, "id" | "createdAt">, second: number): ClientActivityEvent {
  n += 1;
  return { ...row, id: `activity-${n}`, createdAt: `2026-09-20T09:14:${String(second).padStart(2, "0")}.000Z` };
}

test("fixture 19: the gallery's legacy row reads as the old turn did", () => {
  const record = turnScript(19).legacy!;
  const view = buildRunView({ ...record, reasoningParts: null, sources: [] });
  assert.equal(view.typed, false);
  // "Preparing web search" ran nothing; the approval row's outcome is unknown; visits feed sources only.
  assert.deepEqual(
    view.items.map((item) => (item.kind === "tool" ? `${item.call.tool}:${item.call.status}` : item.kind)),
    ["provider_web_search:succeeded", "mcp:succeeded", "mcp:succeeded"],
  );
  const [search, list, create] = view.tools;
  assert.deepEqual(search.call.args, { query: "node 24 fetch ENOTFOUND pinned lookup" });
  assert.equal(list.call.connectorLabel, "GitHub");
  assert.equal(list.call.toolTitle, "List issues");
  assert.equal(list.call.durationMs, 1_100);
  assert.equal(create.call.toolTitle, "Create issue");
  assert.ok(create.detail?.args?.includes("juno/web"), "the stored tool detail rides along for the panel");
  assert.equal(view.counts.sources, 1, "the visit row's URL");
  assert.deepEqual(view.counts.connectorsUsed, ["GitHub"]);
  assert.equal(view.timing.startedAt, Date.parse("2026-09-20T09:14:10.000Z"));
  assert.equal(view.timing.firstAnswerAt, Date.parse("2026-09-20T09:14:12.000Z"));
  assert.equal(view.timing.endedAt, Date.parse("2026-09-20T09:14:18.000Z"));
  // Until the first text, plus the two calls after it: opened at :13 and :14, measured 1.1 s and
  // 0.64 s, so their union is 1.64 s. A call with no measured duration adds nothing.
  assert.equal(view.timing.workedMs, 2_000 + 1_640);
  // Glued content is left as it is: the adapter never infers commentary.
  assert.equal(view.items.some((item) => item.kind === "commentary"), false);
});

test("reasoning comes first: one item, or one per stored part", () => {
  const rows = [legacy({ kind: "write", title: "Writing the answer" }, 12)];
  const whole = buildLegacyRunView({ activity: rows, reasoning: "Thinking it through.", reasoningParts: null, sources: [], content: "x" });
  assert.deepEqual(whole.items.map((item) => item.kind), ["reasoning"]);
  const parts = buildLegacyRunView({
    activity: rows,
    reasoning: "**A**\n\nOne.\n\n**B**\n\nTwo.",
    reasoningParts: ["**A**\n\nOne.", "  ", "**B**\n\nTwo."],
    sources: [],
    content: "x",
  });
  assert.deepEqual(
    parts.items.map((item) => item.kind === "reasoning" && [item.part, item.text, item.live]),
    [[0, "**A**\n\nOne.", false], [1, "**B**\n\nTwo.", true]],
  );
  assert.equal(parts.hasReasoning, true);
});

test("tool rows: status from tool.status or resultNote, aliases applied", () => {
  const rows = [
    legacy({ kind: "tool", title: "Using Juno", detail: "code_interpreter", tool: { server: "Juno", name: "code_interpreter", status: "ok", durationMs: 4_000 } }, 1),
    legacy({ kind: "tool", title: "Using Juno", detail: "browser_agent", tool: { server: "Juno", name: "browser_agent", status: "failed" } }, 2),
    legacy({ kind: "tool", title: "Using Linear", detail: "linear__create_issue", tool: { server: "Linear", name: "linear__create_issue", resultNote: "unfinished" } }, 3),
    legacy({ kind: "tool", title: "Using Linear", detail: "linear__search", tool: { server: "Linear", name: "linear__search", resultNote: "pending" } }, 4),
    // Lockdown: detail disabled, so the row carries no `tool` and no call can be recovered.
    legacy({ kind: "tool", title: "Using Notion", detail: "notion__search" }, 5),
    legacy({ kind: "tool", title: "Connected tools ready", detail: "GitHub · Linear" }, 6),
  ];
  const view = buildLegacyRunView({ activity: rows, reasoning: null, reasoningParts: null, sources: [], content: "" });
  assert.deepEqual(
    view.tools.map(({ call }) => [call.tool, call.origin, call.status]),
    [
      ["run_code", "juno", "succeeded"],
      ["web_fetch", "juno", "failed"],
      ["mcp", "connector", "cancelled"],
      ["mcp", "connector", "cancelled"],
    ],
  );
  assert.equal(view.tools[0].call.durationMs, 4_000);
  assert.equal(view.counts.codeRuns, 1);
  assert.equal(view.counts.failedTools, 1);
  assert.equal(view.tools[2].call.connectorLabel, "Linear");
});

test("approval rows are dropped; task rows become start_task items", () => {
  const rows = [
    legacy({ kind: "tool", title: "GitHub needs approval", detail: "Create issue in juno/web" }, 1),
    legacy({ kind: "tool", title: "Starting a task needs your approval", detail: "Audit the repo" }, 2),
    legacy({ kind: "tool", title: "Started a task", detail: "Audit the repo" }, 3),
    legacy({ kind: "tool", title: "Task not started", detail: "Rewrite the docs" }, 4),
  ];
  const view = buildLegacyRunView({ activity: rows, reasoning: null, reasoningParts: null, sources: [], content: "" });
  assert.deepEqual(
    view.tools.map(({ call }) => [call.tool, call.status, call.args?.title]),
    [
      ["start_task", "succeeded", "Audit the repo"],
      ["start_task", "failed", "Rewrite the docs"],
    ],
  );
});

test("warnings become notices with their legacy title; artifacts and the rest are ignored", () => {
  const rows = [
    legacy({ kind: "warning", title: "Research degraded", detail: "Two engines failed" }, 1),
    legacy({ kind: "artifact", title: "Created artifact" }, 2),
    legacy({ kind: "model", title: "Selected model", detail: "Claude" }, 3),
    legacy({ kind: "context", title: "Research corpus ready" }, 4),
    legacy({ kind: "search", title: "Preparing web search", detail: "Claude web search" }, 5),
    legacy({ kind: "visit", title: "Visited source", url: "https://a.example/x" }, 6),
    legacy({ kind: "visit", title: "Visited source", url: "https://a.example/x" }, 7),
  ];
  const view = buildLegacyRunView({ activity: rows, reasoning: null, reasoningParts: null, sources: [], content: "" });
  assert.deepEqual(view.items.map((item) => item.kind), ["notice"]);
  const notice = view.items[0];
  assert.equal(notice.kind === "notice" && notice.notice, null);
  assert.equal(notice.kind === "notice" && notice.legacyTitle, "Research degraded");
  assert.equal(notice.kind === "notice" && notice.legacyDetail, "Two engines failed");
  assert.equal(view.counts.warnings, 1);
  assert.equal(view.counts.sources, 1, "visits de-duplicated by URL");
});

test("canonical ids and humanised names", () => {
  assert.equal(canonicalToolId({ name: "github__create_issue" }), "mcp");
  assert.equal(canonicalToolId({ name: "code_interpreter" }), "run_code");
  assert.equal(canonicalToolId({ name: "browser_agent" }), "web_fetch");
  assert.equal(canonicalToolId({ name: "web_search" }), "web_search");
  assert.equal(canonicalToolId({ name: "some_unknown_tool" }), "mcp", "never a raw id in the UI");
  assert.equal(humaniseToolName("github__create_issue"), "Create issue");
  assert.equal(humaniseToolName("a__b__list-open-prs"), "List open prs");
});

test("title matching lives only in the legacy adapter (INV-28)", () => {
  const offenders: string[] = [];
  for (const dir of ["src/components/chat/run", "src/components/chat/panel", "src/lib/run"]) {
    let files: string[] = [];
    try {
      files = readdirSync(path.join(process.cwd(), dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file === "legacy.ts") continue;
      const source = readFileSync(path.join(process.cwd(), dir, file), "utf8");
      if (/\.title\s*\.\s*(?:startsWith|endsWith)\(|\.title\s*===\s*["']/.test(source)) offenders.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(offenders, []);
  const eslint = readFileSync(path.join(process.cwd(), "eslint.config.mjs"), "utf8");
  assert.match(eslint, /src\/components\/chat\/run\/\*\*/);
  assert.match(eslint, /src\/components\/chat\/panel\/\*\*/);
  assert.match(eslint, /no-restricted-syntax/);
});
