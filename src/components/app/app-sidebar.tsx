"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Pin,
  PinOff,
  Plus,
  type IconComponent,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { UserAvatar, UserMenu } from "@/components/app/user-menu";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { JunoOrbit } from "@/components/ui/icons";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useModifierKeyLabel } from "@/components/ui/platform";
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
import { MENU_W } from "@/components/ui/menu-recipe";
import { Label } from "@/components/ui/label";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PopoverTrigger } from "@/components/ui/popover";
import { ScrollFade } from "@/components/ui/scroll-fade";
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
import { intentPrefetch } from "@/lib/intent-prefetch";
import { cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";
import type { ClientAgent } from "@/lib/agents/types";
import { AgentFace } from "@/components/agents/agent-face";
import { localStateSentence } from "@/components/agents/agent-bits";
import { useAgents } from "@/components/agents/use-agents";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useNotifications } from "@/components/notifications/use-notifications";
import { OPEN_NOTIFICATIONS_EVENT } from "@/components/notifications/notifications-transport";
import { unreadDetail } from "@/components/notifications/inbox-model";
import { AGENT_STATE_NAMES, BRAND, FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import { AGENT_STATE_LABEL } from "@/lib/agents/domain";

/* ────────────────────────────────────────────────────────────────────────────
 * The sidebar (docs/design/FLAT_UI.md §3).
 *
 * A flat panel (the frame is painted by `.app-sidebar-frame` in the shell)
 * holding, top to bottom: one 48px header row (collapse, wordmark, the
 * Chat · Code switch), New chat and Search, the destinations and More, the
 * folds, and one two-line account row.
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
 * SEARCH IS A ROW, like New chat beside it. It was a bordered button dressed
 * as a field: the only boxed object in the column, and a pixel off the label
 * edge every other row keeps. Both references draw it as a plain row, and a
 * row still says what it searches in its label. It opens the search palette
 * (`juno:search`), so there is still one search surface with one caret.
 *
 * THE DENSITY LADDER, and nothing off it. Rows are `h-8` (32px, 44 under a
 * coarse pointer) and abut. Their text is the `nav` rung, 14px on a 20px line,
 * which is what both references set their sidebars in. It used to be `body`,
 * the 15px rung the product reads prose at, and a column of chrome at reading
 * size competes with the transcript beside it. A `size-5` box holds a
 * `size-4.5` glyph at `gap-2.5`, so every glyph starts 16px from the panel edge
 * and every label 46px. Rows with no glyph (conversation titles, section
 * headings) sit on the 16px edge, where the glyphs start. The collapse button
 * and the wordmark in the header land on the same two edges.
 *
 * Section headings and the Needs-you toggle are `h-7` sentence-case sans at
 * the `label` rung (12px), muted: a label on the list, two steps under its
 * rows. They take no fill under the pointer; the text brightens instead,
 * because a heading with a hover fill looks like one more row. Glyphs stay on
 * the icon set's ladder (docs/design/ICONS_AND_MOTION.md §1.2).
 *
 * A DESTINATION MAKES AT MOST ONE GESTURE under the pointer — the plus turns,
 * the gear turns, the search glass tilts, the folder opens — and it is the
 * glyph's own, declared once in icons.tsx so the same mark behaves the same
 * way in the palette and on the page; `sidebar-motion-icon.tsx` only adds the
 * folder's cross-fade and silences defaults that are wrong in this column.
 * Played by globals.css when the row is hovered or focused. Documents make
 * none: a conversation title is text on the panel, and so is its trailing
 * mark.
 *
 * HOVER AND SELECTION ARE TWO FILLS, ranked. Hover is `bg-sidebar-hover`, one
 * step off the panel; selection is `.sidebar-row-selected`, one step past
 * that, in both themes (the rungs are in globals.css). Neither draws an edge.
 * The selected row used to sit inside a hairline, which made it the one
 * outlined object in a column of text; both references mark the current row
 * with a fill alone, so the fill went one rung deeper and carries the state by
 * itself.
 *
 * Never weight: swapping a title from regular to medium on click re-measured
 * it and visibly re-truncated the row you had just chosen.
 *
 * AND THE CHANGE OF STATE IS A TRANSITION, not a cut. List rows cross-fade
 * their fill on the `fast` rung, so moving from chat to chat the row you left
 * gives it up over the same 120ms the row you arrived at takes it on. The
 * destinations go one step further: their fill is one element that travels.
 *
 * ONE TREE FOR BOTH WIDTHS. The rail is not a second component: every row is
 * a `motion.div layout`, so collapsing to 64px slides the glyphs into a
 * column and expanding slides them back, on the frame's own curve and
 * duration so the rows and the edge of the panel land together. Two trees
 * cross-fading read as a swap; one tree moving reads as the panel folding,
 * which is what a collapse is.
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
/** Loading lines of uneven length, so the placeholder reads as titles rather
 *  than as a striped block. */
const SKELETON_WIDTHS = ["72%", "56%", "80%", "64%", "48%", "68%"];

/* Recent is one section again, folded like the two above it. Its key is the
   one the old "Recents" section used, so a reader who folded it back then
   finds it the way they left it. */
const SECTION_KEYS = {
  agents: "juno:sidebar:agents:collapsed",
  projects: "juno:sidebar:projects:collapsed",
  pinned: "juno:sidebar:starred:collapsed",
  recents: "juno:sidebar:recents:collapsed",
} as const;

type SectionKey = keyof typeof SECTION_KEYS;

/*
 * "Open notifications" asked for while the column is not on screen. Below md
 * the column is `display: none` and the sidebar is the phone drawer, which is
 * not mounted until it opens, so the mount that hears the request cannot open
 * the popover itself: it opens the drawer and leaves word here, and the
 * drawer's own mount opens the popover when it arrives. Stamped rather than a
 * flag, so a request the drawer never picked up cannot open the popover the
 * next time somebody opens the drawer for something else.
 */
let inboxRequestedAt = 0;
const INBOX_REQUEST_TTL_MS = 2_000;

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

/** One thing waiting on the person, in the Needs you fold (see `attention`). */
type AttentionItem = {
  key: string;
  href: string;
  /** Who is asking: the agent's own name, or the product for its own runs. */
  who: string;
  /** What they need, in the attention words ("Needs your approval"). */
  ask: string;
  /** What it is about (the task or the chat). */
  what: string;
  agent?: ClientAgent;
  /** The chat behind a run's ask, so its row keeps the chat's own menu. */
  conversation?: ClientConversation;
  conversationId: string | null;
};

/** A run's waiting status, in the words Orbit uses for it. */
function askWords(status: string | undefined): string {
  if (status === "waiting_approval") return "Needs your approval";
  if (status === "host_offline") return "Waiting for your Mac";
  return AGENT_STATE_NAMES.needsAnswer;
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
 *
 * IT FADES IN, it does not blink in. `.pressable` (which `Pressable` wears)
 * transitions `opacity` on the `fast` rung, so the kebab arrives with the
 * row's own hover fill over the same 120ms rather than a frame before it.
 *
 * Its OWN hover is an ink tint, not `bg-sidebar-hover`: it only ever appears
 * on a row that is already painted in that colour (hovered) or in the
 * selected fill, so the panel's hover paint on it drew nothing at all and the
 * one pressable target inside the row had no edge. A 5% ink step reads on
 * both fills in both themes.
 *
 * OPEN IS READ FROM `aria-expanded`, not `data-state`. The kebab is a
 * DropdownMenuTrigger inside a TooltipTrigger's Slot, and the tooltip's own
 * `data-state` (closed / delayed-open) wins the prop merge, so a
 * `data-[state=open]` recipe never matched and the kebab faded out under its
 * own open menu the moment the pointer left the row. `aria-expanded` is
 * written by the dropdown alone.
 *
 * THE HIT AREA IS 32px, the box is 28. The `after:` layer (Pressable is
 * `relative`) reaches 2px past each edge, so the pointer floor in
 * ICONS_AND_MOTION.md §3 holds without the drawn target filling the 32px row
 * edge to edge or taking width from the title beside it. Under `coarse:` the
 * same 2px lifts the 40px box to 44.
 */
const KEBAB_CLASS =
  "group/kebab size-7 shrink-0 rounded-control opacity-0 after:absolute after:-inset-0.5 hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-foreground/5 aria-expanded:text-foreground aria-expanded:opacity-100 coarse:size-10 coarse:opacity-100";

/*
 * A conversation row's kebab floats over the row's right end instead of
 * holding a 28px slot, so at rest a title uses the whole row. While the kebab
 * shows (the row is hovered, its menu is open, or it has keyboard focus) the
 * two classes below make room for it: the title's last 24px fade out under it
 * (a mask on the text, so it works on the hover fill and the selected fill
 * alike), and a trailing mark gives up its place. The three conditions are
 * spelled out rather than composed because Tailwind only sees literal class
 * names.
 */
const KEBAB_ROOM =
  "group-hover:[mask-image:linear-gradient(to_left,transparent_24px,#000_44px)] group-has-[[aria-expanded=true]]:[mask-image:linear-gradient(to_left,transparent_24px,#000_44px)] group-has-[button:focus-visible]:[mask-image:linear-gradient(to_left,transparent_24px,#000_44px)]";
const TRAILING_MARK_YIELDS =
  "transition-opacity duration-fast ease-out-soft motion-reduce:transition-none group-hover:opacity-0 group-has-[[aria-expanded=true]]:opacity-0 group-has-[button:focus-visible]:opacity-0";

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
  /* The roster the Agents fold draws. Polled only in Chat, where the fold
     is; the Code column has no agents in it. Sorted waiting-first, so the
     teammate that needs you is the first face in the fold. */
  const { agents: roster } = useAgents({ enabled: product !== "code" });
  const agents = React.useMemo(
    () =>
      (roster ?? [])
        .slice()
        .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || a.sortOrder - b.sortOrder),
    [roster]
  );
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  // The chord hints print the reader's own modifier: "⌘" on Apple, "Ctrl"
  // everywhere else, where the same chords answer to Control.
  const mod = useModifierKeyLabel();
  const {
    conversations,
    updateConversation,
    removeConversation,
    upsertConversation,
    activeConversationId,
    sidebarOpen,
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
    agents: false,
    projects: false,
    pinned: false,
    recents: false,
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
      const next: Record<SectionKey, boolean> = { agents: false, projects: false, pinned: false, recents: false };
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

  /*
   * Infinite scroll for Recent: a sentinel at the foot of the list asks for
   * the next page as it scrolls into the well.
   *
   * The sentinel is held in STATE through a callback ref, so the observer
   * follows the node itself. It used to read a ref in an effect keyed to
   * `[mounted, collapsed]`, which only ever saw the first node: pressing
   * Needs you unmounts Recent and its sentinel, pressing it again mounts a
   * new one, and the observer went on watching the detached node, so the list
   * stopped paging at whatever it had loaded. A list that first grows past a
   * page after mount had no sentinel observed at all.
   */
  const [sentinel, setSentinel] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const root = scrollRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRecentsLimit((n) => n + RECENTS_PAGE);
      },
      { root, rootMargin: "160px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel]);

  /*
   * THE ROW YOU ARE ON STAYS VISIBLE.
   *
   * Selection is worth drawing only where it can be seen, and half the ways
   * into a conversation do not come through this column at all: the command
   * palette, a search result, ⌘⇧O, a deep link, deleting the chat you were
   * reading. In every one of those the panel's fill moved to a row that could
   * be four hundred pixels above the well — so the answer to "where am I"
   * was drawn correctly and off screen, and the column looked like it had
   * lost its selection rather than like it had scrolled.
   *
   * The smallest scroll, and an explicit in-view test before it, which is
   * what keeps this from being the other failure — a panel that yanks itself
   * around while you are reading it. A row already in the well is left
   * exactly where it is; only a row outside it moves, and then only as far
   * as brings it in. Smooth, because this is a scroll nothing else is
   * writing at the same time, and instant when the reader has asked the OS
   * for less motion.
   *
   * THE WELL SCROLLS AND NOTHING ELSE. This was `row.scrollIntoView`, which
   * scrolls every clipping ancestor on both axes, and the shell's `<aside>`
   * is one: it clips a column already laid out at full width while its own
   * width unfolds from the rail. So expanding the panel with the open chat
   * below the fold scrolled the frame 8px sideways to line the row's left
   * edge up with it, and the whole column (collapse button, glyphs, avatar)
   * lurched left mid-fold and snapped back as the frame reached full width.
   */
  React.useEffect(() => {
    if (collapsed || !mounted || !activeConversationId) return;
    const root = scrollRef.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>(
      `[data-conversation-row="${CSS.escape(activeConversationId)}"]`
    );
    if (!row) return;
    const rowBox = row.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const above = rowBox.top - rootBox.top;
    const below = rowBox.bottom - rootBox.bottom;
    if (above >= 0 && below <= 0) return;
    root.scrollTo({
      top: root.scrollTop + (above < 0 ? above : below),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [activeConversationId, collapsed, mounted, reduceMotion]);

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
  /*
   * EVERY ATTENTION ITEM, ONE SHAPE (INTERACTION_SPEC S7, critique 1: "every
   * attention item treated the same", "Needs you says what"). An agent that is
   * waiting on the person and a chat or session whose run stopped to ask are
   * the same row: who is asking, what they need in the attention words, and
   * what it is about. An agent's ask in its own thread is one row, not two.
   */
  const attention = React.useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    const covered = new Set<string>();
    if (!isCode) {
      for (const agent of agents) {
        if (agent.state !== "waiting") continue;
        const conversationId = agent.task?.conversationId ?? agent.conversationId ?? null;
        if (conversationId) covered.add(conversationId);
        items.push({
          key: `agent:${agent.id}`,
          href: conversationId ? `/chat/${conversationId}` : `/agents/${agent.id}`,
          who: agent.name,
          ask: askWords(agent.task?.status),
          what: agent.task?.title?.trim() || agent.role || "a task",
          agent,
          conversationId,
        });
      }
    }
    for (const c of needsYouRows) {
      if (covered.has(c.id)) continue;
      items.push({
        key: c.id,
        href: `/chat/${c.id}`,
        who: isCode ? BRAND.code.title : PRODUCT_NAME,
        ask: isCode ? (rowSignals.get(c.id)?.label ?? AGENT_STATE_NAMES.needsAnswer) : askWords(workRuns.byConversation.get(c.id)?.status),
        what: c.title || (c.kind === "code" ? "Untitled session" : "New chat"),
        conversation: c,
        conversationId: c.id,
      });
    }
    return items;
  }, [agents, isCode, needsYouRows, rowSignals, workRuns.byConversation]);
  const pinned = React.useMemo(() => live.filter((c) => c.pinned && !needsYouIds.has(c.id)), [live, needsYouIds]);
  // Project chats stay in Recents as well as under their project, because a
  // project is a workspace rather than a filing.
  const recents = React.useMemo(
    () => live.filter((c) => !c.pinned && !needsYouIds.has(c.id)),
    [live, needsYouIds]
  );
  // The page in view. The list is already newest-first, so order carries the
  // recency the date folds used to spell out in four headings.
  const visibleRecents = React.useMemo(() => recents.slice(0, recentsLimit), [recents, recentsLimit]);

  /*
   * Answer the last question and the filter lets go of the panel.
   *
   * Without this, clearing the fold leaves the reader looking at an empty
   * column with the thing that emptied it no longer on screen to press again —
   * a filter that has hidden every row including its own control.
   */
  React.useEffect(() => {
    if (attention.length === 0) setNeedsYouOnly(false);
  }, [attention.length]);

  const newChat = () => {
    router.push("/chat");
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };

  /* ── Notifications ───────────────────────────────────────────────────── */

  /*
   * The inbox, in both products: a task, an agent and Juno itself can all
   * have something to say whichever column is showing. Its dot is one small
   * count polled per mount (see use-notifications.ts); the list is read only
   * when the popover opens.
   */
  const inbox = useNotifications();
  const [inboxOpen, setInboxOpen] = React.useState(false);
  const inboxDetail = unreadDetail(inbox.count);
  const rootRef = React.useRef<HTMLDivElement>(null);

  /*
   * "Open notifications" from the command palette. Every mount hears it, and
   * the one on screen answers: the column at any width (the rail's row opens
   * the same popover), or the drawer while it is open. The column below md is
   * `display: none`, so it has no box; it opens the drawer instead and leaves
   * word for the drawer's mount (see `inboxRequestedAt`).
   */
  React.useEffect(() => {
    const onOpenInbox = () => {
      if ((rootRef.current?.getClientRects().length ?? 0) > 0) {
        setInboxOpen(true);
        return;
      }
      if (sidebarOpen) return;
      inboxRequestedAt = Date.now();
      setSidebarOpen(true);
    };
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, onOpenInbox);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, onOpenInbox);
  }, [setSidebarOpen, sidebarOpen]);

  /*
   * The drawer's mount picks the request up, once the drawer has finished
   * sliding in. The popover measures its trigger when it opens and does not
   * follow a transform, so opened mid-slide it would hang where the row was
   * a frame into the animation. The word is cleared only when the popover
   * opens, so an effect that runs twice still opens it once.
   */
  React.useEffect(() => {
    if (Date.now() - inboxRequestedAt > INBOX_REQUEST_TTL_MS) return;
    const drawer = rootRef.current?.closest<HTMLElement>('[role="dialog"]');
    const sliding = drawer?.getAnimations?.() ?? [];
    let cancelled = false;
    void Promise.all(sliding.map((animation) => animation.finished.catch(() => undefined))).then(() => {
      if (cancelled) return;
      inboxRequestedAt = 0;
      setInboxOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rowProps = {
    renamingId,
    setRenaming: setRenamingId,
    projects,
    onUpdate: updateConversation,
    onRemove: removeConversation,
    onRestore: upsertConversation,
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
   * `DotFillBar` with a `Messages 12 / 15` header, so a bar here would be a
   * second read of one number, and a bar at 12% full is furniture. Below 80%
   * the plan line names the plan and nothing else; above it a toned note joins
   * it, which is the only moment the number is worth a person's attention.
   * `quota.remaining` is preferred over `limit - used` so the copy matches
   * whatever the server computed, and it is nullable (types/chat.ts) so it is
   * guarded.
   */
  const usagePct =
    quota.limit != null && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : null;
  const remaining = quota.remaining ?? (quota.limit != null ? Math.max(0, quota.limit - quota.used) : null);
  const usageNote =
    usagePct == null || usagePct < 80
      ? null
      : usagePct >= 100
        ? { label: "Limit reached", tone: "text-destructive" }
        : { label: `${remaining ?? 0} left`, tone: "text-warning" };
  // The whole truth always rides the accessible name, so nothing a sighted
  // reader can see is lost to the truncation on that one line.
  const accountLabel = `${user.name ?? user.email ?? "Account"}, ${plan.name} plan${
    quota.limit == null ? ", no message cap" : `, ${quota.used} of ${quota.limit} messages used`
  }`;

  /*
   * The column's motion starts one frame after mount, for the reason the
   * shell's frame does (see `frameLive` in app-shell.tsx): the stored collapse
   * is restored AFTER the first paint, and without this the rows of anyone who
   * keeps the panel collapsed slid into the rail on every page load while the
   * frame around them had already snapped there.
   */
  const [motionLive, setMotionLive] = React.useState(false);
  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setMotionLive(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  /*
   * THE ROWS RIDE THE FRAME'S OWN CURVE. The shell folds the panel with a CSS
   * width transition on `duration-base ease-in-out` (app-shell.tsx), and the
   * rows used to slide on `spring.layout`, a 360ms spring: the edge of the
   * panel stopped and the glyphs inside it kept travelling for another 140ms,
   * so one collapse read as two motions. `transition.symmetric` is that same
   * 220ms on the same curve, with nothing to overshoot, so every mark lands on
   * the frame the edge does. The travelling selection fill uses it too: moving
   * between two rows that are both on screen is an A-to-B move, which is what
   * the symmetric curve is for.
   */
  const layoutTransition = reduceMotion || !motionLive ? { duration: 0 } : transition.symmetric;
  /* Labels, the wordmark and the account name fade in when the panel opens,
     while the frame reveals them, instead of arriving in the first frame of
     the fold. Not on first paint: `motionLive` is false then. */
  const revealOnMount = motionLive ? { opacity: 0 } : false;
  /*
   * ONE NAMESPACE PER MOUNT, and the shell has two of them.
   *
   * `AppShell` renders this component twice: the desktop `<aside>`, which is
   * `hidden md:block` — CSS-hidden below the breakpoint but still MOUNTED —
   * and the phone drawer inside the Sheet. A `LayoutGroup` with a hard-coded
   * id gives both mounts the SAME namespace, so both copies of the selection
   * fill claim `layoutId="sidebar-nav-active"` at once. On a phone the other
   * claimant is a `display: none` subtree, which framer measures as a 0×0 rect
   * at the origin, so opening the drawer could animate the fill out of the top
   * left corner of the window.
   *
   * `useId()` is stable across SSR and hydration and unique per instance,
   * which is exactly the scope a layout namespace wants.
   */
  const layoutScope = React.useId();

  return (
    <LayoutGroup id={`juno-sidebar-${layoutScope}`}>
      <div
        key="sidebar"
        ref={rootRef}
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "flex h-full flex-col text-sidebar-foreground",
          // Desktop width rides the shell's --juno-sidebar-width (user-resizable);
          // keeping it on the inner column preserves the collapse clip-reveal.
          // w-[52px] = app-shell's RAIL_WIDTH: 36px targets in px-2. (Was 64:
          // product switch's rail items are 44px inside `px-2.5`, which is
          // exactly 64, and that control is signed off and not ours to resize.
          collapsed ? "w-[52px]" : "w-full md:w-[var(--juno-sidebar-width,260px)]"
        )}
      >
        {/* ── Lockup · bell · collapse ─────────────────────────────────── */}
        {/*
         * THE HEAD (the V3 gallery's shell, D-033): the Alevr lockup on the
         * left, the Continuum mark beside the outlined wordmark, its mark on
         * the glyph column's 18 px edge (where every nav glyph starts); the
         * bell and the collapse control on the right, quiet (the third ink),
         * 32 px targets. The row is 44 px, 8 px down, so its centre line is
         * y = 30, the gallery's, and meets the inset panel's header line.
         *
         * Collapsed to the rail, the mark alone is the way home, and the bell
         * and the expand control stack under it on the glyph column.
         *
         * The bell carries unseen records in its INK, one step up from the
         * third ink to the first: no dot, no count, no fill (INTERACTION_SPEC
         * S10 as the gallery revised it). Its accessible name says how many.
         *
         * `layout="position"` on every wrapper, never a bare `layout`: a bare
         * one animates size as a scale on content framer cannot counter-scale.
         */}
        <motion.div
          layout="position"
          transition={layoutTransition}
          className={cn("flex items-center", collapsed ? "flex-col px-2 pt-3" : "mt-2 h-11 gap-0.5 pl-[18px] pr-2")}
        >
          <motion.div layout="position" transition={layoutTransition} className={cn("min-w-0", !collapsed && "flex-1")}>
            {collapsed && onToggleCollapse ? (
              /*
               * THE RAIL'S HEAD IS ONE CONTROL. It used to stack the mark, the
               * bell and an expand button, three 44px tiles before the first
               * destination. Now the mark is the expand control: under the
               * pointer it hands over to the panel glyph (the pattern people
               * know from the references), and the bell lives by the avatar.
               */
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleCollapse}
                    aria-label="Show sidebar"
                    aria-keyshortcuts={mod === "⌘" ? "Meta+Shift+S" : "Control+Shift+S"}
                    className="jicon-trigger group/head relative grid size-9 place-items-center rounded-control text-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-hover coarse:size-11"
                  >
                    <span className="col-start-1 row-start-1 transition-[opacity,transform] duration-fast ease-out-soft group-hover/head:scale-90 group-hover/head:opacity-0 group-focus-visible/head:opacity-0 motion-reduce:transition-none">
                      <ContinuumMark size={14} tight tone="current" />
                    </span>
                    <span className="col-start-1 row-start-1 scale-90 text-muted-foreground opacity-0 transition-[opacity,transform] duration-fast ease-out-soft group-hover/head:scale-100 group-hover/head:text-foreground group-hover/head:opacity-100 group-focus-visible/head:opacity-100 motion-reduce:transition-none [&_svg]:size-4">
                      <SidebarMotionIcon kind="panel-open" />
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="flex items-center gap-1.5">
                  Show sidebar
                  <Kbd>{`${mod}⇧S`}</Kbd>
                </TooltipContent>
              </Tooltip>
            ) : (
            <Link
              href={isCode ? "/code" : "/chat"}
              onClick={() => setSidebarOpen(false)}
              aria-label={isCode ? `${BRAND.code.title} home` : `${PRODUCT_NAME} home`}
              className={cn(
                "flex items-center rounded-control text-foreground outline-offset-2",
                collapsed ? "size-9 justify-center" : "h-9 w-fit"
              )}
            >
              {collapsed ? (
                <ContinuumMark size={14} tight tone="current" />
              ) : (
                <motion.span initial={revealOnMount} animate={{ opacity: 1 }} transition={transition.base} className="flex items-center">
                  <AlevrLockup height={14} tone="current" decorative />
                </motion.span>
              )}
            </Link>
            )}
          </motion.div>
          {!collapsed && (
          <NotificationsPopover inbox={inbox} open={inboxOpen} onOpenChange={setInboxOpen} onNavigate={() => setSidebarOpen(false)}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={inboxDetail ? `Notifications, ${inboxDetail}` : "Notifications"}
                className={cn(
                  "jicon-trigger shrink-0 coarse:size-11",
                  "size-8",
                  (inbox.count?.unreadCount ?? 0) > 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <SidebarMotionIcon kind="notifications" className="size-4" />
              </Button>
            </PopoverTrigger>
          </NotificationsPopover>
          )}
          {onToggleCollapse && !collapsed && (
            <motion.div layout="position" transition={layoutTransition} className="hidden shrink-0 md:flex">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn("jicon-trigger hidden shrink-0 text-muted-foreground hover:text-foreground md:inline-flex", "size-8 coarse:size-11")}
                    onClick={onToggleCollapse}
                    aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
                    aria-keyshortcuts={mod === "⌘" ? "Meta+Shift+S" : "Control+Shift+S"}
                  >
                    <SidebarMotionIcon kind={collapsed ? "panel-open" : "panel-close"} className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={collapsed ? "right" : "bottom"} className="flex items-center gap-1.5">
                  {collapsed ? "Show sidebar" : "Hide sidebar"}
                  <Kbd>{`${mod}⇧S`}</Kbd>
                </TooltipContent>
              </Tooltip>
            </motion.div>
          )}
          {/* The drawer's own close, drawn only below md. No tooltip: the
              drawer's focus scope moves here when it opens, and a tooltip
              measured mid-slide would hang over New chat. */}
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="jicon-trigger size-8 shrink-0 text-muted-foreground md:hidden coarse:size-11"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
            >
              <SidebarMotionIcon kind="close" className="size-4" />
            </Button>
          )}
        </motion.div>

        {/* The labelled Chat | Code switch, full width on its own row. It
            fades with the collapse rather than cutting (the closing panel is
            still ~200px wide when the rows start to move), and `popLayout`
            lets the rows below close the gap on the same frame. */}
        <AnimatePresence initial={false} mode="popLayout">
          {!collapsed && (
            <motion.div
              key="header-switch"
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ ...layoutTransition, opacity: transition.fast }}
              className="px-2 pb-2 pt-0.5"
            >
              <ProductSwitch
                active={product}
                plan={quota.plan}
                onNavigate={() => setSidebarOpen(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* The rail keeps the stacked icon column: see the note above.
            It FADES in and out rather than cutting, on the same collapse the
            rows below slide through — the header's 28px pair is clipped away
            by the closing frame, and this column arrives as the rows make
            room for it, so the switch never blinks between its two shapes.
            `popLayout`, so a leaving column stops holding its 100px while it
            fades — the rows under it start closing the gap on the same frame
            instead of waiting out the exit. Under reduced motion the travel
            collapses and the fade keeps its timing, as everywhere else. */}
        <AnimatePresence initial={false} mode="popLayout">
          {collapsed && (
            <motion.div
              key="rail-switch"
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ ...layoutTransition, opacity: transition.base }}
            >
              <ProductSwitch
                collapsed
                active={product}
                plan={quota.plan}
                onNavigate={() => setSidebarOpen(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── New chat + Search ────────────────────────────────────────── */}
        {/* The two actions, then the destinations, as ONE run of abutting rows:
            a gap between them would make the column read as stacked groups
            rather than a header and a list. New chat leads because it is the
            row people press most, as in both references. `pt-1` is all the air
            the header needs: its 48px row already centres 32px controls, so
            the first row starts 12px under the collapse button. */}
        <div className={cn(collapsed ? "flex flex-col items-center gap-0.5 px-2 pt-1" : "px-2 pt-1")}>
          <NavRow
            collapsed={collapsed}
            href={isCode ? "/code" : undefined}
            onClick={isCode ? () => setSidebarOpen(false) : newChat}
            /* Plain, like every sibling. The 22px tinted tile that used to sit
               behind this glyph was the only chip in the panel, and it is what
               made the one row people press most read as the chunkiest. */
            icon={<SidebarMotionIcon kind={isCode ? "new-session" : "new"} />}
            label={isCode ? "New session" : FEATURE_NAMES.newChat.label}
            moves
            trailing={isCode ? undefined : <Kbd>{`${mod}⇧O`}</Kbd>}
            layoutId="nav-new"
            transition={layoutTransition}
            reveal={revealOnMount}
          />
          {/* SEARCH IS A ROW. It opens the search palette over the window
              (`juno:search`), which searches messages, files and memories
              server side; a field here would have to either filter titles in
              place or forward keystrokes into that palette, two inputs fighting
              over one caret. No shortcut hint: ⌘K opens the command menu, not
              this palette, and a keycap that opens something else is worse
              than none. */}
          <NavRow
            collapsed={collapsed}
            onClick={() => {
              setSidebarOpen(false);
              window.dispatchEvent(new CustomEvent("juno:search"));
            }}
            icon={<SidebarMotionIcon kind="search" />}
            label={FEATURE_NAMES.search.label}
            layoutId="nav-search"
            transition={layoutTransition}
            reveal={revealOnMount}
          />

        </div>

        {/* ── Destinations ─────────────────────────────────────────────── */}
        {/* Chat: Library · Projects · Artifacts. Code: Artifacts · Customize ·
            Pull requests. Then More for the rest. The rail keeps the same
            order icon-only; More opens the same flyout. */}
        {/* `min-h-0 flex-1 overflow-y-auto` on the rail: collapsed, the list
            scroller below renders nothing, all thirteen rail rows sit in
            non-scrolling blocks, and the shell's `<aside>` is `overflow-hidden`
            — so on a short window the account control was simply clipped away
            with no way to reach it. */}
        <nav
          className={cn(
            /*
             * `isolate`, AND IT IS WHY THE SELECTED DESTINATION IS VISIBLE AT
             * ALL.
             *
             * The selection fill is a `motion.span` at `-z-10` inside its row
             * (see NavRow). A negative z-index is resolved against the nearest
             * ANCESTOR STACKING CONTEXT, and there wasn't one: the row is
             * `relative` with `z-index: auto`, which does not make one, so the
             * fill was hoisted all the way out and painted before
             * `.app-sidebar-frame` painted `bg-sidebar` over it. Library,
             * Projects, Artifacts and Design therefore had NO selected state
             * on the docked panel — the one width nearly everybody reads it
             * at. It only ever showed at md–lg, where the panel floats on
             * `z-40` and accidentally supplied the context this needed.
             *
             * ON THE `<nav>`, not on the row, and the difference is visible in
             * motion rather than at rest. Isolating each ROW also makes the
             * fill paint, but it makes it paint inside that row's own stacking
             * context — so travelling down the column the fill passes OVER the
             * labels between, blanking "Projects" and "Artifacts" for the
             * length of the move. Isolating the container the fill travels
             * WITHIN puts it behind every row in the list, which is what this
             * element has always claimed to be: the ink behind them.
             *
             * The contract that buys: nothing between this `<nav>` and a row
             * may carry a background of its own, or it will paint over the
             * travelling ink. Today nothing does — the rows are the only
             * painted things in here.
             */
            "isolate",
            // No top padding when expanded: this is the same run of rows as
            // New chat and Search above it (see the note there).
            collapsed ? "min-h-0 flex-1 overflow-y-auto no-scrollbar flex flex-col items-center gap-0.5 px-2 pt-0.5" : "px-2"
          )}
          aria-label="Primary"
        >
          {(isCode
            ? ([
                { href: "/code/customize", kind: "customize", label: FEATURE_NAMES.customize.label, active: pathname === "/code/customize" },
              ] as const)
            : ([
                { href: "/projects", kind: "projects", label: FEATURE_NAMES.projects.label, active: !!pathname?.startsWith("/projects") },
                { href: "/library", kind: "library", label: FEATURE_NAMES.library.label, active: pathname === "/library" || pathname === "/artifacts" },
                { href: "/customize", kind: "customize", label: FEATURE_NAMES.customize.label, active: !!pathname?.startsWith("/customize") || !!pathname?.startsWith("/connections") || !!pathname?.startsWith("/skills") || !!pathname?.startsWith("/automations") },
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
              moves
              layoutId={`nav-${item.kind}`}
              transition={layoutTransition}
              reveal={revealOnMount}
            />
          ))}
        </nav>

        {/* ── Lists ────────────────────────────────────────────────────── */}
        {/*
         * THE LIST DISSOLVES AT ITS EDGES instead of being sliced by them.
         *
         * This was a bare `overflow-y-auto`, which meant a scrolled list cut
         * its first visible title in half against the "More" row above it and
         * its last against the account band below — two hard horizontal seams,
         * both landing mid-letterform, in the one region of the panel that
         * moves. A cut edge also says nothing: at rest the list looked
         * identical whether there were two more chats below the fold or two
         * hundred.
         *
         * `ScrollFade` is the product's own answer to both and was already
         * drawn in five other scrollers — the connector list inside this very
         * sidebar's "+" menu among them — so the panel with the longest list
         * in the app was the one place still cutting. Its bands fade in only
         * when there is something to scroll in that direction, so the top and
         * bottom of a short list stay crisp.
         */}
        <ScrollFade
          viewportRef={scrollRef}
          // The rail has no lists to scroll; its own scroll region is the
          // <nav> above, so this must not also claim the slack.
          className={cn("min-h-0 flex-1", collapsed && "hidden")}
          // `pt-5` (20px): the break between the navigation and the first
          // section heading. Every later heading gets the same 20px from
          // `Section`'s own `mt-5`; the first is exempted from that margin by
          // `first:mt-0` and takes its air from the scroller instead, so all
          // the section breaks in the column are one size.
          viewportClassName="overscroll-contain px-2 pb-2 pt-5"
        >
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                key="lists"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                // A fade, so it keeps its timing under reduced motion
                // (ICONS_AND_MOTION.md §2.2, rule 10).
                transition={transition.fast}
              >
                {!mounted ? (
                  /* The placeholder stands where the list will: a heading and
                     six title lines on the rows' own 32px pitch and 16px text
                     edge, so nothing moves sideways when the rows arrive. */
                  <div aria-hidden="true">
                    <div className="flex h-7 items-center px-2">
                      <span className="skeleton h-2.5 w-14 rounded-full" />
                    </div>
                    <div className="pt-1">
                      {SKELETON_WIDTHS.map((width, i) => (
                        <div key={i} className="flex h-8 items-center px-2">
                          <span className="skeleton h-3 rounded-full" style={{ width, ...staggerDelay(i, "tight") }} />
                        </div>
                      ))}
                    </div>
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
                        what this has to say. It is drawn LAST in the list (see its
                        note at the end) so the first section's `first:mt-0`
                        still finds that section. */}

                    {attention.length > 0 && (
                      <NeedsYouFold
                        items={attention}
                        only={needsYouOnly}
                        onToggle={() => setNeedsYouOnly((v) => !v)}
                        activeConversationId={activeConversationId}
                        onNavigate={() => setSidebarOpen(false)}
                        rowProps={rowProps}
                      />
                    )}

                    {/* AGENTS — the roster at a glance, above the filing. Each
                        row is a live face, so the column says which teammate
                        is working and which is waiting before a name is read
                        (Grok's point: a roster is scanned peripherally), and
                        its one trailing signal is the toned dot while it
                        needs you. Absent until there is an agent: an empty
                        heading is a promise the column cannot keep. */}
                    {/* ORBIT (Alevr Orbit, "Your agents"): always reachable in
                        Chat, so a person with no agents yet still has the
                        place and Create agent. The head is the destination
                        (S8: it opens the roster); each row is the agent's
                        shipped face, its name and its state in words on the
                        right, in the third ink. Ready says nothing, and the
                        ask is coloured once, in Needs you. */}
                    {!isCode && !needsYouOnly && (
                      <section className="group/section mt-5 first:mt-0" aria-label={`${BRAND.orbit.label}, ${BRAND.orbit.description.toLowerCase()}`}>
                        <div className="flex items-center">
                          <Link
                            href="/agents"
                            onClick={() => setSidebarOpen(false)}
                            prefetch={false}
                            aria-current={pathname === "/agents" ? "page" : undefined}
                            aria-label={`${BRAND.orbit.label}, ${BRAND.orbit.description.toLowerCase()}`}
                            className={cn(
                              "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-label transition-colors duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
                              pathname === "/agents" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <JunoOrbit aria-hidden="true" className="size-4" motion="none" />
                            <span className="min-w-0 truncate">{BRAND.orbit.label}</span>
                          </Link>
                          <SectionAction
                            label={FEATURE_NAMES.createAgent.label}
                            onClick={() => {
                              setSidebarOpen(false);
                              router.push("/agents/new");
                            }}
                            always
                          >
                            <Plus className="size-4" />
                          </SectionAction>
                        </div>
                        {agents.length > 0 && (
                          <div className="pt-1">
                            {agents.map((agent) => (
                              <AgentRow
                                key={agent.id}
                                agent={agent}
                                active={
                                  pathname === `/agents/${agent.id}` ||
                                  (agent.conversationId !== null && agent.conversationId === activeConversationId)
                                }
                                onNavigate={() => setSidebarOpen(false)}
                              />
                            ))}
                          </div>
                        )}
                      </section>
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
                          <SectionAction
                            label="New project"
                            onClick={() => {
                              setSidebarOpen(false);
                              router.push("/projects?new=1");
                            }}
                            always
                          >
                            <Plus className="size-4" />
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

                    {/* ONE LIST, ONE HEADING: "Recent", drawn by the same
                        `Section` as Pinned projects and Pinned chats above it,
                        so the three read as one family and fold the same way.
                        It was four date folds — Today, Yesterday, Previous 7
                        days, Older — which put up to four headings into the
                        busiest part of the column to say what the order of the
                        rows already says: the newest is at the top. */}
                    {needsYouOnly ? null : recents.length > 0 ? (
                      <Section
                        label="Recent"
                        isCollapsed={sectionCollapsed.recents}
                        onToggleCollapse={() => toggleSection("recents")}
                      >
                        {visibleRecents.map((c) => (
                          <ConversationRow
                            key={c.id}
                            conversation={c}
                            active={c.id === activeConversationId}
                            signal={rowSignals.get(c.id)}
                            {...rowProps}
                          />
                        ))}
                        {recents.length > recentsLimit && (
                          <div ref={setSentinel} className="flex justify-center py-2" aria-hidden>
                            <span className="skeleton h-2 w-16 rounded-full" />
                          </div>
                        )}
                      </Section>
                    ) : (
                      live.length === 0 &&
                      // Projects are not drawn in the Code column, so a starred
                      // project must not suppress the one sentence that says a
                      // person has no sessions yet.
                      (isCode || sidebarProjects.length === 0) && (
                        /* LEFT, on the column's own text edge, and not
                           centred. It was the only centred text in this
                           panel — every heading, fold and title above it
                           starts at the same vertical — so it floated in the
                           middle of a left-aligned column and read as
                           belonging to nothing. `py-8` went with it: eight
                           above and eight below put it a third of the way
                           down an empty list rather than under the thing it
                           is about. */
                        <p className="px-2 pb-2 pt-3 text-ui text-muted-foreground" aria-live="polite">
                          {isCode ? "No sessions yet." : "No conversations yet."}
                          <br />
                          Start one above.
                        </p>
                      )
                    )}
                    {/* The Needs you live region (its note is at the top of
                        this list). Last, not first: as the first child it
                        took `first:mt-0` from whichever section opens the
                        list, which then sat 40 px under the navigation
                        instead of the column's 20. */}
                    <p role="status" className="sr-only">
                      {attention.length === 0
                        ? "Nothing is waiting on you."
                        : attention.length === 1
                          ? `${attention[0].who}: ${attention[0].ask.toLowerCase()}.`
                          : `${attention.length} things are waiting on you.`}
                    </p>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </ScrollFade>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        {/*
         * ONE ROW: the account. Name over plan, the way both references draw
         * it, and the one door to everything about the account: Settings, the
         * apps, shortcuts and sign out are in the menu it opens. It used to
         * share the footer with a settings gear and a download button, three
         * controls where one menu already held all of them, under a hairline
         * the list's own fade already draws.
         *
         * THE AVATAR DOES NOT MOVE ON A COLLAPSE. Expanded, `px-2` twice puts
         * it at 16px; at the rail, the 44px button in `px-2.5` centres the
         * same 32px face on 16px too. So the rows slide into their column and
         * the face that ends the column stays where it is.
         */}
        <motion.div
          layout="position"
          transition={layoutTransition}
          className={cn(collapsed ? "flex flex-col items-center gap-1 px-2 pb-3 pt-1" : "px-2 pb-2 pt-1")}
        >
          {collapsed && (
            <NotificationsPopover inbox={inbox} open={inboxOpen} onOpenChange={setInboxOpen} onNavigate={() => setSidebarOpen(false)}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={inboxDetail ? `Notifications, ${inboxDetail}` : "Notifications"}
                      className={cn(
                        "jicon-trigger size-9 shrink-0 rounded-control hover:bg-sidebar-hover coarse:size-11",
                        (inbox.count?.unreadCount ?? 0) > 0 ? "text-foreground" : "text-sidebar-foreground hover:text-foreground"
                      )}
                    >
                      <SidebarMotionIcon kind="notifications" className="size-4" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">{inboxDetail ? `Notifications · ${inboxDetail}` : "Notifications"}</TooltipContent>
              </Tooltip>
            </NotificationsPopover>
          )}
          {collapsed ? (
            <UserMenu compact onOpenArchived={() => setArchivedOpen(true)} archivedLabel={isCode ? "Archived sessions" : "Archived chats"} />
          ) : (
            <UserMenu
              onOpenArchived={() => setArchivedOpen(true)}
              archivedLabel={isCode ? "Archived sessions" : "Archived chats"}
              trigger={
                <button
                  type="button"
                  aria-label={accountLabel}
                  /* An open menu is drawn as the row's selected fill, the same
                     "you are here" the destinations above use. `-on-open`
                     because a className cannot read Radix's `data-state`. */
                  className="group sidebar-row-selected-on-open flex h-12 w-full min-w-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast ease-out-soft hover:bg-sidebar-hover motion-reduce:transition-none"
                >
                  {/* The SAME avatar helper the menu this opens draws with, so
                      the person has one face in the footer and in the menu. */}
                  <UserAvatar className="size-8" />
                  <motion.span
                    initial={revealOnMount}
                    animate={{ opacity: 1 }}
                    transition={transition.base}
                    className="flex min-w-0 flex-1 flex-col"
                  >
                    <span translate="no" className="truncate text-nav font-medium text-foreground">
                      {user.name ?? user.email}
                    </span>
                    {/* The plan truncates, the usage note never does: "Limit
                        reached" is the one phrase on this line a narrow column
                        must not eat. */}
                    <span className="flex min-w-0 items-baseline text-caption text-muted-foreground">
                      <span translate="no" className="truncate">
                        {`${plan.name} plan`}
                      </span>
                      {usageNote && (
                        <span className={cn("shrink-0 whitespace-pre", usageNote.tone)}>
                          {" · "}
                          {usageNote.label}
                        </span>
                      )}
                    </span>
                  </motion.span>
                  {/* A state mark, not an action: the up-down caret says
                      "this opens a menu" without claiming a direction, and
                      it inks up while the menu is open rather than flipping,
                      which read as the row itself turning over. */}
                  <ChevronsUpDown
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground transition-colors duration-fast ease-out-soft group-data-[state=open]:text-foreground motion-reduce:transition-none"
                  />
                </button>
              }
            />
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
          onNavigate={() => setSidebarOpen(false)}
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
 * It wears `Section`'s heading voice (12px, muted, no hover fill) but not its
 * chevron: pressing it filters rather than hiding these rows, so a chevron
 * would be a lie about what it does. The count rides IN the heading rather
 * than at the far end of the row: a second element on the right would be a
 * trailing signal on a row that already has one job
 * (docs/design/PREMIUM_AUDIT.md rule 6).
 */
function NeedsYouFold({
  items,
  only,
  onToggle,
  activeConversationId,
  onNavigate,
  rowProps,
}: {
  items: AttentionItem[];
  only: boolean;
  onToggle: () => void;
  activeConversationId: string | null;
  onNavigate: () => void;
  /** The conversation rows' shared verbs, so a waiting chat keeps its menu. */
  rowProps: RowSharedProps;
}) {
  const reduceMotion = useReducedMotion();
  return (
    // No bottom margin: whatever follows opens with its own `mt-5`.
    <div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={only}
            className={cn(
              "flex h-7 w-full select-none items-center rounded-control px-2 text-left text-label transition-colors duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
              only ? "sidebar-row-selected text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="min-w-0 truncate">{FEATURE_NAMES.needsYou.label}</span>
            {/* A count only past three rows (S7): below that the rows are the count. */}
            {items.length > 3 && (
              <span className="shrink-0 whitespace-pre tabular-nums">
                {" · "}
                {items.length}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{only ? "Show everything" : "Show only these"}</TooltipContent>
      </Tooltip>
      {/* S7: a new row fades in on `base`, a resolved one leaves on `exit`,
          and the rest close the gap on `spring.layout`. Rows present when
          the fold mounts do not animate in. */}
      <div className="pt-1">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.key}
              layout={reduceMotion ? false : "position"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: reduceMotion ? { duration: 0 } : transition.base }}
              exit={{ opacity: 0, transition: reduceMotion ? { duration: 0 } : transition.exit }}
              transition={reduceMotion ? { duration: 0 } : spring.layout}
            >
              <AttentionRow
                item={item}
                active={item.conversationId != null && item.conversationId === activeConversationId}
                onNavigate={onNavigate}
                rowProps={rowProps}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * One attention row: who (the agent's shipped face, or the Continuum for
 * Alevr's own runs), what they need in the attention words, and what it is
 * about. Two lines, so neither the name nor the ask is ever truncated away;
 * 44 px tall, a touch target at every width. A chat's row keeps the chat's
 * own menu (rename, pin, project, share, archive, delete), because the list
 * rows it stands in for are not drawn while it waits.
 */
function AttentionRow({
  item,
  active,
  onNavigate,
  rowProps,
}: {
  item: AttentionItem;
  active: boolean;
  onNavigate: () => void;
  rowProps: RowSharedProps;
}) {
  const conversation = item.conversation;
  if (conversation && rowProps.renamingId === conversation.id) {
    return <ConversationRow conversation={conversation} active={active} {...rowProps} />;
  }
  return (
    <div
      data-active={active ? "" : undefined}
      data-conversation-row={item.conversationId ?? undefined}
      className={cn("group relative flex min-h-11 items-center rounded-control pl-2 pr-1", LIST_ROW_TRANSITION, listRowClass(active))}
    >
      <Link
        href={item.href}
        onClick={onNavigate}
        prefetch={false}
        aria-current={active ? "page" : undefined}
        aria-label={`${item.who}. ${item.ask}: ${item.what}`}
        className={cn("flex min-w-0 flex-1 items-center gap-2.5 py-1 pr-1.5", conversation && "coarse:pr-10")}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {item.agent ? <AgentFace avatar={item.agent.avatar} state={item.agent.state} size="xs" /> : <ContinuumMark size={10} tight tone="current" />}
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col", conversation && KEBAB_ROOM)}>
          <span translate="no" className="truncate text-nav text-foreground">
            {item.who}
          </span>
          <span className="truncate text-caption text-muted-foreground">
            <span className="text-[hsl(var(--attention))]">{item.ask}</span>
            <span>{`: ${item.what}`}</span>
          </span>
        </span>
      </Link>
      {conversation && <ConversationMenu conversation={conversation} active={active} {...rowProps} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rows
 * ──────────────────────────────────────────────────────────────────────────── */

function NavRow({
  href,
  onClick,
  icon,
  label,
  trailing,
  signal,
  detail,
  trigger: Trigger,
  active,
  collapsed,
  layoutId,
  transition: t,
  reveal = false,
  moves = false,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  /**
   * A low-frequency destination (New chat, Projects, Library, Customize): its
   * glyph may articulate under a fine pointer (INTERACTION_SPEC I-7). Every
   * other row's glyph holds still.
   */
  moves?: boolean;
  /** A hint that shows under the pointer only (a shortcut's keycap). */
  trailing?: React.ReactNode;
  /**
   * A state that shows AT REST, which `trailing` cannot carry: an unread dot.
   * In the rail it sits on the glyph's corner, since there is no row end. A
   * row takes one or the other, never both (PREMIUM_AUDIT.md rule 6).
   */
  signal?: React.ReactNode;
  /**
   * The words for what `signal` shows ("3 unread"). A dot has none of its
   * own, so they join the accessible name ("Notifications, 3 unread") and
   * the rail's tooltip ("Notifications · 3 unread").
   */
  detail?: string;
  /**
   * Makes the row the trigger of a popover around it (`PopoverTrigger`). It
   * wraps the control itself, inside the rail's tooltip, so the popover's
   * `data-state` and ARIA land on the button and the tooltip's on its wrapper,
   * the order MoreFlyout keeps for its menu.
   */
  trigger?: React.ComponentType<{ asChild?: boolean; children?: React.ReactNode }>;
  active?: boolean;
  collapsed: boolean;
  layoutId: string;
  transition: object;
  /** Where the label fades in from when it mounts; `false` draws it at once. */
  reveal?: { opacity: number } | false;
}) {
  const router = useRouter();
  const cls = cn(
    navRowClass(collapsed, !!active),
    moves ? "jicon-trigger jicon-hover" : "jicon-trigger jicon-quiet",
    // While its popover is open the row wears the selected fill, as the More
    // trigger and the account row do for theirs.
    Trigger && "sidebar-row-selected-on-open data-[state=open]:text-foreground"
  );
  const name = detail ? `${label}, ${detail}` : label;
  const inner = (
    <>
      {/*
       * SELECTION IS TONAL AND IMMEDIATE (INTERACTION_SPEC S1, F0): the row
       * takes the panel's selected fill (`.sidebar-row-selected`) and its
       * ink steps up on the `fast` rung; nothing travels and the glyph never
       * moves for it. It is the same fill the conversation rows draw, so the
       * column has one selected state at both widths.
       */}
      {/* A `size-5` BOX holding a `size-4` GLYPH (the V3 shell: 16 px icons in a 20 px lead slot), and the two numbers are
          doing different jobs.

          The box is layout: 20px at `gap-2.5` is what puts every label in
          this panel on one text edge, 46px from the panel's edge, which the
          header's wordmark lands on too. Change it and the column loses its
          alignment.

          The glyph is weight. `4.5` is the icon ladder's sidebar-destination
          rung (ICONS_AND_MOTION.md §1.2), drawn in the set's regular line
          (1.1px at this size), and its ink measures about 14px: the height of
          the 14px label beside it, so the mark reads as the label's companion
          rather than its heading.

          Muted at rest, foreground under the pointer and on the page you are
          on, cross-faded on the `fast` rung. The ink change and the glyph's
          one gesture (sidebar-motion-icon.tsx) are the whole of the row's
          hover, with the fill behind them. */}
      <span className="relative flex size-5 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-focus-visible:text-foreground group-data-[active]:text-foreground group-data-[state=open]:text-foreground [&_svg]:size-4">
        {icon}
        {/* The rail's signal, on the glyph's top-right corner, where the bell
            and the other marks leave the box empty. Later in the tree than
            the glyph, so it paints over it without a z-index. */}
        {collapsed && signal ? <span className="absolute -right-0.5 -top-0.5 flex">{signal}</span> : null}
      </span>
      {!collapsed && (
        <>
          {/* The `nav` rung sits on the label, the row's only text, and not in
              the row's cn() beside its colours: until `nav` is registered in
              utils.ts, tailwind-merge takes an unknown `text-*` for a colour
              and drops one of the two. */}
          <motion.span
            initial={reveal}
            animate={{ opacity: 1 }}
            transition={transition.base}
            className="min-w-0 flex-1 truncate text-nav"
          >
            {label}
          </motion.span>
          {trailing && (
            <span className="ml-auto shrink-0 opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100">
              {trailing}
            </span>
          )}
          {signal && <span className="ml-auto flex shrink-0 items-center">{signal}</span>}
        </>
      )}
    </>
  );
  // `data-active` on the row, read by `group-data-[active]` on the glyph. It
  // replaces an arbitrary ancestor variant keyed to a literal utility string
  // (`[.bg-sidebar-accent_&]:text-foreground`), which could not tell the hover
  // fill from the active one.
  const activeAttr = active ? "" : undefined;
  const el = href ? (
    <Link
      href={href}
      onClick={onClick}
      /* The destinations behind these rows are reached once in a session if at
         all, and each is a `force-dynamic` route whose prefetch is a full
         server render. Aim, not viewport — see lib/intent-prefetch.ts. */
      prefetch={false}
      {...intentPrefetch(router, href)}
      data-active={activeAttr}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed || detail ? name : undefined}
      className={cls}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      data-active={activeAttr}
      aria-label={collapsed || detail ? name : undefined}
      className={cn(cls, "text-left")}
    >
      {inner}
    </button>
  );
  const row = (
    <motion.div layout="position" layoutId={layoutId} transition={t} className={cn(collapsed && "flex justify-center")}>
      {Trigger ? <Trigger asChild>{el}</Trigger> : el}
    </motion.div>
  );
  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-1.5">
        {detail ? `${label} · ${detail}` : label}
        {trailing && <span className="inline-flex">{trailing}</span>}
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
 * Hover is `bg-sidebar-hover`; active is the travelling fill inside the row
 * (`.sidebar-row-selected` on a shared `layoutId`) and carries no hover rule
 * at all, so the row you are standing on does not brighten under the pointer.
 * The two are separate colours rather than one colour at two alphas; see the
 * note at the top of this file for the rungs.
 */
function navRowClass(collapsed: boolean, active: boolean) {
  return cn(
    // `font-normal`, not `font-medium`. Chrome is quieter than content: the
    // navigation rows used to be set one weight HEAVIER than the chat titles
    // under them, so the furniture out-shouted the documents
    // (docs/design/PREMIUM_AUDIT.md §2). Selection is the fill and the ink.
    /*
     * 32px tall, abutting, measured off the reference at the same window size
     * rather than argued from it:
     *
     *                        reference   now
     *   row pitch              32.2px    32px
     *   label inset            46.5px    46px
     *   icon inset             16.9px    16px
     *   icon glyph ink          14.4px    14.4px
     *   label size              14px      14px (`nav`, on the label)
     *
     * `px-2` on the row, against the panel's own `px-2`, is where the inset
     * comes from: 8 + 8 = 16 to the glyph, + a 20px box + `gap-2.5` = 46 to
     * the label. That 46 is load-bearing: the header's wordmark keys to it,
     * and the collapse glyph's centre keys to the glyph column's 26.
     */
    // Background and ink only: selection is a fill with no edge, so there is
    // no shadow to animate (the More trigger bolts `.sidebar-row-selected`
    // onto this recipe and relies on this list for its fade).
    "group relative flex h-8 w-full items-center rounded-control font-normal transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
    // The rail: a 44px target around the glyph, so every icon is one tap and
    // the row's tooltip names it.
    // The rail: 36px targets on a 52px column (44 under a coarse pointer).
    // The old 44px tiles made every glyph sit in a slab of grey when hovered
    // or selected, which is what read as "too big".
    collapsed ? "size-9 justify-center px-0 coarse:size-11" : "gap-2.5 px-2 coarse:h-11",
    // NO `bg-` on the active row: its fill is the travelling `motion.span`
    // inside it (see NavRow). Painting it here too would leave a hard-edged
    // copy of the fill sitting under the one that slides, so the old row's ink
    // would blink off before the new row's arrived.
    active
      ? "sidebar-row-selected text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground"
  );
}

/**
 * Selection for the rows that are NOT the travelling fill: conversations,
 * projects, a project's own chats.
 *
 * They keep a CSS fill that cuts rather than travels, and that is deliberate.
 * The four navigation rows are a fixed, always-mounted ladder eight pixels
 * apart, so a fill sliding between them reads as one object moving. This list
 * is a scroller: the row you leave can be four hundred pixels up the column or
 * unmounted entirely, and a fill flying that far — or vanishing mid-flight
 * because its origin scrolled out of the well — is a projectile, not a
 * correction. Same recipe, same fill, no travel.
 */
function listRowClass(active: boolean) {
  return active
    ? "sidebar-row-selected text-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground";
}

/**
 * What a list row animates: its fill and its ink, on the `fast` rung (120ms).
 * This is a property changing on a row the pointer has just left or landed
 * on, and the two rows do it at once: the one you left gives its fill up over
 * exactly the window the one you chose takes it on, so the state crosses
 * rather than blinking.
 */
const LIST_ROW_TRANSITION =
  "transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none";

function InlineErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      // Fades in rather than landing: it arrives after the panel has already
      // drawn, and a block that cuts in above the list shoves every row under
      // it in the same frame.
      className="mx-0.5 my-1 flex items-center gap-2 rounded-control border border-destructive/40 bg-destructive/10 px-2 py-2 text-ui text-destructive motion-safe:animate-fade-in"
    >
      {/* `size-4` beside `text-ui` at `gap-2`, the icon ladder's row pair. */}
      <StatusIcons.error className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {/* No `transition-*` utility: `.pressable` carries the colour AND the
          press transitions, and a utility beside it would replace both. */}
      <button
        type="button"
        onClick={onRetry}
        className="pressable flex shrink-0 items-center gap-1.5 rounded-control px-1.5 py-0.5 font-medium hover:bg-destructive/20 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
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
          // No `transition-opacity`: `.pressable` already fades opacity on the
          // `fast` rung alongside the colour and the press, and a transition
          // utility beside it replaced that shorthand, so the hover fill cut
          // in and the press never dipped. The hover is an ink tint, like the
          // row kebab's (see KEBAB_CLASS), so it reads the same on the panel
          // and on a filled row. The drawn box stays 24px so the "+" sits on
          // the heading's line; the `after:` layer reaches 4px past each edge,
          // so the hit area meets the 32px pointer floor (44 under `coarse:`)
          // without the heading growing.
          className={cn(
            "size-6 rounded-control text-muted-foreground after:absolute after:-inset-1 hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 coarse:size-9 coarse:opacity-100",
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
    // `mt-5` ABOVE the heading that owns the break, so the first section sits
    // on the scroller's own `pt-5` and every later one is separated from the
    // list it follows by the same 20px.
    <div className="group/section mt-5 first:mt-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          /* `px-2`: 16px from the panel edge, measured at 15.2 in the
             reference, and NOT the 46px the nav labels sit at.
             THE COLUMN HAS TWO TEXT EDGES ON PURPOSE. 46px is where a label
             lands when a glyph precedes it, and every destination has one.
             A section heading has no glyph and neither do the conversation
             rows under it, so both sit at 16: the heading on the same edge as
             the list it heads, which is the alignment that actually matters.

             A plain button, not `Pressable kind="row"`: a heading is a label
             on the list, and the row press tone (`active:bg-selected`, a page
             fill) and hover fill made it flash like one more row. Only its
             ink answers the pointer. */
          className="group/heading flex h-7 min-w-0 flex-1 select-none items-center gap-1 rounded-control px-2 text-left text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none coarse:h-11"
        >
          {/* ONE SECTION VOICE: sentence-case sans at the `label` rung (12px,
              weight 500), muted, two steps under the 14px rows. Quiet enough
              to be a label ON the list rather than an object beside it, which
              is how the reference sets them. */}
          <span className="min-w-0 truncate">{label}</span>
          {/* The chevron appears with the pointer or focus, and stays while
              the section is folded, because folded is a state the reader has
              to be able to see. `ease-in-out` on the `base` rung: both ends of
              the turn are on screen, and the rows under it unfold over the
              same 220ms. */}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-[opacity,transform] duration-base ease-in-out motion-reduce:transition-none",
              isCollapsed
                ? "-rotate-90"
                : "opacity-0 group-hover/section:opacity-100 group-focus-visible/heading:opacity-100 coarse:opacity-100"
            )}
          />
        </button>
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
  /** Puts a row back after an optimistic removal the server refused. */
  onRestore: (c: ClientConversation) => void;
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
  onRestore,
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
  /* A pin is not drawn under a project, where the row's place already says it
     was filed on purpose. */
  /* A run's state is no longer a coloured pip in the trailing slot (owner
     directive, 2026-09-26). A row that needs the reader is set in full ink at
     medium weight instead; every other state says nothing here, and the
     StatusDot left in the slot only carries the words for a screen reader. */
  const needsReader = signal?.tone === "attention" || signal?.tone === "bad";
  const trailingMark = conversation.pinned && !nested;

  const { patch } = useConversationActions({ conversation, active, onUpdate, onRemove, onRestore, onRequestConfirm });

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
     * A title on the panel and nothing else: no leading glyph (a chat is a
     * document, not a destination; PREMIUM_AUDIT.md rule 4), so the title
     * starts on the column's 16px edge under its section heading. The title
     * does NOT change weight on select; `font-semibold` re-measured it and
     * visibly re-truncated the row you had just clicked.
     */
    <div
      data-active={active ? "" : undefined}
      /* How the panel finds the row it has just selected, so it can bring it
         into the well — see the effect in AppSidebar. On the conversation's
         own id rather than on `data-active`, because the row that needs
         finding is the one that is ABOUT to be active. */
      data-conversation-row={conversation.id}
      className={cn(
        "group relative flex h-8 items-center rounded-control pl-2 pr-1 coarse:h-11",
        LIST_ROW_TRANSITION,
        nested && "ml-4",
        listRowClass(!!active)
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        /* Prefetched on aim, not on scroll — see lib/intent-prefetch.ts. */
        prefetch={false}
        {...intentPrefetch(router, `/chat/${conversation.id}`)}
        aria-current={active ? "page" : undefined}
        /* No leading slot, so the title IS the row's left edge: 16px from the
           panel, on the same line as the section heading above it. `gap-2` is
           only ever spent on a trailing mark. A title takes the same `nav`
           rung the destinations read at, so the panel never sets documents
           smaller than its furniture. */
        /* `pr-1.5`: with the row's `pr-1`, a trailing mark's 16px slot is
           centred 18px from the row's edge, exactly where the kebab's centre
           lands when it takes the mark's place. `coarse:pr-10` keeps the
           always-visible touch kebab clear of the title. */
        className="flex min-w-0 flex-1 items-center gap-2 pr-1.5 text-nav font-normal coarse:pr-10"
        /* The run's sentence joins the title rather than replacing it: this
           attribute is also how a truncated title gets read, and a row that
           answered "what is this" with "Juno has asked you something" would
           have traded one fact for another. */
        title={signal ? `${rowLabel}: ${signal.meaning}` : rowLabel}
      >
        <AnimatedTitle
          title={rowLabel}
          animate={conversation.titleSource === "ai"}
          className={cn("min-w-0 flex-1", !trailingMark && KEBAB_ROOM, needsReader && "font-medium text-foreground")}
        />
        {signal && <StatusDot tone={signal.tone} label={signal.label} />}
        {/* One trailing mark, in this order: a run that needs you outranks the
            fact that the row is pinned, because the pin is something you set
            and the dot is something that happened. Rule 6 still holds (a row
            shows one mark, in one place), and it gives its place to the kebab
            while the row is under the pointer. */}
        {trailingMark && (
          <span className={cn("flex size-4 shrink-0 items-center justify-center", TRAILING_MARK_YIELDS)}>
            {(
              /* `weight="fill"` because a pin you set is ON (ICONS_AND_MOTION.md
                 §1.2), and `motion="none"` because here it reports a state
                 rather than offering an action: a status mark that tilted when
                 the row was hovered would be claiming the row pins something. */
              <Pin weight="fill" motion="none" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </span>
        )}
      </Link>
      <ConversationMenu
        conversation={conversation}
        active={active}
        setRenaming={setRenaming}
        projects={projects}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onRestore={onRestore}
        onNavigate={onNavigate}
        onRequestConfirm={onRequestConfirm}
        onShare={onShare}
        onArchive={onArchive}
      />
    </div>
  );
}



/**
 * What a conversation's own menu changes, shared by its list row and by its
 * Needs you row, so a chat that is waiting on the reader keeps every verb.
 */
function useConversationActions({
  conversation,
  active,
  onUpdate,
  onRemove,
  onRestore,
  onRequestConfirm,
}: Pick<RowSharedProps, "onUpdate" | "onRemove" | "onRestore" | "onRequestConfirm"> & {
  conversation: ClientConversation;
  active: boolean;
}) {
  const router = useRouter();
  const isCodeSession = conversation.kind === "code";
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
        : `This permanently removes the conversation and its messages. Anything ${PRODUCT_NAME} made in it stays in your Library. This can't be undone.`,
      confirmLabel: isCodeSession ? "Delete session" : "Delete chat",
      onConfirm: async () => {
        onRemove(conversation.id);
        const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" }).catch(() => null);
        if (!res?.ok) {
          // The row comes back: the chat still exists, and a list that went on
          // leaving it out would say otherwise until the next reload.
          onRestore(conversation);
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

  return { patch, remove };
}

/** A conversation's kebab and its menu: Rename, Pin, Add to project, Share, Archive, Delete. */
function ConversationMenu({
  conversation,
  active,
  setRenaming,
  projects,
  onUpdate,
  onRemove,
  onRestore,
  onNavigate,
  onRequestConfirm,
  onShare,
  onArchive,
}: Omit<RowSharedProps, "renamingId"> & { conversation: ClientConversation; active: boolean }) {
  const router = useRouter();
  const isCodeSession = conversation.kind === "code";
  const { patch, remove } = useConversationActions({ conversation, active, onUpdate, onRemove, onRestore, onRequestConfirm });
  return (
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
              /* Out of the flow, over the row's right end, so at rest the
                 title runs the full width of the row instead of stopping
                 28px short for a control that is invisible. */
              className={cn(KEBAB_CLASS, "absolute inset-y-0 right-1 my-auto")}
              aria-label={isCodeSession ? "Session options" : "Conversation options"}
            >
              <SidebarMotionIcon kind="more" className="size-3.5" />
            </Pressable>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Options</TooltipContent>
      </Tooltip>
      {/* ONE hairline, and it is the one before Delete.
          This menu carried three, which cut seven rows into four groups —
          Rename/Pin, the project submenu, Share/Archive, Delete — and a
          four-part menu of seven verbs reads as a settings panel. The
          reference set (ChatGPT's chat menu, Claude's, Linear's) all do the
          same thing: the actions are one list, and the rule exists to put a
          beat in front of the row that cannot be undone. */}
      <DropdownMenuContent align="end" className={MENU_W}>
        <DropdownMenuItem onSelect={() => setRenaming(conversation.id)}>
          <ActionIcons.edit className="size-4" /> Rename
        </DropdownMenuItem>
        {/* The verb's own glyph: a pin to pin, a struck pin to unpin. It was
            the same pin for both, filled in the accent when the row was
            already pinned — a state mark sitting on an action, and the one
            accent-coloured glyph in a menu of muted ones. */}
        <DropdownMenuItem onSelect={() => patch({ pinned: !conversation.pinned })}>
          {conversation.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {conversation.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        {/* A project is Chat's filing and a Code session has its own — the
            repository or workspace it runs in — so this submenu would offer
            to file a session into a folder the Code column never draws. */}
        {!isCodeSession && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppIcons.projects className="size-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={MENU_W}>
              <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                {conversation.projectId == null ? <StatusIcons.success className="size-4 text-primary" /> : <span className="size-4" />}
                No project
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => patch({ projectId: p.id })}>
                  {conversation.projectId === p.id ? <StatusIcons.success className="size-4 text-primary" /> : <AppIcons.projects className="size-4" />}
                  <span dir="auto" className="truncate">
                    {p.name}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  onNavigate();
                  router.push("/projects");
                }}
              >
                <Plus className="size-4" /> New project…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
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
  );
}

/**
 * One agent in the sidebar (S8): its shipped face at 20 px, still; its name;
 * and its state in words on the right, in the third ink. Ready is the rest
 * state and says nothing. The words carry the state; the face never loops here
 * and the row never turns amber (the ask is coloured once, in Needs you).
 */
function AgentRow({ agent, active, onNavigate }: { agent: ClientAgent; active: boolean; onNavigate: () => void }) {
  const sentence = localStateSentence(agent);
  // Waiting says the same words as its Needs you row ("Needs your approval"
  // when the task stopped for an approval), so one ask never reads two ways.
  const word = agent.state === "idle" ? null : agent.state === "waiting" ? askWords(agent.task?.status) : AGENT_STATE_LABEL[agent.state];
  return (
    <div
      data-active={active ? "" : undefined}
      className={cn("group relative flex h-8 items-center rounded-control pl-2 pr-2 coarse:h-11", LIST_ROW_TRANSITION, listRowClass(active))}
    >
      <Link
        href={agent.conversationId ? `/chat/${agent.conversationId}` : `/agents/${agent.id}`}
        onClick={onNavigate}
        prefetch={false}
        aria-current={active ? "page" : undefined}
        aria-label={`${agent.name}, ${(word ?? AGENT_STATE_LABEL.idle).toLowerCase()}. ${sentence}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-nav font-normal"
        title={sentence}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <AgentFace avatar={agent.avatar} state={agent.state} size="xs" />
        </span>
        <span translate="no" className="min-w-0 flex-1 truncate">
          {agent.name}
        </span>
        {word && (
          <span aria-hidden="true" className="shrink-0 text-caption text-muted-foreground transition-opacity duration-fast ease-out-soft motion-reduce:transition-none">
            {word}
          </span>
        )}
      </Link>
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
     `ConversationRow` (they hang off a guide line and carry no kebab), but a
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
  const router = useRouter();
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
          "group relative flex h-8 items-center rounded-control pl-2 pr-1 coarse:h-11",
          LIST_ROW_TRANSITION,
          listRowClass(active)
        )}
      >
        <Link
          href={`/projects/${project.id}`}
          onClick={onNavigate}
          prefetch={false}
          {...intentPrefetch(router, `/projects/${project.id}`)}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-nav font-normal"
          title={project.name}
        >
          {/* The one glyph that survives in a list row, because its closed →
              open folder crossfade is the single glyph morph in this panel
              that carries meaning. */}
          <span className="flex size-5 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground [&_svg]:size-4">
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
                /* THE HIT AREA IS 32×32, the box is 20. The kebab sits flush
                   against the chevron's right edge, is `relative` and later
                   in the DOM, and its own `after:` layer starts 2px inside
                   this box — so it wins every point it overlaps, even at
                   opacity 0. A layer centred on the caret would lose 8px to
                   it and fall back to 24 wide. So the layer grows to the
                   LEFT only: 6px above and below (32 tall on the 20px box),
                   14px past the left edge — across the `ml-1` gap and the
                   title link's last 10px, which is trailing space or the
                   ellipsis — and it stops 2px short of the right edge, where
                   the kebab's layer begins: [-14px, 18px], 32 wide, none of
                   it shadowed. The drawn target does not grow and the title
                   loses no width. Under `coarse:` the box is already 40 and
                   the layer is not needed. */
                className="relative ml-1 flex size-5 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-fast ease-out-soft after:absolute after:-inset-y-1.5 after:-left-3.5 after:right-0.5 hover:bg-foreground/5 hover:text-foreground coarse:-my-3 coarse:size-10 coarse:after:hidden"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
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
          <DropdownMenuContent align="end" className={MENU_W}>
            <DropdownMenuItem onSelect={onNewChat}>
              <Plus className="size-4" /> New chat in project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleStar}>
              {starred ? <PinOff className="size-4" /> : <Pin className="size-4" />}
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
          {/* The guide drops from the folder's REAL centre, the row's `pl-2`
              (8) plus half of `size-5` (10) = 18px, so it stays under the
              glyph it descends from (26px from the panel edge) rather than
              under an arbitrary inset. `ml-[18px]` is off the spacing ladder
              on purpose: this is an alignment to a computed centre, and
              rounding it to `ml-4` or `ml-5` would visibly miss the folder. */}
          <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-sidebar-border pb-1 pl-2.5">
            {visibleChats.map((c) => {
              const signal = signals.get(c.id);
              const label = c.title || "New chat";
              return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={onNavigate}
                prefetch={false}
                {...intentPrefetch(router, `/chat/${c.id}`)}
                aria-current={activePath === `/chat/${c.id}` ? "page" : undefined}
                /* Findable by the same attribute a top-level row is, so a chat
                   opened from anywhere scrolls into the well whether it lives
                   in the recents or inside a pinned project. */
                data-conversation-row={c.id}
                title={signal ? `${label}: ${signal.meaning}` : label}
                className={cn(
                  "group group/pc flex h-8 items-center gap-2.5 rounded-control px-2 font-normal coarse:h-11",
                  LIST_ROW_TRANSITION,
                  activePath === `/chat/${c.id}`
                    ? "sidebar-row-selected text-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground"
                )}
              >
                {/* No leading slot here either: the guide line to the left
                    already says these rows belong to the project above them.
                    The signal is trailing, as it is on every other
                    conversation row. The `nav` rung is on the title, outside
                    the cn() that holds the row's colours. */}
                <span
                  dir="auto"
                  className={cn(
                    "min-w-0 flex-1 truncate text-nav",
                    (signal?.tone === "attention" || signal?.tone === "bad") && "font-medium text-foreground",
                  )}
                >
                  {label}
                </span>
                {signal && <StatusDot tone={signal.tone} label={signal.label} />}
              </Link>
              );
            })}
            {chats.length > PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-hover hover:text-foreground motion-reduce:transition-none coarse:h-11"
              >
                {showAll ? "Show less" : <>View all {chats.length}</>}
              </button>
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Archived chats: restore or delete, opened from More.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The dialog list's empty and failed states: one muted glyph in a quiet tile
 * and one sentence (ICONS_AND_MOTION.md §3). They were a bare centred line of
 * grey, which in a 448px dialog read as the list having failed to render
 * rather than as the list saying something.
 */
function DialogListState({
  icon: Icon,
  tone = "empty",
  children,
}: {
  icon: IconComponent;
  tone?: "empty" | "error";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-8 text-center motion-safe:animate-fade-in">
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-field",
          tone === "error" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"
        )}
      >
        <Icon className="size-5" motion="none" aria-hidden="true" />
      </span>
      <p className="text-body text-muted-foreground">{children}</p>
    </div>
  );
}

function ArchivedChatsDialog({
  open,
  product,
  onOpenChange,
  onNavigate,
  onRestored,
  onRequestConfirm,
}: {
  open: boolean;
  /** Archived rows are filtered to the product whose panel opened this, so the
   *  Code column's "Archived sessions" cannot answer with a year of chats. */
  product: ProductSurface;
  onOpenChange: (o: boolean) => void;
  /** Opening a row leaves the panel the way a row in it does: on a phone the
   *  dialog lives inside the drawer, and the drawer stayed open over the chat
   *  it had just opened. */
  onNavigate: () => void;
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
        : `This permanently removes the conversation and its messages. Anything ${PRODUCT_NAME} made in it stays in your Library. This can't be undone.`,
      confirmLabel: isCode ? "Delete session" : "Delete chat",
      onConfirm: async () => {
        setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
        const r = await fetch(`/api/conversations/${c.id}`, { method: "DELETE" }).catch(() => null);
        if (!r?.ok) {
          // Back in the list, as a failed restore puts it back: it is still
          // archived, and the list must not claim otherwise.
          setItems((prev) => (prev ? [c, ...prev] : prev));
          toast.error("Delete failed.");
        }
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
              : "Archived chats stay searchable. Restore one to bring it back to Recent."}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[50vh] overflow-y-auto">
          {failed ? (
            <DialogListState icon={StatusIcons.error} tone="error">
              {isCode ? "Couldn’t load archived sessions." : "Couldn’t load archived chats."}
            </DialogListState>
          ) : items == null ? (
            <div className="space-y-0.5 px-1">
              {/* The placeholders stand at the row's own geometry — a title and
                  a date line, 48px — so the list does not re-shape when the
                  archive lands. */}
              {[...Array(4)].map((_, i) => (
                <div key={i} className="skeleton h-12 rounded-control" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <DialogListState icon={Archive}>Nothing archived.</DialogListState>
          ) : (
            <ul className="space-y-0.5">
              {items.map((c, i) => (
                /* Dealt, not dumped: the first eight rows arrive on the
                   `tight` stagger, the rest with the eighth. No leading glyph —
                   a chat is a document, and the title and its date already
                   say what it is (PREMIUM_AUDIT.md rule 4). */
                <li
                  key={c.id}
                  style={staggerDelay(Math.min(i, 8), "tight")}
                  className="group flex items-center gap-2 rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-safe:animate-rise-in motion-reduce:transition-none [animation-fill-mode:backwards]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onNavigate();
                      router.push(`/chat/${c.id}`);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
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
