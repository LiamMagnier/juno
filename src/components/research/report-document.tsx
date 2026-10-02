"use client";

import * as React from "react";
import { useCitationAudit, type CitationAudit } from "@/components/chat/citation-audit";
import { Markdown } from "@/components/chat/markdown";
import { CitationCard, CitationHoverLayer } from "@/components/research/citation-card";
import { RESEARCH_COPY, sourcesCount } from "@/components/research/copy";
import {
  citationPassages,
  citationSources,
  citedNumbers,
  claimsInGroup,
  groupSupport,
  parseReport,
  reportBodyOf,
  sentenceGroups,
  type ParsedReport,
  type SupportMark as SupportMarkKind,
} from "@/components/research/report-structure";
import { sourceSections, type SourceSections } from "@/components/research/research-view";
import { SourceRows } from "@/components/research/research-sources";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertTriangle, CheckCircle2, ChevronDown, Circle, CircleDashed, CircleSlash } from "@/components/ui/icons";
import { Phrase, usePhrase } from "@/lib/i18n-phrase";
import type { PhraseLine, PhraseSpec } from "@/lib/run/types";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/*
 * The report as a document (SPEC §9.12, DECISIONS R5), shared by the panel's
 * Report tab (`report-view.tsx`) and the full-screen reader.
 *
 * The report renders through the existing `Markdown` (the chat's prose
 * system, citations resolved against the run's sources), split at the
 * writer's section markers so the contents can jump to a section by its
 * marker rather than by a heading in the report's language. Under the title:
 * the provenance line (["Researched", date] · n sources · ["Written by",
 * model]) and the audit's counts, which replace the old recap's shield (bug
 * 19). After each cited group of sentences, a support mark; on each `[n]`,
 * the citation card with the verbatim passage. Then the sources, from rows
 * (Cited, numbered; then Read, not cited), never from the model's own list.
 */

export interface ReportModel {
  /** The report's Markdown, or null when the run has none. */
  report: string | null;
  parsed: ParsedReport | null;
  audit: CitationAudit | null;
  /** What `[n]` resolves to, in order. */
  citationOrder: ClientSource[];
  cited: Set<number>;
  sections: SourceSections;
}

export function useReportModel(run: ResearchRunView | null): ReportModel {
  const raw = run?.report ?? null;
  const report = React.useMemo(() => (raw ? reportBodyOf(raw) : null), [raw]);
  const messageId = run?.assistantMessageId ?? undefined;
  const auditState = useCitationAudit(messageId, !!report && !!messageId);
  const audit = auditState.phase === "ready" ? auditState.audit : null;
  const parsed = React.useMemo(() => (report ? parseReport(report) : null), [report]);
  const runSources = run?.sources;
  const citationOrder = React.useMemo(() => citationSources(runSources ?? [], audit), [runSources, audit]);
  const cited = React.useMemo(() => (report ? citedNumbers(report) : new Set<number>()), [report]);
  const sections = React.useMemo(() => sourceSections(runSources ?? [], citationOrder, cited), [runSources, citationOrder, cited]);
  return { report, parsed, audit, citationOrder, cited, sections };
}

/** A DOM id for a section marker, unique per mount. */
export function sectionAnchor(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Scrolls a section into view; instantly under reduced motion. */
export function jumpToSection(anchor: string): void {
  const el = document.getElementById(anchor);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || !!el.closest('[data-motion="reduce"]');
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

// ── Support marks ─────────────────────────────────────────────────────────────

const MARKS: Record<SupportMarkKind, { Icon: typeof CheckCircle2; text: string; tone: string }> = {
  supported: { Icon: CheckCircle2, text: RESEARCH_COPY.support.supported, tone: "text-success-ink" },
  partial: { Icon: CircleDashed, text: RESEARCH_COPY.support.partial, tone: "text-warning-foreground" },
  notChecked: { Icon: Circle, text: RESEARCH_COPY.support.notChecked, tone: "text-muted-foreground" },
  notSupported: { Icon: AlertTriangle, text: RESEARCH_COPY.support.notSupported, tone: "text-warning-foreground" },
  contradicted: { Icon: CircleSlash, text: RESEARCH_COPY.support.contradicted, tone: "text-destructive-ink" },
};

/** One mark after a group of cited sentences: glyph and word, never colour alone. */
export function SupportMark({ mark }: { mark: SupportMarkKind }) {
  const { Icon, text, tone } = MARKS[mark];
  return (
    <p className={cn("mt-1 inline-flex items-center gap-1 text-caption", tone, mark === "notChecked" && "[&_svg]:[stroke-dasharray:2_2]")}>
      <Icon aria-hidden className="size-3.5" />
      <Phrase text={text} />
    </p>
  );
}

/** The audit's counts, replacing the recap's shield (bug 19). Only the non-zero ones. */
export function supportCountsLine(audit: CitationAudit | null): PhraseLine | null {
  if (!audit) return null;
  const s = audit.summary;
  const C = RESEARCH_COPY.count;
  const specs: PhraseSpec[] = [];
  const add = (n: number, one: string, other: string) => {
    if (n > 0) specs.push({ parts: [{ kind: "count", n, one, other }] });
  };
  add(s.supported, C.claimSupported, C.claimsSupported);
  add(s.partiallySupported, C.claimPartly, C.claimsPartly);
  add(s.unverified, C.claimNotChecked, C.claimsNotChecked);
  add(s.unsupported, C.claimNotSupported, C.claimsNotSupported);
  add(s.contradicted, C.claimContradicted, C.claimsContradicted);
  return specs.length ? specs : null;
}

/** ["Researched", date] · n sources · ["Written by", model] (§9.12). */
export function provenanceLine(run: ResearchRunView, cited: number): PhraseLine {
  const line: PhraseSpec[] = [];
  if (run.createdAt) line.push({ parts: [{ phrase: RESEARCH_COPY.report.researched }, { kind: "date", iso: run.createdAt, style: "medium" }] });
  line.push(sourcesCount(cited));
  if (run.leadModel) line.push({ parts: [{ phrase: RESEARCH_COPY.report.writtenBy }, { kind: "label", value: run.leadModel.label }] });
  return line;
}

// ── The document ──────────────────────────────────────────────────────────────

function Groups({ text, claims, sources }: { text: string; claims: CitationAudit["claims"]; sources: ClientSource[] }) {
  const groups = React.useMemo(() => sentenceGroups(text), [text]);
  return (
    <>
      {groups.map((group, i) => {
        const mark = claims.length ? groupSupport(claimsInGroup(group, claims)) : null;
        return (
          <div key={i}>
            <Markdown content={group} sources={sources} className="text-reading" />
            {mark && <SupportMark mark={mark} />}
          </div>
        );
      })}
    </>
  );
}

export function ReportDocument({
  run,
  model,
  anchorPrefix,
  onActiveCitation,
  className,
}: {
  run: ResearchRunView;
  model: ReportModel;
  anchorPrefix: string;
  onActiveCitation?(n: number | null): void;
  className?: string;
}) {
  const { parsed, audit, citationOrder } = model;
  const claims = React.useMemo(() => audit?.claims ?? [], [audit]);
  const render = React.useCallback(
    (n: number) => {
      const source = citationOrder[n - 1];
      if (!source) return null;
      return <CitationCard key={n} n={n} source={source} passages={citationPassages(audit, n)} language={run.language} />;
    },
    [citationOrder, audit, run.language],
  );
  if (!parsed) return null;
  return (
    <CitationHoverLayer render={render} onActive={onActiveCitation}>
      <div lang={run.language ?? undefined} className={cn("space-y-6", className)}>
        {parsed.preamble && (
          <div className="space-y-3">
            <Groups text={parsed.preamble} claims={claims} sources={citationOrder} />
          </div>
        )}
        {parsed.sections.map((section) => (
          <section
            key={section.id}
            id={sectionAnchor(anchorPrefix, section.id)}
            data-section={section.id}
            className="scroll-mt-16 space-y-3"
          >
            <Groups text={section.body} claims={claims} sources={citationOrder} />
          </section>
        ))}
      </div>
    </CitationHoverLayer>
  );
}

/** "Sources": Cited (numbered, in citation order), then Read, not cited. */
export function ReportSources({ sections }: { sections: SourceSections }) {
  if (sections.cited.length === 0 && sections.read.length === 0) return null;
  return (
    <section className="space-y-3 border-t border-border/60 pt-5">
      <h4 className="text-ui font-medium text-foreground">
        <Phrase text={RESEARCH_COPY.report.sources} />
      </h4>
      {sections.cited.length > 0 && (
        <div className="space-y-1">
          <p className="px-2 text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.sources.cited} />
          </p>
          <SourceRows rows={sections.cited} numbered />
        </div>
      )}
      {sections.read.length > 0 && (
        <div className="space-y-1">
          <p className="px-2 text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.sources.readNotCited} />
          </p>
          <SourceRows rows={sections.read} />
        </div>
      )}
    </section>
  );
}

/** The sticky mini-contents: a menu of the report's sections by marker. */
export function ReportContentsMenu({ toc, anchorPrefix }: { toc: Array<{ id: string; title: string }>; anchorPrefix: string }) {
  const jumpName = usePhrase(RESEARCH_COPY.report.jumpTo);
  if (toc.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={jumpName} className="gap-1 px-2.5 text-caption">
          <Phrase text={RESEARCH_COPY.report.contents} />
          <ChevronDown aria-hidden className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        {toc.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => jumpToSection(sectionAnchor(anchorPrefix, item.id))}>
            <span className="truncate">{item.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

