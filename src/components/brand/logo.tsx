import Image from "next/image";
import { cn } from "@/lib/utils";

// The Juno mark: a transparent black glyph (chat-bubble "G" + spark). `dark:invert`
// flips it to light so it stays legible on the dark theme.
//
// `dark:brightness-[0.94]` rides with the invert. Inverting a pure-black glyph
// yields pure #FFFFFF, which is 21:1 against the OLED ground — and --foreground
// is set to 94% for the express purpose of avoiding that glare (see the note in
// globals.css beside the dark ramp). Without the clamp the mark was the single
// brightest object on every signed-out page, worst at the 40-44px lockups on the
// auth and suspended screens. 0.94 lands it exactly on the foreground ramp.
//
// `unoptimized`: serve the static PNG directly instead of routing through the
// /_next/image optimizer. The mark is tiny, always-visible chrome on every page,
// so it must never fail — and the optimizer is a dynamic endpoint that can
// 500/OOM under memory pressure on the small self-hosted `next start` VM, which
// surfaces as an intermittent broken-image box. A static file has no such
// failure mode. (The asset is a small 2-tone PNG, so optimization saved little.)
export function JunoMark({ className }: { className?: string }) {
  return (
    <Image
      src="/juno-mark.png"
      alt="Juno"
      width={512}
      height={512}
      priority
      unoptimized
      className={cn("h-6 w-6 select-none dark:invert dark:brightness-[0.94]", className)}
    />
  );
}

export function JunoLogo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <JunoMark className="h-6 w-6" />
      {showWordmark && <span className="text-heading">Juno</span>}
    </span>
  );
}
