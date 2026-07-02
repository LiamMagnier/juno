# Tool Connectors

Juno lets a user link external tools. Once linked, the stored access token is
handed to the model as a **remote MCP server**, so the model can call that
provider's tools with the user's own permissions.

Connectors come in two shapes:

| Connector | Kind        | Pre-registration        | Refreshes | MCP endpoint                         |
| --------- | ----------- | ----------------------- | --------- | ------------------------------------ |
| GitHub    | `oauth_app` | OAuth app (id + secret) | no        | `https://api.githubcopilot.com/mcp/` |
| Figma     | `oauth_app` | OAuth app (id + secret) | yes       | set via `FIGMA_MCP_URL`              |
| Notion    | `mcp_oauth` | **none** (self-registers) | yes (1h) | `https://mcp.notion.com/mcp`         |

- **`oauth_app`** — a classic OAuth 2.0 app you register once with the provider.
  Its **Connect** button appears only when its `*_OAUTH_CLIENT_ID` and
  `*_OAUTH_CLIENT_SECRET` are set.
- **`mcp_oauth`** — a hosted remote MCP server that self-registers via OAuth 2.1
  + PKCE + Dynamic Client Registration. There is **nothing to pre-register**; it's
  available as soon as its MCP URL is known.

## How it works

1. `src/lib/connectors.ts` — the connector registry plus a unified
   authorize / exchange / refresh flow that dispatches on `kind`.
2. `src/lib/mcp-oauth.ts` — the OAuth 2.1 client for `mcp_oauth` servers:
   discovery (RFC 9728 → RFC 8414), Dynamic Client Registration (RFC 7591),
   PKCE, and resource-bound tokens (RFC 8707).
3. `src/app/api/connectors/[id]/connect` — sets a signed, single-use `state`
   cookie (and, for `mcp_oauth`, an encrypted per-flow session cookie holding the
   PKCE verifier + registered client) and redirects to the consent screen.
4. `src/app/api/connectors/[id]/callback` — verifies `state`, exchanges the code
   for tokens, and stores them encrypted (AES-256-GCM) as a `Connection` row.
5. `src/lib/mcp.ts` — at generation time, resolves linked connectors into live
   MCP endpoints (refreshing expiring tokens) and exposes their tools to the model.

## Notion setup (MCP)

Notion is the easy one — **no Notion app, no client id, no secret.** The hosted
Notion MCP server registers Juno as a client automatically the first time a user
connects (Dynamic Client Registration).

1. Set `NEXT_PUBLIC_APP_URL` to your deployed URL so the OAuth callback
   (`https://<your-app>/api/connectors/notion/callback`) resolves correctly.
2. That's it. `NOTION_MCP_URL` defaults to `https://mcp.notion.com/mcp`; set it
   only to override.
3. In Juno → **Connections → Notion → Connect**, approve the workspace + MCP
   permissions in Notion's consent screen, then toggle **Expose to chats**.

Notion access tokens are short-lived (~1 hour); Juno refreshes them
automatically using the client it registered at connect time (persisted on the
`Connection` row as `oauthClientId` / `oauthClientSecret`). Refresh tokens last
180 days (or 30 days of inactivity), after which the user reconnects.

## GitHub setup

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Authorization callback URL:**
   `https://<your-app>/api/connectors/github/callback`
3. Copy the **Client ID** and generate a **Client secret**.
4. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
5. `GITHUB_MCP_URL` is optional — it defaults to
   `https://api.githubcopilot.com/mcp/`.

## Figma setup

1. Figma → **Settings → Account → Developer → Apps → Create a new app**.
2. **OAuth callback / redirect URL:**
   `https://<your-app>/api/connectors/figma/callback`
3. Under the app's **OAuth scopes** tab, enable the scopes you want (e.g.
   `file_content:read`). These must match `FIGMA_OAUTH_SCOPE`.
4. Set `FIGMA_OAUTH_CLIENT_ID`, `FIGMA_OAUTH_CLIENT_SECRET`, and, to expose
   Figma tools to the model, `FIGMA_MCP_URL` (Figma's remote MCP endpoint).

## Environment variables

```txt
# Required — OAuth callbacks (and Notion) resolve against this host
NEXT_PUBLIC_APP_URL=https://<your-app>

# Notion (MCP) — no id/secret needed. Only override the endpoint if you must.
# NOTION_MCP_URL=https://mcp.notion.com/mcp

# GitHub (optional — the connector is hidden until both are set)
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
# GITHUB_MCP_URL=https://api.githubcopilot.com/mcp/   # optional override

# Figma (optional — the connector is hidden until both are set)
FIGMA_OAUTH_CLIENT_ID=
FIGMA_OAUTH_CLIENT_SECRET=
FIGMA_OAUTH_SCOPE=file_content:read
FIGMA_MCP_URL=
```

Set the same variables in the Vercel project (Settings → Environment
Variables), then redeploy. The `Connection` table needs the `oauthClientId` /
`oauthClientSecret` columns (migration `20260702033000_add_mcp_oauth_client_fields`),
so run `prisma migrate deploy` (or `prisma db push`) against the database.
