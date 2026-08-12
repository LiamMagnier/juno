/**
 * Colour arithmetic for the terminal palette.
 *
 * xterm needs sixteen ANSI colours plus a foreground, a background, a cursor
 * and a selection. Juno's design system does not contain sixteen hues — it
 * contains a warm neutral ramp and six semantic colours — so the palette is
 * *derived* from the tokens rather than picked. Everything in this file is a
 * pure function over a colour string so that derivation is inspectable and the
 * result follows light/dark automatically: every input is a CSS custom property
 * read at runtime, and none of it is a literal.
 *
 * Normalisation goes through a canvas rather than a hand-written parser. The
 * design tokens are bare HSL triplets (`54 18% 97%`), but the next revision of
 * the system could use `oklch()` or `color-mix()`, and a parser that understood
 * only what exists today would fail silently — as a wrong colour, which is the
 * hardest kind of bug to notice in a themeable surface. The browser's own
 * parser understands every syntax the browser understands, by definition.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

let normalizationContext: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (normalizationContext !== undefined) return normalizationContext;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    normalizationContext = canvas.getContext('2d');
  } catch {
    normalizationContext = null;
  }
  return normalizationContext;
}

/**
 * Turn any CSS colour into `#rrggbb`, or `null` if it is not a colour.
 *
 * `fillStyle` round-trips through the browser's colour parser and comes back
 * normalised. The sentinel dance is necessary because assigning an invalid
 * value to `fillStyle` is a silent no-op that leaves the previous value in
 * place — without it, one bad token would be reported as whatever the last good
 * one happened to be.
 */
export function normalizeColor(input: string): string | null {
  const candidate = input.trim();
  if (candidate.length === 0) return null;

  const ctx = context();
  if (!ctx) return null;

  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = candidate;
  const first = String(ctx.fillStyle);

  if (first.toLowerCase() === sentinel) {
    /* Either the value really is #010203, or it was rejected. Re-run against a
       different sentinel to tell the two apart. */
    const alternate = '#040506';
    ctx.fillStyle = alternate;
    ctx.fillStyle = candidate;
    if (String(ctx.fillStyle).toLowerCase() === alternate) return null;
  }

  return toHex(parseColor(first) ?? { r: 0, g: 0, b: 0 });
}

/**
 * A design token, resolved.
 *
 * Juno's tokens are stored as bare HSL components so Tailwind can compose them
 * with `/ <alpha-value>`. That means `getPropertyValue('--background')` returns
 * `54 18% 97%`, which is not a colour until it is wrapped. Values that already
 * carry their own function or `#` are passed through untouched, so the day a
 * token becomes `oklch(…)` this keeps working.
 */
export function resolveTokenColor(rawValue: string): string | null {
  const value = rawValue.trim();
  if (value.length === 0) return null;

  const isCompleteColor =
    value.startsWith('#') ||
    /^[a-z][a-z0-9-]*\(/i.test(value) ||
    /^[a-z]+$/i.test(value);

  return normalizeColor(isCompleteColor ? value : `hsl(${value})`);
}

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()`. Alpha is discarded. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = hex[0];
      const g = hex[1];
      const b = hex[2];
      if (r === undefined || g === undefined || b === undefined) return null;
      return {
        r: Number.parseInt(r + r, 16),
        g: Number.parseInt(g + g, 16),
        b: Number.parseInt(b + b, 16),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  const match = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!match?.[1]) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r: channel(r), g: channel(g), b: channel(b) };
}

function channel(part: string): number {
  const numeric = Number.parseFloat(part);
  if (Number.isNaN(numeric)) return 0;
  return clamp(Math.round(part.endsWith('%') ? (numeric / 100) * 255 : numeric), 0, 255);
}

export function toHex({ r, g, b }: Rgb): string {
  const pair = (value: number): string =>
    clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear blend in sRGB. `t = 0` returns `from`, `t = 1` returns `to`. */
export function mix(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return from;
  const ratio = clamp(t, 0, 1);
  return toHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;

  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;

  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

/** Shift lightness by `delta` (−1…1) and saturation by `saturationDelta`. */
export function adjust(color: string, delta: number, saturationDelta = 0): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const hsl = rgbToHsl(rgb);
  return toHex(
    hslToRgb({
      h: hsl.h,
      s: clamp(hsl.s + saturationDelta, 0, 1),
      l: clamp(hsl.l + delta, 0, 1),
    }),
  );
}

/** Rotate the hue by `degrees`, keeping saturation and lightness. */
export function rotateHue(color: string, degrees: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const hsl = rgbToHsl(rgb);
  return toHex(hslToRgb({ h: hsl.h + degrees, s: hsl.s, l: hsl.l }));
}

/** WCAG relative luminance, used only to decide which way "brighter" points. */
export function relativeLuminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  const channelLuminance = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** `rgba()` string at the given alpha. Used only where xterm allows alpha. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${clamp(
    alpha,
    0,
    1,
  )})`;
}
