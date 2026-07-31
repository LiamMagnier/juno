# 05 — Market study

Researched 2026-07-31 from primary sources — vendor pricing pages, docs, changelogs, GitHub APIs, and the Apple/Google store APIs. Every external claim carries a URL and an access date. Where a fact could not be verified from a primary source it is marked `UNVERIFIED` with what would settle it. No accounts were created, so anything behind an auth gate (in-product paywall screens, real numeric rate limits, some feature ladders) is systematically unverifiable and marked as such.

Three things that stale training data gets wrong and that shape everything below:

- **Mistral's Le Chat is now "Vibe"** (renamed 2026-05-28) and Mistral has flagged its Chat mode for sunset, with history migrating into a Work surface.
- **xAI is now SpaceXAI** (2026-07-06).
- **ChatGPT runs contextual ads** on its Free and Go tiers across US/AU/NZ/CA/UK.
- **LibreChat was acquired by ClickHouse** (announced 2025-11-04, [clickhouse.com](https://clickhouse.com/blog/clickhouse-acquires-librechat), accessed 2026-07-31). It stays MIT; the monetisation is ClickHouse Cloud.

---

## A. Feature parity matrix

`✅ has` · `◐ partial` · `✗ missing` · `—` N/A · `?` UNVERIFIED

Juno's column is verified against this repository. The competitor columns are verified against the sources cited in §D.

### Against the incumbents

| Capability | Juno | ChatGPT | Claude | Gemini | Perplexity | Copilot | Vibe | Grok | DeepSeek |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Multi-model routing (many labs) | ✅ 14 | ✗ | ✗ | ✗ | ◐ | ◐ | ✗ | ✗ | ✗ |
| Auto model selection | ✅ | ✅ | ✗ | ✅ | ✅ | ◐ | ? | ✅ | ✗ |
| Web search + inline citations | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Deep research | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Image generation | ✅ | ✅ | ✗ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Image editing | ✅ | ✅ | ✗ | ✅ | ◐ | ✅ | ◐ | ✅ | ✗ |
| Video generation | ✅ MAX | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✅ | ✗ |
| Code interpreter / sandbox | ◐ browser | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ✗ |
| Artifacts / canvas | ✅ | ◐ inline | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Projects / workspaces | ✅ | ✅ | ✅ | ✗ | ✅ | ✅ | ✅ | ? | ✗ |
| Custom instructions & personas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Agent / GPT builder | ✗ | ✅ | ◐ | ✅ | ◐ | ✅ | ✅ | ? | ✗ |
| Skills / plugin ecosystem | ✗ | ✅ | ✅ | ◐ | ◐ | ✅ | ✅ | ? | ✗ |
| MCP support | ✅ | ✅ | ✅ | ◐ | ? | ✅ | ✅ | ✅ | ✗ |
| Third-party connectors | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✗ |
| Long-term memory + user controls | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Per-response memory provenance | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| File / image / PDF | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Spreadsheet handling | ◐ text-in, xlsx-out | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ◐ |
| Voice read-aloud (TTS) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Voice dictation (STT) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Realtime speech-to-speech | ✅ 4 providers | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ✅ | ✗ |
| Conversation branching | ✅ | ✅ | ◐ hidden | ✗ overwrites | ? | ? | ? | ? | ? |
| Message editing | ✅ | ✅ | ✅ | ✅ | ? | ? | ? | ? | ? |
| Regeneration + version pager | ✅ | ✅ | ✅ | ✅ | ? | ? | ? | ? | ? |
| Conversation search | ◐ title-only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ? |
| Folders | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ? |
| Pinning / archiving | ✅ | ✅ | ✗ | ✗ archive | ? | ? | ? | ? | ? |
| Export / portability | ✅ JSON+CSV | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Import** (from a rival) | ✅ ChatGPT+Claude | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Public share links | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Real-time collaboration | ✗ | ✗ | ✗ | ◐ | ◐ | ✅ | ✗ | ✗ | ✗ |
| Teams & roles | ✗ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| SSO / SAML | ✗ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| SCIM | ✗ | ✅ ent. | ✅ | ✅ | ✅ | ✅ | ? | ? | ✗ |
| **Numeric usage transparency** | ✅ per-msg € | ✗ | ✗ | ✗ | ✅ | ◐ | ✗ | ✗ | — |
| Native mobile app | ◐ built, ship? | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native desktop app | ◐ macOS + Win | ✅ | ✅ | ✗ | ✅ | ✅ | ✅ | ✗ | ✗ |
| Linux desktop | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Offline | ◐ native cache | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ weights |
| Command palette / keyboard-first | ✅ ⌘K | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Prompt library | ✅ | ✗ | ✗ | ◐ Chrome | ◐ | ◐ M365 | ? | ? | ✗ |
| Scheduled / recurring tasks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| Moderation controls | ✅ operator | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Privacy / training-data controls | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Admin console + audit logging | ◐ owner-only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ |
| **Agent / async top-level surface** | ◐ Code | ✅ Work | ✅ Cowork | ✅ Spark | ✅ Computer | ✅ Cowork | ✅ Work | ✅ Automations | ✗ |

### Against the multi-provider / indie field — Juno's actual competitive set

| Capability | Juno | LobeHub | Poe | TypingMind | Open WebUI | LibreChat | Cherry Studio | Chatbox | Msty | BoltAI | T3 Chat |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Hosted (not self-host/BYOK) | ✅ | ✅ | ✅ | ✗ BYOK | ✗ | ✗ | ✗ | ◐ | ✗ | ✗ | ✅ |
| Resells inference (no BYOK needed) | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ | ✅ |
| Multi-provider | ✅ 14 | ✅ 50+ | ✅ | ✅ | ✅ | ✅ | ✅ ~50 | ✅ 20+ | ✅ | ✅ 300 models | ✅ |
| Auto model routing | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ recommends | ✗ | ✗ |
| Deep research | ✅ | ✗ TODO | ? | ✅ | ◐ | ✗ | ✗ roadmap | ✗ | ✗ | ✗ |
| Artifacts / canvas | ✅ | ✅ | ? | ✅ both | ◐ HTML-only | ✅ | ◐ | ✅ | ✅ Aurum | ✗ | ✗ |
| MCP | ✅ | ✅ | ? | ✅ | ✅ admin-only | ✅ best | ✅ | ✅ desktop | ✅ | ✅ | ✗ |
| Memory w/ user controls | ✅ | ✅ | ? | ◐ | ✅ best | ✅ | ◐ | ✗ | ? | ✅ | ✗ |
| Realtime speech-to-speech | ✅ | ✗ chained | ? | ✗ | ◐ chained | ✗ | ✗ | ✗ | ? | ◐ stale | ✗ |
| Voice TTS + STT | ✅ | ✅ | ? | ✅ | ✅ | ✅ | ✗ **both** | ✗ **both** | ? | ✅ | ✗ |
| Code agent (repo-aware) | ✅ | ◐ | ✗ | ✗ | ◐ subagents | ✅ | ✅ | ✅ Work Mode | ✅ Go | ✗ | ✗ |
| Scheduled tasks | ✅ | ✅ | ✗ | ✗ | ✅ | ✗ roadmap | ✅ | ✗ | ✅ Go | ✗ | ✗ |
| Per-message cost display | ✅ | ✅ | ✅ | ✅ | ✗ **tokens only** | ◐ off by default | ✅ | ✅ | ✅ Aurum | ✗ | ✗ |
| Native iOS app | ◐ ? | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ◐ beta | ✗ |
| Native desktop app | ◐ macOS/Win | ✅ | ✅ | ✗ | ◐ alpha | ✗ | ✅ | ✅ | ✅ | ✅ macOS | ✗ |
| Teams / SSO / SCIM | ✗ | ◐ / ◐ / ✗ | ? | ✅ / ✅ / ✅ | ✅ / ◐ / ✅ | ✅ / ✅ / ✗ | ✅ ent. | ✗ | ◐ / ◐ / ✗ | ✗ | ✗ |
| Free tier that can send a message | **✗** | ✅ | ✅ | ◐ no history | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ trial | ? |

---

## B. Gap analysis — which gaps actually cost Juno users

### Table stakes Juno is missing (fix these)

**1. A free tier that can send a message. — the single most damaging gap.**
`FREE.monthlyMessages = 0` ([`src/lib/plans.ts:33`](../src/lib/plans.ts)). Every hosted competitor in both tables has a usable free tier: ChatGPT, Claude, Gemini, Perplexity, Copilot, Vibe, Grok, DeepSeek, Poe, LobeHub, T3 Chat. Chatbox even runs a *recurring daily* free allowance ([chatboxai.app](https://chatboxai.app/en), accessed 2026-07-31). Juno asks a stranger for €20 before they have seen a single token stream. In a category whose entire acquisition funnel is "try it, then pay", this is not a pricing choice, it is a closed door.

**2. Conversation search that reaches message bodies.** Every incumbent has it; Open WebUI's is typo-tolerant Meilisearch. Juno's is title-only because message bodies are encrypted at rest — a good security decision with a bad product consequence, and the mitigation (client-side index over the already-decrypted open conversation) is cheap.

**3. Teams / SSO.** Absent, and absent across most of the indie field too — so this is table stakes only if Juno sells to organisations. It currently does not, and I would not add it.

**4. A code interpreter that runs server-side.** Juno's Pyodide runs in the artifact sandbox in the browser: no filesystem, no pip, no large files. Every incumbent runs real server-side execution. This matters for the data-analysis use case and nothing else.

### Genuine differentiators Juno already has (defend these)

**1. Per-message cost in euros, on every turn.** `Mistral Medium 3.5 · 7.3K tokens · $0.037`. Cross-referencing both dossiers: **seven of eight incumbents publish only relative multipliers** — "4x higher", "up to 6x free" — and Google actively *removed* its numeric quotas at I/O 2026. The only incumbent exception is Perplexity's credit meter. On the indie side, Open WebUI's admin analytics has **no currency at all** (its docs hand you the multiplication to do yourself), LibreChat's cost display is **off by default**, TypingMind shows dollars to individuals but **not** in its Teams admin console, and BoltAI, ChatWise, Witsy and Kerlig have **none** despite being BYOK products whose users are spending their own money.

This is Juno's strongest and least-defended position. The landing page already sells it. Lean harder.

**2. Import from ChatGPT and Claude.** Verified across both dossiers: **not one of the seventeen products researched offers an import path from a rival.** Every product exports; portability is one-directional across the entire market. Juno reads a ChatGPT *or* Claude export ZIP idempotently. That is the single cheapest switching-cost reversal available to anyone in this category and Juno has already built it — and does not advertise it anywhere on the landing page.

**3. Realtime speech-to-speech across four providers.** LobeHub's is chained STT→LLM→TTS ("Hands-Free Mode", explicitly not duplex). Open WebUI's Call mode is likewise a pipeline with zero Realtime-API references in its env docs. TypingMind, LibreChat, Cherry Studio and Chatbox have **no realtime voice at all**; Cherry Studio and Chatbox have **no TTS or STT of any kind**. BoltAI has it, pinned to `gpt-4o-realtime-preview-2024-10-01` — a two-year-old model. Juno's relay is genuinely ahead of the indie field here.

**4. A command palette.** Only Claude among the incumbents has a real ⌘K. Close to an open field.

**5. Folders.** Basic organisation is genuinely weak across the market: Claude cannot pin or archive individual chats, Gemini has no archive, Chatbox has no chat folders, AnythingLLM's thread menu offers only rename and delete.

**6. Auto model routing that is actually cheapest-first.** Among the multi-provider field, **nobody else has query-level auto-routing.** Msty recommends; OpenRouter's Fusion is a panel-plus-judge; LibreChat, Open WebUI, TypingMind, ChatWise, BoltAI and Cherry Studio are all manual. Juno's `juno:auto` classifies complexity and picks the cheapest eligible model. That is a real, unclaimed position — and it is undersold, because the user never sees *why* a model was chosen.

### Gaps that are noise — do not build these

- **Agent / GPT builders and a plugin marketplace.** 8/8 incumbents have them; the indie field mostly does not. A solo product cannot seed a marketplace, and MCP already provides the extensibility. Skip.
- **Real-time collaboration on a conversation.** Nobody does it — ChatGPT explicitly does not, Claude has an open request. The market's answer is collaboration on the *artifact*. Not urgent either way for a single-player product.
- **SCIM.** Only relevant with an enterprise motion Juno does not have.
- **Video generation.** Only 2/8 incumbents. Juno already has it behind MAX; do not invest further.
- **Per-response memory provenance.** Only ChatGPT has it. Genuinely the state of the art, and genuinely not why anyone will choose Juno.
- **Native image generation.** Claude ships none at all and remains a top-two product. Useful evidence that this is skippable.

---

## C. Design and UX benchmark

Sixteen conventions the incumbents have converged on, and where Juno sits. "Convention" = 6/8 or better.

| # | Current convention | Juno | Verdict |
|---|---|---|---|
| 1 | One rounded composer, `+` attach on the left, tool pills beneath. **8/8** | ✅ exactly this | Follows. Correct. |
| 2 | Model switcher **in the composer**, not a top bar. 7/8 (ChatGPT moved 2026-04-28) | ✅ in the composer | Follows. Correct — and Juno was there first. |
| 3 | Plain-language effort labels, not version numbers. 6/8 | ✅ Instant/…/Max | Follows. But the control renders as a bare value (`High`) with no label — see [04](04-UX-AUDIT.md) §2. |
| 4 | Collapsible reasoning panel above the answer. 7/8 | ✅ Thought process panel | Follows, and Juno's PROFILE-vs-FACTS split is more honest than most. ChatGPT's *steerable* plan is the leading edge Juno does not match. |
| 5 | Side-panel artifact splitting the screen. 7/8 — **but ChatGPT is defecting** to inline blocks + full-screen editor (2026-05-28) | ✅ side panel | Follows the majority. Watch this: the largest player is betting the split-pane is wrong. |
| 6 | "Projects" is the organising primitive; folders barely exist. 6/8 — Perplexity renamed Spaces→Projects on 2026-07-30 | ✅ both | Follows and exceeds. Having folders *as well* is a genuine plus, not a deviation. |
| 7 | Two-layer memory (auto + explicit) with per-item delete. 7/8 | ✅ + natural-language editing with an undo ledger | **Exceeds the convention.** Juno's "forget my old job" → reviewable, undoable operation set is ahead of every incumbent's list-and-delete UI. It is also invisible until you go looking. |
| 8 | MCP as the integration substrate. 6–7/8 | ✅ | Follows. Correct call. |
| 9 | Scheduled / recurring tasks. 7/8 | ✅ | Follows. |
| 10 | Separate full-screen realtime voice session, distinct from composer dictation. 6/8 | ✅ voice dock + composer mic | Follows — **but the two live adjacent in the composer as near-identical audio glyphs**, which is the unforced error in [04](04-UX-AUDIT.md) §2. The convention puts them at different levels of the UI. |
| 11 | Public share links. 7/8 | ✅ snapshot-pointer shares | Follows, and Juno's snapshot semantics are stricter than most. |
| 12 | Onboarding is a hard auth gate, not a tour. Universal | ✅ | Follows. Correct — nobody ships a feature carousel. |
| 13 | Usage limits published as **relative multipliers**. 7/8 | ❌ Juno shows exact € | **Deliberate advantage.** Deviate harder. |
| 14 | Hybrid subscription + metered credits. 6/8 — the defining 2026 pricing shift | ❌ flat-rate only | **Unforced error.** Juno already computes exact per-request cost and enforces a € budget internally. It has the entire metering apparatus and exposes none of it as a product. See §D. |
| 15 | An agent / async surface promoted to top level. **8/8** — ChatGPT *Work*, Claude *Cowork*, Copilot *Cowork*, Perplexity *Computer*, Vibe *Work*, Gemini *Spark*, Grok *Automations* | ◐ "Code" in a sidebar mode toggle | **Partly deliberate, partly a miss.** Juno has the runtime (device sessions, cloud runs, subagents) and files it under a developer-flavoured name in a segmented control. Mistral has flagged Vibe's *Chat* mode for sunset. If chat is becoming a thin surface over an agent runtime, Juno's Code surface is undersold by its name and its placement. |
| 16 | Auto-routing that is **visible and overridable**. Emerging | ◐ sticky, but silent | Juno routes and logs the decision server-side (`console.info("[chat:auto]")`) but never tells the user which model was picked *or why*. The convention is routing you can see and veto. Surfacing the one-line reason would turn an invisible feature into a differentiator. |

**Where deviating is right:** #13 (numeric cost transparency) and #6 (folders as well as projects). Both are deliberate and both are advantages.

**Where deviating is an unforced error:** #14 (no metered layer), #10's implementation (two adjacent audio glyphs), #16 (invisible routing), and #15's naming/placement.

**One design observation the market data supports.** Juno's visual identity — warm paper, Newsreader serif for the entire UI, a single coral accent, no all-caps, film grain — is genuinely distinctive in a category that has converged on cool grey and Inter. Nothing in either dossier describes a competitor that looks like this. That is not a small thing for a solo product: it is the cheapest possible differentiation and Juno already has it.

---

## D. Pricing

### Where Juno sits

| | Free | Entry | Standard | Power | Ultra |
|---|---|---|---|---|---|
| **Juno** | **€0 — 0 messages** | — | **€20** | **€100** | **€200** |
| ChatGPT | Yes, with ads | Go $8 | Plus $20 | Pro $100 | Pro $200 |
| Claude | Yes | — | Pro $20 ($17 annual) | Max 5× $100 | Max 20× $200 |
| Gemini | Yes | AI Plus $4.99 | AI Pro $19.99 | AI Ultra $99.99 | $200 |
| Perplexity | Yes | Comet Plus $5 | Pro $20 | — | Max $200 |
| Vibe (Mistral) | Yes | Education $5.99 | **Pro $14.99** | — | — |
| Grok | Yes | SuperGrok Lite $10 | SuperGrok $30 | X Premium+ $40 | Heavy $300 |
| DeepSeek | Yes — **no paid tier at all** | — | — | — | — |
| **LobeHub** | **Yes** (500k credits) | **$12.9** ($9.9 annual) | $24.9 ($19.9) | $49.9 ($39.9) | — |
| **Poe** | Yes, daily points | **$4.99** | $19.99 | — | — |
| **Chatbox** | Yes, daily quota | **$3.99** ($3.50 annual) | $19.99 ($16.7) | $39.99 ($33.33) | — |
| **T3 Chat** | ? | ~$8 `UNVERIFIED` | — | — | — |
| **TypingMind** | Yes, no history | **$39 once** | $79 once | $99 once | — |
| **Msty** | **$0 forever** | $149/yr | **$349 lifetime** | — | — |

Sources: [openai.com/chatgpt/pricing](https://openai.com/chatgpt/pricing), [claude.ai](https://claude.ai), [gemini.google](https://gemini.google), [perplexity.ai/hub/pricing](https://www.perplexity.ai/hub/pricing), [lobehub.com/pricing.md](https://lobehub.com/pricing.md), [help.poe.com](https://help.poe.com/hc/en-us/articles/19945140063636-Poe-Purchases-FAQs), [chatboxai.app/en](https://chatboxai.app/en), [typingmind.com/buy](https://www.typingmind.com/buy), [msty.ai/pricing](https://msty.ai/pricing/) — all accessed 2026-07-31. T3 Chat's pricing page 404s and its subscription page is auth-gated; the $8 figure is secondary-sourced and `UNVERIFIED`.

### Four things this table says

**1. €20 is the right number and Juno is on it.** Five incumbents at effectively $20; $100 and $200 have become the standard power rungs, with three vendors converging on that exact ladder within a quarter. Juno's 20/100/200 is not mispriced against the incumbents.

**2. Juno is mispriced against its *actual* competitive set.** In the multi-provider category — where the entire cultural premise is "cheaper than ChatGPT, or bring your own keys" — Juno's €20 entry is **2.5× Chatbox's monthly, 5.7× Chatbox's annual, 4× Poe's entry, and 1.55× LobeHub's entry**. And every one of those has a free tier that sends messages. Juno charges an incumbent price without an incumbent brand, and charges it *before* the user has seen the product.

**3. Juno has no annual plan.** Claude, Gemini, LobeHub, Chatbox and TypingMind all discount 17–23% for annual. Annual billing is the cheapest available improvement to cash flow and churn for a solo operator, and it costs one Stripe price id.

**4. Juno has no metered layer despite having built the meter.** `src/lib/spend.ts` computes exact per-request micro-USD, writes an `ApiSpend` ledger row per call, and enforces a monthly € budget with rolling 5-hour and weekly windows. That is precisely the hybrid subscription+credits architecture 6/8 incumbents shifted to in 2026 — and Juno exposes none of it as a product surface. Poe, ironically a resold-inference product, has the best cost UX in the entire research set: per-bot rate cards, per-message cost breakdown, and global *and per-chat* budget caps that prompt before overspending.

### The margin arithmetic, which nobody else's pricing has to survive

`src/lib/spend.ts:20-27` sizes budgets against **net** revenue after ~21% URSSAF cotisations: Pro €20 → €15.80 net → €11 budget → €4.80 margin. That is honest and it is thin. Measured live, a trivial two-part question cost **$0.037** with ~7.3K tokens of per-turn overhead ([04](04-UX-AUDIT.md) §3). At that rate €11 buys roughly **300 messages a month** on a plan sold as unlimited. A single heavy user on Opus-class models exhausts it in a fraction of that.

Meanwhile **OpenRouter — which raised $113M at a ~$1.3B valuation in May 2026 and processes 25T tokens weekly — publicly anchors fair routing margin at ~5%** (5.5% credit-purchase fee, 5% BYOK fee, no markup on inference; [openrouter.ai/docs/faq](https://openrouter.ai/docs/faq), accessed 2026-07-31). Juno's implied margin at the budget ceiling is ~30%. That is defensible *if* the product justifies it — but it means Juno cannot win a price war with an aggregator and should not try.

---

## E. Positioning

### Who Juno is actually competing with

Not ChatGPT. Ranked by closeness:

1. **LobeHub** — the only other product that is hosted, resells inference, spans 50+ providers, ships native desktop *and* iOS, and has structured user-editable memory, MCP, projects and scheduled runs. 81k GitHub stars, source-available under a custom non-OSI licence. Juno's defensible surface against it is **voice** (LobeHub's realtime is chained, not duplex) and **the code agent** — its README claims neither. Everything else on Juno's list LobeHub has or beats.
2. **Poe** — identical business model, better native-app matrix (iOS/Android/macOS/Windows/web, 54k iOS ratings), but its depth is in the creator marketplace rather than the chat surface. And it has the best cost UX in the market.
3. **Chatbox** — the packaging threat. $3.50/month annual, real five-platform parity, 41k stars, resells inference *and* supports BYOK. It has no memory, no voice of any kind, no deep research, and no projects — but it is 5.7× cheaper.
4. **TypingMind** — the feature benchmark (MCP, skills, canvas, SSO **and** SCIM v2) at $39 one-time, BYOK, PWA-only.
5. **T3 Chat** — the closest *business* analogue: solo-built hosted SaaS, deliberately far shallower, reported seven-figure ARR on speed and price.

### The honest read on each segment

**Enterprise: unwinnable, do not try.** No SSO, no SCIM, no audit log, no SOC 2, no DPA, one operator, and a bus factor of one. LibreChat gives away SAML/LDAP/OIDC + RBAC in an MIT core; Open WebUI gives away SCIM 2.0. Juno cannot compete on governance and should not spend a week pretending otherwise.

**Displacing ChatGPT for the mainstream: unwinnable.** Brand, distribution, price parity, and now ads-subsidised free tiers.

**Winnable: the person who wants every frontier model, honestly metered, in a product that is nice to live in.** Specifically someone who (a) already suspects they are overpaying for one lab's subscription, (b) wants Claude *and* GPT *and* Gemini without three subscriptions or an API key, (c) cares that their conversations are encrypted at rest and that account deletion actually deletes, and (d) values craft.

### The positioning I would actually recommend

**"Every frontier model. One subscription. And you can see exactly what each answer cost."**

That is nearly what the landing page already says — the third clause is the one doing the work and it is currently in the smallest type on the page ([04](04-UX-AUDIT.md) §4.1: it fails contrast at 2.44:1). The research says cost transparency is the clearest open flank in the entire market: seven of eight incumbents have actively *retreated* from numeric limits, and the indie field has cost tracking that is absent, token-only, off by default, or paywalled.

Three moves, in order:

1. **Fix the free tier.** A small monthly allowance on a cheap model, or a 20-message trial. This is not a pricing concession; it is the entire top of the funnel and every competitor has one.
2. **Ship the meter as a product surface.** A live € balance, per-model rate cards, and a spend cap the user sets — Poe's pattern, which Juno already has the ledger for. This turns "unlimited\*" into the only honest usage story in the category, and it converts the thin-margin problem into a feature.
3. **Advertise the import.** Nobody else in the market lets you bring your history in. It is built, it is idempotent, it handles both ChatGPT and Claude exports, and it is invisible.

Then add an annual plan and a sub-€10 entry tier, because the $0→$20 gap is being filled by every serious competitor and Juno currently has nothing in it.

### What I would not do

Build an agent marketplace, chase SSO, build real-time collaboration, or spend anything further on video generation. And — stated plainly because the temptation is real — do not add BYOK. It would immediately reposition Juno against TypingMind and Msty at $39–$349 one-time, which is a worse business than the one it is currently in.

---

## F. What could not be verified

- **In-product surfaces across every incumbent** — paywall interstitials, empty states, dark-mode placement, real numeric rate limits. Blocked systematically by the no-login rule.
- **Basic conversation mechanics for five of eight incumbents** — editing, regeneration, branching, pinning, archiving are simply not documented publicly.
- **T3 Chat's pricing and feature set** — `t3.chat/pricing` 404s, the subscription page is auth-gated, and the site bot-blocks automated fetches (HTTP 429 across six attempts). This is the highest-priority manual check, because T3 Chat is Juno's closest business analogue.
- **LobeHub's exact paid tiers via the rendered page** (`/pricing` 403s to automated fetches); the figures above come from `lobehub.com/pricing.md`, a machine-readable primary source, which is good evidence but not the rendered page.
- **Poe's ladder above $19.99** — `poe.com/pricing` 404s; secondary sources report $49.99/$99.99/$249.99 tiers I could not confirm.
- **Whether Juno's iOS app is actually shipped to the App Store.** `native/iOS/JunoMobile` exists and builds in CI; I did not check the store listing.
- **Whether every model provider's terms permit resale** to third parties under a single subscription. This is a per-provider legal read and a genuine business risk — see [03](03-PRODUCTION-READINESS.md) §5.6.
- Funding for Cherry Studio, Chatbox, LobeHub and T3 Chat; and Poe's revenue/MAU (circulating figures are SEO-blog claims).
- Both research tracks exhausted a 200-call web-search budget, so newer entrants were not systematically swept.
