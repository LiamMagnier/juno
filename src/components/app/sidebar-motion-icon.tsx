import {
  Box,
  BookOpen,
  CalendarClock,
  Code2,
  Folder,
  FolderOpen,
  GitPullRequest,
  Home,
  Layers3,
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
 * One optically consistent icon set for the entire app shell. Keeping this
 * adapter means sidebar call sites share the same size and motion language,
 * while Lucide supplies production-tested geometry instead of bespoke paths.
 */
const ICONS: Record<SidebarMotionIconKind, LucideIcon> = {
  new: Plus,
  home: Home,
  code: Code2,
  library: BookOpen,
  artifacts: Layers3,
  connections: Plug,
  projects: Box,
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

      {kind === "conversation" ? (
        <span className="sidebar-motion-icon__chat-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : null}
    </span>
  );
}
