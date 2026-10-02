"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { LazyMotion, MotionConfig, LayoutGroup, domAnimation, m } from "framer-motion";
import { PublicAction } from "@/components/public/public-motion";

const MODES = [
  { id: "chat", label: "Chat", title: "Think it through.", description: "Ask a question, bring your files, compare models, and turn the answer into something you can use.", href: "/sign-up", action: "Create account" },
  { id: "orbit", label: "Orbit", title: "Let the work continue.", description: "Shape an agent’s role, give it the context it needs, and stay in control of its tools and permissions.", href: "/sign-up", action: "Create account" },
  { id: "code", label: "Code", title: "Build with evidence.", description: "Work with your repository, inspect changes, and review test results before deciding what to apply.", href: "/download", action: "Download for Mac" },
] as const;
type Mode = typeof MODES[number]["id"];

/** Selection moves through one shared indicator. All examples remain in HTML
 * for print/no-script reading; CSS gives the newly selected content a finite entrance. */
export function ProductStudy({ chat, orbit, code, compact = false }: { chat: React.ReactNode; orbit: React.ReactNode; code: React.ReactNode; compact?: boolean }) {
  const [selected, setSelected] = React.useState<Mode>("chat");
  const examples = { chat, orbit, code };
  return (
    <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user"><LayoutGroup>
      <Tabs.Root value={selected} onValueChange={value => setSelected(value as Mode)} className={compact ? "alevr-product-study alevr-product-compact" : "alevr-product-study"}>
        {compact && <h2 className="sr-only">Explore Alevr</h2>}
        <Tabs.List aria-label="Explore Alevr" className="alevr-product-tabs">
          {MODES.map(mode => (
            <Tabs.Trigger key={mode.id} value={mode.id}>
              {selected === mode.id && <m.span className="alevr-product-selection" layoutId="public-product-selection" transition={{ type:"spring", stiffness:360, damping:32 }} />}
              <span className="relative">{mode.label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {MODES.map(mode => (
          <Tabs.Content forceMount key={mode.id} value={mode.id} className="alevr-product-panel">
            {compact && <h3 className="sr-only">{mode.label} example</h3>}
            {!compact && <div className="alevr-product-description">
              <h3 className="font-serif">{mode.title}</h3>
              <p className="mt-5 text-body-lg leading-relaxed text-muted-foreground">{mode.description}</p>
              <div className="mt-8"><PublicAction href={mode.href}>{mode.action}</PublicAction></div>
            </div>}
            <div className="alevr-product-example">
              <div className="alevr-example-content">{examples[mode.id]}</div>
            </div>
            <p className="alevr-example-note">Example content, shown with Alevr’s product components.</p>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </LayoutGroup></MotionConfig></LazyMotion>
  );
}
