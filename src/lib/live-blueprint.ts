/**
 * The live blueprint: the page's structure, read from its source as it streams.
 *
 * While Alevr writes an HTML or React artifact the preview cannot render yet
 * (half a document is not a page), so the canvas draws what the source
 * already says: a nav, a hero, three cards, a form, a footer, in reading
 * order, each as a hairline box. This module is the reading half, pure and
 * DOM-free so it is pinned by tests/live-blueprint.test.ts; the drawing half
 * is src/components/canvas/live-blueprint.tsx.
 *
 * It is a tolerant scanner, not a parser. Opening and closing tags (HTML and
 * JSX, with one level of nested braces in attributes) are matched with one
 * regular expression; `<style>` bodies are read for colours; `<script>` and
 * React logic only move the phase. Anything it does not recognise is skipped,
 * never thrown on: the input is half-written by definition.
 *
 * INCREMENTAL. `BlueprintParser.feed()` keeps its scan position, element
 * stack and blocks between calls, so each call only reads what arrived since
 * the last one (a stream only ever appends). If the text is not an extension
 * of what it read before (a regeneration replaced it), it starts over.
 */

import { canonicalLang } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";

// ── The vocabulary ────────────────────────────────────────────────────────────

/** Rows of the page skeleton. */
export type BlueprintRowKind =
  | "nav"
  | "header"
  | "hero"
  | "section"
  | "aside"
  | "footer"
  | "form"
  | "cards"
  | "list"
  | "table"
  | "canvas";

/** Things inside a row. */
export type BlueprintLeafKind = "heading" | "text" | "image" | "button" | "input" | "link";

export type BlueprintKind = BlueprintRowKind | BlueprintLeafKind;

const ROW_KINDS: ReadonlySet<string> = new Set<BlueprintRowKind>([
  "nav",
  "header",
  "hero",
  "section",
  "aside",
  "footer",
  "form",
  "cards",
  "list",
  "table",
  "canvas",
]);

export function isRowKind(kind: BlueprintKind): kind is BlueprintRowKind {
  return ROW_KINDS.has(kind);
}

export interface BlueprintBlock {
  /** Stable for the life of one parse, so a renderer can key on it. */
  id: number;
  kind: BlueprintKind;
  /** Merged siblings ("text ×3") or a container's items ("cards ×3"). */
  count: number;
  /** Heading level, 1–6. */
  level?: number;
  /** Where its opening tag starts in the source, and its 1-based line. */
  offset: number;
  line: number;
  /** The first line of the opening tag, trimmed, for the hover note. */
  snippet: string;
  /** A colour the source gives it (CSS, Tailwind or inline), when cheap to find. */
  ink: string | null;
  /** Rows only: what is inside, flattened to one level. */
  children: BlueprintBlock[];
  /** A row created to hold leaves written outside any row. */
  implicit?: true;
}

/** Where the write cursor is. */
export type BlueprintCursor = "markup" | "style" | "script" | "logic" | "code";

export interface Blueprint {
  blocks: BlueprintBlock[];
  /** Every block drawn, rows and leaves (a merged run counts once). */
  total: number;
  /** Blocks the cap left out. */
  overflow: number;
  /** The source has started saying how things look (CSS rules, utility classes, inline styles). */
  styled: boolean;
  cursor: BlueprintCursor;
  /** The page's own background, when the source sets one (body, html or the root element). */
  pageInk: string | null;
}

/** Blocks drawn at most; beyond this the blueprint stops growing. */
export const BLUEPRINT_MAX_BLOCKS = 60;

/** Kinds a blueprint is drawn for: a page that renders in the web sandbox. */
export function isBlueprintSource(type: ArtifactType | null | undefined, language?: string | null): boolean {
  if (type === "HTML" || type === "REACT") return true;
  if (type !== "CODE") return false;
  const lang = canonicalLang(language);
  return lang === "html" || lang === "tsx" || lang === "jsx";
}

// ── The build phase ───────────────────────────────────────────────────────────

export type BuildPhase = "start" | "setup" | "layout" | "styling" | "wiring" | "rendering";

/**
 * The words for each phase, English source strings for the phrase runtime
 * (usePhrase). Each is true of what the stream is doing at that moment.
 */
export const BUILD_PHASE_COPY: Record<BuildPhase, string> = {
  start: "Starting the page",
  setup: "Setting up components",
  layout: "Laying out the page",
  styling: "Styling the page",
  wiring: "Wiring interactions",
  rendering: "Rendering the preview",
};

/** The block count beside the phase, as plural phrases. */
export const BLOCK_COUNT_FORMS = { one: "block", other: "blocks" } as const;

/**
 * What the build is doing, from where the write cursor is.
 *
 *   stream finished                      → rendering (the sandbox is booting)
 *   inside an unclosed <style>           → styling
 *   inside an unclosed <script>, or
 *   writing hooks and handlers           → wiring
 *   writing component code, no markup    → setup (before any block), else layout
 *   writing markup                       → layout once a block exists, else start
 */
export function buildPhase(bp: Pick<Blueprint, "cursor" | "total"> | null, streaming: boolean): BuildPhase {
  if (!streaming) return "rendering";
  if (!bp) return "start";
  switch (bp.cursor) {
    case "style":
      return "styling";
    case "script":
    case "logic":
      return "wiring";
    case "code":
      return bp.total > 0 ? "layout" : "setup";
    default:
      return bp.total > 0 ? "layout" : "start";
  }
}

// ── Motion ────────────────────────────────────────────────────────────────────

export interface BlueprintMotionPlan {
  /** Pointer tilt of the sheet. */
  tilt: boolean;
  /** Outlines draw on (stroke-dashoffset); otherwise blocks fade in. */
  drawOn: boolean;
  /** Largest tilt, in degrees, on either axis. */
  maxTiltDeg: number;
}

/**
 * What moves. Reduced motion (the OS or the in-app setting, read through
 * lib/motion-preference) keeps every piece of information and drops travel:
 * no tilt, no draw-on, blocks fade in, the phase words cross-fade.
 */
export function blueprintMotionPlan(reduced: boolean): BlueprintMotionPlan {
  return reduced ? { tilt: false, drawOn: false, maxTiltDeg: 0 } : { tilt: true, drawOn: true, maxTiltDeg: 2.5 };
}

/**
 * The sheet's target tilt for a pointer at (`nx`, `ny`), each -1…1 from the
 * centre of the stage. Leaning toward the pointer: right of centre turns the
 * right edge away (positive rotateY), above centre tips the top away.
 */
export function blueprintTilt(nx: number, ny: number, plan: BlueprintMotionPlan): { rx: number; ry: number } {
  if (!plan.tilt) return { rx: 0, ry: 0 };
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  return { rx: -clamp(ny) * plan.maxTiltDeg, ry: clamp(nx) * plan.maxTiltDeg };
}

// ── Colour ────────────────────────────────────────────────────────────────────

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|(?:rgba?|hsla?|oklch|oklab)\([^()]*\)/;

/** The first colour in a CSS value, resolving `var(--x)` from what is known. */
export function colorIn(value: string, vars?: ReadonlyMap<string, string>): string | null {
  const v = value.trim();
  const direct = COLOR_RE.exec(v);
  const variable = /var\(\s*(--[\w-]+)/.exec(v);
  if (direct && (!variable || direct.index < variable.index)) return direct[0];
  if (variable && vars) return vars.get(variable[1]) ?? null;
  if (/^(?:white|black)\b/i.test(v)) return v.toLowerCase().startsWith("white") ? "#ffffff" : "#000000";
  return null;
}

/* Tailwind's palette, close enough for a tint: hue and saturation per family,
   lightness per shade. A blueprint needs "this hero is dark blue", not a
   colour match. */
const TW_FAMILY: Record<string, [number, number]> = {
  slate: [215, 20],
  gray: [220, 10],
  zinc: [240, 5],
  neutral: [0, 0],
  stone: [25, 6],
  red: [0, 80],
  orange: [25, 90],
  amber: [38, 92],
  yellow: [48, 95],
  lime: [84, 80],
  green: [142, 70],
  emerald: [160, 80],
  teal: [173, 75],
  cyan: [189, 85],
  sky: [199, 88],
  blue: [217, 88],
  indigo: [239, 80],
  violet: [258, 85],
  purple: [271, 80],
  fuchsia: [292, 80],
  pink: [330, 80],
  rose: [350, 85],
};
const TW_SHADE: Record<string, number> = {
  "50": 97,
  "100": 94,
  "200": 86,
  "300": 77,
  "400": 66,
  "500": 55,
  "600": 46,
  "700": 38,
  "800": 28,
  "900": 20,
  "950": 12,
};

/** A Tailwind background class's colour: bg-blue-600, bg-[#0b0b0f], from-rose-500, bg-white. */
export function tailwindInk(cls: string): string | null {
  const bare = cls.slice(cls.lastIndexOf(":") + 1);
  const arbitrary = /^(?:bg|from)-\[([^\]]+)\]$/.exec(bare);
  if (arbitrary) return colorIn(arbitrary[1].replace(/_/g, " "));
  if (bare === "bg-white") return "#ffffff";
  if (bare === "bg-black") return "#000000";
  const named = /^(?:bg|from)-([a-z]+)-(\d{2,3})(?:\/\d+)?$/.exec(bare);
  if (!named) return null;
  const family = TW_FAMILY[named[1]];
  const light = TW_SHADE[named[2]];
  if (!family || light === undefined) return null;
  return `hsl(${family[0]} ${family[1]}% ${light}%)`;
}

const UTILITY_RE = /^(?:[a-z]+:)*-?(?:bg|text|p[xytrbl]?|m[xytrbl]?|flex|grid|gap|rounded|shadow|border|w|h|max-w|min-h|font|leading|tracking|items|justify|space-[xy])(?:-|$)/;

// ── The scanner ───────────────────────────────────────────────────────────────

/*
 * An opening or closing tag. Attributes may hold quoted strings and JSX
 * expressions with one level of nested braces (`style={{ a: 1 }}`,
 * `onClick={() => go()}`), so a `>` inside either does not end the tag.
 */
const TAG_RE =
  /<(\/?)([A-Za-z][\w.:-]*)((?:[^<>{}"']|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/g;

const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "track", "wbr", "param"]);

/** React logic being written: the wiring half of a component. */
const LOGIC_RE = /\b(?:use(?:State|Effect|Reducer|Ref|Memo|Callback|LayoutEffect)|addEventListener|setInterval|setTimeout|fetch|function\s+handle\w*|const\s+handle\w*|on[A-Z]\w*\s*=)/;
const CODE_RE = /\b(?:import|export|function|const|let|return|interface|type)\b/;

type Attrs = { classes: string[]; id: string | null; bg: string | null; role: string | null; type: string | null; styled: boolean };

function readAttrs(raw: string): Attrs {
  const cls = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/.exec(raw);
  const classes = (cls?.[1] ?? cls?.[2] ?? cls?.[3] ?? "").split(/\s+/).filter(Boolean);
  const id = /\bid\s*=\s*["']([^"']+)["']/.exec(raw)?.[1] ?? null;
  const role = /\brole\s*=\s*["']([^"']+)["']/.exec(raw)?.[1] ?? null;
  const type = /\btype\s*=\s*["']([^"']+)["']/.exec(raw)?.[1]?.toLowerCase() ?? null;
  const inline = /\bbackground(?:-c|C)?(?:olor)?\s*:\s*["']?([^;"'}]+)/.exec(raw);
  let bg = inline ? colorIn(inline[1]) : null;
  if (!bg) {
    for (const c of classes) {
      bg = tailwindInk(c);
      if (bg) break;
    }
  }
  const styled = !!inline || /\bstyle\s*=/.test(raw) || classes.some((c) => UTILITY_RE.test(c));
  return { classes, id, bg, role, type, styled };
}

type Classified = { kind: BlueprintKind; level?: number } | { item: true } | null;

/* Component names, read for what they say they are. Order matters: CardGrid
   is a grid of cards before it is a card. */
const COMPONENT_RULES: Array<[RegExp, BlueprintKind]> = [
  [/(?:cards|grid|gallery|features|pricing|testimonials|products|team)/, "cards"],
  [/(?:navlink|menuitem|link)$/, "link"],
  [/(?:navbar|^nav|menu|sidebar)/, "nav"],
  [/(?:hero|banner|jumbotron)/, "hero"],
  [/header|topbar/, "header"],
  [/footer/, "footer"],
  [/form|signup|subscribe|newsletter/, "form"],
  [/button|cta/, "button"],
  [/image|img|photo|avatar|logo|picture/, "image"],
  [/canvas|scene|chart|game/, "canvas"],
  [/table/, "table"],
  [/list/, "list"],
  [/input|field|select|textarea|checkbox/, "input"],
  [/heading|title/, "heading"],
  [/paragraph|text|copy/, "text"],
  [/section|panel|block/, "section"],
];

const CARDS_CLASS_RE = /(?:^|[\s:-])(?:cards?-?(?:grid|list|row)|features?|gallery|pricing|testimonials?|products|team|grid-cols-(?:[3-9]|1[0-2]))(?:$|[\s_-])/;
const CARD_CLASS_RE = /(?:^|\s)(?:card|tile)(?:$|\s|-|_)/;
const HERO_CLASS_RE = /\b(?:hero|banner|jumbotron|masthead)\b/;
const BUTTON_CLASS_RE = /\b(?:btn|button|cta)\b/;

interface El {
  name: string;
  /** The block this element made, if any. */
  block: Internal | null;
  /** Leaves and items swallow their descendants: an <img> in a <button> is the button. */
  swallows: boolean;
  /** A cards or list container counts its direct children. */
  counts: boolean;
  /** Implicit card run started by `.card` children of this element. */
  cardRun: Internal | null;
}

interface Internal extends BlueprintBlock {
  attrs: Attrs;
  tag: string;
  children: Internal[];
  parent: Internal | null;
}

export class BlueprintParser {
  private src = "";
  private pos = 0;
  private lineAt = 0;
  private lineCount = 1;
  private stack: El[] = [];
  private rows: Internal[] = [];
  private nextId = 1;
  private total = 0;
  private overflow = 0;
  private styledSeen = false;
  private rules = new Map<string, string>();
  private vars = new Map<string, string>();
  /** Inside an unclosed <style> or <script> opened at `rawStart`. */
  private raw: { tag: "style" | "script"; bodyStart: number } | null = null;
  private lastTagEnd = 0;
  private sawMarkup = false;
  private pageInk: string | null = null;

  constructor(private readonly react = false) {}

  /** Read `content` (the whole source so far) and return the blueprint. */
  feed(content: string): Blueprint {
    if (!content.startsWith(this.src)) this.reset();
    this.src = content;
    this.scan();
    return this.snapshot();
  }

  private reset() {
    this.src = "";
    this.pos = 0;
    this.lineAt = 0;
    this.lineCount = 1;
    this.stack = [];
    this.rows = [];
    this.nextId = 1;
    this.total = 0;
    this.overflow = 0;
    this.styledSeen = false;
    this.rules.clear();
    this.vars.clear();
    this.raw = null;
    this.lastTagEnd = 0;
    this.sawMarkup = false;
    this.pageInk = null;
  }

  private lineOf(offset: number): number {
    // Offsets only grow during a scan, so count forward from the last one.
    for (let i = this.lineAt; i < offset; i++) if (this.src.charCodeAt(i) === 10) this.lineCount++;
    this.lineAt = Math.max(this.lineAt, offset);
    return this.lineCount;
  }

  private scan() {
    const src = this.src;
    while (this.pos < src.length) {
      if (this.raw) {
        const close = src.toLowerCase().indexOf(`</${this.raw.tag}`, this.raw.bodyStart);
        if (close === -1) return; // still inside it
        const end = src.indexOf(">", close);
        if (end === -1) return;
        if (this.raw.tag === "style") this.readCss(src.slice(this.raw.bodyStart, close));
        this.raw = null;
        this.pos = end + 1;
        this.lastTagEnd = this.pos;
        continue;
      }
      TAG_RE.lastIndex = this.pos;
      const m = TAG_RE.exec(src);
      if (!m) return; // the next tag has not finished arriving
      const start = m.index;
      this.pos = start + m[0].length;
      // A type argument (useState<Card[]>, Array<Item>) follows an identifier;
      // a JSX element never does.
      const [, closing, name, rawAttrs, selfClose] = m;
      const before = start > 0 ? src[start - 1] : "";
      if (this.react && !closing && /[\w$.)\]]/.test(before)) continue;
      this.lastTagEnd = this.pos;
      const lower = name.toLowerCase();
      if (closing) {
        this.close(name);
        continue;
      }
      if (lower === "style" || lower === "script") {
        if (lower === "style") this.styledSeen = true;
        if (selfClose) continue;
        this.raw = { tag: lower, bodyStart: this.pos };
        continue;
      }
      this.open(name, rawAttrs ?? "", start, m[0], !!selfClose || VOID.has(lower));
    }
  }

  private close(name: string) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].name === name) {
        this.stack.length = i;
        return;
      }
    }
  }

  private classify(name: string, attrs: Attrs): Classified {
    const lower = name.toLowerCase();
    const cls = attrs.classes.join(" ");
    const inNavLike = this.stack.some((e) => e.block && (e.block.kind === "nav" || e.block.kind === "header" || e.block.kind === "footer"));
    if (/^[A-Z]/.test(name)) {
      const key = lower.replace(/[^a-z]/g, "");
      if (/provider|context|fragment|suspense|router|route|motion/.test(key)) return null;
      if ((key.endsWith("card") || key.startsWith("card") || key.includes("tile")) && !/cards|grid/.test(key)) return { item: true };
      for (const [re, kind] of COMPONENT_RULES) if (re.test(key)) return { kind };
      return null;
    }
    switch (lower) {
      case "nav":
        return { kind: "nav" };
      case "header":
        return { kind: "header" };
      case "footer":
        return { kind: "footer" };
      case "aside":
        return { kind: "aside" };
      case "form":
        return { kind: "form" };
      case "table":
        return { kind: "table" };
      case "canvas":
        return { kind: "canvas" };
      case "section":
      case "article":
        if (HERO_CLASS_RE.test(cls) || (attrs.id && HERO_CLASS_RE.test(attrs.id))) return { kind: "hero" };
        if (CARDS_CLASS_RE.test(cls)) return { kind: "cards" };
        if (CARD_CLASS_RE.test(cls)) return { item: true };
        return { kind: "section" };
      case "ul":
      case "ol":
        if (inNavLike) return null;
        return CARDS_CLASS_RE.test(cls) ? { kind: "cards" } : { kind: "list" };
      case "div":
      case "main":
        if (HERO_CLASS_RE.test(cls) || (attrs.id && HERO_CLASS_RE.test(attrs.id))) return { kind: "hero" };
        if (CARDS_CLASS_RE.test(cls)) return { kind: "cards" };
        if (CARD_CLASS_RE.test(cls)) return { item: true };
        return null;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return { kind: "heading", level: Number(lower[1]) };
      case "p":
      case "blockquote":
        return { kind: "text" };
      case "img":
      case "picture":
      case "video":
        return { kind: "image" };
      case "button":
        return { kind: "button" };
      case "a":
        if (BUTTON_CLASS_RE.test(cls) || attrs.role === "button") return { kind: "button" };
        return inNavLike ? { kind: "link" } : null;
      case "input":
        if (attrs.type === "hidden") return null;
        if (attrs.type === "submit" || attrs.type === "button") return { kind: "button" };
        return { kind: "input" };
      case "textarea":
      case "select":
        return { kind: "input" };
      default:
        return null;
    }
  }

  private open(name: string, rawAttrs: string, offset: number, tagText: string, selfClosing: boolean) {
    const attrs = readAttrs(rawAttrs);
    if (attrs.styled) this.styledSeen = true;
    if (/^[a-z]/.test(name)) this.sawMarkup = true;
    const el: El = { name, block: null, swallows: false, counts: false, cardRun: null };
    const parent = this.stack[this.stack.length - 1] ?? null;
    const swallowed = this.stack.some((e) => e.swallows);

    if (!swallowed) {
      // A direct child of a cards or list container is one of its items.
      if (parent?.counts && parent.block) {
        parent.block.count++;
        el.swallows = true;
      } else {
        const c = this.classify(name, attrs);
        if (c && "item" in c) {
          // A `.card` outside any cards container starts (or extends) a run.
          const holder = parent ?? null;
          const run = holder?.cardRun;
          if (run) run.count++;
          else {
            const block = this.add("cards", attrs, name, offset, tagText);
            if (block && holder) holder.cardRun = block;
          }
          el.swallows = true;
        } else if (!c && attrs.bg && this.rows.length === 0 && this.pageInk === null) {
          // The wrapper that paints the page (body, or React's root div).
          this.pageInk = attrs.bg;
        } else if (c) {
          const block = this.add(c.kind, attrs, name, offset, tagText, "level" in c ? c.level : undefined);
          el.block = block;
          if (block && (c.kind === "cards" || c.kind === "list")) {
            // A container counts its items as they arrive, from none.
            block.count = 0;
            el.counts = true;
          }
          if (!isRowKind(c.kind) || c.kind === "canvas" || c.kind === "table") el.swallows = true;
        }
      }
    }
    if (!selfClosing) this.stack.push(el);
  }

  /** The nearest row this position sits in, through the element stack. */
  private currentRow(): Internal | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const b = this.stack[i].block;
      if (b && isRowKind(b.kind)) return b.parent ?? b;
    }
    return null;
  }

  private add(kind: BlueprintKind, attrs: Attrs, tag: string, offset: number, tagText: string, level?: number): Internal | null {
    const row = this.currentRow();
    const make = (k: BlueprintKind, parent: Internal | null): Internal | null => {
      if (this.total >= BLUEPRINT_MAX_BLOCKS) {
        this.overflow++;
        return null;
      }
      this.total++;
      return {
        id: this.nextId++,
        kind: k,
        count: 1,
        level,
        offset,
        line: this.lineOf(offset),
        snippet: snippetOf(tagText),
        ink: null,
        children: [],
        attrs,
        tag: tag.toLowerCase(),
        parent,
      };
    };

    if (isRowKind(kind)) {
      if (!row) {
        const block = make(kind, null);
        if (block) this.rows.push(block);
        return block;
      }
      // A row inside a row is drawn inside it: the skeleton is two levels.
      const block = make(kind, row);
      if (block) row.children.push(block);
      return block;
    }

    let holder = row;
    if (!holder) {
      const last = this.rows[this.rows.length - 1];
      if (last?.implicit) holder = last;
      else {
        holder = make("section", null);
        if (!holder) return null;
        holder.implicit = true;
        this.rows.push(holder);
      }
    }
    const prev = holder.children[holder.children.length - 1];
    if (prev && prev.kind === kind && kind !== "heading") {
      prev.count++;
      return prev;
    }
    const block = make(kind, holder);
    if (block) holder.children.push(block);
    return block;
  }

  private readCss(css: string) {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const RULE = /([^{}@]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = RULE.exec(body))) {
      const selectors = m[1].trim();
      const decls = m[2];
      if (/(?:^|,)\s*:root\b|(?:^|,)\s*html\b|(?:^|,)\s*body\b/.test(selectors)) {
        const VAR = /(--[\w-]+)\s*:\s*([^;]+)/g;
        let v: RegExpExecArray | null;
        while ((v = VAR.exec(decls))) {
          const color = colorIn(v[2], this.vars);
          if (color) this.vars.set(v[1], color);
        }
      }
      const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(decls);
      const color = bg ? colorIn(bg[1], this.vars) : null;
      if (!color) continue;
      for (const sel of selectors.split(",")) {
        const last = sel.trim().split(/[\s>+~]+/).pop() ?? "";
        const clean = last.replace(/:{1,2}[\w-]+(?:\([^)]*\))?/g, "");
        for (const key of clean.match(/[.#]?[\w-]+/g) ?? []) this.rules.set(key, color);
      }
    }
  }

  private inkOf(b: Internal): string | null {
    if (b.attrs.bg) return b.attrs.bg;
    if (b.attrs.id) {
      const byId = this.rules.get(`#${b.attrs.id}`);
      if (byId) return byId;
    }
    for (let i = b.attrs.classes.length - 1; i >= 0; i--) {
      const byClass = this.rules.get(`.${b.attrs.classes[i]}`);
      if (byClass) return byClass;
    }
    return this.rules.get(b.tag) ?? null;
  }

  private cursor(): BlueprintCursor {
    if (this.raw) return this.raw.tag === "style" ? "style" : "script";
    if (!this.react) return "markup";
    // Import lines name hooks without using them.
    const tail = this.src.slice(Math.max(this.lastTagEnd, this.src.length - 600)).replace(/^\s*import\b[^\n]*$/gm, "");
    if (/<[A-Za-z]/.test(tail)) return "markup"; // a tag is arriving
    if (LOGIC_RE.test(tail)) return "logic";
    if (CODE_RE.test(tail)) return "code";
    return this.sawMarkup ? "markup" : "code";
  }

  private snapshot(): Blueprint {
    const out = (b: Internal): BlueprintBlock => ({
      id: b.id,
      kind: b.kind,
      count: b.count,
      ...(b.level ? { level: b.level } : {}),
      offset: b.offset,
      line: b.line,
      snippet: b.snippet,
      ink: this.inkOf(b),
      children: b.children.map(out),
      ...(b.implicit ? { implicit: true as const } : {}),
    });
    const blocks = this.rows.map(out);
    // The first content row opening with a top-level heading, after only the
    // page's chrome, is the hero.
    const first = blocks.findIndex((b) => b.kind !== "nav" && b.kind !== "header");
    const candidate = first >= 0 ? blocks[first] : null;
    if (candidate && candidate.kind === "section" && candidate.children[0]?.kind === "heading" && candidate.children[0].level === 1) {
      candidate.kind = "hero";
    }
    return {
      blocks,
      total: this.total,
      overflow: this.overflow,
      styled: this.styledSeen || this.rules.size > 0,
      cursor: this.cursor(),
      pageInk: this.pageInk ?? this.rules.get("body") ?? this.rules.get("html") ?? null,
    };
  }
}

function snippetOf(tagText: string): string {
  const first = tagText.split("\n")[0].replace(/\s+/g, " ").trim();
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

/** One-shot read of a whole source (tests, and a card that mounts mid-stream). */
export function parseBlueprint(content: string, type: ArtifactType, language?: string | null): Blueprint {
  return new BlueprintParser(isReactSource(type, language)).feed(content);
}

export function isReactSource(type: ArtifactType, language?: string | null): boolean {
  if (type === "REACT") return true;
  const lang = canonicalLang(language);
  return type === "CODE" && (lang === "tsx" || lang === "jsx");
}

/** The mono label a block wears: "nav", "cards ×3", "h1". */
export function blockLabel(block: Pick<BlueprintBlock, "kind" | "count" | "level">): string {
  const base = block.kind === "heading" && block.level ? `h${block.level}` : block.kind;
  return block.count > 1 ? `${base} ×${block.count}` : base;
}
