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

## Work connector events

The Work poller reads persisted events through `readConnectorTriggerEvents`. Supported connector IDs are `gmail`, `google-calendar`, `google-drive`, `outlook`, `microsoft-365` and `slack`. Unknown connectors remain refused. The first read records the current outbox position and starts no old runs. Subsequent reads preserve the poller's existing admission, lease, deduplication, approval and audit paths.

`events` accepts event names such as `message_received`, `message_changed`, `message_deleted`, `file_changed`, `file_deleted`, `event_changed` and `event_deleted`; an empty list means all events from that source. `attributes.resourceId` can narrow a specific resource. Google Calendar defaults to the primary calendar; `attributes.stream` can select a calendar ID. Slack requires a channel ID in `attributes.stream`, for example `{ "kind": "connector_event", "config": { "connector": "slack", "events": ["message_received"], "attributes": { "stream": "C123456" } } }`.

The generic trigger editor currently exposes connector/event names and does not expose the stream attribute. Slack channel selection therefore requires the API configuration shape above until the requested small UI integration lands. Permission policies still apply to source reads: a blocked connector or Always ask policy refuses unattended sync. These are incremental API reads, not vendor push subscriptions.

## Owner setup and acceptance

Exact OAuth registrations, callbacks and delegated scopes are in the shared `.claude/handoff/OWNER_TODO.md`. The owner must configure dedicated connector app credentials, finish any Google restricted-scope review, consent against test accounts, and verify live refresh/revoke and approved sends. Automated tests replace provider responses and use disposable PostgreSQL; they do not prove vendor consent or API acceptance.

Reference protocols: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Microsoft delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages), [Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation/).
