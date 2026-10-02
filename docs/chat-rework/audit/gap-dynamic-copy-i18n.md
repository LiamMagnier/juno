# Gap audit: dynamic copy and i18n for the chat rework

**Question.** The rework puts copy that carries arguments into almost every new surface: tool labels,
phase labels, the "Thought for 12s · 5 sources" summary, the Research estimate line, research
narration, approval and announcer copy, and durations and plurals everywhere. Juno ships 20 UI
locales through an exact-match DOM walker. No earlier report worked out how this copy gets
localised, or what language model-written research text should be in. This report does.

**Scope.** Web app, branch `web/tools-thinking-research`, read-only. Inputs: `DECISIONS.md` (T2,
T3, T6, U1, U2, U6, R2, R4, R5, R7), `internal-tools-ui.md` §3.7, `external-motion-audit.md` §3.2
and §3.9–3.13, `external-deep-research-audit.md` §6.2 and §11. File and line references are to
this worktree as of 2026-09-23. Browser-support claims were checked against MDN and the TC39
proposal repo on that date. Plural categories and formatter outputs were run in Node 26 (ICU from
V8), which matches current evergreen browsers.

---

## 0. Summary

1. **Today nothing with an argument in it is translated.** `AutoTranslate` replaces a DOM text
   node or attribute only when its *whole* trimmed value equals a catalog entry
   (`auto-translate.tsx:190-196`, `:207`). The catalog is harvested from string literals
   (`generate-i18n-catalog.mjs:90-141`). It has 5,482 entries in this worktree and **none contains a
   placeholder**. There is no `t()`, no `Intl.PluralRules` anywhere in `src`, 8 local English
   `plural()` helpers, and 155 inline `=== 1 ? "…"` ternaries.
2. **The server does not know the user's locale when it writes copy, and cannot know it
   reliably.** The chat route reads `responseLanguage` (`route.ts:970,2252`) but not `uiLocale` or
   `Accept-Language`. On top of that, the client may override the server's locale from
   `navigator.languages` (`auto-translate.tsx:95-99`). **Only the client knows the effective UI
   locale.** That decides the architecture: the server sends `{key, params}`, and the client formats.
3. **Precedents exist but they are partial.**
   - Tool-detail notes already travel as codes (`tool-detail.ts:73-74`). The client maps each code to
     a whole sentence (`run-receipt.ts:110-122`), and that sentence translates because it is an exact
     literal.
   - `memory-time.ts:17-45` formats relative dates with `Intl.RelativeTimeFormat` in `<html lang>`.
   - Server literal titles such as `title: "Searching the web"` translate *by accident*, because
     `title` is a harvested property name. Ternary, `switch` and template titles do not.
   - Native shows server titles raw, and matches on two of them in English
     (`NativeSearchActivity.swift:13,23,68`).
4. **Streaming cost.** Every DOM mutation schedules a full-document walk within 20 ms
   (`auto-translate.tsx:239-266`). `data-no-auto-translate` stops *rewriting* but not *walking*: the
   walker still visits every text node under an excluded element and calls `closest()` on it.
   Because the observer callback ignores its records (`:259`), a streamed token anywhere triggers a
   whole-body scan.
5. **Recommended architecture:**
   - **Wire.** Server copy travels as `{key, params}`, with typed, raw params. The legacy English
     `title`/`message` fields stay for shipped native builds.
   - **Messages.** Messages are declared with `defineMessages()` in a small ICU MessageFormat-1
     subset. The extractor harvests and validates them.
   - **Translation.** The existing translation route handles them with placeholder validation
     against the target locale's CLDR plural categories.
   - **Client runtime.** A client runtime (`formatMessage`, `<Msg>`) renders already-localised text
     marked `data-no-auto-translate`. Durations, lists, ranges, dates and money go through `Intl`.
   - **AutoTranslate.** AutoTranslate prunes excluded subtrees and ignores their mutations.
6. **Language of model-written text.** This needs an owner decision. The recommendation is **one
   `contentLanguage` per turn or run**, resolved as: an explicit `responseLanguage` setting, else the
   language of the user's request (detected by the planner), else the UI locale. It is frozen on the
   research run. It applies to:
   - the approach, the questions, the narration, the report and the summary;
   - search queries and other argument echoes, which stay verbatim and bidi-isolated;
   - quotes, which are never translated.
7. **Hidden language dependencies surfaced.**
   - The report writer dictates English section headings (`corpus.ts:204-215`).
   - The claim extractor and the Sources stripper key on `## Sources` and English sentence rules
     (`claim-analysis.ts:490-553,615`, `message-item.tsx:411`). A Japanese or German report
     silently loses citation-audit coverage.
   - R3 moves every run to the background engine, which has **no** language rule. The chat path had
     one through the system prompt (`route.ts:2819`, `system-prompt.ts:355-357`).
   - The approval `preview` is an English sentence bound into the receipt digest
     (`action-approval.ts:305,352-357`).
8. **Effort:** about **16–21 engineer-days** on the web. About 9 of those are infrastructure that
   the rest of the rework then reuses. §5 has the breakdown.

---

## 1. The current mechanism

### 1.1 `AutoTranslate`, the client DOM walker (`src/components/i18n/auto-translate.tsx`)

| Aspect | Behaviour | Evidence |
|---|---|---|
| Mount | Mounted once by `Providers` for every page | `providers.tsx:43` |
| Locale | Uses the server-resolved `locale`. When `autoDetect` is on and the server chose English but `navigator.languages` is not English, the **client switches locale on its own** | `:95-99` |
| `<html lang/dir>` | Set on every run, before the English bail-out | `:103-104` |
| English | Returns before doing anything | `:105` |
| Catalog | Loaded with a dynamic `import()` only for non-English readers (about 131 KB gzip, per the comment) | `:8-34` |
| Matching | `TreeWalker(SHOW_TEXT)` over `document.body`. Each text node is split into whitespace and core, and the **core must equal a catalog source exactly** (whitespace collapsed) | `:182-199`, `:49-57` |
| Attributes | `aria-label`, `alt`, `placeholder`, `title`, also exact whole-value match. It is a second pass over `[root, ...root.querySelectorAll("*")]` | `:35`, `:201-213` |
| Exclusions | `[data-no-auto-translate]`, `[translate='no']`, `[contenteditable='true']`, `code`, `pre`, `script`, `style`, `svg`, `math`, `textarea` (the textarea's placeholder is still translated) | `:36-47`, `:74-80` |
| Exclusion cost | `excluded(parent)` is a `closest()` call **per visited text node**. Excluded subtrees are still traversed; they are just not rewritten | `:189`, `:203` |
| Fetching | Missing ids are sent in chunks of 30 to `/api/i18n/translations?locale=&ids=`. **Only opaque ids leave the device** | `:156-160`, `:228-230`, `:83-86` |
| Failure | A 429 or 5xx backs off for 5 min or 30 s and retries. Any other failure marks the id `failed` for the page's lifetime | `:163-176` |
| Cache | `localStorage["juno:ui-translations:<locale>:v1"]`, pruned to known ids | `:122`, `:132-154` |
| Cadence | A scan is scheduled 20 ms after **any** mutation. The observer watches `childList`, `characterData` and the four attributes over the whole subtree, and its callback **ignores the records** | `:239-266` |

**Streaming cost.** During an answer, the markdown body, the reasoning viewport, the 1 Hz clocks
and the rolling counters mutate 30–60 times a second. Each burst produces one full scan within
20 ms. That is up to about 50 whole-body walks a second (`internal-tools-ui.md` §3.7, §3.10), each
O(text nodes + elements) with a `closest()` per node and an array spread of every element. The
answer body's `data-no-auto-translate` (`markdown.tsx:646`) does not reduce this, because
exclusion is checked per node after the node has been visited. The reasoning viewport
(`aicss/thinking-reasoning.tsx`), the web-search block (`aicss/web-search.tsx`), the thought panel
and every research component carry no exclusion at all.

**A second cost that matters for the rework.** When React later writes the same text node (a
label change), it writes English. The observer then re-translates within 20 ms. A live phase label
therefore flashes English on every change in non-English locales, and under U2's shimmer the
flash is visible.

### 1.2 The extractor (`scripts/generate-i18n-catalog.mjs`)

It runs at `predev` and `prebuild` (`package.json:6-9`). The output is gitignored
(`.gitignore:101-107`).

**What it harvests** from every `src/**/*.ts(x)`:

- **JSX text** (`:91`).
- **Literal values** of the JSX attributes and object properties in `COPY_PROPERTIES`: `alt`,
  `aria-label`, `body`, `caption`, `description`, `detail`, `emptyLabel`, `error`, `eyebrow`,
  `heading`, `helpText`, `label`, `lede`, `message`, `openLabel`, `removeLabel`, `phrases`,
  `placeholder`, `subject`, `term`, `title`, `tooltip` (`:12-46`, `:93-116`). Arrays of literals
  are harvested under a copy property (`:109-114`).
- **Every literal inside the initializer of a variable** whose name ends in `Label`, `Title`,
  `Heading`, `Description`, `Message`, `Note`, `Placeholder`, `Copy` or `Tooltip`, or in the
  `_LABEL`, `_TITLE`, `_NOTE`… forms (`:118-129`).
- **The first literal argument** of `toast.success|error|message|info|warning(…)` and `Error(…)`
  (`:131-137`). A bare `toast(…)` is not harvested.
- **String literals rendered directly as JSX children**, including inside `?:` branches
  (`:70-88`, `:139-141`).

**Filters.** A string must be 2–300 characters and contain a letter (`:48-58`). Only
`StringLiteral` and `NoSubstitutionTemplateLiteral` count (`:60-63`). **A template with `${}` is
invisible.** So is a literal behind a ternary in a property, a `switch` `return`, or a function
argument.

**Identity.** `id = sha256(source).slice(0, 16)` (`:163-168`). Any wording change is a new id,
which invalidates every cache automatically.

**Consequences, verified against the generated catalog:**

- **In the catalog.** Server literal titles written as `title: "…"` are in: "Searching the web"
  (`deep-research.ts:149`), "Connected tools ready" (`route.ts:2741`), "Model stopped responding".
  They translate when the client renders them as a whole node.
- **Not in the catalog.**
  - "Reasoning mode enabled" (a ternary at `route.ts:1108,2752`).
  - Every finish reason (`switch` returns, `finish-reason.ts:65-80`).
  - `Using ${server}` and `${connectorLabel} needs approval` (`route.ts:395,2903`).
- **Harvested by accident.** `description` and `title` are harvested **wherever they appear**. A
  T2 `ToolSpec` with a short model-facing `description: "…"` would enter the UI catalog and be sent
  to the translator. Model-facing text needs a namespace the extractor skips (§6, I-13).

### 1.3 Machine translation (`src/app/api/i18n/translations/route.ts`)

**How a request is served:**

- **Runtime, on demand.** Nothing is translated at build time. The route has no auth, accepts at
  most 30 known ids (`:9-10`, `:73-77`), and answers English from the source (`:80-82`).
- **Cache key.** Language plus script; the region is dropped. `pt-BR` is translated as `pt`
  (`:43-47`).
- **Caches:**
  - process memory, `globalThis.junoUiTranslations` (`:12-14`), lost on every deploy;
  - the CDN, `s-maxage` 30 days (`:22`);
  - the browser's `localStorage`.
- **Model.** The shared utility-model walk, `runUtilityPrompt`, with a platform policy and
  `userId: null` (`:126-155`). Rate limits are 4,000 per hour globally and 200 per hour per IP,
  counted on cache misses only (`:103-111`).

**The prompt** (`:156-160`) asks for a JSON object with the same keys, and to "preserve … variables,
numbers, and punctuation where appropriate".

**What is missing:**

- **No placeholder validation and no plural awareness.** A partial answer is accepted
  (`:164-167`). Values over 600 characters are dropped (`:174`).
- **No persistent store and no human review.** The only durable copy is at the CDN edge.

### 1.4 Locale resolution

- **`src/lib/i18n.ts`:**
  - Canonicalises locale tags (`:17-31`).
  - Reads Accept-Language (`:34-52`).
  - `RTL_LANGUAGES` (`:15`) and `directionOf` (`:63-65`).
- **`UI_LOCALES`** holds 20 locales (`:95-106`): en, es, fr, de, it, pt-BR, nl, pl, tr, ru, uk, sv, id,
  vi, th, hi, ja, ko, zh-Hans and zh-Hant.
  - **RTL is withheld on purpose** (`:98-105`): 176 physical `pl-/pr-/ml-/mr-/left-/right-`
    utilities against 16 logical ones would mirror the text and leave the layout pinned LTR.
  - A looser regex today finds about 475 physical-direction tokens in `src/**/*.tsx`, 125 of them in
    chat and research components. The method differs from the comment's, so treat the number as an
    order of magnitude.
  - The tool UI alone uses physical offsets for the spine, row actions, `ml-auto`, `text-right` and
    the dock's `from-right` (`internal-tools-ui.md` §3.7).
- **`src/lib/i18n-server.ts`** gives `getRequestLocale(override)`, which is the stored `uiLocale`,
  or Accept-Language when it is "auto" (`:15-17`). It is used **only** by the root layout, for
  `<html lang dir>` and for the value handed to `AutoTranslate` (`layout.tsx:108-118,144`).
- **Two separate settings** (`schema.prisma:389-393`):
  - `uiLocale` holds a BCP-47 tag or "auto";
  - `responseLanguage` holds an English language *name* ("French") or "auto". It is injected into
    the chat system prompt as "Always respond in X, regardless of the language of the question"
    (`system-prompt.ts:355-357`).

### 1.5 Does the server know the locale when it composes copy?

**No.**

- **Chat route.** It reads `responseLanguage` (`route.ts:970,2252`). It never reads `uiLocale` or
  `Accept-Language`. The chat request carries neither a locale nor a time zone (`chat/request.ts`).
  The model's date line is `en-US` server time (`anthropic.ts:71-79`).
- **Background workers.** The research engine has no request at all. `ResearchRun` has no locale or
  language column (`schema.prisma`, `model ResearchRun`), and no research prompt mentions language
  (`research/tools.ts:203-317`, `agents/lead.ts:34`, `agents/worker.ts:163`, `corpus.ts:204-236`).
- **Why it cannot know reliably.** Even with the header and the setting, the effective UI locale can
  be changed by the client (`auto-translate.tsx:95-99`). **The effective UI locale is a client
  fact.** The one piece of code that formats in it, `memory-time.ts:17-19`, reads
  `document.documentElement.lang` for exactly this reason (its comment is at `:7-9`).

### 1.6 Where composed or plural strings do get localised today

| Precedent | How | Limits |
|---|---|---|
| Codes on the wire → whole sentences in the client | `ClientToolDetail.argsNote/resultNote` are enums (`tool-detail.ts:73-74`). `TOOL_ARGS_NOTE` and `TOOL_RESULT_NOTE` map them to complete sentences whose `_NOTE` names the extractor harvests (`run-receipt.ts:110-122`, and the warning at `:126-135`) | No parameters |
| Research events | `kind + payload` (`domain.ts:391-445`). Text is composed on the client | …by template literals that never translate (`run-timeline.tsx:377,385,395,494,784`) |
| `Intl.RelativeTimeFormat` | "3 days ago" in `<html lang>` (`memory/memory-time.ts:21-45`) | The only formatter that follows the UI locale |
| `Intl.NumberFormat` and dates in Settings | `components/settings/format.ts:21-60`. It fixes `en-US` and UTC for SSR and hydration (`:28-47`) | It formats in the **browser default** (`locale: undefined`), not the chosen `uiLocale` |
| Native `inflect: true` | 4 iOS catalog keys use automatic grammar agreement, e.g. `^[%@ file](inflect: true)` | English values only; the French translations do not cover them |

**Everything else that carries a number or a name is English in every locale.** Examples:

- the completion announcer, "Response complete, N words." (`message-list.tsx:241-246`), which is
  marked `data-no-auto-translate` (`:271`), so it is English even when the rest of the page is not;
- the strip copy and plurals (`activity-timeline.tsx:63-75,218-237,258-266`);
- the run summary (`run-receipt.ts:231-270`) and its English list and "once/twice" helpers
  (`:193-210`);
- the durations (`run-receipt.ts:46-55`, `thought-process-model.tsx:130-140`);
- the approval concatenation and countdown (`approval-card.tsx:376-379,516-519`);
- the "Research corpus ready" detail (`deep-research.ts:377-383`);
- research dollars and durations (`run-format.ts:15-36`).

### 1.7 Native: `Localizable.xcstrings` and server titles

- **One catalog**, `native/iOS/JunoMobile/Resources/Localizable.xcstrings`, bundled by macOS too
  (`macOS/JunoDesktop/project.yml:57`).
  - 510 keys, source `en`, only `fr` translated (386 of 510). `knownRegions` is en and fr
    (`project.yml:7-9` in both apps).
  - 29 keys use format specifiers, and **0 keys use plural `variations`**. The hand-plural
    anti-pattern exists here too: `%@ item%@ waiting`, `%@ file change%@`.
- **Server titles are shown raw.** `NativeChatActivity.title` is a plain `String`
  (`NativeChatAPIClient.swift:349-370`). Where it is displayed, it goes through `Text(String)`, the
  verbatim initializer (e.g. `DesktopWorkWorkspace.swift:2970`, `JunoMobileCodeView.swift:1394`).
- **Native branches on English titles**, which freezes them as contract:
  - "Searching the web" (`NativeSearchActivity.swift:13,23`, `DeepResearchActivityProjection.swift:125,133`);
  - "Research corpus ready" (`NativeSearchActivity.swift:68`).
- **Wire compatibility is fine.** The OpenAPI `ChatActivityEvent.event` is
  `additionalProperties: true` (`contracts/openapi/juno-native-v1.yaml:1685-1691`), and Swift
  `Decodable` ignores unknown keys. **Adding `copy: {key, params}` beside `title` is safe for
  shipped builds.**

### 1.8 What would happen to the rework's copy under today's mechanism

Every one of these would stay English in all 19 non-English locales:

- every T2 running, done or figure label with an argument;
- every duration;
- every "N sources";
- the summary line;
- the estimate line;
- the research state sentences with counts;
- the announcer;
- the tab title and browser notifications, because `document.title` is in `<head>`, which the walker
  never visits, and `Notification` text never enters the DOM (`document-title.tsx:38-48`,
  `use-needs-you-count.ts:213-220`).

The static parts, such as "Thinking" or "Pause", translate, but with an English flash on each
change (§1.1). Adding the rework on top of today's mechanism **increases** the share of untranslated
live UI.

---

## 2. Inventory of dynamic string families

**Producer legend:**

- **S**: the server builds `{key, params}`.
- **C**: the client composes from state (phase, status or counts).
- **M**: model-written content. It is not a message, and §4 governs its language.
- **S+M**: a server key whose parameter is model or user text.

"Plural" means an ICU `plural` argument. The Intl column names the formatter the parameter needs.
English sources are written in the proposed ICU subset.

### 2.1 Tool labels (T2 and T3; running / done / figure)

| # | Family | English source | Params | Plural / Intl | Producer | Today |
|---|---|---|---|---|---|---|
| T-1 | web_search running | `Searching the web for “{query}”` | `query`: text (M) | grapheme-safe truncation at ~40 | S+M | title literal + query in `detail`; client composes `Searching for “…”` (`activity-timeline.tsx:66-68`) |
| T-2 | web_search done | `Searched the web for “{query}”`; several: `{count, plural, one {Ran # search} other {Ran # searches}}` | query, count | plural | S | — |
| T-3 | web_search figure | `{count, plural, one {# result} other {# results}}` | count | plural, NumberFormat | S | — |
| T-4 | web_fetch running / done | `Reading {domain}` / `Read {domain}` | `domain`: text (Unicode host, not punycode) | — | S | client `Reading ${domain}` (`activity-timeline.tsx:65`) |
| T-5 | web_fetch figure | `{pages, plural, one {# page} other {# pages}}`, `PDF · {pages, plural, …}` | pages | plural | S | — |
| T-6 | web_fetch failed | `Couldn't open {domain}` + `{reason, select, blocked {The site blocked the request} timeout {It took too long} not_found {The page doesn't exist} no_provenance {The link didn't come from this conversation} other {The page couldn't be read}}` | domain, reason (code) | select | S | — |
| T-7 | read_document | `Reading {file}` · `Reading {file}, pages {range}` · `Read {file}` | file (user), `range` | NumberFormat `formatRange` | S | — |
| T-8 | inspect_image | `Looking closer at {file}` / `Looked closer at {file}` | file | — | S | — |
| T-9 | run_code | `Running code` / `Ran code` · figure `{files, plural, =0 {No files} one {# file created} other {# files created}}` · `Ran for {duration}` | files, duration | plural, DurationFormat | S | — |
| T-10 | run_code failed | `Code failed` + error name verbatim (`ValueError`) | errorName (content) | — | S | — |
| T-11 | search_chats | `Searching your chats for “{query}”` / `Searched your chats` / `{count, plural, one {# chat} other {# chats}}` | query, count | plural | S | — |
| T-12 | current_time | `Checking the time` / `Checked the time` · figure `{time}` | `time`: date + IANA zone | DateTimeFormat | S | — |
| T-13 | calculate | `Calculating` / `Calculated` · figure `= {result}` | result: number | NumberFormat (locale decimal separator) | S | — |
| T-14 | start_task | `Handing this to a task` / `Started a task: {title}` | title (M) | — | S+M | `taskActivityTitle` + `detail` (`route.ts:395-397`) |
| T-15 | suggest_research chip | `Research this` | — | — | C | — |
| T-16 | Status words (T6 `status`) | `Queued`, `Waiting for your approval`, `Timed out after {duration}`, `You declined this`, `Approval expired`, `Cancelled`, `Failed` | duration | DurationFormat | C (from enum) | — |
| T-17 | Parallel batch | `Reading {count, plural, one {# source} other {# sources}}` (2 or more in 1 s, per the motion audit §3.2) | count | plural | C | — |
| T-18 | Tool-detail notes | as today (`run-receipt.ts:110-122`) | — | — | C (from code) | translated (exact literals) |
| T-19 | Step copied as Markdown | the row's label and figure in the UI locale | as the row | as the row | C | English (`run-receipt.ts:270+`) |

### 2.2 Connector (MCP) labels

| # | Family | English source | Params | Intl | Producer | Today |
|---|---|---|---|---|---|---|
| C-1 | Running | `{connector}: {tool}` (e.g. "Linear: Create issue") | connector (brand), tool (the MCP `title` annotation, or the humanised name; third-party language) | — | S | `Using ${server}` (`route.ts:395`) |
| C-2 | Done | `Used {connector}` · figure from a Juno-side result shape only | connector | — | S | — |
| C-3 | Ready | `Connected tools ready: {connectors}` | list | `ListFormat` conjunction | S | literal title (`route.ts:2741`) + English detail |
| C-4 | Failed to connect (RC-3) | `{connector} couldn't connect` + `{reason, select, auth_expired {…} unreachable {…} misconfigured {…} other {…}}` | connector, reason | select | S | swallowed (`mcp.ts:389-391`) |
| C-5 | Needs approval | `{connector} needs your approval` | connector | — | S | `${connectorLabel} needs approval` (`route.ts:2903`) |
| C-6 | Needs sign-in | `Sign in to {connector} to continue` | connector | — | S | — |
| C-7 | Third-party `invoking` / `invoked` strings | verbatim, never translated; the Juno template above is preferred | — | — | M (third party) | — |

### 2.3 Phase labels and escalations (U1, U2; motion audit §3.2)

| # | Phase | English source | Params | Intl | Producer |
|---|---|---|---|---|---|
| P-1 | thinking | `Thinking` | — | — | C |
| P-1b | thinking (provider headline) | the provider's reasoning-summary heading, verbatim | — | — | M (§4, D-5) |
| P-2 | searching | `Searching for “{query}”` | query | truncation | C, from the T-1 record |
| P-3 | reading | `Reading {domain}` / `Reading {count, plural, one {# source} other {# sources}}` | domain / count | plural | C |
| P-4 | tool | the running label of the tool record (T-*, C-1) | — | — | S |
| P-5 | waiting | `Waiting for your approval` / `Needs your answer` | — | — | C |
| P-6 | writing (Research only) | `Writing the report` | — | — | C |
| P-7 | stalled | `No response for {duration}` | duration | DurationFormat | C |
| P-8 | escalation at 2 min | `Still thinking. This can take a few minutes.` | — | — | C (already a whole literal, `activity-timeline.tsx:91-93`) |
| P-9 | escalation at 10 min | `Still working. You can leave; the answer will be here.` | — | — | C (`:88-90`) |
| P-10 | live clock | `{duration}` in tabular numerals | ms | DurationFormat (§3.5) | C |

### 2.4 Summary line and accessible names (U1, U3; motion audit §3.2 and §3.9)

| # | Family | English source | Params | Intl | Producer | Today |
|---|---|---|---|---|---|---|
| S-1 | Settled lead | `Thought for {duration}` / `Worked for {duration}` | duration | DurationFormat narrow | C | `formatSpan` English units (`run-receipt.ts:46-55`) |
| S-2 | Facts (at most 2) | `{n, plural, one {# search} other {# searches}}`, `{n, plural, one {# source} other {# sources}}`, `{n, plural, one {Ran code} other {Ran code # times}}`, `{n, plural, one {# file created} other {# files created}}` | n | plural | C | `=== 1` ternaries (`activity-timeline.tsx:228-237`) |
| S-3 | Joiner | the design separator ` · ` between **complete** messages (never a sentence) | — | — | C | same |
| S-4 | Stopped | `Stopped after {duration}` | duration | DurationFormat | C | `run-receipt.ts:257` |
| S-5 | Failed | `Couldn't finish` · `{duration}` | duration | DurationFormat | C | — |
| S-6 | Accessible name | `Thought process, worked for {durationLong}{sources, plural, =0 {} one {, # source} other {, # sources}}` | durationLong, sources | DurationFormat long, plural | C | `activity-timeline.tsx:258-266` |
| S-7 | Panel header and sections | `Thought for {duration}`, `Cited ({n, number})`, `Also read ({n, number})`, `{n} of {total}` | n, total | NumberFormat | C | `N of M`, `N steps` (`internal-tools-ui.md` §3.7) |
| S-8 | Run sentence (if kept) | complete sentences built with `ListFormat`; "once/twice" only through ICU `=1`/`=2` | — | `ListFormat` | C | `toRunSummary` (`run-receipt.ts:231-270`) |

### 2.5 Approval card (T6 `approval`; `approval-card.tsx`)

| # | Family | English source | Params | Intl | Producer | Today |
|---|---|---|---|---|---|---|
| A-1 | Request sentence | `{risk, select, reversible_write {{connector} wants to make a change} external_write {{connector} wants to send something outside Juno} destructive_or_sensitive {{connector} wants to delete or change something important} other {{connector} wants to make a change}}` + the tool name as a separate element | connector, risk (code), tool (verbatim) | select | S | `"${label} wants to ${verb}."`, where the verb is a de-snake-cased tool id (`action-approval.ts:407-412`), **bound into the digest** (`:305`, `:352-357`) |
| A-2 | Unknown-risk note | `Juno couldn't verify that this only reads, so it's treated as a change.` | — | — | S (code) | `:408-411` |
| A-3 | Task | `Start a background task: {title}` · `Estimated cost {cost}` | title (M), cost (money) | NumberFormat currency | S+M | `:401-405` |
| A-4 | Actions | `Allow once`, `Always allow {connector} in this chat`, `Deny` | connector | — | C | "Allow this action for this connector" (`:664`) |
| A-5 | Countdown | `Expires in {remaining}` | remaining | DurationFormat digital | C | two text nodes; the number is glued after the words (`:516`) |
| A-6 | Deadline (screen reader) | `Answer this request before {time}` | time | DateTimeFormat `timeStyle: short` | C | `toLocaleTimeString()` in the browser default (`:517-519`) |
| A-7 | Outcome | `{decision, select, allow_once {Allowed once} allow_scope {Allowed in this chat} deny {Denied} other {Done}}` and, as a **separate** node, the replay note | decision | select | C | one concatenated node (`:376-379`) |
| A-8 | Refusal | by code: `{code, select, expired {…} superseded {…} unreachable {…} other {This request couldn't be answered ({status})}}` | code, status | select | S (code) | `serverSentence` English passthrough (`:415`) |

### 2.6 Announcer (U6; motion audit §3.13)

| # | Family | English source | Params | Intl | Producer | Today |
|---|---|---|---|---|---|---|
| N-1 | Phase boundaries | `Searching the web`, `Reading sources`, `Using {connector}` / the tool's running label, `Writing the report` | connector | — | C | — |
| N-2 | Waiting (assertive) | `Needs your input` / `Waiting for your approval` | — | — | C | — |
| N-3 | Done | `{kind, select, thought {Done, thought for {durationLong}} other {Done, worked for {durationLong}}}` | durationLong | DurationFormat long | C | `speakSpan` English (`thought-process-model.tsx:130-140`) |
| N-4 | Stopped / failed / slow | `Stopped`, `Couldn't finish`, `Still working` | — | — | C | — |
| N-5 | Response complete | `Response complete, {words, plural, one {# word} other {# words}}.` / `Response failed.` | words | plural | C | English in all locales (`message-list.tsx:241-246,271`) |
| N-6 | Research | `Research started`, `Research paused`, `A question for you`, `Report ready` | — | — | C | — |

### 2.7 Research (R2, R4, R5, R7; research audit §6.2 and §11)

| # | Family | English source | Params | Intl | Producer |
|---|---|---|---|---|---|
| R-1 | Estimate line | `About {minutes} · reads up to about {pages, plural, one {# page} other {# pages}} · stops at {ceiling}` (three complete facts joined by ` · `) | minutes (unit minute), pages, ceiling (money) | NumberFormat unit and currency, plural | S (numbers from `researchBudgetFor`) → C |
| R-2 | Approach sentence | — | — | — | M (planner) |
| R-3 | Questions (3–6), editable | — | — | — | M / user |
| R-4 | Clarifying questions and chips | — | — | — | M |
| R-5 | Sources row | `Web · Prioritise: {domains}` | list | `ListFormat` unit | C |
| R-6 | Quick offer | `This looks quick. Answer with a web search instead?` · `Answer now` · `Research anyway` | — | — | C |
| R-7 | Transcript row | `{state}` · `{duration}` · `{n, plural, one {# source} other {# sources}}` · `Open` | state (msg), duration, n | DurationFormat, plural | C |
| R-8 | State sentences (§11.2) | `Working out the plan…`; `Check the plan to start`; `Searching and reading · {n, plural, one {# source so far} other {# sources so far}}`; `Checking what's still missing`; `Writing the report`; `Checking {n, plural, one {# citation} other {# citations}} against their sources`; `Paused. Nothing is being spent.`; `A question for you`; `Report ready`; `Report ready. {open, plural, one {# question stayed open} other {# questions stayed open}}.`; `Stopped. Nothing was written.`; `Stopped early. The report was written from what was found.`; `Couldn't finish: {reason, select, …}. You weren't charged for the report.` | n, open, reason (code) | plural, select | C, from `state` + counts + codes |
| R-9 | Dock header | `{elapsed}` · `About {remaining} left` · `{spent} of {ceiling}` | elapsed, remaining (range in minutes), spent, ceiling | DurationFormat, NumberFormat `formatRange` unit, currency | C |
| R-10 | Question coverage | `{done, number} of {total, plural, one {# question covered} other {# questions covered}}`; per question `{status, select, covered {Covered} in_progress {In progress} next {Next} other {}}` | done, total, status | plural, select | C |
| R-11 | Activity headings (§6.2) | `Mapping the question`; `Searching for {topic}`; `Checking what's still missing`; `Writing the report`; `Checking {n, plural, …} citations against their sources`; `You: {guidance}` | topic (M, a sub-question label), n, guidance (user) | plural | C + M |
| R-12 | Activity line under a heading | a first-person sentence by the lead model at a round boundary | — | — | M (§4) |
| R-13 | Query rows / page rows | `“{query}”` + `{n, plural, one {# result} other {# results}}`; `{domain} — {title}` + `Read · {q, plural, one {# quote} other {# quotes}}` | query (M), domain, title (content), n, q | plural | C |
| R-14 | Researchers lane | `{n, plural, one {# researcher working} other {# researchers working}}` | n | plural | C |
| R-15 | Found so far | quote verbatim + domain | — | — | content (never translated) |
| R-16 | Sources tab | `Cited ({n, number})`, `Read ({n, number})`, `Found ({n, number})`, published `{date}`, `{q, plural, …quotes}`, `{read, number} read · {cited, number} cited` | n, date | NumberFormat, DateTimeFormat | C |
| R-17 | Report card provenance | `{duration}` · `{cited, number} cited of {read, number} read` · `{verdict, select, all_checked {Every citation checked} some_unchecked {{unchecked, plural, one {# citation not checked} other {# citations not checked}}} other {}}` · the lead model's name | duration, counts, verdict, unchecked | DurationFormat, plural, select | C |
| R-18 | Support marks (R5) | `Supported`, `Partly supported`, `Not checked`, `Unsupported` (only when a judge looked) | — | — | C (from verdict code) |
| R-19 | Citation hover card | `Open at passage`, `{i, number} of {n, number}` (today `1/2`), `{date}` | i, n, date | NumberFormat, DateTimeFormat | C |
| R-20 | Report headings and body | the model writes them in the content language | — | — | M (§4, §3.12) |
| R-21 | Export file name | `{reportTitle}.md` / `.pdf` (Unicode-safe sanitising) | title (M) | — | C |
| R-22 | Controls | `Pause`, `Resume`, `Finish now`, `Cancel` · confirm: `Cancel this research? {spent} has been spent so far.` | spent (money) | currency | C |
| R-23 | Steering | `Guide the research`, `Ask Juno`, `Applied at the next round` | — | — | C |
| R-24 | Entry tooltip and quota | `Plans, reads the web and writes a cited report · usually {range}` · `{left, plural, one {# research left this month} other {# research runs left this month}}` · `{remaining} of {total} research budget left` | range (minutes), left, remaining, total | `formatRange`, plural, currency | C |
| R-25 | Budget note | `Shortened to fit this month's research budget.` | — | — | C |
| R-26 | Legacy timeline details | replaced by R-11…R-17 | — | — | today's templates (`run-timeline.tsx:377-395,494,784`) |

### 2.8 Notifications, tab title and toasts (R7; motion audit §3.9)

| # | Family | English source | Params | Producer | Today |
|---|---|---|---|---|---|
| X-1 | Tab title while away | `Report ready · {title}` (FSI/PDI-isolated) | title (M) | C | `document.title` is never translated (`document-title.tsx:38-48`) |
| X-2 | Toast | `Report ready` + description `{reportTitle}` + action `Open` | title | C | composed `toast(sentence)` is not harvested |
| X-3 | Browser notification | title `Your report is ready`, body `{reportTitle}`; opt-in prompt `Notify me when it's ready` | title | C | the Work precedent is English (`use-needs-you-count.ts:213-220`) |
| X-4 | Other rework toasts | `Copied`, `Saved {fileName}`, `Couldn't export: {reason, select, …}` | fileName, reason | C | — |
| X-5 | Native push (later) | APNs `loc-key` + `loc-args` (Apple's own key-plus-params) | — | S | — |

### 2.9 Error copy

| # | Family | Today | Target |
|---|---|---|---|
| E-1 | Stream `error.message` (`types/chat.ts:393-402`) | English from `providerErrorMessage(err, {model, provider})` (`llm.ts:249`), e.g. `route.ts:3369` | add `code` + `params`; keep `message` for legacy |
| E-2 | Finish reasons | `finishReasonTitle` `switch` (`finish-reason.ts:65-80`), not in the catalog | the client maps `finishReason` to a message |
| E-3 | Tool failure (RC-14) | — | `{reason, select, timeout {Timed out after {duration}} invalid_args {The model sent arguments this tool can't use} tool_error {The tool reported an error} other {…}}` |
| E-4 | Connector failure (RC-3) | swallowed | C-4 |
| E-5 | Research `error` | free English text in `ResearchRun.error` (`schema.prisma`, `model ResearchRun`) | `errorCode` + params; the text stays for logs |
| E-6 | Approval refusals | `serverSentence` passthrough | A-8 |
| E-7 | Usage and budget | literal title + `detail` (`route.ts:1145,2875`) | a code, and money params when shown |

### 2.10 Model-written text (not messages; §4 governs it)

These are **not** messages:

- reasoning text and provider summary headlines;
- T6 commentary;
- the answer;
- the conversation title (already "SAME language as the user's message", `titles.ts:153`);
- the research approach, questions, clarifications, narration, findings, report and the 120–250 word
  summary message;
- search queries and other tool arguments;
- the `start_task` title;
- third-party MCP tool titles and `invoking` strings;
- source titles, snippets and quotes.

Model-facing strings are not UI copy either and are never localised: tool descriptions (T2), the
final-round note (T5), the T7 history notes, and tool results.

**Totals:**

- about **190–220 messages** across roughly 75 families;
- about **45 plural arguments**, **20 durations**, 8 money values, 6 lists, 5 ranges and 6 dates;
- about **12 `select` arguments** over server codes;
- about **25 slots that carry verbatim model, user or third-party text**.

---

## 3. Proposed copy architecture

### 3.1 Decision: `{key, params}` on the wire, not English strings

| Criterion | English strings from the server (status quo) | Localised strings from the server | **`{key, params}`, formatted on the client** |
|---|---|---|---|
| Correct locale | No | Only if the server knows the effective locale, which it does not (§1.5) | **Yes**: the client owns `<html lang>` |
| Privacy (only opaque ids leave the device, `auto-translate.tsx:83-86`) | kept | **broken**: the server would translate sentences that contain queries and titles | **kept**: params are substituted locally |
| Persisted rows re-render after a locale switch | no | no (frozen in the old locale) | **yes** |
| Native | shows English raw | would need the server to track each device's locale | maps keys to xcstrings; old builds keep `title` |
| Control flow | the client matched title prefixes (`activity-timeline.tsx:73`, `thought-process-model.tsx:149-152`) | worse | none: `kind`, `status`, `code` |
| Cost | none | one translation per event | one catalog entry per family |

**Recommendation.** Every server-produced UI string travels as `copy: {key, params}`. The legacy
English `title`, `detail` and `message` stay, byte-identical where native matches on them (§1.7).
The client never reads the legacy fields when `copy` is present. This generalises the existing
`argsNote` pattern (§1.6) to carry parameters.

### 3.2 Wire shape

```ts
// src/lib/copy/types.ts: shared by server, web client, tests and the OpenAPI doc
export type CopyParam =
  | string                                                    // verbatim text: query, domain, file, connector, title
  | number                                                    // counts and plain numbers (plural selectors stay numbers)
  | { t: "duration"; ms: number; style?: "narrow" | "long" | "digital" }
  | { t: "date"; iso: string; style?: "time" | "date" | "datetime"; timeZone?: string }
  | { t: "money"; micros: string; currency: "USD" | "EUR" }   // micro-units as a string, like the DB
  | { t: "list"; items: string[]; type?: "conjunction" | "unit" }
  | { t: "range"; lo: number; hi: number; unit?: "minute" | "page" };

export interface Copy {
  key: MessageKey;                     // stable and append-only, e.g. "tool.web_search.running"
  params?: Record<string, CopyParam>;  // raw values only, never pre-formatted text
}
```

**Where `Copy` is added.** Every field is additive and optional, and legacy fields stay:

- `ClientActivityEvent.copy?` and `detailCopy?` (`types/chat.ts:237-261`).
- The T6 tool record gets `label: { running: Copy; done: Copy; figure?: Copy; error?: Copy }`.
  The ToolSpec's `status.running(args) → Copy` runs on the server. It sees the unredacted arguments
  and emits only the safe params (`query`, `domain`, `file`).
- The stream `error` frame gets `code?` and `params?`.
- `ClientActionApproval` gets `copy: Copy` beside `preview` (§3.11).
- Research:
  - event payloads keep `kind + payload` and add `reasonCode` wherever English text travels today
    (e.g. `round_reviewed.reason` is model text: keep it as M content, with `lang`);
  - the run DTO gains `contentLanguage` and `estimate: {minutes: [lo, hi], pages, ceilingMicros}`.
- The chat request gains `locale` (the effective `<html lang>`) and `timeZone`. The server uses them
  only for background work (the research snapshot, email) and for `current_time`. **They never
  format live UI copy.**

### 3.3 Message definitions and the ICU subset

```ts
// src/lib/copy/run.messages.ts
export const RUN_MESSAGES = defineMessages({
  "run.phase.searching": {
    en: "Searching for “{query}”",
    description: "Status line while a web search runs. {query} is the model's own search text, verbatim, in any language.",
  },
  "run.summary.sources": {
    en: "{count, plural, one {# source} other {# sources}}",
    description: "One fact in the settled summary line, after 'Worked for 12s ·'.",
  },
});
```

**Keys.** `surface.family.variant`, for example `tool.web_fetch.done`, `research.state.paused`,
`approval.request`. They are append-only. When a meaning changes, the key changes, because keys are
persisted in activity rows. An unknown key renders the legacy English field, never a raw key.

**The ICU subset is MessageFormat 1**, the syntax FormatJS, react-intl and every current translation
tool accept. It allows:

- `{arg}`;
- `{n, number}`;
- `{n, plural, …}` with `#` and `=N`, and `selectordinal` if ever needed;
- `{code, select, …}`.

It does **not** allow:

- rich-text tags or Markdown;
- plural nested more than one level;
- `select` keys that are anything other than server codes.

**Typed params.** Durations, dates, money, lists and ranges are pre-formatted into strings by the
runtime (§3.5) before ICU substitution. Numbers stay numbers so `plural` and `#` work.

**Why not MessageFormat 2.** The Unicode MF2 syntax is stable, but `Intl.MessageFormat` is still at
TC39 Stage 2 and is blocked from advancing
([proposal](https://github.com/tc39/proposal-intl-messageformat),
[stuck issue](https://github.com/tc39/proposal-intl-messageformat/issues/49)). FormatJS and Lingui
still default to MF1
([Locize, May 2026](https://www.locize.com/blog/messageformat-2-i18next/)). The utility models that
translate the catalog know MF1 far better. The subset above maps mechanically to MF2 later.

### 3.4 Client runtime

- **One store of translations.** `AutoTranslate`'s `translations` map (`auto-translate.tsx:123`)
  becomes an exported store with `subscribe` and `get(id)`. Plain catalog entries and message
  entries share the fetcher, the chunking, the `localStorage` cache and the back-off.
- **One locale source.** `useUiLocale()` reads the provider value, which is updated with
  `AutoTranslate`'s resolved `activeLocale`. Every `Intl` formatter uses it. This also fixes
  Settings, which formats in the browser default (§1.6).
- **API.**
  - `formatMessage(locale, key, params)` returns a string, for `document.title`, `Notification`,
    `aria-label`, toasts and clipboard Markdown.
  - `<Msg k="…" {...params} />` returns a `<span data-no-auto-translate>`. Each text param is wrapped
    in `<bdi translate="no">`.
  - In plain-text contexts, verbatim params are wrapped in FSI…PDI (U+2068/U+2069).
- **Fallback.** Use the English source until the translation arrives. **The swap is a plain text
  replacement:** animation identity is the key plus its semantic params, never the rendered
  string. The English→translated swap must not replay U2's label cross-fade or reset the 700 ms
  dwell (motion audit §3.4). Today's `copyKey` includes the rendered message
  (`activity-timeline.tsx:243`).
- **Prefetch.** On app idle, non-English readers fetch the `run.*`, `tool.*`, `approval.*` and
  `research.*` ids (about 200, 7 requests) so the live status line never starts in English.
- **Hydration.** Follow `useFormatLocale` (`settings/format.ts:40-47`): SSR and the hydration pass
  render English, and the live locale takes over after mount. Chat run blocks are client-rendered
  while live, so this matters only for server-rendered persisted turns.
- **Size.** Use `intl-messageformat` (MF1, formatting only), with ASTs pre-parsed by the route
  (§3.7), so the client ships no parser. The alternative is an in-house formatter of about 150 lines
  for the subset. §7 asks the owner.

### 3.5 `Intl` formatters, and where they run

| Need | API | Support (checked 2026-09-23) | Notes for Juno |
|---|---|---|---|
| Plurals | `Intl.PluralRules` (inside ICU `plural`) | Widely available, all engines since 2019–20 | The categories differ by locale; §3.7 validates them |
| Numbers, counts, units | `Intl.NumberFormat` (`style: "unit"`, `unitDisplay`) | Widely available (unit style since Safari 14.1) | "12 min", "12 Min.", "12分钟" |
| Ranges ("6–9 min", "5–15 min") | `NumberFormat.prototype.formatRange` | Baseline 2023 | Estimate and ETA lines |
| Money | `NumberFormat` currency | Widely available | Replaces `$${usd.toFixed(2)}` (`run-format.ts:15-19`) |
| Durations | `Intl.DurationFormat` | **Baseline 2025, newly available** ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat)); Node ≥ 23, so the pinned Node 24 has it (`package.json` engines) | `narrow` for S-1, `long` for the announcer (replaces `speakSpan`), `digital` with `hoursDisplay: "auto"` for countdowns. **Fallback:** a unit `NumberFormat` pair when `typeof Intl.DurationFormat === "undefined"` (browsers before March 2025) |
| Relative time | `Intl.RelativeTimeFormat` | Widely available | "Updated 3 minutes ago" (`memory-time.ts` pattern) |
| Lists | `Intl.ListFormat` | Widely available (Safari 14.1) | Connector lists, prioritised domains, any sentence list. **Not** for the ` · ` fact row: `unit`/`narrow` joins with no separator in ja and zh |
| Dates and times | `Intl.DateTimeFormat` with `timeZone` | Widely available | `current_time`, deadlines, published dates |
| Sentences and graphemes | `Intl.Segmenter` | Baseline 2024 (Firefox 125) | Grapheme-safe truncation of params; sentence splitting for claims (§3.12) |

**Measured outputs** (Node 26 ICU) that the design has to absorb:

- **Plural categories:**
  - en, de, nl, sv, tr and hi have `one/other`;
  - es, fr, it and pt-BR have `one/many/other` (CLDR's `many` for large numbers);
  - pl, ru and uk have `one/few/many/other`;
  - id, vi, th, ja, ko and zh have `other` only.
- **Narrow durations vary in width:** `1m 4s` (en), `1 Min., 4 Sek.` (de), `1 мин 4 с` (ru),
  `1分钟4秒` (zh-Hans).
  - The live clock should use `digital` ("1:04") once past 60 s, which is identical in every
    locale.
  - The settled summary uses `narrow`.
  - The motion audit's "1m 04s" zero-padding is English-only styling and should be dropped.

### 3.6 Extractor changes (`scripts/generate-i18n-catalog.mjs`)

1. **Harvest messages.** Add a visitor for `defineMessages({ key: { en, description } })`.
   - `en` must be a literal, and `description` is required.
   - Parse `en` with `@formatjs/icu-messageformat-parser` (a new dev dependency) and **exit
     non-zero** on:
     - a parse error;
     - an unsupported construct (tags, deep nesting);
     - a duplicate key;
     - a missing description;
     - a `select` without `other`.
   - Emit `UI_MESSAGES: {key, id, source, description, args: [{name, kind}]}` into the same
     generated file, with `id = sha256("msg\0" + key + "\0" + source).slice(0, 16)`. The route's
     `catalogById` then accepts message ids with no change to its id regex (`route.ts:74`), and
     editing the English invalidates the caches just as today.
2. **No double harvest.** The legacy visitor stops descending into `defineMessages` arguments.
3. **Keep model-facing text out.** Stop harvesting `description` and `title` inside `defineTool(…)`
   (T2 specs) and inside files named `*.prompt.ts` (§1.2).
4. **A lint rule, `juno/no-composed-copy`**, alongside the rules in `eslint-rules/`. It is error
   level in `src/components/chat`, `src/components/research`, `src/lib/run-*`, `src/lib/copy`, the
   ToolSpec registry and any new run or research directory, and a warning elsewhere. It flags:
   - a template literal or `+` concatenation whose value reaches JSX text, a `COPY_PROPERTIES`
     prop, `toast*()`, `aria-*`, `document.title` or `new Notification`;
   - a string-returning `n === 1 ? … : …`;
   - `toLocale*String()` without the UI locale.
5. **A test** that every `Copy` a ToolSpec can emit names a key in `UI_MESSAGES` with matching
   params. With `MessageKey` typed from the `defineMessages` literals, most of this is a
   typecheck.

### 3.7 Translator changes (placeholder protection)

**Runtime route (`/api/i18n/translations`).**

- **Branch on the entry kind.** Plain entries keep today's prompt. Message entries are sent as:

  ```json
  {"<id>": {"source": "…", "description": "…", "args": [{"name": "count", "kind": "plural"}],
            "targetPluralCategories": ["one", "few", "many", "other"]}}
  ```

  The categories come from `new Intl.PluralRules(cacheLocale).resolvedOptions().pluralCategories`.
  The system prompt adds these rules:
  - keep ICU syntax;
  - translate only the text inside branches;
  - never translate an argument name or a `select` key;
  - give every listed plural category plus `other`, and `=N` only where the language needs it;
  - keep `#`;
  - typographic quotes may follow the target language („…“, «…», 「…」).
- **Validate every returned message** before caching. A message is rejected when:
  1. it fails to parse (MF1);
  2. its set of argument names or any argument's kind differs from the source;
  3. a plural lacks `other`, or uses a category outside the target's categories (`=N` is allowed);
  4. its `select` keys differ from the source's;
  5. it introduces a tag or Markdown, or is longer than 3× the source plus 40 characters.
- **Retry and fallback.** A rejected message is retried once with the validator's error list. If it
  fails again it is omitted, so the client keeps English, and the failure is logged with the key.
- **Response.** For message ids, return `{text, ast}`, so the client needs no parser.
- **Unchanged.** The cache (`${cacheLocale}:${id}`) and the rate limits stay as they are. Params
  never reach the route, which keeps the privacy property.

**Build-time pretranslation (recommended for the rework's namespaces).**

- `npm run i18n:translate -- --namespaces=run,tool,approval,research` fills
  `src/lib/i18n/messages/<locale>.json` for the 19 non-English `UI_LOCALES`, through the same
  validator. The files are **committed**, so diffs are reviewable. That is about 19 × 200 entries,
  and the one-off utility spend is negligible.
- The route serves committed entries first, with no model call, and falls back to runtime
  translation for anything missing.
- **Why:**
  - the live status line never waits on a model;
  - `/dev/run` and `/dev/research` screenshots are deterministic per locale;
  - a native speaker can review the 200 messages people see most;
  - the same files can seed the native catalog (§3.10).
- **Cost:** a manual step when messages change. A CI check fails if a key has no entry in a
  committed locale.

### 3.8 `AutoTranslate` changes (the per-token cost)

1. **Prune.** Use one `TreeWalker(SHOW_ELEMENT | SHOW_TEXT)` whose `acceptNode` returns
   `FILTER_REJECT` for `EXCLUDED_SELECTOR` elements. That skips the whole subtree, and attributes
   are collected in the same pass (replacing `:201-213`).
2. **Filter mutations.** The observer callback looks at each record. For a `characterData` record it
   takes the target's parent element. If that element (or the target) is inside
   `[data-no-auto-translate], [translate='no'], code, pre`, the record is ignored. Otherwise the
   record's target or added nodes are queued as dirty roots.
3. **Scan incrementally.** A scheduled scan walks only the dirty roots. A full-body scan runs only at
   start and when a batch of translations arrives.
4. **Throttle.** Keep the 20 ms delay for ordinary UI, but coalesce to at most 4 scans a second
   while any `[aria-busy="true"]` message exists.

**Effect.** A streamed token, a clock tick or a counter roll inside excluded regions costs one
`closest()` per mutation record instead of a document walk. The same holds for English readers,
since the observer never starts for them (`:105`).

### 3.9 Which surfaces set `data-no-auto-translate`

Rule: **put it on the content leaf, not on the whole row**, unless every piece of chrome inside is
itself a `<Msg>`. An excluded container hides its static labels from the walker.

| Surface | Why | Today |
|---|---|---|
| Every `<Msg>` output (automatic) | already localised; prevents a second match and the English flash | — |
| Answer markdown, user bubble | content | done (`markdown.tsx:646`, `message-item.tsx:1086`) |
| Reasoning excerpt and viewport (`aicss/thinking-reasoning.tsx`), provider headlines | content that streams per token | **missing** |
| T6 commentary items | content | new |
| Tool-row argument echoes: query, domain, file, connector, MCP tool title, code blocks | verbatim params (code and pre are already excluded) | partly |
| Web-search block site titles (`aicss/web-search.tsx`) | content | **missing** |
| Live clock, rolling counters, favicon stack | 1 Hz and rolling mutations | **missing** |
| Research: activity lines, query and page rows, Found so far, Sources tab titles and snippets, report reader, citation hover quotes, plan questions, approach sentence | content, and mutates while running | **missing** |
| Conversation titles (sidebar, tab), report titles | content | sidebar partly (`app-sidebar.tsx:1398,1405` use `translate="no"`) |
| Announcer live regions | localised by the runtime; a DOM rewrite double-announces (`message-list.tsx:266-272`) | completion only |

### 3.10 How this fits the native clients

- **Shipped builds are unaffected.** They read `title` and `detail`. The legacy titles native
  matches on ("Searching the web", "Research corpus ready") stay byte-identical until those builds
  age out.
- **New builds (the Mac Chat redesign) read `copy`.**
  - A script converts `defineMessages` sources into xcstrings entries:
    - `{name}` becomes a positional `%1$@` or `%1$lld`;
    - `plural` becomes xcstrings `variations.plural`, or `substitutions` when there are several
      plural arguments;
    - `select` over server codes becomes one key per branch.
  - `Copy.key` becomes the xcstrings key. Params format with Foundation formatters (`Duration`
    formatting, `ListFormatter`, `.formatted(.number)`, `Date.FormatStyle`).
  - An unknown key falls back to `title`.
  - The committed pretranslations (§3.7) can seed `fr`, and more locales if the native apps widen
    `knownRegions` beyond en and fr.
- **Native push.** APNs `loc-key` and `loc-args` carry the same key and params, and the device
  localises them.
- DECISIONS §5 holds: no Swift changes in this rework. The Mac session gets this section with the
  spec.

### 3.11 Approval receipts bind semantics, not English bytes

Today the English `preview` sentence is part of `ActionReceiptBinding` and is hashed into
`receiptDigest` (`action-approval.ts:305,352-357`). If the card shows French, the digest no longer
describes what the person saw.

**Proposal: receipt v2** (`RECEIPT_DOMAIN = "juno.action-approval.receipt.v2"`):

- **Bind locale-independent content:** `copy` (key and params), plus the redacted `detail`, which
  is shown verbatim.
- **Record the locale on the decision:** `shownLocale`, the effective `<html lang>`, goes on the
  decision row, not into the digest.
- **Keep `preview` in English** for logs and legacy clients. Native echoes the digest opaquely
  (`NativeChatAPIClient.swift:914,933`), so this is server-only.
- **Rollout.** Pending v1 receipts expire within the 15 min TTL (`ACTION_APPROVAL_TTL_MS`), so both
  versions only need to verify during one deploy window.

### 3.12 Reports and claims must not depend on English headings

These fixes are needed whatever language policy §4 lands on, because a user who writes in German
already gets a German report through the chat path:

- **The writer.** It is told the literal headings `## Executive Summary` … `## Sources`
  (`corpus.ts:204-215`). Replace these with the R5 section **roles**. The model writes the headings
  in the content language and precedes each section with a marker line,
  `<!-- juno:section=sources -->`. The alternative is to have the writer return JSON sections that
  Juno renders.
- **Claims and the Sources stripper.** Both key on the marker, not on `/^#{1,6}\s+sources/i`
  (`claim-analysis.ts:615`, `message-item.tsx:411`). Today a `## Quellen` or `## 出典` list is
  audited as claims, and the pill duplicates it.
- **Sentence splitting and claim limits.** `splitSentences` recognises only `.`, `!` and `?`
  followed by whitespace (`claim-analysis.ts:492-510`). A Japanese paragraph ending in `。` becomes
  one "sentence". Paragraphs over `MAX_CLAIM_CHARS` = 600 are dropped (`:542-543`), so **CJK
  reports silently lose audit coverage**.
  - Split with `Intl.Segmenter(contentLanguage, {granularity: "sentence"})`.
  - Measure claim length in graphemes or words, with per-script thresholds.
- **The claim classifier.** `classify` and `isLoadBearing` use English lexicons and a Latin capital
  heuristic (`:526-553`). Keep the language-neutral signals (citations, numbers, dates, quotes), and
  leave the English lexicon as a bonus only for `en`.

### 3.13 Verification

- **A pseudo-locale in dev builds only** (`en-XA`, `?locale=en-XA` in `/dev/*`). Each message is
  accented, expanded by 35 % and bracketed (`⟦Ŝéàŕçĥîñĝ ƒöŕ “{query}”⟧`). Any unbracketed text in
  a run block is a concatenation or a missed message. It is cheap, it needs no model, and it covers
  what the lint rule misses.
- **Galleries.** Every `/dev/run` and `/dev/research` state renders in `en`, `en-XA`, `pl` (4 plural
  categories), `ja` (1 category, no spaces) and `de` (longest labels), in both themes and with
  reduced motion (extends U7).
- **Unit tests:**
  - the validator, on crafted bad translations (a renamed argument, a missing `other`, a translated
    `select` key, an extra category);
  - the runtime, on every typed param;
  - `AutoTranslate` pruning: the number of nodes visited per streamed token is 0 inside an excluded
    subtree;
  - claim extraction on a German and a Japanese fixture report.

---

## 4. Language policy for model-written content

**Definitions.**

- **UI locale:** the effective `<html lang>` (§1.5).
- **Content language:** the language model-written text is produced in.

**The facts the options have to respect:**

- **Chat answers.** They follow `responseLanguage` when it is set (`system-prompt.ts:355-357`), and
  otherwise the model's default, which in practice is the question's language.
- **Model-written UI text.** Titles and the preflight clarifier are already told "SAME language as
  the user's message" (`titles.ts:153,195`; `preflight-triage.ts:119,163`).
- **The research engine** has no rule. The chat path's report inherits `responseLanguage` through
  the system prompt (`route.ts:2819`). The background writer does not (`research/tools.ts:674-700`).
  **R3 routes every run through the background engine, so without a rule the explicit setting would
  stop applying to reports.**

### 4.1 Options

| Option | Rule | For | Against |
|---|---|---|---|
| A. UI locale | All model text (narration, questions, report) in the UI locale | Chrome and content agree; simplest to explain | Surprising when someone asks in another language (an English UI with a French question gives an English report). Contradicts the chat and title precedents. Ignores `responseLanguage`. The background engine would need the UI locale snapshotted anyway |
| B. Language of the question | The planner detects it; everything follows it | Matches chat, titles and preflight; natural for multilingual users | Chrome and content differ when the UI locale differs; needs detection; ignores an explicit setting |
| **C. Resolved content language (recommended)** | Explicit `responseLanguage`, else the question's language (planner-detected), else the UI locale. **Resolved once, frozen on the run**, and used for every model-written research text | Honours the one explicit setting, matches the precedents, and stays consistent within a run | Mixed chrome and content in the minority case; needs a planner field and a snapshot |
| D. Split | Narration and headings in the UI locale; report and summary in the question's language | The dock reads as chrome | Two languages from one model on one panel; sub-question labels appear in both; doubles prompt complexity |

### 4.2 Recommendation (option C), with the mechanics

- **Resolution, at Start.**
  1. If `responseLanguage` is not "auto", use it. It is stored as an English name, so map it to a
     tag once.
  2. Otherwise, use `plan.language`. This is a BCP-47 tag the planner returns in its structured
     output (R8 already makes planner output structured).
  3. Otherwise, use the UI locale the client sent with the request (§3.2).
- **Storage.** `ResearchRun.contentLanguage`, a column or a field of `plan`. It is frozen and
  exposed in the DTO.
- **Prompts.** Every research prompt carries: "Write all prose you produce (approach, questions,
  progress notes, report, summary) in {languageName}. Quote sources verbatim in their original
  language. Search queries may use whatever language finds the best sources." This covers the
  brief (`tools.ts:203`), clarify (`:288`), planner (`plan-format.ts:66`), lead (`agents/lead.ts:34`)
  and writer (`corpus.ts:181`), and the revision pass, whose user turn is English
  (`tools.ts:684-686`).
- **Markup.**
  - Model-content containers carry `lang={contentLanguage}`: report, narration, plan and summary
    message. A French-UI screen reader then reads an English report with the right voice.
  - Verbatim params carry `lang=""` (unknown) where the language cannot be known (queries, titles).
- **Chrome.** Everything in §2 that is not M stays in the UI locale.
- **Chat turns** need no new rule: the content language is the chat's own reply language. T6
  commentary and T7 notes are content, or model-facing text, and are never localised.

### 4.3 Per content type

| Content | Policy (under C) | Notes |
|---|---|---|
| Research approach, questions, clarifications | content language | editable; the user may type any language |
| Research narration lines (R-12), finding claims | content language | one sentence per round boundary (research audit §6.2) |
| Headings with model fragments (R-11 "Searching for {topic}") | the template is UI locale, `topic` is content language | the fragment sits in a delimited slot (I-8), so a mismatch reads as a quoted label, not broken grammar |
| Report and the 120–250 word summary message | content language | section roles by marker (§3.12) |
| Report card chrome, support marks, provenance | UI locale | §2.7 |
| Search queries and tool arguments (T-1, T-11, R-13) | **verbatim, never translated** | they record what was actually searched, which honesty requires; `<bdi>`, `translate="no"`, grapheme truncation |
| Quotes, source titles and snippets | verbatim, never translated | "verbatim supporting quote" (R5) |
| `start_task` title, MCP tool titles, third-party `invoking` strings | verbatim | third-party or model data |
| Provider reasoning headlines in the status line (P-1b) | **owner decision D-5** | see below |
| Conversation title | question language (existing `titles.ts:153`) | also used in the tab title and notifications as a param |

**D-5: provider reasoning headlines.** The motion audit shows the latest provider headline as the
`thinking` label (§3.2). Provider summaries are often English whatever the conversation language.

- **(i) Always show them verbatim.** This is what the motion audit specifies.
- **(ii) Recommended: in a non-English UI locale, the status line shows the localised phase label.**
  Headlines appear only in the expanded timeline and the panel. The line is never mixed-language,
  and it costs nothing.
- **(iii) A script heuristic.** Show the headline only when its dominant Unicode script matches the
  UI locale's. This catches ja, ko, zh, ru, th and hi, but not English against French.

---

## 5. Effort estimate (web, engineer-days)

| # | Work | Days | Notes |
|---|---|---|---|
| 1 | `Copy` types; `defineMessages`; runtime (`formatMessage`, `<Msg>`, `useUiLocale`, typed-param formatters with the DurationFormat fallback, bidi isolation, grapheme truncation); the store refactored out of `AutoTranslate`; prefetch | 3 | infrastructure |
| 2 | Extractor: message visitor, ICU validation, `UI_MESSAGES`, model-facing exclusions | 1.5 | infrastructure |
| 3 | `juno/no-composed-copy` lint rule, scoped | 1 | infrastructure |
| 4 | Translation route: message prompt, validator, retry, AST response; tests | 2 | infrastructure |
| 5 | Build-time pretranslation script, committed JSON, CI completeness check | 1 | recommended |
| 6 | `AutoTranslate` pruning, record filtering and incremental scan; perf test | 1.5 | infrastructure; helps every page |
| 7 | Wire: `copy` on activity events, the T6 tool record `label`, error `code`, approval `copy`, research estimate and `contentLanguage`; request `locale`/`timeZone`; OpenAPI note | 1.5 | inside T2 and T6 work |
| 8 | Converting surfaces as they are built: the run block, summary, announcer, approval card, research scope card, panel, report card, tab title, toasts, notifications, errors (~200 messages) | 3–4 | incremental; cheaper than retrofitting |
| 9 | Language policy: planner `language`, resolution and snapshot, prompt lines, `lang` attributes | 1.5 | depends on D-1 |
| 10 | Report markers and language-agnostic claim extraction (Segmenter, thresholds, heading independence) | 1.5–2 | needed even without a policy change |
| 11 | Receipt v2 binding | 1 | |
| 12 | Pseudo-locale and gallery locale matrix | 1 | extends U7 |
| | **Total** | **≈ 19.5–21** | about 16 if 5 and 11 are deferred |

**Later, in the Mac session:** the native key mapping, the xcstrings generator and APNs `loc-key`
take 3–4 days. RTL enablement is not in this estimate. What is in scope is the rule that new
components use logical properties (I-15), which costs almost nothing when written fresh.

---

## 6. Invariants `SPEC.md` must adopt

- **I-1. No composed sentences.** No UI string is built by concatenation, a template literal or
  `join`. Every user-visible sentence is **one message** with named placeholders. The only permitted
  composition is joining **complete** messages with the design separator ` · `.
- **I-2. No hand-made plurals, numbers or units in code.** That means no `n === 1 ?`, no number words
  computed in code ("once", "Two"), and no unit suffixes (`s`, `m`, `min`). Plurals live in the
  message (ICU `plural`, `=N` allowed). Numbers, durations, dates, lists, ranges and money are
  formatted with `Intl` in the UI locale.
- **I-3. Server copy travels as `copy: {key, params}`.** Params are raw typed values (numbers, ms,
  ISO dates, micro-units, codes, verbatim text), never pre-formatted strings. The legacy English
  `title`, `detail` and `message` stay for shipped native builds, byte-identical for titles native
  matches on ("Searching the web", "Research corpus ready").
- **I-4. No control flow on copy.** The client never branches on rendered copy or on legacy titles.
  Behaviour keys on `kind`, `status`, `phase`, `tool`, `code` and `state`.
- **I-5. Only the client formats UI copy, in the effective `<html lang>`.** The server formats UI
  text only for work with no client present: email, and push through `loc-key`. It then uses the
  locale the client sent with the triggering request.
- **I-6. Message keys are stable and append-only.** A changed meaning gets a new key. An unknown key
  renders the legacy English field, never a raw key.
- **I-7. The message format is constrained.** Every message has a translator description. Messages
  use the MF1 subset only (§3.3). `select` keys are server codes and are never translated. A
  translation is cached only after it passes the placeholder and plural validator.
- **I-8. Verbatim text sits in delimited slots.** A param carrying user, model or third-party text is
  inserted only in a slot delimited by quotes, a colon or its own element, never where grammar must
  agree with it. It is bidi-isolated (`<bdi>`, or FSI/PDI in plain text), marked `translate="no"`,
  and truncated by grapheme.
- **I-9. Localised and streaming regions are excluded, and exclusion prunes.** Every element
  rendered from a message, and every streaming or ticking region (answer, reasoning, commentary,
  clocks, counters, research activity, report), carries `data-no-auto-translate`. `AutoTranslate`
  prunes those subtrees and ignores their mutations.
- **I-10. Motion follows meaning, not text.** Animation and dwell identity is the message key plus
  its semantic params, never the rendered string. A late translation swaps text without replaying
  motion.
- **I-11. Out-of-DOM text uses the runtime.** Announcer, `document.title`, `Notification`, toast and
  clipboard text come from `formatMessage`. Nothing relies on post-hoc DOM translation.
- **I-12. One content language per turn or run.** Model-written content follows it (§4). UI chrome
  follows the UI locale. Content containers carry `lang`. Quotes, queries and source titles are
  never machine-translated.
- **I-13. Model-facing text is English and invisible to the UI catalog.** That covers tool
  descriptions, prompts, the final-round and history notes, and tool results. It lives where the
  extractor does not harvest (`defineTool`, `*.prompt.ts`).
- **I-14. Report structure is marked, not worded.** It is identified by markers or roles, never by
  heading text. Claim extraction and source-list handling are language-agnostic.
- **I-15. New surfaces use logical direction utilities** (`ps-`, `pe-`, `ms-`, `me-`, `start-`,
  `end-`, `text-start`) and direction-aware carets and slides, so RTL can be enabled later without
  rework.
- **I-16. Receipts bind semantics.** Approval receipts bind `copy` (key and params) and the redacted
  detail, never a rendered sentence. The shown locale is recorded on the decision.
- **I-17. Every gallery state is checked in the locale matrix:** en, the pseudo-locale, pl, ja and
  de. An unbracketed pseudo-locale string in a run or research surface fails review.

---

## 7. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Content-language policy (§4.1) | **C**: explicit setting, else the question's language, else the UI locale; frozen per run |
| D-2 | Pretranslate the rework's ~200 messages at build time into committed JSON, with runtime translation as the fallback | **Yes** |
| D-3 | Runtime formatter: add `intl-messageformat` (plus the `@formatjs` parser as a dev dependency) or write an in-house subset formatter | `intl-messageformat` with server-provided ASTs; in-house if bundle size is a priority |
| D-4 | Receipt v2 binding the copy key instead of the English preview | **Yes**, in the approval workstream |
| D-5 | Provider reasoning headlines in the live status line for non-English locales | **(ii)**: localised phase label; headlines in the timeline only |
| D-6 | The motion audit's "1m 04s" zero-padding and English unit letters | Drop both: locale `narrow` at rest, `digital` for the live clock past 60 s |
| D-7 | Widen native `knownRegions` beyond en and fr once keys are shared | Later, Mac session |
| D-8 | Should `pt-BR` keep collapsing to `pt` in the translation cache (`route.ts:43-47`)? | Keep it for plain entries; allow a region-specific override file for the committed messages if a reviewer asks |

---

## Appendix: evidence index

- `src/components/i18n/auto-translate.tsx`: `:27-34`, `:35-47`, `:74-80`, `:83-86`, `:95-105`,
  `:122-141`, `:156-180`, `:182-215`, `:217-266`
- `scripts/generate-i18n-catalog.mjs`: `:9`, `:12-46`, `:48-58`, `:60-63`, `:70-88`, `:90-141`,
  `:163-174`; `.gitignore:101-107`; `package.json:6-9`
- `src/app/api/i18n/translations/route.ts`: `:9-14`, `:16-26`, `:43-47`, `:73-82`, `:103-111`,
  `:126-168`, `:172-186`
- `src/lib/i18n.ts`: `:15`, `:63-65`, `:95-106`, `:118-120`
- `src/lib/i18n-server.ts`: `:6-17`
- Root wiring:
  - `src/app/layout.tsx:108-118,144`
  - `src/components/providers.tsx:43`
- Settings:
  - `prisma/schema.prisma:389-393`
  - `src/lib/chat/system-prompt.ts:355-357`
  - `src/app/api/chat/route.ts:970,2252`
- Server titles:
  - `route.ts:395,1108,1121,2741,2752,2819,2903`
  - `deep-research.ts:149,377-383`
  - `finish-reason.ts:65-80`
  - `llm.ts:249`
- Codes → copy precedent:
  - `src/lib/chat/tool-detail.ts:73-74`
  - `src/lib/run-receipt.ts:110-135`
- English composition:
  - `activity-timeline.tsx:63-95,218-266`
  - `thought-process-model.tsx:130-152`
  - `run-receipt.ts:46-55,193-270`
  - `approval-card.tsx:376-379,415,516-519,664`
  - `message-list.tsx:234-272`
  - `research/run-timeline.tsx:377-395,494,784`
  - `research/run-format.ts:15-36`
  - `research/effort-copy.ts:25-41`
- `Intl` precedents:
  - `components/memory/memory-time.ts:7-45`
  - `components/settings/format.ts:10-60`
- Approvals: `src/lib/action-approval.ts:62-83,295-357,387-413`
- Research language:
  - `research/tools.ts:203-317,660-700`
  - `research/corpus.ts:181-236`
  - `research/agents/lead.ts:34`
  - `research/agents/worker.ts:163`
  - `research/engine.ts:3043-3053`
  - `research/claim-analysis.ts:490-553,558-637`
  - `chat/message-item.tsx:395-418`
  - `titles.ts:153,195`
  - `preflight-triage.ts:119,163`
- Out-of-DOM text:
  - `components/app/document-title.tsx:38-48`
  - `components/work/inbox/use-needs-you-count.ts:213-220`
- Native:
  - `native/iOS/JunoMobile/Resources/Localizable.xcstrings` (510 keys, en and fr)
  - `native/macOS/JunoDesktop/project.yml:7-9,57`
  - `JunoChatKit/NativeChatAPIClient.swift:349-370,914,933`
  - `JunoChatKit/NativeSearchActivity.swift:13,21-27,67-69`
  - `JunoChatKit/DeepResearchActivityProjection.swift:125,133`
  - `JunoChatKit/NativeResearchEffort.swift:27-55`
  - `contracts/openapi/juno-native-v1.yaml:1685-1691`
- External, read 2026-09-23:
  - [MDN Intl.DurationFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat)
  - [TC39 Intl.MessageFormat](https://github.com/tc39/proposal-intl-messageformat)
  - [issue #49](https://github.com/tc39/proposal-intl-messageformat/issues/49)
  - [Locize: MF2 in i18next, May 2026](https://www.locize.com/blog/messageformat-2-i18next/)
