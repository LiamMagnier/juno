import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppPage } from "@/components/ui/app-page";
import { JunoMark } from "@/components/brand/logo";
import { staggerDelay } from "@/lib/motion";

/**
 * Shared shell for the French legal pages (mentions légales, confidentialité,
 * CGU): the app's page frame at the `reading` measure, a simple top bar (back
 * link + mark), and a footer nav between the three documents. Pages render
 * plain semantic HTML; the article selectors below give it the prose
 * treatment on Juno's own type scale.
 *
 * `AppPage` is imported from `components/ui` directly — this route sits
 * outside the app shell, and the frame is a primitive with no app deps.
 */

const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Confidentialité" },
  { href: "/legal/cgu", label: "CGU" },
  { href: "/legal/mentions-legales", label: "Mentions légales" },
];

/** The prose treatment, as plain `[&_…]` selectors on the article. */
const ARTICLE = [
  "pb-16 text-body leading-relaxed text-foreground/90",
  // Headings on Juno's own scale (display / title / heading). The tokens carry
  // weight and tracking, so nothing is restated beside them.
  "[&_h1]:text-balance [&_h1]:font-sans [&_h1]:text-display [&_h1]:text-foreground",
  "[&_h2]:mt-10 [&_h2]:font-sans [&_h2]:text-title [&_h2]:text-foreground",
  "[&_h3]:mt-6 [&_h3]:font-sans [&_h3]:text-heading [&_h3]:text-foreground",
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
  "[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-mono [&_th]:text-label [&_th]:text-muted-foreground",
  "[&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2",
].join(" ");

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div lang="fr" className="min-h-dvh bg-background text-foreground">
      {/* The top bar: back link and mark, on the same reading column as the
          article so the arrow and the h1 share a left edge. */}
      <AppPage scroll={false} measure="reading" contentClassName="py-0">
        <header className="flex items-center justify-between gap-4 py-5 motion-safe:animate-fade-in sm:py-6">
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
            <JunoMark className="size-8" />
          </Link>
        </header>
      </AppPage>

      <AppPage scroll={false} measure="reading" contentClassName="pt-6 sm:pt-8">
        <main style={staggerDelay(1, "loose")} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
          <article className={ARTICLE}>{children}</article>
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
              at 11px a further 20% of transparency puts this under it. */}
          <p className="mt-3 font-mono text-caption text-muted-foreground">
            Juno — chat.liams.dev. Un service exploité depuis la France.
          </p>
        </footer>
      </AppPage>
    </div>
  );
}
