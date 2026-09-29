"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowUp, Plus } from "@/components/ui/icons";
import { announceAgentsChanged, hireAgent } from "./agents-transport";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { agentStarterInput } from "@/lib/agents/starter";
import { cn } from "@/lib/utils";

/** One request creates a persistent teammate; configuration continues in its thread. */
export function AgentJobBoard({ initialTemplateId, className }: {
  initialTemplateId?: string | null; formHref?: string; className?: string;
}) {
  const router = useRouter();
  const initial = AGENT_TEMPLATES.find(t => t.id === initialTemplateId);
  const [prompt, setPrompt] = React.useState("");
  const [selected, setSelected] = React.useState(initial?.id ?? "custom");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef<{ key: string; text: string; template: string } | null>(null);
  const inFlight = React.useRef(false);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const template = AGENT_TEMPLATES.find(t => t.id === selected) ?? AGENT_TEMPLATES[0];
  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    if (!request.current || request.current.text !== text || request.current.template !== selected) {
      request.current = { key: crypto.randomUUID(), text, template: selected };
    }
    try {
      const outcome = await hireAgent({ ...agentStarterInput(template), creationKey: request.current.key, starterMessage: text });
      if (outcome.kind !== "ok") { setError(outcome.message); return; }
      announceAgentsChanged();
      const agent = outcome.value;
      router.push(agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`);
    } catch { setError("Couldn’t open your agent. Your request is still here; try again."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className={cn("agent-studio-start", className)}>
    <div className="agent-create-intro">
      <h2>Give your agent a job.</h2>
      <p>Tell it what to handle and what a good result looks like. It’ll save its brief and work out the details with you.</p>
    </div>
    <form onSubmit={start} className="agent-request">
      <label htmlFor="agent-request" className="agent-request-label">Your first message</label>
      <textarea id="agent-request" ref={input} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={6000}
        disabled={busy} rows={3} placeholder="For example: review my inbox each morning, flag urgent messages, and draft replies for my approval."
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      <div className="agent-request-footer">
        <span>{busy ? "Starting your conversation…" : "⌘ / Ctrl + Enter to send"}</span>
        <Button type="submit" disabled={busy || !prompt.trim()} aria-busy={busy} className="gap-2">
          {busy ? "Starting…" : "Create & start"}<ArrowUp className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </form>
    {error && <p role="alert" className="text-ui text-destructive">{error}</p>}
    <div className="agent-start-prompts">
      <p className="text-ui text-muted-foreground">Try a request</p>
      <div className="agent-prompt-list">{AGENT_TEMPLATES.filter(t => ["chief-of-staff", "researcher", "monitor"].includes(t.id)).map(t =>
        <button type="button" key={t.id} disabled={busy} aria-pressed={selected === t.id}
          onClick={() => { setSelected(t.id); setPrompt(t.firstGoal || t.promise); input.current?.focus(); }}>
          <span>{t.firstGoal || t.promise}</span><ArrowUp className="size-3.5" aria-hidden="true" />
        </button>)}</div>
    </div>
    <div className="agent-create-boundary"><span>Your permissions stay in control.</span><p>Connected apps require access. Sending, publishing, paying, and deleting require your approval.</p></div>
  </div>;
}
export function FirstHireBoard(_props: { formHref?: string }) {
  return <section aria-labelledby="first-hire"><h2 id="first-hire" className="text-title font-medium">Create your first agent</h2>
    <p className="mt-2 text-body text-muted-foreground">Start with a request. Keep working in the same conversation.</p><AgentJobBoard className="mt-8" /></section>;
}
export function NewAgentButton() {
  return <Button asChild size="sm" className="gap-1.5"><Link href="/agents/new"><Plus className="size-3.5" aria-hidden="true" /> New agent</Link></Button>;
}
