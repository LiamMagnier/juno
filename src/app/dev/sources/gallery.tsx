"use client";

import { Markdown } from "@/components/chat/markdown";
import { SourcesPill } from "@/components/chat/sources-pill";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ClientSource } from "@/types/chat";

const SOURCES: ClientSource[] = [
  { title: "Heat pumps explained", url: "https://energysavingtrust.org.uk/advice/air-source-heat-pumps/", snippet: "An air source heat pump can typically deliver around three units of heat for every unit of electricity it uses.", cited: true },
  { title: "What a heat pump really costs to run", url: "https://www.theguardian.com/environment/heat-pumps-cost", snippet: "Running costs depend mostly on the tariff and how well the house holds heat.", cited: true },
  { title: "Energy price cap", url: "https://www.ofgem.gov.uk/energy-price-cap", snippet: "The cap for October to December is set at 24.50p per kWh for electricity.", cited: true },
  { title: "Boiler Upgrade Scheme", url: "https://www.gov.uk/apply-boiler-upgrade-scheme", snippet: "You can get £7,500 off the cost of installing an air source heat pump.", cited: true },
  { title: "Heat pump efficiency in cold weather", url: "https://www.nature.com/articles/heat-pump-cold", snippet: "Field data from 750 homes showed efficiency stayed above 2 at −10 °C.", cited: true },
];

const REPLY = `A heat pump would cost about **£1,050 a year** to run against £1,310 for your boiler [1][3]. That assumes a seasonal efficiency of 3, which field studies support even in cold snaps [5].

The upfront cost is the hurdle: around £12,000 installed, of which the Boiler Upgrade Scheme covers £7,500 [4]. Savings depend mostly on your tariff and how well the house holds heat [2].`;

export function SourcesGallery() {
  return (
    <TooltipProvider>
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-4 py-12">
        <header>
          <p className="font-mono text-caption font-semibold text-primary">Dev gallery</p>
          <h1 className="pt-1 font-sans text-page-title font-semibold tracking-tight">Sources</h1>
        </header>
        <section data-sample="answer" className="flex flex-col">
          <Markdown content={REPLY} sources={SOURCES} />
          <SourcesPill sources={SOURCES} />
        </section>
        <section data-sample="open" className="flex flex-col">
          <Markdown content={REPLY} sources={SOURCES} />
          <SourcesPill sources={SOURCES} />
        </section>
      </main>
    </TooltipProvider>
  );
}
