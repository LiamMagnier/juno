import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { JunoMark } from "@/components/brand/logo";

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
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10 sm:py-14">
        <header className="flex items-center justify-between gap-4 motion-safe:animate-fade-in">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md font-mono text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Retour à Juno
          </Link>
          <Link href="/" aria-label="Juno" className="rounded-md">
            <JunoMark className="h-8 w-8" />
          </Link>
        </header>

        <main className="flex-1 pt-10 motion-safe:animate-rise-in [animation-delay:60ms] [animation-fill-mode:backwards]">
          <article
            className={[
              "pb-16 text-[0.9375rem] leading-relaxed text-foreground/90",
              // Headings — editorial serif, matching the app's display voice.
              "[&_h1]:font-serif [&_h1]:text-4xl [&_h1]:font-medium [&_h1]:tracking-tight [&_h1]:text-balance [&_h1]:text-foreground",
              "[&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-foreground",
              "[&_h3]:mt-6 [&_h3]:font-serif [&_h3]:text-lg [&_h3]:font-medium [&_h3]:text-foreground",
              // Body rhythm.
              "[&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_li]:pl-1",
              "[&_strong]:font-semibold [&_strong]:text-foreground",
              "[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-primary",
              // Tables (plans/prix in the CGU) scroll inside their wrapper on narrow screens.
              "[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
              "[&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-mono [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground",
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
                  className="rounded-sm transition-colors duration-fast ease-out-soft hover:text-foreground"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </nav>
          <p className="mt-3 text-caption text-muted-foreground/80">
            Juno — chat.liams.dev. Un service exploité depuis la France.
          </p>
        </footer>
      </div>
    </div>
  );
}
