import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VerbButton } from "@/components/chat/decision";
import { admitSkillDraft, skillDraftKey, type ClientSkillDraft, type ClientTaughtSkill } from "@/lib/skills/teach";
import {
  SkillDraftCardView,
  draftCardPhase,
  readDismissed,
  skillDraftMeta,
  skillDraftReviewHref,
  writeDismissed,
  type SkillDraftPhase,
} from "@/components/skills/skill-draft-card";
import { fetchTaughtSkillByKey, readStashedSkillDraft } from "@/components/skills/teach/teach-transport";
import { TeachPermissions } from "@/components/skills/teach/teach-permissions";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The chat's skill draft card, without a DOM (the repo has none): each phase
 * rendered to markup, the buttons' handlers found on the element tree and
 * pressed, and the decisions behind them — the lookup by draft key, Not now
 * remembered per draft, Review handing the draft over through session storage.
 */

// The icon module is written for the automatic JSX runtime; markup rendered
// here goes through the classic one, as in tests/teach-skill-render.test.ts.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-25T10:00:00Z");

function draft(overrides: Record<string, unknown> = {}): ClientSkillDraft {
  const admission = admitSkillDraft(
    {
      name: "File the monthly invoices",
      whenToUse: "When I ask to file invoices for a month.",
      steps: ["Open the Invoices label in Gmail.", "Download each PDF.", "Rename it to client-month.pdf.", "Move it to Drive."],
      tools: ["web_search"],
      apps: ["Gmail", "Notion"],
      questions: ["Which Drive folder holds the months?", "Skip paid ones?"],
      ...overrides,
    },
    {
      key: skillDraftKey("m1", 0),
      now: NOW,
      conversationId: "c1",
      connectors: [{ id: "composio:gmail", label: "Gmail" }],
      untrusted: overrides.untrusted === true,
    }
  );
  if (!admission.ok) throw new Error(admission.message);
  return admission.draft;
}

const SAVED: ClientTaughtSkill = {
  id: "s1",
  slug: "file-the-monthly-invoices",
  name: "File the monthly invoices",
  enabled: false,
  currentVersion: 1,
  projectId: null,
  securityStatus: "clear",
};

type Calls = { review: number; notNow: number; show: number };

function props(d: ClientSkillDraft, phase: SkillDraftPhase, saved: ClientTaughtSkill | null, calls: Calls) {
  return {
    draft: d,
    phase,
    saved,
    reduce: true,
    titleId: "t1",
    onReview: () => calls.review++,
    onNotNow: () => calls.notNow++,
    onShow: () => calls.show++,
  };
}

const render = (element: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(TooltipProvider, null, element));

/** Every element in a tree the view returned, without rendering its children's components. */
function elements(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const el = node as React.ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as React.ReactNode)];
}

const text = (node: React.ReactNode): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : React.isValidElement(node)
        ? text((node.props as { children?: React.ReactNode }).children)
        : "";

test("open: the draft's name, what it uses, three steps and the rest counted, its question, and Review / Not now", () => {
  const d = draft({ untrusted: true });
  const html = render(React.createElement(SkillDraftCardView, props(d, "open", null, { review: 0, notNow: 0, show: 0 })));
  assert.ok(html.includes("Skill draft"));
  assert.ok(html.includes("File the monthly invoices"));
  assert.equal(skillDraftMeta(d), "/file-the-monthly-invoices · 4 steps · uses Search the web and Gmail");
  assert.ok(html.includes(skillDraftMeta(d)));
  assert.ok(html.includes("Open the Invoices label in Gmail."));
  assert.ok(html.includes("Rename it to client-month.pdf."));
  assert.ok(!html.includes("Move it to Drive."), "only three steps are previewed");
  assert.ok(html.includes("and 1 more"));
  assert.ok(html.includes("Open questions: Which Drive folder holds the months? (+1)"));
  assert.ok(html.includes("Not connected: Notion."));
  assert.ok(html.includes("Drafted while reading outside content."));
  assert.ok(html.includes("Review"));
  assert.ok(html.includes("Not now"));
  assert.ok(html.includes("Nothing is saved until you review it."));
  assert.ok(html.includes(`data-skill-draft="${d.key}"`));
});

test("saved: the skill's slug and switch, and a link to it instead of Review", () => {
  const d = draft();
  const off = render(React.createElement(SkillDraftCardView, props(d, "saved", SAVED, { review: 0, notNow: 0, show: 0 })));
  assert.ok(off.includes("Skill saved"));
  assert.ok(off.includes("/file-the-monthly-invoices"));
  assert.ok(off.includes("Off until you switch it on"));
  assert.ok(off.includes('href="/skills/s1"'));
  assert.ok(off.includes("Review it there to switch it on."));
  assert.ok(!off.includes("Not now"));
  const on = render(React.createElement(SkillDraftCardView, props(d, "saved", { ...SAVED, enabled: true }, { review: 0, notNow: 0, show: 0 })));
  assert.ok(on.includes(" · On"));
  assert.ok(on.includes("You can switch it off or change it there."));
});

test("dismissed folds to one line with Show; checking holds the space without content", () => {
  const d = draft();
  const folded = render(React.createElement(SkillDraftCardView, props(d, "dismissed", null, { review: 0, notNow: 0, show: 0 })));
  assert.ok(folded.includes("Skill not saved:"));
  assert.ok(folded.includes("Show"));
  assert.ok(!folded.includes("Review"));
  const checking = render(React.createElement(SkillDraftCardView, props(d, "checking", null, { review: 0, notNow: 0, show: 0 })));
  assert.ok(checking.includes('aria-hidden="true"'));
  assert.ok(!checking.includes("File the monthly invoices"));
});

test("pressing Review, Not now and Show calls the card back", () => {
  const d = draft();
  const calls: Calls = { review: 0, notNow: 0, show: 0 };
  const open = elements(SkillDraftCardView(props(d, "open", null, calls)));
  const review = open.find((el) => el.type === VerbButton);
  assert.ok(review, "Review is the verb");
  assert.equal(review.props.accessibleLabel, "Review the File the monthly invoices skill");
  (review.props.onClick as () => void)();
  const notNow = open.find((el) => typeof el.props.onClick === "function" && text(el.props.children as React.ReactNode) === "Not now");
  assert.ok(notNow);
  (notNow.props.onClick as () => void)();
  const folded = elements(SkillDraftCardView(props(d, "dismissed", null, calls)));
  const show = folded.find((el) => el.type === "button" && text(el.props.children as React.ReactNode) === "Show");
  assert.ok(show);
  (show.props.onClick as () => void)();
  assert.deepEqual(calls, { review: 1, notNow: 1, show: 1 });
});

test("the lookup by draft key decides the phase: saved, open, or folded after Not now", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ skill: { ...SAVED, enabled: true } }), { status: 200 });
  }) as typeof fetch;
  try {
    const found = await fetchTaughtSkillByKey("skill-draft:m1:0");
    assert.deepEqual(seen, ["/api/skills/teach?key=skill-draft%3Am1%3A0"]);
    assert.deepEqual(draftCardPhase(found, true), { phase: "saved", saved: { ...SAVED, enabled: true } }, "saved wins over Not now");

    globalThis.fetch = (async () => new Response(JSON.stringify({ skill: null }), { status: 200 })) as typeof fetch;
    const none = await fetchTaughtSkillByKey("skill-draft:m1:0");
    assert.deepEqual(draftCardPhase(none, false), { phase: "open", saved: null });
    assert.deepEqual(draftCardPhase(none, true), { phase: "dismissed", saved: null });

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const offline = await fetchTaughtSkillByKey("skill-draft:m1:0");
    assert.equal(offline.kind, "failed");
    assert.deepEqual(draftCardPhase(offline, false), { phase: "open", saved: null }, "offline still shows the draft");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Not now is remembered per draft in this browser; Review forgets it and hands the draft over", () => {
  const store = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  };
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = { localStorage: store(), sessionStorage: store() };
  try {
    const d = draft();
    assert.equal(readDismissed(d.key), false);
    writeDismissed(d.key, true);
    assert.equal(readDismissed(d.key), true);
    assert.equal(readDismissed(skillDraftKey("m1", 1)), false, "per draft");

    const href = skillDraftReviewHref(d);
    assert.equal(readDismissed(d.key), false, "Review forgets Not now");
    const match = /^\/skills\/teach\?draft=([a-z0-9]+)$/.exec(href);
    assert.ok(match, href);
    assert.deepEqual(readStashedSkillDraft(match[1]), d, "the Teach page reads back the very draft");
    assert.ok(!href.includes("Invoices"), "the steps never ride the URL");

    // A tab that cannot store it opens an empty walkthrough rather than nothing.
    const forgotten: string[] = [];
    assert.equal(
      skillDraftReviewHref(d, { stash: () => null, forget: (key) => forgotten.push(key) }),
      "/skills/teach?mode=walk"
    );
    assert.deepEqual(forgotten, [d.key]);
  } finally {
    g.window = previous;
  }
});

test("the permission footnote promises narrowing only when something is listed", () => {
  const base = { apps: [{ id: "composio:gmail", label: "Gmail" }], onChange: () => {} };
  const listed = render(React.createElement(TeachPermissions, { ...base, tools: ["web_search"], connectors: [], domains: [] }));
  assert.ok(listed.includes(`When you run it, ${PRODUCT_NAME} uses just what’s listed here`));
  const empty = render(React.createElement(TeachPermissions, { ...base, tools: [], connectors: [], domains: [] }));
  assert.ok(empty.includes("Nothing listed."));
  assert.ok(!empty.includes("uses just what’s listed here"), "an empty list does not claim to narrow");
  const domainsOnly = render(React.createElement(TeachPermissions, { ...base, tools: [], connectors: [], domains: ["example.com"] }));
  assert.ok(!domainsOnly.includes("uses just what’s listed here"), "a website is a record, not a limit");
  assert.ok(empty.includes("Anything that needs your approval still asks you each time."));
});
