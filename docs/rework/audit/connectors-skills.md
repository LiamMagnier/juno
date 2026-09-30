# Audit: Connectors, MCP, Composio, Skills and packaging

Phase 0, read-only. Written 2026-09-30 against `rework/refoundation` @ `1feb392c` (same tree as `main`).
Scope: server, web, Mac, iPhone/iPad, Juno Code. Parallel work was inspected read-only in `../juno-custom-mcp`
(branch `connectors/custom-mcp`) and `../juno-skills` (branch `skills/import-anywhere`, uncommitted).

Conventions: `path:line` refers to this worktree unless another tree is named. Every claim is taken from the code
unless it is marked **UNVERIFIED**, which means nothing was run and it depends on runtime state or production
configuration that this phase could not see. Competitor claims cite URLs with their dates.

---

## 1. Map

### 1.1 Concepts and where they live

| Concept | Storage | Id shape | Notes |
|---|---|---|---|
| Built-in connector (GitHub, Figma, Notion, Apple Calendar/Mail/Music) | `Connection` (`prisma/schema.prisma:186`) with encrypted `accessToken`/`refreshToken`/`oauthClientSecret` | `github`, `notion`, … (closed union `ConnectorId`, `src/lib/connectors.ts:31`) | Three kinds: `oauth_app`, `mcp_oauth` (DCR + PKCE), `credentials` (served by Juno's own `/api/mcp/[connector]`) |
| Composio app | `Connection` row, provider `composio:<slug>`, `scope` used as a state machine (`composio:active/pending/starting:*`) | `composio:gmail` | Plus one internal `__composio_directory` row per user (`src/lib/composio.ts:12,384`) |
| User MCP server (on main, shipped) | `UserMcpServer` (`schema.prisma:227`): URL, optional encrypted `Authorization` header, `enabled`, `status`, cached `tools` | `user_mcp:<cuid>` (`src/lib/user-mcp.ts:22`) | Added in `30ff9a79`, extended in `81bf66c5`, migration `724cd370` |
| Custom connector (branch only) | `CustomConnector` + tokens in `Connection` under `mcp:<10>` | `mcp:<slug>` | `connectors/custom-mcp` @ `75a62e6a`, **not merged**, and it competes with `UserMcpServer` |
| Per-conversation attachment | `Conversation.activeConnectors String[]` (`schema.prisma:592`) | any of the above | Max 5 per turn, enforced client-side (`src/lib/connector-intent.ts:7`) and server-side (`src/lib/chat/request.ts:125`) |
| Account block list, policy, lockdown | `Settings.blockedConnectors`, `actionApprovalPolicy`, `lockdownMode` (`schema.prisma:502`) | — | Written by `src/app/api/settings/route.ts:63,178` |
| Approval receipt | `ActionApprovalReceipt` (`schema.prisma:2319`) | — | One-time, digest-bound, atomically consumed |
| Standing grant | `ActionApprovalGrant` (`schema.prisma:2385`) | — | Reversible writes only; has `revokedAt`, but nothing in the product can revoke one (§3.1 P2) |
| Audit row | `ToolInvocation` (`schema.prisma:2269`) | — | Written for every routed call |
| Work task grant | `WorkSessionConnector` (`schema.prisma:2548`) | — | Connectors lent to one Work session |
| Agent | `Agent.connectorIds` (`schema.prisma:3834`) | — | Agents carry connectors but no skills |
| Skill | `WorkSkill` / `WorkSkillVersion` / `WorkSkillSource` (`schema.prisma:3014,3105,3074`) | slug per user | `trust` (untrusted/user_authored/verified), `securityStatus`, `autoSelect`, `kind` (`skill`/`assistant`), versioned contract with provenance |
| Assistant | `WorkSkill` with `kind: "assistant"` (`src/lib/assistants.ts:1-12`) | — | Shares the skill table |
| Juno Code local MCP / skills | `.mcp.json` / `.juno/mcp.json` (`native/Packages/JunoCode/Sources/JunoCodeRuntime/MCP/MCPServerConfiguration.swift:131-135`); `.claude/skills` / `.juno/skills` (`JunoCodeLocal/Extensibility/SkillActivation.swift:1-8`) | — | A separate stack. It never reads the account's connectors or skills |

### 1.2 Server modules

| File | Role |
|---|---|
| `src/lib/connectors.ts` | Registry of 6 built-in connectors, OAuth URL building, code exchange, refresh |
| `src/lib/mcp-oauth.ts` | MCP OAuth discovery (protected-resource metadata, AS metadata), DCR (`registerClient`), PKCE, exchange, refresh. DCR only |
| `src/lib/mcp.ts` | `getActiveConnectors` (ids → endpoints and headers, token refresh) and `openMcpToolset` (connect, list tools, namespace `<id>__<tool>`, execute through audit → broker → `callTool` → untrusted envelope) |
| `src/lib/user-mcp.ts`, `src/lib/mcp-probe.ts`, `src/lib/mcp-server-input.ts` | User MCP URL check, header sealing, probe (connect + listTools), DTO |
| `src/lib/composio.ts` (1059 lines) | Composio client, catalog (REST, sorted by usage), categories, connect/complete/disconnect with a lease-based claim machine, execution sessions |
| `src/app/api/mcp/composio/[slug]/route.ts` | Proxies MCP traffic to the Composio session URL, authenticated by a Juno HMAC token |
| `src/app/api/mcp/[connector]/route.ts` | Juno's own MCP server for the Apple connectors |
| `src/lib/connector-token.ts` | 15-minute HMAC bearer tokens for Juno-served MCP routes |
| `src/lib/tool-access.ts` | Coarse read/write/unknown classification (hints, then verb heuristic) |
| `src/lib/action-approval.ts` | Pure policy: 5 risk classes, 5 policies, exact Juno rules, receipt digests, previews, redaction |
| `src/lib/action-approval-store.ts` | Broker: resolve policy, find grant, create or recover receipt, wait (poll every 400 ms, `:31`), re-check policy and args, atomic spend |
| `src/lib/tool-audit.ts` | `ToolInvocation` rows |
| `src/lib/crypto.ts` | AES-256-GCM with key ids and rotation (`scripts/rotate-encryption-keys.ts`) |
| `src/lib/connector-intent.ts` | Auto-attach a connected app when the prompt names it |
| `src/lib/work/connectors.ts` | Work's connector inventory with verdicts, and the admission gate |
| `src/lib/skills/{skill-md,github,sources,store,library-contract}.ts` | SKILL.md parser and serializer, GitHub repository import, source update checks, the single create path, library wire shape |
| `src/lib/work/skills.ts` (1923 lines), `src/lib/work/skill-security.ts` | Trust, slug, contract, grant intersection (`narrowestGrant`, `resolveSkillPermissions`), version selection, security scan, permission fingerprint |
| `src/lib/chat/skills.ts`, `src/lib/chat/skill-runtime.ts` | The chat adapter: one grant layer per turn, tool narrowing, envelope, `skill_applied` audit |
| `src/lib/connectors/google-drive.ts`, `microsoft-365.ts` | **Dead** (§2) |

### 1.3 Routes

- Connectors: `GET /api/connectors` (registry + connected Composio apps + user MCP rows, `src/app/api/connectors/route.ts`); `/api/connectors/[id]/{connect,callback,credentials}`, `DELETE /api/connectors/[id]`; Composio: `/api/connectors/composio/{catalog,[slug],[slug]/connect,[slug]/callback}`; Apple Music dev token.
- User MCP: `/api/mcp/servers` (GET/POST), `/api/mcp/servers/test` (draft probe), `/api/mcp/servers/[id]` (PATCH/DELETE), `/api/mcp/servers/[id]/test`.
- MCP endpoints Juno serves: `/api/mcp/[connector]` (Apple), `/api/mcp/composio/[slug]` (proxy).
- Approvals: `/api/approvals`, `/api/approvals/[id]`.
- Skills: `GET /api/skills` (library with sources), `/api/skills/import/github` (preview, then import by paths), `/api/skills/import/file` (SKILL.md preview; used only by the Mac, `NativeSkillsClient.swift:152`), `/api/skills/sources/[id]{,/check,/update}`, and `/api/work/skills/**` (CRUD, versions, consent).

### 1.4 Web UI

- `/connections` (`src/app/(app)/connections/page.tsx`): one directory (`src/components/connections/connector-directory.tsx`) that merges built-ins, the Composio catalog (categories, paging) and user MCP rows. Tiles split into Connected and Available. `AddMcpServerDialog` (name, URL, Authorization header, Test). `CredentialsDialog` for the Apple connectors.
- Settings › Connectors (`src/components/settings/sections/connectors.tsx`): per-app switch backed by `blockedConnectors`, the 5-option policy, and Lockdown.
- `/permissions` (`src/app/(app)/permissions/page.tsx`): Work approval modes and Mac hosts. It does not mention the connector policy.
- Composer (`src/components/chat/composer.tsx`): a `+` menu connector flyout, an `@` palette with a Connectors group (`:282-324`, `:1791-1821`), inline `@GitHub` mentions drawn with the brand mark (`:345-396`, `:2405-2432`), and auto-attach from prompt text (`:1363-1380`). Skills can be armed with `/slug` or from the skills panel (`src/components/skills/composer-skills-panel.tsx`). One skill per message.
- `/skills`, `/skills/new` (write or import a SKILL.md file), `/skills/import` (GitHub), `/skills/[id]` (detail, versions, consent, copy/download SKILL.md).
- Approval card: `src/components/chat/approval-card.tsx`.

### 1.5 Native

- **Mac**: `DesktopConnectionsScreen.swift` (1074 lines: grid, categories, Add/Manage MCP server sheet, "Use in chats" toggle for user MCP), `DesktopSettingsConnectorsPane.swift` (mirrors Settings › Connectors, with its copy duplicated by hand at `:13-20`), `DesktopSkillsScreen/SkillPage/SkillSheets.swift` (full library, GitHub import, file import, versions, consent), composer `+` menu connectors and skill arming (`ComposerPlusMenu.swift`, `NativeConversationStore.swift:2166-2184`), `ApprovalCard.swift`. There is no inline `@` mention.
- **iPhone**: `JunoMobileConnectionsView.swift` (list, Connect through a web flow, Disconnect) and a composer connector submenu capped at 5 (`JunoMobileAttachmentMenu.swift:238-291`). **No skills** anywhere in `native/iOS`. No connector policy settings. No user MCP management.
- **iPad**: the same binary (`TARGETED_DEVICE_FAMILY = 1,2`). It reuses the iPhone Connections view (`JunoMobileRootView.swift:1422`) and has no iPad-specific layout for this area.
- **Juno Code** (Mac local agent): its own MCP client (stdio + HTTP) and its own SKILL.md discovery. It has no bridge to account connectors or `WorkSkill`.

### 1.6 Flows

1. **Link.** A tile's Connect button navigates to `/api/connectors/[id]/connect`. That route signs single-use state, and for `mcp_oauth` it discovers, registers (DCR) and runs PKCE. `/callback` stores encrypted tokens on `Connection`. Composio has its own connect/callback with a claim lease. User MCP is a POST to `/api/mcp/servers`, which probes first and stores the row whether or not the probe passes (`src/app/api/mcp/servers/route.ts:76-95`).
2. **Chat turn with apps.** The composer sends `connectors: string[]` (max 5). The chat route filters them by workspace permits (`src/app/api/chat/route.ts:981-991`), then `getActiveConnectors` (`src/lib/mcp.ts:92`) and `openMcpToolset` (`:367`). Every server's full tool list is namespaced and handed to the model. On each call the order is: `ToolInvocation` row → `authorizeExternalAction`, which classifies, resolves the policy, checks for a grant, and on "ask" pushes an approval card and waits → `client.callTool` → truncate → `wrapUntrusted` → settle audit and receipt (`src/lib/mcp.ts:451-557`). `scripts/check-approval-dispatch.mjs` guards against any provider-native MCP path that would skip the broker.
3. **Skill on a turn.** `skillSlug` is armed explicitly and never parsed from text. The route calls `loadChatSkill`, which builds one grant layer from the tools this turn has, then `narrowRuntimeToolsForSkill`. Untrusted instructions go inside the envelope, withheld tools are named after it, and a `skill_applied` audit row is written (`docs/JUNO.md` §5.9, `src/app/api/chat/route.ts:2189-2270`).
4. **Skill import.** A GitHub URL is previewed at a pinned commit, then imported by path. Imported skills land `untrusted` and scanned, with provenance on the version (`docs/JUNO.md` §9b.6). Sources can be checked and updated. The file import on `/skills/new` parses on the client and posts `origin: "imported"` (`src/app/(app)/skills/new/page.tsx:67-72`).

---

## 2. What is real, and what is fake, dead or gated

| Item | Verdict | Evidence |
|---|---|---|
| Approval broker (classify, receipt, digest, atomic spend, replay, unattended refusal) | **Real and strong** | `src/lib/action-approval-store.ts:403-504`; tests `tests/action-approval*.test.ts`, `work-broker.test.ts`; build guard `scripts/check-approval-dispatch.mjs` |
| Risk classifier (deny-first, hints treated as evidence and never as authority) | **Real** | `src/lib/action-approval.ts:215-270` |
| Encrypted credentials with key ids and rotation | **Real**, with one gap | `src/lib/crypto.ts`. Rotation covers `Connection` and `Account` only (`scripts/rotate-encryption-keys.ts:27-73`) and skips `UserMcpServer.authHeader` (P5) |
| Built-in connectors | **Real but gated** by environment | Hidden or "Unavailable" until the OAuth client id and secret are set (`src/lib/connectors.ts:217-227`). Which ones are configured in production is **UNVERIFIED** |
| Composio catalog and connect | **Real but gated** by `COMPOSIO_API_KEY` | Toolkits without a Composio-managed OAuth app show "Setup needed" and link to Composio's dashboard (`connector-directory.tsx:208,230,327-344`) |
| User MCP servers (URL + header) | **Real and shipped**, but unsafe (P1) | `src/lib/user-mcp.ts`, `/api/mcp/servers/*`, web and Mac UI |
| "Use in chats" switch on built-in and Composio tiles (web) | **Fake**: it writes `localStorage["juno:mcp:enabled"]` and nothing reads it | `src/app/(app)/connections/page.tsx:35,112-141`; `connector-directory.tsx:311-317`; a repo-wide grep finds the key only in `page.tsx` and a comment in `user-mcp.ts:15` |
| "Allow this action for this connector" | **Misleading**: the grant is written, but the default policy never consults it | P2 |
| `probeMcpEndpoint` 15 s timeout | **Dead code**: the `AbortController` is never passed to the transport | `src/lib/mcp-probe.ts:39-45` |
| `src/lib/connectors/google-drive.ts`, `microsoft-365.ts` | **Dead**: referenced only by `tests/connectors-lifecycle.test.ts`, not in the registry, no OAuth. They came from a "v1.1.0 … enterprise SSO, CRDT, swarms" commit (`3a7499ba`, `8e852d69`) | grep |
| `/api/skills/import/file` | Real, but only the Mac uses it; the web parses on the client | `NativeSkillsClient.swift:152` |
| Skills library, GitHub import, sources, versions, consent, scanner, trust | **Real and deep** | `src/lib/work/skills.ts`, `skill-security.ts`, `src/lib/skills/*`; tests `tests/skill*.test.ts`, `work-skill*.test.ts` |
| SKILL.md export (web: copy/download) | Real (client-side `serializeSkillMd`) | `src/components/skills/skill-detail-view.tsx:32,191-206` |
| Inline `@app` mentions in the chat composer | **Real on web only** | `composer.tsx:345-396,2405-2432` |
| App directory / catalog | **Real**: one directory merging built-ins and roughly 1000 Composio toolkits with categories. There is **no per-app detail page** (what it reads, what it changes, which tools, which permissions) | `connector-directory.tsx`; `src/lib/composio.ts:762-827` |
| Per-tool enable/disable | **Absent on main** (branch only) | — |
| Plugin or bundle packaging | **Absent**. Projects are called "the bundle" in `docs/JUNO.md` §9b.5, but they are not installable or shareable. Agents carry connectors without skills. Assistants live in the skill table | `schema.prisma:3834`; `src/lib/assistants.ts` |
| `resolveConnectorsWithStatus` (report skipped connectors) | **Stub** that throws `not implemented: WS1`, on the paused `web/tools-thinking-research` branch | `git diff main...web/tools-thinking-research -- src/lib/mcp.ts` |
| `docs/JUNO.md` §8 | **Stale**: no mention of user MCP servers or the broker. `:1348` still says Apple routes "are dialed by Anthropic's MCP infrastructure", but that path was removed (`src/lib/mcp.ts:25-38`) | — |

---

## 3. Problems

### 3.1 Correctness and security, most severe first

**P1. The shipped user MCP path is an SSRF primitive.**
`isAllowedMcpUrl` checks the scheme only. It accepts `https://` to any host and `http://` to `localhost`/`127.0.0.1`/`::1` in production (`src/lib/user-mcp.ts:46-57`). The probe and the runtime then connect with the SDK's plain `fetch` (`src/lib/mcp-probe.ts:43-47`, `src/lib/mcp.ts:384-388`). There is:
- no private or link-local address refusal,
- no DNS pinning,
- no redirect re-validation.

Up to 240 characters of the failure text go back to the caller (`mcp-probe.ts:55`), which lets a user read responses from internal services. Any signed-in user can probe the production VM's loopback services and internal DNS names through `/api/mcp/servers/test`. It is rate-limited to 60 per hour (`src/app/api/mcp/servers/test/route.ts:21`).
The fix already exists twice: main has `src/lib/search/url-safety.ts` and `pinned-fetch.ts`, and the unmerged branch has a streaming `src/lib/mcp-safe-fetch.ts` built on them (`git show 75a62e6a:src/lib/mcp-safe-fetch.ts`).

**P2. "Allow this action for this connector" does not do what it says under the default policy.**
- The card offers it whenever the risk class is `reversible_write` (`canAllowScope: mayCreateStandingApproval(riskClass)`, `src/lib/action-approval-store.ts:93`). That condition ignores the policy.
- Choosing it writes a grant (`:643-670`) and shows "Allowed. Juno will not ask again before this action on this connector." (`src/components/chat/approval-card.tsx:91,763-771`).
- `decideActionPolicy` honours grants only under `allow_selected_low_risk` (`src/lib/action-approval.ts:296-302`). The default is `ask_for_any_change` (`:42`), so the next identical call asks again.
- The Mac card behaves the same way (`native/macOS/JunoDesktop/App/ApprovalCard.swift:342`).
- No UI or API lists or revokes grants. A grep finds `actionApprovalGrant` only in the store.

**P3. Three switches answer "may Juno use this app?", and one of them is fake.**
- (a) The web "Use in chats" switch writes localStorage that nothing reads (§2).
- (b) Settings › Connectors "Connected apps" writes `blockedConnectors`, which the broker enforces.
- (c) The user MCP `enabled` column is labelled "On/Off" on the web (`connector-directory.tsx:279-281`) and "Use in chats" on the Mac (`DesktopConnectionsScreen.swift:386`). A disabled server also disappears from Settings' list, because that list filters on `connected` (`settings/sections/connectors.tsx:191-193`) and `/api/connectors` sets `connected: row.enabled` (`src/app/api/connectors/route.ts:63`).

The branch commit message states the same diagnosis and fixes (a).

**P4. Every Composio action is probably asked about, and the card cannot say what it is.**
- Composio sessions expose **meta tools** over MCP, such as `COMPOSIO_SEARCH_TOOLS` and `COMPOSIO_MULTI_EXECUTE_TOOL` ([Composio docs, "What is a session?"](https://docs.composio.dev/docs/how-composio-works), undated).
- The classifier reads the tool name's first token (`composio`, not a verb) and the argument **keys** only (`src/lib/action-approval.ts:204-207,215-270`). Every meta-tool call therefore lands as `unknown`, which is floored to an external write and asks under the default policy.
- The card would read something like "Gmail wants to COMPOSIO MULTI EXECUTE TOOL. Juno could not verify whether this only reads…" (`actionPreview`, `:463-469`). The real action slug sits inside `args.tools[].tool_slug` and nothing inspects it.
- **UNVERIFIED at runtime.** The exact tool list Juno's session config exposes (`src/lib/composio.ts:836-848`) was not observed.

**P5. Key rotation strands user MCP headers without saying so.**
`rotate-encryption-keys.ts` never re-seals `UserMcpServer.authHeader`. After the retired key is dropped, `decryptAuthHeader` returns `null` (`src/lib/user-mcp.ts:65-73`) and the server is dialled **anonymously**. The call fails or, worse, succeeds with less access, and nothing tells the user.

**P6. Connectors are dropped silently at chat time.**
An unreachable or unauthorised server is skipped (`src/lib/mcp.ts:424-426`), and so is a failed refresh (`:150-160`). The model never sees the tools and the reader is never told. The fix was designed as RC-3 on the paused chat-rework branch but was never implemented (§2). Work has its own verdict system for this (`src/lib/work/connectors.ts:1-40`). Chat does not.

**P7. There is no tool budget.**
Up to 5 servers' full tool lists go to the model on every turn (`src/lib/mcp.ts:381-428`), with no cap, no deferred loading and no tool search. A remote GitHub server alone exposes dozens of tools (**UNVERIFIED** count).

**P8. The native-equivalent filter can hide an app completely.**
`NATIVE_EQUIVALENT` drops Composio's GitHub, Figma and Notion unconditionally (`connector-directory.tsx:557`). If the built-in Figma OAuth app is not configured, Figma shows only as "Unavailable" and the working Composio Figma is hidden. Production configuration is **UNVERIFIED**.

**P9. The iPhone/iPad mishandles user MCP rows.**
They arrive as `source: .native, kind: "user_mcp"` (`NativeConnectorStore.swift:165-183`).
- "Disconnect" deletes the server permanently (`:246-249`), while the copy promises a reconnect.
- A disabled row renders Connect, which builds `api/connectors/user_mcp:<id>/connect` (`JunoMobileConnectionsView.swift:322-335`). That route cannot serve it.

This is based on code; runtime is **UNVERIFIED**.

**P10. The `@` palette shows raw ids.**
The row label is `@${connectorKey(id)}` (`composer.tsx:1801`). `connectorKey` strips only `composio:` (`:339-343`), so a user MCP row reads `@user_mcp:clx…`.

**P11. There is an unneeded self-hop.**
Composio MCP traffic goes from Juno's server to Juno's **public** URL (`src/lib/mcp.ts:128-131`) and then to Composio. The proxy existed to keep Composio headers away from Anthropic's native MCP path, and that path was removed (`src/lib/mcp.ts:25-38`). Apple routes make the same self-dial (`src/lib/connectors.ts:165,180,195`).

**P12. The MCP stack is behind the current spec.**
- Juno uses `@modelcontextprotocol/sdk` 1.29.0, has DCR-only OAuth (`src/lib/mcp-oauth.ts` `registerClient`), and no RFC 9207 `iss` check was found.
- The 2026-07-28 spec makes the transport stateless, deprecates DCR in favour of Client ID Metadata Documents, and requires issuer validation ([MCP blog, 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/), Jul 28 2026).
- The branch's custom-connector probe **refuses** servers without DCR (`git show 75a62e6a:src/lib/custom-connectors.ts`, `no_registration`). That is the wrong direction now.
- Whether current servers (Notion, GitHub) still accept Juno's handshake is **UNVERIFIED**.

**P13. The probe timeout is dead** (`src/lib/mcp-probe.ts:39-45`). A slow server holds the request for as long as the platform allows.

### 3.2 Product and UX coherence

- **The area has no single home.** Extending Juno is spread across:
  - `/connections`, which has its own dead switch;
  - Settings › Connectors (block list and policy);
  - `/permissions` (Work modes and Macs, with no connector policy, `src/app/(app)/permissions/page.tsx:137-138`);
  - `/skills`;
  - Assistants, stored as skills;
  - Agents, which carry connectors;
  - Projects, which carry default connectors and scoped skills.

  Competitors converged on one directory:
  - Claude's **Customize** has Skills, Connectors and Plugins tabs ([Claude Help: Browse skills, connectors, and plugins in one directory](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory), marked "updated this week" with no date shown; a third-party source dates the unification to Mar 31 2026, **UNVERIFIED**).
  - ChatGPT moved its app directory into a **Plugin directory** on July 9 2026. Apps are invoked with `@` and skills with `/` ([OpenAI Help: Plugins in ChatGPT](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex), via search snippet because the page returned 403 to a direct fetch; [OpenAI Developers: Plugins](https://developers.openai.com/plugins), undated).
- **Two permission vocabularies that never reference each other.** Work has conservative/balanced/permissive (`src/lib/work/domain.ts:503`). Connectors have 5 policies (`src/lib/action-approval.ts:32-38`). A person cannot tell which one governs a chat versus a task.
- **Implementation details leak to end users.**
  - "Needs its own OAuth app in Composio", with a "Set up ↗" link to `platform.composio.dev` (`connector-directory.tsx:243,327-344`).
  - The error copy "Add your own app credentials … in the Composio dashboard" (`connections/page.tsx:28-29`).
  - "Not set up on this server" for unconfigured built-ins.

  End users have no Composio dashboard and no server. Only `ComposioSetupCallout` is gated on owner (`:697`). The tiles are not.
- **Connecting is blind.** No page says what an app can read, what it can change, which tools it exposes, or which of them will ask. The branch's manage dialog ("Reads" / "Changes things" with a switch per tool) covered only custom servers. Claude lets members disable individual tools per conversation ([custom connectors help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), updated Aug 11 2026). Its Enterprise roles set Always allow / Needs approval / Blocked per tool ([role permissions help](https://support.claude.com/en/articles/13930458-set-up-role-based-permissions-on-enterprise-plans), undated).
- **No packaging unit.** Claude and ChatGPT now distribute *plugins* that bundle connectors, skills, commands and sub-agents ([Claude blog: Build plugins for Claude](https://claude.com/blog/build-plugins-for-claude), Sep 25 2026; [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude), undated). Juno can import a skill repository but cannot install "Gmail + its skills" as one thing. Its Agent/Assistant/Skill/Project split is harder to learn than either competitor.
- **Skill boundaries.** One skill per message; regenerate drops the skill (`docs/JUNO.md` §5.9, "Known boundary"). Both are documented, but people will read them as bugs.
- **Auto-attach from prose** (`src/lib/connector-intent.ts`) exists only on the web, so the same prompt behaves differently on the Mac and the phone.

### 3.3 Visual

- A grep of `src/components/{connections,skills}` and the connections, skills and permissions routes found no gradients, sparkles, glow blobs or pulsing dots. Tiles print no Connected/Available status word (`connector-directory.tsx:154-189`, per the 2026-09-26 directive). Nothing here reads as a Claude UI copy. The vocabulary (Connectors, Skills, SKILL.md, `@`/`/`) is now shared across the industry and is not an imitation problem in itself.
- `AddMcpServerDialog` uses **PhaseOrb**, the Libraries.dev transcript "thinking" orb, as a settings-form "Connecting…" indicator (`add-mcp-server-dialog.tsx:12,317-326`). It is ornamental motion outside the transcript. A plain progress indicator and the sentence would be enough.
- The web directory is the generic logo-tile grid with Connect buttons, and the tiles `rise-in` with a stagger (`connector-directory.tsx:251-259`). It is serviceable, but with about 1000 Composio tiles and many dead ("Setup needed"/"Unavailable") ones it reads as a catalog dump rather than a curated set.
- On the Mac, category chips are hand-drawn filled `Capsule`s (`DesktopConnectionsScreen.swift:270-300`) rather than a system control. That is borderline against the "native components" rule; it is not faked glass.

### 3.4 Parity

| Capability | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Directory + Composio catalog | yes | yes | yes | yes (iPhone view) |
| Add/manage user MCP server | yes | yes (main) | no; broken Connect and a destructive Disconnect (P9) | same as iPhone |
| Per-app block list, policy, lockdown | Settings | Settings pane | **no** | **no** |
| Attach app to a chat | `+` flyout, `@` palette, inline `@mention`, auto-from-prose | `+` menu | `+` submenu | `+` submenu |
| Approval card incl. "allow scope" | yes (P2) | yes (P2) | **UNVERIFIED** | **UNVERIFIED** |
| Skills library, import, versions | yes | yes (GitHub + file) | **none** | **none** |
| Arm a skill on a message | `/slug`, skills panel | `+` menu | **no** | **no** |
| Juno Code uses account apps and skills | n/a | **no** (separate `.mcp.json` / `.claude/skills`) | n/a | n/a |

---

## 4. Unmerged branches and parallel work

| Branch / worktree | State | Touches | Verdict |
|---|---|---|---|
| `connectors/custom-mcp` (`../juno-custom-mcp`) | 1 commit `75a62e6a` (Sep 27 15:50), 26 files, +2538. Native WIP **uncommitted** (5 modified, 4 new Swift files, last touched Sep 27 16:02) | New `CustomConnector` model + migration; OAuth-only custom servers (probe, DCR, PKCE, one shared callback); `mcp-safe-fetch.ts` (https-only, pinned DNS, private ranges refused, redirects re-validated, streaming); per-tool disable; "Use in chats" → `blockedConnectors`; integration test `tests/integration/custom-mcp.ts` | **Do not merge as-is.** Main shipped a different custom-MCP model (`UserMcpServer`, `30ff9a79`, Sep 27 18:37, about 3 hours later) that has production rows. Both sides changed `schema.prisma`, `connections/page.tsx`, `api/connectors/route.ts`, `connector-directory.tsx`, `types.ts`, `mcp.ts`, `db.ts`, `package.json` and the dev gallery. Native WIP collides with main's `NativeConnectorStore`/`DesktopConnectionsScreen` custom-MCP code from `81bf66c5`. **Harvest** `mcp-safe-fetch.ts`, the OAuth custom-server flow, the per-tool switches, the Use-in-chats fix and the integration test into one unified model (R1, R3, R4). Drop the "refuse servers without DCR" rule (P12) |
| `skills/import-anywhere` (`../juno-skills`) | HEAD = `8a0b05bd`, all work **uncommitted** (11 modified, 4 new: `src/lib/skills/package.ts`, `/api/skills/import/package`, `/api/work/skills/[id]/export`, `tests/integration/skill-package.ts`); last touched Sep 27 about 16:00 | Import from `.zip`/`.skill`/SKILL.md upload, paste, or any public link (through `fetchSafePublicUrl`, rate-limited, bounded zip); server export as md/zip; "Save as skill…" on a message that contains a SKILL.md; paste a SKILL.md to fill `/skills/new` | **Fold in after a rebase.** It follows the untrusted, scanned, provenance model and fills the most-requested import gaps. Conflicts: `skills/new/page.tsx` (main added file import in `81bf66c5`), `skill-detail-view.tsx`, `skill-library-model.ts`, `skills-library-page.tsx`, `import-skills-dialog.tsx`, `skills-transport.ts`, dev gallery. Reconcile the two serializers (main's `serializeSkillMd` vs the worktree's `formatSkillMd`). Being uncommitted, this work is at risk: the owner should commit it on its branch before the refoundation touches skills |
| `web/tools-thinking-research` (paused chat rework) | 15 commits ahead | `src/lib/mcp.ts`: `resolveConnectorsWithStatus` stub (RC-3), richer `ToolExecution` (status, error codes, sources), per-call `timeoutMs` and `onAuthorized` | Relevant to P6. Carry the RC-3 design into the refoundation's chat work; do not merge the stub on its own |
| `agents/rework`, `agents/features`, `agents/runtime` | Agents work | `action-approval.ts` (keep "?" on agent-change headlines), `approval-card.tsx`, `composer.tsx` (+7) | Small. They land with Agents and do not change connector semantics |
| `origin/codex/voice-artifacts-composio` | 1 commit `2ad6183e`, Jul 15 2026 | The original Composio routes and voice | **Superseded.** The Composio routes on main are newer. Do not merge |

---

## 5. Recommendations, highest leverage first

**R1. Close the SSRF now.** It is small and independent. Route every user-supplied MCP request (draft test, saved test, create probe, runtime transport) through a pinned, private-range-refusing fetch; the branch's `mcp-safe-fetch.ts` can be taken almost verbatim. Refuse `http://localhost` in production. Wire the probe timeout (P13). Stop echoing raw upstream error bodies.
Files: `src/lib/user-mcp.ts`, `src/lib/mcp-probe.ts`, `src/lib/mcp.ts` (the transport for `user_mcp:`), new `src/lib/mcp-safe-fetch.ts` (from `75a62e6a`), `src/app/api/mcp/servers/**`. Tests: port `tests/integration/custom-mcp.ts`'s SSRF cases.

**R2. Make the approval card tell the truth, and give grants a home.** Either offer "Allow this action for this connector" only when the current policy honours grants, or make grants apply to reversible writes under `ask_for_any_change` too (a product decision). Add a Settings › Connectors "Always allowed" list with Revoke, on web and Mac.
Files: `src/lib/action-approval.ts` (`decideActionPolicy`, `mayCreateStandingApproval`), `src/lib/action-approval-store.ts` (`serializeActionApproval`, new list/revoke), `src/app/api/approvals/**` or `src/app/api/settings/route.ts`, `src/components/chat/approval-card.tsx`, `src/components/settings/sections/connectors.tsx`, `native/macOS/JunoDesktop/App/{ApprovalCard,DesktopSettingsConnectorsPane}.swift`.

**R3. One switch per app.** Delete the localStorage "Use in chats". The switch on a connected tile becomes the `blockedConnectors` switch, the same one Settings shows. Fold `UserMcpServer.enabled` into it, or keep `enabled` purely as "installed" and never as a second on/off. List disabled or blocked custom servers in Settings too.
Files: `src/app/(app)/connections/page.tsx`, `connector-directory.tsx`, `src/app/api/connectors/route.ts`, `src/lib/user-mcp.ts`, `settings/sections/connectors.tsx`, `DesktopConnectionsScreen.swift`, `NativeConnectorStore.swift`.

**R4. One custom-connector model.** Merge `UserMcpServer` (shipped, header auth) and the branch's `CustomConnector` (OAuth, per-tool) into a single table:
- auth kinds `oauth` (DCR **and** CIMD, with `iss` validation), `header` and `none`;
- a `disabledTools` list;
- cached tools split into reads and changes;
- all traffic through the safe fetch.

Migrate production `UserMcpServer` rows in place, keeping the `user_mcp:` ids or aliasing them so `Conversation.activeConnectors`, `Agent.connectorIds` and `blockedConnectors` keep resolving. Add these fields to key rotation (P5). Then finish native from the branch WIP against the unified API.
Files: `prisma/schema.prisma`, migrations, `src/lib/user-mcp.ts` → `src/lib/custom-connectors.ts`, `src/lib/mcp-oauth.ts`, `src/lib/mcp.ts`, `src/app/api/mcp/servers/**` and/or `src/app/api/connectors/custom/**`, `scripts/rotate-encryption-keys.ts`, web dialogs, `NativeConnectorStore.swift`, `DesktopConnectionsScreen.swift`, `DesktopCustomConnectorSheets.swift` (WIP).

**R5. Make Composio actions legible.** Two options:
- Switch execution sessions to Composio's direct-tools preset so each app action is its own MCP tool with a real name, or
- teach the classifier and preview to unwrap `COMPOSIO_MULTI_EXECUTE_TOOL` (`tools[].tool_slug`) and classify each inner action (a `GMAIL_SEND_EMAIL` asks, a `GMAIL_FETCH_EMAILS` does not).

Verify against live traffic first (P4 is **UNVERIFIED** at runtime). Call the Composio session URL directly from `getActiveConnectors` and drop the public-URL self-hop (P11). Hide "Setup needed" toolkits from non-owners.
Files: `src/lib/composio.ts:836-848`, `src/lib/action-approval.ts` (`classifyExternalAction`, `actionPreview`), `src/lib/mcp.ts:124-133`, `src/app/api/mcp/composio/[slug]/route.ts` (keep only if an external client needs it), `connector-directory.tsx`.

**R6. Report connectors that could not join the turn.** Implement RC-3: `getActiveConnectors` / `openMcpToolset` return skipped ids with a reason, chat shows one line ("Notion isn't available this turn: sign-in expired. Reconnect"), and native gets the same. Reuse Work's verdict vocabulary (`src/lib/work/connectors.ts`) rather than inventing a third one.
Files: `src/lib/mcp.ts`, `src/app/api/chat/route.ts:981-991`, chat activity components, `NativeConversationStore.swift`.

**R7. Consolidate the surface.** Create one "Apps & Skills" (or "Customize") destination:
- **Apps**: a curated first page, search into Composio, and a per-app sheet showing what it reads and changes, its tools with per-tool Allow / Ask / Off, the account, and Disconnect.
- **Skills**: the library.
- **Bundles** (later): an installable app + skills + default permissions unit, which is what Projects/Agents half-provide today.

Move the connector policy onto that surface or cross-link it from `/permissions`. State plainly how Work modes and connector policies relate. Remove owner-only states (Composio setup, "Not set up on this server") from end-user views.
Files: `src/app/(app)/connections/**`, `src/app/(app)/skills/**`, `src/app/(app)/permissions/page.tsx`, `src/components/connections/**`, `src/components/settings/sections/connectors.tsx`, Mac/iOS equivalents.

**R8. Land `skills/import-anywhere`.** Rebase the uncommitted work onto the refoundation, reconcile `serializeSkillMd`/`formatSkillMd` and the two SKILL.md entry points on `/skills/new`, run its integration test, and add package import on Mac.
Files: those listed in §4.

**R9. Native parity.**
- iPhone/iPad: fix user MCP rows (Remove, not Disconnect; no Connect), add Settings › Connectors (policy, block list, grants), and add a read-and-arm skills surface.
- Mac: inline `@` mentions are optional, but pick one attach model and use it on every platform (either auto-attach from prose everywhere or nowhere).
- Juno Code: decide whether account skills and account MCP servers are offered to local sessions (with the same broker) or explicitly scoped out.

Files: `native/iOS/JunoMobile/App/JunoMobileConnectionsView.swift`, `JunoMobileAttachmentMenu.swift`, new iOS skills views, `NativeConnectorStore.swift`, `native/Packages/JunoCode/**` (decision first).

**R10. Tool budget and MCP spec upgrade.**
- Cap tools per turn and add deferred tool discovery, so 5 servers cannot flood the model.
- Plan the SDK and spec move: 2026-07-28 stateless transport, CIMD, RFC 9207, MCP Apps and Enterprise Managed Auth are now table stakes in Claude's directory ([Claude blog](https://claude.com/blog/build-plugins-for-claude), Sep 25 2026).

Files: `src/lib/mcp.ts`, `src/lib/mcp-oauth.ts`, `package.json`.

**R11. Hygiene.**
- Delete `src/lib/connectors/google-drive.ts`, `microsoft-365.ts` and `tests/connectors-lifecycle.test.ts`.
- Fix the `@` palette label for user MCP rows (`composer.tsx:1801`).
- Make `NATIVE_EQUIVALENT` apply only when the built-in connector is configured (`connector-directory.tsx:557`).
- Replace PhaseOrb in `add-mcp-server-dialog.tsx`.
- Rewrite `docs/JUNO.md` §8: user MCP, broker and receipts, policies, the removed Anthropic path at `:1348`.
- Generate the Mac policy copy from the web source instead of duplicating it (`DesktopSettingsConnectorsPane.swift:13-20`).

---

### Competitor sources used

- Claude Help, "Browse skills, connectors, and plugins in one directory": https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory ("updated this week" as of 2026-09-30, no date shown)
- Claude blog, "Build plugins for Claude with the directory submission portal": https://claude.com/blog/build-plugins-for-claude (Sep 25 2026)
- Claude Help, "Use plugins in Claude": https://support.claude.com/en/articles/13837440-use-plugins-in-claude (undated)
- Claude Help, "Get started with custom connectors using remote MCP": https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp (updated Aug 11 2026)
- Claude Help, "Set up role-based permissions on Enterprise plans": https://support.claude.com/en/articles/13930458-set-up-role-based-permissions-on-enterprise-plans (undated; per-tool Always allow / Needs approval / Blocked, taken from a search snippet)
- Releasebot aggregator, Claude updates: https://releasebot.io/updates/anthropic/claude (Claude Marketplace with 2,000+ connectors and plugins on Sep 23 2026; not confirmed on a primary source, **UNVERIFIED**)
- OpenAI Help, "Plugins in ChatGPT and Codex": https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex (directory migration on July 9 2026; `@` for apps, `/` for skills; taken from a search snippet because a direct fetch returned 403)
- OpenAI Developers, Plugins: https://developers.openai.com/plugins (undated)
- MCP blog, "The 2026-07-28 Specification": https://blog.modelcontextprotocol.io/posts/2026-07-28/ (Jul 28 2026)
- Composio docs, "What is a session?": https://docs.composio.dev/docs/how-composio-works (undated)
