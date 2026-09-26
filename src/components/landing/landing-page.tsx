import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
import { JunoMark } from "@/components/brand/logo";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { HeroStage } from "@/components/landing/hero-stage";
import { LabMarquee, MODELS_FLOOR, TOTAL_LABS } from "@/components/landing/lab-marquee";
import { Metering } from "@/components/landing/metering";
import { Platforms } from "@/components/landing/platforms";
import { Features, Privacy } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { Closing } from "@/components/landing/closing";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingPhoneMenu } from "@/components/landing/phone-menu";
import { LandingColumn } from "@/components/landing/section";

/**
 * The public front door (signed-out "/"). Server-rendered: model names, counts
 * and prices are read from the registry at render time, so the page can never
 * disagree with the product. The only client code is three small islands:
 * the bar's scrolled state (landing-header.tsx) and the scroll reveals below
 * the hero (reveal.tsx), which wrap server markup, and the phone menu's
 * close behaviour on top of a native <details> (phone-menu.tsx).
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
  // A page, not a file. This used to link straight at `/downloads/Juno.dmg`, a
  // disk image committed to the repository — which meant the footer both
  // prefetched 21.9 MB nobody asked for AND handed over the one build
  // docs/native/RELEASE.md says "must not be promoted": self-signed, no Team ID,
  // no notarization ticket, refused by Gatekeeper. /download reports what is
  // actually published instead.
  { href: "/download", label: "Download", file: false },
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
  // Named for the article it opens, not for a section that does not exist yet
  // — the same reason there is no Status link two lines down. When there is a
  // second engineering page, this becomes an index and the label follows.
  { href: "/engineering/file-understanding", label: "How Juno reads files" },
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
  { href: "#apps", label: "Apps" },
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

/**
 * The two logo lockups (header + footer): one radius, and the product's one
 * press (`.pressable`, scale 0.97 on --dur-press) rather than a private 0.98.
 */
const LOGO_LOCKUP =
  "pressable inline-flex items-center gap-2.5 rounded-control motion-reduce:transition-none motion-reduce:active:scale-100";

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
    // No `bg-background` here: `body` already paints --background, and a fill
    // on this block would sit over the hero's backdrop where it runs up behind
    // the bar. `relative` is only an anchor for the bar's scroll sentinel (see
    // LandingHeader); with no z-index it opens no stacking context.
    <div className="relative min-h-dvh text-foreground">
      {/* The bar: transparent at rest, the page ground over a blur with one
          hairline once content scrolls beneath it (landing-header.tsx). */}
      <LandingHeader>
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
                them reachable with no client JS; the island (phone-menu.tsx)
                adds what a menu owes on top of it: it leaves on the recipe's
                exit, closes when a section is taken, on Escape and on a press
                outside. */}
            <LandingPhoneMenu links={NAV_LINKS} />
          </div>
        </LandingColumn>
      </LandingHeader>

      <main>
        {/* Runs before the hero below is parsed — see HERO_SEEN_SCRIPT. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: HERO_SEEN_SCRIPT }} />
        {/* The hero: the promise, two actions, then the product on a painted
            plate (hero-stage.tsx). The type sits on the page ground above the
            stage rather than over the paint, so it never fights the picture
            for contrast. */}
        <section className="relative">
          <LandingColumn contentClassName="flex flex-col items-center pb-10 pt-12 text-center sm:pb-14 sm:pt-20">
            <h1
              style={staggerDelay(0, "loose")}
              className={`max-w-[20ch] text-balance pb-1 font-serif lg:max-w-none text-hero font-medium tracking-tight ${HERO_ENTER}`}
            >
              Choose the best AI <span className="italic text-primary">for the work.</span>
            </h1>
            <p
              style={staggerDelay(1, "loose")}
              className={`mt-5 max-w-[34rem] text-pretty text-body-lg text-muted-foreground ${HERO_ENTER}`}
            >
              Compare frontier models in one conversation, see what every answer costs, and pick up on web, Mac or
              iPhone.
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
              <Button asChild size="lg" variant="secondary">
                <Link href="/download">Download for Mac</Link>
              </Button>
            </div>
          </LandingColumn>
          <div style={staggerDelay(3, "loose")} className={`mx-auto w-full max-w-[80rem] px-3 sm:px-6 ${HERO_ENTER}`}>
            <HeroStage />
          </div>
        </section>

        {/* Under the hero, never inside it: who is in the picker. */}
        <section aria-labelledby="labs-heading" className="pb-6 pt-12 sm:pt-16">
          <LandingColumn contentClassName="py-0">
            <p id="labs-heading" className="text-center text-body text-muted-foreground">
              {MODELS_FLOOR}+ models from {TOTAL_LABS} labs, in one picker
            </p>
          </LandingColumn>
          <div className="mx-auto mt-6 max-w-[80rem]">
            <LabMarquee />
          </div>
        </section>

        <Metering />
        <Platforms />
        <Features />
        <Privacy />
        <Pricing />
        <Closing />
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
            © {new Date().getFullYear()} Juno. Every frontier model, one honest subscription.
          </p>
        </LandingColumn>
      </footer>
    </div>
  );
}
