import {
  Box,
  BookOpen,
  CalendarClock,
  Code2,
  Folder,
  GitPullRequest,
  Home,
  Layers3,
  MessageSquare,
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
  conversation: MessageSquare,
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
    <Icon
      aria-hidden="true"
      focusable="false"
      strokeWidth={1.75}
      className={cn("sidebar-motion-icon", `sidebar-motion-icon--${kind}`, className)}
    />
  );
}
