import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
import { JunoMark } from "@/components/brand/logo";
import { AsciiWordmark, DotMatrixMark } from "@/components/signature/dot-matrix";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { ComposerPreview, HERO_MODEL } from "@/components/landing/composer-preview";
import { FlagshipStrip, ModelLineup } from "@/components/landing/model-lineup";
import { Metering } from "@/components/landing/metering";
import { Features } from "@/components/landing/features";
import { Switching } from "@/components/landing/switching";
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

const PRODUCT_LINKS: { href: string; label: string; file?: boolean }[] = [
  { href: "/sign-in", label: "Sign in" },
  { href: "/sign-up", label: "Create account" },
  // /roadmap lives under the (app) route group, whose layout calls requireUser():
  // a signed-out visitor clicking it is silently bounced to a login form with no
  // explanation. `?next=` keeps the nav item and makes the redirect intentional.
  { href: "/sign-in?next=/roadmap", label: "Roadmap" },
  // `file` because this is not a route: a <Link> with no explicit prefetch
  // prefetches on viewport entry in production, and Juno.dmg is 21.9 MB — so
  // every visitor who merely scrolled to the footer was pulling down a disk
  // image they never asked for. features.tsx links the same href with a plain
  // <a>, which is the correct treatment; this makes the two agree.
  { href: "/downloads/Juno.dmg", label: "Download for macOS", file: true },
];

/** One hover/colour treatment for every footer link, whatever element renders it. */
const FOOTER_LINK =
  "block w-fit rounded-sm text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground";

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* px-4 sm:px-6 throughout: every app screen indents 16px on a phone, and
          the landing used to indent 24px, so crossing the sign-in wall shifted
          the whole left edge by 8px. */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
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
          {/* CSS twin of DotField's resting frame (dot-field.tsx: --foreground at
              0.05, r 0.7, 24px spacing). The same dot motif already appears on the
              other side of the sign-in wall — app shell, auth, onboarding — but as
              a canvas painting near-black dots, while this painted the warm --border
              at 1px, so the two read as visibly different fields. Matching costs one
              class string and keeps the landing at zero client JS. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(hsl(var(--foreground)/0.05)_0.7px,transparent_0.8px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]"
          />
          <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
            <p className="flex items-center gap-2 font-mono text-label text-muted-foreground motion-safe:animate-fade-in">
              <DotMatrixMark className="h-4 w-4" />
              Multi-model AI chat
            </p>
            {/* The hero is one staggered set, indices 0-4 on the "loose" rung.
                It used to hand-write [animation-delay:60/120/200/260ms] — steps
                of 60, 60, 80, 60, so the hero did not even hold its own tempo,
                let alone the product's three-rung scale. */}
            <h1
              style={staggerDelay(0, "loose")}
              className="mt-4 max-w-3xl text-balance font-serif text-hero font-medium tracking-tight motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              {/* Italic accent on the key phrase — the most consistent typographic
                  gesture Juno has (empty states, /work, /upgrade, /roadmap, code/new,
                  onboarding) and until now absent from the one page where a visitor
                  learns the voice. */}
              Every frontier model. <span className="italic text-primary">One honest subscription.</span>
            </h1>
            <p
              style={staggerDelay(1, "loose")}
              className="mt-5 max-w-2xl text-pretty text-body-lg text-muted-foreground motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              Juno puts Claude, GPT, Gemini and a dozen more labs in one calm workspace — voice, artifacts, projects
              and a coding agent included — with the real cost of every answer on the receipt.
            </p>
            <div
              style={staggerDelay(2, "loose")}
              className="mt-8 flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
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
            <div
              style={staggerDelay(3, "loose")}
              className="mt-12 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <ComposerPreview model={HERO_MODEL} />
            </div>
            <div
              style={staggerDelay(4, "loose")}
              className="mt-14 motion-safe:animate-fade-in [animation-fill-mode:backwards]"
            >
              <DottedDivider label="In the picker today" className="mb-5" />
              <FlagshipStrip />
            </div>
          </div>
        </section>

        <Metering />
        <ModelLineup />
        <Features />
        <Switching />
        <Pricing />
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
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
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 gap-y-1.5 text-body">
              {/* text-label, not text-caption/80: the visitor has just scrolled past
                  five PageHeader eyebrows in exactly this role, and these were a
                  third rendering of it — 11px at 80% alpha, which also measures
                  ≈3.6:1 on --background and fails AA at that size. */}
              <div className="space-y-1.5">
                <p className="font-mono text-label text-muted-foreground">Product</p>
                {PRODUCT_LINKS.map(({ href, label, file }) =>
                  file ? (
                    <a key={href} href={href} download className={FOOTER_LINK}>
                      {label}
                    </a>
                  ) : (
                    <Link key={href} href={href} className={FOOTER_LINK}>
                      {label}
                    </Link>
                  )
                )}
              </div>
              <div className="space-y-1.5">
                <p className="font-mono text-label text-muted-foreground">Legal</p>
                {LEGAL_LINKS.map(({ href, label }) => (
                  <Link key={href} href={href} className={FOOTER_LINK}>
                    {label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
          {/* No /80: at 11px the composite lands ≈3.6:1 on --background, under the
              4.5:1 AA floor, and 11px is far below the large-text exemption. */}
          <p className="mt-8 border-t border-border/60 pt-6 text-caption text-muted-foreground">
            Juno — chat.liams.dev · © {new Date().getFullYear()}
          </p>
        </div>
      </footer>
    </div>
  );
}
