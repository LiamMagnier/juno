"use client";

/**
 * The Code column's list of work, drawn in the Chat column's own recipes.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (thread rows that carry project, branch and age; state by position, with
 * the finished rest behind a collapsible "Settled" fold).
 *
 * WHAT IT SAYS is Code's: one flat list, sessions that need you first, then
 * working ones, then the rest by recency, with the finished ones folded under
 * Settled, and an "All projects" filter over it. A row is the title with its
 * age; under it the project and branch (or pull request). The trailing slot
 * is the only state a row shows: a coral spinner while it works, a coral
 * raised hand when it needs you. No dots, no pills.
 *
 * HOW IT LOOKS is Chat's: it sits in `AppSidebar`'s list well under the same
 * header, switch, New and Search rows, its headings are `Section`'s 12 px
 * annotation on the 16 px text edge, its rows take `listRowClass`'s hover and
 * selected fills at the two-line row's 44 px (the Needs you row's metrics),
 * and its empty state is the Chat list's sentence.
 *
 * Reorders use FLIP (T3 Code's Sidebar.motion timing): rows translate from
 * where they were over 150 ms, travel clamped to 40 px, entering rows fade.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-provider";
import { LIST_ROW_TRANSITION, Section, listRowClass } from "@/components/app/sidebar-section";
import { useCodeRuns } from "@/components/code/use-code-runs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "@/components/ui/icons";
import { Icon } from "@/components/ui/juno-icons";
import { fieldFrameClass } from "@/components/ui/field-recipe";
import { MENU_W } from "@/components/ui/menu-recipe";
import { RUN_STATE_META, isBlockedOnYou, prSettled, runState } from "@/lib/code-runs";
import { newestPerConversation } from "@/lib/conversation-status";
import {
  settledByPullRequest,
  shellThreads,
  subscribeThreadStates,
  threadStateFromRun,
  threadStatesSnapshot,
} from "@/lib/code-v2/shell-threads";
import {
  FLIP_DURATION_MS,
  planFlip,
  relativeAge,
  workList,
  workProjects,
  type ThreadState,
  type ThreadSummary,
} from "@/lib/code-v2/thread-sections";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DeviceLinkTransport, EnvClient } from "@/lib/code-v2/env-client";
import { reducedMotionAt } from "@/lib/motion-preference";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { InlineTitleInput, useCodeSessionActions } from "@/components/code/v2/session-actions";
// `.title-fade`: the Chat rows' truncation, which this list shares (it is also
// drawn outside the sidebar, by the Code workspace, so it imports the rule).
import "@/components/app/sidebar-column.css";

interface RemovableCodeProject { id: string; key?: string | null; name: string; path: string }


function useFlip(container: React.RefObject<HTMLElement | null>, key: string) {
  const prev = React.useRef<Map<string, number>>(new Map());
  React.useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-flip]")];
    const next = new Map(rows.map((r) => [r.dataset.flip!, r.offsetTop]));
    const reduce = reducedMotionAt(root);
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

function stateWords(t: ThreadSummary): string | null {
  if (t.state === "running") return "Working";
  if (t.state === "waiting") return `Needs you${t.waitingFor ? `: ${t.waitingFor}` : ""}`;
  if (t.state === "limited") return "Paused at a plan limit";
  if (t.state === "error") return "Failed";
  return null;
}

/** What a row's menu can do (the app shell's list passes these; the gallery passes none). */
export interface WorkRowActions {
  rename(id: string, title: string): void;
  setPinned(id: string, pinned: boolean): void;
  share(id: string): void;
  archive(id: string): void;
  remove(id: string): void;
}

/*
 * The row's kebab floats over its right end, as in the Chat list: hidden at
 * rest, faded in with the row's hover fill, always shown on touch (a phone
 * never hovers, and the drawer is its only route to these verbs), and kept
 * while its menu is open. A right-click on the row opens the same menu.
 */
const ROW_KEBAB =
  "absolute right-1 top-1.5 grid size-7 place-items-center rounded-control text-muted-foreground opacity-0 outline-none transition-opacity duration-fast ease-out-soft hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 aria-expanded:bg-foreground/5 aria-expanded:text-foreground aria-expanded:opacity-100 motion-reduce:transition-none coarse:size-10 coarse:opacity-100";
const TRAILING_YIELDS = "transition-opacity duration-fast ease-out-soft motion-reduce:transition-none group-hover:opacity-0 group-has-[[aria-expanded=true]]:opacity-0 group-has-[button:focus-visible]:opacity-0";

function WorkRow({
  t,
  active,
  now,
  href,
  onOpen,
  actions,
}: {
  t: ThreadSummary;
  active: boolean;
  now: number;
  href?: string;
  onOpen?: (id: string) => void;
  actions?: WorkRowActions;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const where = t.pr ? `#${t.pr}` : t.branch;
  const state = stateWords(t);
  if (renaming && actions) {
    return (
      <div data-flip={t.id} className="flex min-h-11 items-center rounded-control px-1">
        <InlineTitleInput
          initial={t.title}
          // The shared field (field-recipe): it opens focused, a pressed or
          // autofocused field steps its edge up, and only the keyboard gets
          // the ring line. 32px and the row's own type, inside a 44px row.
          className={cn(fieldFrameClass, "h-8 px-2 text-nav")}
          onCommit={(value) => {
            setRenaming(false);
            if (value.trim() && value.trim() !== t.title) actions.rename(t.id, value);
          }}
          onCancel={() => setRenaming(false)}
        />
      </div>
    );
  }
  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn("title-fade min-w-0 flex-1 text-nav", t.unread && "font-medium text-foreground")}
          onDoubleClick={actions ? (e) => (e.preventDefault(), setRenaming(true)) : undefined}
        >
          {t.title}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1 text-caption tabular-nums text-muted-foreground", actions && TRAILING_YIELDS)}>
          {t.state === "running" ? (
            // The galaxy in Code's coral: the one working mark, still the moment the run stops.
            <GalaxyMark phase="working" size={14} className="text-[hsl(var(--signal))]" />
          ) : t.state === "waiting" ? (
            <Icon name="hand" size={14} className="text-[hsl(var(--signal))]" />
          ) : (
            <>
              {/* A pin reports a state here, so it does not articulate on hover. */}
              {t.pinned && <Icon name="pin" size={12} className="shrink-0" aria-hidden />}
              {relativeAge(t.updatedAt, now)}
            </>
          )}
          {state && <span className="sr-only">{state}</span>}
          {t.pinned && <span className="sr-only">Pinned</span>}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
        {/* `title-fade-hug`: this label is as wide as its text, so the
            always-on fallback mask would fade the end of a name that fits
            (sidebar-column.css). */}
        <span className="title-fade title-fade-hug min-w-0 shrink">{t.project}</span>
        {where && (
          <>
            <Icon name={t.pr ? "pull-request" : "branch"} size={12} className="shrink-0" />
            <span className="title-fade min-w-0 flex-1">{where}</span>
          </>
        )}
      </span>
    </>
  );
  const cls = cn("flex min-w-0 flex-1 flex-col py-1 pr-1.5 text-left", actions && "coarse:pr-10");
  const label = state ? `${t.title}. ${state}` : t.title;
  return (
    <div
      data-flip={t.id}
      data-active={active ? "" : undefined}
      data-conversation-row={t.id}
      className={cn("group relative flex min-h-11 items-center rounded-control pl-2 pr-1", LIST_ROW_TRANSITION, listRowClass(active))}
      onContextMenu={
        actions
          ? (e) => {
              e.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
    >
      {href ? (
        <Link href={href} prefetch={false} onClick={() => onOpen?.(t.id)} aria-current={active ? "page" : undefined} title={label} className={cls}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={() => onOpen?.(t.id)} aria-current={active ? "page" : undefined} title={label} className={cls}>
          {inner}
        </button>
      )}
      {actions && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={ROW_KEBAB} aria-label="Session options" title="Options">
              <Icon name="more" size={14} />
            </button>
          </DropdownMenuTrigger>
          {/* One hairline, before Delete: the actions are one list, and the rule puts a beat
              in front of the one row that cannot be undone. */}
          <DropdownMenuContent align="end" className={MENU_W}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Icon name="rename" size={16} /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.setPinned(t.id, !t.pinned)}>
              <Icon name={t.pinned ? "unpin" : "pin"} size={16} /> {t.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.share(t.id)}>
              <Icon name="share" size={16} /> Share…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.archive(t.id)}>
              <Icon name="archive" size={16} /> Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(t.id)}>
              <Icon name="delete" size={16} /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * The list itself, with no data source: the app shell feeds it the account's
 * sessions (`CodeShellList`), the Code workspace gallery feeds it fixtures.
 * `hrefFor` makes each row a link; without it a row is a button that calls
 * `onOpen`.
 */
export function CodeWorkList({
  threads,
  activeId,
  hrefFor,
  onOpen,
  removalTargets = [],
  onRemoveProject,
  rowActions,
}: {
  threads: readonly ThreadSummary[];
  activeId?: string;
  hrefFor?: (id: string) => string;
  onOpen?: (id: string) => void;
  removalTargets?: readonly RemovableCodeProject[];
  onRemoveProject?: (project: RemovableCodeProject) => Promise<void>;
  /** Each row's menu (rename, pin, share, archive, delete); without it rows have none. */
  rowActions?: WorkRowActions;
}) {
  const [removing, setRemoving] = React.useState<RemovableCodeProject | null>(null);
  const [removalError, setRemovalError] = React.useState<string | null>(null);
  const [removalBusy, setRemovalBusy] = React.useState(false);
  const [project, setProject] = React.useState<string | null>(null);
  const [showSettled, setShowSettled] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const projects = React.useMemo(() => [...new Set([...workProjects(threads), ...removalTargets.map((p) => p.name)])], [threads, removalTargets]);
  const list = React.useMemo(() => workList(threads, { project, now }), [threads, project, now]);
  const root = React.useRef<HTMLDivElement>(null);
  const order = [...list.active, ...(showSettled ? list.settled : [])].map((t) => `${t.id}.${t.state}`).join(",");
  useFlip(root, order);
  const row = (t: ThreadSummary) => (
    <WorkRow key={t.id} t={t} active={t.id === activeId} now={now} href={hrefFor?.(t.id)} onOpen={onOpen} actions={rowActions} />
  );

  return (
    <div ref={root}>
      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !removalBusy) setRemoving(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.name} from Alevr?</DialogTitle>
            <DialogDescription>Running sessions will stop and their records will be removed from Alevr. The folder stays on disk.</DialogDescription>
          </DialogHeader>
          {removalError && <p role="alert" className="text-ui text-destructive">{removalError}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={removalBusy} onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="destructive" disabled={removalBusy} onClick={async () => {
              if (!removing || !onRemoveProject) return;
              setRemovalBusy(true); setRemovalError(null);
              try { await onRemoveProject(removing); setProject(null); setRemoving(null); }
              catch (error) { setRemovalError(error instanceof Error ? error.message : "Could not remove this project."); }
              finally { setRemovalBusy(false); }
            }}>{removalBusy ? "Removing…" : "Remove"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* The filter is the list's first heading: `Section`'s heading recipe
          (12 px annotation on the 16 px edge, ink that answers the pointer),
          with its chevron always drawn because it opens a menu. */}
      <div className="group/section">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 max-w-full select-none items-center gap-1 rounded-control px-2 text-left text-label text-muted-foreground outline-none transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground motion-reduce:transition-none coarse:h-11"
            >
              {/* As wide as its text, like the row's project name: `title-fade-hug`. */}
              <span className="shell-annot title-fade title-fade-hug min-w-0">{project ?? "All projects"}</span>
              <ChevronDown aria-hidden className="size-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_W}>
            <DropdownMenuRadioGroup value={project ?? ""} onValueChange={(v) => setProject(v || null)}>
              <DropdownMenuRadioItem value="">All projects</DropdownMenuRadioItem>
              {projects.length > 0 && <DropdownMenuSeparator />}
              {projects.map((p) => onRemoveProject && removalTargets.some((t) => t.name === p) ? (
                <DropdownMenuSub key={p}>
                  <DropdownMenuSubTrigger>{p}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={() => setProject(p)}>Show sessions</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {removalTargets.filter((t) => t.name === p).map((target) => (
                      <DropdownMenuItem key={target.id} onSelect={() => { setRemovalError(null); setRemoving(target); }}>
                        Remove from Alevr…{removalTargets.filter((t) => t.name === p).length > 1 ? ` (${target.path})` : ""}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : <DropdownMenuRadioItem key={p} value={p}>{p}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="pt-1">{list.active.map(row)}</div>
      </div>
      {list.active.length === 0 && list.settled.length === 0 && (
        <p className="px-2 pb-2 pt-3 text-ui text-muted-foreground" aria-live="polite">
          No sessions{project ? ` in ${project}` : ""} yet.
        </p>
      )}
      {list.settled.length > 0 && (
        <Section label={`Settled · ${list.settled.length}`} isCollapsed={!showSettled} onToggleCollapse={() => setShowSettled((s) => !s)}>
          {showSettled && list.settled.map(row)}
        </Section>
      )}
    </div>
  );
}

const EMPTY = new Map();

/**
 * The app shell's Code list: the account's Code sessions, each row's state
 * from its newest run (or the open workspace's live state), on every Code
 * route (/code, /code/[id], a Code session at /chat/[id]).
 */
export function CodeShellList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { conversations, activeConversationId, removeConversation } = useApp();
  const router = useRouter();
  const [removalTargets, setRemovalTargets] = React.useState<RemovableCodeProject[]>([]);
  React.useEffect(() => {
    let live = true;
    fetch("/api/code/workspaces").then((r) => r.ok ? r.json() : null).then((body) => { if (live) setRemovalTargets(body?.workspaces ?? []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const removeProject = async (project: RemovableCodeProject) => {
    // The host forgets its authoritative folder and stops local runtimes first.
    const response = await fetch("/api/code/devices");
    if (!response.ok) throw new Error("Could not check the computers sharing this project.");
    const devices = (await response.json()).devices as { id: string; online?: boolean; workspaces?: { path: string }[] }[];
    const hosts = devices.filter((d) => d.workspaces?.some((w) => w.path === project.path));
    for (const host of hosts) {
      if (!host.online) throw new Error("Open Alevr on the Mac sharing this project so its running sessions can stop.");
      const transport = new DeviceLinkTransport(host.id);
      transport.followGlobal();
      const client = new EnvClient(transport, { timeoutMs: 36_000 });
      try { await client.request("project.remove", { cwd: project.path }); } finally { client.close(); }
    }
    const removed = await fetch("/api/code/workspaces/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: project.path, ...(project.key ? { key: project.key } : {}) }) });
    if (!removed.ok) throw new Error((await removed.json()).error ?? "Could not remove this project.");
    const ids = conversations.filter((c) => c.kind === "code" && (c.codeWorkspacePath === project.path || !!project.key && c.codeWorkspaceKey === project.key)).map((c) => c.id);
    for (const id of ids) removeConversation(id);
    setRemovalTargets((rows) => rows.filter((p) => p.id !== project.id));
    if (ids.includes(activeConversationId ?? "")) router.push("/code");
    router.refresh();
  };
  const { runs, reachableFor, openPrUrls, openPageWasFull } = useCodeRuns({ enabled: true, perConversation: true });
  const live = React.useSyncExternalStore(subscribeThreadStates, threadStatesSnapshot, () => EMPTY);

  const newest = React.useMemo(
    () =>
      newestPerConversation(
        runs,
        (run) => run.conversationId,
        (run) => run.createdAt,
      ),
    [runs],
  );
  const runStates = React.useMemo(() => {
    const out = new Map<string, ThreadState>();
    for (const [conversationId, run] of newest) {
      const reachable = reachableFor(run);
      const state = runState(run, reachable);
      if (!(state in RUN_STATE_META)) continue;
      out.set(conversationId, threadStateFromRun(state, isBlockedOnYou(run, reachable)));
    }
    return out;
  }, [newest, reachableFor]);
  // A session whose pull request merged or closed settles by itself.
  const settled = React.useMemo(
    () => settledByPullRequest(conversations, newest, (run) => prSettled(run, openPrUrls, openPageWasFull)),
    [conversations, newest, openPrUrls, openPageWasFull],
  );

  const threads = React.useMemo(() => shellThreads(conversations, runStates, live, settled), [conversations, runStates, live, settled]);
  // The route names the open session; off a session route, the open
  // conversation does, when it is one of these sessions.
  const activeId =
    pathname?.match(/^\/(?:code|chat)\/([^/?#]+)/)?.[1] ??
    (activeConversationId && threads.some((t) => t.id === activeConversationId) ? activeConversationId : undefined);

  // The same verbs as the open session's own menu (session-actions.tsx), with its dialogs.
  const session = useCodeSessionActions();
  const rowActions: WorkRowActions = { rename: session.rename, setPinned: session.setPinned, share: session.requestShare, archive: session.archive, remove: session.requestDelete };

  return (
    <>
      <CodeWorkList removalTargets={removalTargets} onRemoveProject={removeProject} threads={threads} activeId={activeId} hrefFor={(id) => `/code/${id}`} onOpen={() => onNavigate?.()} rowActions={rowActions} />
      {session.ui}
    </>
  );
}
