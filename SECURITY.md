# Security Policy

Juno is a hosted, paid AI platform handling user conversations, uploaded
files, connected cloud workspaces, software engineering repositories, and payment metadata. Security reports are
welcome and will be prioritized.

## Reporting a Vulnerability

**Email `security@liams.dev`** with:

- What you found and where (a URL, a route, a file path);
- How to reproduce it, ideally with the smallest possible steps;
- What an attacker could do with it.

Please do **not** open a public GitHub issue for a security vulnerability.

You will receive an acknowledgement within **24–48 hours**.

## Scope

In scope:
- Hosted web application (`src/app/`, `src/components/`, `src/middleware.ts`)
- The `/api/v1` native API contract
- The Voice and Multimodal WebSocket relay (`relay/`)
- Agent and tool execution runtime (`src/lib/agent/`, `src/lib/work/`, `src/lib/trust-boundary.ts`)
- Native macOS and iOS applications (`native/Packages/`, `native/macOS/`, `native/iOS/`)

Out of scope:
- Upstream model provider outages or platform issues (OpenAI, Anthropic, Google, etc.)
- Findings requiring physical access to a rooted or jailbroken client device
- Volumetric denial of service (DDoS)

## Enforced Security Controls

1. **Content Security Policy (CSP)**:
   Strict per-request nonce-based CSP with `strict-dynamic`, disallowing `unsafe-eval` in production.
2. **Deterministic Agent / Tool Trust Boundary**:
   Strict input provenance tracking (`user`, `system`, `external_website`, `mcp_tool_response`, `uploaded_document`, etc.). External untrusted inputs are DATA, never INSTRUCTIONS, and cannot execute destructive tools without explicit user approval.
3. **Action-Bound Approval Receipts**:
   Cryptographic SHA-256 digests over tool, args, session, and user. Any mutation of arguments invalidates prior approvals.
4. **CSRF & Origin Validation**:
   Cookie-authenticated browser mutations strictly require matching `Origin` or `Sec-Fetch-Site: same-origin`. Missing or cross-origin headers fail closed. Bearer-authenticated API/Native clients operate under the bearer authentication contract.
5. **Immediate Native Credential Revocation**:
   Device session revocation immediately fails closed on subsequent bearer authentication and token rotation with zero grace period.
6. **Cryptographic Enterprise SSO**:
   OIDC ID Token verification via JWKS signature validation, audience verification, expiration checking, and replay defense.
7. **Enterprise Data Loss Prevention (DLP)**:
   Deterministic secret scanning and policy enforcement (allow/warn/block modes) with audit event logging before payload dispatch.

## Handling of User Data

Message content, reasoning traces, connector tokens, and OAuth credentials are
AES-256-GCM encrypted at rest. Conversation search is title-only as a direct
consequence. Full account deletion (`DELETE /api/account`) cascades across
database records and object storage.
