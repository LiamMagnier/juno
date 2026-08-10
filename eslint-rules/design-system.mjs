/**
 * Local ESLint rules that keep the design system enforceable rather than
 * aspirational.
 *
 * The radius scale in tailwind.config.ts had existed for a while, with a comment
 * saying the arbitrary values were being replaced "1:1". They were not: 26
 * distinct `rounded-[Npx]` values across 256 call sites had accumulated
 * alongside it, including three different corner treatments on a single shared
 * component. A scale nothing enforces is a suggestion, and suggestions lose to
 * whatever the last person typed.
 */

/** px -> token. Exactly the ladder declared in tailwind.config.ts. */
const RADIUS_TOKENS = {
  "2px": "micro",
  "4px": "sm",
  "6px": "xs",
  "8px": "md",
  "10px": "control",
  "11px": "composer-control",
  "12px": "field",
  "13px": "composer-action",
  "14px": "menu",
  "16px": "card",
  "18px": "popover",
  "20px": "surface",
  "22px": "composer",
  "24px": "lg",
  "28px": "panel",
  inherit: "inherit",
};

const SCALE_HELP =
  "micro 2 · sm 4 · xs 6 · md 8 · control 10 · composer-control 11 · field 12 · " +
  "composer-action 13 · menu 14 · card 16 · popover 18 · surface 20 · composer 22 · " +
  "lg 24 · panel 28 · full · logo (24%)";

const ARBITRARY_RADIUS = /rounded(?:-[a-z]{1,2})?-\[([^\]]+)\]/g;

/**
 * Only values that are genuinely not on the scale because they are relative to
 * something the scale cannot know about.
 */
const DEFAULT_ALLOW = ["0.25em"];

const noArbitraryRadius = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Use the semantic border-radius scale instead of an arbitrary rounded-[Npx] value.",
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      arbitrary:
        "`rounded-[{{value}}]` bypasses the radius scale. Use `rounded-{{suggestion}}`. Scale: " +
        SCALE_HELP,
      offScale:
        "`rounded-[{{value}}]` is not on the radius scale. Pick the nearest rung or add a named " +
        "token to tailwind.config.ts with a comment saying what it wraps. Scale: " +
        SCALE_HELP,
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? DEFAULT_ALLOW);

    /** @param {import('estree').Node} node @param {string} raw @param {number} offset */
    function scan(node, raw, offset) {
      for (const match of raw.matchAll(ARBITRARY_RADIUS)) {
        const value = match[1];
        if (allow.has(value)) continue;

        const suggestion = RADIUS_TOKENS[value];
        const start = node.range[0] + offset + match.index;
        const range = [start, start + match[0].length];

        // Only autofix the plain `rounded-` form; a directional variant
        // (rounded-t-, rounded-bl-) keeps its infix and is left to a human.
        const directional = /^rounded-[a-z]{1,2}-/.test(match[0]);

        context.report({
          node,
          loc: {
            start: context.sourceCode.getLocFromIndex(range[0]),
            end: context.sourceCode.getLocFromIndex(range[1]),
          },
          messageId: suggestion ? "arbitrary" : "offScale",
          data: { value, suggestion: suggestion ?? "" },
          fix:
            suggestion && !directional
              ? (fixer) => fixer.replaceTextRange(range, `rounded-${suggestion}`)
              : null,
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

const plugin = {
  rules: {
    "no-arbitrary-radius": noArbitraryRadius,
  },
};

export default plugin;
