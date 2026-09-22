/**
 * Core marks: direction, the four punctuation glyphs, time, transport, and the
 * handful of shapes everything else is built out of.
 *
 * Direction is the one family where motion is not decoration — an arrow that
 * travels one unit along its own axis on hover is the button previewing what
 * it does. Every arrowhead therefore carries `data-part="arrow-<dir>"`, and
 * the axis is in the name so the choreography can be written once per axis
 * instead of once per icon.
 */
import { createIcon as icon, p, c, rect, dot, dashed } from "./create-icon";

/* — Direction ———————————————————————————————————————————————————————— */

export const ArrowUp = icon("arrow-up", [
  p("M12 19.6V6.1"),
  p("M6.9 11.2 12 6.1l5.1 5.1", "arrow-up"),
]);
export const ArrowDown = icon("arrow-down", [
  p("M12 4.4v13.5"),
  p("M6.9 12.8 12 17.9l5.1-5.1", "arrow-down"),
]);
export const ArrowLeft = icon("arrow-left", [
  p("M19.6 12H6.1"),
  p("M11.2 6.9 6.1 12l5.1 5.1", "arrow-left"),
]);
export const ArrowRight = icon("arrow-right", [
  p("M4.4 12h13.5"),
  p("M12.8 6.9 17.9 12l-5.1 5.1", "arrow-right"),
]);
export const ArrowUpRight = icon("arrow-up-right", [
  p("M7.3 16.7 16.5 7.5"),
  p("M9.7 7.5h7v7", "arrow-ne"),
]);
export const ArrowDownToLine = icon("arrow-down-to-line", [
  p("M12 4v10.1"),
  p("M7.7 9.8 12 14.1l4.3-4.3", "arrow-down"),
  p("M5.8 19.2h12.4"),
]);
export const ArrowUpToLine = icon("arrow-up-to-line", [
  p("M12 20V9.9"),
  p("M7.7 14.2 12 9.9l4.3 4.3", "arrow-up"),
  p("M5.8 4.8h12.4"),
]);
export const ChevronUp = icon("chevron-up", [p("M6.5 14.6 12 9.1l5.5 5.5", "arrow-up")]);
export const ChevronDown = icon("chevron-down", [p("M6.5 9.4 12 14.9l5.5-5.5", "arrow-down")]);
export const ChevronLeft = icon("chevron-left", [p("M14.6 6.5 9.1 12l5.5 5.5", "arrow-left")]);
export const ChevronRight = icon("chevron-right", [p("M9.4 6.5 14.9 12l-5.5 5.5", "arrow-right")]);
export const CornerDownRight = icon("corner-down-right", [
  p("M5.4 5.2v7.6a3.4 3.4 0 0 0 3.4 3.4h8.6"),
  p("M14.4 12.6 17.8 16l-3.4 3.4", "arrow-right"),
]);
export const MousePointer2 = icon("mouse-pointer-2", [
  p("M5.2 3.9 19 11.4l-6.5 1.4-2.6 6.2z"),
]);
export const Hand = icon("hand", [
  p("M9.6 11V5.9a1.7 1.7 0 0 1 3.4 0V11"),
  p("M13 10.4V6.6a1.7 1.7 0 0 1 3.4 0v6"),
  p("M16.4 11.4a1.7 1.7 0 0 1 3.4 0v2.8a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.5-2L4.9 14.6a1.7 1.7 0 0 1 2.5-2.2l2.2 2.3"),
]);

/* — Punctuation —————————————————————————————————————————————————————— */

export const Plus = icon("plus", [p("M12 5.6v12.8"), p("M5.6 12h12.8")]);
export const Minus = icon("minus", [p("M5.8 12h12.4")]);
export const X = icon("x", [p("M6.7 6.7 17.3 17.3"), p("M17.3 6.7 6.7 17.3")]);
export const Check = icon("check", [p("M5.6 12.7 9.9 17 18.4 7.5")]);
export const Slash = icon("slash", [p("M6.9 17.1 17.1 6.9")]);

/* — Shapes ——————————————————————————————————————————————————————————— */

export const Circle = icon("circle", [c(12, 12, 7.6)]);
export const CircleDashed = icon("circle-dashed", [
  dashed("M12 4.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2", "3.3 3.2"),
]);
export const CircleSlash = icon("circle-slash", [c(12, 12, 7.6), p("M6.9 17.1 17.1 6.9")]);
export const Square = icon("square", [rect(4.4, 4.4, 15.2, 15.2, 3.4)]);
export const SquareDashed = icon("square-dashed", [
  dashed("M7.8 4.4h8.4a3.4 3.4 0 0 1 3.4 3.4v8.4a3.4 3.4 0 0 1-3.4 3.4H7.8a3.4 3.4 0 0 1-3.4-3.4V7.8a3.4 3.4 0 0 1 3.4-3.4"),
]);
export const Shapes = icon("shapes", [
  c(7.4, 7.6, 3.6),
  rect(13.2, 13, 6.8, 6.8, 2),
  p("M10.6 19.8H4.6a.8.8 0 0 1-.7-1.2l3-5.2a.8.8 0 0 1 1.4 0l3 5.2a.8.8 0 0 1-.7 1.2"),
]);

/* — Time ————————————————————————————————————————————————————————————— */

export const Clock = icon("clock", [c(12, 12, 7.6), p("M12 7.9V12l3 1.8", "rotor")]);
export const Timer = icon("timer", [
  p("M9.8 3.4h4.4"),
  c(12, 13.6, 6.6),
  p("M12 10.2v3.4l2.5 1.5", "rotor"),
]);
export const History = icon("history", [
  p("M4.4 12A7.6 7.6 0 1 0 6.7 6.7", "rotor"),
  p("M10.1 6.7H6.7V3.3"),
  p("M12 8.2V12l2.9 1.7"),
]);
export const CalendarClock = icon("calendar-clock", [
  p("M14.2 19H5.8A2.6 2.6 0 0 1 3.2 16.4V7.6A2.6 2.6 0 0 1 5.8 5h8.6a2.6 2.6 0 0 1 2.6 2.6v1.8"),
  p("M3.2 9.8h13.8"),
  c(17.6, 16.4, 4.2),
  p("M17.6 14.6v1.9l1.5.9", "rotor"),
]);

/* — Rotation ————————————————————————————————————————————————————————— */

export const RotateCcw = icon("rotate-ccw", [
  p("M4.4 12A7.6 7.6 0 1 0 6.7 6.7", "rotor"),
  p("M10.1 6.7H6.7V3.3"),
]);
export const RefreshCw = icon("refresh-cw", [
  p("M5.1 9.4A7.6 7.6 0 0 1 19 9.6", "rotor"),
  p("M19.8 6.3 18.9 9.7 15.7 8.3"),
  p("M18.9 14.6A7.6 7.6 0 0 1 5 14.4", "rotor"),
  p("M4.2 17.7 5.1 14.3l3.2 1.4"),
]);
export const Undo2 = icon("undo-2", [
  p("M8.9 13.6 4.6 9.3 8.9 5"),
  p("M4.6 9.3h9.6a5.4 5.4 0 0 1 0 10.8h-3.4"),
]);
export const Redo2 = icon("redo-2", [
  p("M15.1 13.6 19.4 9.3 15.1 5"),
  p("M19.4 9.3H9.8a5.4 5.4 0 0 0 0 10.8h3.4"),
]);
export const Repeat = icon("repeat", [
  p("M16.6 3.6 20 7l-3.4 3.4", "arrow-right"),
  p("M4 12.4V10a3 3 0 0 1 3-3h13"),
  p("M7.4 20.4 4 17l3.4-3.4", "arrow-left"),
  p("M20 11.6V14a3 3 0 0 1-3 3H4"),
]);

/* — Transport ———————————————————————————————————————————————————————— */

export const Play = icon("play", [p("M8.6 5.9 18.2 12l-9.6 6.1z", "arrow-right")]);
export const Pause = icon("pause", [
  rect(8, 5.8, 2.6, 12.4, 1.2),
  rect(13.4, 5.8, 2.6, 12.4, 1.2),
]);
export const PlayCircle = icon("play-circle", [c(12, 12, 7.6), p("M10.4 9.1 15.2 12l-4.8 2.9z")]);
export const PauseCircle = icon("pause-circle", [
  c(12, 12, 7.6),
  p("M10.3 9.4v5.2"),
  p("M13.7 9.4v5.2"),
]);
export const StopCircle = icon("stop-circle", [c(12, 12, 7.6), rect(9.4, 9.4, 5.2, 5.2, 1.5)]);
export const SkipBack = icon("skip-back", [
  p("M18 6.5 9.6 12 18 17.5z"),
  p("M6.2 6.3v11.4"),
]);

/* — Traffic —————————————————————————————————————————————————————————— */

export const Loader2 = icon("loader-2", [p("M19.6 12A7.6 7.6 0 1 1 12 4.4", "rotor")]);
export const MoreHorizontal = icon("more-horizontal", [
  dot(5.9, 12),
  dot(12, 12),
  dot(18.1, 12),
]);
export const GripVertical = icon("grip-vertical", [
  dot(9.2, 6.4, 1.2),
  dot(14.8, 6.4, 1.2),
  dot(9.2, 12, 1.2),
  dot(14.8, 12, 1.2),
  dot(9.2, 17.6, 1.2),
  dot(14.8, 17.6, 1.2),
]);
export const Menu = icon("menu", [p("M4.6 7.4h14.8"), p("M4.6 12h14.8"), p("M4.6 16.6h14.8")]);
export const Search = icon("search", [c(11, 11, 6.4, "pulse"), p("M15.8 15.8 20 20")]);
export const SearchX = icon("search-x", [
  c(11, 11, 6.4, "pulse"),
  p("M15.8 15.8 20 20"),
  p("M9 9l4 4"),
  p("M13 9l-4 4"),
]);
export const ExternalLink = icon("external-link", [
  p("M13.6 4.6h5.8v5.8", "arrow-ne"),
  p("M19.4 4.6 11.8 12.2"),
  p("M17.4 14v3.4a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 17.4V9.2a2.6 2.6 0 0 1 2.6-2.6H10"),
]);
export const Download = icon("download", [
  p("M12 3.8v10.4"),
  p("M7.6 9.9 12 14.3l4.4-4.4", "arrow-down"),
  p("M4.6 15.6v1.8a2.8 2.8 0 0 0 2.8 2.8h9.2a2.8 2.8 0 0 0 2.8-2.8v-1.8"),
]);
export const Upload = icon("upload", [
  p("M12 14.4V4"),
  p("M7.6 8.4 12 4l4.4 4.4", "arrow-up"),
  p("M4.6 15.6v1.8a2.8 2.8 0 0 0 2.8 2.8h9.2a2.8 2.8 0 0 0 2.8-2.8v-1.8"),
]);
export const Send = icon("send", [
  p("M20.4 3.6 11 13"),
  p("M20.4 3.6 14.4 20.4a.7.7 0 0 1-1.3 0L11 13 4.6 10.9a.7.7 0 0 1 0-1.3z"),
]);
export const Crosshair = icon("crosshair", [
  c(12, 12, 7.2),
  p("M12 2.8v3.4"),
  p("M12 17.8v3.4"),
  p("M2.8 12h3.4"),
  p("M17.8 12h3.4"),
]);
export const Scan = icon("scan", [
  p("M4 8.6V7a3 3 0 0 1 3-3h1.6"),
  p("M15.4 4H17a3 3 0 0 1 3 3v1.6"),
  p("M20 15.4V17a3 3 0 0 1-3 3h-1.6"),
  p("M8.6 20H7a3 3 0 0 1-3-3v-1.6"),
]);
export const Sigma = icon("sigma", [p("M17.4 4.6H6.6L12 12l-5.4 7.4h10.8")]);
export const Sparkles = icon("sparkles", [
  p("M12 3.6l1.85 4.55L18.4 10l-4.55 1.85L12 16.4l-1.85-4.55L5.6 10l4.55-1.85z"),
  p("M18.2 15.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z", "accent"),
]);
export const Zap = icon("zap", [p("M13.4 3.4 5.6 13.2h5.4l-.4 7.4 7.8-9.8h-5.4z")]);
export const Flame = icon("flame", [
  p("M12 3.4s5.6 3.9 5.6 9.2a5.6 5.6 0 1 1-11.2 0c0-1.8.7-3.3 1.6-4.5.6 1.2 1.5 2 2.4 2 1.3 0 1.6-2.1 1.6-6.7"),
]);
export const Star = icon("star", [
  p("M12 3.8l2.62 5.31 5.86.85-4.24 4.13 1 5.84L12 17.18l-5.24 2.75 1-5.84-4.24-4.13 5.86-.85z"),
]);
export const Eraser = icon("eraser", [
  p("M8.9 19.4 4.3 14.8a2 2 0 0 1 0-2.8l7.3-7.3a2 2 0 0 1 2.8 0l5.3 5.3a2 2 0 0 1 0 2.8l-6.6 6.6z"),
  p("M9.6 9.6 15 15"),
  p("M8.9 19.4h10.6"),
]);
export const Eye = icon("eye", [
  p("M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12"),
  c(12, 12, 2.9, "pulse"),
]);
export const EyeOff = icon("eye-off", [
  p("M10.1 6a8.6 8.6 0 0 1 1.9-.2c5.8 0 9.4 6.2 9.4 6.2a15 15 0 0 1-2.6 3.3"),
  p("M6.4 7.8A14.9 14.9 0 0 0 2.6 12s3.6 6.2 9.4 6.2a8.7 8.7 0 0 0 3.5-.7"),
  p("M10 10.1a2.9 2.9 0 0 0 4 4"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Maximize2 = icon("maximize-2", [
  p("M14.4 4.6h5v5", "arrow-ne"),
  p("M9.6 19.4h-5v-5"),
  p("M19.4 4.6 13.4 10.6"),
  p("M4.6 19.4 10.6 13.4"),
]);
export const Minimize2 = icon("minimize-2", [
  p("M9.8 4.6v5.2H4.6"),
  p("M14.2 19.4v-5.2h5.2"),
  p("M4.6 19.4 9.8 14.2"),
  p("M19.4 4.6 14.2 9.8"),
]);
export const Columns2 = icon("columns-2", [
  rect(4, 4.4, 16, 15.2, 3.2),
  p("M12 4.4v15.2"),
]);
export const Pin = icon("pin", [
  p("M12 13.2V21"),
  p("M9.3 3.4h5.4l-.8 5 2.7 2.4v1.4H7.4v-1.4l2.7-2.4z", "swing"),
]);
export const PinOff = icon("pin-off", [
  p("M12 13.2V21"),
  p("M9.3 3.4h5.4l-.8 5 2.7 2.4v1.4h-5"),
  p("M8.6 8.9l-1.2 1.9-2.6 2.4v1.4h6.4"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Ban = icon("ban", [c(12, 12, 7.8), p("M6.5 6.5 17.5 17.5")]);
export const Crop = icon("crop", [
  p("M6.4 2.8v12.2a2.6 2.6 0 0 0 2.6 2.6h12.2"),
  p("M2.8 6.4H15a2.6 2.6 0 0 1 2.6 2.6v12.2"),
]);
export const Printer = icon("printer", [
  p("M7 8.4V4.6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3.8"),
  p("M7 17H5.6A2.6 2.6 0 0 1 3 14.4v-3.4a2.6 2.6 0 0 1 2.6-2.6h12.8a2.6 2.6 0 0 1 2.6 2.6v3.4a2.6 2.6 0 0 1-2.6 2.6H17"),
  rect(7, 14.4, 10, 6, 1.6),
]);
export const Keyboard = icon("keyboard", [
  rect(2.6, 6.4, 18.8, 11.2, 3),
  dot(7, 10.4, 1),
  dot(12, 10.4, 1),
  dot(17, 10.4, 1),
  p("M7.6 14.4h8.8"),
]);
export const Wrench = icon("wrench", [
  p("M15.1 3.6a5.4 5.4 0 0 0-4.6 8.2L4 18.3a2 2 0 0 0 2.8 2.8l6.5-6.5a5.4 5.4 0 0 0 6.8-7.2l-2.9 2.9-2.7-.7-.7-2.7z", "rotor"),
]);
export const Coins = icon("coins", [
  c(9.2, 9.2, 5.4),
  p("M14.4 5.6a5.4 5.4 0 0 1 0 12.4"),
  p("M9.9 14.6a5.4 5.4 0 0 0 4.5 3.8"),
]);
export const CreditCard = icon("credit-card", [
  rect(2.6, 5.4, 18.8, 13.2, 3),
  p("M2.6 10.2h18.8"),
  p("M6.6 14.8h3.2"),
]);
export const ReceiptText = icon("receipt-text", [
  p("M5.4 3.4h13.2v17.2l-2.6-1.6-2.6 1.6-2.6-1.6-2.6 1.6-2.8-1.6z"),
  p("M8.8 8.4h6.4"),
  p("M8.8 12.4h4.4"),
]);
export const Group = icon("group", [
  dashed("M4.4 8.6V6.6a2.2 2.2 0 0 1 2.2-2.2h2M15.4 4.4h2a2.2 2.2 0 0 1 2.2 2.2v2M19.6 15.4v2a2.2 2.2 0 0 1-2.2 2.2h-2M8.6 19.6h-2a2.2 2.2 0 0 1-2.2-2.2v-2", "3 3"),
  rect(8, 8, 8, 8, 2.2),
]);
export const Component = icon("component", [
  p("M12 3.4 15.6 7 12 10.6 8.4 7z"),
  p("M17 8.4 20.6 12 17 15.6 13.4 12z"),
  p("M7 8.4 10.6 12 7 15.6 3.4 12z"),
  p("M12 13.4 15.6 17 12 20.6 8.4 17z"),
]);
export const Boxes = icon("boxes", [
  rect(3.2, 12.6, 7.4, 7.4, 2),
  rect(13.4, 12.6, 7.4, 7.4, 2),
  rect(8.3, 4, 7.4, 7.4, 2),
]);
export const Frame = icon("frame", [
  p("M4 8.2h16"),
  p("M4 15.8h16"),
  p("M8.2 4v16"),
  p("M15.8 4v16"),
]);
export const Table = icon("table", [
  rect(3.4, 4.4, 17.2, 15.2, 3),
  p("M3.4 9.8h17.2"),
  p("M9.4 9.8v9.8"),
]);
export const Table2 = Table;
export const Type = icon("type", [
  p("M5 6.6V4.8h14v1.8"),
  p("M12 4.8v14.4"),
  p("M9 19.2h6"),
]);
export const Cloud = icon("cloud", [
  p("M7.2 18.4a4.4 4.4 0 0 1-.5-8.77 5.6 5.6 0 0 1 10.74 1.17A3.8 3.8 0 0 1 16.8 18.4z"),
]);
export const Globe = icon("globe", [
  c(12, 12, 7.8),
  p("M4.4 12h15.2"),
  p("M12 4.2a12 12 0 0 1 0 15.6 12 12 0 0 1 0-15.6", "rotor"),
]);
export const Map = icon("map", [
  p("M9.2 5.2 3.6 7.2v11.6l5.6-2 5.6 2 5.6-2V5.2l-5.6 2z"),
  p("M9.2 5.2v11.6"),
  p("M14.8 7.2v11.6"),
]);
export const Telescope = icon("telescope", [
  p("M12.4 12.6 4.2 10.4l1.3-3.6 8.6 2.1z"),
  p("M14.1 8.9 18.7 6.7l1.6 3.4-5 2.5z"),
  p("M9.1 13.4 6.4 20"),
  p("M12.4 12.6 15.4 20"),
  c(11, 16.4, 2.2),
]);
export const Radio = icon("radio", [
  c(12, 12, 2.4),
  p("M7.4 7.4a6.5 6.5 0 0 0 0 9.2"),
  p("M16.6 16.6a6.5 6.5 0 0 0 0-9.2"),
  p("M4.6 4.6a10.4 10.4 0 0 0 0 14.8"),
  p("M19.4 19.4a10.4 10.4 0 0 0 0-14.8"),
]);
export const Activity = icon("activity", [p("M3.4 12h4l2.6-7 4 14 2.6-7h4")]);
