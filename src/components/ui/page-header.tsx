/**
 * Serif display heading → optional one-line lede.
 *
 * `eyebrow` is still accepted but no longer drawn (7 Nov 2026): a mono label
 * restating the section above every heading was decoration, not structure.
 *
 * This was landing/section.tsx's private markup, and it is the strongest
 * existing bridge across the sign-in wall: /upgrade, /tasks, /memory,
 * /connections, /artifacts and /roadmap all open with the same three lines,
 * hand-copied. Promoting it is the cheapest way to guarantee the two sides
 * never drift, and it collapses what had become a third competing eyebrow
 * treatment.
 *
 * `text-label` is written as a token rather than spelled out longhand: cn() is
 * now configured to know Juno's word-named font sizes, so the size survives
 * sitting next to a text-* colour (see the note in lib/utils.ts).
 *
 * Server component — zero client JS, which is what lets the landing stay free
 * of a bundle of its own.
 */
export function PageHeader({
  heading,
  lede,
  as: H = "h2",
  className,
}: {
  eyebrow?: React.ReactNode;
  heading: React.ReactNode;
  lede?: React.ReactNode;
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <header className={className}>
      <H className="max-w-2xl text-balance font-serif text-display font-medium tracking-tight">{heading}</H>
      {lede && <p className="mt-3 max-w-2xl text-pretty text-body-lg text-muted-foreground">{lede}</p>}
    </header>
  );
}
