# Alevr feature names: proposal

Proposal for owner review · 2026-10-02 · not adopted. No production string, route, id or file name changes until the owner picks names and an implementation pass is authorised. Review page: `/Users/liammagnier/Developer/project/juno/.claude/local-tools/refoundation-artifacts/alevr-naming.html` (rendered from `naming/naming-data.mjs`, the same source as this file).

The owner asked: "maybe find new name for artifacts and other features like memory something related to Alevr brand identity but also mathematical & space like the infinite knowledge".

## Answer

Four branded nouns, each introduced with a plain descriptor: Orbit for your agents, Folio for what Alevr makes, Locus for memory and Deep Field for deep research. Everything else keeps its plain name: Library, Projects, Skills, Routines, Instructions, Voice, Search and threads. Library stays because the plain word already tells the brand story (Borges's infinite library). The thinking moment gets no name: the Continuum mark and the real phase words are enough.

This updates [NAMES_AND_ICONS.md](NAMES_AND_ICONS.md) only if the owner accepts it. That map kept Library, Memory, Projects, Skills, Routines, Instructions and Research as plain nouns and banned space terminology for ordinary controls. This proposal keeps that ban for controls and verbs, and adds three branded *destination or object* nouns beside Orbit, each always introduced with a plain descriptor.

## The system: A point, a path, an ellipse, a fold, a field.

| Geometry | Name | Plain descriptor | Meaning |
|---|---|---|---|
| point | Locus | Memory | What is known about you: one fixed point. |
| path | Continuum (internal only) | The mark, not a label | Thinking becoming action. Logo and thinking mark only. |
| ellipse | Orbit | Your agents | Agents carrying work around you, each on its own path. |
| fold | Folio | What Alevr made | A sheet folded once, like the Continuum blades. Made work you keep. |
| field | Deep Field | Deep research | One long, patient look that shows far more than expected. |

Library holds all of it, and keeps its plain name because Borges's Library of Babel is already literature's image of infinite knowledge.

## Rules

- **Descriptor first.** Each branded noun appears with its plain descriptor on first use, in onboarding, settings search, help, data export and the accessible name ("Locus, memory").
- **Verbs stay plain.** Create agent, Remember, Forget, Open, Save to Library, Start. Never launch, summon, deploy or beam.
- **Names lead events.** Notifications lead with the agent's name or the outcome ("Otto finished a deck"). The branded noun follows, at most once.
- **Not marks.** Only Alevr, Alevr Chat, Alevr Orbit and Alevr Code are product names. Never "Alevr Locus" or "Alevr Folio" lockups or filings until cleared.
- **Latin script, local descriptor.** Branded nouns are not translated, like product names. The descriptor is localized and carries the meaning ("Locus · メモリ"). Needs native review.
- **Identifiers unchanged.** Routes, ids and files stay: /library, /artifacts, /memory, /research, crew/. Only user-facing words change.

## If the owner wants fewer names

1. **Locus.** Drop first. It is the only branded noun on a privacy control. Falling back to Memory costs nothing in clarity.
2. **Folio.** Drop second. The fallback is to show the type (deck, document, site) and use "made by Alevr" as the Library filter.
3. **Deep Field.** Keep longest. It is the clearest bridge ("Deep" is already in the phrase) and the strongest metaphor.
4. **Orbit.** Already chosen (D-035).

## Plain words that stay

Chat · Code · New chat · Search · Projects · Library · Customize · Apps · Skills · Routines · Instructions · Voice · Dictation · Computer · Preview · Activity · Tasks · Runs · Receipts · Plan · Ready · Thinking · Working · Needs your answer · Blocked · Finished · Allowed · Ask first · Stop · Continue · Review · Try again · Approve

## Feature by feature

### 1. Made things (artifacts)

- **Today:** Artifacts · Made by Juno · artifact
- **Recommended:** **Folio** (What Alevr made). Branded name.
- **Meaning:** A folio is a sheet folded once, the same fold as the Continuum blades, and the root of portfolio: a finished piece of work you keep, version and share.
- **Alternatives:** Artifact (Keep today's word): Claude's and Grok's word for the same thing; carries no Alevr meaning. [E5] · Figure (Math and science "Fig. 1"): Reads as a chart or diagram, wrong for a site or a deck. · Plate (Astronomical photographic plate): Beautiful history, but most people read dinnerware.
- **In real copy:**
  - Library filter: "Folios" with descriptor "What Alevr made"
  - Button: "Open folio"
  - Empty state: "No folios yet. Ask for a document, deck, site or design. Everything Alevr makes is kept here with its versions."
  - Notification: "Otto finished a folio: Q3 market brief." (action: Open)
- **How each option reads:** Folio: "Otto finished a folio: Q3 market brief." · Artifact: "Otto finished an artifact: Q3 market brief." · Figure: "Otto finished a figure: Q3 market brief." · Plate: "Otto finished a plate: Q3 market brief."
- **Clarity risk:** Medium. Portfolio helps, but some read folio as a binder of many items. In Indian English a folio is a mutual-fund account number; in hotels, a guest bill. Use the real type (deck, document) in running copy and keep folio for the Library filter, project tab and receipts.
- **Collision risk:** Medium. Crowded common word: Folio AI (Verso.ai, Paris), an AI agent for PowerPoint and Google Slides; Folio (Isengard LLC), an alpha desktop document workspace for AI agents; a Folio digital-wallet app. Fine as an in-product noun; do not file "Alevr Folio". [E7, E8, E9]

### 2. Library

- **Today:** Library (also /artifacts)
- **Recommended:** **Library** (Keep the plain word). Keep the plain word.
- **Meaning:** Borges's Library of Babel is literature's image of infinite knowledge, a combinatorially vast library. The plain word already carries Alevr's story, and everyone knows what a library holds.
- **Alternatives:** Atlas (A bound collection of maps): ChatGPT Atlas (launched 2025-10-21, sunset announced 2026-07-09) still owns the word in AI. [E1, E2] · Aleph (Borges's point that holds every point): Near-homophone of Alevr; Aleph Alpha is a major AI company merging into Cohere. [E4] · Archive (Plain alternative): Collides with the existing Archive action and implies cold storage.
- **In real copy:**
  - Sidebar label: "Library"
  - Button: "Save to Library"
  - Empty state: "Your Library is empty. Everything Alevr makes and every file you add will be kept here, searchable."
  - Notification: "Saved to Library: Q3 market brief.pdf" (action: Open)
- **How each option reads:** Library: "Saved to Library: Q3 market brief.pdf" · Atlas: "Saved to Atlas: Q3 market brief.pdf" · Aleph: "Saved to Aleph: Q3 market brief.pdf" · Archive: "Saved to Archive: Q3 market brief.pdf"
- **Clarity risk:** None. Universally understood. Also rejected: Codex (OpenAI Codex). [E17]
- **Collision risk:** Low. ChatGPT also added a Library (March 2026). A plain shared noun; no exclusivity is claimed or needed. [E3]

### 3. Memory

- **Today:** Memory
- **Recommended:** **Locus** (Memory). Branded name.
- **Meaning:** Latin for place. The method of loci (the memory palace) is the oldest memory technique; in geometry a locus is the set of every point that satisfies a condition: everything that holds true about you.
- **Alternatives:** Memory (Keep the plain word): Strongest clarity on a privacy control; every assistant uses it. · Basis (The set everything is built from): Good math, plain English (foundation); Basis is a $1.15B AI-agent company. [E14] · Constellation (Connected points): Four syllables, decorative, and already common among AI-memory tools. [E15]
- **In real copy:**
  - Customize tab: "Locus" with descriptor "Memory"
  - Button: "Remember this"
  - Empty state: "Locus is empty. When you tell Alevr something worth keeping, it is saved here. You can edit or forget any of it."
  - Notification: "Remembered in Locus: you prefer metric units." (action: Undo)
- **How each option reads:** Locus: "Remembered in Locus: you prefer metric units." · Memory: "Remembered: you prefer metric units. Manage in Memory." · Basis: "Added to your Basis: you prefer metric units." · Constellation: "Added to your constellation: you prefer metric units."
- **Clarity risk:** High. The only branded noun on a privacy control. Keep "Memory" in settings search, the privacy policy, data export, the accessible name ("Locus, memory") and every switch ("Memory: On"). Verbs stay plain: Remember, Forget. Also rejected: Recall (Microsoft Windows Recall). [E27]
- **Collision risk:** Medium-high. Several AI products already use it: Locus for macOS (open-source AI workspace with agents and recurring work), Locus – Mobile AI Agent (App Store), a locus persistent-memory MCP for coding tools, Oracle's locus multi-agent SDK. Acceptable as an in-product noun only. [E10, E11, E12, E13]

### 4. Instructions

- **Today:** Instructions
- **Recommended:** **Instructions** (Keep the plain word). Keep the plain word.
- **Meaning:** These are literal rules the person writes. The label has to say exactly what it does.
- **Alternatives:** Axioms (Statements taken as true): Lovely math, but grand for "be concise"; Axiom Math is a well-funded AI prover. [E16] · Invariants (What holds in every chat): Precise for engineers, opaque for everyone else.
- **In real copy:**
  - Customize tab: "Instructions"
  - Button: "Edit instructions"
  - Empty state: "No instructions yet. Tell Alevr how you like answers: tone, format, language. It applies them in every chat."
  - Notification: "Instructions updated. They apply to new messages."
- **How each option reads:** Instructions: "Instructions updated. They apply to new messages." · Axioms: "Axioms updated. They apply to new messages." · Invariants: "Invariants updated. They apply to new messages."
- **Clarity risk:** None. Clear today.
- **Collision risk:** n/a. Generic vocabulary.

### 5. Projects

- **Today:** Projects
- **Recommended:** **Projects** (Keep the plain word). Keep the plain word.
- **Meaning:** The universal word for a context container. A branded noun would add learning without adding meaning.
- **Alternatives:** Span (Everything reachable from a set): Elegant linear algebra; abstract as a place. · Field (An area of work): Competes with Deep Field.
- **In real copy:**
  - Sidebar label: "Projects"
  - Button: "New project"
  - Empty state: "No projects yet. Keep the chats, files and agents for one piece of work together."
  - Notification: "Mira added 3 files to Launch plan." (action: Open)
- **How each option reads:** Projects: "Mira added 3 files to Launch plan." · Span: "Mira added 3 files to the Launch plan span." · Field: "Mira added 3 files to the Launch plan field."
- **Clarity risk:** None. Clear today.
- **Collision risk:** n/a. Generic vocabulary.

### 6. Skills

- **Today:** Skills
- **Recommended:** **Skills** (Keep the plain word). Keep the plain word.
- **Meaning:** Agent Skills is an open SKILL.md standard (released 2025-12-18; 30+ tools by March 2026). Importing a skill from elsewhere only works if Alevr uses the shared word.
- **Alternatives:** Lemmas (A proven helper reused in bigger proofs): The perfect metaphor and the most opaque word on this page; Lemma is also an AI-observability startup. [E18] · Methods (Plain alternative): Vague, and breaks the shared standard's vocabulary.
- **In real copy:**
  - Customize tab: "Skills"
  - Button: "Import skill"
  - Empty state: "No skills yet. Add one to teach Alevr a repeatable method, or import a skill you already use."
  - Notification: "Scout used the skill Competitor brief." (action: View)
- **How each option reads:** Skills: "Scout used the skill Competitor brief." · Lemmas: "Scout used the lemma Competitor brief." · Methods: "Scout used the method Competitor brief."
- **Clarity risk:** None. Clear, and the industry's word.
- **Collision risk:** n/a. Shared open-standard vocabulary.

### 7. Routines (scheduled work)

- **Today:** Routines (route /automations)
- **Recommended:** **Routines** (Keep the plain word). Keep the plain word.
- **Meaning:** Plain for repeating, scheduled work, and the category's word (Claude Code Routines, April 2026). An orbit is already periodic, so Alevr needs no second cosmic word here. Use "Coming up" as the plain heading for the next runs.
- **Alternatives:** Horizon (What is ahead): Names a view, not the thing; Sierra launched Horizon for long-horizon agents (July 2026). [E20] · Cadence (A steady rhythm): Cadence Design Systems plus several Cadence AI-agent companies. [E21]
- **In real copy:**
  - Customize tab: "Routines"
  - Button: "New routine"
  - Empty state: "No routines yet. Ask Alevr to do something every morning, every week or when something changes."
  - Notification: "Monday market brief ran at 9:00. 3 changes since last week." (action: Open)
- **How each option reads:** Routines: "Monday market brief ran at 9:00." · Horizon: "On your Horizon: Monday market brief, 9:00." · Cadence: "Cadence ran: Monday market brief, 9:00."
- **Clarity risk:** None. Clear today.
- **Collision risk:** n/a. Generic vocabulary shared with Claude Code.

### 8. Research / deep research

- **Today:** Research (composer mode) · Deep research
- **Recommended:** **Deep Field** (Deep research). Branded name.
- **Meaning:** In December 1995 Hubble held on a patch of sky that looked empty for ten days and found about 3,000 galaxies. Deep research does that with one question, and "Deep" keeps the familiar meaning.
- **Alternatives:** Deep research (Keep the plain phrase): Clear, but it is OpenAI's, Google's and Perplexity's generic term. [E22] · Parallax (Measuring by two vantage points): Also the name of an unselected Alevr logo concept, and of YouGov's AI research product. [E25] · Survey (As in a sky survey): Most people read a questionnaire.
- **In real copy:**
  - Composer option: "Deep Field" with descriptor "Deep research"
  - Button: "Start a Deep Field"
  - Empty state: "Deep Field. Reads widely on one question, compares sources and writes a cited report. It can take several minutes."
  - Notification: "Deep Field finished: EU battery rules. 42 sources, 6 open questions." (action: Open report)
- **How each option reads:** Deep Field: "Deep Field finished: EU battery rules. 42 sources." · Deep research: "Deep research finished: EU battery rules. 42 sources." · Parallax: "Parallax finished: EU battery rules. 42 sources." · Survey: "Survey finished: EU battery rules. 42 sources."
- **Clarity risk:** Low. "Deep" bridges to the familiar phrase. A Deep Field must never imply that it found everything; the report states its sources and open questions. Quick lookups stay Search.
- **Collision risk:** Medium. DeepField (deepfield-ai.com) is an AI consumer-research platform for agencies (page dated 2026-09-22); Nokia Deepfield is network analytics. Always two words, never a standalone mark. [E23, E24]

### 9. The Continuum thinking moment

- **Today:** Thinking (spinner / pending row)
- **Recommended:** **No name** (The mark and the real phase words). No name.
- **Meaning:** The mark is already the brand. A label would decorate a state and break the truthful-state rule. Internally, design calls it the Continuum mark and its path handoff; users never see those words.
- **Alternatives:** Continuum (As a visible label): Names a logo, not a state. Rejected. · Reasoning (Plain alternative): Only where the provider exposes real reasoning.
- **In real copy:**
  - Work row: "Searching 12 sources"
  - Control beside it: "Stop"
  - Next phase: "Reading files. The phase words change with real runtime events: Thinking, Reading files, Running Python, Waiting for your answer. The mark holds still between events."
  - Waiting state: "Waiting for your answer: send 3 follow-up emails?" (action: Review)
- **How each option reads:** Thinking: "Searching 12 sources" · Continuum: "Continuum…" · Reasoning: "Reasoning"
- **Clarity risk:** None. Phase words are the accessible name; the mark is decorative beside them.
- **Collision risk:** n/a. No user-facing name.

### 10. Voice

- **Today:** Voice · Dictation
- **Recommended:** **Voice** (Keep the plain word). Keep the plain word.
- **Meaning:** Voice is a mode, not a place. It has to match the OS and be found by search. Dictation stays separate.
- **Alternatives:** Talk (Friendlier verb): Blurs with Chat. · Resonance (Branded alternative): Decorative; adds no meaning.
- **In real copy:**
  - Composer button: "Voice"
  - Button: "Start voice"
  - Empty state: "Voice. Speak naturally. Alevr answers out loud. Tap Stop to end."
  - Notification: "Voice ended after 4 min. The transcript is in this chat." (action: Open)
- **How each option reads:** Voice: "Voice ended after 4 min." · Talk: "Talk ended after 4 min." · Resonance: "Resonance ended after 4 min."
- **Clarity risk:** None. Clear today.
- **Collision risk:** n/a. Generic vocabulary.

### 11. Workspaces and agent threads

- **Today:** Workspace · thread · crew chat
- **Recommended:** **Thread** (Under the agent's own name). Keep the plain word.
- **Meaning:** The agent's name does the branding work; another noun would compete with it. "Workspace" stays only in Code, for the folder and host.
- **Alternatives:** Trajectory (An agent's path of work): Reads as analytics. · Course (A plotted course): Reads as education.
- **In real copy:**
  - Orbit row: "Mira" with descriptor "Research"
  - Button: "Open thread"
  - Empty state: "Nothing here yet. Tell Mira what you need, or ask what it can take on."
  - Notification: "Mira needs your answer: send 3 follow-up emails?" (action: Review)
- **How each option reads:** Thread: "Mira needs your answer: send 3 follow-up emails?" · Trajectory: "Mira's trajectory needs your answer." · Course: "Mira's course needs your answer."
- **Clarity risk:** None. Clear today.
- **Collision risk:** n/a. Generic vocabulary.

### 12. The collective of agents

- **Today:** Crew · Agents
- **Recommended:** **Orbit** (Your agents). Chosen.
- **Meaning:** Agents carry work around you, each on its own path; the two open elliptical arcs are its glyph. Each agent is still called by its own name, never "an Orbit".
- **Alternatives:** Agents (Plain fallback): Zero risk, zero distinctiveness. · Constellation (A group of named points): Long and decorative.
- **In real copy:**
  - Sidebar label: "Orbit" with descriptor "Your agents"
  - Button: "Create agent"
  - Empty state: "No agents yet. Describe a job and Alevr will help you create an agent for it."
  - Notification: "Otto finished the summary." (action: Open)
- **How each option reads:** Orbit: "Otto finished the summary." · Agents: "Otto finished the summary." · Constellation: "Otto, in your constellation, finished the summary."
- **Clarity risk:** Low. Needs "Your agents" on first use; never used for an individual.
- **Collision risk:** Low. Mozilla's Orbit AI add-on shut down on 2025-06-26. A common word; not exclusive. [E26]

## Evidence

Web searches on 2026-10-02. Indexed search signals only, not legal clearance or proof of absence; no domain, handle or mark was bought or filed. Alevr's own availability remains unresolved ([NAMING_SCREEN.md](NAMING_SCREEN.md)). Internal: Parallax is also the name of an unselected logo concept ([LOGO_REVISION.md](LOGO_REVISION.md)).

| Id | Finding | Source · date |
|---|---|---|
| E1 | [ChatGPT Atlas browser launched 2025-10-21](https://www.cnn.com/2025/10/22/tech/openai-chatgpt-atlas-browser-google-chrome-ai) | CNN · 2025-10-22 |
| E2 | [OpenAI is shutting down Atlas (announced 2026-07-09)](https://techcrunch.com/2026/07/09/openai-is-shutting-down-atlas-but-its-ai-browser-ambitions-are-still-growing/) | TechCrunch · 2026-07-09 |
| E3 | [ChatGPT Library stores uploaded and created files](https://www.ghacks.net/2026/03/24/openai-introduces-chatgpt-library-to-store-uploaded-files-in-one-place/) | gHacks · 2026-03-24 |
| E4 | [Cohere to acquire Aleph Alpha](https://www.cnbc.com/2026/04/24/cohere-aleph-alpha-germany-ai-europe-expansion.html) | CNBC · 2026-04-24 |
| E5 | [Claude artifacts (durable outputs)](https://code.claude.com/docs/en/artifacts) | Anthropic docs · read 2026-10-02 |
| E7 | [Folio AI: AI agent for PowerPoint and Google Slides (Verso.ai, Paris)](https://get-folio.ai/help/) | First-party · read 2026-10-02 |
| E8 | [Folio: desktop document workspace for AI agents (Isengard LLC, alpha)](https://www.usefolio.ai/) | First-party · read 2026-10-02 |
| E9 | [Folio: digital wallet app](https://apps.apple.com/ai/app/folio-digital-wallet-app/id1266382717) | App Store · read 2026-10-02 |
| E10 | [Locus for macOS: native AI workspace with agents and recurring work](https://github.com/nahid-sparktales/locus) | GitHub · read 2026-10-02 |
| E11 | [Locus – Mobile AI Agent (Leverage AI Inc.)](https://apps.apple.com/us/app/locus-mobile-ai-agent/id6757721454) | App Store · read 2026-10-02 |
| E12 | [locus: persistent project memory MCP for AI coding tools](https://github.com/Magnifico4625/locus) | GitHub · read 2026-10-02 |
| E13 | [Oracle locus: generative-AI multi-agent reasoning SDK](https://locusagents.oracle.com/) | First-party · read 2026-10-02 |
| E14 | [Basis (AI accounting agents) raises $100M at $1.15B](https://siliconangle.com/2026/02/24/ai-accounting-startup-basis-secures-100m-1-15b-valuation-firms-adopt-agent-based-workflows/) | SiliconANGLE · 2026-02-24 |
| E15 | [Hindsight "Constellation View" for AI memory banks](https://hindsight.vectorize.io/blog/2026/04/16/constellation-view) | First-party · 2026-04-16 |
| E16 | [Axiom Math: AI prover with peer-reviewed proofs](https://www.axios.com/2026/05/26/axiom-ai-math-journal) | Axios · 2026-05-26 |
| E17 | [Agent Skills open standard (2025-12-18), adopted by Codex and 30+ tools](https://codex.danielvaughan.com/2026/05/05/agent-skills-open-standard-portable-skills-codex-cli-cross-agent/) | Practitioner guide · 2026-05-05 |
| E18 | [Lemma: AI agent observability (YC)](https://www.uselemma.ai/) | First-party · read 2026-10-02 |
| E19 | [Anthropic introduces Routines for Claude Code (launched 2026-04-14)](https://www.infoq.com/news/2026/05/anthropic-routines-claude/) | InfoQ · 2026-05 |
| E20 | [Sierra Horizon: long-horizon customer agents](https://sierra.ai/blog/horizon) | First-party · 2026-07-16 |
| E21 | [Cadence: AI agents for labor operations (one of several Cadence AI companies)](https://cadencework.ai/) | First-party · read 2026-10-02 |
| E22 | [OpenAI: Introducing deep research](https://openai.com/index/introducing-deep-research/) | First-party · 2025-02 |
| E23 | [DeepField: AI-native consumer research platform for agencies](https://www.deepfield-ai.com/) | First-party · page 2026-09-22 |
| E24 | [Nokia Deepfield: network analytics and security](https://www.nokia.com/ip-networks/deepfield/) | First-party · read 2026-10-02 |
| E25 | [YouGov Parallax: AI-twin research product](https://yougov.com/articles/55129-yougov-parallax-the-worlds-first-research-product-to-combine-ai-twins-with-validation-from-real-consumers) | First-party · read 2026-10-02 |
| E26 | [Mozilla shuts down its Orbit AI add-on on 2025-06-26](https://www.omgubuntu.co.uk/2025/06/orbit-by-mozilla-shutting-down-june-26-2025) | OMG! Ubuntu · 2025-06 |
| E27 | [Microsoft Windows Recall (rejected as a memory name)](https://support.microsoft.com/en-us/windows/privacy/privacy-and-control-over-your-recall-experience) | First-party · read 2026-10-02 |
| E28 | [Hubble Deep Field: about 3,000 galaxies in an "empty" patch, Dec 1995](https://science.nasa.gov/image-detail/full-wfpc2-mosaic-full-resolution) | NASA · read 2026-10-02 |
| E29 | [Borges, The Library of Babel](https://en.wikipedia.org/wiki/The_Library_of_Babel) | Wikipedia · read 2026-10-02 |
| E30 | [The method of loci (locus, Latin for place)](https://www.mcgill.ca/oss/article/critical-thinking-history/ancient-memory-technique-still-puzzles-scientists) | McGill OSS · read 2026-10-02 |
