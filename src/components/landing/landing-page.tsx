import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JunoMark } from "@/components/brand/logo";
import { AsciiWordmark, DotMatrixMark } from "@/components/signature/dot-matrix";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { FlagshipStrip, ModelLineup } from "@/components/landing/model-lineup";
import { Metering } from "@/components/landing/metering";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";

/**
 * The public front door (signed-out "/"). Entirely server-rendered — model
 * names, counts and prices are read from the registry at render time, so the
 * page can never disagree with the product. The only coral action on the page
 * is the hero's "Create account".
 */

const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Confidentialité" },
  { href: "/legal/cgu", label: "CGU" },
  { href: "/legal/mentions-legales", label: "Mentions légales" },
];

const PRODUCT_LINKS = [
  { href: "/sign-in", label: "Sign in" },
  { href: "/sign-up", label: "Create account" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/downloads/Juno.dmg", label: "Download for macOS" },
];

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Juno" className="inline-flex items-center gap-2.5 rounded-md">
          <JunoMark className="h-7 w-7" />
          <AsciiWordmark />
        </Link>
        <nav aria-label="Account" className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/sign-up">Create account</Link>
          </Button>
        </nav>
      </header>

      <main>
        {/* Hero — static dot-grid backdrop (CSS only, no canvas) + faint coral wash. */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_45%_at_50%_0%,hsl(var(--primary)/0.1),transparent_70%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1.5px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]"
          />
          <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-14 sm:pb-20 sm:pt-20">
            <p className="flex items-center gap-2 font-mono text-label uppercase text-muted-foreground motion-safe:animate-fade-in">
              <DotMatrixMark className="h-4 w-4" />
              Multi-model AI chat
            </p>
            <h1 className="mt-4 max-w-3xl text-balance font-serif text-hero font-medium tracking-tight motion-safe:animate-rise-in [animation-fill-mode:backwards]">
              Every frontier model. <span className="text-primary">One honest subscription.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-pretty text-body-lg text-muted-foreground motion-safe:animate-rise-in [animation-delay:60ms] [animation-fill-mode:backwards]">
              Juno puts Claude, GPT, Gemini and a dozen more labs in one calm workspace — voice, artifacts, projects
              and a coding agent included — with the real cost of every answer on the receipt.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:120ms] [animation-fill-mode:backwards]">
              <Button asChild size="lg">
                <Link href="/sign-up">
                  Create account
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link href="/sign-in">Sign in</Link>
              </Button>
            </div>
            <div className="mt-14 motion-safe:animate-fade-in [animation-delay:200ms] [animation-fill-mode:backwards]">
              <DottedDivider label="In the picker today" className="mb-5" />
              <FlagshipStrip />
            </div>
          </div>
        </section>

        <Metering />
        <ModelLineup />
        <Features />
        <Pricing />
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-6 py-10">
          <div className="flex flex-col justify-between gap-8 sm:flex-row">
            <div>
              <Link href="/" aria-label="Juno" className="inline-flex items-center gap-2.5 rounded-md">
                <JunoMark className="h-6 w-6" />
                <AsciiWordmark />
              </Link>
              <p className="mt-3 max-w-xs text-caption text-muted-foreground">
                Every frontier model, one honest subscription. Operated from France.
              </p>
            </div>
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 gap-y-1.5 text-sm">
              <div className="space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">Product</p>
                {PRODUCT_LINKS.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className="block w-fit rounded-sm text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
                  >
                    {label}
                  </Link>
                ))}
              </div>
              <div className="space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">Legal</p>
                {LEGAL_LINKS.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className="block w-fit rounded-sm text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
          <p className="mt-8 border-t border-border/60 pt-6 text-caption text-muted-foreground/80">
            Juno — chat.liams.dev · © {new Date().getFullYear()}
          </p>
        </div>
      </footer>
    </div>
  );
}
