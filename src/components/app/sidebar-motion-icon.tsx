import {
  Folder,
  FolderOpen,
  PanelLeft,
  PanelLeftClose,
  type IconComponent,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

export type SidebarMotionIconKind =
  | "new"
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
  | "tasks"
  /** Skills, Automations and Permissions: the three rooms Work's tab row used
   *  to hold, now destinations of their own under More. */
  | "skills"
  | "automations"
  | "permissions"
  | "pulls"
  /** Code's Customize row. The same gear the account menu draws Settings with,
   *  because it is the same idea one level down: configuration for a product
   *  rather than for the account. */
  | "settings"
  | "search"
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
  new: AppIcons.new,
  home: AppIcons.home,
  code: AppIcons.code,
  design: AppIcons.design,
  library: AppIcons.library,
  research: AppIcons.research,
  artifacts: AppIcons.artifacts,
  connections: AppIcons.connections,
  projects: AppIcons.projects,
  assistants: AppIcons.assistants,
  tasks: AppIcons.tasks,
  skills: AppIcons.skills,
  automations: AppIcons.automations,
  permissions: AppIcons.permissions,
  pulls: AppIcons.pulls,
  settings: AppIcons.settings,
  search: AppIcons.search,
  "panel-open": PanelLeft,
  "panel-close": PanelLeftClose,
  close: ActionIcons.dismiss,
  folder: Folder,
  conversation: AppIcons.conversation,
  more: ActionIcons.more,
};

/**
 * WHAT EACH MARK DOES UNDER THE POINTER is the glyph's own business.
 *
 * Every gesture is declared once, on the glyph, in icons.tsx
 * (docs/design/ICONS_AND_MOTION.md §1.3), and played by globals.css
 * (`svg.icon[data-motion]`) when the row around the mark is hovered or
 * keyboard-focused — never under `prefers-reduced-motion`. This file does not
 * assign gestures: a destination that moved here but sat still in the command
 * palette, the product switch or a page would be one registry mark behaving
 * two ways. So the plus turns (New), the gear turns (Settings, Customize), the
 * search glass tilts, the dismiss X turns and the library and artifact stacks
 * lift because THAT is what those glyphs do everywhere; the destinations whose
 * glyphs icons.tsx leaves still (Research, Assistants, Connections, Code,
 * Design, Automations, Permissions and the rest) stay still here too, as the
 * `.sidebar-motion-icon` note in globals.css settled.
 *
 * The only thing this table does is SILENCE a default that is wrong in the
 * sidebar:
 *
 *   folder, projects  their gesture is the closed → open cross-fade below, a
 *                     state change the label cannot say; the folder glyph's
 *                     default lift on top of it would be two gestures at once.
 *   panel toggle      its effect is the whole column moving.
 *   more              the overflow dots open a menu; they are not a place.
 *   conversation      a DOCUMENT, not a destination (PREMIUM_AUDIT.md rule 4).
 */
const SILENT: Partial<Record<SidebarMotionIconKind, "none">> = {
  projects: "none",
  folder: "none",
  "panel-open": "none",
  "panel-close": "none",
  conversation: "none",
  more: "none",
};

/** The kinds whose gesture is a folder opening rather than a transform. Two
 *  glyphs are stacked and cross-fade on the row's hover (`.sidebar-motion-icon`
 *  in globals.css), so the shape reads as one folder changing state rather
 *  than as two icons swapping. */
const OPENS_ON_HOVER: ReadonlySet<SidebarMotionIconKind> = new Set(["folder", "projects"]);

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
  const opens = OPENS_ON_HOVER.has(kind);
  // The size lands on the <svg> itself, not only on the wrapper: icons.tsx
  // chooses the optical cut (the regular line, or the heavier drawing at 12px
  // and under) from the size class ON the glyph, so a glyph sized only through
  // its parent would be drawn for the wrong size.
  const glyphCls = cn("sidebar-motion-icon__glyph", DEFAULT_GLYPH_SIZE, className);

  return (
    <span
      aria-hidden="true"
      className={cn("sidebar-motion-icon", `sidebar-motion-icon--${kind}`, DEFAULT_GLYPH_SIZE, className)}
    >
      <Icon focusable="false" motion={SILENT[kind]} className={glyphCls} />

      {opens ? (
        <FolderOpen
          focusable="false"
          motion="none"
          className={cn(glyphCls, "sidebar-motion-icon__glyph--alternate absolute inset-0")}
        />
      ) : null}
    </span>
  );
}
