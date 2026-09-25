#!/usr/bin/env node
/**
 * Generates the native apps' icon set from the *web's* icon sources, so the
 * two can never drift.
 *
 * The web draws every glyph through `src/components/ui/icons.tsx`: Phosphor
 * geometry (MIT) on its 256-unit grid at the house `regular` weight, the `bold`
 * cut at 13px and under, and `fill` for an "on" state — plus five marks drawn
 * for Juno (`juno-glyphs.tsx`, whose geometry is `juno-glyph-paths.ts`).
 * `src/lib/app-icons.ts` decides which drawing each concept wears. This script
 * ships those very drawings, read out of the installed `@phosphor-icons/react`
 * and out of `juno-glyph-paths.ts`, rather than approximating them with SF
 * Symbols or redrawing them.
 *
 * OUTPUT: one custom-symbol template (`.symbolset`) per cut, static — a single
 * Regular-M glyph, which the system uses at every weight and scale. A symbol
 * rather than an image because a symbol sizes like an SF Symbol: in a sidebar
 * row, a menu item or `Label(_:image:)` it takes the text's size and baseline
 * instead of the asset's own box. Static rather than variable because
 * Phosphor's weights are separate drawings, not masters that interpolate.
 *
 * - `ph.<name>` — lowercase, hyphen-free Phosphor names — with a `.bold` twin
 *   for every glyph (the cut `JunoIconView` draws at 13pt and under, as the web
 *   does at 13px) and a `.fill` twin where an "on" state needs one.
 * - `juno.chat`, `juno.code`, `juno.design`, `juno.library`, `juno.agents`,
 *   `juno.send`, `juno.ghost` (the private-chat ghost), with the same twins.
 *
 * THE BOX. The 256 grid is set at 16/14 of the symbol's point size: the web's
 * house pairing is a 16px glyph beside 14px text (`size-4` in `text-sm`), so a
 * symbol in a 13pt menu row stands to its label as the web's glyph does to
 * its. That puts Phosphor's live area within a few percent of an SF Symbol's at
 * the same size. The horizontal margins are the whole box, so every glyph has
 * the same advance and a column of them aligns; vertically the box is centred
 * on the cap height, where SF Symbols centre.
 *
 * JUNO'S MARKS are strokes, and a symbol is fills only, so each cut is outlined
 * once — `--outline-juno`, on a Mac, via Core Graphics
 * (`scripts/outline-glyph-strokes.swift`) — and committed under
 * `scripts/icon-sources/juno/`. Each file carries a hash of the drawing it was
 * outlined from, so a mark redrawn in `juno-glyph-paths.ts` without
 * re-outlining fails the check here, and CI never needs Swift.
 *
 * Run:
 *   node scripts/generate-native-icons.mjs                  write both catalogs
 *   node scripts/generate-native-icons.mjs --check          exit 1 on any drift
 *   node scripts/generate-native-icons.mjs --outline-juno   re-outline Juno's marks (macOS)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { junoGhostDrawing, junoGlyphDrawing } from "../src/components/ui/juno-glyph-paths.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const phosphorDefs = join(root, "node_modules/@phosphor-icons/react/dist/defs");
const junoSources = join(root, "scripts/icon-sources/juno");
const iconsModule = join(root, "src/components/ui/icons.tsx");
const registries = join(root, "src/lib/app-icons.ts");
const swiftIcons = join(root, "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoBrand.swift");

/**
 * Every Phosphor drawing the apps ship, by Phosphor's own component name, with
 * the `icons.tsx` export that draws it on the web. The check below reads
 * icons.tsx and fails if that export has moved to another drawing, so a glyph
 * swapped on the web cannot quietly stay the old one here.
 *
 * `null` marks a glyph the web does not currently draw, kept because a native
 * surface names that concept (a notifications row, a Code palette's Plugins,
 * a colour-scheme row) — each is Phosphor's own drawing for it, never an
 * invention, and never a sparkle or a brain standing in for "AI" (§10.2).
 */
const PHOSPHOR = {
  // AppIcons — the destinations.
  TreeStructure: "Workflow",
  Stack: "Layers3",
  Folder: "Folder",
  FolderOpen: "FolderOpen",
  CalendarDots: "CalendarClock",
  Plug: "Plug",
  GitPullRequest: "GitPullRequest",
  Plus: "Plus",
  MagnifyingGlass: "Search",
  GearSix: "Settings",
  Robot: "Bot",
  Scroll: "ScrollText",
  ShieldCheck: "ShieldCheck",

  // CodeIcons — the things Juno Code talks about.
  Cloud: "Cloud",
  Laptop: "Laptop",
  GitBranch: "GitBranch",
  LockSimple: "Lock",
  ShieldWarning: "ShieldAlert",
  PushPin: "Pin",
  WarningCircle: "AlertCircle",
  ArrowClockwise: "RefreshCw",
  ArrowUpRight: "ArrowUpRight",
  FileText: "FileText",

  // ComposerIcons — what the "+" menu adds, and the tools it arms.
  Paperclip: "Paperclip",
  ImageSquare: "ImagePlus",
  FileArrowUp: "FileUp",
  NotePencil: "SquarePen",
  Binoculars: "Telescope",
  GlobeSimple: "Globe",
  Layout: "LayoutTemplate",
  Scan: "Scan",

  // StatusIcons, ActionIcons and the message action row.
  Warning: "TriangleAlert",
  Info: "Info",
  Check: "Check",
  SealCheck: "BadgeCheck",
  PencilSimple: "Pencil",
  Trash: "Trash2",
  X: "X",
  Copy: "Copy",
  ArrowCounterClockwise: "RotateCcw",
  ShareNetwork: "Share2",
  LinkSimple: "Link2",
  LinkSimpleBreak: "Link2Off",
  DownloadSimple: "Download",
  UploadSimple: "Upload",
  DotsThree: "MoreHorizontal",
  SlidersHorizontal: "SlidersHorizontal",
  ThumbsUp: "ThumbsUp",
  ThumbsDown: "ThumbsDown",
  SpeakerHigh: "Volume2",
  Quotes: "TextQuote",
  GitFork: "GitFork",
  Archive: "Archive",
  BoxArrowUp: "ArchiveRestore",
  PushPinSlash: "PinOff",
  SignOut: "LogOut",

  // SettingsIcons — the settings rail.
  UserGear: "UserPen",
  // A model is a thing you pick off a shelf, not a processor (app-icons.ts).
  Cube: "Cube",
  Database: "Database",
  User: "User",
  CreditCard: "CreditCard",

  // Voice and media.
  Microphone: "Mic",
  MicrophoneSlash: "MicOff",
  Waveform: "AudioLines",
  PhoneDisconnect: "PhoneOff",
  MonitorArrowUp: "MonitorUp",
  Screencast: "MonitorX",
  Square: "Square",
  Play: "Play",
  Pause: "Pause",
  PlayCircle: "PlayCircle",
  PauseCircle: "PauseCircle",
  StopCircle: "StopCircle",
  // A task's meter: Elapsed, Cost, Tokens (`WorkLiveMeter`).
  Timer: "Timer",
  Coins: "Coins",
  Sigma: "Sigma",
  Image: "Image",
  ImageBroken: "ImageOff",
  Crop: "Crop",
  Crosshair: "Crosshair",

  // Direction and navigation.
  CaretLeft: "ChevronLeft",
  CaretRight: "ChevronRight",
  CaretDown: "ChevronDown",
  CaretUp: "ChevronUp",
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowsOutSimple: "Maximize2",
  ArrowUUpLeft: "Undo2",
  ClockCounterClockwise: "History",
  SidebarSimple: "PanelLeft",
  DotsThreeVertical: null,
  CaretUpDown: "ChevronsUpDown",
  ArrowsLeftRight: null,

  // Objects, people and state.
  TerminalWindow: "Terminal",
  EyeSlash: "EyeOff",
  Eye: "Eye",
  Clock: "Clock",
  GitDiff: "GitCompare",
  ListBullets: "List",
  ListChecks: "ListChecks",
  SquaresFour: "LayoutGrid",
  Columns: "Columns2",
  CircleNotch: "Loader2",
  ChatText: "MessageSquareText",
  Minus: "Minus",
  Package: "Boxes",
  Key: "KeyRound",
  Sun: "Sun",
  Moon: "Moon",
  Monitor: "Monitor",
  BookOpen: "BookOpen",
  Wrench: "Wrench",
  CheckCircle: "CheckCircle2",
  XCircle: "XCircle",
  Question: "HelpCircle",
  CircleDashed: "CircleDashed",
  ProhibitInset: "CircleSlash",
  Prohibit: "Ban",
  Circle: "Circle",
  FileMagnifyingGlass: "FileSearch",
  FileCode: "FileCode",
  WifiSlash: "WifiOff",
  Sparkle: "Sparkles",
  PenNib: "PenTool",
  LockSimpleOpen: "LockOpen",
  Hand: "Hand",
  ShieldSlash: "ShieldOff",
  Pulse: "Activity",
  Cards: null,
  CloudSlash: null,

  // Named by a native surface only; each is Phosphor's own drawing of it.
  ChartBar: null,
  Palette: null,
  TextAlignLeft: null,
  BellSimple: "Bell",
  FolderPlus: null,
  Shield: null,
  Compass: null,
  PuzzlePiece: null,
  GitCommit: null,
  GitMerge: null,
  Record: null,
  House: null,
  MinusCircle: null,
  FilePlus: null,
  FileDashed: null,
  CalendarCheck: null,
  ClockCountdown: null,
  Hourglass: null,
  AppWindow: null,
  UserCircle: null,
  Brain: null,
  ChartLine: null,
  ChartPie: null,
  ChartBarHorizontal: null,
  Gauge: null,
  CurrencyDollar: null,
  Equals: null,
  MapPin: null,
  CursorText: null,
  Rows: null,
  Power: null,
  Flag: null,
  SpeakerX: null,
  CheckSquare: null,
  Graph: null,

  // The transcript (Phase 2): the Regenerate menu, Continue, generated video,
  // links that leave the app, and a React artifact's brackets.
  ListDashes: "ListMinus",
  ListPlus: "ListPlus",
  ArrowElbowDownRight: "CornerDownRight",
  VideoCamera: "Video",
  ArrowSquareOut: "ExternalLink",
  Code: "Code2",

  // The run's tool rows (the Tool calls & research rework, SPEC §3.1's
  // ToolIconKind): `calculate` and `search_chats` wear Phosphor's own
  // drawings for those concepts.
  Calculator: null,
  Chats: null,
};

/** Glyphs with a `.fill` twin: the "on" drawings §8.6 asks for — a pinned row,
 *  the stop face, a rated reply. Must match `JunoIcon.filledSymbols`. */
const FILLED = new Set(["PushPin", "Square", "ThumbsUp", "ThumbsDown"]);

/** Glyphs the web draws mirrored (`glyph(…, { mirrored: true })`), shipped as a
 *  mirrored copy so every native path — `Image`, `NSImage(named:)`, a menu —
 *  draws it the right way round. */
const MIRRORED = new Set(["SidebarSimple"]);

/** Juno's own marks: the drawing, and the cuts each ships. */
const JUNO = {
  "juno.chat": { drawing: (w) => junoGlyphDrawing("chat", w), cuts: ["regular", "bold", "fill"] },
  "juno.code": { drawing: (w) => junoGlyphDrawing("code", w), cuts: ["regular", "bold", "fill"] },
  "juno.design": { drawing: (w) => junoGlyphDrawing("design", w), cuts: ["regular", "bold", "fill"] },
  "juno.library": { drawing: (w) => junoGlyphDrawing("library", w), cuts: ["regular", "bold", "fill"] },
  "juno.agents": { drawing: (w) => junoGlyphDrawing("agents", w), cuts: ["regular", "bold", "fill"] },
  // The web's Send `fill` is the bold drawing again, so there is nothing to add.
  "juno.send": { drawing: (w) => junoGlyphDrawing("send", w), cuts: ["regular", "bold"] },
  "juno.ghost": { drawing: (w) => junoGhostDrawing(w), cuts: ["regular", "bold", "fill"] },
};

const TARGETS = [
  {
    // A catalog of its own, so the set can be replaced wholesale.
    dir: join(root, "native/macOS/JunoDesktop/Resources/Icons.xcassets"),
    legacy: join(root, "native/macOS/JunoDesktop/Resources/Navigation.xcassets"),
  },
  {
    // A folder inside the app's catalog (no project change needed to add it).
    dir: join(root, "native/iOS/JunoMobile/Resources/Assets.xcassets/Icons"),
    legacy: join(root, "native/iOS/JunoMobile/Resources/Assets.xcassets/Navigation"),
  },
];

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Reads one Phosphor icon's per-weight path data out of its `defs` module by
 *  evaluating it against a stub `React.createElement`. */
function readPhosphor(name) {
  const file = join(phosphorDefs, `${name}.es.js`);
  if (!existsSync(file)) throw new Error(`no Phosphor icon '${name}' in @phosphor-icons/react`);
  const src = readFileSync(file, "utf8");
  const ns = src.match(/import \* as (\w+) from "react";/)?.[1];
  const mapVar = src.match(/export \{\s*(\w+) as default\s*\}/)?.[1];
  if (!ns || !mapVar) throw new Error(`unrecognised Phosphor module shape: ${name}`);
  const body = src.replace(/import \* as \w+ from "react";/, "").replace(/export \{[\s\S]*?\};?\s*$/, "");
  const stub = { Fragment: "fragment", createElement: (tag, props, ...children) => ({ tag, props, children }) };
  const weights = new Function(ns, `${body}\nreturn ${mapVar};`)(stub);
  const paths = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (node.tag === "path") {
      if (node.props.opacity != null) throw new Error(`${name}: translucent path in a shipped weight`);
      out.push(node.props.d);
    } else if (node.tag !== "fragment") {
      throw new Error(`${name}: unexpected <${node.tag}>`);
    }
    for (const child of node.children ?? []) paths(child, out);
    return out;
  };
  return (weight) => {
    const tree = weights.get(weight);
    if (!tree) throw new Error(`${name} has no '${weight}' weight`);
    return paths(tree);
  };
}

/** `export const Name = glyph(SomeIcon, …)` → { Name: "Some" }, following the
 *  file's import aliases and `export const A = B` re-exports. */
function readWebExports() {
  const src = readFileSync(iconsModule, "utf8");
  const aliases = new Map();
  for (const [, from, to] of src.matchAll(/\b(\w+Icon) as (\w+)\b/g)) aliases.set(to, from);
  const exports = new Map();
  for (const [, name, base] of src.matchAll(/export const (\w+) = glyph\((\w+),/g)) {
    const real = aliases.get(base) ?? base;
    exports.set(name, real.endsWith("Glyph") ? `juno:${real}` : real.replace(/Icon$/, ""));
  }
  for (const [, name, target] of src.matchAll(/export const (\w+) = (\w+);/g)) {
    if (exports.has(target)) exports.set(name, exports.get(target));
  }
  return exports;
}

/** The registries in app-icons.ts: `{ AppIcons: { home: "JunoChat", … }, … }`. */
function readRegistries() {
  const src = readFileSync(registries, "utf8");
  const out = {};
  for (const [, group, body] of src.matchAll(/export const (\w+Icons) = \{([\s\S]*?)\n\} as const/g)) {
    out[group] = {};
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const [, key, value] of code.matchAll(/(\w+):\s*(\w+),/g)) out[group][key] = value;
  }
  return out;
}

/** `JunoIcon.symbolName`'s switch: case name → symbol name. */
function readSwiftSymbols() {
  const src = readFileSync(swiftIcons, "utf8");
  const start = src.indexOf("public var symbolName: String {");
  if (start < 0) throw new Error("JunoBrand.swift: no `symbolName` switch");
  const body = src.slice(start, src.indexOf("\n    }\n", start));
  const map = new Map();
  for (const [, cases, symbol] of body.matchAll(/case\s+((?:\.\w+\s*,\s*)*\.\w+)\s*:\s*"([a-z0-9.]+)"/g)) {
    for (const name of cases.split(",")) map.set(name.trim().slice(1), symbol);
  }
  const filledStart = src.indexOf("static let filledSymbols");
  if (filledStart < 0) throw new Error("JunoBrand.swift: no `filledSymbols` set");
  const filledBody = src.slice(filledStart, src.indexOf("]", filledStart));
  const filled = new Set([...filledBody.matchAll(/"([a-z0-9.]+)"/g)].map((m) => m[1]));
  return { map, filled };
}

// ---------------------------------------------------------------------------
// Juno's marks: outlined once, committed, verified by hash
// ---------------------------------------------------------------------------

/** A drawing's elements in paint order, with each group (`g`, a part the web
 *  moves as one) replaced by its children: a symbol has no moving parts. */
function flatten(elements) {
  return elements.flatMap((element) => (element.tag === "g" ? flatten(element.children ?? []) : [element]));
}

/** A drawing with every element's paint resolved against the root `<svg>`
 *  (`fill="none"`, a stroke at `line`), in the shape the outliner reads. */
function outlineJob(name, drawing) {
  return {
    name,
    viewBox: drawing.viewBox,
    elements: flatten(drawing.elements).map(({ tag, attrs, knockout }) => {
      const fill = attrs.fill != null && attrs.fill !== "none";
      const stroked = attrs.stroke == null || attrs.stroke !== "none";
      const geometry =
        tag === "path"
          ? { d: String(attrs.d) }
          : tag === "circle"
            ? { cx: +attrs.cx, cy: +attrs.cy, r: +attrs.r }
            : { x: +attrs.x, y: +attrs.y, width: +attrs.width, height: +attrs.height, rx: +(attrs.rx ?? 0) };
      return {
        kind: tag,
        ...geometry,
        fill,
        evenOdd: attrs.fillRule === "evenodd",
        strokeWidth: stroked ? +(attrs.strokeWidth ?? drawing.line) : null,
        knockout: Boolean(knockout),
      };
    }),
  };
}

function cutName(base, cut) {
  return cut === "regular" ? base : `${base}.${cut}`;
}

function junoJobs() {
  const jobs = [];
  for (const [base, { drawing, cuts }] of Object.entries(JUNO)) {
    for (const cut of cuts) jobs.push(outlineJob(cutName(base, cut), drawing(cut)));
  }
  return jobs;
}

const digest = (job) => createHash("sha256").update(JSON.stringify(job)).digest("hex").slice(0, 16);

function outlineJuno() {
  if (process.platform !== "darwin") throw new Error("--outline-juno needs macOS (Core Graphics)");
  const jobs = junoJobs();
  const scratch = mkdtempSync(join(tmpdir(), "juno-outline-"));
  const input = join(scratch, "jobs.json");
  writeFileSync(input, JSON.stringify(jobs));
  let out;
  try {
    out = execFileSync("xcrun", ["swift", join(root, "scripts/outline-glyph-strokes.swift"), input], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const outlines = JSON.parse(out);
  rmSync(junoSources, { recursive: true, force: true });
  mkdirSync(junoSources, { recursive: true });
  for (const job of jobs) {
    const d = outlines[job.name];
    if (!d) throw new Error(`outliner returned nothing for ${job.name}`);
    writeFileSync(
      join(junoSources, `${job.name}.svg`),
      `<!-- ${job.name}: outlined from src/components/ui/juno-glyph-paths.ts by ` +
        `\`node scripts/generate-native-icons.mjs --outline-juno\`. Do not edit. -->\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" data-source="${digest(job)}">\n` +
        `  <path d="${d}"/>\n</svg>\n`,
    );
  }
  console.log(`Outlined ${jobs.length} Juno mark cuts into ${relative(root, junoSources)}.`);
}

/** The committed outline for a Juno cut, refusing one whose drawing changed. */
function readJunoOutline(job) {
  const file = join(junoSources, `${job.name}.svg`);
  const fix = "re-run `node scripts/generate-native-icons.mjs --outline-juno` on a Mac";
  if (!existsSync(file)) throw new Error(`${relative(root, file)} is missing — ${fix}`);
  const src = readFileSync(file, "utf8");
  const stamp = src.match(/data-source="([0-9a-f]+)"/)?.[1];
  if (stamp !== digest(job)) {
    throw new Error(`${job.name} changed in juno-glyph-paths.ts since it was outlined — ${fix}`);
  }
  return [...src.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Symbol templates
// ---------------------------------------------------------------------------

// Apple's template artboard, at the 100pt it is typeset at. Only the guides the
// compiler reads are drawn: baseline and capline for each scale, and fixed
// margins for the one glyph.
const CAP_HEIGHT = 70.459;
const BASELINE = { S: 696, M: 1126, L: 1556 };
const BOX = (100 * 16) / 14;
const SCALE = BOX / 256;
const LEFT = 1391;
const n4 = (v) => String(Math.round(v * 10000) / 10000);

function symbolTemplate(asset, source, paths, { mirrored = false } = {}) {
  const top = BASELINE.M - CAP_HEIGHT / 2 - 128 * SCALE;
  const transform = mirrored
    ? `matrix(${n4(-SCALE)} 0 0 ${n4(SCALE)} ${n4(LEFT + BOX)} ${n4(top)})`
    : `matrix(${n4(SCALE)} 0 0 ${n4(SCALE)} ${LEFT} ${n4(top)})`;
  const guide = (id, x1, x2, y1, y2) =>
    `  <line id="${id}" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="${x1}" x2="${x2}" y1="${y1}" y2="${y2}"/>`;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- ${asset}: ${source}. Generated by scripts/generate-native-icons.mjs; do not edit. -->`,
    `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="3300" height="2200">`,
    ` <g id="Notes">`,
    `  <rect height="2200" id="artboard" style="fill:white;opacity:1" width="3300" x="0" y="0"/>`,
    `  <text id="template-version" style="stroke:none;fill:black;font-family:sans-serif;font-size:13;text-anchor:end;" transform="matrix(1 0 0 1 3036 1933)">Template v.3.0</text>`,
    ` </g>`,
    ` <g id="Guides">`,
  ];
  for (const [size, y] of Object.entries(BASELINE)) {
    lines.push(guide(`Baseline-${size}`, 263, 3036, y, y));
    lines.push(guide(`Capline-${size}`, 263, 3036, n4(y - CAP_HEIGHT), n4(y - CAP_HEIGHT)));
  }
  const marginTop = n4(BASELINE.M - CAP_HEIGHT - 25);
  const marginBottom = n4(BASELINE.M + 25);
  lines.push(guide("left-margin-Regular-M", LEFT, LEFT, marginTop, marginBottom));
  lines.push(guide("right-margin-Regular-M", n4(LEFT + BOX), n4(LEFT + BOX), marginTop, marginBottom));
  lines.push(` </g>`, ` <g id="Symbols">`, `  <g id="Regular-M" transform="${transform}">`);
  for (const d of paths) {
    lines.push(`   <path class="monochrome-0 multicolor-0:tintColor hierarchical-0:primary SFSymbolsPreviewWireframe" d="${d}"/>`);
  }
  lines.push(`  </g>`, ` </g>`, `</svg>`, ``);
  return lines.join("\n");
}

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const symbolContents = (svg) =>
  json({ info: { author: "xcode", version: 1 }, symbols: [{ filename: svg, idiom: "universal" }] });

/** Every symbol, by asset name → template source. */
function buildSymbols() {
  const symbols = new Map();
  for (const name of Object.keys(PHOSPHOR)) {
    const weights = readPhosphor(name);
    const base = `ph.${name.toLowerCase()}`;
    const cuts = FILLED.has(name) ? ["regular", "bold", "fill"] : ["regular", "bold"];
    for (const cut of cuts) {
      const source = `Phosphor ${name}, ${cut} (@phosphor-icons/react, MIT)`;
      symbols.set(cutName(base, cut), symbolTemplate(cutName(base, cut), source, weights(cut)));
      if (MIRRORED.has(name)) {
        const asset = cutName(`${base}.mirrored`, cut);
        symbols.set(asset, symbolTemplate(asset, `${source}, mirrored`, weights(cut), { mirrored: true }));
      }
    }
  }
  for (const job of junoJobs()) {
    symbols.set(job.name, symbolTemplate(job.name, "Juno's own mark, juno-glyph-paths.ts", readJunoOutline(job)));
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Consistency with the web and with JunoIcon
// ---------------------------------------------------------------------------

const JUNO_EXPORTS = {
  JunoChatGlyph: "juno.chat",
  JunoCodeGlyph: "juno.code",
  JunoDesignGlyph: "juno.design",
  JunoLibraryGlyph: "juno.library",
  JunoAgentsGlyph: "juno.agents",
  JunoSendGlyph: "juno.send",
};

function checkSources(symbols) {
  const problems = [];

  // 1. Each glyph is still the one its web export draws.
  const web = readWebExports();
  for (const [name, exportName] of Object.entries(PHOSPHOR)) {
    if (exportName == null) continue;
    const drawn = web.get(exportName);
    if (drawn !== name) {
      problems.push(`icons.tsx: ${exportName} draws ${drawn ?? "nothing"}, but PHOSPHOR ships ${name} for it`);
    }
  }

  // 2. Every JunoIcon case resolves to a shipped symbol with a bold cut, and
  //    every shipped symbol is worn by some case (else it is a dead asset).
  const { map: swift, filled } = readSwiftSymbols();
  for (const [icon, symbol] of swift) {
    if (!symbols.has(symbol)) problems.push(`JunoIcon.${icon} names ${symbol}, which is not generated`);
    else if (!symbols.has(`${symbol}.bold`)) problems.push(`JunoIcon.${icon}: ${symbol} has no .bold cut`);
  }
  const worn = new Set(swift.values());
  for (const asset of symbols.keys()) {
    if (!/\.(bold|fill)$/.test(asset) && !worn.has(asset)) {
      problems.push(`${asset} is generated but no JunoIcon case wears it`);
    }
  }
  const shippedFills = new Set([...symbols.keys()].filter((k) => k.endsWith(".fill")).map((k) => k.slice(0, -5)));
  for (const f of filled) {
    if (!shippedFills.has(f)) problems.push(`JunoIcon.filledSymbols lists ${f}, which has no .fill cut`);
  }
  for (const f of shippedFills) {
    if (!filled.has(f)) problems.push(`${f}.fill is generated but JunoIcon.filledSymbols omits it`);
  }

  // 3. A JunoIcon case named for a registry key wears that key's drawing.
  for (const [group, entries] of Object.entries(readRegistries())) {
    for (const [key, exportName] of Object.entries(entries)) {
      if (!swift.has(key)) continue;
      const drawn = web.get(exportName);
      if (!drawn) {
        problems.push(`app-icons.ts: ${group}.${key} is ${exportName}, which icons.tsx does not export`);
        continue;
      }
      const expected = drawn.startsWith("juno:") ? JUNO_EXPORTS[drawn.slice(5)] : `ph.${drawn.toLowerCase()}`;
      if (swift.get(key) !== expected) {
        problems.push(`JunoIcon.${key} wears ${swift.get(key)}, but ${group}.${key} is ${exportName} (${expected})`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** The files a catalog should contain: relative path → contents. */
function catalogFiles(symbols) {
  const files = new Map();
  // Deliberately *not* `provides-namespace`: a namespaced group compiles the
  // asset as "Icons/ph.plus", and `Image("ph.plus")` would resolve to nothing —
  // with no error, just empty space where the glyph should be.
  files.set("Contents.json", json({ info: { author: "xcode", version: 1 } }));
  for (const [asset, svg] of symbols) {
    files.set(`${asset}.symbolset/${asset}.svg`, svg);
    files.set(`${asset}.symbolset/Contents.json`, symbolContents(`${asset}.svg`));
  }
  return files;
}

function listFiles(dir, base = dir, out = new Map()) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === ".DS_Store") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.set(relative(base, full), full);
  }
  return out;
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--outline-juno")) outlineJuno();
  const check = args.has("--check");

  const symbols = buildSymbols();
  const problems = checkSources(symbols);
  const expected = catalogFiles(symbols);

  for (const { dir, legacy } of TARGETS) {
    const where = relative(root, dir);
    if (check) {
      const actual = listFiles(dir);
      for (const [file, contents] of expected) {
        if (!actual.has(file)) problems.push(`${where}: missing ${file}`);
        else if (readFileSync(actual.get(file), "utf8") !== contents) problems.push(`${where}: stale ${file}`);
      }
      for (const file of actual.keys()) if (!expected.has(file)) problems.push(`${where}: unexpected ${file}`);
      if (existsSync(legacy)) problems.push(`${relative(root, legacy)}: the retired Lucide set is back — delete it`);
    } else {
      rmSync(dir, { recursive: true, force: true });
      rmSync(legacy, { recursive: true, force: true });
      for (const [file, contents] of expected) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), contents);
      }
    }
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 40);
    console.error(`[native-icons] ${problems.length} problem(s):\n  ${shown.join("\n  ")}`);
    if (problems.length > shown.length) console.error(`  … and ${problems.length - shown.length} more`);
    if (check) console.error("  Run `npm run native:icons` to regenerate.");
    process.exit(1);
  }

  const phosphor = [...symbols.keys()].filter((k) => k.startsWith("ph.")).length;
  const juno = symbols.size - phosphor;
  console.log(
    check
      ? `[native-icons] up to date — ${symbols.size} symbols (${phosphor} Phosphor, ${juno} Juno) in ${TARGETS.length} catalogs.`
      : `Generated ${symbols.size} symbols (${phosphor} Phosphor, ${juno} Juno) into ${TARGETS.length} catalogs.`,
  );
}

main();
