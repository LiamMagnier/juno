/**
 * Canonical destination icons for the whole app shell.
 *
 * Menus, the command palette, the sidebar, chips, and empty states should all
 * import from here so a mark never drifts (e.g. projects as Box in one place
 * and Folder in another). Sidebar hover choreography still lives in
 * SidebarMotionIcon — this module is the shared resting glyph set.
 */
import {
  CalendarClock,
  Code2,
  Folder,
  GitPullRequest,
  Home,
  Layers3,
  Library,
  MessageCircle,
  Plug,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";

export const AppIcons = {
  home: Home,
  code: Code2,
  library: Library,
  artifacts: Layers3,
  projects: Folder,
  tasks: CalendarClock,
  connections: Plug,
  pulls: GitPullRequest,
  conversation: MessageCircle,
  new: Plus,
  search: Search,
} as const satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof AppIcons;
