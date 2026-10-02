"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowRight } from "@/components/ui/icons";
import Link from "next/link";

const MODES = [
  { id: "chat", label: "Chat", title: "Find the next useful thought.", description: "Ask a question, bring your files, compare models, and turn the answer into something you can use.", href: "/sign-up", action: "Create account" },
  { id: "orbit", label: "Orbit", title: "Give your work continuity.", description: "Create persistent agents, discuss their roles, and stay in control of their tools, permissions, and standing work.", href: "/sign-up", action: "Create account" },
  { id: "code", label: "Code", title: "Make the change. See the evidence.", description: "Work with your repository, inspect the diff, and review test results. Your changes remain yours to approve.", href: "/download", action: "Download for Mac" },
] as const;

/** Real product renderers arrive as server children. Tab changes expose a
 * finished example, never simulated progress or an action against an account. */
export function ProductStudy({ chat, orbit, code }: { chat: React.ReactNode; orbit: React.ReactNode; code: React.ReactNode }) {
  const examples = { chat, orbit, code };
  return (
    <Tabs.Root defaultValue="chat" className="alevr-product-study">
      <Tabs.List aria-label="Explore Alevr" className="alevr-product-tabs">
        {MODES.map(mode => <Tabs.Trigger key={mode.id} value={mode.id}>{mode.label}</Tabs.Trigger>)}
      </Tabs.List>
      {MODES.map(mode => (
        <Tabs.Content forceMount key={mode.id} value={mode.id} className="alevr-product-panel">
          <div className="alevr-product-description">
            <h3 className="font-serif text-display font-medium tracking-tight">{mode.title}</h3>
            <p className="mt-5 max-w-sm text-body-lg leading-relaxed text-muted-foreground">{mode.description}</p>
            <Link href={mode.href} className="alevr-text-link mt-8">{mode.action}<ArrowRight aria-hidden className="size-4" /></Link>
          </div>
          <div className="alevr-product-example">
            <div className="alevr-example-content">{examples[mode.id]}</div>
            <p className="alevr-example-note">Example content, shown with Alevr’s product components.</p>
          </div>
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
