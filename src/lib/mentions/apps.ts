/**
 * The app rows of the mention palette, from the account's rows and the
 * server's registry.
 *
 * Three sources, one list: built-in connectors this server has set up
 * (connected or ready to connect), Composio apps the account has connected,
 * and the account's own MCP servers. The long tail of Composio's catalogue
 * is not searched here — it is a network call to Composio on every keystroke,
 * which is the wrong cost for a palette; the palette's "Browse apps" goes to
 * the directory (GET /api/connectors/composio/catalog) instead.
 *
 * Every row carries its approval preview (src/lib/chat/app-approval-preview.ts),
 * computed from the same policy the broker enforces, so "will ask you first"
 * is known before the token is even inserted.
 *
 * Pure: the caller passes rows in.
 */
import { appApprovalPreview } from "@/lib/chat/app-approval-preview";
import { contextTokenLabel } from "@/lib/chat/context-tokens";
import type { ActionPermissionPolicy } from "@/lib/action-approval";
import type { MentionCandidate } from "@/lib/mentions/rank";

export interface RegistryApp {
  id: string;
  label: string;
  description: string;
  /** Set up on this server (its OAuth app or credentials are configured). */
  configured: boolean;
  connectHref: string;
}

export interface AppRowsInput {
  registry: readonly RegistryApp[];
  connections: readonly { provider: string; accountLabel: string | null; scope: string | null; createdAt: Date }[];
  servers: readonly { id: string; name: string; enabled: boolean; url: string; createdAt: Date }[];
  composio: { configured: boolean; prefix: string; activeScope: string };
  approvals: { policy: ActionPermissionPolicy; lockdown: boolean; blockedConnectors: readonly string[] };
  /** Restrict to these ids (the `ids=` lookup). */
  only?: ReadonlySet<string>;
}

function titleCase(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function appMentionCandidates(input: AppRowsInput): MentionCandidate[] {
  const { approvals } = input;
  const byProvider = new Map(input.connections.map((row) => [row.provider, row]));
  const out: MentionCandidate[] = [];
  const keep = (id: string) => !input.only || input.only.has(id);
  const approval = (id: string, label: string) =>
    appApprovalPreview({
      label,
      policy: approvals.policy,
      lockdown: approvals.lockdown,
      blocked: approvals.blockedConnectors.includes(id),
    });

  for (const app of input.registry) {
    if (!app.configured || !keep(app.id)) continue;
    const row = byProvider.get(app.id);
    const connected = !!row;
    out.push({
      item: {
        kind: "app",
        id: app.id,
        label: contextTokenLabel(app.label) || app.id,
        subtitle: row?.accountLabel?.trim() || app.description,
        icon: `app:${app.id}`,
        connectorId: app.id,
        connected,
        needsConnection: !connected,
        connectHref: app.connectHref,
        approval: approval(app.id, app.label),
        ...(row ? { updatedAt: row.createdAt.toISOString() } : {}),
      },
      alternates: [app.id],
      boost: connected ? 5 : 0,
    });
  }

  if (input.composio.configured) {
    for (const row of input.connections) {
      if (!row.provider.startsWith(input.composio.prefix) || !keep(row.provider)) continue;
      const slug = row.provider.slice(input.composio.prefix.length);
      if (!slug) continue;
      const active = row.scope === input.composio.activeScope;
      const label = contextTokenLabel(row.accountLabel?.trim() || titleCase(slug)) || slug;
      out.push({
        item: {
          kind: "app",
          id: row.provider,
          label,
          icon: `app:${row.provider}`,
          connectorId: row.provider,
          connected: active,
          needsConnection: !active,
          connectHref: `/api/connectors/composio/${encodeURIComponent(slug)}/connect`,
          approval: approval(row.provider, label),
          updatedAt: row.createdAt.toISOString(),
        },
        alternates: [slug],
        boost: active ? 5 : 0,
      });
    }
  }

  for (const server of input.servers) {
    const id = `user_mcp:${server.id}`;
    if (!keep(id)) continue;
    out.push({
      item: {
        kind: "app",
        id,
        label: contextTokenLabel(server.name) || "MCP server",
        subtitle: server.url,
        icon: `app:${id}`,
        connectorId: id,
        // The server's own switch is the one "connected" here: a switched-off
        // server is offered like an app to connect, and its page turns it on.
        connected: server.enabled,
        needsConnection: !server.enabled,
        connectHref: "/connections",
        approval: approval(id, server.name),
        updatedAt: server.createdAt.toISOString(),
      },
      boost: server.enabled ? 5 : 0,
    });
  }
  return out;
}
