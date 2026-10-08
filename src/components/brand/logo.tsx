import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { ContinuumMark } from "./continuum-mark";

/**
 * The product mark at a call site sized by a Tailwind `size-*` class: the
 * Continuum (continuum-mark.tsx), in the row's own colour.
 *
 * This used to draw `public/juno-mark.png`, the pre-rebrand chat-bubble mark,
 * which is how the model picker, the agent profile and notification rows kept
 * showing the old logo after the Alevr brand shipped. The Continuum picks its
 * optical master from the pixel size, so the size is read off the class
 * (`size-4` is 16 px) rather than left to CSS scaling a 24 px drawing.
 */
function pxFromClass(className?: string): number {
  const m = className?.match(/(?:^|\s)size-(\d+(?:\.5)?)(?=\s|$)/);
  return m ? Number(m[1]) * 4 : 24;
}

export function JunoMark({ className }: { className?: string }) {
  return <ContinuumMark size={pxFromClass(className)} tone="current" title={PRODUCT_NAME} className={cn("select-none", className)} />;
}

export function JunoLogo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <JunoMark className="size-6" />
      {showWordmark && <span className="text-heading">{PRODUCT_NAME}</span>}
    </span>
  );
}
