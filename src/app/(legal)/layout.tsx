import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { JunoMark } from "@/components/brand/logo";
import { staggerDelay } from "@/lib/motion";

/**
 * Shared shell for the French legal pages (mentions légales, confidentialité,
 * CGU): a calm max-w-3xl reading column with serif headings, a back link to
 * the app, and a footer nav between the three documents. Pages render plain
 * semantic HTML; the article selectors below give it the prose treatment.
 */

const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Confidentialité" },
  { href: "/legal/cgu", label: "CGU" },
  { href: "/legal/mentions-legales", label: "Mentions légales" },
];

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div lang="fr" className="min-h-dvh bg-background text-foreground">
      {/* px-4 sm:px-6 — every other surface in the product (landing, its
          sections, the share page, the app screens) indents 16px on a phone.
          This column indented 24px unconditionally, which is the same 8px seam
          landing/section.tsx documents having closed. */}
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6 sm:py-14">
        <header className="flex items-center justify-between gap-4 motion-safe:animate-fade-in">
          {/* `group` so the arrow answers focus as well as hover — a keyboard user
              had no affordance at all on the page's only navigation control. */}
          <Link
            href="/"
            className="group inline-flex items-center gap-2 rounded-xs font-mono text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
          >
            <ArrowLeft
              className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5 group-focus-visible:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              aria-hidden
            />
            Retour à Juno
          </Link>
          <Link
            href="/"
            aria-label="Juno"
            className="rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <JunoMark className="h-8 w-8" />
          </Link>
        </header>

        <main
          style={staggerDelay(1, "loose")}
          className="flex-1 pt-10 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
        >
          <article
            className={[
              "pb-16 text-body leading-relaxed text-foreground/90",
              // Headings — editorial serif on Juno's OWN scale (display / title /
              // heading). This was written entirely in Tailwind defaults —
              // text-4xl / text-2xl / text-lg, i.e. 36 / 24 / 18px — none of
              // which exist on the product's ladder, so the three legal
              // documents rendered headings at sizes that appear nowhere else.
              // The tokens already carry weight and tracking, so the
              // font-medium/tracking-tight pairs they used to need are gone.
              "[&_h1]:font-serif [&_h1]:text-display [&_h1]:text-balance [&_h1]:text-foreground",
              "[&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-title [&_h2]:text-foreground",
              "[&_h3]:mt-6 [&_h3]:font-serif [&_h3]:text-heading [&_h3]:text-foreground",
              // Body rhythm.
              "[&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_li]:pl-1",
              "[&_strong]:font-semibold [&_strong]:text-foreground",
              // rounded-xs so the global :focus-visible outline traces the link
              // rather than a hard rectangle; the colour shift answers focus too,
              // since hover was the only signal these had.
              "[&_a]:rounded-xs [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors [&_a]:duration-fast [&_a]:ease-out-soft [&_a:hover]:text-primary [&_a:focus-visible]:text-primary",
              // Tables (plans/prix in the CGU). The scroll container is the
              // `overflow-x-auto` wrapper the page puts around the table
              // (cgu/page.tsx) — any new table here needs the same one.
              // It is NOT `[&_table]:block` any more. Forcing display:block on a
              // <table> drops its table box, and with it the implicit table/row/
              // cell semantics a screen reader announces the price grid by — for
              // a scroll that a wrapper was already doing, on a two-column table
              // that has never come close to overflowing 343px. Block also
              // stretched those two short columns across the full 700px measure;
              // a real table box shrink-to-fits and the price sits beside its
              // plan, which is how the row was written to read.
              "[&_table]:mt-4 [&_table]:max-w-full [&_table]:border-collapse [&_table]:text-body",
              "[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-mono [&_th]:text-label [&_th]:text-muted-foreground",
              "[&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2",
            ].join(" ")}
          >
            {children}
          </article>
        </main>

        <footer className="border-t border-border/60 py-8">
          <nav aria-label="Pages légales" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
            {LEGAL_LINKS.map((link, i) => (
              <span key={link.href} className="inline-flex items-center gap-2">
                {i > 0 && <span aria-hidden>·</span>}
                <Link
                  href={link.href}
                  className="rounded-xs transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </nav>
          {/* No /80: --muted-foreground is already tuned to the 4.5:1 floor, and
              at 11px a further 20% of transparency puts this under it with no
              large-text exemption available. */}
          <p className="mt-3 text-caption text-muted-foreground">
            Juno — chat.liams.dev. Un service exploité depuis la France.
          </p>
        </footer>
      </div>
    </div>
  );
}
