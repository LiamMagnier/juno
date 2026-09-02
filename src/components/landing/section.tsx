import { AppPage } from "@/components/ui/app-page";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

/**
 * Shared shell for landing-page sections. The eyebrow/heading/lede stack IS
 * the app's PageHeader — same component the signed-in pages open with — and
 * the column is the app's own page frame at the `wide` measure, so the
 * landing and the product behind the sign-in wall share one width and one
 * gutter. `scroll={false}`: the document scrolls, not the section.
 *
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
    // `scroll-mt-20`: the landing header is sticky, so an anchor jump to one of
    // these ids (#models, #pricing, …) would otherwise land the heading directly
    // underneath the bar.
    <section id={id} className={cn("scroll-mt-20", className)}>
      <LandingColumn contentClassName="py-14 sm:py-16">
        <PageHeader eyebrow={eyebrow} heading={heading} lede={lede} />
        {children}
      </LandingColumn>
    </section>
  );
}

/**
 * The landing's column: the app page frame, unscrolled, at the `wide`
 * measure. The header, hero, sections and footer all sit on it, so the
 * wordmark in the bar, the hero's left edge and every section heading share
 * one x-coordinate. `contentClassName` sets the vertical rhythm per use.
 */
export function LandingColumn({
  children,
  className,
  contentClassName,
}: {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <AppPage scroll={false} measure="wide" className={className} contentClassName={cn("py-0", contentClassName)}>
      {children}
    </AppPage>
  );
}
