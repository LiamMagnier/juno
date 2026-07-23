import { cn } from "@/lib/utils";

/** A whisper-quiet dotted rule. With `label`, centers a mono label between dots. */
export function DottedDivider({ className, label }: { className?: string; label?: string }) {
  if (label) {
    return (
      <div className={cn("flex items-center gap-3", className)} aria-hidden>
        <span className="h-px flex-1 border-t border-dotted border-border" />
        <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
        <span className="h-px flex-1 border-t border-dotted border-border" />
      </div>
    );
  }
  return <div className={cn("border-t border-dotted border-border", className)} aria-hidden />;
}
