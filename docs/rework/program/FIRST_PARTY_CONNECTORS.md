# First-party connector implementation (G08)

The six dedicated connectors use the existing Connections page and shared MCP dispatcher. Provider access and refresh tokens remain encrypted in Connection; only scoped short-lived Alevr tokens reach the internal MCP adapters. OAuth credentials for Google connectors are separate from Google sign-in. Unconfigured connectors are hidden. Existing connected Composio apps remain usable.

## Available tools

- Gmail: search/read, draft and approved send.
- Google Calendar: calendars, event search/read and approved event creation.
- Google Drive: search and bounded text reads, including native Google Docs/Sheets/Slides exports.
- Outlook: mail search/read/draft/approved send and calendar list/search/create.
- Microsoft 365: OneDrive search/list, SharePoint discovery and bounded text file reads; other formats return metadata with an explicit limitation.
- Slack: search, list/read conversations and approved posting.

All sends and posts pass the shared approval broker and tool audit. Provider writes are never retried after an ambiguous failure. Redirects cannot carry provider authorization to another host. File download redirects use the public-DNS-pinned SSRF-safe fetch without provider headers. Responses and input sizes are bounded.

## Incremental sync

`POST /api/connectors/{id}/sync` accepts `{ "stream": "primary" }` (a Slack channel ID for Slack, a calendar ID for Google Calendar). Each request consumes one bounded page and returns `inserted`, `more` and `reset`. Initial snapshots establish a quiet baseline. Gmail uses history IDs, Drive uses change tokens, Calendar uses sync tokens, Graph uses delta links, and Slack retains decimal timestamp strings across pagination. Expired provider cursors return a reset indication; an expired history window cannot be recovered as a complete event history.

The additive migration creates parent-scoped ConnectorSyncState and ConnectorSyncEvent tables. Every storage query proves ownership through Connection. Cursor state and event payloads are encrypted. Events and their next cursor commit atomically; row locks serialize refresh token rotation and event publication across replicas. Disconnect removes both tables' private data through cascading foreign keys. These are incremental reads, not vendor push subscriptions.

## Shared trigger integration still required

`readConnectorTriggerEvents` in `src/lib/first-party-connectors/sync-store.ts` is the producer seam for the existing Work poller. It yields real outbox event sequence positions, supports the poller's quiet first-read behavior, and leaves admission, leases and deduplication with the existing poller.

The handoff assigns `src/lib/work/triggers.ts` to Claude. Until the request in LANES.md is accepted and its integration is tested, `connector_event` remains refused. Do not advertise connector-trigger availability based only on the new outbox. Slack channel selection also needs to be exposed by that integration. Vendor push registration/renewal is not implemented by this change.

## Owner setup and acceptance

Exact OAuth registrations, callbacks and delegated scopes are in the shared `.claude/handoff/OWNER_TODO.md`. The owner must configure dedicated connector app credentials, finish any Google restricted-scope review, consent against test accounts, and verify live refresh/revoke and approved sends. Automated tests replace provider responses and use disposable PostgreSQL; they do not prove vendor consent or API acceptance.

Reference protocols: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Microsoft delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages), [Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation/).
