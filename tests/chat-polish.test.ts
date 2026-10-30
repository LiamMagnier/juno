import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  INCOGNITO_LEAVE_COPY,
  INCOGNITO_LEAVE_KEY,
  inAppLeaveHref,
  incognitoLeaveConfirmOff,
  incognitoLeaveNeedsConfirm,
  setIncognitoLeaveConfirmOff,
  type LeaveClick,
} from "@/components/chat/incognito-leave";
import {
  conversationExportFileName,
  conversationExportTurns,
  conversationMarkdown,
  exportableMarkdown,
  type ExportMessage,
} from "@/components/chat/conversation-export";
import { CHAT_EXPORT_COPY, isChatExportKind } from "@/components/chat/conversation-export-menu";
import { stripTrailingSourcesSection } from "@/components/chat/sources-section";
import { ApprovalCard, approvalToolTitle } from "@/components/chat/approval-card";
import { MemoryUpdatedAnnouncement, MemoryUpdatedNotice, noticeSummary } from "@/components/chat/memory-updated-notice";
import { MARKDOWN_COPY, Markdown } from "@/components/chat/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { serializeQuote, ANSWER_QUOTE_TITLE } from "@/lib/quote-context";
import type { ClientActionApproval } from "@/lib/action-approval";

/*
 * Chat polish (package C1): leaving incognito asks first, a conversation
 * exports as Markdown or prints, wide tables scroll from the keyboard,
 * approval cards name the tool in words, and "Memory updated" never covers
 * the conversation on a phone nor cuts a word in half.
 */

(globalThis as { React?: typeof React }).React = React;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/* ── Leaving incognito ─────────────────────────────────────────────────── */

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

test("only a non-empty incognito chat asks before it is left, and Don't ask again silences it", () => {
  assert.equal(incognitoLeaveNeedsConfirm({ privateMode: true, hasContent: true, suppressed: false }), true);
  assert.equal(incognitoLeaveNeedsConfirm({ privateMode: true, hasContent: false, suppressed: false }), false, "an empty one has nothing to lose");
  assert.equal(incognitoLeaveNeedsConfirm({ privateMode: false, hasContent: true, suppressed: false }), false, "a saved chat never asks");
  assert.equal(incognitoLeaveNeedsConfirm({ privateMode: true, hasContent: true, suppressed: true }), false);

  const storage = memoryStorage();
  assert.equal(incognitoLeaveConfirmOff(storage), false);
  setIncognitoLeaveConfirmOff(storage);
  assert.equal(storage.values.get(INCOGNITO_LEAVE_KEY), "off");
  assert.equal(incognitoLeaveConfirmOff(storage), true);

  // Storage that throws (private browsing, blocked site data) keeps asking.
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(incognitoLeaveConfirmOff(broken), false);
  assert.doesNotThrow(() => setIncognitoLeaveConfirmOff(broken));
  assert.equal(incognitoLeaveConfirmOff(null), false);
});

test("a link click counts as leaving only when it navigates inside the app, away from this page", () => {
  const click: LeaveClick = { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const here = { origin: "https://alevr.app", pathname: "/chat", search: "" };
  const link = (href: string | null, extra: Partial<{ target: string | null; download: boolean }> = {}) => ({
    href,
    target: extra.target ?? null,
    download: extra.download ?? false,
  });
  assert.equal(inAppLeaveHref(click, link("/projects"), here), "/projects");
  assert.equal(inAppLeaveHref(click, link("/chat/abc?m=1#x"), here), "/chat/abc?m=1#x");
  assert.equal(inAppLeaveHref(click, link("https://alevr.app/agents"), here), "/agents");
  assert.equal(inAppLeaveHref(click, link("/chat?project=p1"), here), "/chat?project=p1", "another search on the same page reloads its state");
  // Not leaving: this page again, a fragment on it, another site, a new tab, a download, a script.
  assert.equal(inAppLeaveHref(click, link("/chat"), here), null);
  assert.equal(inAppLeaveHref(click, link("#main"), here), null);
  assert.equal(inAppLeaveHref(click, link("https://example.com/x"), here), null);
  assert.equal(inAppLeaveHref(click, link("//example.com/x"), here), null);
  assert.equal(inAppLeaveHref(click, link("/projects", { target: "_blank" }), here), null);
  assert.equal(inAppLeaveHref(click, link("/projects", { target: "_self" }), here), "/projects");
  assert.equal(inAppLeaveHref(click, link("/files/a.pdf", { download: true }), here), null);
  assert.equal(inAppLeaveHref(click, link("javascript:alert(1)"), here), null);
  assert.equal(inAppLeaveHref(click, link("blob:https://alevr.app/0f0f"), here), null);
  assert.equal(inAppLeaveHref(click, link(null), here), null);
  // Not a plain primary click: it opens elsewhere and this chat stays.
  assert.equal(inAppLeaveHref({ ...click, metaKey: true }, link("/projects"), here), null);
  assert.equal(inAppLeaveHref({ ...click, ctrlKey: true }, link("/projects"), here), null);
  assert.equal(inAppLeaveHref({ ...click, shiftKey: true }, link("/projects"), here), null);
  assert.equal(inAppLeaveHref({ ...click, button: 1 }, link("/projects"), here), null);
  assert.equal(inAppLeaveHref({ ...click, defaultPrevented: true }, link("/projects"), here), null);
});

test("every in-app door out of a non-empty incognito chat goes through the question", () => {
  const view = read("../src/components/chat/chat-view.tsx");
  // New chat, from any door that fires the event.
  assert.match(view, /const handler = \(\) => askBeforeLeavingIncognito\(reset\);/);
  // The band's Leave incognito and the header toggle.
  assert.match(view, /e\.stopPropagation\(\);\s+askBeforeLeavingIncognito\(\(\) => exitPrivateMode\(\)\);/);
  assert.match(view, /if \(privateMode\) \{\s+askBeforeLeavingIncognito\(\(\) => exitPrivateMode\(\)\);/);
  // A link: captured on the window, before the link and the router see it.
  assert.match(view, /window\.addEventListener\("click", onClick, true\);/);
  assert.match(view, /setLeaveIncognito\(\{ proceed: \(\) => exitPrivateMode\(href\) \}\);/);
  // Ending the chat is the leave already answered: its own new-chat event never asks again.
  assert.match(view, /leavingIncognitoRef\.current = true;\s+try \{\s+window\.dispatchEvent\(new CustomEvent\("juno:new-chat", \{ detail: \{ focusComposer: false \} \}\)\);/);
  assert.match(view, /<IncognitoLeaveDialog/);
  // No beforeunload: a closed tab or a reload cannot carry the copy (spec §6.1).
  assert.doesNotMatch(view, /beforeunload/);

  const dialog = read("../src/components/chat/incognito-leave-dialog.tsx");
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /keepRef\.current\?\.focus\(\)/, "focus lands on the answer that loses nothing");
  assert.match(dialog, /if \(dontAsk\) setIncognitoLeaveConfirmOff\(\);\s+onEnd\(\);/, "Don't ask again is kept only when the chat is ended");
  assert.equal(INCOGNITO_LEAVE_COPY.title, "End this incognito chat?");
  assert.equal(INCOGNITO_LEAVE_COPY.end, "End chat");
  assert.equal(INCOGNITO_LEAVE_COPY.keep, "Keep chatting");
});

/* ── Export ────────────────────────────────────────────────────────────── */

const AT = new Date("2026-10-30T12:00:00Z");

function messages(): ExportMessage[] {
  const quoted = serializeQuote(
    { source: "answer", messageId: "a0", title: ANSWER_QUOTE_TITLE, kind: "text", text: "Halvorsen accounts for €23,600.", mode: "ask" },
    "Which customer is that?"
  );
  return [
    { id: "s1", role: "SYSTEM", content: "You are a helpful assistant. SECRET SYSTEM PROMPT" },
    {
      id: "u1",
      role: "USER",
      content: "Compare the three quotes.",
      attachments: [{ fileName: "quotes.pdf" }],
    },
    {
      id: "a1",
      role: "ASSISTANT",
      content: [
        "<!-- juno:section=summary -->",
        "## Summary",
        "",
        "Oak is cheapest [1].",
        "",
        "```html",
        "<!-- this comment is code, and stays -->",
        "```",
        "",
        "```live-ui",
        '{"type":"chart","data":[1,2,3]}',
        "```",
        "",
        '<juno:artifact identifier="cab-plan" type="document" title="Cabinet plan">SECRET ARTIFACT BODY</juno:artifact>',
        "",
        "<juno:memory>The user lives in Lisbon.</juno:memory>",
        "## Sources",
        "[1] Oak Co — https://oak.example/quote",
      ].join("\n"),
      sources: [
        { title: "Oak Co quote", url: "https://oak.example/quote" },
        { title: "Bad link", url: "javascript:alert(1)" },
      ],
    },
    { id: "u2", role: "USER", content: quoted },
    { id: "a2", role: "ASSISTANT", content: "Unauthorized: token abc123 rejected by upstream", error: true },
    { id: "a3", role: "ASSISTANT", content: "Halvorsen AS holds the annual", streaming: true },
  ];
}

test("the Markdown export is what the transcript shows, and nothing it hides", () => {
  const md = conversationMarkdown({ title: "Cabinet quotes compared", messages: messages(), exportedAt: AT });
  assert.ok(md.startsWith("# Cabinet quotes compared\n"));
  assert.match(md, /_Alevr · 2026-10-30_/);
  assert.match(md, /\*\*You:\*\*\n\nCompare the three quotes\./);
  assert.match(md, /_Files: quotes\.pdf_/, "an attachment by name");
  assert.match(md, /\*\*Alevr:\*\*\n\n## Summary\n\nOak is cheapest \[1\]\./);
  assert.match(md, /<!-- this comment is code, and stays -->/, "a comment inside code is code");
  assert.match(md, /_Interactive view: open this chat to use it\._/);
  assert.match(md, /_Artifact: “Cabinet plan” \(not included in this export\)_/);
  assert.match(md, /Sources:\n\n1\. \[Oak Co quote\]\(https:\/\/oak\.example\/quote\)/);
  // A quoted passage is a quote, then the person's own words.
  assert.match(md, /> Halvorsen accounts for €23,600\.\n\nWhich customer is that\?/);
  assert.match(md, /_This reply did not finish\._/);
  assert.match(md, /Halvorsen AS holds the annual\n\n_Still being written when this was exported\._/);

  // Hidden or private: none of it reaches the file.
  for (const hidden of [
    "SECRET SYSTEM PROMPT",
    "juno:memory",
    "Lisbon",
    "juno:section",
    "SECRET ARTIFACT BODY",
    '"type":"chart"',
    "javascript:",
    "Unauthorized",
    "abc123",
    "[1] Oak Co — https", // the model's own sources list, replaced by the real one
  ]) {
    assert.ok(!md.includes(hidden), `the export leaks ${JSON.stringify(hidden)}`);
  }
  // The quote block's protocol (its header line and the instruction written to the model) stays out.
  const raw = messages()[3].content;
  const protocolLine = raw.split("\n")[0];
  assert.ok(!md.includes(protocolLine), "the quote header is protocol, not the person's words");
});

test("export turns name the agent, keep file names only, and skip what is never shown", () => {
  const turns = conversationExportTurns({
    title: "",
    messages: [
      { id: "u", role: "USER", content: "", attachments: [{ fileName: "photo.png" }] },
      { id: "a", role: "ASSISTANT", content: "", attachments: [{ fileName: "render.png" }] },
      { id: "e", role: "USER", content: "   " },
    ],
    assistantName: "Mira",
    exportedAt: AT,
  });
  assert.deepEqual(
    turns.map((turn) => [turn.speaker, turn.label, turn.files, turn.note]),
    [
      ["you", "You", ["photo.png"], null],
      ["assistant", "Mira", ["render.png"], null],
    ]
  );
  const empty = conversationExportTurns({ title: "", messages: [{ id: "a", role: "ASSISTANT", content: "" }], exportedAt: AT });
  assert.equal(empty[0].note, "No answer.");
  // A renamed artifact takes the chat's current title, as its card does.
  const renamed = conversationMarkdown({
    title: "t",
    messages: [{ id: "a", role: "ASSISTANT", content: '<juno:artifact identifier="x1" title="Old">body</juno:artifact>' }],
    exportedAt: AT,
    artifactTitle: (id) => (id === "x1" ? "New name" : undefined),
  });
  assert.match(renamed, /Artifact: “New name”/);
});

test("exportable Markdown keeps code whole and removes only what the page never draws", () => {
  assert.equal(exportableMarkdown("a <!-- note --> b"), "a  b");
  // A comment split by another cannot survive one pass: none is left behind.
  assert.equal(exportableMarkdown("a <!<!-- x -->-- y --> b"), "a  b");
  assert.equal(exportableMarkdown("~~~\n<!-- kept -->\n~~~"), "~~~\n<!-- kept -->\n~~~");
  assert.equal(exportableMarkdown("```juno-live\n{}\n```\nafter"), "_Interactive view: open this chat to use it._\nafter");
  // An unclosed fence runs to the end, as Markdown reads it.
  assert.equal(exportableMarkdown("```python\nprint(1)"), "```python\nprint(1)");
  assert.equal(stripTrailingSourcesSection("Body\n\n## Sources\n[1] A — https://a.example"), "Body");
  assert.equal(stripTrailingSourcesSection("Body\n\n## Sources\nI used these because…"), "Body\n\n## Sources\nI used these because…");
});

test("the download is named after the chat", () => {
  assert.equal(conversationExportFileName("Cabinet quotes compared", AT), "cabinet-quotes-compared.md");
  assert.equal(conversationExportFileName("Café: déjà vu?", AT), "cafe-deja-vu.md");
  assert.equal(conversationExportFileName("登录", AT), "chat-2026-10-30.md");
  assert.equal(conversationExportFileName("", AT), "chat-2026-10-30.md");
  const long = conversationExportFileName("word ".repeat(40), AT);
  assert.ok(long.length <= 83 && !long.includes("--") && !/-\.md$/.test(long), long);
});

test("export lives in the conversation's menu and in an answer's More menu, and prints without the app around it", () => {
  assert.equal(CHAT_EXPORT_COPY.copy, "Copy as Markdown");
  assert.equal(CHAT_EXPORT_COPY.download, "Download Markdown");
  assert.equal(CHAT_EXPORT_COPY.print, "Print or save as PDF");
  assert.ok(isChatExportKind("print") && !isChatExportKind("pdf"));

  const view = read("../src/components/chat/chat-view.tsx");
  assert.match(view, /<ConversationMoreMenu onExport=\{\(kind\) => void exportChat\(kind\)\} \/>/);
  assert.match(view, /window\.addEventListener\(CHAT_EXPORT_EVENT, onExport\);/);
  // The whole conversation, not only the loaded page of it.
  assert.match(view, /const transcript = chatHistory\.hasOlder \? await loadOlderMessages\(\{ all: true \}\) : chat\.messages;\s+if \(!transcript\) \{\s+toast\.error\("Couldn’t export/);
  const item = read("../src/components/chat/message-item.tsx");
  assert.match(item, /\{canExport && <ExportChatMenuSection \/>\}/);
  // On a phone the rows sit in the menu itself: a submenu opened off the screen's edge.
  const menu = read("../src/components/chat/conversation-export-menu.tsx");
  assert.match(menu, /if \(phone\) \{\s+return \(\s+<>\s+<DropdownMenuLabel>\{CHAT_EXPORT_COPY\.chatHeading\}<\/DropdownMenuLabel>\s+<ChatExportItems onSelect=\{requestChatExport\} \/>/);

  const print = read("../src/components/chat/conversation-print.tsx");
  assert.match(print, /data-print-document=""/);
  assert.match(print, /window\.addEventListener\("afterprint", finish\);\s+window\.print\(\);/);
  const css = read("../src/components/chat/conversation-print.css");
  assert.match(css, /\.chat-print-root \{\s+display: none;/, "never drawn on screen");
  assert.match(css, /color: #111 !important;/, "ink on paper in every theme");
  assert.match(css, /\.chat-print button \{\s+display: none !important;/, "no controls on paper");
  // The page rule that hides the app around a print document.
  assert.match(read("../src/app/globals.css"), /body:has\(\[data-print-document\]\) > :not\(:has\(\[data-print-document\]\)\) \{ display: none; \}/);
});

/* ── Wide tables ───────────────────────────────────────────────────────── */

test("a wide table scrolls in its own box, which joins the tab order as a named region while it scrolls", () => {
  const html = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Markdown, { content: "| a | b |\n| --- | --- |\n| 1 | 2 |" }))
  );
  assert.match(html, /<div data-table-scroll="" class="overflow-x-auto[^"]*"><table>/);
  // Before it is measured (and while it fits) it is no tab stop.
  assert.doesNotMatch(html, /data-table-scroll=""[^>]*tabindex/);
  const source = read("../src/components/chat/markdown.tsx");
  assert.match(source, /tabIndex=\{scrolls \? 0 : undefined\}/);
  assert.match(source, /role=\{scrolls \? "region" : undefined\}/);
  assert.match(source, /aria-label=\{scrolls \? label : undefined\}/);
  assert.match(source, /setScrolls\(box\.scrollWidth > box\.clientWidth \+ 1\)/);
  // The global keyboard ring, outside the edge (inside, the sticky label column covered it).
  assert.doesNotMatch(source, /data-table-scroll=""[\s\S]{0,200}outline-none/);
  assert.equal(MARKDOWN_COPY.tableRegion, "Scrollable table");
});

/* ── Approval cards ────────────────────────────────────────────────────── */

test("an approval names its tool in plain words", () => {
  assert.equal(approvalToolTitle("slack__post_message", "Slack"), "Post message");
  assert.equal(approvalToolTitle("post_message", "Slack"), "Post message");
  assert.equal(approvalToolTitle("slack_post_message", "Slack"), "Post message");
  assert.equal(approvalToolTitle("google_calendar__create_event", "Google Calendar"), "Create event");
  assert.equal(approvalToolTitle("google_calendar_create_event", "Google Calendar"), "Create event");
  assert.equal(approvalToolTitle("github__createIssue", "GitHub"), "Create issue");
  assert.equal(approvalToolTitle("fetch_URL", "Web"), "Fetch URL");
  assert.equal(approvalToolTitle("linear-update-issue", "Linear"), "Update issue");
  assert.equal(approvalToolTitle("slack", "Slack"), "Slack", "a name that is only the connector stays");
  assert.equal(approvalToolTitle("__", "Slack"), "__", "nothing readable: the identifier as it is");
});

const SLACK_POST = "Q3 renewals: Stripe is €26,000 under forecast.";
function approval(over: Partial<ClientActionApproval> = {}): ClientActionApproval {
  return {
    id: "ap-slack",
    surface: "chat",
    sessionId: "s",
    conversationId: "c",
    connectorId: "slack",
    connectorLabel: "Slack",
    toolName: "slack__post_message",
    action: "connector.slack.post_message",
    riskClass: "external_write",
    preview: `#design in Northwind Slack, as you: ${SLACK_POST}`,
    detail: { channel: "#design", text: SLACK_POST },
    receiptDigest: "digest",
    status: "pending",
    decision: null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    decidedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  } as ClientActionApproval;
}

test("the card heads the call as 'Slack · Post message' and keeps the identifier with what is sent", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalCard, { approval: approval() }));
  assert.match(html, /<span class="font-medium text-foreground">Slack<\/span><span aria-hidden="true"> · <\/span><span class="sr-only">, <\/span>Post message/);
  // The raw identifier is not in the visible heading; it waits behind "Exactly what will be sent".
  assert.doesNotMatch(html, /font-mono">slack__post_message/);
  const source = read("../src/components/chat/approval-card.tsx");
  assert.match(source, /Tool <span className="font-mono text-foreground">\{current\.toolName\}<\/span>/);
  // The answer still carries the digest it was shown (unchanged binding).
  assert.match(source, /receiptDigest/);
});

/* ── "Memory updated" ──────────────────────────────────────────────────── */

test("the memory notice cuts its fact between words and wraps instead of clipping", () => {
  assert.equal(noticeSummary("Halvorsen is the user's largest renewal this quarter."), "Halvorsen is the user's largest renewal this quarter.");
  const long = "Halvorsen is the user's largest renewal this quarter, and the account manager is Mira Okafor in Oslo.";
  const cut = noticeSummary(long);
  assert.ok(cut.endsWith("…") && cut.length <= 73, cut);
  const words = cut.slice(0, -1).split(" ");
  assert.ok(long.split(/\s+/).includes(words[words.length - 1]) || long.includes(`${words[words.length - 1]},`), `cut mid-word: ${cut}`);
  assert.equal(noticeSummary("a".repeat(100)).length, 72, "a single giant word is the only thing cut inside itself");

  const html = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, {
      write: { saved: [{ id: "m1", content: long, category: "projects" }] } as never,
      onDismiss: () => undefined,
    })
  );
  assert.match(html, /whitespace-normal break-words/);
  assert.doesNotMatch(html, /min-w-0 truncate text-ui font-medium/, "the fact is no longer clipped to one line");
});

test("on a phone the notice is never drawn over the conversation", () => {
  const view = read("../src/components/chat/chat-view.tsx");
  assert.match(view, /const phoneWidth = useMediaQuery\(PHONE_QUERY\);/);
  assert.match(view, /\{memoryNotice && !phoneWidth && \(\s+<div className="flex justify-center px-4 pt-2">/);
  // A named write: its answer's chip says it, so only a screen reader is told.
  assert.match(view, /\{memoryNotice && phoneWidth && memoryNotice\.write && \(\s+<MemoryUpdatedAnnouncement/);
  // An unnamed write has no chip: drawn above the composer, never over the transcript.
  assert.match(view, /\{memoryNotice && phoneWidth && !memoryNotice\.write && \(\s+<div className="mb-2 flex justify-center px-2">\s+<MemoryUpdatedNotice key=\{memoryNotice\.key\} write=\{null\}/);
  const html = renderToStaticMarkup(
    React.createElement(MemoryUpdatedAnnouncement, {
      write: { saved: [{ id: "m1", content: "Prefers metric units", category: "preferences" }] } as never,
      onDismiss: () => undefined,
    })
  );
  // The region is in place before its words arrive, so it is announced.
  assert.match(html, /<p role="status" aria-live="polite" class="sr-only" data-memory-announcement=""><\/p>/);
});
