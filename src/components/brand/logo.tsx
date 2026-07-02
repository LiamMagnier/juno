import Image from "next/image";
import { cn } from "@/lib/utils";

// The Juno mark: a transparent black glyph (chat-bubble "G" + spark). `dark:invert`
// flips it to light so it stays legible on the warm-charcoal dark theme.
export function JunoMark({ className }: { className?: string }) {
  return (
    <Image
      src="/juno-mark.png"
      alt="Juno"
      width={512}
      height={512}
      priority
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
