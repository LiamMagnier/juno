import { cn } from "@/lib/utils";

export function JunoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("text-primary", className)} fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" opacity="0.22" />
      <path
        d="M21.5 6.4a11 11 0 1 0 4.1 13.2 8.6 8.6 0 0 1-4.1-13.2Z"
        fill="currentColor"
      />
    </svg>
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
