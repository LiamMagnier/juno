/**
 * Canonical destination icons for the whole app shell.
 *
 * Menus, the command palette, the sidebar, chips, and empty states should all
 * import from here so a mark never drifts (e.g. projects as Box in one place
 * and Folder in another). Sidebar hover choreography still lives in
 * SidebarMotionIcon — this module is the shared resting glyph set.
 */
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  Cloud,
  Code2,
  FileText,
  FileUp,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  ImagePlus,
  Laptop,
  Layers3,
  LayoutTemplate,
  Library,
  Lock,
  MessageCircle,
  NotebookPen,
  Paperclip,
  PenTool,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Telescope,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const AppIcons = {
  /** Home — the assistant surface, whose default landing is `/chat`.
   *
   *  A speech bubble, not a house. `Home` was a building: it named the ROUTE
   *  ("the place you start") rather than the thing the mode actually is, so the
   *  product's primary surface wore the mark of a dashboard. It also put the
   *  switcher's three glyphs in three different metaphor classes at once —
   *  architecture, object, notation — which is why they never read as a set.
   *
   *  The SAME bubble the conversation rows use (`conversation`, below), not a
   *  second drawing of the same idea. A squared variant was tried first for
   *  silhouette-matching with `work`; it meant the switcher said "chat" with one
   *  glyph while the list under it said "chat" with another, three pixels apart.
   *  Matching the thing it navigates to beats matching the thing beside it. */
  home: MessageCircle,
  /** Juno Work — tasks Juno carries out on your Mac or in the cloud.
   *
   *  A bolt. Two glyphs were tried and rejected first: a briefcase (luggage —
   *  it says *employment*, and at 14px it is a filled rectangle with a notch),
   *  and a kanban square (accurate about "tasks at stages", but a board is a
   *  place you administer work rather than the work happening).
   *
   *  The bolt is chosen for the pair it makes rather than for itself. Work now
   *  sits directly beside Chat in one control, and the distinction that control
   *  draws is not chat-versus-tasks, it is TALK versus ACT: a speech bubble is
   *  you asking, a bolt is it going and doing. Two marks, one sentence.
   *
   *  It also survives the size this is actually read at — a single unbroken
   *  stroke with no interior detail to lose at 14px, which is where both
   *  rejected glyphs failed. */
  work: Zap,
  code: Code2,
  /** Juno Design — the visual design surface. A pen nib rather than a paint
   *  brush or a square: the mode is about drawing something precise that
   *  becomes real, and the brush reads as illustration. */
  design: PenTool,
  library: Library,
  /** The Research surface (`/research`). The SAME telescope the composer's
   *  Deep research tool draws (`ComposerIcons.research`) — the destination is
   *  where that tool's runs live, so two drawings would read as two features. */
  research: Telescope,
  artifacts: Layers3,
  projects: Folder,
  tasks: CalendarClock,
  connections: Plug,
  pulls: GitPullRequest,
  conversation: MessageCircle,
  new: Plus,
  search: Search,
  /** The web reaches Settings from the user menu rather than the rail, and draws
   *  it with this same mark (`user-menu.tsx`). It lives here because the native
   *  apps *do* give it a sidebar row, and without an entry the generator had
   *  nothing to emit — so that row fell back to SF Symbols' `gearshape`, the one
   *  non-Lucide glyph in an otherwise Lucide column. */
  settings: Settings,
} as const satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof AppIcons;

/**
 * The marks Juno Code uses for the things it talks about, as opposed to the
 * places you can go.
 *
 * Split from `AppIcons` because the two answer different questions — that one
 * is "which destination is this", this one is "what kind of thing is this" —
 * but they are one vocabulary and are generated into the native apps together
 * by `scripts/generate-native-icons.mjs`. Everything here is already in use
 * somewhere under `/code` on the web; nothing was invented for the native
 * apps, which is the whole point. A concept the website draws with no icon at
 * all (a diff, a checkpoint, the thinking state) is deliberately absent rather
 * than given one here — inventing a mark for native only is drift with extra
 * steps.
 */
export const CodeIcons = {
  /** A cloud run: a fresh machine, ending in a pull request. */
  cloud: Cloud,
  /** A run on a real computer — this Mac, or one signed in to Juno Code. */
  device: Laptop,
  /** A repository, its default branch, and the base ref of a run. The website
   *  uses one mark for all three; native does too rather than inventing two. */
  branch: GitBranch,
  /** A private repository. */
  lock: Lock,
  /** Juno Code asking permission before it does something. */
  permission: ShieldAlert,
  /** A pinned session or project. The API field is `starred` and the section
   *  header says "Pinned", but the mark has always been a pin — never a star. */
  pin: Pin,
  /** A failure the reader can act on: a dead connector, an unreachable list. */
  error: AlertCircle,
  /** Retry, refresh, reload. Spins while it works. */
  refresh: RefreshCw,
  /** Leaves Juno — a pull request on GitHub, a file in Finder. */
  external: ArrowUpRight,
  /** A file: an attachment chip, a changed file in a run. */
  file: FileText,
} as const satisfies Record<string, LucideIcon>;

export type CodeIconName = keyof typeof CodeIcons;

/**
 * The marks the composer's "+" menu uses for the things you can add to a
 * message and the tools you can arm on it.
 *
 * A third group rather than more entries in `AppIcons`, because these answer a
 * third question. That one is "which destination is this" and `CodeIcons` is
 * "what kind of thing is this"; this is "what will this do to the message I am
 * about to send". Filing `Telescope` under destinations would make the name
 * lie.
 *
 * Every one of these is already drawn by `src/components/chat/composer.tsx` —
 * they are here so the same drawing reaches the apps, which had been
 * approximating each with the nearest SF Symbol (`binoculars` for Deep
 * research, `powerplug` for Connectors, `brain.head.profile` for Memory). The
 * apps' own menus are the only place a reader sees these marks, so a near-miss
 * there reads as a different product rather than as a different platform.
 */
export const ComposerIcons = {
  /** The parent "Attach" row, over Photos and Files. */
  attach: Paperclip,
  /** Add an image. Distinct from `file` — the web draws a picture with a plus. */
  photos: ImagePlus,
  /** Add a document. A page with an up arrow, not a paperclip: the paperclip
   *  belongs to the parent row and reusing it made the two indistinguishable. */
  files: FileUp,
  /** Start a canvas from the composer. */
  canvas: SquarePen,
  /** Deep research. A telescope, never binoculars. */
  research: Telescope,
  /** Web search — Lucide's globe, which is a different drawing from SF's. */
  web: Globe,
  /** The canvas-and-artifacts tool. */
  artifactsTool: LayoutTemplate,
  /** Memory: what Juno keeps about you between conversations. */
  memory: NotebookPen,
} as const satisfies Record<string, LucideIcon>;

export type ComposerIconName = keyof typeof ComposerIcons;
