# Security and permissions vertical

2026-10-04 · branch `rework/permissions` · BRIEF §6 (one permission model), §7 (Alevr Secrets), §17 (retrieval security), §31 (Computer Use audit), §50–51 (blockers).

This records local, tested work. It does not claim production acceptance. Maturity is tracked in `src/lib/capabilities.ts` under `action_permissions`, `credential_broker` and `computer_cloud`.

## 1. One permission model (§6)

### Decision

There is no new engine. Each runtime still makes its own allow/ask/deny decision. They can't share one function: the native names are written on stored rows, advertised by Macs, hashed into approvals and decoded by clients. What changed is that every runtime is now projected onto one shared taxonomy, and every place that can create a standing grant checks the same floors. A single contract pins the projection, and tests in every language read it. `src/lib/action-approval.ts` stays the authority and re-exports the model from the dependency-free `src/lib/permissions/taxonomy.ts`. That module is separate because Work's domain and client components import it, and they cannot pull in `node:crypto`.

### The model (`contracts/permissions/permission-taxonomy.v1.json`)

**Tiers:**
- `safe_read`
- `reversible_write`
- `external_action`
- `destructive_sensitive`

**Grants and labels (`PERMISSION_GRANT_LABEL`):**

| Grant | Label |
|---|---|
| `block` | Block |
| `ask_every_time` | Ask every time |
| `allow_once` | Allow once |
| `allow_for_task` | Allow for this task |
| `allow_for_site` | Allow for this site or app |
| `always_allow` | Always allow |

**Ceilings (the widest standing grant each tier may hold):**

| Tier | Widest standing grant |
|---|---|
| `safe_read` | Always allow |
| `reversible_write` | Always allow |
| `external_action` | Allow for this task |
| `destructive_sensitive` | Allow once |

**Hard-floor categories:** `destructive`, `sensitive`, `financial`, `credential`, `account_security`. An action whose name falls in one of these is pinned to Allow once, whatever its tier. Detection is a deterministic token list kept in the contract. It is deliberately broad: a false positive costs one extra question.

**Projection of native risk names (`RUNTIME_RISK_TIERS`):**

| Runtime | safe_read | reversible_write | external_action | destructive_sensitive |
|---|---|---|---|---|
| Connector/MCP broker (`ActionRiskClass`) | read_only | reversible_write | external_write, unknown | destructive_or_sensitive |
| Tool registry (`ToolRisk`) | read | write | external | destructive |
| Work and Orbit tasks (`WorkRiskLevel`) | safe | edit | command | sensitive, irreversible |
| Code cloud runner (`RiskLevel`) | safe | edit | command | sensitive |
| Code on the Mac (`ActionRisk`) | read | write | execute, critical | destructive |

Any name not in the table maps to `external_action`.

**Stored answers (`RUNTIME_DECISION_GRANTS`):**

| Runtime | Stored answer | Means |
|---|---|---|
| Connector | `allow_scope` | Always allow |
| Work | `allowed_always` | Allow for this task |
| Code | `allow_always` | Allow for this task |
| Secrets | a grant | Allow for this task, for *access* to one login |

A Secrets grant only covers access. Every fill is still a sensitive action that asks each time.

### Dispatch-boundary inventory

| Boundary | Decision point | Native vocabulary | Notes |
|---|---|---|---|
| Chat: Alevr's own tools | `src/lib/tools/dispatch.ts` → `authorizeExternalAction` | ToolRisk → ActionRiskClass | Every model-authored call is marked `derivedFromUntrusted: true`. |
| Connectors and custom MCP | `src/lib/mcp.ts openMcpToolset` → broker | ActionRiskClass; annotations are evidence only | Standing grant now also gated by `mayAllowScope` (hard floors). |
| Agent setup changes, routines, handoffs, tasks | `juno_agents:*`, `juno_work:*` exact rules | external_write | Asks under every policy short of Block; never standing. Tested. |
| Work runs and Orbit agent tasks | `runner/agent-core/src/work/session.ts` (`approvalAsksUnder`); Mac `WorkApprovalCoordinator` | WorkRiskLevel × policy | "Always" now gated by `mayHoldStandingAllowance` (web domain, runner, Mac adapter). |
| Routines (unattended) | `WORK_UNATTENDED_POLICIES`, `WorkRisk.unattendedRuling` | pause / skip / disallow | No auto-approve exists. |
| Code (cloud) | `permissions.ts ladderRuling/permissionRuling`; `cloud-code-runner.mjs` | plan / ask / auto-edit / full | **Fixed:** under Full access the unattended runner auto-allowed sensitive actions such as force-push or `curl \| sh`. It now refuses them (`unattendedApprovalAnswer`). |
| Code (Mac) | `PermissionCoordinator` | read … destructive | Covered by the existing rule fixture. Destructive asks in every mode. |
| Computer and browser (Work tools) | `computer-tools.ts`, `tools.ts browserTool` | WorkRiskLevel | Shell, type and text keys are sensitive. **Changed:** Return, Enter and Space are no longer "navigation". New `fill_credential` action is sensitive. |
| Native screen control | `JunoScreenControl` `ConsequentialActionFloor`, `AppGrant` | view / click / full + `FloorReason` | `always` scope is never offered. Not projected (no shared risk names). |
| Voice | `relay/src/providers/gemini-live.ts` | — | Only `ask_backend_model` is accepted. The task tool is off for voice. There is no action boundary to gate. |

### Changes

- `mayAllowScope` (connector standing grants) is checked in three places: when the card offers it (`canAllowScope`), when the answer is recorded (`decideActionApproval`), and when a grant is looked up (`findStandingGrant`). A reversible tool named for paying, deleting, credentials or account changes, such as `archive_order`, can no longer become Always allow.
- `mayBeCoveredByStandingAllowance` (web), `mayHoldStandingAllowance` (agent-core runner) and `WorkRisk.mayHoldStandingAllowance` (Swift, used by `DesktopWorkExecutorAdapter`) all apply the shared floor.
- `mayGrantAlways` (Code runner) is extracted. Sensitive is never Allow for this task.
- The approval cards use the shared labels for standing answers.

### Proving the model cannot grant itself permission

`tests/permission-conformance.test.ts` covers four attack routes:
- **Arguments:** argument keys such as `approved`, `decision`, `permission`, `policy` or `receiptDigest` can never lower a classification.
- **Metadata:** a read-only hint cannot downgrade a delete, send, transfer or password reset.
- **Hostile-page targets:** routines, agents, autonomy, apps and handoffs ask under every policy and are never standing.
- **Reaching grant code:** a structural scan shows that the code which records decisions or mints grants is imported only by signed-in routes: `decideActionApproval`, `workApproval.update*`, `actionApprovalGrant.*` writes, `createSecretGrant` and `secretGrant.*` writes. No model tool is named for approving or granting.

Web content is also wrapped in the untrusted envelope and marks the turn's taint (§4 below).

## 2. Alevr Secrets: the credential broker (§7)

### Design

- **Storage:** `SecretCredential` (label, host patterns, optional username, sealed value, version, revoked/rotated/last used). The value is sealed with `encryptSecretBound` (AES-256-GCM on the existing key ring, with AAD `alevr.secret.v1:<userId>:<credentialId>`). A ciphertext copied into another account's row, or another credential's row, does not decrypt.
- **Grants:** `SecretGrant` binds one credential to one task (`work:<sessionId>`), with:
  - host patterns that must be a subset of the credential's,
  - scopes `fill:username` and `fill:secret`,
  - the credential version (rotation invalidates the grant),
  - an expiry (default 8 h, maximum 24 h),
  - a use budget (default 10, maximum 50),
  - revocation.

  Grants are minted only by `POST /api/secrets/grants`: a signed-in person, for one of their own tasks.
- **References:** the model sees `asec_<grantId>.<HMAC>` in its own domain. The reference carries no secret and no host. A forged or spliced reference is refused.
- **Redemption:** `redeemSecretGrant` is the only path to plaintext. In one transaction it:
  1. re-checks the grant: account, task, revoked, credential revoked, expiry, rotation, https-only host match against both the grant and the credential, scope, and for `fill:secret` that the trusted executor read the field as a real password field;
  2. spends one use with a conditional update, so concurrent replay cannot double-spend.

  Every attempt, granted or refused, writes a `SecretAccessEvent`: host, scope, outcome, reason and run reference. No value, hash or reference is stored.
- **The boundary vertical (Work browser):**
  - `browser` gains `credentials`, a safe action that lists references, labels and sites, and `fill_credential`, which is sensitive and asks every time under every mode.
  - The runner (`scripts/work-runner.ts` + `src/lib/secrets/browser-fill.ts`) reads the page's real URL and the field's DOM type, redeems, fills, and then scrubs the filled value from every later page, error and title the run returns.
  - The browser refuses to `type` into password or one-time-code fields, so a model-known password is never typed.
  - Snapshots strip `value` from password, hidden, one-time-code and card inputs.
- **Rotation:** `PATCH /api/secrets/:id` re-seals the value and bumps the version. `npm run crypto:rotate` re-seals saved logins under a new primary key, keeping their binding.
- **Revocation:** removing a login overwrites the ciphertext and revokes every grant. Grants can be taken back individually.
- **UI:** Permissions → *Saved logins*. Save a login; let a task use it ("Allow for this task"); take it back; replace the password; remove it; and *Every use* (the access log, in mono annotation text). Values are never returned by the API, so the page cannot show them. The gallery is at `/dev/permissions?state=full|empty|error`. Screenshots are in `docs/rework/program/evidence/permissions/`.

### Persistent browser profiles

Logins typed by a person during a takeover stay in the agent computer's Chromium profile. They are not a broker credential:
- The model never receives them through Alevr. Snapshots now strip secret input values.
- They are destroyed with the computer, including on account deletion (below).
- Per-site restriction of that profile's cookies needs the real host. See the blockers.

## 3. Computer Use audit (§31)

This is a fresh read of `src/lib/computer/*`, the Work computer and browser tools, the runner wiring, `deploy/agent-computers/*`, and native `ComputerUseCoordinator` / `JunoScreenControl`.

### Already enforced

- **Takeover:**
  - Takeover is a 60 s window extended by heartbeats.
  - Every computer and browser tool refuses before and after it runs. The fixed `TAKEOVER_REFUSAL` is returned.
  - Hand back sends a fixed answer, rotates the VNC passwords and is recorded.
  - App links are single-use and session-bound.
- **Sandbox:**
  - `--cap-drop ALL`, `no-new-privileges`, read-only root and tmpfs.
  - Memory equals swap; CPU and pid limits.
  - Agent and browser run as separate uids (1000 and 1001).
  - 300 s exec limit with kill-after.
  - Writes are confined to `/home/agent/work`, with no dotfiles.
  - One container and volumes per agent, ICC off.
  - Private and metadata addresses are refused at the proxy and the firewall.
- **Secrets and approvals:**
  - CDP/VNC secrets are encrypted at rest, and the CDP token is passed over stdin.
  - Shell, typing and text keys are sensitive and ask every time.
  - A payment page makes clicks, keys and submits `work.browser.purchase`, which is irreversible.
- **Native:** secure fields are refused, finance apps are excluded from capture, generation checkpoints run after every await, and the always-allow scope is never offered.

### Fixed here (each with tests)

| Gap | Fix | Test |
|---|---|---|
| Any signed-in tab or device could hand back someone else's control | `takeoverReleasableBy`: only the holder releases | `tests/computer-takeover-hardening.test.ts` |
| A takeover that started and ended inside one call (e.g. `sleep 60; scrot`) was invisible | `takeoverEpoch` column (migration `20261004121000`). Computer tools (`takeoverEpoch` dep) and the browser guard (`computerTakeoverFence`) discard the result if the epoch moved. | same file, plus `agent-computer-takeover` |
| A password typed during a takeover could reach the model via a `value` label or HTML | `redactSecretInputs` and label exclusion in `snapshotPage`; the browser refuses `type` into secret fields | same file |
| `computer_key Return/Enter/Space` pressed submit buttons as mere "navigation" | removed from `NAVIGATION_KEYS`, so these keys are now sensitive and ask every time | same file |
| The remote browser enforced site policy only on `open` | the agent's own clicks and submits are route-filtered by the run's site policy; the person is never filtered | same file (`agentNavigationVerdict`) |
| Account deletion left containers and volumes (with browser sign-ins) and posters | `deleteAccountPermanently` destroys each computer first; failures are counted, never blocking | `tests/account-delete-deliverables.test.ts` |
| Unattended cloud Code auto-allowed sensitive actions under Full access | `unattendedApprovalAnswer` | `runner/agent-core/src/test/permission-conformance.test.ts` |

### Remaining gaps (need the real host, or are larger than this pass)

- **In-flight cancellation and process freeze.** Nothing kills an in-flight `xdotool` or shell when a takeover starts, and detached uid-1000 processes keep running. Proposed: `provider.freezeAgent` / `thawAgent` (`pkill -STOP/-CONT -u 1000`, kill xdotool) on control open, hand back and lapse. This needs broker argv acceptance on the docker host. Today the epoch fence discards the *result*, but the side effect still happens.
- **Takeover lapse.**
  - The web viewer stops heartbeating in a hidden tab, and heartbeats are limited to 10 per minute per user, so a lapse can return control while the person is still typing.
  - A lapse does not rotate VNC or record `takeover_lapsed`.
  - Proposed: per-agent limits, hidden-tab control beats, and a sweep that closes lapsed windows.
- **Xvfb runs with `-ac`.** Any uid-1000 process can read the display. Verifying and hardening this needs the image.
- **Network.** DNS to 1.1.1.1 and 9.9.9.9 is open (tunnelling); the proxy allows any public host on ports 80 and 443. Needs a real proxy and firewall.
- **Pixel clicks on submit controls.** These are still `command` unless the page takes payment. An `elementFromPoint` check through `withPage` is the next step.
- **Cleanup.** No orphan reconciliation (`listOwned` is never called), no volume size limit, no `ulimit nofile`.
- **Audit log.** The holder at hand back, lapses, and wake/sleep are not logged. The native journal is in memory only.
- **Dead code.** `src/lib/agent/computer.ts` still reports success without dispatching. It stays unregistered, and registering it would be a security regression.

## 4. Retrieval security (§17)

Confirmed in source: `src/lib/search/{fetch-safe,pinned-fetch,url-safety}.ts`, `src/lib/web/{extract,fetch-page,untrusted-rule.prompt,taint}.ts`, `src/lib/untrusted-content.ts`.

- **SSRF guard on every hop.** Private, metadata, loopback and alternative IP spellings are refused, as are non-http schemes and credentials in the URL.
- **Pinned DNS.** The validated answer is pinned to the socket, so there is no rebinding window. Any private answer in the set refuses the whole fetch.
- **Redirect limit.** At most 5 redirects.
- **Byte caps.** Enforced both by the declared length and while streaming.
- **No decompression.** `Accept-Encoding: identity` is forced, and a hostile gzip body is never inflated.
- **MIME refusal.** Binary types are refused.
- **Untrusted content.**
  - Web text is wrapped in a defanged envelope.
  - The system rule tells the model that pages may carry hostile instructions and must never grant, send, publish or delete.
  - A hostile verdict taints the turn, and a tainted turn writes no durable memory.

New: `tests/retrieval-security.test.ts` pins the following:
- metadata endpoints under every spelling;
- scheme redirects (file, gopher, data, javascript);
- redirect cycles;
- URL credentials;
- the uninflated decompression bomb, including a caller trying to re-enable gzip;
- binary MIME refusal;
- a hostile page with a fake closing marker arriving inside exactly one envelope, with the turn tainted.

What a page can never do is covered by the permission conformance suite: alter permissions, start a routine or agent, or grant access.

## Tests

| Command | Result |
|---|---|
| `npx tsx --test tests/permission-conformance.test.ts tests/secrets-broker.test.ts tests/secrets-browser-fill.test.ts tests/secrets-crypto.test.ts tests/computer-takeover-hardening.test.ts tests/retrieval-security.test.ts` | pass |
| `SECRETS_TEST_DATABASE_URL=<local throwaway> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/secrets-broker.integration.test.ts` | 2/2 pass. Real Postgres, real routes, real guarded client. |
| The new suites plus every existing suite touched, in one run: action-approval*, app-approval-preview, approval-grants-route, work-approval-*, work-security, work-browser, prompt-injection-defense, tool-registry, cloud-runner-*, unified-agent-runtime, agent-computer*, agents-computer-handback, web-transport, web-extract, untrusted-content, ownership-guard*, field-crypto, mcp-ssrf, search-ssrf, computer-broker-argv, capabilities-registry | 359 tests: 347 pass, 0 fail, 12 skipped (environment-gated) |
| `NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/account-delete-deliverables.test.ts` | 7/7 pass. It was 0/6 at baseline because of a stale mock; the mock is fixed. |
| `cd runner/agent-core && node --test dist/test/*.test.js` | 241 pass |
| `cd native/Packages/JunoWork && swift test --filter "PermissionConformanceTests\|WorkRiskTests"` | 17 pass |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | clean |
| `npm run capabilities:check` | pass |

## Security considerations

- **Values never echoed.** The plaintext exists only inside `redeemSecretGrant`'s caller, for the duration of one `fill`. It is never logged, returned, persisted or hashed.
- **Account scoping is layered:**
  - every query is user-scoped;
  - the ownership guard map covers the three new tables;
  - AAD binding protects against DB-level row swaps;
  - a MAC on references prevents forging or splicing.
- **Every model call is treated as untrusted.** All model-authored calls are already marked `derivedFromUntrusted`, so provenance does not gate standing grants. The ceilings and hard floors do. This keeps standing grants to reversible writes only, as before.
- **Known limit: the screenshot channel.** A username filled into a text field is visible in pixel screenshots of the agent's computer. Passwords render masked in password fields, which `fill:secret` requires.

## Remaining blockers

- **Infrastructure:** every item in §3's "remaining gaps" list needs the real docker host and relay. Also: a real-site authenticated fill in a deployed Work run, and production `TOKEN_ENCRYPTION_KEYS` / `PRIMARY` plus the two migrations deployed.
- **Native:**
  - The Mac app target (`DesktopWorkExecutorAdapter.swift`) was edited but not rebuilt here. Only the `JunoWork` package tests ran.
  - Saved logins have no native UI.
  - Native Code (`PermissionModel.swift`) is covered by the existing rule fixture, not yet by the new taxonomy test.
- **Out of scope here:**
  - Work `allowed_always` allowances on the Mac are risk-scoped (`WorkAlwaysAllowance(upTo:)`), not action-scoped, so one "always" covers every action up to `command`. Narrowing it is a native data-model change.
  - `decideUnattendedAction` is enforced natively only.
- **Owner actions (§50–51):**
  - Agent purchases and payment cards stay deprioritised until computer acceptance and the remaining gaps above are closed. This pass adds no payment capability.
  - Not resolved by code: provider data-use terms for screenshots of logged-in pages; the retention policy for `SecretAccessEvent` (no pruning yet; choose a period); disclosures that saved logins exist and how they are sealed.
- **Unrelated worktree issue:** an accidental `git stash pop` (stashes are shared across worktrees) briefly applied the shared stash `stash@{0}` from `rework/refoundation` here. The worktree was reset to HEAD and the stash entry is intact. One untracked file it restored, `src/components/library/library-nav.tsx` (identical to the stash copy), is still in this worktree. It is not committed; delete it at will.

## Next milestone

1. Add `freezeAgent` / `thawAgent` on the docker provider with broker argv tests, and close lapsed takeovers in the sweep.
2. Let a person grant a login from the task composer as well as from Permissions, and add native parity for Saved logins.
3. Run a real authenticated fill end to end on a staging host, and record the receipt in the capability registry.
4. Add an `elementFromPoint` submit check for pixel clicks, and add DNS and proxy egress policy.

## Competitor note

- **Claude Code** documents deny-before-ask-before-allow rules enforced by the runtime, with prompt-generated rules that cover only what was approved. Alevr follows the same principle across more surfaces, with a shared contract and hard floors that no rule can widen. [code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions)
- **The MCP tools specification** treats tool annotations as hints, not security guarantees. The broker classifies independently, and the conformance cases prove a read-only hint cannot downgrade a delete. [modelcontextprotocol.io/specification/2025-11-25/server/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
