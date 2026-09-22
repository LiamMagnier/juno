# Memory audit — Claude, ChatGPT, Juno

*September 2026. Sources for the two competitors are their public documentation and
the press coverage of the 2026 changes; Juno's column is read from this repository.*

---

## 1. How each one works

### ChatGPT

Two layers, controlled independently in Settings → Personalization → Memory.

- **Saved memories** — an explicit list of facts, each individually deletable, written
  when the model decides something is worth keeping or when the user says "remember
  this". Capped (roughly 24k words); on reaching the cap ChatGPT shows a
  *saved-memory-full* indicator at the bottom of the chat and stops adding.
- **Reference chat history** — implicit recall of patterns across past conversations,
  with no list to inspect.

In June 2026 OpenAI began rolling out **Dreaming V3**: a background batch job that reads
across years of conversations between sessions and rewrites the memory store, replacing
the saved-memories list as the foundation rather than sitting beside it. OpenAI reports
factual recall rising from 41.5% (the 2024 saved-memories design) to 82.8%.

Controls: per-memory delete, clear all, both layers toggleable, inline "forget that" in
chat which removes the matching memory and confirms without leaving the conversation.

### Claude

Rolled out to all plans in March 2026, then rebuilt twice in the same year.

- **July 10, 2026** — memory moved from a single rolling summary to individually
  editable, categorised entries, written and updated *during* the conversation rather
  than synthesised afterwards.
- **August 25, 2026** — reorganised around **Topics**. Settings → Memory lists
  everything grouped by subject; each topic opens as a short file you can read, rewrite
  or delete, and edits are made by describing the change in a prompt bar.

Other properties: memory summaries refresh on a ~24h cycle; **three pools** — general
chats and Cowork share one, each Project has its own; **sensitive subjects** (health,
race, ethnicity, gender identity, religion, political beliefs) are not stored by
default and each has an opt-in toggle; **pause** keeps what exists but stops both use
and creation, **reset** deletes everything; incognito chats are never saved or
remembered; deleting a chat does *not* delete the memories it produced; import from
other assistants is supported; a Monthly Recap lives under Settings → Reflect.

### Juno, before this change

A genuinely strong engine behind a surface that had come loose.

**The engine** — and this part was, on several axes, ahead of both competitors:

| Capability | Where |
| --- | --- |
| Incremental extraction with a per-chat high-water mark, resumable | `extractConversationMemory` |
| Nine categories, per-category retrieval weights, TTL on `temporary` facts | `memory-categories.ts` |
| Contradiction resolution — a newer/explicit fact supersedes an older one, and the loser is **annotated, never deleted** | `resolveContradiction` |
| Hybrid retrieval: RRF over cosine + token overlap, weighted by recency, confidence, category and project scope, filled to a token budget | `selectMemoriesForContext` |
| Per-project memory isolation enforced in the SQL *and* in the ranking | `getMemoryProfile` |
| A suppression block-list every write path goes through, with containment matching in both directions | `memory-suppression.ts` |
| Per-turn receipt naming the exact facts used, not a count | `memoryReceiptDetail` |
| A background-provider policy deciding which providers may see memory work at all | `background-provider-policy.ts` |
| Encrypted summary at rest, and every background LLM call billed to the account ledger | `field-crypto.ts`, `recordSpend` |

**The surface** — three defects, none visible to the type-checker:

1. `MemoryManager` POSTed to **`/api/memory/instruct`, a route that does not exist**.
   The natural-language editor — the page's headline feature — 404'd on every use and
   reported it as "Couldn't update memory". The real contract is `/api/memory/edit`
   (draft) → `/api/memory/edit/apply` (commit), and nothing called either.
2. **`EntryList` (358 lines) and `EditsPanel` (207 lines) were never imported.** The
   page rendered a prose summary and a privacy strip, so a user who saw a wrong fact had
   no row to point at, no provenance, and no way to remove it. Everything the engine
   knew — category, confidence, project scope, supersession trail, source chat — was
   reachable by API and invisible in the product.
3. **Pausing memory never persisted.** It called the app provider's `setSettings`,
   which is React state and no request. The switch moved, the toast said "Memory
   paused", and the next page load had it on again.

Plus: `/api/memory/backfill` had worked and been resumable since Memory v2 with nothing
in the product that called it, so an account with a long history had no way to ask Juno
to read it.

---

## 2. Feature comparison

| | ChatGPT | Claude | Juno (before) | Juno (now) |
| --- | --- | --- | --- | --- |
| Inspect individual memories | ✅ list | ✅ Topics | ❌ *built, unreachable* | ✅ Topics **and** flat list |
| Edit one memory | ➖ delete only | ✅ | ❌ | ✅ inline rewrite |
| Delete one memory | ✅ | ✅ | ❌ | ✅ |
| "Forget, and never relearn" | ➖ delete only | ➖ | ✅ API only | ✅ block-list, on the row |
| Natural-language memory editing | ✅ in chat | ✅ prompt bar | ❌ **404** | ✅ draft → diff → apply → **Undo** |
| Reviewable diff before applying | ❌ | ❌ | ❌ | ✅ |
| Undo an applied edit | ❌ | ❌ | ❌ | ✅ server-computed inverse |
| Group by subject | ❌ | ✅ | ❌ | ✅ |
| Search memories | ➖ | ➖ | ❌ | ✅ instant, incl. project + topic |
| Add a memory by hand | ✅ via chat | ✅ | ❌ | ✅ |
| Per-project memory | ❌ | ✅ | ✅ | ✅ (+ scope chip on every row) |
| Sensitive-subject protection | ❌ | ✅ 6 topics | ❌ | ✅ 6 topics, **refuses before the prompt** |
| Pause vs. reset | ➖ toggles | ✅ | ⚠️ pause didn't save | ✅ |
| Export | ✅ account export | ✅ | ✅ | ✅ |
| Incognito / temporary chat | ✅ | ✅ | ✅ | ✅ |
| Learn from past chats on demand | ✅ Dreaming (automatic) | ➖ | ❌ *API only* | ✅ one press, resumable, progress |
| Learn from past chats automatically | ✅ Dreaming | ✅ | ❌ | ✅ between sessions, within usage limits, switchable |
| Forget by saying so in a chat | ✅ | ➖ | ❌ | ✅ with a receipt, guarded against injected content |
| Forgetting reaches the next chat at once | ✅ | ✅ | ❌ *stale summary kept quoting it* | ✅ stale summary benched until rebuilt |
| Import from another assistant | ➖ | ✅ | ❌ | ✅ reviewed row by row, never shown to a model |
| Recap of what changed | ➖ | ✅ Monthly Recap | ❌ | ✅ 7 / 30 / 90 days, correctable in place |
| Memory in the agent surface | ✅ | ✅ Cowork | ❌ | ✅ Work (full) · Code (coding facts only) |
| Memory in voice mode | ✅ | ➖ | ❌ | ❌ *next — see §4* |
| Why a fact is believed (provenance) | ❌ | ❌ | ✅ API only | ✅ source chat, date, confidence |
| What changed and why (supersession trail) | ❌ | ❌ | ✅ API only | ✅ "what Juno stopped believing" |
| Receipt of what was used this turn | ❌ | ❌ | ✅ | ✅ |
| Which providers may read your chats | ❌ | ❌ | ✅ | ✅ |

---

## 3. What changed in the first pass

**The three regressions, fixed.** `useMemory` (`src/components/memory/use-memory.ts`) is
now the single place that knows how this page talks to the server: it drafts through
`/api/memory/edit`, applies through `/api/memory/edit/apply`, keeps the server's inverse
for Undo, and pauses through `useSettingsSave` so the switch reaches the database and
rolls back when the server refuses. `EntryList` and `EditsPanel` are rendered.

**Topics** (`topics-view.tsx`) — Claude's headline surface, built on the categories Juno
already had. An accordion of subject cards, each showing a count, a two-line preview of
the user's own sentences, a sensitivity flag and a retired-count; opening one reveals
the rows with their controls attached.

**Sensitive subjects** (`memory-sensitive.ts`) — six GDPR-shaped topics, off by default,
each a switch in settings. Two properties worth naming, because they are where this goes
past Claude's version:

- The gate is applied **at the ingestion plan *and* in the extractor's prompt**, so a
  refused subject is not merely discarded after the model returned it — it is never
  asked for, and the content never reaches a provider on that path.
- The verdict is **recomputed from content on every read, never stored**. A stored
  verdict would be the classifier as it stood the day the row was written, so widening a
  pattern later would leave unflagged exactly the rows the widening was for. Recomputing
  means every row that predates the feature is flagged too.

The gate applies to automatic extraction only. A fact the user types themselves is
always kept — and labelled — because the switch answers "may a background model write
this down because I mentioned it", and the answer for a row someone is looking at as
they create it is already yes.

**The rest of the surface** — instant search across content, topic label, project name
and change reason; a Topics / All-facts switch; manual add; a stats strip; and the
backfill job finally given a button, driven in a loop with progress and a hard stop,
resumable if the user leaves.

**Motion**, on the house vocabulary (`src/lib/motion.ts`), never decorative:

- Topic cards stagger in at 45ms and carry `layout`, so opening one card and closing
  another is a single continuous move rather than two cuts.
- A deleted row collapses its own height on the way out — the gap closing *is* the
  confirmation, which matters here because the control beside it ("forget") is
  destructive in a different way and the two must feel different.
- Rows animate on **exit only**. A row that is merely being rendered has not arrived
  from anywhere, and animating it would turn every scroll into a performance.
- Counts use `RollingNumber`, so forgetting a fact visibly moves the tally it belonged to.
- Every one of these has a reduced-motion projection that keeps the fade and drops the
  travel — the tiering `globals.css` already applies.

**Tests** — `tests/memory-sensitive.test.ts`, 30 cases. Beyond the classifier and the
gate, three of them are shaped to catch the exact class of bug that caused this work:
every `/api/…` string the memory components fetch must resolve to a real route file in
the app tree; no component in the memory folder may be unreachable from its siblings;
and pausing must write through `useSettingsSave`. All three were confirmed to fail
against the original defect and pass against the fix.

---

## 4. Where Juno now stands

**Ahead of both** on: provenance (why a fact is believed, and which chat taught it),
the supersession trail (what Juno stopped believing and why), the reviewable-and-undoable
edit model, per-turn receipts naming the facts used, project-scoped isolation enforced
in SQL, the background-provider policy, an import that never shows the pasted text to a
model, and a Code surface that is sent only the facts a CI runner has any business
seeing — none of which ChatGPT or Claude expose at all.

**At parity** on: topic grouping, per-entry editing and deletion, sensitive subjects,
pause/reset, incognito, export, manual add, in-chat forget, automatic learning from
history, import, a recap, memory in the agent surface, per-project summaries, voice
mode that knows the caller, and re-reading history that has already been read.

### Closed in the third pass

- **Per-project summaries.** Every project now gets its own summary
  (`ProjectMemorySummary`, per person — two members of a shared project never read each
  other's), built by the same rule as the account's from that project's facts and chats
  only, encrypted at rest and rotated with the rest of the keyring. A project chat reads
  its project's summary and nothing else; the prompt says whose memory it is. The memory
  page can be narrowed to one project (summary, facts and recap), and the project page's
  rail shows the project's own summary and facts.
- **Voice mode reads memory.** A chat's call asks for memory (never incognito); the
  relay fetches it from the app itself, server to server, under a callback token scoped
  to memory, so it never passes through the browser. The call gets exactly what a typed
  turn in that chat would read — the project's own memory in a project, nothing when
  paused — plain text, capped, told not to recite it, kept across provider switches. The
  dock says "Memory" once the relay confirms it. Saved voice turns are now distilled
  straight away instead of waiting for the dreamer. Exercised end to end against the
  relay's mock provider; the native apps keep calls without memory until they ask.
- **Re-reading history, measured first.** `npm run memory:bench` scores what Juno
  believes after reading five ordinary histories (a move, a job change, a trip, a thesis
  and a side project, a forget, sixty facts of a long-time user) against ground truth. It
  runs the production extraction prompt, ingestion, forget and retrieval rules; offline a
  reader that follows the prompt stands in for the model, so CI gates on exact numbers,
  and `--live` swaps in a real model. Measured before anything changed:

  | reading | recall | still believes outdated | precision | retrieval | leaks |
  |---|---|---|---|---|---|
  | as it happens, before | 95.0% | 42.9% | 96.2% | 68.2% | 2 |
  | as it happens, now | **100%** | **28.6%** | **97.6%** | **81.8%** | **1** |
  | re-reading history, before | 92.5% | **100%** | 91.4% | 77.3% | 6 |
  | re-reading history, now | **100%** | **28.6%** | **97.6%** | **81.8%** | **1** |
  | existing data, repaired | 97.5% → **100%** | 85.7% → **28.6%** | 92.9% → **97.6%** | 86.4% → 81.8% | 5 → **1** |

  Re-reading history — which "Learn from past chats" and the dreamer do newest chat
  first — handed every conflict to the older statement, so it left Juno believing the
  old city, the old employer and a trip long over. Facts now carry when they were said
  (`observedAt`), conflicts are judged by it in whatever order they are read, temporary
  facts count from when they were said, and saying something again later makes it
  believed again. A re-judge pass repairs what the old order already decided, dating old
  rows from their messages a bounded batch at a time. And the reader (v2) no longer
  tells the model it "already knows" other scopes' facts or facts Juno stopped
  believing; chats read by v1 are re-read by the dreamer — never from before the oldest
  thing Juno still remembers, so a reset's erasure cannot be undone.

**Still behind:**

- **Beliefs no rule can see are outdated.** Two of the benchmark's seven outdated beliefs
  survive every setting: a change of taste ("prefers short answers" after "detailed
  answers now") and a job search that ended when the job started. Nothing structural
  links them; retiring them needs a model to judge the timeline, which is also what
  ChatGPT's re-synthesis does. The benchmark names both, so a judge pass can be measured
  the day it is written.
- **Retrieval under-weights relevance.** Four of 22 facts a question needs miss the
  context: two share no words with their question (a semantic match would find them —
  the offline run is lexical only), and two lose to newer facts because token overlap
  over a long question is a weak signal next to recency. Measured, not tuned: tuning a
  ranking to 22 questions is how a benchmark gets overfitted.
- **Live numbers.** This environment has no model provider keys, so every figure above
  is the offline run. `npm run memory:bench -- --live` reports the same table with a real
  model reading the chats.
- **Native voice.** The iOS and macOS apps call the relay without asking for memory; the
  token route and relay are ready for them.

## 5. Correctness fixes made along the way

Found while building the above, and fixed in the same branch:

- **"Forget" did not reach the next chat.** The summary is injected whole and was
  rebuilt only when the fact *count* changed, which forgetting does not do.
- **Temporary facts outlived their moment in the summary**, for the same reason: an
  expiry does not change the count either.
- **The sensitive-subject classifier shipped wrong in both directions** — it missed 9 of
  9 plainly sensitive facts (no pattern could match a plural or an open stem) and
  refused 11 of 12 innocent ones, mostly developer English ("race conditions",
  "progressive web app", "broke the build"). Rewritten, with both lists pinned as tests.
- **Copying a reply pasted the user's memory tags with it.**
- **The manual backfill route trusted a disabled button to enforce a pause.**
- **The generated i18n catalog was ignored in intent but tracked in fact**, dirtying the
  tree on every dev run.

Third pass:

- **The project page's memory rail was always empty** — it read `/api/memory` as an
  array, which it has not been for a long time — and had it worked, it would have shown
  the whole account's facts on every project.
- **Project chats' topics leaked into the account summary**, the one path project memory
  still had out of its project after its facts were scoped.
- **The extractor was told other projects' facts, and facts Juno no longer believed,
  were "already known"** — a cross-project leak into the prompt, and the reason a
  project never learned a habit first mentioned elsewhere, or a user's move back home.
- **Undoing a removed project fact restored it account-wide.**
- **Importing a Juno export revived forgotten and replaced facts** into a fresh account,
  and widened project facts to the whole account.
- **"The user's sister lives in Utrecht" replaced where the user lives.** The single-value
  rule now checks whose attribute a sentence is about.
- **Voice turns were never learned from** until the background dreamer reached them.
