"use client";

import * as React from "react";
import { AlertTriangle, BadgeCheck, ChevronDown, CircleDashed, CircleSlash, Copy } from "lucide-react";
import { SourceFavicon, hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/**
 * The citation audit under a research answer (program §8.3).
 *
 * The report's inline `[n]` chips say WHERE a sentence came from. They cannot
 * say whether the source actually backs it, and a chip on an unsupported
 * sentence is worse than no chip at all — it is the thing that stops a reader
 * checking. This is the affordance that closes that gap: every load-bearing
 * claim, its support state, and the exact passage the validator read, quoted so
 * the reader can judge it themselves rather than take a badge's word for it.
 *
 * Nothing here is rendered for an ordinary answer. It appears only where there
 * is an audit to show, which is deep-research turns.
 */

// ---------------------------------------------------------------------------
// The wire shape (mirrors ClaimAuditView in src/lib/research/claims.ts)
// ---------------------------------------------------------------------------

export interface CitationAuditSource {
  index: number;
  title: string;
  url: string;
  host: string;
  publishedAt: string | null;
  authority: number | null;
  freshness: number;
  directness: number;
  independence: number;
  duplicateOfIndex: number | null;
}

export interface CitationAuditLink {
  sourceIndex: number;
  stance: "supports" | "contradicts";
  strength: number | null;
  passage: string;
  locator: string | null;
  reasons: string[];
}

export interface CitationAuditClaim {
  id: string;
  text: string;
  type: string;
  status: "unverified" | "supported" | "contradicted" | "unsupported";
  supportStrength: number | null;
  label: "supported" | "partially supported" | "unsupported" | "contradicted" | "unverified";
  answerSpan: string | null;
  links: CitationAuditLink[];
}

export interface CitationAudit {
  runId: string;
  state: string;
  claims: CitationAuditClaim[];
  sources: CitationAuditSource[];
  summary: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  };
}

type AuditState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "error" }
  | { phase: "ready"; audit: CitationAudit };

/**
 * Fetch the audit for one answer.
 *
 * `enabled` is the deep-research test, so an ordinary reply never issues the
 * request. The audit is written after the answer is saved, so a just-finished
 * report legitimately has none yet — one delayed retry covers that without
 * turning the footer into a poller.
 */
export function useCitationAudit(messageId: string | undefined, enabled: boolean): AuditState {
  const [state, setState] = React.useState<AuditState>({ phase: "idle" });

  React.useEffect(() => {
    if (!enabled || !messageId) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    let retry: number | undefined;
    setState({ phase: "loading" });

    const load = async (attempt: number) => {
      try {
        const res = await fetch(`/api/research/citations?messageId=${encodeURIComponent(messageId)}`);
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        const data = (await res.json()) as { audit: CitationAudit | null };
        if (cancelled) return;
        if (data.audit) {
          setState({ phase: "ready", audit: data.audit });
          return;
        }
        // The audit runs after the answer is persisted. One retry, then stop —
        // a report with no audit is a perfectly normal state to sit in.
        if (attempt === 0) retry = window.setTimeout(() => void load(1), 6_000);
        else setState({ phase: "none" });
      } catch {
        if (!cancelled) setState({ phase: "error" });
      }
    };

    void load(0);
    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
    };
  }, [messageId, enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Support state, drawn
// ---------------------------------------------------------------------------

/*
 * Colour is never the only carrier: each state has its own glyph and its own
 * word. A reader who cannot separate the green from the amber still reads
 * "unsupported", which is the whole point of the component.
 */
const STATES = {
  supported: {
    Icon: BadgeCheck,
    tone: "text-success-ink border-success/35 bg-success/10",
    dot: "bg-success",
    // `label`, not `word`: it is a COPY_PROPERTY, so the five state names reach
    // scripts/generate-i18n-catalog.mjs and can be translated.
    label: "Supported",
  },
  "partially supported": {
    Icon: CircleDashed,
    tone: "text-warning-foreground border-warning/35 bg-warning/10",
    dot: "bg-warning",
    label: "Partly supported",
  },
  unsupported: {
    Icon: AlertTriangle,
    tone: "text-warning-foreground border-warning/45 bg-warning/10",
    dot: "bg-warning",
    label: "Unsupported",
  },
  contradicted: {
    Icon: CircleSlash,
    tone: "text-destructive-ink border-destructive/40 bg-destructive/10",
    dot: "bg-destructive",
    label: "Contradicted",
  },
  unverified: {
    Icon: CircleDashed,
    tone: "text-muted-foreground border-border/70 bg-muted/50",
    dot: "bg-muted-foreground/50",
    label: "Not checked",
  },
} as const;

/**
 * Phrases this component composes with counts at runtime. A template literal is
 * invisible to the catalog extractor, so the fixed halves live here — the name
 * ends in `COPY`, which is what makes the generator collect them.
 */
export const AUDIT_COPY = {
  nothingToCheck: "No checkable claims in this answer",
  allSupported: "Every claim checks out against its sources",
  claimsSupported: "claims supported",
  contradicted: "contradicted",
  unsupported: "unsupported",
  partlySupported: "partly supported",
  notChecked: "not checked",
  claimsCited: "claims cited",
  oneClaimCited: "claim cited",
  supported: "supported",
  notUsedAsEvidence: "not used as evidence for any claim",
  syndicatedCopyOf: "syndicated copy of",
} as const;

export function SupportBadge({ label }: { label: CitationAuditClaim["label"] }) {
  const state = STATES[label];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-caption leading-none",
        state.tone
      )}
    >
      <state.Icon aria-hidden="true" className="size-3" />
      {state.label}
    </span>
  );
}

/** 0..1 drawn as a four-segment meter — precise enough to compare, honest about being an estimate. */
export function ScoreMeter({ label, value }: { label: string; value: number }) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 4);
  return (
    <span className="inline-flex items-center gap-1.5" title={`${label}: ${Math.round(value * 100)} out of 100`}>
      <span className="font-mono text-caption text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="flex gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("h-1.5 w-2 rounded-full", i < filled ? "bg-foreground/45" : "bg-border")} />
        ))}
      </span>
      <span className="sr-only">
        {label} {Math.round(value * 100)} out of 100
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The source inspector
// ---------------------------------------------------------------------------

/**
 * What one citation actually rests on: the passage verbatim, where in the
 * source it sits, how the source scored, and what the validator objected to.
 * The passage is quoted from the snapshot taken when the report was written —
 * not re-fetched — so it still says what the model was shown even after the
 * page changes.
 */
function SourceInspector({ link, source }: { link: CitationAuditLink; source?: CitationAuditSource }) {
  const [copied, setCopied] = React.useState(false);
  const published = source?.publishedAt ? new Date(source.publishedAt) : null;

  return (
    <div className="mt-2 rounded-menu border border-border/70 bg-card p-3">
      <div className="flex items-start gap-2">
        {source && <SourceFavicon url={source.url} variant="list" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-body leading-tight text-foreground/90">{source?.title ?? "Cited source"}</p>
          <p className="truncate font-mono text-caption text-muted-foreground">
            {source ? hostOf(source.url) : ""}
            {published ? ` · published ${published.toISOString().slice(0, 10)}` : " · no publication date"}
            {link.locator ? ` · ${link.locator}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link.passage).then(() => setCopied(true));
          }}
          aria-label="Copy the cited passage"
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground",
            "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
            // `hover:bg-accent`. This button is inside the `bg-card` inspector
            // above, so `hover:bg-card` repainted the exact colour already
            // under it — the only copy-passage control in the audit had no
            // hover state at all.
            "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <Copy aria-hidden="true" className="size-3.5" />
        </button>
      </div>

      <blockquote className="mt-2 border-l-2 border-border pl-3 text-body leading-relaxed text-foreground/85">
        {link.passage}
      </blockquote>
      <span aria-live="polite" className="sr-only">
        {copied ? "Passage copied" : ""}
      </span>

      {source && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ScoreMeter label="Authority" value={source.authority ?? 0} />
          <ScoreMeter label="Freshness" value={source.freshness} />
          <ScoreMeter label="Directness" value={source.directness} />
          <ScoreMeter label="Independence" value={source.independence} />
        </div>
      )}

      {source?.duplicateOfIndex != null && (
        // Two copies of one wire story are one witness. Saying so here is the
        // difference between "three sources agree" and "one agency, reprinted".
        <p className="mt-2 text-caption text-warning-foreground">
          This is a syndicated copy of source [{source.duplicateOfIndex}], so it is not separate corroboration.
        </p>
      )}

      {link.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {link.reasons.map((reason, i) => (
            <li key={i} className="text-caption leading-snug text-muted-foreground">
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One claim
// ---------------------------------------------------------------------------

function ClaimRow({ claim, sources }: { claim: CitationAuditClaim; sources: CitationAuditSource[] }) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const sourceOf = (index: number) => sources.find((s) => s.index === index);
  const hasEvidence = claim.links.length > 0;

  return (
    <li className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-field px-2 py-2.5 text-left",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          // Full-strength `bg-muted`. The claim list is drawn straight on the
          // page, and half a muted fill is a 1-point step over light paper —
          // the row hover on the widest control in the audit was invisible in
          // the light theme and thin in the dark one.
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // 44px minimum target on touch, without stretching the row on a desktop list.
          "coarse:min-h-11"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATES[claim.label].dot)}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-body leading-snug text-foreground/90">{claim.text}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <SupportBadge label={claim.label} />
            {claim.links.map((link, i) => (
              <span
                key={`${link.sourceIndex}-${i}`}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border border-border/70 bg-card px-2 font-mono text-caption",
                  link.stance === "contradicts" && "border-destructive/40 text-destructive-ink"
                )}
              >
                [{link.sourceIndex}]
                {link.stance === "contradicts" ? " contradicts" : ""}
              </span>
            ))}
            {!hasEvidence && (
              <span className="font-mono text-caption text-muted-foreground">no citation on this sentence</span>
            )}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>

      <div
        id={panelId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="px-2 pb-3">
            {hasEvidence ? (
              claim.links.map((link, i) => (
                <SourceInspector key={`${link.sourceIndex}-${i}`} link={link} source={sourceOf(link.sourceIndex)} />
              ))
            ) : (
              <p className="mt-2 rounded-menu border border-border/70 bg-card p-3 text-body text-muted-foreground">
                The report states this without citing anything. Juno could not check it against a source, so treat it as
                unverified.
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

/**
 * One honest sentence about a checked report. Takes the summary alone (not the
 * full audit) because the /research reader holds only the run-level counts —
 * the same numbers, and they must be phrased the same way in both places.
 */
export function auditHeadline(s: CitationAudit["summary"]): string {
  const problems = s.unsupported + s.partiallySupported + s.contradicted;
  if (s.claims === 0) return AUDIT_COPY.nothingToCheck;
  if (problems === 0 && s.unverified === 0) return AUDIT_COPY.allSupported;
  const parts = [`${s.supported}/${s.claims} ${AUDIT_COPY.claimsSupported}`];
  if (s.contradicted) parts.push(`${s.contradicted} ${AUDIT_COPY.contradicted}`);
  if (s.unsupported) parts.push(`${s.unsupported} ${AUDIT_COPY.unsupported}`);
  if (s.partiallySupported) parts.push(`${s.partiallySupported} ${AUDIT_COPY.partlySupported}`);
  if (s.unverified) parts.push(`${s.unverified} ${AUDIT_COPY.notChecked}`);
  return parts.join(" · ");
}

/**
 * The footer strip. Collapsed it is one honest sentence about the answer above
 * it; expanded it is every claim with its evidence.
 *
 * Sorted worst-first on purpose. A reader opening this is looking for what they
 * cannot trust, and making them scroll past twelve green rows to find the one
 * contradiction buries exactly the thing they came for.
 */
export function CitationAuditPanel({ state, className }: { state: AuditState; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();

  const claims = React.useMemo(() => {
    if (state.phase !== "ready") return [];
    const rank: Record<CitationAuditClaim["label"], number> = {
      contradicted: 0,
      unsupported: 1,
      "partially supported": 2,
      unverified: 3,
      supported: 4,
    };
    return [...state.audit.claims].sort((a, b) => rank[a.label] - rank[b.label]);
  }, [state]);

  if (state.phase === "idle" || state.phase === "none") return null;

  if (state.phase === "loading") {
    return (
      <p
        aria-live="polite"
        className={cn("mt-3 font-mono text-caption text-muted-foreground", className)}
      >
        Checking citations…
      </p>
    );
  }

  if (state.phase === "error") {
    // Degraded, and said plainly. The answer above is unaffected; what is
    // missing is Juno's opinion of its own citations, and pretending otherwise
    // would be the one thing this component exists not to do.
    return (
      <p aria-live="polite" className={cn("mt-3 font-mono text-caption text-muted-foreground", className)}>
        Citation check unavailable — the sources below have not been verified.
      </p>
    );
  }

  const { audit } = state;
  const trouble = audit.summary.contradicted + audit.summary.unsupported;

  return (
    <div className={cn("mt-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "group/audit relative z-0 inline-flex h-9 max-w-full items-center gap-2 rounded-full border bg-card pl-2.5 pr-3 shadow-soft",
          "transition-[transform,box-shadow,border-color] duration-base ease-out-soft motion-reduce:transition-none",
          "hover:z-10 hover:shadow-lift motion-safe:hover:-translate-y-0.5",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "coarse:h-11",
          trouble > 0 ? "border-warning/45" : "border-border/70"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", trouble > 0 ? "bg-warning" : "bg-success")}
        />
        <span className="truncate font-mono text-label text-muted-foreground transition-colors duration-fast group-hover/audit:text-foreground motion-reduce:transition-none">
          {auditHeadline(audit.summary)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
      {/* The summary is announced once when it arrives, so a screen reader is
          told the answer's citations were checked without having to open this. */}
      <span aria-live="polite" className="sr-only">
        {auditHeadline(audit.summary)}
      </span>

      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          {claims.length > 0 ? (
            <ul className="mt-1.5 max-w-2xl">
              {claims.map((claim) => (
                <ClaimRow key={claim.id} claim={claim} sources={audit.sources} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 max-w-2xl text-body text-muted-foreground">
              This answer makes no checkable factual claims, so there was nothing to verify.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** What one source was actually used for: the claims that cite it, with the passage each rests on. */
export function evidenceForSource(
  audit: CitationAudit,
  index: number
): Array<{ claim: CitationAuditClaim; link: CitationAuditLink }> {
  const out: Array<{ claim: CitationAuditClaim; link: CitationAuditLink }> = [];
  for (const claim of audit.claims) {
    for (const link of claim.links) if (link.sourceIndex === index) out.push({ claim, link });
  }
  return out;
}

/** Whether an answer is one the audit applies to: the numbered-corpus contract. */
export function isAuditableAnswer(sources: ClientSource[] | undefined, streaming: boolean | undefined): boolean {
  return !streaming && !!sources?.some((s) => s.cited);
}
