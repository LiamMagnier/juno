import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { admitSkillDraft, skillDraftKey } from "@/lib/skills/teach";
import { emptySkillContract } from "@/lib/work/skills";
import { stateFromDraft, stateFromForm } from "@/components/skills/teach/teach-model";
import { TeachEditor } from "@/components/skills/teach/teach-editor";
import { TaughtLine } from "@/components/skills/teach/taught-line";

/*
 * Teach Juno's review, rendered to markup: a chat draft opens with its steps,
 * what it may use (with the evidence from the chat), where it applies and a
 * review whose "turn on" stays unavailable until the person confirms. A
 * re-taught skill names the version it will save. The skill page says where a
 * taught skill came from and offers to teach it again.
 */

// The icon module is written for the automatic JSX runtime; markup rendered
// here goes through the classic one, as in tests/chat-image-card.test.ts.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-25T10:00:00Z");

function draft(overrides: Record<string, unknown> = {}) {
  const admission = admitSkillDraft(
    {
      name: "File the monthly invoices",
      whenToUse: "When I ask to file invoices for a month.",
      steps: ["Open the Invoices label in Gmail.", "Download each PDF.", "Rename it to client-month.pdf."],
      tools: ["web_search"],
      apps: ["Gmail"],
      questions: ["Which Drive folder holds the months?"],
      ...overrides,
    },
    {
      key: skillDraftKey("m1", 0),
      now: NOW,
      conversationId: "c1",
      connectors: [{ id: "composio:gmail", label: "Gmail" }],
      observed: { tools: ["web_search"], apps: [] },
      untrusted: overrides.untrusted === true,
    }
  );
  if (!admission.ok) throw new Error(admission.message);
  return admission.draft;
}

const context = { projects: [{ id: "p1", name: "Finance" }], apps: [{ id: "composio:gmail", label: "Gmail" }] };

function render(element: React.ReactElement) {
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, element));
}

test("a chat draft opens as a review: steps, evidence, scope, and turn-on held until confirmed", () => {
  const d = draft();
  const html = render(
    React.createElement(TeachEditor, {
      initial: stateFromDraft(d),
      mode: { kind: "new", key: d.key, source: d.source },
      context,
      observed: d.observed,
      draftNotes: { dropped: [], missingApps: [], fromOutsideContent: false },
      onSaved: () => {},
    })
  );
  for (const heading of ["Name it", "Steps", "What it may use", "Where it applies", "Review"]) {
    assert.ok(html.includes(heading), heading);
  }
  assert.ok(html.includes("Open the Invoices label in Gmail."));
  assert.ok(html.includes("Which Drive folder holds the months?"), "the drafter's question is asked on the page");
  assert.ok(html.includes("Search the web"));
  assert.ok(html.includes("Used in your chat"), "evidence from the conversation is marked");
  assert.ok(html.includes("Gmail"));
  assert.ok(html.includes("/file-the-monthly-invoices · 3 steps · uses Search the web and Gmail · everywhere"));
  assert.ok(html.includes("Safety check: nothing flagged."));
  // The verb that switches it on is rendered disabled until the box is ticked.
  const turnOn = /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save and turn on/s.test(html);
  assert.ok(turnOn, "Save and turn on is disabled before confirmation");
  assert.ok(html.includes("Save, keep it off"));
  assert.ok(!html.includes("drafted this while reading content"), "no outside-content warning when there was none");
});

test("a draft from outside content says so before anything else", () => {
  const d = draft({ untrusted: true });
  const html = render(
    React.createElement(TeachEditor, {
      initial: stateFromDraft(d),
      mode: { kind: "new", key: d.key, source: d.source },
      context,
      draftNotes: { dropped: ["Bash(git add *)"], missingApps: ["Notion"], fromOutsideContent: true },
      onSaved: () => {},
    })
  );
  assert.ok(html.indexOf("drafted this while reading content") < html.indexOf("Name it"));
  assert.ok(html.includes("Left out because a skill can’t ask for it: Bash(git add *)."));
  assert.ok(html.includes("Not connected: Notion."));
});

test("re-teaching a skill that is on names the version it saves and offers to turn it off now", () => {
  const html = render(
    React.createElement(TeachEditor, {
      initial: stateFromForm(
        {
          name: "Weekly report",
          whenToUse: "",
          steps: ["Collect the numbers.", "Write the summary."],
          inputs: [],
          doneWhen: "",
          rules: [],
          notes: [],
          questions: [],
          tools: [],
          connectors: [],
          domains: [],
        },
        "p1"
      ),
      mode: {
        kind: "reteach",
        skillId: "s1",
        slug: "weekly-report",
        enabled: true,
        currentVersion: 4,
        base: emptySkillContract(),
        source: { via: "walkthrough", conversationId: null },
      },
      context,
      onSaved: () => {},
    })
  );
  assert.ok(html.includes("saves version 5"));
  assert.ok(html.includes("Save version 5"));
  assert.ok(html.includes("Save and turn off"));
  assert.ok(html.includes("Turn it off now"));
  assert.ok(html.includes("only in Finance"));
  assert.ok(html.includes("Nothing listed."), "an empty permission list is described honestly");
});

test("the skill page says where a taught skill came from, and offers to teach it again", () => {
  const html = render(
    React.createElement(TaughtLine, {
      skillId: "s1",
      provenance: { "taught.via": "conversation", "taught.conversationId": "c1", "taught.at": NOW.toISOString() },
      enabled: false,
      canReteach: true,
    })
  );
  assert.ok(html.includes("Taught in a chat"));
  assert.ok(html.includes('href="/chat/c1"'));
  assert.ok(html.includes("Off until you switch it on"));
  assert.ok(html.includes('href="/skills/teach?skill=s1"'));
  assert.ok(html.includes("Review and turn on"), "an off taught skill is switched on through the review");
  const on = render(
    React.createElement(TaughtLine, { skillId: "s1", provenance: { "taught.via": "walkthrough" }, enabled: true, canReteach: true })
  );
  assert.ok(on.includes("Taught step by step"));
  assert.ok(on.includes("Teach it again"));
  const imported = render(React.createElement(TaughtLine, { skillId: "s2", provenance: { "source.kind": "github" }, enabled: true, canReteach: true }));
  assert.equal(imported, "", "a skill that was not taught draws nothing");
});
