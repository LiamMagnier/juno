# Figma AI and the product family: how Figma adds "made thing" types without fragmenting

Lens: Figma Make, Sites, Slides, Draw, Buzz, Weave, First Draft / AI in Design, the Figma agent, the MCP server, generative plugins, shaders, Motion, code layers, Code Connect, Config 2025 and Config 2026. The main question: how Figma puts many file types behind one file browser and one navigation, and how it moves content between types. Juno's Artifacts + Juno Design merge needs the same pattern.

Researched 2026-09-23. Each claim carries a source, a date and a confidence tag:
- **[P]** primary: a vendor source (figma.com blog, help.figma.com, developers.figma.com, release notes) or the Figma plugin skills and Plugin API typings installed on this machine.
- **[S]** secondary: press, reviews or aggregators.
- **[C]** community: forum, Hacker News or Mastodon.
- **[I]** inferred: my own reading of the evidence.

Local primary evidence (the installed Figma plugin skills, synced 2026) lives at:
`~/.claude/plugins/synced/c2187ff8-…/figma/skills/`, specifically `figma-use/references/plugin-api-standalone.d.ts` (10,191 lines), `figma-use-slides/`, `figma-use-motion/`, `figma-shaders/`, `figma-generative-plugins/`, `figma-create-new-file/`, `figma-code-connect/` and `figma-implement-motion/`. It is cited below as **[P-local]**.

The Claude side is not re-derived here. See `docs/design/artifacts-design/research/claude-primary-evidence.md`, which is authoritative for Claude's typed artifacts.

---

## 0. TL;DR: the pattern in one paragraph

Figma's product family grew in two phases.

**Phase 1 (2024–2025).** Figma shipped new *file types*: Slides (Config 2024), then Make, Sites and Buzz (Config 2025). Draw shipped as a *mode*, not a file type. Four things held the types together:
1. **One file browser.** A single "+ Create" dropdown and per-type icons, URL namespaces (`/design`, `/board`, `/slides` or `/deck`, `/site`, `/buzz`, `/make`) and `.new` shortcuts.
2. **One chrome (UI3).** A bottom floating toolbar and collapsible left and right panels.
3. **One asset substrate.** Published libraries of components, variables and styles that every type consumes.
4. **Copy-paste as the universal transport.** Frames move from Design into Slides, Buzz, Sites and Make.

**Phase 2 (2026).** Figma pulled new capabilities *back into the Design canvas as "materials"*, not new file types: code layers, Motion, shader fills and effects, generative plugins and Weave tools. One **Figma agent** became the cross-product layer. It launched in Design on 20 May 2026 and is announced for FigJam and Slides. It replaces the older First Draft entry point.

The Config 2026 recap puts it as "Code is material, just like images, vectors and design layers", and says the canvas is "where everything connects" [P] [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/) (2026-06-24). Fragmentation still shows at the edges:
- Weave lives outside the file browser. Standalone Weave, and Weave tools run through MCP, use Weave credits and need a paid Weave account. Weave tools used *inside* Figma Design draw on Figma AI credits.
- Make's Design↔Make round-trip is one-way.
- Three animation systems overlap: prototype smart-animate, Slides animations and Figma Motion.
- The new Make UI applies only to new files.
- Plugin and MCP support differs by editor type.

**Lesson for Juno [I]:**
- Keep separate *types* only where the **consumption context** differs: present (Slides), publish a site (Sites), produce assets in bulk (Buzz), run an app (Make).
- Ship new *materials* as layer or node types inside one canvas. Code, motion and generated media belong here.
- Prefer *modes* over new files: Draw, Dev Mode, Slides "design mode" and Motion mode are all modes.
- Put one agent everywhere.

---

## 1. Timeline (launches relevant to this lens)

| Date | Launch | Confidence / source |
|---|---|---|
| 2024-06-26 | **UI3** redesign: bottom floating toolbar, collapsible panels, Actions menu; described as a "cohesive family of tools" across Design, FigJam, Dev Mode and Slides | [P] [Behind the redesign: UI3](https://www.figma.com/blog/behind-our-redesign-ui3/) |
| 2024-06-26 | **Figma Slides** open beta: design-mode toggle, grid view, embedded prototypes, polls/alignment scale, AI text tone | [P] [Introducing Figma Slides](https://www.figma.com/blog/introducing-figma-slides/) |
| 2024 (June→Sept) | "Make Designs" AI generator pulled after it produced Apple Weather look-alikes; relaunched as **First Draft** | [S] [AlternativeTo, Sep 2024](https://alternativeto.net/news/2024/9/figma-relaunches-ai-powered-first-draft-app-generator-after-initial-backlash-over-fraud) |
| 2025-03-19 | **Slides GA**: .pptx import/export, object animations, components, slide numbers, video improvements; available to Full, Dev and Collab seats | [P] [Figma blog](https://www.figma.com/blog/how-teams-tap-into-the-power-of-design-with-figma-slides/) |
| 2025-05-07 | **Config 2025**: **Make** (prompt-to-app, launched on Claude 3.7 Sonnet), **Sites** (design→publish), **Buzz** (brand assets at scale), **Draw** (mode in Design), **Grid** (CSS-grid auto layout) | [P] [Config 2025 recap](https://www.figma.com/blog/config-2025-recap/), [press release](https://www.figma.com/blog/config-2025-press-release/), [Make](https://www.figma.com/blog/introducing-figma-make/), [Sites](https://www.figma.com/blog/introducing-figma-sites/), [Buzz](https://www.figma.com/blog/introducing-figma-buzz/), [Draw](https://www.figma.com/blog/introducing-figma-draw/) |
| 2025-05-07 | Sites accessibility criticism: output was all `<div>`s. Figma shipped semantic fixes on 2025-05-21 (Roselli's post is dated 2025-05-07 and was last updated 2026-06-10) | [C] [Adrian Roselli](https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html); [C] [Mastodon @joelanman](https://hachyderm.io/@joelanman/114468661897615798) |
| 2025-06-04 | **Dev Mode MCP server** (beta, local): code, image and variables tools plus Code Connect | [P] [Introducing the MCP server](https://www.figma.com/blog/introducing-figma-mcp-server/) |
| 2025-06-17 | **Code layers in Sites**: React-backed layers with a Make-powered chat; Figma also acquired **Payload** (open-source CMS) for Sites and Make | [P] [Code layers](https://www.figma.com/blog/introducing-code-layers/), [Payload](https://www.figma.com/blog/payload-joins-figma/) |
| 2025-10-30 | Figma acquires **Weavy** and renames it **Figma Weave** (node-based AI media) | [P] [Figma blog](https://www.figma.com/blog/welcome-weavy-to-figma/) |
| 2025-11 (exact day unverified) | **Sites CMS** public beta: collections, CMS pages, lists (the feature list is from search summaries and is unverified) | [C] [Forum](https://forum.figma.com/suggest-a-feature-11/launched-figma-sites-cms-41906); [S] [search summaries] |
| 2026-01-21 | Community complaint that a pay-as-you-go AI credit costs about 5.6× a seat-bundled one ($0.03 vs about $0.005) | [C] [Forum](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944) |
| 2026-01-23 | Hacker News "Show HN" (55 points, 24 comments per the HN Algolia API): Make files reverse-engineered because the REST API rejects them | [C] [albertsikkema.com](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) |
| 2026-03-24 | **MCP write-to-canvas** (`use_figma`) plus **skills**; works in Claude Code, Codex, Cursor and others | [P] [Agents, meet the Figma canvas](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/) |
| 2026-04-09 | **Figma Weave** launches (node canvas, 20+ models from 12 providers, App Mode) as a standalone product. The "launch" date, model count and App Mode come only from the secondary source. Figma's 2026-04-09 blog shows Weave as a standalone product at weave.figma.com with "20+ templates" and deeper integration "later this year", but does not call it a launch | [S] [creativeainews](https://www.creativeainews.com/articles/figma-weave-node-graph-ai-design-analysis/); [P] [Five Weave workflows](https://www.figma.com/blog/five-figma-weave-workflows/) |
| 2026-05-20 | **Figma agent** in Design, beta. Replaces **First Draft** as the "new entry point" | [P] [Figma agent blog](https://www.figma.com/blog/the-figma-agent-is-here/), [Help](https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI); [S] [TechCrunch](https://techcrunch.com/2026/05/20/figma-adds-an-ai-assistant-to-its-collaborative-canvas/) |
| 2026-05-28 | **Make on local code** (limited beta, Mac only, in the Figma Beta desktop app; no credits charged during beta): branches, local commits, PRs | [P] [Figma blog](https://www.figma.com/blog/figma-make-now-on-your-local-code/), [Help](https://help.figma.com/hc/en-us/articles/40775535020695-Make-in-your-local-codebase) |
| 2026-06-23 | Agent chats in Design become **visible by default** to Full-seat editors | [P] [Help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) |
| 2026-06-24 | **Config 2026**: **code layers in Design** (closed beta, waitlist, rolling out from July), plus **Figma Motion**, **shader fills/effects**, **generative plugins** and **Weave tools in Design**, all open beta per the help article. Also agent skills, connectors and attachments. The agent is coming to **FigJam and Slides** (waitlist). **3D transforms** are "coming soon" (waitlist); the help article and Motion blog say so, but the recap does not mention them. Interactive shaders were "coming soon" and shipped 2026-09-01 | [P] [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/), [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026), [Code on the canvas](https://www.figma.com/blog/code-on-the-figma-canvas/), [Motion](https://www.figma.com/blog/introducing-figma-motion/), [Weave](https://www.figma.com/blog/connecting-figma-and-weave/) |
| 2026-07-30 | Make gets a **properties panel** (with DOM tree) and **"Annotate for agent"**, in new Make files only | [P] [Figma blog](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/) |
| 2026-08-03 | **Projects become folders**: nesting up to 10 levels, colours, simpler permissions | [P] [Help](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management); [C] [Forum](https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675) |
| 2026-08-13 | Skill authoring inside the agent; community skills library (50+). Releasebot quotes a Figma release note titled "Try skills from the Community and make your own with the Figma agent". That entry did not appear in my fetch of figma.com/release-notes, so it is not confirmed against the primary source | [S] [Releasebot aggregate](https://releasebot.io/updates/figma) |
| 2026-08-24 | Vector editing gets an eraser and drag-to-fill (paint bucket). Shift+E switches to the eraser in vector edit mode or Draw mode. Enterprise-managed MCP auth reaches GA for Organization and Enterprise admins; "Okta and others" is unverified | [P] [Release notes](https://www.figma.com/release-notes/?title=erase-and-drag-to-fill-for-vector-editing) |
| 2026-08-26 | Agent chat panel can pop out to its own window (Mac and Windows desktop) | [P] [Release notes](https://www.figma.com/release-notes/) |
| 2026-09-01 | **Shaders** gain animation and mouse interaction. **Both** generative plugins and shaders gain Community and org publishing and MCP edit support. A code viewer shows any shader's code and the code of your own generative plugins. Animation and interaction are described for shaders only, not plugins | [P] [Release notes](https://www.figma.com/release-notes/?title=updates-to-generative-plugins-and-shaders) |
| 2026-09-16 | Folders show previews of their files again, with more distinct colours and duplication; Weave tools can be published to Community | [P] [Release notes](https://www.figma.com/release-notes/) |
| 2026-09-17 | **Figma node in Weave**: copy a Design frame and paste it into Weave, where it becomes a workflow node. You pick which text and image layers become inputs, and a "Sync" keeps connected assets up to date | [P] [Release notes](https://www.figma.com/release-notes/?title=create-on-brand-content-with-your-figma-designs-in-weave-workflows) |

---

## 2. One file browser, one navigation (the IA Juno needs to copy or avoid)

### 2.1 Creation and file types
- **"+ Create" dropdown in the top-right** of the file browser, in Drafts and in any team folder. It lists Design, FigJam, Slides, Sites, Make and Buzz. Each file is created "with their own set of tools and features". [P] [Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file); [P] [Import files](https://help.figma.com/hc/en-us/articles/360041003114-Import-files-to-the-file-browser) lists the extensions `.jam`, `.deck`, `.buzz`, `.site` and `.make`.
- **Per-type URL namespaces** [P] [Guide to files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders):

  | Type | URL namespace |
  |---|---|
  | Design | `/design` |
  | FigJam | `/board` |
  | Slides | `/slides`, plus `/deck` for presentation view |
  | Sites | `/site` |
  | Buzz | `/buzz` |
  | Make | `/make` |

  The MCP skills confirm `figma.com/slides/...` vs `figma.com/design/...` vs `figma.com/board/...` [P-local `figma-use-slides/SKILL.md`, `figma-use-figjam/SKILL.md`].
- **Per-type `.new` shortcuts**:

  | Type | Shortcut |
  |---|---|
  | Design | `figma.new` |
  | FigJam | `figjam.new` |
  | Slides | `flides.new` |
  | Buzz | `buzz.new` |
  | Sites | `figma.com/site/new` |

  [P] [Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file)
- **The type is shown by a file icon.** The sidebar and file grid use distinct icons for Design files, libraries and branches, FigJam files and templates, Slides files and templates, Buzz files and templates, and Sites, Make and Prototypes. [P] [Guide to the file browser](https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser)
- **Sidebar order** on Starter and Professional plans: Account, Search, Recents, Community, Notifications, Team, Drafts, Browse ("All folders"), Trash, Admin, Starred. Organization and Enterprise plans replace Team with Organization and add "Custom sidebar". [P] same source
- **Exceptions to "one browser"**:
  - **Weave** "lives outside the Figma file browser". You sign in to Weave separately to create or duplicate a Weave file. [P] [Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file)
  - **Credits are split by surface.** The MCP doc says running a Weave tool *through MCP* "uses your Weave credits, not your Figma AI credits" and needs "a paid standalone Figma Weave account" [P] [MCP tools doc](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/). But **Weave tools inside Figma Design are billed in Figma AI credits**: they appear on the AI-credit list [P] [Manage AI credits](https://help.figma.com/hc/en-us/articles/35865276858647-Manage-AI-credits), and the 2026-06-24 blog says they are free in open beta and will use Figma AI credits at GA [P] [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/). The standalone Weave app has its own credit plans. [S] [creativeainews](https://www.creativeainews.com/articles/figma-weave-node-graph-ai-design-analysis/)
  - Weave runs at weave.figma.com. [S] [creativeainews](https://www.creativeainews.com/articles/figma-weave-node-graph-ai-design-analysis/)
  - **Draw** is *not* a file type. It is "a set of visual design tools within the Figma Design editor". [P] [Explore Figma Draw](https://help.figma.com/hc/en-us/articles/31440394517143-Explore-Figma-Draw)
- **Plan limits are set per product**, which reinforces "product = file type". Starter allows "3 total Figma Design and Figma Sites files in a folder" and "3 files in a folder for each other Figma product". [P] [Guide to files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders)

### 2.2 Folders (2026 restructure)
- Starting 2026-08-03, **projects were renamed to folders**. The change shows in menus, the share modal and the file browser.
  - Paid plans can nest folders up to 10 levels deep, and folders have custom colours.
  - Permissions collapse to two states: **Inherited** ("Anyone in [Parent] can access") and **Limited** ("Only people added…"). The "View only" setting was removed.
  - [P] [Updates to Figma's file management](https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management)
- **Complaint cycle**: the new folder view replaced project cards that showed file thumbnails with small folder icons. Forum users said they needed "preview cards with files inside". They also reported that folder colours were too weak and that sort order didn't persist (37 replies, about 2.8k views). [C] [Forum](https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675)
  - Figma responded on **2026-09-16**: folders now "preview what files are inside", colours are more distinct, and folders can be duplicated. [P] [Release notes](https://www.figma.com/release-notes/)
  - **Juno lesson [I]:** in a mixed-type library, **thumbnails matter more than type icons**. Users recognise work by its picture.

### 2.3 Shared chrome
- **UI3 (2024)** set the shared frame: a slim **bottom floating toolbar**, left and right panels that collapse or hide, a UI that "disappears when not needed", and an **Actions** menu for quick access (component search, AI). It is meant as a family of tools across FigJam, Design, Dev Mode and Slides, with "consistent patterns like the slim toolbar and floating collapsible panels". The exact phrase "cohesive family of tools" is unverified. [P] [UI3](https://www.figma.com/blog/behind-our-redesign-ui3/) (2024-06-26)
- **Modes toggle in the toolbar, not in the file browser:**
  - Design ↔ **Draw** toggle in the toolbar. [P] [Explore Figma Draw](https://help.figma.com/hc/en-us/articles/31440394517143-Explore-Figma-Draw)
  - Dev Mode toggle (plugin `editorType` includes `'dev'`). [P-local d.ts line 16]
  - **Motion mode**: help calls it a "Toolbar toggle to Motion mode" [P] [What's new Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026), and the blog says you "switch any frame to Motion mode". [P] [Motion blog](https://www.figma.com/blog/introducing-figma-motion/)
  - Slides **design mode** toggle (Shift D). [P] [Design mode in Slides](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides)
- **Juno lesson [I]:** Figma now tends to add a *mode* to an existing editor rather than a new file type whenever the underlying document is the same scene graph. Draw, Dev and Motion all follow this. New file types are reserved for a different *document root*: a slide grid (Slides), an asset grid (Buzz), site pages and breakpoints with CMS (Sites), a code project (Make), or a node graph (Weave).

### 2.4 Shared substrate (why the types don't fragment the data)
- **One Plugin API across editor types**: `figma.editorType: 'figma' | 'figjam' | 'dev' | 'slides' | 'buzz'`. [P-local d.ts line 16]
  - **Slides and Buzz share the same "canvas grid" API**: `getCanvasGrid()`, `setCanvasGrid()` and `createCanvasRow()` are "only available in Figma Slides and Figma Buzz". The grid holds "slide or asset" nodes. [P-local d.ts ~1024–1075]
  - Buzz adds `BuzzTextField` and `BuzzMediaField` (template fields; media accepts `ImagePaint | VideoPaint`). [P-local d.ts ~1245–1290]
  - **Sites and Make are *not* plugin editor types.** The `editorType` union leaves them out, and the typings never mention "sites" or "make". [P-local] The conclusion that plugins can't run there is **[I]**, drawn from the typings, and was not checked against help docs.
- **Make files use the same .fig document engine.** A `.make` file is a ZIP containing `canvas.fig` (Figma's Kiwi binary scene format, with a `fig-makee` header). It holds a node tree whose `CODE_FILE` nodes contain full React/TSX source, plus `ai_chat.json` with the whole prompt history. [C] [albertsikkema.com, 2026-01-23](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
  - **[I]** So the Make "file type" is the same multiplayer document substrate with different node types and a different editor. The type boundary is in the editor and product, not in storage.
- **Libraries are the cross-type glue.** Published libraries (components, variables, styles) are consumed by:
  - Slides, via Assets → Add your own → Add to file. Instances stay live and update notifications flow. [P] [Slides libraries](https://help.figma.com/hc/en-us/articles/24292359259543-Access-Figma-Design-and-FigJam-assets-in-Figma-Slides)
  - Sites, via the inserts panel. [P] [Sites blog](https://www.figma.com/blog/introducing-figma-sites/)
  - Buzz, via brand library components. [P] [Buzz blog](https://www.figma.com/blog/introducing-figma-buzz/)
  - Make, via **Make kits** that "sync your npm packages, library styles, and guidelines". [P] [Make page](https://www.figma.com/make/)
  - Limit: Slides can't *create* variable modes. They must be made in Design and published. [P] [Design mode in Slides](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides)

### 2.5 Moving content between types (conversion matrix)

| From → To | Mechanism | Link kept? | Source |
|---|---|---|---|
| Design → Slides | Copy-paste frames or components. Interactive components keep hover states when presenting. Library instances stay live | Library instances: yes. Pasted frames: copy | [P] [Slides launch](https://www.figma.com/blog/introducing-figma-slides/), [Slides libraries](https://help.figma.com/hc/en-us/articles/24292359259543-Access-Figma-Design-and-FigJam-assets-in-Figma-Slides) |
| FigJam → Slides | Convert a board to a slide outline | Copy | [P] [Slides page](https://www.figma.com/slides/) |
| Design → Buzz | Brand designer builds a template in Design and copy-pastes it into Buzz, then locks fields | Copy. Users complain that component updates don't sync to Buzz | [P] [Buzz blog](https://www.figma.com/blog/introducing-figma-buzz/); [C] [Buzz forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307) |
| Design → Sites | Copy-paste a Design file's frames ("Start with a Figma Design file"); libraries via the inserts panel | Copy (libraries live) | [P] [Sites page](https://www.figma.com/sites/) |
| Design → Make | Paste frames or components into the Make chat, or + → Add context with a URL | Context only | [P] [Explore Make](https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make) |
| Make → Design | "Copy the preview as design layers" and paste into Design | **One-way** ("changes don't sync back") | [P] [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs) |
| Make (local code) → Design → code | Copy screens, pages and components into Design as layers; "Figma detects those changes and prompts you to bring them back into Make, applying them in code" | Semi-round-trip (prompted, not automatic) | [P] [Make local code](https://www.figma.com/blog/figma-make-now-on-your-local-code/) |
| Design layer → code layer (Sites, 2025) | Select a layer and choose "Make code from design" in the right sidebar (or the Make icon in the properties panel); **E** draws a blank code layer; **double-click** a code layer to re-enter "Make view" | Layer holds code | [P] [Code layers blog](https://www.figma.com/blog/introducing-code-layers/), [Sites AI help](https://help.figma.com/hc/en-us/articles/35895907782807-Figma-Sites-collection-Create-code-layers-in-Figma-Sites-with-AI) |
| Frame ↔ code layer (Design, 2026) | Add from the toolbar, create one from an existing frame, or ask the agent. **"Extract designs"** turns the current code state into editable layers (one screen, one state, or a full flow); "one click updates the code layer" with your design edits | **Two-way sync** (closed beta) | [P] [Code on the canvas](https://www.figma.com/blog/code-on-the-figma-canvas/), [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/) |
| GitHub or local repo → canvas | Import a repo or upload a folder as code layers (Design); Make local runs a repo | Live | [P] same |
| Design → Weave | **Figma node**: copy a frame from Design and paste it into Weave, and it becomes a node. Choose which text and image layers act as inputs. The 2026-06-24 blog promised edits "reflect in real time"; the 2026-09-17 release note describes a "Sync" that keeps connected assets up to date (shipped 2026-09-17) | **Linked** (live or manual sync not confirmed) | [P] [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/), [Release notes](https://www.figma.com/release-notes/) |
| Weave → Design | **Weave tools** in the Design **left panel**: 20+ parameterised image tasks such as style transfer, product shoot and material extraction. "Background swap" and "only image or vector outputs run on the canvas" come from a search summary (unverified) | Output only | [P] [Connecting Figma and Weave](https://www.figma.com/blog/connecting-figma-and-weave/); [S] [search summary of Weave help] |
| Live web UI → Design | MCP `generate_figma_design` sends live HTML to design layers (new file, existing file or clipboard) | Copy | [P] [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) |
| Design motion → code | Dev Mode read-only timeline, with code copied as CSS, JSON or React (motion.dev); MCP `get_motion_context` | Read-only | [P] [Motion blog](https://www.figma.com/blog/introducing-figma-motion/); [P-local figma-implement-motion] |

**[I] Pattern:**
- Figma's first-generation bridges were **clipboard copies**: Design→Slides, Sites, Buzz and Make, and Make→Design. They lose the link, and users complain about exactly that (Buzz sync, Make one-way).
- The 2026 bridges are **live links or in-canvas layers**: code layers with extract and sync, the Figma node in Weave, and motion carried by components. That is the direction Juno should start from.

---

## 3. Product-by-product notes

### 3.1 Figma Design (+ Draw mode, Dev Mode, Motion mode, Actions menu, AI tools)
- **Actions menu** (toolbar; also quick actions and right-click) holds Figma AI [P] [Use AI tools](https://help.figma.com/hc/en-us/articles/23870272542231-Use-AI-tools-in-Figma-Design):
  - Find assets and designs: visual search from part of a design, a screenshot or a description
  - Replace content
  - Add interactions (auto-prototype)
  - Rename layers
  - Rewrite, Translate, Shorten
  - Make images, Remove background, Boost resolution, Expand images, Isolate or erase objects, Vectorize
  - First Draft, now being superseded by the agent
- **First Draft** flow [P] [First Draft help](https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI):
  1. Actions → First Draft
  2. Pick a library (website wireframe or mobile app design)
  3. Type a prompt
  4. A frame is generated with theme previews
  5. Refine with style controls (colour, type, spacing, radius) or more prompts

  "Beginning May 20, 2026, Figma's agent will be the new entry point for this functionality". Legacy First Draft stays on paid plans during the transition.
- **Draw mode** [P] [Explore Figma Draw](https://help.figma.com/hc/en-us/articles/31440394517143-Explore-Figma-Draw), [Draw blog 2025-05-07](https://www.figma.com/blog/introducing-figma-draw/):
  - Click **Draw** in the toolbar. The toolbar changes to Pen, Brush and Pencil.
  - The right sidebar becomes a "more streamlined view of illustration-related properties, with slider controls".
  - The Layers panel shows enlarged visual previews.
  - Some Design features are hidden, so you switch the toggle back to Design.
  - Available on any plan with edit access.
  - Brushes, custom brush styles from any vector, text on path, variable-width strokes, textures and noise.
  - Eraser and drag-to-fill added 2026-08-24. [P] [Release notes](https://www.figma.com/release-notes/)
- **Figma Motion** (Config 2026, open beta 2026-06-24) [P] [Motion blog](https://www.figma.com/blog/introducing-figma-motion/), [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026):
  - A timeline panel next to the canvas.
  - Drag layers to retime. Scrub to any moment.
  - Keyframe position, scale, rotation and opacity independently.
  - **Auto-keyframing** records changes while the playhead moves.
  - **Time-based comments** reference a specific moment.
  - **Presets**: fade, move, scale. Presets can be stacked to play at once or sequenced.
  - **Motion variables** hold easing and "modes". Switching the page-level mode updates every animation that references it.
  - The **agent generates keyframes** grounded in components and tokens.
  - **Animated components** carry motion across files like fills do.
  - **Dev Mode** shows a read-only timeline with every keyframe and curve, and copies it as CSS, JSON or React (motion.dev). The name "Motion tab" is unverified.
  - **Exports**: MP4, WebM, GIF, animated SVG.
  - MCP `get_motion_context` hands motion to coding agents.
  - **3D transforms** are "coming soon" (waitlist).
  - **Plans.** The blog says: "Starter users can access motion with limited exports. Full seat users on all plans can access motion primitives and export." Full design-system integration and the motion agent need a paid plan. The help article adds that publishing animated components, agent-generated animations and **high-resolution** video export need paid plans. Motion "is not available on Figma for Government plans". [P] [Motion blog](https://www.figma.com/blog/introducing-figma-motion/), [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026)
- **Shader fills and effects** (Config 2026, open beta) [P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026); [P-local `figma-shaders/SKILL.md`]:
  - Prompt the agent to build WebGPU shaders.
  - Two kinds: **effect** (samples the rendered layer beneath) and **fill** (procedural, no input raster).
  - Parameterised controls appear on the canvas.
  - Exports: PNG (a fixed frame), MP4, and code via MCP.
  - Shader effects "do not currently appear in Dev Mode". [P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026)
  - Since 2026-09-01: animated (`frame.time`, an absolute clock in milliseconds), mouse-reactive (`frame.mousePosition`), community and org publishing, and a code viewer. [P] [Release notes](https://www.figma.com/release-notes/?title=updates-to-generative-plugins-and-shaders)
  - Plugin API types: `ShaderEffect`, `ShaderPaint`, `GlassEffect`, `NoiseEffect`, `TextureEffect`, `VideoPaint`. [P-local d.ts]
- **Other 2025–26 Design materials in the API** [P-local d.ts]:
  - `SlotNode` (component slots)
  - `GridLayoutMixin` (CSS grid)
  - `TransformGroupNode`, `RepeatModifier` (linear or radial repeat)
  - `TextPathNode`, brush strokes
  - `MediaNode`, `EmbedNode`, `LinkUnfurlNode`

### 3.2 The Figma agent (Design, 2026-05-20 beta; Config 2026 upgrades)
- **Three ways in** [P] [Help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files):
  1. **An on-canvas prompt box.** Select a layer, then click "Agents" or press **Cmd/Ctrl+Enter**. The help article lists the shortcut as a separate way in, so four in total. The prompt input "appears inline". [S] [mantlr](https://mantlr.com/blog/figma-ai-agent-guide-2026)
  2. **"Agents" in the left sidebar**, a persistent chat list. "Ordered by recency with preview text" is unverified; I did not confirm it in the help article.
  3. **Dictate.**

  On-canvas prompting can be turned off in Preferences ("Show AI Chat on canvas").
- **Parallel prompts.** You can run several prompts without waiting. **Each active prompt shows an animated loading indicator on the canvas**. Clicking it opens that thread's chat window, which shows the steps completed and the result. [P] same
- **Undo**: Cmd/Ctrl+Z or "Undo" in the chat. [P] same
- **Sharing.** From 2026-06-23, new chats are **visible by default** to Full-seat editors of the file. Older chats stay private. [P] same
- **Seats.** Full seats with edit access can make edits. View, Dev and Collab seats can chat but not edit. [P] same
- **What it can do** [P] same:
  - Generate and edit layouts
  - Work with component instances, styles and variables
  - Bulk content edits
  - Image make and edit, background removal, image→vector
  - Rename layers, library search, design and accessibility feedback
  - Skills, MCP connectors (Notion, Slack, Granola, Hex, GitHub, Atlassian and others), web search, attachments (Figma files, images, text, code)
  - **Coming**: vectors, icons, slots, prototyping
  - **Not supported**: exporting assets, diagrams and data visualisations (the help sends users to FigJam AI for these), and contacting Figma support
- **Workflow framing.** Start in Design with the agent, move to **Make** for code, and iterate back in Design. [P] [Figma agent blog 2026-05-20](https://www.figma.com/blog/the-figma-agent-is-here/)
- **Beta terms at launch.** The agent was "rolling out gradually in beta" and "won't consume credits" during the beta. The blog names Full seats on Professional, Organization and Enterprise, with Collab and Dev seats limited to drafts. The First Draft help says the agent is "available on all plans", so the two sources conflict. [P] same; [P] [First Draft help](https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI)
- The agent will also come to **FigJam and Slides** (waitlist). [P] [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/)
- The agent chat panel **pops out** into its own window on desktop (2026-08-26). [P] [Release notes](https://www.figma.com/release-notes/)
- Skill authoring in the agent and a community skills library of 50+ skills (2026-08-13). [S] [Releasebot](https://releasebot.io/updates/figma)
- **Weaknesses** [S] [mantlr](https://mantlr.com/blog/figma-ai-agent-guide-2026), [chatforest](https://chatforest.com/reviews/figma-ai-design-agent-canvas-code-to-canvas-2026/):
  - Multi-frame flows come out inconsistent
  - Microcopy is bland
  - Accessibility still needs human review
  - How it resolves conflicts between parallel agents is undocumented

### 3.3 Figma Make (prompt → app)
- **Launch**: 2025-05-07. "Figma Make currently uses Claude 3.7 Sonnet; we will begin introducing other models in the future." [P] [Make blog](https://www.figma.com/blog/introducing-figma-make/) The tagline "design, prompt, validate—all in Figma" was not found in the blog (unverified).
- **Layout**: **AI chat on the left, live preview on the right**, with a separate code editor. You can run more than one chat at once in a single Make file. [P] [Explore Make](https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make) (not re-fetched in the fact-check)
- **Context**: + → Add context (Figma URL); paste frames or components into the chat; drag in images, text files, PDFs and video. [P] same; [P] [Make page](https://www.figma.com/make/)
- **New Make editor (2026-07-30)** [P] [Figma blog](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/), [Edit a Make file](https://help.figma.com/hc/en-us/articles/42009840449175-Edit-a-Figma-Make-file):
  - An **"Edit"** button in the top-right toolbar opens a Figma-Design-style **properties panel**: spacing, padding, type, layout, opacity, z-index and borders.
  - The panel shows the **full DOM tree**, so you can select every instance of an element at once.
  - Direct edits are **staged**: they appear "in the chat above the prompt box" and are committed with **Apply**. Staged edits are "credit-free". Credits are charged on Apply, which creates a new version, and an edit uses "far fewer tokens" than a prompt.
  - **"Annotate for agent"** drops **blue numbered callouts** on the rendered UI. Each annotation takes text and optional images. You can "stack several annotations across the screen and submit them together as a single prompt" (Send to agent, then Apply). The example "fade this button in after a 300ms delay" is unverified.
  - A **Draw tool** lets you mark up the preview. "Add to prompt" attaches the drawings as context images.
  - **This UI applies only to new Make files**. Old files keep the previous interface.
- **Versions** [P] [Edit a Make file](https://help.figma.com/hc/en-us/articles/42009840449175-Edit-a-Figma-Make-file):
  - Created automatically on edits.
  - Preview without affecting current work.
  - Restore (all versions are kept), favourite, rename.
- **Publish** [P] [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs):
  - A dedicated URL, with custom domains available.
  - Hosted on AWS behind Cloudflare, not indexed by default.
  - Full seats only (Starter can publish publicly only with a Community publish).
- **Make kits and connectors.** Kits sync npm packages, library styles and guidelines. MCP connectors bring in docs, tasks and data. [P] [Make page](https://www.figma.com/make/)
- **Make on local code** (2026-05-28, closed beta, Mac desktop app) [P] [Make local code](https://www.figma.com/blog/figma-make-now-on-your-local-code/):
  - Connect a GitHub repo or a local repo. The blog does not compare the two, so this detail comes from the help article and was not re-verified.
  - The live app runs with real data.
  - Edit through the properties panel, annotations or chat.
  - "Until you open a PR, your changes are stored as local commits." That each prompt makes exactly one commit is unverified.
  - Create and switch branches, and open a PR without leaving Figma.
  - Launched as a limited beta on Mac only, in the Figma Beta desktop app, with no credits charged during the beta.
- **Seats**: Full seats can create in team folders, share and publish. Dev, Collab and View seats can only create in drafts. [P] [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs)
- **Weaknesses** [C] [HN Show HN 2026-01-23](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html), [C] [Forum 2026-01-21](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944), [C] [stackdiver 2025-07-27](https://stackdiver.com/posts/figma-make-is-not-the-future-of-design/):
  - The REST API rejects Make files ("File type not supported by this endpoint"), which reads as lock-in.
  - Forum users report 60 credits for one button-text change, 82 credits for two button labels, and "98 credits on do nothing" (forum 2026-01-21, not stackdiver).
  - Critics call Make gated to Full seats rather than truly democratising.

### 3.4 Figma Sites (design → publish)
- **Launch**: 2025-05-07, beta [P] [Sites blog](https://www.figma.com/blog/introducing-figma-sites/):
  - **Multi-edit across breakpoints** ("changes quickly across screen sizes all at once").
  - A web preview renders real HTML and CSS; resize to watch reflow.
  - Libraries and pre-built blocks come in via the **inserts panel**.
  - **Preset interactions**: mouse parallax, scroll parallax and scroll transform, lightbox, spin, draggable, typewriter, scramble text, hover and pressed states. The product page adds marquee and custom cursors. [P] [Sites page](https://www.figma.com/sites/)
- **Code layers** (2025-06-17) [P] [Code layers](https://www.figma.com/blog/introducing-code-layers/), [Sites AI help](https://help.figma.com/hc/en-us/articles/35895907782807-Figma-Sites-collection-Create-code-layers-in-Figma-Sites-with-AI):
  - A code layer is React code rendered as a layer.
  - Three ways to create one: convert an element (the Make icon in the properties panel, or "Make code from design"), draw one with **E**, or prompt for it.
  - The editor has **chat, code and preview**.
  - The AI generates properties such as "animation speed" that show as canvas controls.
  - **Cmd+D** duplicates a layer to compare variants.
  - **Double-click re-enters "Make view"**.
  - npm packages such as `motion` and `@react-three/fiber` are supported.
- **CMS**: public beta in November 2025; the exact day is unverified. The staff post said "This one definitely took a lot longer than we initially expected". The feature list (collections, CMS pages with dynamic URLs, lists, custom domains, rollback) comes from search summaries and is unverified. [C] [Forum](https://forum.figma.com/suggest-a-feature-11/launched-figma-sites-cms-41906); [S] [search summaries]
  - The CMS view locks the design layout while collaborators update content. [P] [Sites page](https://www.figma.com/sites/)
  - Backed by the **Payload** acquisition (2025-06-17). [P] [Payload](https://www.figma.com/blog/payload-joins-figma/)
- **Weaknesses**:
  - Launch output was inaccessible. The first demo site had 210 axe issues (33 critical) and 101 role-less `<div>`s with `aria-label`. Links and buttons were built from event handlers, and characters were wrapped in stray `<span>`s. [C] [Adrian Roselli 2025-05-08](https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html)
  - Figma's 2025-05-21 fixes added semantic `<button>`/`<a>`, `<p>`, keyboard navigation and more. Roselli called them minimal.
  - Sites still lacks multi-language, e-commerce and membership support, and its SEO is limited. [S] [Supasaito](https://www.supasaito.com/en/media/blog/figma-sites)
  - CMS delays frustrated users. [C] [Forum](https://forum.figma.com/suggest-a-feature-11/launched-figma-sites-cms-41906)

### 3.5 Figma Slides
- **Layout** [P] [Explore Figma Slides](https://help.figma.com/hc/en-us/articles/24170630629911-Explore-Figma-Slides):
  - **Toolbar** holds building blocks, Assets (Design libraries), AI tools and the **Slides ↔ Design mode toggle**.
  - **Left sidebar** has a template picker and the **slide view ↔ grid view** toggle.
  - **Right sidebar** has **Design** and **Animate** tabs.
  - In **grid view**, both sidebars appear only when something is selected. In slide view they are always visible.
- **Design mode** (Shift D; Full seat plus edit access) unlocks the layers panel, auto layout, components and advanced properties. [P] [Design mode in Slides](https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides)
  - **[I]** This is the clearest Figma example of **progressive disclosure of the full editor inside a simpler type**, which is what Juno needs for "a doc or slide that can drop into Design".
- **Deck structure** [P-local `figma-use-slides/SKILL.md`, `slide-properties.md`]:
  - The node model is **SLIDE_GRID → SLIDE_ROW → SLIDE**. Each row is a named "section" shown next to the row in the editor and in Presenter View.
  - `speakerNotes` takes markdown (lists, bold, italic).
  - Other slide properties: `isSkippedSlide`, `focusedSlide`, `slideThemeId`.
  - Interactive elements: `POLL`, `EMBED`, `FACEPILE`, `ALIGNMENT`, `YOUTUBE`.
  - A new Slides file starts with an **empty grid** plus a default light theme.
  - `get_metadata` does not work on Slides.
- **Transitions** [P] [Use slide transitions](https://help.figma.com/hc/en-us/articles/24244588378007-Use-slide-transitions); [P-local d.ts `SlideTransition`]:
  - Styles: **Smart Animate** (matches objects across consecutive slides), Dissolve, Push, Slide In, Slide Out, Move In and Move Out, with left, right, top or bottom directions. In the API: `SLIDE_FROM_*`, `PUSH_FROM_*`, `MOVE_FROM_*`, `SLIDE_OUT_TO_*`, `MOVE_OUT_TO_*`, `SMART_ANIMATE`.
  - Controls: easing and spring presets in the Curve dropdown, duration (seconds), timing (immediate or after a delay).
- **Object animations** [P] [Animate objects](https://help.figma.com/hc/en-us/articles/30601608159383-Animate-objects-on-a-slide):
  - In Animate tab → Add animation, set Style, Duration and Timing. The first animation plays "On click" and later ones can follow the previous.
  - Drag handles to reorder. Group animations to sequence them. "Play animations" previews them.
  - **One animation per object.** Only objects on a slide can animate.
  - GA added slide and fade animations. [P] [Slides GA blog](https://www.figma.com/blog/how-teams-tap-into-the-power-of-design-with-figma-slides/)
- **Presenting**:
  - Presenter notes, **spotlight**, audio and **cursor chat**, co-presenter handoff.
  - Polls and alignment scale, with responses saved to the deck.
  - Embedded prototypes, .pptx import and export.
  - AI tone and length rewrite, AI-generated presenter notes, FigJam → slide outline.
  - [P] [Slides launch](https://www.figma.com/blog/introducing-figma-slides/), [Slides page](https://www.figma.com/slides/)
- **Agent**: a Slides agent is on a waitlist (Config 2026). The MCP skill mentions an optional `generate_deck` tool for template-based one-shot decks. It warns agents to pick one approach, `generate_deck` or `use_figma`, and not create duplicate artifacts. [P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026); [P-local `figma-use-slides/SKILL.md`]
- **Complaint**: the forum asks for Smart Animate settings in the Animate panel (durations, easing, delay). Some have since shipped. [C] [Forum](https://forum.figma.com/suggest-a-feature-11/figma-slides-add-settings-in-animate-panel-smart-animation-durations-easing-curves-delay-22115)

### 3.6 Figma Buzz (brand assets at scale)
- **Workflow** [P] [Buzz blog 2025-05-07](https://www.figma.com/blog/introducing-figma-buzz/), [Guide to Buzz](https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz):
  - A brand designer builds a template in Design, **copy-pastes it into Buzz**, and **locks** elements, leaving text and image fields editable.
  - Marketers start from a template, a blank preset size (Instagram, Facebook, Pinterest, X, LinkedIn, YouTube, Google) or an AI image.
- **Guidelines state shown by outline colour**:
  - **Pink outline**: guidelines are on. Only approved fields can be edited, and the Text, Images, Shapes and Inserts tools are hidden.
  - **Blue outline**: full editing.
- **Grid view** shows every asset in a campaign side by side, at any size, for multi-editing. **Table view** edits fields in bulk.
- **Bulk create**: map CSV or XLSX columns to template fields, and one asset is generated per row. **AI fill** creates varied values per cell.
- **AI** [P] [Buzz page](https://www.figma.com/buzz/):
  - Images via gpt-image-1 and Gemini
  - Upscale, background removal
  - Tone rewrite, translate, shorten
- **Video**: import mp4 or mov, trim, export.
- **Exports**: PNG, JPG, PDF.
- **Templates** can be configured with component properties.
- Buzz shares the **canvas grid** API with Slides. [P-local d.ts]
- **Weaknesses** [C] [Buzz forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307):
  - Embedding images via Excel fails.
  - No parent auto layout, so templates can't be responsive.
  - Locking is too coarse; one user said users "will just unlock everything".
  - **Design library updates don't sync into Buzz**; you "manually replace every single asset".
  - No CMYK or multi-page PDF.
  - Frustration that the UI keeps getting reorganised.

### 3.7 Figma Weave (AI media workflows)
- **Background**: Weavy was acquired 2025-10-30. Its node-based canvas mixes generative outputs with hand edits (lighting, masking, colour grading) and supports branch and remix. [P] [Welcome Weavy](https://www.figma.com/blog/welcome-weavy-to-figma/)
- **Launch**: 2026-04-09 as a standalone product, per the secondary source only. Figma's own 2026-04-09 post is a workflows article that points to weave.figma.com and promises integration "later this year"; it does not announce a launch. [S] [creativeainews](https://www.creativeainews.com/articles/figma-weave-node-graph-ai-design-analysis/); [P] [Five Weave workflows](https://www.figma.com/blog/five-figma-weave-workflows/)
  - 20+ models from 12 providers (Veo, OpenAI, Runway, Luma, Kling, FLUX, Recraft, Ideogram, ByteDance and others). [S]
  - Nodes include Image Describer, "Any LLM", 3D and Kling Element. [P] Five workflows blog
  - **App Mode** turns a workflow into a simple form UI for non-experts. [S]
  - Pricing: Free 150 credits a month; Starter $24 a month for 1,500 credits; up to $60 per user per month. [S] only; not on any Figma page I fetched.
- **Integration** [P] [Connecting Figma and Weave 2026-06-24](https://www.figma.com/blog/connecting-figma-and-weave/), [Release notes](https://www.figma.com/release-notes/):
  - **Weave tools in Design's left panel**: parameterised, with no freeform prompt.
  - **Publish workflows as tools**: announced as "soon" on 2026-06-24 and shipped to Community on 2026-09-16. The "Share →" menu path is unverified.
  - The **Figma node** (2026-09-17) links pasted Design frames, with a "Sync" to keep connected assets up to date. See §2.5.
  - Weave tools in Design were free in open beta and will use Figma AI credits at GA.
  - Output is exported by download or copy-paste.
- **MCP**: `weave_list_tools`, `weave_get_tool_inputs`, `weave_upload_asset`, `weave_run_tool` (needs credit acknowledgement), `weave_get_tool_run_output` (polling), `weave_cancel_tool_run`. The installed server also exposes `weave_find_model`, `weave_run_model` and `weave_get_model_run_output`. [P] [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/); [P-local: MCP tool list in this session]
- **Fragmentation** [P] [Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file), [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/); [S] [search summary]:
  - Weave sits outside the file browser.
  - Standalone Weave, and Weave tools run through MCP, use Weave credits and need a paid standalone Weave account. Weave tools inside Design use Figma AI credits.
  - Weave tools with unverified models can't go to Community (unverified; search summary only).

### 3.8 MCP server, skills, generative plugins, Code Connect
- **MCP evolution** [P] [MCP launch](https://www.figma.com/blog/introducing-figma-mcp-server/), [Agents meet canvas](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/), [MCP docs](https://developers.figma.com/docs/figma-mcp-server/):
  - 2025-06-04: local Dev Mode MCP with code, image and variables tools.
  - Later: a remote server (recommended, "broadest set of features") and write access.
  - 2026-03-24: `use_figma` writes to the canvas. Skills launched with 9 examples, such as `/figma-generate-library`.
  - Only clients in the Figma MCP Catalog can connect.
- **Current tool families** [P] [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/):

  | Family | Tools |
  |---|---|
  | Read | `get_design_context` (Design, Make), `get_metadata`, `get_screenshot` (Design, FigJam, Slides), `get_variable_defs`, `get_motion_context`, `get_figjam`, `download_assets` |
  | Write | `use_figma` (Design, FigJam, Slides), `generate_figma_design`, `create_new_file` (`design`/`figjam`/`slides`), `upload_assets`, `generate_diagram` |
  | Design system | `get_libraries`, `search_design_system`, Code Connect map tools |
  | Generative | plugin and shader CRUD, Weave tools, `whoami` |

  - **Note [I]:** `create_new_file` can make Design, FigJam or Slides files, **but not Buzz, Sites or Make**. Agent reach is uneven across types.
- **Generative plugins** (Config 2026 open beta) [P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026); [P-local `figma-generative-plugins/SKILL.md` + `references/authoring.md`]:
  - "Build reusable plugins right in your file" by prompting. Plugins are **hosted by Figma**, not local.
  - They start private to their creator (the skill calls them an "account-library tool"), so "file-level" is imprecise. Community and org publishing came 2026-09-01.
  - Run only in the Design editor (`editorType: ["figma"]`).
  - **Every plugin must have a functional UI.** The UI is `ui.html` built from PropsKit web components (`fig-field`, `fig-input-number`, `fig-button`, `fig-footer`) plus a sandboxed `code.ts`, talking over `postMessage`.
  - Lifecycle: create a scaffold (a square-drawing starter), get the source, then update with full file replacements and a commit message.
  - A "try" link, `figma.com/file/new?try-tool-resource-content-id=<id>&try-tool-resource-type=gen_tool`, **opens a new Design file with the unpublished tool ready**. Shaders use `gen_effect` / `gen_fill`.
- **Code Connect** [P-local `figma-code-connect/SKILL.md`]:
  - Maps published components to code snippets through `.figma.ts` parserless templates (`figma.code` tagged templates).
  - Requires Organization or Enterprise and published components.
  - MCP tools: `get_code_connect_suggestions`, `send_code_connect_mappings`, `add_code_connect_map`.

### 3.9 Pricing and seat structure (only where it shapes product structure)
- **Seats** [S] [PageDog pricing summary](https://www.pagedog.app/blog/figma-pricing):
  - **Full**: all products.
  - **Dev**: Dev Mode.
  - **Collab**: FigJam and Slides editing, view-only Design.
  - **View**: free.
- **AI credits are shared across products** [P] [Manage AI credits](https://help.figma.com/hc/en-us/articles/35865276858647-Manage-AI-credits):
  - Covered: Make, the agent (including generative plugins and shaders), Weave tools, code layers, 3D, Motion edits, and FigJam and Slides AI.
  - Monthly allowance per seat:

    | Seat | Credits per month |
    |---|---|
    | Full, Starter | 500 |
    | Full, Professional | 3,000 |
    | Full, Organization | 3,500 |
    | Full, Enterprise | 4,250 |
    | Dev, Collab, View (all plans) | 500 |

    Starter and View seats also have a daily cap of 150 credits.

  - Admins can add a subscription pool or pay-as-you-go.
- **[I] Takeaway**: a *single credit currency* across types is a unifying move. Weave tools inside Design are on that currency; only standalone Weave and MCP-run Weave tools use separate Weave credits. *Seat-gated edit rights* (chat-only for non-Full seats) spread across every AI surface.

---

## 4. Motion and animation catalogue (everything documented)

| Surface | What animates | Parameters | Source |
|---|---|---|---|
| Prototype transitions and Smart Animate (Design) | Frame→frame, matched layers | 7 Bézier presets (Linear, Ease In, Ease Out, Ease In And Out, Ease In Back, Ease Out Back, Ease In And Out Back) + custom Bézier (curve editor in the Interaction details modal); **springs: Gentle, Quick, Bouncy, Slow** + custom (stiffness, damping, mass) | [P] [Prototype easing](https://help.figma.com/hc/en-us/articles/360051748654-Prototype-easing-and-spring-animations) |
| Figma Motion timeline | Keyframes on transform, size, radius, padding, gap, opacity, fills, strokes, effects | Timeline in **seconds**; `EASE_IN`, `EASE_OUT`, `EASE_IN_AND_OUT`, `LINEAR`, `*_BACK`, `CUSTOM_CUBIC_BEZIER`, `GENTLE`, `QUICK`, `BOUNCY`, `SLOW`, `CUSTOM_SPRING`, **`HOLD`** (step). In Motion, `CUSTOM_SPRING` takes only a normalised `{bounce}` from 0 to 1. Physical `{mass, stiffness, damping}` values convert via `figma.motion.physicalSpringToNormalized`. The `{mass, stiffness, damping, initialVelocity}` shape belongs to the prototype-transition `EasingFunctionSpring`, not Motion; animation styles (Fade, Move, Scale presets) stack or sequence; `timelineOffset`; the top-level frame holds the timeline | [P-local `figma-use-motion/`, d.ts `MotionEasing`, `EasingFunctionSpring`, `NormalizedSpring`, `KeyframePropertyFieldName`]; [P] [Motion blog](https://www.figma.com/blog/introducing-figma-motion/) |
| Slides transitions | Slide→slide | Smart Animate, Dissolve, Push, Slide In/Out, Move In/Out × 4 directions; Curve dropdown (easing and springs); duration; delay | [P] [Transitions](https://help.figma.com/hc/en-us/articles/24244588378007-Use-slide-transitions) |
| Slides object animations | Objects in or out | Style, Duration, Timing (On click / after previous); groups; one per object | [P] [Animate objects](https://help.figma.com/hc/en-us/articles/30601608159383-Animate-objects-on-a-slide) |
| Sites interactions | Page elements | Presets: mouse parallax, scroll parallax and transform, lightbox, spin, draggable, typewriter, scramble text, hover and pressed, marquee, custom cursor | [P] [Sites blog](https://www.figma.com/blog/introducing-figma-sites/), [Sites page](https://www.figma.com/sites/) |
| Code layers | Anything in React | npm `motion`, `@react-three/fiber`; AI-exposed props such as speed | [P] [Code layers](https://www.figma.com/blog/introducing-code-layers/) |
| Shaders | Procedural fills and effects | WebGPU; `frame.time` (ms) animation, `frame.mousePosition` interaction; exported to MP4 | [P-local `figma-shaders`]; [P] [Release notes 2026-09-01](https://www.figma.com/release-notes/?title=updates-to-generative-plugins-and-shaders) |
| Agent presence | Work in progress | An "animated loading indicator on the canvas" per running prompt; click it to open the thread | [P] [Help: agent](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) |
| Make annotations | Agent targets | Blue numbered callouts on the rendered UI | [P] [Make blog 2026-07-30](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/) |
| Buzz guidelines | State | Pink outline = locked template fields; blue = free edit | [P] [Guide to Buzz](https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz) |
| Slides presenting | Presence | Spotlight, cursor chat, audio, co-presenter | [P] [Slides launch](https://www.figma.com/blog/introducing-figma-slides/) |

**Gap.** Figma documents no durations or easings for its **own chrome** transitions, such as panel open and close, the mode toggle, or the agent indicator's animation. Treat any such values as unknown, not "standard".

**[I] Overlap.** Prototype Smart Animate, Slides transitions and animations, Sites interaction presets and Motion timelines are four separate animation models. Only Motion is shared through components and variables. The Motion easing enum explicitly reuses the Smart Animate easing shape and adds `HOLD` [P-local `motion-easing.md`]. That suggests Figma is converging on Motion as the one model. Juno should start with **one motion model** (keyframes + easing/spring + presets) shared by Slides transitions, Design prototypes and code export.

---

## 5. Weaknesses and complaints (collected)

1. **Product sprawl and overlap.** Make vs Sites code layers vs Design code layers are three homes for "code on/near the canvas". Four animation systems overlap. Slides and Buzz are both grids of frames. [I]; the MCP skill itself warns "pick one and commit" between `generate_deck` and `use_figma` to avoid "duplicate, conflicting artifacts". [P-local `figma-use-slides/SKILL.md`]
2. **One-way conversions.** Make → Design copy doesn't sync back. [P] [Make FAQs](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs) Design library → Buzz doesn't sync. [C] [Buzz forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307)
3. **Lock-in and closed formats.** The REST API rejects Make files. [C] [HN/blog](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
4. **Uneven tooling across types** [P-local] [P] [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/):
   - `get_metadata` fails on Slides and FigJam.
   - `createPage()` throws outside Design.
   - The plugin `editorType` doesn't include Sites or Make.
   - `create_new_file` can't create Buzz, Sites or Make.
   - Generative plugins run only in Design.
5. **Weave outside the family.** It has a separate sign-in and file browser. Standalone and MCP use runs on separate Weave credits (Weave tools inside Design use Figma AI credits). Outputs come back by download or copy-paste. [P] [Create a new file](https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file), [Five workflows](https://www.figma.com/blog/five-figma-weave-workflows/)
6. **Split UI generations.** The new Make editor applies only to new files. [P] [Make blog](https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/)
7. **AI credit economics.** Pay-as-you-go credits cost about 5.6× seat credits, and small edits cost 60–98 credits. [C] [Forum 2026-01-21](https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944)
8. **Output quality** [C] [Roselli](https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html); [S] [mantlr](https://mantlr.com/blog/figma-ai-agent-guide-2026); [S] [AlternativeTo](https://alternativeto.net/news/2024/9/figma-relaunches-ai-powered-first-draft-app-generator-after-initial-backlash-over-fraud):
   - Sites launched with inaccessible HTML.
   - The agent is inconsistent across multiple frames and writes bland copy.
   - "Make Designs" was pulled in 2024 for copying Apple Weather.
9. **Mode confusion.** One Draw user said switching modes "feels clunky". Users also asked for iPad support and complained about toolbar placement in fullscreen. [C] [Draw forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-draw-is-here-let-s-hear-what-you-think-40305/index2.html)
10. **Navigation churn.** The folder redesign removed thumbnails and Figma had to restore previews six weeks later. [C] [Forum](https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675) → [P] [Release notes 2026-09-16](https://www.figma.com/release-notes/). Buzz users also complained about repeated UI reorganisation. [C] [Buzz forum](https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307)
11. **Feature gates and beta sprawl.** Motion APIs sit behind a user feature flag (`metronome`) and throw "not a supported API" without it. [P-local `figma-use-motion/SKILL.md`] Code layers in Design, local Make and the Slides/FigJam agent are all waitlisted. [P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026)

---

## 6. Figma vs Claude's merged model (building on the lead's evidence)

| Dimension | Figma (2026) | Claude (after 2026-09-16, per `claude-primary-evidence.md`) |
|---|---|---|
| Unit | Typed **file** (Design/FigJam/Slides/Sites/Make/Buzz) + materials inside Design | Typed **artifact** (Design/Design System/Docs/Slides + custom), one link |
| Entry | File browser "+ Create" dropdown; `.new` URLs | Conversation first; the model routes (`quickstart` intent) |
| Type switching | Copy-paste between files; modes inside an editor (Draw, Dev, Motion, Slides design mode) | Types are runtimes over content files; conversation is the glue |
| AI | One agent, Design first (FigJam and Slides waitlisted); chats shared with editors by default | Claude in every surface; comments "sent to Claude" |
| Shared assets | Published libraries, Make kits, variables | Design System type auto-applied to decks and designs |
| Code on canvas | Code layers (React) with extract↔sync to design layers | Design type artboards are `.dc.html` components with tweaks |
| Tweaks and props | Code-layer props, shader params, generative plugin PropsKit UI | `data-props` tweaks as editor levers |
| Mobile | Viewing (Make "mobile app support for native viewing" [P] [Make page](https://www.figma.com/make/)) | Edit on phone at the same link |

**[I]** Figma is *file-type first with a shared canvas*. Claude is *conversation first with typed pages*. Juno sits between them: it has a chat (like Claude) and a Figma-like DESIGN editor (like Figma).

---

## 7. Implications for Juno's Artifacts + Juno Design merge [I]

1. **One library, one "+ New" menu, per-type icon plus a big thumbnail.** Figma's type icons were not enough. Users revolted when thumbnails disappeared (Aug–Sep 2026). Every artifact card should render a live thumbnail and carry a small type glyph.
2. **Reserve types for different document roots and consumption modes.** Keep a small set: Design canvas, Slides (sequence plus present), Doc (flow text), App/Code (runnable), and possibly Asset-set (bulk variants, like Buzz). Everything else (HTML, React, SVG, Mermaid, markdown snippets) should be a **layer or material inside the Design canvas** or inline in chat, not a new top-level type. This mirrors Figma's 2026 move from new products to new canvas materials.
3. **Code layer = Juno's HTML/React artifact placed on the Design canvas.**
   - Double-click enters the code or preview editor (Figma's "Make view").
   - AI-generated props appear as canvas controls. This maps onto Claude's `data-props` tweaks.
   - Cmd+D duplicates to compare.
   - "Extract to layers" converts code → design, and "update code from layers" syncs back.
   - Avoid Figma's one-way Make→Design copy.
4. **Modes over files.** A Design artifact should expose modes in a toolbar toggle: Design / Draw / Prototype-Play / Motion / Inspect(dev). Slides and Docs should offer a **"design mode" (Shift D) progressive-disclosure toggle** that reveals the full Juno Design panels for that slide or block.
5. **One agent, two entry points.** Use an inline on-canvas prompt (Cmd+Enter on a selection) plus a persistent chat rail. Allow parallel prompts, each with an **animated indicator on its target** that opens its thread. Put Undo in the thread. Make threads visible to collaborators by default (Figma, 2026-06-23). Allow the chat rail to pop out into its own window on macOS (Figma, 2026-08-26).
6. **Direct edit with staged Apply.** Figma Make's panel stages edits in the prompt box, commits them on Apply, and uses fewer tokens. Juno can let users tweak properties of generated HTML and React visually and batch them into one model call. Add **numbered annotations** ("Annotate for agent") that submit as one prompt.
7. **One motion model.** Adopt Figma Motion's primitives for every type (keyframes in seconds; easing enum with springs Gentle, Quick, Bouncy, Slow, custom spring and HOLD; stackable presets; motion variables with modes). Use the same model for slide transitions (Smart-Animate-style "magic move", which Claude's Slides calls `magic`) and export to CSS or motion.dev.
8. **Live links beat clipboard copies.** Wherever content moves between types (Design → Slides, Design → Asset set), prefer instance or reference semantics (library-style update notifications) over paste. Figma's user complaints come mostly from copy-based bridges.
9. **Keep every type agent-addressable.** Don't repeat Figma's uneven MCP and plugin coverage across types. Every Juno artifact type should be readable and writable by the same model tools (create, read, update, screenshot).
10. **Keep one credit currency and one sign-in.** Weave's separate account and credits for standalone and MCP use are the clearest fragmentation in Figma's family. Figma is partly fixing this by billing Weave tools in Design with Figma AI credits.

---

## 8. Open questions and gaps
- No primary Figma source gives **chrome animation timings**: panel slide, mode toggle, agent loading indicator style.
- Whether **Figma Sites and Make will merge into Design** once code layers reach GA is unannounced. The recap frames code layers as bringing Make's power onto the Design canvas, and Make remains a separate product. [P] [Make page](https://www.figma.com/make/)
- The exact **file-browser filter-by-type UI** isn't documented in the help pages fetched. The file grid shows type icons, but I found no primary evidence of a type filter.
- **Slides/FigJam agent GA** and the **`generate_deck`** tool's public status are unclear; the skill references it conditionally.
- **Mobile** (Figma iOS) editing support for Slides, Buzz and Make wasn't verified.
- The Config 2026 keynote video wasn't watched. Everything here comes from the recap, help and blog posts.

---

## 9. Sources (URL + date)
- UI3 redesign — https://www.figma.com/blog/behind-our-redesign-ui3/ — 2024-06-26
- Introducing Figma Slides — https://www.figma.com/blog/introducing-figma-slides/ — 2024-06-26
- First Draft relaunch (AlternativeTo) — https://alternativeto.net/news/2024/9/figma-relaunches-ai-powered-first-draft-app-generator-after-initial-backlash-over-fraud — 2024-09
- Slides GA — https://www.figma.com/blog/how-teams-tap-into-the-power-of-design-with-figma-slides/ — 2025-03-19
- Config 2025 recap — https://www.figma.com/blog/config-2025-recap/ — 2025-05-07
- Config 2025 press release — https://www.figma.com/blog/config-2025-press-release/ — 2025-05-07
- Introducing Figma Make — https://www.figma.com/blog/introducing-figma-make/ — 2025-05-07
- Introducing Figma Sites — https://www.figma.com/blog/introducing-figma-sites/ — 2025-05-07
- Introducing Figma Buzz — https://www.figma.com/blog/introducing-figma-buzz/ — 2025-05-07
- Introducing Figma Draw — https://www.figma.com/blog/introducing-figma-draw/ — 2025-05-07
- Roselli, Do Not Publish… with Figma Sites — https://adrianroselli.com/2025/05/do-not-publish-your-designs-on-the-web-with-figma-sites.html — 2025-05-07 (updates 2025-05-21 and later; last updated 2026-06-10)
- @joelanman (Mastodon) — https://hachyderm.io/@joelanman/114468661897615798 — 2025-05-08
- Introducing the Figma MCP server — https://www.figma.com/blog/introducing-figma-mcp-server/ — 2025-06-04
- Code layers in Sites — https://www.figma.com/blog/introducing-code-layers/ — 2025-06-17
- Payload joins Figma — https://www.figma.com/blog/payload-joins-figma/ — 2025-06-17
- Stackdiver, Figma Make is not the future — https://stackdiver.com/posts/figma-make-is-not-the-future-of-design/ — 2025-07-27
- Welcome Weavy / Figma Weave — https://www.figma.com/blog/welcome-weavy-to-figma/ — 2025-10-30
- Sites CMS launched (forum) — https://forum.figma.com/suggest-a-feature-11/launched-figma-sites-cms-41906 — 2025-11
- AI credit complaint (forum) — https://forum.figma.com/share-your-feedback-26/why-is-1-ai-credit-6x-more-expensive-than-a-full-seat-credit-49944 — 2026-01-21
- Reverse-engineering Make files — https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html — 2026-01-23
- Agents, meet the Figma canvas — https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/ — 2026-03-24
- Five Figma Weave workflows — https://www.figma.com/blog/five-figma-weave-workflows/ — 2026-04-09
- Weave analysis (creativeainews) — https://www.creativeainews.com/articles/figma-weave-node-graph-ai-design-analysis/ — 2026 (after April)
- The Figma agent is here — https://www.figma.com/blog/the-figma-agent-is-here/ — 2026-05-20
- TechCrunch, Figma adds an AI assistant — https://techcrunch.com/2026/05/20/figma-adds-an-ai-assistant-to-its-collaborative-canvas/ — 2026-05-20
- Mantlr agent guide — https://mantlr.com/blog/figma-ai-agent-guide-2026 — 2026-05
- ChatForest review — https://chatforest.com/reviews/figma-ai-design-agent-canvas-code-to-canvas-2026/ — 2026
- Make on local code — https://www.figma.com/blog/figma-make-now-on-your-local-code/ — 2026-05-28
- Config 2026 recap — https://www.figma.com/blog/config-2026-recap/ — 2026-06-24
- Code on the Figma canvas — https://www.figma.com/blog/code-on-the-figma-canvas/ — 2026-06-24
- Introducing Figma Motion — https://www.figma.com/blog/introducing-figma-motion/ — 2026-06-24
- Connecting Figma and Weave — https://www.figma.com/blog/connecting-figma-and-weave/ — 2026-06-24
- Snappr news, Config 2026 — https://www.snappr.com/news/story/figma-config-2026 — 2026-06-24
- Everything announced at Config 2026 (forum) — https://forum.figma.com/product-updates-3/everything-announced-at-config-2026-55221 — 2026-06
- Properties panel and annotations in Make — https://www.figma.com/blog/properties-panel-and-annotations-now-in-figma-make/ — 2026-07-30
- Projects become folders (forum) — https://forum.figma.com/product-updates-3/rolling-out-projects-become-folders-56675 — 2026-08-03
- Release notes (Aug–Sep 2026 entries) — https://www.figma.com/release-notes/ — accessed 2026-09-23
- Release note: updates to generative plugins and shaders — https://www.figma.com/release-notes/?title=updates-to-generative-plugins-and-shaders — 2026-09-01
- Releasebot aggregate — https://releasebot.io/updates/figma — accessed 2026-09-23
- Help: What's new from Config 2026 — https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026 — 2026-06
- Help: Config 2026, a guide for admins — https://help.figma.com/hc/en-us/articles/41301052048791-Config-2026-a-guide-for-admins — 2026-06
- Help: Work with the Figma agent — https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files — 2026
- Help: Use First Draft — https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI — 2026
- Help: Use AI tools in Figma Design — https://help.figma.com/hc/en-us/articles/23870272542231-Use-AI-tools-in-Figma-Design — 2026
- Help: Manage AI credits — https://help.figma.com/hc/en-us/articles/35865276858647-Manage-AI-credits — 2026
- Help: Updates to Figma's file management — https://help.figma.com/hc/en-us/articles/41753150926103-Updates-to-Figma-s-file-management — 2026-08
- Help: Guide to files and folders — https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders — 2026
- Help: Guide to the file browser — https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser — 2026
- Help: Create a new file — https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file — 2026
- Help: Import files to the file browser — https://help.figma.com/hc/en-us/articles/360041003114-Import-files-to-the-file-browser
- Help: Explore Figma Make — https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make
- Help: Edit a Figma Make file — https://help.figma.com/hc/en-us/articles/42009840449175-Edit-a-Figma-Make-file — 2026-07
- Help: Make in your local codebase — https://help.figma.com/hc/en-us/articles/40775535020695-Make-in-your-local-codebase — 2026
- Help: Figma Make FAQs — https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs
- Help: Sites, create code layers with AI — https://help.figma.com/hc/en-us/articles/35895907782807-Figma-Sites-collection-Create-code-layers-in-Figma-Sites-with-AI
- Help: Explore Figma Slides — https://help.figma.com/hc/en-us/articles/24170630629911-Explore-Figma-Slides
- Help: Use design mode in Figma Slides — https://help.figma.com/hc/en-us/articles/25423848723863-Use-design-mode-in-Figma-Slides
- Help: Use slide transitions — https://help.figma.com/hc/en-us/articles/24244588378007-Use-slide-transitions
- Help: Animate objects on a slide — https://help.figma.com/hc/en-us/articles/30601608159383-Animate-objects-on-a-slide
- Help: Slides libraries — https://help.figma.com/hc/en-us/articles/24292359259543-Access-Figma-Design-and-FigJam-assets-in-Figma-Slides
- Help: Guide to Figma Buzz — https://help.figma.com/hc/en-us/articles/31271566667543-Guide-to-Figma-Buzz
- Help: Explore Figma Draw — https://help.figma.com/hc/en-us/articles/31440394517143-Explore-Figma-Draw
- Help: Prototype easing and spring animations — https://help.figma.com/hc/en-us/articles/360051748654-Prototype-easing-and-spring-animations
- Buzz forum feedback — https://forum.figma.com/share-your-feedback-26/config-2025-figma-buzz-is-here-let-s-hear-what-you-think-40307 — 2025-05+
- Draw forum feedback — https://forum.figma.com/share-your-feedback-26/config-2025-figma-draw-is-here-let-s-hear-what-you-think-40305/index2.html — 2025+
- Slides Animate-panel feature request — https://forum.figma.com/suggest-a-feature-11/figma-slides-add-settings-in-animate-panel-smart-animation-durations-easing-curves-delay-22115
- Product pages — https://www.figma.com/make/ , https://www.figma.com/sites/ , https://www.figma.com/slides/ , https://www.figma.com/buzz/ — accessed 2026-09-23
- MCP docs — https://developers.figma.com/docs/figma-mcp-server/ and https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/ — accessed 2026-09-23
- Supasaito, Sites limits — https://www.supasaito.com/en/media/blog/figma-sites — 2025/26
- PageDog pricing summary — https://www.pagedog.app/blog/figma-pricing — 2026
- Local: `~/.claude/plugins/synced/c2187ff8-a276-4a64-b1e7-cf254a58703a_4beff4b7-d72c-4a9a-a79e-91158ce46804/figma/skills/` (figma-use d.ts, figma-use-slides, figma-use-motion, figma-shaders, figma-generative-plugins, figma-create-new-file, figma-code-connect, figma-implement-motion) — synced 2026

---

## 10. Fact-check (adversarial pass, 2026-09-23)

I re-fetched each cited primary URL and checked the local plugin typings and skills. WebSearch was not available (the session's search budget was spent), so second sources came from direct fetches: the HN Algolia API, forum threads and per-entry release-note URLs.

**Verified. No change needed, or only wording tightened:**
- **Agent beta and First Draft.** The Figma agent launched in beta on 2026-05-20 in Design. The First Draft help says: "Beginning May 20, 2026, Figma's agent will be the new entry point for this functionality." Legacy First Draft stays on paid plans. TechCrunch (2026-05-20) confirms a Design-first launch but does not mention First Draft.
- **Agent entry points.** On-canvas "Agents", Cmd/Ctrl+Enter, the left-sidebar "Agents" and Dictate all check out. So does "an animated loading indicator on the canvas" for each parallel task, which opens that thread's chat. Chats are visible by default to Full-seat editors from 2026-06-23. The Preferences toggle is "Show AI Chat on canvas". Undo works from the chat or with Cmd/Ctrl+Z.
- **Code layers in Design** (blog, 2026-06-24). "Extract designs" works on a screen, a state or a flow. "One click updates the code layer with your edits". You can import a GitHub repo or upload a local folder. The feature is in closed beta.
- **Weave outside the file browser.** The Create-a-new-file help says Weave "is currently a separate product experience that lives outside the Figma file browser".
- **Draw.** The help calls it "a set of visual design tools within the Figma Design editor" and describes a Draw/Design toggle in the toolbar.
- **Plugin typings.** `editorType: 'figma'|'figjam'|'dev'|'slides'|'buzz'` is at d.ts line 16. `getCanvasGrid`, `setCanvasGrid` and `createCanvasRow` are marked "only available in Figma Slides and Figma Buzz" (d.ts lines 1024–1075). `BuzzTextField` and `BuzzMediaField` also check out.
- **.make format.** A ZIP containing `canvas.fig` (with a `fig-makee` header and a Kiwi schema), `CODE_FILE` nodes holding React/TSX `sourceCode`, and `ai_chat.json`. The REST API error is `{"status":400,"err":"File type not supported by this endpoint"}`. The HN Algolia API confirms a Show HN on 2026-01-23 (55 points).
- **New Make editor** (2026-07-30). Edit properties panel, DOM tree, staged edits committed with Apply, blue numbered "Annotate for agent" callouts, new Make files only.
- **Folders.** Projects became folders from 2026-08-03, with nesting up to 10 levels and Inherited or Limited permissions. The forum thread has 37 replies and 2,776 views; staff called previews "the single most common piece of feedback". Folder previews returned on 2026-09-16.
- **Motion.** Exports are MP4, GIF, SVG/animated SVG and WebM. Dev Mode copies code as CSS, JSON or React/motion.dev. The local `motion-easing.md` lists GENTLE, QUICK, BOUNCY and SLOW springs plus HOLD. The Government-plan exclusion checks out.
- **MCP file types.** `create_new_file` makes Design, FigJam or Slides files only. `use_figma` works in Design, FigJam and Slides. `get_design_context` works in Design and Make, `get_metadata` in Design only, and `get_motion_context` in Design only.
- **AI credits.** Credits cover Make, the agent, generative plugins, shaders, code layers, 3D transforms, Motion edits and Weave tools. Full seats get 3,000 (Pro), 3,500 (Org) or 4,250 (Enterprise) a month, and other seats get 500.
- **Release notes.** Weave tools can be published to Community (2026-09-16), the Figma node arrived in Weave (2026-09-17), and the agent chat can pop out into its own window (2026-08-26).
- **Other launch dates.** Make on 2025-05-07 using Claude 3.7 Sonnet; Sites on 2025-05-07; code layers in Sites and the Payload acquisition on 2025-06-17; the MCP server on 2025-06-04; `use_figma` and 9 skills on 2026-03-24; the Weavy acquisition on 2025-10-30; Slides GA on 2025-03-19; Slides beta and UI3 on 2024-06-26.

**Corrected (partly wrong or overstated):**
- **Weave credits.** The notes said Weave has its own credits, separate from Figma AI credits. That holds only for standalone Weave and for Weave tools run *through MCP*, which need a paid standalone account. Weave tools *inside Design* are on the Figma AI credit list and will bill AI credits at GA; they were free during open beta. I fixed this in the TL;DR and in §2.1, §3.7, §3.9, §5 and §7.
- **2026-09-01 release.** Animation and mouse interaction apply to **shaders** only. Publishing, the code viewer and MCP edits apply to both shaders and generative plugins.
- **Motion `CUSTOM_SPRING`.** It takes only `{bounce}` (0–1). `{mass, stiffness, damping, initialVelocity}` is the prototype `EasingFunctionSpring`.
- **Motion plans.** Starter gets limited exports, and Full seats on all plans can export. Paid plans are needed for publishing animated components, agent-generated animation and high-resolution video. The old line "paid plans are needed to export video" was wrong.
- **Config 2026 quote.** The recap's wording is "Code is material, just like images, vectors and design layers", not "code is material for design".
- **3D transforms** are not in the recap. They appear in the help article and the Motion blog.
- **Make local.** The copy-back quote was corrected to "Figma detects those changes and prompts you to bring them back into Make, applying them in code". The "each prompt becomes a local commit" wording was softened to "changes are stored as local commits until you open a PR". The beta is limited, Mac only, in the Beta desktop app.
- **Figma node in Weave.** The release note describes a copy-paste node with a "Sync" action. The June blog's "real-time" promise is not confirmed as shipped, so the node is now "linked", not "live".
- **Weave "launch" 2026-04-09.** Only the secondary source (creativeainews) calls it a launch; Figma's post that day is a workflows article. The launch date, model count, App Mode and pricing are now tagged [S].
- **2026-08-24 release.** It is "vector editing" (eraser with Shift+E in vector edit mode or Draw mode, plus drag-to-fill), not Draw only.
- **Agent's unsupported list.** It also includes data visualisations and contacting support.
- **Roselli's post** is dated 2025-05-07, not 05-08.
- **Credit price gap.** The forum says 5.6× (not about 6×). The 60/82/98-credit examples come from the forum thread, not stackdiver.
- **Credit table.** Added Starter Full = 500 and the 150-a-day cap for Starter and View seats.

**Tagged (unverified):**
- The Make tagline "design, prompt, validate".
- The Make annotation example "fade this button in after a 300ms delay".
- Weave tools "only image/vector outputs" and "unverified models can't go to Community".
- The exact day of the Sites CMS launch and its feature list.
- The agent sidebar "ordered by recency with preview text".
- The Dev Mode "Motion tab" name.
- The UI3 phrase "cohesive family of tools".
- The 2026-08-13 skills release. Releasebot quotes a Figma release-note title, but I did not see it on figma.com/release-notes.
- "Okta and others" for enterprise MCP auth.
- Whether plugins truly cannot run in Sites or Make. This is now marked [I], inferred from the typings.

**Not re-checked:** the Buzz forum complaints, the Draw forum complaints, the file-browser sidebar order, the Slides design-mode and Explore-Slides help details, the mantlr and chatforest reviews, and the PageDog seat summary. They keep the original author's citations.
