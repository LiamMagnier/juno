# Tool Connectors

Juno lets a user link external tools. Once linked, the stored access token is
handed to the model as a **remote MCP server**, so the model can call that
provider's tools with the user's own permissions.

The Connections page shows **one unified directory**
(`components/connections/connector-directory.tsx`). Two backends feed it and the
user never has to care which:

- **Native connectors** — the six below, each with its own OAuth/credential flow
  and MCP endpoint. Always present, no server key needed beyond their own.
- **Composio** — the managed catalog (Gmail, Slack, Linear, …), searchable and
  paged. Requires `COMPOSIO_API_KEY`; when it is absent the directory still lists
  the native connectors and shows setup steps instead of rendering empty.

Composio itself is never shown as a connector. Where both backends offer the same
app (GitHub, Figma, Notion) the **native connector wins** and Composio's
duplicate is filtered out — see `NATIVE_EQUIVALENT` in the directory component.

| Connector      | Kind          | Pre-registration          | Refreshes  | MCP endpoint                         |
| -------------- | ------------- | ------------------------- | ---------- | ------------------------------------ |
| GitHub         | `oauth_app`   | OAuth app (id + secret)   | no         | `https://api.githubcopilot.com/mcp/` |
| Figma          | `oauth_app`   | OAuth app (id + secret)   | yes        | set via `FIGMA_MCP_URL`              |
| Notion         | `mcp_oauth`   | **none** (self-registers) | yes (1h)   | `https://mcp.notion.com/mcp`         |
| Apple Calendar | `credentials` | **none**                  | n/a        | `<app>/api/mcp/apple-calendar`       |
| Apple Mail     | `credentials` | **none**                  | n/a        | `<app>/api/mcp/apple-mail`           |
| Apple Music    | `credentials` | MusicKit key (.p8)        | ~150 days¹ | `<app>/api/mcp/apple-music`          |

¹ Music-User-Tokens aren't refreshable; the user re-authorizes when it lapses.

- **`oauth_app`** — a classic OAuth 2.0 app you register once with the provider.
  Its **Connect** button appears only when its `*_OAUTH_CLIENT_ID` and
  `*_OAUTH_CLIENT_SECRET` are set.
- **`mcp_oauth`** — a hosted remote MCP server that self-registers via OAuth 2.1
  + PKCE + Dynamic Client Registration. There is **nothing to pre-register**; it's
  available as soon as its MCP URL is known.
- **`credentials`** — no OAuth at all. The user hands us a credential (an iCloud
  app-specific password, or a MusicKit user token) in an in-app dialog. It's
  stored AES-256-GCM-encrypted on the `Connection` row, and the provider's tools
  are served by **our own MCP route** (`/api/mcp/[connector]`). The model
  authenticates to that route with a short-lived HMAC-signed token
  (`src/lib/connector-token.ts`) — the raw credential never leaves the server.
## Composio setup (recommended)

1. Create a project at [Composio](https://dashboard.composio.dev) and copy its API key.
2. Set `COMPOSIO_API_KEY` in Juno's environment and restart the backend.
3. Open **Connections**. The app directory now lists Composio toolkits directly.
4. Click **Connect** on Gmail, Slack, Linear, or any other app you want. Each app
   gets its own consent flow, status, disconnect action, and chat toggle.

Composio credentials never pass through Juno or the model. Juno stores an
encrypted, app-scoped session reference under `composio:<toolkit-slug>` and
proxies MCP requests server-side so Composio's API headers never reach the
browser or model provider. The catalog is loaded from Composio rather than
being hard-coded in the client.

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
6. `src/app/api/connectors/composio/[slug]` — manages one Composio toolkit at a
   time. A hidden directory session handles search/auth; app-scoped execution
   sessions prevent one enabled app from exposing another.
7. `src/app/api/mcp/composio/[slug]` — a short-lived bearer-authenticated MCP
   proxy that injects Composio's server-only session header. This also makes
   individual Composio apps usable by Claude's native remote-MCP path.

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

## Apple Calendar & Apple Mail setup (app-specific passwords)

Nothing to configure on the server — both connectors are always available. The
user links them with an **app-specific password** (Apple requires one for
third-party access to iCloud CalDAV/IMAP; the account must have two-factor
authentication enabled):

1. Open [account.apple.com](https://account.apple.com) and sign in.
2. **Sign-In & Security → App-Specific Passwords → Generate** one named "Juno"
   (format `xxxx-xxxx-xxxx-xxxx`).
3. In Juno → **Connections → Apple Calendar / Apple Mail → Connect**, enter the
   Apple ID email and the app-specific password.

Juno validates the credentials live before saving (a CalDAV principal lookup
against `caldav.icloud.com`, or an IMAP login to `imap.mail.me.com:993`) and
rejects the main Apple ID password with a hint to generate an app password.
Revoking the password at account.apple.com kills access instantly.

- **Apple Calendar tools:** `list_calendars`, `list_events`, `create_event`,
  `delete_event` (CalDAV; recurring events are flagged, not expanded).
- **Apple Mail tools:** `list_mailboxes`, `search_messages`, `read_message`,
  `unread_count` (IMAP, read-only, capped at 25 results).

## Apple Music setup (MusicKit)

Needs an Apple Developer account for the developer token that MusicKit requires:

1. Apple Developer → **Certificates, Identifiers & Profiles → Keys → +**, enable
   **Media Services (MusicKit)**, and download the `.p8` private key.
2. Set `APPLE_MUSIC_TEAM_ID` (Membership page), `APPLE_MUSIC_KEY_ID` (the key's
   id), and `APPLE_MUSIC_PRIVATE_KEY` (the `.p8` contents — literal `\n` escapes
   are fine for single-line env vars).
3. In Juno → **Connections → Apple Music → Connect**, the dialog loads MusicKit
   JS, runs Apple's sign-in popup, and stores the resulting **Music-User-Token**
   (encrypted, ~150-day expiry; the user re-authorizes after that).

Tools: `search_catalog`, `list_playlists`, `recently_played`, `add_to_playlist`.

## Environment variables

```txt
# Required — OAuth callbacks (and Notion) resolve against this host
NEXT_PUBLIC_APP_URL=https://<your-app>

# Recommended — managed catalog and per-user app connections
COMPOSIO_API_KEY=

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

# Apple Calendar / Apple Mail — nothing to configure (app-specific passwords).

# Apple Music (optional — the connector shows Unavailable until all three are set)
APPLE_MUSIC_TEAM_ID=
APPLE_MUSIC_KEY_ID=
APPLE_MUSIC_PRIVATE_KEY=   # .p8 contents; \n escapes allowed
```

Note for the Apple connectors: `NEXT_PUBLIC_APP_URL` must be the **public** URL
of the deployment — Anthropic's MCP infrastructure dials
`/api/mcp/apple-*` from outside, so a localhost URL only works for
non-Anthropic providers (which call the route through the local tool loop).

Set the same variables in the Vercel project (Settings → Environment
Variables), then redeploy. The `Connection` table needs the `oauthClientId` /
`oauthClientSecret` columns (migration `20260702033000_add_mcp_oauth_client_fields`),
so run `prisma migrate deploy` (or `prisma db push`) against the database.
