import Link from "next/link";
import { ArrowRight, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
import { JunoMark } from "@/components/brand/logo";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { HeroTranscript } from "@/components/landing/hero-transcript";
import { FlagshipStrip, ModelLineup } from "@/components/landing/model-lineup";
import { Metering } from "@/components/landing/metering";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { LandingColumn } from "@/components/landing/section";

/**
 * The public front door (signed-out "/"). Entirely server-rendered — model
 * names, counts and prices are read from the registry at render time, so the
 * page can never disagree with the product.
 *
 * Reading order: the hero shows one priced reply; Metering explains the
 * receipt; the Lineup says who is in the picker; Features lists the rest;
 * Pricing closes. Each section has its own anatomy — an elevated receipt, a
 * logo strip, a two-column list, plan cards — so five serif headings in a
 * row do not read as one template stamped five times.
 */

// English labels over the French route slugs on purpose: the slugs are the
// legal pages' canonical URLs (operated from France, and linked from documents
// that cannot move), while every other word on this page is English — three
// French labels in an English footer read as a localization bug, not as
// jurisdiction. `lang="fr"` on the link tells assistive tech what is on the
// other side.
const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Privacy" },
  { href: "/legal/cgu", label: "Terms" },
  { href: "/legal/mentions-legales", label: "Legal notice" },
];

const PRODUCT_LINKS: { href: string; label: string; file?: boolean }[] = [
  { href: "/sign-in", label: "Sign in" },
  { href: "/sign-up", label: "Create account" },
  // `file` because this is not a route: a <Link> with no explicit prefetch
  // prefetches on viewport entry in production, and Juno.dmg is 21.9 MB — so
  // every visitor who merely scrolled to the footer was pulling down a disk
  // image they never asked for. features.tsx links the same href with a plain
  // <a>, which is the correct treatment; this makes the two agree.
  { href: "/downloads/Juno.dmg", label: "Download for macOS", file: true },
];

/**
 * The address the product already sends from (src/lib/email.ts, `EMAIL_FROM`
 * with the same default), parsed out of its "Name <addr>" form — so the
 * footer's Contact and Support links go where a reply to any Juno email
 * would, without a second address to keep in step.
 */
const CONTACT_EMAIL = (process.env.EMAIL_FROM ?? "Juno <hello@chat.liams.dev>").replace(/^.*<|>\s*$/g, "").trim();

/**
 * The company column. No Status link: there is no status page, and a link
 * that invents one is worse than the gap. Changelog is the roadmap, which
 * lives under the (app) group and calls requireUser(): a signed-out visitor
 * clicking it would be silently bounced to a login form with no explanation,
 * so `?next=` keeps the item and makes the redirect intentional.
 */
const COMPANY_LINKS = [
  { href: `mailto:${CONTACT_EMAIL}`, label: "Contact" },
  { href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Juno support")}`, label: "Support" },
  { href: "/sign-in?next=/roadmap", label: "Changelog & roadmap" },
];

/**
 * The in-page anchors in the sticky bar, in reading order. Metering and
 * Models are the two sections that say what makes Juno different, and the
 * nav used to skip both.
 */
const NAV_LINKS = [
  { href: "#metering", label: "Metering" },
  { href: "#models", label: "Models" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
];

/**
 * One hover/colour treatment for every footer link, whatever element renders it.
 *
 * `rounded-xs` (6px) is the ladder's rung for inline text links, and it is what
 * shapes the global :focus-visible outline. `focus-visible:text-foreground`
 * rides with the hover: the outline alone says "this is focused"; the colour
 * shift is what says "this is a link you can follow". `py-1` lifts the 15px
 * line box to the 24px target SC 2.5.8 asks for without moving the text.
 */
const FOOTER_LINK =
  "block w-fit rounded-xs py-1 text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The two logo lockups (header + footer) — one radius, one press response. */
const LOGO_LOCKUP =
  "inline-flex items-center gap-2.5 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100";

/**
 * The hero's entrance, which runs once per session.
 *
 * The five-step rise-in replayed on every load — back from the sign-in page,
 * every refresh — which is the difference between an entrance and a tic. The
 * inline script below runs before the hero paints (it is parsed in place),
 * marks the document when the session has already seen it, and the arbitrary
 * variant turns the animation off under that mark. sessionStorage, not
 * localStorage: a new visit a week later should get the entrance again.
 * Wrapped in try/catch because storage throws in some private modes, and a
 * thrown script here would only cost the animation its gate — not the page.
 */
const HERO_SEEN_KEY = "juno:landing-seen";
const HERO_SEEN_SCRIPT = `try{if(sessionStorage.getItem("${HERO_SEEN_KEY}"))document.documentElement.setAttribute("data-landing-seen","");sessionStorage.setItem("${HERO_SEEN_KEY}","1")}catch(e){}`;
const HERO_ENTER =
  "motion-safe:animate-rise-in [animation-fill-mode:backwards] [[data-landing-seen]_&]:animate-none";

export function LandingPage({ nonce }: { nonce?: string }) {
  return (
    // No `bg-background` here. This div is an in-flow, non-positioned block, so
    // its background would paint AFTER the hero's `-z-10` backdrop layers in the
    // root stacking context. `body` already paints --background.
    <div className="min-h-dvh text-foreground">
      {/* The bar: the page ground at 90% over a 12px blur with one bottom
          hairline — the flat header Claude and ChatGPT wear. No float shadow:
          a sticky header is chrome that stays on the page, not a layer that
          leaves it. Server-only: no scroll listener, the same at rest and mid-page. */}
      <header className="sticky top-0 z-toolbar border-b border-border bg-background/90 backdrop-blur-md">
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
          <div className="flex items-center gap-2">
            <nav aria-label="Account" className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/sign-up">Create account</Link>
              </Button>
            </nav>
            {/* Below `md` the section links used to vanish, so a phone got only
                Sign in / Create account. A native <details> disclosure keeps
                them reachable at zero client JS: the summary is the button, the
                list is a floating menu at the popper rung, and Escape/outside
                clicks are the browser's to handle. */}
            <details className="group relative md:hidden">
              <summary
                aria-label="Sections"
                className="pressable flex size-9 cursor-pointer list-none items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground coarse:size-11 [&::-webkit-details-marker]:hidden"
              >
                <Menu className="size-4" aria-hidden />
              </summary>
              <nav
                aria-label="Sections"
                className="surface-float absolute right-0 top-full z-popper mt-2 min-w-40 rounded-popover p-1.5 motion-safe:animate-pop-in"
              >
                {NAV_LINKS.map(({ href, label }) => (
                  <a
                    key={href}
                    href={href}
                    className="menu-item flex items-center rounded-control px-3 py-2 text-ui transition-colors duration-fast ease-out-soft hover:bg-accent"
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </details>
          </div>
        </LandingColumn>
      </header>

      <main>
        {/* Runs before the hero below is parsed — see HERO_SEEN_SCRIPT. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: HERO_SEEN_SCRIPT }} />
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
          {/* Centred, unlike the sections below: on a wide display a
              left-flushed hero left the right half of the viewport empty. The
              sections keep the app's left-aligned page header. */}
          <LandingColumn contentClassName="flex flex-col items-center pb-16 pt-14 text-center sm:pb-20 sm:pt-20">
            {/* The hero opens on the job to be done, not a catalogue claim. */}
            <h1
              style={staggerDelay(0, "loose")}
              className={`mt-4 max-w-[22ch] text-balance font-serif text-hero font-medium tracking-tight ${HERO_ENTER}`}
            >
              Choose the best AI <span className="italic text-primary">for the work.</span>
            </h1>
            <p
              style={staggerDelay(1, "loose")}
              className={`mt-5 max-w-prose text-pretty text-body-lg text-muted-foreground ${HERO_ENTER}`}
            >
              Compare frontier models in one conversation, see the cost of every answer, and continue the same work on
              web, Mac and iPhone.
            </p>
            <div
              style={staggerDelay(2, "loose")}
              className={`mt-8 flex flex-wrap items-center justify-center gap-3 ${HERO_ENTER}`}
            >
              <Button asChild size="lg">
                <Link href="/sign-up">
                  Start with Juno
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              {/* To the receipt, not to Features three sections down: the
                  secondary action should land on the argument, not past it. */}
              <Button asChild size="lg" variant="secondary">
                <a href="#metering">See what a reply costs</a>
              </Button>
            </div>
            <div style={staggerDelay(3, "loose")} className={`mt-12 flex w-full justify-center ${HERO_ENTER}`}>
              <HeroTranscript />
            </div>
            <div style={staggerDelay(4, "loose")} className={`mt-14 w-full ${HERO_ENTER}`}>
              <DottedDivider label="In the picker today" className="mb-5" />
              <FlagshipStrip />
            </div>
          </LandingColumn>
        </section>

        <Metering />
        <ModelLineup />
        <Features />
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
              <p className="mt-3 max-w-xs text-body text-muted-foreground">
                Every frontier model, one honest subscription. Operated from France.
              </p>
            </div>
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-1 text-body sm:grid-cols-3">
              <div>
                <p className="mb-1 font-mono text-label text-muted-foreground">Product</p>
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
              <div>
                <p className="mb-1 font-mono text-label text-muted-foreground">Company</p>
                {COMPANY_LINKS.map(({ href, label }) =>
                  href.startsWith("mailto:") ? (
                    <a key={label} href={href} className={FOOTER_LINK}>
                      {label}
                    </a>
                  ) : (
                    <Link key={label} href={href} className={FOOTER_LINK}>
                      {label}
                    </Link>
                  )
                )}
              </div>
              <div>
                <p className="mb-1 font-mono text-label text-muted-foreground">Legal</p>
                {LEGAL_LINKS.map(({ href, label }) => (
                  <Link key={href} href={href} lang="fr" className={FOOTER_LINK}>
                    {label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
          {/* The brand line, not the dev hostname: "chat.liams.dev" is where the
              product is deployed, not what it is called. No /80: at 11px the
              composite lands ≈3.6:1 on --background, under the 4.5:1 AA floor,
              and 11px is far below the large-text exemption. */}
          <p className="mt-8 border-t border-border/60 pt-6 font-mono text-caption text-muted-foreground">
            © {new Date().getFullYear()} Juno · Every frontier model, one honest subscription.
          </p>
        </LandingColumn>
      </footer>
    </div>
  );
}
