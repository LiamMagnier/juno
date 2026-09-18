"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, ChevronUp, Pin, Plus } from "lucide-react";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { DownloadMenu } from "@/components/app/download-menu";
import { UserAvatar, UserMenu } from "@/components/app/user-menu";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { JunoMark } from "@/components/brand/logo";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApp } from "@/components/app/app-provider";
import { ProductSwitch, type ProductSurface } from "@/components/app/product-switch";
import { ShareDialog } from "@/components/share/share-dialog";
import { useCodeRuns } from "@/components/code/use-code-runs";
import { useWorkRunsByConversation } from "@/components/work/inbox/use-needs-you-count";
import { StatusDot, statusLabel, statusSentence, statusTone } from "@/components/work/work-vocabulary";
import { RUN_STATE_META, isBlockedOnYou, runState } from "@/lib/code-runs";
import { codeRunTone, newestPerConversation, workRunIsOpen, type StatusTone } from "@/lib/conversation-status";
import { PLANS } from "@/lib/plans";
import { spring, staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";

/* ────────────────────────────────────────────────────────────────────────────
 * The sidebar (docs/design/FLAT_UI.md §3).
 *
 * A flat panel (the frame is painted by `.app-sidebar-frame` in the shell)
 * holding, top to bottom: brand + Search + collapse, the Chat · Code product
 * switch, New, the nav destinations, the folds, and a footer of one 36px
 * account band.
 *
 * ONE SHAPE, TWO PRODUCTS (docs/design/TWO_PRODUCTS.md §3). `product` picks the
 * destinations and which conversations the folds hold; NOTHING else forks. That
 * is deliberate and it is the whole point: Code used to have its sessions on a
 * list PAGE with its own header, its own tabs, its own search field and its own
 * All | Cloud | My Macs filter, while this panel filtered every Code
 * conversation OUT — so an open Code session had no row anywhere in the shell
 * and the run that had stopped to ask you something was only visible if you
 * happened to be standing on /code. A session is a conversation in both
 * products; the panel that lists conversations lists both.
 *
 * WHAT A ROW CAN SAY ABOUT A RUN. Every row is a title and one 6px mark in a
 * `size-4` slot. At rest that mark is the hollow bullet it has always been;
 * when the conversation is carrying a run it becomes that run's toned status
 * dot (`StatusDot`), which is a state and not a decoration — the same mark, the
 * same five tones and the same 3:1 argument as the transcript's, read from
 * `lib/conversation-status.ts` so a status cannot be amber here and coral
 * there. One mark, never two (docs/design/PREMIUM_AUDIT.md rule 6): the run's
 * sentence rides the row's tooltip and its label rides the accessible name.
 *
 * AND ONE FETCH BEHIND ALL OF THEM. The join from conversation to run is a
 * single account-wide poll per product, keyed by `conversationId` in memory.
 * A fetch per row would be forty requests every few seconds for the quietest
 * column in the product.
 *
 * SEARCH IS A FIELD AT THE TOP OF THE COLUMN, which is where it started and
 * where it has come back to. It spent a release as a magnifier in the panel
 * header on a measurement — the column spent 330px before the first
 * conversation title — and on a real distinction: a nav list is a list of
 * PLACES, and search is a command that opens a palette over the window and
 * returns you where you were, which is why Linear, Raycast and Arc keep it in
 * the chrome.
 *
 * The distinction holds and the conclusion did not. Claude's sidebar, the
 * reference for this pass, spends MORE of this column than Juno's did — a
 * field, seven destinations, a More — and reads calmer, because a sidebar
 * feels heavy per ROW, not per column; 34px of reclaimed height never
 * addressed what the panel was actually being judged on. And a field and a
 * glyph are not the same control: a field says what it searches by holding a
 * placeholder, while a 16px mark in a corner it shares with the collapse
 * toggle says nothing, and this is the control people arrive looking for.
 * It is a BUTTON wearing a field — one search surface, one caret.
 *
 * THE DENSITY LADDER, and nothing off it. Rows are `h-10` (40px) carrying
 * `text-body` (15px) and a `size-5` box holding a `size-4.5` glyph at
 * `gap-3`, so every label in the panel starts 44px from its edge.
 *
 * Those numbers ARE the rework. The panel was `h-9`/`text-ui`/`size-3.5` at
 * `gap-2` on a 32px edge, and every step to it is defensible on its own —
 * chrome quieter than content, a glyph no larger than its label, rows tight
 * enough that the list starts high. Together they made a column you read at
 * arm's length rather than glanced at, which is what "it looks horrible" was
 * pointing at. 15px is `body`, the rung the product reads PROSE at, so the
 * panel shares a size with the page instead of inventing a chrome-only one;
 * 18px under it holds the same glyph-to-label ratio 14-under-13 did.
 *
 * Section headings, date folds and the Needs-you toggle are `h-7` sentence-case
 * SANS at the `ui` rung on the same 44px edge — one voice, one step below its
 * rows. They were mono at `label`, which is the eyebrow a settings page heads
 * its groups with: mono is a machine voice, and these name piles of the
 * reader's own chats. Glyphs may only be `size-3`, `size-3.5`, `size-4`,
 * `size-4.5` or `size-5` — every one of which has a rung on the optical stroke
 * ladder in globals.css, so a bigger mark thins rather than fattening.
 *
 * HOVER IS WEAKER THAN ACTIVE. `bg-sidebar-accent/60` on hover, the full fill
 * when selected. They used to be the same fill, so pointing anywhere in the
 * column made two rows claim to be selected at once and the real one vanished
 * under the pointer. Selection is fill + ink + (in a list) a filled bullet —
 * never weight: swapping a title from medium to semibold on click re-measured
 * it and visibly re-truncated the row you had just chosen.
 *
 * ONE TREE FOR BOTH WIDTHS. The rail is not a second component: every row is
 * a `motion.div layout`, so collapsing to 64px slides the glyphs into a
 * column and expanding slides them back, while the labels and the lists fade.
 * Two trees cross-fading read as a swap; one tree moving reads as the panel
 * folding, which is what a collapse is.
 * ──────────────────────────────────────────────────────────────────────────── */

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
} | null;

type SidebarProject = {
  id: string;
  name: string;
  nameSource?: "default" | "ai" | "manual";
  starred: boolean;
  updatedAt: string;
  conversationCount: number;
};

const LEGACY_STARRED_KEY = "starredProjects";
const RECENTS_PAGE = 40;

/* Recents is NOT here any more: its date folds are its headings now, so there
   is no "Recents" row left to collapse. The orphaned
   `juno:sidebar:recents:collapsed` key is harmless — a reader who had the
   section folded simply finds their chats back. */
const SECTION_KEYS = {
  projects: "juno:sidebar:projects:collapsed",
  pinned: "juno:sidebar:starred:collapsed",
} as const;

type SectionKey = keyof typeof SECTION_KEYS;

/**
 * What one row is allowed to say about the run behind it: a tone for its mark,
 * a label for a screen reader, and the sentence that explains the state.
 *
 * The three come from the vocabulary that owns the run — `work-vocabulary.tsx`
 * for a task, `RUN_STATE_META` for a Code run — and are never written here. A
 * row restating a status in its own words is how one state ends up with two
 * names, which is the failure both of those modules exist to prevent.
 */
type RowSignal = { tone: StatusTone; label: string; meaning: string };

/** Recents fall into ChatGPT's four buckets, in this order. */
const RECENTS_GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;
type RecentsGroup = (typeof RECENTS_GROUPS)[number];

/** Which bucket a chat's last activity falls in, by the LOCAL calendar day —
 *  "yesterday" is the reader's yesterday, not a rolling 24 hours. */
function recentsGroupOf(iso: string, now: Date): RecentsGroup {
  const stamp = new Date(iso).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  // An unparsable date (or a clock skewed into the future) lands in Today
  // rather than vanishing into Older.
  if (Number.isNaN(stamp) || stamp >= startOfToday) return "Today";
  if (stamp >= startOfToday - day) return "Yesterday";
  if (stamp >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}

/**
 * The row kebab, once. `coarse:opacity-100` is not polish: reveal-on-hover is
 * the only way this control appears, and a touch device never hovers — on a
 * phone the drawer is the only route to rename, move or delete a chat.
 *
 * `rounded-control`, not `Pressable kind="icon"`'s circle: it sits inside a
 * `rounded-control` row and beside the composer's `rounded-control` icon
 * buttons, and it was the only disc in either. `coarse:size-10` rather than
 * `size-11` so it does not fill a 44px touch row edge to edge.
 */
const KEBAB_CLASS =
  "group/kebab size-7 shrink-0 rounded-control opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-sidebar-accent data-[state=open]:opacity-100 coarse:size-10 coarse:opacity-100";

export function AppSidebar({
  collapsed = false,
  onToggleCollapse,
  product,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /**
   * Which product's column this is. Derived once in `AppShell` — where the
   * route and the open conversation's kind both already live — and passed down,
   * rather than each of the two mounts (the aside and the phone drawer) working
   * it out again and being able to disagree.
   */
  product: ProductSurface;
}) {
  const isCode = product === "code";
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const {
    conversations,
    updateConversation,
    removeConversation,
    upsertConversation,
    activeConversationId,
    setSidebarOpen,
    user,
    quota,
  } = useApp();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);
  // Date grouping depends on the local clock, so the list waits for mount to
  // keep SSR and the first client render in agreement.
  const [mounted, setMounted] = React.useState(false);
  const [projects, setProjects] = React.useState<SidebarProject[]>([]);
  const [projectsError, setProjectsError] = React.useState(false);
  const [sectionCollapsed, setSectionCollapsed] = React.useState<Record<SectionKey, boolean>>({
    projects: false,
    pinned: false,
  });
  const [renameTarget, setRenameTarget] = React.useState<SidebarProject | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renamingProject, setRenamingProject] = React.useState(false);
  const [shareId, setShareId] = React.useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = React.useState(false);
  /*
   * The triage the Work inbox did, as a filter rather than as a page.
   *
   * The rejected alternative was a `/tasks` destination — the inbox under a new
   * name, which is the thing being removed (docs/design/TWO_PRODUCTS.md §2.2).
   * Pressing the "Needs you" header hides everything else in the panel, so the
   * list you are already reading becomes the queue instead of sending you to a
   * second list somewhere else. Not persisted: it is a stance you take for a
   * minute, not a preference, and a panel that came back filtered tomorrow
   * would look like a panel that had lost your chats.
   */
  const [needsYouOnly, setNeedsYouOnly] = React.useState(false);
  const [recentsLimit, setRecentsLimit] = React.useState(RECENTS_PAGE);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  const migratedLegacyStars = React.useRef(false);

  const loadProjects = React.useCallback(async () => {
    setProjectsError(false);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error();
      const data = await res.json();
      const nextProjects: SidebarProject[] = Array.isArray(data.projects) ? data.projects : [];
      if (!migratedLegacyStars.current) {
        migratedLegacyStars.current = true;
        try {
          const raw = JSON.parse(localStorage.getItem(LEGACY_STARRED_KEY) || "[]");
          const legacy: string[] = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
          if (legacy.length > 0) {
            const toStar = nextProjects.filter((p) => legacy.includes(p.id) && !p.starred);
            const results = await Promise.all(
              toStar.map((p) =>
                fetch(`/api/projects/${p.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ starred: true }),
                })
                  .then((r) => r.ok)
                  .catch(() => false)
              )
            );
            toStar.forEach((p, i) => {
              if (results[i]) p.starred = true;
            });
            if (results.every(Boolean)) localStorage.removeItem(LEGACY_STARRED_KEY);
          } else {
            localStorage.removeItem(LEGACY_STARRED_KEY);
          }
        } catch {
          /* storage unavailable — server state stands */
        }
      }
      React.startTransition(() => setProjects(nextProjects));
    } catch {
      setProjectsError(true);
    }
  }, []);

  React.useEffect(() => {
    setMounted(true);
    loadProjects();
    try {
      const next: Record<SectionKey, boolean> = { projects: false, pinned: false };
      for (const key of Object.keys(SECTION_KEYS) as SectionKey[]) {
        const raw = localStorage.getItem(SECTION_KEYS[key]);
        if (raw) next[key] = JSON.parse(raw) === true;
      }
      setSectionCollapsed(next);
    } catch {}
    const handleSync = () => loadProjects();
    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [loadProjects]);

  const toggleSection = (key: SectionKey) => {
    setSectionCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(SECTION_KEYS[key], JSON.stringify(next[key]));
      } catch {}
      return next;
    });
  };

  // Infinite scroll for Recents: a sentinel at the foot of the list asks for
  // the next page as it scrolls into the well.
  React.useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRecentsLimit((n) => n + RECENTS_PAGE);
      },
      { root, rootMargin: "160px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [mounted, collapsed]);

  const sidebarProjects = React.useMemo(
    () =>
      [...projects]
        .filter((p) => p.starred)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [projects]
  );

  const toggleProjectStar = async (project: SidebarProject) => {
    const next = !project.starred;
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, starred: next } : p)));
    const r = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)));
      toast.error("Couldn’t update the project.");
      return;
    }
    toast.success(next ? "Project pinned." : "Project unpinned.");
    window.dispatchEvent(new CustomEvent("starred:sync"));
    window.dispatchEvent(new CustomEvent("projects:sync"));
  };

  const renameProject = async () => {
    if (!renameTarget || !renameDraft.trim()) return;
    setRenamingProject(true);
    try {
      const r = await fetch(`/api/projects/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameDraft.trim() }),
      });
      if (!r.ok) throw new Error();
      toast.success("Project renamed.");
      await loadProjects();
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setRenameTarget(null);
    } catch {
      toast.error("Couldn’t rename project.");
    } finally {
      setRenamingProject(false);
    }
  };

  const deleteProject = (project: SidebarProject) => {
    setConfirm({
      title: "Delete this project?",
      description:
        "Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.",
      confirmLabel: "Delete project",
      onConfirm: async () => {
        const r = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
        if (!r.ok) {
          toast.error("Couldn’t delete project.");
          return;
        }
        toast.success("Project deleted.");
        window.dispatchEvent(new CustomEvent("projects:sync"));
        if (pathname === `/projects/${project.id}`) router.push("/projects");
      },
    });
  };

  const archiveConversation = React.useCallback(
    async (c: ClientConversation) => {
      // The row's own kind names it, rather than the column it was pressed in:
      // a Code session archived from a search result is still a session, and a
      // product that calls one thing two things in two toasts has no vocabulary.
      const noun = c.kind === "code" ? "session" : "chat";
      removeConversation(c.id);
      const res = await fetch(`/api/conversations/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }).catch(() => null);
      if (!res?.ok) {
        upsertConversation(c);
        toast.error(`Couldn’t archive the ${noun}.`);
        return;
      }
      toast.success(c.kind === "code" ? "Session archived." : "Chat archived.", {
        action: {
          label: "Undo",
          onClick: async () => {
            const r = await fetch(`/api/conversations/${c.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ archived: false }),
            }).catch(() => null);
            if (r?.ok) upsertConversation({ ...c, archivedAt: null });
          },
        },
      });
      if (c.id === activeConversationId) {
        // The product the row belonged to, not always Chat — archiving the Code
        // session you are reading should not move you to another product.
        router.push(c.kind === "code" ? "/code" : "/chat");
        if (c.kind !== "code") window.dispatchEvent(new CustomEvent("juno:new-chat"));
      }
    },
    [activeConversationId, removeConversation, router, upsertConversation]
  );

  /* ── What is running behind these rows ───────────────────────────────── */

  /*
   * One poll per product, and only the one this column is showing.
   *
   * Hooks cannot be called conditionally, so both are mounted and the inactive
   * one is told not to fetch. That is not a trick to get around the rule: a
   * Chat column has nothing to say about Code runs and vice versa, so a poll
   * for the other product is a request whose answer is discarded.
   */
  const workRuns = useWorkRunsByConversation({ enabled: !isCode });
  const { runs: codeRuns, reachableFor } = useCodeRuns({ enabled: isCode, perConversation: true });

  /*
   * The two products' runs, reduced to the same three facts per conversation.
   *
   * A Chat row only lights up while its run is still the reader's business —
   * a finished task leaves the conversation a conversation, and a permanent
   * green tick on every chat that ever delegated something is decoration. A
   * Code row always carries its state, because in that product the row IS the
   * session and "finished, nothing to review" is the answer somebody opened
   * the panel for.
   */
  const rowSignals = React.useMemo(() => {
    const signals = new Map<string, RowSignal>();
    if (isCode) {
      const newest = newestPerConversation(
        codeRuns,
        (run) => run.conversationId,
        (run) => run.createdAt,
      );
      for (const [conversationId, run] of newest) {
        const state = runState(run, reachableFor(run));
        const meta = RUN_STATE_META[state];
        signals.set(conversationId, { tone: codeRunTone(state), label: meta.label, meaning: meta.meaning });
      }
      return signals;
    }
    for (const [conversationId, session] of workRuns.byConversation) {
      if (!workRunIsOpen(session.status, session.needsAttention)) continue;
      signals.set(conversationId, {
        tone: statusTone(session.status),
        label: statusLabel(session.status),
        meaning: statusSentence(session.status),
      });
    }
    return signals;
  }, [isCode, codeRuns, reachableFor, workRuns.byConversation]);

  /** The conversations whose newest run has stopped for a person. */
  const needsYouIds = React.useMemo(() => {
    if (!isCode) return workRuns.needsYou;
    const ids = new Set<string>();
    const newest = newestPerConversation(
      codeRuns,
      (run) => run.conversationId,
      (run) => run.createdAt,
    );
    for (const [conversationId, run] of newest) {
      if (isBlockedOnYou(run, reachableFor(run))) ids.add(conversationId);
    }
    return ids;
  }, [isCode, codeRuns, reachableFor, workRuns.needsYou]);

  /* ── Lists ───────────────────────────────────────────────────────────── */

  /*
   * The panel holds ONE product's conversations. It used to hold Chat's and
   * filter `kind === "code"` out unconditionally, which is why an open Code
   * session had no row anywhere in the shell.
   */
  const live = React.useMemo(
    () => conversations.filter((c) => !c.archivedAt && (c.kind === "code") === isCode),
    [conversations, isCode]
  );
  /*
   * Needs you takes precedence over Pinned, and over the date folds.
   *
   * A row can only be in one place, and of the three this is the one with a
   * deadline attached to a person: a pinned chat that has stopped to ask a
   * question is not usefully filed under "you like this one".
   */
  const needsYouRows = React.useMemo(() => live.filter((c) => needsYouIds.has(c.id)), [live, needsYouIds]);
  const pinned = React.useMemo(() => live.filter((c) => c.pinned && !needsYouIds.has(c.id)), [live, needsYouIds]);
  // Project chats stay in Recents as well as under their project, because a
  // project is a workspace rather than a filing.
  const recents = React.useMemo(
    () => live.filter((c) => !c.pinned && !needsYouIds.has(c.id)),
    [live, needsYouIds]
  );
  // The page in view, bucketed by day. Grouped AFTER the slice so the
  // infinite-scroll page size still counts chats, not groups; a group with
  // nothing in the page is simply not drawn.
  const groupedRecents = React.useMemo(() => {
    const now = new Date();
    const buckets = new Map<RecentsGroup, ClientConversation[]>();
    for (const c of recents.slice(0, recentsLimit)) {
      const group = recentsGroupOf(c.lastMessageAt || c.createdAt, now);
      buckets.set(group, [...(buckets.get(group) ?? []), c]);
    }
    return RECENTS_GROUPS.flatMap((group) => {
      const rows = buckets.get(group);
      return rows ? [{ group, rows }] : [];
    });
  }, [recents, recentsLimit]);

  /*
   * Answer the last question and the filter lets go of the panel.
   *
   * Without this, clearing the fold leaves the reader looking at an empty
   * column with the thing that emptied it no longer on screen to press again —
   * a filter that has hidden every row including its own control.
   */
  React.useEffect(() => {
    if (needsYouRows.length === 0) setNeedsYouOnly(false);
  }, [needsYouRows.length]);

  const newChat = () => {
    router.push("/chat");
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };

  const rowProps = {
    renamingId,
    setRenaming: setRenamingId,
    projects,
    onUpdate: updateConversation,
    onRemove: removeConversation,
    onNavigate: () => setSidebarOpen(false),
    onRequestConfirm: setConfirm,
    onShare: setShareId,
    onArchive: archiveConversation,
  };

  const plan = PLANS[quota.plan];
  /*
   * Usage in the footer is a WORD, not a meter.
   *
   * The account menu behind this row already draws the same quota as a
   * `DotFillBar` with a `Messages 12 / 15` header, so the footer's `Progress`
   * bar was a second read of one number — and a bar at 12% full is furniture.
   * Below 80% the footer says nothing about usage at all; above it the plan
   * segment changes copy and tone, which is the only moment the number is
   * worth a person's attention. `quota.remaining` is preferred over
   * `limit - used` so the copy matches whatever the server computed, and it is
   * nullable (types/chat.ts) so it is guarded.
   */
  const usagePct =
    quota.limit != null && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : null;
  const remaining = quota.remaining ?? (quota.limit != null ? Math.max(0, quota.limit - quota.used) : null);
  const planSegment =
    usagePct == null || usagePct < 80
      ? { label: plan.name, tone: "text-muted-foreground" }
      : usagePct >= 100
        ? { label: "Limit reached", tone: "text-destructive" }
        : { label: `${remaining ?? 0} left`, tone: "text-warning" };
  // The whole truth always rides the accessible name, so nothing a sighted
  // reader can see is lost to the truncation on that one line.
  const accountLabel = `${user.name ?? user.email ?? "Account"}, ${plan.name} plan${
    quota.limit == null ? ", no message cap" : `, ${quota.used} of ${quota.limit} messages used`
  }`;

  const layoutTransition = reduceMotion ? { duration: 0 } : spring.layout;

  return (
    <LayoutGroup id="juno-sidebar">
      <div
        key="sidebar"
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "flex h-full flex-col text-sidebar-foreground",
          // Desktop width rides the shell's --juno-sidebar-width (user-resizable);
          // keeping it on the inner column preserves the collapse clip-reveal.
          // w-16 = 64px = app-shell's RAIL_WIDTH. Not the spec's 56: the
          // product switch's rail items are 44px inside `px-2.5`, which is
          // exactly 64, and that control is signed off and not ours to resize.
          collapsed ? "w-16" : "w-full md:w-[var(--juno-sidebar-width,256px)]"
        )}
      >
        {/* ── Collapse · Brand · Chat|Code ─────────────────────────────── */}
        {/*
         * THE REFERENCE'S HEADER, and it is three things on one 36px line:
         * the collapse control, the wordmark, and the product switch.
         *
         * The switch used to be a full-width labelled pill on its own block
         * below this row — `pb-6 pt-3` around two 36px segments, so roughly
         * 72px of the column spent on a control pressed twice a session, and
         * at 100% width the widest object in the panel. Here it is 64×28 in
         * space the header was already holding open, and the 72px goes to the
         * list. That is more than the search field costs, which is the whole
         * answer to the argument search was moved out of this column on.
         *
         * Collapse moves to the LEFT of the wordmark, which is the one part
         * of this that is arrangement rather than economy: with the switch on
         * the right, two controls on the right would be a cluster whose two
         * halves do unrelated things — one hides this column, the other
         * changes which product it lists. Split, each sits on the side of the
         * thing it acts on.
         */}
        <motion.div
          layout
          transition={layoutTransition}
          className={cn("flex items-center pt-2", collapsed ? "flex-col gap-1 px-2.5" : "h-9 gap-1 px-2")}
        >
          {onToggleCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn("group hidden shrink-0 md:inline-flex", collapsed ? "size-11" : "size-7 coarse:size-9")}
                  onClick={onToggleCollapse}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-keyshortcuts="Meta+Shift+S"
                >
                  <SidebarMotionIcon kind={collapsed ? "panel-open" : "panel-close"} className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={collapsed ? "right" : "bottom"}>
                {collapsed ? "Expand sidebar" : "Collapse sidebar"} <Kbd className="ml-1">⌘⇧S</Kbd>
              </TooltipContent>
            </Tooltip>
          )}
          <motion.div layout="position" transition={layoutTransition} className="min-w-0 flex-1">
            <Link
              href="/chat"
              onClick={() => setSidebarOpen(false)}
              aria-label="Juno home"
              className={cn(
                "group/brand flex items-center gap-2 rounded-control",
                collapsed ? "size-11 justify-center" : "h-9"
              )}
            >
              <JunoMark className="size-5 shrink-0" />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.span
                    key="wordmark"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={reduceMotion ? { duration: 0 } : transition.fast}
                    className="overflow-hidden whitespace-nowrap font-sans text-body-lg font-semibold tracking-[-0.02em] text-foreground"
                  >
                    Juno
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          </motion.div>
          {/* The ONE product switch in the shell. Expanded it is this 28px
              icon pair; at the rail it stays the 44px icon column below,
              because 64px has no room for a header row at all. */}
          {!collapsed && (
            <ProductSwitch
              active={product}
              plan={quota.plan}
              onNavigate={() => setSidebarOpen(false)}
            />
          )}
          {!collapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="group size-7 shrink-0 md:hidden coarse:size-9"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close menu"
                >
                  <SidebarMotionIcon kind="close" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close</TooltipContent>
            </Tooltip>
          )}
        </motion.div>

        {/* The rail keeps the stacked icon column: see the note above. */}
        {collapsed && (
          <ProductSwitch
            collapsed
            active={product}
            plan={quota.plan}
            onNavigate={() => setSidebarOpen(false)}
          />
        )}

        {/* ── Search + New chat ────────────────────────────────────────── */}
        {/* `pt-2` when expanded: the product switch no longer sits between this
            and the header, so the 8px this column puts between sibling groups
            has to be spent here instead of inherited from that block. */}
        {/* These two and the three destinations below are ONE navigation
            block, not two. They used to be separated by 16px (this block's
            own bottom plus the nav's `pt-2`), which is the same gap the panel
            spends between the product switch and the whole navigation — so
            the column read as four stacked groups rather than a header and a
            list, and the first chat title started ~300px down. */}
        {/* `space-y-1.5` = the 6.4px the reference leaves between the field and
            the first row of the list. It is the only gap in this whole column:
            the field is a different KIND of object from the rows below it, and
            six pixels is what says so without a rule. Everything under it
            abuts. (It was `mb-1.5` on this block, which put the six pixels
            below New rather than above it — the one place they do nothing.) */}
        <div className={cn("pt-2", collapsed ? "space-y-1 px-2.5" : "space-y-1.5 px-2")}>
          {/* SEARCH IS A FIELD AGAIN, and it is the first thing in the column.
              It spent a release as a magnifier in the panel header, on the
              argument that a nav list is a list of PLACES and search is a
              command — true — and that the row it cost was worth more than the
              label (the column spent ~330px before the first conversation
              title). The second half is what did not hold up. Claude spends MORE
              of this column than Juno did — a field, seven destinations and a
              More — and reads calmer, because what makes a sidebar feel heavy
              is row DENSITY, not row count. Fixing the density (below) buys the
              row back with change to spare.

              And the header icon was never really the same control. A field
              says what it searches by having a placeholder; a 16px glyph in a
              corner shared with the collapse toggle says nothing, and it is the
              one control in this panel people arrive looking for.

              A BUTTON that looks like a field, not an input. Typing here would
              have to either filter in place — which is the browser-side title
              filter /api/search replaced, and it cannot see message text, files
              or memories — or forward every keystroke into the palette, which
              is two inputs fighting over one caret. One search surface, one
              caret, and this opens it. */}
          <SidebarSearchField collapsed={collapsed} />

          <NavRow
            collapsed={collapsed}
            href={isCode ? "/code" : undefined}
            onClick={isCode ? () => setSidebarOpen(false) : newChat}
            /* Plain, like every sibling. The 22px tinted tile that used to sit
               behind this glyph was the only chip in the panel, and it is what
               made the one row people press most read as the chunkiest. */
            icon={<SidebarMotionIcon kind="new" />}
            label={isCode ? "New session" : "New chat"}
            trailing={isCode ? undefined : <Kbd>⌘⇧O</Kbd>}
            layoutId="nav-new"
            transition={layoutTransition}
          />
        </div>

        {/* ── Destinations ─────────────────────────────────────────────── */}
        {/* Library · Projects · Artifacts, then More for the rest. The rail
            keeps the same order icon-only; More opens the same flyout. */}
        {/* `min-h-0 flex-1 overflow-y-auto` on the rail: collapsed, the list
            scroller below renders nothing, all thirteen rail rows sit in
            non-scrolling blocks, and the shell's `<aside>` is `overflow-hidden`
            — so on a short window the account control was simply clipped away
            with no way to reach it. */}
        <nav
          className={cn(
            // `pt-0.5`, matching the row gap above it: see the note on the
            // Search block — this is the same navigation block continuing.
            collapsed ? "min-h-0 flex-1 overflow-y-auto no-scrollbar space-y-1 px-2.5 pt-2" : "px-2"
          )}
          aria-label="Primary"
        >
          {(isCode
            ? ([
                /* Code's two destinations.

                   Artifacts is shared with Chat — one library of generated
                   things, not one per product.

                   Customize is Code's and Chat has no equivalent, deliberately:
                   Code is the product with page-sized configuration —
                   repositories, Mac workspaces, the default permission mode
                   (docs/design/TWO_PRODUCTS.md §2.2) — while Chat's are already
                   destinations (Projects, Connections) or settings. The row was
                   held back until `/code/customize` was served, on the rule
                   that persistent chrome must never be an invitation to a 404;
                   the page exists, so the row is here. */
                { href: "/artifacts", kind: "artifacts", label: "Artifacts", active: pathname === "/artifacts" },
                { href: "/code/customize", kind: "settings", label: "Customize", active: pathname === "/code/customize" },
              ] as const)
            : ([
                { href: "/library", kind: "library", label: "Library", active: pathname === "/library" },
                { href: "/projects", kind: "projects", label: "Projects", active: !!pathname?.startsWith("/projects") },
                { href: "/artifacts", kind: "artifacts", label: "Artifacts", active: pathname === "/artifacts" },
                /* Design is a destination like the four above it and is drawn
                   like one. It used to be pinned on its own above the footer
                   hairline, on the reasoning that it must never scroll away —
                   but this whole block sits ABOVE the scroll region (the only
                   thing that scrolls is the conversation list), so it never
                   scrolled away here either. The pin was solving a problem that
                   did not exist, and it cost a row stranded at the bottom of the
                   column with a void above it. */
                { href: "/design", kind: "design", label: "Design", active: pathname === "/design" },
              ] as const)
          ).map((item) => (
            <NavRow
              key={item.href}
              collapsed={collapsed}
              href={item.href}
              active={item.active}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind={item.kind} />}
              label={item.label}
              layoutId={`nav-${item.kind}`}
              transition={layoutTransition}
            />
          ))}
          <MoreFlyout
            collapsed={collapsed}
            product={product}
            pathname={pathname}
            onNavigate={() => setSidebarOpen(false)}
            onOpenArchived={() => setArchivedOpen(true)}
          />
        </nav>

        {/* ── Lists ────────────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className={cn(
            // `pt-6` (24px), not `pt-3`. Measured, the reference leaves 55.8px
            // between the last destination's label and the first section
            // heading's; at `pt-3` this column left 42.9, so the list began
            // while the navigation was still finishing. Every LATER heading
            // gets the same break from `Section`'s own `mt-6` plus the row it
            // follows — this is only the first one, which `first:mt-0`
            // deliberately exempts from that margin and which therefore has to
            // get its air from the scroller. (28px overshot it by three; this
            // is the rung that lands on it.)
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-6",
            // The rail has no lists to scroll; its own scroll region is the
            // <nav> above, so this must not also claim the slack.
            collapsed && "hidden"
          )}
        >
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                key="lists"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : transition.fast}
              >
                {!mounted ? (
                  <div className="space-y-1 px-1 pt-1">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="skeleton h-8 rounded-control" style={staggerDelay(i, "tight")} />
                    ))}
                  </div>
                ) : (
                  <>
                    {/* NEEDS YOU — above everything, and only when there is
                        something in it. A run that stopped to ask a question is
                        the first row of this panel on every page in the product,
                        which is the answer to the objection the Code list page
                        used to raise against landing on a composer: you no
                        longer have to be standing anywhere in particular to see
                        it. */}
                    {/* The one live region in the panel, and it announces the
                        only number here that can require the reader to act.
                        The Code run list carried this and is retiring; the
                        count moved into the fold's heading, where it is a
                        glance rather than an announcement, so a reader working
                        somewhere else in the panel was never told that a run
                        had stopped to ask them something. It sits OUTSIDE the
                        fold's own condition because the fold unmounts at zero,
                        and "nothing is waiting any more" is the other half of
                        what this has to say. */}
                    <p role="status" className="sr-only">
                      {needsYouRows.length === 0
                        ? "Nothing is waiting on you."
                        : `${needsYouRows.length} ${needsYouRows.length === 1 ? "run is" : "runs are"} waiting on you.`}
                    </p>

                    {needsYouRows.length > 0 && (
                      <NeedsYouFold
                        rows={needsYouRows}
                        signals={rowSignals}
                        only={needsYouOnly}
                        onToggle={() => setNeedsYouOnly((v) => !v)}
                        activeConversationId={activeConversationId}
                        rowProps={rowProps}
                      />
                    )}

                    {projectsError && !isCode && !needsYouOnly && (
                      <InlineErrorRow message="Couldn’t load your projects." onRetry={loadProjects} />
                    )}

                    {/* Projects are Chat's filing, not Code's: a Code session
                        belongs to a repository or a workspace, which is a fact
                        about where it RUNS and is already on the session. */}
                    {!isCode && !needsYouOnly && sidebarProjects.length > 0 && (
                      // "Pinned projects", because that is what `sidebarProjects`
                      // is — the starred subset — and because the nav row ~40px
                      // above this heading already says "Projects" and already
                      // goes to /projects. The section used to repeat the word
                      // AND carry an "All projects" chevron to the same route:
                      // one destination, two controls, one column.
                      <Section
                        label="Pinned projects"
                        isCollapsed={sectionCollapsed.projects}
                        onToggleCollapse={() => toggleSection("projects")}
                        action={
                          <SectionAction label="New project" onClick={() => router.push("/projects?new=1")} always>
                            <Plus className="size-3.5" />
                          </SectionAction>
                        }
                      >
                        {sidebarProjects.map((p) => (
                          <ProjectRow
                            key={p.id}
                            project={p}
                            chats={live.filter((c) => c.projectId === p.id)}
                            signals={rowSignals}
                            active={pathname === `/projects/${p.id}`}
                            activePath={pathname}
                            starred={p.starred}
                            onNavigate={() => setSidebarOpen(false)}
                            onNewChat={() => {
                              router.push(`/chat?project=${p.id}`);
                              setSidebarOpen(false);
                            }}
                            onToggleStar={() => toggleProjectStar(p)}
                            onRename={() => {
                              setRenameDraft(p.name);
                              setRenameTarget(p);
                            }}
                            onDelete={() => deleteProject(p)}
                          />
                        ))}
                      </Section>
                    )}

                    {!needsYouOnly && pinned.length > 0 && (
                      // "Pinned chats", for the reason the section above is
                      // "Pinned projects": the same word at the same rung one
                      // section apart, naming two kinds of thing, reads as one
                      // list cut in half rather than two lists. In Code the
                      // noun is "sessions", because that is what the rows are.
                      <Section
                        label={isCode ? "Pinned sessions" : "Pinned chats"}
                        isCollapsed={sectionCollapsed.pinned}
                        onToggleCollapse={() => toggleSection("pinned")}
                      >
                        {pinned.map((c) => (
                          <ConversationRow
                            key={c.id}
                            conversation={c}
                            active={c.id === activeConversationId}
                            signal={rowSignals.get(c.id)}
                            {...rowProps}
                          />
                        ))}
                      </Section>
                    )}

                    {/* THE FOLDS ARE THE HEADERS. There is no "Recents"
                        section wrapper any more: a `text-xs` sentence-case
                        header immediately followed by a `font-mono` "Today"
                        caption one rung below it put two headings over one
                        list, a rung apart in two families, so neither read as
                        the structure. Sans captions under the mono caps
                        eyebrows above them can no longer be confused for one
                        another. Grouping, paging and the sentinel are
                        untouched. */}
                    {needsYouOnly ? null : recents.length > 0 ? (
                      <div className="mt-6 first:mt-0">
                        {groupedRecents.map(({ group, rows }) => (
                          <div key={group} className="pt-6 first:pt-0">
                            {/* Same heading as Projects and Pinned above — see the note in
                                `Section` — and the same INSET. This is a second
                                implementation of that heading, so it has to be moved by
                                hand every time the other one moves; it has now been left
                                behind twice (once at `px-2` against a 40px edge, once at
                                `pl-8` against 44), which is the argument for the two
                                becoming one the next time either is touched. */}
                            <p className="flex h-7 items-center pl-2 pr-2 text-ui font-medium text-muted-foreground">
                              {group}
                            </p>
                            {rows.map((c) => (
                              <ConversationRow
                                key={c.id}
                                conversation={c}
                                active={c.id === activeConversationId}
                                signal={rowSignals.get(c.id)}
                                {...rowProps}
                              />
                            ))}
                          </div>
                        ))}
                        {recents.length > recentsLimit && (
                          <div ref={sentinelRef} className="flex justify-center py-2" aria-hidden>
                            <span className="skeleton h-2 w-16 rounded-full" />
                          </div>
                        )}
                      </div>
                    ) : (
                      live.length === 0 &&
                      // Projects are not drawn in the Code column, so a starred
                      // project must not suppress the one sentence that says a
                      // person has no sessions yet.
                      (isCode || sidebarProjects.length === 0) && (
                        <p className="px-2 py-8 text-center text-ui text-muted-foreground" aria-live="polite">
                          {isCode ? "No sessions yet." : "No conversations yet."}
                          <br />
                          Start one above.
                        </p>
                      )
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        {/*
         * ONE BLOCK: the account band. It was two, the first being a lone
         * Design row pinned above the hairline — see the note beside Design in
         * the destinations list for why that pin bought nothing. Removing it
         * closes the gap that used to sit between the end of the conversation
         * list and the bottom of the column, which is the "void" the panel was
         * repeatedly read as having.
         */}
        <motion.div layout transition={layoutTransition}>
          {collapsed ? (
            /* The rail loses its dedicated 44px Settings button: Settings is a
               row in the account menu, one click away at BOTH widths, and
               removing it is what lets the rail footer be two controls instead
               of three. DownloadMenu is new here, so nothing the expanded
               footer offers becomes unreachable when collapsed. */
            <>
              {/* Inset like the product switch's separator above, not a
                  full-bleed rule: at 64px a rule that touches both edges reads
                  as the panel ending. */}
              <div className="mx-2.5 mt-1.5 border-b border-sidebar-border" aria-hidden="true" />
              <div className="flex flex-col items-center gap-1 px-2.5 pb-2 pt-1.5">
                <DownloadMenu className="size-11 rounded-control" />
                <UserMenu compact />
              </div>
            </>
          ) : (
            <div className="mt-2 flex items-center gap-1 border-t border-sidebar-border px-2 pb-2.5 pt-2">
              <UserMenu
                trigger={
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={accountLabel}
                    /* No horizontal padding, so the avatar starts where a nav
                       row's fill starts and the name lands on the panel's one
                       text edge. The avatar is `size-5` and the gap `gap-3`,
                       the same pair every nav row uses, which is what puts the
                       last row your eye rests on at the same 44px as the rest
                       rather than a few pixels off it. */
                    className="group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-control text-left transition-[background-color,color] duration-fast ease-out-soft hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent motion-reduce:transition-none coarse:h-11"
                  >
                    {/* The SAME avatar helper the menu this opens draws with.
                        The footer used to render mono initials in a bordered
                        disc while the menu four pixels away rendered a
                        DotIdenticon — one person, two faces, one click apart. */}
                    <UserAvatar className="size-5" />
                    {/* The NAME truncates, the plan segment never does: it is
                        the tonal state, and "Limit reached" is precisely the
                        word a 256px column must not eat. */}
                    <span className="flex min-w-0 flex-1 items-baseline text-body">
                      <span className="min-w-0 truncate font-medium text-foreground">{user.name ?? user.email}</span>
                      <span className={cn("shrink-0 whitespace-pre", planSegment.tone)}>{` · ${planSegment.label}`}</span>
                    </span>
                    <ChevronUp
                      aria-hidden
                      className="size-3 shrink-0 text-muted-foreground/70 transition-transform duration-fast ease-in-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                    />
                  </button>
                }
              />
              {/* gap-0.5 inside, gap-1 outside: the two buttons read as one
                  object, which the vertical stack they replace never did. */}
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Settings"
                      onClick={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }))}
                      className="group size-9 shrink-0 rounded-control text-muted-foreground hover:bg-sidebar-accent hover:text-foreground coarse:size-11"
                    >
                      <AppIcons.settings className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Settings</TooltipContent>
                </Tooltip>
                {/* cn() lets the call-site radius win, so the one `rounded-full`
                    control in the footer finally matches the square one beside
                    it. */}
                <DownloadMenu className="size-9 rounded-control coarse:size-11" />
              </div>
            </div>
          )}
        </motion.div>

        {/* ── Dialogs ──────────────────────────────────────────────────── */}
        <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{confirm?.title}</DialogTitle>
              <DialogDescription>{confirm?.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  confirm?.onConfirm();
                  setConfirm(null);
                }}
              >
                {confirm?.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>Change the name of this project.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="sidebar-rename-project">Project name</Label>
              <Input
                id="sidebar-rename-project"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                placeholder="New project name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameProject();
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button onClick={renameProject} disabled={renamingProject || !renameDraft.trim()}>
                {renamingProject ? "Renaming…" : "Rename project"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {shareId && <ShareDialog kind="CHAT" conversationId={shareId} open onOpenChange={(o) => !o && setShareId(null)} />}

        <ArchivedChatsDialog
          open={archivedOpen}
          product={product}
          onOpenChange={setArchivedOpen}
          onRestored={(c) => upsertConversation({ ...c, archivedAt: null })}
          onRequestConfirm={setConfirm}
        />
      </div>
    </LayoutGroup>
  );
}

/**
 * "Needs you" — a fold, not a destination.
 *
 * The rejected alternative was a `/tasks` page, which is the inbox this rework
 * removes wearing a new name (docs/design/TWO_PRODUCTS.md §2.2). So the triage
 * survives as a stance you take on the list you are already reading: the header
 * is a toggle, and while it is on the rest of the panel is hidden and these are
 * the only rows. Zero new destinations.
 *
 * It borrows the date folds' heading rather than `Section`'s, because it is a
 * date fold's sibling and not a collapsible section — pressing it filters, it
 * does not hide these rows, so a chevron would be a lie about what it does. The
 * count rides IN the heading rather than beside it: a second element on the
 * right would be a trailing signal on a row that already has one job
 * (docs/design/PREMIUM_AUDIT.md rule 6), and the number changes width, which in
 * a 24px heading reads as the heading moving.
 */
function NeedsYouFold({
  rows,
  signals,
  only,
  onToggle,
  activeConversationId,
  rowProps,
}: {
  rows: ClientConversation[];
  signals: Map<string, RowSignal>;
  only: boolean;
  onToggle: () => void;
  activeConversationId: string | null;
  rowProps: RowSharedProps;
}) {
  return (
    // No bottom margin: whatever follows — Pinned projects, Pinned chats, the
    // date folds — opens with its own `mt-6`, and two margins meeting would put
    // 48px between this fold and the list it heads.
    <div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable
            kind="row"
            onClick={onToggle}
            aria-pressed={only}
            className={cn(
              // The date folds' geometry exactly — `h-6`, the panel's 40px text
              // edge — so this reads as the first fold rather than as a banner
              // over the list. `coarse:h-11` because this panel IS the phone
              // drawer (AppShell renders it inside SheetContent) and a date
              // fold's heading is not pressable, while this one is: at 24px it
              // would be the one control in the drawer at half the 44px every
              // row, flyout entry and section heading beside it guarantees. On
              // a fine pointer the resting geometry is untouched.
              "h-7 select-none gap-1.5 border-0 py-0 pl-2 pr-2 hover:bg-sidebar-accent/60 coarse:h-11",
              only && "bg-sidebar-accent"
            )}
          >
            <span
              className={cn(
                "min-w-0 truncate text-ui font-medium",
                only ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {`Needs you · ${rows.length}`}
            </span>
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="right">{only ? "Show everything" : "Show only these"}</TooltipContent>
      </Tooltip>
      {rows.map((c) => (
        <ConversationRow
          key={c.id}
          conversation={c}
          active={c.id === activeConversationId}
          signal={signals.get(c.id)}
          {...rowProps}
        />
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rows
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The search field — a button wearing a field, at the top of the column.
 *
 * At the rail it is the 44px icon row every other destination is, with the
 * tooltip they all carry; the field shape only exists where there is a
 * placeholder to hold. The reasoning for its return is at the call site.
 */
function SidebarSearchField({ collapsed }: { collapsed: boolean }) {
  const el = (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
      className={cn(
        // `rounded-field` (12px), not `rounded-control` (10px): this is the one
        // thing in the column shaped like an input, and the ladder in
        // tailwind.config.ts gives fields their own rung precisely so a field
        // and a list row are not the same object at a glance.
        //
        // The fill is the panel's own hover ink at 70%, so it reads as a well
        // in the sidebar rather than a card floating on it — and it deepens
        // under the pointer instead of lighting up, which is what a field does.
        "group flex w-full items-center rounded-field border border-transparent bg-sidebar-accent/70 text-left text-body text-muted-foreground transition-[background-color,border-color,color] duration-fast ease-out-soft hover:border-sidebar-border hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        collapsed ? "size-11 justify-center rounded-control px-0" : "h-8 gap-2.5 px-2 coarse:h-11"
      )}
      aria-label="Search"
    >
      <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-4.5">
        <SidebarMotionIcon kind="search" />
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">Search</span>}
    </button>
  );
  if (!collapsed) return el;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex justify-center">{el}</div>
      </TooltipTrigger>
      <TooltipContent side="right">Search</TooltipContent>
    </Tooltip>
  );
}

function NavRow({
  href,
  onClick,
  icon,
  label,
  trailing,
  active,
  collapsed,
  layoutId,
  transition: t,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  active?: boolean;
  collapsed: boolean;
  layoutId: string;
  transition: object;
}) {
  const cls = navRowClass(collapsed, !!active);
  const inner = (
    <>
      {/*
       * THE SELECTION FILL TRAVELS. It is one element with a shared
       * `layoutId`, so moving from Library to Projects slides it down the
       * column instead of switching off in one row and on in another.
       *
       * This is the same mechanism — and the same `layoutId` idea — as the
       * product switch's thumb directly above, which is the point: the panel
       * had two ways of saying "this one is selected", a travelling thumb in
       * the switcher and a hard cut everywhere else. Now it has one.
       *
       * It is a FILL, which is the only thing rule 10 of
       * docs/design/PREMIUM_AUDIT.md lets chrome animate, and the row's text
       * and glyph do not move at all — only the ink behind them.
       *
       * `spring.layout` has `bounce: 0`: this is a position correcting itself,
       * not an object with momentum. Under reduced motion `layoutTransition`
       * is `{ duration: 0 }`, so it jumps, which is the correct behaviour
       * rather than a degraded one.
       */}
      {active && !collapsed && (
        <motion.span
          layoutId="sidebar-nav-active"
          transition={t}
          aria-hidden
          data-nav-fill
          className="absolute inset-0 -z-10 rounded-control bg-sidebar-accent"
        />
      )}
      {/* A `size-5` BOX holding a `size-4.5` GLYPH, and the two numbers are
          doing different jobs.

          The box is layout: 20px at `gap-3` is what puts every label in this
          panel on one text edge, 44px from the panel's edge, which the section
          headings, the chat bullets and the project tree's guide line also land
          on. Change it and the column loses its alignment.

          The glyph is weight, and it is set BY the label rather than against
          it. 18px under a 15px label is the same ratio 14px held under 13px —
          the mark reads as the label's companion, not as its heading. Both
          rungs exist: `4.5` is 18px in the spacing scale and has its own step
          on the optical stroke ladder in globals.css, so the stroke thins to
          match instead of a 24-viewBox weight being scaled down whole. */}
      <span className="flex size-5 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground [&_svg]:size-4.5">
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="ml-auto shrink-0 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100">{trailing}</span>}
        </>
      )}
    </>
  );
  // `data-active` on the row, read by `group-data-[active]` on the glyph. It
  // replaces an arbitrary ancestor variant keyed to a literal utility string
  // (`[.bg-sidebar-accent_&]:text-foreground`), which can no longer tell the
  // hover fill from the active one now that hover is the same colour at 60%.
  const activeAttr = active ? "" : undefined;
  const el = href ? (
    <Link
      href={href}
      onClick={onClick}
      data-active={activeAttr}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cls}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      data-active={activeAttr}
      aria-label={collapsed ? label : undefined}
      className={cn(cls, "text-left")}
    >
      {inner}
    </button>
  );
  const row = (
    <motion.div layout layoutId={layoutId} transition={t} className={cn(collapsed && "flex justify-center")}>
      {el}
    </motion.div>
  );
  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {trailing && <span className="ml-1.5 inline-flex">{trailing}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The sidebar row recipe, shared by NavRow and the More trigger.
 *
 * No `border border-transparent`: it was a Soft UI artifact that stopped a box
 * changing size under a border that no longer arrives, and against a FIXED
 * `h-8` with `box-border` it now just steals 2px of the row's height.
 *
 * Hover is `bg-sidebar-accent/60`, active is the full fill, and active carries
 * no hover rule at all so it does not brighten under the pointer. They used to
 * be the identical fill, which meant that at any moment the pointer was in the
 * sidebar two rows claimed to be selected and the real one disappeared.
 */
function navRowClass(collapsed: boolean, active: boolean) {
  return cn(
    // `font-normal`, not `font-medium`. Chrome is quieter than content, and
    // this column had it backwards: the six navigation rows above the list
    // were set one weight HEAVIER than the chat titles they sit above, so the
    // furniture out-shouted the documents (docs/design/PREMIUM_AUDIT.md §2).
    // Selection is the tonal fill and the ink, as it already was.
    /*
     * 32px tall at the `body` rung (15px), abutting. Every number here was
     * MEASURED off the reference at the same window size rather than argued
     * from it, because two passes of arguing produced 42px and then 38px of
     * pitch against a reference that runs 32.2, and each time the column read
     * as "still too big" with nothing identifiably wrong in it.
     *
     *                        reference   before      now
     *   row pitch              32.2px    37.6px     32px
     *   label inset            46.5px    57.0px     46px
     *   icon inset             16.9px    26.5px     17px
     *   icon glyph              14.4px    14.4px    14.4px   (already right)
     *
     * The glyph line is why the earlier passes kept missing: the mark was
     * never the thing that was too big. It was the ROOM — 5px of extra pitch
     * per row and 10px of extra inset on every label, which across a column
     * of thirteen rows is a panel that looks inflated while every element in
     * it is the right size.
     *
     * `px-2` on the row, against the panel's own `px-2`, is where the inset
     * comes from: 8 + 8 = 16 to the glyph, + a 20px box + `gap-2.5` = 46 to
     * the label. Juno was spending `px-3` twice. That 46 is load-bearing: the
     * section headings, the date folds, the chat bullets and the project
     * tree's guide line all key to it.
     *
     * `body` (15px) stays. Measured against the reference, "Projects" and
     * "Design" set identically in both — the type was never the problem
     * either, which is worth writing down since it is the first thing anyone
     * reaches for when a panel looks heavy.
     */
    "group relative flex h-8 w-full items-center rounded-control text-body font-normal transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
    // The rail: a 44px target around the glyph, so every icon is one tap and
    // the row's tooltip names it.
    collapsed ? "size-11 justify-center px-0" : "gap-2.5 px-2 coarse:h-11",
    // NO `bg-` on the active row: its fill is the travelling `motion.span`
    // inside it (see NavRow). Painting it here too would leave a hard-edged
    // copy of the fill sitting under the one that slides, so the old row's ink
    // would blink off before the new row's arrived.
    active
      ? "text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
  );
}

/**
 * More: the destinations that do not earn a top-level row, in a
 * `.surface-float` flyout to the right of the sidebar (ChatGPT's "More").
 * The same flyout from the rail, where the trigger is an icon with a tooltip.
 * Archived chats lives here too — it opens the dialog rather than a route.
 */
function MoreFlyout({
  collapsed,
  product,
  pathname,
  onNavigate,
  onOpenArchived,
}: {
  collapsed: boolean;
  product: ProductSurface;
  pathname: string | null;
  onNavigate: () => void;
  onOpenArchived: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const isCode = product === "code";
  /*
   * Work and Code are NOT here any more. They used to lead this list because
   * the only other way to reach them was a header switcher hidden below `md`;
   * the sidebar's product switch now carries both products at every width (the
   * drawer renders the expanded sidebar, the rail gets icon rows), so a second
   * door in More was the third copy of the same control.
   *
   * Pull requests is Code's, and it is HERE rather than a top-level row because
   * it is where a finished run's outcome is read rather than a place work
   * happens — it used to be a tab on the Code list page, beside a Runs tab that
   * duplicated the panel you are reading. Connections is in both lists: a Code
   * session reaches GitHub through exactly the same connector a chat does.
   *
   * SKILLS, AUTOMATIONS AND PERMISSIONS ARRIVE HERE, and this is the whole of
   * what Work's four-tab row becomes. They were rooms inside a product, which
   * meant you could only reach them by first going to a place you had no other
   * reason to be in — and two of the three govern every delegated run in the
   * account, not a section of it. In More rather than as top-level rows for the
   * same reason Assistants and Connections are: you configure them occasionally
   * and read the list under them every day. Tasks stays beside them and is a
   * different, older thing — scheduled PROMPTS, which predate delegated runs
   * and still have their own page and their own data.
   */
  const items = isCode
    ? [
        { href: "/code/pulls", kind: "pulls" as const, label: "Pull requests", active: pathname === "/code/pulls" },
        { href: "/connections", kind: "connections" as const, label: "Connections", active: pathname === "/connections" },
      ]
    : [
        { href: "/assistants", kind: "assistants" as const, label: "Assistants", active: pathname === "/assistants" },
        { href: "/connections", kind: "connections" as const, label: "Connections", active: pathname === "/connections" },
        { href: "/skills", kind: "skills" as const, label: "Skills", active: !!pathname?.startsWith("/skills") },
        { href: "/automations", kind: "automations" as const, label: "Automations", active: !!pathname?.startsWith("/automations") },
        { href: "/permissions", kind: "permissions" as const, label: "Permissions", active: !!pathname?.startsWith("/permissions") },
        // "Tasks" is gone from this list, not renamed: scheduled tasks and
        // Automations were two entries for one question, and Automations is
        // the one that survived. `/tasks` still answers — it redirects here —
        // so nothing that links to it breaks.
      ];
  const anyActive = items.some((item) => item.active);
  const rowClass =
    "flex h-8 w-full items-center gap-2.5 rounded-control px-2.5 text-body font-normal text-foreground outline-none transition-[background-color] duration-fast ease-out-soft hover:bg-accent focus-visible:bg-accent motion-reduce:transition-none coarse:h-11";
  // An open flyout takes the ACTIVE recipe, not a fill bolted on beside the
  // inactive one — otherwise `hover:bg-sidebar-accent/60` would win over it and
  // the trigger would go pale the moment the pointer reached the menu it opened.
  const trigger = (
    <button
      type="button"
      aria-label={collapsed ? "More" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      data-active={open ? "" : undefined}
      className={cn(navRowClass(collapsed, open), anyActive && !open && "text-foreground")}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground [&_svg]:size-4.5">
        <SidebarMotionIcon kind="more" />
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">More</span>}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn(collapsed && "flex justify-center")}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">More</TooltipContent>
          </Tooltip>
        ) : (
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        )}
      </div>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        collisionPadding={16}
        role="menu"
        aria-label="More"
        className="w-56 p-1.5"
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            aria-current={item.active ? "page" : undefined}
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
            className={cn(rowClass, item.active && "bg-accent font-semibold")}
          >
            <SidebarMotionIcon kind={item.kind} className="size-4.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </Link>
        ))}
        <div role="separator" aria-hidden="true" className="my-1 h-px bg-border/70" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onOpenArchived();
          }}
          className={rowClass}
        >
          <Archive className="size-4.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{isCode ? "Archived sessions" : "Archived chats"}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

function InlineErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mx-0.5 my-1 flex items-center gap-2 rounded-control border border-destructive/40 bg-destructive/10 px-2 py-2 text-ui text-destructive"
    >
      <StatusIcons.error className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="pressable flex shrink-0 items-center gap-1 rounded-control px-1.5 py-0.5 font-medium hover:bg-destructive/20 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

function SectionAction({
  label,
  onClick,
  children,
  always = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** Shown at rest, not only on hover — the section's one standing affordance. */
  always?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          kind="icon"
          size="sm"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "size-6 rounded-control text-muted-foreground/70 transition-opacity duration-fast hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:opacity-100 coarse:size-9 coarse:opacity-100",
            always ? "opacity-100" : "opacity-0 group-hover/section:opacity-100"
          )}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({
  label,
  children,
  isCollapsed,
  onToggleCollapse,
  action,
}: {
  label: string;
  children: React.ReactNode;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  action?: React.ReactNode;
}) {
  return (
    // `mt-4` rather than `mb-3`: the 16px belongs ABOVE the header that owns
    // it, so the first section sits on the scroller's own 8px and every later
    // one is separated from the list it follows.
    <div className="group/section mt-6 first:mt-0">
      <div className="flex items-center">
        <Pressable
          kind="row"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          /* `pl-2` — 16px from the panel edge, measured at 15.2 in the
             reference — and NOT the 46px the nav labels sit at.
             THE COLUMN HAS TWO TEXT EDGES ON PURPOSE. 46px is where a label
             lands when an icon precedes it, and every destination has one.
             A section heading has no icon and neither do the conversation
             rows under it, so both sit at 16 — the heading on the same edge
             as the list it heads, which is the alignment that actually
             matters. Putting the heading out at 46 lined it up with the
             navigation it is not part of, and left it hanging 30px inside
             its own rows. */
          className="h-7 min-w-0 flex-1 select-none gap-1.5 border-0 pl-2 pr-2 py-0 hover:bg-sidebar-accent/60"
        >
          {/*
           * ONE SECTION VOICE, and it is SANS now: sentence-case at the `ui`
           * rung, muted. It was mono at `label`, which is the eyebrow
           * SettingsGroup and CardEyebrow head their sections with — right for
           * a page, wrong for this column. Mono is a machine voice, and it is
           * doing a machine's job everywhere else it appears in the product:
           * naming a field, a digest, a state. Here it names a pile of the
           * reader's own chats, six or more times down one panel, in a
           * typeface different from every word under it.
           *
           * The reference (Claude) sets these as quiet sans, one rung under the
           * rows, and that is what they are: a label ON the list rather than an
           * object beside it. `ui` rather than `label`, because the rows moved
           * up to `body` — a heading has to stay a step below its rows, and
           * `label` two steps down would have gone from quiet to squinting.
           */}
          <span className="min-w-0 truncate text-ui font-medium text-muted-foreground">{label}</span>
          {/* `ease-in-out`, not `ease-out-soft`: both endpoints of a chevron
              turn are on screen, so this is an A-to-B move. */}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-fast ease-in-out motion-reduce:transition-none",
              isCollapsed && "-rotate-90"
            )}
          />
        </Pressable>
        {action != null && <span className="flex shrink-0 items-center">{action}</span>}
      </div>
      <Disclosure open={!isCollapsed}>
        <div className="pt-1">{children}</div>
      </Disclosure>
    </div>
  );
}

/** The panel's one fold: a grid-rows sweep so rows never pop. */
function Disclosure({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,visibility] duration-base ease-out-soft motion-reduce:transition-none",
        open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          !open && "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Inline rename field for a chat row. */
function InlineNameInput({
  initial = "",
  placeholder,
  onCommit,
  onCancel,
  nested,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  nested?: boolean;
}) {
  const [draft, setDraft] = React.useState(initial);
  const committed = React.useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(draft);
  };
  return (
    <div className={cn("flex min-h-8 items-center gap-1 py-0.5 pr-1", nested ? "ml-4 pl-2" : "pl-2")}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            committed.current = true;
            onCancel();
          }
        }}
        className="h-7 w-full text-ui"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="size-7 rounded-control" onMouseDown={(e) => e.preventDefault()} onClick={commit} aria-label="Save">
            <StatusIcons.success className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save</TooltipContent>
      </Tooltip>
    </div>
  );
}

type RowSharedProps = {
  renamingId: string | null;
  setRenaming: (id: string | null) => void;
  projects: { id: string; name: string }[];
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
  onShare: (id: string) => void;
  onArchive: (c: ClientConversation) => void;
};

function ConversationRow({
  conversation,
  active,
  nested,
  signal,
  renamingId,
  setRenaming,
  projects,
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
  onShare,
  onArchive,
}: RowSharedProps & {
  conversation: ClientConversation;
  active: boolean;
  /** Indented under a folder or project. */
  nested?: boolean;
  /** The run behind this conversation, when one is worth a mark. */
  signal?: RowSignal;
}) {
  const router = useRouter();
  const renaming = renamingId === conversation.id;
  /* The row names itself from its own conversation rather than from the column
     it is drawn in, so a Code session says "session" wherever it appears. */
  const isCodeSession = conversation.kind === "code";
  /* One name for this row, computed once and used by every place that speaks
     it. A conversation with no stored title is ordinary — it has one until its
     first reply is summarised — and when the visible label and the tooltip
     each applied their own fallback, the tooltip did not: a row carrying a run
     opened its tooltip with " — Running now.", a sentence with no subject. */
  const rowLabel = conversation.title || (isCodeSession ? "Untitled session" : "New chat");

  const patch = async (data: Partial<Pick<ClientConversation, "title" | "titleSource" | "pinned" | "projectId">>) => {
    const optimistic = data.title != null ? { ...data, titleSource: "manual" as const } : data;
    onUpdate(conversation.id, optimistic);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.titleSource == null ? data : { ...data, titleSource: undefined }),
    });
    if (!res.ok) toast.error("Update failed.");
  };

  const remove = () => {
    onRequestConfirm({
      title: isCodeSession ? "Delete this session?" : "Delete this conversation?",
      description: isCodeSession
        ? "This permanently removes the session and its transcript. Anything it already changed on a machine or in a pull request stays where it is. This can't be undone."
        : "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: isCodeSession ? "Delete session" : "Delete chat",
      onConfirm: async () => {
        onRemove(conversation.id);
        const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
        if (!res.ok) {
          toast.error("Delete failed.");
          return;
        }
        if (active) {
          // Back to the product this row belonged to, not always to Chat: a
          // reader who deletes the Code session they are inside should land on
          // Code's own landing, with the column they were using still under
          // their pointer.
          router.push(isCodeSession ? "/code" : "/chat");
          if (!isCodeSession) window.dispatchEvent(new CustomEvent("juno:new-chat"));
        }
      },
    });
  };

  if (renaming) {
    return (
      <InlineNameInput
        initial={conversation.title}
        placeholder={isCodeSession ? "Session name" : "Chat name"}
        nested={nested}
        onCommit={(value) => {
          setRenaming(null);
          const title = value.trim();
          if (title && title !== conversation.title) patch({ title });
        }}
        onCancel={() => setRenaming(null)}
      />
    );
  }

  return (
    /*
     * One marker language down the whole list. The 22px icon well and its 15px
     * chat bubble are gone; every chat is a 6px hollow bullet in a `size-5`
     * slot — the same mark the project tree already drew under a pinned
     * project — so titles land on the panel's single 44px left inset. The slot
     * is what holds that edge; the bullet inside it is invisible at rest and
     * solid `bg-current` when active, so a resting list is titles and nothing
     * else. The title does NOT change weight on select;
     * `font-semibold` re-measured it and visibly re-truncated the row you had
     * just clicked.
     */
    <div
      data-active={active ? "" : undefined}
      className={cn(
        "group relative flex h-8 items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
        nested && "ml-4",
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        /* No leading slot, so the title IS the row's left edge — 16px from the
           panel, on the same line as the section heading above it and 30px in
           from where the nav's labels sit. See the note on the row. `gap-2`
           is only ever spent on a trailing mark. A title is CONTENT in a
           column of chrome, so it takes the same `body` rung the destinations
           read at — the panel no longer sets documents smaller than furniture. */
        className="flex min-w-0 flex-1 items-center gap-2 text-body font-normal"
        /* The run's sentence joins the title rather than replacing it: this
           attribute is also how a truncated title gets read, and a row that
           answered "what is this" with "Juno has asked you something" would
           have traded one fact for another. */
        title={signal ? `${rowLabel} — ${signal.meaning}` : rowLabel}
      >
        <AnimatedTitle
          title={rowLabel}
          animate={conversation.titleSource === "ai"}
          className="min-w-0 flex-1"
        />
        {/* One trailing mark, in this order: a run that needs you outranks the
            fact that the row is pinned, because the pin is something you set
            and the dot is something that happened. Rule 6 still holds — a row
            shows one mark, in one place — and trailing is where it stops
            costing every OTHER row 30px of indent to hold a slot that only a
            handful of rows ever fill. */}
        {signal ? (
          <span className="flex size-4 shrink-0 items-center justify-center">
            <StatusDot tone={signal.tone} label={signal.label} />
          </span>
        ) : (
          conversation.pinned && !nested && <Pin className="size-3 shrink-0 fill-current text-muted-foreground/60" aria-hidden />
        )}
      </Link>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              {/* Named from the row's own conversation, like every other
                  string on it: a screen reader landing on a Code row heard
                  "Conversation options" while the rename field, the delete
                  dialog and the archive toast it opens all said "session". */}
              <Pressable
                kind="icon"
                className={KEBAB_CLASS}
                aria-label={isCodeSession ? "Session options" : "Conversation options"}
              >
                <SidebarMotionIcon kind="more" className="size-3.5" />
              </Pressable>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => setRenaming(conversation.id)}>
            <ActionIcons.edit className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => patch({ pinned: !conversation.pinned })}>
            <Pin className={cn("size-4", conversation.pinned && "fill-primary text-primary")} />
            {conversation.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          {/* A project is Chat's filing and a Code session has its own — the
              repository or workspace it runs in — so this submenu would offer
              to file a session into a folder the Code column never draws. */}
          {!isCodeSession && (
            <>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppIcons.projects className="size-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                {conversation.projectId == null ? <StatusIcons.success className="size-4" /> : <span className="size-4" />}
                No project
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => patch({ projectId: p.id })}>
                  {conversation.projectId === p.id ? <StatusIcons.success className="size-4" /> : <AppIcons.projects className="size-4" />}
                  <span dir="auto" className="truncate">
                    {p.name}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/projects")}>
                <Plus className="size-4" /> New project…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onShare(conversation.id)}>
            <ActionIcons.share className="size-4" /> Share
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(conversation)}>
            <Archive className="size-4" /> Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={remove} variant="destructive">
            <ActionIcons.delete className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


function ProjectRow({
  project,
  chats,
  signals,
  active,
  activePath,
  starred,
  onNavigate,
  onNewChat,
  onToggleStar,
  onRename,
  onDelete,
}: {
  project: SidebarProject;
  chats: ClientConversation[];
  /* The same join the folds read. These rows are hand-rolled rather than
     `ConversationRow` — they are 28px, guided, and carry no kebab — but a
     conversation's state is a property of the conversation, not of where it is
     drawn, and one panel showing a toned dot in Today and a hollow bullet for
     the same chat under its pinned project is one state with two drawings. */
  signals: Map<string, RowSignal>;
  active: boolean;
  activePath: string;
  starred: boolean;
  onNavigate: () => void;
  onNewChat: () => void;
  onToggleStar: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  // Open by default: a pinned project's recent chats are the reason it is
  // pinned, and Claude's sidebar shows them under the project at rest. The
  // chevron still folds a noisy one away.
  const [expanded, setExpanded] = React.useState(true);
  const [showAll, setShowAll] = React.useState(false);
  const PREVIEW = 3;
  const visibleChats = showAll ? chats : chats.slice(0, PREVIEW);
  const hasChats = chats.length > 0;

  return (
    <div>
      <div
        data-active={active ? "" : undefined}
        className={cn(
          "group relative flex h-8 items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
          active
            ? "bg-sidebar-accent text-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
        )}
      >
        <Link
          href={`/projects/${project.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-body font-normal"
          title={project.name}
        >
          {/* The one glyph that survives in a list row, because its closed →
              open folder crossfade is the single glyph morph in this panel
              that carries meaning. */}
          <span className="flex size-5 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground [&_svg]:size-4.5">
            <SidebarMotionIcon kind="projects" />
          </span>
          <AnimatedTitle title={project.name} animate={project.nameSource === "ai"} className="min-w-0 flex-1" />
        </Link>
        {hasChats && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  setExpanded((v) => !v);
                  if (expanded) setShowAll(false);
                }}
                aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                aria-expanded={expanded}
                className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-control text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground coarse:-my-3 coarse:size-10"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 transition-transform duration-fast ease-in-out motion-reduce:transition-none",
                    expanded && "rotate-90"
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>{expanded ? "Collapse" : "Expand"}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" className={KEBAB_CLASS} aria-label="Project options">
                  <SidebarMotionIcon kind="more" className="size-3.5" />
                </Pressable>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Project options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onNewChat}>
              <Plus className="size-4" /> New chat in project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleStar}>
              <Pin className={cn("size-4", starred && "fill-primary text-primary")} />
              <span>{starred ? "Unpin" : "Pin"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <ActionIcons.edit className="size-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} variant="destructive">
              <ActionIcons.delete className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasChats && (
        <Disclosure open={expanded}>
          {/* The guide drops from the folder's REAL centre — the row's `pl-3`
              (8) plus half of `size-5` (10) = 18px — so it stays under the
              glyph it descends from rather than under an arbitrary inset.
              `ml-[22px]` is off the spacing ladder on purpose: this is not a
              spacing decision, it is an alignment to a computed centre, and
              rounding it to `ml-5` or `ml-6` would visibly miss the folder. */}
          <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-sidebar-border pb-1 pl-2.5">
            {visibleChats.map((c) => {
              const signal = signals.get(c.id);
              const label = c.title || "New chat";
              return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={onNavigate}
                aria-current={activePath === `/chat/${c.id}` ? "page" : undefined}
                title={signal ? `${label} — ${signal.meaning}` : label}
                className={cn(
                  "group group/pc flex h-8 items-center gap-2.5 rounded-control px-2 text-body font-normal transition-[color,background-color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
                  activePath === `/chat/${c.id}`
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-foreground"
                )}
              >
                {/* No leading slot here either — the guide line to the left
                    already says these rows belong to the project above them,
                    which is the job a bullet was doing twice. The signal is
                    trailing, as it is on every other conversation row. */}
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {label}
                </span>
                {signal && (
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <StatusDot tone={signal.tone} label={signal.label} />
                  </span>
                )}
              </Link>
              );
            })}
            {chats.length > PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent/60 hover:text-foreground motion-reduce:transition-none coarse:h-11"
              >
                {showAll ? "Show less" : `View all ${chats.length}`}
              </button>
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Archived chats — restore or delete, from the footer.
 * ──────────────────────────────────────────────────────────────────────────── */

function ArchivedChatsDialog({
  open,
  product,
  onOpenChange,
  onRestored,
  onRequestConfirm,
}: {
  open: boolean;
  /** Archived rows are filtered to the product whose panel opened this, so the
   *  Code column's "Archived sessions" cannot answer with a year of chats. */
  product: ProductSurface;
  onOpenChange: (o: boolean) => void;
  onRestored: (c: ClientConversation) => void;
  onRequestConfirm: (c: ConfirmState) => void;
}) {
  const router = useRouter();
  const isCode = product === "code";
  const [items, setItems] = React.useState<ClientConversation[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    fetch("/api/conversations?archived=only")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { conversations?: ClientConversation[] }) => {
        if (!cancelled) {
          const rows = Array.isArray(data.conversations) ? data.conversations : [];
          // Filtered here rather than in the route: the payload is one page of
          // archived rows and both products read it, so a `kind` parameter
          // would be a second query shape for a dialog that opens rarely.
          setItems(rows.filter((c) => (c.kind === "code") === isCode));
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isCode]);

  const restore = async (c: ClientConversation) => {
    setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    const r = await fetch(`/api/conversations/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    }).catch(() => null);
    if (!r?.ok) {
      setItems((prev) => (prev ? [c, ...prev] : prev));
      toast.error(isCode ? "Couldn’t restore the session." : "Couldn’t restore the chat.");
      return;
    }
    onRestored(c);
    toast.success(isCode ? "Session restored." : "Chat restored.");
  };

  const destroy = (c: ClientConversation) => {
    onRequestConfirm({
      title: isCode ? "Delete this session?" : "Delete this conversation?",
      description: isCode
        ? "This permanently removes the session and its transcript. Anything it already changed on a machine or in a pull request stays where it is. This can't be undone."
        : "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: isCode ? "Delete session" : "Delete chat",
      onConfirm: async () => {
        setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
        const r = await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
        if (!r.ok) toast.error("Delete failed.");
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isCode ? "Archived sessions" : "Archived chats"}</DialogTitle>
          <DialogDescription>
            {isCode
              ? "Archived sessions stay searchable. Restore one to bring it back to the list."
              : "Archived chats stay searchable. Restore one to bring it back to Recents."}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[50vh] overflow-y-auto">
          {failed ? (
            <p className="px-2 py-6 text-center text-body text-muted-foreground">Couldn’t load archived chats.</p>
          ) : items == null ? (
            <div className="space-y-1 px-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="skeleton h-10 rounded-control" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-2 py-6 text-center text-body text-muted-foreground">Nothing archived.</p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((c) => (
                <li key={c.id} className="group flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-accent">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      router.push(`/chat/${c.id}`);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <SidebarMotionIcon
                      kind={isCode ? "code" : "conversation"}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">
                        {c.title || (isCode ? "Untitled session" : "New chat")}
                      </span>
                      <span className="block truncate font-mono text-caption text-muted-foreground">
                        Archived {c.archivedAt ? new Date(c.archivedAt).toLocaleDateString() : ""}
                      </span>
                    </span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pressable kind="icon" size="sm" onClick={() => restore(c)} aria-label="Restore">
                        <ArchiveRestore className="size-4" />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent>Restore</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pressable kind="icon" size="sm" onClick={() => destroy(c)} aria-label="Delete" className="danger-hover">
                        <ActionIcons.delete className="size-4" />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
