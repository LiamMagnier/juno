# Claude Artifacts & Design — primary evidence observed first-hand (2026-09-23)

Observed by the lead session from the Claude Code `Artifact` tool contract and the four
published "core" Artifact types it lists (read-only calls: list types, quickstart, read type).
This is how Claude's artifact platform actually works *today*, after the 16 Sept 2026 merge.

## The merge (sources: claude.com/blog/cowork-is-now-claude; TechCrunch 2026-09-16)
- Claude chat + Cowork (agent workspace) + Artifacts are ONE interface. No tab choice before typing;
  Claude "figures out what a task needs" and routes to the capability.
- Claude Docs and Claude Slides launched (beta, paid plans). Claude Design (launched April 2026 for
  websites/prototypes) "now works inside your conversations too".
- Everything Claude makes lives at "one shareable link you can open on your phone", editable directly.
- Docs support collaborative commenting; slides can be presented and exported to PDF / PowerPoint.
- Default: Claude asks before acting; optional mode where it keeps working and checks in only when needed.
- Nothing removed: existing chats, projects, artifacts, connectors, skills remain. Cross-device: start on
  desktop, track progress on mobile.
- Rollout: Pro/Max first from 16 Sept (web, desktop, mobile), Team/Free later, Enterprise 30-day notice.

## One substrate, many types ("appifacts")
- Every artifact is a hosted web page at a private-by-default URL (claude.ai/artifact/{id} /
  claude.ai/code/artifact/{uuid}); owner can share, pin to sidebar; gallery at claude.ai/code/artifacts.
- **Artifact types** are themselves published artifacts: a fixed runtime (index.html, SKILL.md,
  artifact-type/*) + the instance's OWN content files under `project/`. Types can be upgraded
  (releases) without touching instance content. Core types today: **Design**, **Design System**,
  **Docs**, **Slides**. A `quickstart(intent: document|slides|design|other)` call picks the type and
  attaches the user's default design system.
- The instructions each type ships (SKILL.md) are how the model learns to fill/revise that type —
  i.e. types are model-authorable file formats + a shared editor runtime.
- **Runtime capabilities** a page declares: `artifact` (self-save/versions), `assets` (asset store,
  /_blob/<id> uploads ≤15–20 MB), `comments` (anchored threads; `customAnchors`, `composer_only`),
  `db` (small shared per-artifact database with path rules: who can read/write), `downloads`
  (give the viewer a file: PDF/PPTX etc.), `room` (live multiplayer presence), `user` (who is viewing:
  profile scope), `mcp` (connected data), `sample`/ask-Claude (page can ask Claude a question),
  live connected data. Pinned "contract" version (e.g. 0.2.47) = runtime API version.
- Versions: every publish is a version; optional `label` ("Draft to legal"); conflict detection —
  a publish over a newer version is refused and hands back the live one to merge; `force` only on
  explicit user instruction. Pages that edit themselves save new versions ("document edited in place").
- Comments: people comment on a published artifact; a comment can be "sent to Claude", arriving
  in the session as a turn; Claude answers in that thread. Sessions "watch" artifacts they publish.
- Private by default; publishing refuses impersonation/fabricated records/credential-phishing.
- Size caps: page ≤16 MB; 255 files/version; 64 MB/version; canvases 512 files/256 MB.

## Design type (Claude Design inside the unified product)
- "Design canvas for websites, landing pages, screens, UI mockups, wireframes, posters, visual social
  posts, visuals, ads, invites and digital media: live artboards laid out on a canvas."
- Capabilities: artifact, assets, comments(composer_only, customAnchors), db(admin write), downloads,
  room (multiplayer), user.
- Content model: `project/canvas.json` index {v:3, title, launch{view: canvas|focused, file, page},
  pages[{id,name}] (≤40), boards{path:{x,y,w,h,title,page,expand:"fill",print:"flow",
  paper:"letter"|"a4",is_interactive,frameless,guides,radius}}, order (z-order), notes, designSystems}.
  One `.dc.html` file per ARTBOARD = a self-contained "Design Component" page: `<x-dc>` markup,
  `<helmet><style>`, `{{hole}}` bindings to `renderVals()` of a `class Component extends DCLogic`,
  `data-props` JSON declaring **tweaks** (e.g. `{"accent":{"editor":"color","default":"#d97757"}}`) that
  show as levers in the editor, `$preview` size; `<sc-for>`, `<sc-if>`, `<dc-import>` child components;
  `<a href="Cart.dc.html">` = **prototype links** opened in **Play** mode; `is_interactive` = working controls.
- The editor: an infinite canvas of artboards (80px gap in rows, 120px between rows), pages,
  **notes**: `title1` headings over groups of artboards (72px bold), **stickies** (colors gray/red/
  orange/green/teal/blue/purple/pink, sizes), plus user-drawn rect/oval/pen/line/arrow/image
  annotations; a **properties panel** that edits inline styles; a **Theme menu** fed by an
  installed design system's tokens; a focused (single artboard) view; **Play** (prototype) mode;
  print/PDF pagination (letter/A4); guides; frameless boards; corner radius; view-state
  ("this artboard"/selection context passed to Claude — view-state.md).
- Design systems are installed INTO a canvas (project/ds/<folder>/tokens.json + record) so the
  Theme menu shows named tokens, not bare hexes; components from a system's bundle are MOUNTED
  (`x-import`), never imitated.
- Craft rules the model follows: no filler/lorem/fake stats (placeholders like [YOUR PRICE]); rationale
  goes in chat not the artboard; 1–3 typefaces, toned neutral ground, 0–2 accents; no AI tropes
  (gradient washes, left-border cards, emoji; Inter/Roboto/Arial); touch targets ≥44px; real
  <button>/<a>/<input>+<label> even in static mockups; 4.5:1 contrast; phone 390×844, desktop 1280–1440.
  "Tell the user what happens on the canvas, never the mechanism." Model is told NOT to self-verify
  (no screenshots/render checks) unless the user asks.
- Revising: users edit live; model re-reads current files first, changes only what's asked; conflict
  → re-read and redo once, then tell the user.

## Design System type
- "a brand's README, tokens (colors across themes, type scale and fonts, spacing, radius),
  components with live previews and guidelines, and assets — one browsable reference agents read and
  build on." Default design system per user/org is applied automatically to every deck/design.
- tokens.json: color.themes (light/dark…) + tokens with per-theme values and a `usage` note each;
  type.fonts/families/groups/styles; spacing; radius; shadow… (list-shaped, not DTCG map).
- components/<Comp>/README.md (guidelines) + preview.html (live preview card, `@dsCard group height`),
  components/bundle.js (window.<namespace>), bundle.css, index.d.ts; assets groups (logos, icons…);
  a Cover; README = brand book (content fundamentals, visual foundations, iconography).
- Built FROM real sources: a codebase (from-code.md) or a design tool (from-design-tool.md, e.g. Figma),
  re-syncable file-by-file; `lastChange {by, at, via, note}` provenance; CI can republish.

## Slides type
- 16:9, 1920×1080 canvas per slide; `project/deck.json` {title, order, sections (outline: one sentence
  per section), faces (≤4 fonts), designSystems}; one `project/slides/<id>.html` per slide =
  one `<section>` with a closed inline-style subset; elements h1–h3/p/ul/ol/table/img/svg/hr,
  `<x-shape>` (rect, rounded, ellipse, diamond, arrows, line), `<x-icon>`, `<x-connector>`,
  `<x-embed>` (small sandboxed live page), speaker notes `<aside>`; **transitions**
  `data-transition="fade|push|magic"` (magic = morph), **build-ins** `data-build-in="fade|rise|pop"`.
  Present mode, page-through, download (PDF / PPTX). Capabilities include room (multiplayer) and a db
  path `notes` readable only by admins. Diagram recipes, layout/type/color craft rules.

## Docs type
- "Living docs — plans, memos, briefs that people and Claude read and edit together." Content lives
  in the Claude Docs service (not files), edited via a connector with block-level ops (create/batch/
  read/update/query), tabs, blocks (prose, tables, charts), comments with threads, @-mentions, live
  collaborative editing; the artifact is the shared viewer. The viewer publishes an
  `<artifact-view-context>` to Claude's conversation: mode (read/edit), tab, node, selected block ids,
  dirty (unsaved words), rev, edits count → Claude knows what the user is looking at / selected.
  Viewer bundle has modules: AgentRunsModal, AskClaude card, RightRail, VersionBar,
  VersionPreviewPane, WidgetPanel, CommentMarkdown, BottomSheet (mobile), animations, askWhy.
  Comments "sent to Claude" arrive as turns; Claude replies in-thread. Capabilities: assets, comments,
  downloads, mcp, room, sample, user.

## Inline visuals (separate from artifacts)
- Claude also renders inline widgets in the transcript (show_widget: SVG/HTML diagrams, charts,
  calculators, interactive widgets with a `sendPrompt()` bridge back to chat), distinct from
  persistent artifacts.
