import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
import { HeroStage } from "@/components/landing/hero-stage";
import { LabMarquee, MODELS_FLOOR, TOTAL_LABS } from "@/components/landing/lab-marquee";
import { Metering } from "@/components/landing/metering";
import { Platforms } from "@/components/landing/platforms";
import { Features, Privacy } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { Closing } from "@/components/landing/closing";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";
import { LandingColumn } from "@/components/landing/section";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The public front door (signed-out "/"). Server-rendered: model names, counts
 * and prices are read from the registry at render time, so the page can never
 * disagree with the product. The only client code is three small islands:
 * the bar's scrolled state (landing-header.tsx) and the scroll reveals below
 * the hero (reveal.tsx), which wrap server markup, and the phone menu's
 * close behaviour on top of a native <details> (phone-menu.tsx).
 *
 * Reading order: the hero sets the product on a painted plate; the marquee
 * says who is in the picker; Metering holds up the receipt; Platforms shows
 * where Juno runs; Features lists the rest; Privacy, Pricing and the closing
 * band finish. Each section has its own anatomy (a receipt on a plate, a
 * bento, a sticky column, a band, plan cards) so the serif headings in a row
 * never read as one template stamped over and over. Header and footer are the
 * public site's shared chrome (site-chrome.tsx).
 */

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
      <SiteHeader onLanding />

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
                  {`Start with ${PRODUCT_NAME}`}
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

      <SiteFooter />
    </div>
  );
}
