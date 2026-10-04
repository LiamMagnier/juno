"use client";

import * as React from "react";
import { DotRings } from "@/components/home/dot-construction";
import { ThinkingMark } from "@/components/brand/thinking-mark";
import { Check } from "@/components/ui/icons";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { FIELD_CENTRE, FIELD_RINGS, deepField, type FieldSourceInput } from "./deep-field-model";
import { answeredCount, questionState, type WorkspaceQuestion } from "./workspace-model";
import type { ResearchRunView } from "./use-research-run";

const RAIL_COPY = {
  questions: "Questions", answered: "answered", planningQuestions: "The questions appear here once the plan is ready.",
  allQuestions: "Show all questions", fewerQuestions: "Show fewer questions",
};

/**
 * Deep Field, live: the homepage's research map drawn from the run itself.
 * The question sits at the centre; every source the run has met is a point on
 * the orbit for how far it got (found, read, cited), and moves inward when it
 * gets further. The one presence line runs to the page being read now.
 *
 * Motion is state, never a loop: the orbits draw on once, a point arrives when
 * its source is discovered and travels when its state changes, and the line
 * draws when a new page is opened. The centre mark is the brand's thinking
 * mark, which passes only when a real step happens. Reduced motion places
 * everything where it ends.
 */
export function DeepField({
  sources,
  currentHost,
  working,
  eventKey,
  counts,
  still = false,
  className,
}: {
  sources: readonly FieldSourceInput[];
  currentHost: string | null;
  working: boolean;
  /** Changes once per real step of work (the newest event's seq). */
  eventKey?: number;
  counts: { found: number; read: number; cited: number | null };
  /** A finished run's map: drawn where it ended, with nothing arriving (history should not replay). */
  still?: boolean;
  className?: string;
}) {
  const model = React.useMemo(() => deepField(sources, { currentHost }), [sources, currentHost]);
  const lines = React.useMemo(
    () =>
      model.nodes
        .filter((node) => node.state === "cited" || node.current)
        .map((node) => ({
          x1: FIELD_CENTRE.x,
          y1: FIELD_CENTRE.y,
          x2: node.x,
          y2: node.y,
          tone: node.current ? ("presence" as const) : ("ink" as const),
          strength: node.current ? 0.55 : 0.18,
        })),
    [model.nodes],
  );
  const summary = `${counts.found} sources found, ${counts.read} read${counts.cited != null ? `, ${counts.cited} cited` : ""}`;

  return (
    <div className={className ? `rf-map ${className}` : "rf-map"} data-still={still || undefined} role="img" aria-label={summary}>
      <DotRings rings={FIELD_RINGS} lines={lines} animate={!still} className="rf-dots" />
      <span className="rf-centre" aria-hidden>
        <ThinkingMark phase={working ? "working" : "idle"} eventKey={eventKey} size={18} />
      </span>
      {model.nodes.map((node) => (
        <span
          key={node.id}
          aria-hidden
          className="rf-point"
          data-state={node.state}
          data-current={node.current || undefined}
          style={{ left: `${node.x * 100}%`, top: `${node.y * 100}%` }}
        />
      ))}
      {model.nodes
        .filter((node) => node.label)
        .map((node) => {
          const style: React.CSSProperties = {
            left: `${node.x * 100}%`,
            top: `${node.labelY * 100}%`,
          };
          const body = (
            <>
              {node.cited != null && <sup>{node.cited}</sup>}
              <bdi translate="no">{node.host}</bdi>
            </>
          );
          return isRenderableSourceUrl(node.url) ? (
            <a
              key={node.id}
              href={node.url}
              target="_blank"
              rel="noopener noreferrer"
              tabIndex={-1}
              title={node.title}
              className="rf-label"
              data-side={node.side}
              data-current={node.current || undefined}
              style={style}
            >
              {body}
            </a>
          ) : (
            <span key={node.id} className="rf-label" data-side={node.side} data-current={node.current || undefined} style={style}>
              {body}
            </span>
          );
        })}
      {model.hidden > 0 && <span className="rf-more">+{model.hidden}</span>}
    </div>
  );
}

export function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="rf-annot">{label}</dt>
      <dd className="rf-figure">{children}</dd>
    </div>
  );
}

/**
 * The questions the run is answering, as the homepage's plan column: a check
 * for an answered one, the thinking mark on the one being investigated while
 * the run works, an empty ring for the rest. Under each, the hosts that
 * actually support it, or its state in words (never colour alone).
 */
export function QuestionRail({ questions, working, language, sources, eventKey }: {
  questions: WorkspaceQuestion[]; working: boolean; language: string | null | undefined;
  sources: ResearchRunView["sources"]; eventKey?: number;
}) {
  const [all, setAll] = React.useState(false);
  const shown = all ? questions : questions.slice(0, 4);
  return (
    <aside className="rf-rail" aria-label={RAIL_COPY.questions}>
      <p className="rf-annot flex items-baseline justify-between gap-3">
        <span className="text-foreground">{RAIL_COPY.questions}</span>
        {questions.length > 0 && <span className="tabular-nums">{answeredCount(questions)}/{questions.length} {RAIL_COPY.answered}</span>}
      </p>
      {questions.length === 0 ? (
        <p className="mt-4 text-caption text-muted-foreground">{RAIL_COPY.planningQuestions}</p>
      ) : (
        <ol className="rf-questions">
          {shown.map(question => {
            const hosts = question.sourceIds
              .map(id => sources.find(source => source.id === id))
              .filter((source): source is NonNullable<typeof source> => !!source && isRenderableSourceUrl(source.url))
              .slice(0, 3);
            const now = question.status === "searching";
            return (
              <li key={question.id} data-state={question.status}>
                <span className="rf-mark" aria-hidden>
                  {question.status === "covered" ? <Check /> : now && working ? <ThinkingMark phase="working" eventKey={eventKey} size={14} /> : null}
                </span>
                <div className="min-w-0">
                  <p lang={language ?? undefined} className="rf-question">{question.question}</p>
                  {hosts.length > 0 ? (
                    <p className="rf-annot mt-1 flex flex-wrap gap-x-2">
                      {hosts.map(source => (
                        <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" title={source.title} className="rf-link">
                          <bdi translate="no">{hostOf(source.url)}</bdi>
                        </a>
                      ))}
                    </p>
                  ) : question.status !== "pending" && (
                    <p className="rf-annot mt-1" data-tone={question.status === "thin" ? "attention" : undefined}>{questionState(question.status)}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {questions.length > 4 && (
        <button type="button" className="rf-annot rf-more-toggle" onClick={() => setAll(value => !value)}>
          {all ? RAIL_COPY.fewerQuestions : `${RAIL_COPY.allQuestions} (${questions.length})`}
        </button>
      )}
    </aside>
  );
}
