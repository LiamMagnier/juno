# Handoff: artifact previews on their own policy (audit X-01) + public-link governance

Status on 2026-09-23: **done and committed, not merged, not deployed.** The session
paused on the user's request (usage limit).

- Worktree: `.claude/worktrees/laughing-hofstadter-77d528`
- Branch: `claude/sharp-aryabhata-79fb4b` (based on main at `7f92324f`)
- Fix commit: `b7946ff5` "Run artifact previews under their own policy, and make public links removable"
- Audit record: `docs/design/artifacts-design/00-AUDIT-OVERVIEW.md` §6 #1, §7 X-01/X-31/X-32, §12.8,
  on branch ref `wip/artifacts-design-audit` (not updated; it still lists X-01 as open)

## What was wrong

Since fb3a42b5 (26 Aug 2026) the app sends an enforcing CSP with a nonce and
`'strict-dynamic'`. Previews were `<iframe srcdoc>`, and a srcdoc document inherits the
parent's policy container, so no artifact script ran anywhere on the web: canvas, inline
cards, Mermaid blocks, the JS/Python console, public shares, Work site previews.
Reproduced in Chrome. `blob:` inherits the same way and `data:` is refused by `frame-src`,
so neither is a fix.

## What changed (all in b7946ff5)

- `src/lib/sandbox-policy.ts`: profiles (`private` / `public`), the egress allowlists,
  iframe flags, the shell URL, and `documentPolicyFor` (the middleware routing decision).
- `src/lib/sandbox-shell.ts` + `src/app/sandbox/v1/[profile]/route.ts`: the shell page,
  served with its own CSP (including a `sandbox` directive and `frame-ancestors`). It
  takes the document over postMessage only from its parent at the app origin.
- `src/components/canvas/sandbox-document-frame.tsx`: the iframe plus the handshake. It
  sets `src` only after its listener is armed; otherwise a server-rendered frame with a
  cached shell never rendered. `SandboxFrame`, `MermaidBlock` and `WorkSitePreview` all
  use it. The share page wraps its content in `SandboxProfileProvider profile="public"`.
- `src/middleware.ts`: no app CSP on `/sandbox/*`. With `NEXT_PUBLIC_SANDBOX_ORIGIN`
  set, the preview host serves only the shell and the app host 404s it.
  `src/lib/csp.ts`: `frame-src` admits the preview origin.
- `next.config.mjs`: `X-Frame-Options` and `Referrer-Policy` are no longer sent on `/sandbox/*`.
- Governance (§12.8):
  - Ban propagation: `src/lib/share.ts` `findActiveShare` reads `User.bannedAt`.
  - Takedown: `Share.takenDownAt/By/Reason`, `src/lib/share-moderation.ts`,
    `/api/admin/shares/**`, Admin › Links (`src/components/admin/links-admin.tsx`).
  - Report link: `ShareReport`, `/api/share/report`,
    `src/components/share/report-share-dialog.tsx`.
- Migration: `prisma/migrations/20260923180000_share_governance` (expand-only).
- Tests: `tests/sandbox-origin.test.ts`, `tests/sandbox-origin-browser.test.ts`
  (Chromium; skips without one), `tests/share-governance.test.ts`, and an updated
  `tests/sandbox-security.test.ts`.
- Dev galleries: `/dev/sandbox` (every runtime, both profiles) and `/dev/share-links`
  (Report dialog + Admin › Links over a fetch shim).

Verified: full `tsx --test tests/*.test.ts` (3808 pass, 12 skipped), the auth,
message-crypto and moderation scripts, eslint on every changed file, and `tsc` (its only
error is the pre-existing missing `runner/agent-core/dist`). Both regression tests were
checked by reintroducing the bug. Every runtime ran in Chrome under the real app CSP,
same-origin and separate-origin (`localhost:3111` app, `127.0.0.1:3111` previews).

## Merge-plan acceptance conditions (04-MERGE-PLAN §9.5), added 2026-09-24

- CSP `sandbox` directive on every shell response: yes. It carries `allow-forms`, which the
  plan says to leave out: without it the `submit` event never fires, so every form-based
  artifact (a todo app) breaks. `form-action 'none'` already stops forms posting anywhere.
- Refuse any request whose `Sec-Fetch-Dest` isn't `iframe`, with `Vary: Sec-Fetch-Dest`
  so a cached copy can't answer a top-level visit: yes (`isFrameRequest`).
- `nosniff`: yes.
- CI test that opens a preview URL top-level: yes, the second test in
  `tests/sandbox-origin-browser.test.ts`. It gets a 404; a shell served anyway has
  origin `null` and can't read the cookie.
- Public shares gated (owner's decision, 2026-09-24): `/share/*` previews run no scripts.
  The `static` profile's shell admits only its own script, by hash; HTML, SVG and CSS
  render as markup, and React, Mermaid and code show their source.
  `JUNO_PREVIEW_ORIGIN_PUBLIC=1` switches shares to the scripted `public` profile. Turn
  it on only after publish-time screening (X-32) and a screening pass over existing
  HTML/React shares (B11) exist.
- Still open: the per-version HMAC subdomains and signed tokens need the separate
  preview domain.

## Exact next steps

1. **Coordinate the release** with the other sessions (memory:
   concurrent-sessions-shared-worktree). One releaser only; check `pgrep -f deploy-from-mac.sh`.
2. Merge `claude/sharp-aryabhata-79fb4b` into main: sync with the base branch, re-run
   `npm test` on the merged tree, then deploy. `deploy.sh` runs `prisma migrate deploy`,
   and the migration is additive.
3. After the deploy, make a **signed-in check**: open an HTML/React artifact in chat, a
   Mermaid block, and a `/share/<token>` page; test Report; and in Admin › Links take a
   link down and restore it. The in-app browser pane refuses URL-loaded iframes, so use
   real Chrome.
4. Optional, needs the owner: a separate preview domain. Needs DNS and a certificate,
   the commented server block in `deploy/nginx.conf.template`, and a rebuild with
   `NEXT_PUBLIC_SANDBOX_ORIGIN`.
5. Mark X-01 fixed on `wip/artifacts-design-audit`, then ping the juno-glass session
   (memory: artifacts-design-audit).

## Decisions made, and open items

- **Egress policy (audit question 6)** is my call; the owner may want it changed. Your
  own previews can no longer `fetch` arbitrary APIs: only jsDelivr, unpkg and cdnjs,
  plus PyPI for the Python console. Public shares also refuse unlisted image and frame
  hosts. The lists are in `src/lib/sandbox-policy.ts`.
- **Not done:**
  - publish-time screening of shared content (X-32)
  - keeping `ModerationFlag` rows after account deletion
  - the legal contact placeholder in `legal/mentions-legales`
  - letting admins preview a taken-down link's content
  - Admin › Links "open" still counts as a view
