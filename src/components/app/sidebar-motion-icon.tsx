import {
  Folder,
  FolderOpen,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  X,
  type LucideIcon,
} from "lucide-react";
import { AppIcons } from "@/lib/app-icons";
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
 * One optically consistent icon set for the entire app shell. Destination marks
 * come from AppIcons so menus / palette / pages never drift; CSS in globals.css
 * articulates the meaningful part of each mark on hover (except overflow ⋯).
 *
 * Kinds with a closed → open morph (`folder`, `projects`) stack a second glyph
 * and crossfade under CSS — see `.sidebar-motion-icon__glyph--alternate`.
 */
const ICONS: Record<SidebarMotionIconKind, LucideIcon> = {
  new: AppIcons.new,
  home: AppIcons.home,
  code: AppIcons.code,
  library: AppIcons.library,
  artifacts: AppIcons.artifacts,
  connections: AppIcons.connections,
  projects: AppIcons.projects,
  tasks: AppIcons.tasks,
  pulls: AppIcons.pulls,
  search: AppIcons.search,
  "panel-open": PanelLeft,
  "panel-close": PanelLeftClose,
  close: X,
  folder: Folder,
  conversation: AppIcons.conversation,
  more: MoreVertical,
};

const OPENS_ON_HOVER: ReadonlySet<SidebarMotionIconKind> = new Set(["folder", "projects"]);

export function SidebarMotionIcon({
  kind,
  className,
}: {
  kind: SidebarMotionIconKind;
  className?: string;
}) {
  const Icon = ICONS[kind];
  const opens = OPENS_ON_HOVER.has(kind);

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

      {opens ? (
        <FolderOpen
          focusable="false"
          strokeWidth={1.75}
          className="sidebar-motion-icon__glyph sidebar-motion-icon__glyph--alternate absolute inset-0 h-full w-full"
        />
      ) : null}
    </span>
  );
}
