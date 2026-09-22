import {
  Folder,
  FolderOpen,
  PanelLeft,
  PanelLeftClose,
  type IconComponent,
  type IconMotion,
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
 * destination two ways. This file adds exactly one thing the registry does not
 * know: WHAT EACH MARK DOES UNDER THE POINTER.
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
 * ONE GESTURE PER DESTINATION, and each one says something about the place.
 *
 * Played by `globals.css` (`svg.icon[data-motion]`) when the row around the
 * mark — a link or a button — is hovered or keyboard-focused, on the same
 * spring every other glyph in the product settles on, and never under
 * `prefers-reduced-motion`. The vocabulary is `IconMotion` in icons.tsx; this
 * table only chooses from it, so the sidebar cannot invent a gesture the rest
 * of the product does not already make.
 *
 * The reference is Claude's panel: the plus turns, the gear turns, the search
 * glass tilts, the folder opens. A row already says where it goes in words, so
 * a gesture earns its place only by saying what KIND of place it is:
 *
 *   turn   New — one more of something; Close — the same plus, dismissing.
 *   tilt   a tool you pick up: the search glass, the telescope, the pieces of
 *          a design, the chat and code marks of the product switch, an
 *          assistant's head.
 *   lift   an object taken off the shelf: a book, a stack of artifacts, a
 *          written skill, a calendar page, a pull request.
 *   pop    a mark that is SET: a granted permission, a trigger that fires.
 *   spin   configuration: the gear.
 *   nudge  the plug pushes toward its socket, because connecting is what the
 *          page does (Phosphor draws the prongs up and to the right).
 *
 * Three marks stay still on purpose: the overflow dots (More opens a menu, it
 * is not a place), the panel toggle (its effect is the whole column moving,
 * which is gesture enough) and a conversation's bubble, which marks a
 * DOCUMENT rather than a destination (docs/design/PREMIUM_AUDIT.md rule 4).
 *
 * Projects and folders make no transform at all — their gesture is the
 * closed → open cross-fade below, which is a state change the label cannot
 * say, and a folder that also lifted would be making two gestures at once.
 */
const MOTION: Record<SidebarMotionIconKind, IconMotion | "none"> = {
  new: "turn",
  home: "tilt",
  code: "tilt",
  design: "tilt",
  library: "lift",
  research: "tilt",
  artifacts: "lift",
  connections: "nudge-ne",
  projects: "none",
  assistants: "tilt",
  tasks: "lift",
  skills: "lift",
  automations: "pop",
  permissions: "pop",
  pulls: "lift",
  settings: "spin",
  search: "tilt",
  "panel-open": "none",
  "panel-close": "none",
  close: "turn",
  folder: "none",
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
      <Icon focusable="false" motion={MOTION[kind]} className={glyphCls} />

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
