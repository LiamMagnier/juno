import {
  Folder,
  FolderOpen,
  PanelLeft,
  PanelLeftClose,
  type LucideIcon,
} from "lucide-react";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

export type SidebarMotionIconKind =
  | "new"
  | "home"
  | "work"
  | "code"
  | "design"
  | "library"
  | "research"
  | "artifacts"
  | "connections"
  | "projects"
  | "assistants"
  | "tasks"
  | "pulls"
  | "search"
  | "panel-open"
  | "panel-close"
  | "close"
  | "folder"
  | "conversation"
  | "more";

/**
 * One optically consistent icon set for the entire app shell. Destination marks
 * come from AppIcons so menus / palette / pages never drift; CSS in globals.css
 * articulates the meaningful part of each mark on hover (except overflow ⋯).
 *
 * Kinds with a closed → open morph (`folder`, `projects`) stack a second glyph
 * and crossfade under CSS — see `.sidebar-motion-icon__glyph--alternate`.
 *
 * A kind with no bespoke rule in globals.css still animates: the shared
 * `:hover` lift applies to every kind except the three it excludes by name. So
 * a new mark is never inert, it just has no per-part choreography until someone
 * writes it.
 */
const ICONS: Record<SidebarMotionIconKind, LucideIcon> = {
  new: AppIcons.new,
  home: AppIcons.home,
  work: AppIcons.work,
  code: AppIcons.code,
  design: AppIcons.design,
  library: AppIcons.library,
  research: AppIcons.research,
  artifacts: AppIcons.artifacts,
  connections: AppIcons.connections,
  projects: AppIcons.projects,
  assistants: AppIcons.assistants,
  tasks: AppIcons.tasks,
  pulls: AppIcons.pulls,
  search: AppIcons.search,
  "panel-open": PanelLeft,
  "panel-close": PanelLeftClose,
  close: ActionIcons.dismiss,
  folder: Folder,
  conversation: AppIcons.conversation,
  more: ActionIcons.more,
};

const OPENS_ON_HOVER: ReadonlySet<SidebarMotionIconKind> = new Set(["folder", "projects"]);

/**
 * The default box, and why there has to be one.
 *
 * The inner glyph used to be `size-full` inside a wrapper that has no size of
 * its own (`.sidebar-motion-icon` in globals.css only sets `inline-flex`). A
 * percentage against an auto-sized box resolves to nothing, so every caller
 * that forgot a `size-*` class silently rendered at Lucide's INTRINSIC 24px —
 * overflowing the 22px wells the sidebar drew around them, and missing the
 * optical stroke ladder entirely, so the mark also drew at the 24px reference
 * weight. That one bug was most of "the sidebar elements are too big": 24px
 * destination marks beside 15px chat bubbles beside 14px switch icons.
 *
 * It is applied FIRST in each cn(), so a caller's own `size-*` still wins — the
 * default is a floor, not a cap.
 */
const DEFAULT_GLYPH_SIZE = "size-4";

export function SidebarMotionIcon({
  kind,
  className,
}: {
  kind: SidebarMotionIconKind;
  className?: string;
}) {
  const Icon = ICONS[kind];
  const opens = OPENS_ON_HOVER.has(kind);
  // The size lands on the <svg> itself, not only on the wrapper: the optical
  // stroke ladder is written as `svg.lucide.size-4 { stroke-width: 2.25 }`, so
  // a glyph sized through a parent (the old `size-full`) drew at the 24px
  // reference weight however small it actually rendered.
  const glyphCls = cn("sidebar-motion-icon__glyph", DEFAULT_GLYPH_SIZE, className);

  return (
    <span
      aria-hidden="true"
      className={cn("sidebar-motion-icon", `sidebar-motion-icon--${kind}`, DEFAULT_GLYPH_SIZE, className)}
    >
      <Icon focusable="false" className={glyphCls} />

      {opens ? (
        <FolderOpen
          focusable="false"
          className={cn(glyphCls, "sidebar-motion-icon__glyph--alternate absolute inset-0")}
        />
      ) : null}
    </span>
  );
}
