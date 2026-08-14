/**
 * design-system/no-arbitrary-text — the type scale, made enforceable.
 *
 * Companion to the rules in design-system.mjs, with the same history: the
 * semantic scale in tailwind.config.ts existed, and 457 `text-[Npx]` sites
 * accumulated beside it anyway — 80× 13px and 36× 12.5px in the gap that is now
 * `text-ui`, 139× 10px and 20× 9px in the one that is now `text-micro`. A scale
 * nothing enforces is a suggestion.
 *
 * Unlike no-arbitrary-radius this rule does NOT autofix. A radius token was a
 * 1:1 pixel rename by construction; a fontSize rung carries line-height,
 * tracking and sometimes weight along with the size, so the swap is a design
 * decision that needs eyes on the call site (`text-[13px] leading-relaxed` does
 * not mean `text-ui leading-relaxed`). It names the nearest rung and stops.
 *
 * CommonJS on purpose: this package declares no `type`, so a plain `.js` file
 * here parses as CJS — ESM syntax would fail the moment eslint.config.mjs
 * imports it on an older Node without module-syntax detection.
 */

/** px -> rung, exactly the scale declared in tailwind.config.ts. The fluid
 *  rungs (hero/display/page-title) are omitted: nothing hand-written as a px
 *  literal can have meant a clamp. */
const TEXT_TOKENS = {
  "9px": "micro",
  "10px": "micro",
  "10.5px": "micro",
  "11px": "caption",
  "12px": "label",
  "12.5px": "ui",
  "13px": "ui",
  "15px": "body",
  "17px": "body-lg",
  "18px": "heading",
  "22px": "title",
};

const SCALE_HELP =
  "hero · display · page-title · title 22 · heading 18 · body-lg 17 · body 15 · " +
  "ui 13 · label 12 (mono eyebrow) · caption 11 · micro 10.5 (mono metadata)";

/**
 * Only bare `<number>px` lengths. `text-[…]` is an overloaded namespace in
 * Tailwind — colours, alignment, arbitrary properties all live there — and
 * nothing but a raw px length is a size bypass.
 */
const ARBITRARY_TEXT = /text-\[(\d+(?:\.\d+)?)px\]/g;

/**
 * Mirrors the radius rule's escape hatch: values that are genuinely off the
 * scale for a reason the scale cannot know about go in the shared config, not
 * in a disable comment at the call site. Empty by default — no such text size
 * has earned an exemption yet.
 */
const DEFAULT_ALLOW = [];

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Use the semantic type scale instead of an arbitrary text-[Npx] value.",
    },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      arbitrary:
        "`text-[{{value}}]` bypasses the type scale. Use `text-{{suggestion}}` and let the rung " +
        "bring its own line-height/tracking. Scale: " + SCALE_HELP,
      offScale:
        "`text-[{{value}}]` is not on the type scale. Pick the nearest rung, or add a named rung " +
        "to tailwind.config.ts with a comment saying what it is for. Scale: " + SCALE_HELP,
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? DEFAULT_ALLOW);

    /** @param {import('estree').Node} node @param {string} raw @param {number} offset */
    function scan(node, raw, offset) {
      for (const match of raw.matchAll(ARBITRARY_TEXT)) {
        const value = match[1] + "px";
        if (allow.has(value)) continue;

        const suggestion = TEXT_TOKENS[value];
        const start = node.range[0] + offset + match.index;
        const range = [start, start + match[0].length];

        context.report({
          node,
          loc: {
            start: context.sourceCode.getLocFromIndex(range[0]),
            end: context.sourceCode.getLocFromIndex(range[1]),
          },
          messageId: suggestion ? "arbitrary" : "offScale",
          data: { value, suggestion: suggestion ?? "" },
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
