"use client";

import { ArrowUpRight, Clock, Globe, Monitor, Plug, Sparkles, Terminal } from "@/components/ui/icons";
import { ORBIT_SETUP_STEPS } from "@/lib/agents/onboarding";

const CAPABILITIES = [
  { icon: Globe, name: "Research & browse", description: "Find sources. Bring back answers.", prompt: "Research topics for me, compare reliable sources, and prepare clear reports with citations." },
  { icon: Monitor, name: "Use a Linux computer", description: "A desktop for hands-on work.", prompt: "Help me set up your Linux computer, then use the browser, terminal, and files to carry out tasks. Ask me what to work on first." },
  { icon: Sparkles, name: "Write & create", description: "Turn an idea into a finished draft.", prompt: "Help me write and create polished documents, presentations, images, and other content. Ask about my first project and the tools available." },
  { icon: Terminal, name: "Build & run code", description: "Go from a problem to a working result.", prompt: "Help me build software, run code, diagnose errors, and verify the result. Ask me about the project and execution environment first." },
  { icon: Clock, name: "Work on a schedule", description: "Keep recurring work moving.", prompt: "Help me set up a recurring routine. Ask what I want done, how often, and my timezone before scheduling it." },
  { icon: Plug, name: "Connect your apps", description: "Work with the tools you already use.", prompt: "Help me work across my connected apps. First check which connections are available and help me choose a useful workflow." },
] as const;

/** Starters fill a draft; creating an agent always stays an explicit action. */
export function OrbitCapabilities({ onChoose, gettingStarted = false }: { onChoose: (prompt: string) => void; gettingStarted?: boolean }) {
  return (
    <section className="orbit-capabilities" aria-labelledby="orbit-capabilities-title">
      {gettingStarted && (
        <ol className="orbit-setup" aria-label="Set up your first agent">
          {ORBIT_SETUP_STEPS.map((step, index) => (
            <li key={step.id}>
              <span className="orbit-setup__number" aria-hidden="true">{index + 1}</span>
              <div><h3>{step.title}</h3><p>{step.detail}</p></div>
            </li>
          ))}
        </ol>
      )}
      <div className="orbit-section-heading">
        <div>
          <h2 id="orbit-capabilities-title">Choose a starting point</h2>
          <p>Pick a job to fill the draft. You can edit it before creating your agent.</p>
        </div>
        <span className="orbit-overline hidden sm:block">Explore Orbit</span>
      </div>
      <div className="orbit-capabilities__grid">
        {CAPABILITIES.map(({ icon: Icon, name, description, prompt }) => (
          <button key={name} type="button" className="orbit-capability" onClick={() => onChoose(prompt)}>
            <span className="orbit-capability__icon"><Icon className="size-[18px]" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block text-ui font-medium text-foreground">{name}</span><span className="mt-1 block text-caption leading-5 text-muted-foreground">{description}</span></span>
            <ArrowUpRight className="orbit-capability__arrow size-4" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="mt-3 text-caption text-muted-foreground">Available tools depend on your plan, connected apps, and computer setup.</p>
    </section>
  );
}
