import test from "node:test";
import assert from "node:assert/strict";
import { createResearchEngine } from "@/lib/research/engine";
import { parsePlan } from "@/lib/research/domain";
import {
  applySourceChoice,
  buildPrivateFingerprint,
  defaultSourceSelection,
  isPrivateSourceUrl,
  parsePrivateSourceUrl,
  parseSourceSelection,
  privateSourceTitle,
  privateSourceUrl,
  sanitiseWebQuery,
  type PrivateSourceOption,
} from "@/lib/research/private-sources";
import {
  mailSearchTerms,
  parseCalendarListing,
  parseMailListing,
  passagesToHits,
  searchPrivateSourcesWith,
  type ConnectorSession,
} from "@/lib/research/private-retrieval-core";
import { buildResearchCorpus, sourceMetaLine } from "@/lib/research/corpus";
import { CITATION_RULES } from "@/lib/research/corpus.prompt";
import { privateSourcesRule } from "@/lib/research/planner.prompt";
import { validateToolUrl } from "@/lib/research/agents/protocol";
import { orderCompletionSources } from "@/lib/research/completion-core";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { sourceSections } from "@/components/research/research-view";
import { isLastSource, planBody, seedDraft, sourceOn, toggleSource, WEB_SOURCE_KEY } from "@/components/research/scope-draft";
import type { PrivateResearchHit, ResearchDeps } from "@/lib/research/stages/types";
import { memoryStore } from "./fixtures/research-store";
import { SCENARIO_GOAL, scenarioDeps } from "./fixtures/research-protocol-scenario";

/*
 * Deep Research's own sources: the person's files, project, library, memory
 * and connectors as sources beside the web. What is tested here is what
 * makes it safe — the scope gate, owner-scoped and read-only retrieval, the
 * guarantee that private text never reaches a web search engine, and a
 * citation a person can find their record by.
 */

const OPTIONS: PrivateSourceOption[] = [
  { key: "file", kind: "file", count: 2, defaultOn: true },
  { key: "project", kind: "project", label: "Tooling review", count: 4, defaultOn: true },
  { key: "library", kind: "library", count: 30, defaultOn: false },
  { key: "memory", kind: "memory", defaultOn: false },
  { key: "calendar:apple-calendar", kind: "calendar", connectorId: "apple-calendar", label: "Apple Calendar", defaultOn: false },
  { key: "mail:apple-mail", kind: "mail", connectorId: "apple-mail", label: "Apple Mail", defaultOn: false },
];

// ── Addressing and citations ─────────────────────────────────────────────────

test("a private address round-trips, is https on a reserved host, and is never a web page", () => {
  const url = privateSourceUrl({ kind: "file", id: "doc 1/2", locator: "page 3" });
  assert.match(url, /^https:\/\/private\.invalid\/file\//);
  assert.ok(isPrivateSourceUrl(url));
  assert.deepEqual(parsePrivateSourceUrl(url), { kind: "file", id: "doc 1/2", locator: "page 3" });
  assert.equal(parsePrivateSourceUrl("https://example.org/file/x"), null);
  assert.equal(parsePrivateSourceUrl("https://private.invalid/unknown_kind/x"), null);
  assert.equal(isPrivateSourceUrl("https://example.org"), false);
  // Every renderer's chokepoint: drawn as its kind, never linked.
  assert.equal(isRenderableSourceUrl(url), false);
  assert.equal(hostOf(url), "Your files");
  assert.equal(hostOf(privateSourceUrl({ kind: "mail", id: "INBOX:4" })), "Your mail");
  assert.equal(isRenderableSourceUrl("https://example.org/a"), true);
});

test("citations name the record: file and page, subject and date, event and date", () => {
  assert.equal(privateSourceTitle({ kind: "file", name: "Q3 plan.pdf", locator: "page 3" }), "Q3 plan.pdf · page 3");
  assert.equal(
    privateSourceTitle({ kind: "mail", name: "Renewal quote", date: new Date("2026-09-12T08:00:00Z") }),
    "Renewal quote — 2026-09-12"
  );
  assert.equal(
    privateSourceTitle({ kind: "calendar", name: "Tooling review", date: new Date("2026-10-02T09:00:00Z") }),
    "Tooling review — 2026-10-02"
  );
  const meta = sourceMetaLine({ url: privateSourceUrl({ kind: "mail", id: "x" }), title: "t", snapshot: "s", publishedAt: new Date("2026-09-12T00:00:00Z") });
  assert.match(meta, /^\(PRIVATE — the person's own email · dated 2026-09-12\)$/);
  assert.match(CITATION_RULES, /PRIVATE[\s\S]*\(your sources\)/, "the writer is told to mark claims that rest on private data");
});

test("knowledge passages group into one citation per file and page, in reading order", () => {
  const hits = passagesToHits(
    [
      { documentId: "d1", fileName: "Plan.pdf", ordinal: 5, text: "second", locator: "page 2" },
      { documentId: "d1", fileName: "Plan.pdf", ordinal: 4, text: "first", locator: "page 2" },
      { documentId: "d1", fileName: "Plan.pdf", ordinal: 9, text: "later", locator: "page 4" },
      { documentId: "d2", fileName: "Notes.md", ordinal: 0, text: "notes", locator: "" },
    ],
    "file",
    "file"
  );
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.title, "Plan.pdf · page 2");
  assert.equal(hits[0]!.text, "first\n\nsecond");
  assert.equal(hits[2]!.title, "Notes.md · part 1");
  assert.ok(hits.every((hit) => isPrivateSourceUrl(hit.url) && hit.kind === "file"));
});

test("connector text parses into events and messages", () => {
  const events = parseCalendarListing(
    [
      "3 events from …:",
      "• Copilot renewal call — 2026-10-02T09:00+02:00 → 10:00 (Zoom) · calendar: Work · uid: abc-1",
      "• Dentist — 2026-10-03 (all day) · calendar: Home · uid: abc-2",
    ].join("\n")
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]!.summary, "Copilot renewal call");
  assert.equal(events[0]!.uid, "abc-1");
  assert.equal(events[0]!.start?.toISOString(), "2026-10-02T07:00:00.000Z");
  const mail = parseMailListing(
    [
      "Messages in 2 mailboxes (2, newest first):",
      "• [INBOX · uid 42] Cursor seat quote — from sales@cursor.example · 2026-09-12T10:15+00:00 · unread",
      "• [uid 7] Hello — from a@b.example",
    ].join("\n")
  );
  assert.deepEqual(mail.map((m) => [m.mailbox, m.uid, m.subject]), [["INBOX", 42, "Cursor seat quote"], [null, 7, "Hello"]]);
  assert.equal(mail[0]!.date?.toISOString(), "2026-09-12T10:15:00.000Z");
  assert.ok(mailSearchTerms(["What does Cursor cost per seat?"]).includes("cursor"));
});

// ── The scope gate ───────────────────────────────────────────────────────────

test("defaults: the web, this chat's files and the current project; nothing else until switched on", () => {
  const selection = defaultSourceSelection(OPTIONS);
  assert.equal(selection.web, true);
  assert.deepEqual(selection.enabled, ["file", "project"]);
});

test("a choice can only narrow what was offered, and never leaves nothing to read", () => {
  const selection = defaultSourceSelection(OPTIONS.slice(0, 2));
  const chosen = applySourceChoice(selection, { web: false, enabled: ["file", "mail:apple-mail", "library"] });
  assert.deepEqual(chosen.enabled, ["file"], "keys the server did not offer are dropped, never enabled");
  assert.equal(chosen.web, false);
  const none = applySourceChoice(selection, { web: false, enabled: [] });
  assert.equal(none.web, true, "the web stays on when nothing private is left");
  // A stored selection with a forged key reads back without it.
  const parsed = parseSourceSelection({ web: false, enabled: ["file", "forged"], options: OPTIONS.slice(0, 1) });
  assert.deepEqual(parsed?.enabled, ["file"]);
  assert.equal(parseSourceSelection({ web: false, enabled: [], options: [] })?.web, true);
});

test("the scope card's switches: toggle, keep one on, and send the choice with Start", () => {
  const run = {
    id: "r1",
    plan: { pinnedSources: [], sources: { web: true, enabled: ["file"], options: OPTIONS.slice(0, 3) } },
  };
  let draft = seedDraft(run, 0);
  assert.ok(sourceOn(draft, WEB_SOURCE_KEY) && sourceOn(draft, "file") && !sourceOn(draft, "library"));
  draft = toggleSource(draft, "library");
  draft = toggleSource(draft, WEB_SOURCE_KEY);
  draft = toggleSource(draft, "not-offered");
  assert.deepEqual(planBody(draft, "confirm"), {
    decision: "confirm",
    questions: [],
    answers: {},
    pinnedSources: [],
    sources: { web: false, enabled: ["file", "library"] },
  });
  // Web off, file off: library is the last one on, and stays on.
  draft = toggleSource(toggleSource(draft, "file"), "library");
  assert.ok(sourceOn(draft, "library") && isLastSource(draft, "library"));
  const lone = toggleSource(seedDraft({ id: "r2", plan: { pinnedSources: [], sources: { web: false, enabled: ["file"], options: OPTIONS.slice(0, 1) } } }, 0), "file");
  assert.ok(sourceOn(lone, "file"), "the last source on cannot be switched off");
  // A run that offered nothing sends nothing about sources (an older server ignores it either way).
  assert.equal("sources" in planBody(seedDraft({ id: "r3", plan: { pinnedSources: [] } }, 0), "confirm"), false);
});

// ── Query sanitisation ───────────────────────────────────────────────────────

const PRIVATE_TEXT =
  "Renewal quote from Jane Hollingsworth (jane.hollingsworth@acme-widgets.example, +44 20 7946 0958). " +
  "Acme Widgets will pay 48,000 per year for 50 Copilot Business seats under contract AW-77231904.";

test("no private text reaches a web query: identifiers, quoted runs, titles and names are stripped", () => {
  const fingerprint = buildPrivateFingerprint(
    [{ title: "Acme renewal quote.pdf · page 1", text: PRIVATE_TEXT }],
    "Should we standardise on GitHub Copilot or Cursor?"
  );
  const cases = [
    "Jane Hollingsworth Copilot Business pricing",
    "jane.hollingsworth@acme-widgets.example Copilot",
    "Copilot Business seats under contract price",
    "acme renewal quote Copilot Business price per seat",
    "Copilot price call +44 20 7946 0958",
    "contract AW-77231904 Copilot",
  ];
  for (const query of cases) {
    const out = sanitiseWebQuery(query, fingerprint);
    const sent = (out.query ?? "").toLowerCase();
    for (const secret of ["hollingsworth", "jane", "acme", "widgets", "7946", "77231904", "@", "renewal quote", "seats under contract"]) {
      assert.ok(!sent.includes(secret), `"${query}" → "${out.query}" leaks "${secret}"`);
    }
  }
  // The public part of a mixed query survives; a word of the person's own question stays searchable.
  assert.equal(sanitiseWebQuery("Jane Hollingsworth GitHub Copilot pricing", fingerprint).query, "GitHub Copilot pricing");
  // A purely public query is untouched.
  assert.deepEqual(sanitiseWebQuery("GitHub Copilot pricing per seat", fingerprint), {
    query: "GitHub Copilot pricing per seat",
    changed: false,
  });
  // Nothing public left: withheld.
  assert.equal(sanitiseWebQuery("Jane Hollingsworth Acme Widgets", fingerprint).query, null);
  // Identifiers are stripped even with no private sources at all.
  assert.equal(sanitiseWebQuery("someone@example.com Cursor pricing", null).query, "Cursor pricing");
});

test("the planner is told what is switched on and that queries are public", () => {
  assert.equal(privateSourcesRule([]), "");
  assert.match(privateSourcesRule(["File in this chat", "Apple Calendar (calendar event)"]), /never put a name, figure, subject or detail/);
});

test("workers may open and cite a private address; it is never fetched", () => {
  const url = privateSourceUrl({ kind: "file", id: "d1", locator: "page 2" });
  assert.deepEqual(validateToolUrl(url), { ok: true, url });
  assert.equal(validateToolUrl("https://private.invalid/").ok, false);
});

// ── Retrieval: only what is enabled, connectors read-only and unattended ──────

function fakeSession(calls: string[], opts: { refuse?: boolean; writes?: boolean } = {}): ConnectorSession {
  return {
    isRead: (tool) => opts.writes !== true && /list_events|search_messages|read_message/.test(tool),
    async call(tool, args) {
      calls.push(`${tool} ${JSON.stringify(args)}`);
      if (opts.refuse) return { ok: false, body: "" };
      if (tool.endsWith("list_events")) {
        return {
          ok: true,
          body: "• Copilot renewal call — 2026-10-02T09:00+00:00 → 10:00 · calendar: Work · uid: ev-1\n• Dentist — 2026-10-03 (all day) · calendar: Home · uid: ev-2",
        };
      }
      if (tool.endsWith("search_messages")) {
        return { ok: true, body: "• [INBOX · uid 42] Copilot seat quote — from sales@x.example · 2026-09-12T10:15+00:00" };
      }
      return { ok: true, body: "Subject: Copilot seat quote\n\nThe quote is 39 per seat per month." };
    },
    async close() {
      calls.push("close");
    },
  };
}

test("retrieval searches only the enabled options, and connectors only through read tools", async () => {
  const asked: string[] = [];
  const calls: string[] = [];
  const result = await searchPrivateSourcesWith(
    {
      async chatFiles({ query }) {
        asked.push(`file:${query}`);
        return [{ documentId: "d1", fileName: "Tooling.pdf", ordinal: 0, text: "Copilot seats: 50.", locator: "page 1" }];
      },
      async library({ query }) {
        asked.push(`library:${query}`);
        return [];
      },
      async memory() {
        asked.push("memory");
        return ["Works at a 50-person startup"];
      },
      async openConnector({ connectorId }) {
        asked.push(`connector:${connectorId}`);
        return fakeSession(calls);
      },
      now: () => new Date("2026-10-08T00:00:00Z"),
    },
    {
      userId: "u",
      runId: "r",
      conversationId: "c",
      options: OPTIONS,
      enabled: ["file", "calendar:apple-calendar", "mail:apple-mail"],
      questions: ["What does Copilot cost per seat?"],
    }
  );
  assert.ok(!asked.some((a) => a.startsWith("library") || a === "memory"), "library and memory were not enabled");
  assert.ok(asked.includes("connector:apple-calendar") && asked.includes("connector:apple-mail"));
  assert.ok(calls.every((call) => call === "close" || /__(list_events|search_messages|read_message) /.test(call)), calls.join("\n"));
  assert.equal(calls.filter((c) => c === "close").length, 2, "every session is closed");
  const kinds = result.hits.map((hit) => hit.kind).sort();
  assert.deepEqual(kinds, ["calendar", "file", "mail"], "the dentist is not about the question and is left out");
  const mail = result.hits.find((hit) => hit.kind === "mail")!;
  assert.equal(mail.title, "Copilot seat quote — 2026-09-12");
  assert.match(mail.text, /39 per seat/);
  assert.deepEqual(result.skipped, []);
});

test("a connector the approval policy refuses, or with no read tool, is skipped and said so", async () => {
  const calls: string[] = [];
  const refused = await searchPrivateSourcesWith(
    { openConnector: async () => fakeSession(calls, { refuse: true }) },
    { userId: "u", runId: "r", conversationId: null, options: OPTIONS, enabled: ["calendar:apple-calendar"], questions: ["Copilot renewal"] }
  );
  assert.equal(refused.hits.length, 0);
  assert.match(refused.skipped[0]!.reason, /approval settings/);
  const noRead = await searchPrivateSourcesWith(
    { openConnector: async () => fakeSession(calls, { writes: true }) },
    { userId: "u", runId: "r", conversationId: null, options: OPTIONS, enabled: ["mail:apple-mail"], questions: ["Copilot renewal"] }
  );
  assert.equal(noRead.hits.length, 0);
  assert.ok(!calls.some((call) => call.includes("apple-mail")), "no tool was called when no read tool exists");
});

// ── End to end, offline ──────────────────────────────────────────────────────

function privateHit(): PrivateResearchHit {
  return {
    url: privateSourceUrl({ kind: "file", id: "doc-renewal", locator: "page 1" }),
    title: "Acme renewal quote.pdf · page 1",
    text: PRIVATE_TEXT,
    kind: "file",
    optionKey: "file",
    publishedAt: new Date("2026-09-12T00:00:00Z"),
  };
}

function withOwnSources(deps: ResearchDeps, seen: { searched: string[][]; enabled: string[][] }): ResearchDeps {
  return {
    ...deps,
    async privateSourceOptions() {
      return OPTIONS;
    },
    async searchPrivate(input) {
      seen.searched.push(input.questions);
      seen.enabled.push(input.options.map((option) => option.key));
      return { hits: [privateHit()], skipped: [] };
    },
  };
}

test("end to end: own sources are read first, cited like pages, never fetched, and nothing private is searched for", async () => {
  const { store, sources, events } = memoryStore();
  const { deps, trace } = scenarioDeps(store);
  const seen = { searched: [] as string[][], enabled: [] as string[][] };
  const workerQueries: string[] = [];
  const engine = createResearchEngine({
    ...withOwnSources(deps, seen),
    async runWorker(input) {
      // A worker that read the private quote and then tries to search for its details.
      const own = input.brief.visited.find(isPrivateSourceUrl);
      assert.ok(own, "the worker brief lists the person's own sources");
      const opened = await input.tools.openPage(own!);
      assert.equal(opened.result.ok, true, JSON.stringify(opened.result));
      const noted = await input.tools.noteFinding({ claim: "Acme pays 48,000 a year.", quote: "Acme Widgets will pay 48,000 per year", url: own! });
      assert.equal(noted.result.ok, true, JSON.stringify(noted.result));
      for (const query of ["Jane Hollingsworth Acme Widgets", "Acme Widgets GitHub Copilot pricing per seat"]) {
        workerQueries.push(query);
        await input.tools.search(query);
      }
      return { summary: "done", openQuestions: [], followUps: [], tokens: 10, costMicroUsd: 10, reason: "done", toolCalls: 4, elapsedMs: 1 };
    },
  });
  const run = await engine.start({ userId: "u", goal: SCENARIO_GOAL, conversationId: "c1", confirmation: "auto", effort: "standard" });
  assert.deepEqual(parsePlan(run.plan).sources?.enabled, ["file", "project"], "the run starts with the defaults on");
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.ok(done && ["completed", "partially_completed"].includes(done.state), String(done?.error));

  assert.deepEqual(seen.enabled[0], ["file", "project"], "only enabled options reach the retriever");
  assert.ok(seen.searched[0]!.includes(SCENARIO_GOAL), "the private search asks the question itself");
  const stored = sources.find((source) => isPrivateSourceUrl(source.url));
  assert.ok(stored?.snapshot?.includes("48,000"), "the private passage is a source with its text");
  assert.ok(!trace.fetched.some(isPrivateSourceUrl), "a private address is never fetched");

  const sent = trace.searches.map((s) => s.query.toLowerCase());
  for (const secret of ["hollingsworth", "acme", "widgets", "seats under contract"]) {
    assert.ok(!sent.some((query) => query.includes(secret)), `a web query carried "${secret}": ${sent.join(" | ")}`);
  }
  assert.ok(events.some((e) => e.kind === "source_read" && (e.payload as { private?: string }).private === "file"));
  assert.ok(
    events.some((e) => e.kind === "query_issued" && (e.payload as { sanitised?: boolean }).sanitised === true),
    "a cleaned query says so on the timeline"
  );

  // The writer sees it labelled PRIVATE; the completion keeps its snippet out of the message.
  const corpus = buildResearchCorpus(SCENARIO_GOAL, parsePlan(done!.plan), sources.filter((s) => s.snapshot));
  assert.match(corpus, /PRIVATE — the person's own file in this chat, page 1/);
  const ordered = orderCompletionSources({
    corpus: [{ id: "s1", title: stored!.title, url: stored!.url, snapshot: stored!.snapshot }],
    summary: "Acme pays 48,000 [1].",
    report: "x",
  });
  assert.equal(ordered.sources[0]!.snippet, "", "a private source's text is not copied into the message");
  assert.ok(ordered.sources[0]!.url.startsWith("https://"), "the chat wire still carries an https URL (shipped native decoders require one)");
});

test("end to end: with the web switched off at the gate, no web search is made at all", async () => {
  const { store } = memoryStore();
  const { deps, trace } = scenarioDeps(store);
  const seen = { searched: [] as string[][], enabled: [] as string[][] };
  const engine = createResearchEngine({
    ...withOwnSources(deps, seen),
    async runWorker(input) {
      const found = await input.tools.search("GitHub Copilot pricing");
      assert.equal(found.result.hits.length, 0);
      assert.match(found.result.note ?? "", /switched off/);
      return { summary: "done", openQuestions: [], followUps: [], tokens: 10, costMicroUsd: 10, reason: "done", toolCalls: 1, elapsedMs: 1 };
    },
  });
  const run = await engine.start({ userId: "u", goal: SCENARIO_GOAL, conversationId: "c1", confirmation: "required", effort: "standard" });
  const parked = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(parked?.state, "awaiting_plan_confirmation");
  const decided = await engine.decidePlan({
    runId: run.id,
    userId: "u",
    decision: "confirm",
    sources: { web: false, enabled: ["file", "library", "forged:key"] },
  });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  const confirmed = parsePlan((await store.loadRun(run.id, "u"))!.plan);
  assert.equal(confirmed.sources?.web, false);
  assert.deepEqual(confirmed.sources?.enabled, ["file", "library"], "a forged key is not enabled");
  await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(trace.searches.length, 0, `searched: ${trace.searches.map((s) => s.query).join(", ")}`);
  assert.deepEqual(seen.enabled[0], ["file", "library"]);
});

test("the report's sources: private rows keep their place in citation order and show whose they are", () => {
  const file = privateSourceUrl({ kind: "file", id: "d1", locator: "page 1" });
  const sections = sourceSections(
    [
      { id: "a", url: "https://docs.github.com/copilot", title: "Copilot plans", read: true } as never,
      { id: "b", url: file, title: "Plan.pdf · page 1", read: true } as never,
    ],
    [
      { url: "https://docs.github.com/copilot", title: "Copilot plans" },
      { url: file, title: "Plan.pdf · page 1" },
    ],
    new Set([1, 2])
  );
  assert.deepEqual(sections.cited.map((row) => [row.cited, row.domain]), [[1, "docs.github.com"], [2, "Your files"]]);
});
