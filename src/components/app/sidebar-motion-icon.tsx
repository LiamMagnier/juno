import {
  Folder,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Plus,
  SlidersHorizontal,
  type IconComponent,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

export type SidebarMotionIconKind =
  | "new"
  /** A new Code session: the plain plus (a session is not a chat bubble). */
  | "new-session"
  /** Customize: balanced adjustment sliders (NAMES_AND_ICONS: Context destinations). */
  | "customize"
  | "home"
  /* No "work". A glyph in this union marks a DESTINATION — a row in the
     sidebar or its flyout — and Work stopped being one when it became
     something a conversation does (docs/design/TWO_PRODUCTS.md §2). The mark
     itself is not gone: `AppIcons.work` still draws a task in the command
     palette's results and in the recents list, because a task is still a kind
     of THING even though it is no longer a kind of PLACE. */
  | "code"
  | "design"
  | "library"
  | "research"
  | "artifacts"
  | "connections"
  | "projects"
  | "assistants"
  /** Agents: persistent teammates (docs/design/AGENTS.md). A destination, like Projects. */
  | "agents"
  | "tasks"
  /** Skills, Automations and Permissions: the three rooms Work's tab row used
   *  to hold. Skills and Automations are rows in More. Permissions has no
   *  sidebar row now (its Macs moved to Settings); the kind stays so a
   *  flyout or page that links it draws the registry's mark. */
  | "skills"
  | "automations"
  | "permissions"
  | "pulls"
  /** Code's Customize row. The same gear the account menu draws Settings with,
   *  because it is the same idea one level down: configuration for a product
   *  rather than for the account. */
  | "settings"
  | "search"
  /** Notifications: an action row like Search, opening a popover rather than a page. */
  | "notifications"
  | "panel-open"
  | "panel-close"
  | "close"
  | "folder"
  | "conversation"
  | "more";

/**
 * The app shell's marks, one per destination, from the Juno icon set.
 *
 * Every drawing comes from the `AppIcons` registry so the sidebar, its More
 * flyout, the product switch, the command palette and the pages never draw one
 * destination two ways. This file adds only what the registry cannot know:
 * the folder's closed → open cross-fade, and which glyph defaults to silence
 * in a navigation column.
 */
const ICONS: Record<SidebarMotionIconKind, IconComponent> = {
  new: MessageSquarePlus,
  "new-session": Plus,
  customize: SlidersHorizontal,
  home: AppIcons.home,
  code: AppIcons.code,
  design: AppIcons.design,
  library: AppIcons.library,
  research: AppIcons.research,
  artifacts: AppIcons.artifacts,
  connections: AppIcons.connections,
  projects: AppIcons.projects,
  assistants: AppIcons.assistants,
  agents: AppIcons.agents,
  tasks: AppIcons.tasks,
  skills: AppIcons.skills,
  automations: AppIcons.automations,
  permissions: AppIcons.permissions,
  pulls: AppIcons.pulls,
  settings: AppIcons.settings,
  search: AppIcons.search,
  notifications: AppIcons.notifications,
  "panel-open": PanelLeft,
  "panel-close": PanelLeftClose,
  close: ActionIcons.dismiss,
  folder: Folder,
  conversation: AppIcons.conversation,
  more: ActionIcons.more,
};

/**
 * WHAT EACH MARK DOES UNDER THE POINTER is the family's business
 * (src/components/ui/icons.tsx, MOTION IS OPT-IN): a glyph articulates only
 * inside a row marked `.jicon-trigger.jicon-hover`, under a fine pointer. The
 * sidebar opts in its four low-frequency destinations (New chat, Projects,
 * Library, Customize); every other row, and every list, stays still.
 */

/**
 * The default box, and why there has to be one.
 *
 * The inner glyph used to be `size-full` inside a wrapper that has no size of
 * its own (`.sidebar-motion-icon` in globals.css only sets `inline-flex`). A
 * percentage against an auto-sized box resolves to nothing, so every caller
 * that forgot a `size-*` class silently rendered at the icon set's default
 * 24px box — overflowing the 20px wells the sidebar draws around its marks.
 * That one bug was most of "the sidebar elements are too big".
 *
 * It is applied FIRST in each cn(), so a caller's own `size-*` still wins — the
 * default is a floor, not a cap. Callers that size through a parent
 * (`[&_svg]:size-4.5` on a row's glyph box) win too, because that selector
 * outranks a bare utility on the svg.
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
  // The folder's closed-to-open change is the family drawing's own hover swap
  // now (drawings.ts, `folder`), played only where the row opts in
  // (.jicon-hover), so one glyph is drawn rather than two stacked.
  return (
    <span aria-hidden="true" className={cn("sidebar-motion-icon", `sidebar-motion-icon--${kind}`, DEFAULT_GLYPH_SIZE, className)}>
      <Icon focusable="false" className={cn("sidebar-motion-icon__glyph", DEFAULT_GLYPH_SIZE, className)} />
    </span>
  );
}
