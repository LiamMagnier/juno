/**
 * Juno's icon set. The ONLY module in the web app that may import a glyph
 * library — every component, page, menu and dialog draws its icons from here.
 *
 * WHY ONE FILE. The previous set was Lucide imported directly at 176 call
 * sites, with a CSS stroke ladder (`svg.lucide.size-4 { stroke-width: 2.25 }`)
 * trying to hold one optical weight across sizes. It could not: a glyph sized by
 * its parent never matched the ladder, hand-drawn SVGs sat beside Lucide marks
 * at different weights, and three components passed their own `strokeWidth`.
 * The result was the thing a reader notices without being able to name — a
 * column of icons that are nearly, but not quite, the same weight.
 *
 * THE GEOMETRY. Every glyph is drawn on Phosphor's 256-unit grid (MIT), whose
 * weights are separate drawings rather than one path with a thicker stroke, so
 * corners, counters and terminals stay designed at every weight. The house
 * weight is `regular` — a 16-unit line, i.e. 1px at 16px and 1.25px at 20px,
 * the same light, even line Claude and ChatGPT draw their chrome with.
 *
 * OPTICAL SIZING. Below ~14px a 1px line starts to disappear, so glyphs at 12px
 * and under draw the `bold` cut (1.125px at 12px). That is decided here from the
 * size the call site asks for, so a call site never picks a weight to fix a
 * size problem.
 *
 * OWNING THE SET. Names are Juno's, not the upstream library's. They keep the
 * spellings the codebase already used (`ChevronDown`, `Loader2`, `Settings`) so
 * the migration touched imports, not call sites. Replacing any mark with a
 * bespoke Juno drawing — on the same 256 grid, 16-unit line, round caps — is a
 * one-line change in this file and reaches every surface at once. Five marks
 * already are Juno's own (`juno-glyphs.tsx`): `JunoChat`, `JunoCode`,
 * `JunoDesign`, `JunoLibrary` and `Send`, the places and the verb the product
 * is known by.
 *
 * MOTION. Each glyph can carry one hover articulation (`data-motion`), played
 * by `globals.css` when the interactive element around it is hovered or
 * focused: arrows nudge the way they point, a plus turns, a gear turns, a pen
 * tilts. The vocabulary is small on purpose and every entry says something
 * about the action (see `IconMotion`). State indicators — carets, spinners,
 * status marks — carry none.
 *
 * Server-component safe: built on the SSR entry, no context, no hooks.
 */
import type { ComponentPropsWithoutRef, ComponentType, JSX, Ref } from "react";

import type { IconProps as PhosphorIconProps, IconWeight } from "@phosphor-icons/react/dist/lib/types";
import {
  AlignBottomIcon,
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  ArchiveIcon,
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowDownRightIcon,
  ArrowLeftIcon,
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowsInSimpleIcon,
  ArrowsOutLineHorizontalIcon,
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  ArrowsOutSimpleIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowUDownLeftIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  BellSimpleIcon,
  BrainIcon,
  BinocularsIcon,
  BookmarkSimpleIcon,
  BookOpenIcon,
  BoundingBoxIcon,
  BoxArrowUpIcon,
  BracketsCurlyIcon,
  BriefcaseIcon,
  BroadcastIcon,
  CalendarDotsIcon,
  CameraIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  ChatCenteredDotsIcon,
  ChatCircleDotsIcon,
  ChatCircleIcon,
  ChatIcon,
  ChatsIcon,
  ChatTextIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CodeIcon,
  CoinsIcon,
  ColumnsIcon,
  ConfettiIcon,
  CopyIcon,
  CpuIcon,
  CreditCardIcon,
  CropIcon,
  CrosshairIcon,
  CubeIcon,
  CursorIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  DiamondsFourIcon,
  DotsSixVerticalIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  EraserIcon,
  EyeIcon,
  EyeSlashIcon,
  FileArrowUpIcon,
  FileCodeIcon,
  FileMagnifyingGlassIcon,
  FileTextIcon,
  FileXlsIcon,
  FilmStripIcon,
  FingerprintIcon,
  FireIcon,
  FloppyDiskIcon,
  FolderIcon,
  FolderLockIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  FolderSimplePlusIcon,
  FrameCornersIcon,
  GearSixIcon,
  GitBranchIcon,
  GitDiffIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobeSimpleIcon,
  GraduationCapIcon,
  HandIcon,
  ImageBrokenIcon,
  ImageIcon as PhImageIcon,
  ImageSquareIcon,
  InfoIcon,
  KanbanIcon,
  KeyboardIcon,
  KeyIcon,
  LaptopIcon,
  LayoutIcon,
  LightningIcon,
  LineSegmentIcon,
  LinkSimpleBreakIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListDashesIcon,
  ListIcon,
  ListMagnifyingGlassIcon,
  ListPlusIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MagnifyingGlassIcon,
  MapTrifoldIcon,
  MegaphoneIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MinusIcon,
  MonitorArrowUpIcon,
  MonitorIcon,
  MoonIcon,
  MusicNotesIcon,
  NotePencilIcon,
  PackageIcon,
  PaperclipIcon,
  PauseCircleIcon,
  PauseIcon,
  PencilSimpleIcon,
  PencilSimpleLineIcon,
  PenNibIcon,
  PhoneDisconnectIcon,
  PlayCircleIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PresentationIcon,
  PrinterIcon,
  ProhibitIcon,
  ProhibitInsetIcon,
  PulseIcon,
  PushPinIcon,
  PushPinSlashIcon,
  QuestionIcon,
  QuotesIcon,
  ReceiptIcon,
  RepeatIcon,
  RobotIcon,
  ScanIcon,
  ScreencastIcon,
  ScrollIcon,
  SealCheckIcon,
  SelectionIcon,
  ShapesIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  ShieldSlashIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
  SigmaIcon,
  SignOutIcon,
  SkipBackIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SpeakerHighIcon,
  SquareIcon,
  SquaresFourIcon,
  StackIcon,
  StackSimpleIcon,
  StarIcon,
  StopCircleIcon,
  SunIcon,
  TableIcon,
  TargetIcon,
  TerminalWindowIcon,
  TextTIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TimerIcon,
  TrashIcon,
  TrayIcon,
  TreeStructureIcon,
  UploadSimpleIcon,
  UserGearIcon,
  UserIcon,
  UsersIcon,
  VideoCameraIcon,
  WarningCircleIcon,
  WarningIcon,
  WaveformIcon,
  WifiSlashIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import {
  JunoChatGlyph,
  JunoCodeGlyph,
  JunoDesignGlyph,
  JunoLibraryGlyph,
  JunoAgentsGlyph,
  JunoSendGlyph,
} from "@/components/ui/juno-glyphs";
import { cn } from "@/lib/utils";

/**
 * The hover articulations `globals.css` knows how to play. Each one names what
 * the action DOES, which is the only reason a glyph is allowed to move:
 *
 * - `nudge-r` / `nudge-l` / `nudge-u` / `nudge-d` / `nudge-ne` — the glyph
 *   points somewhere and the action goes there (forward, back, upload,
 *   download, out of Juno).
 * - `turn` — a quarter turn on a spring: plus (make one more), close.
 * - `spin` — a gear or a sun turning: configuration, appearance.
 * - `cw` / `ccw` — half a turn in the arrow's own direction: refresh, undo.
 * - `tilt` — a tool picked up: pen, magnifier, pin, microphone, wrench.
 * - `lift` — an object picked up off the page: copy, archive, trash, a stack.
 * - `pop` — a small spring swell for marks you set: star, sparkle, bookmark.
 * - `parts` — Juno's own marks move one PART of the drawing instead of the
 *   whole glyph: Chat's ball terminal pops out of the gap, Code's spark
 *   twinkles, Design's circle slides back from the square, Library's leaning
 *   volume straightens and lifts off the shelf.
 */
export type IconMotion =
  | "nudge-r"
  | "nudge-l"
  | "nudge-u"
  | "nudge-d"
  | "nudge-ne"
  | "turn"
  | "spin"
  | "cw"
  | "ccw"
  | "tilt"
  | "lift"
  | "pop"
  | "parts";

export type { IconWeight };

export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "fill" | "strokeWidth"> & {
  ref?: Ref<SVGSVGElement>;
  /** Pixel size of the box. Defaults to 24 so an unsized glyph keeps the box
   *  the previous set gave it; `size-*` / `h-*` classes override it. */
  size?: number | string;
  /** Overrides the optical choice. `fill` is the selected / "on" drawing. */
  weight?: IconWeight;
  /** Kept for call sites written against the previous set: ≥ 2.5 asks for the
   *  heavier cut, ≤ 1.25 for the lighter one. The line itself is never
   *  stretched — a thicker stroke on a filled outline would blunt the drawing. */
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  /** `fill="currentColor"` asked the previous set for a solid shape; any
   *  non-`none` value selects the `fill` weight. */
  fill?: string;
  /** Overrides the glyph's default hover articulation. `"none"` turns it off. */
  motion?: IconMotion | "none";
  mirrored?: boolean;
  alt?: string;
};

/** The type of anything this module exports. Use it wherever a component
 *  takes an icon as a prop (`icon: IconComponent`). */
export type IconComponent = ((props: IconProps) => JSX.Element) & { displayName?: string };

const SMALL_BOX = /(?:^|\s)(?:size|h)-(?:2|2\.5|3)(?=\s|$)/;
const FILLED = /(?:^|\s)(?:[\w-]+:)*fill-(?!none(?:\s|$))[a-z]/;
const HEAVY_STROKE = /(?:^|\s)stroke-\[(?:2\.[5-9]|[3-9])/;

function toNumber(value: number | string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function opticalWeight({
  className,
  size,
  strokeWidth,
  fill,
}: Pick<IconProps, "className" | "size" | "strokeWidth" | "fill">): IconWeight {
  if ((fill && fill !== "none" && fill !== "transparent") || (className && FILLED.test(className))) {
    return "fill";
  }
  const stroke = toNumber(strokeWidth);
  if ((stroke != null && stroke >= 2.5) || (className && HEAVY_STROKE.test(className))) return "bold";
  if (stroke != null && stroke <= 1.25) return "light";
  const px = typeof size === "number" ? size : undefined;
  if (px != null && px <= 13) return "bold";
  if (className && SMALL_BOX.test(className)) return "bold";
  return "regular";
}

/** Anything drawn on the 256 grid with Phosphor's prop shape: a Phosphor icon,
 *  or one of Juno's own drawings in `juno-glyphs.tsx`. */
type GlyphBase = ComponentType<PhosphorIconProps>;

function glyph(
  Base: GlyphBase,
  name: string,
  defaults: { motion?: IconMotion; mirrored?: boolean } = {},
): IconComponent {
  function JunoIcon({
    className,
    size = 24,
    weight,
    strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    fill,
    motion,
    mirrored,
    ...rest
  }: IconProps) {
    const labelled = rest["aria-label"] != null || rest["aria-labelledby"] != null || rest.alt != null;
    const articulation = motion === "none" ? undefined : (motion ?? defaults.motion);
    return (
      <Base
        size={size}
        weight={weight ?? opticalWeight({ className, size, strokeWidth, fill })}
        mirrored={mirrored ?? defaults.mirrored}
        aria-hidden={labelled ? undefined : true}
        role={labelled ? "img" : undefined}
        focusable="false"
        data-icon={name}
        data-motion={articulation}
        className={cn("icon", className)}
        {...rest}
      />
    );
  }
  JunoIcon.displayName = name;
  return JunoIcon;
}

// ---------------------------------------------------------------------------
// Juno's own marks — the places the product is known by. Drawn for Juno in
// juno-glyphs.tsx on the same grid and line as the rest of the set; Chat, Code
// and Design carry the two motifs of the logo (the open ring with its ball
// terminal, and the four-point spark). `Send` below is the verb.
// ---------------------------------------------------------------------------

/** Chat: the logo's bubble as a line. Its `fill` weight is the logo itself —
 *  the solid bubble with the spark cut out — for the selected state. */
export const JunoChat = glyph(JunoChatGlyph, "juno-chat", { motion: "parts" });
/** Code: the spark between two chevrons, where `</>` puts a slash. */
export const JunoCode = glyph(JunoCodeGlyph, "juno-code", { motion: "parts" });
/** Design: a square in front of a circle, stacked like cut paper. */
export const JunoDesign = glyph(JunoDesignGlyph, "juno-design", { motion: "parts" });
/** Library: two volumes on a shelf, the right one leaning toward the left, one
 *  band each. It replaced Phosphor's Books, whose six bands hatched into grey
 *  at 18px. Under the pointer the leaning volume straightens and lifts, the
 *  way a book comes off a shelf. */
export const JunoLibrary = glyph(JunoLibraryGlyph, "juno-library", { motion: "parts" });
/** Agents: a face whose eyes glance up and over on hover (docs/design/AGENTS.md). */
export const JunoAgents = glyph(JunoAgentsGlyph, "juno-agents", { motion: "parts" });

// ---------------------------------------------------------------------------
// Direction & navigation
// ---------------------------------------------------------------------------

/** Carets are state indicators (open / closed, sort order) and never move on
 *  hover — a disclosure that twitches before it is pressed says it did
 *  something it has not done. Their rotation belongs to the call site. */
export const ChevronDown = glyph(CaretDownIcon, "chevron-down");
export const ChevronUp = glyph(CaretUpIcon, "chevron-up");
export const ChevronLeft = glyph(CaretLeftIcon, "chevron-left");
export const ChevronRight = glyph(CaretRightIcon, "chevron-right");
/** Both ways at once: a row that opens a menu (the sidebar's account row)
 *  without claiming which direction it opens in. Still a state mark, so it
 *  carries no hover gesture either. */
export const ChevronsUpDown = glyph(CaretUpDownIcon, "chevrons-up-down");

export const ArrowLeft = glyph(ArrowLeftIcon, "arrow-left", { motion: "nudge-l" });
export const ArrowRight = glyph(ArrowRightIcon, "arrow-right", { motion: "nudge-r" });
export const ArrowUp = glyph(ArrowUpIcon, "arrow-up", { motion: "nudge-u" });
export const ArrowDown = glyph(ArrowDownIcon, "arrow-down", { motion: "nudge-d" });
export const ArrowUpRight = glyph(ArrowUpRightIcon, "arrow-up-right", { motion: "nudge-ne" });
export const ArrowUpToLine = glyph(ArrowLineUpIcon, "arrow-up-to-line", { motion: "nudge-u" });
export const ArrowDownToLine = glyph(ArrowLineDownIcon, "arrow-down-to-line", { motion: "nudge-d" });
export const CornerDownRight = glyph(ArrowElbowDownRightIcon, "corner-down-right", { motion: "nudge-r" });
export const ExternalLink = glyph(ArrowSquareOutIcon, "external-link", { motion: "nudge-ne" });
export const LogOut = glyph(SignOutIcon, "log-out", { motion: "nudge-r" });
export const Undo2 = glyph(ArrowUUpLeftIcon, "undo", { motion: "nudge-l" });
export const Redo2 = glyph(ArrowUUpRightIcon, "redo", { motion: "nudge-r" });
export const RefreshCw = glyph(ArrowClockwiseIcon, "refresh", { motion: "cw" });
export const RotateCcw = glyph(ArrowCounterClockwiseIcon, "rotate-ccw", { motion: "ccw" });
export const Repeat = glyph(RepeatIcon, "repeat", { motion: "cw" });
export const History = glyph(ClockCounterClockwiseIcon, "history");
export const Maximize2 = glyph(ArrowsOutSimpleIcon, "maximize");
export const Minimize2 = glyph(ArrowsInSimpleIcon, "minimize");
/** Expand / collapse a clamped block (a long code fence): the two-way arrow
 *  off a rule, opening and closing along the axis the block grows on. */
export const UnfoldVertical = glyph(ArrowsOutLineVerticalIcon, "unfold-vertical");
export const FoldVertical = glyph(ArrowsInLineVerticalIcon, "fold-vertical");
/** Soft-wrap long lines: the return arrow, the mark editors use for "wrap". */
export const WrapText = glyph(ArrowUDownLeftIcon, "wrap-text");
export const Menu = glyph(ListIcon, "menu");
export const MoreHorizontal = glyph(DotsThreeIcon, "more");
export const GripVertical = glyph(DotsSixVerticalIcon, "grip");
export const PanelLeft = glyph(SidebarSimpleIcon, "panel-left");
export const PanelLeftOpen = glyph(SidebarSimpleIcon, "panel-left-open");
export const PanelLeftClose = glyph(SidebarSimpleIcon, "panel-left-close");
export const SidebarOpen = glyph(SidebarSimpleIcon, "sidebar-open");
export const SidebarClose = glyph(SidebarSimpleIcon, "sidebar-close");
export const PanelRightOpen = glyph(SidebarSimpleIcon, "panel-right-open", { mirrored: true });
export const PanelRightClose = glyph(SidebarSimpleIcon, "panel-right-close", { mirrored: true });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Plus = glyph(PlusIcon, "plus", { motion: "turn" });
export const Minus = glyph(MinusIcon, "minus");
export const X = glyph(XIcon, "x", { motion: "turn" });
export const Check = glyph(CheckIcon, "check");
export const Copy = glyph(CopyIcon, "copy", { motion: "lift" });
export const Trash2 = glyph(TrashIcon, "trash", { motion: "lift" });
export const Archive = glyph(ArchiveIcon, "archive", { motion: "lift" });
export const ArchiveRestore = glyph(BoxArrowUpIcon, "archive-restore", { motion: "nudge-u" });
export const Download = glyph(DownloadSimpleIcon, "download", { motion: "nudge-d" });
export const Upload = glyph(UploadSimpleIcon, "upload", { motion: "nudge-u" });
export const UploadCloud = glyph(CloudArrowUpIcon, "upload-cloud", { motion: "nudge-u" });
export const FileUp = glyph(FileArrowUpIcon, "file-up", { motion: "nudge-u" });
export const Save = glyph(FloppyDiskIcon, "save");
/** Juno's own send mark (juno-glyphs.tsx): an up arrow whose head has the
 *  spark's concave flanks. Every "send this" in the product draws it — the
 *  composer's send circle, Ask Juno, steering a run, sending a voice draft. */
export const Send = glyph(JunoSendGlyph, "send", { motion: "nudge-u" });
export const Share2 = glyph(ShareNetworkIcon, "share");
export const Printer = glyph(PrinterIcon, "printer");
export const Search = glyph(MagnifyingGlassIcon, "search", { motion: "tilt" });
export const SearchX = glyph(MagnifyingGlassIcon, "search-empty");
export const TextSearch = glyph(ListMagnifyingGlassIcon, "text-search", { motion: "tilt" });
export const FileSearch = glyph(FileMagnifyingGlassIcon, "file-search", { motion: "tilt" });
export const Pencil = glyph(PencilSimpleIcon, "pencil", { motion: "tilt" });
export const Edit3 = glyph(PencilSimpleLineIcon, "edit", { motion: "tilt" });
export const SquarePen = glyph(NotePencilIcon, "square-pen", { motion: "tilt" });
export const NotebookPen = glyph(NotePencilIcon, "notebook-pen", { motion: "tilt" });
export const PenTool = glyph(PenNibIcon, "pen-tool", { motion: "tilt" });
export const Eraser = glyph(EraserIcon, "eraser", { motion: "tilt" });
export const Pin = glyph(PushPinIcon, "pin", { motion: "tilt" });
export const PinOff = glyph(PushPinSlashIcon, "pin-off");
export const Star = glyph(StarIcon, "star", { motion: "pop" });
export const BookmarkPlus = glyph(BookmarkSimpleIcon, "bookmark", { motion: "pop" });
export const ThumbsUp = glyph(ThumbsUpIcon, "thumbs-up", { motion: "tilt" });
export const ThumbsDown = glyph(ThumbsDownIcon, "thumbs-down", { motion: "tilt" });
export const Link2 = glyph(LinkSimpleIcon, "link", { motion: "tilt" });
export const Link2Off = glyph(LinkSimpleBreakIcon, "link-off");
export const Crop = glyph(CropIcon, "crop");
export const Scan = glyph(ScanIcon, "scan");
export const ListPlus = glyph(ListPlusIcon, "list-plus");
export const ListMinus = glyph(ListDashesIcon, "list-minus");

// ---------------------------------------------------------------------------
// Media & voice
// ---------------------------------------------------------------------------

export const Play = glyph(PlayIcon, "play", { motion: "pop" });
export const PlayCircle = glyph(PlayCircleIcon, "play-circle", { motion: "pop" });
export const Pause = glyph(PauseIcon, "pause");
export const PauseCircle = glyph(PauseCircleIcon, "pause-circle");
export const StopCircle = glyph(StopCircleIcon, "stop-circle");
export const Square = glyph(SquareIcon, "square");
export const SkipBack = glyph(SkipBackIcon, "skip-back", { motion: "nudge-l" });
export const Mic = glyph(MicrophoneIcon, "mic", { motion: "tilt" });
export const MicOff = glyph(MicrophoneSlashIcon, "mic-off");
export const AudioLines = glyph(WaveformIcon, "audio-lines");
export const Volume2 = glyph(SpeakerHighIcon, "volume");
export const PhoneOff = glyph(PhoneDisconnectIcon, "phone-off");
export const Radio = glyph(BroadcastIcon, "radio");
export const Video = glyph(VideoCameraIcon, "video");
export const Film = glyph(FilmStripIcon, "film");
export const Camera = glyph(CameraIcon, "camera");
export const Music2 = glyph(MusicNotesIcon, "music");
export const Image = glyph(PhImageIcon, "image");
/** Same glyph as `Image`, under the name that does not shadow `next/image`. */
export const ImageIcon = Image;
export const ImagePlus = glyph(ImageSquareIcon, "image-plus");
export const ImageOff = glyph(ImageBrokenIcon, "image-off");
export const MonitorUp = glyph(MonitorArrowUpIcon, "monitor-up", { motion: "nudge-u" });
export const MonitorX = glyph(ScreencastIcon, "monitor-x");

// ---------------------------------------------------------------------------
// Objects & places
// ---------------------------------------------------------------------------

export const MessageCircle = glyph(ChatCircleIcon, "message-circle");
export const MessageCircleQuestion = glyph(ChatCircleDotsIcon, "message-circle-question");
export const MessageSquare = glyph(ChatIcon, "message-square");
export const MessageSquareText = glyph(ChatTextIcon, "message-square-text");
export const MessageSquarePlus = glyph(ChatCenteredDotsIcon, "message-square-plus");
export const MessagesSquare = glyph(ChatsIcon, "messages");
export const TextQuote = glyph(QuotesIcon, "text-quote");
export const Folder = glyph(FolderIcon, "folder", { motion: "lift" });
export const FolderClosed = glyph(FolderIcon, "folder-closed", { motion: "lift" });
export const FolderOpen = glyph(FolderOpenIcon, "folder-open");
export const FolderCode = glyph(FolderSimpleIcon, "folder-code");
export const FolderInput = glyph(FolderSimplePlusIcon, "folder-input");
export const FolderLock = glyph(FolderLockIcon, "folder-lock");
export const FolderKanban = glyph(KanbanIcon, "folder-kanban");
export const FileText = glyph(FileTextIcon, "file-text");
export const FileCode = glyph(FileCodeIcon, "file-code");
export const FileCode2 = glyph(FileCodeIcon, "file-code-2");
export const FileSpreadsheet = glyph(FileXlsIcon, "file-spreadsheet");
export const Paperclip = glyph(PaperclipIcon, "paperclip", { motion: "tilt" });
export const Inbox = glyph(TrayIcon, "inbox");
/** Notifications: a plain bell. It tilts under the pointer the way a bell
 *  swings when it rings, the one thing a bell does. */
export const Bell = glyph(BellSimpleIcon, "bell", { motion: "tilt" });
export const Mail = glyph(EnvelopeSimpleIcon, "mail");
export const MailWarning = glyph(EnvelopeSimpleIcon, "mail-warning");
export const BookOpen = glyph(BookOpenIcon, "book-open");
export const ScrollText = glyph(ScrollIcon, "scroll");
export const ReceiptText = glyph(ReceiptIcon, "receipt");
export const Layers = glyph(StackSimpleIcon, "layers", { motion: "lift" });
export const Layers3 = glyph(StackIcon, "layers-3", { motion: "lift" });
export const Boxes = glyph(PackageIcon, "boxes");
export const Component = glyph(DiamondsFourIcon, "component");
export const Shapes = glyph(ShapesIcon, "shapes");
export const Frame = glyph(FrameCornersIcon, "frame");
export const Group = glyph(BoundingBoxIcon, "group");
export const SquareDashed = glyph(SelectionIcon, "square-dashed");
export const SquareDashedMousePointer = glyph(SelectionIcon, "square-dashed-pointer");
export const MousePointer2 = glyph(CursorIcon, "pointer");
export const Crosshair = glyph(CrosshairIcon, "crosshair");
export const Hand = glyph(HandIcon, "hand");
export const Type = glyph(TextTIcon, "type");
export const LayoutGrid = glyph(SquaresFourIcon, "layout-grid");
export const LayoutTemplate = glyph(LayoutIcon, "layout-template");
export const Columns2 = glyph(ColumnsIcon, "columns");
export const List = glyph(ListBulletsIcon, "list");
export const ListChecks = glyph(ListChecksIcon, "list-checks");
export const ListTodo = glyph(ListChecksIcon, "list-todo");
export const Table = glyph(TableIcon, "table");
export const Table2 = glyph(TableIcon, "table-2");
export const Presentation = glyph(PresentationIcon, "presentation");
export const Map = glyph(MapTrifoldIcon, "map");
export const Globe = glyph(GlobeSimpleIcon, "globe");
export const Cloud = glyph(CloudIcon, "cloud");
export const Database = glyph(DatabaseIcon, "database");
export const Cpu = glyph(CpuIcon, "cpu");
/** A cube: three faces and no inner detail. `SettingsIcons.models` draws it. */
export const Cube = glyph(CubeIcon, "cube");
export const Monitor = glyph(MonitorIcon, "monitor");
export const Laptop = glyph(LaptopIcon, "laptop");
export const Smartphone = glyph(DeviceMobileIcon, "smartphone");
export const Tablet = glyph(DeviceTabletIcon, "tablet");
export const Keyboard = glyph(KeyboardIcon, "keyboard");
export const Terminal = glyph(TerminalWindowIcon, "terminal");
export const Code2 = glyph(CodeIcon, "code");
export const Braces = glyph(BracketsCurlyIcon, "braces");
export const GitBranch = glyph(GitBranchIcon, "git-branch");
export const GitFork = glyph(GitForkIcon, "git-fork");
export const GitCompare = glyph(GitDiffIcon, "git-compare");
export const GitPullRequest = glyph(GitPullRequestIcon, "git-pull-request");
export const GitPullRequestDraft = glyph(GitPullRequestIcon, "git-pull-request-draft");
export const Plug = glyph(PlugIcon, "plug");
export const Wrench = glyph(WrenchIcon, "wrench", { motion: "tilt" });
export const Settings = glyph(GearSixIcon, "settings", { motion: "spin" });
export const Settings2 = glyph(SlidersHorizontalIcon, "settings-2");
export const SlidersHorizontal = glyph(SlidersHorizontalIcon, "sliders");
export const Workflow = glyph(TreeStructureIcon, "workflow");
export const Bot = glyph(RobotIcon, "bot");
/** A model's own reasoning: the resting mark of a thought-process row. */
export const Brain = glyph(BrainIcon, "brain");
export const Telescope = glyph(BinocularsIcon, "research");
export const Sparkles = glyph(SparkleIcon, "sparkles", { motion: "pop" });
export const Zap = glyph(LightningIcon, "zap", { motion: "pop" });
export const Flame = glyph(FireIcon, "flame");
export const PartyPopper = glyph(ConfettiIcon, "party", { motion: "pop" });
export const Megaphone = glyph(MegaphoneIcon, "megaphone", { motion: "tilt" });
export const GraduationCap = glyph(GraduationCapIcon, "graduation-cap");
export const BriefcaseBusiness = glyph(BriefcaseIcon, "briefcase");
export const Target = glyph(TargetIcon, "target");
export const Coins = glyph(CoinsIcon, "coins");
export const CreditCard = glyph(CreditCardIcon, "credit-card");
export const Sigma = glyph(SigmaIcon, "sigma");
export const Slash = glyph(LineSegmentIcon, "slash");
export const Activity = glyph(PulseIcon, "activity");
export const Timer = glyph(TimerIcon, "timer");
export const Clock = glyph(ClockIcon, "clock");
export const CalendarClock = glyph(CalendarDotsIcon, "calendar");

// ---------------------------------------------------------------------------
// People, access & appearance
// ---------------------------------------------------------------------------

export const User = glyph(UserIcon, "user");
export const Users = glyph(UsersIcon, "users");
export const UserPen = glyph(UserGearIcon, "user-pen");
export const KeyRound = glyph(KeyIcon, "key", { motion: "tilt" });
export const Fingerprint = glyph(FingerprintIcon, "fingerprint");
export const Lock = glyph(LockSimpleIcon, "lock");
export const LockOpen = glyph(LockSimpleOpenIcon, "lock-open");
export const ShieldCheck = glyph(ShieldCheckIcon, "shield-check");
export const ShieldAlert = glyph(ShieldWarningIcon, "shield-alert");
export const ShieldOff = glyph(ShieldSlashIcon, "shield-off");
export const Eye = glyph(EyeIcon, "eye");
export const EyeOff = glyph(EyeSlashIcon, "eye-off");
export const Sun = glyph(SunIcon, "sun", { motion: "spin" });
export const Moon = glyph(MoonIcon, "moon", { motion: "tilt" });

// ---------------------------------------------------------------------------
// Status — never animated on hover; a status mark reports, it does not act.
// ---------------------------------------------------------------------------

/** The one spinner. Pair with `animate-spin`; the notch reads as progress where
 *  a full ring of dashes reads as a clock face at 14px. */
export const Loader2 = glyph(CircleNotchIcon, "loader");
export const Circle = glyph(CircleIcon, "circle");
export const CircleDashed = glyph(CircleDashedIcon, "circle-dashed");
export const CheckCircle2 = glyph(CheckCircleIcon, "check-circle");
export const XCircle = glyph(XCircleIcon, "x-circle");
export const AlertCircle = glyph(WarningCircleIcon, "alert-circle");
export const AlertTriangle = glyph(WarningIcon, "alert-triangle");
export const TriangleAlert = glyph(WarningIcon, "triangle-alert");
export const Info = glyph(InfoIcon, "info");
export const HelpCircle = glyph(QuestionIcon, "help");
export const BadgeCheck = glyph(SealCheckIcon, "badge-check");
export const Ban = glyph(ProhibitIcon, "ban");
export const CircleSlash = glyph(ProhibitInsetIcon, "circle-slash");
export const WifiOff = glyph(WifiSlashIcon, "wifi-off");

// ---------------------------------------------------------------------------
// Design editor alignment
// ---------------------------------------------------------------------------

export const AlignStartHorizontal = glyph(AlignTopIcon, "align-top");
export const AlignCenterHorizontal = glyph(AlignCenterVerticalIcon, "align-middle");
export const AlignEndHorizontal = glyph(AlignBottomIcon, "align-bottom");
export const AlignStartVertical = glyph(AlignLeftIcon, "align-left");
export const AlignCenterVertical = glyph(AlignCenterHorizontalIcon, "align-center");
export const AlignEndVertical = glyph(AlignRightIcon, "align-right");
export const AlignHorizontalDistributeCenter = glyph(ArrowsOutLineHorizontalIcon, "distribute-horizontal");
export const AlignVerticalDistributeCenter = glyph(ArrowsOutLineVerticalIcon, "distribute-vertical");
