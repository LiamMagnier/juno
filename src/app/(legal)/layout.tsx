import { PublicDocumentNav } from "@/components/public/document-nav";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";



/** The prose treatment, as plain `[&_…]` selectors on the article. */
const ARTICLE = [
  "pb-16 text-body-lg leading-relaxed text-foreground/90",
  // Headings on Juno's own scale (display / title / heading). The tokens carry
  // weight and tracking, so nothing is restated beside them.
  "[&_h1]:text-balance [&_h1]:font-serif [&_h1]:text-display [&_h1]:font-medium [&_h1]:tracking-tight [&_h1]:text-foreground",
  "[&_h2]:mt-12 [&_h2]:font-serif [&_h2]:text-title [&_h2]:text-foreground",
  "[&_h3]:mt-6 [&_h3]:font-serif [&_h3]:text-heading [&_h3]:text-foreground",
  // Body rhythm.
  "[&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_li]:pl-1",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
  // rounded-xs so the global :focus-visible outline traces the link rather
  // than a hard rectangle; the colour shift answers focus as well as hover.
  "[&_a]:rounded-xs [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors [&_a]:duration-fast [&_a]:ease-out-soft [&_a:hover]:text-primary [&_a:focus-visible]:text-primary",
  // Tables (plans/prix in the CGU). The scroll container is the
  // `overflow-x-auto` wrapper the page puts around the table — a real table
  // box, never `display:block`, so the row/cell semantics survive.
  "[&_table]:mt-4 [&_table]:max-w-full [&_table]:border-collapse [&_table]:text-body",
  "[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-sans [&_th]:text-label [&_th]:text-muted-foreground",
  "[&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2",
].join(" ");

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="alevr-public relative min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <div className="alevr-document-layout">
        <PublicDocumentNav />
        <main lang="fr" className="alevr-document-main">
          <article className={ARTICLE}>{children}</article>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
