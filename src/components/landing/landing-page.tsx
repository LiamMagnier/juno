import { PublicAction } from "@/components/public/public-motion";
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

export function LandingPage() {
  return (
    <div className="alevr-public alevr-home relative min-h-dvh text-foreground">
      <SiteHeader onLanding />
      <main>
        <section className="alevr-home-hero" aria-labelledby="alevr-hero">
          <LandingColumn contentClassName="alevr-hero-layout">
            <div className="alevr-hero-copy">
              <h1 id="alevr-hero" className="font-serif">Go further.</h1>
              <p className="mt-6 text-body-lg leading-relaxed text-muted-foreground">Conversation, agents, and code. One workspace to research, make things, and carry your work forward.</p>
              <div className="alevr-hero-actions">
                <PublicAction href="/sign-up">Create account</PublicAction>
                <PublicAction href="/download" secondary>Download for Mac</PublicAction>
              </div>
            </div>
          </LandingColumn>
          <ProductOverview hero />
        </section>
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
