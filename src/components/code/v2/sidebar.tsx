"use client";

/**
 * The Code sidebar: a list of work, not navigation (TARGET §3).
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (thread rows that carry project, branch and age; state by position, with
 * the finished rest behind a collapsible "Settled" divider).
 *
 * Top: the Continuum mark and a compact Chat/Code icon switch. Then Search
 * (the command palette) with New session at its right, an "All projects"
 * filter, and one flat list: sessions that need you, then working ones, then
 * the rest by recency. A row is the title with its age; under it the project
 * and branch (or pull request). The trailing slot is the only state a row
 * shows: a coral spinner while it works, a coral raised hand when it needs
 * you. No dots, no pills, no section headers.
 *
 * Reorders use FLIP (T3 Code's Sidebar.motion timing): rows translate from
 * where they were over 150 ms, travel clamped to 40 px, entering rows fade.
 */
import * as React from "react";
import Link from "next/link";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { planFlip, relativeAge, workList, workProjects, FLIP_DURATION_MS, type ThreadSummary } from "@/lib/code-v2/thread-sections";
import { ComposerPopover, Glyph, MenuList, Spinner, useIsMac, type MenuEntry } from "./primitives";

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
        if (dy) row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: FLIP_DURATION_MS, easing: "cubic-bezier(0.32,0.72,0,1)" });
        else if (plan.entering.includes(id) && !plan.skipFades) row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIP_DURATION_MS, easing: "ease-out" });
      }
    }
    prev.current = next;
  }, [container, key]);
}

function ThreadRow({ t, active, onOpen, now }: { t: ThreadSummary; active: boolean; onOpen?: (id: string) => void; now: number }) {
  const where = t.pr ? `#${t.pr}` : t.branch;
  const state = t.state === "running" ? "Working" : t.state === "waiting" ? `Needs you${t.waitingFor ? `: ${t.waitingFor}` : ""}` : t.state === "limited" ? "Paused at a plan limit" : t.state === "error" ? "Failed" : null;
  return (
    <button
      type="button"
      data-flip={t.id}
      className="cv2-th"
      aria-current={active ? "page" : undefined}
      data-unread={t.unread ? "true" : undefined}
      title={state ? `${t.title}. ${state}` : t.title}
      onClick={() => onOpen?.(t.id)}
    >
      <span className="t cv2-trunc">{t.title}</span>
      <span className="tail">
        {t.state === "running" ? (
          <Spinner size={12} className="working" />
        ) : t.state === "waiting" ? (
          <Glyph name="hand" size={14} className="needs" />
        ) : (
          relativeAge(t.updatedAt, now)
        )}
        {state && <span className="cv2-sr">{state}</span>}
      </span>
      <span className="meta">
        <span className="cv2-trunc" style={{ flex: "0 1 auto" }}>{t.project}</span>
        {where && (
          <>
            <Glyph name={t.pr ? "pull-request" : "branch"} size={12} />
            <span className="cv2-trunc">{where}</span>
          </>
        )}
      </span>
    </button>
  );
}

export function ThreadSidebar({
  threads,
  activeId,
  userName = "You",
  onOpen,
  onNew,
  onSearch,
  onSettings,
  onCollapse,
  chatHref = "/chat",
  settingsHref = "/settings",
}: {
  threads: readonly ThreadSummary[];
  activeId?: string;
  userName?: string;
  onOpen?: (id: string) => void;
  onNew?: () => void;
  onSearch?: () => void;
  /** Settings in place (Connections lives there); falls back to the settings page. */
  onSettings?: () => void;
  /** The app shell's fold to its rail. */
  onCollapse?: () => void;
  chatHref?: string;
  settingsHref?: string;
  /** @deprecated Pull requests moved to the command palette and the header menu. */
  pullsHref?: string;
  /** @deprecated Connections moved into Settings. */
  onConnections?: () => void;
}) {
  const mac = useIsMac();
  const [project, setProject] = React.useState<string | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [showSettled, setShowSettled] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const projects = React.useMemo(() => workProjects(threads), [threads]);
  const list = React.useMemo(() => workList(threads, { project, now }), [threads, project, now]);
  const scroll = React.useRef<HTMLDivElement>(null);
  const filterRef = React.useRef<HTMLDivElement>(null);
  const order = [...list.active, ...(showSettled ? list.settled : [])].map((t) => `${t.id}.${t.state}`).join(",");
  useFlip(scroll, order);
  const initials = userName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const filterEntries: MenuEntry[] = [
    { id: "all", label: "All projects", checked: project === null, onSelect: () => setProject(null) },
    ...(projects.length ? [{ kind: "sep" as const, id: "s1" }] : []),
    ...projects.map((p) => ({ id: `p:${p}`, label: p, checked: project === p, icon: <Glyph name="folder" size={16} />, onSelect: () => setProject(p) })),
  ];

  return (
    <nav className="cv2-side" aria-label="Code sessions">
      <div className="cv2-side-top">
        <ContinuumMark size={20} />
        <div className="cv2-switch" role="group" aria-label="Product">
          <Link href={chatHref} aria-label="Chat" title="Chat">
            <Glyph name="chat" size={16} />
          </Link>
          <span aria-current="page" aria-label="Code" title="Code">
            <Glyph name="code" size={16} />
          </span>
        </div>
        {onCollapse && (
          <button type="button" className="cv2-iconbtn" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onCollapse}>
            <Glyph name="sidebar-toggle" />
          </button>
        )}
      </div>
      <div className="cv2-searchrow">
        <button type="button" className="cv2-nav" onClick={onSearch} title={`Search (${mac ? "⌘K" : "Ctrl K"})`}>
          <Glyph name="search" />
          <span className="cv2-grow">Search</span>
        </button>
        <button type="button" className="cv2-iconbtn" aria-label="New session" title={`New session (${mac ? "⌘N" : "Ctrl N"})`} onClick={onNew}>
          <Glyph name="compose" />
        </button>
      </div>
      <div className="cv2-filter" ref={filterRef}>
        <button type="button" aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen((o) => !o)}>
          {project ?? "All projects"}
          <Glyph name="chevron-down" size={12} />
        </button>
        <ComposerPopover open={filterOpen} onClose={() => setFilterOpen(false)} width={240} align="left" offset={0} label="Projects" anchorRef={filterRef} down role="menu">
          <MenuList entries={filterEntries} onClose={() => setFilterOpen(false)} label="Projects" />
        </ComposerPopover>
      </div>

      <div className="cv2-side-scroll" ref={scroll}>
        {list.active.map((t) => (
          <ThreadRow key={t.id} t={t} active={t.id === activeId} onOpen={onOpen} now={now} />
        ))}
        {list.active.length === 0 && list.settled.length === 0 && <div className="cv2-side-empty">No sessions{project ? ` in ${project}` : ""} yet.</div>}
        {list.settled.length > 0 && (
          <>
            <button type="button" className="cv2-settled" aria-expanded={showSettled} onClick={() => setShowSettled((s) => !s)}>
              <span>Settled ({list.settled.length})</span>
              <span className="rule" aria-hidden />
              <Glyph name="chevron-down" size={14} className="chev" />
            </button>
            {showSettled && list.settled.map((t) => <ThreadRow key={t.id} t={t} active={t.id === activeId} onOpen={onOpen} now={now} />)}
          </>
        )}
      </div>

      <div className="cv2-side-foot">
        <span className="cv2-avatar" aria-hidden>
          {initials}
        </span>
        <span className="cv2-grow cv2-trunc">{userName}</span>
        {onSettings ? (
          <button type="button" className="cv2-iconbtn" aria-label="Settings" title="Settings" onClick={onSettings}>
            <Glyph name="settings" />
          </button>
        ) : (
          <Link className="cv2-iconbtn" href={settingsHref} aria-label="Settings" title="Settings">
            <Glyph name="settings" />
          </Link>
        )}
      </div>
    </nav>
  );
}

