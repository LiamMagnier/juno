# Security policy

Juno is a hosted, paid AI chat product handling user conversations, uploaded
files, connected third-party accounts and payment metadata. Security reports are
welcome and will be taken seriously.

## Reporting a vulnerability

**Email `security@liams.dev`** with:

- what you found and where (a URL, a route, a file path);
- how to reproduce it, ideally with the smallest possible steps;
- what an attacker could do with it.

Please do **not** open a public GitHub issue for a security problem.

You should get an acknowledgement within **72 hours**. Juno is maintained by one
person, so a fix may take longer than that — you will get an honest timeline
rather than silence.

## Scope

In scope: the hosted app at the production origin, this repository's source, the
`/api/v1` contract, the voice relay (`relay/`), the Cloud Code runner
(`.github/workflows/code-runner.yml` + `runner/agent-core/`), and the macOS/iOS
clients under `native/`.

Out of scope: the upstream model providers, Stripe, Supabase, Composio and the
other third parties Juno depends on — report those to the vendor. Also out of
scope: findings that require a compromised device or a rooted/jailbroken client,
volumetric denial of service, and reports produced solely by an automated
scanner with no demonstrated impact.

## Please do not

- Access, modify or delete data belonging to an account that is not yours. If a
  proof of concept needs a second account, create one.
- Run automated scanners against the production origin.
- Perform denial-of-service testing.
- Exfiltrate data. Demonstrate access, then stop.

Testing that stays inside your own account, on your own data, is fine.

## Known and accepted

These are documented rather than hidden. They are real, they are on the backlog,
and a report about them will be acknowledged but is not new information:

- **No Content-Security-Policy.** Next.js inline scripts need per-request
  nonces; a nonce-based CSP is planned work. See `review/02-SECURITY.md` §7.1.
- **Tool and web-search output is not isolated from instruction.** MCP tool
  results and fetched pages re-enter the model's context without a trust
  boundary. See `review/02-SECURITY.md` §4.1.
- **CSRF passes when a request carries no `Origin` header** — deliberate, so
  native clients and server-to-server callers work. See `src/middleware.ts`.
- **Native access tokens have no revocation list.** Revoking a device kills the
  refresh family; an already-issued access token stays valid for up to its
  10-minute TTL.

## Handling of user data

Message content, reasoning traces, connector tokens and OAuth tokens are
AES-256-GCM encrypted at rest. Conversation search is title-only as a direct
consequence. Full account deletion (`DELETE /api/account`) cascades across
PostgreSQL and object storage; see `docs/JUNO.md` §15.3.
