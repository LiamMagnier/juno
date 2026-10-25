/*
 * Fixtures for the memory evaluation suite (memory-eval.ts) beyond the recall
 * benchmark's histories: corrections, near-duplicates, scope readers,
 * sensitive statements. Hand-written, each with the answer a careful person
 * would give, and several the rules are EXPECTED to get wrong are kept in —
 * a suite that only contains what the code handles measures nothing.
 */

import type { AgentMemoryAccess } from "@/lib/memory-scope";

// ---------------------------------------------------------------------------
// Corrections and contradictions
// ---------------------------------------------------------------------------

export interface CorrectionStep {
  content: string;
  source?: "AUTO" | "MANUAL";
  projectId?: string | null;
  /** ISO time it was said. */
  at: string;
}

export interface CorrectionCase {
  id: string;
  /** What the case exercises. */
  kind: "correction" | "contradiction" | "transition" | "keep-both";
  steps: CorrectionStep[];
  /** Read in this order as well as the order said (re-reading is newest first). */
  believed: string[];
  notBelieved: string[];
}

export const CORRECTION_CASES: CorrectionCase[] = [
  {
    id: "answer-length",
    kind: "contradiction",
    steps: [
      { content: "The user prefers short answers with examples.", at: "2026-01-10T10:00:00Z" },
      { content: "The user prefers detailed answers with sources.", at: "2026-06-10T10:00:00Z" },
    ],
    believed: ["The user prefers detailed answers with sources."],
    notBelieved: ["The user prefers short answers with examples."],
  },
  {
    id: "register",
    kind: "contradiction",
    steps: [
      { content: "The user likes formal replies.", at: "2026-01-10T10:00:00Z" },
      { content: "The user prefers casual, conversational replies.", at: "2026-03-10T10:00:00Z" },
    ],
    believed: ["The user prefers casual, conversational replies."],
    notBelieved: ["The user likes formal replies."],
  },
  {
    id: "no-longer-employer",
    kind: "correction",
    steps: [
      { content: "The user works at Initech.", at: "2026-01-10T10:00:00Z" },
      { content: "The user no longer works at Initech.", at: "2026-04-10T10:00:00Z" },
    ],
    believed: ["The user no longer works at Initech."],
    notBelieved: ["The user works at Initech."],
  },
  {
    id: "no-longer-vegetarian",
    kind: "correction",
    steps: [
      { content: "The user is vegetarian.", at: "2026-01-10T10:00:00Z" },
      { content: "Actually, the user is no longer vegetarian.", at: "2026-05-10T10:00:00Z" },
    ],
    believed: ["Actually, the user is no longer vegetarian."],
    notBelieved: ["The user is vegetarian."],
  },
  {
    id: "moved-city",
    kind: "contradiction",
    steps: [
      { content: "The user lives in Leeds.", at: "2026-01-10T10:00:00Z" },
      { content: "The user lives in York.", at: "2026-07-10T10:00:00Z" },
    ],
    believed: ["The user lives in York."],
    notBelieved: ["The user lives in Leeds."],
  },
  {
    id: "typed-beats-inferred",
    kind: "correction",
    steps: [
      { content: "The user lives in Porto.", source: "MANUAL", at: "2026-01-10T10:00:00Z" },
      { content: "The user lives in Lisbon.", at: "2026-02-10T10:00:00Z" },
    ],
    believed: ["The user lives in Porto."],
    notBelieved: ["The user lives in Lisbon."],
  },
  {
    id: "job-search-ends",
    kind: "transition",
    steps: [
      { content: "The user is looking for a new job.", at: "2026-02-01T10:00:00Z" },
      { content: "The user works at Hooli.", at: "2026-06-01T10:00:00Z" },
    ],
    believed: ["The user works at Hooli."],
    notBelieved: ["The user is looking for a new job."],
  },
  {
    id: "graduated",
    kind: "transition",
    steps: [
      { content: "The user studies computer science at Leeds University.", at: "2025-10-01T10:00:00Z" },
      { content: "The user graduated in July.", at: "2026-07-20T10:00:00Z" },
    ],
    believed: ["The user graduated in July."],
    notBelieved: ["The user studies computer science at Leeds University."],
  },
  {
    id: "old-employer-before-search",
    kind: "transition",
    // A job held BEFORE the search does not end it.
    steps: [
      { content: "The user works at Initech.", at: "2026-01-01T10:00:00Z" },
      { content: "The user is looking for a new job.", at: "2026-02-01T10:00:00Z" },
    ],
    believed: ["The user works at Initech.", "The user is looking for a new job."],
    notBelieved: [],
  },
  {
    id: "two-languages",
    kind: "keep-both",
    steps: [
      { content: "The user is learning Spanish.", at: "2026-01-10T10:00:00Z" },
      { content: "The user is learning Japanese.", at: "2026-03-10T10:00:00Z" },
    ],
    believed: ["The user is learning Spanish.", "The user is learning Japanese."],
    notBelieved: [],
  },
  {
    id: "sister-city",
    kind: "keep-both",
    steps: [
      { content: "The user lives in Rotterdam.", at: "2026-01-10T10:00:00Z" },
      { content: "The user's sister lives in Utrecht.", at: "2026-03-10T10:00:00Z" },
    ],
    believed: ["The user lives in Rotterdam.", "The user's sister lives in Utrecht."],
    notBelieved: [],
  },
  {
    id: "additive-answer-prefs",
    kind: "keep-both",
    steps: [
      { content: "The user prefers short answers.", at: "2026-01-10T10:00:00Z" },
      { content: "The user prefers answers with code examples.", at: "2026-03-10T10:00:00Z" },
    ],
    believed: ["The user prefers short answers.", "The user prefers answers with code examples."],
    notBelieved: [],
  },
  {
    id: "sister-graduated",
    kind: "keep-both",
    steps: [
      { content: "The user studies law at Bristol University.", at: "2025-10-01T10:00:00Z" },
      { content: "The user's sister graduated last month.", at: "2026-03-10T10:00:00Z" },
    ],
    believed: ["The user studies law at Bristol University.", "The user's sister graduated last month."],
    notBelieved: [],
  },
  {
    id: "denial-other-value",
    kind: "keep-both",
    steps: [
      { content: "The user works at Hooli.", at: "2026-06-10T10:00:00Z" },
      { content: "The user no longer works at Initech.", at: "2026-06-11T10:00:00Z" },
    ],
    believed: ["The user works at Hooli.", "The user no longer works at Initech."],
    notBelieved: [],
  },
  {
    // Known gap, kept in: no rule connects a pet's death to "has a dog".
    id: "pet-died",
    kind: "correction",
    steps: [
      { content: "The user has a dog called Biscuit.", at: "2026-01-10T10:00:00Z" },
      { content: "The user's dog Biscuit died in May.", at: "2026-05-20T10:00:00Z" },
    ],
    believed: ["The user's dog Biscuit died in May."],
    notBelieved: ["The user has a dog called Biscuit."],
  },
];

// ---------------------------------------------------------------------------
// Near-duplicates (consolidation)
// ---------------------------------------------------------------------------

export const DUPLICATE_PAIRS: { a: string; b: string; same: boolean }[] = [
  { a: "The user prefers short answers with examples.", b: "The user prefers short answers, with examples please.", same: true },
  { a: "The user writes services in Go.", b: "The user writes their services in Go.", same: true },
  { a: "The user uses pnpm for JavaScript projects.", b: "The user uses pnpm for JavaScript projects mostly.", same: true },
  { a: "The user has a cat named Miso.", b: "The user has a cat called Miso.", same: true },
  { a: "The user has 2 cats.", b: "The user has 3 cats.", same: false },
  { a: "The user is learning Spanish.", b: "The user is learning Japanese.", same: false },
  { a: "The user lives in Madrid.", b: "The user lives in Valencia.", same: false },
  { a: "The user prefers dark mode in editors.", b: "The user prefers light mode in editors.", same: false },
  { a: "The user runs on Mondays.", b: "The user swims on Mondays.", same: false },
];

// ---------------------------------------------------------------------------
// Scope readers
// ---------------------------------------------------------------------------

export type ScopeReaderId =
  | "A:account"
  | "A:project-p1"
  | "A:project-p2"
  | "A:agent-profile"
  | "A:agent-none"
  | "A:agent-full-p1"
  | "B:project-p1";

export interface ScopeReaderSpec {
  id: ScopeReaderId;
  userId: string;
  projectId: string | null;
  agent?: { access: AgentMemoryAccess };
}

export const SCOPE_READERS: ScopeReaderSpec[] = [
  { id: "A:account", userId: "A", projectId: null },
  { id: "A:project-p1", userId: "A", projectId: "p1" },
  { id: "A:project-p2", userId: "A", projectId: "p2" },
  { id: "A:agent-profile", userId: "A", projectId: null, agent: { access: "profile" } },
  { id: "A:agent-none", userId: "A", projectId: null, agent: { access: "none" } },
  { id: "A:agent-full-p1", userId: "A", projectId: "p1", agent: { access: "full" } },
  // B is a member of A's shared project p1.
  { id: "B:project-p1", userId: "B", projectId: "p1" },
];

export interface ScopeFact {
  userId: string;
  projectId: string | null;
  content: string;
  /** The readers allowed to see it. Everyone else seeing it is a leak. */
  readers: ScopeReaderId[];
}

export const SCOPE_FACTS: ScopeFact[] = [
  { userId: "A", projectId: null, content: "The user prefers concise answers.", readers: ["A:account", "A:agent-profile"] },
  { userId: "A", projectId: null, content: "The user writes code in TypeScript.", readers: ["A:account", "A:agent-profile"] },
  { userId: "A", projectId: null, content: "The user lives in Bristol.", readers: ["A:account", "A:agent-profile"] },
  { userId: "A", projectId: null, content: "The user's partner is called Sam.", readers: ["A:account"] },
  { userId: "A", projectId: null, content: "The user was diagnosed with ADHD.", readers: ["A:account"] },
  { userId: "A", projectId: null, content: "The user is studying for a law degree.", readers: ["A:account"] },
  { userId: "A", projectId: null, content: "The user has a dentist appointment tomorrow.", readers: ["A:account"] },
  { userId: "A", projectId: "p1", content: "The launch site uses Astro.", readers: ["A:project-p1", "A:agent-full-p1"] },
  { userId: "A", projectId: "p1", content: "The launch date is the first of December.", readers: ["A:project-p1", "A:agent-full-p1"] },
  { userId: "A", projectId: "p2", content: "The thesis is about urban heat islands.", readers: ["A:project-p2"] },
  { userId: "B", projectId: null, content: "The user is pregnant.", readers: [] },
  { userId: "B", projectId: null, content: "The user prefers bullet points.", readers: [] },
  { userId: "B", projectId: "p1", content: "The user owns the analytics dashboard for the launch.", readers: ["B:project-p1"] },
];

/** Queries each reader asks; every fact is eligible by wording so only scope decides. */
export const SCOPE_QUERIES = [
  "What do you know about me and the launch?",
  "answers code lives partner diagnosed studying dentist launch thesis pregnant bullet analytics",
];

// ---------------------------------------------------------------------------
// Sensitive statements
// ---------------------------------------------------------------------------

export const SENSITIVE_STATEMENTS: { content: string; topic: string }[] = [
  { content: "The user was diagnosed with type 2 diabetes.", topic: "health" },
  { content: "The user takes sertraline for depression.", topic: "health" },
  { content: "The user is pregnant with their second child.", topic: "health" },
  { content: "The user is Muslim and prays five times a day.", topic: "religion" },
  { content: "The user is a practising Catholic.", topic: "religion" },
  { content: "The user votes Labour.", topic: "politics" },
  { content: "The user is a member of the Green Party.", topic: "politics" },
  { content: "The user is gay.", topic: "sexuality" },
  { content: "The user is transgender.", topic: "sexuality" },
  { content: "The user is Black British.", topic: "ethnicity" },
  { content: "The user has £30,000 of credit card debt.", topic: "finances" },
  { content: "The user's salary is $140,000 a year.", topic: "finances" },
];

export const BENIGN_NEAR_MISSES: string[] = [
  "The user prefers short answers.",
  "The user is training for a half marathon.",
  "The user works on a healthcare scheduling app.",
  "The user is building a budgeting spreadsheet for a client.",
  "The user follows politics podcasts for work research.",
  "The user writes a newsletter about church architecture.",
  "The user lives in Manchester.",
  "The user uses Neovim as their main editor.",
  "The user is learning Japanese.",
  "The user has a cat named Miso.",
];

// ---------------------------------------------------------------------------
// Inappropriate personalisation (brief §10.3)
// ---------------------------------------------------------------------------

/**
 * One person's memory, mixing ordinary facts with sensitive ones and facts on
 * topics they later excluded. `topic` is the sensitive topic a fact falls
 * under; `excluded` marks a fact on an excluded topic.
 */
export const PERSONALISATION_FACTS: {
  id: string;
  content: string;
  source: "AUTO" | "MANUAL";
  topic?: string;
  excluded?: boolean;
}[] = [
  { id: "name", content: "The user is called Sam.", source: "AUTO" },
  { id: "city", content: "The user lives in Porto.", source: "AUTO" },
  { id: "style", content: "The user prefers short answers.", source: "AUTO" },
  { id: "job", content: "The user works at Hooli as a data engineer.", source: "AUTO" },
  { id: "diabetes", content: "The user has type 1 diabetes.", source: "AUTO", topic: "health" },
  { id: "catholic", content: "The user is a practising Catholic.", source: "AUTO", topic: "religion" },
  { id: "bi", content: "The user is bisexual.", source: "AUTO", topic: "sexuality" },
  { id: "debt", content: "The user is in debt after a failed startup.", source: "AUTO", topic: "finances" },
  { id: "insulin-typed", content: "The user takes insulin before meals.", source: "MANUAL", topic: "health" },
  { id: "divorce", content: "The user is going through a divorce.", source: "AUTO", excluded: true },
  { id: "ex", content: "The user's ex-wife lives in Leeds.", source: "AUTO", excluded: true },
];

/** The person's own exclusions, as stored. */
export const PERSONALISATION_EXCLUSIONS = ["Anything about my divorce", "Anything about my ex"];

/** Messages no sensitive fact has any business answering. */
export const PERSONALISATION_OFF_TOPIC = [
  "What is 17 times 23?",
  "Explain how a hash map handles collisions.",
  "Draft a polite email declining a meeting.",
  "Who am I and how do I like my answers?",
  "Recommend a podcast for my commute.",
  "thanks!",
];

/** Messages ABOUT a sensitive fact: with the topic allowed, using it is the point. */
export const PERSONALISATION_RELEVANT: { query: string; expect: string; topic: string }[] = [
  { query: "What should I eat before a long run, given my diabetes?", expect: "diabetes", topic: "health" },
  { query: "Is there a Catholic church near Porto with an English mass?", expect: "catholic", topic: "religion" },
  { query: "How do I make a plan to pay off the debt from my failed startup?", expect: "debt", topic: "finances" },
];

/** Messages about an excluded topic: nothing on it may be used, however direct the question. */
export const PERSONALISATION_EXCLUDED_QUERIES = [
  "Help me write to my ex about the divorce papers.",
  "Remind me what you know about my divorce.",
];

// ---------------------------------------------------------------------------
// Manual corrections — the person's own hand on the timeline
// ---------------------------------------------------------------------------

export interface ManualCorrectionCase {
  id: string;
  /** Already stored, oldest first: [content, source, projectId?, status?]. */
  stored: { content: string; source: "AUTO" | "MANUAL"; projectId?: string | null; status?: string }[];
  /** What the person typed (account scope unless `projectId`). */
  typed: string;
  projectId?: string | null;
  believed: string[];
  notBelieved: string[];
}

export const MANUAL_CORRECTION_CASES: ManualCorrectionCase[] = [
  {
    id: "moved-city",
    stored: [{ content: "The user lives in Lisbon.", source: "AUTO" }],
    typed: "The user lives in Porto.",
    believed: ["The user lives in Porto."],
    notBelieved: ["The user lives in Lisbon."],
  },
  {
    id: "new-employer",
    stored: [{ content: "The user works at Initech.", source: "AUTO" }],
    typed: "The user works at Hooli.",
    believed: ["The user works at Hooli."],
    notBelieved: ["The user works at Initech."],
  },
  {
    id: "name",
    stored: [{ content: "The user is called Samuel.", source: "AUTO" }],
    typed: "The user goes by Sam.",
    believed: ["The user goes by Sam."],
    notBelieved: ["The user is called Samuel."],
  },
  {
    id: "answer-length",
    stored: [{ content: "The user prefers detailed answers.", source: "AUTO" }],
    typed: "The user prefers short answers.",
    believed: ["The user prefers short answers."],
    notBelieved: ["The user prefers detailed answers."],
  },
  {
    id: "job-search-ends",
    stored: [{ content: "The user is looking for a new job.", source: "AUTO" }],
    typed: "The user works at Hooli.",
    believed: ["The user works at Hooli."],
    notBelieved: ["The user is looking for a new job."],
  },
  {
    id: "typed-over-typed",
    stored: [{ content: "The user lives in Lisbon.", source: "MANUAL" }],
    typed: "The user lives in Porto.",
    believed: ["The user lives in Porto."],
    notBelieved: ["The user lives in Lisbon."],
  },
  {
    id: "two-stale-values",
    // Older data: two cities believed at once. The typed one settles both.
    stored: [
      { content: "The user lives in Lisbon.", source: "AUTO" },
      { content: "The user lives in Madrid.", source: "AUTO" },
    ],
    typed: "The user lives in Porto.",
    believed: ["The user lives in Porto."],
    notBelieved: ["The user lives in Lisbon.", "The user lives in Madrid."],
  },
  {
    id: "keep-both-languages",
    stored: [{ content: "The user is learning Spanish.", source: "AUTO" }],
    typed: "The user is learning Japanese.",
    believed: ["The user is learning Spanish.", "The user is learning Japanese."],
    notBelieved: [],
  },
  {
    id: "other-scope-untouched",
    stored: [
      { content: "The user works at Acme.", source: "AUTO", projectId: "p1" },
      { content: "The user works at Initech.", source: "AUTO" },
    ],
    typed: "The user works at Hooli.",
    believed: ["The user works at Hooli.", "The user works at Acme."],
    notBelieved: ["The user works at Initech."],
  },
  {
    id: "typed-again-after-replaced",
    stored: [
      { content: "The user lives in Madrid.", source: "AUTO", status: "superseded" },
      { content: "The user lives in Berlin.", source: "AUTO" },
    ],
    typed: "The user lives in Madrid.",
    believed: ["The user lives in Madrid."],
    notBelieved: ["The user lives in Berlin."],
  },
];

/** Typed duplicates: afterwards exactly one believed row may say it. */
export const MANUAL_DUPLICATE_CASES: { stored: string; typed: string }[] = [
  { stored: "The user prefers dark mode.", typed: "The user prefers dark mode" },
  { stored: "The user uses Neovim as their main editor.", typed: "the user uses neovim as their main editor." },
  { stored: "Prefers metric units.", typed: "The user prefers metric units." },
];
