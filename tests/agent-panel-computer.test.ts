/**
 * The agent's profile says why it has no computer instead of hiding the
 * section (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.8, fact 7), offers
 * the policy only when the account may use it, and calls the button that
 * deletes the computer "Delete computer".
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProfile } from "@/components/agents/agent-panel";
import type { ClientAgent, ClientAgentDetail } from "@/lib/agents/types";

// tsx compiles the components' JSX with the classic runtime, which reads a global React.
(globalThis as { React?: typeof React }).React = React;


const AGENT = {
  id: "agent_mira",
  name: "Mira",
  role: "Research",
  avatar: { shape: "orb", tone: "sky", eyes: "soft", mark: "ring" },
  style: "warm",
  instructions: "",
  model: null,
  reasoningEffort: null,
  approvalMode: "balanced",
  connectorIds: [],
  projectId: null,
  conversationId: "conv_1",
  status: "active",
  proactive: false,
  notify: "results",
  pinnedAt: null,
  template: null,
  lastReflectedAt: null,
  sortOrder: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: "idle",
  stateSentence: "Ready",
  task: null,
  needsYou: 0,
  nextRoutine: null,
  newIdeas: 0,
  computer: null,
  executionTarget: "cloud",
  computerPolicy: "ask",
} as unknown as ClientAgent;

function detail(extra: Partial<ClientAgentDetail>): ClientAgentDetail {
  return { agent: AGENT, goals: [], ideas: [], notes: [], routines: [], tasks: [], ...extra } as ClientAgentDetail;
}

const render = (d: ClientAgentDetail) => renderToStaticMarkup(React.createElement(AgentProfile, { detail: d, onChanged: () => {} }));

test("computers off on this server: the section says so in one line", () => {
  const html = render(
    detail({
      computer: null,
      computerConfigured: false,
      computerAccess: { ok: false, reason: "server_off", message: "Computers aren’t available on this server.", upgradePlan: null },
    }),
  );
  assert.match(html, /What it can use/);
  assert.match(html, /Computers aren’t available on this server\./);
  assert.doesNotMatch(html, /Give it one|Ask first|On its own/, "nothing to turn on");
});

test("not in the plan: the sentence and the way to the plans", () => {
  const html = render(
    detail({
      computerConfigured: true,
      computerAccess: { ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO" },
    }),
  );
  assert.match(html, /Computers come with Pro and above\./);
  assert.match(html, /href="\/upgrade"/);
  assert.doesNotMatch(html, /Give it one|Ask first/);
});

test("lost access with a computer still there: it can be deleted, never woken", () => {
  const html = render(
    detail({
      computerConfigured: true,
      computer: { enabled: true, status: "asleep", streamOn: false, lastActiveAt: null, activeSeconds: 0, hasPoster: false, usingNow: null, error: null },
      computerAccess: { ok: false, reason: "not_in_rollout", message: "Computers are in early access and aren’t open to your account.", upgradePlan: null },
    }),
  );
  assert.match(html, /early access/);
  assert.match(html, />Delete computer</);
  assert.doesNotMatch(html, />Turn off</, "the button says what it does");
});

test("open: the policy control, the status line, Open and Delete computer", () => {
  const html = render(
    detail({
      computerConfigured: true,
      computer: { enabled: true, status: "resting", streamOn: false, lastActiveAt: null, activeSeconds: 0, hasPoster: false, usingNow: null, error: null },
      computerAccess: { ok: true, reason: null, message: null, upgradePlan: null },
    }),
  );
  for (const label of ["Off", "Ask first", "On its own"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /Resting\. Opens instantly\./);
  assert.match(html, />Delete computer</);
  assert.doesNotMatch(html, />Turn off</);
});

test("open with no computer yet: what the policy means, and Give it one", () => {
  const html = render(
    detail({
      computerConfigured: true,
      computer: { enabled: false, status: "disabled", streamOn: false, lastActiveAt: null, activeSeconds: 0, hasPoster: false, usingNow: null, error: null },
      computerAccess: { ok: true, reason: null, message: null, upgradePlan: null },
    }),
  );
  assert.match(html, /Its tasks ask you before starting one\./);
  assert.match(html, />Give it one</);
});

test("an agent that runs on the Mac: no policy and no new computer, because its tasks never use one", () => {
  const mac = { ...AGENT, executionTarget: "mac", computerPolicy: "allowed" } as unknown as ClientAgent;
  const open = { ok: true, reason: null, message: null, upgradePlan: null } as const;
  const none = render({
    ...detail({
      computerConfigured: true,
      computer: { enabled: false, status: "disabled", streamOn: false, lastActiveAt: null, activeSeconds: 0, hasPoster: false, usingNow: null, error: null },
      computerAccess: open,
    }),
    agent: mac,
  });
  assert.match(none, /Its tasks run on your Mac, so they don’t use one\./);
  assert.doesNotMatch(none, /Give it one|Ask first|On its own|start one on their own/);

  const kept = render({
    ...detail({
      computerConfigured: true,
      computer: { enabled: true, status: "asleep", streamOn: false, lastActiveAt: null, activeSeconds: 0, hasPoster: false, usingNow: null, error: null },
      computerAccess: open,
    }),
    agent: mac,
  });
  assert.match(kept, /Its tasks run on your Mac and don’t use this computer\./);
  assert.match(kept, />Delete computer</, "an existing computer can still be deleted");
  assert.doesNotMatch(kept, /Ask first|On its own/);
});
