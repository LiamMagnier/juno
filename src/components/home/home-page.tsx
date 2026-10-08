import { EyeOff, Lock, ShieldCheck, Download as DownloadIcon } from "@/components/ui/icons";
import { PublicAction } from "@/components/public/public-motion";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";
import { LABS, MODELS_FLOOR, TOTAL_LABS } from "@/components/landing/lab-marquee";
import { Metering } from "@/components/landing/metering";
import { Pricing } from "@/components/landing/pricing";
import { Platforms } from "@/components/landing/platforms";
import { Hero } from "./hero";
import { Labs } from "./labs";
import { Showcase } from "./showcase";
import { OrbitScene } from "./orbit-scene";
import { CodeScene } from "./code-scene";
import { Bento } from "./bento";
import { Aleph } from "./aleph";
import { Construction } from "./construction";
import { HomeReveal } from "./home-reveal";
import "@/components/landing/overview.css";
import "./alv-base.css";
import "./home.css";

/**
 * The Alevr homepage. Server composition; every moving part is its own client
 * leaf. Order: the promise and the product (hero), breadth (labs), depth
 * (chapters), delegation (Orbit), building (Code), the rest of the workspace
 * (bento), the name (aleph), trust, cost, plans, platforms, and the close.
 */
export function AlevrHome() {
  return (
    <div className="alevr-public alv relative min-h-dvh">
      <SiteHeader onLanding />
      <main>
        <Hero />
        <Labs />
        <Showcase labs={LABS} modelsFloor={MODELS_FLOOR} totalLabs={TOTAL_LABS} />

        <section className="alv-orbit-section" id="orbit" aria-labelledby="alv-orbit-title">
          <div className="alv-col">
            <div className="alv-orbit-head">
              <h2 id="alv-orbit-title" className="alv-h2">Agents that carry the work forward.</h2>
              <p className="alv-lede">Alevr Orbit gives each agent a name, a role and standing work. They keep going between conversations and tell you, in plain words, what they did.</p>
            </div>
            <OrbitScene />
            <dl className="alv-ledger">
              <div><dt>A role you shape together</dt><dd className="alv-body">Describe the job in a conversation. The agent writes it down, and you edit it like any document.</dd></div>
              <div><dt>Permissions you set</dt><dd className="alv-body">Every action is Allowed, Ask first or Blocked. Waiting never counts as a yes.</dd></div>
              <div><dt>Work you can check</dt><dd className="alv-body">Each run leaves a record of what was read, done and sent, in the agent&apos;s own thread.</dd></div>
            </dl>
          </div>
        </section>

        <CodeScene />
        <Bento />
        <Aleph />

        <section className="alv-trust" aria-labelledby="alv-trust-title">
          <div className="alv-col alv-trust-grid">
            <h2 id="alv-trust-title" className="alv-h2" style={{ maxWidth: "8em" }}>Private by design.</h2>
            <div className="alv-trust-list">
              <div><ShieldCheck aria-hidden /><h3>Hosted in France</h3><p className="alv-body">EU infrastructure, with GDPR as the default.</p></div>
              <div><Lock aria-hidden /><h3>Encrypted at rest</h3><p className="alv-body">Your messages are encrypted in the database.</p></div>
              <div><EyeOff aria-hidden /><h3>Never used for training</h3><p className="alv-body">Your conversations stay yours.</p></div>
              <div><DownloadIcon aria-hidden /><h3>Yours to take with you</h3><p className="alv-body">Import your ChatGPT or Claude history, and export your work whenever you like.</p></div>
            </div>
          </div>
        </section>

        <Metering />
        <Pricing />
        <Platforms />

        <section className="alv-closing" aria-labelledby="alv-closing-title">
          <div className="alv-closing-construction"><Construction ticks={false} trajectory={false} axis={false} animate={false} /></div>
          <div className="alv-col">
            <h2 id="alv-closing-title" className="alv-display">Go further.</h2>
            <p className="alv-lede">Create an account, then choose the plan that fits your work.</p>
            <div className="alv-actions">
              <PublicAction href="/sign-up">Create account</PublicAction>
              <PublicAction href="/download" secondary>Download for Mac</PublicAction>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
      <HomeReveal />
    </div>
  );
}
