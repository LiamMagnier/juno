# Internal audit: how the web chat renders tool calls, results, sources and approvals

Scope: the Juno **web** transcript and its right-hand dock, as of `d0997af2` on branch
`web/tools-thinking-research`. This is a read-only audit and no source was changed. Every claim below cites
`file:line`. Unless a note says otherwise, paths are relative to the repo root.

Files read in full: `src/types/chat.ts`, `src/hooks/use-chat.ts`, `src/lib/chat/tool-detail.ts`,
`src/components/chat/{activity-timeline,thought-process-model,thought-process-panel,thought-panel-context,message-item,message-list,approval-card,source-chip,sources-pill,session-outputs,generation-placeholder,artifact-inline-card,python-execution-block,work-run-panel,research-run-panel}.tsx`.

Files read in part: `chat-view.tsx` (the dock, the context and inlineRuns), `citation-audit*.tsx`,
`inline-visual-block.tsx`, `data-*-block.tsx`, `src/lib/serializers.ts`, `src/lib/run-receipt.ts`,
`src/lib/mcp.ts`, `src/app/api/chat/route.ts` (every activity producer), `src/components/aicss/{web-search,thinking-reasoning}.tsx`,
`src/components/signature/thinking-dots.tsx`, `src/components/i18n/auto-translate.tsx`,
`scripts/generate-i18n-catalog.mjs`, `src/app/globals.css` (aicss, stream-tail, reduced motion) and the `src/app/dev/*` galleries.

---

## 0. Summary

The chat has **no inline tool-call UI**. A tool call is visible in only two places:

1. **One line** above the answer, the "run strip". While the run is live it reads `Using Linear · linear__create_issue · 12s`.
   At rest it becomes a count, `Run · 2 tool calls   3.1s ›`.
2. **The right-hand "Thought process" dock**, which opens from that line. There each call is one row on a
   timeline spine, and it opens to show raw JSON for the arguments and the result.

Web search, sources, memory, approvals, tasks, artifacts, media generation and research each have their own
separate surface, with their own vocabulary and motion. Claude, ChatGPT and Juno's own Code surface
(`src/components/code/code-activity.tsx`) all draw tool calls **inline** with a status, a name, the input and the
output. Juno's chat hides them behind a click, and even there the information is partial and sometimes wrong.

The most important problems:

| # | Finding | Evidence |
|---|---|---|
| 1 | If you open the dock during a run, it **closes itself when the answer finishes**. The message id changes from temp to server at `done`, and the dock is keyed by that id. | `use-chat.ts:668-676`, `activity-timeline.tsx:154`, `chat-view.tsx:1096-1104` |
| 2 | **Approval cards vanish** when the turn completes and never come back on reload. `approvals` are never serialized onto a message. | `message-item.tsx:1268-1274`, `use-chat.ts:668-676`, `serializers.ts:156-199` |
| 3 | **Memory receipts and artifact verification are dropped by the serializer.** "Memory used" disappears at `done`, not only on reload. | `serializers.ts:72-117`, `route.ts:3186-3190` |
| 4 | **No tool row is ever shown as running.** The live line keeps saying "Using X" after the call returns. A turn that is waiting on the user's approval says "Thinking", then "Still thinking. This can take a few minutes." | `thought-process-model.tsx:680-693`, `activity-timeline.tsx:73-94`, `use-chat.ts:583` |
| 5 | **A user's Deny is shown as "Failed"** with an "Ask to run again" button. Refused, blocked and expired approvals come back as `ok:false`. | `mcp.ts:482-485`, `thought-process-panel.tsx:626-630`, `:1308-1310` |
| 6 | On Anthropic, every **live** tool row says "The provider did not send the arguments for this call." That is false: the arguments arrive when the call completes. | `tool-detail.ts:156,171-175,219-223`, `run-receipt.ts:111` |
| 7 | **Many producer events never render anywhere**: approval-request rows, start_task rows, canvas edit, artifact verification, research narrative, evidence-gap searches, "Memory updated", "Auto thinking". This is because the model filters by title prefix (`title.startsWith("Using ")`). | `thought-process-model.tsx:363-424` |
| 8 | **Warnings disappear after streaming** on turns with no reasoning, tools or sources. Examples: "Model changed", "Skill not applied", "Usage limit reached". | `activity-timeline.tsx:228-240` |
| 9 | **Layout jumps at completion.** The live reasoning viewport (up to 180px plus the search block) and the approval card both unmount when `done` lands, so the answer moves up under the reader. | `activity-timeline.tsx:269-272,397-413`, `message-item.tsx:1268` |
| 10 | **Focusable links and a button sit inside an `aria-hidden` subtree.** This is the live WebSearchBlock inside the strip's trace. | `activity-timeline.tsx:398`, `web-search.tsx:176-233` |
| 11 | **Screen readers get nothing** for tool calls or for a blocked approval. The strip's content is aria-hidden, the approval card mounts silently, and the dock's announcer exists only while the dock is open. | `activity-timeline.tsx:245-265,398`, `approval-card.tsx:426-433,672-682`, `thought-process-panel.tsx:676-683` |
| 12 | **The run clock resets to 0s** when a run is re-attached, for example after reopening a tab. The skew is calibrated against a replayed, old event. | `thought-process-model.tsx:783-786`, `use-chat.ts:976-1026` |
| 13 | **Most live copy cannot be translated.** Auto-translate matches exact, whole text nodes, and nearly every string with a number, a query or a name in it is composed at runtime. | `auto-translate.tsx:183-214`, e.g. `activity-timeline.tsx:65-75,228-234`, `run-receipt.ts:231-270` |
| 14 | **Chat has no code-execution UI.** `PythonExecutionBlock`, `DataChartBlock` and `DataTableBlock` are orphaned: nothing imports them. | `grep` of `src/` |
| 15 | Dev-gallery coverage **excludes the strip and the dock entirely**. No fixture has `activity` or `tool`. | `src/app/dev/*` |

---

## 1. The data model for a tool call, as the UI sees it

### 1.1 Stream frames that carry tool state (`src/types/chat.ts:333-408`)

| Frame | Payload | Client effect (`use-chat.ts` `createStreamApplier`) |
|---|---|---|
| `activity` | `{ event: ClientActivityEvent }` | Upserted **in place** by `event.id` (`use-chat.ts:49-59,556-578`). The server completes a tool row by re-sending the same id. It also nudges `status`: `submitting→thinking`, `reasoning→thinking`, `write→writing` (`:557-559`). |
| `approval` | `{ approval: ClientActionApproval }` | Replaced by `approval.id` into `message.approvals` (`:579-601`). **It sets `status = "thinking"` (`:583`)**, although the comment directly above says the status "must stop claiming Juno is thinking". |
| `sources` | `{ sources: ClientSource[] }` | Replaces `message.sources` (`:602-607`). |
| `work` | `{ session }` | Adopts a background task, which is then drawn by `WorkRunPanel` (`:608-616`). |
| `reasoning` | `{ text, part? }` | Folds into `reasoning` and `reasoningParts` (`:617-639`). |
| `done` | `{ message, artifacts, … }` | **Replaces the whole message** with the server's serialized one, keeping only `renderKey` (`:658-688`). The id changes from `temp-…` to the DB id. `approvals` and any activity fields the serializer drops are lost here. |
| `error` | `{ message, finishReason, preservePartial }` | Sets `error`, `streaming:false`, `finishReason`. **It does not touch `activity`**, so rows still marked pending stay pending (`:689-716`). |

The server sends exactly **one** `approval` frame per request, at the moment the approval is raised
(`route.ts:2898-2908`). It is **never re-sent as its status changes**, even though the comment at
`use-chat.ts:589-591` says it is. After the user decides, the card's view of its own status is local state.

### 1.2 `ClientActivityEvent` (`src/types/chat.ts:150,235-261`)

```ts
type ActivityKind = "context"|"model"|"reasoning"|"search"|"visit"|"write"|"usage"|"done"|"warning"|"tool"|"artifact";
interface ClientActivityEvent {
  id: string; kind: ActivityKind; title: string; detail?: string; url?: string; createdAt: string;
  tool?: ClientToolDetail;                 // only on rows that stand for one real connector call
  memoryReceipt?: ClientMemoryReceipt[];   // "Remembered about you" row — DROPPED by the serializer
  artifactVerification?: {...};            // "Artifact verified/repaired/refused" — DROPPED by the serializer
}
```

The serializer also spreads `patch` and `exitCode` onto the row for Code sessions (`serializers.ts:95-111`),
but the type does not declare them. `code-activity.tsx:55` reads them through a cast.

A row's **identity and meaning are carried by the English `title` string.** The UI discriminates on literal
titles:

- `"Using "` prefix: `thought-process-model.tsx:406`, `activity-timeline.tsx:73`
- `"Searching the web"`, `"Research corpus ready"`, `"Connected tools ready"`, `"Reasoning mode enabled"`:
  `thought-process-model.tsx:149-152`
- `"Remembered about you"`: `thought-process-model.tsx:369`
- `"Listed source"`, `"Read source"` and `"Reading source"`: `thought-process-model.tsx:231-235`

### 1.3 `ClientToolDetail` (`src/types/chat.ts:168-223`, produced by `src/lib/chat/tool-detail.ts`)

| Field | Meaning | Notes |
|---|---|---|
| `server` | Connector label, e.g. "Linear" | This is a label, not an id. There is no `connectorId`, so the UI cannot draw a connector logo. |
| `name` | Namespaced function name, e.g. `linear__create_issue` | Shown raw everywhere. |
| `args` or `argsNote` | Redacted, pretty JSON (≤2,000 chars), or one of `unavailable \| empty \| unparsable \| over_budget` | `argsTruncated` flags a cut. There is no `argsChars`. |
| `result` or `resultNote` | Result head (≤4,000 chars), or one of `pending \| unfinished \| empty \| over_budget` | `resultTruncated` and `resultChars` describe a cut. |
| `status` | `"ok" \| "failed"` | Absent while pending or unfinished. **There are no other terminal states.** |
| `durationMs` | Server-measured dispatch time | Absent for calls that never reached the network, including refused approvals. |

The whole run has a budget of 32,000 characters of tool detail (`tool-detail.ts:71`). Once it is spent, later
rows carry `over_budget`.

**Lifecycle on the server** (`route.ts:379-420`, `createToolActivity`):

1. **`open(effect)`** runs when the adapter reports a tool call. It sends `kind:"tool"` with
   `title: "Using ${server}"` and `detail: name`, and `tool = openToolDetail()` with `resultNote:"pending"`.
   - **On Anthropic the arguments are not known yet** (`tool-detail.ts:156`), so the open row carries
     `argsNote:"unavailable"`.
2. **If the call needs approval**, `requestApproval` (`route.ts:2898-2908`) sends:
   - a **separate** `kind:"tool"` row titled `"${connectorLabel} needs approval"`, and
   - an `approval` frame.

   Neither shares an id with the tool row. `ClientActionApproval` has no `callId`.
3. **`close(effect)`** mutates the same entry and re-sends it with `status`, `result` and `durationMs`.
   - With lockdown mode on (`route.ts:734`), `enabled` is false. In that case close re-sends nothing, so the
     row never learns how the call ended.
4. **`start_task`** uses the titles `"Starting a task"`, then `"Started a task"` or `"Task not started"`, not
   `"Using …"`.
5. **Refused approvals** (Deny, blocked, expired, superseded) return `ok:false` with the result
   `"Action not permitted: <reason>"` and no duration (`mcp.ts:482-485`).
6. **When the conversation is read back**, `readToolDetail` rewrites a stored `resultNote:"pending"` to
   `"unfinished"` (`tool-detail.ts:319`). This happens only on the read path. The live client never does it.

### 1.4 How the UI infers a tool call's status

There is **no status enum**. Status is inferred from the combination of `tool`, `status` and `resultNote`:

| Real-world state | Wire shape | What the UI concludes |
|---|---|---|
| Model reached for the tool; call in flight | `tool.resultNote="pending"`, no `status` | Nothing. The row is not "running" (`running:false`, `thought-process-model.tsx:690`). The body says "Waiting for the connector to answer." |
| In flight, provider is Anthropic | The above plus `argsNote="unavailable"` | The body also says "The provider did not send the arguments for this call." **This is false.** |
| Awaiting the user's approval | Pending tool row, plus a separate "X needs approval" tool row, plus an `approval` frame | The panel does not know. The strip says "Thinking". The card shows the approval. |
| Executing after approval | Still pending | Same as in flight. |
| Succeeded | `status:"ok"`, `result` or `resultNote`, `durationMs` | A duration figure. Success has **no mark** at all (a deliberate "absence" idiom). |
| Connector error | `status:"failed"`, `result` = error text, `durationMs` | "Failed" in amber, an "error" block, and "Ask to run again". |
| Denied, blocked, expired or superseded | `status:"failed"`, `result:"Action not permitted: …"`, no duration | **Identical to a connector error**, including "Ask to run again". |
| Stopped or errored mid-call (live) | Still `resultNote:"pending"` | Stale: "Waiting for the connector to answer." |
| Stopped or errored mid-call (reloaded) | `resultNote:"unfinished"` | "The run ended before this call returned." plus "Ask to run again". |
| Lockdown mode, or a legacy row | No `tool` | A non-openable name-only row, plus the caption "Some of these calls carry no recorded detail…". |
| Detail budget exhausted | `argsNote` or `resultNote` = `over_budget` | An explanatory sentence in place of the block. |

### 1.5 `ClientActionApproval` (`src/lib/action-approval.ts:62-83`)

`id, surface, sessionId, conversationId, connectorId, connectorLabel, toolName, action, riskClass
(read_only|reversible_write|external_write|destructive_or_sensitive|unknown), preview, detail (redacted args),
receiptDigest, status (pending|allowed|denied|executing|executed|failed|expired|superseded|blocked), decision,
canAllowScope, derivedFromUntrusted, expiresAt, decidedAt, completedAt, createdAt`.

- It is **client-transient**. `ClientMessage.approvals` is documented as "re-fetchable afterwards from
  /api/approvals" (`types/chat.ts:79-88`), but nothing in chat ever re-fetches it.
- It has **no link to the tool row**: no `callId` and no activity id.

### 1.6 The derived run model (`thought-process-model.tsx:345-525`)

`buildRun(events, nowServer, anchorT0, {sources, reasoning, reasoningParts})` returns a `RunModel`:

- **`phases`**: `research`, `think` and `write`, each with `ms` and `active`. There are only three real spans.
- **`facts`**: Model, Effort, Context, Tools and Cost. Each comes from the **first** matching titled event.
- **`calls`**: warnings plus **only** the `tool` rows whose title starts with `"Using "` (`:405-424`).
- **`sources`**: every event with a `url`, deduplicated.
- **`searches`**: only titles equal to `"Searching the web"` (`:373`).
- **`note`**: the **last** warning's title only. Its detail is dropped (`:520`).
- **`stopped`**: true when there are events but no `usage` event and the run is not streaming (`:522`). This makes
  errors read as "Stopped".
- **`steps: Step[]`**. The step kinds are `think | search | source | tool | memory | notice | write`, with fields
  `label, detail, ms, running, failed, body{tool|prose|memory}, source{url,domain,access,citeIndex}`.

**Events consumed** by the model, and those **dropped on the floor**:

| Producer event (title) | kind | Used by the model? | Visible anywhere after the run? |
|---|---|---|---|
| Reading / Rebuilding the conversation context | context | First context row becomes the "Context" fact | Details disclosure only |
| Remembered about you (+ `memoryReceipt`) | context | Memory steps (Details) | **No.** The serializer drops `memoryReceipt` (§1.7). |
| Memory updated / Forgotten (`memory-lifecycle.ts:1237,1385`) | context | **No** | No |
| Selected model | model | "Model" fact | Details |
| Model changed / Skill not applied / Connected tools are off in private chat / Usage limit reached | warning | notice steps and `note` | **Only** if the strip renders at rest (§4 B8) |
| Reasoning mode enabled | reasoning | "Effort" fact | Details |
| Auto thinking | reasoning | **No** (only `T_EFFORT` is matched, `:366`) | No |
| Preparing web search | search | **No.** It is an intent. | No, except that SessionOutputs counts it as a use (§4 B17) |
| Searching the web (deep research) | search | search step and live WebSearchBlock | Panel |
| Following an evidence gap (`deep-research.ts:192`) | search | **No** | No |
| Planned the research / Sending a researcher / Lead review … (`deep-research.ts:134-203`) | reasoning | **No** | No, except inside ResearchRunPanel's own timeline |
| Visited / Read / Listed source | visit | source steps | Panel and SourcesPill |
| Using {server} (+ `tool`) | tool | tool step | Panel only |
| {connector} needs approval / Starting a task needs your approval | tool | **No** | **No.** The card is gone too. |
| Starting a task / Started a task / Task not started | tool | **No** | Only indirectly, through WorkRunPanel |
| Editing existing canvas | tool | **No** | No |
| Connected tools ready | tool | "Tools" fact | Details |
| Artifact verified / repaired / refused (+ `artifactVerification`) | artifact | **No** | No (and the serializer drops the payload) |
| Writing the answer | write | write phase and step | Panel |
| Token usage recorded | usage | cost | Panel recap |
| Finished response / finish titles | done | **No** | No |

### 1.7 Persistence round-trip (`src/lib/serializers.ts:72-117`)

`serializeActivity` rebuilds each row field by field:

- **Kept**: `id, kind, title, detail, url, createdAt, tool, patch, exitCode`.
- **Silently dropped**: `memoryReceipt` and `artifactVerification`. The file's own header warns about exactly
  this failure: "anything added to `ClientActivityEvent` without being added here streams live and then vanishes".

The `done` frame's message is built by `serializeMessage` (`route.ts:3186-3190`), so these fields vanish **at the
end of the live turn**, not only on reload. `approvals` are never part of `serializeMessage` at all.

### 1.8 Client-side flow of one connector call

```
adapter tool call ─▶ route open()  ── SSE activity{tool.resultNote:"pending"} ─▶ upsertActivity (append)
                     [approval?]   ── SSE activity{"X needs approval"}        ─▶ upsertActivity (append; ignored by buildRun)
                                   ── SSE approval{status:"pending"}          ─▶ message.approvals[] ; status="thinking"
                     route close() ── SSE activity{same id, status, result}   ─▶ upsertActivity (replace in place)
done                               ── SSE done{serializeMessage(row)}         ─▶ message replaced: new id, approvals gone,
                                                                                 memoryReceipt gone, pending→unfinished only if persisted as pending
error / Stop                       ── SSE error{…}                            ─▶ activity untouched (pending stays pending)
```

---

## 2. The component tree

### 2.1 Inline, in the transcript

```
ChatView (chat-view.tsx) ── ThoughtPanelProvider{openId,setOpenId,container,seedDraft,coversChat}
└─ MessageList (message-list.tsx)               role="log" aria-live="off"; sr-only completion announcer
   ├─ per message: <div data-message-id> MessageItem (memo)
   │   └─ assistant branch (message-item.tsx:1220-1612)
   │      ├─ ActivityTimeline  (surface!=="code")           ← THE ONLY INLINE TOOL SURFACE
   │      │   ├─ Pressable row (the "strip")               live: ThinkingDots + "Using Linear · linear__create_issue · 12s"
   │      │   │                                             rest: • "Thought process|Run · 4 searches · 9 sources · 2 tool calls" 8.4s ›
   │      │   ├─ live-only trace (aria-hidden)              WebSearchBlock (deep-research query only) + ThinkingReasoning (≤180px)
   │      │   └─ portal → ThoughtProcessPanel (only while open)
   │      ├─ ApprovalCard × n (next/dynamic, ssr:false)     only while message.approvals exists (live only)
   │      ├─ GenerationPlaceholder                          media generation (/api/generate), role=status
   │      ├─ StreamStatus                                   only if streaming AND no activity/reasoning yet
   │      ├─ error box | answer body (aria-live off→polite)
   │      │   ├─ AttachmentTile / GeneratedImageAttachment / VideoAttachment
   │      │   ├─ Markdown → SourceChip [n] (only when sources[].cited), InlineVisualBlock → StepLabBlock
   │      │   ├─ ArtifactInlineCard                         parsed from <artifact> markup, not from tool events
   │      │   ├─ VisualLearningBlockRenderer
   │      │   └─ finish-note box ("Stopped by user.", "…tool flow…")
   │      ├─ SourcesPill → SourceRow → SourceAudit (research only)
   │      ├─ CitationAuditPanel (research only)
   │      └─ action toolbar
   └─ inlineRuns (placed by createdAt): ResearchRunPanel | HistoricalResearchRunPanel | WorkRunPanel
       (WorkRunPanel embeds the *Work* ApprovalQueue/ApprovalCard — a second approval component)
Header cluster: SessionOutputs popover (Outputs / "Used in this session") — hidden while the dock is open (chat-view.tsx:1914)
```

### 2.2 The right-hand dock ("the right sidebar")

```
chat-view.tsx:2421-2476  <div ref=setThoughtContainer> (bg-card, @[50rem]/split: 30rem column, resizable; below: full-bleed, chat hidden)
└─ (portal from ActivityTimeline) ThoughtProcessPanel <aside tabIndex=-1 aria-labelledby>
   ├─ header 48px: [Back ‹ below split] [dots|dot] h2 "Thinking|Researching|Writing|Done|Stopped" · 8.4s
   │               [Filter ▾: Find · All/Reasoning/Tools/Sources/Searches/Notices · Summary/Full trace · Expand/Collapse all]
   │               [Copy ▾: summary · run · sources · visible steps] [✕ above split]
   ├─ find bar (optional)
   ├─ sr-only role=status announcer (phase word / summary)
   └─ scroller (aria-live=off, auto-follow while streaming, "Live" pill)
      ├─ RECAP: sentence (live copy | toRunSummary) · figures [Elapsed | Cost | Sources or Tool calls] · NOTICE band
      ├─ SPINE: <section> per phase (Research / Think / Write), sticky h3, <ol> of StepRow
      │    StepRow: grid [marker 20px][label/detail][Failed + duration][hover action 28px]
      │      marker: favicon (source) | dot (think) | globe (search) | "connections" glyph (tool) | error glyph (notice) | artifacts glyph (write)
      │      action: Jump to citation n | Open domain | Ask to run again | Copy
      │      body (grid-rows collapse): Prose | ToolBody (args block, result block, caption, Copy step / Ask to run again) | MemoryBody
      └─ DETAILS disclosure: Model, Effort, Context, Tools, Billed/Cost + "Memory used" (StepRow + Forget)
```

The dock and the canvas are mutually exclusive: opening one closes the other (`chat-view.tsx:978-991,994-1009`).

### 2.3 Rendering by state

| State | Strip (inline, collapsed) | Other inline | Dock row | Dock body | After reload |
|---|---|---|---|---|---|
| **Pending** (model reached for the tool) | "Using Linear · linear__create_issue · 12s", but only while this row is the *latest* event | nothing | "Linear · linear__create_issue". Generic glyph, **no spinner**, no figure. Openable. | Args block, or on Anthropic "The provider did not send the arguments…" (false). Then "Waiting for the connector to answer." | See "Aborted". Only a run that is still streaming shows pending. |
| **Running** (dispatched) | Same as pending. No distinction. | nothing | Same | Same | n/a |
| **Awaiting approval** | "Thinking · 34s". After 2 min: "Still thinking. This can take a few minutes." After 10 min: "Still working. You can leave…" (`activity-timeline.tsx:82-94`) | ApprovalCard above the answer: amber frame, risk pill, countdown, arguments disclosure, Don't allow / Allow once / Allow this action for this connector | Pending row. The approval row is invisible. | "Waiting for the connector to answer." It is actually waiting on **you**. | **The card is gone.** No trace of the approval remains in the UI. |
| **Done (ok)** | Rest: "… · N tool calls  3.1s ›" | ApprovalCard shows "Allowed once…" until `done`, then **unmounts** | Row plus duration. **No success mark.** | "arguments · json" block, "result · first 4000 of 26318 chars" block, caption, Copy step | Same |
| **Error** (connector threw) | Same as ok. There is no error count in the strip. | — | Amber marker, amber label, "Failed" + duration | "error" block + "Ask to run again" | Same |
| **Denied / blocked / expired** | Same | The card shows the outcome sentence until `done`, then unmounts | "Failed" in amber, no duration | "error: Action not permitted: …" + **"Ask to run again"** | Same, with no card |
| **Aborted** (Stop or error mid-call) | Rest strip. The finish note is in the answer ("Stopped by user.") | The error box, or the partial answer with a notice | Row with no mark | **Live: "Waiting for the connector to answer."** (stale) | "The run ended before this call returned." + Ask to run again |
| **Lockdown / legacy** | "Using X · fn" forever while live (the close is never sent) | — | Non-openable row | The spine note "Some of these calls carry no recorded detail…" | Same |

### 2.4 Other tool-like surfaces, and how they differ

| Surface | What it represents | Live treatment | Rest treatment | Notes |
|---|---|---|---|---|
| **Native web search** (Claude, Gemini, xAI, OpenAI) | A provider tool call | Nothing says "searching". "Preparing web search" is dropped. The strip reads "Thinking". | "Visited source" rows become sources. SourcesPill. | **The query is never shown** (`route.ts:3028-3037` sends only sources). |
| **Deep-research search** | Juno's research engine | WebSearchBlock with the query, per-site globe animation, and the strip's "Reading nature.com · 9 sources" | Panel search rows (no result counts) + ResearchRunPanel (its own UI) | Two parallel UIs for one run. |
| **SourcesPill / SourceChip** | Citations | Appears when the `sources` frame lands | The same | Favicons fetched from `origin/favicon.ico`, including `http:` origins (`source-chip.tsx:60-68`) |
| **ApprovalCard (chat)** | A connector action or task handoff | A rich card | **Gone** | Separate from **Work's** `components/work/approvals/approval-card.tsx`, which has a different decision vocabulary (`allowed` vs `allow_once`) |
| **WorkRunPanel** | The `start_task` tool's result | framer-motion panel (a different motion stack) | A terminal digest | It is the only UI for the start_task call. |
| **ArtifactInlineCard** | Artifact creation or edit (markup, not a tool event) | Three loops: icon-breathe, pulse dot and gen-sweep (`artifact-inline-card.tsx:265,290,371`) | Preview / Code / Console | Verification refusal is shown in the card body ("Source unavailable"), but the verification activity itself is dropped. |
| **GenerationPlaceholder** | Image or video generation (`/api/generate`) | Lattice canvas, stage word, long-wait sentence | The media tile | Its own role=status |
| **InlineVisualBlock / StepLab** | Model-authored fenced JSON | "Drawing inline visual..." | A rich block | Not tools |
| **PythonExecutionBlock, DataChartBlock, DataTableBlock** | Code interpreter output | — | — | **Not imported anywhere**: dead code, and there is no chat path for code execution. |
| **CodeActivity** (Juno Code) | Commands, file writes, approvals | Inline mono cards with exit status and diffs | Same | The richer idiom the chat lacks (`code-activity.tsx:13-37`) |

---

## 3. UX critique

### 3.1 What looks cheap or confusing

1. **Tool calls are demoted to a sentence fragment.** The whole inline presence of a connector call is one line of
   muted text, and at rest it collapses to a count ("2 tool calls"). The reader cannot see *what* was done
   (created an issue? read 40 emails?) without opening a side panel. Claude and ChatGPT show a named, collapsible
   block per action; Juno Code shows command cards. Chat is the odd one out.
2. **Machine names are shown raw.** Examples: `Using Linear · linear__create_issue` (`activity-timeline.tsx:73-76`,
   `route.ts:394-397`), and dock labels like `Linear · linear__create_issue` (`thought-process-model.tsx:415`).
   There is no humanized verb ("Created issue ENG-123 in Linear"), no result summary and no argument summary.
3. **The word "Run"** labels every trace without reasoning (`activity-timeline.tsx:368`). "Tool calls", "Notices",
   "Think / Write" and "arguments · json" are engineering vocabulary.
4. **Success is invisible by design.** The idiom is "absence means ok" (`run-receipt.ts:418-421`). But absence also
   means pending, unknown (no detail) and still running. Four states share one appearance.
5. **Failure looks like a warning.** A failed call and a notice both use `text-warning` or amber
   (`thought-process-panel.tsx:1262-1263,1276,1308-1310`). There is no error red, no ✕ glyph for failure, and a
   denial is indistinguishable from a crash.
6. **"Ask to run again" is offered on a call the user just denied** (`thought-process-panel.tsx:626-630`). It seeds
   a prompt of raw JSON into the composer (`:635-638`), which is a developer affordance in a consumer chat.
7. **The same caption repeats** under every tool body: TOOLS_DESCRIPTION, "Exactly what Juno sent each connector…"
   (`thought-process-panel.tsx:1585`). With ten calls expanded you read it ten times.
8. **The strip's live copy is often wrong.** It says "Using X" after X has returned (it only checks whether the
   latest row's title starts with "Using"), "Thinking" while blocked on the user, and "Thinking" during a native
   web search. The one sentence meant to say what the run is doing now is the least reliable thing on screen.
9. **Too many "working" signals.** A research-plus-tools answer can show, at once: the strip's ThinkingDots, the
   WebSearchBlock shimmer and per-row SMIL globes, the 180px reasoning viewport translating, the stream-tail mask,
   and the artifact card's breathe, pulse and sweep. There is also a separate ResearchRunPanel below with its own
   motion. The code comments argue against a second loop in several places, yet the composite has five or more.
10. **The dock's header menus are overloaded.** The *Filter* icon opens Find, five kind filters, the Summary/Full
    radio and Expand/Collapse all (`thought-process-panel.tsx:754-822`). That is four unrelated controls behind
    one filter glyph.
11. **The third recap figure switches meaning.** It shows "Sources" or "Tool calls" but never both
    (`thought-process-panel.tsx:661-664`). A run with 9 sources and 4 tool calls shows only "9 Sources". The Cost
    figure is "—" for most runs.
12. **The live reasoning stays pinned above the answer while the answer streams.** The trace is visible whenever
    `streaming` is true, which includes the whole *write* phase (`activity-timeline.tsx:269`). The reader watches
    up to 180px of old reasoning sit between the question and the text being written.
13. **Two approval UIs** (chat vs Work) with different frames, copy and decision enums. A task handoff approval
    looks different from the approvals inside the task it starts.
14. **The finish note for `tool_calls`** reads "The model requested tools, but no tool flow is enabled for this
    request." (`message-item.tsx:1214-1215`). That is jargon, and confusing in a product whose tools are on.
15. **SourcesPill numbers every source 1..N** (`sources-pill.tsx:164-166`), even on native-search turns where the
    text has no `[n]` chips (`cited` is false). The numbers look like citation keys that point at nothing.

### 3.2 Information that is missing

| Missing | Where it should be | Today |
|---|---|---|
| **Inputs**, in human form | Inline, per call | Only raw redacted JSON in the dock. The inline strip shows none. |
| **Outputs** / result summary | Inline, per call | Only a raw 4,000-char head in the dock. There is no "3 results" or "Created ENG-123". |
| **Running indicator per call** | Inline and in the dock | None (`running:false` for every tool step) |
| **Durations** | Per call inline, per search | The dock only, and dispatch time only. Searches and sources have none. |
| **Connector logos** | Tool rows, approval card | A generic `AppIcons.connections` glyph (`thought-process-panel.tsx:219-220`). No `connectorId` on the row, although `connections/connector-logos.tsx` exists. |
| **Favicons** | Sources | Present but weak: `origin/favicon.ico` only, frequently a monogram, and dark glyphs vanish in dark mode (§3.8) |
| **Counts** | Search results per query, rows or items per tool result | None |
| **The native web-search query** | Strip and dock | Never sent to the client |
| **Why a call failed**, in plain words | The row | Raw connector error text, or "Action not permitted: …" |
| **Approval history** | Transcript and dock after the run | None. The card unmounts and the approval row is filtered out. |
| **Who approved, when, and at what scope** | The same | `decidedAt` and `decision` exist on the receipt but are never shown after the run |
| **Memory read / written** | The dock | Read receipts vanish at `done`. Writes ("Memory updated") are never shown. |
| **Artifact verification** | The artifact card or dock | Dropped (the payload is not serialized, and the kind is ignored) |
| **Task handoff call** | The dock | Filtered out (not a "Using" title) |
| **Warning detail** | The strip | Only the last warning's *title* (`thought-process-model.tsx:520`) |
| **Parallelism** | The dock | Parallel calls appear as sequential rows with no grouping |

### 3.3 Live streaming vs the reloaded view

| # | Live | After `done` or reload | Evidence |
|---|---|---|---|
| L1 | The dock can be open on the streaming turn | **It closes itself at `done`** (the id is swapped) | `use-chat.ts:668-676`, `chat-view.tsx:1096-1104` |
| L2 | ApprovalCard(s) above the answer | **Gone**, on `done` and on reload | `serializers.ts:156-199` (no approvals), `message-item.tsx:1268` |
| L3 | "Memory used" in Details, and a Memory row in SessionOutputs | **Gone at `done`** | `serializers.ts:72-117`, `session-outputs.tsx:160-163` |
| L4 | Artifact-verification payload on the activity row | Dropped | same |
| L5 | A stopped or errored call reads "Waiting for the connector to answer." | "The run ended before this call returned." with Ask to run again | `use-chat.ts:689-716`, `tool-detail.ts:319` |
| L6 | The reasoning viewport (≤180px) and the WebSearchBlock with the query | Not rendered. The query is visible only as dock rows. | `activity-timeline.tsx:269-272` |
| L7 | The strip names the current tool | The strip only counts calls | `activity-timeline.tsx:228-234` |
| L8 | Warnings render through the live strip | Hidden when there are no reasoning, tool or source nouns | `activity-timeline.tsx:240` |
| L9 | A re-attached run's clock starts at 0s | A settled run shows the true span | `thought-process-model.tsx:783-786` |
| L10 | The live clock is whole seconds (`12s`) | At rest it uses one decimal (`12.4s`) | `run-receipt.ts:46-55`. Intentional, but it re-flows the digit width. |
| L11 | Older versions (pager) | Drop the activity entirely, so the strip disappears | `message-item.tsx:921-923` |

### 3.4 Layout jank

- **The answer jumps up at completion.** The live trace block is `mb-3` with a reasoning viewport of up to 180px,
  plus the WebSearchBlock rows. It unmounts when `streaming` flips false (`activity-timeline.tsx:269-272,397-413`).
  A reader who has scrolled up to read the start of the answer sees it move by up to about 200px.
- **The approval card's removal** at `done` shifts the answer up by the card's height plus `my-5` and `mb-3`
  (`message-item.tsx:1268-1274`, `approval-card.tsx:449`). The card's own margins double up: `my-5` inside an
  `mb-3 space-y-2` wrapper.
- **The approval card pops in late.** It is `next/dynamic` with `ssr:false` and **no loading fallback**
  (`message-item.tsx:55-58`). The first approval of a session waits for a 24 kB chunk while the turn is blocked,
  and then the card inserts about 250px of content in one step.
- **The strip itself changes geometry at settle**: `min-h-9 gap-3` becomes `min-h-8 gap-2.5`, and `mb-0.5` becomes
  `mb-1.5` (`activity-timeline.tsx:305-309`). This is small but perceptible.
- **The live clock sits inside the truncating span** (`activity-timeline.tsx:340-355`). As the sentence grows, the
  count and the elapsed time are the first things clipped.
- **StreamStatus hands off to the strip.** The status line (min-h-10) shows only until the first activity event
  arrives, then the strip replaces it (`message-item.tsx:1277`). The two have different heights, and each keeps its
  own clock (`message-item.tsx:141-151` vs `useRunClock`).
- **Dock exit.** The column plays a 160ms slide-out while its content has **already unmounted**
  (`activity-timeline.tsx:418`, `chat-view.tsx:2421-2453`), so an empty card slides away.
- **The panel re-renders every row every second and on every reasoning delta.** `buildRun` is recomputed on each
  tick and delta (`activity-timeline.tsx:197-201`), and `StepRow` is not memoized. Expanded code blocks re-render
  too. Watch for scroll-follow jitter on long runs.

### 3.5 Accessibility

**Roles and live regions**

- The transcript is `role="log"` with `aria-live="off"` (`message-list.tsx:307-312`). Each answer body is polite
  once settled (`message-item.tsx:1319`). A single completion announcer says "Response complete, N words."
  (`message-list.tsx:231-250`).
- **Tool activity is never announced.** The strip's visible content is `aria-hidden`, and its `aria-label` changes
  only between "in progress" and "complete" (`activity-timeline.tsx:258-265`). Its resting label omits the nouns
  (searches, sources, tool calls) that sighted users see.
- **A blocked approval is silent.** The card mounts without an announcement. Its `role="status"` paragraph is
  empty while the request is pending (`approval-card.tsx:426-433,672-682`). Focus is not moved and the card is not
  scrolled into view.
- **Every approval card is labelled "Juno needs your approval."** The `aria-labelledby` header is the same text
  for all of them (`approval-card.tsx:479-486`), and the buttons are just "Allow once" and "Don't allow". With two
  cards, a screen-reader user cannot tell which action a button approves.
- **The dock's announcer lives inside the dock** (`thought-process-panel.tsx:923-925`). It announces only the
  phase word and the final summary, and only while the dock is open.

**Hidden but focusable (bug)**

- `activity-timeline.tsx:398` wraps WebSearchBlock in `aria-hidden="true"`. WebSearchBlock renders `<a href>`
  source links and a "Hide results" `<button>` (`web-search.tsx:176-233`). These are keyboard-focusable elements
  that are removed from the accessibility tree, which fails WCAG 4.1.2 and axe's `aria-hidden-focus` rule.

**Keyboard**

- The strip is a real button with `aria-expanded` and `aria-controls` only while mounted. Focus returns to it on
  close (`activity-timeline.tsx:164-174`). This is good.
- The dock takes focus on open (`thought-process-panel.tsx:425-427`). Esc closes it unless a nearer layer
  prevented the default (`chat-view.tsx:1106-1121`). Rows support ↑/↓/j/k/Home/End **only once focus is already
  in the spine** (`:572-591`).
- Non-openable rows are `div tabIndex=-1` (`:1485`). A run whose rows are all non-openable (legacy tool rows,
  searches) has **no Tab stop in the spine**, so the arrow navigation is unreachable.
- The hover-revealed row actions are invisible until focus-within. They stay in the tab order, so Tab lands on an
  invisible 28px button that reveals itself on focus. That is acceptable, but noisy: three Tab stops per row.

**Contrast (light theme)**

- `--warning` is `40 57% 45%`, about rgb(180,137,49), on `--card` (near white). That is about **3.1:1**.
- The "Failed" caption is `text-warning/80` at 12px (about 2.6:1) (`thought-process-panel.tsx:1309`). Failed
  step labels (`:1276`) and the Notice list items (`:1005,1009`) are `text-warning` at text-ui size. All three
  fail the 4.5:1 AA threshold for normal text.

**Other**

- The "Live" pill (`thought-process-panel.tsx:1179-1189`) is named only "Live". It is a jump-to-latest control,
  and the name does not say so.
- The completion announcer is in English only (`data-no-auto-translate`, `message-list.tsx:271`).

### 3.6 Reduced motion

**Handled well**

- ThinkingDots falls back to an opacity pulse (`thinking-dots.tsx:33-37`).
- The trace and search blocks stop translating (`globals.css:2755-2779`).
- The WebSearch globe becomes a static glyph (`web-search.tsx:53-54`).
- Grid-row disclosures use `motion-reduce:transition-none`.
- The approval card uses `motion-reduce:animate-fade-in`.
- The dock *entrance* has its own fade-only branch (`chat-view.tsx:2448-2449`).

**Gaps**

- The **dock exit** `slide-out-to-right-4` has no reduced-motion guard (`chat-view.tsx:2452`, and the same on the
  canvas at `:2506,2553`). No `--tw-exit-translate-x` override exists in `globals.css`.
- **Jump to latest** always uses `behavior:"smooth"` (`message-list.tsx:260`). `html{scroll-behavior:auto}`
  does not affect an explicit option.
- The panel reads `prefers-reduced-motion` **once**, with no change listener (`thought-process-panel.tsx:548-551`).
- The composite motion load (§3.1 point 9) is not governed by one budget. Each component guards itself, so there is
  nothing to keep "one loop per turn" true.

### 3.7 Internationalisation

**The mechanism.** `AutoTranslate` walks every text node and the attributes `aria-label`, `alt`, `placeholder`
and `title`. It replaces **exact, whole-node matches** against a build-time catalog, `i18n-catalog.generated`
(`auto-translate.tsx:183-214`). The catalog is harvested from JSX text and from literal values of copy-named props
and variables (`generate-i18n-catalog.mjs:12-45`). The consequences:

- **Any string composed at runtime never translates.** In the tool UI that is most strings:
  - The strip: `Reading ${domain}`, `Searching for “q”`, `Using ${tool}`, `4 searches · 9 sources · 2 tool calls`
    (`activity-timeline.tsx:65-75,218-234`), and the resting aria-label with its duration (`:258-265`).
  - The model: `Searched “q”`, `${domain} · listed`, `${n} tokens`, `plural()` (`thought-process-model.tsx:585,614,718,142-144`).
  - The dock: `toRunSummary`, "Thought for 2.1s, ran 3 searches…" (`run-receipt.ts:231-270`), `N of M`, `N steps`,
    `Jump to citation n`, `Open domain`, and the code-block labels `arguments · json · truncated` and
    `result · first 4000 of 26318 chars` (`run-receipt.ts:171-191`).
  - The server titles `Using ${server}` and `${connectorLabel} needs approval` (`route.ts:395,2903`).
- **The "COPY constant" workaround is defeated by concatenation.**
  - `approval-card.tsx:376-379` joins `decisionCopy[decision]` and `REPLAY_COPY.message` into **one** text node.
    Both halves are in the catalog, but the combined node never matches.
  - The same happens in `sources-pill.tsx:39-41`: `${n} ${AUDIT_COPY.claimsCited} · ${m} ${AUDIT_COPY.supported}`.
- **Word order is frozen.** `Expires in {countdown}` becomes two text nodes (`approval-card.tsx:516`). The first
  translates and the number stays glued after it, whatever the target language's word order.
- **Units and numbers are English.** `formatSpan` emits `s` and `m` (`run-receipt.ts:46-55`). Token counts are
  pre-formatted with commas on the server.
- **Server strings are control flow.** The UI branches on English titles (§1.2), so producer copy cannot be
  localized server-side without breaking the client.
- **RTL is not supported.** The document gets `dir` set (`auto-translate.tsx:103-104`), but the tool UI uses physical
  properties throughout:
  - the spine hairline at `before:left-[0.625rem]` (`thought-process-panel.tsx:1058`)
  - the row action at `right-0` (`:1496`)
  - `ml-auto`, `-ml-1`, `pl-[38px]` (`sources-pill.tsx:44`) and `text-right` (`:164`)
  - disclosure carets that are `ChevronRight` with `rotate-90`
  - the dock sliding `from-right`
- **Performance for non-English users.** Any DOM mutation schedules a full-document walk within 20ms
  (`auto-translate.tsx:237-258,262-270`). Streaming produces 30 to 60 mutations a second plus 1Hz clocks, so the
  whole document is walked up to about 50 times a second during every answer.

### 3.8 Dark mode

- Surfaces are token-based. The warning-tinted surfaces carry explicit dark overrides: the approval card
  `dark:bg-warning/[0.14]` (`approval-card.tsx:460`) and the Notice band `dark:bg-warning/10`
  (`thought-process-panel.tsx:997`). This is good.
- **Favicons on dark.** `SourceFavicon` paints `bg-muted` behind a transparent favicon (`source-chip.tsx:127`).
  Common dark-glyph icons (GitHub, Vercel, X, Medium, many docs sites) nearly disappear on the dark `--muted`.
  There is no light plate and no ring.
- **Artifact previews** are deliberately a white sheet inside the dark card (`artifact-inline-card.tsx:392-402`).
  It is framed, but it is still the brightest object in a dark transcript.
- **Code blocks in the dock** are `bg-secondary` on `bg-card`. That is a one-step contrast in dark and barely
  visible, but acceptable.
- **Failed vs notice** share `text-warning`, which in dark is a light amber. A failed call and a warning are
  indistinguishable in both themes.

### 3.9 Mobile width (below the `@[50rem]/split` container step)

- **The dock goes full-bleed and the chat column is hidden** (`chat-view.tsx:1999`). The composer is hidden too.
  Three consequences:
  - **An approval that arrives while the dock is open is not visible anywhere.** The dock does not surface
    approvals, and the strip there says "Thinking".
  - "Back to chat" is the only way out. There is no peek or bottom-sheet pattern.
  - Opening a citation (`jumpToCitation`) closes the dock first (`thought-process-panel.tsx:610`), which is correct.
- **The strip truncates the sentence together with its clock** (§3.4).
- **Tool bodies nest scrollers inside the dock's scroller.** The code blocks have `maxBodyHeight` 220 and 320
  (`thought-process-panel.tsx:1558,1575`, `code-block.tsx:191-192`). That is scroll-in-scroll on touch, and it
  contradicts the panel's own "no inner scroller" rule (`:75-77`).
- **The approval card's scope button** is a full sentence, "Allow this action for this connector"
  (`approval-card.tsx:664`). On a 375px screen it wraps to its own full-width row.
- Coarse-pointer adaptations exist throughout: row actions are always visible under `coarse:` and the targets are
  `min-h-11`.

### 3.10 Performance, as it affects UI smoothness

- **The run model is rebuilt on every reasoning delta and on each 1Hz tick.** When the dock is open, every
  `StepRow` re-renders, because `buildRun` returns new step objects and `StepRow` is not memoized
  (`activity-timeline.tsx:197-201`, `thought-process-panel.tsx:1037-1080`).
- **`toReasoningLines(reasoning)` re-chunks the whole trace on every delta** (`activity-timeline.tsx:269`).
- **AutoTranslate walks the full document on each mutation** (§3.7).
- **SourcesPill keeps the full source list mounted but `inert`** (`sources-pill.tsx:280-296`). For a 100-source
  research answer that is about 100 rows plus favicon requests per turn in the DOM.

### 3.11 Cross-surface consistency

| Aspect | Chat strip / dock | ApprovalCard (chat) | Work approvals | Code activity | Research |
|---|---|---|---|---|---|
| Motion stack | CSS (tailwindcss-animate + aicss) | CSS | framer-motion (`work-run-panel.tsx:4`) | CSS | Its own components |
| Status vocabulary | ok / failed + absence | 9 receipt statuses | allowed / denied | ok / failed / unknown (exit code) | research states |
| Failure colour | warning (amber) | warning | per work vocabulary | destructive | — |
| Name source | English title prefix | receipt fields | receipt fields | `toolLabel(event)` | DTO kinds |

---

## 4. Rendering bugs

Each bug has a severity, the evidence, and a way to reproduce it.

**B1. High. The thought dock closes itself when the answer finishes.**

- **Evidence.** `ActivityTimeline` computes `open = panel.openId === messageId` (`activity-timeline.tsx:154`). The
  `done` frame swaps the message to the server object, whose id differs from the temp id (`use-chat.ts:668-676`,
  where only `renderKey` is kept). `chat-view.tsx:1096-1104` then clears `thoughtOpenId` because no message has
  that id any more, and it does so with no exit animation.
- **Repro.** Send any message, open the strip while it streams, and wait for completion. The dock snaps shut.
  Regenerate and edit-and-resend behave the same way.

**B2. High. Approval cards are lost at completion and on reload.**

- **Evidence.** The cards render from `message.approvals` (`message-item.tsx:1268-1274`). `done` replaces the
  message with `serializeMessage(...)` (`route.ts:3186-3190`), which has no `approvals` field
  (`serializers.ts:156-199`). Nothing re-fetches `/api/approvals`.
  - The "receipt outlives the question" copy (`approval-card.tsx:70-87`) is therefore reachable only while the
    turn is still streaming.
- **Also affected.** The answer text shifts up when the card unmounts.

**B3. High. `memoryReceipt` and `artifactVerification` are dropped by `serializeActivity`.**

- **Evidence.** `serializers.ts:72-117` rebuilds rows from named fields and omits both. `done` uses it, so the
  dock's "Memory used" section (`thought-process-panel.tsx:1122-1154`) and SessionOutputs' Memory row
  (`session-outputs.tsx:160-163,204-211`) disappear as the answer finishes. The data is still stored in
  `Message.activity`.

**B4. High. No running state for tool calls, and the live copy lies.**

- **In the dock**: `buildSteps` sets `running:false` for every tool step (`thought-process-model.tsx:680-693`).
- **In the strip**: `liveCopy` shows "Using X" whenever the latest row's title starts with "Using"
  (`activity-timeline.tsx:73-76`), so it keeps showing it after completion. That is because completion is an
  in-place update that leaves the row latest.
- **While waiting for approval**, the latest row is "X needs approval", so the copy falls through to "Thinking" and
  the think-time ladder (`:82-94`). The status is also forced to `"thinking"` (`use-chat.ts:583`).

**B5. Medium-high. Denials are rendered as failures and offered a re-run.**

- **Evidence.** `mcp.ts:482-485` returns `ok:false` with "Action not permitted: …" for any refused authorization.
  The panel marks `status==="failed"` as "Failed" (`thought-process-panel.tsx:1308-1310`) and makes it
  `rerunnable` (`:626-630`).

**B6. Medium. Anthropic's live tool rows show a false note about missing arguments.**

- **Evidence.** `ToolCallInput.args` is "Absent on Anthropic" (`tool-detail.ts:156`), so `applyArgs` sets
  `argsNote:"unavailable"` (`:171-175`) on the open row. The panel prints "The provider did not send the arguments
  for this call." (`run-receipt.ts:111`, `thought-process-panel.tsx:1564-1569`) until `close` re-derives the
  arguments (`tool-detail.ts:243-250`).

**B7. Medium. After a Stop or error mid-call, the row still says it is waiting.**

- **Evidence.** The `error` frame (`use-chat.ts:689-716`) and the Stop catch path (`:1157-1166`) never touch
  `activity`, so `resultNote:"pending"` renders as "Waiting for the connector to answer." Only
  `readToolDetail` on reload rewrites it to `unfinished` (`tool-detail.ts:319`). "Ask to run again" is therefore
  not offered live, although it is after reload.

**B8. Medium. Warnings disappear on quiet turns.**

- **Evidence.** `if (!streaming && !hasReasoning && !restingDetail) return null;` (`activity-timeline.tsx:240`).
  `restingDetail` counts only searches, sources and tool calls (`:228-234`); `run.note` is not considered. A
  non-reasoning model with a "Model changed", "Skill not applied", "Connected tools are off in private chat" or
  "Usage limit reached" warning shows it only while streaming.

**B9. Medium. Producer events are silently discarded** (see the table in §1.6).

- **Evidence.** Title-filtered consumption in `thought-process-model.tsx:363-424`, for example
  `e.title.startsWith("Using ")` at `:406` and `T_EFFORT` only at `:366`. The `artifact` kind is never read.

**B10. Medium. The live trace unmounts at `done` and shifts the answer.**

- **Evidence.** `reasoningLines` and `showSearch` are computed only while streaming
  (`activity-timeline.tsx:269-272`). The trace block, `mb-3` plus up to 180px, is conditional on them (`:397-413`).

**B11. Medium. Focusable content sits inside `aria-hidden`.**

- **Evidence.** `activity-timeline.tsx:398` wraps WebSearchBlock, which renders links and a button
  (`web-search.tsx:176-233`).

**B12. Medium. The clock resets to 0 when a run is re-attached.**

- **Evidence.** `useRunClock` calibrates `skew = Date.now() − createdAt(first event)` on the first streaming render
  that has an event (`thought-process-model.tsx:783-786`). On a reopened or resumed tab, the placeholder mounts with
  `streaming:true` and no events (`use-chat.ts:976-985`), and then the *whole* log replays from seq 0 (`:1026`). The
  first event is minutes old, so it is absorbed as skew, and `elapsed ≈ 0` and counts up again. The "Still
  thinking" ladder restarts with it.

**B13. Low-medium. The dock's exit animation runs on an empty column.**

- **Evidence.** The portal renders only while `open` (`activity-timeline.tsx:418`), but the container lingers for
  the exit via `closingThoughtId` (`chat-view.tsx:1055-1063,2421-2453`).
- **Also.** The exit slide is not guarded for reduced motion (`:2452`).

**B14. Low. Errored runs are labelled "Stopped".**

- **Evidence.** `stopped = events.length>0 && !usageEv && !streaming` (`thought-process-model.tsx:522`). The header
  word is `Stopped` (`thought-process-panel.tsx:654-656`) and the summary prefix is "Stopped after …"
  (`run-receipt.ts:260`), even for provider or network errors.

**B15. Low. The live clock and count are truncated with the sentence.**

- **Evidence.** They sit inside the same `truncate` span (`activity-timeline.tsx:340-355`).

**B16. Low. i18n concatenation defeats the catalog.**

- **Evidence.** `approval-card.tsx:376-379`, `sources-pill.tsx:39-41,60-62`. The completion announcer is excluded
  from translation (`message-list.tsx:246,271`).

**B17. Low. SessionOutputs reports capability as use.**

- **Evidence.** `if (ev.kind === "search" && !m.sources?.length) searchTurns += 1` (`session-outputs.tsx:158`)
  counts the "Preparing web search" intent row. This contradicts the file's own rule at `:45-50`.

**B18. Low (product gap). The code-interpreter blocks are orphaned.**

- **Evidence.** `PythonExecutionBlock`, `DataChartBlock` and `DataTableBlock` have no importers outside
  themselves.

**B19. Low. The approval chunk loads late.**

- **Evidence.** `ApprovalCard` uses `nextDynamic(..., {ssr:false})` with no `loading` (`message-item.tsx:55-58`).
  The blocked turn shows nothing until the chunk arrives.

**B20. Low. The approval card's local snapshot masks newer props.**

- **Evidence.** `current = decided ?? approval` (`approval-card.tsx:326-328`), and `onDecided` is not passed by
  `message-item.tsx:1271`, so `message.approvals` never updates.
- **Plausible consequence.** A reconnected stream replays the original `pending` frame. It then shows an
  answerable card for an already-decided request until the user presses a button and gets "already_decided".

**B21. Low. The `tool_calls` finish note is misleading.** See `message-item.tsx:1214-1215`.

**B22. Low. Reduced motion is ignored** by jump-to-latest (`message-list.tsx:260`) and the dock exit
(`chat-view.tsx:2452`).

**B23. Low. The Effort fact is missing for the Auto model.**

- **Evidence.** The title is "Auto thinking" (`route.ts:2752,2758`), but only "Reasoning mode enabled" is matched
  (`thought-process-model.tsx:152,366`).

**B24. Low. Type drift.** `patch` and `exitCode` are persisted and served (`serializers.ts:95-111`) but not
declared on `ClientActivityEvent` (`types/chat.ts:235-261`).

**B25. Low. Favicons on `http:` origins** request `http://host/favicon.ico` from an https page
(`source-chip.tsx:60-68`). The result is mixed-content upgrade or block and console noise.

**B26. Low. Research panels without `createdAt` are misplaced.**

- **Evidence.** `research.run.createdAt ?? ""` (`chat-view.tsx:2262`) becomes `Date.parse("")`, which is NaN, so
  the panel falls to the end of the transcript (`message-list.tsx:119-127`).

---

## 5. Dev gallery coverage (`src/app/dev/*`, all `notFound()` in production)

| Gallery | Tool-UI components rendered | Gaps |
|---|---|---|
| `/dev/aicss` | `ThinkingReasoning` (header and headless), `WebSearchBlock` (live, settled, no query), citation footer | Not shown inside `ActivityTimeline`. No reduced-motion toggle. |
| `/dev/polish` | Real `MessageItem` with prose, a table and cited sources | **No `activity`, no `tool`, no approvals.** The strip and dock never render. |
| `/dev/task-handoff` | `ApprovalCard` (task: expensive, untrusted, started, declined, expired; plus one connector) | No connector risk classes beyond one. No refusal outcomes. |
| `/dev/composer-landing` | `WorkRunPanel` live, waiting and done | — |
| others (controls, documents, glyphs, learning, library, memory, settings, shell, skills) | none of these components | — |

**Not covered by any gallery**:

- `ActivityTimeline` in any state
- `ThoughtProcessPanel`, including all tool body variants: pending, unfinished, failed, over_budget, truncated
- `SourcesPill` with an audit
- `GenerationPlaceholder`
- `ArtifactInlineCard` streaming or error
- the dock at the split and below it

Visual verification of the rework needs a fixture set that feeds `ActivityTimeline` synthetic event arrays for
every row in §2.3.

---

## 6. What the redesign must change (derived requirements)

1. **A real tool-call record**, not titles. It needs:
   - `{ callId, kind: "connector"|"web_search"|"fetch"|"code"|"memory"|"artifact"|"task"|"image"|…, connectorId, displayName, verb, status: "queued"|"running"|"awaiting_approval"|"succeeded"|"failed"|"denied"|"blocked"|"expired"|"cancelled", startedAt, endedAt, durationMs, argsSummary, resultSummary, counts, args?, result?, approvalId?, error{code,message}? }`
   - It must be persisted **and** serialized. Approvals must be linked by `callId` and persisted onto the turn.
   - Drop string-prefix discrimination entirely, so that producer copy can be localized.
2. **Inline, per-call blocks in the transcript**, in the idiom Juno Code already has and Claude and ChatGPT use:
   - a logo or favicon, a humanized verb and object, a live spinner or duration, and a success or failure glyph
   - one click to see inputs and outputs, with parallel calls grouped
   - the right-hand dock stays for the full run, not as the *only* place a call is visible
3. **Approval as a state of the call.** The card is part of the call block and survives completion as a compact
   receipt ("Allowed once by you at 14:02"). Denied is distinct from failed, and re-run is never offered for a
   denial.
4. **One live-status source of truth**, derived from call states:
   - Awaiting approval must say so, in the strip and in the dock, and be announced.
   - Native search must say "Searching the web for …" once the query is plumbed through.
5. **A stable identity across `done`.** Key the dock and any per-turn UI state on `renderKey`, or remap it, so the
   temp-to-server id swap cannot close or reset anything (B1).
6. **Layout-stable completion.**
   - Collapse the live trace into the resting row with a height-preserving transition, or reserve the space.
   - Collapse the reasoning when writing starts, as Claude and ChatGPT do.
7. **Accessibility.**
   - A polite announcer for call start and end and for approval requests.
   - Unique approval group names.
   - No focusables under `aria-hidden`.
   - Tab reachability into the spine.
   - Error red that is distinct from notice amber, with ≥4.5:1 text.
8. **i18n.**
   - Move composed strings to an ICU-style `t(key, {n, name})` so the catalog can match.
   - Pluralize with `Intl.PluralRules`, format numbers and durations with `Intl`, and use logical CSS properties
     for RTL.
   - Stop walking the full DOM on every streaming mutation.
9. **One motion budget per turn.**
   - At most one looping indicator per turn.
   - Every exit and scroll must honour reduced motion.
   - Motion should be shared between the chat, Work and Research surfaces, not three stacks.
10. **Gallery fixtures** for every state in §2.3, before any reimplementation lands.

---

## Appendix A. File inventory (`src/components/chat` unless noted)

| File | Lines | Role in the tool UI |
|---|---|---|
| `activity-timeline.tsx` | 439 | The inline strip, the live trace, the portal into the dock, and `liveCopy` |
| `thought-process-model.tsx` | 804 | `buildRun`, `buildSteps`, `useRunClock`, and the Step and RunModel types |
| `thought-process-panel.tsx` | 1,647 | The dock: header, recap, spine, StepRow, ToolBody, MemoryBody, Details |
| `thought-panel-context.tsx` | 69 | The open id, the container, `seedDraft` and `coversChat` |
| `message-item.tsx` | 1,613 | Turn composition: strip, approvals, placeholder, StreamStatus, body, sources, audit |
| `message-list.tsx` | 430 | log region, follow-scroll, completion announcer, inlineRuns placement |
| `approval-card.tsx` | 694 | The connector and task approval card (chat) |
| `source-chip.tsx` | 254 | Inline `[n]` chip and `SourceFavicon` |
| `sources-pill.tsx` | 299 | The bibliography pill and list, with the per-source audit |
| `session-outputs.tsx` | 433 | Header popover: Outputs and "Used in this session" |
| `generation-placeholder.tsx` | 133 | The image or video generation placeholder |
| `artifact-inline-card.tsx` | 457 | The inline artifact preview card |
| `citation-audit.tsx` / `citation-audit-panel.tsx` | 653 / 585 | Research citation audit |
| `research-run-panel.tsx` | 132 | Router to ResearchConsole or ResearchRecap |
| `work-run-panel.tsx` | 440 | The inline background-task panel (framer-motion) |
| `python-execution-block.tsx`, `data-chart-block.tsx`, `data-table-block.tsx` | 164 / 98 / 205 | **Orphaned** |
| `inline-visual-block.tsx`, `step-lab-block.tsx` | 589 / 1,073 | Model-authored visuals (not tools) |
| `chat-view.tsx` | 2,589 | Dock column, coexistence rules, Esc, self-heal, inlineRuns |
| `src/types/chat.ts` | 434 | Wire and message types |
| `src/hooks/use-chat.ts` | 1,907 | Frame applier, stop, reconnect and recovery |
| `src/lib/chat/tool-detail.ts` | 330 | Tool-detail open, close and read policy |
| `src/lib/run-receipt.ts` | 468 | Tool note copy, labels, summary, `formatSpan` |
| `src/lib/serializers.ts` | — | `serializeActivity` (field whitelist) and `serializeMessage` |
