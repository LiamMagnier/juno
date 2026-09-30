# Audit: Security, CI and Release

Phase 0 of the Juno Refoundation. Read-only audit of `rework/refoundation` (same tree as `main` @ `1feb392c`), 2026-09-30.

Method: read the code and scripts, queried GitHub (`gh run list`, `gh api`, `gh release`), probed the live site (`/api/health`, response headers, `/sign-in`), ran two light static checks (`node scripts/check-approval-dispatch.mjs`, `npm audit --omit=dev`). I did not run typecheck, tests, builds, Swift or Xcode, because the baseline gate run needs the machine. Anything I could not confirm is marked **UNVERIFIED**.

Sibling audits overlap with this one in two places. I cite them and do not repeat them in full:
- The user MCP SSRF is written up as P1 in `docs/rework/audit/connectors-skills.md` §3. It is summarised here as a security guarantee gap.
- Agent computers being off in production because the VM cannot fit them is in `docs/rework/audit/crew-work-research-voice.md` §2. This audit covers the security side of computers.

---

## 0. Decision summary

1. **No CI gate has run since 2026-09-22.** Every GitHub Actions job since then failed within 2–7 seconds with "recent account payments have failed or your spending limit needs to be increased". That covers `deploy` (run 36719202721), `native`, `sync-models` (fails daily), `code-runner` (last success 2026-08-10) and both release workflows. `main` has **no branch protection** (`gh api …/branches/main/protection` → 404). Production is deployed from the Mac by `deploy/deploy-from-mac.sh`, which runs a **subset** of the gates and can skip all of them with `--skip-checks`. Production currently serves `1feb392c`, and `/api/health` reports that SHA.
2. **This has already caused a production outage.** Commit `724cd370` ("Add the UserMcpServer migration the custom MCP release shipped without") records that production failed every connector lookup with P2021, so any chat that resolved connectors died before its first token. The CI `migrations` job (drift check, `deploy.yml:190-400`) would have caught it. `deploy-from-mac.sh` does not run it.
3. **Five security gaps block calling Crew computers production:**
   - the agent's own shell can reach unauthenticated raw Chrome DevTools and the cookie store;
   - `computer_shell` is graded only `command`, so Skip mode or one "Always allow" gets past the ALWAYS_CONFIRM floor;
   - a takeover does not pause the agent;
   - the handoff link is a reusable 60-second control bearer;
   - the web process is in the `docker` group, which makes it root-equivalent.

   The feature is also physically impossible on the current VM (sibling audit).
4. **SECURITY.md claims three "Enforced Security Controls" whose modules are dead code:** the Trust Boundary (`src/lib/trust-boundary.ts`), Enterprise SSO (`src/lib/auth/enterprise-sso.ts`) and DLP (`src/lib/security/dlp.ts`). Each is imported only by its own test. `src/lib/capabilities.ts`, which lists SSO and DLP as `"stable"`, is also imported by nothing.
5. **The auto-update chain of the shipped Mac app is weak.** Installed builds are ad-hoc signed (`--publish-dev`). For an ad-hoc running app the updater's code requirement falls back to `identifier "<bundle id>"` only (`DesktopUpdater.swift:561-565`). Anyone who can publish a GitHub release on the repository, or tamper with the server's feed, can therefore push arbitrary code to every installed Mac.
6. **The iOS release path has never run** (`release-ios.yml` has zero runs). It needs GitHub Actions, and there is no local equivalent.
7. **Dependency advisories are live in production code paths.** `npm audit --omit=dev` today reports 10 (8 high), including `next-auth`/`@auth/core`, `nodemailer`, `imapflow` and `ip-address`. `security:check`, which contains the dependency audit and the tracked-secret scan, is in **no** workflow and not in `deploy-from-mac.sh`.

---

## 1. Map

### 1.1 Security controls: where each is enforced

| Control | Enforcement point | Tests | Notes |
|---|---|---|---|
| CSP (nonce + `strict-dynamic`) | `src/middleware.ts`, `src/lib/csp.ts:28` (`buildCsp`) | `tests/csp.test.ts`, `tests/csp-report.test.ts` | Live header confirmed: `script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-inline' https:`. The last two are CSP2 fallbacks that `strict-dynamic` ignores. HSTS 2y, `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` all present. |
| Artifact preview isolation | `src/lib/sandbox-policy.ts`, `src/lib/sandbox-shell.ts`, `src/app/sandbox/v1/[profile]/route.ts` | — | Merged (`b7946ff5` is an ancestor of main). `docs/security/PREVIEW-ORIGIN-HANDOFF.md` still says "not merged, not deployed", which is stale. |
| CSRF / Origin | `src/lib/csrf.ts:47` (`evaluateCsrf`), called from `src/middleware.ts:125` | `tests/csrf-origin.test.ts` | A cookie-bearing mutation needs a matching `Origin`, or `Sec-Fetch-Site: same-origin`. Bearer-only requests pass. `/api/auth/*` is exempt except `register`. The exempt custom routes (`forgot-password`, `reset-password`, `mfa/challenge`) are pre-auth. |
| Chat/connector action approval: risk class, policy, digest-bound one-time receipt | `src/lib/action-approval.ts:215` (`classifyExternalAction`, deny-first), `:283` (`decideActionPolicy`), `:351/:377` (policy and receipt SHA-256 digests with domain separation), `:43` (15-min TTL); `src/lib/action-approval-store.ts:254-290` (binding recomputed and compared on redemption), `:557` (`decideActionApproval`) | `tests/action-approval*.test.ts` | "Unknown" risk takes the external-write floor (`:275`). Destructive always asks unless the policy is `block`. Standing approvals only for `reversible_write` (`:279`). |
| Work approval floor (ALWAYS_CONFIRM) | `src/lib/work/domain.ts:615` (list), `:641` `requiresExplicitApproval`, `:661` `mayBeCoveredByStandingAllowance`, `:737` `approvalRuling` (floor checked before the mode ladder); vendored copy `runner/agent-core/src/work/types.ts:111-138`; Swift mirror `WorkRisk.swift` | `tests/work-approval-modes.test.ts`, `tests/work-approval-digest.test.ts`, `tests/work-security.test.ts` (drift between TS and runner copy) | Work approvals are digest-bound via `src/lib/work/digests.ts:72-77`. |
| Approval dispatch chokepoints | `scripts/check-approval-dispatch.mjs` (TS-parser static proof that a policy/receipt call precedes each tool sink) | passes today | **Wired into no gate**: not in `package.json` scripts, any workflow, `security-check.mjs` or the Mac deploy. Does not inventory `computer_*` tools or `user_mcp:` servers. |
| Untrusted-content provenance | `src/lib/work/connectors.ts:615-627` (`derivedFromUntrusted` = the injection detector fired; forces approval for non-read connector calls), `src/lib/mcp.ts:468/511`, `src/lib/chat/task-tool.ts:739`, `src/lib/chat/handoff-tool.ts:559` | `tests/untrusted-content.test.ts` | What actually ships is **heuristic detection plus the approval policy**, not taint tracking. `src/lib/trust-boundary.ts` (the "provenance engine" SECURITY.md describes) is dead (§2). |
| SSRF: search/browse/research | `src/lib/search/url-safety.ts:18-57` (host/IP deny rules), `src/lib/search/pinned-fetch.ts:30-45` (resolve once, refuse any private answer, pin the socket), `src/lib/search/fetch-safe.ts:20-47` (re-validate every redirect hop); used by `src/lib/agent/browser.ts:45-49`, `search-engine.ts:324-328` | `tests/search-ssrf.test.ts` | Gaps: only `0.0.0.0` rather than all of `0.0.0.0/8`, and no NAT64 `64:ff9b::/96`, 6to4 `2002::/16` or Teredo. `research/crawler.ts:105,293` and `research/agents/protocol.ts:184` use the host check only, with no DNS pinning. A hardened version is on the unmerged `web/rework-ws2` (§4). |
| SSRF: Work runner fetch | `runner/agent-core/src/work/tools.ts:258-280` (`blockedFetchAddress`, a separate copy) | runner suite | This is the third copy of the IP classifier. The relay has a fourth, a CIDR allowlist. |
| SSRF: user MCP servers | **none**. `src/lib/user-mcp.ts:46-57` checks the scheme only and allows `http://localhost` in production. `mcp-probe.ts:43`, `mcp.ts:384` use the SDK's default `fetch`. | none | See `connectors-skills.md` P1. The fix exists as `src/lib/mcp-safe-fetch.ts` on `connectors/custom-mcp` (`75a62e6a`). |
| Ownership scoping | `src/lib/db.ts:264-283` (Prisma `$extends` guard over `OWNER_COLUMN`), `tests/ownership-guard.test.ts` (schema drift) | yes | **Fails open in production.** It logs and proceeds (`db.ts:277-278`), and throws only when `NODE_ENV=development`. It checks that an owner key is *present*, not that it is the caller's. It does not cover `count`, `aggregate`, `groupBy`, `upsert`, `create`. 156 call sites use `prismaUnguarded`. Real authorization is the per-route `where: { id, userId }`. |
| Encryption at rest: messages and fields | `src/lib/message-crypto.ts` (AES-256-GCM, `DATA_ENCRYPTION_KEYRING`, refuses production without it `:130-168`), `src/lib/field-crypto.ts` | `tests/field-crypto.test.ts`, `scripts/test-message-crypto.ts` | Solid. |
| Encryption at rest: secrets (connector tokens, MCP auth headers, agent-computer VNC/CDP secrets) | `src/lib/crypto.ts` `encryptSecret` | — | **No production guard.** Primary key defaults to `"auth"`, which is `sha256("juno:connector:"+AUTH_SECRET)` (`crypto.ts:36-38, 78`) unless `TOKEN_ENCRYPTION_KEYS`/`TOKEN_ENCRYPTION_PRIMARY` are set. Production value UNVERIFIED. The `DATA_ENCRYPTION_KEY` mentioned in the brief protects messages, not these secrets. |
| Native bearer auth and immediate revocation | `src/lib/native-auth.ts:387-411` (per-request DB lookup of `NativeDeviceSession.revokedAt`, `bannedAt`, `sessionVersion`), `:413-432` (`revokeNativeDevice` also revokes refresh tokens and push tokens), refresh-token reuse detection `:299-323`; 10-min access JWT (`native-auth-core.ts:8`) | `tests/native-auth-core.test.ts`, `tests/native-revocation-immediate.test.ts` | Real and correct. Keychain storage is `AfterFirstUnlockThisDeviceOnly` (`KeychainAuthTokenStore.swift:223,426`). |
| Web sessions / MFA | `sessionVersion` re-check, TOTP (`src/lib/totp.ts`), owner MFA gate (`src/lib/admin.ts`) | `tests/totp-rfc6238.test.ts`, `scripts/test-auth.ts` | Live `/sign-in` shows `googleEnabled:false`, `appleEnabled:false`, `emailLinkEnabled:true`. Production has no OAuth sign-in. |
| Agent computer container | `src/lib/computer/docker.ts:33-95` (`--cap-drop ALL`, `no-new-privileges`, `--read-only`, tmpfs, `--pids-limit 2048`, mem/cpu caps, DNS 1.1.1.1/9.9.9.9, no published ports in production), `deploy/agent-computers/firewall.sh:10-12` (drops RFC1918, CGNAT, link-local, loopback, multicast/reserved, Azure wire server `168.63.129.16`, host INPUT, all IPv6), `setup-vm.sh:23` (`enable_icc=false`), `chrome-policies.json` (no password/card/address saving) | `tests/agent-computer.test.ts` | Good container hygiene. The gaps are inside the container (§3.2). |
| Computer live view | `src/lib/computer/live-view.ts:27-56` (HMAC view token, 60 s), `relay/src/computer-view.ts:58-66` (endpoint must be `:5900` inside `172.30.0.0/24` in production), `:196` (Origin allowlist), `:202` (token), 3 viewers/agent, 15-min idle, 2-h cap; watch vs control enforced by x11vnc view-only password (`docker.ts:651-678`) | `relay/tests/computer-view.test.ts` | Token travels in the query string, so nginx logs it (`nginx.conf.template:24`, default format). The 60-s TTL limits the damage. |
| Computer handoff (native → web view) | `live-view.ts:64-128` (`mintHandoffCode`, `verifyHandoffCode`, 60 s), `src/app/computer-view/page.tsx:26` (verifies `?c=` and renders the viewer with the VNC password, no session required) | — | Multi-use bearer and no audit event (§3.2). |
| Mac updater signature check | `native/macOS/JunoDesktop/App/DesktopUpdater.swift:548-620` (`SecStaticCodeCheckValidity` with a requirement relative to the running app), shell re-check with `codesign -R` before the swap (`:412-426`) | `JunoUpdateFeedTests.swift` | Strong for a Developer ID install, weak for the ad-hoc installs that actually exist (§3.3). |
| App Store billing | `src/lib/billing/app-store.ts:94-127` (`SignedDataVerifier`, Production only) | — | Server side is real. The client `JunoStoreKit.swift` is referenced only by its test, so no app UI sells subscriptions. The Production-only verifier also means TestFlight sandbox purchases cannot be verified. |

### 1.2 Crew computer data flow

```
Web /agents → POST /api/agents/[id]/computer (enable/wake)
      └─ src/lib/computer/store.ts → DockerProvider (docker CLI via execFile/spawn, argv arrays)
            └─ container juno-agent-<id>  (network juno-computers / br-juno, 172.30.0.0/24)
                 ├─ Xvfb :0 + XFCE + Chromium --no-sandbox --remote-debugging-port=9223 (loopback, NO auth)
                 ├─ cdp-gate.py 0.0.0.0:9222 → 127.0.0.1:9223, requires X-Juno-CDP-Token
                 ├─ x11vnc :5900 (started on demand, passwdfile in /home/agent/.juno, readable by uid 1000)
                 └─ volume /home/agent (profile + cookies + downloads), persistent per agent

juno-work (scripts/work-runner.ts:3401) → resolveRunComputerSession (lease CAS, 120 s)
      ├─ connectAgentBrowser (Playwright connectOverCDP via :9222 + token) → `browser` tool
      └─ runtime.computerTools (work-runner.ts:1919-1990):
           computer_screenshot|click|type|key|scroll  (xdotool/scrot via docker exec)
           computer_shell  → docker exec bash (risk 'command', computer-tools.ts:329-334)
           computer_files  → docker exec cat / sh -c 'cat > "$1"'

Viewer: POST /api/agents/[id]/computer/view {mode, handoff?}
      ├─ direct: {relayUrl, token(60 s), password(view or control)} → noVNC in browser
      │     → wss://…/voice-relay/computer?t=… → relay verifies HMAC + CIDR → TCP :5900
      └─ handoff: URL /computer-view?c=<60 s code> → page renders viewer with password
```

### 1.3 CI map

| Workflow | Trigger | Jobs / gates | State |
|---|---|---|---|
| `deploy.yml` "Deploy to VM" | push to main (except `native/**`, `docs/**`, `artifacts/**`), every PR, dispatch | `test`: i18n, typecheck, `npm test`, lint, `capabilities:check`, `work:contract:check`, `models:capabilities:audit`, `work:sandbox:check`, host-serialiser grep. `migrations`: Work migration present, no `CREATE INDEX CONCURRENTLY`, `prisma validate`, **`migrate diff` drift (blocking)**, three DB-backed suites. `runner`: agent-core build and tests, compiled-output check. `build-and-deploy`: `next build`, relay, release transaction, smoke | **Billing-blocked since 2026-09-22.** Last success 2026-09-22T16:30Z. |
| `native.yml` | push to main, every PR, dispatch | `contract`: `native:contract:check`, `design:tokens:check`, icons, `design:contract:check`, `design:editor:check`, shell contract. `design`: `native:design:check`. `parity`: `native:wire:check`, `native:parity:check`, `native:register:check`. `packages` (macos-26 matrix JunoNativeKit, JunoCode, JunoWork). Mac build (Debug and Stable) and unit tests. iOS simulator build and unit tests | Billing-blocked. |
| `native-parity.yml` | PR | parity-label check | PRs are not used (every recent run is a `push`). |
| `release-macos.yml` | dispatch | Developer ID and notarization path | 3 runs, all failed or cancelled (no Developer ID). |
| `release-ios.yml` | dispatch, main only | release gates, 3 `swift test` packages, unsigned build, ASC key check, archive, TestFlight upload | **Never run.** |
| `code-runner.yml` | dispatched **by the app** for cloud Juno Code tasks | runs agent code on a GitHub runner | Last success 2026-08-10, last run failed 2026-09-21. Cloud Code depends on Actions billing. |
| `sync-models.yml` | daily schedule | model catalogue sync, opens a PR | Fails daily (billing). |

Local substitutes: `deploy/deploy-from-mac.sh` (web), `native/Scripts/release-macos.sh` (Mac), `scripts/release-gates.sh` (native release invariants), `.githooks/pre-commit` (eslint on staged files plus a secret-filename check), `.claude/local-tools/refoundation/gate.sh` (slot lock only, no gate list).

### 1.4 Release paths

- **Web.** `deploy-from-mac.sh` does the following:
  1. `git archive` of `origin/main` or any ref. A ref not on GitHub only gets a warning (`:77-78`).
  2. Gates in a linux/amd64 container (`:145-155`): i18n, typecheck, `npm test`, lint, capabilities, Work contract, model evidence, Work sandbox, runner tests. **All of them are skipped with `--skip-checks`** (`:44`).
  3. `next build`, relay tests and build.
  4. Upload with checksums, then `deploy.sh` (migrate deploy, PM2 reload, health, auto-rollback).
  5. External health for the exact SHA, production smoke (sign-in plus a real chat reply), public UI smoke.

  SSH uses `StrictHostKeyChecking=accept-new` (TOFU, `:56`), where CI pins `VM_KNOWN_HOSTS`. The deploy transaction itself (checksums, immutable release dir, rollback) is well built.
- **Mac.** `release-macos.sh X.Y.Z --publish-dev` does the following:
  1. Signs with Apple Development, or **ad-hoc `-`** when there is no certificate (`:200-205`, `:356-363`). Not notarized.
  2. Tests: `swift test --filter JunoVoiceKitTests` only, runner tests and `JunoDesktopTests` (`:266-276`). It does not run the full JunoNativeKit, JunoCode or JunoWork suites.
  3. Runs `scripts/release-gates.sh`.
  4. Publishes a GitHub **prerelease**, which the `?channel=next` feed serves, then verifies that the live feed exposes the exact DMG sha256 and reverts to draft if not.

  The last stable (non-prerelease) is `v1.6.0`. `v1.7.0`–`v1.9.2` are prereleases. The `1.9.3` release commit exists on main, but **no `v1.9.3` release exists** on GitHub.
- **iOS.** `release-ios.yml` only, which is blocked and has never run. Local iOS builds use a personal team without push (owner memory). No TestFlight build has ever been produced by this repository.

---

## 2. What is real vs placeholder, dead or gated

| Item | Verdict | Evidence |
|---|---|---|
| Digest-bound action receipts (chat/connectors) | **Real** | `action-approval.ts:351-381`, store recompute at `action-approval-store.ts:284,371`; static gate passes |
| ALWAYS_CONFIRM floor (Work) | **Real, but routable around** (§3.2 C2) | `domain.ts:615-780` |
| Native revocation | **Real** | `native-auth.ts:400-411` |
| CSRF, CSP | **Real** | middleware plus live headers |
| Message and field encryption | **Real** | refuses production without keyring |
| Secret encryption keyed off AUTH_SECRET by default | **Real, weaker than documented** | `crypto.ts:78` |
| `src/lib/trust-boundary.ts` (TOOL_SECURITY_REGISTRY, provenance engine) | **Dead** | Only importer is `tests/prompt-injection-defense.test.ts`. Added in `8e852d69` (2026-08-17). |
| `src/lib/auth/enterprise-sso.ts` (OIDC/JWKS) | **Dead** | No importer outside `tests/enterprise-sso.test.ts`. Live sign-in has no SSO. |
| `src/lib/security/dlp.ts` | **Dead** | No importer outside `tests/dlp*.test.ts` |
| `src/lib/capabilities.ts` (SSO "stable", DLP "stable", Drive/M365 "stable", swarm "beta") | **Dead manifest** | No importer anywhere in `src`, `scripts` or `native`. Not the same file as the generated capability contract that `capabilities:check` verifies. |
| `src/lib/agent/swarm.ts`, `src/lib/collaboration/crdt.ts` | **Dead or near-dead** | Same `8e852d69` batch. `crdt.ts` has no non-test importer. `swarm.ts` is imported by `src/lib/research/agents/scheduler.ts`; whether that path is reachable in product is not verified here (the crew audit calls it dead). |
| Ownership guard | **Advisory in production** | `db.ts:277-278` |
| Approval-dispatch static gate | **Real, not wired** | `scripts/check-approval-dispatch.mjs` |
| `security:check` | **Real, not wired** | `package.json:83`. It is in no workflow and not in the Mac deploy. Its 14 test files also run inside `npm test`. Only the **dependency audit** and the **tracked-secret scan** are excluded everywhere. |
| Playwright e2e (`e2e/*.spec.ts`, 476 lines, 7 files) | **Not run anywhere** | No workflow, script or deploy step invokes `playwright test` |
| Migration drift gate | **Real, not running** | only in `deploy.yml` `migrations` job |
| Agent computers | **Built, security-hardened at the container boundary, off in production (UNVERIFIED)** | Production provider value unknown. VM too small (crew audit). Image-name mismatch: `setup-vm.sh:10` builds `juno-computer:1`, `env.ts:172-177` defaults to `juno-agent-computer:1`, and `setup-vm.sh:51` tells the owner to set only `COMPUTER_PROVIDER`. `available()` then reports the image missing (`docker.ts:149-162`). This fails closed. |
| Disk quota for computers | **Displayed only** | `env.agentComputer.diskQuotaMb` is read only into state and serializers (`store.ts:558,574,646`). Nothing enforces it on the named volume. |
| `env.agentComputer.network` / `storageRoot` | **Unused** | `docker.ts:47` hardcodes `juno-computers`. Volumes are Docker named volumes. |
| iOS StoreKit client | **Dead** | `JunoStoreKit.swift` is referenced only by `JunoStoreKitTests.swift` |
| Backups | **Tooling only** | `docs/runbooks/BACKUP_RESTORE.md:98`: "this repository does not claim a restore drill until an operator has exercised them". No schedule. Managed-DB PITR UNVERIFIED. |

---

## 3. Problems

### 3.1 Security correctness

**S1. SSRF through user MCP servers (P0, shipped).** Covered in `connectors-skills.md` P1. The security-specific notes:
- (a) `http://localhost` / `127.0.0.1` are accepted in production (`user-mcp.ts:56`), so any user can make the VM POST JSON-RPC to its own loopback services and read the error text back. The Next app, relay and PM2 services all run there.
- (b) Any https hostname that resolves to RFC1918 or link-local is accepted, with no pinning or rebinding defence.
- (c) The stored URL is not re-validated at use time (`mcp.ts:104-117`).
- (d) OAuth discovery for registry connectors uses bare `fetch` (`mcp-oauth.ts:101`) on URLs from server-returned metadata.
- (e) When folding in the branch's `mcp-safe-fetch.ts`, add one thing it lacks: **drop `Authorization` on a cross-origin redirect.** It re-sends `init.headers` on every hop (`75a62e6a:src/lib/mcp-safe-fetch.ts` `safeMcpFetch`).

**S2. SECURITY.md claims controls the code does not enforce.** Items 2, 6 and 7 of "Enforced Security Controls" (`SECURITY.md:37-48`) point at dead modules. Item 2 also describes "strict input provenance tracking". The shipped mechanism is an injection heuristic plus approval policy. For a paid product this is a disclosure problem, not only a documentation one. The encrypted-columns list also claims completeness ("Exactly these columns") while omitting that `WorkEvent.payload` (`schema.prisma:2707`) is plaintext Json that holds tool output, including `computer_shell` output.

**S3. Secrets keyring defaults to an AUTH_SECRET-derived key in production.** Unlike `message-crypto.ts`, `crypto.ts` has no production refusal. Connector refresh tokens, user MCP `Authorization` headers and agent-computer CDP/VNC secrets all share `AUTH_SECRET`'s fate, derived with a bare SHA-256. Whether `TOKEN_ENCRYPTION_KEYS` is set in production is UNVERIFIED.

**S4. Ownership guard is fail-open and presence-only.** Acceptable as a lint, but it is described as a guard (`db.ts:4-12`). It needs to throw in `test` as well, so CI catches unscoped queries, and to cover `count`/`aggregate`/`groupBy`/`upsert`.

**S5. SSRF classifier drift.** Four IP classifiers exist: `url-safety.ts`, the runner's `blockedFetchAddress`, the relay CIDR check, and the unmerged `mcp-safe-fetch.ts` (which reuses the first). The web one misses `0.0.0.0/8` and the IPv6 transition ranges. The `ip-address` advisory (GHSA-2vr4-cq9g-pvrc, NAT64 local-use `64:ff9b:1::/48`) is the same class of gap in a dependency. `research/crawler.ts` and `research/agents/protocol.ts` check the host string but do not resolve and pin.

**S6. Live dependency advisories.** 10 today (8 high). `next-auth`/`@auth/core` (auth path), `nodemailer` (magic link is enabled in production), `imapflow` (Apple Mail connector), `brace-expansion`, `fast-uri`, `ip-address`, `image-size`/`pptxgenjs` (accepted exception). `scripts/dependency-audit.mjs` hard-codes the accepted set to `image-size`, `pptxgenjs`, so it fails, but nothing runs it.

### 3.2 Crew computers: gaps before calling them production

**C1. The agent's shell bypasses the browser abstraction (P0).** Chromium's DevTools listens on `127.0.0.1:9223` **inside the container with no authentication** (`entrypoint.sh:67`). The token-checking `cdp-gate.py` guards only the external `:9222`. `computer_shell` runs as the same uid 1000 (`computer-tools.ts:329-384`, `docker.ts:488-513`). So a prompt-injected agent can do three things:
- Drive raw CDP (`Runtime.evaluate`, `Network.getAllCookies`), including reading form values the person typed during a takeover.
- Read `~/.chrome/Default/Cookies`. `--password-store=basic` (`entrypoint.sh:71`) uses Chromium's fixed Linux fallback key.
- `curl` anything anywhere. Container egress to the public internet is unrestricted, and the skill `egressDomains` allowlist applies only to the host-side fetch and `browser` tools (`work-runner.ts:1763, 1830, 1902`), not to the container network.

`YOUR_COMPUTER_PROMPT_SECTION` (`store.ts:1063`) tells the person their sign-ins persist and asks them to take over for passwords. That is the exact data this path exposes.

**C2. The ALWAYS_CONFIRM floor is routable around through `computer_shell` (P0).** `computer_shell` is graded `command` (`computer-tools.ts:334`). In Skip (`permissive`) it runs silently. In Auto and Manual, a single "Always allow" covers it for the rest of the run, because `mayBeCoveredByStandingAllowance` admits `command` (`domain.ts:661-664`). A `curl -X POST` that sends mail, publishes or pays is `work.computer.shell`, never `work.connector.send_message`/`publish`/`payment`. The floor is enforced on action labels, and a shell has no labels. The Skip copy ("except for the four things it cannot take back", `domain.ts:554`) then overstates the guarantee. The pixel tools escalate to `work.browser.purchase` only when the DOM says the page takes payment (`computer-tools.ts:101-106`). Typing into the XFCE terminal through `computer_type` has the same property.

**C3. A takeover does not pause the agent.** `openComputerViewSession` (`store.ts:1155-1250`) starts VNC and mints a token. It does not touch the run lease, and nothing in `work-runner.ts` or `src/lib/computer/*` checks for an active control session. While the person types, the agent can keep calling `computer_screenshot` and see visible fields (2FA codes, card numbers outside password inputs), and `computer_type` / `click` can interleave with the person's input. OpenAI's ChatGPT agent documents the opposite behaviour: while you control the browser in takeover mode, screenshots are not captured and your inputs are not seen by the model ([OpenAI Help Center, "ChatGPT agent"](https://help.openai.com/en/articles/11752874-chatgpt-agent); page date UNVERIFIED, WebFetch returned 403, confirmed via search snippet 2026-09-30). Claude in Chrome keeps passwords and one-time codes out of the model's context by handing sign-in to 1Password ([Anthropic support, "Use Claude in Chrome safely"](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely), updated 2026-08-12).

**C4. The handoff link is a reusable control bearer with no audit event.** `mintHandoffCode` (`live-view.ts:64-88`) signs `{agentId, userId, mode, exp=60 s}`. `/computer-view?c=` (`page.tsx:26-60`) accepts it **without a signed-in session**, has no single-use record and no binding to the requesting device, and renders the viewer with the **control** VNC password. Anyone who sees the URL within 60 s gets full control: shared screen, logs, a WKWebView history, a referrer (mitigated by `no-referrer`). The `takeover_started` event is recorded only on the direct POST path (`view/route.ts` `mode === "control"`), not on handoff.

**C5. The internet-facing web process is root-equivalent on the VM.** `setup-vm.sh:17` adds the run user to `docker`. The Next process (`juno-backend`) shells out to `docker` for enable, wake, exec, files and VNC (`src/lib/docker-cli.ts:13,62`). Any RCE in the web app becomes root on the host that holds `.env`, the database URL and every secret. The fix is a narrow broker: a separate unix-socket service, or rootless Docker or Podman, that exposes only the six operations the app needs, keyed by agent id.

**C6. Resource and abuse controls are incomplete.**
- The disk quota is not enforced (§2).
- Egress has no rate or port limits. Outbound SMTP depends on Azure's default block, UNVERIFIED.
- The only per-user limit is `maxAwakeUser = 2` with 60 view requests/hour.
- `--shm-size 1g` and `--memory 2048m` on an ~890 MB host means the feature cannot run without a different host (crew audit).

**C7. Smaller items.**
- The view token is in the URL query, so nginx logs it (`relay/src/computer-view.ts:202`, `nginx.conf.template:24`).
- The VNC password file is readable by the agent (`docker.ts:651-664`). Harmless while VNC is reachable only through the relay.
- Chromium `--no-sandbox` relies on the container, which is acceptable with `cap-drop ALL` plus Docker's default seccomp.
- Downloads auto-save to `/home/agent/work/downloads` with no prompt (`chrome-policies.json`) and are served to the user as `application/octet-stream` attachments. That part is good.

### 3.3 CI and release

**R1. There is no enforced gate between a commit and production.** CI is billing-blocked, `main` is unprotected, PRs are not used, and `deploy-from-mac.sh` has `--skip-checks`. The `.githooks/pre-commit` header says "The full gate … runs in CI on every pull request", which is no longer true. The owner memory records several concurrent sessions pushing and deploying `main`.

**R2. The Mac deploy runs a strict subset of CI.** Missing from `deploy-from-mac.sh` compared with `deploy.yml` plus `native.yml`:
- `prisma validate`
- **migration drift** (`migrate diff --exit-code`)
- the Work-migration and `CONCURRENTLY` greps
- the three DB-backed suites
- the host-serialiser grep
- runner compiled-output check
- every contract, token, parity, wire and register check
- `security:check`, dependency audit, tracked-secret scan
- Playwright

The P2021 outage (`724cd370`) came through this gap.

**R3. Baseline gates are already red on main** (`docs/rework/PROGRESS.md`): `design:tokens:check`, `native:parity:check` (7 unclassified routes), `native:sync:check`, `security:check` (dependency audit). They went red because nothing ran them.

**R4. The Mac update trust chain.** `--publish-dev` ships ad-hoc builds (`release-macos.sh:204`: `IDENTITY="-"` when no Apple Development cert). The comment at `:359-360` says an ad-hoc artifact "can never be published", which contradicts the `--publish-dev` branch. The installed updater's requirement for an ad-hoc running app is `identifier "…"` only (`DesktopUpdater.swift:561-565`). Any ad-hoc bundle with that identifier satisfies it. The feed sha256 is served by the same origin as the asset, and the code says so (`:285-289`). So the integrity of every installed Mac rests on the GitHub account and the server's feed route. There is no update-signing key independent of both, such as Sparkle-style EdDSA. The same ad-hoc signing means each update changes the designated requirement (cdhash). macOS then treats it as a new app for Keychain ACLs (the repository carries `KeychainReSigningRecoveryTests`) and very likely for TCC grants such as Screen Recording and Microphone (UNVERIFIED on this machine).

**R5. The local Mac release test coverage is narrow.** It runs only `JunoVoiceKitTests` (`release-macos.sh:269`), not the JunoCode package tests that cover `CommandClassifier`, the local coding agent's approval gate.

**R6. iOS has no working release path.** The workflow is billing-blocked, never run, and needs ASC secrets (configuration UNVERIFIED). There is no local `release-ios.sh`. The entitlements carry `aps-environment=development` (fine, export rewrites it). The privacy manifest exists (`native/iOS/JunoMobile/Resources/PrivacyInfo.xcprivacy`). Account deletion exists (`JunoMobileSettingsView.swift`). The App Store server verifier is Production-only.

**R7. Cloud Juno Code and model sync depend on GitHub Actions.** `code-runner.yml` is dispatched by `src/lib/cloud-code.ts`, so cloud Code runs cannot start while billing fails. The daily `sync-models` has failed every day.

**R8. Runner image drift ahead.** GitHub annotated every run: "`ubuntu-latest` will migrate to Ubuntu 26 beginning October 19, 2026". Pin `ubuntu-24.04` when CI returns.

### 3.4 Product coherence (security-facing UX)

- **Three approval vocabularies.** They are:
  - chat/connectors: `ActionRiskClass` × 5 policies (`always_ask`…`block`);
  - Work: `WorkRiskLevel` × 3 modes (Manual/Auto/Skip, stored as `conservative/balanced/permissive`);
  - Juno Code: `CommandClassifier` / `ActionRisk` in Swift.

  A person sees different words for the same decision depending on the surface. The dead `trust-boundary.ts` adds a fourth, `TOOL_SECURITY_REGISTRY`. The refoundation should present one ladder and one floor.
- **Security settings parity.**
  - Two-step and device sessions: web and Mac have them (`DesktopSettingsAccountPane.swift`, `NativeAccountSecurityClient.swift`), **iPhone and iPad have none**.
  - Account deletion: web and iOS.
  - Approvals: rendered on all three (57 Mac / 16 iOS / 136 kit files reference approvals).
- **Visual.** Nothing in this area reads as AI-slop. The one hardcoded surface is `computer-view/page.tsx` (`bg-neutral-950 text-neutral-300`), which bypasses tokens. Fine for a full-bleed viewer, but it should use the token for dark surfaces. No status pills or pulsing dots were found in the computer viewer path.

---

## 4. Unmerged branches touching this area

| Branch | Ahead | What it holds for this area | Recommendation |
|---|---|---|---|
| `connectors/custom-mcp` (`75a62e6a`, 2026-09-27) | 1 | `src/lib/mcp-safe-fetch.ts`: https-only, pinned DNS, private ranges refused, per-hop redirect re-validation, streaming. `mcp-oauth.ts` gains a pluggable fetcher. Integration test `tests/integration/custom-mcp.ts`. | **Harvest now:** `mcp-safe-fetch.ts`, the fetcher seam in `mcp-oauth.ts`, the SSRF cases of the integration test. Add cross-origin `Authorization` stripping. Do not merge the parallel `CustomConnector` model (see `connectors-skills.md`). |
| `web/rework-ws2` (2026-09-24, "WIP … paused, unverified") | 19 | `url-safety.ts` rewrite (full `0.0.0.0/8`, IPv6 parse, transition ranges, union with the runner classifier), `pinned-fetch.ts` all-addresses fix, `tests/web-url-guard-drift.test.ts` | **Cherry-pick the SSRF files and the drift test** as one isolated commit. The rest of ws2 is chat-rework WIP and belongs to that phase. |
| `web/rework-ws1` (2026-09-24) | 26 | `action-approval.ts` (+123), `action-approval-store.ts`, `mcp.ts` (+403): one dispatcher and one toolset per turn | Review in the chat phase. It changes approval chokepoints, so re-run `check-approval-dispatch.mjs` on it before merging. |
| `agents/features` (2026-09-27) | 4 | "WIP: agent rooms server side, plus tables for channels and payments". Touches `action-approval.ts`, `db.ts`, `e2e/agents.spec.ts`. | Anything that lets an agent **pay** must sit under `work.connector.payment` / ALWAYS_CONFIRM and never under a `command`-graded tool. Gate the merge on that. |
| `agents/runtime`, `agents/rework` (2026-09-27) | 2–3 | small `action-approval.ts` edits, e2e | Fold in with the Crew phase. Same dispatch-check condition. |
| `artifacts/r1-lifecycle` (2026-09-24) | 1 | `deploy/ecosystem.config.js`, `VM_SETUP_GUIDE.md` | Check the PM2 app list against `EXPECTED_PM2` in `deploy.yml:848` when merging. |
| `origin/codex/native-v3-integration` (2026-07-16) | 14 | old `deploy.yml`, `deploy.sh`, `native-auth*.ts` | **Stale. Do not merge.** Native auth has moved on. |
| `claude/sharp-aryabhata-79fb4b` (preview origin, X-01) | merged | — | Update `docs/security/PREVIEW-ORIGIN-HANDOFF.md` status. |

---

## 5. Recommendations, ordered by leverage

### a) Security guarantees that MUST be preserved through the refoundation

Each of these needs a test that fails if it regresses. Most already have one.

1. Digest-bound, one-time, 15-min action receipts. A changed argument invalidates approval. `src/lib/action-approval.ts`, `src/lib/action-approval-store.ts`, `src/lib/work/digests.ts`.
2. The Work floor: ALWAYS_CONFIRM plus `irreversible`/`sensitive` checked **before** mode and standing allowance, with standing allowances capped at `command` and never covering the list. `src/lib/work/domain.ts:615-780`, runner copy `types.ts:111-138`, `WorkRisk.swift`. Parity test `tests/work-security.test.ts`.
3. Unknown risk is treated as external write. Destructive always asks. Only `reversible_write` may be standing. `action-approval.ts:275-316`.
4. Every tool sink sits behind a policy or receipt call (`scripts/check-approval-dispatch.mjs`).
5. CSRF: cookie mutations require a same-origin `Origin` or `Sec-Fetch-Site`. `src/lib/csrf.ts`, `src/middleware.ts`.
6. CSP nonce plus `strict-dynamic`, and artifact previews on their own policy. `src/lib/csp.ts`, `src/lib/sandbox-policy.ts`.
7. Public-web fetches: host deny, resolve once, refuse any private answer, pin the socket, re-validate each redirect, cap at 10 MB. `src/lib/search/{url-safety,pinned-fetch,fetch-safe}.ts`.
8. Native revocation is effective on the next request (DB check per bearer), with refresh reuse revoking the family and push tokens deactivated on revoke. `src/lib/native-auth.ts`.
9. Messages, reasoning, activity, memory summary, agent notes and scheduled prompts are encrypted under a keyring that production refuses to derive from `AUTH_SECRET`. `src/lib/message-crypto.ts`, `field-crypto.ts`.
10. Sessions are invalidated by `sessionVersion`. Owner accounts require MFA. OAuth is not auto-linked by email.
11. The cloud Work toolset admits no host tool (`work:sandbox:check`), and no Work route uses a host-only serialiser (`deploy.yml` grep plus `release-gates.sh`).
12. Agent computer boundary: `cap-drop ALL`, `no-new-privileges`, read-only rootfs, no ICC, firewall dropping private, metadata and host ranges, CDP only through the token gate, VNC only through the relay's CIDR-checked HMAC token, and path resolution confined to `/home/agent`.
13. Mac updater: an update must satisfy a requirement at least as strong as the running app's signature, re-checked immediately before the swap.
14. App Store transactions and notifications are accepted only through Apple's certificate-chain verifier.

### b) Gaps to fix before calling Crew computers production (in order)

1. **Close the in-container CDP hole.**
   - Bind Chromium DevTools to a unix socket or `--remote-debugging-pipe` owned by a different uid than the agent shell.
   - Or run the shell as uid 1001 with no read access to `/home/agent/.chrome` and no route to `127.0.0.1:9223` (network namespace split, or iptables `owner` match inside the container).

   Files: `deploy/agent-computers/{Dockerfile,entrypoint.sh,cdp-gate.py}`, `src/lib/computer/docker.ts` (`exec --user`).
2. **Put `computer_shell` under the floor.**
   - Grade it `sensitive` by default, so it asks under every mode.
   - Or keep it `command` but add network egress control at the container: default-deny egress through an allowlisting proxy that the skill `egressDomains` drives. Treat any POST or PUT through the proxy to a non-allowlisted host as `work.connector.send_message`.
   - Either way, remove `command` from `mayBeCoveredByStandingAllowance` when `tier === 'shell'` on a computer.

   Files: `runner/agent-core/src/work/computer-tools.ts:329-334`, `src/lib/work/domain.ts:661`, runner `types.ts`, `WorkRisk.swift`, `deploy/agent-computers/firewall.sh`. Fix the Skip copy at `domain.ts:554`.
3. **Make takeover exclusive.** A control session takes the computer lease, or a `takeoverBy` column the runner polls. While it is held, `computer_*` and `browser` refuse with "the person has the computer", and screenshots are not taken or cached. Release on end or heartbeat timeout. Files: `src/lib/computer/store.ts:1017-1250`, `scripts/work-runner.ts:1866-1990`, `src/app/api/agents/[id]/computer/view|heartbeat/route.ts`, `prisma/schema.prisma` (`AgentComputer`).
4. **Make handoff single-use and session-bound.** Store a nonce (`AgentComputerHandoff{id, usedAt, deviceSessionId}`), consume it atomically on first render, require the viewer to be the same user (cookie session, or exchange for one), and record `takeover_started` on this path. Move the relay token from the query string to the WebSocket subprotocol, or set `access_log` to exclude it. Files: `src/lib/computer/live-view.ts`, `src/app/computer-view/page.tsx`, `relay/src/computer-view.ts:202`, `deploy/nginx.conf.template`.
5. **Take Docker away from the web process.** A small broker (unix socket, allowlisted verbs, agent-id labels checked) or rootless Podman, with the app user out of the `docker` group. Files: `src/lib/docker-cli.ts`, `src/lib/computer/docker.ts`, `deploy/agent-computers/setup-vm.sh:17`, `deploy/ecosystem.config.js`.
6. **Configuration truth.** Unify the image name (`setup-vm.sh:10` vs `env.ts:172-177`). Delete unused `network`/`storageRoot`. Enforce the disk quota (XFS project quota, or size-limited volume plus a sweep that stops the computer). Choose a host that can run it (crew audit). Files: `src/lib/env.ts:163-240`, `src/lib/computer/{docker,sweep}.ts`.
7. **Credential handling.** Keep `--password-store=basic` out of reach of the agent (item 1). Consider per-site profile partitions so one compromised task cannot reuse all sign-ins. Encrypt or redact `computer_shell` output in `WorkEvent.payload`.
8. **Tests.** Add adversarial tests:
   - shell cannot reach `:9223` or read `Cookies`;
   - shell under Skip asks;
   - takeover blocks agent input and screenshots;
   - handoff replay fails;
   - relay rejects a token for another agent.

   Add `computer_*` and `user_mcp:` to `check-approval-dispatch.mjs`.

### c) CI gap list for the refoundation's required gates

Principle: CI is billing-blocked and may stay so. Make **one local gate script the source of truth** (`scripts/gate.sh <tier>`). Have `deploy-from-mac.sh`, `release-macos.sh` and CI all call it, remove `--skip-checks` (or require `JUNO_ALLOW_UNGATED=1` plus a logged reason), and refuse to deploy a SHA whose gate record is missing or failed (write `gate-results/<sha>.json` and check it in the deploy preflight).

| Gate | npm script exists | CI (`deploy.yml`/`native.yml`) | Mac web deploy | Mac release | Baseline | Action |
|---|---|---|---|---|---|---|
| Lint | `lint` | yes | yes (skippable) | no | pass | keep |
| Typecheck | `typecheck` | yes | yes (skippable) | no | pass | keep |
| Unit tests | `test` | yes | yes (skippable) | runner only | pass (DB suites skip) | keep |
| Integration / DB suites (`work-store-db`, `work-relay-dispatch`, `research-inspector-db`, route DB tests) | none (inline in yml) | `migrations` job | **no** | no | not run | add `test:db` script with throwaway Postgres (Docker already required by the Mac deploy) |
| `next build` | `build` | yes | yes | no | pending | keep |
| `prisma validate` | none | `migrations` | **no** | no | env-only fail | add `db:validate` with placeholder URLs |
| Migration drift (`migrate diff --exit-code`) | none | `migrations` | **no** | no | not run | **add to the Mac deploy. This is what would have stopped the P2021 outage.** |
| Contract generation (capabilities, Work, shell, native Swift, chat wire) | yes | split across both | capabilities and Work only | `release-gates.sh` checks the version only | pass | one `contracts:check` umbrella |
| Design-token drift | `design:tokens:check` | `native.yml` | **no** | no | **FAIL** | regenerate, then gate |
| Capability drift | `capabilities:check` | yes | yes | no | pass | keep. Delete dead `src/lib/capabilities.ts` so there is one manifest. |
| Native parity (`native:parity:check`, `native:register:check`, `native:sync:check`) | yes | `native.yml` | **no** | no | **FAIL** (7 routes) | classify the routes, then gate |
| Swift package tests (JunoNativeKit, JunoCode, JunoWork) | `native:test` (`scripts/native-test.sh`) | `native.yml` (macos-26) | no | **VoiceKit filter only** | not run | run all three in `release-macos.sh` and the local gate |
| Mac build and unit tests | — | `native.yml` | no | yes (Debug, `JunoDesktopTests`) | not run | keep in the release script. Add a Stable build in the local gate. |
| iOS build and unit tests | — | `native.yml` | no | no | not run | add a local simulator build and test step |
| Security (`security:check`: 14 suites, tracked secrets, dependency audit) | yes | **nowhere** | **no** | no | **FAIL** (deps) | gate. Update the accepted-advisory list with reasons and expiry. |
| Dependency audit | `security:dependencies` | nowhere | no | no | FAIL | same. Add `npm audit` for `runner/agent-core` and `relay`. |
| Approval-dispatch static proof | none | nowhere | no | no | pass | add to `security:check` |
| Sandbox (`work:sandbox:check`, host-serialiser grep) | yes / inline | yes | sandbox only | `release-gates.sh` | pass | move the grep into a script so the Mac deploy runs it |
| Critical Playwright (auth, chat send and stream, approval card, agents) | `test:e2e` | **nowhere** | **no** | no | never run | run the smoke subset against a local production build in the gate. Production smoke already covers sign-in plus one chat reply. |
| Visual fixtures (`native:snapshots:transcript`, `design:fixture`, `/dev/*` galleries) | partial | no | no | no | not run | add offscreen snapshot comparison (owner memory: snapshot tests, not screen control) |
| Branch protection / required checks | — | — | — | — | none | when CI returns, protect `main` with these as required checks, and pin `ubuntu-24.04`. |

### d) Production-readiness table

| Dimension | Web | Mac | iOS / iPadOS |
|---|---|---|---|
| Deployed / distributed | **Live** (`chat.liams.dev`, `1feb392c`, health OK 2026-09-30) | **Prerelease only.** `v1.9.2` ad-hoc on `?channel=next`. Last stable `v1.6.0`. `1.9.3` committed, not released. | **Not distributed.** No TestFlight build has ever been produced. Personal-team local installs only. |
| Signing / notarization | n/a (TLS, HSTS) | **No Developer ID, not notarized.** Gatekeeper may refuse it on a fresh Mac (`release-macos.sh:717`). | No distribution signing path runs. |
| Update integrity | Immutable release dir, checksums, auto-rollback | **Weak.** An ad-hoc requirement is identifier-only. Feed and asset share one trust root. | n/a |
| Release gates actually run | Partial subset from the Mac. Skippable. No drift check. | `release-gates.sh`, VoiceKit tests, Desktop unit tests | none |
| CI | Billing-blocked since 2026-09-22 | Billing-blocked | Billing-blocked, never run |
| Auth | Email/password plus magic link, TOTP, `sessionVersion`. OAuth off in production. | Browser code flow, Keychain, revocable device sessions | Same as Mac |
| Account security UI | Full | Two-step and devices pane | **None** (no two-step or device management) |
| Account deletion | Yes (`DELETE /api/account`) | via web | Yes (`JunoMobileSettingsView.swift`) |
| Billing | Stripe | via web | Server verifier ready. **Client StoreKit dead.** Production-only verifier blocks TestFlight testing. |
| Privacy manifest / entitlements | n/a | `PrivacyInfo.xcprivacy`, unsandboxed by decision (`JunoDesktop.entitlements`) | `PrivacyInfo.xcprivacy`, push entitlement, usage strings present |
| Backups / DR | Scripts only, no schedule, no drill on record | n/a | n/a |
| Known P0/P1 security gaps | User MCP SSRF (S1). SECURITY.md overclaims (S2). Live dependency advisories (S6). | Updater trust (R4) | — |
| Crew computers | Built, off (VM cannot fit), **not production-safe** (C1–C5) | Handoff through web (C4) | Handoff through web (C4) |
| Honest verdict | **Production with caveats.** Close S1, restore an enforced gate (drift plus security), fix SECURITY.md. | **Beta / internal.** Not shippable to strangers until Developer ID and notarization, or an independent update signature. | **Not production.** No release path has ever run. |

### e) Concrete recommendations by leverage

1. **Restore an enforced gate without paying for Actions** (R1, R2, R3). Files: new `scripts/gate.sh`; `deploy/deploy-from-mac.sh` (call it, add `prisma validate` plus `migrate diff` against a throwaway Postgres container, drop or guard `--skip-checks`, pin the host key); `native/Scripts/release-macos.sh` (call it, run all three Swift packages); `.githooks/` (add a `pre-push` for the fast tier); `package.json` (`db:validate`, `db:drift`, `test:db`, `contracts:check`). When CI returns: branch protection with required checks, `ubuntu-24.04` pinned.
2. **Close the user-MCP SSRF** (S1), with the files in `connectors-skills.md` R1 plus the redirect `Authorization` strip. Cherry-pick the `web/rework-ws2` url-safety hardening and drift test at the same time (S5). Files: `src/lib/user-mcp.ts`, `src/lib/mcp-probe.ts`, `src/lib/mcp.ts`, `src/lib/mcp-oauth.ts`, new `src/lib/mcp-safe-fetch.ts`, `src/lib/search/url-safety.ts`, `src/lib/research/crawler.ts`, `src/lib/research/agents/protocol.ts`, `tests/web-url-guard-drift.test.ts`.
3. **Make SECURITY.md true** (S2). Either delete `trust-boundary.ts`, `enterprise-sso.ts`, `security/dlp.ts`, `capabilities.ts` and their tests, or wire them. Deleting is recommended: nothing uses them and they read as shipped. Rewrite "Enforced Security Controls" to name the real enforcement points in §5a. Add `WorkEvent`/`WorkRunIO` to the plaintext list. Fix the stale `docs/security/PREVIEW-ORIGIN-HANDOFF.md` status. Files: `SECURITY.md`, the four modules, `tests/{prompt-injection-defense,enterprise-sso,dlp,dlp-policy,capabilities-registry,swarm-and-crdt,crdt-convergence,multi-agent-orchestration}.test.ts` (verify each before deleting).
4. **Fix the dependency advisories and gate them** (S6). `next-auth`/`@auth/*`, `nodemailer`, `imapflow`, `brace-expansion`, `fast-uri`, `ip-address`. Record accepted exceptions with an expiry in `scripts/dependency-audit.mjs`. Put `security:check` plus `check-approval-dispatch.mjs` in the gate.
5. **Crew computer hardening, in the §5b order**, before the feature is enabled anywhere. This is a prerequisite for the Crew phase, not a follow-up.
6. **One approval ladder** (§3.4). A single vocabulary for chat, Work, Code and computers (read, change, run, reach-out, cannot-undo), with one floor list. The three existing implementations map to it. Files: `src/lib/action-approval.ts`, `src/lib/work/domain.ts`, `runner/agent-core/src/work/types.ts`, `native/Packages/JunoWork/Sources/JunoWorkCore/WorkRisk.swift`, `JunoCodeCore/CommandClassifier.swift`, approval card components.
7. **Secrets keyring production guard** (S3). Refuse production when `TOKEN_ENCRYPTION_PRIMARY` is `auth` or unset. Rotate with `npm run crypto:rotate`. Files: `src/lib/crypto.ts`, `src/lib/env.ts`, runbook.
8. **Mac update trust** (R4). Short term: add an update signature independent of GitHub and the web server. An EdDSA signature over the DMG, with the public key compiled into the app and checked in `DesktopUpdater.verify` in addition to codesign, closes the identifier-only hole for ad-hoc installs. Long term: Developer ID plus notarization, the `--publish` path that already exists. Fix the contradictory comment at `release-macos.sh:359-360`. Files: `native/macOS/JunoDesktop/App/DesktopUpdater.swift`, `native/Packages/JunoNativeKit/Sources/JunoCore/JunoUpdateFeed.swift`, `native/Scripts/release-macos.sh`, the feed route under `src/app/api/downloads`.
9. **Ownership guard strictness** (S4). Throw in `test` too, and cover the remaining operations. Audit the 156 `prismaUnguarded` call sites once. File: `src/lib/db.ts`.
10. **iOS release path** (R6). A local `native/Scripts/release-ios.sh` mirroring `release-ios.yml`. Decide StoreKit (wire it or delete it). Allow the Sandbox verifier for TestFlight. Add two-step and device sessions to iPhone and iPad settings for parity. Files: `native/Scripts/`, `native/iOS/JunoMobile/App/JunoMobileSettingsView.swift`, `src/lib/billing/app-store.ts`.
11. **Decouple cloud Code from Actions billing** (R7), or show its unavailability honestly in the product. Files: `src/lib/cloud-code.ts`, `.github/workflows/code-runner.yml`.
12. **Backups.** Schedule `backup:production` plus `backup:verify`, and run `restore-drill.mjs` once with RPO/RTO recorded. Files: `scripts/backup-production.mjs`, `docs/runbooks/BACKUP_RESTORE.md`.

---

### Sources (external)
- OpenAI Help Center, "ChatGPT agent": https://help.openai.com/en/articles/11752874-chatgpt-agent. Takeover mode: screenshots are not captured while you control the browser. Accessed via search on 2026-09-30. Direct fetch returned 403, so the page date is UNVERIFIED.
- Anthropic Support, "Use Claude in Chrome safely": https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely. Updated 2026-08-12. Covers site permissions, action risk checks, and 1Password keeping credentials out of context.
