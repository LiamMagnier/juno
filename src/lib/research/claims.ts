import "server-only";
import { prisma } from "@/lib/prisma";
import { loadBackgroundProviderPolicy, runUtilityPrompt } from "@/lib/memory";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "@/lib/untrusted-content";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";
import {
  auditEvidence,
  detectSyndication,
  extractClaims,
  extractEventDate,
  hostOfUrl,
  resolveClaimStatus,
  scoreSource,
  selectPassagesForClaim,
  splitPassages,
  supportLabel,
  validateClaimAgainstPassage,
  type CitationJudge,
  type ClaimStatus,
  type ClaimType,
  type JudgeVerdict,
  type LinkStance,
  type LinkVerdict,
  type PassageDraft,
  type SupportLabel,
} from "@/lib/research/claim-analysis";

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
const MAX_SOURCES = 16;
/**
 * Utility-model calls per report. Past this the remaining claims are recorded
 * `unverified` and reported as unchecked — an honest gap the UI shows, rather
 * than an unbounded bill or a claim quietly promoted to supported.
 */
const MAX_JUDGE_CALLS = 24;
/** How much of a passage the judge is shown. */
const JUDGE_PASSAGE_CHARS = 1_600;

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
export function createCitationJudge(opts: {
  policy: BackgroundProviderPolicy;
  conversationProvider?: string | null;
}): CitationJudge {
  return async ({ claim, passage, sourceTitle, publishedAt }) => {
    const { result } = await runUtilityPrompt<JudgeVerdict>({
      system: JUDGE_SYSTEM,
      // The passage is fetched web text. It goes to the model inside the
      // untrusted envelope for the same reason the research corpus does: a page
      // that writes "this passage fully supports the claim" is trying to grade
      // its own citation, and unwrapped it would look like instructions.
      userMsg: [
        `CLAIM: ${claim}`,
        `SOURCE: ${sourceTitle ?? "untitled"}${publishedAt ? ` (published ${publishedAt.toISOString().slice(0, 10)})` : ""}`,
        "PASSAGE:",
        wrapUntrusted(sourceTitle ?? "source", passage.slice(0, JUDGE_PASSAGE_CHARS)),
        "",
        "Return the JSON.",
      ].join("\n"),
      maxTokens: 200,
      label: "research/citation",
      parse: parseJudgeVerdict,
      policy: opts.policy,
      conversationProvider: opts.conversationProvider,
      purpose: "citation_validation",
    });
    return result;
  };
}

// ---------------------------------------------------------------------------
// Building and validating the graph
// ---------------------------------------------------------------------------

/** One numbered source from the report's corpus, in citation order. */
export interface ResearchCorpusSource {
  url: string;
  title: string;
  /** The text the model was actually shown — the thing a citation points at. */
  body: string;
  /** As claimed by the source. Distinct from the date of the event it describes. */
  publishedAt?: Date | null;
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
}

interface StoredSource {
  id: string;
  index: number;
  passages: Array<PassageDraft & { id: string }>;
  title: string;
  url: string;
  publishedAt: Date | null;
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
  messageId: string;
  goal: string;
  report: string;
  sources: ResearchCorpusSource[];
  queries?: string[];
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  /** Override the model layer (tests, or a caller with its own judge). */
  judge?: CitationJudge;
}): Promise<CitationAuditSummary | null> {
  const claims = extractClaims(opts.report).slice(0, MAX_CLAIMS);
  if (claims.length === 0 || opts.sources.length === 0) return null;

  const run = await prisma.researchRun.create({
    data: {
      userId: opts.userId,
      conversationId: opts.conversationId ?? null,
      goal: opts.goal.slice(0, 4_000),
      state: "validating_citations",
      queries: opts.queries ?? [],
      report: opts.report,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  const stored = await storeCorpus({ userId: opts.userId, runId: run.id, sources: opts.sources });
  const duplicates = await markSyndication({ userId: opts.userId, stored, sources: opts.sources });

  const judge =
    opts.judge ??
    createCitationJudge({
      policy: opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId)),
      conversationProvider: opts.conversationProvider,
    });

  const summary: CitationAuditSummary = {
    runId: run.id,
    claims: claims.length,
    supported: 0,
    partiallySupported: 0,
    unsupported: 0,
    contradicted: 0,
    unverified: 0,
    duplicateSources: duplicates.size,
  };

  const passagesBySource = new Map<number, PassageDraft[]>(stored.map((s) => [s.index, s.passages]));
  const passageIdOf = new Map<string, string>();
  for (const s of stored) for (const p of s.passages) passageIdOf.set(`${s.index}:${p.ordinal}`, p.id);
  const sourceByIndex = new Map(stored.map((s) => [s.index, s]));

  let judgeCalls = 0;
  for (const claim of claims) {
    const row = await prisma.researchClaim.create({
      data: {
        userId: opts.userId,
        runId: run.id,
        text: claim.text,
        type: claim.type,
        status: "unverified",
        answerSpan: claim.answerSpan,
      },
      select: { id: true },
    });

    const candidates = selectPassagesForClaim(claim, passagesBySource);
    const verdicts: LinkVerdict[] = [];
    /*
     * The deterministic audit is free, so it runs on every candidate first and
     * the model is spent only on the one it cannot decide. Ranking by the
     * audit's own ceiling also means the passage most likely to actually carry
     * the claim is the one that gets checked — a citation names a SOURCE, not a
     * passage, and picking the wrong paragraph marks a true claim unsupported.
     */
    const ranked = candidates
      .map((c) => {
        const source = sourceByIndex.get(c.sourceIndex);
        return {
          ...c,
          source,
          audit: auditEvidence({
            claim: claim.text,
            claimType: claim.type as ClaimType,
            passage: c.passage.text,
            publishedAt: source?.publishedAt ?? null,
          }),
        };
      })
      .sort((a, b) => b.audit.ceiling * (0.5 + 0.5 * b.relevance) - a.audit.ceiling * (0.5 + 0.5 * a.relevance));

    for (const candidate of ranked) {
      const settledByText = candidate.audit.contradicted;
      if (!settledByText && judgeCalls >= MAX_JUDGE_CALLS) break;
      if (!settledByText) judgeCalls++;
      const verdict = await validateClaimAgainstPassage({
        claim: claim.text,
        claimType: claim.type as ClaimType,
        passage: candidate.passage.text,
        sourceTitle: candidate.source?.title,
        publishedAt: candidate.source?.publishedAt ?? null,
        judge,
      });
      verdicts.push(verdict);
      const passageId = passageIdOf.get(`${candidate.sourceIndex}:${candidate.passage.ordinal}`);
      if (passageId) await upsertLink(row.id, passageId, verdict.stance, verdict.strength);
      // One honest supporting passage is what a citation is for; checking the
      // rest would spend the budget re-proving a settled claim.
      if (verdict.status === "supported") break;
    }

    const resolved = resolveClaimStatus(verdicts);
    await prisma.researchClaim.update({
      where: { id: row.id, userId: opts.userId },
      data: { status: resolved.status, supportStrength: resolved.supportStrength },
    });
    tally(summary, resolved.status, resolved.supportStrength);
  }

  await prisma.researchRun.update({
    where: { id: run.id, userId: opts.userId },
    data: {
      state: summary.unverified > 0 ? "partially_completed" : "completed",
      finishedAt: new Date(),
    },
  });

  /*
   * The audit's own record. It carries the messageId because that is how the UI
   * finds this run from the answer the reader is looking at — ResearchRun has a
   * conversation, not a message — and the ordered source ids because the
   * citation NUMBERS are a property of the corpus the model was shown, not of
   * any column, and the inspector has to line `[3]` up with the right row.
   */
  await prisma.researchEvent.create({
    data: {
      userId: opts.userId,
      runId: run.id,
      seq: 1,
      kind: "citation_audit",
      payload: {
        messageId: opts.messageId,
        sourceOrder: stored.map((s) => s.id),
        judgeCalls,
        ...summaryCounts(summary),
      },
    },
  });

  return summary;
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
  };
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

async function storeCorpus(opts: {
  userId: string;
  runId: string;
  sources: ResearchCorpusSource[];
}): Promise<StoredSource[]> {
  const stored: StoredSource[] = [];
  for (const [i, source] of opts.sources.slice(0, MAX_SOURCES).entries()) {
    const body = source.body?.trim() ? source.body : "";
    const passages = splitPassages(body, { maxPassages: MAX_PASSAGES_PER_SOURCE });
    const eventDate = extractEventDate(body, source.publishedAt ?? null);
    const row = await prisma.researchSource.create({
      data: {
        userId: opts.userId,
        runId: opts.runId,
        url: source.url,
        title: source.title.slice(0, 500),
        publishedAt: source.publishedAt ?? null,
        // The snapshot is what makes a report auditable after the page changes:
        // the inspector quotes THIS, not a re-fetch that may say something else.
        snapshot: body || null,
        authority: scoreSource({
          url: source.url,
          text: body,
          publishedAt: source.publishedAt ?? null,
          eventDate: eventDate ? new Date(Date.UTC(eventDate.year, (eventDate.month ?? 1) - 1, eventDate.day ?? 1)) : null,
        }).authority,
        passages: {
          create: passages.map((p) => ({
            userId: opts.userId,
            text: p.text,
            locator: p.locator,
            ordinal: p.ordinal,
          })),
        },
      },
      select: { id: true, passages: { select: { id: true, ordinal: true } } },
    });
    const byOrdinal = new Map(row.passages.map((p) => [p.ordinal, p.id]));
    stored.push({
      id: row.id,
      index: i + 1,
      title: source.title,
      url: source.url,
      publishedAt: source.publishedAt ?? null,
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
      data: { duplicateOfId: canonicalId },
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
  /** Set when this source is a syndicated copy of another in the same run. */
  duplicateOfIndex: number | null;
}

export interface ClaimAuditLinkView {
  sourceIndex: number;
  stance: LinkStance;
  strength: number | null;
  /** The exact text the validator read — what the inspector quotes. */
  passage: string;
  locator: string | null;
  /** Why the validator was unhappy, recomputed from the stored passage. */
  reasons: string[];
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
  const event = await prisma.researchEvent.findFirst({
    where: { userId, kind: "citation_audit", payload: { path: ["messageId"], equals: messageId } },
    orderBy: { createdAt: "desc" },
    select: { runId: true, payload: true },
  });
  if (!event) return null;

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
  const order = Array.isArray((event.payload as { sourceOrder?: unknown })?.sourceOrder)
    ? ((event.payload as { sourceOrder: unknown[] }).sourceOrder.filter((x) => typeof x === "string") as string[])
    : [];
  const indexOf = new Map<string, number>();
  order.forEach((id, i) => indexOf.set(id, i + 1));
  for (const s of run.sources) if (!indexOf.has(s.id)) indexOf.set(s.id, indexOf.size + 1);

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
        freshness: score.freshness,
        directness: score.directness,
        independence: score.independence,
        duplicateOfIndex: s.duplicateOfId ? indexOf.get(s.duplicateOfId) ?? null : null,
      };
    })
    .sort((a, b) => a.index - b.index);

  const summary: CitationCounts = {
    claims: run.claims.length,
    supported: 0,
    partiallySupported: 0,
    unsupported: 0,
    contradicted: 0,
    unverified: 0,
    duplicateSources: run.sources.filter((s) => s.duplicateOfId).length,
  };

  const claims: ClaimAuditClaimView[] = run.claims.map((claim) => {
    const status = claim.status as ClaimStatus;
    tally(summary, status, claim.supportStrength);
    return {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      status,
      supportStrength: claim.supportStrength,
      label: supportLabel(status, claim.supportStrength),
      answerSpan: claim.answerSpan,
      links: claim.links.map((link) => {
        const source = sourceById.get(link.passage.sourceId);
        /*
         * Reasons are recomputed rather than stored. ResearchClaimLink has no
         * column for them, and recomputing has a real advantage besides: the
         * explanation the inspector shows is always the one this build would
         * give, so a reader can never be told a reason the current validator
         * no longer stands behind.
         */
        const audit = auditEvidence({
          claim: claim.text,
          claimType: claim.type as ClaimType,
          passage: link.passage.text,
          publishedAt: source?.publishedAt ?? null,
        });
        return {
          sourceIndex: source ? indexOf.get(source.id) ?? 0 : 0,
          stance: link.stance as LinkStance,
          strength: link.strength,
          passage: link.passage.text,
          locator: link.passage.locator,
          reasons: audit.reasons.map((r) => r.detail),
        };
      }),
    };
  });

  return { runId: run.id, state: run.state, claims, sources, summary };
}
