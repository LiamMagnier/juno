# Gap audit: the native wire and the persistence contract

A read-only audit of the `web/tools-thinking-research` worktree. It lists every consumer of:

- the `/api/chat` SSE frames;
- the activity event fields and their literal titles;
- the persisted `Message` fields;
- the `/api/research/*` endpoints.

It then judges each `DECISIONS.md` item against that list.

**The decisions version used.** `DECISIONS.md` changed while this audit ran. It gained §4b,
"Resolutions of the audit critic's contradictions" (`DECISIONS.md:279-315`). Everything below is
judged against the current 325-line file, §4b included.

**What is shipped.**

- **Mac.** The Mac app is at 1.6.0, build 87 (`native/Config/Base.xcconfig:8-9`). Tag `v1.6.0` points
  at `d0997af2`.
- **iOS.** iOS reads the same `Base.xcconfig`, so its builds also carry 1.6.0 (87).
  - The repo describes a TestFlight path (`docs/native/RELEASE.md:217-261`) but holds no evidence of a
    public release.
  - Any installed iOS build uses the same `JunoChatKit` decoder as the Mac.
- **Line numbers are the shipped code.** Every `JunoChatKit` and app file cited below is byte-identical
  between `v1.6.0` and this worktree's HEAD. `git diff v1.6.0 HEAD -- native` touches only the Library
  files from `7f92324f`.
- **v1.5.4 is just as strict.** It has the same `default: throw`
  (`git show v1.5.4:…/NativeChatAPIClient.swift:1230-1231`).

---

## 0. Verdict

1. **Any new SSE `type` breaks every installed native build.**
   - `NativeChatAPIClient.decodeEvent` ends in `default: throw NativeChatAPIError.malformedResponse`
     (`NativeChatAPIClient.swift:1230-1231`).
   - That error is not retryable (`:655-661`), so the turn is marked failed with "Juno returned an
     invalid chat response." (`:643-645`, `NativeConversationStore.swift:1972-1993`).
   - Meanwhile the server keeps generating and persisting the answer (`chat-stream.ts:53-56,73-79`).
   - The Retry button that is left behind regenerates, and bills, a second time
     (`NativeConversationStore.swift:2060`).
   - §4b's "No new SSE frame types" (`DECISIONS.md:284-289`) is therefore correct and necessary. It
     is not sufficient, as the next points show.
2. **The server already breaks this rule once.**
   - `createSseSender` sends `{type:"resume", available:false}` to every saved-chat stream whose frame
     log fails or reaches its cap (`chat-stream.ts:86-90`; `stream-log.ts:35,66-68`).
   - That includes native streams, and the decoder shipped in 1.6.0 throws on it.
   - Only the unshipped Mac redesign branch tolerates it (§1.2).
3. **Unknown fields are safe. Retyped fields are not.**
   - Native ignores keys it does not declare.
   - But every declared envelope key is decoded with `try` as a fixed type
     (`NativeChatAPIClient.swift:1639-1660`). A frame that reuses `text`, `title`, `error`,
     `sources`, `stage` or `pct` with a different shape is fatal. This holds even on the tolerant Mac
     branch.
   - `sources`, `done` and `approval` also carry value checks that are fatal. `validText` refuses
     empty strings and any control character, newlines included (`:1345-1348`).
4. **§4b is right to keep native research on the in-chat path** (`DECISIONS.md:306-310`).
   - Native has no `/api/research/*` client at all (§1.6).
   - Its progress UI reads the chat stream only
     (`DeepResearchActivityProjection.swift:127-172`, `NativeSearchActivity.swift:13-70`).
   - Its reconnect gives up after about 12 backoff attempts (`NativeConversationStore.swift:1997-2036`).
   - But the web-path research message (R3) is still read by native **across devices** through sync
     (`sync-entities.ts:137-178`). Its persisted shape is therefore a native contract too (§3, R3).
5. **Bumping `CONTRACT_VERSION` is not a compatibility strategy. It is a kill switch.**
   - Installed apps compare it for exact equality at sign-in and at bootstrap
     (`NativeAuthAPIClient.swift:294-298`, `NativeBootstrapClient.swift:98-102`).
   - A bump signs every app out with "This version of Juno is not compatible with the server."
     (`NativeAuthAPIClient.swift:25-26`).
   - `minimumSupportedAppVersion` is decoded but never enforced, and its value is "3.0.0"
     (`api/v1/auth/session/route.ts:23`, `JunoNativeContract.swift:43`).
6. **§5 "no Swift change" cannot hold everywhere.**
   - The Library fix on this same branch already changed Swift (`7f92324f`).
   - R1's "'Deep' is dropped from every UI string" includes strings compiled into the apps.
   - §6 lists every such place.

---

## 1. Consumer inventory

Strictness uses these words:

- **fatal**: ends the stream or the turn.
- **dropped**: the item is ignored.
- **tolerant**: kept as unknown.
- **n/a**: the consumer never sees it.

### 1.1 Shipped native (Mac 1.6.0/87 and iOS; shared `JunoChatKit`)

| file:line | What it consumes | Unknown frame `type` | Unknown / retyped field | Title and literal dependence |
|---|---|---|---|---|
| `NativeChatAPIClient.swift:1125-1233` (`decodeEvent`) | The frame switch: `meta` `title` `delta` `reasoning` `sources` `done` `error` `activity` `approval` `progress` `ping` | **fatal**, `default: throw` at `:1230-1231` | Unknown keys ignored (synthesized `Decodable`, `CodingKeys` at `:1634-1637`). Retyped reserved keys are **fatal**: `type`, `conversationId`, `userMessageId`, `title`, `generationId`, `text`, `stage` must be strings, `pct` a number, `sources` an array of `SourceWire`, `error` and `finishReason` strings (`:1641-1659`) | — |
| `NativeChatAPIClient.swift:1592-1661` (`EventEnvelopeWire`) | `event` via `try?`: a bad activity becomes `.ping` (`:1654-1656`, `:1204`). `approval` via `try?`, then **fatal** if nil (`:1657`, `:1212-1215`). `message` via `try?`, then **fatal** on `done` if nil (`:1652`, `:1168-1173`) | — | `ActivityWire` requires `id`, `kind` and `title` strings. `detail` and `url` are optional (`:1593-1599`) | — |
| `NativeChatAPIClient.swift:1133-1151` | `meta` and `title`: `conversationId` and `title` non-empty, at most 256 / 1,000 bytes, no control characters | — | **fatal** if they fail | — |
| `NativeChatAPIClient.swift:1152-1161` | `delta.text` and `reasoning.text`, each at most 64 KiB. `reasoning.part` is ignored | — | **fatal** above 64 KiB | — |
| `NativeChatAPIClient.swift:1162-1166, 1235-1244` | `sources`: at most 100. Each `title` non-empty, single line, at most 2,000 bytes. `url` must be `http(s)` with a host. `snippet` a string, at most 32 KiB | — | **fatal** for the whole frame on one bad source | — |
| `NativeChatAPIClient.swift:1167-1190` | `done.message`: `id`, `role == "ASSISTANT"`, `content` at most 4 MiB, `createdAt` ISO, plus `reasoning`, `model`, `sources`, `finishReason` and token and cost fields | — | **fatal** if any check fails. `message.sources` uses the strict source rules above | `finishReason` unknown → `.unknown` (tolerant, `:256-266`, `:1174-1176`) |
| `NativeChatAPIClient.swift:1191-1202` | `error`: `message` (or `error`) string, non-empty, single line, at most 32 KiB | — | **fatal** if it fails | — |
| `NativeChatAPIClient.swift:1246-1299` | `approval`: every `ClientActionApproval` key. `preview` non-empty, **single line**, at most 8 KiB. `detail` at most 100 keys. Dates parsed | — | **fatal** on a failed check. Unknown `riskClass` → `.unknown`. Unknown `status` → `.blocked`, which hides the buttons (`:1271-1276`) | — |
| `NativeChatAPIClient.swift:349-370` | Activity `kind`: `context model reasoning search visit write usage done warning tool` | — | Unknown kind → `.unknown` (tolerant) | — |
| `NativeChatAPIClient.swift:1506-1530, 961-983` | The request it sends: `conversationId model regenerate:true reasoningEffort generationId client:"app"`. Each of `deepResearch webSearch connectors fastMode proMode` is **omitted when off**. `canvasEnabled` is sent explicitly. **No `researchEffort` and no `origin`** | — | — | "Absent means off" is load-bearing (`:1513-1521`) |
| `NativeChatAPIClient.swift:1062-1095` | The stream relay: any decode error → `continuation.finish(throwing:)` | — | — | — |
| `NativeChatAPIClient.swift:871-935` | `GET /api/approvals?conversationId&includeRecent=1` and `POST /api/approvals/{id}` with the digest echo. Recovery after a missed stream | — | Same strict approval decode | — |
| `NativeConversationStore.swift:1889-1995` | Stream loop: `textDelta` → append (`:2104-2106`); `reasoningDelta`; `sources` replace; `activity` → `recordActivity`; `approval` → upsert; `completed` → `completeAssistant` **replaces** content, reasoning and sources from `done` (`:2065-2087`) | fatal (propagated) | — | — |
| `NativeConversationStore.swift:973-982, 953-961, 1709` | `researchActivity`: upsert by `id`, **fed by every activity of every turn**, cleared only when the next turn is sent. `researchDegradedWarning` = last `kind == warning`, shown as `detail ?? title` | — | tolerant | Any `warning` row is shown as a research warning |
| `NativeConversationStore.swift:2038-2048, 1997-2036, 2465-2469` | Recovery: retries only `streamEndedWithoutTerminalEvent` and retryable server errors. It polls sync up to 12 times for **any assistant row created after the user turn** | — | — | A placeholder or early-persisted assistant row would end recovery wrongly |
| `NativeConversationStore.swift:515-546, 2662-2686` | The synced `message` entity: `id conversationId clientId role content reasoning model costMicroUsd cacheRead/Write promptTokens completionTokens feedback createdAt`. `content` is **required** | n/a | A missing `content` or a bad date → `corruptRecord` | No `sources`, `activity`, `approvals` or `finishReason` on synced rows |
| `NativeConversationStore.swift:726-732, 2121-2154` | Approvals are kept **outside** message rows, merged by id. `/api/approvals` is the recovery source | — | — | — |
| `NativeSearchActivity.swift:13, 21-27` | The query = `detail` of the last `{kind: search, title: "Searching the web"}` | — | — | **Exact title** |
| `NativeSearchActivity.swift:38-59` | Sites = every activity with a `url`, **any kind**, deduplicated, each shown as a done row | — | — | Every row with a `url` becomes a "source" |
| `NativeSearchActivity.swift:67-70` | Settled = `{kind: context, title: "Research corpus ready"}` **or** any `kind == write` | — | — | **Exact title**, plus the `write` kind |
| `DeepResearchActivityProjection.swift:125-157` | Queries = unique `detail` of "Searching the web" rows. Warnings = every `warning` shown as `title — detail` | — | — | **Exact title** |
| `DeepResearchActivityProjection.swift:165-172` | Phase is decided by kind precedence: `done` → completed, `write` → synthesizing, `visit` → reading, `search` → searching | — | — | Kinds are load-bearing |
| `DeepResearchActivityProjection.swift:182-215` | Citation registry built positionally from `done` sources. Unmapped `[n]` markers are stripped | — | — | Source order = citation numbers |
| `DeepResearchContracts.swift`, `DeepResearchCoordinator.swift:29-43` | Local on-device research engine | n/a | n/a | No server coupling |
| `NativeResearchEffort.swift:18-45, 67-91` | Display-only depth: "Quick/Standard/Deep/Max". The summaries are **stale** against the server (`internal-research-ui.md` §J10). It is **never sent** (not in `GenerationRequestWire`) | n/a | n/a | Compiled-in level names |
| `NativeChatApproval.swift:9-27` | Closed enums: `riskClass` (5 values) and `status` (9 values, the server's `ACTION_RECEIPT_STATUSES`, `action-approval.ts:45-55`) | — | Unknown values degrade (see above) | — |
| `NativeChatApprovalView.swift:70-123, 135-173` | Buttons only when `.pending`. Copy per risk and status | — | `.blocked` for an unknown status means **no buttons** | — |
| `NativeMessageContent.swift:211-216` | Parses `<juno:memory>`, `<juno:artifact …>` and the `:::clarification-wizard` fence out of `content`. **The research report is shown only through its `research-report` artifact tag** | n/a | Any other `<juno:*>` tag renders as raw text | Tag grammar |
| `ChatStreamReducer.swift:21-26, 101-113` | A `seq`-gap-strict reducer with `ChatToolPhase {pending, running, succeeded, failed}` | — | — | **No production caller** (grep). A precedent only |
| iOS `JunoMobileComposer.swift:151-158, 293-301` | Derives the depth for display. Shows `JunoMobileResearchProgress` whenever `researchActivity` is non-empty, which is **every turn that emitted activity** | — | — | — |
| iOS `JunoMobileResearchProgress.swift:31-33, 53-89, 101-149, 152-176, 190-204` | A 5-stage rail driven by the projection; the counts line; the search block; "research.enabled · {Quick…Max}" plus the stale summary; the warning row | — | — | Titles and kinds, as above |
| iOS `JunoMobileThoughtProcess.swift:26-35, 236-243` | Only `streaming`, `writing` (content non-empty), `reasoning` and a local clock. No persisted events | — | — | Commentary deltas count as "writing" |
| iOS `Localizable.xcstrings:2546, 5003, 5037` | The strings "Deep research", "Deep research is on", "Deep research" | n/a | n/a | Compiled-in "Deep" |
| macOS `DesktopChatWorkspace.swift:956-972` | Approval cards from the store (stream plus `/api/approvals`) | — | — | — |
| macOS `DesktopChatWorkspace.swift:1019-1021, 1944-1978` | The "Research activity" GroupBox while generating, when there is a query or sites | — | — | Titles, as above |
| macOS `DesktopSearchScreen.swift:263-329` | The research strip: phase, counts and the first warning | — | — | Titles and kinds |
| macOS `DesktopComposer.swift:732`, `ProjectWorkspaceStore.swift:57` | The "Deep research" label | n/a | n/a | Compiled-in "Deep" |
| `NativeFollowUpClient.swift:41`, `NativeVoiceTranscriptClient.swift:253-256`, fork, share, `account/export`, library | Other `/api/*` routes that native calls (every `"/api/…"` literal in `JunoChatKit`) | n/a | Minimal decodes | — |

### 1.2 Unshipped clients

| Where | What differs | Status |
|---|---|---|
| Branch `mac/liquid-glass-chat` (`213c4315`), `NativeChatAPIClient.swift:1245-1256, 1355-1373` | Reads `type` first and **skips unknown types as `.ping`**. Decodes `resume`, `done.artifacts` and `message.attachments` (lossy). Sends `regenerateInstruction`. Commit `675a73f4` | **Not** an ancestor of `v1.6.0` or of `origin/main` (verified with `git merge-base`). Known frame types still decode reserved keys strictly |
| Same branch, `docs/native/MACOS_PHASE2_TRANSCRIPT_BRIEF.md:756-783` | Addendum: "Wire changes… All of them are additive… Decode these fields when present and fall back to today's fields when absent." "The server will ignore `researchEffort`" | Brief only |
| `native/desktop-electron` (`package.json` 0.1.0, private) | `wire.ts:416-497` classifies unknown types as `unreadable` and **counts** them without failing. Zod objects are non-strict. Sources default missing strings to `""` (`:116-121`). Sends `origin: "main_macos"` (`service.ts:174, 442`), so the server bills it as `"app"` | Tolerant, unshipped |

### 1.3 Contracts and generated code

| file:line | What it says | Enforced at runtime? |
|---|---|---|
| `contracts/openapi/juno-native-v1.yaml:4, 9-14` | Version `1.3.0`. The version "moves only on a change that an older client cannot survive" | **Yes**, by exact-equality checks (`NativeAuthAPIClient.swift:294-298`, `NativeBootstrapClient.swift:98-102`). The server sends it from `api-v1.ts:6` (`auth/session/route.ts:22`, `bootstrap/route.ts:45`) |
| `juno-native-v1.yaml:280-309` (`streamNativeChat`) | Lists "meta, activity, delta, reasoning, sources, ping, done or error" | Documentation only |
| `juno-native-v1.yaml:1662-1672` (`ChatSSEEvent`) | A closed `oneOf` of 8. **It omits `title`, `approval`, `progress` and `resume`**, which native decodes or receives | Documentation only. **Already inaccurate** |
| `juno-native-v1.yaml:1692-1706` | `ChatDeltaEvent` and `ChatReasoningEvent` have `additionalProperties: false` | Documentation only. Adding `round` contradicts the document, not the decoder |
| `juno-native-v1.yaml:1685-1691` | `ChatActivityEvent.event` is `additionalProperties: true` | — |
| `juno-native-v1.yaml:1630-1640` | `NativeChatGenerationRequest` has `additionalProperties: false` but lists none of `deepResearch webSearch canvasEnabled connectors fastMode proMode`, all of which native sends | Documentation only. **Already inaccurate** |
| `scripts/generate-native-swift-contract.mjs` | Emits only the version, digest, redirects and auth/bootstrap DTOs. **The chat decoder is hand-written**, so an OpenAPI edit changes nothing on the device | — |
| `tests/native-contract.test.ts:20-34` | Asserts only that the operation ids and the `x-juno-event-schema` string exist | **No frame-conformance test exists** |
| `contracts/capabilities/juno-capabilities-v1.json` (version 3) → `JunoCapabilityContract.swift` | Model and plan capabilities, plus `actionApproval` and `action_approval_unavailable` | The version is not compared by any client (grep). It is safe to extend |
| `contracts/work/juno-work-v1.json` → `JunoWorkContract.swift`, `JunoWorkVocabulary.swift:145-190` | Work statuses, approval decisions, risk levels and event kinds. Swift maps unknown values to vague English | See §8 |

### 1.4 How the server tells native from web, and what is already gated

| Signal | Where | Who sends it |
|---|---|---|
| `client: "web" \| "app"` | `request.ts:163-165`, resolved by `legacyChatClientForOrigin` (`chat-origin.ts:34-40`, `route.ts:578`) | Native sends `"app"` (`NativeChatAPIClient.swift:952, 974`). **The web sends nothing** (`use-chat.ts:1296-1325`), so it becomes "web". Electron sends `origin: "main_macos"`, so it becomes **"app"** |
| `workHandoff: true` | `request.ts:154-161`, `task-tool.ts:159-161`, `route.ts:2229-2245` | Web only (`use-chat.ts:1320`). The precedent for a client-declared capability |
| Bearer versus cookie auth, and `NativeDeviceSession.appVersion` | `native-request.ts:3-7`, `native-auth.ts:131, 275` | `appVersion` is written **only at sign-in**, so it goes stale after auto-update. It cannot be used as a gate |

| Frame or behaviour | Gated? | Evidence |
|---|---|---|
| `work` | Yes, by `workHandoff` → `taskToolOn` | `route.ts:2911, 2932-2936` |
| `progress` | Yes, `/api/generate` only | `types/chat.ts:381` |
| `resume {available:false}` | **No.** Every saved stream | `chat-stream.ts:86-90`. **Fatal on 1.6.0** |
| `resume {refetch:true}` | Yes. Only `GET /api/chat/stream/*`, which native never calls | `use-chat.ts:796`. Not in native's path list |
| Research plan gate | Yes, by `client` | `deep-research.ts:241`: `web` requires confirmation, `app` confirms automatically |
| Research effort | The server derives it and ignores the client | `route.ts:2801-2809` (`input.researchEffort` only when there is no `modelInfo`) |
| `canvasEnabled:false` | Legacy native only | `request.ts:90-95` |
| Frame log (ids, replay) | Saved chats only | `stream-log.ts:66-68`. The `id:` lines are ignored by native's parser (`NativeChatAPIClient.swift:1726-1728`) |

**A stale comment.** `request.ts:90-95` says the body schema is `.strict()`. It is not:
`chatBodySchema` is a plain `z.object(...).superRefine` (`request.ts:68-208`), so unknown keys are
**stripped**. It must stay that way. A strict schema would turn every newer client field into a 400
on an older or rolled-back server.

### 1.5 Server and web consumers of the persisted `Message` fields

`Message` columns (`prisma/schema.prisma`, the `model Message` block): `content`, `reasoning`,
`reasoningParts Json?` (an array of encrypted strings), `sources Json?`, `activity Json?`, token and
cost columns.

There is **no `finishReason` column**. It exists only on the `done` frame and on the first-submission
receipt (`route.ts:3180`). `serializeMessage` never emits it (`serializers.ts:162-197`).

`MessageVersion` snapshots only `content`, `reasoning`, `model`, the tokens and `sources`
(`assistant-turn.ts:146-158`).

| Consumer | file:line | Reads | Notes for the rework |
|---|---|---|---|
| Thread loader, `done` frame | `serializers.ts:162-197`, `queries.ts:126`, `route.ts:3192, 3315` | Everything. `activity` through the **whitelist** `serializeActivity` (`:71-117`). `ACTIVITY_KINDS` (`:28-39`) drops `artifact` and any new kind. `memoryReceipt` and `artifactVerification` are dropped | A new field or kind must be added here, or it streams and then vanishes. **No `approvals`** |
| Other `serializeMessage` callers | `api/code/tasks/route.ts:362, 627`, `api/code/tasks/[id]/steer/route.ts:192`, `api/code/tasks/[id]/events/route.ts:177`, `api/voice/transcript/route.ts:58`, `api/generate/route.ts:299` | The same | Juno Code writes the same `activity` column (`code-task-outcome.ts:98-247`, `patch`/`exitCode` at `serializers.ts:95-111`) |
| Sync `message` entity to native | `sync-entities.ts:137-178`, trigger at `migrations/20260716200000_account_change_log/migration.sql:113` | `content`, `reasoning`, tokens, cost, feedback | **Every INSERT or UPDATE of a Message row reaches every device.** Native renders `content` only |
| Sync `message_version` | `sync-entities.ts:179-198` | `content`, `reasoning` | — |
| Model history | `route.ts:1853-1861` (all columns); `anthropic.ts:101-103`, `openai-compat.ts:87-90`, `openai-responses.ts:68-73`, `gemini-core.ts:58` | Assistant `content` only | T7 adds a note here. Prompt-cache key `route.ts:2979` |
| Private history | `request.ts:166-174`, `use-chat.ts:1322-1325`, `NativeChatAPIClient.swift:558-571` | `{role, content}` only | T7 cannot apply to private turns without a schema change |
| Memory, artifacts, forget | `route.ts:3058-3060, 3122-3143` (`parseMemories(acc.text)`, `prepareChatArtifactOutput(acc.text)`) | The accumulated text **of every round** | The commentary split must not lose tags |
| Post-stream research audit (native path) | `route.ts:3546-3613` | `assistantFull`; it rewrites `content` and the artifact | Unchanged by §4b |
| Public share | `share.ts:190-231` | `content` only. **`activity` is deliberately never selected** (`:202-210`) | Tool records and approvals must never reach the share select |
| Chat search | `search/engine.ts:528-575` | `content` only | Commentary becomes unsearchable. Fine |
| In-thread find | `conversation-search.ts:62-83` | Loaded `content` | — |
| Follow-ups | `api/chat/follow-ups/route.ts:103-118` | `content` | Also called by native (`NativeFollowUpClient.swift:41`) |
| Titles | `titles.ts:110, 143-156` | `content` | — |
| Account export | `api/account/export/route.ts:106-122, 236-243, 300-315` | A select whitelist including `reasoningParts`, `sources`, `activity` (decrypted) | A new column needs adding. Native downloads this route |
| Import | `api/import/route.ts:669-679`; `history-import.ts:432-441` | `reasoningParts` (strings), `sources`, `activity` (raw, re-encrypted) | Must accept rows from older and newer builds |
| Fork | `api/conversations/[id]/fork/route.ts:66-95` | Copies `sources` and `activity` raw. **Already drops `reasoningParts`** | A new column needs adding. Approval hydration must survive a fork |
| Chat stream log and replay | `stream-log.ts:36-47`, `stream-replay.ts`, `chat-stream-log-store.ts:24, 29` (retention 10 min after the end, 24 h if abandoned) | Frames written verbatim | A new web client can replay frames logged by the old server during a deploy |
| Web reconnect | `use-chat.ts:504-511` (sequencer), `:759, 796` (resume) | Frames | — |

### 1.6 The `/api/research/*` endpoints

| Endpoint | Consumers | Native? |
|---|---|---|
| `GET /api/research?conversationId=` | `components/research/use-conversation-run.ts:45` (polled every 4 s) | **No** |
| `GET /api/research/[id]?after=` | `components/research/use-research-run.ts:248`. The view builds `plan.effort` (`research/run.ts:704, 867`), read at `research-console.tsx:146` → `run-controls.tsx:469` | **No** |
| `POST /[id]/plan`, `/clarify`, `/steer`, `/control` | `use-research-run.ts:321` | **No** |
| `POST /api/research` (`effort`, `protocol.ts:64`, `route.ts:96`) | No UI caller | No |
| `GET /api/research/citations?messageId=` | `components/chat/citation-audit.tsx:165` | No |
| `ResearchRun` rows (not HTTP) | The PM2 worker `scripts/research-worker.ts`; `planBudget`/`parseBudget` (`domain.ts:1324-1326, 1414-1419`); `judgeCallsForEffort` (`:1596-1598`); `engine.ts:1577, 1616, 1714, 3527` | — |
| Research APNs push | `engine.ts:1437-1448` → `apns.ts:362-392` (`TASK_COMPLETION`) | Shown as an alert. No Swift parses the payload (grep) |

There is **no native consumer** of `/api/research/*`: `/api/research` appears in no native Swift
path. Native research lives entirely in the chat stream.

### 1.7 The web client as a consumer (live, stale tabs, replay)

- **Tolerant of unknown types.** The frame `switch` has no `default` (`use-chat.ts:511-728`), and
  malformed JSON frames are skipped (`chat-stream.ts:151-159`).
- **`done` replaces the whole message** with the serializer's output (`use-chat.ts:658-688`,
  `chat-client-state.ts:22-40`).
  - Empty `content` becomes an error card.
  - T6's fallback ("if the final round wrote nothing, the fallback is today's concatenation") is
    therefore mandatory, not cosmetic.
- **The current UI keys on titles.** `thought-process-model.tsx:149-152, 232-233, 366-373, 406` and
  `activity-timeline.tsx:67, 73`.
  - A stale tab keeps doing so until it reloads.
  - The server must keep writing the legacy titles, as §4b says.
  - The new UI may stop reading them, except inside the legacy adapter.

---

## 2. What exactly a shipped build accepts: "profile 1"

This is the frozen grammar. Everything the server sends to a request that has not opted in (§4)
must satisfy it.

1. **Frame types.** Only `meta`, `title`, `activity`, `approval`, `sources`, `reasoning`, `delta`,
   `done`, `error`, `ping`. `progress` is allowed on `/api/generate` only. Never `resume`, `work` or
   anything new (`NativeChatAPIClient.swift:1132-1231`).
2. **Reserved top-level keys keep their JSON type on every frame** (`:1641-1659`):
   - strings: `type`, `conversationId`, `userMessageId`, `title`, `generationId`, `text`, `stage`,
     `error`, `finishReason`;
   - a number: `pct`;
   - an array of source objects: `sources`;
   - an object on `done`, or a string on `error`: `message`;
   - objects: `event` and `approval`.
3. **Value rules that are fatal.**
   - `meta` and `title`: `conversationId` at most 256 bytes and `title` at most 1,000, both non-empty
     and single-line (`:1133-1151`).
   - `delta` and `reasoning`: `text` at most 64 KiB (`:1152-1161`).
   - `sources`: at most 100. Each has a non-empty, single-line `title` of at most 2,000 bytes, an
     `http(s)` `url` with a host, and a string `snippet` of at most 32 KiB (`:1162-1166, 1235-1244`).
   - `done.message`: `role == "ASSISTANT"`, `content` at most 4 MiB, an ISO `createdAt`, and sources
     that meet the same rules (`:1167-1190`).
   - `error.message`: non-empty, single-line, at most 32 KiB (`:1191-1202`).
   - `approval`: every field present. `preview` and the labels non-empty and single-line. `detail` at
     most 100 keys (`:1246-1269`).
4. **Semantic dependencies. These are not fatal, but visibly wrong if broken.**
   - `{kind:"search", title:"Searching the web", detail:<query>}` supplies the query.
   - `{kind:"context", title:"Research corpus ready"}` and the first `kind:"write"` settle the search
     block.
   - `kind:"done"` marks completion.
   - `visit` rows carry `url`.
   - Every `warning` is a reader-facing research warning on iOS and in the Mac search strip.
   - `done.message.content`, `reasoning` and `sources` replace the live bubble.
   - Absent request flags mean "off".

**Server risks today.** `search-engine.ts:464, 494, 563, 636` can produce `title: ""`.
`seedSources` does no normalisation (`stream-accumulator.ts:141-150`). Deep research already sends
Juno-search sources to native (`route.ts:2824-2825`). T3 extends Juno search to every model, which
multiplies the exposure to rule 3.

---

## 3. Compatibility matrix (one row per decision)

"Breaks 1.6.0?" means: does a shipped Mac or iOS build fail or mislead with no Swift change?

| Decision | Wire or row change | Consumers affected | Breaks 1.6.0? | Compatible strategy |
|---|---|---|---|---|
| **T1 RC-1** (runtime tools classified by risk; `onApprovalRequest`) | Approvals now possible for `connectorId:"juno_runtime"` (`agent/runtime.ts:97-106`). Under §4b every listed runtime tool is a `read` (`DECISIONS.md:300-303`), so in practice none | Native approval card (`NativeChatAPIClient.swift:1246-1299`); `/api/approvals` | **No**, if the preview is single-line (`action-approval.ts:387-411` builds a single-line sentence today) | Additive. Keep previews single-line and never built from raw multi-line arguments |
| **T1 RC-3** (connector failure warning rows) | New `kind:"warning"` rows | iOS shows the last warning above the composer on **every** turn (`JunoMobileComposer.swift:293-301`, `NativeConversationStore.swift:958-961`); the Mac search strip shows the first (`DesktopSearchScreen.swift:296-302`) | No. The copy reads as "research degraded" | Keep `detail` short. Accept, or use `kind:"tool"` for per-connector notices in profile 1 |
| **T1 RC-4/5/7/13/14** | Server internal | — | No | — |
| **T2** ToolSpec `risk` | A new vocabulary (`read/write/external/destructive`) | The approval `riskClass` (`NativeChatApproval.swift:9-15`) | **Degrades** if put on the wire. Unknown values become "Unverified action" in danger styling (`NativeChatApprovalView.swift:141, 147-157`) | Map to `ActionRiskClass` (read→`read_only`, write→`reversible_write`, external→`external_write`, destructive→`destructive_or_sensitive`). Never send the T2 names in `approval` |
| **T2** human labels, "never a raw tool id" | Legacy rows carry `title:"Using {label}"` and `detail: <function id>` (`route.ts:395-396`) | Web legacy rendering; native shows no tool names | No | A legacy id→label table in the web adapter |
| **T3** `code_interpreter` → `run_code`; `browser_agent` removed; `web_fetch` added | Tool ids change | Skill `requestedTools`, matched by exact string (`chat/skills.ts:314-325`, `skills/sources.ts:224-241`); standing grants keyed by `(connectorId, scopeKey, toolName)` (`action-approval-store.ts:624-640`); prompt copy (`prompt-sections.ts:44`, `context-assembly.ts:281, 292`); the agent runtime's `suggestedTools:["browser_agent"]` (`agent/runtime.ts:330, 347`); legacy activity `detail`; T7 notes | **No** for native, which never reads tool ids. **Yes server-side**: a skill that lists `code_interpreter` silently loses `run_code` | An alias map (`code_interpreter`→`run_code`, `browser_agent`→`web_fetch`) applied to skills, grants, legacy rows and T7. Keep the registry entry for Work if Work still uses it |
| **T3** `web_search` for all models | Juno-search `sources` frames; `visit` rows with `url`; `[n]` markers in ordinary chats | Native `sources` decode (fatal on an empty or multi-line title); native sites list; native renders `[n]` literally outside research (no resolver, `DeepResearchActivityProjection.swift:182-193` is used for research only) | **Yes, potentially** (empty titles, `search-engine.ts:464, 494, 563, 636`) | Normalise every `ClientSource` before sending and persisting: title → a single line, falling back to the host. Emit `{kind:"search", title:"Searching the web", detail: query}` per call, which gives native its query line for free |
| **T3** `search_chats`, `current_time`, `calculate` | Tool rows only | — | No | — |
| **T3** `suggest_research` chip | A client-rendered affordance | Native cannot render it | **Misleads.** The model tells a native user to "click Research this" | Offer the tool only when the request declares the feature (the `workHandoff` precedent, `task-tool.ts:159-161`). Never in profile 1 |
| **T4** web on by default | Request semantics | Native encodes "off" as an **absent** `webSearch` (`NativeChatAPIClient.swift:976, 1513-1521`). The server uses `!!input.webSearch` (`route.ts:939, 2099`) | **Yes**, if implemented server-side: native users who turned search off would get it (cost and privacy) | A client-side default in the web composer, or a stored preference read **only** when the request carries the new flag. Absent from a profile-1 request stays "off" |
| **T5** loop (budgets, parallel calls, duplicates, timeouts, final round) | Server internal. Per-tool timeout as an extra key inside `event` | — | No. Round-budget exhaustion must keep reporting `length` (native Continue, `NativeConversationStore.swift:803-813`) | Additive |
| **T6** `seq` on activity; `round` on reasoning and tool calls | Extra keys inside `event`, and on `reasoning` and `delta` frames | Native ignores unknown keys; the web reads them | No | Additive. `seq` is fixed at first emission and survives re-sends (upsert by id, `NativeConversationStore.swift:977-981`, `use-chat.ts:560-576`). Relax `additionalProperties:false` in the OpenAPI document |
| **T6** typed tool record, 8 statuses | A structured record **inside `event`** (for example `event.call`). `kind:"tool"` and the `"Using …"` title stay | Native ignores it; the web adapter and serializer must pass it through | No, if carried inside `event`. **Fatal** if sent as a new frame type (`tool_status`, `part.*`) | Dual-write: legacy `kind`, `title` and `detail` plus the typed record. Add it to `serializeActivity` in the same change |
| **T6** approvals persisted with the call | The tool record stores the approval id. `done.message` may gain `approvals`. `approval` frames may be re-sent as their status changes | Native upserts approvals by id (`NativeConversationStore.swift:2121-2154`) and recovers from `/api/approvals` | No, as long as `status` and `riskClass` stay in the closed enums | Store `approvalId` on the record and hydrate status from `ActionApprovalReceipt` at serialize time. Keep `/api/approvals` unchanged. Never put the 8-status names on the receipt |
| **T6** commentary split from the answer | `delta` text no longer equals `done.message.content`. `Message.content` becomes "the final answer" | Native live bubble, then replaced at `done` (`NativeConversationStore.swift:2076-2086`); native synced rows; share, search, titles, follow-ups (better); tag parsing (`route.ts:3058, 3126`) | **Degrades.** The text visibly jumps at `done`. **This contradicts §4b "existing fields keep their meaning"** (`DECISIONS.md:286`) unless SPEC redefines `delta` as "streamed visible text" | Mark commentary with an added `round` on `delta` and an activity timeline item. No new frame. In profile 1, insert a `"\n\n"` delta between rounds so the live text is not glued. Keep every `<juno:artifact>` and `<juno:memory>` tag in `content`, whichever round wrote it |
| **T7** tool notes in history | Provider history only | Prompt cache (`route.ts:2979`); private history cannot carry notes (`request.ts:166-174`) | No | Build the note deterministically from persisted rows, so the cache prefix stays stable. Map legacy tool ids |
| **U1, U2, U4–U7** | Web UI only | Web | No | — |
| **U3** Activity panel ("Details: memory used, with Forget") | Serializer must return `memoryReceipt`, which **is already stored** (`chat-stream.ts:96-104`, `route.ts:2554, 3174`) but filtered out by the field whitelist (`serializers.ts:71-117`, rebuilt object at `:102-113`) | Web; stale tabs ignore extra keys | No | Extend the serializer whitelist. **No backfill is needed for this field** |
| **R1** no levels; ignore `researchEffort` | Research strings; the envelope from `researchBudgetFor`; `plan.effort` leaves `ResearchRunView` | Server strings that native shows verbatim (`route.ts:2847-2853`; `engine.ts:1443`; `api/research/route.ts:54`); the web console (`research-console.tsx:146`, which is `?? null` tolerant); `planBudget`, `parseBudget` and `judgeCallsForEffort` (`domain.ts:1324-1326, 1414-1419, 1596-1598`); the PM2 worker. **Native never sends `researchEffort`** (`GenerationRequestWire`, `NativeChatAPIClient.swift:1506-1530`). Only stale web tabs do (`use-chat.ts:1308`) | No wire break. **iOS keeps showing "· Max" and stale "8 researchers · up to 320 pages"** (`NativeResearchEffort.swift:26-45`, `JunoMobileResearchProgress.swift:152-176`), which now describe nothing | Server strings can drop "Deep" now. `parseBudget` **discards a stored budget with no valid `effort`**, so an envelope written without `effort` is silently replaced by the default tier on the next read, including by an older worker during a deploy. Ship the reader before the writer, or keep writing an internal `effort` |
| **R2** scope card, one gate | A web gate | Native cannot render it | **Yes**, if applied to native: a native run would park at the plan with only a typed "yes" to confirm | Native stays on automatic confirmation (`deep-research.ts:241`) unless the request declares the scope-card feature |
| **R3** background engine plus a persisted assistant message | Web path: a Message row inserted by the engine. Native path: unchanged under §4b (`DECISIONS.md:306-310`) | The persisted message reaches **native through sync** for web-run research viewed on the Mac or iPhone, and also reaches share, search, export, history, and citations (`citation-audit.tsx:165` by message id) | No, **if** the message's `content` renders on native. **Yes** if the "report card" is a new marker: native renders unknown `<juno:*>` tags raw (`NativeMessageContent.swift:211-216`) | Content = the 120–250-word cited summary followed by the full report as `<juno:artifact identifier="research-report" type="MARKDOWN" title="…">`, which is today's `RESEARCH_OUTPUT_CONTRACT` shape (`route.ts:220-240`). Persist the artifact row and ordered `sources` (`cited:true`), set `ResearchRun.assistantMessageId`, and insert **one** row at completion, never a placeholder (native recovery accepts any assistant row after the user's, `NativeConversationStore.swift:2465-2469`). "Shipped native" must be detected by the absence of an opt-in flag, not by `client:"app"`, which Electron and future native builds also send |
| **R3** hypothetical: native on the background engine | The chat stream would end with a notice | Native projection shows "completed" at the notice's `kind:"done"` (`DeepResearchActivityProjection.swift:167`); no further progress; recovery ends after 12 tries | **Yes**, misleading | §4b's split is correct. If native ever moves, the server must keep the SSE open and relay the run's events with the legacy titles until the persisted message exists, then send `done` built from it |
| **R4** live progress | Web polls `/api/research` | The native in-chat path still relies on the chat-stream research titles (`deep-research.ts:128-219`) | No, if `toActivity` titles and kinds stay | Freeze `toActivity` for the in-chat path |
| **R5** report reader and export | Web | — | No | The report remains a `research-report` artifact on both paths |
| **R6** Stop never cancels a run | Web | Native in-chat path: Stop → `/api/chat/cancel` aborts the drive (`deep-research.ts:351-356`) | No | Keep chat-cancel semantics for the in-chat native path. Native has no other control |
| **R7** completion noticed | Web, plus APNs copy | APNs alert strings are shown verbatim (`apns.ts:374-391`) | No | Copy only |
| **R8** engine fixes (B1–B8) | Engine | The native in-chat hand-off (`deep-research.ts:337-356`, `until:"synthesizing"`) and the post-stream audit (`route.ts:3546-3613`) | No, if B2 "non-claimable hand-off" keeps the chat request as the run's owner until `finalizeChatResearchRun` | Test the native path explicitly |
| **§4 Library** | `DELETE /api/library/[id]` plus `libraryRemovedAt` | Shipped iOS deletes through `DELETE /api/attachments/{id}` (v1.6.0 `JunoMobileLibraryView.swift:201` → `NativeProjectAPIClient.swift:152-157`), which still tombstones the file | **The bug persists on 1.6.0** | Already required Swift (`7f92324f`). See §6 |
| **Proposed new frames** (`part.start/delta/end`, `tool_status`: `internal-tools-backend.md:794-795`, `internal-tools-e2e-trace.md:425, 633`) | New types | Every native build ≤ 1.6.0 | **Yes, fatal** | Only behind the opt-in flag (§4), and only for decoders that skip unknown types |
| **Contract version bump** | `CONTRACT_VERSION` | Every installed app at sign-in and bootstrap | **Yes, total** | Forbidden for stream evolution |

---

## 4. Proposed wire-versioning rule

**W1. Two stream profiles, negotiated per request.**

- A request that does not carry `streamProtocol: 2` (an integer; the name is illustrative) gets
  **profile 1**: the grammar in §2, frozen.
- The web sends `2`. A native build sends `2` only once its decoder skips unknown types (the
  `mac/liquid-glass-chat` decoder already does) **and** it implements the features that profile 2
  turns on.
- The negotiated profile is recorded on the generation, so the resume route replays the same one.
- Precedent: `workHandoff` (`request.ts:154-161`).
- **Do not use `client` or `origin` as the signal.** The web sends neither. Electron sends
  `origin: "main_macos"`, which becomes "app". A future native build also sends "app"
  (`chat-origin.ts:34-40`).

**W2. Features ride explicit flags, not the profile number.** For example:

```
clientFeatures: ["timeline", "research_background", "scope_card", "suggest_research",
                 "work_handoff", "resume"]
```

- Unknown strings are ignored, and `workHandoff` stays as an alias.
- Each flag gates both a frame or behaviour and the model-facing tool or prompt section that depends
  on it, as `taskToolOn` does (`route.ts:2229-2245`).
- The list belongs in `contracts/capabilities/juno-capabilities-v1.json`. Its version is not checked
  by any client, so it can grow. The generated Swift then tells the Mac mirror exactly what it may
  declare.

**W3. Additive-only inside profile 1.**

- New keys are allowed:
  - inside `event`;
  - inside `done.message`;
  - at the top level, but **only** under names outside the reserved list in §2.2.
- No existing key is removed, retyped or given a new meaning without an explicit SPEC redefinition
  that tolerates the old reading. T6's `content` is the one accepted redefinition.

**W4. Profile 2 obligations.**

- Clients must ignore unknown `type` values and unknown keys.
- Clients must treat an absent new field as the legacy meaning.
- Clients must accept profile-1 frames. Replayed logs and rolled-back servers produce them.
- The server may add types, each documented in OpenAPI as `ChatSSEEventV2` with its minimum profile.
- Reserved-key typing (§2.2) still applies: even the tolerant Mac decoder decodes known frames
  strictly.

**W5. Never bump `CONTRACT_VERSION` or `info.version` for chat-stream changes.**

- Both are exact-equality kill switches with no upgrade path (§0.5).
- Regenerate the OpenAPI digest, which is informational.
- Fix the document so it describes profile 1 truthfully. That means adding `title`, `approval` and
  `progress` (`juno-native-v1.yaml:1662-1672`) and native's actual request fields (`:1630-1640`).

**W6. Persisted rows are part of the wire.**

- The sync `message` entity (`sync-entities.ts:137-178`) is additive-only.
- `Message.content` stays one string: the answer, with inline `<juno:artifact>` and `<juno:memory>`
  tags, and no new `<juno:*>` tag types.
- `Message.activity` keeps each event's legacy keys, and new structures live inside it.
- `reasoningParts` stays `string[]`.

**W7. Deploy skew and rollback.** Every reader must accept what the previous and the next build
write:

- stream-log replay: frames kept up to 24 h;
- `ResearchRun.plan`: the web server and the PM2 worker are separate processes;
- `Message.activity` for both the old and new serializers.

Ship readers before writers.

**W8. A conformance gate.**

- Add `tests/native-stream-conformance.test.ts`: a TypeScript port of the `v1.6.0` `decodeEvent`
  acceptance rules (types, reserved-key types, `validText`, the source, approval and done checks).
- Run it over every route fixture and `/dev/run` scenario with no opt-in.
- CI fails on any frame that 1.6.0 would reject.
- Log the negotiated profile per generation, so the day profile 1 has no traffic can be measured.
  Device `appVersion` cannot measure this, because it is written only at sign-in
  (`native-auth.ts:131, 275`).

---

## 5. Invariants SPEC.md must state

**Stream**

1. Profile 1 frame set: `meta title activity approval sources reasoning delta done error ping`, plus
   `progress` on `/api/generate` only. **`resume {available:false}` is withheld from profile 1.** This
   fixes an existing 1.6.0 failure (`chat-stream.ts:86-90`).
2. The reserved top-level keys and their JSON types (§2.2) never change on any frame, in either
   profile.
3. Every `ClientSource` is normalised before it is streamed or persisted:
   - title non-empty and single-line, at most 2,000 bytes, falling back to the host;
   - `url` absolute `http(s)` with a host;
   - `snippet` a string of at most 32 KiB;
   - at most 100 per frame.
4. `delta` and `reasoning` frames are at most 64 KiB. `error.message` is single-line, at most
   32 KiB.
5. The approval wire stays `ClientActionApproval` (`action-approval.ts:62-83`):
   - `status` ∈ `ACTION_RECEIPT_STATUSES`;
   - `riskClass` ∈ `ActionRiskClass`;
   - `preview`, `connectorLabel`, `toolName` and `action` non-empty and single-line, with `preview`
     at most 8 KiB;
   - `detail` at most 100 keys.

   T2's `risk` and T6's `status` never replace these fields.
6. Every activity event keeps `id`, `kind` and `title` as strings. New rows use one of the ten native
   kinds whenever native should count them. New structure goes only inside `event`, and `seq` is
   fixed at first emission.
7. Literal research contract, for as long as profile 1 exists:
   - `{kind:"search", title:"Searching the web", detail: query}` per real query;
   - `{kind:"visit", url}` per source read;
   - `{kind:"context", title:"Research corpus ready"}` when reading ends;
   - exactly one `kind:"write"` at the first answer text;
   - exactly one `kind:"done"` at the end;
   - `kind:"warning"` only for something a reader must see.
8. In profile 1, `delta` carries all visible text, commentary included, with `"\n\n"` between
   rounds. `done.message.content` is authoritative and replaces it.
9. Request semantics:
   - an absent `webSearch`, `deepResearch`, `connectors`, `fastMode` or `proMode` means off;
   - `chatBodySchema` stays non-strict;
   - every field native sends (`NativeChatAPIClient.swift:1506-1530`, plus `regenerateInstruction`
     from the Mac branch) is accepted forever.
10. No tool or prompt section that needs a client surface (`start_task`, `suggest_research`, the
    scope card, background research) is offered unless the request declared that feature.
11. A profile-1 research request keeps today's in-chat path: automatic confirmation, the chat model
    writing the report under `RESEARCH_OUTPUT_CONTRACT`, the post-stream audit, and chat cancel
    aborting the drive.

**Persistence**

12. `Message.content` is a non-empty string whenever any text was produced (T6 fallback). It is the
    answer and keeps every `<juno:artifact>` and `<juno:memory>` tag written in any round. Tag parsing
    runs over all rounds. No new `<juno:*>` tag types.
13. No assistant `Message` row is inserted or updated before the turn's terminal state. Sync triggers
    fire on every write (`migration.sql:113`), and native recovery accepts any assistant row after the
    user's.
14. The R3 research message is one row, inserted at completion. Its content is the summary followed
    by the full report as a `research-report` artifact tag. Its artifact row and ordered, cited
    sources are persisted, and `ResearchRun.assistantMessageId` is set.
15. `Message.activity` stays a JSON array. The tool record, commentary items, approval ids, `seq` and
    `round` live inside it. `ACTIVITY_KINDS` and `serializeActivity` change in the same commit as any
    writer. `share.ts` never selects `activity`.
16. `reasoningParts` stays an array of encrypted strings. Per-part rounds are stored as a parallel
    structure: the serializer, export and import all filter non-strings
    (`serializers.ts:50-54`, `export/route.ts:236-238`, `import/route.ts:669-672`).
17. A new column is added to fork, export, import, history-import and `versionSnapshot`, or is
    explicitly documented as not copied. Prefer the existing `activity` JSON, which all of them
    already copy.
18. `/api/approvals` and `/api/approvals/[id]` keep their shapes and remain the source of truth.
    "Persisted with the call" stores the approval id and hydrates status from the receipt, scoped by
    `userId` so that forks still resolve.
19. The sync `message` entity's fields and types do not change (`sync-entities.ts:137-178`).
20. **Legacy rows are rendered, not backfilled.** One adapter handles rows written before the rework:
    - order = array order;
    - status from `tool.status` and `resultNote` (`tool-detail.ts:299-330`);
    - "Using …" and "… needs approval" matched by title **only inside the adapter**;
    - reasoning shown before tools;
    - glued content left as it is.

    The only recoverable legacy data, `memoryReceipt` and `artifactVerification`, is restored by
    widening the serializer.
21. Juno Code rows (`kind:"write"` with `patch`, `kind:"tool"` with `exitCode`) in the same column
    stay intact.
22. `ResearchRun.plan` stays readable by the previous build: keep a valid `plan.budget.effort`, or
    ship `parseBudget`'s new reader before any writer omits it (`domain.ts:1414-1419`).
23. Tool id aliases (`code_interpreter`→`run_code`, `browser_agent`→`web_fetch`) apply to skill
    `requestedTools`, standing approval grants, legacy row labels and T7 notes.
24. T7 history notes are a pure function of persisted rows.
25. `CONTRACT_VERSION` does not change. The OpenAPI document describes both profiles. The
    conformance test (W8) gates CI.

---

## 6. Where DECISIONS §5 ("It does not change native Swift") cannot hold

1. **It is already false on this branch.**
   - `7f92324f` (§4, the Library fix) changed `NativeProjectAPIClient.swift`, `NativeProjectStore.swift`,
     `JunoMobileLibraryView.swift`, `Localizable.xcstrings` and the generated contract digest.
   - Shipped iOS 1.6.0 still deletes Library files through `DELETE /api/attachments/{id}`, which
     tombstones them (v1.6.0 `JunoMobileLibraryView.swift:201`, `NativeProjectAPIClient.swift:152-157`).
   - So the Library bug stays on installed builds until the new Swift ships.
2. **R1 says "'Deep' is dropped from every UI string"** (`DECISIONS.md:201`). These are compiled in:
   - `DesktopComposer.swift:732`;
   - `ProjectWorkspaceStore.swift:57`;
   - `Localizable.xcstrings:2546, 5003, 5037`.

   The level names ("Quick/Standard/Deep/Max") and their stale summaries are in
   `NativeResearchEffort.swift:26-45` and `JunoMobileResearchProgress.swift:159-175`. Only the
   server-sent strings (`route.ts:2847-2853`, `engine.ts:1443`) can change without Swift.
3. **iOS depth copy becomes false.** Once R1 replaces tiers with `researchBudgetFor(scope…)`, iOS
   still prints "N researchers · up to P pages · ~T min" for a tier the server no longer runs
   (`NativeResearchEffort.swift:39-44`).
4. **T4, web on by default, on native.** Native encodes "off" as an absent key. A native default-on
   is a composer change in Swift.
5. **T3 `suggest_research`, R2 scope card, R3 background runs, R4 panel and controls, R5 reader,
   R6 "Guide the research".** None of these can reach native without Swift. Under §4b they are
   web-only by design, and each must be gated (§5.10–11).
6. **U1–U3 on native.** Native renders no tool rows at all today, apart from the research search
   block. The timeline, the per-call status, commentary and anchored approvals need Swift. This is
   expected, but it means shipped apps get **less** tool visibility than the web, not the same.
7. **Any profile-2 frame, and the fix for the shipped `resume` failure on the client side.** These
   need a release carrying the Mac branch decoder (`675a73f4`), for macOS **and** iOS. Until then,
   the server-side gate (§5.1) is the only fix.
8. **`[n]` citations in ordinary chats.** Once T3 search reaches every model, native shows literal
   brackets. The resolver exists only on the research path
   (`DeepResearchActivityProjection.swift:182-215`).
9. **R6 cancel on native, if R3 is ever extended to native.** Native has no `/api/research/*/control`
   client, so without Swift a background run could not be stopped from the app.

---

## 7. Existing defects this audit found (not caused by the rework, but in its path)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| D1 | `resume {available:false}` reaches native saved-chat streams. 1.6.0 fails the turn | `chat-stream.ts:86-90`; `NativeChatAPIClient.swift:1230-1231` | Gate it to requests that declare `resume` (the web) |
| D2 | Juno-search hits may have `title: ""`. An empty title in a `sources` frame is fatal on native | `search-engine.ts:464, 494, 563, 636`; `stream-accumulator.ts:141-150`; `NativeChatAPIClient.swift:1236` | Normalise in `seedSources` (Invariant 3) |
| D3 | The OpenAPI chat request and SSE schemas do not match what native sends and receives | `juno-native-v1.yaml:1630-1640, 1662-1672` | W5 |
| D4 | The `request.ts` comment claims `.strict()`. The schema strips unknown keys | `request.ts:90-95` vs `:68-208` | Correct the comment. Keep it non-strict |
| D5 | Fork drops `reasoningParts` | `fork/route.ts:66-95` | Copy it |
| D6 | iOS shows the research-progress block, including a phase rail, for every turn that emitted any activity | `JunoMobileComposer.swift:293-301`; `NativeConversationStore.swift:973-982, 1709` | Swift. For now, keep profile-1 activity minimal and truthful |
| D7 | `parseBudget` drops a stored budget whose `effort` is missing or unknown | `domain.ts:1414-1419` | Invariant 22 |
| D8 | `start_task` previews are built from a trimmed model title, but newlines are not stripped. Harmless only because native never gets `start_task` | `action-approval.ts:401-406` | Strip control characters from previews |

---

## 8. Can the Work vocabulary be reused for chat's tool record and approval states?

**Partly: the spelling, not the enums.**

| T6 status (`DECISIONS.md:90-91`) | Work run status (`juno-work-v1.json`) | Work approval decision | Chat receipt status (`action-approval.ts:45-55`, native `NativeChatApproval.swift:17-27`) |
|---|---|---|---|
| `queued` | `queued` | — | — |
| `awaiting_approval` | `waiting_approval` (different spelling) | `pending` | `pending` |
| `running` | `running` | `allowed` | `allowed`, `executing` |
| `succeeded` | `completed` | — | `executed` |
| `failed` | `failed` | — | `failed` |
| `denied` | — (event `tool_denied`) | `denied` | `denied`, `blocked` |
| `expired` | — | `expired` | `expired` |
| `cancelled` | `cancelled` | `superseded` | `superseded` |

**Do not reuse the Work run-status enum for a tool call.**

- Half of its values are run-level: `draft preparing paused interrupted host_offline budget_exceeded
  timed_out`.
- Do not put Work's `approvalDecisions` on the chat approval wire either. Native chat maps an
  unknown status to `.blocked` and hides the buttons (`NativeChatAPIClient.swift:1276`,
  `NativeChatApprovalView.swift:70, 83`).

**Risk has three vocabularies:**

- T2 `read/write/external/destructive`;
- the broker's `read_only/reversible_write/external_write/destructive_or_sensitive/unknown`;
- Work's `safe/edit/command/sensitive/irreversible`.

Keep the broker's `ActionRiskClass` as the only one on the wire, and map T2 onto it.

**Recommendation.**

- Put the chat tool-call status set, with `isTerminal` and `needsAttention` flags like Work's
  statuses and a derivation table from receipt status to tool status, in a contract JSON:
  `contracts/chat/juno-chat-v1.json`, or a `toolCallStatuses` vocabulary added to the capabilities
  manifest.
- Generate its Swift enum the way `JunoWorkContract.swift` is generated.
- Adopt Work's unknown-tolerant rendering (`JunoWorkVocabulary.swift:163-173`), so the Mac mirror
  inherits it.
- Where T6 and Work describe the same state, consider Work's spellings (`waiting_approval`,
  `completed`). One Swift vocabulary then serves both Work and Chat.
