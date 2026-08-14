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

/**
 * One hover/colour treatment for every footer link, whatever element renders it.
 *
 * `rounded-xs` (6px) is the ladder's rung for inline text links, and it is what
 * shapes the global :focus-visible outline. This file previously held three
 * different focus-ring radii — rounded-sm here, rounded-md on both logo lockups
 * — none of them on the semantic ladder.
 *
 * `focus-visible:text-foreground` rides with the hover. The outline alone says
 * "this is focused"; the colour shift is what says "this is a link you can
 * follow", and hover was carrying it alone — so a keyboard user tabbing the
 * footer, and every touch visitor, got a weaker read of these eight links than a
 * mouse does. The auth and legal shells already pair the two states this way.
 */
const FOOTER_LINK =
  "block w-fit rounded-xs text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The two logo lockups (header + footer) — one radius, one press response. */
const LOGO_LOCKUP =
  "inline-flex items-center gap-2.5 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100";

export function LandingPage() {
  return (
    // No `bg-background` here. This div is an in-flow, non-positioned block, so
    // its background paints AFTER the hero's `-z-10` backdrop layers (the coral
    // wash and the dot grid) in the root stacking context — both were fully
    // occluded and the hero rendered as a flat rectangle. `body` already paints
    // --background (globals.css), so nothing is lost by dropping it, and the
    // hero section below now carries `isolate` so a future ancestor ground
    // cannot re-bury them.
    <div className="min-h-dvh text-foreground">
      {/* Sticky, because pricing is the last of six sections and the page's own
          note there records the cost of this: a visitor who read to the bottom
          and picked a tier had to scroll the whole page back to reach a sign-up
          control. The bar stays server-only — no scroll listener, so the
          hairline is permanent rather than appearing on scroll.

          The ground is --background at 72%, not the elevated --card rung the
          share page's bars use. Those float over a transcript and have to read
          as a different material; this one is the top of the page's own ground,
          and holding --background is what lets the hero's coral wash bloom
          through the blur instead of being flattened by an opaque strip. On
          black the separation is then carried by the hairline, which is how the
          dark theme is built to do it.

          px-4 sm:px-6 throughout: every app screen indents 16px on a phone, and
          the landing used to indent 24px, so crossing the sign-in wall shifted
          the whole left edge by 8px. */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/72 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" aria-label="Juno" className={LOGO_LOCKUP}>
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
        </div>
      </header>

      <main>
        {/* Hero — static dot-grid backdrop (CSS only, no canvas) + faint coral wash. */}
        {/* `isolate`: the two backdrop layers below sit at -z-10, which without a
            stacking context of their own resolve against the root and paint
            behind any opaque ancestor ground. */}
        <section className="relative isolate overflow-hidden">
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
              <DotMatrixMark className="size-4" />
              Multi-model AI chat
            </p>
            {/* The hero is one staggered set, indices 0-4 on the "loose" rung.
                It used to hand-write [animation-delay:60/120/200/260ms] — steps
                of 60, 60, 80, 60, so the hero did not even hold its own tempo,
                let alone the product's three-rung scale.
                One keyframe across all five beats, too: index 4 ran `fade-in`
                (0.2s, raw ease-out, no travel) while 0-3 ran `rise-in` (0.32s,
                out-strong, 8px), so the last beat of a choreographed set arrived
                on a different curve and a different distance from the other four. */}
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
              className="mt-14 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
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
              <Link href="/" aria-label="Juno" className={LOGO_LOCKUP}>
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
