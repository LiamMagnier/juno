import assert from "node:assert/strict";
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
  assert.deepEqual(visibleTabs(streaming), ["changes", "terminal", "files", "preview"]);
  const needs = fixture("needs-you").model;
  assert.ok(visibleTabs(needs).includes("agents") && visibleTabs(needs).includes("plan"));
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
    const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui, userName: "Maya Okafor" }));
    assert.ok(html.includes(f.model.thread.title));
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

test("the limited state offers Resume at reset and Switch model, without the working glow", () => {
  const f = fixture("limited");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
  assert.match(html, /Claude plan limit reached\. Resets at/);
  assert.match(html, /Resume at reset/);
  assert.match(html, /Switch model/);
  assert.doesNotMatch(html, /cv2-composer working/);
});

test("the streaming state glows, offers Stop and lists the queued follow-up with Steer now", () => {
  const f = fixture("streaming");
  const html = renderToStaticMarkup(React.createElement(CodeWorkspace, { model: f.model, ui: f.ui }));
  assert.match(html, /cv2-composer working/);
  assert.match(html, /data-mode="stop"/);
  assert.match(html, /Steer now/);
  assert.match(html, /Also update the README/);
  assert.match(html, /Changed 3 files/);
});

test("Connections names subscriptions by the owner's rules and lists Antigravity as held behind its flag", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE }));
  assert.match(html, /Claude \(your subscription\)/);
  assert.match(html, /ChatGPT \(Codex\)/);
  assert.match(html, /Sign in again/);
  assert.match(html, /Install/);
  // Listed honestly while its terms check is open: no action, no status, a plain sentence.
  assert.match(html, /Antigravity<\/div><div class="ds"[^>]*>Not available yet\./);
  const enabled = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE, flags: { "providers.antigravity": true } }));
  assert.doesNotMatch(enabled, /Not available yet/);
  assert.doesNotMatch(html, /Claude Code/);
  const offline = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: [], device: null }));
  assert.match(offline, /Download for Mac/);
  assert.match(offline, /aria-disabled="true"/);
});
