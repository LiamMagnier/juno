import assert from "node:assert/strict";
import { teamSummary } from "@/lib/code-v2/team";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodeWorkspace } from "@/components/code/v2/workspace";
import { ConnectionsPanel } from "@/components/code/v2/connections";
import { cycleEffort, cycleRuntimeMode, currentTier, ratesFor, shortLabel } from "@/components/code/v2/model-info";
import { listWords } from "@/components/code/v2/pickers";
import { filesFrom, latestAgents, visibleTabs } from "@/components/code/v2/dock";
import { pendingRequests } from "@/components/code/v2/composer";
import { offlineReply, parseLinkRequest } from "@/lib/code-v2/device-link";
import { buildInstances, reconcileSelection } from "@/lib/code-v2/workspace-instances";
import { codeProviderModels } from "@/lib/code-v2/code-models";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { DEVICE, INSTANCES, STATES, makeActions } from "../src/app/dev/code-v2/fixtures";

// Some shared brand components use the classic JSX runtime (React in scope); tsx does not inject it.
(globalThis as unknown as { React: typeof React }).React = React;

const actions = makeActions(() => undefined);
const fixture = (id: string) => {
  const s = STATES.find((x) => x.id === id);
  assert.ok(s, id);
  return { ...s, model: { ...s.model, actions } };
};

// ── Device link relay ─────────────────────────────────────────────────────

test("link requests: rpc commands are validated and env.configure never leaves the Mac", () => {
  const ok = parseLinkRequest({ kind: "rpc", command: { id: "c1", type: "provider.list", params: {} } });
  assert.ok(ok.ok);
  assert.equal(parseLinkRequest({ kind: "rpc", command: { id: "c1", type: "rm -rf", params: {} } }).ok, false);
  assert.equal(parseLinkRequest({ kind: "rpc", command: { id: "", type: "provider.list", params: {} } }).ok, false);
  const local = parseLinkRequest({ kind: "rpc", command: { id: "c2", type: "env.configure", params: {} } });
  assert.ok(!local.ok && local.status === 403);
  assert.equal(parseLinkRequest(null).ok, false);
  assert.equal(parseLinkRequest({ kind: "nope" }).ok, false);
});

test("link polls: cursors must be integers, the global cursor defaults to -1", () => {
  const p = parseLinkRequest({ kind: "poll", cursors: { s1: 4, s2: -1 } });
  assert.ok(p.ok && p.request.kind === "poll");
  if (p.ok && p.request.kind === "poll") {
    assert.deepEqual(p.request.cursors, { s1: 4, s2: -1 });
    assert.equal(p.request.globalCursor, -1);
  }
  assert.equal(parseLinkRequest({ kind: "poll", cursors: { s1: 1.5 } }).ok, false);
  assert.equal(parseLinkRequest({ kind: "poll", cursors: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, 0])) }).ok, false);
});

test("link offline reply names the computer", () => {
  assert.equal(offlineReply("Maya's Mac").offline, true);
  assert.match(offlineReply("Maya's Mac").message ?? "", /Maya's Mac/);
});

// ── Instances for the rail ────────────────────────────────────────────────

test("instances: Alevr first, Mac subscriptions next (its own alevr/byok rows dropped), then one row per stored key", () => {
  const alevrModels = codeProviderModels();
  const list = buildInstances({
    alevrModels,
    deviceInstances: [
      { id: "alevr", kind: "alevr", label: "dup", status: "ready" },
      { id: "claude-agent:default", kind: "claude-agent", label: "Claude", status: "ready" },
      { id: "byok:openai", kind: "byok", label: "dup", status: "ready" },
    ],
    byokKeys: [{ provider: "anthropic", hint: "…4f2a", addedAt: "2026-10-01T00:00:00Z" }, { provider: "openai", hint: "…aaaa", addedAt: "2026-10-01T00:00:00Z", invalid: true, detail: "revoked" }],
  });
  assert.deepEqual(
    list.map((i) => i.id),
    ["alevr", "claude-agent:default", "byok:anthropic", "byok:openai"],
  );
  assert.ok(list[2].models?.every((m) => m.id.startsWith("anthropic:")));
  assert.equal(list[3].status, "error");
  assert.equal(list[3].statusMessage, "revoked");
});

test("selection: a stale choice falls back to the first usable default", () => {
  const sel = reconcileSelection(INSTANCES, { instanceId: "codex:default", model: "gone" });
  assert.equal(sel.instanceId, "alevr");
  assert.ok(sel.model);
  const kept = reconcileSelection(INSTANCES, { instanceId: "codex:default", model: "gpt-6.1-sol" });
  assert.equal(kept.model, "gpt-6.1-sol");
});

// ── Model info ─────────────────────────────────────────────────────────────

test("effort cycles through the model's levels and wraps; permissions cycle within what the runtime enforces", () => {
  const sel = { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" as const };
  assert.equal(cycleEffort(INSTANCES, sel).effort, "max");
  assert.equal(cycleEffort(INSTANCES, { ...sel, effort: "max" }).effort, "low");
  assert.equal(cycleRuntimeMode("auto-edit"), "auto");
  assert.equal(cycleRuntimeMode("full"), "read-only");
  assert.equal(cycleRuntimeMode("auto", ["ask", "auto-edit", "auto"]), "ask");
  assert.equal(shortLabel(INSTANCES, sel), "Opus 5.5");
});

test("tiers and rates: the chosen tier wins, subscriptions cost nothing to Alevr", () => {
  const sel = { instanceId: "claude-agent:default", model: "claude-opus-5-5", contextTokens: 1_000_000 };
  assert.equal(currentTier(INSTANCES, sel)?.tokens, 1_000_000);
  assert.equal(currentTier(INSTANCES, { ...sel, contextTokens: undefined })?.tokens, 200_000);
  const rates = ratesFor(INSTANCES);
  assert.equal(rates(sel), undefined);
  const alevr = INSTANCES[0].models![0];
  assert.ok(rates({ instanceId: "alevr", model: alevr.id })!.inputPerMTok > 0);
  assert.equal(listWords(["Claude", "ChatGPT", "DeepSeek Harness"]), "Claude, ChatGPT and DeepSeek Harness");
  assert.equal(listWords(["Claude"]), "Claude");
});

// ── Dock helpers ───────────────────────────────────────────────────────────

test("dock: tabs appear with their content, agents fold to their newest state, diffs parse to hunks", () => {
  const streaming = fixture("streaming").model;
  // One tab strip: Changes, Terminal, Files, and only when relevant Preview, Agents, Screen (the plan lives in the thread).
  assert.deepEqual(visibleTabs(streaming), ["changes", "terminal", "files"]);
  assert.deepEqual(visibleTabs({ ...streaming, previewUrl: "http://localhost:3000" }), ["changes", "terminal", "files", "preview"]);
  const needs = fixture("needs-you").model;
  assert.ok(visibleTabs(needs).includes("agents") && !visibleTabs(needs).includes("plan"));
  const items: TurnItem[] = [
    { id: "a", kind: "subagent", agentId: "w1", role: "worker", model: { instanceId: "alevr", model: "m" }, status: "running", createdAt: "t" },
    { id: "b", kind: "subagent", agentId: "w1", role: "worker", model: { instanceId: "alevr", model: "m" }, status: "completed", createdAt: "t" },
  ];
  assert.equal(latestAgents(items).length, 1);
  assert.equal(latestAgents(items)[0].status, "completed");
  const files = filesFrom([{ path: "a.ts", change: "modify", diff: "@@ -1,1 +1,2 @@\n a\n+b\n" }, { path: "b.ts", change: "add", additions: 3 }]);
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[1].hunks.length, 0);
  assert.equal(files[1].additions, 3);
});

test("pending requests are approvals and questions still waiting", () => {
  const needs = fixture("needs-you").model;
  assert.equal(pendingRequests(needs.items).length, 1);
  assert.equal(pendingRequests(fixture("streaming").model.items).length, 0);
});

// ── Rendering every gallery state ─────────────────────────────────────────

const PILL = /\b(badge|pill|status-dot|rounded-full bg-(green|red|yellow|emerald))\b/;

for (const s of STATES) {
  test(`renders the ${s.id} state without pills, with at most two weights`, () => {
    const f = fixture(s.id);
    const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
    if (!f.ui?.settings) assert.ok(html.includes(f.model.thread.title));
    assert.doesNotMatch(html, PILL);
    assert.doesNotMatch(html, /font-weight:\s*[6-9]00/);
    assert.doesNotMatch(html, /Claude Code/);
  });
}

test("the needs-you state takes the composer over with the asker and the three decisions", () => {
  const f = fixture("needs-you");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
  assert.match(html, /Worker 3 wants to run a command/);
  assert.match(html, /Allow once/);
  assert.match(html, /Allow for this session/);
  assert.match(html, /Deny/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /cv2-composer needs/);
  assert.doesNotMatch(html, /Queue a follow-up/);
});

test("the limited state offers Resume at reset and Switch model, in the composer and not in coral", () => {
  const f = fixture("limited");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
  assert.match(html, /Claude plan limit reached, resets/);
  assert.match(html, /Resume at reset/);
  assert.match(html, /Switch model/);
  assert.match(html, /cv2-approve neutral/);
  assert.doesNotMatch(html, /cv2-composer needs/);
});

test("the streaming state is calm: no glow, a stop button, the queue as one control, the live row with its clock", () => {
  const f = fixture("streaming");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
  assert.match(html, /class="cv2-composer" data-state="running"/);
  assert.doesNotMatch(html, /cv2-glow|cv2-composer working|cv2-composer needs/);
  assert.match(html, /data-mode="stop"/);
  assert.match(html, /Queued \(1\)/);
  assert.match(html, /Running<\/span>/);
  assert.match(html, /Changed 3 files/);
});

test("the composer at rest shows +, the model trigger, the Team chip, the mode, the options menu, the mic and send", () => {
  const f = fixture("model-picker");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: { ...f.model }, ui: {} }));
  const foot = html.slice(html.indexOf('class="cv2-cfoot"'), html.indexOf('class="cv2-strip"'));
  assert.match(foot, /aria-label="Add"/);
  assert.match(foot, /aria-label="Model: Opus 5\.5, High"/);
  assert.match(foot, /aria-label="Mode: Accept edits"/);
  assert.match(foot, /aria-label="More options"/);
  assert.match(foot, /aria-label="Dictate"/);
  // Team lane: the Team chip is always there; Solo shows nothing extra.
  assert.match(foot, /aria-label="Team"/);
  assert.doesNotMatch(foot, /Lead \+|Best of|Auto-edit|>Plan</);
  const team = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: { ...f.model, interactionMode: "plan", routing: fixture("needs-you").model.routing }, ui: {} }));
  assert.ok(team.includes(`aria-label="Team: ${teamSummary(fixture("needs-you").model.routing)}"`), "the chip names the team");
  assert.match(team, /aria-label="Mode: Plan"/);
  const full = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: { ...f.model, runtimeMode: "full" }, ui: {} }));
  assert.match(full, /aria-label="Mode: Full access"/);
});

test("the sidebar is a list of work: needs you first, then working, project and branch under each title, the rest settled", () => {
  const f = fixture("streaming");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: {} }));
  const side = html.slice(html.indexOf('class="cv2-side"'), html.indexOf("</nav>"));
  const order = [...side.matchAll(/truncate text-nav[^"]*">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 2), ["Cart total regression suite", "Move checkout totals to the server"]);
  assert.match(side, /All projects/);
  assert.match(side, /Settled · 3/);
  assert.match(side, /aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Settled/, "Settled is a folded Section heading");
  // The Chat column's recipes, not a second sidebar's.
  assert.match(side, /sidebar-row-selected/);
  assert.match(side, /shell-annot/);
  assert.doesNotMatch(side, /cv2-th|cv2-settled|cv2-filter|cv2-switch|cv2-avatar/);
  assert.match(side, /#7723/);
  assert.match(side, /alevr\/server-totals/);
  assert.doesNotMatch(side, /Upgrade to React 20/, "settled sessions stay folded");
  assert.doesNotMatch(side, /Pull requests|Connections/, "destinations moved to the palette and Settings");
});

test("Connections names subscriptions by the owner's rules and lists Antigravity as a normal provider", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE }));
  assert.match(html, /Claude \(your subscription\)/);
  assert.match(html, /ChatGPT \(Codex\)/);
  assert.match(html, /Sign-in expired/);
  assert.match(html, /Not installed/);
  assert.doesNotMatch(html, /cv2-meter|progress/, "usage is a number, never a bar");
  assert.match(renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE, initialSelected: "acp:grok" })), /Sign in again/);
  assert.match(renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE, initialSelected: "acp:opencode" })), />Install</);
  // Enabled by the owner on 2026-10-09: listed like every other runtime, never as held.
  assert.doesNotMatch(html, /Not available yet/);
  const withAntigravity = renderToStaticMarkup(
    React.createElement(ConnectionsPanel, {
      instances: [...INSTANCES.filter((i) => i.id !== "acp:antigravity"), { id: "acp:antigravity", kind: "acp", label: "Antigravity", acpCommand: ["antigravity-acp"], status: "not-installed", install: { phase: "idle", version: "1.3.0" } }],
      device: DEVICE,
      initialSelected: "acp:antigravity",
    }),
  );
  assert.match(withAntigravity, /Antigravity<\/span>.*?<p class="cv2-ds"[^>]*>Not installed\. Alevr downloads Google&#x27;s official runtime/);
  assert.match(html, /Antigravity/);
  assert.doesNotMatch(html, /Claude Code/);
  const offline = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: [], device: null }));
  assert.match(offline, /Download for Mac/);
  assert.match(offline, /aria-disabled="true"/);
});

test("the model chip opens slider-first: the chat's effort panel, the model's name leading to the catalogue; the catalogue on its own keeps context and usage", () => {
  const f = fixture("model-picker");
  const effort = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: { popover: "model" } }));
  assert.match(effort, /aria-label="Thinking effort"/);
  assert.match(effort, /aria-label="Reset to the model&#x27;s default"/);
  assert.doesNotMatch(effort, /aria-label="Search models"/);
  const catalog = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: { popover: "catalog" } }));
  assert.match(catalog, /aria-label="Search models"/);
  assert.match(catalog, />Context</);
  assert.doesNotMatch(catalog, /aria-label="Thinking effort"/);
  assert.doesNotMatch(catalog, /id="picker-effort-lead"/, "effort lives on the panel, not the catalogue footer");
});
