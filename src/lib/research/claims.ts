import "server-only";
import { prisma } from "@/lib/prisma";
import { loadBackgroundProviderPolicy, runUtilityPrompt } from "@/lib/memory";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";
// The judge's caps are cost facts, so they live in domain.ts with the planner's
// and the writer's: the engine has to reserve for this stage before it runs and
// cannot import this module (`server-only`). See the cost section of domain.ts.
import {
  JUDGE_OUTPUT_TOKENS,
  JUDGE_PASSAGE_CHARS,
  MAX_JUDGE_CALLS,
  parsePlan,
} from "@/lib/research/domain";
import {
  auditEvidence,
  detectSyndication,
  extractEventDate,
  hostOfUrl,
  repairReportFromClaims,
  scoreSource,
  sourceTypeOf,
  splitPassages,
  supportLabel,
  supportingPassageDifference,
  type AuditReason,
  type CitationJudge,
  type ClaimStatus,
  type ClaimType,
  type JudgeVerdict,
  type LinkStance,
  type LinkVerdict,
  type PassageDraft,
  type RepairableClaim,
  type SupportLabel,
} from "@/lib/research/claim-analysis";
import {
  auditClaims,
  disagreesForSamePeriod,
  disputesFigure,
  figureFromAnotherPeriod,
  readAuditReceipt,
  selectClaimsForAudit,
} from "@/lib/research/citation-audit-core";
import {
  isPreviewOnly,
  isSourceReadState,
  openedUrlsFrom,
  sourceReadState,
  type SourceReadState,
} from "@/lib/research/source-provenance";

/**
 * The claim graph and citation validator (program §8.3), server side.
 *
 * What this owns: turning a finished research report into ResearchClaim /
 * ResearchPassage / ResearchClaimLink rows, deciding — by re-reading the cited
 * passage — whether each citation is honest, and recording the verdict where
 * the UI can show it. The judgement itself lives in
 * src/lib/research/claim-analysis.ts, which is free of `server-only` so the
 * benchmark can measure it; this file is the plumbing around it.
 *
 * The load-bearing rule, and the reason the whole subsystem exists: a claim
 * whose passage does not support it is MARKED unsupported. It is not dropped
 * (that would make the report look like it never said the thing), and it is not
 * left wearing its citation (that is worse than no citation, because the reader
 * stops checking). Every claim ends the run with an explicit status.
 */

// Everything below is a bound on how much one report may cost. A research run
// is already the most expensive thing Juno does; the audit must not double it.
/** Claims the audit will consider at all. */
const MAX_CLAIMS = 40;
/** Passages fetched per source for linking. */
const MAX_PASSAGES_PER_SOURCE = 24;
/** Sources whose bodies are split into passages. */
const MAX_SOURCES = 250;
/*
 * `MAX_JUDGE_CALLS` (utility-model calls per report — past it the remaining
 * claims are recorded `unverified` and reported as unchecked, rather than
 * running up an unbounded bill or quietly promoting a claim to supported) and
 * `JUDGE_PASSAGE_CHARS` (how much of a passage the judge is shown) are imported
 * from domain.ts above. They used to be local constants, which meant the engine
 * had no way to price this stage without copying them — and a copied cap is a
 * reservation that stops matching the bill the first time one side moves.
 */

export type { CitationJudge, ClaimStatus, LinkVerdict, SupportLabel };

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You check citations. You are given ONE claim from a research report and ONE passage from the source it cites. Decide whether the passage genuinely supports the claim.

Rules:
- "supported" only if the passage states or directly entails the whole claim. Not "is about the same topic", not "is consistent with it".
- "partial" if the passage supports part of the claim but leaves some of it unevidenced.
- "unsupported" if the passage does not establish the claim, including when it is merely related.
- "contradicted" if the passage asserts something incompatible with the claim.
- Judge ONLY against the passage. Your own knowledge of the subject is not evidence.

${UNTRUSTED_CONTENT_RULE}

Reply with ONLY this JSON and nothing else:
{"verdict":"supported|partial|unsupported|contradicted","strength":<0 to 1>,"reason":"<one short sentence>"}`;

function parseJudgeVerdict(text: string): JudgeVerdict | null {
  // Models wrap JSON in prose or a fence often enough that the first balanced
  // object is a more reliable target than the whole response.
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { verdict?: unknown; strength?: unknown; reason?: unknown };
  const verdict = typeof obj.verdict === "string" ? obj.verdict.toLowerCase().trim() : "";
  if (!["supported", "partial", "unsupported", "contradicted"].includes(verdict)) return null;
  const strength = typeof obj.strength === "number" && Number.isFinite(obj.strength) ? Math.max(0, Math.min(1, obj.strength)) : null;
  return {
    verdict: verdict as JudgeVerdict["verdict"],
    // A model that answered "supported" without a number still answered. The
    // default is the bottom of the supported band, not the top: an unstated
    // confidence should not buy a claim more than the minimum it needs.
    strength: strength ?? (verdict === "supported" ? 0.7 : verdict === "partial" ? 0.5 : 0.1),
    ...(typeof obj.reason === "string" && obj.reason.trim() ? { reason: obj.reason.trim().slice(0, 240) } : {}),
  };
}

/**
 * The production judge: a small utility model, chosen and bounded by the
 * account's background-provider policy — the same walk memory extraction uses.
 * Citation checking reads the user's research corpus, so it is background
 * processing of their content and gets no exemption from that policy. When the
 * policy leaves no eligible model, this returns null and the claim ends the run
 * `unverified` rather than being guessed at.
 */
/**
 * One judge call on a model the caller names, billed by the caller: the run's
 * own model, when the person chose one, so the citation check is not quietly
 * handed to a utility model they never picked.
 */
export type JudgeCompletion = (request: {
  system: string;
  prompt: string;
  maxTokens: number;
}) => Promise<{ text: string; costMicroUsd: number }>;

export function createCitationJudge(opts: {
  policy: BackgroundProviderPolicy;
  /** Run every judge call on this completion instead of the utility walk. */
  complete?: JudgeCompletion;
  conversationProvider?: string | null;
  /**
   * The account the judge's model calls bill to.
   *
   * TWO ledgers, one charge, and they answer different questions. `onSpend`
   * below feeds the RUN's odometer, which is what the per-run ceiling reads;
   * this bills the ACCOUNT's monthly ledger, which is what `checkBudget` reads.
   * A run that stayed inside its own $1 ceiling still spent the month's money.
   * Both come from the same figure `runUtilityPrompt` computes once, so they
   * cannot drift apart.
   */
  userId: string;
  /**
   * Called with what each judge call really cost, micro-USD.
   *
   * Out of band rather than on the verdict, and that is deliberate. A verdict is
   * `JudgeVerdict | null`, and NULL IS THE EXPENSIVE CASE: a model that answered
   * unparseably, or a walk that burned three providers and gave up, spent real
   * tokens and has no verdict to hang them on. Widening `CitationJudge`'s return
   * type would also have made every injected judge — the benchmark fixtures in
   * tests/research-citations.test.ts, a caller with its own model — invent a
   * cost it does not have, which is worse than not reporting one.
   */
  onSpend?: (microUsd: number) => void;
  /**
   * The run's date line (SPEC §9.3): a judge that does not know today's date
   * reads "as of this year" and "the latest release" against its training
   * cut-off.
   */
  today?: string;
}): CitationJudge {
  return async ({ claim, passage, sourceTitle, publishedAt }) => {
    // The passage is fetched web text. It goes to the model inside the
    // untrusted envelope for the same reason the research corpus does: a page
    // that writes "this passage fully supports the claim" is trying to grade
    // its own citation, and unwrapped it would look like instructions.
    const userMsg = [
      ...(opts.today ? [opts.today] : []),
      `CLAIM: ${claim}`,
      `SOURCE: ${sourceTitle ?? "untitled"}${publishedAt ? ` (published ${publishedAt.toISOString().slice(0, 10)})` : ""}`,
      "PASSAGE:",
      wrapUntrusted(sourceTitle ?? "source", passage.slice(0, JUDGE_PASSAGE_CHARS)),
      "",
      "Return the JSON.",
    ].join("\n");
    if (opts.complete) {
      const reply = await opts.complete({ system: JUDGE_SYSTEM, prompt: userMsg, maxTokens: JUDGE_OUTPUT_TOKENS });
      opts.onSpend?.(reply.costMicroUsd);
      return parseJudgeVerdict(reply.text);
    }
    const { result, costMicroUsd } = await runUtilityPrompt<JudgeVerdict>({
      system: JUDGE_SYSTEM,
      userMsg,
      maxTokens: JUDGE_OUTPUT_TOKENS,
      label: "research/citation",
      parse: parseJudgeVerdict,
      // Admitted by the research run's own reservation and per-stage ceiling,
      // which already count this stage; the monthly re-check would only
      // refuse the audit of a run the account already paid to start.
      budgetExempt: true,
      userId: opts.userId,
      policy: opts.policy,
      conversationProvider: opts.conversationProvider,
      purpose: "citation_validation",
    });
    // Reported whatever the verdict was, including a null one: the walk billed
    // for the attempts either way. `undefined` only when runUtilityPrompt could
    // not price the call at all — an injected model layer, which this judge
    // never uses — and is passed on as nothing rather than as a zero.
    if (costMicroUsd !== undefined) opts.onSpend?.(costMicroUsd);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Building and validating the graph
// ---------------------------------------------------------------------------

/** One numbered source from the report's corpus, in citation order. */
export interface ResearchCorpusSource {
  /** Existing source row when the audit belongs to a durable research run. */
  sourceId?: string;
  url: string;
  title: string;
  /** The text the model was actually shown — the thing a citation points at. */
  body: string;
  /** As claimed by the source. Distinct from the date of the event it describes. */
  publishedAt?: Date | null;
  /**
   * True when `body` is only a search snippet rather than the page. It changes
   * what a failed check MEANS: a claim we could not confirm against two
   * sentences of preview text has not been shown to be unsupported, it has not
   * been checked, and printing "unsupported" there is an accusation the
   * evidence does not carry.
   */
  truncated?: boolean;
  /**
   * How `body` was obtained — opened by the run, supplied by the search
   * provider, or a preview (source-provenance.ts). Absent: derived from the
   * run's event log when the audit belongs to a run, unknown otherwise. A
   * `search_preview` is treated as `truncated`.
   */
  readState?: SourceReadState | null;
}

export interface CitationAuditSummary {
  runId: string;
  claims: number;
  supported: number;
  partiallySupported: number;
  unsupported: number;
  contradicted: number;
  /** Claims no model got to — the budget ran out, or no provider was allowed. */
  unverified: number;
  /** Sources found to be syndicated copies of another source in the run. */
  duplicateSources: number;
  /**
   * Supported claims that other evidence in the corpus disagrees with: a
   * cited passage that contradicts them, or an uncited source giving a
   * different figure. Optional because audits recorded before it carry none.
   */
  contested?: number;
  /** Claims carrying a `[n]` that names no source in the corpus. Optional, as above. */
  unresolvedCitations?: number;
}

export interface CitationAuditResult extends CitationAuditSummary {
  /** The report after deterministic honesty repairs. */
  report: string;
  repaired: boolean;
  revision: number;
  /**
   * What the judge calls cost, micro-USD — the whole stage, all claims.
   *
   * Zero when nothing was spent: no judge call was needed, the policy allowed
   * no model, or the caller injected its own judge (whose spend is its own
   * ledger's business, not this function's to guess at). A durable run bills
   * this to its own ledger; the chat route, which audits outside any run
   * budget, is free to ignore it and does.
   */
  costMicroUsd: number;
}

interface StoredSource {
  id: string;
  index: number;
  passages: Array<PassageDraft & { id: string }>;
  title: string;
  url: string;
  publishedAt: Date | null;
  /** Snippet-only: see ResearchCorpusSource.truncated. */
  truncated: boolean;
  /** See ResearchCorpusSource.readState; null when it cannot be known. */
  readState: SourceReadState | null;
}

/**
 * `auditEvidence` for the inspector, which re-derives every link's findings:
 * a passage the checks cannot read shows no findings rather than taking the
 * whole inspector down.
 */
function auditOrNull(opts: Parameters<typeof auditEvidence>[0]): ReturnType<typeof auditEvidence> | null {
  try {
    return auditEvidence(opts);
  } catch {
    return null;
  }
}

/**
 * Persist the corpus, then extract, link and validate the report's claims.
 *
 * Returns null when the report carries no load-bearing claims at all — a
 * one-line answer, or a run that failed before it synthesised anything. Writing
 * an empty run in that case would put a "0 claims checked" badge under answers
 * that were never research reports.
 */
export async function recordCitationAudit(opts: {
  userId: string;
  conversationId?: string | null;
  /** The assistant message the report was delivered as — how the UI finds this. */
  messageId?: string;
  /** Attach the graph to the original durable run; legacy callers may omit it. */
  runId?: string;
  goal: string;
  report: string;
  sources: ResearchCorpusSource[];
  queries?: string[];
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  /** Override the model layer (tests, or a caller with its own judge). */
  judge?: CitationJudge;
  /** Run the default judge on this completion (the run's chosen model), billed here. */
  complete?: JudgeCompletion;
  /**
   * The run's own judge budget, `envelope.judgeCalls` (B22). Absent: the
   * audit-wide `MAX_JUDGE_CALLS`, as for every audit before envelopes.
   */
  maxJudgeCalls?: number;
  /** Claims to extract: the scope's `targetClaims` (10 per question). Absent: `MAX_CLAIMS`. */
  maxClaims?: number;
  /** The run's date line, for the judge (§9.3). */
  today?: string;
  /** When this audit counts as running, for the freshness check. Defaults to now. */
  asOf?: Date;
}): Promise<CitationAuditResult | null> {
  const judgeCap = Math.max(1, Math.floor(opts.maxJudgeCalls ?? MAX_JUDGE_CALLS));
  // Table cells are claims too (comparative and decision matrices); the
  // selection keeps them to a share of the cap so prose is still checked.
  const claims = selectClaimsForAudit(opts.report, opts.maxClaims ?? MAX_CLAIMS);
  if (claims.length === 0 || opts.sources.length === 0) return null;
  // The moment the audit runs: what a present-tense claim is checked against,
  // recorded on the event so the inspector re-derives the same findings.
  const asOf = opts.asOf ?? new Date();

  // The message id is a user-visible foreign key, not a convenience string.
  // Check it before writing any claims so a caller cannot attach an audit to a
  // different account's message (or leave an orphaned graph behind on failure).
  if (opts.messageId) {
    const message = await prisma.message.findFirst({
      where: { id: opts.messageId, conversation: { userId: opts.userId } },
      select: { id: true },
    });
    if (!message) return null;
  }

  const existing = opts.runId
    ? await prisma.researchRun.findFirst({
        where: { id: opts.runId, userId: opts.userId },
        select: { id: true, goal: true, queries: true },
      })
    : null;
  if (opts.runId && !existing) return null;
  const run =
    existing ??
    (await prisma.researchRun.create({
      data: {
        userId: opts.userId,
        conversationId: opts.conversationId ?? null,
        goal: opts.goal.slice(0, 4_000),
        state: "validating_citations",
        queries: opts.queries ?? [],
        report: opts.report,
        startedAt: new Date(),
      },
      select: { id: true, goal: true, queries: true },
    }));

  if (existing) {
    /*
     * ResearchClaim is the graph for the current report, not a second revision
     * history. A durable revise loop audits the same run more than once; leaving
     * the old rows in place would make the inspector count both generations as
     * one answer. The immutable report text and audit summaries remain in
     * ResearchReportRevision, so replacing this current graph does not erase the
     * report history a reader may need.
     */
    await prisma.researchClaim.deleteMany({ where: { runId: run.id, userId: opts.userId } });
  }

  const readStates = await resolveReadStates({ userId: opts.userId, runId: existing ? run.id : null, sources: opts.sources });
  const stored = await storeCorpus({ userId: opts.userId, runId: run.id, sources: opts.sources, readStates });
  const duplicates = await markSyndication({ userId: opts.userId, stored, sources: opts.sources });

  /*
   * What this audit has spent on the model, micro-USD.
   *
   * An injected judge contributes nothing to it on purpose: it is the caller's
   * own model layer and its tokens are billed wherever that caller bills. The
   * alternative — making every injected judge report a cost — would have forced
   * the test fixtures to fabricate money, and a fabricated cost is worse than a
   * missing one when the number's whole job is to be compared with a ceiling.
   */
  let judgeMicroUsd = 0;
  const judge =
    opts.judge ??
    createCitationJudge({
      userId: opts.userId,
      policy: opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId)),
      conversationProvider: opts.conversationProvider,
      ...(opts.complete ? { complete: opts.complete } : {}),
      onSpend: (microUsd) => {
        judgeMicroUsd += microUsd;
      },
      ...(opts.today ? { today: opts.today } : {}),
    });

  /*
   * The decision loop is citation-audit-core.ts — the same function the eval
   * set measures — and nothing in it touches the database. What it returns is
   * persisted below: one claim row per claim, one link row per verdict, and
   * the uncited rivals on the audit event (they are not citations, and a link
   * row would make every reader of `links` count them as one).
   */
  const outcome = await auditClaims({
    claims,
    sources: stored.map((s) => ({
      index: s.index,
      title: s.title,
      url: s.url,
      publishedAt: s.publishedAt,
      passages: s.passages,
      truncated: s.truncated,
    })),
    corpusSize: opts.sources.length,
    judge,
    judgeCap,
    asOf,
  });
  const judgeCalls = outcome.judgeCalls;

  const summary: CitationAuditSummary = {
    runId: run.id,
    claims: outcome.counts.claims,
    supported: outcome.counts.supported,
    partiallySupported: outcome.counts.partiallySupported,
    unsupported: outcome.counts.unsupported,
    contradicted: outcome.counts.contradicted,
    unverified: outcome.counts.unverified,
    duplicateSources: duplicates.size,
    contested: outcome.counts.contested,
    unresolvedCitations: outcome.counts.unresolvedCitations,
  };

  const passageIdOf = new Map<string, string>();
  for (const s of stored) for (const p of s.passages) passageIdOf.set(`${s.index}:${p.ordinal}`, p.id);
  const sourceIdOf = new Map(stored.map((s) => [s.index, s.id]));
  const repairableClaims: RepairableClaim[] = [];
  /** Per claim row: the sources it cited (by id, so a renumbering cannot move them) and the markers that named nothing. */
  const claimCitations: Record<string, { sourceIds: string[]; unresolved: number[] }> = {};
  /** Per claim row: why its checks could not run (`auditError`), for the claims left unverified by an error. */
  const auditErrors: Record<string, string> = {};
  const rivals: Array<{ claimId: string; sourceId: string; passageId: string }> = [];

  for (const claim of outcome.claims) {
    const row = await prisma.researchClaim.create({
      data: {
        userId: opts.userId,
        runId: run.id,
        text: claim.text,
        type: claim.type,
        status: claim.status,
        supportStrength: claim.supportStrength,
        answerSpan: claim.answerSpan,
      },
      select: { id: true },
    });
    for (const link of claim.links) {
      const passageId = passageIdOf.get(`${link.sourceIndex}:${link.ordinal}`);
      if (passageId) await upsertLink(row.id, passageId, link.stance, link.strength);
    }
    if (claim.auditError) auditErrors[row.id] = claim.auditError;
    claimCitations[row.id] = {
      sourceIds: claim.citations.map((n) => sourceIdOf.get(n)).filter((id): id is string => !!id),
      unresolved: claim.unresolvedCitations,
    };
    for (const rival of claim.rivals) {
      const passageId = passageIdOf.get(`${rival.sourceIndex}:${rival.ordinal}`);
      const sourceId = sourceIdOf.get(rival.sourceIndex);
      if (passageId && sourceId) rivals.push({ claimId: row.id, sourceId, passageId });
    }
    repairableClaims.push({
      ...claim,
      status: claim.status,
      supportStrength: claim.supportStrength,
      unresolvedCitations: claim.unresolvedCitations,
      staleSince: claim.staleSince,
    });
  }

  const repaired = repairReportFromClaims(opts.report, repairableClaims);
  // Lock the run while allocating a revision. A retry, a reconnect, or two
  // workers finishing the same run must never both claim revision N. When a
  // repair changes the report, write the delivered draft first and the
  // evidence-backed version second; the inspector can then show exactly what
  // was said before the audit changed it.
  const createRevision = async (report: string, audit: Record<string, unknown>) =>
    prisma.$transaction(async (tx) => {
      await tx.researchRun.update({
        where: { id: run.id, userId: opts.userId },
        data: { updatedAt: new Date() },
        select: { id: true },
      });
      const latest = await tx.researchReportRevision.findFirst({
        where: { runId: run.id, userId: opts.userId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const revision = (latest?.revision ?? 0) + 1;
      await tx.researchReportRevision.create({
        data: {
          userId: opts.userId,
          runId: run.id,
          assistantMessageId: opts.messageId ?? null,
          revision,
          report,
          audit,
        },
      });
      await tx.researchRun.update({
        where: { id: run.id, userId: opts.userId },
        data: {
          report,
          reportRevision: revision,
          ...(opts.messageId ? { assistantMessageId: opts.messageId } : {}),
        },
      });
      return revision;
    });

  const draftRevision = repaired.repaired
    ? await createRevision(opts.report, { phase: "draft" })
    : null;
  const revision = await createRevision(repaired.report, summaryCounts(summary));
  await prisma.researchRun.update({
    where: { id: run.id, userId: opts.userId },
    data: {
      // Legacy callers own their temporary audit run. The original durable
      // run's state is finalized by the engine after this pre-final audit.
      ...(existing ? {} : { state: summary.unverified > 0 ? "partially_completed" : "completed", finishedAt: new Date() }),
    },
  });

  /*
   * The audit's own record. It carries the messageId because that is how the UI
   * finds this run from the answer the reader is looking at — ResearchRun has a
   * conversation, not a message — and the ordered source ids because the
   * citation NUMBERS are a property of the corpus the model was shown, not of
   * any column, and the inspector has to line `[3]` up with the right row.
   */
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [
    {
      kind: "citation_audit",
      payload: {
        ...(opts.messageId ? { messageId: opts.messageId } : {}),
        sourceOrder: stored.map((s) => s.id),
        // Which sources were judged from a search preview rather than the page.
        // Always written, even empty: the inspector reads the ABSENCE of this
        // key as "this audit predates the receipt", so an omitted empty array
        // would make a fully-read corpus indistinguishable from an old one.
        truncatedSources: stored.filter((s) => s.truncated).map((s) => s.id),
        // How each source's text was obtained: opened by the run, supplied by
        // the search provider, a preview, or the person's own record. Only
        // the sources it could be established for; the inspector reads an
        // absent entry as "not known", never as "opened".
        readStates: Object.fromEntries(
          stored.filter((s) => s.readState).map((s) => [s.id, s.readState])
        ),
        // What a present-tense claim was checked against (`source_stale`),
        // so the inspector re-derives the findings this audit actually made.
        asOf: asOf.toISOString(),
        claimCitations,
        rivals,
        // Claims whose checks threw and were left unverified, with the reason. Present only when there are any.
        ...(Object.keys(auditErrors).length > 0 ? { auditErrors } : {}),
        judgeCalls,
        // Beside `judgeCalls` because the two answer different questions: one
        // says how much checking was done, the other what the checking cost.
        // The engine bills from the returned value, not from this — the event
        // is the receipt, not the ledger.
        judgeMicroUsd,
        draftRevision,
        revision,
        repaired: repaired.repaired,
        ...summaryCounts(summary),
      },
    },
  ];
  if (repaired.repaired) {
    events.push({
      kind: "report_revision",
      payload: {
        draftRevision,
        revision,
        reason: "citation_validation",
        originalChars: opts.report.length,
        finalChars: repaired.report.length,
      },
    });
  }
  if (summary.contradicted > 0 || duplicates.size > 0 || (summary.contested ?? 0) > 0) {
    events.push({
      kind: "conflict_found",
      payload: {
        contradictedClaims: summary.contradicted,
        contestedClaims: summary.contested ?? 0,
        duplicateSources: duplicates.size,
        sourceIds: stored.map((s) => s.id),
      },
    });
  }
  await appendResearchEvents({ userId: opts.userId, runId: run.id, events });

  return {
    ...summary,
    report: repaired.report,
    repaired: repaired.repaired,
    revision,
    costMicroUsd: judgeMicroUsd,
  };
}

function summaryCounts(s: CitationAuditSummary) {
  return {
    claims: s.claims,
    supported: s.supported,
    partiallySupported: s.partiallySupported,
    unsupported: s.unsupported,
    contradicted: s.contradicted,
    unverified: s.unverified,
    duplicateSources: s.duplicateSources,
    contested: s.contested ?? 0,
    unresolvedCitations: s.unresolvedCitations ?? 0,
  };
}

async function appendResearchEvent(input: {
  userId: string;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.researchRun.update({
          where: { id: input.runId, userId: input.userId },
          data: { updatedAt: new Date() },
          select: { id: true },
        });
        const top = await tx.researchEvent.aggregate({
          where: { runId: input.runId, userId: input.userId },
          _max: { seq: true },
        });
        await tx.researchEvent.create({
          data: {
            userId: input.userId,
            runId: input.runId,
            seq: (top._max.seq ?? 0) + 1,
            kind: input.kind,
            payload: input.payload,
          },
        });
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error("[research] could not append audit event", { runId: input.runId, error: lastError });
}

async function appendResearchEvents(input: {
  userId: string;
  runId: string;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
}): Promise<void> {
  for (const event of input.events) {
    await appendResearchEvent({ ...input, ...event });
  }
}

type CitationCounts = Omit<CitationAuditSummary, "runId">;

function tally(summary: CitationCounts, status: ClaimStatus, strength: number | null) {
  if (status === "supported") summary.supported++;
  else if (status === "contradicted") summary.contradicted++;
  else if (status === "unverified") summary.unverified++;
  else if (supportLabel(status, strength) === "partially supported") summary.partiallySupported++;
  else summary.unsupported++;
}

/** The unique is (claimId, passageId, stance), so a re-run updates rather than duplicates. */
async function upsertLink(claimId: string, passageId: string, stance: LinkStance, strength: number) {
  await prisma.researchClaimLink.upsert({
    where: { claimId_passageId_stance: { claimId, passageId, stance } },
    create: { claimId, passageId, stance, strength },
    update: { strength },
  });
}

/**
 * How each corpus source's text was obtained (source-provenance.ts), in corpus
 * order.
 *
 * A caller that knows says so on the source. Otherwise, for an audit that
 * belongs to a run, the run's own ledger answers it: the `source_read` events
 * every fetching stage appends, plus the plan's `sweepFetched` list. A source
 * the ledger never saw opened, whose text is shorter than a page, is a search
 * preview — which is what `truncated: !source.snapshot` at both call sites
 * could never detect, since a preview HAS a snapshot. Without a run there is
 * no ledger, and the state is null: unknown, not "opened".
 */
async function resolveReadStates(opts: {
  userId: string;
  runId: string | null;
  sources: readonly ResearchCorpusSource[];
}): Promise<Array<SourceReadState | null>> {
  const given = opts.sources.map((source) => (isSourceReadState(source.readState) ? source.readState : null));
  if (!opts.runId || given.every((state) => state !== null)) return given;
  let opened: Set<string> | null = null;
  try {
    const [events, run] = await Promise.all([
      prisma.researchEvent.findMany({
        where: { runId: opts.runId, userId: opts.userId, kind: "source_read" },
        select: { kind: true, payload: true },
      }),
      prisma.researchRun.findFirst({
        where: { id: opts.runId, userId: opts.userId },
        select: { plan: true },
      }),
    ]);
    opened = openedUrlsFrom({ events, sweepFetched: parsePlan(run?.plan).sweepFetched ?? null });
  } catch (error) {
    // The audit must not fail over its own receipt: an unreadable ledger is
    // an unknown read state, which the inspector shows as nothing.
    console.error("[research] could not read the source ledger for the audit", { runId: opts.runId, error });
  }
  return opts.sources.map(
    (source, i) => given[i] ?? sourceReadState({ url: source.url, textChars: source.body?.trim().length ?? 0 }, opened)
  );
}

async function storeCorpus(opts: {
  userId: string;
  runId: string;
  sources: ResearchCorpusSource[];
  /** Per corpus position, from `resolveReadStates`. */
  readStates: ReadonlyArray<SourceReadState | null>;
}): Promise<StoredSource[]> {
  const stored: StoredSource[] = [];
  for (const [i, source] of opts.sources.slice(0, MAX_SOURCES).entries()) {
    const body = source.body?.trim() ? source.body : "";
    const passages = splitPassages(body, { maxPassages: MAX_PASSAGES_PER_SOURCE });
    const eventDate = extractEventDate(body, source.publishedAt ?? null);
    const authority = scoreSource({
      url: source.url,
      text: body,
      publishedAt: source.publishedAt ?? null,
      eventDate: eventDate
        ? new Date(Date.UTC(eventDate.year, (eventDate.month ?? 1) - 1, eventDate.day ?? 1))
        : null,
    });
    const sourceType = sourceTypeOf({ url: source.url, text: body, authority: authority.authority });
    const existingSource = await prisma.researchSource.findFirst({
      where: {
        userId: opts.userId,
        runId: opts.runId,
        ...(source.sourceId ? { id: source.sourceId } : { url: source.url }),
      },
      select: { id: true },
    });
    const sourceRow = existingSource
      ? await prisma.researchSource.update({
          where: { id: existingSource.id, userId: opts.userId },
          data: {
            title: source.title.slice(0, 500),
            publishedAt: source.publishedAt ?? null,
            ...(body ? { snapshot: body } : {}),
            authority: authority.authority,
            freshness: authority.freshness,
            directness: authority.directness,
            independence: authority.independence,
            composite: authority.composite,
            sourceType,
          },
          select: { id: true },
        })
      : await prisma.researchSource.create({
          data: {
            userId: opts.userId,
            runId: opts.runId,
            url: source.url,
            title: source.title.slice(0, 500),
            publishedAt: source.publishedAt ?? null,
            // The snapshot is what makes a report auditable after the page changes:
            // the inspector quotes THIS, not a re-fetch that may say something else.
            snapshot: body || null,
            authority: authority.authority,
            freshness: authority.freshness,
            directness: authority.directness,
            independence: authority.independence,
            composite: authority.composite,
            sourceType,
          },
          select: { id: true },
        });
    await prisma.researchPassage.deleteMany({ where: { sourceId: sourceRow.id, userId: opts.userId } });
    if (passages.length > 0) {
      await prisma.researchPassage.createMany({
        data: passages.map((p) => ({
          userId: opts.userId,
          sourceId: sourceRow.id,
          text: p.text,
          locator: p.locator,
          ordinal: p.ordinal,
        })),
      });
    }
    const passageRows = await prisma.researchPassage.findMany({
      where: { sourceId: sourceRow.id, userId: opts.userId },
      select: { id: true, ordinal: true },
    });
    const byOrdinal = new Map(passageRows.map((p) => [p.ordinal, p.id]));
    stored.push({
      id: sourceRow.id,
      index: i + 1,
      title: source.title,
      url: source.url,
      publishedAt: source.publishedAt ?? null,
      // A preview is a preview whoever says so: the caller's own flag, or the
      // run's ledger showing the page was never opened and the text is short.
      truncated: !!source.truncated || isPreviewOnly(opts.readStates[i]),
      readState: opts.readStates[i] ?? null,
      passages: passages.map((p) => ({ ...p, id: byOrdinal.get(p.ordinal) ?? "" })).filter((p) => p.id),
    });
  }
  return stored;
}

/**
 * Find the syndicated copies and point them at the original.
 *
 * Two copies of one wire story are one witness. Left unmarked they read as
 * corroboration, which is the specific failure §8.3 names: a claim "confirmed
 * by three sources" that is really one agency report reprinted twice.
 */
async function markSyndication(opts: {
  userId: string;
  stored: StoredSource[];
  sources: ResearchCorpusSource[];
}): Promise<Map<string, string>> {
  const duplicates = detectSyndication(
    opts.stored.map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      text: opts.sources[s.index - 1]?.body ?? "",
      publishedAt: s.publishedAt,
    }))
  );
  for (const [copyId, canonicalId] of duplicates) {
    await prisma.researchSource.update({
      where: { id: copyId, userId: opts.userId },
      data: { duplicateOfId: canonicalId, independence: 0, composite: 0 },
    });
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Reading the graph back (the API and the inspector)
// ---------------------------------------------------------------------------

export interface ClaimAuditSourceView {
  /** The citation number the report used — `[3]` is index 3. */
  index: number;
  title: string;
  url: string;
  host: string;
  publishedAt: string | null;
  authority: number | null;
  freshness: number;
  directness: number;
  independence: number;
  sourceType: string | null;
  /** Set when this source is a syndicated copy of another in the same run. */
  duplicateOfIndex: number | null;
  /**
   * True when the body this audit judged against was a search preview rather
   * than the page — two sentences of lede, not the document.
   *
   * It changes what a verdict MEANS, which is why the inspector has to be able
   * to say it: a figure missing from a snippet is not evidence the page lacks
   * it. `recordCitationAudit` already knows this (it is what demotes such a
   * claim from "unsupported" to "unverified") and it was thrown away on the way
   * out, so the panel showed a bare "unverified" badge with nothing to explain
   * it.
   *
   * NULL means the audit predates this being recorded — not "the page was
   * read". ResearchSource has no column for it and the snapshot cannot stand in
   * (a truncated corpus stores no snapshot, and neither does a source that was
   * simply never fetched), so it rides the audit event alongside `sourceOrder`,
   * for the same reason: it is a property of the corpus the model was shown at
   * that moment, not of a row that is still being updated afterwards.
   */
  truncated: boolean | null;
  /**
   * How the text the audit judged against was obtained: `opened` by the run,
   * supplied by the search provider (`search_text`), a `search_preview`, the
   * person's own record (`private`). Null when the audit predates the record
   * or the run's ledger could not establish it — never read as "opened".
   */
  readState: SourceReadState | null;
}

/**
 * A passage from a source the claim did NOT cite, giving a different figure
 * for the same thing (citation-audit-core.ts, `rivalEvidence`). Kept apart from
 * `links` because it is not a citation: everything that reads `links` as "the
 * claims that cite source n" — the sources pill, the native evidence list —
 * would otherwise count it as one.
 */
export interface ClaimAuditRivalView {
  sourceIndex: number;
  passage: string;
  locator: string | null;
  /** The figure findings, recomputed from the stored passage like a link's. */
  codedReasons: AuditReason[];
}

export interface ClaimAuditLinkView {
  sourceIndex: number;
  stance: LinkStance;
  strength: number | null;
  /** The exact text the validator read — what the inspector quotes. */
  passage: string;
  locator: string | null;
  /**
   * Why the validator was unhappy, recomputed from the stored passage.
   *
   * The sentences only. Kept because two components render this array directly
   * as text; `codedReasons` below is the same list with the machine-readable
   * half attached, and is what anything new should read.
   */
  reasons: string[];
  /**
   * The same findings with their reason code and the ceiling each imposed.
   *
   * `reasons` was a bare `string[]`, so a panel could print the sentences and
   * nothing else: no way to tell a fabricated quote (`quote_absent`) from a
   * thin-overlap warning (`thin_overlap`) from a figure the passage contradicts
   * (`figure_mismatch`), and therefore no way to sort by severity, badge them
   * differently, or count how often a corpus produces one kind of failure. It
   * is a projection of the same array rather than a replacement so widening
   * this did not have to be a coordinated change with the client that already
   * renders `reasons`.
   */
  codedReasons: AuditReason[];
}

export interface ClaimAuditClaimView {
  id: string;
  text: string;
  type: string;
  status: ClaimStatus;
  supportStrength: number | null;
  label: SupportLabel;
  answerSpan: string | null;
  links: ClaimAuditLinkView[];
  /** Uncited passages that give a different figure. Empty on audits that predate the scan. */
  rivals: ClaimAuditRivalView[];
  /** Supported, while a cited passage contradicts it or an uncited source disagrees. */
  contested: boolean;
  /**
   * The `[n]` markers on this claim that named no source in the corpus. Null
   * when the audit predates the record: "none" and "not recorded" differ.
   */
  unresolvedCitations: number[] | null;
}

export interface ClaimAuditView {
  runId: string;
  state: string;
  claims: ClaimAuditClaimView[];
  sources: ClaimAuditSourceView[];
  summary: Omit<CitationAuditSummary, "runId">;
}

/**
 * The audit for one assistant message, or null when that message was never
 * audited (every non-research answer, and research answers still being checked).
 *
 * Every read is scoped by userId — a research corpus is the user's reading
 * history and the claims are what they were told.
 */
export async function loadCitationAuditForMessage(
  userId: string,
  messageId: string
): Promise<ClaimAuditView | null> {
  let event = await prisma.researchEvent.findFirst({
    where: { userId, kind: "citation_audit", payload: { path: ["messageId"], equals: messageId } },
    orderBy: { createdAt: "desc" },
    select: { runId: true, payload: true },
  });
  /*
   * THE LOADER FALLBACK (SPEC §9.4). A web run audits its report before the
   * completion message exists, so no audit event names the message; the run
   * does, through `assistantMessageId`. Its latest audit is the one the
   * message's report was checked by, and its `run_completed` event says what
   * `[n]` means on the message — the completion renumbers citations so `[1]`
   * is the first source cited — which replaces the audit's corpus order.
   */
  let messageOrder: string[] | null = null;
  if (!event) {
    const owner = await prisma.researchRun.findFirst({
      where: { assistantMessageId: messageId, userId },
      select: { id: true },
    });
    if (!owner) return null;
    const [audit, completed] = await Promise.all([
      prisma.researchEvent.findFirst({
        where: { runId: owner.id, userId, kind: "citation_audit" },
        orderBy: { seq: "desc" },
        select: { runId: true, payload: true },
      }),
      prisma.researchEvent.findFirst({
        where: { runId: owner.id, userId, kind: "run_completed" },
        orderBy: { seq: "desc" },
        select: { payload: true },
      }),
    ]);
    if (!audit) return null;
    event = audit;
    const order = (completed?.payload as { sourceOrder?: unknown } | null)?.sourceOrder;
    if (Array.isArray(order)) messageOrder = order.filter((id): id is string => typeof id === "string");
  }

  const run = await prisma.researchRun.findFirst({
    where: { id: event.runId, userId },
    select: {
      id: true,
      state: true,
      sources: {
        select: {
          id: true,
          url: true,
          title: true,
          publishedAt: true,
          authority: true,
          freshness: true,
          directness: true,
          independence: true,
          sourceType: true,
          composite: true,
          snapshot: true,
          duplicateOfId: true,
        },
      },
      claims: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          text: true,
          type: true,
          status: true,
          supportStrength: true,
          answerSpan: true,
          links: {
            select: {
              stance: true,
              strength: true,
              passage: { select: { id: true, text: true, locator: true, sourceId: true } },
            },
          },
        },
      },
    },
  });
  if (!run) return null;

  // The citation numbers live in the audit event, not in a column: they are a
  // property of the corpus the model was shown. Anything the event does not
  // name falls back to the order the rows came out in, which is the order they
  // were written.
  const order =
    messageOrder ??
    (Array.isArray((event.payload as { sourceOrder?: unknown })?.sourceOrder)
      ? ((event.payload as { sourceOrder: unknown[] }).sourceOrder.filter((x) => typeof x === "string") as string[])
      : []);
  const indexOf = new Map<string, number>();
  order.forEach((id, i) => indexOf.set(id, i + 1));
  for (const s of run.sources) if (!indexOf.has(s.id)) indexOf.set(s.id, indexOf.size + 1);

  /*
   * Which of those sources the verdicts were reached against a preview of,
   * recorded on the event beside `sourceOrder` for the same reason: it is true
   * of the corpus at the moment of the audit, and the row it describes keeps
   * being updated afterwards — a later run that finally fetches the page would
   * otherwise retro-actively make an old audit look like it had read one.
   *
   * `null` when the key is absent, which is every audit written before this
   * shipped. Defaulting those to `false` would be the same lie in the other
   * direction: the panel would print nothing, and nothing reads as "the page
   * was read".
   */
  const recordedTruncation = (event.payload as { truncatedSources?: unknown })?.truncatedSources;
  const truncatedIds = Array.isArray(recordedTruncation)
    ? new Set(recordedTruncation.filter((id): id is string => typeof id === "string"))
    : null;
  const receipt = readAuditReceipt(event.payload);

  const sourceById = new Map(run.sources.map((s) => [s.id, s]));
  const sources: ClaimAuditSourceView[] = run.sources
    .map((s) => {
      const body = s.snapshot ?? "";
      const eventDate = extractEventDate(body, s.publishedAt);
      const score = scoreSource({
        url: s.url,
        text: body,
        publishedAt: s.publishedAt,
        eventDate: eventDate ? new Date(Date.UTC(eventDate.year, (eventDate.month ?? 1) - 1, eventDate.day ?? 1)) : null,
        duplicate: !!s.duplicateOfId,
      });
      return {
        index: indexOf.get(s.id) ?? 0,
        title: s.title,
        url: s.url,
        host: hostOfUrl(s.url),
        publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
        authority: s.authority ?? score.authority,
        freshness: s.freshness ?? score.freshness,
        directness: s.directness ?? score.directness,
        independence: s.independence ?? score.independence,
        sourceType: s.sourceType ?? sourceTypeOf({ url: s.url, text: body, authority: s.authority ?? score.authority }),
        duplicateOfIndex: s.duplicateOfId ? indexOf.get(s.duplicateOfId) ?? null : null,
        truncated: truncatedIds ? truncatedIds.has(s.id) : null,
        readState: receipt.readStates?.get(s.id) ?? null,
      };
    })
    .sort((a, b) => a.index - b.index);

  // The uncited rivals' passages, by id, scoped to this run's sources and owner.
  const rivalPassages = receipt.rivals.length
    ? await prisma.researchPassage.findMany({
        where: { id: { in: receipt.rivals.map((r) => r.passageId) }, userId, sourceId: { in: run.sources.map((s) => s.id) } },
        select: { id: true, text: true, locator: true, sourceId: true },
      })
    : [];
  const rivalPassageById = new Map(rivalPassages.map((p) => [p.id, p]));

  const summary: CitationCounts = {
    claims: run.claims.length,
    supported: 0,
    partiallySupported: 0,
    unsupported: 0,
    contradicted: 0,
    unverified: 0,
    duplicateSources: run.sources.filter((s) => s.duplicateOfId).length,
    contested: 0,
    unresolvedCitations: 0,
  };

  const claims: ClaimAuditClaimView[] = run.claims.map((claim) => {
    const status = claim.status as ClaimStatus;
    tally(summary, status, claim.supportStrength);
    // The passage that carried a supported claim, as the audit's period check saw it.
    const supporting =
      status === "supported"
        ? claim.links
            .filter((link) => link.stance === "supports")
            .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0]?.passage.text ?? null
        : null;
    const rivals: ClaimAuditRivalView[] = receipt.rivals
      .filter((r) => r.claimId === claim.id)
      .flatMap((r) => {
        const passage = rivalPassageById.get(r.passageId);
        const source = passage ? sourceById.get(passage.sourceId) : undefined;
        if (!passage || !source) return [];
        const audit = auditOrNull({
          claim: claim.text,
          claimType: claim.type as ClaimType,
          passage: passage.text,
          publishedAt: source.publishedAt ?? null,
        });
        if (!audit) return [];
        const codedReasons = audit.reasons.filter((reason) => reason.code === "figure_mismatch" || reason.code === "figure_differs");
        // Recomputed like a link's reasons: a rival this build would no
        // longer call one is not shown on the strength of an old receipt.
        if (codedReasons.length === 0 || !disagreesForSamePeriod(audit.reasons)) return [];
        if (figureFromAnotherPeriod(claim.text, codedReasons, passage.text)) return [];
        return [{ sourceIndex: indexOf.get(source.id) ?? 0, passage: passage.text, locator: passage.locator, codedReasons }];
      });
    const links: ClaimAuditLinkView[] = claim.links.map((link) => {
        const source = sourceById.get(link.passage.sourceId);
        /*
         * Reasons are recomputed rather than stored. ResearchClaimLink has no
         * column for them, and recomputing has a real advantage besides: the
         * explanation the inspector shows is always the one this build would
         * give, so a reader can never be told a reason the current validator
         * no longer stands behind.
         */
        const audit = auditOrNull({
          claim: claim.text,
          claimType: claim.type as ClaimType,
          passage: link.passage.text,
          publishedAt: source?.publishedAt ?? null,
          // The audit's own clock, so `source_stale` is the finding it made —
          // and absent on audits that never checked freshness at all.
          asOf: receipt.asOf,
        });
        const stance = link.stance as LinkStance;
        const codedReasons = audit ? [...audit.reasons] : [];
        // A doubt beside support is shown with the note naming both figures, as the audit recorded it.
        let note: AuditReason | null = null;
        try {
          note = stance === "differs" && supporting ? supportingPassageDifference(claim.text, link.passage.text, supporting) : null;
        } catch {
          note = null;
        }
        if (note) codedReasons.push(note);
        return {
          sourceIndex: source ? indexOf.get(source.id) ?? 0 : 0,
          stance,
          strength: link.strength,
          passage: link.passage.text,
          locator: link.passage.locator,
          reasons: codedReasons.map((r) => r.detail),
          codedReasons,
        };
      });
    // As the audit decided it: a cited passage that contradicts the claim or may disagree with it (`differs`),
    // one whose figure may be the claim's own but differs (`disputesFigure`), or an uncited rival.
    const contested =
      status === "supported" &&
      (links.some((link) => link.stance !== "supports" || disputesFigure(claim.text, link.codedReasons, link.passage, supporting)) ||
        rivals.length > 0);
    if (contested) summary.contested = (summary.contested ?? 0) + 1;
    const unresolved = receipt.claimCitations?.get(claim.id)?.unresolved ?? (receipt.claimCitations ? [] : null);
    if (unresolved?.length) summary.unresolvedCitations = (summary.unresolvedCitations ?? 0) + 1;
    return {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      status,
      supportStrength: claim.supportStrength,
      label: supportLabel(status, claim.supportStrength),
      answerSpan: claim.answerSpan,
      links,
      rivals,
      contested,
      unresolvedCitations: unresolved,
    };
  });

  return { runId: run.id, state: run.state, claims, sources, summary };
}

