import {
  CalendarClock,
  Code2,
  Folder,
  FolderKanban,
  FolderOpen,
  GitPullRequest,
  Home,
  Layers3,
  Library,
  MessageCircle,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Plug,
  Plus,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type SidebarMotionIconKind =
  | "new"
  | "home"
  | "code"
  | "library"
  | "artifacts"
  | "connections"
  | "projects"
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
 * One optically consistent icon set for the entire app shell. Lucide supplies
 * the resting geometry; CSS in globals.css articulates the meaningful part of
 * each mark on hover (except overflow ⋯, which stays static).
 */
const ICONS: Record<SidebarMotionIconKind, LucideIcon> = {
  new: Plus,
  home: Home,
  code: Code2,
  // Bookshelf spines — clearer “library of files” than an open book.
  library: Library,
  artifacts: Layers3,
  connections: Plug,
  // Folder + kanban bars — reads as a project container, not a package.
  projects: FolderKanban,
  tasks: CalendarClock,
  pulls: GitPullRequest,
  search: Search,
  "panel-open": PanelLeft,
  "panel-close": PanelLeftClose,
  close: X,
  folder: Folder,
  conversation: MessageCircle,
  more: MoreVertical,
};

export function SidebarMotionIcon({
  kind,
  className,
}: {
  kind: SidebarMotionIconKind;
  className?: string;
}) {
  const Icon = ICONS[kind];

  return (
    <span
      aria-hidden="true"
      className={cn("sidebar-motion-icon", `sidebar-motion-icon--${kind}`, className)}
    >
      <Icon
        focusable="false"
        strokeWidth={1.75}
        className="sidebar-motion-icon__glyph h-full w-full"
      />

      {kind === "folder" ? (
        <FolderOpen
          focusable="false"
          strokeWidth={1.75}
          className="sidebar-motion-icon__glyph sidebar-motion-icon__glyph--alternate absolute inset-0 h-full w-full"
        />
      ) : null}
    </span>
  );
}
