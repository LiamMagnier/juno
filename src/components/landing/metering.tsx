import { getModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { eurPerUsd } from "@/lib/spend";
import { COST_EXAMPLES } from "./cost-examples";
import { CostExplorer } from "./cost-explorer";
import { Section } from "./section";
import { Reveal } from "./reveal";

const MODEL_IDS = ["anthropic:claude-fable-5-1","openai:gpt-6-sol","google:gemini-3.1-pro-preview","anthropic:claude-sonnet-5","zhipu:glm-5.3","deepseek:deepseek-flash"];

export function Metering() {
  const rate = eurPerUsd();
  const models = MODEL_IDS.flatMap(id => {
    const model = getModel(id);
    return model ? [{id,name:model.name,costs:COST_EXAMPLES.map(example=>estimateCostUsd(model,example)*rate)}] : [];
  });
  return <Section id="metering" heading="Know what an answer costs." lede="Choose a model and an example. See the provider cost using the same pricing calculation as your usage meter.">
    <Reveal amount={0.1}><CostExplorer models={models} /></Reveal>
    <div className="alevr-budget-note"><h3 className="font-serif text-title">A budget you can understand.</h3><p className="text-body leading-relaxed text-muted-foreground">Your plan is a monthly usage budget. Rolling 5-hour and 7-day windows pace it, and every reply shows its estimated cost.</p></div>
  </Section>;
}
