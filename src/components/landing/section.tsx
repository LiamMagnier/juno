import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

/**
 * Shared shell for landing-page sections. The eyebrow/heading/lede stack that
 * used to live here now IS the app's PageHeader — same component the signed-in
 * pages open with — so this is the container and nothing else.
 *
 * Gutter note: `px-4 sm:px-6` matches every app screen (projects, settings,
 * upgrade, artifacts, work). The landing used to indent 24px on a phone where
 * the app indents 16px, so crossing the sign-in wall shifted the whole left
 * edge by 8px — the first thing a new account sees.
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
    <section id={id} className={cn("mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-14 sm:px-6 sm:py-16", className)}>
      <PageHeader eyebrow={eyebrow} heading={heading} lede={lede} />
      {children}
    </section>
  );
}
