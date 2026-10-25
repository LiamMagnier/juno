"use client";

import * as React from "react";
import { AddMcpServerDialog } from "@/components/connections/add-mcp-server-dialog";
import { AddCustomConnectorDialog } from "@/components/connections/add-custom-connector-dialog";
import { ConnectorDirectory } from "@/components/connections/connector-directory";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import type { ConnectorStatus, UserMcpServerStatus } from "@/components/connections/types";

const saved: UserMcpServerStatus = {
  id: "fixture", name: "My workspace tools", url: "https://tools.example.com/mcp",
  enabled: true, status: "ok", lastError: null, lastCheckedAt: null,
  toolCount: 2, tools: ["search", "read_document"], accountLabel: null, hasAuthHeader: true,
  createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
};

const NOW = "2026-10-20T09:00:00Z";

function native(id: string, label: string, capability: string, extra: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id, kind: "native", label, description: capability, capability,
    configured: true, connected: false, accountLabel: null, connectedAt: null, ...extra,
  };
}

/** A directory the way a busy account sees it: linked apps, one mid sign-in, one failing, plenty to add. */
const CONNECTORS: ConnectorStatus[] = [
  native("github", "GitHub", "Read repos, review pull requests and open issues", { connected: true, accountLabel: "octo-studio", connectedAt: NOW }),
  native("notion", "Notion", "Search, read and draft pages in your workspace", { connected: true, accountLabel: "Acme HQ", connectedAt: NOW }),
  native("google-calendar", "Google Calendar", "See your schedule and propose meeting times"),
  native("gmail", "Gmail", "Find threads, summarise them and draft replies"),
  native("slack", "Slack", "Catch up on channels and post on your behalf"),
  native("figma", "Figma", "Inspect frames and pull design specs", { configured: false }),
  native("linear", "Linear", "Triage issues and update cycles"),
  {
    id: "srv-1", kind: "user_mcp", label: "Workspace tools", description: "https://tools.example.com/mcp",
    capability: "", configured: true, connected: true, accountLabel: null, connectedAt: NOW,
    enabled: true, status: "error", lastError: "Timed out after 10s", toolCount: 4, tools: ["search", "read_document"],
  },
  {
    id: "cc-1", kind: "custom_mcp", label: "Sentry", description: "", capability: "",
    configured: true, connected: false, accountLabel: "mcp.sentry.dev", connectedAt: null, toolCount: null,
  },
];

const CATALOG = {
  items: [
    { id: "composio:asana", slug: "asana", name: "Asana", logo: null, connected: false, connecting: false, noAuth: false, managedAuth: true, status: null, connectedAt: null },
    { id: "composio:hubspot", slug: "hubspot", name: "HubSpot", logo: null, connected: true, connecting: false, noAuth: false, managedAuth: true, status: "ACTIVE", connectedAt: NOW },
    { id: "composio:stripe", slug: "stripe", name: "Stripe", logo: null, connected: false, connecting: false, noAuth: false, managedAuth: true, status: null, connectedAt: null },
    { id: "composio:hackernews", slug: "hackernews", name: "Hacker News", logo: null, connected: false, connecting: false, noAuth: true, managedAuth: true, status: null, connectedAt: null },
    { id: "composio:zendesk", slug: "zendesk", name: "Zendesk", logo: null, connected: false, connecting: false, noAuth: false, managedAuth: false, status: null, connectedAt: null },
  ],
  categories: [],
};

/** Serve the Composio catalog from fixtures so the directory renders without a key. */
function useCatalogShim() {
  React.useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url, window.location.origin);
      if (parsed.pathname === "/api/connectors/composio/catalog") {
        const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
        const items = CATALOG.items.filter((i) => !q || i.name.toLowerCase().includes(q));
        await new Promise((r) => setTimeout(r, 350));
        return new Response(JSON.stringify({ ...CATALOG, items }), { headers: { "Content-Type": "application/json" } });
      }
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, []);
}

/** Real dialog and directory, dev only. Dialog API calls still require the account's normal auth. */
export function ConnectionsGallery() {
  useCatalogShim();
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<UserMcpServerStatus | null>(null);
  const [connectingId, setConnectingId] = React.useState<string | null>("slack");
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({});
  return <main className="@container/page mx-auto max-w-4xl p-8">
    <div className="mb-10 flex gap-3">
      <Button onClick={() => setAdding(true)}>Add MCP server</Button>
      <Button variant="outline" onClick={() => { setEditing(saved); setOpen(true); }}>Manage saved server</Button>
    </div>
    <ConnectorDirectory
      headerAction={
        <Button variant="outline" onClick={() => setAdding(true)} className="shrink-0 gap-1.5 px-3.5">
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      }
      connectors={CONNECTORS}
      composioConfigured
      enabled={enabled}
      permissionsReady
      onEnabledChange={(id, v) => setEnabled((e) => ({ ...e, [id]: v }))}
      onConnectNative={(c) => setConnectingId(c.id)}
      onDisconnect={() => {}}
      onTestUserMcp={(item) => setConnectingId(item.id)}
      connectingId={connectingId}
      onAddCustom={() => setAdding(true)}
      onManageCustom={() => { setEditing(saved); setOpen(true); }}
      onConnectCustom={(id) => setConnectingId(id)}
    />
    <AddMcpServerDialog open={open} onOpenChange={setOpen} editing={editing} onSaved={() => setOpen(false)} />
    <AddCustomConnectorDialog open={adding} onOpenChange={setAdding} />
  </main>;
}
