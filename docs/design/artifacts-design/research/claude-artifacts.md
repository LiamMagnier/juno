# Claude Artifacts: the platform, how it evolved, and the artifact UI/UX

Lens notes for the Juno Artifacts + Design merge. Compiled 2026-09-23.

This builds on `docs/design/artifacts-design/research/claude-primary-evidence.md` (the "lead evidence"). That file is authoritative for today's typed artifacts: the Design, Design System, Docs and Slides types, runtime capabilities, the contract version, file layouts and caps. These notes do not re-derive it. They add the history, the UI/UX anatomy, motion, sharing and governance flows, limits, and user complaints, and they point back to the lead evidence where it covers something.

**Confidence tags** on every claim:
- **[P] primary**: the vendor's own material. That covers anthropic.com, claude.com (blog, docs), support.claude.com, code.claude.com, the Claude Code CHANGELOG, official X posts, and first-hand Artifact tool output.
- **[S] secondary**: press, reviews and teardowns.
- **[C] community**: Hacker News and blogs by users.
- **[I] inferred**: my reading, or a detail that is widely described but that no dated source here confirms.

Help-center articles fetched on 2026-09-23 all read "Updated this week", so they describe the state after the merge.

---

## 1. TL;DR for Juno

1. **Anthropic took 27 months to go from "a side panel for code" to "every made thing is a typed, hosted, versioned web page at one private link".** The stages:
   - A chat-coupled preview pane (June 2024).
   - Publish to a public URL, plus remix (July 2024).
   - A gallery and AI-powered apps (June 2025).
   - Storage and MCP (Oct 2025).
   - Cowork "live artifacts" (Apr 2026), Claude Design (Apr 2026), and hosted artifacts in Claude Code (June 2026).
   - One "updated artifacts system" (Aug 19 2026).
   - The chat, Cowork and Artifacts merge (Sep 16 2026), with Docs, Slides and Design as typed artifacts.

   The key step toward the merge was **decoupling the artifact from the message**. In the new experience, "everything you make is saved to the Artifacts tab automatically". The old chat artifacts needed "Publish" to exist outside the chat ([help: What are artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), 2026-09 [P]). This matches the Juno audit's precondition: first-class artifacts that are decoupled from messages.
2. **The UI grammar has stayed the same since 2024.**
   - A card in the thread opens a split pane: the conversation on the left is the reasoning trail, and the artifact on the right is the product.
   - The pane has Preview and Code, versions, copy and download, and a share control.
   - The model decides when to make an artifact. An explicit "Output" picker was added only in 2026.

   Selecting part of an artifact to edit it arrived in four waves:
   - "Improve" and "Explain" in the code view (2024).
   - "Edit with Claude" for Markdown.
   - Inline edits of drafts (June 12 2026).
   - Element selection and comments on the Design canvas (2026).
3. **Sharing grew from a binary Publish into a document-style share dialog.** The dialog has:
   - an audience: Only you, Only people with access, Everyone in org, or Anyone with link;
   - roles: Can view, Commenter, Can edit;
   - external email invites;
   - a **version pin** ("Always share latest version", or "Sharing version 2").

   Comments on a shared artifact can be **sent to Claude**, and the agent session that published the page replies in the thread. That closes the loop between people and the agent.
4. **Complaints repeat across generations:**
   - full rewrites, and streaming that "deletes every line before rewriting";
   - truncated outputs that render blank;
   - silent data loss (drafts don't persist storage; unpublish deletes data; localStorage is blocked);
   - sandbox limits;
   - confusion between legacy and new artifacts;
   - weak editing on mobile;
   - Design and Docs shipping without version history;
   - abuse of public pages (a malware campaign in Feb 2026).
5. **Motion is barely documented by Anthropic.** What is documented:
   - pages refresh in place on republish;
   - inline cards expand to fullscreen smoothly, and closing returns to the same scroll position;
   - skeletons, not spinners;
   - Slides transitions (fade, push, magic) and build-ins (fade, rise, pop);
   - live presence (room).

   No durations or easing curves for the claude.ai panel are published. Treat anything more specific as inferred.

---

## 2. Timeline

| Date | Event | Confidence and source |
|---|---|---|
| 2024-03-21 | Alex Tamkin builds the first Artifacts prototype in Streamlit. The demo is an 8-bit crab game, "Claw'd". | [S] [Pragmatic Engineer, How Anthropic built Artifacts](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts), 2024-08-27 |
| 2024-06-20 | Artifacts ship as a feature preview with Claude 3.5 Sonnet. Content appears "in a dedicated window alongside their conversation". | [P] [Introducing Claude 3.5 Sonnet](https://www.anthropic.com/news/claude-3-5-sonnet), 2024-06-20 (US launch day; the anthropic.com page itself displays "Jun 21, 2024") |
| 2024-06-23 | Reverse engineering finds the sandbox at `www.claudeusercontent.com`, postMessage from the parent, React Runner, and cdnjs as the only external script host. | [C] [Reid Barber](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts), 2024-06-23 |
| 2024-07-09 | **Publish and remix.** Artifacts get a public URL on `claude.site`, and viewers can "Remix" into a new conversation. | [P] [Anthropic on X](https://x.com/AnthropicAI/status/1810698780263563325); [C] [Simon Willison](https://simonwillison.net/2024/Jul/9/claude-share-artifacts/), 2024-07-09 |
| 2024-08-27 | **General availability** on Free, Pro and Team. Artifacts can be created and viewed on **iOS and Android**. "Tens of millions" created. Team users share inside Projects. | [P] [Artifacts are now generally available](https://claude.com/blog/artifacts) (this URL returned 404 on 2026-09-23); [S] [VentureBeat](https://venturebeat.com/ai/anthropic-launches-claude-artifacts-generally-for-all-users-mobile), 2024-08-27 |
| 2024-09-02 (article date) | **Highlight to edit** in the Code view: "Improve" opens a text box for the requested change; "Explain" sends the selection to chat. At that point Improve still **regenerated the whole artifact**: the article says it "recreates the entire code with the necessary changes". | [S] [Tom's Guide](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text), published 2024-09-02 |
| ~late 2024-10 | **Targeted updates** replace full regeneration. The model picks create, update (string replace) or rewrite, and waits fall 3 to 4 times. Rui Quintino spotted it after the October 2024 "improved Claude 3.5 Sonnet" release. | [C] [Rui Quintino, "Replace Is All You Need"](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113), 2024-11-02 (date from the Medium RSS feed). [Hyperdev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact) is dated **2025-10-24** and wrongly places the change in "October 23-24, 2025", so treat it as an unreliable secondary. |
| 2024-10-21 | Simon Willison publishes "Everything I built with Claude Artifacts this week" (HN: 637 points, 465 comments). He praises the speed and criticizes the sandbox limits. | [C] [simonwillison.net](https://simonwillison.net/2024/Oct/21/claude-artifacts/) |
| 2025-05-29 | TestingCatalog previews an "Artifacts Gallery" with the categories All, Learn something, Life hacks, Play a game, Be creative, Touch grass, plus "My artifacts". | [S] [TestingCatalog](https://www.testingcatalog.com/upcoming-claude-feature-lets-users-explore-and-share-ai-generated-artifacts/), 2025-05-29 |
| 2025-06-25 | **AI-powered artifacts and an artifacts space in the sidebar** (browse, customize, organize). Viewers sign in and usage counts "against their subscription, not yours". "Over half a billion artifacts" created. Launched for Free, Pro and Max. The API name `window.claude.complete()` comes from Simon Willison's reading of the system prompt, not from Anthropic's posts. | [P] [Build and share AI-powered apps](https://claude.com/blog/claude-powered-artifacts) and [Turn ideas into AI-powered apps](https://claude.com/blog/build-artifacts); [C] [Simon Willison](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/), 2025-06-25. The claude.com copy of the first post now shows "July 25, 2025", but it first ran on anthropic.com on 2025-06-25 ([HN 44379673](https://news.ycombinator.com/item?id=44379673)). |
| 2025-07-17 | Users can upload PDFs, images and more into AI-powered artifacts. | [P] [claude-powered-artifacts, update note](https://claude.com/blog/claude-powered-artifacts) ("Upload PDFs, images, and more into your artifact. (July 17, 2025)"); [S] [AlternativeTo](https://alternativeto.net/news/2025/8/claude-artifacts-update-upload-pdfs-images-and-code/) reported it on 2025-08-01 |
| 2025-07-21 | AI-powered artifacts reach the iOS and Android apps. | [P] [build-artifacts, update note](https://claude.com/blog/build-artifacts) |
| 2025-07-31 | AI-powered artifacts reach Team and Enterprise. | [P] same |
| 2025-08-21 | Embed codes for published chat artifacts (Free, Pro, Max), limited to an allowed-domains list. | [P] [Release notes](https://support.claude.com/en/articles/12138966-release-notes); [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) |
| 2025-09-29 | "Imagine with Claude": a 5-day Max-only research preview at claude.ai/imagine that generated software on the fly. It is the ancestor of inline visuals. | [P] [Claude Sonnet 4.5](https://www.anthropic.com/news/claude-sonnet-4-5), 2025-09-29 |
| 2025-10-21 | **MCP and persistent storage** in artifacts, for Pro, Max, Team and Enterprise on web and desktop. 20 MB per artifact, personal or shared, text only, published artifacts only. | [P] [build-artifacts update](https://claude.com/blog/build-artifacts); [P] [help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) |
| 2026-01-12 | Cowork research preview on Claude Desktop for macOS. | [P] [Release notes](https://support.claude.com/en/articles/12138966-release-notes) |
| 2026-02 | Public artifacts are abused for "ClickFix" malware. A page on `claude.ai/public/artifacts/...` titled "macOS Knowledge Base: Secure Command Execution" is pushed through compromised Google Ads accounts and tells users to paste a base64 command into Terminal (MacSync infostealer; the report counts 15,600+ exposed users across two variants). | [S] [Anvilogic](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse), 2026-02-19; [HN](https://hn.algolia.com/api/v1/search?tags=story&query=claude%20artifacts%20clickfix) submission 2026-02-24 |
| 2026-03-12 | **Inline interactive visuals.** Charts, diagrams and widgets render inside the reply rather than the side panel. They are ephemeral. All plans, on by default. Reached Cowork 2026-04-22. | [P] [Claude builds visuals](https://claude.com/blog/claude-builds-visuals), 2026-03-12 |
| 2026-04-17 | **Claude Design** (Anthropic Labs research preview, paid plans). A canvas plus chat, inline comments, direct edits, sliders Claude builds itself, design systems taken from code and design files, and a handoff bundle for Claude Code. | [P] [Introducing Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs); [S] [TechCrunch](https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/), 2026-04-17 |
| 2026-04-20 | **Cowork "live artifacts"**: "dashboards and trackers connected to your apps and files. Open one any time and it refreshes with current data." The claim of no token cost on refresh is (unverified): neither the post nor blockchain.news says it. | [P] [@claudeai on X](https://x.com/claudeai/status/2046328619249684989), posted 2026-04-20 20:42 UTC; [S] [blockchain.news](https://blockchain.news/ainews/claude-cowork-update-live-artifacts-for-real-time-dashboards-and-trackers-2026-analysis) |
| 2026-06-12 | Claude's drafts can be **edited inline** in chat and Cowork: highlight a passage, type an instruction, and the draft opens beside the chat. | [P] [Release notes](https://support.claude.com/en/articles/12138966-release-notes) |
| 2026-06-14 | A third-party UX teardown of the artifact split pane. | [S] [AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) |
| 2026-06-18 | **Artifacts in Claude Code**, beta for Team and Enterprise. Live, shareable pages built from a session (PR walkthroughs, dashboards), updated in place, with version history and a gallery. At launch they were "viewable only by authenticated members of your org and cannot be made public"; public links and Pro and Max came later. | [P] [Claude Code now supports artifacts](https://claude.com/blog/artifacts-in-claude-code); [S] [VentureBeat](https://venturebeat.com/data/anthropics-claude-code-artifacts-update-brings-live-shared-dashboards-and-interactive-workspaces-to-enterprises), 2026-06-18 |
| 2026-07-07 | Cowork reaches web and mobile, and runs sessions remotely (beta). "Chat and Cowork also share one home now, with one place for your projects and artifacts across both." This is the first step toward the September merge. | [P] [Release notes](https://support.claude.com/en/articles/12138966-release-notes) |
| 2026-08-19 | **"Updated artifacts system."** New Cowork artifacts are saved to the account, shareable in the org, and open on the web. Live artifacts can no longer be created; old ones stay viewable but cannot be edited, and must be republished to change. | [P] [Use artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) |
| 2026-08-06 | Pluto Security reports that "10 of 85 attempts got synthetic credentials into a published page", because nothing inspects a page before it ships. The report did not test runtime capabilities. Separately, Claude Code v2.1.265 (dated 2026-09-08 by the same blog) began treating pages written by others as untrusted when reading them. | [S] reported by [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is), 2026-09-13; [P] [CHANGELOG 2.1.265](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md). The Pluto report itself was not read. |
| 2026-09-13 | A blogger finds artifacts that "save themselves" plus a shared real-time db, room presence and comments routed to Claude. | [C] [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is), 2026-09-13 |
| 2026-09-16 | **The merge.** Chat, Cowork and Artifacts become one interface. Claude Docs and Slides launch in beta, and Claude Design works inside conversations. "One shareable link you can open on your phone." | [P] [Claude Cowork and chat are now one Claude](https://claude.com/blog/cowork-is-now-claude); [S] [TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/); [S] [Engadget](https://www.engadget.com/2259938/anthropics-claude-can-now-create-editable-documents-for-you-cowork-chat-together/), 2026-09-16 |
| 2026-09 (inferred; the CHANGELOG has no dates) | Claude Code Artifact tool hardening:<br>- browser-tab icons chosen by Claude (2.1.268), then a one-word tab icon instead of an emoji favicon (2.1.275);<br>- watching up to 10 artifacts, up from 5 (2.1.271);<br>- db updates that remove a single field (2.1.273);<br>- publish and read results that say who can open the page (2.1.275);<br>- a scrollbar on the `/artifacts` list (2.1.280). The `/artifacts` command itself dates from v2.1.208 ([docs](https://code.claude.com/docs/en/artifacts)). | [P] [Claude Code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) |

URL generations are themselves a UX artifact:
- `claude.site/artifacts/{id}` (2024, [HN example 2025-01](https://claude.site/artifacts/27bc7ead-0598-495d-a389-b48faa04ed5b)).
- `claude.ai/public/artifacts/{id}` (2025, [HN example 2025-06](https://claude.ai/public/artifacts/3cebb65f-a869-4dd8-9a89-63513e4830f7)).
- `claude.ai/artifact/{id}` and `claude.ai/code/artifact/{uuid}` (2026, lead evidence and [Claude Code docs](https://code.claude.com/docs/en/artifacts)).

The gallery lives at `claude.ai/code/artifacts`. **[P]/[C]**

---

## 3. Platform evolution in detail

### 3.1 Launch (June 2024): a preview pane coupled to chat

- **Why it exists.** Tamkin wanted to "taste the sauce" immediately instead of copy-pasting generated websites. The team's own words: "When you can see something immediately on the screen, things just 'click'". Michael Wang's view: "A huge chunk of Artifacts is 'just' presentational UI. The heavy lifting is happening in the model itself" ([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts), 2024-08-27 [S]).
- **Team and time.** About one full-time engineer and one part-time, over three months (March 21 to June 20). It was in internal dogfood within about 1.5 weeks. Stack: React, Next.js, Tailwind, Node ([same](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts) [S]).
- **Security model.** "iFrame sandboxes with full-site process isolation" plus strict CSPs ([Simon Willison summarizing Pragmatic Engineer](https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts/), 2024-08-28 [C]):
  - the iframe origin is `www.claudeusercontent.com`;
  - code arrives by `postMessage`;
  - React runs through React Runner, with Tailwind, Radix primitives, Lucide, DOMPurify and react-zoom-pan-pinch bundled (Reid Barber);
  - cdnjs is the only external script host ([Reid Barber](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts), 2024-06-23 [C]).
- **Content types.** The type identifiers used at launch are not publicly documented. The help center lists common artifact content today: documents (Markdown or plain text), code snippets, single-page HTML websites, SVG images, diagrams and flowcharts, and interactive React components ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), 2026-09 [P]).
- **Deciding whether to make one.** The help center gives the criteria Claude applies ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), 2026-09 [P]):
  - significant and self-contained, "typically over 15 lines";
  - likely to be edited, iterated on or reused outside the conversation;
  - complex enough to stand on its own without extra conversation context;
  - likely to be referred back to or used later.

### 3.2 Publish and remix (July 2024)

- Publishing puts a snapshot on a separate public site (`claude.site`). Anyone can open it, and a Remix action opens it in a new Claude conversation for modification ([Simon Willison](https://simonwillison.net/2024/Jul/9/claude-share-artifacts/), [TestingCatalog](https://www.testingcatalog.com/claude-ai-update-enables-public-sharing-and-remixing-of-artifacts-2/), 2024-07-09 [C]/[S]).
- A community gallery (madewithclaude.com) appeared quickly afterwards (unverified: aiwiki returned HTTP 429). Anthropic only shipped an official gallery 11 months later ([aiwiki](https://aiwiki.ai/wiki/claude_artifacts) [S]).
- **Publish flow for today's legacy chat artifacts.** Open the artifact, check the version, click **Publish**, and copy the public link. It is available on Free, Pro and Max only, "previous experience chat artifacts" ([help: Publish and share](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts), 2026-09 [P]).
- The publish modal shows the title and the Usage Policy. It says: "Publishing this Artifact will make it accessible to anyone on the internet and potentially visible in search engine results. Your chat will remain private." It has a **"Publish & copy link"** button, and the URL is copied automatically ([ai-toolbox guide](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026), published 2026-05-31, updated 2026-09-16 [S]).
- On Team and Enterprise, legacy chat artifacts use **"Share & copy link"** (org-internal by default) instead of Publish. Viewers "also get access to any attachments and files in the conversation that created it". After publishing, **"Get embed code"** produces an embed snippet, limited to an "Allowed domains" list ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).
- The modal warns that "the artifact becomes public while the chat stays private" ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/), 2026-06-14 [S]).
- **The link is version-specific.** "Link is specific to the version of the artifact you shared" ([Anthropic Academy tutorial](https://academy.claude.com/tutorials/prototype-ai-powered-apps-with-claude-artifacts) [P]).
- **Remix today is "copy the code, create new".** Under "Build on a published artifact", the help says: click "Copy", start a new chat, paste the code and describe the changes; "Your version is separate from the original" ([help: Publish and share](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]). The claim that the Academy tutorial shows a **Customize** label is (unverified): a fetch of the tutorial found no such label. The June 2025 blog does promise to "customize existing creations in minutes" ([build-artifacts](https://claude.com/blog/build-artifacts) [P]).
- **Unpublish is destructive.** Unpublishing permanently deletes the storage data, and the same artifact cannot be republished ([help: Publish and share](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).

### 3.3 GA, mobile and the first selection-to-edit (Aug to Oct 2024)

- GA on 2024-08-27 across Free, Pro and Team; before that it was a feature preview users had to switch on. Artifacts can be created and viewed on iOS and Android. Alex Albert: "We're nearing the era of mobile apps created in real-time by LLMs." Team users share artifacts inside Projects ([VentureBeat](https://venturebeat.com/ai/anthropic-launches-claude-artifacts-generally-for-all-users-mobile), 2024-08-27 [S]).
- **Improve and Explain.** In the Code view, highlighting text pops up two actions.
  - **Improve** opens a small text box where you type the change. It is scoped by the selection, but at the time Claude still "recreates the entire code with the necessary changes" rather than editing only that line. (An earlier version of these notes said the opposite, which was wrong.)
  - **Explain** sends the selection to the chat, which explains it line by line.
  - Only the code could be highlighted, not the preview.

  Source: [Tom's Guide](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text), 2024-09-02 [S].
- **Try fixing with Claude.** When an artifact throws, a "Try fixing with Claude" button near the error message will "automatically copy the error details into a new message", which you then send ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). A dedicated help article, 9949260, existed (ja/fr variants are indexed); the English URL returned 404 on 2026-09-23.
- **Targeted updates.**
  - The earlier behaviour regenerated everything, even for a one-line change.
  - After the change, Claude chooses create, update (old string to new string) or rewrite. An update "must match exactly once in the artifact".
  - Rui Quintino measured "a 3-4x reduction in waiting time", and users saw "live preview changes visible in real-time".
  - Complaints: no official documentation, and some older chats did not get the fast path. (The Hyperdev complaint about manual edits in diff viewers being discarded concerns Claude Code's IDE diff flow, GitHub issue #1317, not claude.ai artifacts. It has been removed from this list.)

  Sources: [Rui Quintino, "Replace Is All You Need"](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113), 2024-11-02 [C] (read through the Medium RSS feed); [Hyperdev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact), 2025-10-24 [S]. Hyperdev misdates the change to October 2025 and mixes Claude Code with claude.ai, so use it with care.

### 3.4 Gallery and AI-powered artifacts (June to Aug 2025)

- **The artifacts space.** A sidebar entry for Free, Pro and Max. You can "browse curated artifacts for inspiration", "customize existing creations in minutes", and "organize everything in one dedicated space" ([build-artifacts](https://claude.com/blog/build-artifacts), 2025-06-25 [P]). Its two halves are **your artifacts** (created or remixed) and **Inspiration**, grouped by category ([TestingCatalog](https://www.testingcatalog.com/upcoming-claude-feature-lets-users-explore-and-share-ai-generated-artifacts/), 2025-05-29 [S]).
- **Library cards** show the name, the last-edited date, a **view count** for published artifacts, a **Published** tag, and a three-dot menu on hover ([ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026), 2026-09-16 [S]).
- **`window.claude.complete(prompt)`.** A string-in, string-out call from artifact JS to Claude. The name is known from the system prompt as quoted by Simon Willison [C]. Anthropic's own posts only say "Use a Claude API within your artifacts" and "Limited to a text-based completion API" [P].
  - There is no conversation state; history must be serialized into each prompt.
  - The tool prompt tells the model to test prompts in the analysis tool first, and to be emphatic about JSON-only output ("put things in all caps").

  Source: [Simon Willison](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/), 2025-06-25 [C].
- **Viewer-pays economics.**
  - Published apps are publicly viewable.
  - "The moment your app tries to execute a prompt the current user will be required to sign into their own Anthropic account." Usage counts against the **viewer's** plan ([same](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/) [C]; [claude-powered-artifacts](https://claude.com/blog/claude-powered-artifacts) [P]).
  - Limits at launch: no external API calls, no persistent storage, text-only completion ([claude-powered-artifacts](https://claude.com/blog/claude-powered-artifacts) [P]).
  - Today, non-users can view a published chat artifact without signing up. They are "prompted to sign up only for advanced features", and they use their own connected apps ([help: Publish and share](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).
- Platform growth: file uploads into apps on 2025-07-17 ([claude-powered-artifacts update note](https://claude.com/blog/claude-powered-artifacts) [P]; reported by [AlternativeTo](https://alternativeto.net/news/2025/8/claude-artifacts-update-upload-pdfs-images-and-code/) on 2025-08-01 [S]), iOS and Android on 2025-07-21, and Team and Enterprise on 2025-07-31 ([build-artifacts](https://claude.com/blog/build-artifacts) [P]).

### 3.5 Persistent storage and MCP (Oct 21 2025)

- **Storage.** A `window.storage` API ([BlockSecCA repo](https://github.com/BlockSecCA/claude-artefact-storage) [C]).
  - Up to **20 MB per artifact**, **text only**.
  - **Personal** storage keeps each user's data private, even from the creator. **Shared** storage means all users see the same data, and first-time visitors get a **warning dialog**.
  - Only published artifacts persist data, and unpublishing deletes it ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]; [Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]).
  - **Silent failures**:
    - in a draft artifact, storage operations "will not succeed until the artifact is published" ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]), and the UI shows no error ([Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data), 2026-06-12 [C]);
    - localStorage and sessionStorage in legacy chat artifacts are blocked, and "the writes fail without a visible error" ([Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]). This is disputed: the ai-toolbox guide says Preview persists state "via localStorage" [S]. For the **new hosted artifacts** the Claude Code Artifact tool contract (first-hand, 2026-09-23) says localStorage, sessionStorage and IndexedDB work per artifact origin but may come back empty [P];
    - unpublishing deletes both personal and shared data with no recovery ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]; [Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]).
- **MCP.** Artifacts call connectors such as Asana, Calendar and Slack, and each user authenticates independently ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).

### 3.6 Cowork live artifacts, inline visuals, Claude Design, inline drafts (Jan to Jun 2026)

- **Live artifacts in Cowork (2026-04-20).** A self-contained HTML page connected to apps and files that "refreshes with current data" each time it opens ([@claudeai](https://x.com/claudeai/status/2046328619249684989) [P]; [blockchain.news](https://blockchain.news/ainews/claude-cowork-update-live-artifacts-for-real-time-dashboards-and-trackers-2026-analysis) [S]). The phrase "with no prompt and no token cost on the refresh" is (unverified): neither cited source contains it.
- **Inline visuals (2026-03-12)** are deliberately *not* artifacts.
  - They "appear in-line, rather than in a side panel, and they're temporary—they change or disappear as the conversation evolves".
  - Artifacts are "permanent tools and documents created by Claude, designed to be shared or downloaded as more polished work".
  - (The earlier quotes "ephemeral conversational aids" and "render between paragraphs" are not in the blog and have been removed.)

  Source: [Claude builds visuals](https://claude.com/blog/claude-builds-visuals) [P].

  Community reactions ([HN 47352751](https://news.ycombinator.com/item?id=47352751), 2026-03 [C]):
  - praise for a "diagram slowly animating to life";
  - confusion ("intermittently getting artifacts vs new visuals API", data-ottawa);
  - "why not an artifact for shareability?" (razerbeans);
  - trust risk ("nice-looking chart makes output feel more trustworthy", programmertote).

  At first they were not available on iOS or Android ([MakeUseOf](https://www.makeuseof.com/tried-claudes-new-interactive-visuals/), 2026-03-17 [S]).
- **Claude Design (2026-04-17).**
  - Powered by Claude Opus 4.7, a research preview for Pro, Max, Team and Enterprise (off by default on Enterprise).
  - Layout: a canvas plus chat. You refine "through conversation, inline comments, direct edits, or custom sliders (made by Claude)". You can "Comment inline on specific elements, edit text directly, or use adjustment knobs to tweak spacing, color, and layout live" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P]).
  - Sharing is org-scoped (private, view, or edit) with group conversations.
  - Export: an internal URL, a folder, Canva, PDF, PPTX, standalone HTML, and a handoff bundle to Claude Code.

  The lead evidence covers the internals (artboards as `.dc.html`, tweaks, Play mode).
- **Inline editing of drafts (2026-06-12).** "Edit Claude's drafts inline within chat and Cowork". A draft (report, plan or brief) "opens right beside your chat"; highlight a passage, type an instruction, and Claude edits in place ([Release notes](https://support.claude.com/en/articles/12138966-release-notes) [P]; [Suprmind](https://suprmind.ai/hub/claude/features/) [S]).

### 3.7 Artifacts in Claude Code (June 18 2026 to now)

All points below are from [code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts), 2026-09 [P], unless noted.

- **What an artifact is.** A "live, interactive web page" that Claude Code publishes from the session to a private claude.ai URL, and that "updates in place as the session continues".
  - At launch it was a beta for Team and Enterprise, and artifacts "cannot be made public" ([blog](https://claude.com/blog/artifacts-in-claude-code) [P]). Now Pro, Max, Team and Enterprise. On Pro and Max, "a public link is the only way to share an artifact".
  - Surfaces: the CLI, the desktop app (≥1.13576.0), and Claude Tag sessions. It is not available on Bedrock, Vertex (Google Cloud's Agent Platform) or Foundry, or in CMEK, HIPAA or ZDR orgs.
- **Publishing.**
  - Claude writes an HTML or Markdown file to a temp dir, then publishes it.
  - In Auto mode a classifier approves the publish. In Manual mode the prompt reads like: "Claude wants to publish deploy-failures.html ... private to you until you share it".
  - It asks again when the page declares a runtime capability, or when the artifact has since been shared publicly or with "latest version" viewers.
  - After the first publish, **the browser opens the page automatically**. Opt out with `CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0`. **Ctrl+]** reopens the most recent artifact.
  - Claude picks the title, an emoji and a tab icon. The Artifact tool now asks for a one-word tab icon instead of an emoji favicon ([CHANGELOG 2.1.275](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) [P]).
- **Updating.**
  - "Anyone with the page open sees the update in place. Each publish becomes a version." The **Share** control chooses which version viewers see.
  - Another session can update an artifact given its URL, or by attaching it from `/artifacts`.
  - `/artifacts` lists owned and shared artifacts: **o** opens, **c** copies the link, **Enter** attaches to the session.
- **Share control in the page header.** The docs screenshot shows the title, the **Share** button and the author avatar. The Share menu contains:
  - an **"Always share latest version"** toggle;
  - a version picker ("Sharing version 2");
  - an audience selector ("Everyone at Acme");
  - **Copy link**.
- **Who sees what.**
  - A public link can be opened by "anyone on the internet ... with no claude.ai sign-in required". Public viewers who are not signed in, or who are outside the org, see the label `Content is user-generated and unverified.` instead of the author's name.
  - **The sources contradict each other here.** [Help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) says everyone who opens a Share-dialog artifact, which explicitly includes Claude Code artifacts, "needs a Claude account". Only legacy chat artifacts published with Publish can be opened without one.
  - Team and Enterprise can make someone an **editor**. The editor then updates the page through their own Claude session.
- **Comments to Claude.**
  - Comments work only on artifacts shared within an org, so Team and Enterprise only, and need Claude Code v2.1.221 or later. Anyone it is shared with can comment. Only **someone who can edit the artifact** can use **Send to Claude** or `@claude` to activate a thread, and Claude can reply to or resolve only activated threads. Replies show as from Claude, "via you".
  - The session that published the page watches it (v2.1.228 or later), and replies or edits depending on its permission mode.
  - What the user sees: `Auto-replied to comment thread on Artifact: <name>`, `Auto-edited Artifact: <name> in response to a comment thread`, or `Comments are waiting on Artifact: <name>`.
  - Auto-replies stop once Claude has handled **60 sent comments or thread activations on that artifact within an hour**, and pick up again as those age out.
  - Ways to stop them: Ctrl+C once at an idle prompt, stopping the task in `/tasks`, or Ctrl+X Ctrl+K twice within 3 seconds.
  - Public artifacts cannot take comments: `Comments aren't available while this Artifact is shared publicly.` Threads must be deleted before an artifact is switched to a public link.
- **Connectors at view time.**
  - Each viewer's calls run through **their own** connections, and viewers must approve before the first call.
  - Missing connectors leave live sections empty, so the docs advise a "fallback message ... that names the connector it needs".
  - Responses are cached in the browser: a "reopened page renders from the cached responses immediately, then updates with fresh results".
  - Connector-backed artifacts **cannot be public on any plan**.
- **Downloads.** Downloads a page starts itself (links, `data:` or `blob:`) are blocked. The `downloads` capability must be declared instead.
- **CSP and the page shape.**
  - One self-contained page; relative links do not resolve; `.html`, `.htm` or `.md` only.
  - Rendered size ≤16 MiB.
  - Scripts may come only from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and jsDelivr `/npm/`. Fonts may come only from Google Fonts.
  - External images are blocked. fetch, XHR and WebSocket can reach only "the page's own origin and the Google Fonts hosts".
  - The page is served from sandboxed `*.claudeusercontent.com`.
- **Design by default.**
  - A built-in design skill gives "a deliberate palette, typography, and layout".
  - Precedence is prompt > project design system (tokens in CLAUDE.md) > the skill's own choices.
  - `/design <brief>` drafts a Design canvas artifact. Editing it happens in a desktop browser, and artboards export to PNG or PDF.
- **Admin and governance.**
  - Org toggles: Artifacts, External sharing, **Enable artifact connectors**.
  - RBAC role scoping, separate retention for private and shared artifacts, and audit events `claude_artifact_*`.
  - Compliance API: list, get version, delete.

### 3.8 Today: one updated artifacts system, typed "appifacts", and the merge (Aug to Sep 2026)

- **Aug 19 2026.** New artifacts are "saved to your account, can be shared with people in your organization, and open on the web".
  - In Cowork, artifacts are started "From a session" or from **"New artifact"** in the Artifacts view, which begins with guided questions.
  - Cowork artifacts carry a **"Cowork" label**.
  - Each viewer's own connectors are used.
  - Sharing is version-selectable: "When you make changes, the link doesn't update until you select 'Latest' under Shared version." A link to a specific version keeps showing that version. (The earlier paraphrase "changes auto-update unless a specific version is pinned" was not in the source and reversed the default.) Version history can "compare an earlier version with the current one or restore it".
  - Artifacts that use connected apps or ask Claude questions "can only be shared within your organization", and "Connector tools that require per-action approval aren't available to artifacts".
  - Old live artifacts "keep working" and can be viewed but not "edited in place". Share offers to republish one as a new artifact, which can keep the existing link. Orgs using CMEK, ZDR or HIPAA stay on live artifacts.

  Source: [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P].
- **Sep 16 2026 merge UI.**
  - The Chat and Cowork toggles are removed. One "Recents" list holds everything.
  - Files Claude creates "appear alongside the conversation".
  - **Auto** vs **Manual** (the default) replaces the mode toggle.
  - Global instructions become "Instructions for Claude".
  - Known gaps: no conversation branching, incognito falls back to the old experience, and search excludes older Cowork tasks.

  Source: [help 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P].
- **Ways to start Design, Slides or Docs:**
  - just ask;
  - the **"Output"** button in the message box, then pick a type;
  - a template from the **Artifacts** tab;
  - `/docs` or `/design`.

  Sources: [help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]; [Get started with Claude Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P].
- **Share dialog for the new experience** ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]):
  - A Claude account is required for all viewers. This conflicts with the Claude Code docs, which say public links need no sign-in (see 3.7).
  - Roles:
    - Docs: view or edit.
    - **Design and Slides: view, comment or edit.**
    - Others: view or edit.
  - Team and Enterprise audiences: "Only people with access", "Everyone in your organization", "Anyone with the link". Pro and Max: "Only you" or "Anyone with the link".
  - "Anyone with the link" is not a per-artifact approval. It depends on the org-level **External sharing** toggle, which help 9547008 says an Owner must turn on for Enterprise; the Claude Code docs and help 9487310 say it is off by default for Team too. It is unavailable for artifacts that use connected apps or ask Claude questions, and on Team and Enterprise for Docs.
  - The mobile apps cannot change sharing settings.
- **External email invites** ([help 16989529](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact) [P]).
  - Flow: Share, then type an email, then Invite, then pick "Can view", "Commenter" (the default) or "Can edit", then the version, then Invite.
  - Recipients get an email from Claude with "View invitation" and "Accept and open".
  - Limits: at most **50 people outside the org per artifact**, counting pending and accepted invitations. **Pending** invitations expire after **30 days**; accepted ones do not.
  - Ineligible artifacts: Docs, artifacts not yet published, "Artifacts that connect to outside websites", and artifacts with an uploaded file still being checked or that failed the check.
  - External users cannot @mention or ask Claude in comments, get no comment notifications, and cannot comment on an artifact that is also shared with "Anyone with the link". Parts of the artifact that use Claude or connectors do not work for them.
  - The feature is in beta. It is on by default for Team, off by default for Enterprise, and unavailable for education, K-12, CMEK, ZDR and HIPAA orgs.
- **Docs.**
  - "Click into the doc and type. Your changes save automatically."
  - Editors' changes "appear in real time" for everyone with the doc open; the help does not describe presence avatars or cursors. Comment threads let you mention "@Claude" to request edits, and Claude leaves explanatory comments while drafting. Every change is attributed to whoever made it, person or Claude.
  - Deleting a doc is permanent: "There's no trash".
  - Export to .docx, PDF, .md and Google Docs.
  - **No version history** and no comment-only role yet. Charts "don't update on their own".
  - **Mobile is view-only**; templates, editing and sharing need web or desktop.

  Source: [help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P].
- **Design (merged).**
  - It lives at claude.ai/design (standalone), in conversations (Output > Design), in the Artifacts tab (templates), in Claude Code (`/design`), and in the mobile apps (ask in chat, view in the Artifacts tab).
  - Editing: chat for broad changes, inline comments by clicking elements, and direct canvas editing (drag, resize, align).
  - Design systems sync with `/design-sync`. Existing team design systems migrate through the "Migrate team design systems" banner, and each one becomes an artifact with a "Let Claude clean it up" banner.
  - Export targets:
    - .zip, PDF, PPTX, and standalone HTML;
    - Google Slides, but only at claude.ai/design;
    - send to Adobe Experience Manager, Adobe for Creativity, Adobe Journey Optimizer, Base44, Canva, Gamma, HubSpot, Hyperframes, Lovable, Miro, Netlify, Replit, v0, Vercel or Wix;
    - handoff to Claude Code, to a local coding agent, or to Claude Code Web.

    **Figma is not on the list.** An earlier version of these notes said it was.
  - **Known issues**: comment persistence occasionally fails, **"No version history yet"**, and multi-person editing "may not work reliably".
  - Mobile: "Editing on the canvas and changing sharing settings need Claude on web or desktop."

  Source: [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P].
- **Admin.** Separate toggles for the Design artifact in conversations (Organization settings > Artifacts > Design), standalone Claude Design (Capabilities), and Slides (under Artifacts). Enterprise has a "Claude Design Admin" permission, and usage is shared with the rest of Claude ([admin guide 14604406](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P]).
- **The runtime behind it**, from the lead evidence:
  - a typed artifact is a runtime (`index.html`, `SKILL.md`, `artifact-type/*`) plus the instance's own files under `project/`;
  - capabilities are artifact, assets, comments, db, downloads, room, user, mcp and sample;
  - a pinned contract, for example 0.2.47;
  - publish refuses to overwrite a newer version.

  Observed again on 2026-09-23: `Artifact list scope=types` returns exactly four core types (Design, Design System, Docs, Slides). The Slides type is at release `1790097191-2423` with capabilities `artifact, assets, comments, db, downloads, room, user`, and its SKILL.md says "Tell the user what happens to the deck, never the mechanism" and "NEVER VERIFY UNLESS THE USER ASKED" [P, first-hand].
- **Artifacts that save themselves** (community report; the lead evidence confirms the `artifact`, `db` and `room` capabilities first-hand). "Edits stay in the tab until you hit Save, and Save rebuilds the page with the data embedded."
  - Version history keeps authorship. Conflicts are last-writer-wins with optional leases.
  - The db supports "live subscriptions that update every open copy without a reload".
  - Room presence passes cursors and selections, and Claude Code sessions join as marked agents.

  Source: [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is), 2026-09-13 [C].

### 3.9 Sibling reference points inside Anthropic

- **Claude Science** (desktop beta for macOS, Windows and Linux) has its own artifact model ([docs: artifacts](https://claude.com/docs/claude-science/artifacts), [comments](https://claude.com/docs/claude-science/comments.md), 2026 [P]):
  - Artifacts open "in a tab beside the chat". Ctrl/Cmd-click opens fullscreen. HTML has zoom and fit-to-width.
  - **Files** is a searchable grid.
  - The per-artifact menu has Open, Open beside session, **View in context**, **Provenance** (Messages, Code, Execution Log, Environment, Review), Versions, Copy link, Star, Rename, Download and Delete. Renaming does not break links.
  - A **version stepper and a diff toggle** (compare with any earlier version), and **Edit content** then Save creates a new version.
  - Links in the chat point to the version that existed at the time.
  - **Comments**: select text, click a point on an image, or click an element in the HTML "Comment" mode. Saved comments are **pending above the message box and sent with the next message**, so users can batch them. After sending, they become cards on the message.
- **MCP Apps** (connector-supplied UIs in chat) have the most explicit published design guidance ([design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]):
  - Display modes: `inline`, `fullscreen`, `pip`.
  - Inline cards auto-fit their height with no nested scroll, carry at most 2 actions, and use no menus or popovers.
  - In fullscreen, "the composer is always visible" and a close button sits in the native header.
  - On mobile they render in WKWebView or WebView, and the conversation owns vertical scroll.
  - Host tokens: for example `color-background-primary` is #FFFFFF in light and #30302E in dark, `border-width-regular` is 0.5px, and radius runs 4 to 12px.

---

## 4. UI/UX anatomy, part by part

### 4.1 How an artifact comes into being
- **The model decides.** There is no mode switch. Claude judges whether the content is substantial and self-contained, then emits an artifact ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
- **Explicit entry points added in 2026:** Output > Design, Slides or Docs; templates in the Artifacts tab; `/design`, `/docs`, `/design-sync`; "New artifact" with guided questions in Cowork (help articles above [P]).
- **Claude Code:** "Claude may publish an artifact on its own when the output suits a page, or you can ask for one directly" ([docs](https://code.claude.com/docs/en/artifacts) [P]).

### 4.2 The card in the thread, then the pane
- The artifact shows up first as a **card in the reply**, labelled with its type (for example "Interactive artifact"), and opens into the split pane "without losing chat history on the left" ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/), 2026-06-14 [S]).
- **Multiple artifacts** in one conversation are switched with a "slider icon (upper right)" ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
- In the merged product, drafts "open right beside your chat" and files "appear alongside the conversation" ([release notes 2026-06-12](https://support.claude.com/en/articles/12138966-release-notes), [help 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P]). On the desktop app, Docs from Claude Code "open in the side panel"; in the terminal you get a link ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
- [I] The pane opens automatically as the first artifact starts streaming. Clicking the card reopens a closed pane or switches to an older artifact or version. Reference to an older version in the thread is shown by the card for that message.

### 4.3 Streaming and update behaviour
- (unverified) While generating, the pane streams **source in the Code view** and switches to **Preview** once generation completes. The cited [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) guide does not say this. It says the panel "opens on the right of the chat in Preview mode" once Claude "has enough to generate", and that on iteration "Claude regenerates the whole Artifact" [S].
- Targeted updates show "live preview changes visible in real-time" ([Hyperdev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact) [S]).
- An anti-pattern users hate: full rewrites where "the system slowly deletes every line of code before rewriting it" ([BigGo](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues), 2025-07-16 [S]).
- Truncation at the output limit leaves unclosed tags, so the preview is blank ([Pagelive](https://pagelive.io/claude-artifacts/not-working) [S]).
- Hosted pages: "When Claude Code updates an artifact, the open page refreshes in place and teammates see the updates the moment they're published" ([blog](https://claude.com/blog/artifacts-in-claude-code), 2026-06-18 [P]).

### 4.4 Pane chrome
- **Preview and Code** are two tabs of the same pane. The ai-toolbox guide shows an eye icon and a code-bracket icon at the top left ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]; [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) [S]).
- **Top-right actions:**
  - Copy (the whole source), with a dropdown arrow that offers "Download as HTML";
  - Publish or Share, and a refresh button;
  - a three-dot menu that holds version history and "Add to project".

  The **Star, Rename, Add to project, Delete** menu is the one on a **library card** (shown on hover), not necessarily the pane's own menu. Sources: [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) [S]; [AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S].
- **Help-center wording:** a "version selector", and in "the lower right corner of the artifact window" options to view the code, copy and download ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). The idea that older guides put the version arrows at the bottom-left is (unverified): the current ai-toolbox page does not say it. Chrome placement has shifted across releases [I].
- **Batched edit requests (help, 2026-09):** when Claude drafts several Markdown files (a skill or plugin, say), you can leave edit requests in several files first. "Each request is added to your next message, and the file list shows how many requests are waiting in each file" ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). This matches Claude Science's pending comments.
- **Download** saves with the matching extension: .html, .py, .svg and so on [S].
- **Hosted viewer header**: title, Share, author avatar, and a link to the gallery at claude.ai/code/artifacts ([docs](https://code.claude.com/docs/en/artifacts) [P]).

### 4.5 Selecting part of an artifact and asking Claude
| Generation | Surface | Gesture, then result | Source |
|---|---|---|---|
| 2024 (article 2024-09-02) | Code view | Highlight code → **Improve** (small text box; the whole artifact was still regenerated) or **Explain** (sent to chat) | [S] [Tom's Guide](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text) |
| 2025–26 | Markdown artifacts | Highlight → **Edit with Claude** → type → "Claude edits right where you marked it, so you don't have to describe which section you mean in the chat" | [P] [help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) |
| 2026-06-12 | Drafts in chat and Cowork | Highlight → instruction → inline edit | [P] [release notes](https://support.claude.com/en/articles/12138966-release-notes) |
| 2026-04 → merge | Design canvas | Click an element → inline comment for Claude; or direct drag, resize and align; or Claude-made **sliders** | [P] [Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs); [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) |
| 2026-09 | Slides | "Leave a comment for Claude on a slide" | [P] [merge blog](https://claude.com/blog/cowork-is-now-claude) |
| 2026-09 | Docs | Comment threads with **@Claude**; view-context tells Claude the mode, tab and selected blocks | [P] [help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs); lead evidence |
| 2026 | Hosted artifacts (org-shared only) | Comment → an **editor** uses **Send to Claude** or `@claude` → the agent session replies or edits | [P] [docs](https://code.claude.com/docs/en/artifacts) |
| 2026 | Claude Science | Select, click a pin, or use HTML Comment mode → pending comments batched above the composer → sent with the next message | [P] [Science comments](https://claude.com/docs/claude-science/comments.md) |

The merge blog sums up the direct-manipulation goal: "select an element and move it, or tell Claude what you want changed" ([blog](https://claude.com/blog/cowork-is-now-claude), 2026-09-16 [P]).

### 4.6 Recovering from errors
- A **"Try fixing with Claude"** button sits near the error. It copies the error details into a new message, which the user then sends so Claude can diagnose and repair. The help adds that "success isn't guaranteed" ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). The Academy tutorial calls it "Fix with Claude" [P].
- In Claude Code, the publish step itself validates: bad UTF-8 is refused with a line and column, and connector tool names are checked against the connector ([docs](https://code.claude.com/docs/en/artifacts) [P]).

### 4.7 Fullscreen and display modes
- A full-width artifact mode exists but "hides the chat entirely", so context is lost. The split pane feels cramped on small viewports ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]).
- For comparison, MCP Apps fullscreen keeps the **composer visible**, has a close button in the native header, and bans floating panels in favour of collapsible sidebars and tabs ([MCP Apps guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]). Claude Science uses Ctrl/Cmd-click for fullscreen ([docs](https://claude.com/docs/claude-science/artifacts) [P]).

### 4.8 Sharing flows, side by side
| Generation | Control | States and options | Source |
|---|---|---|---|
| 2024 → legacy chat artifacts | **Publish** button → modal (title, Usage Policy) → **Publish & copy link** | Public snapshot of one version; Unpublish deletes storage and is final | [P] [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts); [S] [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) |
| 2026 new experience | **Share** dialog | Audience: Only you / Only people with access / Everyone in org / Anyone with link. Roles: view, comment, edit. Version to share, plus "Always share latest version". Invite by email (external). Copy link | [P] [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts); [P] [docs](https://code.claude.com/docs/en/artifacts); [P] [help 16989529](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact) |
| Hosted public view | Page header | Signed-in org viewers see the author. Others see `Content is user-generated and unverified.` | [P] [docs](https://code.claude.com/docs/en/artifacts) |

### 4.9 Library, gallery and pinning
- An **Artifacts** section in the sidebar holds everything. In the new experience items are "saved automatically"; legacy chat artifacts only appear there after Publish. It is also where templates start ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
- The Cowork sidebar has an Artifacts view with "Cowork" labels ([help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P]).
- The gallery for hosted artifacts is at claude.ai/code/artifacts. Pin and unpin to the claude.ai sidebar are supported, and Claude may offer to pin a dashboard the user will keep reopening (lead evidence and Artifact tool contract [P, first-hand]).
- HN complaint about sidebar clutter: features the commenter never intends to use "take up first class space", with the designer always present and artifacts rarely needed (saratogacx, [HN 49729412](https://news.ycombinator.com/item?id=49729412), 2026-09-16 [C]).

### 4.10 Mobile
- Artifacts could be created and viewed on phones from 2024-08-27 [S], and AI apps worked on mobile from 2025-07-21 [P].
- Today: "View results in the Artifacts tab, but use web/desktop for templates, editing, and sharing management" (Design, Slides, Docs) ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them); [help Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs); [help Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]).
- **This conflicts with the press coverage, and only partly with Anthropic's own wording.**
  - The merge blog says only that everything "lives at one shareable link you can open on your phone". The next sentence, "You can select an element and move it, or tell Claude what you want changed", does not mention the phone. Read together they suggest editing on the phone, but the blog never says it.
  - TechCrunch (Ivan Mehta, 2026-09-16) goes further: users "can share generated documents or slides with a link and edit them on their phone".
  - The help center, updated the same week, says the mobile apps can ask for and view designs, decks and docs, but templates, editing and sharing settings need web or desktop ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).

  Treat the help center as authoritative, and the "edit on your phone" framing as press interpretation [S].
- MCP Apps on mobile use a native WebView, respect safe areas, and pass inline vertical pans to the conversation scroll ([guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]).

### 4.11 Liveness and presence
- The `room` capability carries live presence, cursors and selections, and agent sessions join as marked agents. The db has live subscriptions that update every open copy (lead evidence [P]; [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) [C]).
- In Docs, several editors can work at once and "everyone's edits appear in real time" ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]). The help does not describe visible presence indicators; the viewer's `room` capability implies them (lead evidence) [I].

---

## 5. Motion patterns, documented vs inferred

| Pattern | Detail | Confidence and source |
|---|---|---|
| Refresh in place on republish | Open pages update without a reload whenever a new version is published | [P] [blog 2026-06-18](https://claude.com/blog/artifacts-in-claude-code); [docs](https://code.claude.com/docs/en/artifacts) |
| Cache first, then refresh | Connector pages "render from the cached responses immediately, then update with fresh results" | [P] [docs](https://code.claude.com/docs/en/artifacts) |
| Inline to fullscreen | "Inline cards expand to fullscreen with a smooth transition", with a clear expand affordance; closing "returns to the conversation at the same scroll position" | [P] [MCP Apps guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) |
| Skeletons, not spinners | "Show skeleton screens ... Match the layout structure of the final content ... Avoid spinners for inline content" | [P] same |
| Slide transitions and build-ins | `data-transition="fade\|push\|magic"` (magic = morph); `data-build-in="fade\|rise\|pop"` on pinned children | [P] lead evidence and Slides SKILL.md (first-hand 2026-09-23) |
| Streaming source, then preview | (unverified) Code streams in the Code tab, then the view flips to Preview on completion. The cited guide says instead that the panel opens in Preview | [I]; not supported by [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) |
| Streaming targeted edits | The preview changes in real time as updates apply, with no full re-stream | [S] [Hyperdev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact) |
| Anti-pattern: delete, then retype | A full rewrite visibly deletes every line before rewriting | [S] [BigGo](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues) |
| Inline visuals "animate to life" | Diagrams build progressively as they stream: "Wow it felt magical to watch that diagram slowly animating to life" (atonse) | [C] [HN 47352751](https://news.ycombinator.com/item?id=47352751) |
| Presence | Live cursors and selections (room); marked agent presence | [P] lead evidence; [C] [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) |
| Docs viewer animations | The viewer bundle ships an `animations` module, VersionBar and VersionPreviewPane, and a BottomSheet on mobile | [P] lead evidence |
| Split-pane entrance | [I] The pane slides in from the right while the chat column narrows; the card highlights the active artifact. **No durations or easing are published by Anthropic.** | [I] |

---

## 6. Design choices that make it feel good

1. **Instant visual feedback.** The origin story ("taste the sauce") is still the core value [S].
2. **No modes.** The model decides when to make an artifact, and the merge extends that to "Claude figures out what a task needs". An explicit Output picker exists for users who want to choose [P].
3. **Conversation on the left as the reasoning trail, artifact on the right as the product.** Preview and Code are two views of one pane, not two destinations [S].
4. **A stable identity over versions.** Updates land on the same artifact, versions accumulate, you can switch between them, and a link can be pinned to a version or follow the latest [P].
5. **Targeted edits** are fast and cheap, and do not destroy manual work. This is the fix for the rewrite anti-pattern [S].
6. **Anchored asks.** Select, then ask, and Claude edits "right where you marked it". Comments become instructions to the agent, and that loop reaches people who never open the chat (Send to Claude, @claude) [P].
7. **One-click error repair** with Try fixing with Claude [P].
8. **The gallery feeds conversations.** Inspiration, then Customize or Remix, starts a new conversation [P]/[S].
9. **Viewer-pays and viewer-auth economics.** AI calls and connector calls run under the viewer's account. That removes the creator's cost and credential-leak risk [P].
10. **Private by default, with explicit escalation.** Publishing a public link needs a permission prompt or an owner toggle, and public pages carry an "unverified" label [P].
11. **Design quality by default.** A built-in design skill, design-system precedence, and rules against AI tropes (lead evidence) [P].
12. **Typed artifacts as model-authorable file formats plus a shared runtime.** New artifact kinds ship as data (SKILL.md plus files) rather than as client releases (lead evidence [P]).

---

## 7. Weaknesses and complaints

1. **Sandbox limits (2024–25).**
   - No external fetch, no form submit or navigation, and cdnjs only.
   - Simon Willison: "I'm beginning to get a little frustrated at their limitations" ([2024-10-21](https://simonwillison.net/2024/Oct/21/claude-artifacts/) [C]).
   - At the AI-apps launch: "No external API calls (yet), No persistent storage" ([HN 44379673](https://news.ycombinator.com/item?id=44379673), handfuloflight [C]).
   - Still constrained today: external images are blocked, fetch is same-origin only, and downloads need a capability [P].
2. **Rewrites, truncation, empty or vanishing artifacts.**
   - "I tell Claude not to put anything in the artifacts because it always ... messes them up" ([BigGo](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues), 2025-07-16 [S]).
   - Outputs truncated at the limit render blank ([Pagelive](https://pagelive.io/claude-artifacts/not-working) [S]).
3. **Silent data loss.**
   - Drafts do not persist storage.
   - localStorage fails silently in legacy chat artifacts (community report, disputed; see 3.5).
   - Unpublish deletes data with no export, and the artifact cannot be republished ([Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]; [help](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).
4. **Many generations running at once.**
   - Legacy chat artifacts (Publish) vs the new experience (auto-save plus Share).
   - Legacy Cowork live artifacts are "viewable but non-editable".
   - Three URL schemes.
   - Artifacts vs inline visuals chosen inconsistently ([HN 47352751](https://news.ycombinator.com/item?id=47352751) [C]; [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P]).
5. **New types shipped without basics.**
   - Docs has no version history and no comment-only role; its charts do not update.
   - Design has no version history, occasional comment-persistence failures, and unreliable multi-person editing ([help Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), [help Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), 2026-09 [P]).
6. **Mobile is view-only** for Design, Docs and Slides editing and for sharing management, despite the "open on your phone" launch message and TechCrunch's "edit them on their phone" [P] vs [S]. Inline visuals were not on iOS or Android at launch: "They aren't available on Claude for iOS or Android" ([MakeUseOf](https://www.makeuseof.com/tried-claudes-new-interactive-visuals/), 2026-03-17 [S]).
7. **Sharing edge cases.**
   - Comments are off for public artifacts, and threads must be deleted before a page goes public.
   - External invitees have no @mentions and no notifications.
   - 50 outside people per artifact (pending plus accepted); pending invites expire after 30 days.
   - Viewer sign-in: the help center says every Share-dialog viewer needs a Claude account, while the Claude Code docs say public links need no sign-in [P vs P].
   - Connector artifacts can never be public, so on Pro and Max they stay private [P].
8. **Per-viewer connectors.** Live sections are empty for viewers who have not connected the service or who declined the prompt. A denial "lasts for the rest of that page load" [P].
9. **Abuse and security.**
   - Public artifacts served as a trusted-domain lure in a ClickFix malware campaign ([Anvilogic](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse), 2026-02-19 [S]).
   - In testing, synthetic credentials got into published pages (10 of 85 attempts) ([Pluto Security, 2026-08-06, via chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is), 2026-09-13 [S]).
   - The "unverified" label on public pages and public sharing off by default on Team and Enterprise are both documented [P]. That they were a **response** to these incidents is [I]: no Anthropic source links them.
   - The help center now warns: "Treat someone else's artifact the way you'd treat a file from an unknown sender" ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).
10. **Concurrency.** Self-saving pages are last-writer-wins, with optional leases, which is "unsuitable for simultaneous paragraph editing" ([chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) [C]).
11. **Chrome ergonomics.**
    - Publish and Copy look alike, so accidental shares are a risk.
    - The code tab has no inline editing.
    - Full-width hides the chat.
    - The split pane is cramped on small screens.
    - Card and prose repeat each other once the artifact is open ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]).
12. **Merge backlash.**
    - Loss of a guaranteed chat-only mode: "explicitly only chat, without the possibility of Cowork activating" (LoganDark).
    - Routing opacity: users should "know they are being routed" (bcorigliano).
    - Chat is "a horrible interface" for multi-day work (cpinto).
    - Questions about whether Design, Docs and Slides are needed at all.

    Source: [HN 49729412](https://news.ycombinator.com/item?id=49729412), 2026-09 [C].
13. **Cost and limits.** Usage limits are "the #1 complaint even for paid users" ([Hyperdev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact), 2025-10-24 [S], a low-reliability source). Anthropic confirms that "Artifacts count toward your plan's usage limits" ([help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). A styled page costs more tokens than text, and data-URI images cost the most ([docs](https://code.claude.com/docs/en/artifacts) [P]).
14. **Creators cannot monetize**, and lock-in worries: "don't build your castle in someone else's kingdom" (owebmaster, [HN 44379673](https://news.ycombinator.com/item?id=44379673) [C]).
15. **False trust.** A polished visual makes wrong data more believable: "A slick presentation can distract people from the only thing that really matters—the accuracy of the underlying data" (programmertote); also captainbland ([HN 47352751](https://news.ycombinator.com/item?id=47352751), 2026-03-12 [C]).

---

## 8. Limits and quotas (current)

| Limit | Value | Source |
|---|---|---|
| Rendered page (hosted) | ≤16 MiB | [P] [docs](https://code.claude.com/docs/en/artifacts) |
| Files and version size | 255 files and 64 MB per version; canvases and decks 512 files and 256 MB; one call 16 MB | [P] lead evidence; Slides SKILL.md |
| Persistent storage (chat artifacts) | 20 MB per artifact, text only, published only | [P] [help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) |
| Script hosts | cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com, jsDelivr /npm/; fonts from Google Fonts only; fetch, XHR and WebSocket to the page's own origin and the Google Fonts hosts only | [P] [docs](https://code.claude.com/docs/en/artifacts) |
| External invites | 50 outside people per artifact (pending plus accepted); pending invites expire after 30 days | [P] [help 16989529](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact) |
| Comment auto-replies | Paused after 60 sent comments or thread activations per artifact within an hour | [P] [docs](https://code.claude.com/docs/en/artifacts) |
| Watched artifacts per session | 10 (up from 5) | [P] [CHANGELOG 2.1.271](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) |
| Slides | 1920×1080, at most 200 elements per slide, 4 faces, x-embed ≤16 KB (at most 8), speaker notes ≤4,000 chars | [P] Slides SKILL.md, first-hand |
| Science comments | 1,000 chars | [P] [Science comments](https://claude.com/docs/claude-science/comments.md) |
| Not available in | CMEK, HIPAA, ZDR orgs; Bedrock, Vertex, Foundry | [P] [docs](https://code.claude.com/docs/en/artifacts) |

---

## 9. What this suggests for the Juno merge (inferred, mapped to the Juno audit)

- **Decouple before unifying.** Claude's turning point was "saved to your account", not a UI change. Juno's audit (§1 item 4) shows artifacts dying with message edits and regenerations. Adopt Claude's rule: the artifact is an account-level object, and messages only reference its versions. [I]
- **One Share dialog for every type,** with an audience, per-type roles (Design gets view, comment and edit), a version pin plus an "always latest" toggle, and an "unverified" label on public pages. Also add governance: takedown, retention and audit events. The Juno audit's governance gaps (§1 item 8) match what Anthropic now documents (labels, org toggles, retention, audit events, Compliance API). No Anthropic source says these were added because of the Feb 2026 abuse. [I]
- **Selection to ask everywhere.** Use one gesture for code, Markdown and design nodes. Consider Claude Science's **pending comments batched above the composer** as a cheap model for comments that go to the model. Claude Design's clickable elements with comments and model-made sliders map onto Juno's existing Ask Juno flow and design tweaks. [I]
- **Targeted updates, not re-emits.** Juno's chat re-emit rebuilds the design document and reverts hand edits (audit X-06). Claude's create, update or rewrite split (with the model reading the current version) is the precedent. [I]
- **Motion.** Anthropic publishes little, so Juno's motion token system (audit §8) is an asset. Borrow the documented behaviours:
  - refresh in place;
  - cache-then-refresh for live data;
  - skeletons over spinners;
  - inline-to-fullscreen with scroll position restored;
  - Slides-style fade, push and magic transitions for Design Play mode.

  Avoid "delete every line, then retype" when streaming a rewrite. Diff-apply instead. [I]
- **Don't ship new types without versions.** Claude Docs and Design shipped without version history and drew complaints. Juno already has append-only versions and diffs, so keep them for every type. [I]
- **Mobile.** Decide explicitly between view-only and edit. Claude's messaging and docs contradict each other here. [I]

---

## 10. Sources (with dates)

Primary:
- [Introducing Claude 3.5 Sonnet](https://www.anthropic.com/news/claude-3-5-sonnet), 2024-06-20
- [Anthropic on X: publish and remix](https://x.com/AnthropicAI/status/1810698780263563325), 2024-07-09
- [Artifacts are now generally available](https://claude.com/blog/artifacts), 2024-08-27 (404 on 2026-09-23)
- [Build and share AI-powered apps with Claude](https://claude.com/blog/claude-powered-artifacts), 2025-06-25 (the claude.com copy displays "July 25, 2025"; update notes 07-17 and 07-31)
- [Turn ideas into interactive AI-powered apps](https://claude.com/blog/build-artifacts), 2025-06-25; updates on 07-21, 07-31 and 10-21
- [Claude Sonnet 4.5 (Imagine with Claude)](https://www.anthropic.com/news/claude-sonnet-4-5), 2025-09-29
- [Claude builds interactive visuals](https://claude.com/blog/claude-builds-visuals), 2026-03-12
- [Introducing Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs), 2026-04-17
- [@claudeai: live artifacts in Cowork](https://x.com/claudeai/status/2046328619249684989), 2026-04-20
- [Claude Code now supports artifacts](https://claude.com/blog/artifacts-in-claude-code), 2026-06-18
- [Claude Cowork and chat are now one Claude](https://claude.com/blog/cowork-is-now-claude), 2026-09-16
- [Claude Code docs: Share session output as artifacts](https://code.claude.com/docs/en/artifacts), fetched 2026-09-23
- [Claude Code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md), v2.1.269–2.1.280, 2026-09
- [Help: What are artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), updated 2026-09
- [Help: Publish and share artifacts](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts), updated 2026-09
- [Help: Use artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork), 2026-08/09
- [Help: Get started with Claude Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), 2026-09
- [Help: Invite people outside your organization](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact), 2026-09
- [Help: Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), 2026-09
- [Help: Claude Design admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans), 2026-09
- [Help: Claude Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude), 2026-09
- [Help: Release notes](https://support.claude.com/en/articles/12138966-release-notes), entries on 2026-01-12, 03-12 and 06-12
- [Anthropic Academy: Prototype AI-powered apps](https://academy.claude.com/tutorials/prototype-ai-powered-apps-with-claude-artifacts), 2025–26
- [Claude Science docs: Artifacts](https://claude.com/docs/claude-science/artifacts), [Comments](https://claude.com/docs/claude-science/comments.md), [Overview](https://claude.com/docs/claude-science/overview.md), 2026
- [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md), 2026
- [claude.com/features/artifacts](https://claude.com/features/artifacts), 2026-09
- First-hand: the `Artifact` tool with `list scope=types` and `read type_url` (Slides), 2026-09-23; and `docs/design/artifacts-design/research/claude-primary-evidence.md`

Secondary and community:
- [Pragmatic Engineer: How Anthropic built Artifacts](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts), 2024-08-27; [Simon Willison summary](https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts/), 2024-08-28
- [Reid Barber: Reverse engineering Claude Artifacts](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts), 2024-06-23
- [Simon Willison: publish and remix](https://simonwillison.net/2024/Jul/9/claude-share-artifacts/), 2024-07-09; [TestingCatalog](https://www.testingcatalog.com/claude-ai-update-enables-public-sharing-and-remixing-of-artifacts-2/), 2024-07-09
- [VentureBeat: GA and mobile](https://venturebeat.com/ai/anthropic-launches-claude-artifacts-generally-for-all-users-mobile), 2024-08-27
- [Tom's Guide: highlight and edit](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text), 2024-09-02
- [Rui Quintino: Replace Is All You Need](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113), 2024-11-02
- [Hyperdev: artifact editing](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact), 2025-10-24 (misdates the change; low reliability)
- [Simon Willison: Everything I built with Claude Artifacts this week](https://simonwillison.net/2024/Oct/21/claude-artifacts/), 2024-10-21; [HN 41929174](https://news.ycombinator.com/item?id=41929174)
- [TestingCatalog: Artifacts gallery](https://www.testingcatalog.com/upcoming-claude-feature-lets-users-explore-and-share-ai-generated-artifacts/), 2025-05-29
- [Simon Willison: AI-powered apps](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/), 2025-06-25; [HN 44379673](https://news.ycombinator.com/item?id=44379673)
- [BigGo: Artifacts complaints](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues), 2025-07-16
- [AlternativeTo: uploads to artifacts](https://alternativeto.net/news/2025/8/claude-artifacts-update-upload-pdfs-images-and-code/), 2025-08-01
- [Caipi: Can Claude Artifacts save data?](https://caipi.ai/blog/can-claude-artifacts-save-data), 2026-06-12
- [Anvilogic: MacSync via Claude artifact abuse](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse), 2026-02-19
- [MakeUseOf: inline visuals](https://www.makeuseof.com/tried-claudes-new-interactive-visuals/), 2026-03-17; [HN 47352751](https://news.ycombinator.com/item?id=47352751)
- [TechCrunch: Claude Design](https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/), 2026-04-17
- [AI UX Playground: Claude Artifacts teardown](https://www.aiuxplayground.com/teardowns/claude/artifacts/), 2026-06-14
- [VentureBeat: Claude Code artifacts](https://venturebeat.com/data/anthropics-claude-code-artifacts-update-brings-live-shared-dashboards-and-interactive-workspaces-to-enterprises), 2026-06-18
- [chaosguru: artifacts save themselves and share a realtime db](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is), 2026-09-13
- [TechCrunch: the merge](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/), 2026-09-16; [Engadget](https://www.engadget.com/2259938/anthropics-claude-can-now-create-editable-documents-for-you-cowork-chat-together/), 2026-09-16; [The Next Web](https://thenextweb.com/news/anthropic-claude-cowork-merge-docs-slides), 2026-09-17
- [HN 49729412: merge discussion](https://news.ycombinator.com/item?id=49729412), 2026-09-16
- [ai-toolbox: How to use Claude Artifacts 2026](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026), published 2026-05-31, updated 2026-09-16 (a Chrome-extension vendor's guide, "Verified May 2026")
- [Pagelive: Claude artifacts not working](https://pagelive.io/claude-artifacts/not-working), 2025–26

Gaps: the session's WebSearch budget ran out during this research, so Reddit could not be searched (its domain is also blocked for the fetcher). No first-party source gives panel animation durations or easing.

---

## Fact-check (adversarial pass, 2026-09-23)

**Method.** Every help-center article, the Claude Code docs, the blog posts and the release notes were re-fetched on 2026-09-23 and read in full (raw HTML, extracted to text). Anthropic's own posts were read in full: Introducing Claude 3.5 Sonnet, Claude Design, the Claude Code artifacts blog, the merge blog, the inline-visuals blog, and both 2025 AI-powered-artifacts posts. The Claude Code CHANGELOG was read in full. The Artifact tool was called first-hand: `list scope=types` and a `read` of the Slides type. Press and community sources were fetched one by one: VentureBeat, TechCrunch, Tom's Guide, Hyperdev, Rui Quintino (Medium RSS), Caipi, BigGo, MakeUseOf, Anvilogic, chaosguru, AI UX Playground, ai-toolbox, Reid Barber, Simon Willison, TestingCatalog, and HN through the Algolia API. X posts were read through the fxtwitter API. The WebSearch budget was already used up, so no second-source searching was possible beyond direct fetches.

**Verified as written (selection):**
- The 2024-06-20 launch; the Pragmatic Engineer team size and timeline (one full-time engineer, one part-time, the 2024-03-21 prototype, dogfooding in about 1.5 weeks).
- Publish and remix on 2024-07-09 (X post and claude.site); GA and mobile on 2024-08-27 (VentureBeat; Anthropic's GA post now returns 404).
- The June 2025 artifacts space; viewer-pays billing; "over half a billion artifacts".
- MCP and storage on 2025-10-21 (20 MB, text only, personal or shared, published only; unpublish deletes the data and blocks republishing).
- Inline visuals on 2026-03-12, reaching Cowork on 2026-04-22; Claude Design on 2026-04-17; inline draft editing on 2026-06-12; Claude Code artifacts on 2026-06-18 (Team and Enterprise beta).
- The Cowork updated artifacts system from 2026-08-19; the 2026-09-16 merge.
- In the merged product: the Output picker, Artifacts-tab templates, `/docs` and `/design`; auto-save to the Artifacts tab versus Publish for legacy chat artifacts; roles per type.
- Docs cannot be shared outside the org on Team and Enterprise, and cannot be invited by email.
- No version history for Design or Docs.
- Connector artifacts are never public; each viewer uses their own connectors.
- The CSP host list and 16 MiB cap; `*.claudeusercontent.com`; the public-viewer label; the admin toggles, audit events and Compliance API.
- The Slides type's release, capabilities, contract 0.2.47 and limits (first-hand).
- The MCP Apps motion and token guidance; Claude Science artifacts and comments; the HN quotes (merge thread and inline-visuals thread); the ClickFix campaign (Anvilogic, 2026-02-19).

**Corrected (refuted or misquoted):**
1. **Improve (2024)** did *not* edit "without overwriting the entire result". Tom's Guide (2024-09-02) says it "recreates the entire code".
2. **Targeted updates.** The Hyperdev source is dated 2025-10-24 and misdates the change to Oct 2025. The primary community source is Rui Quintino, 2024-11-02, so the ~late Oct 2024 timing stands on that basis. The "manual edits in diff views discarded" complaint was a Claude Code GitHub issue, not artifacts, and was removed.
3. **Claude Design exports** do not include Figma. Replaced with the help center's actual list.
4. **Pluto Security** is dated 2026-08-06, not 2026-09-08; "before isolation measures" is not in the source. 2026-09-08 is the date the blog gives for Claude Code v2.1.265.
5. **Cowork live artifacts** were announced on 2026-04-20, not ~04-21. "No token cost on refresh" is tagged (unverified).
6. **File uploads into AI apps** date to 2025-07-17 (Anthropic's update note), not 2025-08-01.
7. **Watching 10 artifacts** shipped in 2.1.271, not 2.1.274. `/artifacts` dates from 2.1.208, not the 2.1.269–280 range.
8. **Misquotes replaced with real quotes:**
   - inline visuals: "ephemeral conversational aids" and "between paragraphs" are not in the blog;
   - Claude Design launch wording;
   - Cowork versioning: "changes auto-update unless pinned" reversed the default, and the link actually stays on the chosen version until "Latest" is selected;
   - saratogacx and programmertote on HN;
   - the TL;DR "save automatically to the tab".
9. **Comments.** Only people who can **edit** can Send to Claude or @claude. Comments need Team or Enterprise and v2.1.221 (auto-replies v2.1.228). The 60 cap counts sent comments and thread activations per hour.
10. **CSP.** fetch can also reach the Google Fonts hosts, not only the same origin.
11. **External invites.** Only *pending* invites expire at 30 days; the 50 counts pending plus accepted. The ineligible list says "connect to outside websites", not "connector artifacts".
12. **"Anyone with link needs owner approval"** is an org-level External sharing toggle, not a per-artifact approval.
13. **Bundled libraries.** shadcn/ui and recharts are not on Reid Barber's list and are no longer claimed.
14. **Mobile "contradiction".** The merge blog itself only says "open on your phone". The explicit "edit them on their phone" is TechCrunch's wording. The help center (view-only on mobile) is authoritative.
15. **Docs "real-time presence".** The help only says edits "appear in real time".
16. **Causation.** That the "unverified" label and default-off public sharing responded to the ClickFix abuse is now marked [I].

**Tagged (unverified):**
- the Academy "Customize" label;
- the madewithclaude.com community gallery (aiwiki rate-limited);
- "streams source in Code view, then flips to Preview" (the cited guide says the panel opens in Preview);
- version arrows at the bottom-left;
- "no token cost on refresh" for live artifacts.

**New contradictions found and recorded:**
- Help 9547008 says every Share-dialog viewer, including viewers of Claude Code artifacts, needs a Claude account. The Claude Code docs say public links open "with no claude.ai sign-in required".
- Community sources disagree on whether localStorage works in legacy chat artifacts. For new hosted artifacts, the Artifact tool contract says it works per origin.
- The claude.com copy of "Build and share AI-powered apps" displays "July 25, 2025", but its own update note is dated July 17, 2025 and HN shows the anthropic.com original on 2025-06-25.

**Added from primary sources:**
- 2025-08-21 embed codes;
- 2026-07-07 "Chat and Cowork also share one home";
- Team and Enterprise "Share & copy link" for legacy artifacts, and the exposure of conversation attachments;
- batched Markdown edit requests;
- Docs attribution and no-trash deletion;
- design-system migration banners;
- the Claude Code artifacts launch restriction ("cannot be made public").

**Not independently re-checked:** the Pragmatic Engineer publication date (2024-08-27 is plausible; Simon Willison's summary is 2024-08-28), the VentureBeat Claude Code article (blocked by a bot check), TestingCatalog's July 2024 article, and the individual HN example URLs for claude.site and claude.ai/public.

**Source-policy pass (2026-09-23):** claims whose only support was a leaked (unofficial) copy of the 2024 artifacts system prompt were removed, along with the links to it: the 2024-06-20 timeline row, the launch-era type identifiers and decision rules, and two bundled-library names. The launch criteria in 3.1 now cite the current help article (which gives "typically over 15 lines"). Quotes longer than 25 words were shortened or paraphrased.
