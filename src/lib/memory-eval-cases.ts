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
