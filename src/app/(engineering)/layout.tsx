import Link from "next/link";
import { ArrowLeft } from "@/components/ui/icons";
import { AppPage } from "@/components/ui/app-page";
import { JunoMark } from "@/components/brand/logo";

/**
 * Shell for Juno's public engineering writing.
 *
 * The same idea as the legal group — a page outside the app shell, on the
 * app's own frame and type scale — with two differences. The measure is `wide`
 * rather than `reading`, because these pages carry tables and a table at a
 * 48rem measure scrolls sideways on a desktop; the article column inside is
 * held to a reading width by the page itself. And the top bar is sticky, so
 * the way back out of a long essay is always one click away.
 *
 * `lang="en"` is stated rather than inherited: the root layout sets the
 * document language from the reader's locale, and these pages are written in
 * English whatever that locale happens to be.
 */
export default function EngineeringLayout({ children }: { children: React.ReactNode }) {
  return (
    <div lang="en" className="min-h-dvh bg-background text-foreground">
      {/* z-10, not a named rung: this bar is in-flow page chrome inside this
          layout's own stacking context, not a popper/modal/toast — which is
          exactly the split `no-ad-hoc-stacking` draws at 50. */}
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <AppPage scroll={false} measure="wide" contentClassName="py-0">
          <header className="flex items-center justify-between gap-4 py-3.5">
            <Link
              href="/"
              className="group inline-flex items-center gap-2 rounded-xs font-mono text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
            >
              <ArrowLeft
                className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5 group-focus-visible:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                aria-hidden
              />
              Back to Juno
            </Link>
            <Link
              href="/"
              aria-label="Juno"
              className="rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              <JunoMark className="size-7" />
            </Link>
          </header>
        </AppPage>
      </div>

      <AppPage scroll={false} measure="wide" contentClassName="pb-20 pt-10 sm:pt-14">
        {children}
      </AppPage>

      <div className="border-t border-border/60">
        <AppPage scroll={false} measure="wide" contentClassName="py-8">
          <nav aria-label="Elsewhere" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground">
            {[
              { href: "/", label: "Juno" },
              { href: "/legal/confidentialite", label: "Privacy" },
              { href: "/legal/cgu", label: "Terms" },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-xs transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <p className="mt-3 font-mono text-caption text-muted-foreground">
            Juno engineering · Operated from France.
          </p>
        </AppPage>
      </div>
    </div>
  );
}
