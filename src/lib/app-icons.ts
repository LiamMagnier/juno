/**
 * Canonical icons for the whole app shell — one concept, one drawing.
 *
 * Menus, the command palette, the sidebar, chips, and empty states should all
 * import from here so a mark never drifts (e.g. projects as Box in one place
 * and Folder in another). Every value is a glyph from the one icon set,
 * `@/components/ui/icons` (Phosphor geometry at the house `regular` weight,
 * with the bold cut at 12px and under); the NAMES below are the concepts, and
 * which drawing a concept wears is decided here.
 *
 * Motion is not this module's business: a glyph's single hover articulation is
 * declared in icons.tsx and played by globals.css, and the one sidebar morph
 * (a folder opening) lives in SidebarMotionIcon. This module is the shared
 * resting glyph set.
 *
 * Several notes below record why a concept LEFT a drawing of the previous set
 * (Lucide). They are kept because the reasoning — which metaphor a concept
 * should wear, and which shapes survive 14–18px — outlives any one set.
 */
import {
  AlertCircle,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  CalendarClock,
  Check,
  Clock,
  Code2,
  Cube,
  CreditCard,
  Copy,
  Database,
  Download,
  Circle,
  Cloud,
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
  Lock,
  Mic,
  MessagesSquare,
  Info,
  JunoChat,
  JunoCode,
  JunoDesign,
  JunoLibrary,
  JunoAgents,
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
  ScrollText,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  SlidersHorizontal,
  Square,
  SquareDashed,
  SquarePen,
  Telescope,
  Trash2,
  TriangleAlert,
  Type,
  User,
  UserPen,
  X,
  Workflow,
  type IconComponent,
} from "@/components/ui/icons";
import type { ToolIconKind } from "@/lib/tools/types";

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
   *  Matching the thing it navigates to beats matching the thing beside it.
   *
   *  Juno's own drawing (`JunoChat`, juno-glyphs.tsx): the logo's bubble as a
   *  line — an open ring with the ball terminal in its gap. Its `fill` weight
   *  is the logo itself, the solid bubble with the spark cut out. */
  home: JunoChat,
  /** Juno Work — tasks Juno carries out on your Mac or in the cloud.
   *
   *  A workflow mark: nodes joined by a line, i.e. steps being carried out.
   *  It replaced a lightning bolt, which read as a stock "AI magic" glyph
   *  rather than as a destination. Beside Chat's speech bubble the pair still
   *  says TALK versus ACT, and the drawing survives 14px — three boxes and one
   *  stroke, nothing to lose. */
  work: Workflow,
  /** Juno Code — Juno's own drawing (`JunoCode`): the logo's four-point spark
   *  between two chevrons, where `</>` puts a slash. Code that Juno writes. */
  code: JunoCode,
  /** Juno Design — the visual design surface.
   *
   *  A TRIANGLE, A SQUARE AND A CIRCLE (the set's `Shapes`). This was the
   *  previous set's pen nib, which is a fine drawing at 24px and fell apart at
   *  the two sizes the product actually draws it: 18px in the sidebar and 14px
   *  on an artifact card. That nib was four elements — a body, a
   *  twenty-command bezier outline, a tail stroke and a `circle r="2"` sitting
   *  INSIDE the body — and below about 20px the circle and the two strokes it
   *  sat between merged into one grey lozenge. It was the least legible mark in
   *  the shell and it was on a top-level destination.
   *
   *  It was also the wrong CLASS of thing. A nib is a TOOL, and every other
   *  destination in this list names its contents — a folder of projects, a
   *  shelf of library items, a stack of artifacts, a bubble of conversation.
   *  Three primitives name what a design IS, which is the same reason the
   *  file's first entry gave up the house for a speech bubble.
   *
   *  The nib is not retired: `DesignIcons.path` keeps it for a vector path
   *  layer, where it names a tool because a tool is what it is.
   *
   *  The three primitives became two, in Juno's own drawing (`JunoDesign`): a
   *  square in front of a circle, stacked like cut paper — the circle stops
   *  short of the square instead of crossing it, which is what keeps the mark
   *  quiet at 14px where three overlapping outlines turned into a knot. */
  design: JunoDesign,
  /** Library — the images and documents your conversations have collected.
   *
   *  BOOKS WITH A SPINE, not four tick marks. The previous set's `Library`
   *  was four bare strokes of different heights with the last one tilted; at
   *  the 18px this panel draws it, "a shelf seen from the front" was not what
   *  arrived — what arrived was an equaliser, and beside a folder and a stack
   *  of layers it was the one mark in the column that had to be decoded
   *  rather than read.
   *
   *  The set's `Books` came next: the same idea drawn with CLOSED SHAPES,
   *  which survive the size because an outlined form survives what a bare
   *  hairline does not. But it carried six bands across two volumes, and at
   *  18px each band and each gap is about a pixel, so the spines aliased into
   *  a grey hatch and the leaning volume ran into the upright at the top. It
   *  was the busiest mark in the column, under Juno's own marks drawn in one
   *  or two strokes.
   *
   *  Juno's own drawing (`JunoLibrary`) keeps what carried the meaning and
   *  drops the texture: two volumes, the right one leaning toward the left
   *  with a clear gap at every weight, and ONE head band each. The lean is
   *  what says "books on a shelf" rather than "two boxes"; the extra bands
   *  only said "detail". Under the pointer the leaning volume straightens and
   *  lifts, the way a book comes off a shelf. */
  library: JunoLibrary,
  /** Deep research, wherever the shell has to name it — the command palette,
   *  a native sidebar row, an empty state. The SAME mark the composer's Deep
   *  research tool draws (`ComposerIcons.research`): one feature, one drawing.
   *  The export is still called `Telescope`, and the drawing under it is the
   *  set's binoculars — the set has no telescope, and "looking far, widely"
   *  is the idea either one carries. There is no longer a `/research` page
   *  behind it — a run is read in the conversation that asked for it — but
   *  the concept is still named in the shell and in the native apps. */
  research: Telescope,
  artifacts: Layers3,
  projects: Folder,
  assistants: Bot,
  /** Agents — Juno's own drawing (`JunoAgents`): a face, the pebble body and
   *  rounded-square eyes every agent is drawn with, so the destination wears
   *  the same mark as the teammates it holds. Not `Bot`: that is Assistants'
   *  robot, a persona you talk to; an agent is someone you delegate to, and
   *  giving the two one glyph would say they are one thing. */
  agents: JunoAgents,
  tasks: CalendarClock,
  connections: Plug,
  pulls: GitPullRequest,
  conversation: JunoChat,
  new: Plus,
  search: Search,
  /** The web reaches Settings from the user menu rather than the rail, and draws
   *  it with this same mark (`user-menu.tsx`) — a six-toothed gear that turns
   *  a little under the pointer. It lives here because the native apps *do*
   *  give it a sidebar row, and without an entry the generator had nothing to
   *  emit — so that row fell back to SF Symbols' `gearshape`, the one mark in
   *  its column drawn from a different family. */
  settings: Settings,
  /** Skills — reusable instructions with a name.
   *
   *  A written sheet, not a mortarboard and not a robot: a skill is a document
   *  the reader wrote (or reviewed) and hands over, and the two obvious
   *  alternatives both say something false about it. `Bot` is already
   *  Assistants and sits three rows away in the same menu, and a graduation cap
   *  would say Juno LEARNED this, which is exactly the thing skills are not —
   *  they are instructions, reviewed and trusted by a person, not training. */
  skills: ScrollText,
  /** Automations — everything that starts without the reader typing.
   *
   *  The SAME workflow mark as `work` above and `ComposerIcons.task`, on the
   *  argument this file has already made twice: one feature, one drawing. An
   *  automation IS a delegated task, started by a clock or an event instead of
   *  by a press, and giving it a second glyph would make the thing that starts
   *  a run and the run it starts look like two different products. `tasks`
   *  keeps its calendar because legacy scheduled prompts are a different,
   *  older thing that lives on its own page. */
  automations: Workflow,
  /** Permissions — what Juno may do on your behalf, and on which Mac.
   *
   *  A shield with a CHECK. `ShieldAlert`, three lines up in `CodeIcons`, is
   *  the moment Juno stops to ask and is drawn in warning tone; this is the
   *  standing answer to that question and a destination you visit when nothing
   *  is wrong. The same mark in two tones would read as "something needs your
   *  attention" on a row that is simply where the settings live. */
  permissions: ShieldCheck,
} as const satisfies Record<string, IconComponent>;

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
} as const satisfies Record<string, IconComponent>;

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
  /** Deep research. The `Telescope` export — drawn as the set's binoculars,
   *  since the set has no telescope (see `AppIcons.research`). Never a
   *  sparkle: a sparkle names no action. */
  research: Telescope,
  /** Run this message as a delegated task.
   *
   *  The SAME workflow mark `AppIcons.work` carries, on the same argument the
   *  telescope above is kept in both groups: one feature, one drawing. Work is
   *  no longer a place you navigate to — a run lives in the conversation that
   *  asked for it — but the concept is still named in the shell and in the
   *  native apps, and a second glyph for it here would make the composer's
   *  toggle and the run it starts look like two different things. */
  task: Workflow,
  /** Web search — the set's simple globe (a meridian and an equator), which
   *  is a different drawing from SF's. */
  web: Globe,
  /** The canvas-and-artifacts tool. */
  artifactsTool: LayoutTemplate,
  /** Memory: what Juno keeps about you between conversations. */
  memory: NotebookPen,
} as const satisfies Record<string, IconComponent>;

export type ComposerIconName = keyof typeof ComposerIcons;

/**
 * The marks Juno Design uses for the kinds of thing on a canvas.
 *
 * A fourth group, for the same reason the others are separate: this answers
 * "what kind of layer is this". It exists because the layers panel had been
 * drawing them with Unicode box-drawing characters — `▣ ▢ ◈ ◇ ▭ ◯ ╱ ✎ ▤` — in a
 * file that already imported a dozen glyphs from the icon set. Two icon systems in one
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
  /** A vector path. The pen nib — a TOOL naming the one layer kind that is
   *  made with it. The Design destination used to draw a nib and now draws
   *  `JunoDesign`: the mode is not a tool, and at 18px the old nib's inner circle
   *  closed up (see `AppIcons.design`). At the 12px this tree sets its rows in,
   *  the nib reads — the set switches to its bold cut at that size, which
   *  keeps the slit open — and it is the only mark in the panel with a
   *  diagonal, with the label right beside it. */
  path: PenTool,
  text: Type,
  image: ImageIcon,
} as const satisfies Record<string, IconComponent>;

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
 * same SVG imported under two names (the previous set kept `AlertTriangle` as an
 * alias of `TriangleAlert`, `CircleAlert` of `AlertCircle`), which looks
 * identical on screen and still matters: it defeats any grep-based audit and
 * guarantees the next divergence. The current set keeps those alias names so
 * old call sites compile — `AlertTriangle` and `TriangleAlert` are still one
 * drawing — which is exactly why a concept, not an export name, is what gets
 * imported. Where a pair was genuinely two drawings, the winner is
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
} as const satisfies Record<string, IconComponent>;

export type StatusIconName = keyof typeof StatusIcons;

export const ActionIcons = {
  /** Edit or rename, everywhere. A plain pencil: `SquarePen` is composing a NEW
   *  thing (the composer's canvas button), and `PenTool` is the Design
   *  editor's vector-path tool (`DesignIcons.path`). */
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
} as const satisfies Record<string, IconComponent>;

export type ActionIconName = keyof typeof ActionIcons;

/**
 * The marks for the settings sections.
 *
 * This group exists because the settings rail was the one place in the product
 * still wearing AI-marketing iconography: Personalization was a SPARKLE and
 * Models was a MAGIC WAND. Neither describes anything. A sparkle is the
 * industry's shorthand for "something happens here and we would rather not say
 * what", and a wand says the product is doing a trick rather than running a
 * model you chose and pay for. They are also the two marks in the whole app
 * that could be swapped for each other without changing what either means,
 * which is the test that fails.
 *
 * Every mark here names the NOUN of its section — the thing you are editing —
 * rather than a feeling about it. `personalization` is a person with a gear
 * because it is Juno adjusted to you (the export is still `UserPen`; the set
 * has no person-and-pen); `models` is a cube because a model is a thing you
 * pick off a shelf and pay for per token, and the section is about which one
 * runs.
 */
export const SettingsIcons = {
  /** Adjustments to how the app itself looks and behaves. */
  general: SlidersHorizontal,
  /** How Juno writes for YOU: your instructions, your tone. Not a sparkle. */
  personalization: UserPen,
  /** What Juno keeps between conversations — the same notebook the composer's
   *  memory toggle uses, because it is the same store. */
  memory: NotebookPen,
  /** Which model answers, and how hard it thinks. Not a wand, and no longer a
   *  processor.
   *
   *  A CUBE: the set's three-faced box, a model drawn as an OBJECT, the
   *  packaged thing you choose, so it names the NOUN like the rest of this
   *  rail. The processor it replaced said the same thing less well. It is a
   *  square inside a square with eight pins, and at the rail's 16px the pins
   *  merged into a fringe, the densest mark in a column of calm ones (sliders,
   *  a plug, a mic, a cylinder). It also named the hardware, which Juno's
   *  reader never picks. The cube is one outline and a Y, reads at 14px, and
   *  cannot be mistaken for `data`'s cylinder or `Bot`, which is Assistants.
   *  Not a brain or an atom either: both are the same AI-marketing shorthand
   *  the sparkle and the wand were removed for, and both hatch at 16px. */
  models: Cube,
  /** The apps Juno may reach. Matches `AppIcons.connections`. */
  connectors: Plug,
  /** Speech, in and out. */
  voice: Mic,
  /** Your data: export, import, deletion. */
  data: Database,
  /** Who you are to Juno. */
  account: User,
  /** What you pay. */
  billing: CreditCard,
} as const satisfies Record<string, IconComponent>;

export type SettingsIconName = keyof typeof SettingsIcons;

/**
 * The marks of the run UI's tool rows (SPEC §7.1), one per `ToolIconKind`
 * (§3.1): the tool registry names a KIND, never a drawing, and this is where
 * the kind gets its glyph, so a tool row in the transcript, the Activity panel
 * and Research wears the same mark ("registries come first", design system
 * §7.1).
 *
 * Reused concepts, not new drawings: `search` is the composer's search glyph,
 * `research` the Research binoculars, `connector` the plug every connections
 * surface uses, `task` Work's workflow mark (a task IS a Work session).
 * `calculator` is a sigma: the set has no calculator, and a sigma reads as
 * "a computed value" at 14px where a keypad would hatch.
 */
export const ToolIcons = {
  search: Search,
  globe: Globe,
  document: FileText,
  image: ImageIcon,
  code: Code2,
  chats: MessagesSquare,
  clock: Clock,
  calculator: Sigma,
  task: Workflow,
  research: Telescope,
  connector: Plug,
} as const satisfies Record<ToolIconKind, IconComponent>;
