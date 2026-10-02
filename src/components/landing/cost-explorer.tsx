"use client";

import * as React from "react";
import { LazyMotion, MotionConfig, AnimatePresence, domAnimation, m } from "framer-motion";
import { formatEur } from "./eur";

import { COST_EXAMPLES as EXAMPLES } from "./cost-examples";
export type CostModel = { id:string; name:string; costs:readonly number[] };

/** Every sample is priced on the server by the application's estimator.
 * This is a labeled token-only example, never a bill or prediction of actual usage. */
export function CostExplorer({ models }: { models:CostModel[] }) {
  const [modelId,setModelId] = React.useState(models[0]?.id ?? "");
  const [exampleIndex,setExampleIndex] = React.useState(0);
  const model = models.find(row => row.id === modelId) ?? models[0];
  const example = EXAMPLES[exampleIndex];
  const cost = (row:CostModel) => row.costs[exampleIndex];
  if (!model) return <p className="mt-10 text-body text-muted-foreground">Model pricing is unavailable. Please try again later.</p>;
  return <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user">
    <div className="alevr-cost-explorer">
      <div className="alevr-cost-controls">
        <label htmlFor="public-cost-model" className="block text-ui font-medium">Model</label>
        <select id="public-cost-model" className="mt-3 w-full rounded-field border border-input bg-background px-4 py-3 text-body" value={model.id} onChange={event=>setModelId(event.target.value)}>
          {models.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <fieldset className="mt-8"><legend className="text-ui font-medium">Example</legend><div className="alevr-cost-examples mt-3">{EXAMPLES.map((row,index)=><label key={row.label}><input type="radio" name="public-cost-example" value={index} checked={exampleIndex===index} onChange={()=>setExampleIndex(index)} /><span>{row.label}</span></label>)}</div></fieldset>
        <p className="mt-5 text-ui leading-relaxed text-muted-foreground">{example.input.toLocaleString("en-US")} input tokens and {example.output.toLocaleString("en-US")} output tokens. Tool fees and caching are excluded.</p>
      </div>
      <div className="alevr-cost-result">
        <p className="text-ui text-muted-foreground">Estimated provider cost</p>
        <div className="alevr-cost-number" aria-live="polite" aria-atomic="true"><AnimatePresence mode="wait" initial={false}><m.span key={`${model.id}-${exampleIndex}`} initial={{opacity:.5,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} transition={{duration:.18}}>{formatEur(cost(model))}</m.span></AnimatePresence></div>
        <p className="max-w-sm text-body leading-relaxed text-muted-foreground">Alevr uses the same provider-price calculation for your usage meter. Your actual cost depends on the model and work.</p>
      </div>
    </div>
    <details className="alevr-cost-comparison"><summary>Compare these models</summary><ul>{models.map(row=><li key={row.id}><span>{row.name}</span><span className="tabular-nums">{formatEur(cost(row))}</span></li>)}</ul></details>
  </MotionConfig></LazyMotion>;
}
