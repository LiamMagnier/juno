"use client";

import * as React from "react";
import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, Plug, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { AgentFace } from "@/components/agents/agent-face";
import type { ClientAgent } from "@/lib/agents/types";
import type { ConnectorUsage } from "@/components/connections/types";
import { cn } from "@/lib/utils";
import { AGENT_NOUN, PRODUCT_NAME } from "@/lib/brand/names";

/*
 * An app's details (design V3 customize-app scene; critique 1: who can use an
 * app, the system danger button). A sheet from the right edge on the drawer
 * curve, in the order a person asks: which account, who may use it, what it
 * may do without asking, when it was last used, and how to stop it.
 *
 * Every line is a real state. "Allowed" is the account's own app switch (the
 * blocked-connector policy the tool broker checks); "Allowed without asking"
 * rows are the standing grants the broker honours, each revocable back to
 * Ask first; everything else asks first under the approval policy. Provider
 * permissions are listed only as the provider reported them. Nothing here is
 * a local toggle that the server does not read.
 */

export interface AppDetailTarget {
  id: string;
  slug?: string;
  label: string;
  source: "native" | "composio" | "user_mcp" | "custom";
  mark: React.ReactNode;
  accountLabel?: string | null;
  connectedAt?: string | null;
  capability?: string;
  description: string;
  providerScopes?: string[];
  tools?: string[];
  lastError?: string | null;
}

interface StandingGrant {
  id: string;
  connectorId: string;
  projectId: string | null;
  toolName: string;
  action: string;
  createdAt: string;
}

function since(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, at.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}

function usedWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${since(iso)} at ${time}`;
}

function Section({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border py-4">
      <h3 className="text-ui font-medium text-muted-foreground">{label}</h3>
      {hint ? <p className="mt-1 max-w-[44ch] text-ui leading-[18px] text-muted-foreground">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

export function AppDetailSheet({
  target,
  open,
  onOpenChange,
  allowed,
  permissionsReady,
  onAllowedChange,
  onDisconnect,
  onTest,
  testing,
}: {
  target: AppDetailTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account's app switch: false when the app is on the blocked list. */
  allowed: boolean;
  permissionsReady: boolean;
  onAllowedChange: (allowed: boolean) => void;
  onDisconnect: () => void;
  /** user_mcp only: check the server again. */
  onTest?: () => void;
  testing?: boolean;
}) {
  const [agents, setAgents] = React.useState<ClientAgent[] | null>(null);
  const [grants, setGrants] = React.useState<StandingGrant[] | null>(null);
  const [usage, setUsage] = React.useState<ConnectorUsage | null | undefined>(undefined);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [grantError, setGrantError] = React.useState<string | null>(null);
  const id = target?.id;
  const slug = target?.slug;

  React.useEffect(() => {
    if (!open || !id) return;
    const controller = new AbortController();
    const read = <T,>(url: string) =>
      fetch(url, { signal: controller.signal, cache: "no-store" }).then((response) => (response.ok ? (response.json() as Promise<T>) : Promise.reject(new Error())));
    setAgents(null);
    setGrants(null);
    setUsage(undefined);
    setGrantError(null);
    const matches = (connectorId: string) => connectorId === id || (slug ? connectorId === slug || connectorId === `composio:${slug}` : false);
    read<{ agents?: ClientAgent[] }>("/api/agents")
      .then((data) => setAgents((data.agents ?? []).filter((agent) => agent.connectorIds.some(matches))))
      .catch(() => !controller.signal.aborted && setAgents([]));
    read<{ grants?: StandingGrant[] }>("/api/approvals/grants")
      .then((data) => setGrants((data.grants ?? []).filter((grant) => matches(grant.connectorId))))
      .catch(() => !controller.signal.aborted && setGrants([]));
    read<{ usage?: Record<string, ConnectorUsage> }>("/api/connectors/usage")
      .then((data) => {
        const all = data.usage ?? {};
        setUsage(all[id] ?? (slug ? (all[slug] ?? all[`composio:${slug}`]) : undefined) ?? null);
      })
      .catch(() => !controller.signal.aborted && setUsage(null));
    return () => controller.abort();
  }, [open, id, slug]);

  const revoke = async (grant: StandingGrant) => {
    setRevoking(grant.id);
    setGrantError(null);
    try {
      const response = await fetch(`/api/approvals/grants/${encodeURIComponent(grant.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? null);
    } catch {
      setGrantError("Couldn’t change that. It still runs without asking; try again.");
    } finally {
      setRevoking(null);
    }
  };

  const isServer = target?.source === "user_mcp";
  const connectedSince = since(target?.connectedAt);
  const agentNames = (agents ?? []).map((agent) => agent.name);
  const consequence =
    agentNames.length === 0
      ? `${PRODUCT_NAME} loses access at once. Nothing in ${target?.label ?? "the app"} is deleted.`
      : `${PRODUCT_NAME} loses access at once, and ${agentNames.length === 1 ? agentNames[0] : `${agentNames.length} ${AGENT_NOUN.plural}`} can no longer use it. Nothing in ${target?.label ?? "the app"} is deleted.`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        scrim="always"
        title={target ? `${target.label} details` : "App details"}
        aria-describedby={undefined}
        className="inset-y-2 right-2 flex h-auto w-[min(480px,calc(100vw-16px))] max-w-none flex-col overflow-hidden rounded-panel border-r pb-0 pr-0 pt-0"
      >
        {target ? (
          <>
            <header className="flex items-center gap-3.5 px-6 pb-4 pt-5">
              <span className="grid size-10 shrink-0 place-items-center">{target.mark}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-title font-normal text-foreground">{target.label}</p>
                <p className="truncate text-caption text-muted-foreground">
                  {connectedSince ? `Connected since ${connectedSince}` : isServer ? "Your MCP server" : "Connected"}
                </p>
              </div>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close" className="text-muted-foreground">
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
              {target.accountLabel && target.accountLabel !== target.label ? (
                <Section label="Account">
                  <p className="text-ui leading-5 text-foreground [overflow-wrap:anywhere]">{target.accountLabel}</p>
                </Section>
              ) : null}

              <Section label="Who can use it">
                {isServer ? (
                  <p className="text-ui leading-5 text-foreground">You decide with the switch below whether chats can use this server.</p>
                ) : (
                  <label className="flex min-h-11 items-center justify-between gap-4 text-ui text-foreground">
                    <span>
                      {`${PRODUCT_NAME}, in your chats`}
                      <span className="block text-caption text-muted-foreground">{allowed ? "Allowed" : "Blocked: it won’t be used anywhere"}</span>
                    </span>
                    <Switch checked={allowed} disabled={!permissionsReady} onCheckedChange={onAllowedChange} aria-label={`Allow ${PRODUCT_NAME} to use ${target.label}`} />
                  </label>
                )}
                {agents === null ? (
                  <p className="flex min-h-9 items-center gap-2 text-caption text-muted-foreground" role="status">
                    <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    Checking your {AGENT_NOUN.plural}
                  </p>
                ) : agents.length > 0 ? (
                  <ul className="mt-1 flex flex-col">
                    {agents.map((agent) => (
                      <li key={agent.id} className="flex min-h-9 items-center gap-2.5 text-ui text-foreground">
                        <AgentFace avatar={agent.avatar} size={20} />
                        <Link href={`/agents/${encodeURIComponent(agent.id)}`} className="underline decoration-border underline-offset-[3px] hover:decoration-foreground">
                          {agent.name}
                        </Link>
                        {agent.role ? <span className="truncate text-caption text-muted-foreground">{agent.role}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-caption text-muted-foreground">{`None of your ${AGENT_NOUN.plural} use it.`}</p>
                )}
              </Section>

              <Section
                label={`What ${PRODUCT_NAME} can do without asking`}
                hint={`Anything that changes something in ${target.label} asks you first, unless you chose to allow it below.`}
              >
                {grants === null ? (
                  <p className="text-caption text-muted-foreground" role="status">Loading…</p>
                ) : grants.length === 0 ? (
                  <p className="text-ui leading-5 text-foreground">Nothing. Every change asks first.</p>
                ) : (
                  <ul className="flex flex-col">
                    {grants.map((grant) => (
                      <li key={grant.id} className="flex min-h-11 items-center justify-between gap-4 text-ui">
                        <span className="min-w-0">
                          <span className="block truncate text-foreground">{grant.action}</span>
                          <span className="block text-caption text-muted-foreground">{grant.projectId ? "Allowed in one project" : "Allowed everywhere"}</span>
                        </span>
                        <Button variant="secondary" size="sm" disabled={revoking !== null} loading={revoking === grant.id} onClick={() => void revoke(grant)}>
                          Ask first
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {grantError ? (
                  <p role="alert" className="mt-2 text-caption text-destructive-ink">
                    {grantError}
                  </p>
                ) : null}
                <Link href="/settings?section=connectors" className="mt-2 inline-block text-caption text-muted-foreground underline decoration-border underline-offset-[3px] hover:text-foreground">
                  Your approval policy
                </Link>
              </Section>

              <Section label={isServer ? "Tools it offers" : `What ${target.label} allowed`}>
                {isServer ? (
                  target.tools?.length ? (
                    <ul className="flex flex-col gap-1">
                      {target.tools.map((tool) => (
                        <li key={tool} className="font-mono text-caption text-foreground/80 [overflow-wrap:anywhere]">
                          {tool}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ui leading-5 text-muted-foreground">{target.lastError ?? "Check the server to list its tools."}</p>
                  )
                ) : target.providerScopes?.length ? (
                  <ul className="flex flex-col gap-1">
                    {target.providerScopes.map((scope) => (
                      <li key={scope} className="font-mono text-caption text-foreground/80 [overflow-wrap:anywhere]">
                        {scope}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui leading-5 text-muted-foreground">{`${target.label} didn’t report its exact permissions. You can review them in your ${target.label} account settings.`}</p>
                )}
              </Section>

              <Section label="Last used">
                {usage === undefined ? (
                  <p className="text-caption text-muted-foreground" role="status">Loading…</p>
                ) : usage === null ? (
                  <p className="text-ui leading-5 text-foreground">{`${PRODUCT_NAME} hasn’t used it yet.`}</p>
                ) : (
                  <p className="text-ui leading-5 text-foreground">
                    {`${usedWhen(usage.at)}, ${usage.toolName}`}
                    {usage.conversationId ? (
                      <>
                        {" in "}
                        <Link href={`/chat/${encodeURIComponent(usage.conversationId)}`} className="underline decoration-border underline-offset-[3px] hover:decoration-foreground">
                          {usage.conversationTitle || "a chat"}
                        </Link>
                      </>
                    ) : null}
                  </p>
                )}
              </Section>
            </div>

            <footer className="flex flex-col items-start gap-2 border-t border-border px-6 pb-5 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="destructive-outline" size="sm" onClick={onDisconnect}>
                  {isServer ? `Remove ${target.label}` : `Disconnect ${target.label}`}
                </Button>
                {onTest ? (
                  <Button variant="ghost" size="sm" onClick={onTest} loading={testing} className="text-muted-foreground">
                    <Plug className="size-4" aria-hidden="true" />
                    Check the server
                  </Button>
                ) : null}
              </div>
              <p className={cn("max-w-[52ch] text-caption leading-4 text-muted-foreground")}>{consequence}</p>
            </footer>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
