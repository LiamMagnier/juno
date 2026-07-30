"use client";

import * as React from "react";
import { ThinkingState } from "@/components/aicss/thinking-state";
import { cn, truncate } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────────
 * AIcss "Web Search" — and the component this app already had the data for.
 *
 * AIcss stages it: three hardcoded sites on a discover/finish timer that loops
 * forever. Juno's producer emits the real thing — a `search` event carrying the
 * query and a `visit` event per URL — so the three-state bullet here is read off
 * the wire. A row is `pending` because the search that will return it is still
 * in flight, `loading` because its `visit` landed while the run continues, and
 * `done` because the run moved past it. Nothing is on a timer.
 * ───────────────────────────────────────────────────────────────────────────── */

export type WebSearchSiteState = "pending" | "loading" | "done";

export interface WebSearchSite {
  title: string;
  /** Display form — host + path, no scheme. AIcss's rows show it bare. */
  label: string;
  url: string;
  state: WebSearchSiteState;
}

/** Six meridians, phase-offset by a sixth of the cycle, read as one sphere. */
const MERIDIANS = {
  L: "M6.057 11.565 C2.081 11.565 0.371 8.159 0.371 5.964 C0.371 3.642 2.152 0.329 6.05 0.329",
  ML: "M6.012 11.55 C4.575 10.496 3.333 8.116 3.321 5.964 C3.307 3.399 4.974 0.977 6.012 0.329",
  MR: "M6.012 11.55 C7.211 10.781 8.715 8.287 8.715 5.964 C8.715 3.399 7.24 1.233 6.012 0.329",
  R: "M6.012 11.55 C9.677 11.55 11.65 8.487 11.65 5.964 C11.65 3.499 9.748 0.329 6.012 0.329",
};
const BEGINS = ["0s", "-1.2s", "-2.4s", "-3.6s", "-4.8s", "-6s"];

/**
 * The rotating globe, drawn as morphing meridians rather than a spinning image.
 *
 * SMIL, not CSS — `d` interpolation is the whole effect and CSS cannot tween a
 * path. Which is why `still` is a prop and not a media query: `animation: none`
 * cannot reach inside <animate>, so reduced motion has to be answered by not
 * rendering the elements at all.
 */
function Globe({ still }: { still?: boolean }) {
  const values = [MERIDIANS.L, MERIDIANS.ML, MERIDIANS.MR, MERIDIANS.R, MERIDIANS.L].join(";");
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.85"
      strokeLinecap="round"
      style={{ overflow: "visible" }}
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="5.7" opacity="0.9" />
      <line x1="0.3" y1="6" x2="11.7" y2="6" opacity="0.9" />
      {still ? (
        <path d={MERIDIANS.ML} opacity="0.9" />
      ) : (
        BEGINS.map((begin) => (
          <path key={begin} d={MERIDIANS.L} opacity="0">
            <animate
              attributeName="d"
              dur="7.2s"
              begin={begin}
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;0.25;0.5;0.75;1"
              keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
              values={values}
            />
            <animate
              attributeName="opacity"
              dur="7.2s"
              begin={begin}
              repeatCount="indefinite"
              calcMode="linear"
              keyTimes="0;0.05;0.7;0.75;1"
              values="0;0.9;0.9;0;0"
            />
          </path>
        ))
      )}
    </svg>
  );
}

const SearchGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
  </svg>
);
const Caret = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4.5 15.75 7.5-7.5 7.5 7.5" />
  </svg>
);
const ArrowUp = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
  </svg>
);
const DashedRing = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="9" strokeWidth="1.8" strokeDasharray="1.8 3.6" strokeLinecap="round" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);

/** Render-time reduced-motion, for the one decision CSS cannot make (see Globe). */
function useReducedMotion() {
  // Server render and first client render must agree, so this starts false and
  // corrects in an effect rather than reading matchMedia during render.
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function WebSearchBlock({
  query,
  sites,
  settled,
  defaultOpen = true,
  className,
}: {
  /**
   * The query, verbatim, when the run recorded one.
   *
   * Absent on the provider-tool search paths, where sources arrive from grounding
   * metadata and the query the model typed is never sent to us. The label row is
   * then omitted entirely rather than shown empty or filled in with a guess — and
   * the rows, which are the durable part, still render.
   */
  query?: string | null;
  sites: WebSearchSite[];
  /** The search is over. The label stops shimmering; the rows keep their state. */
  settled?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const listId = React.useId();
  const reducedMotion = useReducedMotion();

  const expanded = query ? open : true;

  return (
    <div className={cn("aicss-ws", className)}>
      {query && (
        <div className="aicss-ws-row">
          <SearchGlyph />
          <span className="aicss-ws-label">
            <ThinkingState settled={settled} tone="strong">
              {settled ? "Searched" : "Searching"} <span className="aicss-ws-quote">“{truncate(query, 72)}”</span>
            </ThinkingState>
            {sites.length > 0 && (
              <button
                type="button"
                className="aicss-ws-chevron"
                aria-label={open ? "Hide results" : "Show results"}
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen((v) => !v)}
              >
                <Caret />
              </button>
            )}
          </span>
        </div>
      )}

      {sites.length > 0 && (
        <div className="aicss-ws-collapsible" data-collapsed={expanded ? "false" : "true"}>
          <div className="aicss-ws-inner">
            <div className="aicss-ws-results">
              <span className="aicss-ws-rail" aria-hidden="true" />
              <ul className="aicss-ws-list" id={listId} inert={!expanded}>
                {sites.map((site) => (
                  <li key={site.url} className="aicss-ws-site" data-state={site.state}>
                    {/* Three glyphs in one 12px box so the row's baseline cannot
                        move as a source resolves. */}
                    <span className="aicss-ws-bullet">
                      <span className="aicss-ws-dots">
                        <DashedRing />
                      </span>
                      <span className="aicss-ws-globe">
                        <Globe still={reducedMotion} />
                      </span>
                      <span className="aicss-ws-check">
                        <Check />
                      </span>
                    </span>
                    {/* Only a read source is a link: a pending row points at a
                        URL the run has not fetched yet. */}
                    {site.state === "done" ? (
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 items-center gap-1.5 !no-underline"
                      >
                        <span className="aicss-ws-title">{truncate(site.title, 52)}</span>
                        <span className="aicss-ws-sep">·</span>
                        <span className="aicss-ws-url">{site.label}</span>
                        <span className="aicss-ws-arrow">
                          <ArrowUp />
                        </span>
                      </a>
                    ) : (
                      <>
                        <span className="aicss-ws-title">{truncate(site.title, 52)}</span>
                        <span className="aicss-ws-sep">·</span>
                        <span className="aicss-ws-url">{site.label}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
