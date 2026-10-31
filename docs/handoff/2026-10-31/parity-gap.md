# Juno (Alevr) vs ChatGPT and Claude: feature parity gap matrix

Date: 31 October 2026. Juno inspected at `main` HEAD `70661166c` (includes the merges of feat/payment-cards, feat/vault, feat/teach-by-demo).
Scope: consumer/pro products (claude.ai and Claude apps; ChatGPT and its apps), not the APIs. Research and static code reading only; no product code changed, nothing executed against a running Juno.

## How to read this

- **present**: code implementing the capability exists; file:line given. "Present" does not mean deployed, enabled or production-accepted. Many Juno features depend on env configuration (e.g. `TOOL_RUNTIME`/`CODE_INTERPRETER_URL` for code execution, `AGENT_TEACH_ENABLED`, `CHANNEL_SENDBLUE_*`, `STRIPE_ISSUING_CARDHOLDER_ID`).
- **partial**: something real exists; what is missing is stated.
- **missing**: no implementation found by grep/reading in `src/`, `relay/`, `native/`, `prisma/`.
- Competitor claims are documentation claims, not hands-on checks. Plan, region and rollout vary.

### Source limitations (important)

- `help.openai.com` and `openai.com` **could not be fetched** from this session (DNS blocked by the session's network allow-list). Every ChatGPT claim below comes from **web-search result excerpts of those official pages** (plus a few press items, marked). Treat ChatGPT details as lower-confidence than Claude details; re-check by opening the cited pages directly. To fetch them, `help.openai.com` and `openai.com` must be allowed in the session's network settings.
- `support.claude.com` was fetched directly for the Claude release notes, artifacts, memory, voice, unified Cowork and sharing articles.
- Juno's own capability registry (`src/lib/capabilities.ts`) was used as a cross-check, not as evidence. It appears partly stale: `teach_alevr` (l.659) and `external_channels` (l.689) are marked `status: "disabled"` with no evidence, although teach (`src/lib/teach/*`, `AgentDemonstration` at `prisma/schema.prisma:4922`) and iMessage channels (`src/lib/channels/*`, `src/app/api/channels/{imessage,sendblue}`) are merged on main.

## Competitor landscape changes since the 29 Oct audit worth knowing

ChatGPT (OpenAI), 2026:
- GPT-6 with **Intelligent UI** (interactive graphics, buttons, forms, charts, small in-chat tools), 7 Oct 2026 [O1][O2].
- **Dots**: always-on agents with their own cloud computers, 4,000+ apps, saved-password sign-in without exposing secrets to the model; DevDay 29 Sep 2026 (press) [P1][P2]. **Texting your dot** via iMessage/RCS, beta for US Pro, 28 Oct 2026 [O1][P3].
- **ChatGPT Work** (long multi-step tasks and finished deliverables: docs, sheets, decks, reports, Sites); rolled out 9 Jul 2026. **ChatGPT agent is no longer available** and points users to Work [O5][O6].
- **Sites** (public beta 9 Jul 2026; cap removed 15 Oct): create, preview, publish, share interactive websites/light apps, editors, viewers [O7].
- **Slides** (16 Oct 2026; co-edit decks in Space, export PowerPoint/PDF/Google Slides) and **Space** (shared pages co-edited live by people, ChatGPT and dots; View/Comment/Edit; inline comments with @ChatGPT; DevDay 29 Sep, rollout from 1 Oct; mostly press) [O1][P4].
- **Plugins** replaced the app directory (9 Jul 2026): bundles of apps (connectors) + skills; **custom GPTs being retired** (standard date 11 Dec 2026; creation already closed on personal plans) [O8][O9]. **Skills** for Business/Enterprise/Edu [O10].
- **Locked chats** (PIN, Face ID/Touch ID; hidden from history, pins and search), 20 Oct 2026 [O11].
- **Group chats retired** (no new ones since 9 Jul 2026) [O12]. **Pulse sunset** (17 Jun 2026) into scheduled tasks [O1].
- **Scheduled tasks**: Scheduled page (17 Jun 2026); webhook triggers for Gmail/Slack/GitHub and task sharing (25 Aug 2026) [O13].
- **Canvas removed** from current models in favour of in-chat writing/code blocks (users complain about persistence) [O14][O15].
- **GPT-Live** voice (1.1 on 15 Oct); Live does **not** support video/screen share; Advanced Voice on iOS/Android still has camera and screen share [O16].
- **Images 2.5**: select-region editing [O17]. **ChatGPT for Excel and Google Sheets** GA 5 May 2026 [O18]. **Atlas** browser with agent mode, pause/takeover [O19].
- Memory: saved memories + reference chat history, project-only memory, "Delete and turn off memory" (Jun 2026), Privacy Center (Sep 2026), personalized temporary chats (Aug 2026) [O20][O21]. Personality presets + **Characteristics** (warmth, enthusiasm, headers/lists, emoji) [O22]. Shared links, branching, temporary chat, data export [O23]. Shared projects with edit/chat roles, project-only memory [O24].

Claude (Anthropic), 2026 (from the Claude release notes page [C1] unless noted):
- **Cowork in every conversation** (16 Sep 2026): tasks run in a cloud VM from any chat, scheduled tasks in the cloud, connectors, skills, plugins, computer use (beta), phone dispatch [C2].
- **Claude Design, Slides, Docs in any conversation** (16 Sep 2026); artifacts on every plan. Export: Docs to Word/PDF/Markdown/Google Docs; Slides to PowerPoint/PDF/Google Slides; Designs to zip/PDF/PPT/HTML; animations to MP4 [C3].
- **AI-powered artifacts** (artifacts call Claude on the viewer's account), **persistent artifact storage** (20 MB, personal or shared), **artifacts using connectors** [C3].
- **Edit drafts in place** (highlight and edit, 12 Jun 2026) [C1][C3].
- **Interactive connectors / MCP Apps** across web, desktop, mobile [C4]; **interactive charts/diagrams inline** (12 Mar 2026) [C1]; custom remote MCP connectors on all plans [C5].
- **Memory**: categorized topics updated during chat (10 Jul), editable topics + sensitive-topics opt-in (25 Aug), per-chat memory off, project memory, chat search with citations, import/export, incognito [C6].
- **Monthly recap**, break reminders, quiet hours (9 Jul 2026) [C1].
- **Claude Duet**: proactive agent app, research preview, US Pro/Max waitlist, 21 Oct 2026 [C1][P5].
- **Claude Tag** in Slack (23 Jun 2026, Team/Enterprise) [C1]; Excel and PowerPoint add-ins [C1]; Claude in Chrome as a full Cowork session (Aug 2026, press) [P6]; health data on mobile (12 Jan 2026, US Pro/Max) [C1].
- **Share a chat with specific people** (default; invite by email, snapshot only) plus public links [C7]. Voice mode on all plans and platforms, with web search and connectors during voice; no video/screen share documented [C8].
- Claude still has **no native image generation** (only third-party/blog sources; Anthropic page not found) [P7].

---

## Matrix

Legend: CG = ChatGPT, CL = Claude. Sizes are for Juno only.

### A. Chat UX

| Capability | CG | CL | Juno | Evidence / what's missing |
|---|---|---|---|---|
| Composer with + menu, attachments, slash palette | yes | yes | present | `src/components/chat/composer.tsx`, `composer-plus-menu.tsx`, slash palette `composer.tsx:3459` |
| Model picker + effort | yes | yes | present | `src/components/chat/model-selector.tsx:369`, `reasoning-slider.tsx:23`, Auto router `src/lib/router/decide.ts` |
| Stop generation | yes | yes | present | `composer.tsx:1344` (`onStop()`), `src/app/api/chat/cancel` |
| Edit user message / regenerate with version pager | yes | yes | present | `src/app/api/messages/[id]/route.ts:29` (PATCH), `src/app/api/messages/[id]/versions/route.ts:25` |
| Branch into new chat | yes [O23] | partial (branching not supported in unified Cowork [C2]) | present | `src/app/api/conversations/[id]/fork/route.ts:33` |
| Temporary / incognito chat | yes | yes | present | `src/components/chat/private-chat-toggle.tsx:28`; iOS `native/iOS/JunoMobile/UITests/JunoMobileIncognitoUITests.swift` |
| Personalized temporary chat (reads memory, writes none) | yes (Aug 2026) [O21] | no | unverified | Incognito is described as "nothing of it may be kept" (`src/lib/chat/skill-draft-tool.ts:143`); whether incognito *reads* memory was not established |
| Locked chats (PIN / biometrics) | yes (20 Oct 2026) [O11] | no | **missing** | No lock/PIN/LocalAuthentication code in `src`/`native` |
| Pin, archive, folders | yes | partial | present | `src/app/api/conversations/[id]/route.ts:40` (pinned), `Folder` model `prisma/schema.prisma:647` |
| Find in conversation + search across chats (bodies) | yes | yes | present | `src/components/chat/conversation-find.tsx:35`; recall index `src/lib/recall/service.ts`, tool `src/lib/tools/specs/search-chats.ts:2` (registry: native not wired, `capabilities.ts:329`) |
| Share link (snapshot) | yes | yes | present | `src/lib/share.ts:18`, `Share` model `prisma/schema.prisma:2493` (leaf-pinned, revocable, takedown) |
| Share with specific people (email-restricted) | no (public links) | yes, default [C7] | **missing** | `Share` has only a bearer token; no recipient list (`prisma/schema.prisma:2493-2531`) |
| Group chat with other humans | retired [O12] | no | n/a | Juno "rooms" are multi-agent (`src/components/chat/use-room.ts`), not multi-human. Not a gap. |
| Keyboard shortcuts + sheet | yes (third-party sources only) | partial | present | `src/components/app/command-palette.tsx:1563,1713`, `src/hooks/use-global-shortcuts.ts` |
| Export conversation (Markdown, print/PDF) | via data export | via data export | present | `src/components/chat/conversation-export.ts:196`, `conversation-print.tsx:59` |
| Follow-up suggestions, feedback | yes | partial | present | `src/lib/chat/follow-up-cache.ts`, `src/components/chat/message-feedback.tsx:38` |
| Saved prompts | no | no | present (differentiator) | `src/app/api/prompts/route.ts` |
| Model compare | no | no | present (differentiator) | `src/app/(app)/compare/page.tsx` |

### B. Search, citations, research

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Web search with citations | yes | yes | present | `src/components/chat/sources-pill.tsx:191`, `alevr_search` in `capabilities.ts:363` |
| Claim-level citation audit | no | no | present (differentiator) | `src/components/chat/citation-audit.tsx:184`, `src/lib/research/citation-audit-core.ts` |
| Deep research with editable plan, progress, interrupt | yes [O13 (deep research)] | yes | present | `src/lib/research/run.ts:744`, planner, editable plan sizing `src/types/research.ts:23` |
| Research over connectors (Drive/Gmail etc.) | yes | yes | unverified | Planner has no connector reference (`grep connector src/lib/research/planner.ts` empty); research may reach connectors elsewhere. Check in browser. |
| Research report export | yes | yes | partial | Print-to-PDF `src/components/research/report-export.tsx:68`; DOCX copy strings present; no Google Docs |

### C. Files, data analysis, code execution

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Upload/read documents and images | yes | yes | present | `src/lib/attachment-upload.ts:83` (plan-based MB cap), `docs/JUNO.md` §5.6b |
| Hosted code execution / data analysis | yes | yes | present, config-gated | `src/lib/exec/config.ts:10` (`CODE_INTERPRETER_URL`, `TOOL_RUNTIME=1`); `src/lib/effective-capabilities.ts:262` degrades when no sandbox; UI `python-execution-block.tsx:34` |
| Inline charts and tables | yes | yes | present | `src/components/chat/data-chart-block.tsx:20`, `data-table-block.tsx` |
| Attach files from Google Drive / OneDrive in composer | yes (apps) | yes (connectors) | **partial** | Drive/M365 connectors exist (`src/lib/connectors/google-drive.ts`, `microsoft-365.ts`); composer only uploads or picks from Library (`library-picker.tsx`); no Drive picker |
| Library of past files | yes | partial | present | `src/app/api/library/route.ts` |

### D. Canvas / artifacts / deliverables

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Side-panel artifact with versions and restore | Canvas removed; writing blocks [O14] | yes | present | `src/components/canvas/canvas-panel.tsx`, `src/app/api/artifacts/[id]/{versions,restore}` |
| Highlight text and edit/ask | partial (blocks) | yes (12 Jun 2026) | present | Selection Modify/Ask bar `canvas-panel.tsx:687` |
| Interactive generative UI in the answer | yes (Intelligent UI, 7 Oct) | yes (12 Mar) | present | `src/components/chat/live-ui/live-ui-intelligent.tsx:56`, `host.tsx`, `live-ui-controls.tsx` |
| Docs / sheets / decks as editable models | yes (Work, Slides) | yes (Docs/Slides) | present (web) / partial (native) | `src/lib/work/deliverables/{document,spreadsheet,presentation}.ts`, `src/lib/artifact-ops.ts`; registry: no native semantic view `capabilities.ts:620-621` |
| Export DOCX/XLSX/PPTX | yes | yes | present | `src/app/api/artifacts/[id]/export/route.ts:25` (`docx|xlsx|pptx`), `src/lib/office-export.ts:30` |
| Export doc/deck to PDF, Google Docs/Slides | yes (Slides: PDF, Google Slides) [O1] | yes [C3] | **partial** | Export enum is only `docx|xlsx|pptx` (`export/route.ts:25`); PDF exists only for designs (`src/lib/design/export.ts:48`) and research print |
| Design canvas (visual design, export SVG/PNG/PDF/HTML/React/SwiftUI) | no | yes (Claude Design) | present | `src/components/design/*`, `src/lib/design/export.ts:48` |
| Publish to a stable public URL with version pin | yes (Sites) | yes | present | `src/lib/artifact-publication.ts` (publish/update/rollback/unpublish/reset), `src/app/api/artifacts/[id]/publication/route.ts:41` |
| AI-powered artifacts (artifact calls the model on the viewer's account) | Sites are "light apps" (backend capabilities not confirmed) | yes [C3] | **missing** | Sandbox bridge only carries `juno:console`, `juno:open`, `juno:status`, `juno:inspect/selected`, mermaid size (`src/components/canvas/sandbox-frame.tsx:167,206,296,346`) |
| Artifact persistent storage (per-user / shared) | not confirmed | yes, 20 MB [C3] | **missing** | Same bridge; no storage model in schema |
| Artifacts using connectors | not confirmed | yes [C3] | **missing** | Same |
| Real-time multi-user co-editing + comments | yes (Space pages, Slides) [P4][O1] | no (snapshot sharing) | **partial** | Semantic documents support comments/tracked revisions (registry summary `capabilities.ts:604`); project roles (`ProjectMember`, `prisma/schema.prisma:806`); CRDT library exists but is not wired: `canvas_crdt_sync` "CRDT transport/editor integration has not been established" (`capabilities.ts:120-124`, `src/lib/collaboration/crdt.ts:4`) |
| Remix / duplicate | n/a | yes | present | `src/app/api/artifacts/[id]/duplicate` |

### E. Images, video, voice

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Image generation | yes | **no** native [P7] | present | `src/components/chat/image-generation-card.tsx`, `src/app/api/generate` |
| Region (mask) image edit | yes (select tool) [O17] | no | present | `src/components/chat/image-edit-overlay.tsx:7` (eraser, region select), `imageEditSupport` in `src/lib/models.ts` |
| Video generation | yes (not re-verified today) | no | present | `src/lib/media/generation-pipeline.ts:15`, `src/lib/media-gen-core.ts` |
| Realtime speech-to-speech | yes (GPT-Live) | yes | present | relay `relay/src/providers/{gpt-live,openai-realtime,gemini-live}.ts`; `src/hooks/use-realtime-voice.ts` |
| Voice + screen share | Advanced Voice mobile only; Live: no [O16] | not documented [C8] | present (web) | `src/hooks/use-realtime-voice.ts:1422` (`getDisplayMedia`), `video.frame` at l.1359 |
| Voice + camera | Advanced Voice mobile | not documented | present (iOS) | `native/iOS/JunoMobile/App/JunoMobileCameraService.swift:102` |
| Voice uses memory | yes | yes | present | `relay/src/session.ts:42` (`VOICE_MEMORY_MAX_CHARS`) |
| Voice uses connectors/tools | unclear | yes [C8] | **partial** | Voice delegate exposes `web_search` (`relay/src/protocol.ts:74`) and memory; no connector/MCP tools in `relay/src` |
| Dictation, read-aloud | yes | yes | present | `src/components/chat/composer-dictation.tsx:95`, `docs/JUNO.md` §10.1 |

### F. Memory, personalization, projects, assistants, skills

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Saved memory, view/edit/delete | yes | yes | present | `/memory` page, `src/app/api/memory/*`, `src/components/chat/memory-fact-row.tsx` |
| Reference chat history / chat search with citations | yes | yes | present | recall index (above); `search_chats` |
| Sensitive-topic controls | n/a | yes (25 Aug) | present | `memorySensitiveTopics` `src/components/settings/sections/memory.tsx:63` |
| Memory import from other assistants | no | yes (experimental) | present | `src/app/api/memory/import/route.ts:32`; full chat import from ChatGPT/Claude ZIP `src/app/api/import/route.ts:128` |
| Per-chat memory off (non-incognito) | no | yes [C6] | **partial** | Only global `memoryEnabled` (`prisma/schema.prisma:546`) and incognito; nothing in plus menu or turn memory (`src/lib/chat/turn/memory.ts`) |
| Background memory learning toggle | n/a | n/a | present | `memoryBackgroundLearning` `prisma/schema.prisma:562` |
| Monthly recap | no | yes (beta, 9 Jul) | present | `src/app/api/memory/recap/route.ts:21`, `src/lib/memory-recap.ts` |
| Break reminders / quiet hours | no | yes (9 Jul) [C1] | missing (low priority) | Not found |
| Custom instructions | yes | yes | present | `customInstructions` `prisma/schema.prisma:536`, `/customize/instructions` |
| Personality presets | yes | partial | present | `src/lib/personalities.ts:24` (default, concise, encouraging, socratic, formal, nerdy) |
| Characteristics sliders (warmth, enthusiasm, headers/lists, emoji) | yes [O22] | no | **missing** | Only a preset id `personality` (`prisma/schema.prisma:545`) |
| Projects: instructions + files | yes | yes | present | `docs/JUNO.md` §14; `src/app/api/projects` |
| Project-scoped memory | yes | yes | present | `src/app/api/projects/[id]/memory/route.ts:8` |
| Shared projects with roles | yes (edit/chat) [O24] | yes | present | `src/app/api/projects/[id]/members/route.ts:27`, `src/lib/project-collaboration.ts:17` (OWNER/EDITOR/VIEWER) |
| Custom assistants (GPTs) | being retired [O9] | n/a | present | `src/app/api/assistants/route.ts`, `/assistants` |
| Skills (create, import from repo, teach by demo) | yes (business tiers) [O10] | yes | present | `/skills`, `src/lib/skills/bundle.ts`, `src/lib/teach/*`, `/skills/teach` (gated `AGENT_TEACH_ENABLED`) |
| Plugins (bundle of skills + connectors for a role) | yes [O8] | yes [C2] | **partial** | Installed skills grouped per repository (`src/components/skills/skills-library-view.tsx:105-110`); no bundle that also installs connectors |

### G. Connectors, agents, automation

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Large app catalogue | yes (plugins, 4,000+ for dots, press) | yes (6,000+, press) | present | Composio directory `src/components/connections/connector-directory.tsx:33`; vendor dependency (Composio) already in place |
| Custom remote MCP | yes (dev mode; plan-limited) | yes, all plans | present | `UserMcpServer` `prisma/schema.prisma:278`, `CustomConnector` l.324, `src/lib/mcp.ts` |
| Connector-rendered interactive UI (Apps SDK / MCP Apps) | yes | yes [C4] | **missing** | `src/lib/mcp.ts` only `callTool` (l.902); no `ui://`/resource rendering anywhere |
| Event-triggered automations (webhooks) | yes (25 Aug) | partial | present | `connector_event` trigger `src/lib/work/triggers.ts:60`; API trigger `docs/JUNO.md` §14 |
| Scheduled tasks page | yes | yes | present | `/automations`, `src/lib/work/schedule.ts` |
| Long-running background task with deliverables | yes (Work) | yes (Cowork) | present | Work engine `capabilities.ts:268`, `src/lib/work/*` |
| Agent with its own cloud computer, live view, takeover | yes (dots) | yes (Cowork VM, Duet) | present | `AgentComputer` `prisma/schema.prisma:4869`, `AgentComputerHandoff`, `/computer-view`, relay `relay/src/computer-view.ts` |
| Use the user's own computer | yes (Work desktop, Atlas) | yes (beta, Mac/Win) | present (Mac) | `native/Packages/JunoScreenControl/Sources/JunoScreenControl/InputDriver.swift:10`, `WorkHost` `prisma/schema.prisma:3627` |
| Credential vault with fill at the boundary | yes (dots, press) | yes (Duet, press) | present | `src/lib/secrets/store.ts`, `src/lib/secrets/browser-fill.ts` |
| Payments by agent | Instant Checkout (partners) | approval required (Duet) | present, vendor-gated | `AgentPayment` `prisma/schema.prisma:5231`; Stripe Issuing (`STRIPE_ISSUING_CARDHOLDER_ID`) |
| Proactive agent (finds work, briefs you) | yes (dots) | yes (Duet preview) | present | `AgentIdea` `prisma/schema.prisma:4795`, agents/goals (`capabilities.ts:473,522`) |
| Text the agent via iMessage | yes (beta 28 Oct) | no | present, vendor-gated | `src/lib/channels/sendblue.ts`, `mac-relay.ts`, settings `src/components/settings/sections/imessage.tsx` (Sendblue is a paid vendor; Mac relay path avoids it) |
| Tag the assistant in Slack | no | yes (Claude Tag) | **missing** | `src/lib/channels` has only iMessage/Sendblue; Slack is reachable only as a Composio tool |

### H. Platforms and surfaces

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| iOS app | yes | yes | present | `native/iOS/JunoMobile` |
| Android app | yes | yes | **missing** | `DownloadPlatform = "macos" | "windows" | "ios"` (`src/lib/app-downloads.ts:18`); Android UA gets no download (l.441); PWA manifest `src/app/manifest.ts` only |
| macOS app, quick entry | yes | yes | present | `native/macOS/JunoDesktop/App/DesktopQuickEntry.swift` |
| Windows app | yes | yes | unverifiable here | Separate repo `LiamMagnier/juno-windows` (`src/lib/app-downloads.ts:4,121`) |
| iOS widgets / app intents | yes | yes | present | `native/iOS/JunoMobile/Widgets/JunoMobileWidgets.swift`, `App/JunoMobileIntents.swift` |
| Browser extension / AI browser | yes (Atlas) | yes (Claude in Chrome) | **missing** | No extension manifest outside `node_modules`/artifacts |
| Excel / Sheets / PowerPoint add-ins | yes (Excel, Sheets GA 5 May) [O18] | yes (Excel, PowerPoint) | **missing** | No Office.js/Apps Script code |
| Health data | no | yes (US) | missing (low priority) | No HealthKit |

### I. Privacy and account

| Capability | CG | CL | Juno | Evidence |
|---|---|---|---|---|
| Data export | yes | yes | present | `src/app/api/account/export/route.ts:57` (JSON / CSV) |
| Delete account | yes | yes | present | `src/app/api/account/delete/route.ts:7` |
| Training opt-out | yes | yes | n/a / unverified | Juno sends data to third-party model APIs; no user "improve the model" toggle found. Whether a user-facing statement on provider training/retention exists was not checked |
| Encryption at rest of messages | not stated | not stated | present | `docs/JUNO.md` §14 (message bodies encrypted) |
| Privacy center | yes (Sep 2026) | partial | partial | Settings sections exist; no dedicated privacy hub verified |

---

## Prioritised build list (partial + missing)

Impact: H/M/L for the conversation-first, premium product in `PRODUCT.md`. Feasibility: what the codebase already has. Dependencies listed when an external vendor or marketplace is involved.

| # | Item | Who has it | Juno status | Size | Builds on | Dependency |
|---|---|---|---|---|---|---|
| 1 | Share a chat/artifact with specific people (email-restricted, signed-in viewers) | CL (default) | missing | M | `Share` model, `src/lib/share.ts`, `src/app/share/[token]`, `ProjectMember` invite flow, `src/lib/project-collaboration.ts`, notifications | none |
| 2 | Per-chat "memory off" without incognito | CL | partial | S | `src/lib/chat/turn/memory.ts`, `composer-plus-menu.tsx`, `Conversation` field, memory extractor/dreamer skip | none |
| 3 | AI-powered artifacts + persistent artifact storage | CL | missing | L | `sandbox-frame.tsx` postMessage bridge, turn pipeline + `request-meter`, `chat-budget-guard`, `rate-limit`, `artifact-publication.ts` (publish URL), `artifact-access.ts` | none (uses existing model providers; spend must bill viewer) |
| 4 | Export docs/decks to PDF (and Google Docs/Slides) | CL, CG (Slides) | partial | M (PDF) + S-M (Google, via connector) | `src/app/api/artifacts/[id]/export/route.ts`, `src/lib/office-export.ts`, semantic renderers, `src/lib/design/export.ts` PDF path; Google via `src/lib/connectors/google-drive.ts` | Google OAuth scopes (already used) |
| 5 | Locked chats (PIN + Face ID/Touch ID) | CG (20 Oct) | missing | M | `Conversation`, `/api/conversations` list + recall/search exclusion (`src/lib/recall/service.ts`), `src/lib/account-security.ts`, native `LocalAuthentication` | none |
| 6 | Attach from Google Drive / OneDrive in the composer | CG, CL | partial | M | `src/lib/connectors/google-drive.ts`, `microsoft-365.ts`, `library-picker.tsx`, `/api/library/attach`, attachment pipeline | none beyond existing OAuth |
| 7 | Connectors in voice mode | CL | partial | M | `relay/src/protocol.ts` delegate, `relay/src/providers/*-delegate`, `src/lib/mcp.ts`, action approvals `src/lib/action-approval.ts` | none |
| 8 | Characteristics sliders (warmth, enthusiasm, lists/headers, emoji) | CG | missing | S | `src/lib/personalities.ts`, `Settings.personality`, system prompt `src/lib/chat/system-prompt.ts`, settings personalization section | none |
| 9 | Connector-rendered interactive UI (MCP Apps / Apps SDK compatibility) | CG, CL | missing | L | `src/lib/mcp.ts` (resources + `_meta` UI), Live UI host `src/components/chat/live-ui/host.tsx`, `sandbox-frame.tsx` isolation, approvals | none (open spec); security review needed |
| 10 | Plugins: role bundles of skills + connectors | CG, CL | partial | M | `src/lib/skills/bundle*.ts`, skill repo import, `connector-directory.tsx`, Composio | Composio (existing) |
| 11 | Native (Mac/iOS) views for docs/sheets/decks | CG, CL (mobile apps view deliverables) | partial | L | sync entities `artifact`/`artifact_version`, `NativeArtifactKind` decode, semantic models (`capabilities.ts:620-621`) | none |
| 12 | Slack channel ("tag Alevr in Slack") | CL | missing | M-L | `src/lib/channels/{inbound,link,reply,webhook,store}.ts` abstraction (built for iMessage), agents | Slack app review / workspace install |
| 13 | Android app | CG, CL | missing | XL (native) / M (installable PWA polish + push) | `/api/v1` sync contract, `src/app/manifest.ts`, web push `src/lib/notify/web-push-shared.ts` | Play Store account |
| 14 | Browser extension (side panel, act in the user's logged-in browser) | CG (Atlas), CL (Chrome) | missing | L | Work hosts, `src/lib/secrets/browser-fill.ts`, teach recorder `src/lib/teach/recorder.ts`, approvals | Chrome Web Store review |
| 15 | Real-time co-editing of documents/decks with presence | CG (Space, Slides) | partial | XL | `src/lib/collaboration/crdt.ts` (unwired), semantic ops `src/lib/artifact-ops.ts`, `ProjectMember` roles, comments in semantic docs | realtime transport (could reuse `relay/`) |

Lower-priority gaps noted but not ranked: Excel/Sheets/PowerPoint add-ins (L-XL, marketplace review), break reminders / quiet hours (S), health data on iOS (M, HealthKit entitlement, US-only in CL), privacy hub page (S), personalized temporary chat (S, if incognito does not already read memory).

Not gaps (Juno equal or ahead): image generation and mask editing (Claude has none), voice screen share on web (ChatGPT Live and Claude lack it), claim-level citation audit, model compare, saved prompts, chat import from ChatGPT/Claude, iMessage texting, agent computers with takeover, credential vault, agent payment cards, teach-by-demo, design canvas with code export, publishing with version pin, monthly memory recap.

---

## Workflow-quality checks for a browser walkthrough

These are present in code but could be worse than ChatGPT/Claude; static review cannot tell.

1. **Artifact editing fidelity**: ask for a doc, then highlight-edit a paragraph (`canvas-panel.tsx:687`), then edit a sheet cell by chat (op-based edits). Confirm one new version per change, no full regeneration, restore works, DOCX/XLSX/PPTX open cleanly. Compare to Claude "Edit with Claude".
2. **Code execution availability and degradation**: with `TOOL_RUNTIME`/`CODE_INTERPRETER_URL` unset, upload a CSV and ask for a chart. Check that the degradation message (`effective-capabilities.ts:275`) is clear and that a configured sandbox returns charts within the 90 s inline wait.
3. **Search and citation usefulness**: everyday questions. Check the activity indicator, the sources pill, the citation audit and whether citations land on the supporting passage.
4. **Deep research end to end**: plan editing, interrupting, leaving and returning (durable run), notification on completion, report export (print-to-PDF only).
5. **Memory transparency**: "remember X", "forget X", memory-updated notice, editing a fact, sensitive topics, project isolation, incognito behaviour. Confirm that deleted memories stop influencing answers.
6. **Voice**: time to first audio, barge-in, web screen share flow (permission, 2 fps frames), iOS camera, transcript saved to the chat, memory used, web search during a call.
7. **Share links**: the snapshot renders artifacts and Live UI correctly, the branch is pinned, revoke 404s immediately, OG card, mobile rendering. Compare to the ChatGPT and Claude share pages.
8. **Agent computer workflow**: live view latency, login/2FA handoff, vault fill without exposing the secret, payment-card approval prompt, pause/stop, and what the user sees after closing the tab.
9. **Composer and transcript basics**: model/effort discoverability, attachments (drag, paste, large files, plan cap message), stop then retry, edit then branch pager, long-answer scroll anchoring, keyboard shortcut sheet, mobile keyboard.
10. **Automations by conversation**: "every weekday at 8 brief me on my inbox" creates a WorkSchedule from chat (routine proposal card), Run-now, event trigger, missed-run behaviour, notifications on web and iOS.

Also worth checking: the capability registry (`src/lib/capabilities.ts`) still marks teach and external channels as disabled with no evidence. Any UI or marketing that reads it will under-report shipped features.

---

## Sources

OpenAI (fetch blocked; claims from search excerpts of these official pages unless marked press):
- [O1] ChatGPT release notes: https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [O2] GPT-6 and Intelligent UI for everyone: https://openai.com/index/gpt-6-for-everyone/ (press corroboration: https://9to5mac.com/2026/10/07/openai-brings-gpt-6-to-chatgpt-and-debuts-intelligent-ui/)
- [O5] ChatGPT agent (now retired, points to Work): https://help.openai.com/en/articles/11752874-chatgpt-agent
- [O6] ChatGPT Work and Codex: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex; Creating documents, spreadsheets, presentations with ChatGPT Work: https://help.openai.com/en/articles/20001278-creating-and-editing-documents-spreadsheets-and-presentations-with-chatgpt-work
- [O7] Creating and using ChatGPT Sites: https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites
- [O8] Plugins in ChatGPT: https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- [O9] Custom GPT retirement and migration FAQ: https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq
- [O10] Skills in ChatGPT: https://help.openai.com/en/articles/20001066-skills-in-chatgpt
- [O11] Using locked chats in ChatGPT: https://help.openai.com/en/articles/20001411-using-locked-chats-in-chatgpt
- [O12] Retiring group chats in ChatGPT: https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt
- [O13] Scheduled tasks in ChatGPT: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt; Deep research in ChatGPT: https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt
- [O14] Model release notes (canvas removal): https://help.openai.com/en/articles/9624314-model-release-notes
- [O15] Community feedback on writing blocks vs Canvas (user reports): https://community.openai.com/t/please-restore-canvas-as-a-persistent-workspace-writing-blocks-are-not-an-equivalent-replacement/1398999
- [O16] ChatGPT Voice: https://help.openai.com/en/articles/8400625-voice-mode-faq; Introducing GPT-Live: https://openai.com/index/introducing-gpt-live/
- [O17] Images in ChatGPT: https://help.openai.com/en/articles/11084440-images-in-chatgpt
- [O18] ChatGPT for Excel and Google Sheets: https://help.openai.com/en/articles/20001063-chatgpt-for-excel-and-google-sheets
- [O19] ChatGPT Atlas release notes: https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes
- [O20] Memory in ChatGPT: https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- [O21] Data controls in ChatGPT: https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt
- [O22] Characteristics in ChatGPT: https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt; Customizing your ChatGPT personality: https://help.openai.com/en/articles/11899719-customizing-your-chatgpt-personality
- [O23] Sharing conversations and scheduled tasks: https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq
- [O24] Projects in ChatGPT: https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- Developer mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta; Instant Checkout: https://openai.com/index/buy-it-in-chatgpt/
- Getting started with your dot: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot

Anthropic (fetched directly unless noted):
- [C1] Claude release notes: https://support.claude.com/en/articles/12138966-release-notes
- [C2] Claude Cowork and chat are one Claude: https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- [C3] What are artifacts and how do I use them?: https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- [C4] Use interactive connectors in Claude (search excerpt): https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- [C5] Custom connectors using remote MCP (search excerpt): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- [C6] Chat search and memory: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- [C7] Share a chat with specific people: https://support.claude.com/en/articles/16762496-share-a-chat-with-specific-people
- [C8] Use voice mode: https://support.claude.com/en/articles/11101966-use-voice-mode
- Create and edit files with Claude (search excerpt): https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude; Skills: https://support.claude.com/en/articles/12512176-what-are-skills; Export data: https://support.claude.com/en/articles/9450526-export-your-claude-data; Computer use in Cowork: https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork

Press / secondary (lower confidence):
- [P1] TechCrunch, dots: https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
- [P2] The Next Web, dots with cloud computers: https://thenextweb.com/news/openai-dots-always-on-ai-agents-cloud-computers-devday
- [P3] ChatGPT on X, texting your dot: https://x.com/ChatGPT/status/2115496387613786374
- [P4] ChatGPT Space coverage: https://www.androidheadlines.com/2026/09/openai-launches-chatgpt-space-collaborative-hub.html
- [P5] Claude Duet: https://x.com/claudeai/status/2112984664256241837, https://betanews.com/article/proactive-ai-agent-claude-duet/
- [P6] Claude in Chrome as Cowork session: https://9to5mac.com/2026/08/12/claude-cowork-chrome/
- [P7] No native Claude image generation (blog sources only): https://dev.to/tariqhassan/can-claude-generate-images-what-actually-works-in-2026-2mlg
