"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AgentFace } from "@/components/agents/agent-face";
import {
  AutonomyPicker,
  ConnectorPicker,
  FaceBuilder,
  FacePreview,
  StylePicker,
  useLinkedConnectors,
} from "@/components/agents/agent-profile-fields";
import { announceAgentsChanged, hireAgent } from "@/components/agents/agents-transport";
import { AGENT_TEMPLATES, agentTemplate, type AgentTemplate } from "@/lib/agents/templates";
import { MAX_AGENT_INSTRUCTIONS_CHARS, MAX_AGENT_NAME_CHARS, MAX_AGENT_ROLE_CHARS, type AgentStyle } from "@/lib/agents/domain";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { WorkPermissionPolicy } from "@/lib/work/domain";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Hiring an agent (docs/design/AGENTS.md §5.1).
 *
 * Four questions on one page, top to bottom, in the order a person decides
 * them: what it is for, what it is called and looks like, how it works, and
 * what it starts on. Not a wizard: every answer stays on screen while the next
 * one is given, because they depend on each other — a Writer called Quill who
 * is allowed to "just do it" is a combination somebody should see whole before
 * pressing Hire.
 *
 * Picking a starting point fills the rest with that job's defaults, and only
 * the fields the person has not touched yet: changing your mind about the job
 * must not throw away a name you already typed.
 */
export function AgentHire({ initialTemplate }: { initialTemplate: string | null }) {
  const router = useRouter();
  const connectors = useLinkedConnectors();
  const start = agentTemplate(initialTemplate) ?? AGENT_TEMPLATES[0];

  const [templateId, setTemplateId] = React.useState<string>(start.id);
  const [name, setName] = React.useState(start.names[0]);
  const [role, setRole] = React.useState(start.role);
  const [avatar, setAvatar] = React.useState<AgentAvatar>(start.avatar);
  const [style, setStyle] = React.useState<AgentStyle>(start.style);
  const [instructions, setInstructions] = React.useState(start.instructions);
  const [approvalMode, setApprovalMode] = React.useState<WorkPermissionPolicy>(start.approvalMode);
  const [connectorIds, setConnectorIds] = React.useState<string[]>([]);
  const [firstGoal, setFirstGoal] = React.useState(start.firstGoal);
  const [saving, setSaving] = React.useState(false);
  const touched = React.useRef(new Set<string>());
  const touch = (field: string) => touched.current.add(field);

  // Suggested apps are pre-ticked once the linked list arrives, for the
  // starting point in force, and only while the person has not chosen any.
  React.useEffect(() => {
    if (!connectors || touched.current.has("connectors")) return;
    const suggested = agentTemplate(templateId)?.suggestedConnectors ?? [];
    setConnectorIds(connectors.filter((option) => suggested.includes(option.id)).map((option) => option.id));
  }, [connectors, templateId]);

  const pick = (template: AgentTemplate) => {
    setTemplateId(template.id);
    const t = touched.current;
    if (!t.has("name")) setName(template.names[0]);
    if (!t.has("role")) setRole(template.role);
    if (!t.has("avatar")) setAvatar(template.avatar);
    if (!t.has("style")) setStyle(template.style);
    if (!t.has("instructions")) setInstructions(template.instructions);
    if (!t.has("approvalMode")) setApprovalMode(template.approvalMode);
    if (!t.has("firstGoal")) setFirstGoal(template.firstGoal);
  };

  const template = agentTemplate(templateId) ?? AGENT_TEMPLATES[0];
  const trimmedName = name.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmedName || saving) return;
    setSaving(true);
    const outcome = await hireAgent({
      name: trimmedName,
      role: role.trim(),
      avatar,
      style,
      instructions: instructions.trim(),
      approvalMode,
      connectorIds,
      template: templateId,
      ...(firstGoal.trim() ? { firstGoal: firstGoal.trim() } : {}),
    });
    if (outcome.kind !== "ok") {
      setSaving(false);
      toast.error(outcome.message);
      return;
    }
    announceAgentsChanged();
    router.push(`/agents/${outcome.value.id}?hired=1`);
  };

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="New agent"
        lede="A teammate with its own brief, goals and memory. It works in the cloud and asks before anything it cannot take back."
        backHref="/agents"
        backLabel="Agents"
      />
      <form onSubmit={submit} className="@container">
        <div className="grid grid-cols-1 gap-8 @[52rem]:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0 space-y-10">
            <Step n={1} title="What should it take on?">
              <div role="radiogroup" aria-label="Starting point" className="grid grid-cols-1 gap-2 @[32rem]:grid-cols-2">
                {AGENT_TEMPLATES.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={option.id === templateId}
                    onClick={() => pick(option)}
                    style={staggerDelay(index, "tight")}
                    className={cn(
                      "flex items-start gap-3 rounded-card border border-border bg-card p-3 text-left",
                      "transition-colors duration-fast ease-out-soft hover:bg-accent aria-checked:border-foreground/40 aria-checked:bg-selected",
                      "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                    )}
                  >
                    <AgentFace avatar={option.avatar} size="sm" />
                    <span className="min-w-0">
                      <span className="block text-ui font-medium text-foreground">{option.label}</span>
                      <span className="mt-0.5 block text-ui text-muted-foreground">{option.promise}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Step>

            <Step n={2} title="Name and face">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 @[32rem]:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block font-mono text-label text-muted-foreground">Name</span>
                    <Input
                      value={name}
                      maxLength={MAX_AGENT_NAME_CHARS}
                      onChange={(event) => {
                        touch("name");
                        setName(event.target.value);
                      }}
                      required
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block font-mono text-label text-muted-foreground">What it is for</span>
                    <Input
                      value={role}
                      maxLength={MAX_AGENT_ROLE_CHARS}
                      placeholder="Inbox and calendar"
                      onChange={(event) => {
                        touch("role");
                        setRole(event.target.value);
                      }}
                    />
                  </label>
                </div>
                {template.names.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-ui text-muted-foreground">Or call it</span>
                    {template.names
                      .filter((suggestion) => suggestion !== trimmedName)
                      .map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => {
                            touch("name");
                            setName(suggestion);
                          }}
                          className="rounded-control border border-border px-2 py-0.5 text-ui text-foreground transition-colors duration-fast ease-out-soft hover:bg-accent coarse:py-2"
                        >
                          {suggestion}
                        </button>
                      ))}
                  </div>
                ) : null}
                <FaceBuilder
                  avatar={avatar}
                  onChange={(next) => {
                    touch("avatar");
                    setAvatar(next);
                  }}
                />
              </div>
            </Step>

            <Step n={3} title="How it works">
              <div className="space-y-6">
                <Field label="How it talks">
                  <StylePicker
                    value={style}
                    onChange={(next) => {
                      touch("style");
                      setStyle(next);
                    }}
                  />
                </Field>
                <Field label="Its brief" hint="Who it is, what it looks after, and how you like things done.">
                  <Textarea
                    value={instructions}
                    maxLength={MAX_AGENT_INSTRUCTIONS_CHARS}
                    rows={6}
                    placeholder="You look after…"
                    onChange={(event) => {
                      touch("instructions");
                      setInstructions(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Autonomy">
                  <AutonomyPicker
                    value={approvalMode}
                    onChange={(next) => {
                      touch("approvalMode");
                      setApprovalMode(next);
                    }}
                  />
                </Field>
                <Field label="Connected apps it may use">
                  <ConnectorPicker
                    options={connectors}
                    value={connectorIds}
                    onChange={(next) => {
                      touch("connectors");
                      setConnectorIds(next);
                    }}
                  />
                </Field>
              </div>
            </Step>

            <Step n={4} title="A first goal" optional>
              <Input
                value={firstGoal}
                placeholder="Something it works towards over time"
                maxLength={140}
                onChange={(event) => {
                  touch("firstGoal");
                  setFirstGoal(event.target.value);
                }}
              />
            </Step>

            <div className="flex items-center gap-3 border-t border-border pt-6">
              <Button type="submit" loading={saving} disabled={!trimmedName}>
                Hire {trimmedName || "agent"}
              </Button>
              <Button asChild variant="ghost">
                <Link href="/agents">Cancel</Link>
              </Button>
            </div>
          </div>

          <aside className="order-first @[52rem]:order-none">
            <div className="@[52rem]:sticky @[52rem]:top-6">
              <FacePreview avatar={avatar} name={trimmedName} />
              <p className="mt-4 text-center text-body font-medium text-foreground">{trimmedName || "New agent"}</p>
              {role.trim() ? <p className="text-center text-ui text-muted-foreground">{role.trim()}</p> : null}
            </div>
          </aside>
        </div>
      </form>
    </AppPage>
  );
}

function Step({
  n,
  title,
  optional = false,
  children,
}: {
  n: number;
  title: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-3 flex items-baseline gap-2 text-heading">
        <span className="font-mono text-ui text-muted-foreground tabular-nums">{n}</span>
        {title}
        {optional ? <span className="text-ui font-normal text-muted-foreground">Optional</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="@container">
      <p className="font-mono text-label text-muted-foreground">{label}</p>
      {hint ? <p className="mb-2 text-ui text-muted-foreground">{hint}</p> : <div className="mb-2" />}
      {children}
    </div>
  );
}
