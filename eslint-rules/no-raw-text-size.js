/**
 * design-system/no-raw-text-size — the type scale's other leak.
 *
 * `no-arbitrary-text` catches `text-[13px]`. It never saw the larger problem:
 * Tailwind's stock rungs — `text-xs` (12px), `text-sm` (14px), `text-base`
 * (16px), `text-lg` (18px), `text-xl` (20px) and up — look like they belong to
 * a scale, and they do, just not to THIS one. Juno's scale runs 10.5 · 11 · 12
 * · 13 · 15 · 17 · 18 · 22, so `text-sm` (14) and `text-xs` (12) fall between
 * rungs, and a settings row drawn with them next to a `text-caption` badge and
 * a `text-ui` chip is four sizes in three pixels. The primitives carried these
 * for a long time, which is why the audit counted 70-odd sites on the landing,
 * auth and settings surfaces alone.
 *
 * A WARNING, not an error, for the same ratchet reason `no-arbitrary-text` is:
 * the stock rungs are everywhere in the app's older surfaces and an error
 * today would only teach people to sprinkle disables. Promote it once the
 * count reaches zero. No autofix either — a rung carries line-height and
 * tracking with it, so each swap needs eyes on the call site.
 *
 * CommonJS for the same reason as its sibling: this package declares no
 * `type`, so a plain `.js` file here is CJS.
 */

/**
 * Stock rung -> the named rung that usually replaces it. `sm` and `xs` each
 * have two answers (interface furniture vs. running text), so the message
 * offers both and lets the author choose.
 */
const RAW_TEXT_RUNGS = {
  "2xs": "micro",
  xs: "caption (metadata) or ui (a row)",
  sm: "ui (controls, rows, menu items) or body (descriptions, dialog copy)",
  base: "body-lg",
  lg: "heading",
  xl: "heading",
  "2xl": "title",
  "3xl": "display",
  "4xl": "display",
  "5xl": "hero",
  "6xl": "hero",
  "7xl": "hero",
  "8xl": "hero",
  "9xl": "hero",
};

const SCALE_HELP =
  "hero · display · page-title · title 22 · heading 18 · body-lg 17 · body 15 · " +
  "ui 13 · label 12 (mono eyebrow) · caption 11 · micro 10.5 (mono metadata)";

/**
 * A stock rung as a whole utility, with or without variants (`sm:text-sm`,
 * `file:text-sm`, `md:text-base`). Bounded so `text-smoke`, `text-sm-ish` and
 * the named rungs themselves (`text-body-lg`) never match.
 */
const RAW_TEXT = /(?:^|[\s"'`])((?:[a-z-]+:)*text-(2xs|xs|sm|base|lg|xl|[2-9]xl))(?=[\s"'`]|$)/g;

const DEFAULT_ALLOW = [];

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Use the semantic type scale instead of Tailwind's stock text-xs/sm/base/lg/xl rungs.",
    },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      raw:
        "`text-{{rung}}` is Tailwind's stock size, not a rung on this scale. Use `text-{{suggestion}}`. " +
        "Scale: " + SCALE_HELP,
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? DEFAULT_ALLOW);

    /** @param {import('estree').Node} node @param {string} raw @param {number} offset */
    function scan(node, raw, offset) {
      for (const match of raw.matchAll(RAW_TEXT)) {
        const utility = match[1];
        const rung = match[2];
        if (allow.has(rung)) continue;
        // The leading boundary character is part of match[0]; the utility
        // itself starts where match[1] does.
        const start = node.range[0] + offset + match.index + match[0].indexOf(utility);
        context.report({
          node,
          loc: {
            start: context.sourceCode.getLocFromIndex(start),
            end: context.sourceCode.getLocFromIndex(start + utility.length),
          },
          messageId: "raw",
          data: { rung, suggestion: RAW_TEXT_RUNGS[rung] ?? "a named rung" },
        });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        scan(node, node.raw, 0);
      },
      TemplateElement(node) {
        scan(node, node.value.raw, 1); // +1 for the backtick/`}` delimiter
      },
    };
  },
};
