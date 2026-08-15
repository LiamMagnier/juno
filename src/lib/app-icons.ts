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
  BadgeCheck,
  CalendarClock,
  Check,
  Copy,
  Download,
  Circle,
  Cloud,
  Code2,
  Component,
  FileText,
  FileUp,
  Folder,
  Frame,
  GitBranch,
  GitPullRequest,
  Globe,
  Group,
  Image as ImageIcon,
  ImagePlus,
  Laptop,
  Layers3,
  LayoutTemplate,
  Library,
  Lock,
  Info,
  MessageCircle,
  Minus,
  MoreHorizontal,
  NotebookPen,
  Paperclip,
  Pencil,
  PenTool,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  SquareDashed,
  SquarePen,
  Telescope,
  Trash2,
  TriangleAlert,
  Type,
  X,
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
  /** Deep research, wherever the shell has to name it — the command palette,
   *  a native sidebar row, an empty state. The SAME telescope the composer's
   *  Deep research tool draws (`ComposerIcons.research`): one feature, one
   *  drawing. There is no longer a `/research` page behind it — a run is read
   *  in the conversation that asked for it — but the concept is still named in
   *  the shell and in the native apps, which generate their glyph from here. */
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

/**
 * The marks Juno Design uses for the kinds of thing on a canvas.
 *
 * A fourth group, for the same reason the others are separate: this answers
 * "what kind of layer is this". It exists because the layers panel had been
 * drawing them with Unicode box-drawing characters — `▣ ▢ ◈ ◇ ▭ ◯ ╱ ✎ ▤` — in a
 * file that already imported a dozen Lucide icons. Two icon systems in one
 * panel is the most visible way a surface reads as assembled rather than
 * designed: box-drawing glyphs are a FONT, so they carry the text colour and
 * the text weight, sit on the text baseline rather than the icon's optical
 * centre, and change shape between platforms because they resolve against
 * whatever fallback font has them. At 12px several of them (`▣` against `▢`,
 * `◈` against `◇`) are the same smudge.
 *
 * `component` and `instance` deliberately keep Figma's relationship — one solid
 * mark and one derived from it — because that is the distinction a person
 * scanning the tree actually needs, and it is the one the old two-diamond pair
 * was least able to make.
 */
export const DesignIcons = {
  frame: Frame,
  group: Group,
  /** A main component: the thing instances are made from. */
  component: Component,
  /** An instance of a component. Dashed, because it is a reference, not a copy. */
  instance: SquareDashed,
  rectangle: Square,
  ellipse: Circle,
  line: Minus,
  /** A vector path. The same nib the Design destination uses. */
  path: PenTool,
  text: Type,
  image: ImageIcon,
} as const satisfies Record<string, LucideIcon>;

export type DesignIconName = keyof typeof DesignIcons;

/**
 * The marks for things that happen TO you, and things you DO — the vocabulary
 * every surface shares.
 *
 * The four groups above answer "which destination", "what kind of thing", "what
 * will this do to my message" and "what kind of layer". This one answers the
 * question that was never written down anywhere, which is why it had drifted
 * furthest: what does a warning look like, what does Edit look like, what does
 * "this leaves Juno" look like.
 *
 * An audit across `src/` found the same concept drawn several ways in different
 * files — five glyphs for "something is wrong", six for "edit", four each for
 * "confirmed", "leaves Juno" and "code". Some of those pairs are literally the
 * same SVG imported under two names (Lucide keeps `AlertTriangle` as an alias of
 * `TriangleAlert`, `CircleAlert` of `AlertCircle`), which looks identical on
 * screen and still matters: it defeats any grep-based audit and guarantees the
 * next divergence. Where a pair was genuinely two drawings, the winner is
 * whichever the product already used most, so adopting this moves the fewest
 * pixels.
 */
export const StatusIcons = {
  /** Something needs attention but nothing is broken. A TRIANGLE, always. */
  warning: TriangleAlert,
  /** Something failed. A CIRCLE, always — the triangle is for warnings, and
   *  `CodeIcons.error` has drawn the circle since Juno Code shipped. */
  error: AlertCircle,
  /** Neutral explanation. Never a triangle, never a circled exclamation. */
  info: Info,
  /** Done, selected, agreed. The bare check — the same mark the dropdown and
   *  select primitives use for a chosen row, so a tick means one thing. */
  success: Check,
  /** Verified BY someone — a claim with an authority behind it, not merely a
   *  finished task. The one case a circled/badged check is right. */
  verified: BadgeCheck,
  /** A security or permission problem, as distinct from a plain failure. */
  security: ShieldAlert,
} as const satisfies Record<string, LucideIcon>;

export type StatusIconName = keyof typeof StatusIcons;

export const ActionIcons = {
  /** Edit or rename, everywhere. A plain pencil: `SquarePen` is composing a NEW
   *  thing (the composer's canvas button), and `PenTool` is the Design mode. */
  edit: Pencil,
  /** Destroy something. Never a bare X — that is dismiss. */
  delete: Trash2,
  /** Close, dismiss, clear a field. Never a trash can. */
  dismiss: X,
  /** Copy to the clipboard. */
  copy: Copy,
  /** Retry, refresh, reload. Spins while it works. Not `RotateCw`, which is
   *  visually near-identical at 14px and was doing this job in two files. */
  refresh: RefreshCw,
  /** Undo or restore a previous state — the anticlockwise arrow, and ONLY this. */
  restore: RotateCcw,
  /** Leaves Juno: a GitHub pull request, a file in Finder, any third-party URL.
   *  Matches `CodeIcons.external`, which is the same idea. */
  external: ArrowUpRight,
  /** Share with someone else. Distinct from `external`, which is "go there". */
  share: Share2,
  /** Download to the machine. */
  download: Download,
  /** The overflow menu on a card or row. HORIZONTAL everywhere: the product was
   *  split roughly evenly between this and `MoreVertical` for the same control
   *  in the same position on different card types. */
  more: MoreHorizontal,
  /** Filter or sort a list. */
  filter: SlidersHorizontal,
  /** Tune a model's parameters — the same sliders, because it is the same idea
   *  of "adjust the knobs", as opposed to `AppIcons.settings`, which is the
   *  application's own preferences. */
  parameters: SlidersHorizontal,
} as const satisfies Record<string, LucideIcon>;

export type ActionIconName = keyof typeof ActionIcons;
