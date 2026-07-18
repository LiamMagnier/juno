import Image from "next/image";
import { cn } from "@/lib/utils";

// The Juno mark: a transparent black glyph (chat-bubble "G" + spark). `dark:invert`
// flips it to light so it stays legible on the warm-charcoal dark theme.
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
      className={cn("h-6 w-6 select-none dark:invert", className)}
    />
  );
}

export function JunoLogo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <JunoMark className="h-6 w-6" />
      {showWordmark && <span className="text-lg font-semibold tracking-tight">Juno</span>}
    </span>
  );
}
