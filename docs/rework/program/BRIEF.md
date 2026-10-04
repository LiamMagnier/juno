# Alevr — Complete Product Rework & Competitive Supremacy Program

You are working inside the existing repository for **Alevr**, currently containing substantial legacy/internal naming as **Juno**.

Your task is not to make a superficial redesign, not to add random competitor features, and not to produce a theoretical audit that stops at recommendations.

You must:

1. inspect the existing repository deeply;
2. understand what is actually implemented, partially implemented, tested, enabled and production-ready;
3. benchmark Alevr against the best current AI assistants and agents;
4. identify architectural and UX problems;
5. design the correct end-state;
6. implement it incrementally;
7. migrate existing systems rather than duplicating them;
8. write/update meaningful tests;
9. verify every important workflow end-to-end;
10. leave Alevr simpler for the user despite becoming substantially more powerful internally.

Do not blindly clone ChatGPT, Claude, Gemini, Kimi, Grok, Hermes, Perplexity, Cursor or any other competitor.

Study them to understand why their best ideas work, then build a coherent Alevr-native implementation.

The objective is:

> **Make Alevr one of the best general-purpose AI products available, not merely another multi-model chatbot.**

---

# 0. NON-NEGOTIABLE PRODUCT DIRECTION

The primary user-facing product architecture should converge toward:

## Alevr Chat

The universal conversational entry point.

The user should simply ask for something.

Alevr determines whether it should:

- answer immediately;
- think longer;
- search the web;
- browse websites;
- use connected apps;
- inspect files;
- execute code;
- create an artifact;
- launch Deep Research;
- hand the task to background execution;
- delegate to Orbit agents;
- create a document, spreadsheet, deck or site;
- schedule a Routine;
- ask for approval;
- continue work later.

The user should not need to understand Alevr's runtime architecture to get good results.

## Alevr Orbit

The persistent-agent layer.

Orbit contains:

- named agents;
- identities;
- roles;
- long-term goals;
- agent memory;
- user/context memory;
- Skills;
- apps;
- permissions;
- routines;
- recurring responsibilities;
- computers;
- browser access;
- activity;
- agent-to-agent delegation;
- teams/rooms;
- background execution;
- notifications.

Orbit should feel like having persistent AI collaborators, not like configuring Custom GPTs.

## Alevr Code

A dedicated software engineering environment.

Code deserves a separate environment because it has specialized state:

- repositories;
- branches;
- worktrees;
- files;
- plans;
- terminal;
- diffs;
- checks;
- PRs;
- agents/subagents;
- review;
- rollback;
- Computer Use;
- GitHub workflows;
- environments.

Do not force Code back into ordinary Chat.

---

# 1. PRODUCT SIMPLIFICATION

One of Alevr's current weaknesses is that it exposes too many internal concepts.

The user should NOT need to think in terms of:

- Chat;
- Work;
- Research;
- Tasks;
- Automations;
- Routines;
- Skills;
- Memory;
- Apps;
- Agents;
- Computer;
- Artifacts;
- Tools;
- Providers;
- background jobs;
- execution targets.

Those can all exist internally.

Reduce the user-facing conceptual model.

Shared organization/configuration may remain around:

- Projects;
- Library;
- Customize.

Research is a capability.

Work is a runtime.

Memory is infrastructure.

Skills are capabilities.

Tools are implementation details.

Automations should converge around one understandable user concept: **Routines**.

---

# 2. FIRST PHASE: AUDIT REALITY BEFORE IMPLEMENTATION

Before changing architecture, inspect the current source.

Do not trust old documentation automatically.

The repository contains extensive documentation and historical audits, but some documentation is stale relative to current `main`.

For every major capability determine:

- implemented?
- partially implemented?
- verified?
- tested?
- feature flagged?
- production enabled?
- native parity?
- web parity?
- obsolete?
- duplicate implementation?
- stale documentation?

Create one machine-readable capability registry.

For example:

```yaml
orbit.rooms:
  backend: verified
  web: partial
  macos: planned
  ios: planned
  production: false

computer_use.cloud:
  backend: implemented
  security_acceptance: blocked
  production: false

memory.session_search:
  backend: implemented
  web: implemented
  native: partial
  tests: verified
```

Use states such as:

- planned
- scaffolded
- implemented
- verified
- enabled
- production_accepted
- blocked
- deprecated

This registry should become the canonical source used by:

- parity documentation;
- feature status;
- release checks;
- developer documentation;
- potentially internal admin/debug pages.

Do not allow several Markdown documents to disagree about whether something exists.

---

# 3. P0 — ARCHITECTURAL HEALTH

## 3.1 Break down giant orchestration files

Several core areas have accumulated too many responsibilities.

Examples include very large:

- Chat route;
- Composer;
- Chat view;
- Message item;
- Research engine.

Do NOT perform a dangerous rewrite for aesthetic reasons.

Refactor incrementally behind existing tests.

Move toward explicit pipeline components such as:

```text
resolveTurnContext
resolveAssistantIdentity
resolveModel
resolveMemory
resolveProjectContext
resolveCapabilities
resolveSkills
resolveTools
resolveApprovals
runTurn
persistTurn
finalizeOutputs
```

The main route should become an orchestrator rather than containing every subsystem directly.

Do the same for Research.

Keep provider-specific code outside product orchestration.

Keep presentation outside domain behavior.

Keep permission/security checks deterministic and outside model control.

---

# 4. P0 — WEBSITE SPEED, NAVIGATION AND SMOOTHNESS

The Alevr web application must feel dramatically faster.

I specifically want page-to-page navigation to feel immediate.

Do a real performance audit rather than adding fake animation to hide latency.

Measure:

- route transition time;
- JS bundle size;
- hydration cost;
- React render count;
- expensive component mounts;
- server response times;
- duplicate data fetches;
- sequential API waterfalls;
- layout shifts;
- sidebar remounts;
- long-task blocks;
- streaming render cost;
- memory usage;
- large conversation performance.

Investigate:

- Next.js routing boundaries;
- layouts;
- server/client component boundaries;
- prefetch behavior;
- cache usage;
- route-level code splitting;
- dynamic imports;
- loading states;
- request waterfalls;
- duplicate fetches;
- shell remounting;
- shared data queries;
- React reconciliation;
- unnecessary global state updates.

### Navigation requirements

The application shell should stay mounted whenever possible.

Switching:

- Chat → Project;
- Project → Library;
- Library → Customize;
- Chat → Orbit;
- Orbit agent → another Orbit agent;

should not feel like reloading an application.

Use:

- route prefetch;
- predictive preloading when justified;
- cached shared resources;
- optimistic navigation;
- background refresh;
- stale-while-revalidate where safe;
- parallel data loading;
- small route bundles;
- sensible skeletons;
- existing data immediately while refreshing.

Never add loading animation solely to hide avoidable architecture latency.

Record baseline performance and compare after implementation.

Target meaningful measured improvement, not subjective claims.

---

# 5. P0 — VIRTUALIZE CHAT

The web transcript currently risks becoming expensive as conversations grow.

Implement proper long-conversation handling.

Requirements:

- dynamic-height virtualization/windowing;
- stable scroll anchoring;
- streaming message separated from settled history;
- find-in-chat compatibility;
- citation/tool cards compatibility;
- generated media;
- research runs;
- artifacts;
- assistant actions;
- accessibility;
- keyboard navigation.

A 1,000-message conversation must remain smooth.

Streaming the newest answer must not re-render the entire conversation.

Study the architecture already developed in Alevr's desktop implementation and reuse good concepts instead of independently solving the same problem again.

---

# 6. P0 — UNIFY SECURITY AND PERMISSIONS

Alevr will become increasingly autonomous.

Permissions therefore cannot remain fragmented between Chat, Work, Agents, Code, connectors and Computer Use.

Create one coherent permission model.

User-facing concepts should be approximately:

- Block;
- Ask every time;
- Allow once;
- Allow for this task;
- Allow for this site/app;
- Always allow.

Some actions must NEVER become permanently auto-approved.

Create deterministic risk classes.

Examples:

### Safe/read

- search;
- read file;
- list folder;
- inspect page;
- calculate;
- inspect repository.

### Reversible write

- create draft;
- edit private note;
- create local file;
- update reversible project state.

### External action

- send email/message;
- submit a form;
- create issue;
- publish;
- invite somebody.

### Destructive/sensitive

- delete;
- merge;
- deploy;
- purchase;
- financial operation;
- credential action;
- account/security changes.

The final authorization decision must be enforced by trusted code.

The model may request permission.

The model may never grant itself permission.

---

# 7. P0/P1 — ALEVR SECRET & CREDENTIAL BROKER

Build a proper credential architecture before increasing autonomous Computer Use.

The model should not receive plaintext:

- passwords;
- API tokens;
- OAuth refresh tokens;
- cookies;
- payment credentials;
- one-time codes whenever avoidable;
- sensitive authentication material.

Create a trusted **Alevr Secrets** layer.

Example capability:

```text
Credential:
  identity = Liam
  service = github.com
  allowed_scopes = repository read/write
  domains = github.com, api.github.com
  lifetime = this task
```

The agent receives a capability reference.

The trusted runtime injects credentials only at the appropriate boundary.

The model should not see the underlying secret.

Implement:

- encryption at rest;
- strict account scoping;
- host/domain restrictions;
- scopes;
- expiration;
- task-scoped grants;
- revocation;
- access log;
- approval receipts;
- credential rotation support;
- least privilege.

Treat credentials obtained through interactive browser takeover similarly.

Do not make a persistent browser profile equivalent to an unrestricted credential vault.

---

# 8. P1 — REBUILD MEMORY TO AIM ABOVE CHATGPT / CLAUDE / GEMINI / HERMES

Do a complete audit of the existing Alevr memory system first.

Preserve good existing work.

Do not replace a sophisticated system with a generic vector database.

Memory should become one of Alevr's strongest features.

Design it as several layers.

## Layer A — Working context

What matters to the current conversation.

Short-lived.

## Layer B — Durable user profile

High-confidence durable information such as:

- preferences;
- communication style;
- ongoing projects;
- frequently used technology;
- stable goals;
- important personal context voluntarily shared.

Keep this bounded.

Do not dump hundreds of facts into every system prompt.

## Layer C — Episodic memory

Specific events from previous conversations:

- what happened;
- when;
- which project;
- which participants;
- relevant artifacts/files;
- outcome.

Retrieve on demand.

## Layer D — Conversation/session recall

Every conversation should remain searchable.

Implement fast hybrid retrieval over historical messages.

Use methods such as:

- FTS/BM25;
- semantic retrieval when beneficial;
- recency;
- entity matching;
- project scope.

A query such as:

> “What did we decide about Orbit permissions two weeks ago?”

should locate the actual relevant historical conversation rather than relying only on an abstract memory summary.

Session/history search should ideally require **no additional LLM call** for basic retrieval.

## Layer E — Project memory

Each Project gets its own durable knowledge.

Project memory must remain distinct from personal/account memory.

Shared projects must not leak one person's private memory to another member.

## Layer F — Orbit agent memory

Each Orbit agent can have:

- facts learned;
- task history;
- goals;
- procedures;
- relationship/context;
- unresolved work;
- environment knowledge.

Do not allow every agent to automatically inherit every private memory.

## Layer G — Procedural memory

Repeated successful methods should become candidate Skills.

Memory = what is known.

Skill = how to do something.

Keep them distinct.

---

# 9. MEMORY QUALITY FEATURES

Every durable memory should support appropriate metadata:

```text
id
scope
subject/entity
fact
source
source conversation/message
createdAt
lastConfirmedAt
lastUsedAt
confidence
temporal status
supersedes
sensitivity
provenance
```

Handle contradictions.

Example:

Old:
> User studies at university X.

New:
> User graduated.

Do not keep both as equally current facts forever.

Support:

- temporal validity;
- supersession;
- confidence;
- explicit correction;
- consolidation;
- deduplication;
- forgetting;
- recency decay where appropriate.

Create a consolidation/"dreaming" process that can:

- merge duplicate memories;
- detect conflicting facts;
- update summaries;
- decay irrelevant facts;
- keep provenance;
- never invent unsupported information.

Make it asynchronous and bounded.

---

# 10. MEMORY TRANSPARENCY UX

The user should be able to inspect:

**What Alevr knows about me**

For each important item show:

- fact;
- source;
- when learned;
- scope;
- confidence when useful;
- last use;
- edit;
- forget;
- move to project;
- make account-wide.

Allow:

- pause memory;
- private/incognito conversations;
- clear project memory;
- export memory;
- import memory;
- search memory;
- activity history.

Build a proper benchmark/evaluation suite.

Evaluate:

- recall;
- precision;
- false memory creation;
- correction;
- contradiction resolution;
- scope leakage;
- sensitive-information filtering;
- retrieval latency;
- token overhead.

Do not claim the memory is better than competitors until the evaluation supports it.

---

# 11. P1 — COMPLETELY REWORK DEEP RESEARCH

The current Deep Research experience is considered bad/unreliable.

Do not polish its existing UI and declare success.

First reproduce its failures.

Audit:

- planning;
- search;
- source discovery;
- crawler;
- parallel workers;
- cancellation;
- pause/resume;
- source deduplication;
- budgets;
- timeouts;
- report generation;
- citation verification;
- stale-state recovery;
- persistence;
- native behavior;
- UI;
- failures after reload;
- cost.

Create test research prompts and run the entire system.

Document exactly where it fails.

Then rebuild/rework the pipeline.

---

# 12. DEEP RESEARCH TARGET ARCHITECTURE

Aim for:

```text
Question
   ↓
Clarify only when necessary
   ↓
Research Plan
   ↓
Research Questions / Hypotheses
   ↓
Parallel Search & Investigation
   ↓
Evidence Store
   ↓
Coverage / Contradiction Review
   ↓
Targeted Follow-up Research
   ↓
Claim Graph
   ↓
Citation Verification
   ↓
Synthesis
   ↓
Final report + evidence
```

Each researcher should have a clear responsibility.

Examples:

- primary sources;
- pricing;
- technical documentation;
- counter-evidence;
- recent developments;
- academic literature;
- community sentiment.

Do not create dozens of workers for marketing.

Use adaptive parallelism.

Simple tasks: 1–2 workers.

Complex tasks: potentially more.

Choose parallelism based on:

- decomposition quality;
- uncertainty;
- breadth;
- budget;
- available time.

---

# 13. DEEP RESEARCH MUST BE EVIDENCE-FIRST

Create a proper evidence model.

For every important claim know:

- which sources support it;
- which sources contradict it;
- source quality;
- publication date;
- retrieval date;
- direct evidence passage;
- confidence;
- primary vs secondary source.

The final writer should synthesize from the evidence store.

It should not freely hallucinate facts because the research workers "probably saw them."

Run a final citation verifier.

Check that:

- source exists;
- page was actually read;
- source supports the claim;
- citation points to correct source;
- important claims have citations;
- weak evidence is labeled;
- conflicting evidence is surfaced.

---

# 14. DEEP RESEARCH UX

Keep Research inside the conversation.

Do not create another major product destination.

Show an understandable research card.

Example:

```text
Researching OLED monitors

✓ Planned 5 questions
✓ Compared current models
● Reading manufacturer specifications
● Checking long-term burn-in reports
○ Verifying prices
○ Writing report

32 sources found
17 read
€0.12 used
4 researchers active
```

Allow:

- Guide;
- Pause;
- Resume;
- Stop;
- adjust scope;
- answer clarifying question;
- open sources;
- inspect evidence;
- see researchers;
- change direction while running.

The final report should become a first-class Library artifact.

---

# 15. P1 — BUILD ALEVR SEARCH

Build a provider-neutral **Alevr Search** system usable by every supported model.

Today web search must not depend on whether a model provider happens to include native search.

Every capable model should receive the same Alevr search tools.

Example:

```text
search_web
open_page
find_in_page
search_news
search_images
search_documents
```

Potentially specialized search later:

```text
search_code
search_academic
search_products
search_places
```

---

# 16. ALEVR SEARCH: COST OBJECTIVE

I want a very low marginal-cost search stack.

Research whether Alevr can operate a high-quality search layer with little or no paid search-API cost.

BUT:

Do not pretend "free" means zero infrastructure cost.

Do not rely on fragile or abusive scraping.

Do not violate providers' terms.

Do not make production depend on random public SearXNG instances.

Evaluate a hybrid architecture such as:

### Discovery

- self-hosted SearXNG where useful;
- reputable open/public data sources with permitted access;
- domain-specific search;
- optional provider-native search;
- optional paid backend only when needed.

### Alevr-owned retrieval

Once URLs are discovered:

- fetch safely;
- normalize;
- deduplicate;
- extract;
- cache;
- index;
- rank;
- cite.

### Local/owned web cache

Maintain an Alevr page cache/index for recently requested content.

Use:

- normalized canonical URLs;
- freshness;
- ETag/Last-Modified;
- content hashes;
- text extraction;
- optional embeddings;
- BM25/FTS;
- domain trust signals.

Over time commonly requested information should increasingly come from Alevr's own cache rather than paying again for discovery.

### Search quality ranking

Do more than return ten links.

Rank with:

- lexical relevance;
- semantic relevance;
- authority;
- freshness;
- source type;
- diversity;
- query intent;
- duplication;
- language;
- region where relevant.

---

# 17. SEARCH SECURITY

All web retrieval must have robust protections.

Protect against:

- SSRF;
- private IPs;
- metadata endpoints;
- DNS rebinding;
- dangerous redirects;
- oversized responses;
- decompression bombs;
- infinite redirects;
- malicious MIME;
- prompt injection;
- hidden instructions.

Web content is untrusted data.

The model must be explicitly told that web pages may contain hostile instructions.

A webpage must never be able to:

- alter permissions;
- install something;
- trigger an agent;
- start a Routine;
- grant access;
- exfiltrate memory;
- override the system prompt.

---

# 18. P1 — REWORK ORBIT AROUND THE BEST IDEAS FROM HERMES AGENT

Before implementing, perform current research on **Hermes Agent by Nous Research**.

Inspect its current documentation and public repository.

Study what users like about it.

Pay particular attention to:

- persistent goal following;
- long-running autonomy;
- durable task state;
- session history search;
- bounded persistent memory;
- Skills/progressive disclosure;
- browser automation;
- Computer Use;
- delegation/subagents;
- recovery after interruption;
- toolsets;
- recurring work;
- agent self-improvement;
- multi-platform access.

Do not clone Hermes literally.

Extract the product principles that make it useful.

Orbit should be easier to understand and more polished for ordinary users.

---

# 19. ORBIT: AGENT MODEL

Each persistent agent should have:

```text
Identity
Role
Description/personality
Goals
Responsibilities
Memory
Session history
Skills
Apps
Files/projects
Routines
Permission policy
Budget
Model policy
Computer
Browser state
Notifications
Activity
Current work
Task queue
```

Example:

```text
Scout
Research analyst

Responsibilities
• Track AI model releases
• Compare benchmarks
• Prepare weekly briefing

Memory
• Knows the user's preferred benchmark sources
• Knows previous conclusions

Routines
• Monday 08:00 — weekly AI report

Apps
• GitHub
• Google Drive

Permissions
• Web: automatic
• Drive reads: automatic
• Drive writes: ask
• External messages: always ask
```

---

# 20. ORBIT SHOULD HAVE DURABLE GOALS

Agents need more than instructions.

Implement durable goals with:

- objective;
- status;
- milestones;
- success criteria;
- blockers;
- progress;
- next action;
- associated tasks;
- budget;
- due date if applicable.

An agent should be able to continue a long-term responsibility across many sessions without repeatedly being reminded.

Avoid infinite autonomous loops.

Every goal must have bounded execution and observable progress.

---

# 21. ORBIT TASK BOARD / DURABLE WORK

Borrow the useful principle behind durable agent task systems such as Hermes' long-running task/delegation behavior.

Build a durable work ledger.

Tasks should have:

```text
pending
claimed
running
waiting_for_user
waiting_for_dependency
blocked
completed
failed
cancelled
```

Support:

- heartbeats;
- leases;
- worker recovery;
- retries;
- dependency tracking;
- crash recovery;
- stale-task reclamation;
- budgets;
- deadlines;
- completion criteria.

If an Alevr process restarts, an Orbit agent should not simply forget what it was doing.

---

# 22. P1 — FINISH ORBIT ROOMS

The current repository already contains substantial group-agent backend work.

Finish it instead of inventing a different system.

Rooms should allow approximately 2–6 named Orbit agents to collaborate.

Support:

- `@Agent`;
- `@all`;
- intelligent routing;
- visible speakers;
- explicit delegation;
- turn caps;
- loop prevention;
- activity;
- role specialization;
- clear handoffs.

Example:

```text
Launch Review

Mira — Product
Scout — Research
Quill — Engineering
Nova — Design
```

The user can simply say:

> Review Alevr onboarding before launch.

Agents should divide work intelligently.

Do not make everyone respond to everything.

---

# 23. P1 — GENERAL TEAM ORCHESTRATION

The repository already includes an AgentSwarmCoordinator/DAG concept.

Turn the useful parts into a real product capability.

For a complicated request Alevr should be able to create a temporary specialist team.

Example:

```text
Lead
 ├── Researcher
 ├── Engineer
 ├── UX reviewer
 └── Critic
       ↓
    Lead synthesis
```

Support:

- role specialization;
- dependencies;
- parallel tasks;
- per-task tools;
- per-task budget;
- retries;
- failure containment;
- final synthesis.

Do NOT expose "300 agents" just to compete with Kimi marketing.

Optimize for useful work.

Four excellent agents with clearly separated responsibilities may outperform fifty poorly coordinated workers.

---

# 24. P1 — TEACH ALEVR

Build a first-class **Teach Alevr** feature.

This should become one of Alevr's differentiators.

Flow:

1. User selects **Teach Alevr**.
2. Recording begins.
3. User performs a browser/computer workflow.
4. Alevr observes high-level actions.
5. Sensitive fields are identified.
6. Alevr identifies constants vs variables.
7. Alevr generates a proposed reusable Skill.
8. User reviews steps.
9. User can rename variables.
10. User can mark fields as secrets.
11. Alevr performs a dry run.
12. User saves it.
13. Skill can optionally become a Routine.
14. Skill can be assigned to an Orbit agent.

Example:

User manually creates the weekly report once.

Alevr generates:

```text
Skill: Prepare weekly engineering report

Inputs
• Week
• Project

Steps
1. Open Linear
2. Query completed issues
3. Open GitHub
4. Collect merged PRs
5. Build summary
6. Create report in Drive
```

Then:

> “Scout, run my weekly engineering report.”

This should work.

---

# 25. P1 — AUTO ROUTER 2.0

Alevr's multi-provider architecture should become a major competitive advantage.

Do not simply select:

> cheapest model above an intelligence score.

Build a task-success router.

Routing dimensions should eventually include:

- task type;
- complexity;
- modality;
- reasoning requirement;
- coding quality;
- research quality;
- long-context reliability;
- tool calling reliability;
- structured output reliability;
- latency;
- provider availability;
- rate limits;
- actual Alevr completion history;
- average tool rounds;
- retries;
- failure rate;
- token use;
- monetary cost;
- privacy/data training policy;
- user preference.

For example, cost should approximate:

```text
expected_total_cost =
model_call_cost
+ expected_tool_rounds
+ expected_retry_cost
+ failure_probability * recovery_cost
```

not merely API price per token.

---

# 26. AUTO ROUTER FEEDBACK LOOP

Collect privacy-conscious routing telemetry.

Example:

```text
task_class
selected_model
reasoning_effort
latency
tool_rounds
retry_count
completion_state
user_regenerated
user_switched_model
user_edited_result
cost
```

Use aggregate evidence to improve routing.

Do not train on private message content without an explicit policy.

The router should become empirically better over time.

---

# 27. AUTO UX

Keep Auto as the default for ordinary users.

Show a subtle receipt:

```text
Auto · Claude Opus 5.5 · High
```

On click:

```text
Selected for:
• repository-scale coding
• complex reasoning
• reliable tool use
```

Do not clutter the conversation with routing details.

Advanced users can still select exact models.

---

# 28. P1 — MAKE WORK AN INTERNAL RUNTIME

Do not maintain a major user decision:

> Chat or Work?

Alevr should identify long-running requests.

Example:

> “Research the market, compare 40 competitors, build a spreadsheet and create a deck.”

Alevr should automatically offer/start the appropriate background workflow.

Chat remains the conversation.

The Work runtime handles:

- background execution;
- retries;
- browser;
- files;
- apps;
- long-running jobs;
- deliverables;
- notifications;
- schedules.

Keep the runtime.

Reduce the conceptual burden.

---

# 29. P1 — REBUILD DOCUMENTS, SPREADSHEETS AND SLIDES

Do not treat professional deliverables primarily as Markdown that happens to export to Office formats.

Create semantic artifact models.

## Document

Support:

- paragraphs;
- headings;
- lists;
- tables;
- callouts;
- citations;
- figures;
- page breaks;
- styles;
- comments;
- tracked revisions;
- metadata.

## Spreadsheet

Support actual:

- sheets;
- typed cells;
- formulas;
- references;
- formatting;
- tables;
- charts;
- filters;
- sorting;
- frozen rows/columns;
- import/export;
- recalculation.

The AI should be able to manipulate the workbook semantically.

Example:

> Increase conversion assumption to 7.5% and update the charts.

Alevr should update the cell and dependent formulas/charts.

It should not regenerate an unrelated Markdown table.

## Presentation

Support:

- slide masters;
- layouts;
- editable text;
- images;
- shapes;
- charts;
- tables;
- speaker notes;
- themes;
- transitions where appropriate.

The result must remain editable.

---

# 30. ARTIFACTS

Keep and improve the existing artifact strengths:

- versions;
- proposals;
- undo/history;
- duplicate;
- restore;
- Library;
- publication;
- previews;
- exports.

A conversation should be capable of editing an existing artifact incrementally.

Do not regenerate the whole output unless necessary.

---

# 31. P1 — COMPUTER USE

Computer Use is powerful and high risk.

Do a fresh security and reliability audit of all current implementations.

Do not assume an older audit remains true.

Verify current source.

Requirements:

- robust sandboxing;
- controlled network;
- explicit scopes;
- credential isolation;
- takeover that truly pauses agent observation/action;
- secure hand-back;
- screenshots protected from secret capture when appropriate;
- deterministic sensitive-action classification;
- domain/site permissions;
- shell restrictions;
- bounded resource use;
- session isolation;
- reliable cleanup;
- audit log.

Computer Use should be available to Orbit and Alevr Code through shared trusted primitives where appropriate.

Do not create three incompatible implementations.

---

# 32. BACKGROUND-FIRST COMPUTER CONTROL ON MAC

Research current high-quality background Computer Use systems, including Hermes Agent.

Where platform APIs safely permit it, prefer:

- accessibility tree;
- application-scoped interaction;
- background automation;
- no cursor stealing;
- no focus stealing;
- semantic element targets.

Fall back to visual coordinate interaction when necessary.

On macOS handle:

- keyboard layout correctly;
- AX APIs;
- Screen Recording permissions;
- Accessibility permissions;
- multiple displays;
- Retina scaling;
- Spaces;
- app/window identity;
- screenshots;
- coordinate transforms.

Alevr must work properly on non-US keyboard layouts.

---

# 33. P1 — SKILLS

Preserve Alevr's strong security architecture.

Skills should remain:

- versioned;
- provenance-aware;
- scanned;
- permission-scoped;
- progressively disclosed;
- importable;
- reusable.

Do not inject every Skill's full instructions into every request.

Use:

Level 1:
name + description.

Level 2:
load full Skill when selected.

Level 3:
load referenced files/scripts only when needed and permitted.

---

# 34. SKILL AUTO-SELECTION

Allow trusted Skills to become automatically discoverable.

Use high-confidence semantic/tool matching.

Do not silently trigger risky imported instructions.

Possible behavior:

> Alevr found a matching Skill: “Review pull request”. Use it?

For user-authored/verified Skills users may opt into automatic use.

Always expose which Skill ran.

---

# 35. P2 — ALEVR EXTENSIONS

Eventually create a coherent extension ecosystem.

An Extension could package:

- Skills;
- MCP/app tools;
- agent template;
- Routine templates;
- UI resources;
- artifact templates.

Implement:

- provenance;
- publisher identity;
- versions;
- signatures if appropriate;
- requested permissions;
- scanner results;
- changelog;
- install/update/remove;
- permission diffs on update.

Do not build a public marketplace before the security model is trustworthy.

---

# 36. P1/P2 — ROUTINES

Unify Scheduled Tasks / Automations / Work schedules under one understandable product concept:

**Routine**.

A Routine has:

```text
When
Do
Using
Who
Notify
```

Example:

```text
Weekly AI briefing

When
Monday at 08:00

Do
Research major AI releases from the previous week

Who
Scout

Using
Web + saved benchmark sources

Notify
When completed
```

Support triggers such as:

- schedule;
- email condition;
- calendar event/window;
- folder change;
- connector event;
- topic/watch condition;
- manual run.

Keep proper:

- timezone handling;
- DST;
- missed-run policy;
- budget;
- history;
- pause;
- retry;
- failure notification.

---

# 37. P2 — PROJECT INTELLIGENCE

Projects should become living knowledge spaces rather than folders.

A Project should unify:

- conversations;
- files;
- project memory;
- artifacts;
- relevant Skills;
- connected apps;
- active Orbit agents;
- routines;
- Code sessions;
- research reports.

When entering a Project, Alevr should already understand its current state.

Add an optional project overview generated from actual state:

```text
Project: Alevr Launch

Current
• 3 unresolved engineering issues
• New competitor research from yesterday
• Scout waiting for approval
• Launch deck modified 2 hours ago

Recent decisions
...
```

Avoid unnecessary LLM calls by caching/projecting state deterministically when possible.

---

# 38. P2 — VOICE AS AN OPERATING INTERFACE

Voice should operate Alevr, not just replace typing.

Examples:

> “What is Scout working on?”

> “Stop the research run.”

> “Approve the GitHub PR but don't merge it.”

> “Create a routine from that.”

> “Summarize today's project changes.”

> “Tell Mira to review the design.”

> “Open the spreadsheet Scout made.”

Voice commands must use the same permission engine as typed requests.

---

# 39. P2 — EXTERNAL CHANNELS

Research and design communication with Orbit agents outside the Alevr app.

Potential channels:

- iMessage;
- WhatsApp;
- Slack;
- email;
- Telegram if useful.

Start conservatively.

Phase 1:

- notifications;
- task results;
- approval links;
- user replies.

Phase 2:

- normal conversations.

Phase 3:

- carefully scoped external actions.

A text message must never bypass sensitive approvals.

Unknown senders must not reach an agent.

Use replay protection and strict identity verification.

---

# 40. P2 — TEAM / ORGANIZATION ORBIT

Design shared agents for teams.

Support:

- organization ownership;
- shared knowledge;
- personal vs organization memory;
- role-based permissions;
- team apps;
- shared routines;
- audit trail;
- human owner;
- agent visibility;
- budget;
- data boundaries.

Never leak one team member's personal memory into organization context.

---

# 41. MACOS APPLICATION

Audit the current Swift macOS app and Electron implementation.

Do NOT continue indefinitely with two full desktop products without a strategy.

Determine and document:

- canonical long-term desktop architecture;
- what Swift does better;
- what Electron does better;
- which implementation has stronger parity;
- security;
- maintenance cost;
- feature velocity;
- performance;
- native integration requirements.

Do not delete either blindly.

Propose and then execute a controlled strategy.

---

# 42. MACOS REQUIREMENTS

Whichever implementation remains canonical must provide first-class support for:

## Chat

- streaming;
- search;
- attachments;
- memory;
- Projects;
- research;
- artifacts;
- Voice;
- model picker;
- Auto;
- apps;
- Skills.

## Orbit

- roster;
- rooms;
- agent conversation;
- current work;
- approvals;
- Routines;
- computer view;
- takeover;
- activity;
- notifications.

## Code

- repository workspace;
- plans;
- tasks;
- terminal;
- diffs;
- files;
- checks;
- PR;
- rollback;
- subagents;
- Computer Use.

## Native integrations

- menu bar;
- global quick entry;
- notifications;
- file system;
- Keychain;
- share/open-with where useful;
- drag/drop;
- keyboard shortcuts;
- Spotlight/App Intents when genuinely useful;
- proper window restoration.

---

# 43. IOS / IPADOS

Bring important functionality to iPhone/iPad without pretending the phone needs the full desktop UI.

The mobile app should excel at:

- Chat;
- Voice;
- sharing content into Alevr;
- Projects;
- Memory controls;
- research monitoring;
- Orbit;
- approving/refusing actions;
- answering agent questions;
- notifications;
- viewing deliverables;
- lightweight artifact editing;
- Computer Use viewing/takeover when safe;
- steering Code/Work runs;
- switching models.

Do not squeeze a desktop IDE onto an iPhone.

Code on mobile should focus on:

- monitoring;
- steering;
- diffs;
- approvals;
- PRs;
- quick edits;
- task initiation.

---

# 44. CROSS-PLATFORM CONTRACT

Web, macOS and iOS should consume shared capability contracts.

Avoid reimplementing product rules three times.

Centralize:

- capability definitions;
- permission semantics;
- model catalog;
- agent states;
- task states;
- artifact contracts;
- memory schemas;
- Work/Routine events;
- approval outcomes.

Generate native projections where practical.

A backend behavior change should fail contract/parity tests if a client has not been accounted for.

---

# 45. DESIGN / UI / UX

Do not produce generic AI SaaS visual design.

Do not redesign everything merely because this is a large project.

Preserve Alevr's strongest existing visual identity.

Improve:

- hierarchy;
- spacing;
- typography;
- information density;
- motion;
- responsiveness;
- contextual panels;
- empty states;
- activity visualization;
- transitions.

Remove unnecessary:

- cards around everything;
- gradients;
- giant glowing AI elements;
- status pills;
- decorative dashboards;
- fake progress;
- ornamental agent graphs.

Motion should communicate state.

Examples:

- source appears when discovered;
- task moves when ownership changes;
- approval enters because attention is required;
- artifact smoothly updates to new version.

Respect Reduced Motion.

---

# 46. ACTIVITY SHOULD READ LIKE WORK, NOT DEBUG LOGS

Instead of:

```text
tool_call completed
worker_4 finished
mcp_call started
```

show:

```text
Scout searched 12 sources

Mira verified Apple's specifications

Quill inspected the repository

Scout asked Mira to verify pricing

Waiting for your approval to update GitHub

Report ready
```

Technical detail can remain available behind disclosure.

---

# 47. OBSERVABILITY

Every long-running system needs proper observability.

Track:

- run id;
- user/account;
- agent;
- model;
- provider;
- tool calls;
- latency;
- retry;
- errors;
- spend;
- budget;
- approvals;
- cancellation;
- worker state;
- search backend;
- citations;
- deliverables.

Sensitive data must be redacted.

Add tracing where valuable.

Build internal diagnostics.

---

# 48. RELIABILITY

Long-running work must survive:

- process restart;
- network failure;
- provider timeout;
- temporary rate limit;
- browser crash;
- stale worker;
- lost SSE;
- client disconnect;
- page refresh.

Persist enough state to resume safely.

Use:

- leases;
- heartbeats;
- idempotency;
- bounded retries;
- exponential backoff;
- durable event logs.

Do not retry external writes blindly.

---

# 49. COST CONTROL

Alevr supports many providers and potentially many agents.

Cost must become part of runtime architecture.

Every long-running action needs:

- estimated budget;
- hard ceiling;
- current spend;
- per-worker accounting;
- model/token usage;
- search cost;
- compute cost where measurable.

Auto should optimize total expected completion cost, not only API token price.

Users should be able to set:

- account budget;
- agent budget;
- routine budget;
- run budget.

---

# 50. DO NOT PRIORITIZE THESE YET

Do NOT prioritize agent purchases/payment cards before:

- credential broker;
- permission unification;
- Computer Use security acceptance;
- audit trail;
- deterministic sensitive-action gates.

Do NOT prioritize enormous 100–300-agent swarms.

Do NOT add another model provider solely for provider count.

Do NOT add another primary sidebar destination without proving it deserves one.

Do NOT create another desktop implementation.

---

# 51. BUSINESS / PLATFORM RISKS

Do not attempt to "solve" legal questions with code.

However, leave clearly documented owner-action blockers for:

- model provider resale/commercial terms;
- Alevr trademark/name clearance;
- AI/data-processing disclosures;
- data residency;
- provider-specific retention/training policies;
- app-store requirements.

Alevr's Auto router must respect providers that have different privacy/training characteristics.

Never silently route a private request to an endpoint with materially different data-use terms just because it is cheap.

---

# 52. TESTING STRATEGY

For every major feature include:

## Unit tests

Domain rules.

## Integration tests

Real persistence / APIs / state transitions.

## Contract tests

Web/native parity.

## Security tests

Ownership, permissions, SSRF, replay, credential isolation.

## End-to-end tests

Actual user workflow.

Examples that must eventually be covered:

### Memory

Conversation → memory learned → new conversation retrieves it → correction supersedes it → forget removes it.

### Research

Prompt → plan → multiple sources → evidence → citations → report → reload still works.

### Orbit

Create agent → assign goal → task runs → asks approval → resumes → final artifact.

### Rooms

Multiple agents → delegation → no duplicate responder → no loop → synthesis.

### Teach Alevr

Record workflow → generate Skill → dry-run → save → execute later.

### Routine

Event/schedule → Orbit agent executes → action policy respected → result notification.

### Computer Use

Start → watch → takeover → agent fully stops → secret input → hand back → agent resumes without reading private takeover data.

### Auto

Known benchmark tasks → appropriate tier/provider selected → fallback behaves correctly.

---

# 53. BUILD EVALUATION HARNESSES

Do not rely exclusively on unit tests.

Create a repeatable Alevr evaluation suite.

Categories:

- everyday chat;
- reasoning;
- coding;
- tool use;
- search;
- Deep Research;
- memory;
- long context;
- agent persistence;
- browser tasks;
- Computer Use;
- artifacts;
- documents;
- spreadsheets;
- slides;
- multilingual behavior;
- instruction following.

Record:

- success;
- latency;
- cost;
- tool count;
- model;
- errors;
- citation quality.

This becomes the evidence behind Auto Router decisions and product-quality claims.

---

# 54. IMPLEMENTATION PRIORITY

Execute in this order unless repository evidence justifies a different dependency order.

## P0 — FOUNDATION / DO FIRST

1. Build current capability registry.
2. Audit current source vs stale docs.
3. Benchmark application performance.
4. Fix navigation/page-transition bottlenecks.
5. Virtualize Chat transcript.
6. Refactor highest-risk giant orchestration files incrementally.
7. Unify permission/action taxonomy.
8. Review current Computer Use security boundaries.
9. Establish cross-platform contracts/parity gates.
10. Make current release/test gates truthful and deterministic.

P0 should make Alevr easier and safer to develop.

---

# 55. P1 — CORE DIFFERENTIATORS

After the P0 foundation:

1. Rebuild Memory architecture and evaluation.
2. Build fast session/conversation recall.
3. Rebuild Deep Research.
4. Build Alevr Search and route every compatible model through it.
5. Upgrade Auto Router to task-success-based routing.
6. Finish Orbit Rooms.
7. Productize multi-agent team orchestration.
8. Add durable Orbit goals/task board.
9. Build credential broker.
10. Finish/security-accept Computer Use.
11. Build Teach Alevr.
12. Make Work mostly an internal execution runtime.
13. Upgrade document artifacts.
14. Upgrade spreadsheets.
15. Upgrade presentations.
16. Complete high-value macOS functionality.
17. Complete high-value iOS/iPadOS functionality.

P1 should make Alevr meaningfully different from ordinary chatbots.

---

# 56. P2 — ECOSYSTEM / EXPANSION

After the above is reliable:

1. Alevr Extensions ecosystem.
2. Trusted automatic Skill selection.
3. Teach → Skill → Routine seamless flow.
4. Advanced memory provenance UX.
5. Intelligent Project overview.
6. External channels: iMessage / WhatsApp / Slack / email.
7. Team/shared Orbit agents.
8. Voice operating the whole product.
9. Enterprise provider/data-region controls.
10. Additional collaboration features.
11. More specialized Alevr Search verticals.

---

# 57. COMPETITIVE BENCHMARK

Before each major subsystem rework, research the current implementation of relevant competitors.

At minimum consider where relevant:

- ChatGPT / ChatGPT Work / Codex;
- Claude / Cowork / Claude Code;
- Gemini;
- Kimi / Kimi Work / Agent Swarm;
- Grok / Grok Bot;
- Hermes Agent;
- Perplexity / Computer;
- Cursor;
- other genuinely relevant products discovered during research.

Use current primary documentation whenever possible.

For each feature create a concise comparison:

```text
Competitor behavior
What users like
Weakness
Current Alevr behavior
Alevr opportunity
Chosen design
```

Do not copy for parity.

Beat the weakness.

---

# 58. ALEVR PRINCIPLES

All implementation decisions should follow these principles.

## One interface, many capabilities

Users speak naturally.

Alevr selects capabilities.

## Provider-neutral intelligence

The provider is replaceable.

The Alevr runtime is the product.

## Persistent where useful

Memory, agents, tasks and projects survive sessions.

## Explicit around power

Dangerous actions have deterministic permission boundaries.

## Outputs are real objects

Documents, spreadsheets, slides, code and sites should be editable semantic artifacts.

## Evidence over claims

Search and Research must expose sources.

## No fake functionality

No button should imply a capability that is actually a placeholder.

## No silent failure

Long-running operations expose failure/retry state.

## No UI for architecture's sake

A backend subsystem does not automatically deserve a sidebar tab.

## Performance is a feature

Alevr must remain responsive despite its complexity.

---

# 59. CODE QUALITY RULES

Do not:

- create giant replacement files;
- duplicate existing infrastructure;
- leave obsolete implementations next to new ones indefinitely;
- add fake mocks to production;
- suppress tests to make CI green;
- weaken security for convenience;
- silently catch important errors;
- use the LLM for deterministic work that code can do;
- add unnecessary dependencies;
- make API calls sequentially when they can safely run concurrently;
- create a second permission model;
- create a second memory model;
- create another task scheduler.

Prefer:

- pure domain modules;
- narrow interfaces;
- shared contracts;
- explicit state machines;
- schema validation;
- idempotency;
- testable business rules;
- provenance;
- metrics.

---

# 60. HOW TO WORK

Do not attempt to rewrite the entire repository in one enormous uncontrolled patch.

Work in vertical milestones.

For each milestone:

### Step 1 — Inspect

Read relevant implementation, docs, schemas and tests.

### Step 2 — Verify

Run existing tests and reproduce real behavior.

### Step 3 — Benchmark

Research relevant competitor behavior if necessary.

### Step 4 — Design

Write a short implementation decision before coding.

### Step 5 — Implement

Prefer migration over duplication.

### Step 6 — Test

Unit + integration + E2E where appropriate.

### Step 7 — Verify manually

Exercise the real workflow.

### Step 8 — Clean

Remove dead/obsolete implementation where safe.

### Step 9 — Document

Update the capability registry and canonical docs.

### Step 10 — Report

Give me:

```text
Implemented
Changed
Removed
Tests
Benchmarks
Security considerations
Remaining blockers
Next milestone
```

---

# 61. IMPORTANT: DO THE WORK

Do not stop after producing another audit.

The repository already contains many audits.

Use them as evidence.

The desired cycle is:

```text
inspect
→ reproduce
→ decide
→ implement
→ test
→ run
→ inspect result
→ fix
→ verify
```

If something is blocked by credentials, legal approval, Apple signing, production infrastructure or another genuinely external dependency:

1. complete every local part that can be completed;
2. create a clear blocker entry;
3. continue to the next locally achievable task.

Do not mark something complete because it compiles.

Use this maturity distinction:

```text
Implemented ≠ Verified
Verified ≠ Enabled
Enabled ≠ Production Accepted
```

---

# 62. FINAL TARGET

When this program is complete, Alevr should feel dramatically simpler despite being much more capable.

A new user should understand:

**Chat**  
Talk to Alevr.

**Orbit**  
Your persistent AI collaborators.

**Code**  
Build software.

Everything else should appear naturally when needed.

The defining Alevr advantages should become:

### 1. Best available intelligence instead of allegiance to one model lab

Auto selects intelligently across providers.

### 2. Exceptional memory

Alevr remembers durable facts, can search actual history, understands projects, resolves contradictions and remains transparent.

### 3. Persistent Orbit agents

Agents remember, learn, continue work, collaborate, use tools, run routines and recover after interruption.

### 4. Alevr Search + Deep Research

Every model can search through one high-quality provider-neutral system, and Deep Research produces evidence-backed work rather than superficial summaries.

### 5. Teach Alevr

A user can demonstrate work once and turn it into reusable capability.

### 6. Serious deliverables

Documents, spreadsheets, decks, sites and code are real editable objects.

### 7. Secure action

Alevr can actually do things while credentials and permissions remain outside model control.

### 8. First-class web, macOS and iOS experiences

One product architecture expressed appropriately on each platform.

Do not optimize Alevr to have the longest feature list.

Optimize it so that all these systems behave like **one coherent intelligence**.

That is the standard for every decision in this rework.