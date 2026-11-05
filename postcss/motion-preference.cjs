/**
 * The in-app Motion setting (Settings › Appearance › Motion) on the same tiers
 * as the OS preference.
 *
 * WHY A BUILD STEP. Every reduced-motion rule in the product is written once,
 * against the media query: `@media (prefers-reduced-motion: reduce)` keeps the
 * fades and state colour and removes travel and loops, tier by tier, in ~60
 * blocks across globals.css and the component sheets, plus every Tailwind
 * `motion-reduce:` / `motion-safe:` utility. The in-app "Reduced" choice used
 * to be a separate, blanket `* { animation-duration: 0.01ms !important }`
 * clamp: a reader who picked it in the app got a different, harsher product
 * than a reader who picked it in the OS, and could not pick "more motion than
 * my OS asks for" at all. Hand-copying each block under an attribute selector
 * is how the galleries' `[data-motion="reduce"]` copies drifted.
 *
 * So each reduced-motion block is compiled into its attribute twin:
 *
 *   @media (prefers-reduced-motion: reduce) { S { d } }
 *     → @media (prefers-reduced-motion: reduce) { S:where(not inside [data-motion="full"]) { d } }
 *       S:where(inside [data-motion="reduced"]) { d }
 *
 *   @media (prefers-reduced-motion: no-preference) { S { d } }
 *     → @media (prefers-reduced-motion: no-preference) { S:where(not inside [data-motion="reduced"]) { d } }
 *       @media (prefers-reduced-motion: reduce) { S:where(inside [data-motion="full"]) { d } }
 *
 * "Inside" is ancestor-or-self, so `<html data-motion>` (the app, written by
 * lib/ui-prefs.ts before first paint) and a gallery root that simulates the
 * preference behave the same. The legacy gallery value `reduce` is honoured as
 * `reduced`. The condition is appended to the FIRST compound of each selector
 * inside `:where()`, so specificity never changes and a `.dark …` selector
 * (whose first compound IS <html>) still matches. A bare `:root` / `html`
 * compound becomes the attribute itself (same 0,1,0 specificity), so the
 * custom-property overrides (--motion-shift, --dur-slow…) reach a gallery root
 * too. The twins are emitted right after the original, so the cascade order is
 * the author's.
 *
 * Runs after Tailwind (postcss.config.mjs), so it sees utilities as well.
 * tests/motion-preference-postcss.test.ts pins the output.
 */

/** `^=` matches both the app's `reduced` and the galleries' legacy `reduce` in one selector. */
const REDUCED = '[data-motion^="reduce"]';
const FULL = '[data-motion="full"]';
/**
 * The in-app Increase contrast setting (spec §3.2), on the same mechanism:
 *
 *   @media (prefers-contrast: more) { S { d } }
 *     → @media (prefers-contrast: more) { S:where(not inside [data-contrast="standard"]) { d } }
 *       S:where(inside [data-contrast="more"]) { d }
 *
 * so high contrast follows the OS unless the reader turned it off in the app,
 * and turns on from the app on any device. The token block in globals.css and
 * every component's own contrast rule ride on it; the Swift projection reads
 * the same token block as Increase Contrast. Only `more` is twinned.
 */
const CONTRAST_MORE = '[data-contrast="more"]';
const CONTRAST_STANDARD = '[data-contrast="standard"]';

const inside = (attr) => `${attr}, ${attr} *`;

const SCOPES = {
  onReduced: `:where(${inside(REDUCED)})`,
  notFull: `:where(:not(${inside(FULL)}))`,
  notReduced: `:where(:not(${inside(REDUCED)}))`,
  onFull: `:where(${inside(FULL)})`,
  onContrast: `:where(${inside(CONTRAST_MORE)})`,
  notStandard: `:where(:not(${inside(CONTRAST_STANDARD)}))`,
};
/** What a bare `:root` / `html` compound becomes when the twin must match the attribute's element (0,1,0, like `:root`). */
const ROOT_SWAP = { onReduced: REDUCED, onContrast: CONTRAST_MORE };
const CONTRAST_FEATURE = /^\(\s*prefers-contrast\s*:\s*more\s*\)$/i;

const LEGACY_PSEUDO_ELEMENT = /^:(?:before|after|first-line|first-letter)(?![\w-])/i;
const MOTION_FEATURE = /^\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)$/i;

/** The end of the first compound selector, and where a pseudo-class may go inside it. */
function firstCompound(selector) {
  let depth = 0;
  let quote = null;
  let pseudoAt = -1;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0) {
      if (/\s|>|\+|~/.test(ch)) return { end: i, insertAt: pseudoAt === -1 ? i : pseudoAt };
      if (ch === ":" && pseudoAt === -1 && (selector[i + 1] === ":" || LEGACY_PSEUDO_ELEMENT.test(selector.slice(i)))) {
        pseudoAt = i;
      }
    }
  }
  return { end: selector.length, insertAt: pseudoAt === -1 ? selector.length : pseudoAt };
}

/**
 * `selector` with `scope` applied to its first compound, or null when it
 * cannot be scoped safely (nesting `&`, an empty selector). A null in a twin
 * drops that selector from the twin; in the original it is left as written.
 */
function scopeSelector(selector, scope) {
  const s = selector.trim();
  if (!s || s.includes("&")) return null;
  const { end, insertAt } = firstCompound(s);
  const compound = s.slice(0, end);
  if (ROOT_SWAP[scope] && /^(?::root|html)$/i.test(compound)) {
    return ROOT_SWAP[scope] + s.slice(end);
  }
  return s.slice(0, insertAt) + SCOPES[scope] + s.slice(insertAt);
}

/** Scope every rule under `node` in place. Keyframe selectors (`from`, `50%`) are left alone. */
function scopeRules(node, scope, { dropUnscopable }) {
  node.walkRules((rule) => {
    if (rule.parent && rule.parent.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    const scoped = [];
    for (const selector of rule.selectors) {
      const next = scopeSelector(selector, scope);
      if (next !== null) scoped.push(next);
      else if (!dropUnscopable) scoped.push(selector);
    }
    if (scoped.length) rule.selectors = scoped;
    else rule.remove();
  });
}

/**
 * Parse a media prelude into alternatives. Each is `{ motion, rest }`:
 * `motion` is "reduce", "safe" or null, `rest` the other `and`-joined
 * conditions. Null overall when the prelude uses `not`, `only` or `or`, which
 * this does not rewrite (the rule is then left exactly as written).
 */
function parseQuery(params) {
  const alternatives = [];
  for (const raw of splitTopLevel(params, ",")) {
    const text = raw.trim();
    if (/\b(?:not|only|or)\b/i.test(text)) return null;
    const parts = splitAnd(text);
    let motion = null;
    const rest = [];
    for (const part of parts) {
      const m = MOTION_FEATURE.exec(part.trim());
      if (m) {
        motion = (m[1] || "reduce").toLowerCase() === "reduce" ? "reduce" : "safe";
      } else {
        rest.push(part.trim());
      }
    }
    alternatives.push({ motion, rest });
  }
  return alternatives;
}

/**
 * The same, for the contrast preference: `contrast` is "more" or null. Only
 * `more` is twinned; `less`, `custom` and `no-preference` are left as written.
 */
function parseContrastQuery(params) {
  const alternatives = [];
  for (const raw of splitTopLevel(params, ",")) {
    const text = raw.trim();
    if (/\b(?:not|only|or)\b/i.test(text)) return null;
    let contrast = null;
    const rest = [];
    for (const part of splitAnd(text)) {
      if (CONTRAST_FEATURE.test(part.trim())) contrast = "more";
      else rest.push(part.trim());
    }
    alternatives.push({ contrast, rest });
  }
  return alternatives;
}

function splitTopLevel(text, separator) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (depth === 0 && text[i] === separator) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** `(a) and (b)` → ["(a)", "(b)"]; tolerates the unspaced `(a)and(b)` form. */
function splitAnd(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && /^\s*and\b/i.test(text.slice(i)) && current.trim()) {
      out.push(current);
      current = "";
      i += text.slice(i).match(/^\s*and\b/i)[0].length - 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** A keyframes rule's body, whitespace-insensitive, to tell two definitions of one name apart. */
const keyframesBody = (keyframes) => (keyframes.nodes ?? []).map((n) => n.toString()).join("").replace(/\s+/g, "");

/** Whether a node sits inside a conditional group rule (@media, @supports, @container). */
function insideConditional(node) {
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent) {
    if (parent.type === "atrule" && /^(?:media|supports|container)$/i.test(parent.name)) return true;
  }
  return false;
}

const query = (rest, motion) =>
  [...rest, ...(motion ? [`(prefers-reduced-motion: ${motion})`] : [])].join(" and ");

function plugin() {
  return {
    postcssPlugin: "alevr-motion-preference",
    prepare() {
      /** Each keyframes name in the sheet → its distinct bodies, and whether one definition is unconditional. */
      const keyframesIndex = new Map();
      return {
        Once(root) {
          root.walkAtRules(/keyframes$/i, (keyframes) => {
            const entry = keyframesIndex.get(keyframes.params) ?? { bodies: new Set(), unconditional: false };
            entry.bodies.add(keyframesBody(keyframes));
            if (!insideConditional(keyframes)) entry.unconditional = true;
            keyframesIndex.set(keyframes.params, entry);
          });
        },
        AtRule: {
          media(atRule, { AtRule, result }) {
            // Visitors receive proxies, so a rewritten block is marked on the
            // node itself (raws survive the proxy) rather than in a WeakSet.
            // Each preference marks only its own flag and carries the other's
            // over from the block it rewrote, so a query naming both
            // preferences is rewritten once by each and never again.
            if (!atRule.raws.alevrMotion && /prefers-reduced-motion/i.test(atRule.params)) {
              rewriteMotion(atRule, { AtRule, result });
              return;
            }
            if (!atRule.raws.alevrContrast && /prefers-contrast/i.test(atRule.params)) {
              rewriteContrast(atRule, { AtRule });
            }
          },
        },
      };

      function rewriteMotion(atRule, { AtRule, result }) {
            const alternatives = parseQuery(atRule.params);
            if (!alternatives || !alternatives.some((a) => a.motion)) return;

            // Keyframes are global by name, and Tailwind's `motion-safe:animate-*`
            // writes its @keyframes inside the media block. Left there, a twin
            // that names the animation (Full on a device that reduces) would
            // find no keyframes. When every definition of the name in this
            // sheet has the same body, defining it unconditionally changes
            // nothing for anyone else, so it moves out in front of the block
            // (or is dropped when an unconditional copy already exists).
            atRule.walkAtRules(/keyframes$/i, (keyframes) => {
              const entry = keyframesIndex.get(keyframes.params);
              if (!entry || entry.bodies.size !== 1) return;
              if (!entry.unconditional) {
                atRule.before(keyframes.clone());
                entry.unconditional = true;
              }
              keyframes.remove();
            });
            if (!atRule.nodes || atRule.nodes.length === 0) {
              atRule.remove();
              return;
            }

            const out = [];
            const plain = alternatives.filter((a) => !a.motion);
            if (plain.length) {
              const keep = new AtRule({ name: "media", params: plain.map((a) => query(a.rest, null)).join(", ") });
              keep.append(atRule.nodes.map((n) => n.clone()));
              out.push(keep);
            }
            const wrap = (params, scope) => {
              const twin = scope === "onReduced" || scope === "onFull";
              const box = new AtRule({ name: "media", params: params || "all" });
              box.append(atRule.nodes.map((n) => n.clone()));
              // A @keyframes still here has a different body elsewhere in the
              // sheet: copied into a twin it would redefine the name for
              // everyone, so twins never carry one; the original block keeps it.
              if (twin) {
                box.walkAtRules(/keyframes$/i, (keyframes) => {
                  result.warn(`@keyframes ${keyframes.params} inside a reduced-motion block is not copied to the in-app twin`, { node: keyframes });
                  keyframes.remove();
                });
              }
              scopeRules(box, scope, { dropUnscopable: twin });
              if (!box.nodes.length) return;
              if (params) out.push(box);
              else out.push(...box.nodes.map((n) => n.clone()));
            };
            for (const a of alternatives.filter((x) => x.motion)) {
              if (a.motion === "reduce") {
                wrap(query(a.rest, "reduce"), "notFull");
                wrap(query(a.rest, null), "onReduced");
              } else {
                wrap(query(a.rest, "no-preference"), "notReduced");
                wrap(query(a.rest, "reduce"), "onFull");
              }
            }
            mark(out, "alevrMotion", atRule.raws.alevrContrast ? "alevrContrast" : null);
            atRule.replaceWith(out);
      }

      function rewriteContrast(atRule, { AtRule }) {
        const alternatives = parseContrastQuery(atRule.params);
        if (!alternatives || !alternatives.some((a) => a.contrast)) return;
        const out = [];
        const plain = alternatives.filter((a) => !a.contrast);
        if (plain.length) {
          const keep = new AtRule({ name: "media", params: plain.map((a) => a.rest.join(" and ")).join(", ") });
          keep.append(atRule.nodes.map((n) => n.clone()));
          out.push(keep);
        }
        for (const a of alternatives.filter((x) => x.contrast)) {
          // The OS preference, unless the app turned it off.
          const os = new AtRule({ name: "media", params: [...a.rest, "(prefers-contrast: more)"].join(" and ") });
          os.append(atRule.nodes.map((n) => n.clone()));
          scopeRules(os, "notStandard", { dropUnscopable: false });
          if (os.nodes.length) out.push(os);
          // The in-app toggle, on any device. Keyframes never go in a twin:
          // they are global by name, and the original block keeps them.
          const twin = new AtRule({ name: "media", params: a.rest.join(" and ") || "all" });
          twin.append(atRule.nodes.map((n) => n.clone()));
          twin.walkAtRules(/keyframes$/i, (keyframes) => keyframes.remove());
          scopeRules(twin, "onContrast", { dropUnscopable: true });
          if (!twin.nodes.length) continue;
          if (a.rest.length) out.push(twin);
          else out.push(...twin.nodes.map((n) => n.clone()));
        }
        mark(out, "alevrContrast", atRule.raws.alevrMotion ? "alevrMotion" : null);
        atRule.replaceWith(out);
      }

      /** Mark rewritten blocks (and media nested in them) with `flag`, and with `carry` when the source had it. */
      function mark(nodes, flag, carry) {
        for (const node of nodes) {
          if (node.type !== "atrule") continue;
          node.raws[flag] = true;
          if (carry) node.raws[carry] = true;
          node.walkAtRules("media", (inner) => {
            inner.raws[flag] = true;
            if (carry) inner.raws[carry] = true;
          });
        }
      }
    },
  };
}
plugin.postcss = true;

module.exports = plugin;
module.exports.scopeSelector = scopeSelector;
module.exports.parseQuery = parseQuery;
module.exports.parseContrastQuery = parseContrastQuery;
