import { cn } from "@/lib/utils";

/** "Léa Petit" → "LP", "noah.bernard@x" → "NB", "" → "?". */
export function monogramOf(name: string | null | undefined): string {
  const source = (name ?? "").split("@")[0].trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "");
  return letters.toUpperCase() || "?";
}

/**
 * A person without a photo: their initials on a quiet neutral disc, the way
 * every serious product draws it. It replaced the dot-matrix identicon
 * (7 Nov 2026), which read as generated decoration rather than a person.
 *
 * Drawn as SVG so the letters scale with whatever size the caller sets, from a
 * 16px byline to a 76px profile avatar, with no size-specific font classes.
 */
export function Monogram({ name, className }: { name: string | null | undefined; className?: string }) {
  const letters = monogramOf(name);
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={cn("shrink-0 rounded-full", className)}>
      <circle cx="20" cy="20" r="20" className="fill-foreground/[0.07]" />
      <text
        x="20"
        y="20"
        dy="0.36em"
        textAnchor="middle"
        className="fill-muted-foreground font-sans"
        style={{ fontSize: letters.length > 1 ? 14.5 : 16, fontWeight: 600, letterSpacing: "0.01em" }}
      >
        {letters}
      </text>
    </svg>
  );
}
