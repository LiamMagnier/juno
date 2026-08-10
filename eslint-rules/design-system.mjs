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
 * `rounded` with no suffix. Tailwind's default is 0.25rem, which is exactly the
 * 4px this scale already names `sm` — so it is a second spelling of an existing
 * rung, and unlike `rounded-[4px]` it looks like it belongs. 46 sites had it.
 * Bounded by whitespace or a quote so `rounded-full`, `rounded-md` and the rest
 * are untouched.
 */
const BARE_ROUNDED = /(?:^|[\s"'`])rounded(?=[\s"'`]|$)/g;

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
      bare:
        "Bare `rounded` is Tailwind's default 0.25rem — the same 4px this scale already names " +
        "`rounded-sm`. Two spellings of one value. Use `rounded-sm`.",
    },
  },

  create(context) {
    const allow = new Set(context.options[0]?.allow ?? DEFAULT_ALLOW);

    /** @param {import('estree').Node} node @param {string} raw @param {number} offset */
    function scan(node, raw, offset) {
      // Bare `rounded`, which is off the ladder while looking like it is on it.
      for (const match of raw.matchAll(BARE_ROUNDED)) {
        const at = node.range[0] + offset + match.index + match[0].indexOf("rounded");
        const range = [at, at + "rounded".length];
        context.report({
          node,
          loc: {
            start: context.sourceCode.getLocFromIndex(range[0]),
            end: context.sourceCode.getLocFromIndex(range[1]),
          },
          messageId: "bare",
          fix: (fixer) => fixer.replaceTextRange(range, "rounded-sm"),
        });
      }

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

/**
 * Out-of-flow stacking has exactly four rungs (globals.css `--z-*`, mapped in
 * tailwind.config.ts). Anything at or above the popper layer must name one.
 *
 * Below that threshold, `z-10`/`z-20` inside a component's own stacking context
 * are local business and none of this rule's concern — the failure mode being
 * prevented is the global one, where a floating toolbar picks `z-[70]` and a
 * skip link picks `z-[100]` because neither could see what the other chose.
 */
const Z_TOKENS = "z-popper (menus, popovers, tooltips) · z-modal (dialogs) · z-toolbar · z-toast";
const Z_THRESHOLD = 50;
const Z_UTILITY = /(?:^|\s|:)(?:-)?z-(?:\[(\d+)\]|(\d+))(?=\s|$|"|'|`)/g;

const noAdHocStacking = {
  meta: {
    type: "problem",
    docs: { description: "Name the stacking layer instead of picking a z-index." },
    schema: [],
    messages: {
      adHoc:
        "`z-{{value}}` picks a number on the out-of-flow layer. Use a named rung: " +
        Z_TOKENS +
        ". (Local z-10/z-20 inside your own stacking context is fine.)",
    },
  },
  create(context) {
    function scan(node, raw, offset) {
      for (const match of raw.matchAll(Z_UTILITY)) {
        const value = Number(match[1] ?? match[2]);
        if (value < Z_THRESHOLD) continue;
        const start = node.range[0] + offset + match.index + match[0].indexOf("z-");
        context.report({
          node,
          loc: {
            start: context.sourceCode.getLocFromIndex(start),
            end: context.sourceCode.getLocFromIndex(start + `z-${value}`.length),
          },
          messageId: "adHoc",
          data: { value: String(value) },
        });
      }
    }
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        scan(node, node.raw, 0);
      },
      TemplateElement(node) {
        scan(node, node.value.raw, 1);
      },
    };
  },
};

const plugin = {
  rules: {
    "no-arbitrary-radius": noArbitraryRadius,
    "no-ad-hoc-stacking": noAdHocStacking,
  },
};

export default plugin;
