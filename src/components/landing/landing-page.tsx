import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LabMarquee, MODELS_FLOOR, TOTAL_LABS } from "./lab-marquee";
import { Metering } from "./metering";
import { Platforms } from "./platforms";
import { Features, Privacy } from "./features";
import { Pricing } from "./pricing";
import { Closing } from "./closing";
import { SiteFooter, SiteHeader } from "./site-chrome";
import { LandingColumn } from "./section";
import { ProductOverview } from "./product-overview";
import { BrandStory } from "./brand-story";
import "./overview.css";

// Preserve the existing session entrance gate and its CSP nonce contract.
const HERO_SEEN_KEY = "juno:landing-seen";
const HERO_SEEN_SCRIPT = `try{if(sessionStorage.getItem("${HERO_SEEN_KEY}"))document.documentElement.setAttribute("data-landing-seen","");sessionStorage.setItem("${HERO_SEEN_KEY}","1")}catch(e){}`;

export function LandingPage({ nonce }: { nonce?: string }) {
  return (
    <div className="alevr-public alevr-home relative min-h-dvh text-foreground">
      <SiteHeader onLanding />
      <main>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: HERO_SEEN_SCRIPT }} />
        <section className="alevr-home-hero" aria-labelledby="alevr-hero">
          <LandingColumn contentClassName="alevr-hero-copy">
            <h1 id="alevr-hero" className="font-serif">Go further.</h1>
            <p className="mt-5 text-body-lg leading-relaxed text-foreground/80">Conversation, agents, and code. One workspace to research, make things, and carry your work forward.</p>
            <div className="alevr-hero-actions">
              <Button asChild size="lg"><Link href="/sign-up">Create account<ArrowRight aria-hidden /></Link></Button>
              <Button asChild size="lg" variant="secondary"><Link href="/download">Download for Mac</Link></Button>
            </div>
          </LandingColumn>
        </section>
        <ProductOverview />
        <Features />
        <section aria-labelledby="labs-heading" className="alevr-labs">
          <LandingColumn contentClassName="py-0">
            <p id="labs-heading" className="text-center text-body text-muted-foreground">{MODELS_FLOOR}+ models from {TOTAL_LABS} labs, in one workspace</p>
            <div className="mt-6"><LabMarquee /></div>
          </LandingColumn>
        </section>
        <BrandStory />
        <Metering />
        <Privacy />
        <Pricing />
        <Platforms />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}
