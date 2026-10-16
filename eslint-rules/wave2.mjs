/**
 * THE WAVE 2 DESIGN RULES, AS LINT (spec §9 "Lint", package P1 scope 10).
 *
 * Each rule below is a sentence of the spec that used to be prose:
 *
 *   off-ladder-duration        transitions and animations last 70, 120, 160,
 *                              220, 360 or 560ms (D2); waits, holds, loops and
 *                              pacing are named tokens (§4.2), never literals
 *   no-text-token-opacity      text colour tokens never carry opacity (§3.1)
 *   transcript-chrome-type     the turn body, composer, tooltips, notifications
 *                              and sidebar use reading / ui / label only;
 *                              text-kbd only in Kbd and Badge (§3.5, D16)
 *   no-blur-entrance           no blur in any entrance (C1, §4.5 rule 2)
 *   no-backdrop-filter         no backdrop-filter in product chrome (D15)
 *   guarded-motion-overrides   a per-element --motion-shift / --motion-scale-from
 *                              override sits behind motion-safe (§4.7 Tier B)
 *   no-raw-presence-hex        presence is read from the token, never typed
 *   no-muted-on-fill           muted text on a hover or selected fill fails AA;
 *                              use muted-on-fill (§3.1)
 *
 * They run on TypeScript (class strings, style objects, framer transitions)
 * and, through the `css` processor, on stylesheets: a .css file becomes a
 * module of line comments with the same line numbers, and the rules read the
 * CSS back out of it. No dependency is added for that.
 *
 * Every rule WARNS everywhere. eslint.config.mjs turns them into errors for
 * the globs packages list in eslint-rules/enforce/*.json (enforce.mjs).
 */

import path from "node:path";

import { matchesAny } from "./enforce.mjs";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** The duration ladder (D2), in ms. 0 is "no transition", always allowed. */
export const RUNGS_MS = [70, 120, 160, 220, 360, 560];
const ALLOWED_MS = new Set([0, ...RUNGS_MS]);

/** Type rungs: `text-<rung>/<n>` is font-size / line-height, not colour with opacity. */
const FONT_SIZES = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
  "hero", "home-title", "display", "page-title", "title", "heading", "body-lg", "reading", "body", "nav", "ui", "label", "caption", "micro", "kbd",
]);
const NOT_TOKENS = new Set(["white", "black", "transparent", "current", "inherit"]);

/** Where the transcript-chrome law holds (§3.5): files that ARE the turn body, composer, tooltips, notifications or sidebar. */
export const DEFAULT_CHROME_GLOBS = [
  "src/components/chat/message-*.tsx",
  "src/components/chat/turn-*.tsx",
  "src/components/chat/composer*.tsx",
  "src/components/chat/composer/**",
  "src/components/ui/composer-shell.tsx",
  "src/components/ui/tooltip.tsx",
  "src/components/ui/sonner.tsx",
  "src/components/app/notification*.tsx",
  "src/components/app/app-sidebar*.tsx",
  "src/components/app/sidebar-*.tsx",
];
export const DEFAULT_KBD_GLOBS = ["src/components/ui/kbd.tsx", "src/components/ui/badge.tsx"];
/** Where backdrop-filter is allowed (D15): marketing, design-editor content, dev pages. */
export const DEFAULT_BACKDROP_ALLOW = [
  "src/components/home/**",
  "src/components/landing/**",
  "src/components/design/**",
  "src/lib/design/**",
  "src/app/dev/**",
];
/** The fills muted text fails on (contrast matrix FILLS). */
const FILLS = new Set(["selected", "sidebar-selected", "sidebar-hover", "user-bubble-hover"]);
/** The places allowed to state presence as hex: the token source and its generated projection. */
export const DEFAULT_HEX_ALLOW = ["src/app/globals.css", "src/lib/design/tokens.generated.ts"];

const relativeName = (context) => {
  const file = context.physicalFilename ?? context.filename ?? context.getFilename();
  return path.relative(context.cwd ?? process.cwd(), file).split(path.sep).join("/");
};

/** A class token split into its variant chain and its utility (brackets respected). */
function splitVariants(token) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) last = i;
  }
  const variants = last === -1 ? [] : token.slice(0, last).split(":");
  let utility = last === -1 ? token : token.slice(last + 1);
  if (utility.startsWith("!")) utility = utility.slice(1);
  return { variants, utility };
}

/** Whitespace-separated tokens of a string with their offsets. */
function tokens(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ token: m[0], index: m.index });
  return out;
}

/** Every time literal outside `var(...)`, as ms. */
function timeLiterals(text) {
  const withoutVars = text.replace(/var\((?:[^()]|\([^()]*\))*\)/g, (m) => " ".repeat(m.length));
  const out = [];
  const re = /(?<![\w.#-])(\d*\.?\d+)(ms|s)(?![\w-])/g;
  let m;
  while ((m = re.exec(withoutVars))) {
    const value = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
    out.push({ ms: Math.round(value * 1000) / 1000, text: m[0], index: m.index });
  }
  return out;
}

/** Report at a character range of a string literal / template element node. */
function reportAt(context, node, start, length, messageId, data) {
  const source = context.sourceCode ?? context.getSourceCode();
  const base = node.range[0] + 1; // skip the opening quote or backtick
  context.report({
    node,
    loc: { start: source.getLocFromIndex(base + start), end: source.getLocFromIndex(base + start + length) },
    messageId,
    data,
  });
}

/** Run `scan(text, node)` over every string literal and template chunk in a TS/TSX file. */
function stringVisitors(scan) {
  return {
    Literal(node) {
      if (typeof node.value === "string") scan(node.value, node);
    },
    TemplateElement(node) {
      scan(node.value.raw, node);
    },
  };
}

const keyName = (property) =>
  property.key?.type === "Identifier" ? property.key.name : property.key?.type === "Literal" ? String(property.key.value) : null;

const isCss = (context) => /\.css(?:\/|$)/.test(context.physicalFilename ?? context.filename ?? "");

// ---------------------------------------------------------------------------
// CSS: a processor that keeps line numbers, and a declaration scanner
// ---------------------------------------------------------------------------

export const cssProcessor = {
  meta: { name: "wave2-css" },
  preprocess(text) {
    return [{ text: text.split("\n").map((line) => `//${line}`).join("\n"), filename: "0.js" }];
  },
  postprocess(messages) {
    return messages.flat().map((m) => ({ ...m, column: Math.max(1, (m.column ?? 1) - 2), endColumn: m.endColumn ? Math.max(1, m.endColumn - 2) : m.endColumn }));
  },
  supportsAutofix: false,
};

/** The original CSS of a processed block (each line had `//` prepended). */
function cssText(context) {
  const source = (context.sourceCode ?? context.getSourceCode()).text;
  return source.split("\n").map((line) => line.replace(/^\/\//, "")).join("\n");
}

/**
 * Every declaration in a stylesheet: `{ prop, value, line, column, selector, atRules }`,
 * comments blanked first so prose about `backdrop-filter` is not a declaration.
 */
export function cssDeclarations(css) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  const stack = [];
  let buffer = "";
  let bufferStart = 0;
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === "\n") lineStarts.push(i + 1);
  const locOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };
  const flush = (end) => {
    const selector = [...stack].reverse().find((p) => !p.startsWith("@")) ?? "";
    const atRules = stack.filter((p) => p.startsWith("@"));
    let offset = bufferStart;
    for (const raw of buffer.split(";")) {
      const colon = raw.indexOf(":");
      const lead = raw.length - raw.trimStart().length;
      if (colon !== -1 && stack.length) {
        const prop = raw.slice(0, colon).trim();
        if (/^-{0,2}[a-zA-Z][\w-]*$/.test(prop)) {
          out.push({ prop: prop.toLowerCase().startsWith("--") ? prop : prop.toLowerCase(), value: raw.slice(colon + 1).trim(), ...locOf(offset + lead), selector, atRules });
        }
      }
      offset += raw.length + 1;
    }
    void end;
  };
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
      bufferStart = i + 1;
    } else if (ch === "}") {
      flush(i);
      stack.pop();
      buffer = "";
      bufferStart = i + 1;
    } else {
      buffer += ch;
    }
  }
  return out;
}

function reportCss(context, decl, messageId, data) {
  context.report({ loc: { start: { line: decl.line, column: decl.column + 1 }, end: { line: decl.line, column: decl.column + 1 + decl.prop.length } }, messageId, data });
}

function cssVisitor(context, run) {
  return {
    Program() {
      if (!isCss(context)) return;
      run(cssDeclarations(cssText(context)));
    },
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const MOTION_KEYS = new Set(["ease", "type", "bounce", "stiffness", "damping", "mass", "repeat", "repeatType", "times", "visualDuration", "easing", "fill", "iterations", "direction"]);
const TIME_PROPS = new Set(["transition", "transitionDuration", "transitionDelay", "animation", "animationDuration", "animationDelay"]);
const CSS_TIME_PROPS = new Set(["transition", "transition-duration", "transition-delay", "animation", "animation-duration", "animation-delay"]);

const offLadderDuration = {
  meta: {
    type: "problem",
    docs: { description: "Durations and delays are rungs (70/120/160/220/360/560ms) or named tokens (spec D2, §4.2)." },
    schema: [],
    messages: {
      literal:
        "`{{value}}` is off the duration ladder. Use a rung (70, 120, 160, 220, 360, 560ms: duration-press/fast/exit/base/slow/emphasis, var(--dur-*), DURATION) or a named token (--delay-*, --hold-*, --loop-*, --settle-*, --stream-*, TIMING).",
    },
  },
  create(context) {
    if (isCss(context)) {
      return cssVisitor(context, (decls) => {
        for (const decl of decls) {
          if (!CSS_TIME_PROPS.has(decl.prop)) continue;
          for (const t of timeLiterals(decl.value)) {
            if (!ALLOWED_MS.has(t.ms)) reportCss(context, decl, "literal", { value: t.text });
          }
        }
      });
    }
    const checkClassToken = (node, token, index) => {
      const { utility } = splitVariants(token);
      const offset = index + token.length - utility.length;
      let m = /^(duration|delay)-(\d+)$/.exec(utility);
      if (m && !ALLOWED_MS.has(Number(m[2]))) return reportAt(context, node, offset, utility.length, "literal", { value: utility });
      m = /^(?:duration|delay|animate|\[(?:transition|animation)(?:-duration|-delay)?:)(?:-\[)?(.*?)\]?$/.exec(utility);
      if (m && /[[\]]/.test(utility)) {
        for (const t of timeLiterals(utility.replace(/_/g, " "))) {
          if (!ALLOWED_MS.has(t.ms)) return reportAt(context, node, offset, utility.length, "literal", { value: utility });
        }
      }
    };
    const scanStyleString = (node, text) => {
      for (const t of timeLiterals(text)) {
        if (!ALLOWED_MS.has(t.ms)) reportAt(context, node, t.index, t.text.length, "literal", { value: t.text });
      }
    };
    return {
      ...stringVisitors((text, node) => {
        // Style-property strings are checked by the Property visitor below.
        if (node.parent?.type === "Property" && TIME_PROPS.has(keyName(node.parent) ?? "")) return;
        for (const { token, index } of tokens(text)) checkClassToken(node, token, index);
      }),
      Property(node) {
        const key = keyName(node);
        if (!key) return;
        if (TIME_PROPS.has(key) && node.value.type === "Literal" && typeof node.value.value === "string") {
          scanStyleString(node.value, node.value.value);
          return;
        }
        if (key !== "duration" && key !== "delay" && key !== "repeatDelay") return;
        if (node.value.type !== "Literal" || typeof node.value.value !== "number") return;
        const object = node.parent;
        if (object?.type !== "ObjectExpression") return;
        const siblings = object.properties.map(keyName);
        const inTransition = object.parent?.type === "Property" && keyName(object.parent) === "transition";
        const animateCall =
          object.parent?.type === "CallExpression" &&
          ((object.parent.callee.type === "Identifier" && /^animate/.test(object.parent.callee.name)) ||
            (object.parent.callee.type === "MemberExpression" && object.parent.callee.property?.name === "animate"));
        if (!inTransition && !animateCall && !siblings.some((s) => MOTION_KEYS.has(s))) return;
        const v = node.value.value;
        const ms = v <= 10 ? Math.round(v * 1000) : v;
        if (!ALLOWED_MS.has(ms)) {
          context.report({ node: node.value, messageId: "literal", data: { value: `${key}: ${v}` } });
        }
      },
    };
  },
};

const noTextTokenOpacity = {
  meta: {
    type: "problem",
    docs: { description: "Text colour tokens never carry opacity (spec §3.1); use the ink the role names." },
    schema: [],
    messages: {
      opacity:
        "`{{token}}` puts opacity on a text colour token. Text inks are tuned for contrast at full strength: use muted-foreground, muted-on-fill, ink-tertiary (glyphs only) or foreground. `disabled:opacity-*` stays allowed.",
    },
  },
  create(context) {
    if (isCss(context)) return {};
    return stringVisitors((text, node) => {
      for (const { token, index } of tokens(text)) {
        const { utility } = splitVariants(token);
        const m = /^text-([a-z][a-z0-9-]*)\/(\d+|\[[^\]]+\])$/.exec(utility);
        if (!m || FONT_SIZES.has(m[1]) || NOT_TOKENS.has(m[1])) continue;
        reportAt(context, node, index + token.length - utility.length, utility.length, "opacity", { token: utility });
      }
    });
  },
};

const transcriptChromeType = {
  meta: {
    type: "problem",
    docs: { description: "Transcript chrome uses reading 16, ui 13 and label 12 only; text-kbd only in Kbd and Badge (spec §3.5)." },
    schema: [
      {
        type: "object",
        properties: { chrome: { type: "array", items: { type: "string" } }, kbd: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      rung: "`{{token}}` is not a transcript-chrome rung. Inside the turn body, the composer, tooltips, notifications and the sidebar there are three sizes: text-reading (content), text-ui (controls), text-label (metadata).",
      kbd: "`text-kbd` (11px) is for keycaps and count badges only: use it through Kbd or Badge.",
    },
  },
  create(context) {
    if (isCss(context)) return {};
    const options = context.options[0] ?? {};
    const file = relativeName(context);
    const chrome = matchesAny(file, options.chrome ?? DEFAULT_CHROME_GLOBS);
    const kbdOk = matchesAny(file, options.kbd ?? DEFAULT_KBD_GLOBS);
    return stringVisitors((text, node) => {
      for (const { token, index } of tokens(text)) {
        const { utility } = splitVariants(token);
        const at = index + token.length - utility.length;
        if (utility === "text-kbd" && !kbdOk) reportAt(context, node, at, utility.length, "kbd", {});
        if (!chrome) continue;
        if (utility === "text-caption" || utility === "text-micro" || /^text-\[(?:\d*\.?\d+(?:px|rem|em)|clamp\([^\]]*\))\]$/.test(utility)) {
          reportAt(context, node, at, utility.length, "rung", { token: utility });
        }
      }
    });
  },
};

const ENTRANCE_KEYS = new Set(["initial", "hidden", "from", "enter", "exit", "start", "0%", "out"]);
const blurValue = (value) => /blur\(\s*(?!0(?:px|rem|em)?\s*\))[\d.]/.test(value);

const noBlurEntrance = {
  meta: {
    type: "problem",
    docs: { description: "No blur in any entrance (spec C1, §4.5)." },
    schema: [],
    messages: { blur: "An entrance that starts blurred. No entrance blurs (spec C1): rise and fade instead (rise-user, settle-part, pop-in)." },
  },
  create(context) {
    if (isCss(context)) {
      return cssVisitor(context, (decls) => {
        for (const decl of decls) {
          if ((decl.prop === "filter" || decl.prop === "-webkit-filter") && blurValue(decl.value) && decl.atRules.some((a) => /^@(?:-webkit-)?keyframes\b/.test(a))) {
            reportCss(context, decl, "blur", {});
          }
        }
      });
    }
    return {
      Property(node) {
        const key = keyName(node);
        if (key !== "filter" && key !== "WebkitFilter") return;
        const values = node.value.type === "ArrayExpression" ? node.value.elements : [node.value];
        const blurred = values.some((v) => v?.type === "Literal" && typeof v.value === "string" && blurValue(v.value));
        if (!blurred) return;
        const object = node.parent;
        const owner = object?.parent?.type === "Property" ? keyName(object.parent) : null;
        const inKeyframes = node.value.type === "ArrayExpression";
        if (inKeyframes || (owner && ENTRANCE_KEYS.has(owner))) context.report({ node, messageId: "blur" });
      },
    };
  },
};

const noBackdropFilter = {
  meta: {
    type: "problem",
    docs: { description: "No backdrop-filter in product chrome (spec D15)." },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      backdrop:
        "backdrop-filter in product chrome (spec D15): content is opaque and the web header is opaque. Use an opaque fill. Allowed only in marketing, design-editor content, dev pages and `.media-scrim` over images.",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? DEFAULT_BACKDROP_ALLOW;
    if (matchesAny(relativeName(context).replace(/\/0\.js$/, ""), allow)) return {};
    if (isCss(context)) {
      return cssVisitor(context, (decls) => {
        for (const decl of decls) {
          if (decl.prop !== "backdrop-filter" && decl.prop !== "-webkit-backdrop-filter") continue;
          if (/^none\b/.test(decl.value) || /\.media-scrim\b/.test(decl.selector)) continue;
          reportCss(context, decl, "backdrop", {});
        }
      });
    }
    return {
      ...stringVisitors((text, node) => {
        if (/\bmedia-scrim\b/.test(text)) return;
        for (const { token, index } of tokens(text)) {
          const { utility } = splitVariants(token);
          if (/^backdrop-(?!filter-none$)[a-z]/.test(utility) || /^\[(?:-webkit-)?backdrop-filter:/.test(utility)) {
            reportAt(context, node, index + token.length - utility.length, utility.length, "backdrop", {});
          }
        }
      }),
      Property(node) {
        const key = keyName(node);
        if (key !== "backdropFilter" && key !== "WebkitBackdropFilter") return;
        if (node.value.type === "Literal" && node.value.value === "none") return;
        context.report({ node, messageId: "backdrop" });
      },
    };
  },
};

const guardedMotionOverrides = {
  meta: {
    type: "problem",
    docs: { description: "Per-element --motion-shift / --motion-scale-from overrides sit behind motion-safe (spec §4.7)." },
    schema: [],
    messages: {
      unguarded:
        "An unguarded `{{name}}` override undoes reduced motion for this element (Tier B sets it to 0 / 1). Write it behind `motion-safe:` (`motion-safe:[--motion-scale-from:0.97]`) or inside `@media (prefers-reduced-motion: no-preference)`.",
    },
  },
  create(context) {
    if (isCss(context)) {
      return cssVisitor(context, (decls) => {
        for (const decl of decls) {
          if (decl.prop !== "--motion-shift" && decl.prop !== "--motion-scale-from") continue;
          if (decl.atRules.some((a) => /prefers-reduced-motion/.test(a))) continue;
          reportCss(context, decl, "unguarded", { name: decl.prop });
        }
      });
    }
    return {
      ...stringVisitors((text, node) => {
        for (const { token, index } of tokens(text)) {
          const { variants, utility } = splitVariants(token);
          const m = /^\[(--motion-(?:shift|scale-from)):/.exec(utility);
          if (m && !variants.includes("motion-safe")) reportAt(context, node, index, token.length, "unguarded", { name: m[1] });
        }
      }),
      Property(node) {
        const key = keyName(node);
        if (key === "--motion-shift" || key === "--motion-scale-from") context.report({ node, messageId: "unguarded", data: { name: key } });
      },
    };
  },
};

const PRESENCE_HEX = /#(?:2d49c9|97a6e6)\b/gi;

const noRawPresenceHex = {
  meta: {
    type: "problem",
    docs: { description: "Presence is read from --presence or SCRIPT_COLOR.presence, never typed as hex." },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: { hex: "Raw presence hex `{{hex}}`. Read `hsl(var(--presence))` in CSS or `SCRIPT_COLOR.presence` in script; the value lives in globals.css." },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? DEFAULT_HEX_ALLOW;
    if (matchesAny(relativeName(context).replace(/\/0\.js$/, ""), allow)) return {};
    if (isCss(context)) {
      return cssVisitor(context, (decls) => {
        for (const decl of decls) {
          const m = decl.value.match(PRESENCE_HEX);
          if (m) reportCss(context, decl, "hex", { hex: m[0] });
        }
      });
    }
    return stringVisitors((text, node) => {
      for (const m of text.matchAll(PRESENCE_HEX)) reportAt(context, node, m.index, m[0].length, "hex", { hex: m[0] });
    });
  },
};

const noMutedOnFill = {
  meta: {
    type: "problem",
    docs: { description: "Muted text on a hover or selected fill fails AA (4.32:1); use muted-on-fill (spec §3.1)." },
    schema: [],
    messages: { fill: "`text-muted-foreground` on `{{fill}}` measures under 4.5:1. Text on a hover or selected fill uses `text-muted-on-fill` (or foreground)." },
  },
  create(context) {
    if (isCss(context)) return {};
    return stringVisitors((text, node) => {
      const parts = tokens(text).map(({ token, index }) => ({ ...splitVariants(token), index, token }));
      for (const muted of parts.filter((p) => p.utility === "text-muted-foreground")) {
        const chain = muted.variants.join(":");
        const fill = parts.find((p) => p.variants.join(":") === chain && /^bg-/.test(p.utility) && FILLS.has(p.utility.slice(3).replace(/\/\d+$/, "")));
        if (fill) reportAt(context, node, muted.index, muted.token.length, "fill", { fill: fill.utility });
      }
    });
  },
};

export const rules = {
  "off-ladder-duration": offLadderDuration,
  "no-text-token-opacity": noTextTokenOpacity,
  "transcript-chrome-type": transcriptChromeType,
  "no-blur-entrance": noBlurEntrance,
  "no-backdrop-filter": noBackdropFilter,
  "guarded-motion-overrides": guardedMotionOverrides,
  "no-raw-presence-hex": noRawPresenceHex,
  "no-muted-on-fill": noMutedOnFill,
};

/** The rules that read stylesheets through the processor. */
export const CSS_RULES = ["off-ladder-duration", "no-blur-entrance", "no-backdrop-filter", "guarded-motion-overrides", "no-raw-presence-hex"];

export const plugin = { meta: { name: "wave2" }, rules, processors: { css: cssProcessor } };

const severity = (level, names) => Object.fromEntries(names.map((name) => [`wave2/${name}`, level]));

/**
 * The flat-config entries: every rule warns on `src/**` TypeScript and on the
 * repository's stylesheets; the enforce globs (eslint-rules/enforce/*.json)
 * turn them into errors.
 */
export function wave2Configs({ enforce = { web: [] } } = {}) {
  const tsRules = Object.keys(rules);
  const configs = [
    { files: ["src/**/*.{ts,tsx}"], plugins: { wave2: plugin }, rules: severity("warn", tsRules) },
    { files: ["src/**/*.css"], plugins: { wave2: plugin }, processor: "wave2/css" },
    { files: ["src/**/*.css/*.js"], plugins: { wave2: plugin }, rules: severity("warn", CSS_RULES) },
  ];
  const web = enforce.web ?? [];
  // A directory glob (`src/lib/strings/**`) is narrowed to the TypeScript in
  // it, so an enforce entry never asks ESLint to parse a JSON or Markdown file.
  const tsGlobs = web
    .filter((glob) => !/\.css$/.test(glob))
    .map((glob) => (/\.(?:ts|tsx|\{ts,tsx\})$/.test(glob) ? glob : `${glob.replace(/\/$/, "")}${glob.endsWith("**") ? "" : "/**"}/*.{ts,tsx}`));
  const cssGlobs = web.filter((glob) => /\.css$/.test(glob)).map((glob) => `${glob}/*.js`);
  if (tsGlobs.length) configs.push({ files: tsGlobs, plugins: { wave2: plugin }, rules: severity("error", tsRules) });
  if (cssGlobs.length) configs.push({ files: cssGlobs, plugins: { wave2: plugin }, rules: severity("error", CSS_RULES) });
  return configs;
}
