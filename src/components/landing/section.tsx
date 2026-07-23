import { cn } from "@/lib/utils";

/**
 * Shared shell for landing-page sections: mono eyebrow → serif display
 * heading → optional one-line lede, then whatever the section renders.
 * Pure server markup — the landing ships zero client JS of its own.
 */
export function Section({
  id,
  eyebrow,
  heading,
  lede,
  children,
  className,
}: {
  id?: string;
  eyebrow: string;
  heading: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("mx-auto w-full max-w-6xl px-6 py-14 sm:py-16", className)}>
      <p className="font-mono text-label text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-3 max-w-2xl text-balance font-serif text-display font-medium tracking-tight">{heading}</h2>
      {lede && <p className="mt-3 max-w-2xl text-pretty text-body-lg text-muted-foreground">{lede}</p>}
      {children}
    </section>
  );
}
