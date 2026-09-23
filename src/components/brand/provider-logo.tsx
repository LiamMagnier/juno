import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { PROVIDER_MARKS, markTransform } from "@/components/brand/provider-marks";

/**
 * A model lab's mark: the vector drawing in `currentColor`, with nothing
 * around it.
 *
 * BARE BY DEFAULT. Almost every call site draws the mark beside the model or
 * lab name (a chip, a picker row, the composer's model button), where a tile
 * is a box inside a box: it was a hairline square with 24% corners inside a
 * pill, and its card fill fought the chip's own hover and selected fills. The
 * bare mark takes the ink of the text next to it, so it dims and lights with
 * its row the way every other glyph does. Size it with a `size-*` class.
 *
 * `tile` is for the few places the mark stands on its own as an object: a lab
 * avatar in a list, an announcement's hero. It gives the mark a quiet muted
 * well at the logo radius (24%, one shape at every size) with the glyph at 60%
 * of the box, so the tile is sized by the same `size-*` class.
 *
 * NAMING. The mark is `aria-hidden` unless a `label` is passed: next to the
 * visible name it would be read twice, and the old two-image version lost its
 * name in dark mode anyway (the named light image was `display: none`). Pass
 * `label` where the mark is the only thing that says which lab it is.
 */
export function ProviderLogo({
  provider,
  className,
  label,
  tile = false,
}: {
  provider: Provider;
  className?: string;
  label?: string;
  /** Draw the mark on its own muted tile, for standalone uses. */
  tile?: boolean;
}) {
  const mark = PROVIDER_MARKS[provider] ?? PROVIDER_MARKS.openai;
  const named = label !== undefined;
  const a11y = named
    ? { role: "img" as const, "aria-label": label || PROVIDERS[provider]?.label || provider }
    : { "aria-hidden": true as const };

  const svg = (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      focusable="false"
      className={cn(tile ? "size-[60%]" : cn("size-4 shrink-0", className))}
      {...(tile ? { "aria-hidden": true as const } : a11y)}
    >
      <g transform={markTransform(mark)}>
        {mark.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );

  if (!tile) return svg;
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-logo bg-muted text-foreground",
        className
      )}
      {...a11y}
    >
      {svg}
    </span>
  );
}
