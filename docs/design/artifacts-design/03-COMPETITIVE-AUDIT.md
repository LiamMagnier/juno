# Competitive audit: how Claude and Figma handle made things, design and motion

**Date:** 2026-09-23. **Purpose:** step 2 of the Artifacts + Design merge (see `HANDOFF.md`). It records how Claude handles Artifacts and Claude Design after the 16 Sept 2026 merge, and how Figma handles Figma Design, in features, UI/UX and motion. It then maps what is worth adopting onto the Juno audit (`00-AUDIT-OVERVIEW.md`, `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md`). The merge plan (`04-MERGE-PLAN.md`) builds on this document.

**Inputs.**
- `research/claude-primary-evidence.md`: the lead's first-hand observation of Claude's typed artifacts (Design, Design System, Docs, Slides), capabilities and versions. It is authoritative for how Claude's platform works today, and nothing here contradicts it.
- Nine research lenses, each fact-checked adversarially on 2026-09-23: `claude-artifacts`, `claude-design`, `claude-merge`, `claude-ux-motion`, `figma-design-core`, `figma-prototyping-motion`, `figma-ai-products`, `figma-files-collab`, `others`. Each is filed at `research/<lens>.md`. Every claim below comes from them unless marked otherwise, and their corrections have been applied.
- The Juno audits (`00`, `01`, `02`) and the Juno motion law: `docs/design/ICONS_AND_MOTION.md` §2, `src/lib/motion.ts`, and the token ladder at `src/app/globals.css:314-349`.

**Confidence tags** (on every non-obvious claim):
- **[P]** primary. A vendor source: anthropic.com, claude.com, support.claude.com, code.claude.com, figma.com (blog, release notes), help.figma.com, developers.figma.com, or a vendor staff forum post.
- **[P·1st]** primary, observed first-hand on this machine. Three sources:
  - the lead's artifact-tool reads (`claude-primary-evidence.md`);
  - the shipped Claude desktop app, `/Applications/Claude.app` v2.7032.0, built 2026-09-22, whose styles and interface were inspected directly;
  - the installed Figma plugin skills and `plugin-api-standalone.d.ts` (a snapshot from about 3 to 16 Sept 2026), under `~/.claude/plugins/synced/…/figma/skills/`.

  Values observed in the shipped desktop app are exact. Which surface such a value belongs to is sometimes inferred, and is marked when it is.
- **[S]** secondary: press, reviews, teardowns.
- **[C]** community: Hacker News, vendor forums, personal blogs and app-store reviews.
- **[I]** inferred: my reading.
- **(unverified)**: the fact-check could not confirm it. Such claims are never load-bearing here.

**Juno defect ids** are those of the audits:
- `X-nn`: cross-cutting, in `00` §7.
- `Dn`, `Mnn`, `Lnn`: web, in `01` §6.
- `Hn` and Mac `Mn`: Mac, in `02` §8.

**Research limits.** The shared web-search budget ran out during the fact-check passes, so second sources came from direct fetches only. Several pages returned 403 (help.openai.com, canva.com). Neither Anthropic nor Figma publishes durations or easing for its own chrome transitions. Claude's motion values here were observed in the shipped Claude desktop app. Figma's chrome timings are unknown and are not guessed. Unofficial copies of vendor system prompts are not used as evidence; a behaviour known only from such material is marked (not publicly documented).

---

## 1. Summary: the ten things that matter most for Juno

1. **An artifact must outlive the message that made it.**
   - **Claude.** The step that made Claude's merge possible was storage, not UI. From 2026-08-19, new artifacts are "saved to your account", shareable in the org, and open on the web ([help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P]). In the new experience everything made "is saved to the Artifacts tab automatically" ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). The Chat/Cowork toggle disappeared last, on 2026-09-16, after the shared home (07-07), the one artifact system (08-19) and shared memory (08-25) were already in place ([release notes](https://support.claude.com/en/articles/12138966-release-notes) [P]).
   - **Figma.** Figma never makes an orphan. Agent-created files land in a chosen plan's Drafts, or in a named folder (local `figma-create-new-file/SKILL.md` and the MCP `create_new_file` schema [P·1st]).
   - **Juno.** Editing a message, regenerating an answer or deleting a chat hard-deletes artifacts, their hand edits and their public links (X-03, X-04, X-22). `Artifact` has no `userId` and no `deletedAt` (`00` §12.1). This is a precondition, not polish.

2. **One object, one view, several sizes. Design is a type, not a destination.**
   - **Claude.** Every typed artifact follows one path: a card in the reply, then a panel beside the conversation, then full screen, then one link ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]). Claude Design moved onto that path on 2026-09-16 ([blog](https://claude.com/blog/cowork-is-now-claude) [P]).
   - **Figma.** Design, Draw, Dev Mode and Motion are toolbar modes of one file, not separate documents ([help: toolbar](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar) [P]). Slides reveals the full editor with Shift-D ([help](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides) [P]).
   - **Both keep an explicit way to choose a type.** Claude has an **Output** picker in the message box, next to automatic routing ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]). Figma has **+ Create** ([help](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file) [P]).
   - **Juno.** One design object has four editors with two save semantics (`00` §4.4), `/design` is a destination, and the Mac has three doors to it (`02` §5).

3. **The model must revise the current version through targeted operations, and people must see what changed.**
   - **Claude.**
     - Claude moved from regenerating the whole artifact to create, update or rewrite with exact string replacement in late 2024 ([Quintino](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113) [C]).
     - The Design type tells the model to re-read the current files and change only what was asked (`claude-primary-evidence.md` [P·1st]).
     - The Docs connector guards human edits with content hashes, so "the person's words win" (Docs connector contract [P·1st]).
   - **Figma.** Figma's agent edits the live file, and its undo sits in the chat thread ([help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P]).
   - **Juno.** Chat revisions rebuild from the model's stale message text and drop components, variables, motion and comments (X-05, X-06). Juno also has two AI channels that cannot see each other (`01` §4.6).
   - **Juno's advantage.** Its validated, invertible design operations and exact-anchor patch protocol (`00` §8) are a better base for this than Claude's HTML string replacement.

4. **Every made thing needs a picture on every surface.**
   - **Figma.** Figma removed thumbnail previews from folders on 2026-08-03. Users said they could no longer find work, and Figma restored them on 2026-09-16 ([release notes](https://www.figma.com/release-notes/) [P]; [forum](https://forum.figma.com/share-your-feedback-26/figma-folders-57057) [C]).
   - **Claude.** Claude's transcript card carries a 56 px "sheet" thumbnail drawn for the file kind (observed in the shipped Claude desktop app [P·1st]).
   - **Juno.** A design appears as raw JSON in the chat card, on the share page, in library tiles and in Outputs (X-20, L30). The renderer that could draw it (`render.ts`, the SVG export) already exists.

5. **Versions must be visible, renderable and pinnable. No type ships without them.**
   - **Claude's gap.** Docs and Design shipped with "no version history yet", and it is their most-cited gap ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]).
   - **Claude elsewhere.** Generic artifacts have compare and restore. A share link pins "Latest" or a specific version ([help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P]). In Claude Science, links in chat point to "the specific version that existed at the time" ([docs](https://claude.com/docs/claude-science/artifacts) [P]).
   - **Figma.** Autosaves collapse under named versions, and a restore adds two checkpoints so nothing is lost ([help](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history) [P]).
   - **Juno.**
     - Code artifacts are append-only, but designs fold in place (`store.ts:179-203`).
     - The history rail cannot render an old version.
     - Every card shows the latest version, not the one its turn made (L9).

6. **Comments are the channel between people and the model.**
   - **Claude.**
     - A comment "sent to Claude" arrives in the session as a turn, and Claude answers in the thread (`claude-primary-evidence.md` [P·1st]; [code docs](https://code.claude.com/docs/en/artifacts) [P]).
     - In Docs, @Claude makes the edit and explains it, and Claude leaves its own comments while drafting ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]).
   - **Figma.** Figma's agent can "review" and "take action on comments" only when asked from its chat. No comment-to-turn path is evidenced ([help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P]).
   - **Lovable** adds two things neither has: a full-thread payload and an orphaned-anchor indicator ([docs](https://docs.lovable.dev/features/project-comments) [P]).
   - **Juno.** `DesignComment` exists with a `transactionId` field, but nothing writes it. No other type has comments (`00` §12.1). Juno can match Claude and beat Figma here.

7. **Sharing is two concepts, and governance ships with the first public script.**
   - **Claude's Share dialog** has:
     - an audience;
     - roles that differ by type (Design and Slides get view, comment and edit);
     - "Latest version" or "Specific version";
     - an unverified label for outside viewers: "Content is user-generated and unverified." ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts); [code docs](https://code.claude.com/docs/en/artifacts) [P]).
   - **Figma** keeps Share (people) apart from Publish / Update / Unpublish (the public web) ([help](https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file) [P]).
   - **Why governance matters.** Public Claude artifacts were used as a trusted-domain lure in a ClickFix malware campaign in Feb 2026 ([Anvilogic](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse) [S]).
   - **Juno.**
     - Opening the dialog publishes (L5).
     - Snapshots are chosen by timestamp and leak later edits (M31).
     - There is no takedown or moderation (X-31, X-32).
     - Moving previews to their own origin (the X-01 fix) re-enables scripted public pages, so governance must ship in the same release (`00` §12.8).

8. **Liveness comes from streaming into the object, and from honest in-flight states.**
   - **Claude's inline visuals** stream: the host diffs partial HTML into a live DOM as tokens arrive, so a visual paints while it is being written (the "Imagine" contract [P·1st]). How Claude Design fills its canvas during generation is (not publicly documented).
   - **Claude Docs** first creates a skeleton of "pending" intent blocks and opens it, then fills one section at a time (connector contract [P·1st]).
   - **Claude's app** reveals skeletons only after 0.5 s, so fast loads never flash (observed in the shipped Claude desktop app [P·1st]).
   - **Figma** exposes a "shimmer overlay" for nodes being generated (`node.placeholder`, d.ts L10151 [P·1st]).
   - **Juno.**
     - Nothing streams into the Canvas.
     - "Writing" is shown over old content (M15).
     - "Source unavailable" flashes before `done` (M14).
     - A cut-off revision is labelled "verified" (X-07).

9. **One motion model and one player.**
   - **Figma's problems.** Figma has four animation systems and two spring parameterisations. Its Motion animations cannot be started by a prototype interaction: they auto-play on load, as staff confirmed on 2026-06-29 and 2026-07-02 ([forum](https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428) [P/C]).
   - **Figma's sound part: the keyframe semantics** (local `figma-use-motion` skill; d.ts [P·1st]):
     - relative transform tracks;
     - easing on the incoming segment;
     - holds at both ends;
     - duration + bounce springs;
     - Timing and Easing variables.
   - **Juno.**
     - Juno already has three things Figma users ask for: `play-animation`, `scroll-into-view` and id-matched transitions.
     - But it has no player (M61), absolute x/y tracks (M64), easing on the outgoing segment, and springs exported as ease-out (L20).

10. **Phone and native are where both competitors are weakest.**
    - **Claude.** Claude's native apps are view-only for Docs, Design and Slides, and cannot change sharing ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). That holds even though the launch copy says "open on your phone", and TechCrunch wrote "edit them on their phone" ([TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) [S]).
    - **Figma.** Figma's mobile app cannot edit Design files or Slides decks ([help](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app) [P]).
    - **Juno's opening.** Juno's iPhone library already edits designs (`00` §0, self-checked).
    - **Juno's risks.**
      - It edits on a stale bundle, with a lossy save (X-14 to X-19).
      - One unknown artifact type blanks the whole native library (X-09).
    - Juno should publish an honest phone contract, and ship native decoding that tolerates unknown kinds before any new type ships.

**Where Juno already leads** (keep all of these through the merge):
- validated, invertible design operations (`operations.ts`);
- exact-anchor targeted patches with compare-and-swap;
- append-only versions with diff;
- one editor bundle on web, Mac and iPhone;
- one motion token ladder generated into CSS, framer and Swift;
- `scroll-into-view` and `play-animation` in the prototype model;
- iPhone design editing;
- offline reading on the Mac.

Sources: `00` §8; `02` §1 and §5.

---

## 2. Claude

### 2.1 (a) The artifact platform and how it evolved

#### Timeline

| Date | Event | Source |
|---|---|---|
| 2024-06-20 | Artifacts ship with Claude 3.5 Sonnet, in "a dedicated window alongside their conversation". About one full-time and one part-time engineer built it in three months | [Anthropic](https://www.anthropic.com/news/claude-3-5-sonnet) [P]; [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts) [S] |
| 2024-07-09 | Publish to a public `claude.site` URL, plus Remix | [@AnthropicAI](https://x.com/AnthropicAI/status/1810698780263563325) [P] |
| 2024-08-27 | General availability; create and view on iOS and Android | [VentureBeat](https://venturebeat.com/ai/anthropic-launches-claude-artifacts-generally-for-all-users-mobile) [S] |
| 2024-09-02 | Highlight code, then **Improve** or **Explain**. Improve still "recreates the entire code" | [Tom's Guide](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text) [S] |
| ~late 2024-10 | Targeted updates: create / update (string replace) / rewrite; waits 3–4× shorter | [Quintino, 2024-11-02](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113) [C] |
| 2025-06-25 | An artifacts space in the sidebar (your artifacts plus Inspiration). AI-powered artifacts are billed to the *viewer's* plan | [build-artifacts](https://claude.com/blog/build-artifacts), [claude-powered-artifacts](https://claude.com/blog/claude-powered-artifacts) [P] |
| 2025-10-21 | Persistent storage (20 MB, text, personal or shared, published only) and MCP connectors in artifacts | [build-artifacts update](https://claude.com/blog/build-artifacts); [help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P] |
| 2026-02 | Public artifacts are abused as a ClickFix malware lure | [Anvilogic, 2026-02-19](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse) [S] |
| 2026-03-12 | Inline interactive visuals: ephemeral, in the transcript, "not artifacts" | [claude-builds-visuals](https://claude.com/blog/claude-builds-visuals) [P] |
| 2026-04-17 | Claude Design (Labs) | [Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P] |
| 2026-06-12 | Inline editing of drafts: highlight, instruct, and Claude edits in place | [release notes](https://support.claude.com/en/articles/12138966-release-notes) [P] |
| 2026-06-18 | Hosted artifacts from Claude Code, updated in place at one private URL | [blog](https://claude.com/blog/artifacts-in-claude-code) [P] |
| 2026-07-07 | "Chat and Cowork also share one home now, with one place for your projects and artifacts" | [release notes](https://support.claude.com/en/articles/12138966-release-notes) [P] |
| 2026-08-19 | "Updated artifacts system": saved to the account, org-shareable, versioned, compare and restore. Old live artifacts become read-only | [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P] |
| 2026-09-16 | The chat, Cowork and Artifacts merge. Docs and Slides launch, and Design works inside conversations | [blog](https://claude.com/blog/cowork-is-now-claude) [P] |

URL schemes changed three times: `claude.site/artifacts/{id}` (2024), then `claude.ai/public/artifacts/{id}` (2025), then `claude.ai/artifact/{id}` and `claude.ai/code/artifact/{uuid}` (2026) [P/C]. Three URL generations and two artifact generations (legacy chat artifacts that need Publish, versus auto-saved new ones) still coexist.

#### How it works today (the substrate)

Everything here comes from `claude-primary-evidence.md` [P·1st] and the [Claude Code artifacts docs](https://code.claude.com/docs/en/artifacts) [P], unless another source is given.

- **Page and URL.** Every artifact is a hosted web page at a private-by-default URL.
- **Typed artifacts.** A typed artifact is a fixed runtime (`index.html`, `SKILL.md`, `artifact-type/*`) plus the instance's own content files under `project/`.
  - Types can be upgraded without touching instance content.
  - The four core types are **Design**, **Design System**, **Docs** and **Slides**.
  - The `SKILL.md` that a type ships is how the model learns to fill and revise it. New kinds therefore ship as data, not as client releases.
- **Runtime capabilities** a page can declare:
  - `artifact`: the page saves itself, with versions;
  - `assets`: an asset store;
  - `comments`: anchored threads;
  - `db`: a small shared database with path rules;
  - `downloads`: give the viewer a file;
  - `room`: live presence, including agents shown as marked agents;
  - `user`: who is viewing;
  - `mcp`: connected data;
  - `sample`: the page asks Claude a question.
- **Versions.**
  - Every publish is a version, with an optional label.
  - A publish over a newer version is refused and hands back the live one to merge.
  - `force` is used only on explicit user instruction.
- **Page limits.**
  - Rendered page up to 16 MiB. Scripts only from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and jsDelivr `/npm/`. Fonts only from Google Fonts.
  - fetch, XHR and WebSocket are same-origin only, plus the Google Fonts hosts. External images are blocked.
  - Pages are served from sandboxed `*.claudeusercontent.com`.
- **Viewer-scoped data.** A shared artifact runs connectors under *each viewer's* account, and each viewer approves them first. A reopened page "renders from the cached responses immediately, then updates with fresh results". Connector-backed artifacts can never be public. [P]
- **Governance.**
  - Org toggles: Artifacts, External sharing, and artifact connectors.
  - RBAC scoping, and separate retention for private and shared artifacts.
  - `claude_artifact_*` audit events, and a Compliance API (list, get version, delete) ([code docs](https://code.claude.com/docs/en/artifacts) [P]).
  - Publishing refuses impersonation, fabricated records and credential phishing (`claude-primary-evidence.md` [P·1st]).

#### Creation and information architecture

- **The model decides.** Claude makes an artifact when the content is "significant and self-contained (typically 15+ lines)" ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]). There is no mode switch. Reusing the identifier creates a new version.
- **Explicit ways in (2026):**
  - **Output** in the message box, then Docs, Slides or Design;
  - a template from the **Artifacts** tab;
  - **New artifact**, which starts with guided questions in Cowork;
  - `/docs` and `/design`.

  Sources: [help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P].
- **Library.**
  - The sidebar **Artifacts** tab holds everything made in the new experience, including Docs, Slides and Design, with "Filter by", a templates gallery and **New artifact** [P].
  - Cards show name, last edited, a view count for published items and a **Published** tag. A hover menu offers Star, Rename, Add to project and Delete ([ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) [S]).
  - Hosted artifacts also have a gallery at `claude.ai/code/artifacts` and can be pinned to the sidebar [P·1st].
- **The conversation layer.** One merged **Recents** list holds chats and tasks together ([help 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P]).

#### UI anatomy: card first, then pane

- **Card in the reply.**
  - The card is labelled with its type, for example "Interactive artifact". It opens into a split pane, with the conversation on the left as the reasoning trail and the artifact on the right as the product ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]).
  - In the shipped app the card is at most 520 px wide, and the whole card is one button.
  - When an artifact is edited several times, **every card except the latest goes to opacity 0**, so the thread shows one live card per artifact (observed in the shipped Claude desktop app [P·1st]).
- **Pane chrome.**
  - **Preview and Code** are two tabs of one pane.
  - Top right: Copy, whose dropdown offers "Download as HTML"; Publish or Share; refresh; and a ⋯ menu with version history and Add to project [S].
  - A version selector. A "slider icon (upper right)" switches between several artifacts in one conversation. View code, copy and download sit at the lower right ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
  - The panel is a labelled region named after the artifact's title. **Escape closes it and returns focus to the trigger, or else to the composer** (observed in the shipped Claude desktop app [P·1st]).
- **Error repair.** A **Try fixing with Claude** button next to a runtime error copies the error into a new message ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]).
- **Full width.** Full-width mode hides the chat entirely, and the split pane is cramped on small viewports ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]). Claude's own guidance for MCP Apps does better: fullscreen keeps "the composer always visible", with the close button in the native header ([MCP Apps guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]).

**Select, then ask** grew in waves. It is the pattern Juno should unify.

| When | Surface | Gesture → result | Source |
|---|---|---|---|
| 2024 | Code view | Highlight → **Improve** (small text box; the whole artifact was regenerated) or **Explain** (sent to chat) | [Tom's Guide](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text) [S] |
| 2025–26 | Markdown | Highlight → **Edit with Claude** → "Claude edits right where you marked it, so you don't have to describe which section you mean" | [help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P] |
| 2026-06-12 | Drafts | Highlight, type an instruction, edited in place | [release notes](https://support.claude.com/en/articles/12138966-release-notes) [P] |
| 2026 | Several Markdown files | Edit requests left in several files are "added to your next message, and the file list shows how many requests are waiting in each file" | [help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P] |
| 2026 | Design canvas | Click an element → inline comment; or drag, resize, align; or Claude-made sliders | [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P] |
| 2026 | Docs | Select text → comment → @Claude; the viewer tells Claude the mode, tab and selected blocks | [help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]; `claude-primary-evidence.md` [P·1st] |
| 2026 | Claude Science | Select text, click an image point, or use HTML Comment mode. Comments wait above the message box and go with the next message, then become cards on it | [Science comments](https://claude.com/docs/claude-science/comments.md) [P] |

#### Sharing flows

| Generation | Control | States and options | Source |
|---|---|---|---|
| Legacy chat artifacts (Free/Pro/Max) | **Publish** → modal (title, Usage Policy, "Your chat will remain private") → **Publish & copy link** | A public snapshot of one version. Unpublish **deletes storage permanently** and the artifact cannot be republished. Embed codes limited to an allowed-domains list (2025-08-21) | [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]; [ai-toolbox](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) [S] |
| New experience (all types) | **Share** → people and groups (Team/Ent) → audience (*Only you* / *Only people with access* / *Everyone in org* / *Anyone with the link*) → **Latest version** (live) or **Specific version** (snapshot) → Copy link | Roles: **Docs** View/Edit; **Design and Slides** View/Comment/Edit; others View/Edit. Viewers need a Claude account (the help says so; the Claude Code docs say public links need no sign-in, a contradiction the sources leave open). Mobile apps cannot change sharing | [help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts); [code docs](https://code.claude.com/docs/en/artifacts) [P] |
| External invites | Share → email → role (Can view / **Commenter** (default) / Can edit) → version → Invite | Up to 50 outside people per artifact; pending invites expire after 30 days. Outsiders cannot @mention Claude and get no notifications | [help 16989529](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact) [P] |
| Hosted page header | Title · **Share** (an "Always share latest version" toggle, a version picker, an audience, Copy link) · author avatar | Outsiders see `Content is user-generated and unverified.` instead of the author | [code docs](https://code.claude.com/docs/en/artifacts) [P] |

**Comments sent to Claude (hosted artifacts).**
- Only org-shared artifacts take comments.
- Only an **editor** can activate a thread with Send to Claude or `@claude`.
- The publishing session watches the page and replies or edits, depending on its permission mode.
- Status lines read "Auto-replied to comment thread…" and "Comments are waiting…".
- Auto-replies pause after 60 activations per artifact per hour.
- Public artifacts cannot take comments ([code docs](https://code.claude.com/docs/en/artifacts) [P]).

#### Motion (documented)

- **Refresh in place.** "The open page refreshes in place and teammates see the updates the moment they're published" ([blog 2026-06-18](https://claude.com/blog/artifacts-in-claude-code) [P]).
- **Cache first, then refresh** for live data (above) [P].
- **Inline to fullscreen.** Inline cards expand to fullscreen "with a smooth transition", and closing "returns to the conversation at the same scroll position". **Skeletons, not spinners**: "Match the layout structure of the final content" ([MCP Apps guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]). No durations are published.
- **Anti-pattern.** A full rewrite "slowly deletes every line of code before rewriting it" ([BigGo, 2025-07-16](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues) [S]).
- (unverified) That the pane streams source in the Code tab and flips to Preview on completion. The cited guide says instead that the panel opens in Preview.

#### Weaknesses of the artifact platform

1. **Rewrites and truncation.** Full rewrites mangle artifacts: "I tell Claude not to put anything in the artifacts because it always … messes them up" ([BigGo](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues) [S]). Output truncated at the limit leaves unclosed tags and a blank preview ([Pagelive](https://pagelive.io/claude-artifacts/not-working) [S]).
2. **Silent data loss.**
   - Storage writes in drafts "will not succeed until the artifact is published" ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]), with no error shown ([Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]).
   - Unpublishing deletes the data for good ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]).
   - Docs deletion is permanent: "There's no trash" ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]).
3. **Generations running side by side.**
   - Legacy chat artifacts use Publish, while the new experience uses auto-save plus Share.
   - Old Cowork live artifacts are viewable but not editable ([help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P]).
   - Claude chooses inconsistently between an inline visual and an artifact ([HN 47352751](https://news.ycombinator.com/item?id=47352751) [C]).
4. **New types shipped without basics.** Docs and Design have no version history. Docs has no comment-only role. Design comments "can disappear before Claude reads them", and multi-person editing "may not work reliably" ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]).
5. **Mobile.** The native apps are view-only, which contradicts the press reading of the launch (§2.3).
6. **Abuse.** Public pages were used for the ClickFix campaign. Pluto Security got synthetic credentials into published pages in 10 of 85 attempts (2026-08-06, via [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) [S]). No Anthropic source says the "unverified" label was a response to either [I].
7. **Concurrency.** Pages that save themselves are last-writer-wins with optional leases ([chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) [C]).
8. **Chrome.**
   - Publish and Copy look alike, which invites accidental shares.
   - The code tab has no inline editing.
   - The card and the prose repeat each other once the artifact is open ([AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S]).
9. **Cost.** "Artifacts count toward your plan's usage limits". A styled page costs more tokens than text, and data-URI images cost most ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them); [code docs](https://code.claude.com/docs/en/artifacts) [P]).
10. **False trust.** A polished visual "improves the perceived confidence of the LLM but doesn't do much for correctness" (captainbland, [HN 47352751](https://news.ycombinator.com/item?id=47352751) [C]).

**Sibling pattern: Claude Science** ([docs](https://claude.com/docs/claude-science/artifacts) [P]).
- Artifacts open "in a tab beside the chat". Ctrl/Cmd-click opens full screen.
- The per-artifact menu has Open beside session, **View in context**, **Provenance** (Messages, Code, Execution Log, Environment, Review), Versions, Copy link, Star, Rename, Download and Delete. Renaming does not break links.
- A **version stepper plus a diff toggle** compares against any earlier version.
- Links in chat pin the version that existed when the message was written.

This is the most complete version UX Anthropic ships.

---

### 2.2 (b) Claude Design

#### What it is and how it got here

- **Launch.** Claude Design launched **2026-04-17** as an Anthropic Labs research preview on Claude Opus 4.7, for Pro, Max, Team and Enterprise (off by default on Enterprise) ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P]).
- **What it does.** You describe a visual and Claude builds a first version as live HTML on a canvas beside the chat. You refine it "through conversation, inline comments, direct edits, or custom sliders (made by Claude)" [P].
- **Adoption.** More than a million people used it in the first week ([blog 2026-06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work) [P]). Figma's stock fell about 7% on launch day ([Gizmodo](https://gizmodo.com/anthropic-launches-claude-design-figma-stock-immediately-nosedives-2000748071) [S]).
- **2026-06-17, "stays on brand" update** ([blog](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work) [P]):
  - a rebuilt design-system import that accepts several systems, and a self-check against the system before output;
  - an Enterprise **Claude Design Admin** permission;
  - `/design-sync` and `/design` with Claude Code;
  - a new editor with **drag, resize and align**, plus "hundreds of stability fixes";
  - usage limits shared with the rest of Claude. At launch, PCWorld had used 80% of its weekly Design allowance in about 25 minutes ([PCWorld](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html) [S]).
- **2026-08-17 to 08-21.** `/design` in the Claude Code CLI "publishes a canvas of editable artboards" ([W34](https://code.claude.com/docs/en/whats-new/2026-w34) [P]).
- **2026-09-16.** Design "now works inside your conversations too":
  - through Output > Design, Design templates in the Artifacts tab, `/design` in Claude Code, and view-only in the mobile apps;
  - decks moved to Claude Slides;
  - the standalone `claude.ai/design` "keeps working", with its own setting and analytics ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design); [admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P]).

#### The format, and the container that changed

- **The file.** Each artboard is a self-contained **Design Component** page, `Name.dc.html`. It holds `<x-dc>` markup with inline styles, `{{hole}}` bindings to `renderVals()` of a `class Component extends DCLogic`, and `data-props` JSON that declares **tweaks**, such as `{"accent":{"editor":"color","default":"#d97757"}}` (`claude-primary-evidence.md` [P·1st]). Whether the standalone app uses the same file format is (not publicly documented).
- **The standalone container** is a project, opened from a project picker ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) [S]), with its own settings, analytics and storage ([admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P]). Its internal file layout is (not publicly documented).
- **The integrated container** is `canvas.json` [P·1st]:
  - **pages** (up to 40) of **artboards** placed with x/y/w/h on an infinite canvas;
  - **notes** (72 px headings over groups) and **stickies**;
  - user-drawn shapes;
  - a **Theme menu** fed by an installed design system's tokens;
  - a focused single-artboard view;
  - **Play** mode for `<a href>` prototype links;
  - letter/A4 print pagination.

  Declared capabilities: artifact, assets, comments (composer_only, customAnchors), db, downloads, room and user.
- **Craft rules the model follows** [P·1st]:
  - no filler, lorem ipsum or fake stats;
  - 1–3 typefaces and 0–2 accents;
  - no gradient washes, left-border cards or emoji;
  - touch targets of at least 44 px;
  - real `<button>`/`<input>` elements, even in static mockups;
  - "Tell the user what happens on the canvas, never the mechanism";
  - do **not** self-verify unless asked.

#### Workflow

1. **Entry.**
   - Ask in any conversation, or pick Output > Design.
   - Choose a Design template in the Artifacts tab.
   - Use `/design` in Claude Code.
   - Standalone: a project picker, then Prototype (Wireframe / High fidelity), From template, or Other ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) [S]).
2. **The design system attaches automatically** from the org default ([help 14604397](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design) [P]).
3. **Clarifying questions before building.** Builder.io called it a "taste exam" that uses the whole canvas ([Builder.io](https://www.builder.io/blog/claude-design) [S]). PCWorld took about a minute to answer the multiple-choice questions [S]. How the form is built and how its rounds behave is (not publicly documented).
4. **Generation** takes "minutes" [S]; UX Pilot measured 4 to 7 minutes per iteration ([UX Pilot](https://uxpilot.ai/blogs/claude-design-review) [S]). How the canvas fills while Claude generates is (not publicly documented).
5. **Refine.** Five surfaces, in the next table.
6. **Present, share, export, hand off.**

#### The five refine surfaces

| Surface | Where and how | Behaviour | Source |
|---|---|---|---|
| Chat | Beside the conversation; in standalone, a narrow left panel | Broad and structural changes, alternatives, explanations | [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P] |
| Inline comments | Comment mode; click an element and type | Comments can be batched ("select for Send to Claude") and resolved in one turn [S]. **Known bug:** comments can vanish before Claude reads them [P] | [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]; [getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) [S] |
| Direct edit | Edit mode opens a contextual inspector: type options for a sentence, layout options for a grid. Covers borders, colours, font options and margins, in designer words ("tracking") | Free movement arrived with drag/resize/align on 06-17. In the integrated type a properties panel edits inline styles, and the view state (the current artboard and selection) is passed to Claude [P·1st] | [Builder.io](https://www.builder.io/blog/claude-design) [S]; [blog 06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work) [P]; `claude-primary-evidence.md` [P·1st] |
| **Tweaks** | Sliders and other controls that Claude makes for the design, shown as levers in the editor | The model declares typed props, and the host renders them and **changes the design live with no model turn** | [Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P]; `data-props` [P·1st] |
| Draw | Sketch or annotate. Annotations queue and are sent together, with optional voice | Builder.io calls it a "scratchpad" usable while the agent works | [Builder.io](https://www.builder.io/blog/claude-design) [S]; [getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) [S] |

Anthropic's own rule of thumb: comments for component-level fixes, chat for structure, direct edit for quick visual changes ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]).

- **Options.** Claude gives about three variations by default. Claire Vo called that "Claude Design's smartest UX choice" ([Lenny's](https://www.lennysnewsletter.com/p/what-claude-design-is-actually-good) [S]). Builder.io found the multi-option view "currently buggy" [S]. How options are laid out and referred to is (not publicly documented).
- **Versions.** "Claude Design doesn't have version history yet". The workaround is to say "Save what we have and try a completely different approach" ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]). PCWorld mistook undo for back and "The undo wiped everything" [S].

#### Export, handoff, design systems, governance

- **Export menu (top right)** ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]):
  - Files: .zip, PDF, PPTX, Google Slides (standalone only), standalone HTML.
  - **Send to** 15 destinations: Adobe Experience Manager, Adobe for Creativity, Adobe Journey Optimizer, Base44, Canva, Gamma, HubSpot, Hyperframes, Lovable, Miro, Netlify, Replit, v0, Vercel, Wix.
  - **Hand off** to Claude Code, to a local coding agent, or to Claude Code Web.
  - **There is no Figma export.**
  - Artboards in the integrated type export as PNG or PDF ([code docs](https://code.claude.com/docs/en/artifacts) [P]).
- **The handoff bundle.** Anthropic's description: "a handoff bundle that you can pass to Claude Code with a single instruction" [P]. What the bundle contains, including whether it records motion, is (not publicly documented).
- **Design systems.**
  - Claude builds one from codebases, Figma files, decks and brand assets. A **Published** toggle makes it the org default, and every new project inherits it ([help 14604397](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design) [P]).
  - Since 2026-09-16 each design system is an **artifact** under Settings > Design systems. A **"Migrate team design systems"** banner moves old ones over, and a **"Let Claude clean it up"** banner tidies imperfect results ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]).
  - Output is "only as good as its source" [P]. Builder.io estimates 50–75% fidelity when Claude approximates a system [S].
- **Governance** ([admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P]):
  - **Two separate switches**: Organization settings > Artifacts > Design (integrated) and > Capabilities > Claude Design (standalone). Changes take up to 15 minutes.
  - The Claude Design Admin permission reserves three actions: publish, set default, delete.
  - Previews run "in a sandboxed iframe on a separate Anthropic content domain", with short-lived signed tokens "re-checked against sharing permissions on every open".
  - Analytics cover standalone only, and standalone has no audit logs.
  - The integrated version is unavailable to CMEK, ZDR and HIPAA orgs.

#### Motion in Claude Design

Anthropic publishes no durations or curves for Claude Design. How the canvas paints while Claude generates, the motion of the Tweaks controls and of deck presentation, and any animation timeline or video export are (not publicly documented). Video is not in the documented export list (above). What public and first-hand sources show:

- **Live tweaks.** "adjustment knobs to tweak spacing, color, and layout live" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P]).
- **Slides type** transitions `fade | push | magic` (magic = morph) and build-ins `fade | rise | pop` [P·1st].
- **Selection and movement in the merged product.** "You can select an element and move it, or tell Claude what you want changed" ([blog](https://claude.com/blog/cowork-is-now-claude) [P]). No durations are published.

#### Weaknesses of Claude Design

- **Generic output.**
  - "You'll get a competent UI with little effort but nothing truly unique" ([HN 47806725](https://news.ycombinator.com/item?id=47806725) [C]).
- **Imprecise editing.**
  - "Squarespace with AI attached"; no layers ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about), [UX Pilot](https://uxpilot.ai/blogs/claude-design-review) [S]).
  - "LLMs are blind, and spatial relativity is tremendously hard across layers of nested html / css" ([HN 48128003](https://news.ycombinator.com/item?id=48128003) [C]).
- **Speed.** It is slow: minutes per turn [S].
- **Export.**
  - No Figma export ([Anima](https://animaapp.com/blog/ai-design-en/claude-design-review-features-pros-cons-and-best-alternatives/) [S]; export list [P]).
  - PPTX exports overlap text ([UX Pilot](https://uxpilot.ai/blogs/claude-design-review) [S]).
  - The Canva export was "intermittently failing" ([dgtl dept](https://www.dgtldept.com/p/claude-design-escape-the-default) [S]).
- **Anthropic's own known issues** ([help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]):
  - no version history;
  - comments can disappear;
  - multi-person editing is basic;
  - large repos lag;
  - "chat upstream error";
  - mobile is view-only.
- **Lock-in.** A user lost access to their projects after unsubscribing, and Anthropic promised downloads would stay possible ([HN 48128003](https://news.ycombinator.com/item?id=48128003) [C]).
- **Split-brain between standalone and integrated.** Two switches, two analytics views, two project stores, and Google Slides export only in standalone ([admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P]).

---

### 2.3 (c) The 16 Sept 2026 merge, Claude Docs and Claude Slides

#### The merge was staged, and the toggle went last

| Date | Step | Source |
|---|---|---|
| 2026-01-12 | Cowork research preview (macOS, Max): agentic knowledge work in a VM | [release notes](https://support.claude.com/en/articles/12138966-release-notes) [P] |
| 2026-04-09 | Cowork GA on macOS and Windows | same [P] |
| 2026-07-07 | Cowork on web and mobile; cloud sessions; **one home for projects and artifacts** | [blog](https://claude.com/blog/cowork-web-mobile); release notes [P] |
| 2026-08-19 | One updated artifacts system: account-owned, versioned, org-shareable | [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) [P] |
| 2026-08-25 | Memory works across chat and Cowork | release notes [P] |
| **2026-09-16** | Chat/Cowork toggle removed. Docs and Slides beta. Design inside conversations | [blog](https://claude.com/blog/cowork-is-now-claude) [P] |
| 2026-09-17 | Projects redesigned as a coordinator conversation with parallel threads and a Library of files and artifacts (narrow beta) | [blog](https://claude.com/blog/projects-redesigned) [P] |

**Rationale.** Users found it frustrating to decide where a task belonged, and work started in one place did not carry over ([blog](https://claude.com/blog/cowork-is-now-claude) [P]; [TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) [S]). A staff member (Felix Rieseberg) named the enabler on HN: Artifacts were made "much more powerful", so anything Claude makes, from an app to a design system, can be deployed as an artifact "with multiplayer features and databases" ([HN 49730108](https://news.ycombinator.com/item?id=49730108) [C]).

#### What changed in the interface ([help 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P] unless noted)

- **Message box.**
  - The Chat and Cowork options are gone, and so is the web-search toggle.
  - Research moved to `/deep-research` or **+**. New commands include `/schedule` and `/docs`.
  - **Output** picks Docs, Slides or Design ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]).
  - A permission control offers **Manual** (the default: Allow/Deny before each action) or **Auto** (keeps working with an automated safety review). It can be changed mid-conversation. Legacy Cowork's Skip mode is not offered ([help 13345190](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [P]).
- **Sidebar.** One **Recents** list; the **Artifacts** tab with templates and New artifact; Projects; Customize.
- **Settings.** "Instructions for Claude" under General; Storage folder and Trusted folders.
- **Where outputs appear.** In a panel beside the conversation that can expand to full screen ([help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P]; [go9x](https://go9x.com/blog/claude-docs-slides-design) [S]).
- **Lost in the merge.** Conversation branching, "Add from GitHub", and Dispatch for new users. Incognito falls back to the old experience, and search skips older Cowork tasks.
- **Rollout.** Staged by account, Pro and Max first. **Once an account is switched it cannot go back.** Enterprise gets at least 30 days' notice.

#### Routing

- Claude decides between a quick answer, an agent task and a typed artifact. No routing algorithm and no "routing to X" indicator is published [P, absence].
- The help centre advises stating the outcome, the format and the inputs [P].
- The Docs connector's own rule [P·1st]: a doc-shaped ask becomes a doc, and the chat reply is one line with the link.

#### Claude Docs (beta)

- **Content model.**
  - Tabs, which can nest.
  - Prose, tables, **charts from connected data that do not auto-refresh**, task lists, Mermaid and LaTeX.
  - Chips: @mentions, dates, and dropdowns tied to an enum.

  Sources: [help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]; connector [P·1st].
- **How Claude writes a doc** (connector contract [P·1st]):
  - The first call creates a **skeleton**: title, byline, and one **pending block per section, each showing its intent** (for example "Timeline: milestones by week"). The doc opens on screen immediately.
  - Claude then fills **one section per call, in reading order**, with a short chat line between sections.
  - The stated reason: a single write streams nothing and would show "a long blank page and then a wall of text".
  - People can edit while Claude writes, and edits to blocks Claude did not write are guarded by content hashes.
- **Comments.**
  - Select text and comment. An @Claude mention makes Claude "reply in the thread, make the change, and explain what it did", and Claude also leaves its own comments while drafting [P].
  - A comment sent to Claude arrives as a turn that must be answered in the doc thread. An `answered` flag stops a second session answering twice.
  - Limits: 1,000 threads per doc, 100 comments per thread, 4 KB per comment [P·1st].
- **Sharing and export.**
  - Roles are View and Edit only; there is **no comment-only role**.
  - Pro and Max can share only by public link. Team and Enterprise have no external sharing.
  - Export to Word, PDF, Markdown or Google Docs, or convert the doc to Slides.
  - Deletion is permanent, and **mobile is view-only** [P].
- **No version history.** Docs lists "No version history yet". The connector nonetheless reads a doc "at rev N" and has a `restore` op, and the viewer bundle ships `VersionBar` and `VersionPreviewPane` modules [P·1st]. The data exists; the UI does not.

#### Claude Slides (beta)

- **Editing and export.** You can "edit directly, present straight from Claude, or download as PowerPoint or PDF" ([blog](https://claude.com/blog/cowork-is-now-claude) [P]). A deck made in the same thread as a report already matches it [P].
- **Type contract** [P·1st]:
  - 1920×1080 slides;
  - `deck.json` holds sections, with a one-sentence outline each, and up to four font faces;
  - one `<section>` per slide, from a closed set of elements (shapes, icons, connectors, a sandboxed `<x-embed>` live mini-page, speaker notes as `<aside>`);
  - transitions `fade | push | magic` and build-ins `fade | rise | pop`;
  - room presence.
- **Hands-on report** ([go9x](https://go9x.com/blog/claude-docs-slides-design) [S]): the background colour picker **offers only design-system colours**; there are speaker notes and full-screen editing.
- **Roles.** View / Comment / Edit [P].
- **Undocumented.** Whether exported PPTX keeps editable text boxes ([Coursiv](https://coursiv.io/blog/claude-docs-slides-design) [S]), and the Present-mode controls.

#### The mobile contradiction

- **The launch blog** says everything "lives at one shareable link you can open on your phone". The next sentence says you can select an element and move it, without saying on which device ([blog](https://claude.com/blog/cowork-is-now-claude) [P]).
- **The press** reads it as phone editing. TechCrunch wrote that users "can share generated documents or slides with a link and edit them on their phone" ([TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) [S]), and tbreak said the same ([tbreak](https://tbreak.com/claude-docs-slides-one-claude/) [S]).
- **The help centre** says the native apps view artifacts in the Artifacts tab, but templates, editing and sharing need web or desktop [P].
- [I] The hosted page is probably editable in a mobile browser: the frame shell has a phone drawer and Docs has a `BottomSheet` module [P·1st]. The native apps are view-first.

#### Reactions and criticisms

The HN thread on the launch drew 234 points and 225 comments ([HN 49729412](https://news.ycombinator.com/item?id=49729412) [C]). Recurring points:

- **No chat-only mode.** Users lost a guaranteed chat-only mode (LoganDark) and a "think first, act later" surface.
- **Opaque routing.** "Know they are being routed" (bcorigliano).
- **Safety.** Capabilities are now on by default (Selkirk).
- **Multi-day work.** Chat is a poor interface for it (cpinto), and branching was lost (clumsysmurf).
- **Sidebar clutter.** "designer is always there, I never need to bring up artifacts" (saratogacx). Users also asked to switch off the rotating tips.

Beyond HN:

- **Governance.** "Your AI policy just expired" ([Stephen Smith](https://www.smithstephen.com/p/claude-stopped-asking-which-mode) [S]).
- **Cost.** Routing simple asks through agent machinery raises cost. Fortune cites a Stanford estimate of about 1,000× the tokens for agentic tasks ([Fortune](https://fortune.com/2026/09/16/anthropic-merges-its-claude-chat-and-agentic-cowork-products-into-a-single-ai-assistant-as-part-of-a-push-to-build-an-ai-superapp/) [S]).
- **Analysts** doubt suite users will switch ([Computerworld](https://www.computerworld.com/article/4223177/anthropic-tries-to-make-claude-stickier-with-launch-of-docs-and-slides.html) [S]).

---

### 2.4 (d) UX craft and motion in Claude's apps

Values below were observed in the shipped Claude desktop app, v2.7032.0 built 2026-09-22 [P·1st], or come from the "Imagine" contract that governs inline visuals [P·1st], unless noted. The fact-check corrected several mappings of values to surfaces, and those corrections are applied here.

#### Three weights of made thing

| Tier | Where | Lifetime | Notes |
|---|---|---|---|
| Inline visual (`show_widget`) | In the transcript: a 680 px auto-height sandboxed iframe | Ephemeral: they "change or disappear as the conversation evolves". Can be kept with Copy as image, Download .svg/.html, or **Save as artifact** | [blog](https://claude.com/blog/claude-builds-visuals); [help 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) [P]. Not rendered on iOS or Android |
| Artifact card → panel | A card, then a panel beside the chat | Persistent, versioned | [help 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) [P] |
| Typed artifact (Design, Docs, Slides, Design System) | "A conversation with a canvas", and a hosted page at one link | Persistent, shareable, commentable | [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P] |

The model escalates on its own: "If the visual is complex … consider creating an artifact instead" [P·1st].

#### The motion system (CDS tokens)

| Token | Value | Typical use |
|---|---|---|
| Shortest duration | 60 ms | stagger offsets, delayed bodies |
| Snap duration | 120 ms | hovers, reveals, crossfades |
| Base duration | 200 ms | state changes, scrims |
| Sheet duration | 300 ms | drawers and sheets |
| Long duration | 450 ms | lifts, the user-bubble pop, lighting |
| Default curve | `cubic-bezier(.165,.84,.44,1)` (quart-out) | the default |
| Snap curve | `cubic-bezier(.32,.72,0,1)` | panels, sheets, view transitions |
| Overshoot curve | `cubic-bezier(.34,1.3,.64,1)` | pops, bubbles |

Almost every animation in the app uses these values. Juno's ladder is close to the same: `ease-drawer` and `ease-out-strong` are Claude's snap curve exactly, `ease-out-back` (.34,1.32,.64,1) is within 0.02 of Claude's overshoot curve, and both products use 120 ms for the fast rung (§7.1).

#### Signature motions

| What | Spec | Note |
|---|---|---|
| Streaming text | Only the **tail** animates: new words fade `opacity 0→1` over **100 ms linear**, and only under `prefers-reduced-motion: no-preference`. Open fences, lists and tables render through fast paths, so half-streamed structure shows without re-layout | [P·1st] |
| Title that changes | Old text blurs out over 200 ms; the new title cascades in per grapheme (from a 6 px blur to sharp, 90 ms `cubic-bezier(.215,.61,.355,1)`, 30 ms stagger), with an sr-only copy. Used for sidebar session titles and renames, not for response text | [P·1st] (fact-check correction) |
| User bubble | Grows from 92% scale and rises 6 px into place over 450 ms on the overshoot curve, anchored at the right (the send side) | [P·1st] |
| Artifact card hover | The 56 px sheet lifts 2 px, a light sweeps across it (450 ms), and an under-sheet fans to −4°. Each kind plays a micro-story: code types a rule in 8 steps over 360 ms, image corner brackets tighten over 320 ms, an archive zips | [P·1st]. The scale 1.035 / ≈3.7° tilt belongs to a legacy fallback card |
| Frame content swap | **120 ms opacity crossfade**. The empty panel is kept mounted at zero size so the sandbox stays warm (inferred) | [P·1st] |
| Resize | **All transitions switched off while resizing**, so panes track the pointer 1:1 | [P·1st] |
| Phone drawer | 300 ms quart-out; follows the finger with transitions off while dragging | [P·1st] |
| Image lightbox | View Transitions morph of inset, radius and shadow, **350 ms `cubic-bezier(.32,.72,0,1)`** | [P·1st]. The only shared-element morph found |
| Working text | A copy hidden from assistive technology carries a 120° highlight band, 3 s linear. The peak is the text colour mixed 30% with white, so it works on every tone and theme | [P·1st] |
| Claude is working | A clay dot breathes (scale .86↔1, 3 s ease-in-out); a dot pulse runs at 1.8 s | [P·1st]. Stops under reduced motion |
| Progress timeline | Status rises in over 240 ms `cubic-bezier(.3,.7,.4,1)` and falls out over 180 ms (−4 px); a spark departs over 420 ms as a step completes; collapsibles use `grid-template-rows 0fr→1fr` | [P·1st] |
| Skeletons | Revealed only **after 0.5 s** (transcript placeholders after 2.5 s), with a 150 ms fade, then a 2 s sweep | [P·1st] |
| Comment being worked on | The anchored text's highlight pulses at 1.6 s; under reduced motion it becomes a static 2 px underline | [P·1st]. The surface is inferred from the class name |
| Thinking copy | The "Thinking…" label is reworded three times as the wait grows, each time acknowledging the longer wait | [P·1st] |
| Conflict copy | Names the cause (someone saved a newer version), says the person's edits are kept while the latest files reload, and gives the next step (review, then save) | [P·1st] |

- **Versions are swaps, not shows.** A 120 ms crossfade, a version stepper, and diff toggles (Claude Science). No morph between versions was found [I].
- **Hot swap.** The desktop app's frame runtime includes hot-swap modules that replace changed code in a running page while keeping its state [P·1st]. That this runs on Design pages specifically is (unverified).

#### Inline-visual contract (the "seamless" rules) [P·1st]

- **Look.** "Users shouldn't notice where claude.ai ends and your widget begins." Flat, with 0.5 px borders, Anthropic Sans at weights 400 and 500 only, and sentence case.
- **No gradients, shadows or blur**, because they "flash during streaming DOM diffs". The host diffs partial HTML into a live DOM as tokens arrive.
- **Streaming order.** Style first, script last, and nothing hidden during streaming ("hidden content streams invisibly").
- **Loading messages.** 1 to 4 model-written `loading_messages`, parsed from the partial tool JSON and shown before any code arrives (the parsing is inferred).
- **Animation.** `transform` and `opacity` only, loops under about 2 s, all wrapped in `prefers-reduced-motion: no-preference`.
- **Fullscreen.** No widget-initiated fullscreen: the **host** owns expand ([help 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) [P]).
- **Accessibility, mandatory.** An sr-only summary. SVG roots get `role="img"` with a title and description.

#### Settings, voice and restraint

- **Reduced motion is an in-app setting.** Settings ▸ Motion offers **System | Reduced**: "Reduce animation in streaming responses and other interface elements." It sets a flag on the document root that the app's motion-safe styles read [P·1st].
- **Chat font.** Serif by default ("Serif is Claude's voice"), then sans, system, Atkinson Hyperlegible Next (feature-flagged) and OpenDyslexic. A separate setting controls the interface font [P·1st].
- **Colour.** Clay `#d97757` is reserved for Claude-initiated actions (send, generate, the spark mark). User primary actions use accent blue [P·1st].
- **Restraint rules:** at most one accent-filled button per view, at most two floating elevations, and "Ellipsis = in progress only" [P·1st].
- **MCP Apps.** The host passes Claude's own tokens and fonts to the app, and `availableDisplayModes: ["inline","fullscreen"]`. The spec also defines picture-in-picture [P·1st]. The guidance: inline cards get at most two actions, no nested scroll and no menus; the conversation owns vertical scroll on mobile ([MCP Apps guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) [P]).

#### Weaknesses in craft

- Inline visuals show only to logged-in web and desktop viewers of a shared chat, and do not render from Cowork share links ([help 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) [P]).
- No live-region announcement when an artifact completes was found [I].
- The context-compaction bar approaches but never passes 95% until the job is done [P·1st]. That is an honest-looking but fake progress signal.

---

## 3. Figma

### 3.1 (a) The core editor

#### How the chrome got here

| Date | Event | Source |
|---|---|---|
| 2024-06-26 | **UI3** announced: a floating bottom toolbar, a component-centred properties panel and new icons. Also Code Connect GA, and Dev Mode's ready-for-dev and focus views | [Config 2024 recap](https://www.figma.com/blog/config-2024-recap/) [P] |
| 2024-10-01 | "Our approach to designing UI3": **floating panels tried in the beta were reverted to fixed, resizable panels** because they cramped the canvas, weakened the rulers and slowed people down. "Speed is a feature" | [blog](https://www.figma.com/blog/our-approach-to-designing-ui3/) [P] |
| 2025-04-30 | UI2 removed; UI3 mandatory | [blog 2025-03-25](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/) [P]; [forum](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) [C] |
| 2025-05-07 | Config 2025: grid auto layout (beta), Draw mode, and Make, Sites and Buzz | [recap](https://www.figma.com/blog/config-2025-recap/) [P] |
| 2025-09-18 | Renderer moves to WebGPU, with a fallback to WebGL mid-session | [blog](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) [P] |
| 2025-10-28 | Schema 2025: extended variable collections (Enterprise), slots (early access), Check designs, DTCG 1.0 JSON, 10/20 modes, MCP server GA | [recap](https://www.figma.com/blog/schema-2025-design-systems-recap/) [P] |
| ~2026-01-07 | A permanent **left navigation rail** begins a phased rollout. Backlash follows | [forum](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) [C] |
| 2026-05-20 | **Design agent** beta, on the canvas and in the rail | [blog](https://www.figma.com/blog/the-figma-agent-is-here/) [P] |
| 2026-05-22 / 06-01 / 06-04 | Grid GA; slots GA; Check designs (Org/Ent) | [release notes](https://www.figma.com/release-notes/) [P] |
| 2026-06-24 | Config 2026: **Motion**, shaders, generative plugins, Weave tools (open beta); **code layers** (closed beta) | [recap](https://www.figma.com/blog/config-2026-recap/) [P] |
| 2026-08-05 / 09-17 | EASING and TIMING variable types; composed colour and opacity variables | [Plugin API updates](https://developers.figma.com/docs/plugins/updates/) [P] |
| 2026-08-26 | The agent chat can pop out into its own desktop window | [release notes](https://www.figma.com/release-notes/) [P] |

#### Layout and information architecture

| Zone | Contents | Source |
|---|---|---|
| **Navigation rail** (far left, 2026) | Menu, **File** (⌥1), **Agents**, **Assets** (⌥2), **Tools** (plugins, widgets, shaders, Weave), **Variables** (a full-window view), Notifications. It cannot be hidden on its own | [help](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar) [P] |
| **Left sidebar** (resizable) | Pages, Find/Replace, the Layers tree (the tree order is the z-order; hover visibility and lock toggles; optional highlight on hover; optional per-layer memory readout) | same [P] |
| **Canvas** | Infinite, per page: page → section → frame | [help](https://help.figma.com/hc/en-us/articles/30925881896727-FD4B-Navigate-Figma-Design-files) [P] |
| **Properties panel** (right; fixed, resizable) | **Design** and **Prototype** tabs. For a component or instance, the component section comes first. Size, auto layout, flow, gap and padding are merged into one **Layout** section. Constraints are expanded by default. Labels are optional; tooltips equal the aria-labels | [blog](https://www.figma.com/blog/our-approach-to-designing-ui3/); [help](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar) [P] |
| **Toolbar** (floating, bottom centre) | Move/Hand/Scale · Frame/Section/Slice · shapes · Pen/Pencil · Text · Comment/Annotation/Measurement · **Actions (⌘K)** · mode switches **Draw**, **Dev Mode** (⇧D), **Motion** | [help](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar) [P] |

- **Modes change the panels, not the document.** Draw swaps in brushes and sliders. Dev Mode swaps in a ready-for-dev list and Inspect. Motion adds a bottom timeline. Selection and context carry across modes [P].
- **Minimize UI** collapses the rail and the sidebars. The properties panel then **pops over the canvas on selection** and disappears on deselect. Users complain it steals clicks and cannot be kept closed ([forum](https://forum.figma.com/t/allow-manual-open-close-of-right-panel/87945) [C]). The shortcut is Shift+\ or ⌘⇧\ (the sources disagree).
- **Actions (⌘K)** is one palette for AI actions, commands, visual asset search and plugins, with recents. Agent skills show up as slash commands ([help](https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design); [blog](https://www.figma.com/blog/agent-custom-tools-context-skills/) [P]).
- **Keyboard parity.** Keyboard box-select (⌥Space, a pink cursor moved with the arrow keys), Tab through children, F6 to reach the toolbar, and a shortcuts panel that knows the keyboard layout. Lines, vectors, connectors and tables still need a pointer ([help](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard) [P]).

#### The scene model

- **Auto layout** (⇧A) ([help](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout) [P]):
  - Flows: vertical, horizontal (with wrap), and **grid**.
  - Sizing: hug, fill or fixed, each with min and max.
  - Gap: a number, auto (space between, and around or evenly since 2026-08-31), or negative.
  - Padding and gap handles directly on the canvas. "Ignore auto layout" for absolute children. Baseline alignment.
- **Grid** (GA 2026-05-22) ([help](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow) [P]):
  - Hovering the frame edge shows **blue pills per track** with sizing labels. Click to edit, drag to fix, reorder with a grabber. Count fields accept arithmetic.
  - Tracks can be Fixed, Fill (`fr` multiples) or **Hug** (the API has `'FLEX' | 'FIXED' | 'HUG'`, d.ts L5621 [P·1st]).
  - Spans work by resize-to-snap.
  - The 2025 beta-era gaps (no hug tracks, no `fr` multiples) are outdated. Whether named areas and subgrid are still missing is (unverified).
- **Components.**
  - Property types: Boolean, Instance swap (with preferred values), Text, Variant, and **Slot**. Properties show at the top of an instance; nested instance properties can be exposed there ([help](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) [P]).
  - **Slots** (GA 2026-06-01) are freeform areas inside instances ([help](https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma) [P]):
    - a pink hover box;
    - an "Add instances" button filtered to preferred instances;
    - min/max child counts shown as a **green check or an orange warning that never blocks** (`limitViolations`, d.ts L8723 [P·1st]).
- **Variables** ([help](https://help.figma.com/hc/en-us/articles/15145852043927-Create-and-manage-variables-and-collections) [P]):
  - Collections with modes: 10 on Pro, 20 on Org.
  - Scopes, code syntax for web, Android and iOS, and DTCG JSON import/export.
  - **Extended collections** (Enterprise) inherit everything and override values only ([help](https://help.figma.com/hc/en-us/articles/36346281624471-Extend-a-variable-collection) [P]).
  - Types include **EASING and TIMING** (2026-08-05), so motion lives in tokens [P].
  - Complaint: the full-window Variables view hides the artboards ([forum](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) [C]).
- **Effects.** Drop and inner shadow, layer and background blur (normal or **progressive**), noise (three kinds), texture, **glass** (GA 2026-01-27), and **shader** (d.ts [P·1st]; [forum](https://forum.figma.com/product-updates-3/glass-is-officially-out-of-beta-50185) [P]).
- **Draw mode.** Shape builder, brushes, variable-width strokes, text on path, pattern fills, repeat modifiers, and since 2026-08-24 an eraser and paint bucket ([Config 2025 recap](https://www.figma.com/blog/config-2025-recap/); [release notes](https://www.figma.com/release-notes/) [P]).

#### Design systems, Dev Mode and handoff

- **Library publishing.** A modal lists changed items with a description. Subscribers see a blue badge and a review modal. Publishing works only from main, never from a branch ([help](https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library) [P]).
- **Check designs** (2026-06-04, Org/Ent) flags hard-coded colour, type, radius and spacing and **swaps in the token in one click**. It also suggests WCAG AA/AAA fixes and flags detached components ([release note](https://www.figma.com/release-notes/?title=check-designs-catch-whats-off-ship-whats-right) [P]).
- **Dev Mode** is the same file with different panels (⇧D) ([help](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode) [P]):
  - Inspect as Code (CSS, iOS, Android) or as a List.
  - Code Connect snippets and a component playground.
  - Statuses **Ready for dev / Completed / Changed (automatic)**, set from the section or frame header on the canvas ([help](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications) [P]).
  - Focus view with per-design history.
  - **Compare changes**, side by side or as an overlay, with layers marked Edited/Added/Deleted ([help](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode) [P]).
  - Annotations stay attached to layers, update live, and **auto-hide at low zoom** ([blog](https://www.figma.com/blog/dev-mode-ga/) [P]).
- **MCP server.** Tools include `get_design_context`, `use_figma` (runs Plugin API JavaScript), `get_motion_context`, `create_shader`, `export_video` and `search_design_system`. The API is shaped for agents: CSS-like `node.query()`, `tree()`, `screenshot()` and **`node.placeholder`, "Show or hide the in-progress shimmer overlay"** (d.ts L10151–10153 [P·1st]; [MCP docs](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) [P]).

#### The agent and code layers: new materials on the canvas

- **The agent** ([help](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P]):
  - **Entry points:** select a layer and press ⌘↵ for an inline prompt; the **Agents** chat list in the rail; or dictation.
  - **Parallel prompts:** each running prompt shows an **animated loading indicator on its target**, and clicking it opens that thread.
  - **Undo:** in the chat, or ⌘Z.
  - **Visibility:** from 2026-06-23, new chats are visible to collaborators by default. The audience is disputed between two help pages: "anyone with access to the file", or "Full seat and edit access" ([help: chat visibility](https://help.figma.com/hc/en-us/articles/41272399602583) [P]).
  - Only the creator can continue a chat.
  - The blue on-canvas status bubbles appear only in blog mockups (unverified as shipped).
- **Code layers** (closed beta from July 2026) ([blog](https://www.figma.com/blog/code-on-the-figma-canvas/) [P]):
  - Live, interactive code on the canvas, created from a frame, the toolbar, the agent, a template, or a GitHub repo or local folder.
  - Direct manipulation gets "an immediate code response".
  - **"Extract designs"** turns the current code state (a screen, a state or a flow) into editable layers, and "one click updates the code layer with your edits".

  This is Figma's version of putting artifacts on the design canvas.

#### Performance and scale

- Active memory is capped at **2 GB per tab**, including in the desktop app. A red alert appears at 90%. At 100% the **file locks** and must be opened in recovery mode ([help](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files) [P]).
- Pages load on demand.

#### What designers complain about

- **The bottom toolbar** cannot be docked, clashes with the macOS Dock, and gets lost among content ([forum 2024-10](https://forum.figma.com/suggest-a-feature-11/allow-us-to-dock-move-the-new-ui3-toolbar-7861/index8.html) [C]).
- **UI3 added clicks, and controls moved with component complexity.** The UI3 migration was forced ("literally paralysed") ([forum](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) [C]).
- **The permanent rail** costs about 60–100 px and cannot be hidden on its own ([forum](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) [C]). **Phased rollouts** with no opt-in leave teammates on different UIs for months ([forum](https://forum.figma.com/ask-the-community-7/how-to-use-new-variables-ui-52729) [C]).
- **Plan gating.** Branching, Completed status, Check designs and the Code Connect UI need Org or Enterprise. Extended collections need Enterprise [P].
- **Mobile** cannot edit Design files (§3.4).

---

### 3.2 (b) Prototyping and motion

#### The prototype model (the Prototype tab)

- **Structure.**
  - An interaction is a **Reaction**: one trigger plus an ordered list of actions (d.ts L3344 [P·1st]).
  - You wire it by dragging a noodle from a hotspot to its destination.
  - Flows are named starting points ([help](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma) [P]).
  - Several actions per trigger, and conditionals, need a paid plan ([help](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals) [P]).
- **12 triggers** ([help](https://help.figma.com/hc/en-us/articles/360040035834-Prototype-triggers) [P]): click, drag (which scrubs the transition), while hovering, while pressing, key or gamepad, mouse enter, leave, down and up, after delay, video hits a time, video ends. **There is no scroll-into-view trigger**, which users have long requested ([forum](https://forum.figma.com/suggest-a-feature-11/on-scroll-for-prototyping-21247) [C]).
- **15 actions** ([help](https://help.figma.com/hc/en-us/articles/360040035874-Prototype-actions) [P]): navigate, back, set variable, set variable mode, if/else conditional with expressions, scroll to, open link, open, close and swap overlay, video controls, and **Change to** (switch a variant).
- **Transitions** ([help](https://help.figma.com/hc/en-us/articles/360040522373-Prototype-animations) [P]):
  - Instant, Dissolve, **Smart Animate**, Move in/out, Push, Slide in/out, with four directions. `matchLayers` runs Smart Animate inside a directional transition.
  - Durations run from 1 to 10,000 ms.
  - Smart Animate matches layers **by name and position in the tree**. It tweens position, scale, rotation, opacity and fills; anything unmatched dissolves. It cannot tween shadows or morph shapes ([help](https://help.figma.com/hc/en-us/articles/360039818874-Smart-animate-layers-between-frames) [P]).
- **Prototype easing** ([help](https://help.figma.com/hc/en-us/articles/360051748654-Prototype-easing-and-spring-animations) [P]):
  - 7 bezier presets and a custom bezier. A custom curve **cannot be saved** for reuse.
  - Springs **Gentle / Quick / Bouncy / Slow**, or a custom spring set by **mass, stiffness and damping**.
- **Play** ([help](https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototype) [P]):
  - **Present** (⌘⌥↩) opens a new tab with a flows sidebar, prev/next, R to restart, "Show hints on click", Hide UI, responsive scaling and a device frame.
  - **Inline preview** (⇧Space) plays in a window on the canvas and picks up edits live.
  - Prototype-only share links need a paid plan.

#### Figma Motion (open beta since 2026-06-24)

- **UI** ([Motion blog](https://www.figma.com/blog/introducing-figma-motion/); [help: timeline](https://help.figma.com/hc/en-us/articles/41405906446999-Use-the-Figma-Motion-timeline) [P]):
  - A **Motion** mode switch in the toolbar opens a timeline across the bottom of the screen. It has Play (Space), a duration field (**2000 ms default**), a current-time field, a seconds/ms toggle, **Loop / Once / Ping-pong**, zoom, a resizable top edge, and tracks grouped by layer that can be dragged and stretched.
  - **Keyframes:** a **diamond beside every animatable field** in the properties panel. Set the playhead, click the diamond, type a value. An auto-keyframe mode records every edit, and Figma warns that stray edits then become keyframes ([help](https://help.figma.com/hc/en-us/articles/41307938657559) [P]).
  - **Animation styles (presets):** Fade, Move, Scale, Rotate, Resize, Path and composites are added from **+**. They show as timeline bars with duration handles and can stack or run in sequence. Custom styles are "coming soon" ([help](https://help.figma.com/hc/en-us/articles/41307886266135) [P]).
  - **On the canvas:**
    - an **anchor point** (⌥R), where position is measured from the centre in Motion mode;
    - **motion paths** drawn as boxes, with **dots spaced to show the easing**; ⌘-drag gives bezier handles;
    - path trim.

    Sources: [help: anchor](https://help.figma.com/hc/en-us/articles/41352588622615-Move-a-layer-s-anchor-point), [help: path](https://help.figma.com/hc/en-us/articles/41780233501591-Edit-an-object-s-motion-path) [P].
  - **Comments tied to a moment** in the timeline. Frames with motion show a Motion icon ([help](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion) [P]).
  - **Animated components** carry their motion through libraries. Instances show as purple tracks. Component properties cannot be edited in Motion mode ([help](https://help.figma.com/hc/en-us/articles/41307940738967) [P]).
- **The data model** (local `figma-use-motion` skill; d.ts [P·1st]):
  - **One timeline per top-level frame.** Top-level frames themselves cannot be animated.
  - **Transform tracks are relative to the resting transform.** Translate and rotate add; scale multiplies. They pivot on the anchor point. Everything else (opacity, radii, stroke weights, auto-layout gap and padding, grid gaps, path trim, width and height, solid fill and stroke colour, every effect field, shader properties) is absolute.
  - **A keyframe's easing controls the segment arriving at it.** The first value holds back to t=0 and the last holds to the end, so no pinning keyframes are needed.
  - **Easing:** Linear, Ease in/out/in-out, three Back curves, **Hold** (a step, exported as `steps(1, jump-end)`), custom bezier, and springs Gentle, Quick, Bouncy, Slow or Custom. **Springs are normalized to a single `bounce` 0–1** (`NormalizedSpring`, d.ts L3558). `physicalSpringToNormalized()` converts from mass, stiffness and damping.
  - **Custom curves and springs can be saved as Easing variables, with modes**, alongside Timing variables. Switching a mode retimes every animation that references them ([help](https://help.figma.com/hc/en-us/articles/41414048690839) [P]).
  - Fields that exist but throw today: scroll offset, media time, variant properties and 3D. They point to a roadmap of scroll-linked, video-time, variant and 3D motion [I].
- **The agent writes real keyframes** ([help](https://help.figma.com/hc/en-us/articles/41159708615319) [P]).
  - Figma's advice: "Create 3 motion variants…", stating intent, feel, what may vary and what must stay fixed. Narrowing three options is faster than getting the first right.
  - It can bulk-edit more than 100 keyframes.
  - The guidance Figma gives its own agent [P·1st]:
    - durations of about **0.25–0.7 s**;
    - stagger related elements;
    - prefer EASE_OUT, GENTLE or QUICK;
    - avoid flashy loops and heavy bounce.
- **Handoff.**
  - **Dev Mode** has a read-only timeline next to CSS, React (motion.dev) and JSON with a Copy button ([help](https://help.figma.com/hc/en-us/articles/41296356954263-Hand-off-animations-to-development) [P]).
  - **MCP `get_motion_context`** returns CSS `@keyframes` and motion.dev snippets, plus `timelineCohorts[{rootNodeId, durationMs, loopMode, memberNodeIds}]` so one lifecycle drives all members. `prefers-reduced-motion` handling is mandatory in generated code (local `figma-implement-motion` [P·1st]).
  - Prototype interactions and Smart Animate are **not** exported through MCP [P·1st].
- **Export.**
  - MP4, WebM, GIF and animated SVG, from top-level frames only. Above 1080p or 30 fps needs a paid plan ([help](https://help.figma.com/hc/en-us/articles/41307983648407) [P]).
  - Lottie and audio are "coming" ([help: Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) [P]).

#### Figma's biggest motion gaps

1. **Motion cannot be triggered by a prototype interaction.** It auto-plays on load. Staff confirmed this on 2026-06-29 ("doesn't appear to be available yet") and 2026-07-02 ("There isn't a way to do this right now") ([forum](https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428); [forum](https://forum.figma.com/ask-the-community-7/questions-about-figma-motion-motion-paths-prototyping-and-variants-55468) [P/C]).
2. **Two easing systems.**
   - Prototype springs are physical, and their custom curves cannot be saved.
   - Motion springs use bounce and can be saved as variables.
   - Smart Animate between variants cannot be keyframed.
   - The unifying "every screen-to-screen transition has a full timeline" is "coming soon" ([figma.com/motion](https://www.figma.com/motion/) [P]).
3. **Timeline ergonomics** ([forum](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314) [C]):
   - clutter with nested layers;
   - no snapping, no typed keyframe times and no multi-select;
   - **no graph editor across keyframes**;
   - no parenting;
   - new layers land at t=0;
   - confusing state between Design and Motion modes.
4. **Beta bugs.** Animations flashed their end state on page transitions and did not play in overlays for about 12 weeks. The report was on 2026-06-26 and the fix came 2026-09-16 ([forum](https://forum.figma.com/report-a-problem-6/figma-motion-feedback-glitch-55346) [P/C]).
5. **Shallow compared with Rive and After Effects.** No state machine, no expressions, one timeline per artboard ([Rive Masterclass](https://www.rivemasterclass.com/blog/figma-motion-vs-rive); [Motion the Agency](https://www.motiontheagency.com/blog/figma-motion-vs-after-effects) [S]).

#### Shaders

- **Two kinds.** A shader **effect** samples the rendered layer beneath it. A **fill** generates its own pixels. Both are built by prompting the agent and run on WebGPU/WGSL (local `figma-shaders` [P·1st]; [quick start](https://help.figma.com/hc/en-us/articles/41147702210071-Quick-start-guide-to-generative-plugins-and-shaders) [P]).
- **Controls.** The agent also builds native-looking controls with **PropsKit**: sliders, selects, colour and gradient pickers, and on-canvas point, radius and line handles ([blog](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) [P]).
- **Since 2026-09-01.** Animated (`frame.time`) and mouse-reactive shaders, and Community and org publishing ([release notes](https://www.figma.com/release-notes/) [P]).
- **Costs.**
  - **Only one animated or interactive shader runs per page.**
  - WebGPU is required, and Firefox has it off by default.
  - Shader visuals drop out of Motion code export and MCP video export.
  - Exported instances do not stay linked.
  - Shaders do not appear in Dev Mode.

  Sources: [quick start](https://help.figma.com/hc/en-us/articles/41147702210071-Quick-start-guide-to-generative-plugins-and-shaders) [P]; [TechTimes](https://www.techtimes.com/articles/319041/20260625/figma-config-2026-code-layers-challenge-cursor-gpu-shaders-hit-paid-plans.htm) [S]; `figma-implement-motion` [P·1st].
- **Juno.** Juno excludes shaders on purpose: "a shader is a program… Eight exporters cannot" (`src/lib/design/types.ts:117-123`). Figma's costs support that rule.

#### Slides transitions compared

| | Figma Slides | Claude Slides |
|---|---|---|
| Styles | None, Dissolve, Slide/Push/Move from 4 directions, Slide/Move out to 4 directions, **Smart Animate** | `fade`, `push`, `magic` (morph) |
| Curves | 4 bezier + 4 spring presets | Not documented |
| Timing | On click, or after a delay | Not documented |
| Object animations | Style, Duration, Timing (on click or after the previous); groups; one per object | Build-ins `fade`, `rise`, `pop` |
| Source | d.ts L9737–9790 [P·1st]; [help](https://help.figma.com/hc/en-us/articles/24244588378007-Use-slide-transitions) [P] | `claude-primary-evidence.md` [P·1st] |

#### Juno's motion model against Figma

Sources: `01` §5.2 and `src/lib/design/types.ts:640-735`, read first-hand in the lens.

| Aspect | Figma | Juno Design today | Implication |
|---|---|---|---|
| Triggers | 12 | 7, **including scroll-into-view** | Juno has what Figma users ask for |
| Actions | 15; several per trigger; conditionals | 10, **including play-animation (with reverse)**; one per interaction | `play-animation` answers Figma's top Motion complaint, but nothing plays it (M61) |
| Transitions | Smart Animate by name | Five kinds plus `matchStableIds` (by id) | Matching by id is more robust than by name, but **no transition reaches a runtime** (M61) |
| Keyframe semantics | Relative transforms, incoming easing, holds | **13 absolute properties**, **outgoing** easing | Absolute x/y causes M64 (auto-layout children move in export only) |
| Springs | Duration + bounce, saved as variables | Stiffness/damping/mass; export as ease-out (L20) | Juno's product motion (`lib/motion.ts`) already uses duration + bounce |
| Presets | Animation styles | None | Presets are what a chat model can emit reliably |
| Player | Present, inline preview, prototype link | **None** (M61) | Table stakes |
| Handoff | Dev Mode timeline + CSS/React/JSON; MCP cohorts | HTML prototype only; React and SwiftUI print a note | Build one motion IR with emitters |
| Media export | MP4, WebM, GIF, animated SVG | None | — |
| AI authoring | The agent writes keyframes | The chat grammar cannot express motion; a chat revision deletes it (X-06) | Motion must survive AI round-trips |

---

### 3.3 (c) AI, the product family, and one file browser for many types

#### Two phases

- **2024–25: new file types.**
  - Slides beta (2024-06-26), then GA (2025-03-19).
  - Make, Sites and Buzz (2025-05-07).
  - Draw shipped as a *mode* inside Design, not as a type.
  - Sources: [Slides](https://www.figma.com/blog/introducing-figma-slides/), [Config 2025](https://www.figma.com/blog/config-2025-recap/) [P].
- **2026: new materials inside the Design canvas.**
  - Code layers, Motion, shaders, generative plugins and Weave tools.
  - **One agent** as the layer across products.
  - The recap: "Code is material, just like images, vectors and design layers", and the canvas is "where everything connects" ([Config 2026 recap](https://www.figma.com/blog/config-2026-recap/) [P]).

#### How one browser holds many types

- **One "+ Create" dropdown** (top right) offers Design, FigJam, Slides, Sites, Make and Buzz ([help](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file) [P]).
- **Each type has its own identity:**

  | Type | URL namespace | Extension | Quick URL |
  |---|---|---|---|
  | Design | `/design` | `.fig` | `figma.new` |
  | FigJam | `/board` | `.jam` | `figjam.new` |
  | Slides | `/slides` (`/deck` when presenting) | `.deck` | `flides.new` |
  | Sites | `/site` | `.site` | — |
  | Buzz | `/buzz` | `.buzz` | `buzz.new` |
  | Make | `/make` | `.make` | — |

  Each also has a file icon ([help](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders) [P]).
- **Plan limits are per product**: Starter allows 3 files of each product per folder [P].
- **Exception: Weave** lives outside the browser, with its own sign-in. Standalone Weave and MCP-run Weave use **separate Weave credits**. Weave tools inside Design use Figma AI credits [P].
- **The type boundary is in the editor, not in storage.**
  - The Plugin API's `editorType` is `'figma' | 'figjam' | 'dev' | 'slides' | 'buzz'` (d.ts L16 [P·1st]).
  - Slides and Buzz share one "canvas grid" API [P·1st].
  - A `.make` file is a ZIP holding a `canvas.fig` (Figma's Kiwi scene format), with `CODE_FILE` nodes carrying React source and an `ai_chat.json` of the whole prompt history ([albertsikkema](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) [C]).
- **Libraries are the glue between types.** Slides consumes them through Assets, and instances stay live. Sites uses the inserts panel, Buzz uses brand components, and Make uses Make kits ([help](https://help.figma.com/hc/en-us/articles/24292359259543-Access-Figma-Design-and-FigJam-assets-in-Figma-Slides); [Make](https://www.figma.com/make/) [P]).
- **Modes over files.** Figma adds a mode whenever the document is the same scene graph: Draw, Dev, Motion, and Slides "design mode". It reserves a new type for a different **document root**: a slide grid, an asset grid, pages with a CMS, a code project, or a node graph [I, from the P sources].

#### Moving content between types

| From → to | Mechanism | Link kept? |
|---|---|---|
| Design → Slides, Sites, Buzz | Copy and paste; library instances stay live | Pasted frames: no. Users complain Buzz never gets library updates ([forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307) [C]) |
| Make → Design | "Copy the preview as design layers" | **One-way**: "changes don't sync back" ([Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs) [P]) |
| Frame ↔ code layer (Design, 2026) | Extract designs / one-click update | **Two-way** (closed beta) ([blog](https://www.figma.com/blog/code-on-the-figma-canvas/) [P]) |
| Design → Weave | The Figma node, with a "Sync" action (2026-09-17) | Linked ([release notes](https://www.figma.com/release-notes/) [P]) |
| Live web UI → Design | MCP `generate_figma_design` | Copy ([MCP docs](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) [P]) |

[I] The bridges built in 2024–25 were clipboard copies that lose the link, and users complain about exactly that. The 2026 bridges are live links or layers inside the canvas.

#### Product notes that matter for Juno

- **Agent** ([help](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P]):
  - It replaced First Draft as "the new entry point" from 2026-05-20 ([help](https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI) [P]).
  - It has an on-canvas prompt plus a rail chat list.
  - Full seats can edit; View, Dev and Collab seats can chat only.
  - It cannot export assets or make charts.
  - Reviewers find multi-frame output inconsistent ([mantlr](https://mantlr.com/blog/figma-ai-agent-guide-2026) [S]).
- **Make** (2025-05-07, launched on Claude 3.7 Sonnet): AI chat on the left, live preview on the right, and a code editor ([help](https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make) [P]).
  - **Edit** (2026-07-30) opens a Design-style properties panel with the full DOM tree ([blog](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/) [P]):
    - direct edits are **staged** above the prompt box and committed with **Apply**;
    - staged edits cost no credits, and an applied edit uses "far fewer tokens" than a prompt;
    - **"Annotate for agent"** drops blue numbered callouts that submit together as one prompt;
    - this new UI applies **only to new Make files**.
  - Versions are created automatically and can be previewed, restored, favourited and renamed ([help](https://help.figma.com/hc/en-us/articles/42009840449175-Edit-a-Figma-Make-file) [P]).
  - The REST API rejects Make files ([albertsikkema](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) [C]).
- **Sites.**
  - One-click interaction presets: parallax, scroll transform, lightbox, typewriter, marquee, custom cursor.
  - Code layers since 2025-06-17: double-click re-enters the editor, AI-generated props appear as canvas controls, and ⌘D duplicates to compare ([blog](https://www.figma.com/blog/introducing-code-layers/) [P]).
  - Sites launched with inaccessible, all-`div` HTML ([Roselli](https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html) [C]).
- **Slides.**
  - A simplified editor. **Design mode (⇧D) reveals layers, auto layout and components** ([help](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides) [P]).
  - In grid view the sidebars appear only when something is selected ([help](https://help.figma.com/hc/en-us/articles/24170630629911-Explore-Figma-Slides) [P]).
  - The structure is `SLIDE_GRID → SLIDE_ROW` (named sections) `→ SLIDE`, with speaker notes in Markdown (local `figma-use-slides` [P·1st]).
- **Buzz.**
  - Lock state is shown by outline colour: **pink** when guidelines lock fields, **blue** for full editing.
  - Grid and table views.
  - Bulk-create from CSV or XLSX ([help](https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz) [P]).
- **Generative plugins.** Prompt-built, hosted by Figma, with **PropsKit** native-looking UI. A "try" link opens a new file with the tool ready (local `figma-generative-plugins` [P·1st]).
- **Credits.** One AI-credit currency covers Make, the agent, plugins, shaders, code layers and Weave tools used inside Design. Full seats get 3,000, 3,500 or 4,250 a month; other seats get 500 ([help](https://help.figma.com/hc/en-us/articles/35865276858647-Manage-AI-credits) [P]). A pay-as-you-go credit costs about 5.6× a seat credit ([forum](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944) [C]).

#### Where the family still fragments

- **Code has three homes**: Make, Sites code layers and Design code layers. **Motion has four systems.** The Slides MCP skill itself warns agents to "pick one and commit" to avoid "duplicate, conflicting artifacts" (local `figma-use-slides` [P·1st]).
- **Uneven tool reach.**
  - `create_new_file` makes only Design, FigJam or Slides files.
  - `get_metadata` fails on Slides and FigJam.
  - Generative plugins run only in Design.

  Sources: [MCP docs](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) [P]; d.ts [P·1st].
- **Churn.** Folder thumbnails were removed, then restored six weeks later (§3.4).

---

### 3.4 (d) Files, sharing, comments, permissions and mobile

#### Organisation

- **Hierarchy.** Organization → Workspace → Team → **Folder** → File, plus private **Drafts** per person per team ([help](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders) [P]).
- **The 2026-08-03 redesign** ([help](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management); [blog](https://www.figma.com/blog/code-craft-and-the-making-of-nested-folders/) [P]):
  - "Projects" became folders, which nest up to 10 levels.
  - Permissions collapsed to **Inherited** ("Anyone in [Parent] can access") or **Limited** ("Only people added…").
  - The hardest design problem was "how the share modal should explain inheritance, especially when it is broken".
  - **Thumbnails removed, then restored.** The new folder tiles dropped their file previews. Users said they could not find work, and called colour-only folders an accessibility problem. Previews came back on 2026-09-16 with stronger colours ([forum](https://forum.figma.com/share-your-feedback-26/figma-folders-57057) [C]; [release notes](https://www.figma.com/release-notes/) [P]).
- **Drafts migration (2024-10-15 to 2025-10-09).** A temporary "Drafts to move" space, and many "my drafts disappeared" threads ([help](https://help.figma.com/hc/en-us/articles/18409526530967-Updates-to-how-drafts-work) [P]; [forum](https://forum.figma.com/report-a-problem-6/i-cant-find-my-files-40147) [C]). The lesson: give made things an owner and a home from day one.
- **Browser sidebar** ([help](https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser) [P]): Recents (with Show in folder), Drafts (with a **Deleted files** tab), All folders, Community, **Starred** (private, reorderable), **Trash**, Admin.
- **Pins and search.**
  - **Pin to folder** is shared and set by editors; pinned items show as thumbnails labelled with who pinned them ([help](https://help.figma.com/hc/en-us/articles/360038511713-Pin-files-to-a-folder) [P]).
  - **⌘/** search covers files, folders, people and the text inside files, with type filters and four sorts ([help](https://help.figma.com/hc/en-us/articles/4422774037271-Search-for-files-folders-and-people) [P]).
- **Thumbnails.** Right-click a frame → **Set as thumbnail**, 1920×1080 recommended ([help](https://help.figma.com/hc/en-us/articles/360038511413-Set-custom-thumbnails-for-files) [P]).

#### The Share modal and publishing

- **Share modal**, in order ([help](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes) [P]):
  1. an invite field;
  2. the audience: Anyone / Organization / Workspace / Only invited people;
  3. the role: can view or can edit;
  4. **Who has access**, ordered plan → inherited → people → groups;
  5. more ways to share: Dev Mode link, prototype link, embed, Publish to Community;
  6. **Copy link**, which points at the selected frame.

  Paid options: password, link expiry (Enterprise), and "Allow viewers to copy, share, and export".
- **Ask to edit.** A viewer's request puts a **red badge on the Share button** until the owner approves or denies it ([help](https://help.figma.com/hc/en-us/articles/4408435431319-Request-to-edit-a-file) [P]).
- **Seat and permission are two gates**: Full, Dev, Collab and View seats on top of can-edit. "I have can edit but I'm view-only" is a recurring question ([forum](https://forum.figma.com/ask-the-community-7/i-have-an-editor-access-but-is-on-view-only-mode-when-i-opened-the-file-28534) [C]).
- **Publish is separate from Share** (Make and Sites) ([help](https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file) [P]):
  - The modal shows the title, a `three-random-words.figma.site` URL, a **Not published / Published** status and "Who can view".
  - Edits reach the public page only after **Update**.
  - **Unpublish** keeps the URL for later.
  - Sites also keeps a **publish history**, so the live site can be reverted.

#### Comments

- **Creating** ([help](https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files) [P]):
  - **C** enters comment mode. Click drops a pin; drag comments on a region.
  - A pin attaches to the **top-level frame, component or group** under it and moves with it. It does not attach to nested layers, a long-standing request ([forum](https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753) [C]).
  - @mentions, reactions, up to 5 images, Markdown.
  - Limit: **100 comments per hour**.
- **Managing** ([help](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments) [P]):
  - Sort by date or unread; toggles for Show resolved, Only your threads and Only current page.
  - **Resolve hides the thread. ⇧C shows or hides all comments.**
  - Deleting a comment is permanent, even across a version restore.
- **Notifications** ([help](https://help.figma.com/hc/en-us/articles/360041547813-Manage-email-notifications-for-comments-on-files) [P]):
  - Per file: Everything / Just mentions and replies / Nothing.
  - Emails are **batched every 30 minutes**.
  - The in-app bell holds 50 items and allows inline replies.
- **Make comments** ([help](https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make) [P]):
  - Placing a comment **captures a screenshot** of the element's state at that moment.
  - The sidebar splits comments into **Current version** and **Other versions**.

  This fits AI output that keeps changing.
- **Figma has no comment-to-agent path.** The agent can review and act on comments only when asked from its chat. No source shows a comment becoming an agent turn, or the agent replying in a thread ([help](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) [P]).

#### Presence and review

- **Follow and spotlight** ([help](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight) [P]):
  - Click an avatar to follow someone: the viewport is **framed in their colour**, with a "following" banner.
  - **Spotlight** gives others "a few seconds" to press **Not now** before their view jumps.
  - The presenter's avatar gets a dashed ring.
- **Cursor chat** (**/**, 52 characters) fades 5 s after typing stops. The cited page is written for FigJam ([help](https://help.figma.com/hc/en-us/articles/1500004414842-Send-messages-with-cursor-chat) [P]).
- **Audio.** The speaker's avatar bubbles up, and their cursor pulses with voice volume ([help](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team) [P]).
- **Viewer history** (Feb 2025) shows Currently viewing and Previously viewed ([help](https://help.figma.com/hc/en-us/articles/29638316371479-See-viewer-history-for-your-files) [P]).
- **Local-first edits.** Conflicting server echoes are dropped so the canvas doesn't flicker ([blog 2019](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) [P]).
- **Review workflows.**
  - Dev Mode statuses flip to **Changed** automatically when a design is edited after handoff.
  - Branch review compares side by side or as an overlay (Org/Ent) ([help](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching) [P]).
  - Buzz approvals **lock** approved assets until someone chooses Edit asset ([help](https://help.figma.com/hc/en-us/articles/39288847137815-Use-approvals-in-Figma-Buzz) [P]).
- **Version history** ([help](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history) [P]):
  - A checkpoint every 30 minutes, and on disconnect.
  - Autosaves **collapse between named versions**.
  - Restore adds two checkpoints, so nothing is lost.
  - An old version is browsed read-only, and can be linked or duplicated.
  - Starter plans and drafts keep 30 days.

#### Mobile and offline

- **Mobile** ([help](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app) [P]):
  - Tabs: Recents, Search, Activity, Mirror.
  - View files, **comment by long-press**, quick-reply to notifications, and play prototypes full screen.
  - **Mirror** shows desktop frames live on the phone.
  - "It's not possible to edit Figma Design files or Figma Slides decks using the mobile app". FigJam is editable on iPad. The agent is not on mobile.
  - App Store reviews complain that Mirror disconnects ([App Store](https://apps.apple.com/us/app/figma/id1152747299) [C]).
- **Offline** ([help](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma) [P]):
  - Edits to open files are queued in IndexedDB for 30 days (7 in Safari).
  - On reconnect there is a blue toast, an **unsynced** badge on the file, and **Open to sync**.
  - Conflicts offer **Review** or **Dismiss**.

#### Governance

- **Public links.** Organization plans can disable public links. Enterprise can require passwords (generated four-word passwords only, if set) and link expiry from 1 hour to 31 days ([help](https://help.figma.com/hc/en-us/articles/5726756336791-Manage-public-link-sharing-and-open-sessions) [P]).
- **Activity log.** Events include viewed, exported and permission changes, with the IP address of each, CSV export and an API ([help](https://help.figma.com/hc/en-us/articles/360040449533-View-and-export-activity-logs) [P]). Retention of 365 days is (unverified).
- **Governance+** adds export blocking, an IP allowlist, a discovery log of AI prompts, and AI hosting controls ([help](https://help.figma.com/hc/en-us/articles/31825370509591-Governance-for-Figma) [P]).

---

## 4. Other references (only ideas that beat Claude or Figma)

Each row says where Claude and Figma fall short, which is why the idea is on the list. The last column says where it would land in Juno.

| # | Idea | Who, when | Why it beats Claude and Figma | Source | Where in Juno |
|---|---|---|---|---|---|
| 1 | **Comments are the AI's inbox.** `@Lovable` or "Send to chat" sends *the full thread, the page and the element*. Resolved threads hide. **Pins whose anchor disappeared after a layout change show a "lost reference" indicator.** Writing a comment is free; only the send costs credits | Lovable, 2026-04-02 | Claude sends comments but documents no orphan state and no payload. Figma has no comment-to-agent path | [docs](https://docs.lovable.dev/features/project-comments) [P] | Comments table for every type; the payload the model receives |
| 2 | **A single-key mode bar on the live preview**: S select, T text, D draw (shapes cleaned up), C comment. Draggable and minimisable; remembers its position. Inline text edits are free (100/day) | Lovable, 2026-06-10 | Claude refines from the composer first; Figma has no running app to point at | [docs](https://docs.lovable.dev/features/design) [P]; [changelog](https://docs.lovable.dev/changelog) [P] | Canvas preview toolbar for HTML/React; design canvas tool keys |
| 3 | **Point, draw or speak at the running artifact, including over a *frozen frame*.** The agent receives xpath, computed styles, React props and a screenshot. **Queue the next edit before the first finishes.** The app hot-reloads as each edit lands | Cursor Design Mode 3.0 (2026-04-02), 3.7 (06-04) | You can point at a *moment in an animation*. Neither Claude nor Figma has an edit queue | [blog](https://cursor.com/blog/design-mode); [docs](https://cursor.com/docs/agent/design-mode) [P] | Select-then-ask payload; Play-mode annotation; composer queue |
| 4 | **Stream the work onto the canvas and let people steer before it finishes.** The Agent Manager tracks several directions in parallel. Shift-click several screens to apply one change | Google Stitch, 2026-03-18 and 2026-05-19 | Claude Design shows options but has no managed branches and no mid-generation steering | [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-updates/); [redesign](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/) [P] | Design canvas: directions as rows; steer in the composer while streaming |
| 5 | **One library for uploaded and made files**, with folders, Viewer/Editor sharing, "Shared with me", and "Add from Library" in the composer | ChatGPT, sharing 2026-09-09 | Claude's gallery has no folders and does not include uploads | [releases.sh mirror](https://releases.sh/openai/chatgpt-release-notes.md) [P]; [help](https://help.openai.com/en/articles/20001052-file-storage-and-library-in-chatgpt) [P, snippet] | One Artifacts index next to /library; "Add from Artifacts" in the composer |
| 6 | **A display-mode contract.** Inline card (at most 2 actions, no nested scroll) → full screen with the composer overlaid ("talking to the app") → picture-in-picture. ChatGPT **removed its side-panel Canvas** in mid-2026 in favour of inline blocks that open full screen | ChatGPT Apps SDK; Canvas removed ~2026-05-28 | A spatial model that works on phone. Claude fixes a side panel in place | [Apps SDK UI guidelines](https://developers.openai.com/apps-sdk/concepts/ui-guidelines) [P]; [ai-toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-use-chatgpt-canvas-guide-2026) [S] | ArtifactView at card, panel and full size; composer persists in full screen |
| 7 | **An output rail scoped to one context**: creation tiles on top, a typed list below, several outputs of one type, usable while another generates. Per-slide feedback regenerates **a new sibling deck** instead of overwriting | NotebookLM Studio, 2025-07-29 and 2026-03-20 | Claude replaces in place, and Figma has no per-context rail | [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/); [Workspace Updates](https://workspaceupdates.googleblog.com/2026/03/new-ways-to-customize-and-interact-with-your-content-in-NotebookLM.html) [P] | The conversation's Outputs popover |
| 8 | **Create converts one type into another**: a doc becomes a web page, infographic, quiz, audio or slides | Gemini Canvas | Claude offers Doc → Slides only, and Figma copies by clipboard | [support.google.com](https://support.google.com/gemini/answer/16047321?hl=en&co=GENIE.Platform%3DDesktop) [P] | A "Turn into…" action on every artifact; the result is a linked sibling |
| 9 | **AI suggestions queued for approval, top to bottom** | Notion, 2026-08-28 | Claude edits in place; Figma's agent applies and offers undo | [release](https://www.notion.com/releases/2026-08-28) [P] | Default for AI edits to anything a person has edited by hand |
| 10 | **AI edits land on a branch, then merge.** Framer offers "Iterate safely by moving AI agent edits to a branch"; v0 can put each chat on its own git branch with PRs | Framer 3.0 (2026-06-16); v0 (2026-02-03) | Claude has linear versions; Figma branching is manual and Org/Ent-only | [framer.com/agents](https://www.framer.com/agents/); [Framer 3.0](https://www.framer.com/blog/framer-3/); [v0](https://vercel.com/blog/introducing-the-new-v0) [P] | Regenerate and edit create a branch or version, never a delete |
| 11 | **"Save a version" kept separate from "Deploy a version"**, with an audience ladder (owner → invited → workspace → public), visitor analytics and custom domains | ChatGPT Sites, 2026-07-09 | Claude has no staging/live split and no analytics | [learn.chatgpt.com/docs/sites](https://learn.chatgpt.com/docs/sites) [P] | Publish flow for web artifacts |
| 12 | **HTML from any AI imported as an editable design; code projects embedded inside decks and whiteboards** | Canva Code 2.0, GA 2026-07-14 | Claude cannot turn arbitrary HTML into design layers; Figma's code layers are closed beta | [VentureBeat](https://venturebeat.com/technology/canva-launches-code-2-0-offering-ai-website-building-to-every-user-including-free-accounts) [S] | HTML → scene importer; code frames inside designs and decks |
| 13 | **Re-apply the brand to existing designs in one step** | Canva AI 2.0, 2026-04-16 | Neither Claude nor Figma offers a one-step "re-brand what I already made" | [CMSWire](https://www.cmswire.com/digital-experience/canva-ai-20-adds-agentic-design-tools/) [S] | Design System type: "Apply to…" |
| 14 | **DESIGN.md**: portable, agent-readable design rules, open-sourced as a draft spec | Stitch, 2026-04-21 | Claude's Design System type is richer but proprietary | [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) [P] | Import and export alongside Juno's design-system record |
| 15 | **A per-node "agent is working here" state the agent must clear** (`finish_working_on_nodes`); comments addressed to "teammates and your agents"; agents working in background tabs | Paper, Aug 2026 | Figma has a shimmer flag but no required clear; Claude has no per-node state | Paper MCP instructions (local [P·1st]); [build log](https://paper.design/build-log) [P] | Design canvas agent presence |
| 16 | **Stateful motion graph**: timeline animations become states (Idle, Hovered, Clicked) joined by transitions | Rive | Figma's timelines are stateless, one per frame | [docs](https://rive.app/docs/editor/state-machine/state-machine) [P] | The existing `MotionAnimation.state` field, which has no UI |
| 17 | **Preview across appearances**: Default, Dark and Mono in one file, for every platform | Apple Icon Composer (macOS Tahoe 26.4+) | Neither Claude nor Figma previews one asset across appearances | [developer.apple.com](https://developer.apple.com/icon-composer/) [P] | A light/dark/phone/desktop strip on design artifacts |
| 18 | **Lesson: say why an editor is disabled.** v0's Design Mode was greyed out for more than three weeks with no explanation; users could not tell a plan limit from a bug | v0, 2026-02-21 to at least 2026-03-15 | — | [community.vercel.com](https://community.vercel.com/t/v0-design-mode-not-working-after-recent-update/34221) [P] | "This design can't be opened" (X-02), refusal reasons (M4) |

No outside reference publishes durations or curves for its AI-presence motion (Stitch streaming, ChatGPT shimmer, PiP). Every timing in §7 therefore comes from Juno's own tokens.

---

## 5. Feature matrix

**Legend.** ✓ = works. **partial** = works with material gaps, or works only in some places. ✗ = absent, or broken so that it does not work. In the Claude and Figma columns, ✗ can also mean *not found in any source checked*; the note says which. The **Juno Mac** column covers native apps, with the iPhone noted where it differs. Juno cells follow the audits, so a feature that is built but broken in production (for example X-01 previews) is ✗ or partial, never ✓.

### Making

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 1 | Model decides when to make a thing | ✓ model decides (since 09-12) | partial dead Canvas toggle ships | ✓ routes; ">15 lines" rule | partial agent on request only |
| 2 | Explicit "make a…" picker / New menu | partial four design presets only | partial design presets only | ✓ Output picker, /docs, /design | ✓ + Create, `.new` URLs |
| 3 | Templates gallery | ✗ none | ✗ none | ✓ Artifacts-tab templates | ✓ Resources, Community |
| 4 | Clarifying questions before building | ✗ none | ✗ none | ✓ structured "taste exam" | ✗ not documented |
| 5 | Several directions side by side | ✗ one output per turn | ✗ one output per turn | ✓ ~3 options by default | partial parallel agent prompts |
| 6 | Convert one type into another | partial Markdown → Office only | partial library Office export | partial Doc → Slides | partial clipboard, often one-way |
| 7 | Import foreign design or code as editable | ✗ no importer (01 §2.6) | ✗ no importer | partial .fig/code as context | partial HTML→layers; repo→code layer |

### Editing by hand

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 8 | Live HTML / React / Mermaid preview | ✗ CSP blocks scripts (X-01) | partial HTML without CDN; no React (X-13) | ✓ sandbox, 5 CDN hosts | partial code layers, closed beta |
| 9 | Edit source, save as a version | ✓ Code tab, 409 guard | partial library saves; dock never does | partial view code; edit via Claude | partial code-layer editor (beta) |
| 10 | Direct manipulation on the canvas | partial outline-only move (M51–M55) | partial stale bundle (X-19) | partial drag/resize/align since 06-17 | ✓ full, on-canvas handles |
| 11 | Layers panel and property inspector | ✓ ARIA tree, full inspector | partial rails hidden below 1024 pt (X-18) | partial contextual inspector | ✓ layers + merged Layout section |
| 12 | Auto layout including grid | partial fill and grid wrong (M37) | partial same engine, stale | ✗ inline-style edits only | ✓ hug/fill, wrap, grid |
| 13 | Components with live instances and props | partial copy-on-create; overrides unread | partial same model | partial DS components mounted | ✓ props, variants, slots |
| 14 | Variables / tokens with modes | partial only fill colour bindable | partial same | partial Theme menu of DS tokens | ✓ modes, extended, EASING/TIMING |
| 15 | Effects: blur, glass, noise, texture | ✓ 7 kinds incl. glass | partial stale bundle | partial via CSS in code | ✓ plus progressive blur, shaders |

### AI editing

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 16 | Model revises the *current* version | partial Canvas Modify only (X-05) | ✗ re-emits from stale text | ✓ re-reads current files | ✓ agent edits live file |
| 17 | Targeted edits, not full re-emits | partial patches; chat rebuilds designs (X-06) | ✗ full re-emit only | ✓ create/update/rewrite | ✓ writes layers directly |
| 18 | Select, then ask | partial quote chip; no keyboard (M22) | partial component menu → composer | ✓ Edit with Claude; element comments | ✓ ⌘↵ on selection |
| 19 | Reviewable proposal before apply | partial Ask Juno; review leaks writes (M46) | ✗ no Ask Juno | ✗ edits apply directly | partial Make staged Apply |
| 20 | Model-generated tweak controls | partial "Tune Juno's change" | ✗ not wired | ✓ Tweaks from `data-props` | partial code-layer props, shader controls |
| 21 | Streams into the open object | ✗ nothing until done (M15) | ✗ card disabled while streaming | partial Docs fill section by section; Design not publicly documented | partial placeholder shimmer on nodes |
| 22 | One-click error repair | ✗ no Fix action | ✗ none | ✓ Try fixing with Claude | ✗ not documented |
| 23 | Parallel or queued AI edits | ✗ one blocking call (01 §4.6) | ✗ none | partial batched comments | ✓ parallel prompts with indicators |

### Design model

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 24 | Validated, invertible operation log | ✓ 37 ops with inverses | partial whole-document save bypasses ops | ✗ HTML files + string replace | ✓ multiplayer scene graph |
| 25 | Notes, stickies, annotations on the canvas | ✗ none | ✗ none | ✓ notes, stickies, shapes | ✓ annotations, sections, measure |
| 26 | Code artifacts placed on the design canvas | ✗ separate objects | ✗ separate objects | ✓ artboards are live HTML | partial code layers, closed beta |
| 27 | One schema across every client | ✓ one editor bundle | partial Swift mirror drops fields (X-14) | ✓ one hosted runtime | ✓ one `.fig` format |
| 28 | Size headroom per document | partial 200k chars, 96 KB images (X-08) | partial one big row blanks library (X-09) | ✓ 16 MB page, 256 MB canvas | partial 2 GB per tab, then locks |

### Prototyping and motion

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 29 | Authoring prototype interactions | ✓ 7 triggers × 10 actions | partial stale bundle | partial `<a href>` links only | ✓ 12 triggers, 15 actions |
| 30 | Player / Play mode | ✗ no player (M61) | ✗ no player | ✓ Play mode (Design) | ✓ Present + inline preview |
| 31 | Screen transitions that actually run | ✗ authored, never run (M61) | ✗ same | partial Slides fade/push/magic | ✓ Smart Animate, push, slide |
| 32 | Keyframe timeline | partial 13 props; preview ≠ export (M64) | partial stale bundle | ✗ not publicly documented | ✓ Motion (open beta) |
| 33 | Animation presets | ✗ none | ✗ none | partial build-ins fade/rise/pop | ✓ Fade, Move, Scale styles… |
| 34 | Motion triggered by an interaction | partial `play-animation`, no runtime | partial same | ✗ not documented | ✗ auto-plays on load |
| 35 | Duration + bounce springs, easing tokens | partial product yes, documents no | partial same | ✗ not documented | ✓ bounce 0–1, EASING variables |
| 36 | Video / GIF export | ✗ none | ✗ none | ✗ not in the documented export list | ✓ MP4, WebM, GIF, SVG |

### Design systems

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 37 | Design system as its own object | ✗ none | ✗ none | ✓ Design System type | ✓ published libraries |
| 38 | Default system applied automatically | ✗ none | ✗ none | ✓ org default auto-applied | partial libraries, subscribed [I] |
| 39 | System built from a codebase | ✗ none | ✗ none | ✓ onboarding, `/design-sync` | partial Code Connect maps |
| 40 | Lint against the system | ✗ none | ✗ none | ✓ self-check before output | ✓ Check designs (Org/Ent) |
| 41 | Admin lock on the system | ✗ none | ✗ none | ✓ Design Admin permission | partial publish rights, plan-gated |

### Collaboration

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 42 | Anchored comments | ✗ in model only, no writes | ✗ none | ✓ anchored threads | ✓ pins and regions |
| 43 | Comment → AI turn → reply in thread | ✗ none | ✗ none | ✓ Send to Claude, @Claude | ✗ agent reads comments from chat only |
| 44 | Real-time presence, co-editing | ✗ CRDT unused (01 §2.6) | ✗ none | partial `room`; Design unreliable | ✓ cursors, follow, spotlight |
| 45 | The making conversation as provenance | partial artifact tied to its chat | partial dock built from chat | ✓ artifact lives in chat | ✓ agent chats shared by default |
| 46 | Notifications for comments and requests | ✗ none read `/api/notifications` | ✗ none | partial session status lines | ✓ tiers, 30-min batching |
| 47 | Review / approval states | ✗ none | ✗ none | ✗ not documented | ✓ Ready for dev, approvals |

### Sharing and permissions

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 48 | A share link per artifact | partial snapshot link | ✗ chat links only | ✓ one private-by-default URL | ✓ file and frame links |
| 49 | Latest or pinned version | ✗ timestamp snapshot (M31) | ✗ none | ✓ latest or specific | partial version links; Sites history |
| 50 | Viewer / commenter / editor roles | ✗ anonymous read-only | ✗ none | ✓ roles by type | partial view/edit; Ask to edit |
| 51 | Publish kept separate, with visible state | ✗ opening dialog publishes (L5) | ✗ none | partial legacy Publish; new Share | ✓ Publish / Update / Unpublish |
| 52 | Designs render at the share link | ✗ raw JSON (X-20) | ✗ no link | ✓ hosted page | ✓ file and prototype views |

### Library and information architecture

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 53 | One index of everything made | partial four surfaces (00 §4.5) | partial three doors (02 §5) | ✓ Artifacts tab, auto-save | ✓ one file browser |
| 54 | Thumbnails of the real thing | partial SVG only; JSON tiles (L30) | partial live web views; design glyph | ✓ kind sheet thumbnails | ✓ thumbnails; folder previews back |
| 55 | Search and type filters | partial client-side, 200 cap (M26) | partial titles only | partial "Filter by" | ✓ ⌘/ search with type filters |
| 56 | Trash / recently deleted | ✗ hard delete | ✗ hard delete | ✗ Docs: "no trash" | ✓ Trash, Deleted files |
| 57 | Canonical link per artifact | ✗ identifier-based `?artifact=` | ✗ none | ✓ `/artifact/{id}` | ✓ `/design/<key>` |
| 58 | Owner and home independent of the chat | ✗ conversation-owned (X-22) | ✗ same server rule | ✓ account-owned since 08-19 | ✓ Drafts or a folder |
| 59 | Star / pin | ✗ none | ✗ none | ✓ Star; pin to sidebar | ✓ Starred, pinned |

### Export and handoff

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 60 | Design export formats | partial 9 formats; 500 on non-Latin names (X-23) | ✗ every item fails (Mac M7) | ✓ zip/PDF/PPTX/HTML + 15 destinations | ✓ PNG/SVG/PDF + video |
| 61 | Office / PDF from docs and decks | partial Markdown → docx/pptx; deliverables unreachable (X-25) | partial library Office export | ✓ Word/PDF/MD/GDocs; PPTX | partial Slides PPTX |
| 62 | Handoff to a coding agent, with motion | partial bundle with no consumer | ✗ export fails | partial Claude Code handoff bundle; motion not publicly documented | ✓ Dev Mode, MCP, motion code |

### Mobile and native

| # | Capability | Juno web | Juno Mac (iPhone) | Claude | Figma |
|---|---|---|---|---|---|
| 63 | View made things on a phone | partial full-bleed Canvas, no touch | partial iPhone views; chat designs fail (X-11) | ✓ Artifacts tab | ✓ view, play prototypes |
| 64 | Edit designs on a phone | ✗ no touch pan (M57, M58) | partial iPhone library edits latest version | ✗ native apps view-only | ✗ cannot edit Design |
| 65 | Comment on a phone | ✗ none | ✗ none | ✗ apps are view-only | ✓ long-press to comment |
| 66 | Offline reading | ✗ online only (n/a in audit) | partial reads offline; no edits | ✗ not documented | partial open files, 7–30 days |

### Governance

| # | Capability | Juno web | Juno Mac | Claude | Figma |
|---|---|---|---|---|---|
| 67 | Rate limits and quotas on writes | ✗ none (X-30, X-33) | ✗ same server | ✓ plan limits; 60/h comment cap | ✓ 100 comments/h; credits |
| 68 | Per-feature admin toggles | ✗ none | ✗ none | ✓ Artifacts › Docs/Slides/Design | ✓ public links, publishing |
| 69 | Audit / activity log | ✗ no telemetry (00 §12.11) | ✗ none | ✓ `claude_artifact_*` events | ✓ activity log (Org/Ent) |
| 70 | Moderation, takedown, public trust label | ✗ none (X-31, X-32) | ✗ none | ✓ publish refusals; "unverified" label | partial admin link controls only |
| 71 | Data portability after a downgrade | partial account export skips artifacts | ✗ none | partial projects lost after unsubscribing [C] | partial REST rejects Make files [C] |

**Reading the matrix.**
- **Juno leads Claude and matches Figma** on 15 (effects), 24 (the operation log) and 29 (interaction authoring).
- **Juno leads both** on 64 (design editing on the iPhone). It will also lead on 34 (motion started by an interaction) once a runtime plays it.
- **Juno matches Figma** on 66 (offline reading, Mac only).
- **Juno is at parity only on paper** on 8, 10, 11 and 32. The pieces exist, but defects in production break them.
- **Sharing, Collaboration and Governance are almost all ✗ for Juno.** The exceptions are a snapshot link, provenance tied to the chat, and a partial account export. These are what make a merged surface safe to open to more people (`00` §14).

---

## 6. UI/UX patterns worth adopting, and where each lives in Juno

**Priority** follows the Juno audit's sequence (`00` §14):
- **P0**: needed before or with the merge, or it stops loss or a trust failure.
- **P1**: parity with Claude and Figma.
- **P2**: where Juno can pull ahead.

The "Where in Juno" column names the surface and the code the audit points to. The file names are from `01` and `02`.

### 6.1 Identity, surfaces and information architecture

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| U1 | **Every artifact is an account-level object; messages reference its versions.** It has an owner and a default home from the first moment. Editing a message or regenerating adds a version or a branch and never deletes | Claude (saved to the account since 2026-08-19) [P]; Figma MCP always places a file in Drafts or a folder [P·1st]; Framer and v0 send AI edits to branches [P] | Server: `Artifact.userId`, a nullable `conversationId` with `SetNull`, `deletedAt`; remove `deleteMany` from edit and regenerate (X-03, X-04, X-22; `00` §12.1) | P0 |
| U2 | **One ArtifactView at every size.** A card in the transcript, a panel beside the chat, full screen, and a canonical page, all the same component and the same state. Full screen keeps the composer | Claude's path and MCP Apps guidance [P]; ChatGPT's display modes [P] | New canonical `/a/{id}`. `CanvasPanel` renders it docked. The Mac dock is backed by the stored row (X-11, X-12; `DesktopArtifactCanvas.swift`) | P0 |
| U3 | **Design is a type, and editing is a mode.** No `/design` destination. The editor toolbar switches modes of one document: **Design · Prototype · Motion · Inspect**. Slides get a "design mode" that reveals the full editor | Figma modes [P]; Slides ⇧D [P]; Claude Design inside conversations [P] | `design-editor.tsx` toolbar. `/design` redirects to `/artifacts?type=DESIGN` (`00` §12.10). Drop the separate Design row the Liquid Glass branch adds (`02` §6) | P0 |
| U4 | **An explicit "make a…" menu beside automatic routing.** Output in the composer, New in the library, slash commands, templates | Claude Output picker, templates, /docs, /design [P]; Figma + Create [P] | Composer `+` menu → **Make** (Design, Doc, Deck, Site…); `/artifacts` **New**; ⌘K "New design" (missing today, `01` §4.3) | P1 |
| U5 | **Say which type Juno is making.** A one-line intent on the card while streaming ("Making a design · 2 screens") | The top HN complaint about Claude's merge was opaque routing [C] | `artifact-inline-card.tsx` header; Mac inline card | P1 |
| U6 | **One live card per artifact, pinned to the version its turn made.** Older cards shrink to a version chip. Links in chat open that version | Claude hides superseded edit cards [P·1st]; Claude Science pins the version [P] | `message-item.tsx` / `artifact-inline-card.tsx` (L9) | P1 |
| U7 | **Panel contract.** A labelled region. Focus moves in on open. Esc closes and returns focus to the trigger, else the composer. Transitions are switched off during drag-resize | Observed in the shipped Claude desktop app [P·1st] | `CanvasPanel` (M23; L15); Mac dock (no Esc today, `02` §5) | P1 |
| U8 | **Fixed, resizable, user-controlled panels, sized by their container.** No floating panels. Nothing auto-pops over the canvas on selection. The last layout is remembered | Figma reverted floating panels (2024-10-01) [P]; complaints about the auto-popping panel [C]; PREMIUM_AUDIT rule 11 | Editor rails keyed to the container, not the viewport (M17, X-18). Persist widths natively (`02` §5: widths are lost in a `.nonPersistent()` store) | P0 |

### 6.2 The AI editing loop

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| A1 | **Juno reads the current version and edits by operations or patches, never by full re-emit.** Hand edits by a person win and are reported | Claude targeted updates [C]; the Docs "their words win" guard [P·1st]; Figma's agent edits the live file [P] | `system-prompt.ts` Canvas contract; `artifact-edit.ts` patches; DESIGN goes through `operations.ts` transactions. Retire the compact grammar, or make it "operations against an empty document" (X-05, X-06, X-10) | P0 |
| A2 | **One AI channel.** Ask Juno and the chat composer become one thread whose proposals appear in the transcript | Claude: comments, selection and chat all arrive as turns in one conversation [P·1st] | Fold `ask-juno-bar.tsx` into the conversation; proposals are transcript cards (`01` §4.6) | P0 |
| A3 | **Proposals you can review, top to bottom.** An isolated preview, per-change Accept/Reject, and an honest result | Notion Suggested Edits [P]; Make staged Apply [P]; Juno's own preview-then-accept | Proposal card plus the canvas preview. Fix M46 (review leaks writes) and M47 ("applied" when it failed) | P1 |
| A4 | **Select, then ask, with a defined payload**: node ids, DOM or xpath, computed styles, the selection text and a screenshot. The selection shows as a chip in the composer | Claude passes the Design view state (artboard and selection) and the Docs selected blocks to the model [P·1st]; Cursor's payload [P]; Figma ⌘↵ on a layer [P] | `quote-context.ts` chip, extended to design nodes and web previews; keyboard reachable (M22) | P1 |
| A5 | **Queued asks above the composer.** Comments, annotations and selections collect as pending items and go with the next message | Claude Science [P]; batched Markdown edit requests [P]; Make "Annotate for agent" [P]; Lovable/Cursor queues [P] | Composer tray above the input on web, Mac and iPhone | P1 |
| A6 | **Try fixing with Juno.** A failed preview or refused artifact offers one action that sends the error and console output as a turn, and shows the refusal reason | Claude [P] | Canvas failure banner (`canvas-panel.tsx:1223-1235`); refusal copy (M4) | P1 |
| A7 | **Clarify with a form, not prose.** Before a first design, a few multiple-choice questions (chips, segmented choices, colour); any question can be skipped | Claude Design's multiple-choice questions before building (PCWorld) [S]; "taste exam" (Builder.io) [S] | An inline form card in the transcript; the answers go into the design brief | P2 |
| A8 | **Directions as first-class options.** N variants side by side, each one nameable in chat, and one change applied across a Shift-selection | Claude Design's ~3 options by default [S]; Stitch Agent Manager and Shift-click changes [P]; Figma's "Create 3 motion variants" advice [P] | Design canvas: options as a row of artboards, each one nameable in chat | P2 |
| A9 | **Tweaks.** The model declares typed props, the host renders them as controls, the design re-renders live with no model turn, and values persist | Claude Tweaks (`data-props`) [P·1st]; Figma code-layer props and shader PropsKit [P] | Generalise `design-adjustments.tsx`; HTML/React artifacts declare props the Canvas renders | P2 |

### 6.3 Versions

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| V1 | **A version counts as current only when it is complete.** Stopped or truncated output never becomes current and is never labelled verified | Claude users on truncated blank previews [S]; Juno X-07 | `chat-artifact-verification.ts`; version `complete` flag (`00` §12.1) | P0 |
| V2 | **Published versions are immutable, with a separate working head.** Design autosaves fold into the head, and named checkpoints collapse the autosaves in between | Figma collapses autosaves under named versions [P] | `store.ts:179-203` today rewrites rows in place, which shares can see (M31) | P0 |
| V3 | **A version stepper that renders any version**, a diff toggle (visual for designs), and restore as a new version that keeps the state left behind | Claude Science stepper + diff [P]; Figma restore adds two checkpoints [P]; Figma compare side by side or overlay [P] | Canvas history rail (it renders only text diffs today, `01` §4.4); a design overlay compare | P1 |
| V4 | **Links carry a version.** `?v=` is honoured everywhere, and share links pin a version or follow Latest | Claude share pin [P]; Claude Science links [P] | Search `?v=` (M28); share model (`00` §12.7) | P1 |

### 6.4 Comments, presence and review

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| C1 | **A comments table for every type**, keyed by artifact, version and anchor. Anchors per kind: a design node (pinned to its top-level frame), a text range, a slide, a timestamp in motion. A screenshot is captured at comment time. Resolve hides. Filters: unread, resolved, mine, this page. **C** for comment mode, **⇧C** to show or hide | Figma comments [P]; Make screenshot per version [P]; Figma time-stamped motion comments [P] | New table (`00` §12.1). Retire the unwritten `DesignComment` array, or back it with the table | P1 |
| C2 | **Send to Juno.** A comment, or an @Juno mention, arrives as a turn. Juno answers *in the thread*, links the version it made, and sets an `answered` flag. Writing a comment is free | Claude [P·1st]; Lovable full-thread payload and free comments [P] | Comment composer; `DesignComment.transactionId` already reserves the link | P1 |
| C3 | **Orphaned anchors are flagged**, not silently moved | Lovable "lost reference" [P] | Comment pins after structural edits | P1 |
| C4 | **Presence in phases.** First "Currently viewing / Previously viewed". Later: avatars, follow with a frame in the person's colour, and spotlight with a "Not now" countdown. Juno appears as a participant marked as an agent | Figma viewer history, follow, spotlight [P]; Claude `room` with marked agents [P·1st] | The artifact page header; the canvas | P2 |
| C5 | **The conversation that made an artifact is its provenance.** It opens from the artifact ("View in context") and is private by default | Claude Science Provenance and View in context [P]; Figma's shared-chat default is disputed in its own docs [P] | Artifact header menu; the Mac library cannot open the conversation today (`02` §5) | P2 |
| C6 | **Review states with an automatic Changed flag**, and an optional approve-then-lock | Figma Ready for dev / Changed [P]; Buzz approvals [P] | Status chip on the artifact header | P2 |

### 6.5 Sharing and publishing

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| S1 | **Two concepts.** *Grants* give people live access as viewer, commenter or editor. *Publish* puts a snapshot pinned to a version on the public web, with a visible **Not published / Published** state, **Update** and **Unpublish**, and the same URL on republish. **Opening the dialog never publishes** | Figma Publish/Update/Unpublish [P]; Claude roles by type [P] | `share-dialog.tsx` (L5, M30, M31); `share.ts` | P0 |
| S2 | **Dialog anatomy**: invite field; audience; role; "Who has access", ordered by source; Latest or a specific version; Copy link that includes the current selection; a pending-request badge on Share | Claude Share [P]; Figma Share modal and Ask to edit [P] | Web dialog; native `NativeShareClient` (CHAT-only today) | P1 |
| S3 | **Public trust and abuse controls ship with scripted public pages.** An "unverified" label for outside viewers; report and takedown; bans propagate; rate limits; screening at publish | Claude label and publish refusals [P]; ClickFix abuse [S]; Figma admin link controls [P] | `00` §12.8 (X-31, X-32). Same release as the X-01 origin move | P0 |
| S4 | **Designs render on the share page**, and each shared item has an OG image | Claude hosted page [P]; Figma file view [P] | `shared-artifact-viewer.tsx` through the server SVG renderer (X-20; L72) | P0 |

### 6.6 Library

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| L1 | **One Artifacts index of everything made**, saved automatically: designs, docs, decks, sites, diagrams, code, generated media and deliverables. Type filters, server search, sort, paging, bulk actions, **Recently deleted** | Claude Artifacts tab [P]; Figma file browser [P]; ChatGPT Library [P] | `/artifacts`, reusing `/api/library` machinery (`00` §8 item 10); settle REWORK_PLAN versus TWO_PRODUCTS (`00` §13 Q2) | P1 |
| L2 | **The picture comes first and the type glyph second.** A server-rendered thumbnail for every kind; a custom thumbnail ("Set as thumbnail"); remembered sort | Figma thumbnails and the Sept 16 reversal [P/C]; Claude kind sheets [P·1st] | Every tile, card and share preview (X-20, L30); one type registry for labels and glyphs (`00` §5) | P0 |
| L3 | **Per-conversation output rail**: what this chat made, with generating states, several items of one type, and "Turn into…" siblings | NotebookLM Studio [P]; Gemini Create [P] | `session-outputs.tsx` | P2 |
| L4 | **Star, pin and folders (or projects), without folder sprawl** | Figma Starred and pins [P]; Claude pin to sidebar [P·1st] | Library and sidebar; project scoping fixes X-21 | P2 |

### 6.7 Editor, Play and handoff

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| E1 | **On-canvas editing of layout**: padding and gap handles, grid track pills, a hover outline for slots, and validation shown as a non-blocking check or warning | Figma [P] | `design-canvas.tsx` overlays | P1 |
| E2 | **Keyboard and clipboard parity**: ⌘C/⌘V/⌘X, Space or H to pan, zoom keys, Enter / ⇧Enter / Esc to move through the hierarchy, Alt-drag to duplicate, and Esc that *cancels* | Figma keyboard [P]; Juno gaps (`01` §4.5, M48) | Editor field drafts and shortcut map | P1 |
| E3 | **Agent presence on the canvas**: a working state on the nodes Juno is building; a pill on the target that opens the thread; parallel asks | Figma `node.placeholder` [P·1st] and loading indicators [P]; Paper `finish_working_on_nodes` [P·1st] | Canvas overlay layer | P1 |
| E4 | **Code frames on the design canvas**: an HTML/React artifact version placed as a node. Double-click to edit, props appear as controls, ⌘D to compare, and extract to layers | Figma code layers [P]; Claude artboards are HTML [P·1st]; Canva Code embeds [S] | A new scene node that references an artifact version; keeps the no-programs-in-scene rule for effects (`types.ts:117-123`) | P2 |
| E5 | **One Play mode for every type**: prototype, deck, HTML. In the panel, full screen and at the share link. Restart with R, hints on click, a device frame | Figma Present and inline preview [P]; Claude Play and Present [P·1st] | `/a/{id}/play`; the "Play" action in ArtifactView (M61) | P1 |
| E6 | **Inspect and handoff**: a code view for the selection and a motion timeline beside CSS/React/SwiftUI output, with a handoff bundle that a coding agent actually consumes | Figma Dev Mode + MCP [P]; Claude handoff bundle [P] | Editor Inspect mode; Juno Code handoff (the bundle has no consumer today, `00` §4.2) | P2 |
| E7 | **Design system as a type**: tokens including Timing and Easing, components with previews, a Theme menu of *named* tokens, applied by default, a lint with one-click token fixes, "apply brand to existing" | Claude Design System type [P·1st]; Figma Check designs [P]; Canva retroactive brand [S] | New DESIGN_SYSTEM kind; inspector token pickers (`bindVariable` covers only `fills.0.color` today) | P2 |

### 6.8 Phone and Mac

| # | Pattern | Evidence | Where in Juno | Pri. |
|---|---|---|---|---|
| N1 | **Native decoding that tolerates unknown kinds and oversized rows** before any new type ships | Juno X-09 | `NativeArtifactStore.swift:101-167` | P0 |
| N2 | **An honest phone contract.** View full screen, comment by long-press, send to Juno, and light edits through fields (text, colour, tweaks) plus proposals. Full canvas editing only where it is safe (latest version, transactions) | Claude native apps are view-only [P]; Figma long-press comments and quick reply [P] | iPhone artifact detail (`JunoMobileWorkspaceViews.swift`); web below 50rem | P1 |
| N3 | **Mac document behaviour**: menu-bar Save, Export, Rename, History and Undo; Quick Look and drag-out; restorable windows; Handoff | macOS expectations; Figma agent pop-out window [P]; Claude split view [P·1st] | `DesktopArtifactsScreen.swift`, `DesktopDesignScreen.swift` (`02` §5) | P1 |
| N4 | **Offline edits queued with a visible sync state**: an unsynced badge, "Open to sync", Review or Dismiss on conflict. Drafts are never dropped | Figma offline [P]; Juno X-16 | Mac and iPhone design drafts | P1 |

---

## 7. Motion patterns worth adopting, with specs in Juno's tokens

**Juno's vocabulary** (`globals.css:314-349`, `src/lib/motion.ts`, `ICONS_AND_MOTION.md` §2):

- **Durations:** press 70, fast 120, exit 160, base 220, slow 360, emphasis 560 ms.
- **Curves:**

  | Curve | Values |
  |---|---|
  | `ease-out-soft` | .33,1,.68,1 |
  | `ease-out-strong` | .32,.72,0,1 |
  | `ease-out-expo` | .16,1,.3,1 |
  | `ease-in` | .4,0,1,1 |
  | `ease-in-out` | .65,0,.35,1 |
  | `ease-breathe` | .45,0,.55,1 |
  | `ease-out-back` | .34,1.32,.64,1 |
  | `ease-spring` | .22,1,.36,1 |
  | `ease-drawer` | .32,.72,0,1 |

- **Framer transitions:** `transition.press / fast / exit / base / slow / emphasis / symmetric`. The `emphasis` rung is "reserved for a change the user did NOT cause".
- **Springs:** `spring.standard` (220 ms, bounce .05), `emphasized` (360, .1), `layout` (360, 0), `interactive` (stiffness 320, damping 30, mass .8).
- **Variants:** `fade`, `rise` (6 px), `pop` (4 px, .96), `stage` (12 px), `swap` (.8).
- **Stagger:** `STAGGER` 30 / 45 / 60 ms, capped at 10 items.
- **Laws that constrain everything below:**
  - Only transform and opacity travel.
  - Hover is tonal: nothing lifts or casts a shadow.
  - Loops only for live state.
  - Reduced motion keeps fades and drops travel.
  - A panel docking from an edge enters on `ease-drawer`.
  - PREMIUM_AUDIT rule 10 (nothing in chrome moves except a fill), rule 14 (ambient motion must not borrow a loading gesture) and §2d (selection does not travel across a scroller).

### 7.1 Cross-walk: Claude's shipped tokens, Juno's, and Figma's

| Role | Claude (observed in the shipped desktop app [P·1st]) | Juno | Figma |
|---|---|---|---|
| Press | `scale(.98)` in inline visuals | `duration-press` 70, `scale(.97)`, `ease-out-strong` | not documented |
| Hover, reveal, crossfade | 120 ms | `duration-fast` 120, `ease-out-soft` | not documented |
| State change | 200 ms | `duration-base` 220 | not documented |
| Sheet or drawer | 300 ms, quart-out | `duration-slow` 360 + `ease-drawer` (the web dock) | not documented |
| Lift, lighting, bubble pop | 450 ms | *(no lift, by law)*; `emphasis` 560 for unprompted changes | not documented |
| Exit | fall 180 ms | `duration-exit` 160, `ease-in` | not documented |
| Snap curve | `.32,.72,0,1` | **identical**: `ease-drawer` = `ease-out-strong` | — |
| Overshoot | `.34,1.3,.64,1` | `ease-out-back` `.34,1.32,.64,1` | "Ease out back" preset |
| Default decelerate | quart-out `.165,.84,.44,1` | `ease-out-soft` (cubic-out) | "Ease out" |
| Springs | not used in chrome | duration + bounce presets | Motion: Gentle/Quick/Bouncy/Slow, custom bounce 0–1; prototypes: mass/stiffness/damping |
| Loops | shimmer 3 s, breathe 3 s, dots 1.8 s | `ease-breathe`, live state only | shaders animate on `frame.time` |
| Stagger | 60 ms offsets | 30 / 45 / 60, cap 10 | agent guidance: "stagger related elements" [P·1st] |
| Skeleton delay | reveal after 0.5 s | none defined | not documented |
| Reduced motion | Settings: System \| Reduced, plus the OS | OS preference, tiered | `prefers-reduced-motion` mandatory in generated code [P·1st] |
| Authored-motion durations | Slides transitions have none published | the ladder above | agent guidance 0.25–0.7 s [P·1st]; timeline default 2000 ms [P] |

**Conclusion.** Juno does not need new tokens to match Claude's feel; its ladder already covers every role. Two things are missing: a **skeleton reveal delay**, and an **in-app reduced-motion setting** that names streaming. Figma's authored-motion guidance (0.25–0.7 s) spans Juno's `base` (220) to `emphasis` (560) rungs, so the same ladder can serve as design tokens (§7.3).

### 7.2 Product motion: how the merged surface should move

| # | Pattern | Evidence | Juno spec | Reduced motion | Where |
|---|---|---|---|---|---|
| M1 | **Card → panel continuity**, only when the card is on screen at the click. The card's thumbnail morphs into the panel header; the chat column narrows in step | MCP Apps: "expand … with a smooth transition" [P]; Claude's only morph: 350 ms on `.32,.72,0,1` (image lightbox) [P·1st]; no card→panel morph on Juno web or Mac today (`02` §7.1) | framer `layoutId` on the thumbnail; `duration-slow` 360 on `ease-drawer` (Claude's curve, same numbers); the column width uses `spring.layout`. Opening from a deep link or the library uses the plain dock entrance. **Closing does not fly back**: the panel exits on `duration-exit` / `ease-in`, so nothing travels across the scroller (§2d) | opacity crossfade on `duration-fast` | `artifact-inline-card.tsx` → `CanvasPanel`; Mac inline card → dock |
| M2 | **Panel open, close and resize** | Claude: all transitions off while resizing [P·1st]; Juno web dock already enters on `ease-drawer` | Enter: 16 px `x` + fade, `duration-slow`, `ease-drawer`. Exit: `duration-exit`, `ease-in`. **While resizing, disable transitions**, and do not replay the entrance afterwards (fixes L15) | fade only; no offset (fixes L16 and the Mac dock) | `chat-view.tsx`; `DesktopArtifactCanvas.swift:433-439` (swap `canvasEnter` from outExpo to the drawer curve) |
| M3 | **Full screen and back**, with the composer kept and the scroll position restored | MCP Apps "returns to the conversation at the same scroll position" [P]; ChatGPT's composer overlaid in full screen [P] | framer `layout` on the panel frame, `spring.layout` (360, bounce 0). Store and restore the transcript scroll offset | crossfade `duration-fast` | `CanvasPanel` fullscreen (also add the focus trap, M23) |
| M4 | **A version change is a swap, never a remount** | Claude frame crossfade 120 ms [P·1st]; in-place hot swap (the runtime modules are [P·1st]; their use for Design pages is (unverified)) | Code or HTML: replace in place, then crossfade the frame on `duration-fast` / `ease-out-soft`. **Design: apply the operation diff to the mounted editor.** Never key the editor by version (the X-02 root cause) | instant swap | `canvas-panel.tsx:1237,1260,1284` |
| M5 | **Change reveal when Juno's edit lands.** Show which nodes, blocks or lines changed | Juno's `emphasis` rung is "reserved for a change the user did NOT cause" (`motion.ts`); the web audit found an Apply "swaps the whole scene in one frame" (`01` §5.1) | Changed nodes get the selection-outline style, which fades out over `duration-emphasis` 560 on `ease-out-expo`. Text blocks get a tonal fill that fades the same way. One shot, no loop, no travelling band | outline shown statically for 1.5 s, then removed with a `duration-fast` fade | Design canvas overlay; doc and code views; Mac hosted editor |
| M6 | **Streaming into the object** | Claude's inline visuals diff partial HTML into the live DOM as tokens arrive [P·1st]; Docs: skeleton, then fill section by section [P·1st]; Stitch streams to the canvas and can be steered [P] | **Docs and decks:** open a skeleton of intent placeholders at once; each section replaces its placeholder with `variants.rise`, in reading order. **Designs:** nodes appear as operations apply (`variants.fade`, `duration-fast`). **Code:** keep Juno's single stream-tail mask. **Never show old content under "Writing"** (M15) | fades keep their timing; no rise offset | Canvas and inline card; design canvas |
| M7 | **Delayed skeletons**: never flash a skeleton for a fast load | Claude reveals after 0.5 s, then a 150 ms fade [P·1st] | Placeholder reveal after 500 ms, then `duration-fast` / `ease-out-soft`. A sweep may run only while waiting for data (rule 9 live state; rule 14 does not apply because this *is* loading) | no sweep; static placeholder | Library tiles, Canvas first open (`01` §4.4: no loading fallback) |
| M8 | **Juno is working here** (on a node, a comment or a tile) | Figma `node.placeholder` shimmer [P·1st]; Claude comment-working pulse 1.6 s and clay breathe 3 s [P·1st]; Paper per-node working state [P·1st] | A tonal breathe (brightness as a proportion, per rule 14's amplitude form) on the selection box of affected nodes, on `ease-breathe` at the rhythm of the existing live glyph. It stops the moment the work lands, followed by M5. **One live-dot animation product-wide** (fixes L17) | static tint; no loop | Design canvas, comment anchors, inline card status |
| M9 | **An agent pill on its target** for parallel asks, which opens the thread | Figma: an "animated loading indicator on the canvas" per prompt [P] | Pill enters with `variants.pop` (`duration-base` on `ease-spring`) and exits with `exit` (160, `ease-in`); its content state swaps via `IconSwap` | fade only | Design canvas; previews |
| M10 | **One live card per artifact.** Superseded cards shrink to a version chip | Claude hides superseded edit cards (opacity 0) [P·1st] | `Collapse` (grid-rows 0fr↔1fr on the symmetric curve with a short fade), then the chip; the chip's label swaps via `IconSwap` | rows snap; fade kept | Transcript |
| M11 | **Library tiles are dealt, not dumped** | Claude list rows rise −12 px over 300 ms [P·1st]; Juno law rule 5 | `staggerDelay(i, "base")` (45 ms, cap 10) with `motion-safe:animate-rise-in`. A thumbnail crossfades in on `duration-fast` when it renders. **No lift on hover** (tonal). Switching list/grid does not replay the stagger (`01` §5.1) | fade only | `/artifacts`; Mac Artifacts grid (dumped today, `02` §7.1) |
| M12 | **Comment pins** | Figma: pins move with their frame, resolve hides [P]; Lovable orphan flag [P] | A new pin uses `variants.pop`. The thread panel uses `variants.rise`. Resolve uses the `exit` variant, then `Collapse`. **An orphaned pin is a static dashed ring, with no motion** | no travel | All artifact viewers |
| M13 | **Presence** | Figma: follow frame in the leader's colour, spotlight "Not now" countdown, cursor chat fades after 5 s [P] | Avatars use `variants.pop`. The follow frame fades in on `duration-fast`. Idle cursor labels fade on `exit` after 5 s. A spotlight request waits 3 s with a visible **Not now** before the view moves on `duration-slow` / `ease-drawer` | the view jumps; no camera motion | Artifact header; canvas (phase 2) |
| M14 | **Tweaks and inspector controls** | Claude's tweaks change the design live [P]; Claude's panes and phone drawer switch transitions off while dragged, so they track the pointer [P·1st] | Segmented thumb on `duration-fast` / `ease-out-strong`; swatches and toggles use `.pressable` (`duration-press`). **While a slider or handle is dragged, the canvas updates with no transition** (it tracks the pointer); release settles on `spring.interactive` | unchanged (these are direct manipulation) | `design-adjustments.tsx`; inspector |
| M15 | **Canvas camera**: zoom to fit, zoom to selection, "go to" a comment | Juno: these jump today (`01` §5.1) | `duration-slow` on `ease-drawer`, interruptible (a spring if a gesture takes over) | jump | `design-canvas.tsx` |
| M16 | **An in-app reduced-motion setting that names streaming** | Claude Settings ▸ Motion: System \| Reduced, "Reduce animation in streaming responses and other interface elements" [P·1st] | Settings ▸ Appearance ▸ Motion sets `data-reduce-motion`. The existing tiered rules read it as well as the OS query. The Mac mirrors it through `JunoMotion.reduced` | — | Settings; `globals.css` unlayered block; `JunoDesignTokens.swift` |

### 7.3 Motion inside documents: the model the merged surface should author, play and export

Figma's keyframe semantics are the right base. They fix Juno's audited motion defects by construction, and they make Figma's MCP output a near-lossless import format ([P·1st] local `figma-use-motion`; `01` §5.2).

1. **Tracks.**
   - Translate and rotate are **additive** and scale is **multiplicative**, relative to the layout position and around an **anchor point** (default: the centre; the anchor is editable).
   - Opacity, radius, colour, blur, width and height, auto-layout gap and padding, and path trim are absolute.
   - This fixes **M64** (x/y tracks move auto-layout children in export only) and **L21** (track order moves the scale origin).
2. **Easing belongs to the incoming segment.** The first keyframe holds back to 0 and the last holds to the end. Add **Hold** as a step, exported as CSS `steps(1, jump-end)`. Juno today puts easing on the outgoing segment (`types.ts:714`).
3. **One easing vocabulary for documents and product.**
   - The named curves are Juno's nine curves.
   - Springs are **duration + bounce**, the same form as `motion.ts`, SwiftUI `.spring(duration:bounce:)` and Figma's `NormalizedSpring`. They export as springs, never as ease-out (fixes **L20**).
   - Figma's Gentle/Quick/Bouncy/Slow import by name. Physical mass/stiffness/damping values convert once on import, as Figma's own `physicalSpringToNormalized()` does.
   - `spring.interactive` (stiffness/damping/mass) is the one product preset still in physical form. Give it a duration+bounce twin so documents never need two forms.
4. **Motion tokens live in the Design System type.**
   - Timing tokens: `press`, `fast`, `exit`, `base`, `slow`, `emphasis`.
   - Easing tokens: the nine curves plus `standard`, `emphasized` and `layout` springs.
   - A **Reduced** mode maps travel to 0 and keeps fades, mirroring Juno's product tiers.
   - Switching a mode retimes every reference, as Figma's variables with modes do [P].
5. **Presets before raw keyframes.** Each is one style id plus two or three parameters, which is what a chat model can emit reliably:

   | Preset | Default |
   |---|---|
   | Fade | `base`, `ease-out-soft` |
   | Rise | 6 px, `base` |
   | Pop | .96 + 4 px, `base`, `ease-spring` |
   | Move | — |
   | Scale | — |
   | Rotate | — |
   | Stage | 12 px, `slow` |
   | Exit versions | `exit`, `ease-in` |

   Presets stack or sequence. `STAGGER` 30/45/60 sequence groups of items. Figma's own agent guidance (0.25–0.7 s, stagger, ease-out or gentle springs, no flashy loops) sits inside this ladder [P·1st].
6. **Motion that can be triggered.**
   - Keep and wire `play-animation` (with reverse) and `scroll-into-view`. Figma users are asking for both [P/C].
   - Fix the runtime semantics:
     - delay timers start when the frame appears, not at page load (**M62**);
     - key triggers do not fire from hidden frames;
     - "while hovering" and "while pressing" reverse on release (**L26**);
     - reverse does not stick (**M63**).
   - Keep Juno's named animations with `state` (a Rive-like state machine, [P]) and give them a small UI later.
7. **Transitions run.**
   - Dissolve, slide, push and move reach the runtime.
   - Smart animate matches by **stable id**, not by layer name. Figma's name-and-tree matching breaks on rename [P].
   - Duplicating nodes must copy a match key; today `duplicateNodes` gives fresh ids with no lineage (`operations.ts:853-878`).
8. **One runtime and one player** for the canvas preview, Play, share links and exports.
   - Loop / Once / Ping-pong.
   - `prefers-reduced-motion` honoured.
   - Conformance tests that assert preview = export for every property.
9. **One IR with emitters, and media export.**
   - Emitters: CSS `@keyframes`, framer/motion.dev, SwiftUI `KeyframeAnimator` / `.spring(duration:bounce:)`.
   - Emit a cohort record (root, duration, loop mode, members), as Figma's `get_motion_context` does, so a coding agent drives one lifecycle [P·1st].
   - Video/GIF export from the deterministic renderer.
10. **Motion survives AI round-trips.** A chat revision must never drop tracks or interactions (**X-06**). The model edits motion through the same operations as everything else.
11. **Comments at a moment.** A comment can anchor to a time on the timeline, as Figma does [P]. Cursor's "frozen frame" lets a person point at a moment in a playing prototype [P].

### 7.4 Play, Slides and Present transitions

Claude names three transitions (`fade | push | magic`) and three build-ins (`fade | rise | pop`) but publishes no timings [P·1st]. Figma offers more styles plus spring curves [P·1st]. Juno should ship Claude's small vocabulary with Juno's timings, and add Figma's directional variants later.

| Name | Behaviour | Juno spec | Reduced motion |
|---|---|---|---|
| **fade** | Crossfade between slides or screens | `duration-slow` 360, `ease-in-out` (both ends visible) | `duration-fast` crossfade |
| **push** | Both slides move by one slide width | `duration-slow`, `ease-drawer`. Not `ease-out-expo`, which the web dropped as "a lurch that then hung" (`01` §5.3) | crossfade |
| **magic** (smart animate) | Nodes with the same stable id interpolate transform, opacity and colour; the rest fade | Matched: `spring.layout` (360, bounce 0). Unmatched: fade on `duration-fast` | crossfade |
| **build-in fade / rise / pop** | Per-element entrance on click or after the previous one | `variants.fade` / `rise` / `pop`; groups at `STAGGER.base` 45 ms | fade only |
| Present chrome | Controls pill and thumbnail rail | The pill hides after 2 s idle on `duration-exit` and returns on pointer move on `duration-fast`. The rail slides on `duration-base` / `ease-drawer`. Reorder uses framer `layout` with `spring.layout`. Slides are hidden, not unmounted, so their state survives | no slide; fades |

### 7.5 Juno's own motion debts to retire as part of the merge

These debts come from the audits. The merged surface makes each one more visible.

| Debt | Evidence | Fix |
|---|---|---|
| Exits missing on the save bar, conflict banner, failure banner, selection toolbar, proposal card, "Tune" card, fullscreen and deleted rows | `01` §5.1 | `exit` variant (160, `ease-in`) under `AnimatePresence`, or `Collapse` |
| The Canvas replays its entrance after every resize | L15 | Disable transitions while resizing; animate the dock only on open and close |
| Docks slide 16 px under reduced motion (web and Mac) | L16; `02` §7.1 | Fade only; the Mac uses `shift()` from the Liquid Glass branch |
| Two different "live" dots side by side | L17 | One live-state animation |
| Mac `canvasEnter` on outExpo; no press or hover on Mac artifact surfaces; hard cuts between library and document | `02` §7.1 | `ease-drawer`; `.junoPress`; `duration-fast` crossfades |
| The hosted editor lacks pop, tooltip and rail motion (stale bundle, unscanned CSS) | `02` §7.1; X-17, X-19 | Gate the bundle in CI; include the shared UI primitives in the scan |
| The timeline playhead animates `left` | `01` §5.1 | `transform: translateX` |
| The design canvas swaps the scene in one frame on Apply | `01` §5.1 | M4 + M5 |

---

## 8. What NOT to copy

| # | Anti-pattern | Who | Evidence | Juno's rule instead |
|---|---|---|---|---|
| 1 | **Shipping a type without version history** | Claude Docs, Claude Design | "No version history yet" ([help 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), [help 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P]) | Every type ships with versions, restore and a stepper |
| 2 | **Unpublish that destroys data; no trash; storage that fails silently** | Claude | Unpublish deletes storage and blocks republishing ([help 9547008](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts) [P]); Docs "There's no trash" [P]; storage in drafts fails with no error ([Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data) [C]) | Unpublish keeps the URL and the data. Recently deleted for 30 days. Every failed write is shown |
| 3 | **Two generations side by side** (legacy plus new artifacts, three URL schemes, a standalone Design with its own settings, analytics and storage) | Claude | [help 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork); [admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) [P] | Migrate in one pass. Old URLs redirect to `/a/{id}` (`00` §12.10). No second Design home |
| 4 | **Promising phone editing while the native apps only view** | Claude | Launch copy vs the help centre (§2.3) | Publish an honest phone contract (N2), then exceed it |
| 5 | **Opaque routing, and no way to stay in plain chat** | Claude | [HN 49729412](https://news.ycombinator.com/item?id=49729412) [C]; [Stephen Smith](https://www.smithstephen.com/p/claude-stopped-asking-which-mode) [S] | Name the type on the card (U5). Keep an explicit Make menu (U4). Keep plain answers possible |
| 6 | **Dropping branching in the merge; an irreversible, per-account migration** | Claude | [help 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P] | Keep the Mac's non-destructive edit-as-branch model and bring it to the web (`01` §4.2) |
| 7 | **A sidebar row per type** ("designer is always there") | Claude; the Liquid Glass branch adds a Design row | [HN](https://news.ycombinator.com/item?id=49729412) [C]; `02` §6 | One Artifacts row with type filters |
| 8 | **Card lift, light sweep, under-sheet fan and tilt on hover** | Claude desktop | Observed in the shipped Claude desktop app [P·1st] | ICONS_AND_MOTION rule 1: hover is tonal, nothing lifts. FLAT_UI: no sheen |
| 9 | **A second colour reserved for the AI's actions** (clay) | Claude | Observed in the shipped Claude desktop app [P·1st] | FLAT_UI §2.4: one accent, used for state |
| 10 | **Streaming a rewrite by deleting every line, then retyping** | Claude (2025) | [BigGo](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues) [S] | Apply patches or operations in place, then show a change reveal (M4, M5) |
| 11 | **A fake asymptotic progress bar** | Claude (context compaction, stops at 95%) | Observed in the shipped Claude desktop app [P·1st] | Honest states: a step list or indeterminate "working", never a made-up percentage |
| 12 | **Full-width mode that hides the conversation** | Claude chat artifacts | [AI UX Playground](https://www.aiuxplayground.com/teardowns/claude/artifacts/) [S] | Full screen keeps the composer (M3) |
| 13 | **Access to made things tied to plan state** | Claude Design (lost after unsubscribing) | [HN 48128003](https://news.ycombinator.com/item?id=48128003) [C] | Made things stay readable and exportable after a downgrade |
| 14 | **Hiding shared visual content from some viewers** | Claude inline visuals (logged-in web/desktop only; Cowork share links drop them) | [help 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) [P] | Shared views fall back to a static render, never to nothing |
| 15 | **Last-writer-wins self-saving pages for simultaneous editing** | Claude | [chaosguru](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) [C] | Keep compare-and-swap with base versions, plus operations (`00` §8) |
| 16 | **Floating panels; a permanent rail that cannot be hidden; a properties panel that pops open on selection** | Figma | [blog 2024-10-01](https://www.figma.com/blog/our-approach-to-designing-ui3/) [P]; [forum](https://forum.figma.com/t/allow-manual-open-close-of-right-panel/87945) [C] | Fixed, resizable, user-controlled panels sized by their container (U8). PREMIUM_AUDIT rule 2: two panes at most |
| 17 | **Forced UI migrations and phased rollouts without opt-in** | Figma (UI3 2025-04-30; the nav rail in 2026) | [forum](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) [C] | Keep old entry points working (redirects); stage behind one flag the owner controls |
| 18 | **A full-window view that hides the canvas you are editing** | Figma Variables view | [forum](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) [C] | Token editing in a panel next to the canvas |
| 19 | **Four animation systems and two spring parameterisations; motion that cannot be triggered; Smart Animate matched by layer name** | Figma | §3.2 [P/C] | One motion model and one runtime; duration + bounce springs; stable-id matching (§7.3) |
| 20 | **Clipboard bridges between types that lose the link** (Make → Design, library → Buzz) and **three homes for code** | Figma | [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs) [P]; [Buzz forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307) [C] | Conversions create linked siblings. Code lives in one place (an artifact) and is referenced on the canvas |
| 21 | **Seat gates on top of permissions; plan-gated basics** (branching, Check designs, extended collections) | Figma | [help](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions) [P]; [forum](https://forum.figma.com/ask-the-community-7/i-have-an-editor-access-but-is-on-view-only-mode-when-i-opened-the-file-28534) [C] | One permission model (grants). Safety features on every plan |
| 22 | **Library tiles without previews; colour-only differentiation** | Figma folders (2026-08-03, reversed 2026-09-16) | [release notes](https://www.figma.com/release-notes/) [P]; [forum](https://forum.figma.com/share-your-feedback-26/figma-folders-57057) [C] | Picture first, glyph second (L2); never rely on colour alone |
| 23 | **Comments that attach only to top-level frames; comment deletion that cannot be undone** | Figma | [help](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments) [P]; [forum](https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753) [C] | Anchors per kind with an orphan state; deleted comments recoverable with the artifact |
| 24 | **AI chats public by default, with docs that disagree on the audience** | Figma agent (2026-06-23) | [help: chat visibility](https://help.figma.com/hc/en-us/articles/41272399602583) [P] | The making conversation is private by default and shareable on purpose (C5) |
| 25 | **Closed formats** | Figma Make (the REST API rejects `.make`) | [albertsikkema](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) [C] | Every type is readable and writable through the same Juno tools and exports |
| 26 | **Shaders as programs inside the scene** (one live per page, missing from exports, off in Firefox) | Figma | §3.2 [P/S] | Keep Juno's rule that every effect is a recipe every exporter honours (`types.ts:117-123`). Programs live in code artifacts placed on the canvas (E4) |
| 27 | **Separate credit currencies and a 5.6× pay-as-you-go premium** | Figma (Weave, credits) | [forum](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944) [C] | One usage meter, shown plainly |
| 28 | **A hard memory lock at 100%** | Figma (2 GB per tab) | [help](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files) [P] | Degrade (thumbnails, lazy pages) before refusing. X-08 and X-09 show what a hard wall does to Juno |
| 29 | **Pink and blue outlines to encode template lock state** | Figma Buzz | [help](https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz) [P] | One accent; a lock is shown with a glyph and a tonal state |
| 30 | **Removing a surface power users relied on without a full replacement** | ChatGPT Canvas | [theaicareerlab](https://theaicareerlab.com/blog/chatgpt-what-changed-june-2026) [S] | Keep full-screen long-form editing when Canvas and Design consolidate |
| 31 | **An editor disabled with no explanation** | v0 Design Mode | [community.vercel.com](https://community.vercel.com/t/v0-design-mode-not-working-after-recent-update/34221) [P] | Every disabled or failed surface says why and offers one action |

**Claims kept out of the conclusions** (unverified in the fact-check):
- that Claude's pane streams source and then flips to Preview;
- that the desktop app's hot-swap runtime runs on Design pages;
- Claude Design's element floating toolbar and "select for Send to Claude" checkboxes;
- Figma's blue on-canvas agent bubbles as shipped UI;
- Figma's remaining CSS-Grid gaps in 2026;
- activity-log retention of 365 days;
- Stitch generating "a separate iteration" per prompt;
- ChatGPT help-centre snippets (the pages returned 403).

**Contradictions left open:**
- Whether Claude public links need sign-in: the help centre says every viewer needs an account; the Claude Code docs say public links need no sign-in.
- The audience of Figma's shared agent chats: one help page says "anyone with access", another says "Full seat and edit access".

---

## 9. Sources

Dates are publication or update dates. "Accessed" means the page was undated and read on 2026-09-23.

### 9.1 Anthropic / Claude: primary

- `docs/design/artifacts-design/research/claude-primary-evidence.md` — first-hand, 2026-09-23
- The shipped Claude desktop app, `/Applications/Claude.app` v2.7032.0 (styles and interface, observed first-hand) — built 2026-09-22, observed 2026-09-23
- "Imagine — Visual Creation Suite" `visualize` contract (CDS tokens and principles) — read 2026-09-23
- Claude Docs connector contract (`guide` topic.index, topic.comments, topic.editing) — read 2026-09-23
- [Introducing Claude 3.5 Sonnet](https://www.anthropic.com/news/claude-3-5-sonnet) — 2024-06-20
- [@AnthropicAI: publish and remix](https://x.com/AnthropicAI/status/1810698780263563325) — 2024-07-09
- [Build and share AI-powered apps](https://claude.com/blog/claude-powered-artifacts) — 2025-06-25 (update notes 07-17, 07-31)
- [Turn ideas into AI-powered apps](https://claude.com/blog/build-artifacts) — 2025-06-25 (updates 07-21, 07-31, 10-21)
- [Claude Sonnet 4.5 / Imagine with Claude](https://www.anthropic.com/news/claude-sonnet-4-5) — 2025-09-29
- [Interactive tools in Claude (MCP Apps)](https://claude.com/blog/interactive-tools-in-claude) — 2026-01-26
- [Claude builds visuals](https://claude.com/blog/claude-builds-visuals) — 2026-03-12
- [Claude Code desktop redesign](https://claude.com/blog/claude-code-desktop-redesign) — 2026-04-14
- [Introducing Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs) — 2026-04-17
- [@claudeai: live artifacts in Cowork](https://x.com/claudeai/status/2046328619249684989) — 2026-04-20
- [Claude Design stays on brand for daily work](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work) — 2026-06-17
- [Claude Code now supports artifacts](https://claude.com/blog/artifacts-in-claude-code) — 2026-06-18
- [Cowork on web and mobile](https://claude.com/blog/cowork-web-mobile) — 2026-07-07
- [@ClaudeDevs: public sharing and multiplayer](https://x.com/ClaudeDevs/status/2076789349145092230) — 2026-07-13
- [Claude Code what's new, W34](https://code.claude.com/docs/en/whats-new/2026-w34) — 2026-08-17 to 08-21
- [Claude Cowork and chat are now one Claude](https://claude.com/blog/cowork-is-now-claude) — 2026-09-16
- [Projects redesigned](https://claude.com/blog/projects-redesigned) — 2026-09-17
- [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts) — accessed 2026-09-23
- [Claude Code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) — v2.1.265–2.1.280, 2026-09
- [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines.md) — accessed 2026-09-23
- [MCP ext-apps spec](https://github.com/modelcontextprotocol/ext-apps) — stable 2026-01-26
- [Claude Science: artifacts](https://claude.com/docs/claude-science/artifacts), [comments](https://claude.com/docs/claude-science/comments.md) — accessed 2026-09-23
- [claude.com/product/design](https://claude.com/product/design) — accessed 2026-09-23

**Help centre** (all "updated this week" as of 2026-09-23 unless dated):
- [9487310 What are artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [9547008 Publish and share](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts)
- [14729249 Artifacts in Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork)
- [16923645 Claude Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)
- [14604416 Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) — modified 2026-09-18
- [14604397 Design system setup](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design) — 2026-09-16
- [14604406 Design admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) — 2026-09-16
- [16989529 External invites](https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact)
- [16761823 Cowork and chat are one](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)
- [13345190 Get started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [15520349 Cowork on web, desktop, mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
- [13979539 Custom visuals](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) — 2026-04-22
- [12138966 Release notes](https://support.claude.com/en/articles/12138966-release-notes) — entries 2026-01 to 2026-09-22

### 9.2 Claude: secondary and community

- [Pragmatic Engineer: how Anthropic built Artifacts](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts) — 2024-08-27
- [VentureBeat: GA and mobile](https://venturebeat.com/ai/anthropic-launches-claude-artifacts-generally-for-all-users-mobile) — 2024-08-27
- [Tom's Guide: highlight to edit](https://www.tomsguide.com/ai/claude-artifacts-get-a-big-update-now-you-can-highlight-and-edit-code-with-text) — 2024-09-02
- [Simon Willison: everything I built](https://simonwillison.net/2024/Oct/21/claude-artifacts/) — 2024-10-21; [AI-powered apps](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/) — 2025-06-25
- [Rui Quintino: Replace is all you need](https://medium.com/@rquintino/replace-is-all-you-need-the-surprisingly-simple-technique-behind-claudes-new-lightning-fast-b5ae18c3c113) — 2024-11-02
- [BigGo: artifacts complaints](https://biggo.com/news/202507160714_Claude_Artifacts_User_Issues) — 2025-07-16
- [Anvilogic: ClickFix via Claude artifacts](https://www.anvilogic.com/threat-reports/macsync-infostealer-via-clickfix-claude-artifact-abuse) — 2026-02-19
- [Gizmodo: Figma stock on Claude Design](https://gizmodo.com/anthropic-launches-claude-design-figma-stock-immediately-nosedives-2000748071) — 2026-04-17
- [PCWorld: locked out after half an hour](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html) — 2026-04-17
- [getpushtoprod: everything about Claude Design](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) — 2026-04-19
- [Lenny's Newsletter (Claire Vo)](https://www.lennysnewsletter.com/p/what-claude-design-is-actually-good) — 2026-04-22
- [Builder.io: Claude Design](https://www.builder.io/blog/claude-design) — 2026-04-29
- [dgtl dept](https://www.dgtldept.com/p/claude-design-escape-the-default) — 2026-04-30
- [UX Pilot review](https://uxpilot.ai/blogs/claude-design-review) — 2026-05-04
- [Caipi: can artifacts save data](https://caipi.ai/blog/can-claude-artifacts-save-data) — 2026-06-12
- [AI UX Playground teardown](https://www.aiuxplayground.com/teardowns/claude/artifacts/) — 2026-06-14
- [Vercel: Claude Design and Vercel](https://vercel.com/changelog/claude-design-and-vercel) — 2026-06-23
- [Anima review](https://animaapp.com/blog/ai-design-en/claude-design-review-features-pros-cons-and-best-alternatives/) — 2026-09-08
- [chaosguru: artifacts save themselves](https://chaosguru.substack.com/p/anthropics-google-docs-killer-is) — 2026-09-13
- [TechCrunch: the merge](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) — 2026-09-16
- [Fortune: superapp push](https://fortune.com/2026/09/16/anthropic-merges-its-claude-chat-and-agentic-cowork-products-into-a-single-ai-assistant-as-part-of-a-push-to-build-an-ai-superapp/) — 2026-09-16
- [ai-toolbox: how to use Claude Artifacts](https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026) — 2026-05-31, updated 2026-09-16
- [Coursiv: open questions](https://coursiv.io/blog/claude-docs-slides-design) — ~2026-09-17
- [tbreak](https://tbreak.com/claude-docs-slides-one-claude/) — 2026-09-17
- [Stephen Smith: Claude stopped asking which mode](https://www.smithstephen.com/p/claude-stopped-asking-which-mode) — 2026-09-17
- [Computerworld](https://www.computerworld.com/article/4223177/anthropic-tries-to-make-claude-stickier-with-launch-of-docs-and-slides.html) — 2026-09-17
- [go9x: Docs, Slides, Design hands-on](https://go9x.com/blog/claude-docs-slides-design) — 2026-09-23
- [Pagelive: artifacts not working](https://pagelive.io/claude-artifacts/not-working) — 2025–26
- HN: [44379673](https://news.ycombinator.com/item?id=44379673) (2025-06-25), [47352751](https://news.ycombinator.com/item?id=47352751) (2026-03-12), [47806725](https://news.ycombinator.com/item?id=47806725) (2026-04-17), [48128003](https://news.ycombinator.com/item?id=48128003) (2026-05-13), [49729412](https://news.ycombinator.com/item?id=49729412) and [49730108](https://news.ycombinator.com/item?id=49730108) (2026-09-16)

### 9.3 Figma: primary

- Local: `~/.claude/plugins/synced/c2187ff8-a276-4a64-b1e7-cf254a58703a_4beff4b7-d72c-4a9a-a79e-91158ce46804/figma/skills/` — `figma-use/references/plugin-api-standalone.d.ts` (snapshot ~2026-09-03 to 09-16), `figma-use-motion`, `figma-implement-motion`, `figma-shaders`, `figma-use-slides`, `figma-generative-plugins`, `figma-create-new-file`, `figma-code-connect`, plus the connected Figma MCP server's tool list and `create_new_file` schema — read 2026-09-23

**Blog:**
- [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) — 2019-10-16
- [Dev Mode GA](https://www.figma.com/blog/dev-mode-ga/) — 2024-01-25
- [Behind our redesign: UI3](https://www.figma.com/blog/behind-our-redesign-ui3/) — 2024-06-26
- [Config 2024 recap](https://www.figma.com/blog/config-2024-recap/) — 2024-06-26
- [Introducing Figma Slides](https://www.figma.com/blog/introducing-figma-slides/) — 2024-06-26
- [Our approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/) — 2024-10-01
- [Making the move to UI3](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/) — 2025-03-25
- Config 2025 (2025-05-07): [recap](https://www.figma.com/blog/config-2025-recap/), [Make](https://www.figma.com/blog/introducing-figma-make/), [Sites](https://www.figma.com/blog/introducing-figma-sites/), [Buzz](https://www.figma.com/blog/introducing-figma-buzz/), [Draw](https://www.figma.com/blog/introducing-figma-draw/)
- [Introducing the MCP server](https://www.figma.com/blog/introducing-figma-mcp-server/) — 2025-06-04
- [Code layers in Sites](https://www.figma.com/blog/introducing-code-layers/) — 2025-06-17
- [Rendering powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) — 2025-09-18
- [Schema 2025 recap](https://www.figma.com/blog/schema-2025-design-systems-recap/) — 2025-10-28
- [Agents, meet the Figma canvas](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/) — 2026-03-24
- [The Figma agent is here](https://www.figma.com/blog/the-figma-agent-is-here/) — 2026-05-20
- [Make on local code](https://www.figma.com/blog/figma-make-now-on-your-local-code/) — 2026-05-28
- Config 2026 (2026-06-24): [recap](https://www.figma.com/blog/config-2026-recap/), [Introducing Figma Motion](https://www.figma.com/blog/introducing-figma-motion/), [Code on the canvas](https://www.figma.com/blog/code-on-the-figma-canvas/), [Agent tools, context, skills](https://www.figma.com/blog/agent-custom-tools-context-skills/), [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/)
- [Properties panel and annotations in Make](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/) — 2026-07-30
- [Code, craft, and nested folders](https://www.figma.com/blog/code-craft-and-the-making-of-nested-folders/) — 2026-08-03
- [How we built generative plugins and shaders](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) — 2026-09-01

**Release notes and developer documentation:**
- [Release notes](https://www.figma.com/release-notes/) — entries 2026-03 to 2026-09-17; [Check designs](https://www.figma.com/release-notes/?title=check-designs-catch-whats-off-ship-whats-right) 2026-06-04
- [Plugin API updates](https://developers.figma.com/docs/plugins/updates/) — 2025-10 to 2026-09-17
- [Slots GA](https://developers.figma.com/docs/plugins/updates/2026/06/10/update/) — 2026-06-10
- [MCP tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) — accessed 2026-09-23
- [figma.com/motion](https://www.figma.com/motion/) — accessed 2026-09-23
- [Glass out of beta (staff forum post)](https://forum.figma.com/product-updates-3/glass-is-officially-out-of-beta-50185) — 2026-01-27

**Help centre** (undated, accessed 2026-09-23):
- Editor: [navigation bar](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar), [toolbar](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar), [right sidebar](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar), [keyboard](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard), [actions menu](https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design)
- Layout and components: [auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout), [grid](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow), [component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties), [slots](https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma), [variables](https://help.figma.com/hc/en-us/articles/15145852043927-Create-and-manage-variables-and-collections), [extended collections](https://help.figma.com/hc/en-us/articles/36346281624471-Extend-a-variable-collection), [publish a library](https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library), [memory](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)
- Dev Mode: [guide](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode), [statuses](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications), [compare changes](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode)
- Prototyping: [guide](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma), [triggers](https://help.figma.com/hc/en-us/articles/360040035834-Prototype-triggers), [actions](https://help.figma.com/hc/en-us/articles/360040035874-Prototype-actions), [animations](https://help.figma.com/hc/en-us/articles/360040522373-Prototype-animations), [smart animate](https://help.figma.com/hc/en-us/articles/360039818874-Smart-animate-layers-between-frames), [easing and springs](https://help.figma.com/hc/en-us/articles/360051748654-Prototype-easing-and-spring-animations), [multiple actions](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals), [play](https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototype)
- Motion: [timeline](https://help.figma.com/hc/en-us/articles/41405906446999-Use-the-Figma-Motion-timeline), [keyframes](https://help.figma.com/hc/en-us/articles/41307938657559), [presets](https://help.figma.com/hc/en-us/articles/41307886266135), [easing](https://help.figma.com/hc/en-us/articles/41414048690839), [animated components](https://help.figma.com/hc/en-us/articles/41307940738967), [anchor point](https://help.figma.com/hc/en-us/articles/41352588622615-Move-a-layer-s-anchor-point), [motion path](https://help.figma.com/hc/en-us/articles/41780233501591-Edit-an-object-s-motion-path), [agent motion](https://help.figma.com/hc/en-us/articles/41159708615319), [handoff](https://help.figma.com/hc/en-us/articles/41296356954263-Hand-off-animations-to-development), [export](https://help.figma.com/hc/en-us/articles/41307983648407), [explore](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion)
- Config 2026 and AI: [What's new from Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026), [shaders quick start](https://help.figma.com/hc/en-us/articles/41147702210071-Quick-start-guide-to-generative-plugins-and-shaders), [agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files), [chat visibility](https://help.figma.com/hc/en-us/articles/41272399602583), [First Draft](https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI), [AI credits](https://help.figma.com/hc/en-us/articles/35865276858647-Manage-AI-credits)
- Other products: [Make](https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make), [edit a Make file](https://help.figma.com/hc/en-us/articles/42009840449175-Edit-a-Figma-Make-file), [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs), [Slides design mode](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides), [explore Slides](https://help.figma.com/hc/en-us/articles/24170630629911-Explore-Figma-Slides), [slide transitions](https://help.figma.com/hc/en-us/articles/24244588378007-Use-slide-transitions), [Slides libraries](https://help.figma.com/hc/en-us/articles/24292359259543-Access-Figma-Design-and-FigJam-assets-in-Figma-Slides), [Buzz](https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz), [Buzz approvals](https://help.figma.com/hc/en-us/articles/39288847137815-Use-approvals-in-Figma-Buzz)
- Files and sharing: [file management update](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management) (effective 2026-08-03), [files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders), [file browser](https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser), [create a file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file), [drafts](https://help.figma.com/hc/en-us/articles/18409526530967-Updates-to-how-drafts-work), [search](https://help.figma.com/hc/en-us/articles/4422774037271-Search-for-files-folders-and-people), [pins](https://help.figma.com/hc/en-us/articles/360038511713-Pin-files-to-a-folder), [thumbnails](https://help.figma.com/hc/en-us/articles/360038511413-Set-custom-thumbnails-for-files), [share](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes), [sharing and permissions](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions), [request to edit](https://help.figma.com/hc/en-us/articles/4408435431319-Request-to-edit-a-file), [publish Make](https://help.figma.com/hc/en-us/articles/31304586129559-Publish-update-or-unpublish-a-Figma-Make-file)
- Comments and collaboration: [add comments](https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files), [manage comments](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments), [comment email](https://help.figma.com/hc/en-us/articles/360041547813-Manage-email-notifications-for-comments-on-files), [Make comments](https://help.figma.com/hc/en-us/articles/38701587731735-Add-comments-in-Figma-Make), [spotlight](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight), [cursor chat](https://help.figma.com/hc/en-us/articles/1500004414842-Send-messages-with-cursor-chat), [audio](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team), [viewer history](https://help.figma.com/hc/en-us/articles/29638316371479-See-viewer-history-for-your-files), [branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching), [version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
- Mobile, offline and governance: [mobile app](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app), [offline](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma), [public links](https://help.figma.com/hc/en-us/articles/5726756336791-Manage-public-link-sharing-and-open-sessions), [activity logs](https://help.figma.com/hc/en-us/articles/360040449533-View-and-export-activity-logs), [Governance+](https://help.figma.com/hc/en-us/articles/31825370509591-Governance-for-Figma)

### 9.4 Figma: community and secondary

- Forum threads:
  - [UI3 toolbar](https://forum.figma.com/suggest-a-feature-11/allow-us-to-dock-move-the-new-ui3-toolbar-7861/index8.html) (2024-10)
  - [right panel auto-open](https://forum.figma.com/t/allow-manual-open-close-of-right-panel/87945) (2024-09-25)
  - [forcing UI3](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) (2025-03/04)
  - [new left panel](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) (2026-01-07)
  - [variables UI rollout](https://forum.figma.com/ask-the-community-7/how-to-use-new-variables-ui-52729) (2026-04)
  - [Motion and prototyping](https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428) (2026-06-29, staff)
  - [Motion questions](https://forum.figma.com/ask-the-community-7/questions-about-figma-motion-motion-paths-prototyping-and-variants-55468) (2026-07-02, staff)
  - [Motion usability](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314) (2026-06-26 to 08-27)
  - [Motion glitch](https://forum.figma.com/report-a-problem-6/figma-motion-feedback-glitch-55346) (2026-06-26, fixed 09-16)
  - [Figma folders](https://forum.figma.com/share-your-feedback-26/figma-folders-57057) (2026-08-18/19)
  - [projects become folders](https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675) (2026-08-03)
  - [nested comments](https://forum.figma.com/suggest-a-feature-11/keep-comments-pinned-to-design-elements-including-nested-17753)
  - [editor seat vs permission](https://forum.figma.com/ask-the-community-7/i-have-an-editor-access-but-is-on-view-only-mode-when-i-opened-the-file-28534)
  - [Buzz feedback](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307) (2025-05+)
  - [AI credit price](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944) (2026-01-21)
  - [on-scroll trigger request](https://forum.figma.com/suggest-a-feature-11/on-scroll-for-prototyping-21247)
  - [missing files](https://forum.figma.com/report-a-problem-6/i-cant-find-my-files-40147)
- [Adrian Roselli: do not publish with Figma Sites](https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html) — 2025-05-07, updated 2026-06-10
- [albertsikkema: reverse-engineering Make files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) — 2026-01-23
- [mantlr: Figma agent guide](https://mantlr.com/blog/figma-ai-agent-guide-2026) — 2026-05
- [Rive Masterclass: Figma Motion vs Rive](https://www.rivemasterclass.com/blog/figma-motion-vs-rive) — 2026-06-25
- [TechTimes: Config 2026](https://www.techtimes.com/articles/319041/20260625/figma-config-2026-code-layers-challenge-cursor-gpu-shaders-hit-paid-plans.htm) — 2026-06-25
- [Motion the Agency: Figma Motion vs After Effects](https://www.motiontheagency.com/blog/figma-motion-vs-after-effects) — 2026-07-14
- [Figma on the App Store](https://apps.apple.com/us/app/figma/id1152747299) — v26.36.0, accessed 2026-09-23

### 9.5 Other references

**Primary:**
- [Lovable project comments](https://docs.lovable.dev/features/project-comments) (2026-04-02); [design toolbar](https://docs.lovable.dev/features/design) (2026-06-10); [changelog](https://docs.lovable.dev/changelog) (2025-11 to 2026-09)
- [Cursor browser visual editor](https://cursor.com/blog/browser-visual-editor) (2025-12-11); [Design Mode blog](https://cursor.com/blog/design-mode) (2026-06-05); [docs](https://cursor.com/docs/agent/design-mode); [changelog](https://cursor.com/changelog/page/4) (3.0 on 2026-04-02; 3.7 on 2026-06-04)
- Google: [Stitch redesign](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/) (2026-03-18); [DESIGN.md](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) (2026-04-21); [Stitch real time](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-updates/) (2026-05-19); [Gemini Canvas](https://support.google.com/gemini/answer/16047321?hl=en&co=GENIE.Platform%3DDesktop); [NotebookLM Studio](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/) (2025-07-29); [NotebookLM slides](https://workspaceupdates.googleblog.com/2026/03/new-ways-to-customize-and-interact-with-your-content-in-NotebookLM.html) (2026-03-20)
- OpenAI: [Apps SDK UI guidelines](https://developers.openai.com/apps-sdk/concepts/ui-guidelines); [ChatGPT Sites](https://learn.chatgpt.com/docs/sites) (2026-07-09); [release-notes mirror](https://releases.sh/openai/chatgpt-release-notes.md) (2026-09 entries); [Library help](https://help.openai.com/en/articles/20001052-file-storage-and-library-in-chatgpt) (403; search snippet only)
- [Notion release 2026-08-28](https://www.notion.com/releases/2026-08-28)
- Framer: [Framer 3.0](https://www.framer.com/blog/framer-3/) (2026-06-16); [agents](https://www.framer.com/agents/)
- [v0: introducing the new v0](https://vercel.com/blog/introducing-the-new-v0) (2026-02-03); [v0 Design Mode outage](https://community.vercel.com/t/v0-design-mode-not-working-after-recent-update/34221) (2026-02-21 to 03-15)
- Paper: [build log](https://paper.design/build-log) (May–Aug 2026); Paper MCP server instructions (local, `paper-desktop` 0.2.1, 2026-09-23)
- [Subframe](https://www.subframe.com/)
- [Rive state machines](https://rive.app/docs/editor/state-machine/state-machine)
- [Apple Icon Composer](https://developer.apple.com/icon-composer/)

**Secondary:**
- [VentureBeat: Canva Code 2.0](https://venturebeat.com/technology/canva-launches-code-2-0-offering-ai-website-building-to-every-user-including-free-accounts) (2026-07-14)
- [CMSWire: Canva AI 2.0](https://www.cmswire.com/digital-experience/canva-ai-20-adds-agentic-design-tools/) (2026-04-16)
- [ai-toolbox: ChatGPT Canvas](https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-use-chatgpt-canvas-guide-2026) (2026-05-30, updated 09-16)
- [theaicareerlab](https://theaicareerlab.com/blog/chatgpt-what-changed-june-2026) (2026-06-24)

### 9.6 Juno (internal)

- `docs/design/artifacts-design/00-AUDIT-OVERVIEW.md`, `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md` — 2026-09-23, HEAD `d0997af2`
- `docs/design/ICONS_AND_MOTION.md` §2
- `docs/design/FLAT_UI.md` §2
- `docs/design/PREMIUM_AUDIT.md` §2d, §3
- `src/lib/motion.ts`
- `src/app/globals.css:314-349`
- `src/lib/design/types.ts`

