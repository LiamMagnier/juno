/**
 * Alevr's icon set. The ONLY module in the web app that call sites import a
 * glyph from: every component, page, menu and dialog draws its icons here.
 *
 * EVERY GLYPH IS ALEVR'S OWN. The drawings are the V3 family in
 * `src/components/ui/juno-icons/` (drawings.ts, ported from the design lane,
 * plus extra.ts, the production additions drawn in the same grammar): a 24
 * unit construction grid with the live area 3 to 21, key stems on a 1.5 unit
 * lattice, one optical line (1.25 px at 16, 1.5 px from 18), round caps and
 * joins, continuous corners, the 1.5 unit house gap where a part stands in
 * front of another, and the house plus cut into the corner for "New". The
 * renderer fits every drawing to the device pixel grid for the size it is
 * painted at. No third-party glyph library is imported anywhere: the Phosphor
 * set this module used to wrap is gone (third-party BRAND marks, the provider
 * and connector logos, are their own assets and are not drawn here).
 *
 * NAMES ARE STABLE. The exports keep the spellings the codebase already used
 * (`ChevronDown`, `Loader2`, `Settings`), so moving to the family touched this
 * file, not the call sites. Each export names the drawing it shows; changing a
 * concept's drawing is a one-line change here and reaches every surface.
 *
 * OPTICAL SIZE comes from where the glyph is painted, not from a prop. A call
 * site sizes a glyph with a class (`size-4`) or its parent does
 * (`[&_svg]:size-4.5`); the icon draws its first frame from the class it can
 * read and then measures itself, so the line, the small cut and the hinting
 * are always those of its real size.
 *
 * MOTION IS OPT-IN (INTERACTION_SPEC I-7, MOTION_AND_THINKING's feature map).
 * A glyph moves only inside a control marked `.jicon-trigger.jicon-hover` (or
 * a `.jicon-hover` region), only under a fine pointer, never on keyboard
 * focus, and only for low-frequency destinations: the sidebar's New chat,
 * Projects, Library and Customize. Lists, menus, the composer and the message
 * actions stay still. An icon-only button marked `.jicon-trigger` gets the
 * press dip (0.97, 70 ms). The old per-glyph `motion` prop is accepted and
 * ignored.
 *
 * STATE. `weight="fill"`, `fill="currentColor"` or a `fill-*` class ask for the
 * "on" drawing (a pinned pin, a filled square); a drawing without one stays
 * outlined rather than borrowing another state.
 *
 * Server-component safe: this module has no hooks; the renderer it draws with
 * is a client component.
 */
import type { ComponentPropsWithoutRef, JSX, Ref } from "react";

import { Icon as AlevrIcon } from "@/components/ui/juno-icons";
import { resolveCatalogIcon } from "@/components/ui/juno-icons/catalog";
import { cn } from "@/lib/utils";

/** Kept for call sites written against the previous set; the family has one weight and an "on" drawing. */
export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

/** Kept for call sites written against the previous set. Motion is the family's (see the header). */
export type IconMotion = "nudge-r" | "nudge-l" | "nudge-u" | "nudge-d" | "nudge-ne" | "turn" | "spin" | "cw" | "ccw" | "tilt" | "lift" | "pop" | "parts";

export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "fill" | "strokeWidth"> & {
  ref?: Ref<SVGSVGElement>;
  /** Pixel size of the box when no class sizes it. Defaults to 24, the box the previous set gave an unsized glyph. */
  size?: number | string;
  /** `fill` asks for the drawing's "on" form. Other weights are accepted and drawn in the family's one line. */
  weight?: IconWeight;
  /** Accepted for old call sites; the family's line is optical and never stretched. */
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  /** Any non-`none` value asks for the "on" form, as `weight="fill"` does. */
  fill?: string;
  /** Accepted for old call sites and ignored: motion is opt-in on the control (see the header). */
  motion?: IconMotion | "none";
  /** Draws the glyph mirrored left to right. */
  mirrored?: boolean;
  alt?: string;
};

/** The type of anything this module exports. Use it wherever a component takes an icon as a prop. */
export type IconComponent = ((props: IconProps) => JSX.Element) & { displayName?: string };

const FILLED = /(?:^|\s)(?:[\w-]+:)*fill-(?!none(?:\s|$))[a-z]/;
const PX: Record<string, number> = { "2": 8, "2.5": 10, "3": 12, "3.5": 14, "4": 16, "4.5": 18, "5": 20, "5.5": 22, "6": 24, "7": 28, "8": 32, "9": 36, "10": 40, "11": 44, "12": 48 };

/** The size a class asks for (`size-4`, `h-5 w-5`, `size-[18px]`), ignoring variant-prefixed classes. */
function classSize(className: string | undefined): number | undefined {
  if (!className) return undefined;
  for (const token of className.split(/\s+/)) {
    if (token.includes(":")) continue;
    const m = /^(?:size|h|w)-(?:(\d+(?:\.\d+)?)|\[(\d+(?:\.\d+)?)px\])$/.exec(token);
    if (!m) continue;
    if (m[2]) return Number(m[2]);
    const px = PX[m[1]];
    if (px) return px;
  }
  return undefined;
}

function numeric(value: number | string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function glyph(name: string, displayName: string): IconComponent {
  const drawing = resolveCatalogIcon(name);
  const canFill = drawing?.on?.kind === "fill";
  function AlevrGlyph({
    ref: _ref,
    className,
    size,
    weight,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    fill,
    motion: _motion,
    mirrored,
    alt,
    style,
    ...rest
  }: IconProps) {
    const labelled = rest["aria-label"] != null || rest["aria-labelledby"] != null || alt != null;
    const on = canFill && (weight === "fill" || (fill != null && fill !== "none" && fill !== "transparent") || (className != null && FILLED.test(className)));
    const px = classSize(className) ?? numeric(size) ?? 24;
    return (
      <AlevrIcon
        name={name}
        size={px}
        autoSize
        state={on ? "active" : "rest"}
        className={cn("icon", className)}
        style={mirrored ? { ...style, scale: "-1 1" } : style}
        data-glyph={displayName}
        {...rest}
        role={labelled ? "img" : undefined}
        aria-hidden={labelled ? undefined : true}
        aria-label={rest["aria-label"] ?? alt}
      />
    );
  }
  AlevrGlyph.displayName = displayName;
  return AlevrGlyph;
}

// ---------------------------------------------------------------------------
// Alevr's places. Orbit and Code also exist as brand glyphs
// (src/components/brand/orbit-glyph.tsx, code-glyph.tsx) for the product
// switch and the Orbit section head; these are the same constructions in the
// icon registry for menus, the palette and pages.
// ---------------------------------------------------------------------------

export const JunoChat = glyph("chat", "JunoChat");
export const JunoCode = glyph("code", "JunoCode");
export const JunoDesign = glyph("design", "JunoDesign");
export const JunoLibrary = glyph("library", "JunoLibrary");
/** Agents (Alevr Orbit): two agents on one ground line. An individual agent in a run is `Bot`. */
export const JunoAgents = glyph("crew", "JunoAgents");
/** Orbit, where your agents live: two open arcs of one ellipse. Static, never a spinner. */
export const JunoOrbit = glyph("orbit", "JunoOrbit");

// The voice call's controls.
export const CallMic = glyph("mic", "CallMic");
export const CallMicOff = glyph("mic-off", "CallMicOff");
export const CallSettings = glyph("customize", "CallSettings");
export const CallStop = glyph("stop", "CallStop");
export const CallEnd = glyph("end-call", "CallEnd");

// ---------------------------------------------------------------------------
// Direction and navigation. Carets are state marks (open, closed, sort
// order); their rotation belongs to the call site.
// ---------------------------------------------------------------------------

export const ChevronDown = glyph("chevron-down", "ChevronDown");
export const ChevronUp = glyph("chevron-up", "ChevronUp");
export const ChevronLeft = glyph("chevron-left", "ChevronLeft");
export const ChevronRight = glyph("chevron-right", "ChevronRight");
/** Both ways at once: a row that opens a menu (the sidebar's account row). */
export const ChevronsUpDown = glyph("chevrons-up-down", "ChevronsUpDown");

export const ArrowLeft = glyph("arrow-left", "ArrowLeft");
export const ArrowRight = glyph("arrow-right", "ArrowRight");
export const ArrowUp = glyph("arrow-up", "ArrowUp");
export const ArrowDown = glyph("arrow-down", "ArrowDown");
/** Mention and return-key glyphs used by the redesigned composer. */
export const AtSign = glyph("at", "AtSign");
export const CornerDownLeft = glyph("enter", "CornerDownLeft");
export const ArrowUpRight = glyph("arrow-up-right", "ArrowUpRight");
export const ArrowUpToLine = glyph("arrow-up-line", "ArrowUpToLine");
export const ArrowDownToLine = glyph("arrow-down-line", "ArrowDownToLine");
export const CornerDownRight = glyph("corner-down-right", "CornerDownRight");
export const ExternalLink = glyph("external", "ExternalLink");
export const LogOut = glyph("sign-out", "LogOut");
export const Undo2 = glyph("undo", "Undo2");
export const Redo2 = glyph("redo", "Redo2");
export const RefreshCw = glyph("refresh", "RefreshCw");
export const RotateCcw = glyph("retry", "RotateCcw");
export const Repeat = glyph("repeat", "Repeat");
export const History = glyph("history", "History");
export const Maximize2 = glyph("expand", "Maximize2");
export const Minimize2 = glyph("collapse", "Minimize2");
/** Expand or collapse a clamped block (a long code fence): chevrons leaving or closing on a rule. */
export const UnfoldVertical = glyph("unfold", "UnfoldVertical");
export const FoldVertical = glyph("fold", "FoldVertical");
/** Soft-wrap long lines: the return arrow. */
export const WrapText = glyph("enter", "WrapText");
export const Menu = glyph("menu", "Menu");
export const MoreHorizontal = glyph("more", "MoreHorizontal");
export const GripVertical = glyph("grip", "GripVertical");
export const PanelLeft = glyph("sidebar", "PanelLeft");
export const PanelLeftOpen = glyph("sidebar", "PanelLeftOpen");
export const PanelLeftClose = glyph("sidebar", "PanelLeftClose");
export const SidebarOpen = glyph("sidebar", "SidebarOpen");
export const SidebarClose = glyph("sidebar", "SidebarClose");
export const PanelRightOpen = glyph("panel-right", "PanelRightOpen");
export const PanelRightClose = glyph("panel-right", "PanelRightClose");
export const PanelRight = PanelRightOpen;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Plus = glyph("plus", "Plus");
export const Minus = glyph("minus", "Minus");
export const X = glyph("close", "X");
export const Check = glyph("check", "Check");
export const Copy = glyph("copy", "Copy");
export const Trash2 = glyph("trash", "Trash2");
export const Archive = glyph("archive", "Archive");
export const ArchiveRestore = glyph("unarchive", "ArchiveRestore");
export const Download = glyph("download", "Download");
export const Upload = glyph("upload", "Upload");
export const UploadCloud = glyph("cloud-upload", "UploadCloud");
export const FileUp = glyph("file-upload", "FileUp");
export const Save = glyph("save", "Save");
/** Every "send this" in the product: the composer, Ask Alevr, steering a run, a voice draft. */
export const Send = glyph("send", "Send");
export const Share2 = glyph("share", "Share2");
export const Printer = glyph("printer", "Printer");
export const Search = glyph("search", "Search");
export const SearchX = glyph("search", "SearchX");
export const TextSearch = glyph("research", "TextSearch");
export const FileSearch = glyph("research", "FileSearch");
export const Pencil = glyph("edit", "Pencil");
export const Edit3 = glyph("edit", "Edit3");
export const SquarePen = glyph("edit", "SquarePen");
/** Memory (what Alevr remembers): the layered recall cards. */
export const NotebookPen = glyph("memory", "NotebookPen");
export const PenTool = glyph("design", "PenTool");
export const Eraser = glyph("eraser", "Eraser");
export const Pin = glyph("pin", "Pin");
export const PinOff = glyph("unpin", "PinOff");
export const Star = glyph("star", "Star");
export const BookmarkPlus = glyph("bookmark", "BookmarkPlus");
export const ThumbsUp = glyph("thumbs-up", "ThumbsUp");
export const ThumbsDown = glyph("thumbs-down", "ThumbsDown");
export const Link2 = glyph("link", "Link2");
export const Link2Off = glyph("link-off", "Link2Off");
export const Crop = glyph("crop", "Crop");
export const Scan = glyph("screenshot", "Scan");
export const ListPlus = glyph("list-plus", "ListPlus");
export const ListMinus = glyph("list-minus", "ListMinus");
/** A plan above this one (Upgrade plan): an arrow rising in a circle. */
export const ArrowUpCircle = glyph("upgrade", "ArrowUpCircle");

// ---------------------------------------------------------------------------
// Media and voice
// ---------------------------------------------------------------------------

export const Play = glyph("play", "Play");
export const PlayCircle = glyph("run", "PlayCircle");
export const Pause = glyph("pause", "Pause");
export const PauseCircle = glyph("pause-circle", "PauseCircle");
export const StopCircle = glyph("stop-circle", "StopCircle");
/** A shape (the design editor's square, a stop control drawn with `fill-current`). */
export const Square = glyph("square", "Square");
export const SkipBack = glyph("skip-back", "SkipBack");
export const Mic = glyph("mic", "Mic");
export const MicOff = glyph("mic-off", "MicOff");
export const AudioLines = glyph("voice", "AudioLines");
export const Volume2 = glyph("read-aloud", "Volume2");
export const PhoneOff = glyph("end-call", "PhoneOff");
export const Radio = glyph("broadcast", "Radio");
export const Video = glyph("video", "Video");
export const Film = glyph("film", "Film");
export const Camera = glyph("camera", "Camera");
export const Music2 = glyph("music", "Music2");
export const Image = glyph("image", "Image");
/** Same glyph as `Image`, under the name that does not shadow `next/image`. */
export const ImageIcon = Image;
export const ImagePlus = glyph("image-plus", "ImagePlus");
export const ImageOff = glyph("image-off", "ImageOff");
export const MonitorUp = glyph("screen-share", "MonitorUp");
export const MonitorX = glyph("screen-off", "MonitorX");

// ---------------------------------------------------------------------------
// Objects and places
// ---------------------------------------------------------------------------

export const MessageCircle = glyph("chat", "MessageCircle");
export const MessageCircleQuestion = glyph("chat-question", "MessageCircleQuestion");
export const MessageSquare = glyph("chat", "MessageSquare");
export const MessageSquareText = glyph("chat", "MessageSquareText");
export const MessageSquarePlus = glyph("new-chat", "MessageSquarePlus");
export const MessagesSquare = glyph("chats", "MessagesSquare");
export const TextQuote = glyph("citation", "TextQuote");
export const Folder = glyph("folder", "Folder");
export const FolderClosed = glyph("folder", "FolderClosed");
export const FolderOpen = glyph("folder-open", "FolderOpen");
export const FolderCode = glyph("folder-code", "FolderCode");
export const FolderInput = glyph("folder-move", "FolderInput");
export const FolderLock = glyph("folder-lock", "FolderLock");
export const FolderKanban = glyph("grid", "FolderKanban");
export const FileText = glyph("document", "FileText");
export const FilePlus = glyph("file-plus", "FilePlus");
export const Calculator = glyph("calculator", "Calculator");
export const FileCode = glyph("file-code", "FileCode");
export const FileCode2 = glyph("file-code", "FileCode2");
export const FileSpreadsheet = glyph("sheet", "FileSpreadsheet");
export const Paperclip = glyph("attach", "Paperclip");
export const Inbox = glyph("inbox", "Inbox");
/** Notifications: a plain bell. Unseen records lift its ink; never a dot, a count or a fill. */
export const Bell = glyph("bell", "Bell");
export const Mail = glyph("mail", "Mail");
export const MailWarning = glyph("mail", "MailWarning");
export const BookOpen = glyph("sources", "BookOpen");
export const ScrollText = glyph("instructions", "ScrollText");
export const ReceiptText = glyph("receipt", "ReceiptText");
export const Layers = glyph("layers", "Layers");
export const Layers3 = glyph("layers", "Layers3");
export const Boxes = glyph("zip", "Boxes");
export const Component = glyph("component", "Component");
export const Shapes = glyph("appearance", "Shapes");
export const Frame = glyph("frame", "Frame");
export const Group = glyph("group", "Group");
export const SquareDashed = glyph("selection", "SquareDashed");
export const SquareDashedMousePointer = glyph("select-area", "SquareDashedMousePointer");
export const MousePointer2 = glyph("pointer", "MousePointer2");
export const Crosshair = glyph("crosshair", "Crosshair");
export const Hand = glyph("hand", "Hand");
export const Type = glyph("type", "Type");
export const LayoutGrid = glyph("grid", "LayoutGrid");
export const LayoutTemplate = glyph("layout", "LayoutTemplate");
export const Columns2 = glyph("columns", "Columns2");
export const List = glyph("list", "List");
export const ListChecks = glyph("plan", "ListChecks");
export const ListTodo = glyph("plan", "ListTodo");
export const Table = glyph("sheet", "Table");
export const Table2 = glyph("sheet", "Table2");
export const Presentation = glyph("deck", "Presentation");
export const Map = glyph("map", "Map");
export const Globe = glyph("globe", "Globe");
export const Cloud = glyph("cloud", "Cloud");
export const Database = glyph("database", "Database");
export const Cpu = glyph("computer", "Cpu");
/** A model: three faces and no inner detail. `SettingsIcons.models` draws it. */
export const Cube = glyph("cube", "Cube");
export const Monitor = glyph("computer", "Monitor");
export const Laptop = glyph("laptop", "Laptop");
export const Smartphone = glyph("phone", "Smartphone");
export const Tablet = glyph("tablet", "Tablet");
export const Keyboard = glyph("keyboard", "Keyboard");
export const Terminal = glyph("terminal", "Terminal");
export const Code2 = glyph("code", "Code2");
export const Braces = glyph("braces", "Braces");
export const GitBranch = glyph("branch", "GitBranch");
export const GitFork = glyph("fork", "GitFork");
export const GitCompare = glyph("diff", "GitCompare");
export const GitPullRequest = glyph("pull-request", "GitPullRequest");
export const GitPullRequestDraft = glyph("pull-request", "GitPullRequestDraft");
export const Plug = glyph("app", "Plug");
/** A tool call's resting mark: what kind of work the row holds. */
export const Wrench = glyph("wrench", "Wrench");
export const Settings = glyph("settings", "Settings");
export const Settings2 = glyph("customize", "Settings2");
export const SlidersHorizontal = glyph("customize", "SlidersHorizontal");
export const Workflow = glyph("workflow", "Workflow");
/** One agent (a subagent in a run). */
export const Bot = glyph("agent", "Bot");
/** The resting mark of a model's reasoning row. The live one is the Continuum mark beside its phase words. */
export const Brain = glyph("thought", "Brain");
/** Deep Field (deep research). */
export const Telescope = glyph("deep-field", "Telescope");
/** Kept for old call sites: the family has no sparkle (a stock "AI" mark); a star stands in. */
export const Sparkles = glyph("star", "Sparkles");
export const Zap = glyph("bolt", "Zap");
export const Flame = glyph("bolt", "Flame");
export const PartyPopper = glyph("success", "PartyPopper");
export const Megaphone = glyph("megaphone", "Megaphone");
export const GraduationCap = glyph("learn", "GraduationCap");
export const BriefcaseBusiness = glyph("folder", "BriefcaseBusiness");
export const Target = glyph("target", "Target");
export const Coins = glyph("coins", "Coins");
export const CreditCard = glyph("billing", "CreditCard");
export const Sigma = glyph("sigma", "Sigma");
/** The design editor's line tool. */
export const Slash = glyph("line", "Slash");
export const Activity = glyph("activity", "Activity");
export const Timer = glyph("timer", "Timer");
export const Clock = glyph("clock", "Clock");
export const CalendarClock = glyph("calendar", "CalendarClock");

// ---------------------------------------------------------------------------
// People, access and appearance
// ---------------------------------------------------------------------------

export const User = glyph("profile", "User");
/** People (accounts, members). An agent is `Bot`; your agents are `JunoAgents`. */
export const Users = glyph("people", "Users");
/** Personalization: you, adjusted. */
export const UserPen = glyph("profile-edit", "UserPen");
export const KeyRound = glyph("key", "KeyRound");
export const Fingerprint = glyph("fingerprint", "Fingerprint");
export const Lock = glyph("lock", "Lock");
export const LockOpen = glyph("unlock", "LockOpen");
export const ShieldCheck = glyph("shield", "ShieldCheck");
export const ShieldAlert = glyph("shield-alert", "ShieldAlert");
export const ShieldOff = glyph("shield-off", "ShieldOff");
export const Eye = glyph("eye", "Eye");
export const EyeOff = glyph("eye-off", "EyeOff");
export const Sun = glyph("sun", "Sun");
export const Moon = glyph("moon", "Moon");

// ---------------------------------------------------------------------------
// Status: a status mark reports, it does not act.
// ---------------------------------------------------------------------------

/** The one spinner, for waits that have no phase words. Pair with `animate-spin`. */
export const Loader2 = glyph("loader", "Loader2");
export const Circle = glyph("circle", "Circle");
export const CircleDashed = glyph("circle-dashed", "CircleDashed");
export const CheckCircle2 = glyph("success", "CheckCircle2");
export const XCircle = glyph("error-circle", "XCircle");
export const AlertCircle = glyph("alert", "AlertCircle");
export const AlertTriangle = glyph("warning", "AlertTriangle");
export const TriangleAlert = glyph("warning", "TriangleAlert");
export const Info = glyph("info", "Info");
export const HelpCircle = glyph("help", "HelpCircle");
export const BadgeCheck = glyph("verified", "BadgeCheck");
export const Ban = glyph("ban", "Ban");
export const CircleSlash = glyph("ban", "CircleSlash");
export const WifiOff = glyph("offline", "WifiOff");

// ---------------------------------------------------------------------------
// Design editor alignment
// ---------------------------------------------------------------------------

export const AlignStartHorizontal = glyph("align-top", "AlignStartHorizontal");
export const AlignCenterHorizontal = glyph("align-middle", "AlignCenterHorizontal");
export const AlignEndHorizontal = glyph("align-bottom", "AlignEndHorizontal");
export const AlignStartVertical = glyph("align-left", "AlignStartVertical");
export const AlignCenterVertical = glyph("align-center", "AlignCenterVertical");
export const AlignEndVertical = glyph("align-right", "AlignEndVertical");
export const AlignHorizontalDistributeCenter = glyph("distribute-horizontal", "AlignHorizontalDistributeCenter");
export const AlignVerticalDistributeCenter = glyph("distribute-vertical", "AlignVerticalDistributeCenter");
