# External audit: how ChatGPT and the OpenAI API do tools, thinking and research

Status: research input for the Juno tools, thinking, right-sidebar and Research rework (branch `web/tools-thinking-research`).
Written 2026-09-23. Scope: ChatGPT (consumer, Work, desktop) plus the OpenAI developer platform (Responses API, Agents API/SDK, ChatKit, Plugins/Apps SDK). Claude, Gemini and Perplexity are covered in other reports.

---

## 0. Method, source access and confidence

**Sources used.**

- **Official developer docs (primary, fetched in full).** `developers.openai.com` serves a Markdown copy of every page when you add `.md` to the URL. I fetched these copies for about 45 guides: function calling, tool search, programmatic and async tool calling, steering, web search, MCP, shell, apply_patch, skills, computer use, reasoning, background, WebSocket, compaction, citation formatting, deep research, ChatKit, and the plugin/Apps SDK reference and guidelines.
- **Official ChatGPT product docs (primary, fetched).** `learn.chatgpt.com` hosts the 2026 ChatGPT, ChatGPT Work and Codex docs, including a dated weekly "What's new" digest.
- **Help center and blog (not fetched).** `help.openai.com` and `openai.com` returned **HTTP 403** to every automated fetch. Their content appears here only through search-engine snippets or press coverage, and every such claim is marked.
- **Press and reviews** (MacRumors, 9to5Mac, TechRadar, AppleInsider, Bloomberg/TNW, Simon Willison and others). Each is cited with its date.
- **Community-extracted system prompts** (`github.com/asgeirtj/system_prompts_leaks`, OpenAI folder). These are *unverified*. I use them only to describe tool **architecture** (tool names, namespaces, channels). They are never the only evidence for a user-facing claim, and I paraphrase rather than copy.

**Confidence tags used throughout:**

- **[V]** Verified in official OpenAI docs I fetched on 2026-09-23.
- **[P]** Reported by reputable press or reviews. The date is the article date.
- **[C]** Community-extracted system prompt. Unverified; could be stale or a decoy.
- **[I]** My inference or observation. Not stated by a source.

---

## 1. Executive summary (the 15 things that matter for Juno)

1. **By Sept 2026 ChatGPT is an agent host with three surfaces: Chat, Work and Codex.** Work launched 2026-07-09 and replaced "agent mode", which was removed in early Aug 2026. OpenAI's president called the tabbed UI "a mess" and committed to removing the Work tab by year-end so the agent "molds into ChatGPT" (TechBriefly, 2026-07-30) [P]. The direction is **no mode picker**: the model escalates on its own. The extracted Chat prompt has a `local.handoff` tool that the model calls to move a request to Work when that request needs browsing, files, code or long execution [C].
2. **Named thinking levels were dropped.** On 2026-08-06 ChatGPT merged Instant and Thinking into one experience with a **reasoning slider** for Plus/Pro and a single **Think** button for Free/Go (9to5Mac, AppleInsider, 2026-08-06) [P]. In Work and Codex the control is a **Power** slider from *Faster* to *Smarter* with six presets and an **Advanced** disclosure for the explicit model, effort and speed ([learn.chatgpt.com/docs/models](https://learn.chatgpt.com/docs/models)) [V]. This is the precedent for the user's request to remove "Deep / Max" style names.
3. **Deep research has no user-facing depth tiers.** The flow is clarify, then an editable plan, then a live run you can steer. Since the Feb 2026 relaunch you can also pick sources (web, files, apps/MCP, specific sites), follow progress in real time, **Update mid-run**, read the report in a **fullscreen viewer** (table of contents on the left, citations on the right) and export it to MD, DOCX or PDF (MacRumors 2026-02-11) [P]. The original o3 version was retired on 2026-03-26 (findskill.ai 2026-03-25) [P]. In 2026 it is reached from **Work → + → Deep research** ([web-search doc](https://learn.chatgpt.com/docs/web-search)) [V].
4. **Thinking UI anatomy has been stable since late 2024.** While the model thinks, a shimmering "Thinking" line shows. When it finishes, a collapsed **"Thought for Ns"** row remains. Clicking it opens a **right-hand side panel** with the reasoning summary and the sources. The panel has shipped since 2024-11-26 (Tibor Blaho) [P]. The panel gained an **"Update"** control on 2025-11-05 for steering long runs ([OpenAI on X](https://x.com/OpenAI/status/1986194298971590988)) [P]. **"Answer now"** stops thinking and answers immediately [P]. GPT-5.4 Thinking (2026-03) shows an **upfront plan** you can interrupt (ETIH 2026-03-09) [P].
5. **OpenAI's own data model for this UI is public in ChatKit.** A turn can contain a `Workflow` of type `reasoning` or `custom`. The workflow holds ordered `tasks` of type thought, web_search (queries plus sources), file, image or custom. Each task has a `status_indicator` of none, loading or complete. The workflow has a summary that is either a *duration* ("Thought for N s") or a custom title plus icon, and an `expanded` flag. There is also a transient `ProgressUpdateEvent` and a `StructuredInput` item (multiple-choice or free-form questions). See [chatkit-python `types.py`](https://github.com/openai/chatkit-python/blob/main/chatkit/types.py) [V]. **Juno should adopt this shape almost verbatim.**
6. **Tool calls carry human copy, not tool names.** Plugin tools declare `openai/toolInvocation/invoking` and `…/invoked` status strings of at most 64 characters, plus MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`). These drive how ChatGPT frames the call and whether it needs confirmation ([plugins reference](https://developers.openai.com/plugins/reference)) [V]. The extracted prompt tells the model never to expose internal tool names or call details in its answer [C].
7. **Web search is one multi-action tool, not a single "search" call.** The API `web_search_call.action` is `search`, `open_page` or `find_in_page` [V]. The consumer tool (`web.run`) also covers fast and slow engines, product, local business and restaurant-availability lookups, image search, click, find, PDF-page screenshot and widget calls [C]. Rendering uses inline citation chips, a **Sources** button that opens a Citations sidebar (since 2024-10-31) [P], rich entity chips, carousels, image groups and a video player [C]. Per the API docs, inline citations must be "clearly visible and clickable" [V].
8. **Generative-UI widgets are a tool.** For weather, currency, calculator, unit conversion, local time, holidays, sports and jobs, the model first calls `genui.search` and then `genui.run` to render a native widget. The text answer must still stand on its own [C]. The Aug 2026 GPT-5.6 update surfaced "brief weather summaries with widgets" (AppleInsider 2026-08-06) [P].
9. **Private and user-visible code are separate tools.** `python` runs in the hidden analysis channel for the model's own work, such as zooming into images or parsing files. `python_user_visible` runs in the commentary channel, and its charts, interactive DataFrames and files are shown to the user [C]. API equivalent: `code_interpreter` containers from 1 GB to 64 GB that expire after 20 idle minutes. Files come back as `container_file_citation` annotations [V].
10. **Canvas is gone.** It was removed from current models on 2026-05-28 and replaced by inline **writing blocks** and **code blocks** with preview and run (The AI Career Lab 2026-06-24) [P]. File deliverables (docx, pptx, xlsx, pdf, html) open in an **artifacts viewer** that supports annotation-driven edits ([artifacts-viewer](https://learn.chatgpt.com/docs/artifacts-viewer)) [V].
11. **Integrations went from connectors to apps to plugins.** Connectors were renamed apps on 2025-12-17/18 when the app directory launched [P]. The **Plugin Directory** arrived on 2026-07-09 [P]. A plugin bundles **skills, MCP servers (optionally with UI), browser extensions and hooks** ([plugins](https://learn.chatgpt.com/docs/plugins)) [V]. Users can @mention a plugin. Write tools need approval, and on iOS the approval can be remembered per chat or across chats (2026-06) [V].
12. **API loop primitives have grown well beyond "function calling"** [V]:
    - **strict** schemas, with the Responses API normalising to strict by default;
    - **namespaces** and **tool_search** with `defer_loading` (gpt-5.4+). Loaded tools are injected at the *end* of context, which keeps the prompt cache;
    - `allowed_tools` in `tool_choice`, also cache-friendly;
    - **programmatic tool calling**: the model writes JavaScript that calls your tools inside a V8 sandbox;
    - **async tools** (GPT-6), where the model keeps working while a tool runs, plus a wait tool and an async "ask the user" tool;
    - **mid-turn steering** over WebSocket;
    - `configuration_update` to change reasoning effort mid-conversation without breaking the cache;
    - the assistant message **`phase`** (commentary or final_answer), recommended to stop preambles being taken as final answers;
    - encrypted reasoning items that must be round-tripped;
    - **background mode**, webhooks, **compaction**, and **WebSocket mode** (about 40% faster for runs with 20+ tool calls).
13. **Official function-design guidance** [V]:
    - keep fewer than 20 functions visible at the start of a turn;
    - pass the "intern test";
    - don't make the model fill arguments you already know;
    - merge functions that are always called in sequence;
    - use enums to rule out invalid states;
    - few-shot examples can *hurt* reasoning models;
    - describe namespaces briefly and put the detail in the deferred function description;
    - plugin metadata should say "Use this when…" and name disallowed cases, and should be tuned against a golden prompt set for precision and recall.
14. **Approvals and safety are designed into the UI** [V]:
    - Work always confirms consequential actions: purchases, sending, deleting, changing permissions;
    - website access has three settings: **Always ask / Auto approve / Always allow**;
    - login uses a **secure sign-in form** the model never sees, and the user can **take over** the browser;
    - a separate review model checks sign-in requests for phishing;
    - tasks can **pause for safety review**;
    - the desktop app offers **Ask for approval / Approve for me (auto-review) / Full access** modes.
15. **Long work is observable and interruptible from outside the chat** [V]:
    - a goal progress row above the composer (pause, resume, edit, clear);
    - an **Activity view** of running, needs-input and ready chats;
    - notifications by push, email or SMS;
    - pets and "Codex Micro" status surfaces;
    - scheduled and event-triggered tasks (Gmail, Slack, GitHub; 2026-08-25).

---

## 2. Dated timeline of tool and UI milestones (2024-10 → 2026-09)

| Date | Change | Source |
|---|---|---|
| 2024-10-31 | ChatGPT search: inline citations plus a **Sources** button that opens a sidebar ("Citations") | [OpenAI](https://openai.com/index/introducing-chatgpt-search/), [Search Engine Land](https://searchengineland.com/chatgpt-search-officially-launches-447919) [P] |
| 2024-11-26 | o1 "Thought for X seconds" chain-of-thought summary opens in a **sidebar** (like sources) instead of inline | [Tibor Blaho, Threads](https://www.threads.com/@btibor91/post/DC1BTZcIiJ7) [P] |
| 2025-01 | Scheduled **Tasks**; Operator (CUA) research preview | [Tibor Blaho changelog 2025](https://medium.com/@btibor91/chatgpt-changelog-2025-a2c0c86ed29e) (title only, 403) [P] |
| 2025-02-02/03 | **Deep research** (o3): a sidebar shows the steps taken and sources used; runs take 5–30 min | [OpenAI PDF](https://cdn.openai.com/API/docs/deep_research_blog.pdf), [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research) [P] |
| 2025-03-25 | GPT-4o native image generation in ChatGPT | [Wikipedia GPT Image](https://en.wikipedia.org/wiki/GPT_Image) [P] |
| 2025-04 | Lightweight deep research (o4-mini); quotas 25 Plus / 250 Pro / 5 Free | [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research) [P] |
| 2025-04-10 | Memory "reference chat history" | [digitalapplied](https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide) [P] |
| 2025-06 | Record mode; connectors/MCP for deep research | [Tibor Blaho](https://medium.com/@btibor91/chatgpt-changelog-2025-a2c0c86ed29e) [P] |
| 2025-07-17 | **ChatGPT agent** (Operator + deep research): virtual computer with a visual browser, text browser, terminal and connectors; watch mode; "take over browser" | [TechTarget](https://www.techtarget.com/whatis/feature/ChatGPT-agents-explained), [OpenAI](https://openai.com/index/introducing-chatgpt-agent/) [P] |
| 2025-07-29 | **Study mode** | [OpenAI](https://openai.com/index/chatgpt-study-mode/) [P] |
| 2025-08-07 | GPT-5 (router plus Thinking) | [Wikipedia](https://en.wikipedia.org/wiki/GPT-5) [P] |
| 2025-09 (mid) | Thinking-time control in the composer: Plus Standard/Extended; Pro Light/Standard/Extended/Heavy | [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/you-can-now-toggle-gpt-5s-thinking-time-for-faster-or-smarter-answers-heres-how-to-do-it), [TestingCatalog](https://x.com/testingcatalog/status/1968398981056045154) [P] |
| 2025-09-25 | **Pulse** (proactive daily feed) | [OpenAI](https://openai.com/index/introducing-chatgpt-pulse/) [P] |
| 2025-10-06 | **Apps SDK** (on MCP) plus Developer Mode | [OpenAI](https://openai.com/index/introducing-apps-in-chatgpt/) [P] |
| 2025-10-21 | **ChatGPT Atlas** browser ("Ask ChatGPT" sidebar, agent mode, browser memories) | [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas) [P] |
| 2025-11-05 | Interrupt long runs: **"Update" in the sidebar** (GPT-5 Pro, deep research) | [OpenAI on X](https://x.com/OpenAI/status/1986194298971590988), [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/you-can-now-interrupt-chatgpt-as-it-learns-to-take-feedback-on-the-fly) [P] |
| 2025-11-20 | Group chats worldwide | [MacRumors](https://www.macrumors.com/2025/11/20/chatgpt-group-chats/) [P] |
| 2025-11-24 | **Shopping research** (asks clarifying questions, builds a buyer's guide, 2–5 min) | [SEJ](https://www.searchenginejournal.com/chatgpt-adds-shopping-research-for-product-discovery/561840/), [DC360](https://www.digitalcommerce360.com/2025/11/25/chatgpt-shopping-research/) [P] |
| 2025-11-25/26 | Voice inside the chat (live transcript plus visuals); separate mode becomes optional | [MacRumors](https://www.macrumors.com/2025/11/26/chatgpt-voice-mode-update-seamless-chat/) [P] |
| 2025-12-17/18 | App directory; connectors renamed "apps"; public submissions open | [OpenAI](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/), [Engadget](https://www.engadget.com/ai/openai-just-launched-an-app-store-inside-chatgpt-133049586.html) [P] |
| 2026-02-10/11 | Deep research relaunch on GPT-5.2: editable plan, site restriction, any MCP/app, real-time progress plus interrupt, fullscreen viewer (TOC and citations), export MD/DOCX/PDF | [MacRumors](https://www.macrumors.com/2026/02/11/chatgpt-deep-research-mode-document-viewer/) [P] |
| 2026-03-09 | GPT-5.4 Thinking: **upfront plan**, interrupt before the final answer | [ETIH](https://www.edtechinnovationhub.com/news/openai-rolls-out-gpt-54-thinking-in-chatgpt-with-new-control-over-ai-responses) [P] |
| 2026-03-26 | Legacy (o3) deep research removed; `/deep` shortcut on macOS | [findskill.ai](https://findskill.ai/blog/openai-deep-research-legacy-removal/) [P] |
| 2026-04-22 | ChatGPT Images 2.0 (`gpt-image-2`) | [OpenAI](https://openai.com/index/introducing-chatgpt-images-2-0/), [MindStudio](https://www.mindstudio.ai/blog/what-is-gpt-image-2) [P] |
| 2026-05-28 | Canvas removed from current models; **writing blocks** plus code blocks replace it | [The AI Career Lab](https://theaicareerlab.com/blog/chatgpt-what-changed-june-2026) [P] |
| 2026-06-04 | Memory "dreaming" (background rewrite of memories) | [digitalapplied](https://www.digitalapplied.com/blog/chatgpt-memory-dreaming-v3-openai-2026-guide) [P] |
| 2026-06-17 | Pulse retirement announced; folded into scheduled tasks | [justinmckelvey.com](https://justinmckelvey.com/blog/chatgpt-pulse) [P] |
| 2026-07-09 | **ChatGPT Work** (GPT-5.6); Codex app merged into the ChatGPT desktop app; Plugin Directory | [learn.chatgpt.com what's new](https://learn.chatgpt.com/docs/whats-new) [V], [TNW](https://thenextweb.com/news/openai-chatgpt-work-agent-launch) [P] |
| 2026-07-20…24 | ChatGPT Voice on GPT-Live in Chat/Work/Codex (desktop) | [what's new](https://learn.chatgpt.com/docs/whats-new) [V] |
| 2026-07-30 | Brockman: UI "kind of a mess"; Work tab to be removed by year-end | [TechBriefly](https://techbriefly.com/2026/07/30/openai-chatgpt-app-ui-mess-zero-tab-design/) [P] |
| 2026-08 (early) | Agent mode removed ("ChatGPT agent is no longer available") | [usecarly](https://www.usecarly.com/blog/chatgpt-agent-mode/) [P] |
| 2026-08-06 | Instant and Thinking merged; **reasoning slider** (Plus/Pro); **Think** button (Free/Go) | [9to5Mac](https://9to5mac.com/2026/08/06/openai-updating-chatgpt-with-a-smarter-gpt-5-6-sol-and-unlimited-free-chats/), [AppleInsider](https://appleinsider.com/articles/26/08/06/new-chatgpt-version-has-a-think-button-will-find-more-reliable-facts) [P] |
| 2026-08 (mid) | Test moving the Sources list behind the "…" menu | [zenergyworks 2026-08-17](https://www.zenergyworks.com/chatgpt/chatgpt-citations-are-changing-what-you-should-know/) [P] |
| 2026-08-25 | Event-triggered scheduled tasks (Gmail/Slack/GitHub); Site tools (WebMCP) | [what's new](https://learn.chatgpt.com/docs/whats-new) [V] |
| 2026-08-31…09-04 | GPT-6 Astra in Work/Codex | [what's new](https://learn.chatgpt.com/docs/whats-new) [V] |
| 2026-09-08 | ChatGPT Images 2.5 (Sketch, ~50% lower latency) | [9to5Mac](https://9to5mac.com/2026/09/08/openai-releases-chatgpt-images-2-5-with-sharper-details-and-more-precise-editing/) [P] |
| 2026-09-22 | GPT-6 Sol/Luna in Codex/Work (not Chat) | [what's new](https://learn.chatgpt.com/docs/whats-new), [models](https://learn.chatgpt.com/docs/models) [V] |

---

## 3. Part A: ChatGPT consumer tools (state as of Sept 2026)

### A1. Product structure: Chat, Work, Codex, plugins

- **Chat** handles questions and back-and-forth. **Work** delegates a larger task and produces a "reviewable result". **Codex** shows developer detail such as diffs and shell output. In the desktop app, Work hides technical detail (Git, shell) and "prefers nontechnical language and finished outputs"; Codex shows diff and review views ([use-chatgpt](https://learn.chatgpt.com/docs/use-chatgpt)) [V].
- Work runs in a **managed cloud environment** on the web. On desktop the user chooses *Cloud*, which keeps running after the app closes and continues on web or mobile, or *Work locally*, which uses local files, apps and the browser. ChatGPT "shows its progress and pauses when it needs information or approval" ([use-chatgpt](https://learn.chatgpt.com/docs/use-chatgpt)) [V].
- **Escalation from Chat to Work is model-driven.** The extracted GPT-5.6 Sol Chat prompt contains `local.handoff({prompt, reason})`. The model must call it *before doing any work* when a request needs browser or computer use, building apps, code or repository edits, file deliverables (pptx, xlsx and similar) or complex analysis. It must not call it again if the user declines [C]. This is how ChatGPT avoids a mode picker [I].
- **Model and effort control.**
  - Chat: a reasoning slider for Plus/Pro and a Think toggle for Free/Go, with Instant and Thinking merged (2026-08-06) [P].
  - Work and Codex: a **Power** slider (*Faster ↔ Smarter*) with six presets: Luna High, Sol Light (start), Sol Medium, Astra Light, Astra Medium, Astra Extra High. An **Advanced** section picks the exact model, effort and speed. **Ultra** runs subagents ([models](https://learn.chatgpt.com/docs/models)) [V].
  - Help-center snippets (not fetched) say that in the model picker "Medium replaces Thinking Standard, High replaces Thinking Extended, and Extra High replaces Thinking Heavy" [P].
- **Plugins are the universal extension unit.** They can include skills, MCP servers with optional UI, browser extensions and hooks. The directory has tabs for OpenAI, workspace, personal and installed. Users invoke a plugin by `@name` in the composer, for example `@Visualize`, `@Slack` or `@Browser` ([plugins](https://learn.chatgpt.com/docs/plugins)) [V].

### A2. Thinking UI: anatomy and evolution

**Verified or reported facts:**

- **Collapsed state.** After reasoning, a "Thought for Ns" row stays above the answer. Clicking it opens the reasoning summary in a **sidebar** that is also used for sources. Shipping since 2024-11-26 [P].
- **Expanded content.** Bullet-style summary steps (for example "I'm going to verify by checking the web…"), interleaved with the searches run and the pages opened, shown as domain chips with an "N more" count. A Sources section sits at the bottom (Simon Willison, 2025-09-06/07, [post](https://simonwillison.net/2025/Sep/6/research-goblin/)) [P]. Search, reasoning and follow-up searches are *interleaved inside the thinking phase* [P]. The API confirms interleaved thinking and preambles ("interleaved thinking … generate visible output tokens before and in between thinking … think in between tool calls", [reasoning](https://developers.openai.com/api/docs/guides/reasoning)) [V].
- **Controls while running.**
  - **Answer now** stops thinking and produces the answer immediately. By one analysis it skips routing and goes to the same model ([Medium, GPT-5.2 tips](https://medium.com/@dalio8/7-pro-tips-to-master-chatgpt-5-2-instant-thinking-extended-thinking-pro-mode-45990346ca1f)) [P].
  - **Update** (sidebar, since 2025-11-05) adds context without restarting; the model adjusts [P].
  - **Stop** is always present [I].
- **Upfront plan.** GPT-5.4 Thinking (2026-03) shows its intended approach before the final answer, and you can interrupt at that point [P].
- **Effort control** moved from named levels (Light, Standard, Extended, Heavy; 2025-09) to a **slider** (2026-08) [P]. In fullscreen plugin UIs, "the composer input 'shimmers' to show that a response is streaming" ([plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)) [V]. That confirms shimmer as ChatGPT's canonical "working" signal.
- **Channels (architecture).** The extracted prompts define `analysis` (hidden reasoning plus private tools), `commentary` (user-visible preambles and visible tools), `final`, and `summary` [C]. The API `phase: "commentary" | "final_answer"` is the public counterpart [V]. A `summary_reader` tool lets the model read *its own earlier reasoning summaries* when the user asks how it reached an answer [C].

**UI anatomy (synthesis) [I]:**

```
[● Thinking ···············]        <- shimmer label, current activity replaces it ("Searching the web", "Reading 4 sources")
   ↳ (optional) plan / preamble line  <- GPT-5.4+ "upfront plan", interruptible
   [Answer now]                        <- appears for long thinks
─ on finish ─
[Thought for 38s  ›]                    <- collapsed chip; click → right panel
Answer text … ⟨cite chip⟩
[⧉ Sources  ●●●]                         <- favicon stack → Citations sidebar
```

Right panel: title "Thinking" or "Activity", then summary steps with inline search and open events, then Sources (grouped "Citations" and "More"), then **Update** on long runs.

### A3. Web search and citations

- **Invocation.** The model decides for itself. The extracted prompt lists when search is *required*: fresh or niche information, local queries, products, people and entities, navigational queries, URLs, and deep research. It lists when search is *forbidden*: greetings, rewriting text the user supplied, creative writing without references. An explicit user request always wins [C].
- **Tool shape (consumer, [C]).** One tool, `web.run`, takes compact newline-separated commands:
  - search on `fast` and `slow` engines, with recency and domain parameters;
  - `product`, `business` and restaurant `availability` lookups;
  - `image` search;
  - `open` a reference or URL at a line;
  - `click` a numbered link on an opened page;
  - `find` text on a page;
  - `screen` a PDF page as an image;
  - `length` to set the answer length;
  - `genui_search` / `genui_run` for widgets.

  Parallel queries are encouraged. Results get **reference IDs** such as `turn3search4`, `turn0fetch3` or `turn0business1`, which the model cites.
- **Citation grammar ([V] and [C]).** OpenAI's public citation guide recommends private-use Unicode markers, `citeturn0file1`, "because they closely match the markers our models are trained on". Source IDs follow `turn{N}{kind}{M}`, where N increments once per tool invocation. Block-level citations are the recommended default: the model emits the *ID*, and the app resolves the *locator* ([citation-formatting](https://developers.openai.com/api/docs/guides/citation-formatting)) [V]. The consumer prompt uses `【cite|turn3search4|turn1news0】`, placed at the **end of the paragraph, list item or table cell** it supports [C].
- **Rich entity formats (consumer, [C]).**
  - Products: inline entity, hero product, rich product, carousel, and comparison table with entity headers.
  - Local businesses: an entity chip rendered as an underlined name that opens a card.
  - `image_group` (carousel or bento), a YouTube `video` player, and nav lists.
  - Rule: each rich block goes on its own line, never inside a list.
- **Rendering (as of Oct 2024 → Aug 2026, [P]).** Inline citation chips sit mid-sentence. A **Sources** button with a favicon stack opens a **Citations** sidebar that also lists "More" sources the model looked at but did not cite. Longer answers show a sidebar source list. In Aug 2026 OpenAI tested moving the list behind the overflow menu (zenergyworks 2026-08-17) [P].
- **API parity [V]** ([web search guide](https://developers.openai.com/api/docs/guides/tools-web-search)):
  - `web_search_call.action` ∈ `search` (with `queries`), `open_page`, `find_in_page`;
  - the message carries `url_citation` annotations;
  - the **`sources`** field lists *all* URLs consulted (always more than the citations) and labels real-time feeds `oai-sports`, `oai-weather` or `oai-finance`;
  - image search results (`image_url`, `source_website_url`, `thumbnail_url`, `caption`);
  - `filters` of up to 100 allowed or blocked domains;
  - `user_location` (country, city, region, timezone);
  - `external_web_access:false` for cache-only search;
  - `search_context_size` (low, medium, high) and `return_token_budget: "unlimited"` for long research;
  - the search context is capped at 128k tokens;
  - "Inline citations must be made clearly visible and clickable in your user interface".
- **Widgets ("genui") [C].**
  - `genui.search(query)` returns widget specs; `genui.run({widget_name:{args}})` renders one.
  - Required for weather, currency, calculator, unit conversion, local time and holidays; also sports and jobs.
  - Show one widget unless the user asks for more.
  - Widgets are "purely supplemental": the text answer must be complete without them.
  - If the widget needs fresh data, run it in parallel with a search.

### A4. Deep research

**Flow.**

1. **Clarify.** In 2025 an intermediate model asked follow-up questions, rewrote the prompt, and then kicked off the research model ([API deep research guide](https://developers.openai.com/api/docs/guides/deep-research)) [V]. The extracted 2025 prompt exposes a `research_kickoff_tool` with `clarify_with_text` and `start_research_task` [C]. This is the same "chat model decides, then hands off to a background task" pattern as Juno's `start_task` [I].
2. **Plan.** Since Feb 2026 the user can create and edit a research plan before it starts [P], and see "what ChatGPT plans to research, adjust scope, add sources, or redirect" ([aiinsider 2026-05-09](https://aiinsider.in/ai-learning/chatgpt-deep-research-feature-2026/)) [P].
3. **Scope.** The public web, uploaded files and connected apps are the defaults. The user can narrow to or prioritise specific sites, and can connect any MCP server or app [P].
4. **Run.** The run takes 5–30 min. Progress shows live in the sidebar, and the user can interrupt with follow-up prompts or new sources without restarting. A notification fires when the report is ready [P].
5. **Report.** It opens in a **fullscreen viewer** with a left **table of contents** and an expandable right **citations** column, and exports to Markdown, Word or PDF (MacRumors 2026-02-11) [P].

**Entry points (2026).**

- Web: Work → **+** → Deep research. Desktop: the Deep research **plugin** → Try now ([web-search doc](https://learn.chatgpt.com/docs/web-search)) [V].
- Deep research is a *task type inside Work*, not a mode of Chat.
- `/deep` works on macOS (2026-03) [P].

**Tiers.** There are none in the UI. Plans get quotas (Plus 25, Pro 250, Free 5 "lightweight") [P]. The lightweight/full distinction is a quota and model detail, not a user-picked level [I]. The API caps work with `max_tool_calls` ("the primary tool … to constrain cost and latency") and recommends background mode plus webhooks [V].

**API safety guidance [V].**

- For private data, run in **phases**: web-only first, then private MCP with no web access.
- Validate tool arguments against a schema or regex.
- Screen links, because a URL like `site.com/{your-data}` can exfiltrate data.
- An MCP server used by deep research must expose `search` and `fetch` with `require_approval:"never"`.

### A5. Agent mode (2025) → ChatGPT Work (2026)

**Agent mode, 2025-07-17 → removed in early Aug 2026 [P]:**

- It ran on its own virtual computer with a visual browser, text browser, terminal and API connectors, and narrated as it worked.
- It asked permission before consequential actions.
- It used **watch mode** for sensitive sites: the user must keep the tab in view, or the agent pauses.
- **Take over browser** let the user enter credentials; no screenshots were taken while the user was in control.
- The user could interrupt at any time.

The extracted agent prompt requires the agent to confirm any instruction that comes from the screen (emails, websites), to flag possible prompt injection or phishing immediately, and to use the `final` channel to request confirmation before irreversible steps [C].

**ChatGPT Work (2026-07-09) [V] unless marked:**

- Plan-first: it "gathers context, asks you clarifying questions, and shows you a step-by-step plan that you can read, change, or approve" ([mavgpt guide](https://mavgpt.ai/resources/chatgpt-work-complete-guide-2026)) [P].
- Configurable check-in frequency: "every step, at key decision points, or only when it is stuck" [P].
- Consequential actions always need sign-off ([browser](https://learn.chatgpt.com/docs/browser)) [V].
- **Chat sidebar while a task runs** "can surface the agent's plan, sources, generated files, and chat summary so you can steer the work" ([artifacts-viewer](https://learn.chatgpt.com/docs/artifacts-viewer)) [V]. This is the closest official description of ChatGPT's *right panel* for agentic work.
- **Cloud browser.**
  - Website permission modes: Always ask, Auto approve (a relevance check runs first) or Always allow (not recommended).
  - Per-site allow and block lists.
  - A **secure sign-in form** shows the site address and a form preview. Credentials go straight to the browser and the model never sees them.
  - An extra **review model** checks sign-in requests for phishing.
  - "If ChatGPT is ever blocked … you can take over its computer."
  - CAPTCHAs and sites that block automation are stated limits ([browser](https://learn.chatgpt.com/docs/browser)).
- **Safety pause.** A task can pause for safety review and show findings before continuing ([get-started-with-work](https://learn.chatgpt.com/docs/get-started-with-work)).
- **Long-running control.**
  - Desktop `/goal` mode adds a **progress row above the composer** with pause, resume, edit goal and clear. A side chat can give a status recap without interrupting.
  - On the web, the user steers by messaging the same chat ([long-running-work](https://learn.chatgpt.com/docs/long-running-work)).
  - **Activity view** (bell icon) lists chats that are unread, running or waiting on the user.
  - Notifications fire on turn completion (never, in the background, or always), plus separate permission and question alerts. On the web they go by push, email or SMS ([notifications](https://learn.chatgpt.com/docs/notifications)).
- **Permission modes (desktop).** Ask for approval (default), **Approve for me** (an auto-review agent evaluates requests to cross the sandbox boundary without widening it) and Full access ([permission-modes](https://learn.chatgpt.com/docs/permission-modes)).
- **Subagents / Ultra.** Parallel subagents with consistent visual identifiers for background subagents (2026-05) ([what's new](https://learn.chatgpt.com/docs/whats-new)).

### A6. Canvas → writing blocks, code blocks, artifacts viewer, Visualizations, Sites

- Canvas (the side-panel editor) was removed from current models on 2026-05-28. **Writing blocks** are inline editable drafts; **code blocks** offer copy, preview and run [P].
- **Work with files** [V]:
  - The desktop app previews docx, pptx, xlsx, pdf and html beside the chat and can auto-open a file when a task finishes.
  - HTML has a rendered/source toggle.
  - **Annotations** let the user select a region of a page, slide, chart or element and ask for a focused change.
  - On the web, the user reviews and downloads the file and asks for targeted revisions ([artifacts-viewer](https://learn.chatgpt.com/docs/artifacts-viewer)).
- **Visualizations** (preview, 2026) [V]:
  - Invoked with `@Visualize` or chosen by the model "when it materially improves the answer".
  - Produces a chart, map, diagram, calculator, simulation or interactive explainer, rendered inline in Chat or Work.
  - Guidance is to "ask for the smallest format that fits". Use Sites for durable hosted apps ([visualizations](https://learn.chatgpt.com/docs/visualizations)).
- **Sites** (2026-06) build and host websites, dashboards, tools and games, with saved versions and deploy on approval ([what's new](https://learn.chatgpt.com/docs/whats-new)) [V].

### A7. Image generation and editing

**Model timeline [P]:** 4o image generation (2025-03-25) → GPT Image 1.5 (2025-12) → Images 2.0 / `gpt-image-2` (2026-04-22) → Images 2.5 (2026-09-08, adds **Sketch**, ~50% lower latency). The DALL·E GPT is retired on 2026-08-30 ([release-notes snippet](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)) [P].

**UI (2026) [V]:**

- Selecting an image opens an **expanded viewer** with **Focused view** (one image) and **Canvas view** (every image in the chat).
- Canvas view offers **Comment** on one or more images, **Multi-select**, and sending comments as edit instructions.
- The user can select an area of an image and describe the change there ([image-generation](https://learn.chatgpt.com/docs/image-generation)).

**API [V]:**

- The `image_generation` tool supports `action` (auto, generate or edit), size, quality (up to `max` on 2.5), background (transparent) and format.
- It returns a `revised_prompt`.
- It streams **1–3 partial images** (`response.image_generation_call.partial_image`) for progressive reveal.
- Editing works across turns via `previous_response_id` or an image ID ([tools-image-generation](https://developers.openai.com/api/docs/guides/tools-image-generation)).

### A8. Python / data analysis

- **Consumer [C].**
  - Two tools: `python`, private, run in the analysis channel for the model's own reasoning (inspecting files and images, 300 s timeout, `/mnt/data`); and `python_user_visible`, run in the commentary channel for code and outputs the user should see.
  - `display_dataframe_to_user` renders an **interactive table**.
  - Chart rules: no seaborn, one chart per figure, no custom colours unless asked.
  - Created files must be linked as `sandbox:/mnt/data/...`.
- **Historic UI [P].** The answer shows an "Analyzed" chip with **View analysis** to reveal the code ([obot.ai](https://obot.ai/resources/learning-center/chatgpt-advanced-data-analysis/)).
- **API [V].**
  - `code_interpreter`, which the model knows as "the python tool", uses **containers** at 1g, 4g, 16g or 64g.
  - A container expires after **20 min idle**, and expired containers cannot be revived.
  - Input files are uploaded automatically.
  - Outputs come back as `container_file_citation` annotations.
  - Streaming events: `code_interpreter_call.in_progress|interpreting|completed` and `code_interpreter_call_code.delta` ([code interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter)).
  - The model can use it to crop, zoom and rotate images, which is the "thinking with images" pattern.
  - Hosted **shell** (Debian 12; Python, Node, Java, PHP, Ruby, Go) is the 2026 superset: `network_policy` allowlists and `domain_secrets` placeholders keep raw credentials out of model context ([shell](https://developers.openai.com/api/docs/guides/tools-shell)).

### A9. Files, file search, Library, projects

- **Consumer [V].**
  - Files can be uploaded to a chat or to a **project**, which bundles chats, files, sources and instructions.
  - **Library** (web, 2026-08): add a saved file without re-uploading; pasted text over 10,000 characters automatically becomes an attachment, with a "Show in text field" option ([what's new](https://learn.chatgpt.com/docs/whats-new)).
- **Consumer tools [C].** A "File Search Tool" section plus a "Files Tool" section, and `container.open_image` / `container.download`.
- **API [V].** `file_search` over vector stores (hosted, semantic plus keyword) with `max_num_results`, metadata filters, `include` to return the chunks, and `file_citation` annotations ([file search](https://developers.openai.com/api/docs/guides/tools-file-search)).

### A10. Memory and personal context

- **Two layers [P]:**
  - **Saved memories**, written by the `bio` tool [C], shown in a user-editable list;
  - **Reference chat history**, implicit recall across past chats (2025-04-10).
  - Since 2026-06-04, a background **"dreaming"** process rewrites memories [P].
- **Desktop [V].**
  - `/memories` decides per chat whether it can *use* or *contribute to* memory.
  - **Computer History** (macOS, 2026-08) turns app and web activity into a searchable timeline and memories ([memories](https://learn.chatgpt.com/docs/customization/memories)).
  - The Codex memory config has `disable_on_external_context`, which keeps chats that used MCP, web search or tool search *out* of memory generation, as a guard against injection [V].
- **Tools [C].** `personal_context.search` (retrieve user context), `user_info.get_user_info` (location and local time), and `user_settings.get/set_setting`.

### A11. Connectors → apps → plugins; MCP and the Apps SDK

- **History [P].** Connectors and MCP for deep research (2025-06) → Developer Mode with full MCP (2025-09) → Apps SDK (2025-10-06) → app directory, with connectors renamed apps (2025-12-17/18) → **Plugin Directory** (2026-07-09) → **Sign in with ChatGPT** for partner accounts (2026-07-29, [V]).
- **Tool metadata used by the host UI [V]** ([reference](https://developers.openai.com/plugins/reference)):
  - `_meta["openai/toolInvocation/invoking"]` / `invoked`: status text of at most 64 characters, shown *while* the tool runs and *after* it completes;
  - MCP `annotations`: `readOnlyHint` (required), `destructiveHint` (required), `openWorldHint` (required), `idempotentHint`. These "only influence how ChatGPT or Codex frames the tool call"; servers must still authorise;
  - `outputSchema` for any `structuredContent`;
  - `_meta.ui.resourceUri` links the tool to a UI template;
  - `_meta.ui.visibility` sets whether the model, the UI or both can call the tool;
  - `openai/fileParams` for file inputs;
  - approval-gated arguments are **not delivered to the widget until the user approves**.
- **Plugin guidelines [V].** Any action that sends data outside the current boundary must be marked as a write action "so it can require user confirmation or run in preview mode" ([app-guidelines](https://developers.openai.com/plugins/app-guidelines)).
- **Display modes [V]** ([UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)):
  - **Inline card.** Appears *before* the model's text. The layout is: app icon plus tool-call label, the card, then a short model follow-up. At most 2 actions, no nested scroll, no deep navigation.
  - **Inline carousel.** 3–8 items, an image per item, at most 3 lines of metadata, one CTA.
  - **Fullscreen.** The system composer stays overlaid; the composer **shimmers** while a response streams; a truncated reply snippet appears above the composer.
  - **Picture-in-picture.** Pins at the top while the user scrolls, for live sessions.
- **Tool-surface design [V]** ([define tools](https://developers.openai.com/plugins/plan/tools), [optimize metadata](https://developers.openai.com/plugins/guides/optimize-metadata)):
  - separate reads from writes;
  - split tools by permission and risk;
  - write a contract per tool: name, title, description, input and output schema, authorization, side effects, failure behaviour;
  - descriptions start "Use this when…" and name the disallowed cases;
  - build a golden set of direct, indirect and negative prompts;
  - measure precision and recall;
  - change one metadata field at a time.
- **Consumer `api_tool` namespace [C].** `list_resources`, `read_resource`, `find_in_resource`, `search_plugins` and `suggest_installs` let the model *discover* and suggest installing plugins mid-conversation, rather than the user pre-selecting them [I].

### A12. Tasks, scheduled tasks, Pulse

- **Scheduled tasks [V]** ([automations](https://learn.chatgpt.com/docs/automations)):
  - A **Scheduled** hub lists tasks and their runs.
  - A task can be standalone (starts fresh each time) or run *inside a chat* (reuses its context).
  - Tasks can use files, connected tools, skills and plugins.
  - **Event triggers** (2026-08-25): Gmail new mail with sender or subject filters, Slack channel messages, GitHub PR activity. Events close together may be merged into one run, and there is **Run now**.
  - The model-side tool `automations.create/update/list` exists [C].
- **Pulse** (2025-09-25) was retired in 2026-06 and its useful parts folded into scheduled tasks [P]. The lesson: *proactive feeds lost to explicit, user-configured tasks* [I].

### A13. Other consumer tools

- **Study mode** (2025-07-29): Socratic guided learning [P]. In 2026, education *plugins* (College Student, Educator) create study guides, quizzes and flashcards [V].
- **Shopping research** (2025-11-24) [P]:
  - asks interactive **preference questions** (budget, use, features);
  - researches for 2–5 min;
  - returns a **buyer's guide** with images, prices, specs and review summaries;
  - OpenAI reported 52% product accuracy on multi-constraint queries.
- **Record mode** (2025-06): records meetings and produces notes [P]. The 2026 successor is desktop **Record & Replay**, which turns a demonstrated workflow into a skill [V].
- **Voice.** Integrated into the chat with a live transcript and inline visuals (2025-11-25) [P]. **ChatGPT Voice on GPT-Live** can start and steer tasks in other threads (2026-07); since 2026-08 it also works with files and Projects [V].
- **GPTs / actions.** Still present, mainly in workspaces (Enterprise "GPTs and Sharing"). The DALL·E GPT retires on 2026-08-30 [P/V]. Plugins are now the primary extension model [I].
- **Group chats** (2025-11-20). Memory is not shared into the group [P].
- **Atlas** browser (2025-10-21 → discontinued 2026-08). The Chrome extension (Chrome, Edge, Brave, Opera, Vivaldi) plus desktop browser, Computer Use and **Appshots** replace it [P/V].

### A14. How tool calls appear: cross-cutting patterns

| Phase | ChatGPT pattern | Evidence |
|---|---|---|
| Before a tool | Short **preamble** in commentary ("I'll check the latest filings") or an upfront plan | [V] `phase` guidance; [P] GPT-5.4 plan |
| Running (Chat) | Shimmer label naming the current activity; favicons pop in as pages are read; image generation shows progressive partial images; plugin tools show their `invoking` string | [V] plugin docs; [V] partial images; [I] labels |
| Running (Work) | Step list and plan checklist in the sidebar; live screenshots or terminal output for browser and computer work; the user can take over | [V] artifacts-viewer, browser |
| Needs user | Approval prompt (write, destructive, open-world); secure sign-in form; question to the user; safety-review pause | [V] browser, plugins; [V] ChatKit `StructuredInput` |
| Done | Collapses to "Thought for Ns" plus Sources; plugin tools show their `invoked` string plus an inline card; files open in the viewer | [P]/[V] |
| Error | Blocked site: "will let you know and try another way"; failed MCP call: `error` on the item, which the model explains; ChatKit `ErrorEvent` with an optional retry button | [V] browser, MCP, ChatKit |
| Hygiene | "Never expose the internal tool names or tool call details in your final response" | [C] |

---

## 4. Part B: OpenAI API tool design (developer platform, Sept 2026)

### B1. Function tools [V] ([function calling](https://developers.openai.com/api/docs/guides/function-calling))

- **Definition.** `{type:"function", name, description, parameters (JSON Schema), strict}`.
- **Namespaces** `{type:"namespace", name, description, tools:[…]}` group tools by domain. They are recommended when the model must choose between similar tools in different systems.
- **Strict mode.** Uses structured outputs. Every object needs `additionalProperties:false`, every property must be `required`, and optional fields are typed `["string","null"]`.
  - When `strict` is omitted, the Responses API **tries to normalise to strict** and falls back to non-strict, reporting `strict:false`.
  - Chat Completions stays non-strict by default.
  - OpenAI recommends always enabling strict mode.
  - Some JSON Schema features are unsupported.
- **tool_choice.** `auto` (default), `required`, `none`, forced `{type:"function",name}`, or **`allowed_tools`**, which restricts the *callable* subset without changing the `tools` list and so preserves the prompt cache.
- **Parallel calls.**
  - Enabled by default; `parallel_tool_calls:false` means "zero or one".
  - From GPT-5 onwards, functions can run in parallel even when built-in tools are enabled, but *built-ins cannot be in a parallel function batch*.
  - Fine-tuned models lose strict mode on parallel calls.
- **Outputs.**
  - `function_call_output` with a `call_id`, usually a string (JSON, error codes or text).
  - It can also be an **array of image or file objects**.
  - For no-result tools, return a success or failure string.
- **Best practices (quoted list, condensed):**
  1. Explicit purpose, parameter formats and meaning of the output; use the system prompt for when *and when not* to call a tool.
  2. Examples help, **but may hurt reasoning models**.
  3. Enums and structure make invalid states impossible.
  4. The "intern test".
  5. Don't make the model fill arguments you already know.
  6. Combine functions that are always called in sequence.
  7. **Fewer than 20 functions at the start of a turn** (soft limit).
  8. Use tool search for the long tail.
  9. For deferred tools, keep the namespace description concise and put detail in the function description.
- **Tokens.** Definitions are injected into the system message and billed as input.
- **Streaming.** `response.output_item.added` (call started, with name) → `response.function_call_arguments.delta` → `…done`. The docs suggest using these to show "which function is called as the model fills its arguments, and even displaying the arguments in real time".
- **Reasoning models.** "Any reasoning items returned … with tool calls must also be passed back with tool call outputs."

### B2. Custom tools and grammars [V]

- `{type:"custom"}` tools take **free-form text** input, for example code or SQL, with no JSON wrapping.
- The input can be constrained by a **CFG**: `lark` (LLGuidance subset) or `regex` (Rust syntax, no lookarounds, no lazy quantifiers).
- Guidance: keep grammars small and bounded; carve free text into single terminals; handle whitespace explicitly; raise reasoning effort if the model drifts.

### B3. Tool search [V] ([tool search](https://developers.openai.com/api/docs/guides/tools-tool-search))

- **Availability:** `gpt-5.4`+. Add `{type:"tool_search"}` and set `defer_loading:true` on functions, on functions inside namespaces, or on MCP servers.
- **What the model sees:** only namespace or server names and descriptions until it loads them. For individual deferred functions it still sees name and description, so mostly the *parameter schema* is deferred.
- **Modes:**
  - **Hosted:** `tool_search_call` / `tool_search_output`, `execution:"server"`.
  - **Client-executed:** the application looks the tools up and returns a `tool_search_output` with a matching `call_id`. Use this when the available tools depend on tenant or project state.
- **Cache:** loaded tools are injected **at the end of the context window**, which preserves the cache.
- **Advanced:** an `additional_tools` input item (role developer) adds tools at a specific point in the conversation.
- **Guidance:** fewer than 10 functions per namespace. The models are "primarily trained to search" namespaces and MCP servers.
- **Agents API:** MCP tools are deferred automatically when the model supports it.

### B4. Programmatic tool calling [V] ([guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling))

- The model writes **JavaScript** that runs in a fresh, isolated V8 runtime. There is no Node, network or filesystem; the program only has `tools.*`, `text()` and `image()`.
- `allowed_callers`: `["direct"]`, `["programmatic"]` or both, per tool. Supported for function, custom, MCP, apply_patch, shell and code_interpreter tools.
- New items: `program` (JavaScript, `call_id`, `fingerprint`), nested `function_call` with a `caller`, and `program_output`.
- **When to use it:** predictable fan-out, filter, join or dedupe work that returns a *smaller* structured result.
- **When not to:** approvals, citation-preserving steps, or anywhere each result needs fresh judgement.
- Requires `output_schema` on the tools, idempotent tools, and application-level approval for high-impact actions.
- Enabled by default in the Agents API (as an `exec` tool).

### B5. Async tool calling (GPT-6 Astra+) [V] ([guide](https://developers.openai.com/api/docs/guides/async-tool-calling))

- `async:true` on a function or custom tool: the model keeps reasoning, calls other tools, or answers independent parts while the application runs the tool. The result is delivered later on the original `call_id`.
- **Wait tool pattern.** A synchronous application-defined `wait_for_tasks(task_handles[])`. Each async call carries a model-chosen `task_handle`. Deliver results *before* the wait status.
- **Async ask-user pattern.** `request_user_input_async` shows a question; its result *is the user's answer*. Supply an explicit no-answer result if the question is dismissed or times out.
- Not for hosted tools; not combined with programmatic calls; no parallel calls in multi-agent mode.

### B6. Mid-turn steering (GPT-6, WebSocket) [V] ([steering](https://developers.openai.com/api/docs/guides/steering))

- `response.steer {previous_response_id, input}` → `response.steer.accepted`.
- The server finishes the *current output item* and any hosted tool already running, then creates a continuation automatically. The interrupted response ends `incomplete` with `reason:"steered"`.
- If a client tool result or approval is pending, `response.steer.pending` lists `required_input`.
- Failure codes: `steering_not_supported`, `too_many_pending_steers` and others.
- Steering never rewrites output already sent, never undoes actions and never cancels tools that have started.

### B7. Built-in / hosted tools [V]

| Tool | Key parameters | Output items and events | Notes |
|---|---|---|---|
| `web_search` | `filters.allowed_domains/blocked_domains` (≤100), `user_location`, `search_context_size`, `external_web_access`, `return_token_budget`, `search_content_types:["image","text"]`, `image_settings` | `web_search_call{action:search\|open_page\|find_in_page}`, `sources`, `url_citation` annotations; events `web_search_call.in_progress/searching/completed` | `web_search_preview` is legacy. The search context is limited to 128k. Chat Completions uses `gpt-5-search-api`. The 4o search-preview models shut down 2026-07-23. |
| `file_search` | `vector_store_ids`, `max_num_results`, `filters`, `include:["file_search_call.results"]` | `file_search_call`, `file_citation` | Hosted retrieval. |
| `code_interpreter` | `container:{type:"auto",memory_limit,file_ids}` or a container id | `code_interpreter_call`, `container_file_citation`; code delta events | 20-minute idle expiry. |
| `shell` (hosted and local) | `environment` (`container_auto`/reference), `network_policy`, `domain_secrets`, skills | `shell_call`, `shell_call_output`; command and output delta events | Debian 12, `/mnt/data`, no sudo or TTY. |
| `apply_patch` | none (the model knows the V4A diff format) | `apply_patch_call{operation:create_file\|update_file\|delete_file}` → `apply_patch_call_output{status,output}` | Report failures with `status:"failed"` and a useful message. |
| `computer` | the environment is yours; actions `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot` (batched) | `computer_call` → `computer_call_output` (screenshot) | **For GPT-6 Astra OpenAI recommends *code execution* (Playwright or PyAutoGUI script tools) over the computer tool.** Safety: isolate, treat the screen as untrusted, confirm at the point of risk, bound steps, time and cost. |
| `image_generation` | `model`, `action`, `size`, `quality`, `background`, `partial_images` 1–3 | `image_generation_call` (base64, `revised_prompt`); `partial_image` events | Multi-turn edits. |
| `mcp` (remote) | `server_url` or `tunnel_id`, `server_label/description`, `allowed_tools`, `require_approval` (`always`/`never`/per tool), `authorization` (never stored), `defer_loading` | `mcp_list_tools` (keep it in context so tools aren't re-listed), `mcp_call` (args and output or `error`), `mcp_approval_request` → `mcp_approval_response`; events `mcp_call.*`, `mcp_list_tools.*` | **Approval is the default.** `connector_id` is deprecated for models released after 2026-09-01. Secure MCP Tunnel covers private servers. |
| `tool_search` | `execution:"server"\|"client"` | `tool_search_call`, `tool_search_output` | gpt-5.4+. |
| `programmatic_tool_calling` | `allowed_callers` on tools | `program`, `program_output` | See B4. |
| Skills | `SKILL.md` bundles (agentskills.io standard) mounted into shell | name, description and path are added to *user-prompt* context | Instructions have user priority, not system priority. |

### B8. Reasoning [V] ([reasoning](https://developers.openai.com/api/docs/guides/reasoning), [latest model](https://developers.openai.com/api/docs/guides/latest-model))

- **Effort levels:**
  - `none|minimal|low|medium|high|xhigh|max`, with support varying by model. GPT-6 Astra rejects `none` with an HTTP 400.
  - OpenAI's guidance: low suits tool use, search and chat assistants; medium is the default; xhigh suits "deep research, asynchronous workflows … long runs"; max is the maximum.
  - "Treat `reasoning.effort` as a tuning knob, not the primary way to recover quality."
- **`reasoning.mode: "pro"`** (GPT-5.6/6) is an axis independent of effort.
- **`reasoning.context`:** `current_turn` or `all_turns`. GPT-5.6 defaults to `all_turns`, which renders earlier turns' reasoning. Reasoning is reusable only within the same model family.
- **Stateless reasoning.** With `store:false` or ZDR, reasoning items carry `encrypted_content`. Pass back **all items since the last user message untouched**: reasoning, function calls and their outputs, *in order*.
- **Summaries.** `summary: auto|concise|detailed` produces `reasoning_summary_part.added` / `reasoning_summary_text.delta`. Some latest models require organisation verification.
- **`phase`.** Mark assistant messages `commentary` (preambles) or `final_answer`, and round-trip them. Missing phase "can cause preambles to be treated as final answers".
- **`configuration_update`.** Change effort between turns without touching the request-level effort, which keeps the cache (GPT-6, single-agent). It is incompatible with auto-compaction.
- **Latency.** "For faster time to first visible token … ask the model to generate a short preamble before continuing with deeper reasoning."
- **Budget.** Reserve at least 25k tokens for reasoning plus output. Watch for `incomplete_details.reason:"max_output_tokens"`.
- **GPT-6 Astra behaviour.**
  - More likely to *ask the user* when input could change the outcome. OpenAI provides prompts to make it more autonomous, including "ask for approval only after preparing a concrete, reviewable result".
  - More sensitive to instructions in skill and AGENTS files, so audit them.
  - Delegates to subagents less often than desired unless prompted.

### B9. State, transport, long runs [V]

- **Background mode** (`background:true`):
  - poll `GET /responses/{id}` and cancel idempotently;
  - with `stream:true`, resume by `sequence_number` cursor;
  - data kept about 10 min for polling under ZDR or `store:false`;
  - webhooks on completion.
  ([background](https://developers.openai.com/api/docs/guides/background), [webhooks](https://developers.openai.com/api/docs/guides/webhooks))
- **WebSocket mode.**
  - Incremental inputs plus `previous_response_id` held in a connection-local cache; "up to roughly 40% faster" for runs with 20+ tool calls.
  - `stream_id` lanes multiplex conversations, with at most 16 in-flight responses and 32 named lanes. Forking a conversation onto a new lane is supported.
  - `generate:false` warm-up.
  ([websocket-mode](https://developers.openai.com/api/docs/guides/websocket-mode))
- **Compaction.** Server-side `context_management.compact_threshold` emits an opaque compaction item. The standalone `/responses/compact` endpoint is stateless and ZDR-friendly ([compaction](https://developers.openai.com/api/docs/guides/compaction)).
- **Agents API (2026).** A managed "Codex harness" with sessions, events and items, and a sandbox environment (none, OpenAI-hosted or self-hosted). Tool search, programmatic calling and compaction are managed by the harness ([agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)). **Agents SDK** approvals are *interruptions* carrying a resumable, serialisable `state`: approve or reject, then resume *the same run* ([guardrails-approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)).

### B10. Streaming event taxonomy (Responses) [V]

These are the events a UI can animate on (from the [streaming events reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)):

- **Lifecycle:** `response.created`, `in_progress`, `completed`, `incomplete`, `failed`.
- **Items:** `output_item.added` / `.done`.
- **Text:** `output_text.delta`, `output_text.annotation.added` (a citation arrives *during* streaming).
- **Reasoning:** `reasoning_summary_part.added`, `reasoning_summary_text.delta`, and `reasoning_text.delta` on open models.
- **Function tools:** `function_call_arguments.delta` / `.done`; `custom_tool_call_input.delta`.
- **Web search:** `web_search_call.in_progress | searching | completed`.
- **File search:** `file_search_call.in_progress | searching | completed`.
- **Code interpreter:** `code_interpreter_call.in_progress | interpreting | completed`, `code_interpreter_call_code.delta`.
- **Image generation:** `image_generation_call.in_progress | generating | partial_image | completed`.
- **MCP:** `mcp_list_tools.*`, `mcp_call.in_progress | completed | failed`, `mcp_call_arguments.delta`.
- **Shell:** `shell_call_command.added | delta | done`, `shell_call_output_content.delta`.
- **Other:** `compaction.compacting`, `refusal.delta`.

**Design takeaway [I]:** every hosted tool has a distinct *searching / interpreting / generating* sub-state. That is what lets ChatGPT's status line say "Searching…", then "Reading…", then "Generating image…" instead of a generic spinner.

### B11. ChatKit: OpenAI's reference UI model for agent chat [V]

([ChatKit](https://developers.openai.com/api/docs/guides/chatkit), [types.py](https://github.com/openai/chatkit-python/blob/main/chatkit/types.py), [update-client guide](https://github.com/openai/chatkit-python/blob/main/docs/guides/update-client-during-response.md))

- **Thread items:**
  - `user_message`, `assistant_message` (Markdown, annotations);
  - `client_tool_call`, `widget`, `generated_image` (with `generated_image.updated` for partials);
  - `task`, **`workflow`**, **`structured_input`** (pending, answered or skipped; multiple-choice or free-form);
  - `end_of_turn`, and hidden context items.
- **Workflow shape:**

  ```
  Workflow { type: "custom" | "reasoning"; tasks: Task[];
             summary?: { title, icon } | { duration /*s*/ }; expanded: boolean }
  Task = CustomTask{title,icon,content} | SearchTask{title,title_query,queries[],sources[URLSource]}
       | ThoughtTask{title,content} | FileTask{title,sources[FileSource]} | ImageTask{title}
  BaseTask.status_indicator: "none" | "loading" | "complete"
  URLSource{title,url,attribution,description,timestamp,group}
  ```

- **Stream events:** `thread.item.added/updated/done/removed/replaced`, `workflow.task.added/updated`, `progress_update` (transient, **not persisted**, replaced by the next item), `client_effect` (fire-and-forget UI), `error` (message plus retry flag), `notice`, `stream_options` (for example, allow user cancel).
- **Progress-update guidance:** "short, action-oriented messages … throttle updates to meaningful stages instead of every percent".
- **Client tools:** the server stops at a named tool, the client runs a callback, and the server resumes. One client tool call per turn.
- Agent Builder shuts down 2026-11-30; ChatKit continues.

---

## 5. Part C: Recommendations for Juno (prioritised)

Context from the Juno codebase (read-only survey on this branch):

- **Four hand-written tool loops**, each with `MAX_TOOL_ROUNDS = 6`: `src/lib/anthropic.ts:194`, `src/lib/openai-responses.ts:47`, `src/lib/openai-compat.ts:172` and `src/lib/gemini-core.ts:31`.
- The runtime tools are `browser_agent`, `read_document`, `inspect_image`, `code_interpreter` and `computer_use`, gated in `src/lib/chat/tool-policy.ts`. There is a native `start_task`.
- Connectors are MCP (at most 5 per turn).
- Web search is native per provider, with Tavily for research.
- Research tiers are `quick|standard|deep|max` (`src/lib/research/auto-effort.ts`, `docs/JUNO.md` §5.6).
- Thinking and tools render through `activity-timeline.tsx` (the inline strip) and `thought-process-panel.tsx` (the right dock, 1,647 lines) on top of `thought-process-model.tsx`.
- The Responses adapter already round-trips `encrypted_content` and forces `tool_choice:"none"` on the final round.

### C0. Where Juno diverges most from the ChatGPT pattern [I]

1. **No shared agent loop.** Each provider re-implements rounds, limits, error handling and event emission, so behaviour and failure modes differ per model. This is the most likely root cause of "tool calls don't work".
2. **A flat round cap (6) regardless of effort.** ChatGPT and OpenAI scale work with effort, the Power slider and `max_tool_calls`, and give the user "Answer now" and "Update".
3. **User-picked modes and depth names** (Research tier names, separate toggles). ChatGPT has moved to model-decided escalation (`handoff`, `start_research_task`) plus one continuous effort control.
4. **Missing tool families that ChatGPT treats as core:**
   - multi-action web (open, find, click, PDF page);
   - widgets;
   - visible versus private Python;
   - an image-generation *tool*;
   - memory tools;
   - chat-history search;
   - structured ask-user;
   - scheduled tasks;
   - plugin/tool discovery.
5. **No per-tool human copy or risk metadata** driving the UI (the invoking/invoked strings and the readOnly, destructive and openWorld hints).

### C1. P0: one provider-agnostic agent loop

Build `runAgentTurn(adapter, tools, policy)`. Each provider adapter implements a single `step(items) → stream of normalized events` and nothing else.

**The item log is the source of truth.** Persist it per assistant message. Mirror the Responses/ChatKit vocabulary:

```ts
type RunItem =
  | { kind: "reasoning"; id; summary: string[]; encrypted?: string; provider: ProviderId }   // round-trip opaque blobs per provider
  | { kind: "message"; id; phase: "commentary" | "final"; text; annotations: Citation[] }
  | { kind: "tool_call"; id; callId; tool: ToolId; title: string; args: unknown; status: "streaming_args"|"queued"|"running"|"done"|"error"|"denied"|"cancelled";
      startedAt; endedAt?; progress?: string; result?: ToolResultSummary; error?: { code; message; retryable } }
  | { kind: "approval"; id; callId; risk: "write"|"destructive"|"open_world"|"sensitive_data"; preview; decision?: "approved"|"denied"|"always_this_chat" }
  | { kind: "question"; id; inputs: StructuredInput[]; status: "pending"|"answered"|"skipped" }   // ChatKit StructuredInput
  | { kind: "plan"; id; steps: { id; text; status: "pending"|"active"|"done"|"skipped" }[]; editable: boolean }
  | { kind: "steer"; id; text; appliedAt? };                                                      // "Update"
```

**Loop rules.**

- **Budget by effort, not a constant.** Suggested rounds: quick ≈ 3, default ≈ 8, high ≈ 16, research runs in its own engine. Add wall-clock and cost ceilings. Per-tool timeouts: search 20 s, fetch 30 s, python 120 s, image 120 s, MCP 60 s.
- **Parallel execution of independent read-only calls** returned in the same round, using `Promise.allSettled` with concurrency around 4. Serialise writes and approval-gated calls. This follows OpenAI's parallel-call semantics.
- **Errors are results, not exceptions.** Return `{error:{code,message,retryable}}` to the model, just as MCP puts failures in `mcp_call.error`. The UI renders them as a failed step with Retry. After two consecutive failures of the same tool, remove it from `allowed` for the rest of the turn (the `allowed_tools` idea).
- **Duplicate-call guard.** The same tool plus normalised args within a turn returns the cached result. Juno Work already has a stall detector (`DEFAULT_STALL_THRESHOLD = 6`); reuse it in chat.
- **Final round.** Always offer the model a tools-off round with "answer with what you have; say what you could not verify". The same path implements **Answer now**: abort the in-flight step, keep completed items and reasoning, and run the final round.
- **Steering ("Update").** Queue the user's text. At the next item boundary, append it as a user message marked `steer`, then continue. This mirrors OpenAI's semantics: finish the current item and running hosted tools, never undo. Where the provider supports native steering (GPT-6 over WebSocket), use it.
- **Reasoning continuity.** Keep round-tripping provider-opaque reasoning (OpenAI `encrypted_content`, Anthropic thinking signatures) *in order* with the calls they led to. Add `phase` on assistant messages for the OpenAI Responses adapter.
- **Preambles.** Instruct models to emit one short commentary sentence before the first tool call of a round. It becomes the live status and cuts perceived latency; OpenAI documents it as a TTFT trick.
- **Cache discipline.** Keep the tool list stable across a conversation and narrow per turn with an allowlist rather than by rebuilding it (OpenAI `allowed_tools`), so the cached prefix survives.

### C2. Tools to add or rework

Keep **≤ 12–15 tools visible** at turn start (OpenAI suggests fewer than 20). Put connectors and rarely used families behind **namespaces with deferred loading**: a Juno-side `tool_search`, or native `tool_search` on gpt-5.4+ where the adapter supports it.

| Pri | Tool (model-facing id → user-facing title) | Why (ChatGPT/OpenAI precedent) | Notes |
|---|---|---|---|
| P0 | `web` with actions `search{queries[],recency?,domains?}`, `open{ref\|url,line?}`, `find{ref,pattern}`, `pdf_page{ref,page}` → "Searching the web" / "Reading {domain}" / "Looking in {domain}" | `web.run` [C]; API actions search/open_page/find_in_page [V] | One provider-agnostic tool fronting native search (Anthropic/Google/xAI) *or* Juno's crawler. Return reference ids (`s{turn}.{n}`) the model cites. Emit a `sources` list separately from citations (OpenAI `sources` vs `url_citation`). |
| P0 | `generate_image{prompt,edit_of?,size?,transparent?}` → "Creating image" | image_generation tool; partial images | Stream partial previews into a skeleton card; edits reference earlier image ids. |
| P0 | `python` (private) and `run_code` (visible) → "Analyzing data" / "Running code" | `python` vs `python_user_visible` [C]; code_interpreter [V] | The visible variant renders code, stdout, charts, interactive tables and file outputs as downloadable chips (`container_file_citation` analogue). The private variant only appears inside the thinking panel. |
| P0 | `ask_user{questions:[{id,question,type:"choice"\|"text",options?,multiple?}]}` → rendered as a question card | ChatKit `StructuredInput`; async ask-user [V]; shopping-research preference questions [P] | Replaces free-text clarification. At most 3 questions, always skippable. The answer is returned as the tool result. |
| P0 | `start_research{question,scope,plan_draft}` → "Research plan" card | `research_kickoff_tool` [C]; `local.handoff` [C] | Model-decided escalation. The user's "Research" chip just biases the model to call it. Replaces tier names (C7). |
| P0 | `user_context{}` (local time, timezone, coarse location if permitted) | `user_info` / `genui time` [C] | Cheap. Keeps the system prompt date-free (Juno already puts the date in a second block). |
| P1 | `memory.save/update/forget{fact,scope}` and `memory.search{query}` | `bio`, `personal_context` [C]; Codex keeps external-context chats out of memory [V] | Move off `<juno:memory>` tags on tool-capable models (strict schema, auditable), keeping the tag fallback. Skip memory writes on turns that ingested untrusted web or MCP content unless the user asked. |
| P1 | `search_chats{query,limit}` and `read_chat{id,range}` | "Reference chat history" [P]; `summary_reader` [C] | Lets the model pull earlier context on demand instead of preloading it. |
| P1 | `widget.search` / `widget.show` for weather, time, currency, units, calculator, stocks, sports | genui [C]; plugin inline cards [V] | Native Juno cards. The text answer must stand alone (ChatGPT rule). |
| P1 | `create_file{type:"docx"\|"pptx"\|"xlsx"\|"pdf"\|"md", spec}` → "Creating document" | Work deliverables and artifacts viewer [V] | Build on the sandbox. Open the result in the right panel's file viewer with annotation-to-edit. |
| P1 | `schedule{kind:"once"\|"cron"\|"event", when, prompt}` → "Scheduled task" | automations tool [C]; scheduled tasks and event triggers [V] | Needs a Scheduled hub page; Pulse's fate argues for explicit tasks over proactive feeds. |
| P1 | `visualize{spec}` (interactive chart, diagram or calculator) | Visualizations `@Visualize` [V] | Juno already has `data-chart-block` and `inline-visual-block`; expose them as a tool with a schema. |
| P1 | `find_tools{query}` over connector namespaces (client-executed tool search) | tool_search [V]; `api_tool.search_plugins` [C] | Lets up to 5+ connectors coexist without flooding context. |
| P2 | `browser` interactive (click, type) and `computer_use` behind approval | Work cloud browser [V] | Only in a Work-like run with site permissions (Always ask / Auto / Always allow), a secure sign-in form, and take-over. |
| P2 | Product and local-business lookups with card and carousel output | `product`/`business` commands [C]; shopping research [P] | Only if Juno targets those use cases. |

Keep `read_document` and `inspect_image`, which are good, scoped and read-only, but give them titles and status strings (C3).

### C3. P0: a tool metadata contract (drives the loop *and* the UI)

Every tool, whether native, runtime or MCP-mapped, declares:

```ts
interface ToolSpec {
  id: string;                        // model-facing, verb_noun, stable
  title: string;                     // "Search the web"
  description: string;               // starts "Use this when…", names non-uses, distinguishes siblings
  input: JSONSchema;                 // strict-compatible (all required, nullable optionals, additionalProperties:false)
  output?: JSONSchema;               // for structured results (enables programmatic/parallel use later)
  annotations: { readOnly: boolean; destructive: boolean; openWorld: boolean; idempotent?: boolean };
  status: { invoking: (args) => string; invoked: (args, result) => string };   // ≤ 64 chars, human, no tool names
  icon: IconName; display: "step" | "card" | "media" | "file" | "question";
  approval: "never" | "write" | "always";                                      // derived default from annotations
  timeoutMs: number; concurrency: "parallel" | "serial";
  namespace?: string; deferred?: boolean;
}
```

- For MCP tools, map the server's annotations. If they are missing, default to `openWorld:true, readOnly:false` so the tool requires approval. OpenAI defaults MCP to approval-required.
- **Evals.** Keep a golden prompt set per tool (direct, indirect and negative) and track precision and recall of tool selection, per OpenAI's metadata guide. Run it in CI against the four adapters so one loop behaves the same everywhere.

### C4. How tool calls should display (inline)

Adopt the **ChatKit Workflow** model as the single render primitive for "the model is working".

- **One workflow per assistant turn**, above the answer, containing ordered **tasks**: thought, search (queries plus favicon sources), read/open (domain), code, image, file, custom (connector), approval, question.
- **Live header.** Show the *current* task's `invoking` string with a shimmer and an elapsed timer, for example "Searching the web · 6s". When a commentary preamble exists, show it as a quiet line beneath.
- **Sources accrue visibly.** Favicons pop into a small stack (max 4 plus "+N"), the pattern ChatGPT uses in the trace and on the Sources button.
- **On completion, collapse to a summary chip.** A pure reasoning turn reads "Thought for 38s". A tool turn reads "Worked for 1m 12s · 14 sources · ran code". The chip is the button that opens the right panel. This is ChatKit's `DurationSummary` vs `CustomSummary`.
- **Cards and media sit outside the collapsed workflow** so they stay visible: generated images, charts and tables, file chips, widgets, approval and question cards. This follows OpenAI's inline rule that cards appear *before* the model's text, with the text following.
- **Never print tool ids.** Use titles and status copy. Show arguments only inside the panel's detail view, for example the query string or the code.
- **Error step.** Red dot and one-line reason ("Couldn't open nytimes.com — blocked"), with an inline **Retry** that re-queues the call. The model is told the error either way.
- **Approval card** (writes, destructive or open-world with user data), shown *before* execution:
  - human sentence plus a preview (recipient, subject, diff, URL);
  - buttons **Allow once / Always allow in this chat / Deny**;
  - the arguments are hidden until approval for widget-bearing tools (ChatGPT behaviour).
- **Question card** (`ask_user`): chips for options, a free-text field and **Skip**. While the question is pending, the loop may continue on independent work (the async ask-user pattern).

### C5. Thinking animation spec (uses Juno's motion tokens)

| State | Visual | Motion |
|---|---|---|
| Queued (0–400 ms) | A single dot placeholder aligned with the text baseline | Opacity 0→1, `duration-fast` (120 ms) `out-soft`. Nothing else, so fast answers never flash a "Thinking" label. |
| Thinking (no tool yet) | Label "Thinking" with a **text shimmer**: a gradient mask sweeping left to right across the glyphs | Loop about 1.8 s linear on a symmetric curve (Juno's `in-out` rule for loops). The elapsed counter fades in after **3 s**. |
| Tool running | Label becomes the tool's `invoking` string; icon swaps via `IconSwap`; favicons pop in | Label cross-fade `duration-base` (220 ms); new favicon scale 0.8→1 plus opacity over `duration-fast` with 30 ms stagger. |
| Writing | The workflow header collapses to its summary chip while text streams below | Height collapse via a layout spring (`spring.layout`, 360 ms, bounce 0) plus opacity; the caret blinks at 1 Hz on the last token. |
| Long run (> 10 s) | **Answer now** ghost button appears at the right of the header; **Stop** stays in the composer | Fade and slide 4 px, `duration-base`. |
| Needs input | Header turns accent colour with "Waiting for you"; the approval or question card slides in | `emphasis` (560 ms `out-expo`), used only here because the user did not cause it. Optional haptic or sound on native. |
| Done | Summary chip "Thought for 38s ›" | Chevron rotates on hover. |
| Stopped / error | Chip reads "Stopped after 12s" / "Couldn't finish" with Retry | No motion beyond a 120 ms fade. |

- **Reduced motion:** no shimmer sweep (static label with a slow 2 s opacity pulse, or none), no height springs (instant swap), no stagger.
- Never run a spinner *and* a shimmer at once. Pick one signal per surface.

### C6. Right sidebar ("Activity panel") rework

Replace the current thought dock with one **Activity panel** per assistant message. It opens from the summary chip, any citation chip, the Sources button, or a running task. Layout, top to bottom:

1. **Header.** Title (the live `invoking` text or "Thought for 38s"), elapsed time, model, and effort. **Answer now** and **Stop** show while running. Close (Esc).
2. **Plan** (research and long tasks only). A checklist with active, done and skipped states. Editable before start; read-only with status while running.
3. **Timeline.** Workflow tasks in order:
   - thought summaries as short paragraphs;
   - searches with their queries and result favicons;
   - "Read {domain}" rows that expand to the page title, a snippet and the *why*;
   - code blocks collapsed to their first line with output;
   - connector calls with their `invoked` text and expandable args and result JSON;
   - approvals and questions as history.

   Scroll-follow while running with a "Jump to latest" pill.
4. **Sources.** Two groups, matching ChatGPT and the API: **Cited** (in answer order, numbered) and **Also read** (the `sources` superset). Each row has favicon, title, domain, date, and "Cited N×". Hovering a row highlights the citation chips in the answer.
5. **Outputs.** Files, images and charts produced in the turn, with open-in-viewer.
6. **Update composer** (sticky footer while running): "Add details or change direction…". Sends a `steer`.

**Behaviour.**

- Desktop ≥1280 px: the panel *pushes* the transcript; 360–420 px wide and resizable.
- Below that: an overlay sheet from the right; on mobile, a bottom sheet at 90% height.
- Enter: slide 24 px plus fade, `duration-slow` (360 ms) `out-expo`. Exit: `duration-exit` (160 ms) `in`.
- Content swaps between messages without re-animating the shell.
- Deep link: `?activity=<messageId>`.
- Persist the open or closed state per conversation.
- Keyboard: `⌘.` toggles; `j`/`k` move between steps.

### C7. Deep Research rework (drop "Quick / Standard / Deep / Max")

Follow ChatGPT's Feb 2026 design and remove user-facing tiers entirely.

1. **Entry.** There are three ways in:
   - the model calls `start_research` when warranted;
   - the user adds the **Research** chip in the composer "+" menu;
   - the user types `/research`.

   No depth picker.
2. **Clarify** (optional, at most 3 questions). Use a question card (`ask_user`). Skip it when the prompt is already specific, as Juno's clarify endpoint already does.
3. **Plan card** (in the transcript, mirrored in the panel):
   - editable steps;
   - **Sources scope**: Web, plus toggles for Your files, Connectors, and "Only these sites"/"Prefer these sites" with domain chips;
   - an **estimate line** instead of a tier, such as "About 8–12 min · up to ~150 pages · est. cost €0.40", derived from `auto-effort.ts` scoring plus the model and effort slider;
   - buttons **Start research** and **Edit**.
4. **Run.**
   - Runs in the background worker (already the case).
   - Live progress sits in the Activity panel: plan checklist, current activity line, source counter, elapsed time.
   - **Update** steers mid-run.
   - **Stop & write report now** triggers synthesis with the evidence already gathered; it is the research form of Answer now.
   - **Keep going** extends the budget once, if the run ends near its ceiling.
5. **Report.**
   - Opens in a **fullscreen reader**: TOC on the left, citations column on the right, inline citation chips, and exports to MD, DOCX and PDF.
   - It becomes a referencable artifact in later turns (Juno already scopes it as context).
   - Notify with push, email or toast when the user has left, the way ChatGPT's Activity view and notifications do.
6. **Budget internals.** Keep the current `quick…max` budgets as *internal* presets chosen automatically. Surface only the estimate, and a continuous "More thorough ↔ Faster" slider inside **Advanced** when needed. Mirror OpenAI's `max_tool_calls` as the hard cap.
7. **Security.** Run in phases when private connectors are in scope (web first, then private without web), screen outbound URLs for exfiltration, and keep page text inside the untrusted envelope (already done).

### C8. Effort control: one slider, no names

- Replace named reasoning tiers in the UI with **Auto** (default) plus a **Faster ↔ Smarter** slider. This follows ChatGPT's Aug 2026 slider and the Work/Codex Power slider.
- On narrow screens, a single **Think** toggle.
- An **Advanced** disclosure exposes the exact model, effort and speed (OpenAI's "Advanced" pattern).
- Map slider stops to provider effort through the existing clamp logic (`reasoningCaps`).
- The slider also scales the tool-round budget (C1) and the research estimate (C7), so users learn one control.

### C9. Safety defaults (keep Juno's untrusted-content work and add these)

- **Derive approvals from annotations.** Writes and destructive actions always need approval. Open-world calls need approval when they would carry user data outward. Offer "Always allow in this chat" and never a global default (ChatGPT iOS supports per-chat and cross-chat MCP approval choices [V]).
- **No auto-render of URLs or images returned by tools** without a proxy, as OpenAI's MCP guidance warns. Keep the untrusted envelope on every tool result.
- **Phase private versus public work** for research and Work runs, following OpenAI's deep-research guidance.
- **Exclude untrusted-context turns from memory writes** unless the user asked (the Codex `disable_on_external_context` idea).
- **Credentials never pass through chat.** Any site sign-in uses a dedicated form or take-over, as ChatGPT Work does.

### C10. Suggested sequencing

1. **Week 1–2.** Unified loop plus item log (C1). Tool metadata contract (C3). Port the existing tools. Eval harness across the four adapters.
2. **Week 2–3.** Workflow rendering and animation (C4, C5). Activity panel (C6). Answer now and Update.
3. **Week 3–4.** P0 tools: `web` multi-action, `generate_image`, `run_code`/`python`, `ask_user`, `start_research`, `user_context`.
4. **Week 4–6.** Research rework (C7). Effort slider (C8).
5. **Then.** P1 tools: memory, chat search, widgets, `create_file`, schedule, visualize, `find_tools`.

---

## 6. Appendix

### 6.1 Tool inventory: ChatGPT consumer vs OpenAI API vs Juno

| Capability | ChatGPT consumer (2026) | OpenAI API | Juno today | Juno proposed |
|---|---|---|---|---|
| Web search | `web.run` multi-command [C]; Sources sidebar [P] | `web_search` (search/open/find, sources, filters) [V] | Native per provider plus `browser_agent` fetch; Tavily for research | `web` multi-action, provider-agnostic (P0) |
| Widgets | genui (weather, fx, calc, units, time, sports, jobs) [C] | plugins' inline cards [V] | none | `widget.*` (P1) |
| Private code | `python` [C] | code_interpreter / shell [V] | `code_interpreter` (attachment-gated) | `python` private (P0) |
| Visible code/files | `python_user_visible`, interactive tables [C]; artifacts viewer [V] | container files [V] | python execution block | `run_code` plus `create_file` (P0/P1) |
| Images | image_gen; viewer with comments [V] | image_generation, partials [V] | image edit overlay (UI) | `generate_image` tool (P0) |
| Files/RAG | file search, Library, projects [V/C] | file_search [V] | `read_document`, `inspect_image` | keep plus titles |
| Memory | bio, chat history, dreaming [C/P] | n/a | `<juno:memory>` tags | `memory.*`, `search_chats` (P1) |
| Integrations | plugins (skills + MCP + UI + hooks) [V]; api_tool discovery [C] | `mcp`, tool_search, Secure Tunnel [V] | MCP connectors ≤5 | namespaces plus `find_tools` (P1) |
| Ask user | clarify; shopping preference questions [P] | async ask-user pattern [V]; ChatKit StructuredInput [V] | clarify endpoint (pre-turn) | `ask_user` in-loop (P0) |
| Research | Deep research in Work, plan/scope/update/viewer [P/V] | o3/o4-mini-deep-research, background, max_tool_calls [V] | tiers quick…max, plan, worker | tierless flow (C7) |
| Agent/browser | Work cloud browser, approvals, take-over [V] | computer tool / code-exec CUA [V] | `computer_use`, Work runs | P2 behind approvals |
| Scheduling | Scheduled plus event triggers [V] | n/a | none in chat | `schedule` (P1) |
| Visualizations | `@Visualize` [V] | n/a | chart and visual blocks | `visualize` tool (P1) |
| Mode escalation | `local.handoff` to Work [C] | n/a | `start_task` | `start_research` plus existing `start_task` |

### 6.2 Status copy examples (≤64 chars, OpenAI invoking/invoked style) [I]

| Tool | invoking | invoked |
|---|---|---|
| web.search | Searching the web for "{q}" | Searched {n} queries |
| web.open | Reading {domain} | Read {domain} |
| web.find | Looking for "{pattern}" on {domain} | Found {k} matches on {domain} |
| python (private) | Checking the numbers | Checked the numbers |
| run_code | Running code | Ran code · {status} |
| generate_image | Creating image | Created image |
| read_document | Reading {file}, pages {a}–{b} | Read {file} |
| inspect_image | Looking closer at {file} | Zoomed into {region} |
| memory.save | Saving to memory | Saved to memory |
| connector (MCP) | {Connector}: {tool title} | {Connector}: {short result} |
| start_research | Drafting a research plan | Research plan ready |

### 6.3 Source list (primary)

**OpenAI API guides** (all fetched 2026-09-23 via `.md`):

- [function-calling](https://developers.openai.com/api/docs/guides/function-calling), [tools](https://developers.openai.com/api/docs/guides/tools), [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling), [steering](https://developers.openai.com/api/docs/guides/steering)
- [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [file search](https://developers.openai.com/api/docs/guides/tools-file-search), [code interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter), [computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [image generation](https://developers.openai.com/api/docs/guides/tools-image-generation), [MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [shell](https://developers.openai.com/api/docs/guides/tools-shell), [apply patch](https://developers.openai.com/api/docs/guides/tools-apply-patch), [skills](https://developers.openai.com/api/docs/guides/tools-skills)
- [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [latest model (GPT-6)](https://developers.openai.com/api/docs/guides/latest-model), [background](https://developers.openai.com/api/docs/guides/background), [websocket mode](https://developers.openai.com/api/docs/guides/websocket-mode), [compaction](https://developers.openai.com/api/docs/guides/compaction), [citation formatting](https://developers.openai.com/api/docs/guides/citation-formatting), [deep research](https://developers.openai.com/api/docs/guides/deep-research)
- [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [guardrails & approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals), [ChatKit](https://developers.openai.com/api/docs/guides/chatkit), [custom ChatKit](https://developers.openai.com/api/docs/guides/custom-chatkit), [ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets), [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)

**ChatKit source:** [types.py](https://github.com/openai/chatkit-python/blob/main/chatkit/types.py), [threads](https://github.com/openai/chatkit-python/blob/main/docs/concepts/threads.md), [stream events](https://github.com/openai/chatkit-python/blob/main/docs/concepts/thread-stream-events.md), [update client](https://github.com/openai/chatkit-python/blob/main/docs/guides/update-client-during-response.md)

**Plugins / Apps SDK:** [reference](https://developers.openai.com/plugins/reference), [UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines), [define tools](https://developers.openai.com/plugins/plan/tools), [optimize metadata](https://developers.openai.com/plugins/guides/optimize-metadata), [app guidelines](https://developers.openai.com/plugins/app-guidelines)

**ChatGPT product docs:**

- [use-chatgpt](https://learn.chatgpt.com/docs/use-chatgpt), [get-started-with-work](https://learn.chatgpt.com/docs/get-started-with-work), [long-running-work](https://learn.chatgpt.com/docs/long-running-work), [permission modes](https://learn.chatgpt.com/docs/permission-modes), [notifications](https://learn.chatgpt.com/docs/notifications), [browser](https://learn.chatgpt.com/docs/browser)
- [visualizations](https://learn.chatgpt.com/docs/visualizations), [work with files](https://learn.chatgpt.com/docs/artifacts-viewer), [image generation](https://learn.chatgpt.com/docs/image-generation), [web search](https://learn.chatgpt.com/docs/web-search), [models](https://learn.chatgpt.com/docs/models), [scheduled tasks](https://learn.chatgpt.com/docs/automations), [memories](https://learn.chatgpt.com/docs/customization/memories), [plugins](https://learn.chatgpt.com/docs/plugins), [what's new](https://learn.chatgpt.com/docs/whats-new)

**Press:** as cited inline in §2 and §3.

**Community-extracted prompts [C]:**

- [gpt-5.6-sol.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/gpt-5.6-sol.md)
- [tool-deep-research.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/tool-deep-research.md)
- [chatgpt-gpt-5-agent-mode.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/chatgpt-gpt-5-agent-mode.md)

### 6.4 Known gaps in this audit

- The help center and openai.com were blocked (403). The exact wording of the current ChatGPT release notes, and the help pages on deep research, "GPT-5.6 and GPT-6 Pro in ChatGPT" and memory, are known only from search snippets.
- The pixel-level Chat UI while tools run is not officially documented in 2026. Examples: exact label strings ("Searching the web", "Reading N sources"), the shimmer spec, and when "Answer now" appears. The anatomy in A2 and C5 is a synthesis [I] and should be checked against a live account before the UI is final.
- Whether Chat, as opposed to Work, still exposes a visible Python tool UI after the May 2026 Canvas removal is unconfirmed. The extracted Sol prompt still has `python_user_visible` [C].
