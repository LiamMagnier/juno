import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
import { JunoMark } from "@/components/brand/logo";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { ComposerPreview, HERO_MODEL } from "@/components/landing/composer-preview";
import { FlagshipStrip, ModelLineup } from "@/components/landing/model-lineup";
import { Metering } from "@/components/landing/metering";
import { Features } from "@/components/landing/features";
import { Switching } from "@/components/landing/switching";
import { Pricing } from "@/components/landing/pricing";
import { LandingColumn, Section } from "@/components/landing/section";

/**
 * The public front door (signed-out "/"). Entirely server-rendered — model
 * names, counts and prices are read from the registry at render time, so the
 * page can never disagree with the product.
 */

// English labels over the French route slugs on purpose: the slugs are the
// legal pages' canonical URLs (operated from France, and linked from documents
// that cannot move), while every other word on this page is English — three
// French labels in an English footer read as a localization bug, not as
// jurisdiction.
const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Privacy" },
  { href: "/legal/cgu", label: "Terms" },
  { href: "/legal/mentions-legales", label: "Legal notice" },
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

/** The in-page anchors in the sticky bar, in reading order. */
const NAV_LINKS = [
  { href: "#features", label: "Product" },
  { href: "#code", label: "Code" },
  { href: "#pricing", label: "Pricing" },
];

/**
 * One hover/colour treatment for every footer link, whatever element renders it.
 *
 * `rounded-xs` (6px) is the ladder's rung for inline text links, and it is what
 * shapes the global :focus-visible outline. `focus-visible:text-foreground`
 * rides with the hover: the outline alone says "this is focused"; the colour
 * shift is what says "this is a link you can follow".
 */
const FOOTER_LINK =
  "block w-fit rounded-xs text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The two logo lockups (header + footer) — one radius, one press response. */
const LOGO_LOCKUP =
  "inline-flex items-center gap-2.5 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100";

export function LandingPage() {
  return (
    // No `bg-background` here. This div is an in-flow, non-positioned block, so
    // its background would paint AFTER the hero's `-z-10` backdrop layers in the
    // root stacking context. `body` already paints --background.
    <div className="min-h-dvh text-foreground">
      {/* The floating bar: `.surface-float` + `.overlay-glass` — the same
          material every menu and popover in the product is cut from, which is
          what glass is for (chrome, never reading surfaces). The side and top
          edges of the material's hairline are zeroed so only the bottom rule
          remains; the shadow-float throw and the --sheen rim light stay.
          Server-only: no scroll listener, the bar is the same at rest and mid-page. */}
      <header className="surface-float overlay-glass sticky top-0 z-toolbar rounded-none border-x-0 border-t-0">
        <LandingColumn contentClassName="flex items-center justify-between gap-3 py-2.5">
          <Link href="/" aria-label="Juno" className={LOGO_LOCKUP}>
            <JunoMark className="size-7" />
            <AsciiWordmark />
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-0.5 md:flex">
            {NAV_LINKS.map(({ href, label }) => (
              <Button key={href} asChild variant="ghost" size="sm" className="text-muted-foreground">
                <a href={href}>{label}</a>
              </Button>
            ))}
          </nav>
          <nav aria-label="Account" className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/sign-up">Create account</Link>
            </Button>
          </nav>
        </LandingColumn>
      </header>

      <main>
        {/* Hero — static dot-grid backdrop (CSS only, no canvas) + faint coral wash.
            `isolate`: the two backdrop layers below sit at -z-10, which without a
            stacking context of their own resolve against the root and paint
            behind any opaque ancestor ground. */}
        <section className="relative isolate overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_45%_at_50%_0%,hsl(var(--primary)/0.1),transparent_70%)]"
          />
          {/* CSS twin of DotField's resting frame (dot-field.tsx: --foreground at
              0.05, r 0.7, 24px spacing) — the same dot motif the app shell, auth
              and onboarding paint, at zero client JS. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(hsl(var(--foreground)/0.05)_0.7px,transparent_0.8px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]"
          />
          <LandingColumn contentClassName="pb-16 pt-14 sm:pb-20 sm:pt-20">
            {/* The hero opens on the job to be done, not a catalogue claim. */}
            <h1
              style={staggerDelay(0, "loose")}
              className="mt-4 max-w-[22ch] text-balance font-serif text-hero font-medium tracking-tight motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              Choose the best AI <span className="italic text-primary">for the work.</span>
            </h1>
            <p
              style={staggerDelay(1, "loose")}
              className="mt-5 max-w-prose text-pretty text-body-lg text-muted-foreground motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              Compare frontier models in one conversation, see the cost of every answer, and continue the same work on
              web, Mac and iPhone.
            </p>
            <div
              style={staggerDelay(2, "loose")}
              className="mt-8 flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <Button asChild size="lg">
                <Link href="/sign-up">
                  Start with Juno
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <a href="#features">Explore the workspace</a>
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
              className="mt-14 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <DottedDivider label="In the picker today" className="mb-5" />
              <FlagshipStrip />
            </div>
          </LandingColumn>
        </section>

        <Metering />
        <ModelLineup />
        <Features />
        <CodeAndContinuity />
        <Switching />
        <Pricing />
      </main>

      <footer className="border-t border-border/60">
        <LandingColumn contentClassName="py-10">
          <div className="flex flex-col justify-between gap-8 sm:flex-row">
            <div>
              <Link href="/" aria-label="Juno" className={LOGO_LOCKUP}>
                <JunoMark className="size-6" />
                <AsciiWordmark />
              </Link>
              <p className="mt-3 max-w-xs text-caption text-muted-foreground">
                Every frontier model, one honest subscription. Operated from France.
              </p>
            </div>
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 gap-y-1.5 text-body">
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
          <p className="mt-8 border-t border-border/60 pt-6 font-mono text-caption text-muted-foreground">
            Juno — chat.liams.dev · © {new Date().getFullYear()}
          </p>
        </LandingColumn>
      </footer>
    </div>
  );
}

/** The product boundary competitors often hide: powerful local work remains under reader control. */
function CodeAndContinuity() {
  return (
    <Section
      id="code"
      eyebrow="Work across surfaces"
      heading="Pick up the thread. Keep control of the machine."
      lede="A project can move from a browser conversation to Juno Code on your Mac and back to your phone without turning local access into a black box."
      className="border-y border-border/60 bg-secondary/25"
    >
      <div className="mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="max-w-prose text-body-lg text-foreground">
            Juno Code can inspect diffs, run tests and work in an isolated worktree. It shows what an action will touch
            and asks before it acts.
          </p>
          <a
            href="/downloads/Juno.dmg"
            className="group mt-6 inline-flex items-center gap-1 rounded-xs text-body font-medium underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
          >
            Download Juno for macOS
            <ArrowRight aria-hidden className="size-4 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </a>
        </div>
        <dl className="border-l border-border/70 pl-6 sm:pl-8">
          <div className="border-b border-border/60 pb-5">
            <dt className="text-heading">Exact MCP approval</dt>
            <dd className="mt-1.5 text-body text-muted-foreground">A project-declared tool cannot start until you approve that exact command or endpoint.</dd>
          </div>
          <div className="pt-5">
            <dt className="text-heading">One continuous project</dt>
            <dd className="mt-1.5 text-body text-muted-foreground">Keep conversations, research, artifacts and code context aligned across the Juno apps.</dd>
          </div>
        </dl>
      </div>
    </Section>
  );
}
