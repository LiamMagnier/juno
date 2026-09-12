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

/**
 * px -> token. The ladder as `tailwind.config.ts` actually declares it, and as
 * `src/lib/design/tokens.generated.ts` (RADIUS) generates it from there.
 *
 * THIS TABLE HAD DRIFTED, and because the rule is `fixable: "code"` and wired as
 * an error, the drift was not merely unhelpful — `eslint --fix` was rewriting
 * correct code to wrong values. Eleven of the fifteen rungs were off, most of
 * them by naming a token whose real value is a different size: `rounded-[16px]`
 * was "fixed" to `rounded-card`, which is 14px, so a correct radius silently
 * became a 2px-smaller one. Others named the right size under the wrong token
 * (`12px` -> `field`, which is 10px).
 *
 * Values that are genuinely NOT on the ladder (11, 13, 20, 22, 24, 28px) are
 * deliberately absent rather than mapped to their nearest neighbour: the rule
 * reports those as `offScale` with `fix: null`, which asks a human to pick a
 * rung or name a new token. An autofix is only ever correct when the px value
 * and the token's value are the same number.
 *
 * Where several tokens share a value the general-purpose one is the suggestion:
 * 10px is `control` (not `composer-control`), 12px is `field` (not
 * `composer-action`), 16px is `card` (not `popover`, `surface` or the generic
 * `lg`), 20px is `panel` (not `composer`). All of those remain valid to write by
 * hand; this is only what the fixer reaches for.
 *
 * This paragraph described a DIFFERENT ladder until now — it said 12px was
 * `menu` and 14px was `card`, which are the values the table above was corrected
 * away from. A comment that disagrees with the table beside it is how the table
 * drifted in the first place.
 *
 * If the ladder moves, `npm run design:tokens` regenerates RADIUS from the
 * Tailwind config — this table must be updated to match it in the same change.
 */
const RADIUS_TOKENS = {
  "2px": "micro",
  "4px": "sm",
  "6px": "xs",
  "8px": "md",
  "10px": "control",
  "12px": "field",
  "14px": "menu",
  "16px": "card",
  "20px": "panel",
  inherit: "inherit",
};

const SCALE_HELP =
  "micro 2 · sm 4 · xs 6 · md 8 · control 10 · composer-control 10 · field 12 · " +
  "composer-action 12 · menu 14 · card 16 · popover 16 · surface 16 · lg 16 · panel 20 · " +
  "composer 20 · full · logo (24%)";

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

/**
 * The concentric radius rule, which `tailwind.config.ts` has stated for as long
 * as the ladder has existed and nothing has ever checked:
 *
 *     inner radius = outer radius − padding
 *
 * Two boxes read as one object only when their corners are struck from the same
 * centre. Get it wrong and the inner box looks either pinched or inflated, and
 * the effect compounds: the Library's file tile was a 16px card with 12px of
 * padding holding a 12px well, so the thumbnail's corners were three times
 * rounder than the geometry allows, and the tile stopped reading as a frame
 * around a picture.
 *
 * The rule is deliberately narrow, because a false positive here costs a
 * developer more than a missed one costs a design. It fires only when the parent
 * declares BOTH a radius and symmetric padding in one literal className, or is
 * one of the wrapper components below whose radius is fixed in its own source,
 * and the child declares a plain radius of its own.
 */
const RADIUS_PX = {
  none: 0,
  micro: 2,
  sm: 4,
  xs: 6,
  md: 8,
  control: 10,
  "composer-control": 10,
  field: 12,
  "composer-action": 12,
  menu: 14,
  card: 16,
  popover: 16,
  surface: 16,
  lg: 16,
  panel: 20,
  composer: 20,
};

/** px -> the token the message suggests. Mirrors RADIUS_TOKENS, keyed by number. */
const PX_TO_TOKEN = {
  0: "none",
  2: "micro",
  4: "sm",
  6: "xs",
  8: "md",
  10: "control",
  12: "field",
  14: "menu",
  16: "card",
  20: "panel",
};

/**
 * Wrapper components whose radius is fixed in their own source, so a call site
 * that adds padding to one is still a concentric parent even though no
 * `rounded-*` appears at the call site. Verified against
 * `src/components/ui/*.tsx`; if one of those changes rung, change it here in the
 * same commit. Anything not listed is simply not checked — silence is the
 * correct answer for a parent whose radius this rule cannot know.
 */
const COMPONENT_RADIUS = {
  Card: 16, // card.tsx — rounded-card
  DialogContent: 20, // dialog.tsx — rounded-panel
  SheetContent: 20, // sheet.tsx — rounded-r-panel
  PopoverContent: 16, // popover.tsx — rounded-popover
  SelectContent: 16, // select.tsx — rounded-popover
  DropdownMenuContent: 16, // dropdown-menu.tsx — rounded-popover
  TooltipContent: 10, // tooltip.tsx — rounded-control
};

/** `p-3` -> 12. Symmetric padding only: px-/py- do not inset all four corners. */
const PADDING_PX = {
  "0": 0,
  px: 1,
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "5": 20,
  "6": 24,
  "7": 28,
  "8": 32,
};

/**
 * Symmetric padding, unprefixed: `p-3`, not `sm:p-3` and not `px-3`. Only `p-`
 * insets all four corners, which is the only case where the child's corners and
 * the parent's are struck from one centre.
 */
const PLAIN_PADDING = /(?:^|\s)p-([0-9.]+|px)(?=\s|$)/;

/**
 * Every string literal reachable from a className expression, including the
 * arguments of a `cn(...)`/`clsx(...)` call and both arms of a ternary. Returned
 * joined, because a radius and a padding written in two different arguments of
 * the same `cn()` still land on the same element.
 */
function classStrings(node) {
  if (!node) return "";
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : "";
    case "JSXExpressionContainer":
      return classStrings(node.expression);
    case "TemplateLiteral":
      return node.quasis.map((q) => q.value.raw).join(" ");
    case "CallExpression":
      return node.arguments.map(classStrings).join(" ");
    case "ConditionalExpression":
      // Both arms, so a radius that only appears in one is still seen. This can
      // over-read — two arms offering different radii read as both — which is
      // why a parent offering two radii is skipped below rather than guessed at.
      return `${classStrings(node.consequent)} ${classStrings(node.alternate)}`;
    case "LogicalExpression":
      return classStrings(node.right);
    default:
      return "";
  }
}

function classNameOf(element) {
  const attr = element.openingElement?.attributes?.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  return attr ? classStrings(attr.value) : "";
}

function elementName(element) {
  const name = element.openingElement?.name;
  if (!name) return "";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property?.name ?? "";
  return "";
}

/** How many plain radii a className declares. More than one means "do not guess". */
function radiiIn(classes) {
  return [...classes.matchAll(/(?:^|\s)rounded-([a-z-]+)(?=\s|$)/g)].map((m) => m[1]);
}

/**
 * An explicit width that is not the full inner box, or an explicit square size.
 * A child narrower than its parent's content box is content sitting in the box,
 * not a box nested in the box — a skeleton bar at `w-3/4` is standing in for a
 * line of text, and striking its corners from the card's centre would be
 * geometry applied to something that is not there.
 */
const PARTIAL_WIDTH = /(?:^|\s)(?:w-(?:\d+\/\d+|\d+(?:\.\d+)?|px|fit|min|max|auto|screen|\[)|size-(?!full)[\w.[]+)/;

/**
 * Whether anything is actually drawn at this child's corners. A radius on a box
 * with no fill, edge, shadow or clip is invisible — it exists for a focus ring
 * or out of habit — and rounding it differently changes nothing a person sees.
 *
 * A capitalised component counts as painting: `<Skeleton className="rounded-…">`
 * carries its own surface, and the call site asking for a radius at all means
 * the author expects a visible corner.
 */
function paintsACorner(classes, name) {
  if (/^[A-Z]/.test(name)) return true;
  return /(?:^|\s)(?:bg-|border(?![-\w]*transparent)|shadow-|ring-|surface-|overlay-|overflow-hidden)/.test(classes);
}

/**
 * The elements that actually render as this element's children, seeing through
 * the expressions JSX children are usually wrapped in.
 *
 * Without this the rule was blind to the commonest shape in the codebase: a
 * track that renders its segments through `options.map(…)`. Those segments are
 * every bit as inset by the track's padding as a literal child, and the
 * thinking-effort slider's were 2px off for exactly as long as nothing looked.
 */
function renderedChildren(nodes, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const node of nodes ?? []) {
    if (!node) continue;
    switch (node.type) {
      case "JSXElement":
        out.push(node);
        break;
      case "JSXFragment":
        out.push(...renderedChildren(node.children, depth + 1));
        break;
      case "JSXExpressionContainer":
        out.push(...renderedChildren([node.expression], depth + 1));
        break;
      case "ConditionalExpression":
        out.push(...renderedChildren([node.consequent, node.alternate], depth + 1));
        break;
      case "LogicalExpression":
        out.push(...renderedChildren([node.right], depth + 1));
        break;
      case "CallExpression": {
        // `items.map(item => <Row …/>)` — only `.map`, because that is the one
        // whose result is rendered in place. A `cn()` or a handler is not.
        const callee = node.callee;
        const isMap = callee?.type === "MemberExpression" && callee.property?.name === "map";
        if (!isMap) break;
        const fn = node.arguments[0];
        if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) break;
        if (fn.body.type === "BlockStatement") {
          for (const statement of fn.body.body) {
            if (statement.type === "ReturnStatement" && statement.argument) {
              out.push(...renderedChildren([statement.argument], depth + 1));
            }
          }
        } else {
          out.push(...renderedChildren([fn.body], depth + 1));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const concentricRadius = {
  meta: {
    type: "problem",
    docs: {
      description: "A nested rounded box takes its parent's radius minus the parent's padding.",
    },
    schema: [],
    messages: {
      offCentre:
        "`rounded-{{actual}}` ({{actualPx}}px) inside a {{parentPx}}px parent with {{padding}}px of " +
        "padding is not concentric — the corners are struck from different centres. " +
        "Either use `rounded-{{expected}}` ({{expectedPx}}px), since {{parentPx}} − {{padding}} = {{expectedPx}}, " +
        "or keep this radius and change the parent's padding to {{keepPadding}}px. " +
        "Which one is right is a design call; the arithmetic is not.",
      offLadder:
        "`rounded-{{actual}}` inside a {{parentPx}}px parent with {{padding}}px of padding wants " +
        "{{expectedPx}}px, which is not a rung on the ladder. Change the padding to land on one, " +
        "or name a derived token in tailwind.config.ts the way `composer-action` is named.",
    },
  },

  create(context) {
    return {
      JSXElement(element) {
        const classes = classNameOf(element);
        const name = elementName(element);

        // The parent's radius: declared here, or fixed in a known component.
        const declared = radiiIn(classes);
        let parentPx;
        if (declared.length === 1) {
          parentPx = RADIUS_PX[declared[0]];
        } else if (declared.length === 0) {
          parentPx = COMPONENT_RADIUS[name];
        }
        // `rounded-full`, `rounded-logo`, `rounded-inherit`, a directional
        // variant, or two radii in two ternary arms: nothing to be concentric
        // with, so say nothing.
        if (typeof parentPx !== "number") return;

        const padding = PLAIN_PADDING.exec(classes);
        if (!padding) return; // px-/py- alone does not inset all four corners
        const paddingPx = PADDING_PX[padding[1]];
        if (typeof paddingPx !== "number" || paddingPx === 0) return;

        const expectedPx = parentPx - paddingPx;
        if (expectedPx <= 0) return; // the child has no corner left to round

        for (const child of renderedChildren(element.children)) {
          const childClasses = classNameOf(child);
          // Out of flow, so the parent's padding never insets it.
          if (/(?:^|\s)(?:absolute|fixed)(?=\s|$)/.test(childClasses)) continue;
          // A pill is a pill at any size, and a mark owns its own shape.
          if (/(?:^|\s)rounded-(?:full|logo|inherit|none)(?=\s|$)/.test(childClasses)) continue;
          // Narrower than the box it sits in: content, not a nested surface.
          if (PARTIAL_WIDTH.test(childClasses)) continue;
          // Nothing drawn at the corners, so the radius is not a visible edge.
          if (!paintsACorner(childClasses, elementName(child))) continue;

          const childRadii = radiiIn(childClasses);
          if (childRadii.length !== 1) continue; // absent, or conditional — not ours to guess
          const actual = childRadii[0];
          const actualPx = RADIUS_PX[actual];
          if (typeof actualPx !== "number" || actualPx === expectedPx) continue;

          const expected = PX_TO_TOKEN[expectedPx];
          const attr = child.openingElement.attributes.find(
            (a) => a.type === "JSXAttribute" && a.name?.name === "className",
          );
          context.report({
            node: attr ?? child.openingElement,
            messageId: expected ? "offCentre" : "offLadder",
            data: {
              actual,
              actualPx: String(actualPx),
              parentPx: String(parentPx),
              padding: String(paddingPx),
              expected: expected ?? "",
              expectedPx: String(expectedPx),
              keepPadding: String(parentPx - actualPx),
            },
          });
        }
      },
    };
  },
};

const plugin = {
  rules: {
    "no-arbitrary-radius": noArbitraryRadius,
    "no-ad-hoc-stacking": noAdHocStacking,
    "concentric-radius": concentricRadius,
  },
};

export default plugin;
