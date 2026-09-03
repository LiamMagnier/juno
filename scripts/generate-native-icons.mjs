#!/usr/bin/env node
/**
 * Generates the native asset catalogs' Juno navigation icons from the *web's*
 * icon source, so the two can never drift.
 *
 * `src/lib/app-icons.ts` is the canonical mapping from a destination (home,
 * projects, artifacts, …) to its glyph. Those glyphs are Lucide icons, not a
 * bespoke Juno set — so "use the website's icons" means shipping the very same
 * Lucide geometry, read out of the installed `lucide-react` rather than
 * redrawn or approximated by an SF Symbol. Lucide is ISC-licensed, which
 * permits redistribution inside the app bundle.
 *
 * Output: one `.imageset` per destination containing a 24x24 SVG, registered
 * with `preserves-vector-representation` (so it stays crisp at any Dynamic Type
 * size) and `template-rendering-intent` (so SwiftUI tints it with the current
 * foreground colour — which is what makes a single asset work in both light and
 * dark, exactly as the web's `dark:invert` does for the mark).
 *
 * Run: node scripts/generate-native-icons.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lucideDir = join(root, "node_modules/lucide-react/dist/esm/icons");

/**
 * Name -> Lucide icon file. The first group mirrors `src/lib/app-icons.ts`
 * exactly — `AppIcons` (destinations), then `CodeIcons` (the things Juno Code
 * talks about) — and adding a mark there means adding it here too. The asset
 * name is `nav-<key>` throughout, including for the code group, because the
 * prefix is only a flat namespace inside the catalog and renaming the existing
 * eleven would be churn for nothing.
 *
 * The last group is the marks native needs that no `app-icons.ts` row covers,
 * because the web draws them somewhere that isn't a destination list. Each
 * still names its web source below rather than being chosen here: a glyph
 * invented for native is the drift this file exists to prevent.
 *
 * Every key must match a `JunoIcon` case in JunoBrand.swift, whose `assetName`
 * is `nav-<rawValue>` — a key with no case is a dead asset, and a case with no
 * key renders as empty space with no error.
 */
const ICONS = {
  // These two had NOT mirrored app-icons.ts, and they were the two marks it
  // spends the most words rejecting: `home` was Lucide's house and `work` was
  // the briefcase. So the iOS and macOS rails were rendering exactly the glyphs
  // the web had considered and thrown out — the house because it names the
  // route rather than the mode, the briefcase because it says "employment" and
  // collapses to a filled rectangle at 14px. The pair is also the one place the
  // switcher has to make a single distinction legible (talk versus act), and it
  // cannot make it with a building and a bag.
  home: "message-circle",
  work: "zap",
  code: "code-2",
  library: "library",
  artifacts: "layers-3",
  projects: "folder",
  tasks: "calendar-clock",
  connections: "plug",
  pulls: "git-pull-request",
  conversation: "message-circle",
  new: "plus",
  search: "search",
  settings: "settings",

  cloud: "cloud",
  device: "laptop",
  branch: "git-branch",
  lock: "lock",
  permission: "shield-alert",
  pin: "pin",
  error: "circle-alert",
  refresh: "refresh-cw",
  external: "arrow-up-right",
  file: "file-text",

  // ComposerIcons — what the "+" menu adds to a message, and the tools it arms.
  attach: "paperclip",
  photos: "image-plus",
  files: "file-up",
  canvas: "square-pen",
  research: "telescope",
  web: "globe",
  artifactsTool: "layout-template",
  memory: "notebook-pen",

  // Settings, profile & sections
  usage: "chart-bar",
  appearance: "palette",
  writing: "align-left",
  language: "globe",
  models: "cpu",
  notifications: "bell",
  about: "info",
  user: "user",
  tools: "wrench",
  knowledge: "book-open",
  sliders: "sliders-horizontal",

  // Action controls & navigation glyphs
  mic: "mic",
  send: "arrow-up",
  stop: "square",
  plus: "plus",
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  chevronDown: "chevron-down",
  chevronUp: "chevron-up",
  trash: "trash-2",
  pencil: "pencil",
  copy: "copy",
  check: "check",
  close: "x",
  ellipsis: "ellipsis",
  share: "share-2",
  terminal: "terminal",
  arrowDown: "arrow-down",
  volume: "volume-2",
  thumbsUp: "thumbs-up",
  thumbsDown: "thumbs-down",
  eyeOff: "eye-off",

  // Added 2026-09-03 for the macOS rework (Codex-class Code shell, message
  // actions, native lists). Every key has a matching `JunoIcon` case.
  folderOpen: "folder-open",
  folderPlus: "folder-plus",
  clock: "clock",
  history: "history",
  shield: "shield",
  compass: "compass",
  blocks: "blocks",
  play: "play",
  pause: "pause",
  gitCommit: "git-commit-horizontal",
  fork: "git-fork",
  fileDiff: "file-diff",
  list: "list",
  grid: "layout-grid",
  image: "image",
  circleDot: "circle-dot",
  loader: "loader-circle",
  agents: "users",
  archive: "archive",
  download: "download",
  filter: "list-filter",
  eye: "eye",
  message: "message-square-text",
  bell: "bell",
  arrowUp: "arrow-up",
  arrowLeft: "arrow-left",
  arrowRight: "arrow-right",
  minus: "minus",
  box: "box",
  key: "key-round",
  link: "link",
  sun: "sun",
  moon: "moon",
  monitor: "monitor",
  home2: "house",

  // Status and state marks — the web's `StatusIcons` plus the Lucide glyphs
  // its lists draw beside a row's state. Added so every SF Symbol name still
  // crossing a package boundary resolves to a real mark (see the exact table
  // in JunoBrand.swift) instead of a fallback wrench.
  triangleAlert: "triangle-alert",
  circleCheck: "circle-check",
  circleX: "circle-x",
  circleMinus: "circle-minus",
  circleHelp: "circle-help",
  circleDashed: "circle-dashed",
  circleSlash: "circle-slash",
  circle: "circle",
  circlePause: "circle-pause",
  circlePlay: "circle-play",
  circleStop: "circle-stop",
  badgeCheck: "badge-check",
  chevronsUpDown: "chevrons-up-down",
  compose: "square-pen",
  fileSearch: "file-search",
  filePlus: "file-plus",
  fileCode: "file-code",
  fileQuestion: "file-question",
  clockCheck: "clock-check",
  clockAlert: "clock-alert",
  calendarCheck: "calendar-check",
  hourglass: "hourglass",
  octagonX: "octagon-x",
  wifiOff: "wifi-off",
  sparkles: "sparkles",
  panelRight: "panel-right",
  panelLeft: "panel-left",
  columns: "columns-2",
  appWindow: "app-window",
  diff: "diff",
  phoneOff: "phone-off",
  userCircle: "circle-user",
  penTool: "pen-tool",
  micOff: "mic-off",
  lockOpen: "lock-open",
  monitorOff: "monitor-off",
  crop: "crop",
  crosshair: "crosshair",
  binoculars: "binoculars",
  maximize: "maximize-2",
  undo: "undo-2",
  rotateCcw: "rotate-ccw",
  quote: "text-quote",
  brain: "brain",
  chartLine: "chart-line",
  hand: "hand",
  gauge: "gauge",
  shieldCheck: "shield-check",
  shieldOff: "shield-off",
  dollar: "dollar-sign",
  equal: "equal",
  location: "map-pin",
  textCursor: "text-cursor",
  listChecks: "list-checks",
  layoutList: "layout-list",
  power: "power",
  upload: "upload",
  cloudOff: "cloud-off",
  unlink: "unlink",
  logOut: "log-out",
  flag: "flag",
  imageOff: "image-off",
  activity: "activity",
  gitMerge: "git-merge",
  volumeX: "volume-x",
  ellipsisVertical: "ellipsis-vertical",
  squareStack: "square-stack",
  paperclip: "paperclip",

  // The last SF Symbol names the shared packages still spelled out: the
  // Markdown task-list checkbox, and the block headers over Mermaid diagrams,
  // each named for what the diagram is. Every key has a `JunoIcon` case.
  squareCheck: "square-check",
  square: "square",
  arrowLeftRight: "arrow-left-right",
  workflow: "workflow",
  chartPie: "chart-pie",
  chartGantt: "chart-gantt",
  waypoints: "waypoints",
};

const TARGETS = [
  join(root, "native/iOS/JunoMobile/Resources/Assets.xcassets/Navigation"),
  join(root, "native/macOS/JunoDesktop/Resources/Navigation.xcassets"),
];

/** Follows `export { default } from './other.mjs'` re-exports to the real node. */
function readIconNode(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`re-export cycle at ${name}`);
  seen.add(name);
  const file = join(lucideDir, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`no Lucide icon '${name}'`);
  const src = readFileSync(file, "utf8");

  const reexport = src.match(/export \{ default \} from '\.\/([^']+)\.mjs'/);
  if (reexport) return readIconNode(reexport[1], seen);

  const body = src.match(/const __iconNode = (\[[\s\S]*?\]);/);
  if (!body) throw new Error(`no __iconNode in ${name}`);
  // The literal is plain JSON-ish JS (tag + attribute object per element).
  return new Function(`return ${body[1]}`)();
}

/** Lucide's canonical presentation attributes, per its own <svg> wrapper. */
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
  ' fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

function toSVG(node) {
  const els = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `  <${tag} ${a}/>`;
    })
    .join("\n");
  return `${SVG_OPEN}\n${els}\n</svg>\n`;
}

const contents = (svgName) =>
  JSON.stringify(
    {
      images: [{ filename: svgName, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  ) + "\n";

let count = 0;
for (const target of TARGETS) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // Deliberately *not* `provides-namespace`. A namespaced group compiles the
  // asset as "Navigation/nav-projects", so `Image("nav-projects")` resolves to
  // nothing — and a missing image in SwiftUI renders as empty space with no
  // error, so the mistake is invisible until someone looks at the screen. The
  // sibling Providers catalog is flat for the same reason.
  writeFileSync(
    join(target, "Contents.json"),
    JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n",
  );

  for (const [destination, lucideName] of Object.entries(ICONS)) {
    const set = join(target, `nav-${destination}.imageset`);
    mkdirSync(set, { recursive: true });
    const svg = `nav-${destination}.svg`;
    writeFileSync(join(set, svg), toSVG(readIconNode(lucideName)));
    writeFileSync(join(set, "Contents.json"), contents(svg));
    count += 1;
  }
}

console.log(`Generated ${count} navigation icons across ${TARGETS.length} asset catalogs.`);
console.log(`Source: lucide-react (ISC), mirroring the marks the web already draws.`);
