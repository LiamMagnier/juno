import * as React from "react";

/**
 * The Juno mark set.
 *
 * WHY THIS EXISTS. Every glyph in the product used to be a Lucide icon. Lucide
 * is a good, complete, consistent set — and it is the set several hundred other
 * products also ship, drawn on a 24-unit grid with 2-unit corner radii and a
 * hairline everywhere. Beside Claude's and ChatGPT's own marks it reads as a
 * default: correct, unowned, and a half-step less considered than the surfaces
 * around it.
 *
 * This is the same vocabulary redrawn in Juno's hand. The rules, applied to all
 * of them so the set reads as one system rather than 200 decisions:
 *
 *   GRID      24 x 24, with the live area inset to 3 → 21. Nothing touches the
 *             box edge, so a mark never collides with its neighbour's stroke in
 *             a dense row.
 *   RADIUS    Generous. A 16-unit container rounds at 3.2, a 10-unit one at
 *             2.4, a 6-unit one at 1.8 — roughly r = w/5, which is the single
 *             biggest reason a mark reads as soft rather than technical.
 *   STROKE    One weight, round caps, round joins. The optical ladder in
 *             globals.css sets the number per rendered size; nothing here
 *             hard-codes it.
 *   CLEARANCE No two parallel strokes closer than 2 units. Below that they
 *             merge into a grey lozenge at 14px, which is where Lucide's more
 *             detailed marks (the pen nib, the bookshelf) fell apart.
 *   COUNT     Four elements is the budget. Anything needing more is the wrong
 *             drawing of the idea.
 *
 * WHAT A PART IS. Elements may carry `data-part`, which is what the hover
 * choreography in globals.css keys on — `accent` twinkles, `arrow` travels
 * along its axis, `rotor` turns, `alt` cross-fades in as `base` leaves. The
 * motion is written ONCE against those five names rather than per icon, so a
 * new mark inherits the system's behaviour by naming its parts, and hovering a
 * row never becomes a surprise.
 */

/** One drawn element: an SVG tag plus its attributes, in React casing. */
export type IconNode = readonly (readonly [string, Record<string, string | number>])[];

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  /**
   * Rendered size in px. Sizing is normally done with a `size-*` class, because
   * the stroke ladder keys on one — this is here for the handful of callers
   * that compute a size at runtime.
   */
  size?: number | string;
}

export type IconComponent = React.ForwardRefExoticComponent<
  IconProps & React.RefAttributes<SVGSVGElement>
> & {
  /** The geometry, readable by tooling — the native asset generator reads it. */
  readonly iconNode: IconNode;
  readonly iconName: string;
};

/**
 * `LucideIcon` under its own name. Kept as an alias so the many `icon: Icon`
 * props across the app keep one type to point at.
 */
export type Icon = IconComponent;

export function createIcon(iconName: string, iconNode: IconNode): IconComponent {
  const Component = React.forwardRef<SVGSVGElement, IconProps>(
    ({ size, className, children, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Decorative by default. Every icon-only control in this app names
        // itself (IconButton requires `label`), so announcing the glyph too
        // would double every toolbar button in a screen reader. A caller that
        // passes `aria-label` or a `role` overrides this via `rest`.
        aria-hidden="true"
        {...(size == null ? null : { width: size, height: size })}
        className={["juno-icon", `juno-icon--${iconName}`, className].filter(Boolean).join(" ")}
        {...rest}
      >
        {iconNode.map(([Tag, attrs], index) =>
          React.createElement(Tag, { key: `${iconName}-${index}`, ...attrs })
        )}
        {children}
      </svg>
    )
  );
  Component.displayName = iconName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return Object.assign(Component, { iconNode, iconName }) as IconComponent;
}

/* ---------------------------------------------------------------------------
 * Drawing shorthands.
 *
 * Glyphs are written as data rather than JSX so the geometry stays readable as
 * geometry — and so tooling can consume it. `scripts/generate-native-icons.mjs`
 * emits the iOS and macOS asset catalogs straight from these arrays, which is
 * what keeps a Juno mark identical on every platform.
 * ------------------------------------------------------------------------ */

export type IconElement = readonly [string, Record<string, string | number>];

const withPart = (attrs: Record<string, string | number>, part?: string) =>
  part ? { ...attrs, "data-part": part } : attrs;

/** A path. `part` opts the element into the shared hover choreography. */
export const p = (d: string, part?: string): IconElement => ["path", withPart({ d }, part)];

/** A circle. */
export const c = (cx: number, cy: number, r: number, part?: string): IconElement => [
  "circle",
  withPart({ cx, cy, r }, part),
];

/** A rounded rectangle. Radius is explicit: it is the set's loudest signature. */
export const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  part?: string
): IconElement => ["rect", withPart({ x, y, width, height, rx: radius }, part)];

/** A straight line. */
export const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  part?: string
): IconElement => ["line", withPart({ x1, y1, x2, y2 }, part)];

/** A dashed path — for provisional, draft and empty states. */
export const dashed = (d: string, dash = "3.2 3.4", part?: string): IconElement => [
  "path",
  withPart({ d, strokeDasharray: dash }, part),
];

/** A filled dot. Solid, not a hairline ring: below 16px a stroked `r=1`
 *  circle is a grey smudge, which is what made overflow and step markers the
 *  muddiest glyphs in the old set. */
export const dot = (cx: number, cy: number, r = 1.3, part?: string): IconElement => [
  "circle",
  withPart({ cx, cy, r, fill: "currentColor", stroke: "none" }, part),
];
