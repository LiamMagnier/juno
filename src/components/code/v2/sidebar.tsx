"use client";

/**
 * The Code sidebar (DESIGN §4.1): the Chat/Code switch, New session, Search,
 * Pull requests, Connections, then "Needs you" and one section per project.
 * A running thread shows the spinner glyph at its trailing edge, a thread
 * waiting on the reader the coral hand. No dots, no pills.
 *
 * Reorders use FLIP (INTERACTION I-14, T3 Code's Sidebar.motion timing):
 * rows translate from where they were over 150 ms, travel clamped to 40 px,
 * entering rows fade; more than 40 fades in one update skips the fades.
 */
import * as React from "react";
import Link from "next/link";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { planFlip, threadSections, threadTrailingGlyph, FLIP_DURATION_MS, type ThreadSummary } from "@/lib/code-v2/thread-sections";
import { Glyph, Kbd, Spinner, useIsMac } from "./primitives";
import { cn } from "@/lib/utils";

function useFlip(container: React.RefObject<HTMLElement | null>, key: string) {
  const prev = React.useRef<Map<string, number>>(new Map());
  React.useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-flip]")];
    const next = new Map(rows.map((r) => [r.dataset.flip!, r.offsetTop]));
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || root.closest("[data-reduced-motion='true']");
    if (prev.current.size && !reduce) {
      const plan = planFlip(prev.current, next);
      for (const row of rows) {
        const id = row.dataset.flip!;
        const dy = plan.moves.get(id);
        if (dy) {
          row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: FLIP_DURATION_MS, easing: "cubic-bezier(0.32,0.72,0,1)" });
        } else if (plan.entering.includes(id) && !plan.skipFades) {
          row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIP_DURATION_MS, easing: "ease-out" });
        }
      }
    }
    prev.current = next;
  }, [container, key]);
}

export function ThreadSidebar({
  threads,
  activeId,
  userName = "You",
  onOpen,
  onNew,
  onSearch,
  onConnections,
  onCollapse,
  pullsHref = "/code/pulls",
  chatHref = "/chat",
}: {
  threads: readonly ThreadSummary[];
  activeId?: string;
  userName?: string;
  onOpen?: (id: string) => void;
  onNew?: () => void;
  onSearch?: () => void;
  onConnections?: () => void;
  /** The app shell's fold to its rail. */
  onCollapse?: () => void;
  pullsHref?: string;
  chatHref?: string;
}) {
  const mac = useIsMac();
  const sections = React.useMemo(() => threadSections(threads), [threads]);
  const scroll = React.useRef<HTMLDivElement>(null);
  const order = sections.map((s) => `${s.id}:${s.threads.map((t) => `${t.id}.${t.state}`).join(",")}`).join("|");
  useFlip(scroll, order);
  const initials = userName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <nav className="cv2-side" aria-label="Code threads">
      <div className="cv2-side-top">
        <ContinuumMark size={20} />
        <div className="cv2-switch" role="group" aria-label="Product">
          <Link href={chatHref}>
            <span>
              <Glyph name="chat" size={14} /> Chat
            </span>
          </Link>
          <span className="on" aria-current="page">
            <Glyph name="code" size={14} /> Code
          </span>
        </div>
        {onCollapse && (
          <button type="button" className="cv2-iconbtn" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}>
            <Glyph name="sidebar-toggle" />
          </button>
        )}
      </div>
      <button type="button" className="cv2-nav" onClick={onNew}>
        <Glyph name="compose" />
        <span className="cv2-grow">New session</span>
        <span className="cv2-wide">
          <Kbd k="mod+n" mac={mac} />
        </span>
      </button>
      <button type="button" className="cv2-nav" onClick={onSearch}>
        <Glyph name="search" />
        <span className="cv2-grow">Search</span>
        <span className="cv2-wide">
          <Kbd k="mod+k" mac={mac} />
        </span>
      </button>
      <Link className="cv2-nav" href={pullsHref}>
        <Glyph name="pull-request" />
        <span className="cv2-grow">Pull requests</span>
      </Link>
      <button type="button" className="cv2-nav" onClick={onConnections}>
        <Glyph name="plug" />
        <span className="cv2-grow">Connections</span>
      </button>

      <div className="cv2-side-scroll" ref={scroll}>
        {sections.map((section) => (
          <div key={section.id} role="group" aria-label={section.title}>
            {section.kind === "project" ? (
              <div className="cv2-nav" style={{ marginTop: 10, cursor: "default" }} aria-hidden>
                <Glyph name="folder" />
                <span className="cv2-trunc">{section.title}</span>
              </div>
            ) : (
              <div className="cv2-side-h">{section.title}</div>
            )}
            {section.threads.map((t) => {
              const glyph = threadTrailingGlyph(t.state);
              return (
                <button
                  key={`${section.id}:${t.id}`}
                  data-flip={`${section.id}:${t.id}`}
                  type="button"
                  className={cn("cv2-nav cv2-flip-row", section.kind === "needs-you" ? "needs" : "sub")}
                  aria-current={t.id === activeId ? "page" : undefined}
                  title={t.waitingFor ? `${t.title}: ${t.waitingFor}` : t.title}
                  onClick={() => onOpen?.(t.id)}
                >
                  <span className="cv2-trunc cv2-grow">{t.title}</span>
                  {glyph && (
                    <span className="tail">
                      {glyph === "loading" ? (
                        <Spinner />
                      ) : (
                        <Glyph name={glyph} className={glyph === "needs-you" ? "cv2-sig" : glyph === "error-circle" ? "cv2-del" : undefined} />
                      )}
                      <span className="cv2-sr">
                        {t.state === "running" ? "Working" : t.state === "waiting" ? "Needs you" : t.state === "limited" ? "Paused at a plan limit" : "Failed"}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cv2-side-foot">
        <span className="cv2-avatar" aria-hidden>
          {initials}
        </span>
        <span className="cv2-grow cv2-trunc">{userName}</span>
        <Link className="cv2-iconbtn" href="/settings" aria-label="Settings">
          <Glyph name="settings" />
        </Link>
      </div>
    </nav>
  );
}
