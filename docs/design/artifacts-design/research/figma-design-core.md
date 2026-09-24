# Figma Design core editor (UI3 era, 2024 – Sept 2026): competitive notes for Juno

Researched 2026-09-23 for the Juno "Artifacts + Juno Design merge" project. Lens: the Figma Design editor that a
Juno Design (a Figma-like scene editor stored as a DESIGN artifact) is measured against.

**Confidence tags**
- **[P]** primary: figma.com blog, help.figma.com, figma.com/release-notes, developers.figma.com, or the locally installed Figma plugin skills and Plugin API typings
- **[S]** secondary: press, third-party guides, or a search-result snippet I could not open myself
- **[C]** community: forum.figma.com threads (used for complaints)
- **[I]** inferred: my own reading or long-standing behaviour I did not re-check this session

**Local primary evidence**
- `…/figma/skills/figma-use/references/plugin-api-standalone.d.ts` (10,191 lines). It contains `textWrapStyle` (Aug 14 2026), `SPACE_EVENLY` (Aug 31 2026) and `EASING`/`TIMING` variable types (Aug 5 2026). It also contains the variable-font types `FontVariationSettings`/`getFontFamilyVariationAxes` (Sep 3 2026). It does not contain `COLOR_OPACITY` or `VariableComposedColor` (Sep 17 2026). So the typings are a snapshot from roughly 3–16 Sept 2026 (fact-check: re-grepped 2026-09-23). Full path: `/Users/liammagnier/.claude/plugins/synced/c2187ff8-a276-4a64-b1e7-cf254a58703a_4beff4b7-d72c-4a9a-a79e-91158ce46804/figma/skills/figma-use/references/plugin-api-standalone.d.ts`.
- The Figma plugin skills `figma-use-motion`, `figma-shaders`, `figma-generative-plugins` and `figma-generate-library`.
- The official Figma MCP server's tool list as exposed in this session: `use_figma`, `get_design_context`, `get_motion_context`, `create_shader`/`update_shader`/`list_shaders`, `create_generative_plugin`, `export_video`, `weave_list_tools`/`weave_run_model`/`weave_find_model`, `generate_diagram`, `search_design_system`, `get_libraries`, `get_variable_defs`, `add_code_connect_map`/`get_code_connect_suggestions`, `upload_assets`, `create_new_file`, `get_screenshot`.

Read alongside `docs/design/artifacts-design/research/claude-primary-evidence.md`. That file is the authoritative account of Claude's typed artifacts: Design, Design System, Docs and Slides.

---

## 0. TL;DR for Juno

1. **Figma's chrome converged on a four-zone layout.** The four zones are:
   - a thin **vertical navigation bar** at the far left: Menu, File, Agents, Assets, Tools, Variables, Notifications
   - a resizable **left sidebar**: pages and layers
   - a fixed-but-resizable **right properties panel**: Design and Prototype tabs
   - a **floating bottom toolbar** holding the tools and the mode switches (Design / Draw / Dev Mode / Motion)

   Floating panels were tried in the 2024 beta and **reverted** before GA. The reasons were cramped canvas, weaker rulers and slower workflows. [P: Figma blog, 2024-10-01](https://www.figma.com/blog/our-approach-to-designing-ui3/) · [P: help](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar)
2. **"Modes" live in one file and one canvas.** Design, Draw, Dev Mode (Shift+D) and Motion are toggles in the toolbar. Each one re-skins the panels and does not open a new document. This is the pattern Juno needs for Artifacts and Design sharing one surface. [P: help toolbar](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar) · [P: Motion blog 2026-06-24](https://www.figma.com/blog/introducing-figma-motion/)
3. **The agent is now a first-class tab.** It sits in the left rail, prompts can start "from any design layer", parallel prompts are allowed, and skills become slash commands. It launched as a gradual beta on 2026-05-20 and opened to everyone (open beta, all plans) on 2026-06-23. From **2026-06-23**, new threads are **visible to collaborators by default** (Full seat + edit access; earlier threads stay private). Blue on-canvas status bubbles appear in Figma's launch imagery; the help centre does not document them. Since 2026-08-26 the chat can open in a separate desktop window (macOS and Windows). [P: blog 2026-05-20](https://www.figma.com/blog/the-figma-agent-is-here/) · [P: blog 2026-06-24](https://www.figma.com/blog/agent-custom-tools-context-skills/) · [P: help, Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P: release note 2026-08-26](https://www.figma.com/release-notes/)
4. **Code is becoming a canvas material.** "Code layers" (closed beta; the blog said "over the next few weeks" and the Config recap said rollout starts in July 2026) are live, interactive code on the canvas. They convert both ways between code and design layers ("extract designs", then one click updates the code layer). Calling this Figma's own "merge Make into Design" is my reading [I]; the blog does say Make code can be brought onto the canvas as a code layer. It is the direct analogue of Juno putting HTML/React artifacts next to design scenes. [P: blog 2026-06-24](https://www.figma.com/blog/code-on-the-figma-canvas/)
5. **The scene graph got much richer in 2025–26.** New additions:
   - grid auto layout
   - slots (GA 2026-06-10)
   - extended variable collections
   - easing and timing variables
   - keyframe motion with timelines
   - shader fills and effects (WebGPU)
   - glass, texture and noise effects, and progressive blur
   - text on path
   - repeat modifiers
   - video paint
   - variable fonts
   - composed colour/opacity variables

   Juno Design cannot match all of this. It should pick a coherent subset that includes auto layout, components, props, slots, variables and modes. [P: local d.ts; dev updates](https://developers.figma.com/docs/plugins/updates/)
6. **Mobile is Figma's gap.** The mobile app cannot edit Design files or Slides decks; for those it only views, comments, runs prototypes and mirrors. The exceptions are FigJam boards, which can be edited on iPad, and Figma Make files, which can be previewed but not created or edited on mobile. [P: help](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app) Claude's merged product promises editing on the phone. Juno can win here.
7. **Recurring complaints cluster in five areas:**
   - space-stealing chrome (the bottom toolbar and the new left rail)
   - extra clicks after UI3 regrouped controls
   - a forced migration (UI2 removed 2025-04-30)
   - slow phased rollouts, so teammates see different UIs
   - memory limits (2 GB per tab; the file locks at 100%)

   [C: forum threads, 2024–2026, below]

---

## 1. Timeline (dated)

| Date | Event | Src |
|---|---|---|
| 2024-01-31 | Dev Mode moves from free beta to paid (announced in a blog post dated 2024-01-25). That release adds **annotations**, a redesigned compare-changes modal and plugin updates. *(Corrected: the ready-for-dev view and focus view came later, at Config 2024.)* | [P](https://www.figma.com/blog/dev-mode-ga/) |
| 2024-06-26 | Config 2024: **UI3** announced ("more immersive canvas", component-centred UI, new icon set). It starts as a limited beta/waitlist rolling out gradually, and users can turn it off. Also: Figma AI beta (Make Designs, visual search, rename layers), Code Connect GA, and the ready-for-dev view and focus view. | [P](https://www.figma.com/blog/config-2024-recap/) |
| 2024-10-01 | "Our approach to designing UI3" is published. It explains the **floating panels reverted to fixed and resizable**, Minimize UI, optional property labels and 200 hand-drawn icons. | [P](https://www.figma.com/blog/our-approach-to-designing-ui3/) |
| 2025-04-30 | **UI2 removed**; UI3 mandatory for everyone (announced in the blog on 2025-03-25: "On April 30, we'll be fully transitioning to UI3"). | [P](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/) · [C](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) |
| 2025-05-07 | Config 2025 adds **grid auto layout**. The current help calls the choice the auto layout **"flow"**; that Config 2025 renamed it from "direction" is not stated in the recap (unverified). It also launches **Figma Draw** (shape builder, dynamic and variable-width strokes, texture/noise, progressive blur, text on path, pattern fills), Figma Make, Sites and Buzz. | [P](https://www.figma.com/blog/config-2025-recap/) |
| 2025-09-18 | The renderer moves from WebGL to **WebGPU**, with a mid-session WebGL fallback and "no regressions". | [P](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) |
| 2025-10-28 | Schema 2025 announces:<br>• **extended collections** (Enterprise, available November)<br>• **slots** (early access)<br>• **Check designs** (early access, Org/Ent)<br>• variables updates: native DTCG 1.0 JSON import/export and a full-screen authoring modal (both "available in November"), plus 10/20 modes on Pro/Org (available immediately). *(Corrected: Figma's recap does not use the label "Variables 2.0".)*<br>• Code Connect UI GA (Org/Ent)<br>• MCP server GA<br>• 30–60% faster mode switching | [P](https://www.figma.com/blog/schema-2025-design-systems-recap/) · [P](https://help.figma.com/hc/en-us/articles/35794667554839-What-s-new-from-Schema-2025) |
| ~2026-01-07 | The **new left navigation bar** starts a phased rollout. Community backlash follows. | [C](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) |
| 2026-03-05 | Slots enter open beta, "starting to roll out to all full seat / Starter+ users today" (a Figma Community Support post). | [P: Figma staff forum post, read 2026-09-23](https://forum.figma.com/ask-the-community-7/release-of-slots-50615) |
| 2026-03-23 | "Simplified instances" are deprecated, so all instance properties and layers are always visible. | [P](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) |
| 2026-04 → 06 | The nav bar and full-screen Variables view are still rolling out in phases, with no opt-in and no timeline given. | [C](https://forum.figma.com/ask-the-community-7/how-to-use-new-variables-ui-52729) · [C](https://forum.figma.com/report-a-problem-6/professional-full-seat-missing-new-ui3-left-navigation-54512) |
| 2026-05-20 | **Figma design agent** (beta) arrives on the canvas and in the left rail. It rolls out gradually via a waitlist to Full seats on Pro/Org/Ent; Collab and Dev seats can use it in drafts. | [P](https://www.figma.com/blog/the-figma-agent-is-here/) · [P release note 2026-05-20](https://www.figma.com/release-notes/) |
| 2026-05-22 | **Grid auto layout GA**, with drag to reorder tracks, automatic positioning and automatic rows. | [P release note "Do more with grid"](https://www.figma.com/release-notes/) |
| 2026-06-01 | **Slots are generally available** in the product, with new slot settings: min/max layers, only allow preferred instances, display empty by default, fill by default. | [P release note "Sharper controls for every slot"](https://www.figma.com/release-notes/) |
| 2026-06-04 | **Check designs** launches (Org/Ent). It flags hard-coded colour, text, radius and spacing and swaps in the right token; replaces contrast failures with WCAG 2.0 AA/AAA-compliant colours; and flags unsubscribed-library tokens and detached components. Fixes take one click. | [P: release note dated 2026-06-04, read from page data](https://www.figma.com/release-notes/?title=check-designs-catch-whats-off-ship-whats-right) |
| 2026-06-10 | **Slots GA in the Plugin API** (`SlotNode`, `SlotSettings`, `createSlot`, `resetSlot`, `limitViolations`). | [P](https://developers.figma.com/docs/plugins/updates/2026/06/10/update/) |
| 2026-06-23 | The agent is "launched to everyone" as an open beta on all plans. Plugin API adds Motion and shaders. New agent threads become visible to collaborators by default. | [P Config recap](https://www.figma.com/blog/config-2026-recap/) · [P help](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P API](https://developers.figma.com/docs/plugins/updates/) |
| 2026-06-24 | Config 2026 announcements (recap and release note dated 2026-06-24; the venue and full event dates are unverified):<br>• **Figma Motion** (open beta)<br>• **shader fills/effects** (open beta)<br>• **code layers** (closed beta)<br>• agent skills, attachments, web search and MCP connectors<br>• **generative plugins** (open beta)<br>• Weave tools in Design (open beta, Pro+)<br>• also beta sign-ups for **3D transforms** and the **agent in FigJam and Slides** | [P](https://www.figma.com/blog/config-2026-recap/) · [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P release note](https://www.figma.com/release-notes/) |
| 2026-07-16 / 07-29 | Plugin API adds video export (MP4, GIF, WebM) and `figma.motion.playheadPosition`. | [P](https://developers.figma.com/docs/plugins/updates/) |
| 2026-08-05 | EASING and TIMING variable types arrive, making motion part of design tokens. | [P](https://developers.figma.com/docs/plugins/updates/) |
| 2026-07-24 | An updated auto layout version "closer to CSS": new frames get it automatically, existing frames stay on legacy unless switched, and legacy stays selectable until January 2027. | [P release note](https://www.figma.com/release-notes/) |
| 2026-08-14 / 08-21 / 08-31 | Text wrap gets `AUTO`/`BALANCE`/`PRETTY` (08-14). Auto spacing gains "Around" and "Evenly" in the UI, with the old default renamed "Between" (release note 08-21); the Plugin API adds `SPACE_EVENLY`/`SPACE_AROUND` on 08-31. | [P](https://developers.figma.com/docs/plugins/updates/) · [P release notes](https://www.figma.com/release-notes/) |
| 2026-08-24 | Vector editing (vector edit mode and Draw) gets an eraser and a paint bucket (drag to fill), with Shift+E for the eraser. MCP authorization can be managed by the enterprise. | [P](https://www.figma.com/release-notes/) |
| 2026-08-26 | The agent chat can **open in a separate window** in the desktop app (macOS and Windows), movable and always visible. | [P](https://www.figma.com/release-notes/) |
| 2026-09-01 | Animated and interactive shaders; community publishing for generative plugins and shaders. | [P](https://www.figma.com/release-notes/) · [P](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) |
| 2026-09-03 / 09-17 | Opacity variables, and composed colour variables (`COLOR_OPACITY` scope). | [P](https://www.figma.com/release-notes/) · [P](https://developers.figma.com/docs/plugins/updates/) |

---

## 2. Editor layout (information architecture)

### 2.1 The five zones
| Zone | Contents | Notes |
|---|---|---|
| **Navigation bar** (vertical rail, far left, new in 2026) | Top to bottom: Figma Menu, **File** (Opt+1), **Agents**, **Assets** (Opt+2), **Tools** (plugins, widgets, shaders, Weave tools), **Variables** (opens the full-window Variables view), **File notifications** (library updates, missing fonts, offline). Labels are on by default and can be toggled under View. | [P help](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar). The libraries modal is Opt+3. Complaints: it uses about 60–100 px and cannot be hidden separately [C Jan 2026](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352), [C Jul 2026](https://forum.figma.com/report-a-problem-6/how-do-you-hide-the-new-leftmost-sidebar-55802) |
| **Left sidebar** (width resizable) | The File tab holds the file menu (rename, version history, colour profile), the **Pages** list, **Find/Replace** and the **Layers** tree. The Assets tab offers component search with grid or list views. | [P](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar) |
| **Properties panel** (right; fixed, resizable) | **Design** and **Prototype** tabs. The header row holds the zoom % dropdown, which includes "Property labels", plus multiplayer avatars and Share/Present. For a component or instance the component section comes first; auto layout width/height/resizing/flow/alignment/gap are merged into one "Layout" section; constraints are expanded by default. | [P blog 2024-10-01](https://www.figma.com/blog/our-approach-to-designing-ui3/) · [P help](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar) |
| **Toolbar** (floating, bottom centre) | Move group (Move, Hand, Scale) · Region group (Frame, Section, Slice) · Shapes (Rectangle, Line, Arrow, Ellipse, Polygon, Star, Image/Video) · Creation (Pen, Pencil) · Text (T) · Comment group (Comment, **Annotation**, **Measurement**; the last two need a Full seat) · **Actions** (Cmd+K) · mode switches: **Draw**, **Dev Mode** (Shift+D) and, from June 2026, **Motion**. Flyout arrows sit next to the group icons. | [P](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar) · [P Motion](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion) |
| **Canvas** | Infinite canvas: pages, then sections, then frames. Space-drag or H to pan; Cmd+scroll or pinch to zoom; arrow keys pan when nothing is selected. | [P](https://help.figma.com/hc/en-us/articles/30925881896727-FD4B-Navigate-Figma-Design-files) · [P](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard) |

### 2.2 Panel states
- **Minimize UI**: Shift+\ in the UI3 guide, and Figma support repeated Shift+\ on 2026-07-08 ([C staff reply](https://forum.figma.com/report-a-problem-6/how-do-you-hide-the-new-leftmost-sidebar-55802)). The help centre instead gives Cmd+Shift+\ for collapsing the nav bar and both sidebars; the sources disagree. The toolbar stays. Staff confirm there is "no way to permanently hide the navigation bar" on its own. **The Design panel appears on selection and disappears on deselect.** [P UI3 guide 2025](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/) · [P help](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar)
  - Complaint: in minimized mode the panel pops over the canvas on selection, and clicks land on auto-layout controls by mistake. There is no option to keep it closed. [C 2024-09-25, staff reply 09-26](https://forum.figma.com/t/allow-manual-open-close-of-right-panel/87945)
- **Hide all UI**: Cmd+\. [P](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/)
- **Property labels** are optional. Tooltips match the aria-labels, which UI3's designers call an accessibility requirement that clashed with their minimalist goal. [P](https://www.figma.com/blog/our-approach-to-designing-ui3/)

### 2.3 Actions menu (command palette)
- Cmd+K opens a searchable palette. It has four areas:
  - **AI**: make designs/prototypes, rename layers, replace content, rewrite, image generation and background removal
  - **productivity commands**: type "align" and similar
  - **asset search**: AI visual search by selection, screenshot or text
  - **plugins and widgets**

  It shows recent actions and needs `can edit`. [P](https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design)
- Agent **skills appear as slash commands** in a commands menu. [P 2026-06-24](https://www.figma.com/blog/agent-custom-tools-context-skills/)

---

## 3. Canvas, tools, layers, keyboard

- **Layers panel**:
  - Type icons for frame, group, component, instance, text, shape, image, auto layout, section, GIF/video and **slot**.
  - New layers go on top.
  - There is a Collapse layers button.
  - Each row has hover toggles for visibility and lock.
  - Tree order is z-order.
  - "Highlight layers on hover" can be turned on in preferences.
  - Layer search sits in the File tab.

  [P](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar)
- **Memory in layers**: View → Memory usage adds a meter to the left sidebar, and "Show memory in layers panel" gives a per-layer cost. [P](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)
- **Keyboard-only use**:
  - The **keyboard box-selection tool** (Opt+Space) shows a **pink cursor** that you move with the arrow keys; Enter selects.
  - Tab and Shift+Tab walk through child layers.
  - F6 (Mac) or Ctrl+F6 moves focus to the toolbar, where arrow keys and Enter pick a tool.
  - Ctrl+Shift+? opens the shortcuts panel, which has a Layout tab for keyboard layouts.
  - Preferences → Accessibility "adapts canvas content for screen readers".
  - Lines, vector paths, connectors and tables still need a pointer.

  [P](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- **Smart eyedropper** (I): it detects styles and variables, and Shift+Cmd turns the picked colour into a variable. **Rename**: Cmd+R. [P](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/)
- **Draw mode** (May 2025, extended Aug 2026):
  - rewritten vector editing with multi-select across vectors
  - shape builder
  - dynamic and variable-width strokes, plus brushes (scatter and stretch)
  - texture and noise effects
  - progressive blur
  - text on path
  - pattern fills
  - eraser and paint bucket (drag to fill)
  - vector tool options now sit in a selection menu above the toolbar, with sliders instead of fly-outs

  [P 2025-05-07](https://www.figma.com/blog/config-2025-recap/) · [P 2026-08-24](https://www.figma.com/release-notes/). The API types confirm it: `BrushStrokeProperties`, `ScatterBrushProperties`, `DynamicStrokeProperties`, `VariableWidthStrokeProperties`, `TextPathNode`, `TransformGroupNode` with `LinearRepeatModifier`/`RadialRepeatModifier`, `NoiseEffect*`, `TextureEffect`, `BlurEffectProgressive`, `GlassEffect` [P local d.ts].
- Long-standing canvas conveniences such as Shift+1 (zoom to fit), Shift+2 (zoom to selection), Shift+R (rulers), multi-edit and pixel preview: [I; not re-verified this session].

---

## 4. Layout: auto layout, wrap, grid, constraints

- **Auto layout** (Shift+A):
  - Flows: vertical, horizontal (horizontal can **wrap**) and **grid**.
  - Sizing: hug, fill or fixed, each with min/max.
  - Gap can be a number, auto (space-between, and from 2026 also space-around and space-evenly) or **negative**.
  - Padding and a 9-grid alignment control.
  - **Ignore auto layout**, which works like absolute positioning.
  - Baseline alignment.
  - **On-canvas handles** for padding and gap.
  - AI "Suggest auto layout".

  [P](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout) · [P API 2026-08-31](https://developers.figma.com/docs/plugins/updates/)
- **Grid flow** (Config 2025 beta; GA 2026-05-22; all plans):
  - **Setup**: a grid picker in the right sidebar sets columns × rows (rows default to `auto`).
  - **On-canvas track editing**: hovering the frame edges shows **blue pills per track** with sizing labels. Click a label to edit, drag an edge to fix a size, Cmd or Shift multi-selects tracks, a grabber icon reorders tracks, and select-then-Delete removes one. Track-count fields accept math (`+ - * /`).
  - **Track sizing**: Fixed, **Fill (1fr; type "A")**, Hug, and min/max.
  - **Spans**: a child must be set to Fill first; then resize it until it snaps to cells, or use the Column span / Row span fields.
  - **Other controls**: per-cell alignment in the Position section, row and column gaps (can be bound to variables), and a toggle for automatic positioning so empty cells can be kept.

  [P](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow)
  - The API mirrors this: `layoutMode: 'GRID'`, `gridRowCount`/`gridColumnCount`, `GridTrackSize{FLEX|FIXED|HUG}` (HUG = CSS `fit-content(100%)`), `gridAutoTracks: 'NONE'|'ROWS'`, `reorderRows()`/`reorderColumns()`. [P local d.ts L5609–5621, L5156, L5668–5921]
  - **Gaps against CSS Grid (2025 beta-era analysis, partly outdated)**: Nearform (2025-06-27, during the beta) found no percentages, no `fr` multiples, no `repeat(auto-fill)`, no named areas, no subgrid and one element per cell, with "Auto" behaving like 1fr. [S](https://nearform.com/digital-community/figmas-new-grid-auto-layout-what-it-does-and-doesnt-yet-do/)
    - Two of those gaps have since closed. **Fix (corrected 2026-09-23):** the current help documents `fr` multiples (1fr, 2fr…) and **Hug contents** for tracks, and the API has `HUG` tracks. [P](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow)
    - Whether percentages, auto-fill, named areas, subgrid and multi-item cells are still missing was not re-verified (unverified).
    - In the 2025 feedback thread, users' top asks were **hug for tracks**, item swapping, auto-removal of rows and variable gaps. Hug tracks, drag-reordering and auto rows have since shipped (Grid GA 2026-05-22). Users also reported slowdowns on grids with 100+ columns. [C 2025-05-07 thread](https://forum.figma.com/share-your-feedback-26/config-2025-grid-auto-layout-flow-let-s-hear-what-you-think-40316) · [P release note 2026-05-22](https://www.figma.com/release-notes/)
- **Constraints**:
  - Horizontal options: Left, Right, Left & Right, Center, Scale. Vertical: Top, Bottom, Top & Bottom, Center, Scale.
  - They live under a Constraints button in the **Position** section.
  - They are unavailable inside auto layout frames and on layers outside frames.
  - Hold Cmd while resizing to ignore them.

  [P](https://help.figma.com/hc/en-us/articles/360039957734-Apply-constraints-to-define-how-layers-resize)
- **Layout guides**: the old "layout grids" (columns, rows, grid) are now called layout guides in UI3. They can be bound to variables and saved as Grid styles. [P help](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar) · [P local d.ts `GridStyle`, `setBoundVariableForLayoutGrid`]

---

## 5. Components, variants, properties, slots

- **Property types**: Boolean (layer visibility only), Instance swap (with **preferred values**), Text (no rich text), Variant, and **Slot**. [P](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties)
  - **Creating a property**: select a component, use the Properties section's **+** menu, configure it in a modal, then bind layers through **purple property pills** or icons.
  - **On instances**: all properties show at the top of the properties panel. "Expose properties from nested instances" lifts child controls up so you don't have to deep-select.
  - **Simplified instances**, which hid them, are **deprecated from 2026-03-23**.
- **Slots** (early access 2025-10 → open beta 2026-03-05 → **GA announced 2026-06-01 in release notes; Plugin API GA 2026-06-10**; all plans):
  - **Create**: pick one of three ways:
    - convert a nested frame (right-click or **Cmd+Shift+S** "Convert to slot")
    - "Wrap in new slot"
    - Create property → Slot, then assign it
  - **On instances**: a **pink box** marks the slot on hover. An optional "display empty slots" setting keeps the marker visible.
  - **Filling a slot**: draw into it with any tool, paste or duplicate, drag from the Assets panel, or use the **"Add instances"** button, which filters to preferred instances.
  - **Limits**: min/max layer counts show a **green check** when met and an **orange warning** when broken. They guide but do not block.
  - **Options**: "Only allow preferred instances"; "fill on counter-axis" stretches inserted items.
  - **Reset**: "Reset slot" restores the component's original contents.
  - **Restrictions**: a slot cannot be bound to the component's top-level layer, and component properties cannot be applied to layers inside a slot.

  [P](https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma) · [P API](https://developers.figma.com/docs/plugins/updates/2026/06/10/update/). API: `SlotSettings{stretchChildOnInsert, displayEmptyByDefault, minChildren, maxChildren, allowPreferredValuesOnly}` and `SlotNode.limitViolations: 'BELOW_MIN'|'ABOVE_MAX'|'HAS_NON_PREFERRED'` [P local d.ts L8541–8716].
- **Performance note**: Figma loads **every component in a component set**, which makes variant switching fast but means thousands of variants cost memory. *(Corrected: the help does not say "loaded in the background".)* Figma's own advice is to use component properties, including boolean properties, so fewer variants are needed. [P](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)
- **Component playground** ("Explore component behavior") in Dev Mode lets you try variants without editing the file. [P](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode)

---

## 6. Variables, modes, styles

- **Variables view** (2026 rollout): **edge-to-edge**, opened from the Variables tab in the nav bar. Its layout:
  - a collapsible sidebar of collections and groups, with drag-to-reorder and nesting
  - a table with a name column and **one value column per mode**
  - search by name, value or group, and filter by type
  - bulk edit of scopes and publishing visibility
  - copy/paste across files, and Shift+Enter to duplicate
  - a right-click menu for create, delete and alias
  - Minimize/Expand buttons and resizable edges

  [P](https://help.figma.com/hc/en-us/articles/15145852043927-Create-and-manage-variables-and-collections)
  - Complaint: the full-screen view blocks the artboards, so you cannot copy values from the canvas. [C Jan 2026](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352)
- **Types**:
  - `BOOLEAN | COLOR | FLOAT | STRING` plus **`EASING` and `TIMING`** (from 2026-08-05) [P local d.ts L9097]
  - composed colour and opacity (2026-09-17) [P](https://developers.figma.com/docs/plugins/updates/)
  - opacity aliasing "while the color stays linked to your library" (2026-09-03) [P](https://www.figma.com/release-notes/)
- **Scopes** decide which pickers show a variable. **Code syntax** holds WEB/ANDROID/iOS names for Dev Mode. `hiddenFromPublishing` hides one. [P help; P local d.ts L9103–9354]
- **Modes**:
  - Nodes inherit their parent's mode automatically, or a mode can be pinned per node and collection (`explicitVariableModes` vs `resolvedVariableModes`). [P local d.ts L4200–4237]
  - Limits: **10 modes** per collection on Professional, **20** on Organization. [P Schema 2025](https://help.figma.com/hc/en-us/articles/35794667554839-What-s-new-from-Schema-2025)
  - Switching modes became 30–60% faster, and heavy swaps went from 3500 ms to 350 ms. [P](https://www.figma.com/blog/schema-2025-design-systems-recap/)
- **Extended collections** (Enterprise plan; the help says anyone with `can edit` access can extend. The earlier "Full seats" wording is unverified):
  - A brand collection **inherits** its parent's variables, modes, names, scopes and order, and **overrides only values**.
  - Parent changes flow through unless a value is overridden. Overridden values are highlighted in blue, and "Reset change" reverts an override.
  - You cannot add variables or modes in an extension, or change a variable's description or scope.
  - Colour value and opacity count as one unit: overriding either one marks both as overridden.
  - Chains are allowed (C extends B extends A), and the API exposes `rootVariableCollectionId` and `variableOverrides`.
  - Accepting an update to extended collections clears the modes previously set on designs.

  [P](https://help.figma.com/hc/en-us/articles/36346281624471-Extend-a-variable-collection) · [P local d.ts L9413–9447]
- **Variables in prototypes**: the API includes expressions, conditionals and a `SET_VARIABLE_MODE` action. [P local d.ts L3349–3418]
- **JSON import/export** follows the W3C DTCG 1.0 spec. [P](https://www.figma.com/blog/schema-2025-design-systems-recap/)
- **Styles** remain: Paint, Text, Effect and Grid styles, including folder reordering. [P local d.ts L689–755]

---

## 7. Libraries, publishing, design-system hygiene

- **Publishing**:
  - Assets tab → Libraries icon → "This file" → **Publish**.
  - A modal lists the changed components, styles and variables. You can deselect items and add a **description**, which subscribers see.
  - Org/Ent can target a team, org or workspace.
  - Paid plans only; you need a Full seat, and the file must be outside drafts.

  [P](https://help.figma.com/hc/en-us/articles/360025508373-Publish-a-library)
- **Subscribers**: a **blue badge** on the library icon, then a review-updates modal. [P ibid.]
- **Branches**: you can only publish from the main file. [P](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching)
- **Check designs** (2026-06-04, Org/Ent):
  - flags hard-coded colour, text, radius and spacing, and swaps in tokens with one click
  - suggests WCAG 2.0 AA/AAA-compliant colours for contrast problems
  - flags components from unsubscribed libraries and detached components

  [P: release note dated 2026-06-04, verified from page data 2026-09-23](https://www.figma.com/release-notes/?title=check-designs-catch-whats-off-ship-whats-right) · help: https://help.figma.com/hc/en-us/articles/39592284074263-Check-designs-in-Figma · announced at [P Schema 2025](https://www.figma.com/blog/schema-2025-design-systems-recap/)
- **Code Connect**: the UI version (GA for Org/Ent) connects GitHub and uses AI to match files; the CLI version defines real snippets through templates. Both feed the **MCP server**, and Dev Mode shows the resulting snippets. [P](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect)

---

## 8. Dev Mode

- **Entry**: a toolbar toggle or **Shift+D**, which also exits. Dev Mode is the same file with different panels. [P](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode)
- **Left panel**: a "Ready for development" list with last-edit times, plus layers.
- **Right Inspect tab**:
  - Compare changes
  - component metadata and the component playground
  - **Code Connect snippets**
  - properties shown as **Code** (CSS / iOS / Android / plugin codegen, with units) or as a **List**
  - styles and variables
  - auto-detected assets
  - export
- **Plugins tab**: Jira, Storybook, GitHub. [P ibid.]
- **Motion tab** (2026): a read-only timeline, with animation code to copy as CSS, JSON or motion.dev/React. [P](https://www.figma.com/blog/introducing-figma-motion/)
- **Statuses**:
  - **Ready for dev** is available on all plans; **Completed** is Org/Ent only.
  - A **Changed** state is set automatically. Library-driven instance updates and variable or style value changes do not trigger it.
  - You set a status from the **section or frame header on the canvas** ("Mark as ready for dev"), from the properties panel or from Dev Mode views.
  - Notifications go by email, desktop, mobile push, Slack or Teams, grouped per hour.

  [P](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications)
- **Focus view**:
  - one design, centred
  - a **per-design version history**
  - a "Mark as completed" button, which writes a history entry
  - temporary frame resizing and variable-mode switching that do not change the file
  - "See all ready for dev", "Inspect on page" and Back
  - "Copy link to focus view"

  [P](https://help.figma.com/hc/en-us/articles/23919923330455-Dev-Mode-focus-view)
- **Compare changes**:
  - **Side-by-side** or **overlay** (an opacity slider and a click to toggle).
  - The layer tree marks layers as **Edited/Added/Deleted**.
  - Properties and code are diffed before/after.
  - Shift-click two components to compare them.
  - Needs a paid plan and a Full or Dev seat.

  [P](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode)
- **Annotations and measurements** (toolbar comment group):
  - Annotations stay attached to layers and **update live** when the design changes.
  - They pin specific properties (the `AnnotationProperty` types include `gridRowCount` and others).
  - Colour-coded **categories** come in eight colours.
  - They **auto-hide at low zoom**.

  [P 2024](https://www.figma.com/blog/dev-mode-ga/) · [P local d.ts L1223–1242, L6902–6990]

---

## 9. Collaboration: comments, multiplayer, presence

- **Comments**:
  - C enters comment mode. Click to drop a pin or **drag to comment on a region**.
  - A comment attaches to its **top-level frame, component or group** and moves with it. It does not attach to nested layers.
  - @mentions reach people and **user groups**.
  - Up to 5 images or GIFs per comment, emoji reactions on hover, and markdown-ish formatting (bold, italics, strikethrough, lists).
  - Resolve closes a thread.
  - Limit: 100 comments per hour.
  - **Time-stamped comments** exist in Motion.
  - On mobile, long-press to comment.

  [P](https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files)
- **Multiplayer cursors** are coloured per user, and avatars sit in the header. [P](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight)
- **Observation (follow)**:
  - Click an avatar to follow that person.
  - Followers see a **border around the canvas in that person's avatar colour** and a top banner saying who they follow, with "Stop following".
  - A presenter's avatar gets a **dashed border** and a follower count.
- **Spotlight**:
  - Avatar menu → "Spotlight me". Others can send "Ask to spotlight", which the presenter accepts or declines.
  - Only the canvas is shared (zoom and page changes), not the toolbar or panels.

  [P](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight) · [P Slides variant](https://help.figma.com/hc/en-us/articles/24260248467735-Spotlight-yourself-or-other-presenters)
- **Cursor chat**:
  - **/** (or right-click) opens an empty speech bubble **attached to the cursor**. Each message is 52 characters max.
  - The bubble **stays 5 s after you stop typing**. Enter starts a new line and replaces the previous one.
  - Esc or a click exits. Nothing is logged.

  [P](https://help.figma.com/hc/en-us/articles/4403130802199-Use-cursor-chat-in-Figma-Design)
- **Audio**:
  - Avatar menu → "Start conversation"; others press "Join conversation". A green "Connected" label confirms.
  - While someone talks, **their avatar bubbles up in the toolbar and their cursor gets an audio pulse scaled by mic volume**.
  - One conversation per file (not re-checked). The help lists support on Professional, Education and Organization plans; audio is not available on mobile, in presentation view or in Figma for Government.
  - Closed captions in the desktop app.

  [P](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team)
- **Viewer history** shows who has viewed a file. [P section index](https://help.figma.com/hc/en-us/sections/360006780134-Multiplayer-tools)
- **Agent threads as shared presence**: since 2026-06-23, new design-agent conversations are **visible by default to people in the org or team who have a Full seat and edit access to the file**. Earlier threads stay private, and any thread can be made private. Blue status bubbles ("Creating QR code plugin", "Generating code layer") appear in the launch blog's mockup imagery. The help centre does not document them, so the exact UI is unverified. [P](https://www.figma.com/blog/agent-custom-tools-context-skills/) · [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) The Plugin API also exposes `node.placeholder`, which is **"Show or hide the in-progress shimmer overlay"** on nodes being generated. [P local d.ts L10150–10153]

---

## 10. Branching, merging, version history

- **Version history**:
  - File menu → Show version history opens the list in the right sidebar.
  - An **autosave checkpoint every 30 min**. Autosaves between named versions **collapse** into a group.
  - Versions can be named and described. "Restore this version" is in the ⋯ menu.
  - Starter plans and drafts keep 30 days; paid plans keep everything.

  [P](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
- **Branching** (Org/Ent, Full seat):
  - **Create**: file menu → "Create branch…" makes an exact copy. The sidebar shows `File name › Branch name`, and the URL gets `/branch/<id>`.
  - **Update from main**: an all-or-nothing pull; you cannot cherry-pick.
  - **Review**: statuses are In review (grey), Changes suggested (yellow) and Approved.
  - **Merge**: a per-page **side-by-side or overlay** diff, with conflicts resolved one by one (keep main or keep branch).
  - **Manage**: a Branches modal with Active, Archived and Yours tabs.
  - **Limits**: **comments do not carry across** from main to branch or back after merge, and publishing works only from main.
  - **History**: checkpoints are written on create, before merge and on merge.

  [P](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching) · [P review](https://help.figma.com/hc/en-us/articles/5691414603543-Request-a-branch-review)

---

## 11. Prototyping and Motion (the time dimension)

- **Prototype transitions**:
  - Types: `DISSOLVE`, `SMART_ANIMATE`, `SCROLL_ANIMATE`, plus directional `MOVE_IN/OUT`, `PUSH` and `SLIDE_IN/OUT` with `matchLayers`.
  - **Easing**: ease-in/out/in-out, linear, the back variants, custom cubic bezier, **spring presets `GENTLE`, `QUICK`, `BOUNCY`, `SLOW`**, and `CUSTOM_SPRING` with mass, stiffness, damping and initialVelocity.
  - Triggers: click, hover, press, drag, after-timeout, mouse up/down/enter/leave with delay, **key or gamepad** (Xbox, PS4, Switch Pro), media hit and media end.
  - Actions: navigate, swap, overlay, scroll-to, change-to, and set variable mode.

  [P local d.ts L3344–3565]
- **Figma Motion** (open beta, 2026-06-24):
  - **Where**: a **Motion** mode in the toolbar, alongside Design, Draw and Dev. It opens a **timeline across the bottom** of the screen, which you can resize by its top edge or collapse.
  - **Timeline controls**: Play/Pause on **Space**, an **auto-keyframe** toggle, a current-time field (typing a time jumps there), a duration field (**default 2000 ms**), a seconds/milliseconds toggle, playback modes **Loop / Once / Ping-pong**, and collapse/expand for all tracks.
  - **Tracks**: grouped by layer. Drag a track to shift it in time; drag its handles to stretch it.
  - **Zoom**: a slider, pinch, or Cmd+wheel. [P](https://help.figma.com/hc/en-us/articles/41405906446999-Use-the-Figma-Motion-timeline)
  - **Animation styles** (Fade, Move, Scale, Rotate, Resize…) can be stacked to play together or dragged to play in sequence. **Custom styles are "coming soon".**
  - On canvas you can edit the **anchor point** (rotation and scale pivot, centre by default) and the **motion path** (position keyframes shown as a sequence of dots). [P anchor point](https://help.figma.com/hc/en-us/articles/41352588622615-Move-a-layer-s-anchor-point) · [P motion path](https://help.figma.com/hc/en-us/articles/41780233501591-Edit-an-object-s-motion-path)
  - **Motion as a design system**: **animated components** carry motion across screens and files, and **easing and timing variables** have modes that switch per page.
  - **Agent**: it generates real keyframes from prompts.
  - **Export**: MP4, WebM, GIF or animated SVG. Lottie is "in the future". [P Config help FAQ]
  - **Handoff**: Dev Mode has a read-only timeline for scrubbing and inspecting, and can copy the motion as CSS, JSON or motion.dev. [P Explore Motion help]
  - **3D transforms** (z-axis rotation) are announced as "coming soon", with a waitlist.
  - **Plans**: open beta for Full seats on all plans, and Starter gets limited exports. Publishing animated components, generating animations with the agent and high-resolution video exports need a Full seat on a paid plan. Not available on Figma for Government.

  [P](https://www.figma.com/blog/introducing-figma-motion/) · [P](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion) · [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026)
  - **API**:
    - **Keyframes and styles**: `manualKeyframeTracks`, `applyAnimationStyle`, `timelines`, `setTimelineDuration`, `figma.motion.figmaAnimationStyles()`, `playheadPosition`.
    - **Easing**: `MotionEasing` adds **`HOLD`** (step). Springs are **normalized to `bounce` 0–1**, and `physicalSpringToNormalized()` converts from physical parameters.
    - **Animatable fields**: translation X/Y, rotation, scale, opacity, per-corner radius, **auto layout gap and padding** (including grid row and column gap), fill and stroke colours, and effect parameters (glass refraction, specular light, chromatic aberration, noise size and so on).
    - **Limits**: top-level frames cannot be animated, only their descendants. The API is gated behind the `metronome` flag.

    [P local skill figma-use-motion SKILL.md, motion-easing.md, motion-patterns.md]

---

## 12. New materials (2025–26): shaders, generative plugins, code layers, Weave, agent

- **Shader fills and effects** (open beta 2026-06):
  - **Creation**: prompt the agent or give it a reference image; it builds a WebGPU shader. The result is a native **shader properties panel** plus **on-canvas controls**, with no code.
  - **Effect vs fill**: effects transform the layer's existing content, while fills act as a new material.
  - **Composition**: the behind-the-build blog lists "Composability, so one shader's output feeds the next" as a goal of the designer's early "FigGPU" prototype. That the shipped feature chains shaders this way is unverified.
  - **Export and variables**: PNG for a fixed frame, MP4 in Motion, and raw JS/WGSL code via MCP. [P Config help] Every shader property value can be a `VariableAlias` binding. [P local d.ts L2699] Static shader properties can be keyframed in Motion mode. [P local skill figma-shaders]
  - **Dev Mode**: shader effects "do not currently appear in Dev Mode". [P Config help]
  - **Animated and interactive shaders** (time and mouse-reactive) since 2026-09-01, alongside Community publishing, org publishing (Org/Ent) and a code viewer. [P release note 2026-09-01]

  [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) · [P local d.ts `ShaderPaint`/`ShaderEffect`, `listAvailableShaders`, `importShaderById`]
- **Generative plugins**:
  - Describe the tool, its controls and its parameters, and the agent writes it.
  - Plugins are **hosted and run inside the file**. At launch anyone with access to the file could use them, and they were also available across the creator's own design files. They are built on **PropsKit**, a web-components UI kit in Figma's own style, so the generated UIs look native.
  - They open from the **Tools** tab in the left rail. Community publishing since 2026-09-01.

  [P](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) · [P release notes](https://www.figma.com/release-notes/)
- **Code layers** (closed beta, waitlist; rolling out "over the next few weeks" from 2026-06-24, "starting in July" per the Config recap):
  - **Creation**: add a code layer from the toolbar, create one from an existing frame, have the agent generate it, **import a GitHub repo or upload a local folder**, or start from a template or prompt. A Make file's code can also be brought onto the canvas as a code layer.
  - **Editing**: moving, adjusting and resizing elements on the canvas gets "an immediate code response", and a code editor lets you annotate or edit directly. Prompts create new versions and keep the originals. Changes can be pushed to the repo.
  - **Round trip**: "Extract designs" converts the current state (a single screen, a specific state or a full flow) back into editable Figma layers. After you edit them, "one click updates the code layer with your edits".
  - Code layers can be commented on and prompted in shared files.

  [P](https://www.figma.com/blog/code-on-the-figma-canvas/)
- **Weave tools in Design** (open beta, Pro+): AI image operations such as background swap, logo placement and aspect-ratio changes. Weave node workflows can take Figma frames as input (2026-09-17). [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P release notes](https://www.figma.com/release-notes/)
- **Agent**:
  - **Entry points**: the canvas and the left-rail **Agents** tab. Prompts can start from any layer, and **@-mentions** reference tokens, variables and components.
  - **Behaviour**: **parallel prompts**, bulk edits, and "your most frequently and recently used components as a starting point".
  - **Context**: skills (slash commands), **MCP connectors** (the blog names GitHub, Atlassian, Slack, Linear and Hex "and other tools"; *corrected: Notion and Excel were not named in the sources checked*), attachments (Figma files, images, text/code, PDFs, spreadsheets), and web search (from 2026-06-18).
  - **Seats and plans**: during the open beta the agent is on all plans (help, 2026-06). Full seats with edit access can edit; View, Dev and Collab seats and view-only users can chat without editing. At the 2026-05-20 launch it was Pro/Org/Ent Full seats, with Collab and Dev able to edit in drafts. No AI credits are consumed during the beta.
  - Threads are visible to collaborators by default from 2026-06-23 (see §9).
  - The chat can open in a **separate desktop window** (2026-08-26; macOS and Windows).

  [P](https://www.figma.com/blog/the-figma-agent-is-here/) · [P](https://www.figma.com/blog/agent-custom-tools-context-skills/) · [P](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026) · [P](https://www.figma.com/release-notes/)
- **External agents writing to the canvas**: through MCP, `use_figma` runs Plugin API JavaScript inside a file. The API is shaped for agents:
  - `node.query(selector)` is a **CSS-like selector** over the scene graph, with `.set()`, `.values()` and `.tree()`.
  - `node.screenshot()` captures a node.
  - `node.placeholder` shows the shimmer on nodes still being built.

  [P local d.ts L10114–10162; local skill figma-use]

---

## 13. Performance and scale

- **Memory**: the limit is **2 GB of active memory per tab**, and it applies in the desktop app too.
  - A meter under View → Memory usage.
  - At **90%**, a red alert that cannot be dismissed.
  - At **100%**, the **file locks** and you must enter **recovery mode** to cut usage below 90%.

  [P](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)
- **Dynamic page loading**: pages load on demand. [P ibid.] The Plugin API has to call `setCurrentPageAsync` to load a page. [P local skill]
- **WebGPU renderer** (2025-09-18):
  - The C++ renderer is compiled to WASM. WebGPU is used where supported, with WebGL kept as the fallback.
  - A dynamic fallback swaps to WebGL mid-session on device loss or failure, and devices with high fallback rates are blocklisted.
  - Gains were an improvement on some device classes and neutral on others, with "no regressions".
  - Compute-shader blur, MSAA and RenderBundles are planned.

  [P](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) The shaders blog calls Figma's canvas "enterprise-scale, tile-rendered" and says shaders run as sandboxed WebGPU pipelines. *(Corrected: it does not say shaders and plugins specifically use tile rendering.)* [P](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/)
- **Complaints**:
  - Figma used 12 GB of RAM on a 16 GB Mac mini, with lag on simple actions (2025-11-16). Staff pointed the user to the memory tips and a Technical Quality team form. *(Corrected from "support escalated it".)* [C](https://forum.figma.com/report-a-problem-6/figma-renderer-using-a-lot-of-memory-47410)
  - Large variant sets are slow. [C](https://forum.figma.com/suggest-a-feature-11/optimize-performance-in-large-variant-sets-28624)
  - Grids with 100+ columns lag. [C](https://forum.figma.com/share-your-feedback-26/config-2025-grid-auto-layout-flow-let-s-hear-what-you-think-40316)

---

## 14. Accessibility

- **Keyboard**: keyboard box-select (pink cursor), Tab through children, F6 to reach the toolbar, arrow-key panning, and a shortcuts panel with keyboard-layout settings. Some drawing still needs a mouse. [P](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- **Screen readers**: a preference adapts the canvas for assistive technology. [P ibid.]
- **Labels**: UI3's optional labels and aria-matched tooltips. [P](https://www.figma.com/blog/our-approach-to-designing-ui3/)
- **Contrast**: Check designs flags contrast problems (WCAG AA/AAA). [S](https://www.figma.com/release-notes/?title=check-designs-catch-whats-off-ship-whats-right)
- **Complaints** about UI3's own readability: small, thin type; checkboxes whose state is unclear; inputs that look selected when they are not. [C Mar–Apr 2025](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150)

---

## 15. Mobile

- The **Figma mobile app** (iOS 16+, Android 8+) can **view** Design files, **comment** (long-press), run **prototypes** and **mirror** frames. **"It's not possible to edit Figma Design files or Figma Slides decks using the mobile app."** Audio is also unavailable on mobile. Exceptions: **FigJam boards can be viewed and edited on iPad**, and **Figma Make files can be previewed and shared** on mobile, with comment replies, but not created or edited (release note 2026-04-22). [P](https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app) · [P](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team)

---

## 16. Motion patterns in Figma's own UI (what animates, and how)

Figma rarely documents the timing of its own interface. Durations are given only where a source states them.

| Pattern | Detail | Src |
|---|---|---|
| Transient properties panel in Minimize UI | The panel **appears on selection and disappears on deselect**, sliding in over the canvas. That is exactly what users complain about. | [P](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/) · [C](https://forum.figma.com/t/allow-manual-open-close-of-right-panel/87945) |
| Cursor chat bubble | The bubble follows the cursor, persists **5 s after typing stops**, then disappears. A new line replaces the old message. | [P](https://help.figma.com/hc/en-us/articles/4403130802199-Use-cursor-chat-in-Figma-Design) |
| Audio presence | The speaker's **avatar "bubbles up"** in the toolbar, and their **cursor pulses with mic volume**. | [P](https://help.figma.com/hc/en-us/articles/1500004414622-Use-audio-to-chat-with-your-team) |
| Follow / spotlight | Following adds a **coloured border in the leader's colour** around the canvas and a top banner. The presenter's avatar gets a **dashed ring**. The follower's view tracks the leader's zooms and page switches; whether that is animated or a cut is not documented [I]. | [P](https://help.figma.com/hc/en-us/articles/360040322673-Present-to-collaborators-using-spotlight) |
| Agent progress on canvas | **Blue status bubbles** ("Generating code layer…") sit next to the layers being worked on; this comes from blog mockup imagery only and is not in the help centre (unverified as shipped UI). A **shimmer overlay** covers in-progress nodes (`node.placeholder`, verified in the d.ts). | [P](https://www.figma.com/blog/agent-custom-tools-context-skills/) · [P local d.ts] |
| Hover affordances | **Pink box** around slots; **blue pills** on grid tracks; **pink** keyboard-selection cursor; padding and gap handles on auto layout; "highlight layers on hover" (optional). | [P slots](https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma) · [P grid](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow) · [P keyboard](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard) |
| Validation feedback | Slot min/max shows a **green check** when met and an **orange warning** when broken. Neither blocks the user. | [P](https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma) |
| Annotations | Annotations **auto-hide at low zoom levels** so the canvas stays readable. | [P](https://www.figma.com/blog/dev-mode-ga/) |
| Prototype transitions | Smart Animate, directional push/slide/move, and dissolve, with bezier or **spring presets Gentle / Quick / Bouncy / Slow** or a custom spring (mass, stiffness, damping, velocity). | [P local d.ts] |
| Motion authoring | Keyframe tracks with a **2000 ms default** duration; Loop, Once or Ping-pong; springs normalized to **bounce 0–1**; `HOLD` step easing; auto-keyframe while scrubbing. | [P](https://help.figma.com/hc/en-us/articles/41405906446999-Use-the-Figma-Motion-timeline) · [P local skill] |
| Speed ethos | "**Speed is a feature**." The UI3 team rejected changes that added clicks, for example returning "Clip content" to a single checkbox. | [P](https://www.figma.com/blog/our-approach-to-designing-ui3/) |

---

## 17. What designers praise and what they complain about

**Praise**
- More canvas space; a cleaner, component-centred panel; merged Layout controls; labels that can be turned on. [P](https://www.figma.com/blog/our-approach-to-designing-ui3/)
- Slots end the detach-to-customize habit. [P](https://www.figma.com/blog/schema-2025-design-systems-recap/)
- Grid finally arrived, although it is basic. [C](https://forum.figma.com/share-your-feedback-26/config-2025-grid-auto-layout-flow-let-s-hear-what-you-think-40316)
- Motion makes animation part of the design system: "Atomic design is now atomic motion design". [P, quoting Atlassian](https://www.figma.com/blog/introducing-figma-motion/)

**Complaints**
- **Bottom toolbar**: it sits "in the middle of everything", clashes with the macOS Dock, gets lost among content, and cannot be docked or moved. [C Oct 2024](https://forum.figma.com/suggest-a-feature-11/allow-us-to-dock-move-the-new-ui3-toolbar-7861/index8.html)
- **More clicks**:
  - Clip content briefly became a dropdown; it was reverted.
  - Creating a component property takes more steps.
  - Controls "move depending on component complexity".
  - Nested properties get pushed off-screen.

  [C UI3 feedback](https://forum.figma.com/share-your-feedback-26/ui3-feedback-3058/index2.html) · [C 2025](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150)
- **Forced migration** on 2025-04-30, which users called paralysing. Figma answered with late fixes: the "Reset others" icon, boolean-operation strings, a de-duplicated overflow menu, the mask icon, and restoring the old Tidy up. [C](https://forum.figma.com/share-your-feedback-26/forcing-ui3-on-us-is-a-huge-mistake-let-us-choose-april-30-39150) · [S search summary]
- **New left rail (2026)**: permanent, redundant, cannot be hidden separately, bulky padding. The lock/hide icons briefly vanished. The full-screen Variables view hides the canvas. [C Jan 2026](https://forum.figma.com/share-your-feedback-26/figma-your-new-left-hand-menu-panel-is-a-disaster-7th-jan-2026-49352) · [C Jul 2026](https://forum.figma.com/report-a-problem-6/how-do-you-hide-the-new-leftmost-sidebar-55802)
- **Phased rollouts** with no opt-in and no timeline, so teammates run different UIs. [C Apr 2026](https://forum.figma.com/ask-the-community-7/how-to-use-new-variables-ui-52729) · [C Jun 2026](https://forum.figma.com/report-a-problem-6/professional-full-seat-missing-new-ui3-left-navigation-54512)
- **Grid (2025 beta-era)**: no hug tracks, one item per cell, no fr/auto-fill/areas/subgrid. *(Partly outdated: hug tracks and fr multiples are now documented, and Grid went GA 2026-05-22 with reordering and auto rows. The other gaps are unverified for 2026.)* [C](https://forum.figma.com/share-your-feedback-26/config-2025-grid-auto-layout-flow-let-s-hear-what-you-think-40316) · [S](https://nearform.com/digital-community/figmas-new-grid-auto-layout-what-it-does-and-doesnt-yet-do/)
- **Slots**: properties do not pass through slots, and one slot property cannot feed several slots. [C](https://forum.figma.com/report-a-problem-6/figma-slots-do-not-pass-on-component-properties-51891) · [C](https://forum.figma.com/suggest-a-feature-11/using-multiple-slots-in-1-component-with-the-same-slot-property-51623) (titles from search results; bodies not read)
- **Memory and performance** on big files. [C](https://forum.figma.com/report-a-problem-6/figma-renderer-using-a-lot-of-memory-47410)
- **Plan gating is fragmented**:
  - Branching, Completed status, Check designs and Code Connect: Org/Ent only.
  - Extended collections: Enterprise only.
  - Audio: Professional, Education and Organization plans (per help).

  [P various]

---

## 18. Implications for Juno Design (inferred)

1. **Keep the canvas and give it modes; don't split into tabs.** Figma's Design, Draw, Dev and Motion modes are toolbar toggles on one document. For Juno, "Artifact preview", "Design edit", "Inspect/code" and "Motion" could be modes of one Canvas surface. Chat would dock the way Figma's Agents tab or separate window does. [I]
2. **Show agent work on the canvas.** Use shimmer placeholders on nodes being generated and status pills anchored to the layers. Threads should be visible to collaborators by default. Allow parallel prompts from a selection. Figma validates all of this; Claude Design already sends selection context. [I]
3. **Converge code and design artifacts.** Figma's code layers (live code on the canvas, extract-to-design, sync back) are the target shape for Juno's HTML/React artifacts living next to design scenes. [I]
4. **Borrow the chrome lessons.** Floating panels failed. Permanent rails that can't be hidden cause resentment. Auto-popping panels steal clicks. Forced migrations generate backlash. Ship toggles, and let people hide what they don't use. [I]
5. **Mobile editing is an open lane.** Figma cannot edit Design files on the phone. [I, from P]
6. **Pick a minimum scene-graph subset that stays coherent** (see §19). [I]

---

## 19. Figma Plugin API surface vs a Juno Design scene model (local primary evidence, Sept 2026 snapshot)

| Area | What the API exposes (d.ts) |
|---|---|
| Node types | Document, Page, Section, Frame, Group, **TransformGroup** (repeat modifiers), Component, ComponentSet, Instance, **Slot**, BooleanOperation, Vector, Rectangle, Line, Ellipse, Polygon, Star, Text, **TextPath**, Slice, Media; FigJam: Sticky, Stamp, Table, Connector, CodeBlock, ShapeWithText, Widget, Embed, LinkUnfurl; Slides: SlideGrid, SlideRow, Slide, InteractiveSlideElement; Buzz: text and media fields |
| Layout | `layoutMode: NONE/HORIZONTAL/VERTICAL/GRID`, `layoutWrap`, sizing FIXED/HUG/FILL + min/max, `itemSpacing`, `counterAxisSpacing`, padding, alignment (incl. SPACE_BETWEEN/EVENLY/AROUND), `itemReverseZIndex`, `strokesIncludedInLayout`, grid tracks and spans, constraints, layout guides (bindable to variables) |
| Paint | Solid, Gradient, Image, **Video** (with filters), Pattern, **Shader**; bindable to variables |
| Effects | Drop/Inner shadow, Blur (normal / **progressive**), **Noise** (mono/duo/multitone), **Texture**, **Glass** (light intensity/angle, refraction, depth, dispersion, frost radius), **Shader** |
| Strokes | Individual strokes, variable-width, brush (scatter/stretch), dynamic strokes |
| Text | Styled segments, variable fonts (`FontVariationSettings`), `textWrapStyle` AUTO/BALANCE/PRETTY, lists, hyperlinks, leading trim |
| Components | Properties BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT/SLOT, preferred values, `isExposedInstance`, `resetOverrides` |
| Variables | Collections, modes, **extended collections** (`extendLibraryCollectionByKeyAsync`, Enterprise), types incl. **EASING/TIMING**, scopes, codeSyntax, aliases, expressions/conditionals in prototypes, explicit/resolved modes per node |
| Prototype | Reactions (triggers incl. key/gamepad/media), actions (navigate/swap/overlay/scroll/change-to/set-variable-mode), transitions with bezier/spring easing, overflow scrolling |
| Motion | Keyframe tracks, animation styles, timelines, playhead, video export |
| Dev | Annotations with categories, Measurements, `getCSSAsync`, export settings (PNG/JPG/SVG/PDF + video) |
| Agent ergonomics | `query(selector)`, `set()`, `tree()`, `screenshot()`, `placeholder` shimmer |

---

## Sources (with dates)

**Figma blog**
- Our approach to designing UI3, 2024-10-01: https://www.figma.com/blog/our-approach-to-designing-ui3/
- Making the move to UI3, 2025-03-25: https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/
- Config 2024 recap, 2024-06-26: https://www.figma.com/blog/config-2024-recap/
- Config 2025 recap, 2025-05-07: https://www.figma.com/blog/config-2025-recap/
- Figma rendering: powered by WebGPU, 2025-09-18: https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
- Schema 2025 recap, 2025-10-28: https://www.figma.com/blog/schema-2025-design-systems-recap/
- The Figma design agent is here, 2026-05-20: https://www.figma.com/blog/the-figma-agent-is-here/
- Config 2026 recap, 2026-06-24: https://www.figma.com/blog/config-2026-recap/
- Introducing Figma Motion, 2026-06-24: https://www.figma.com/blog/introducing-figma-motion/
- Code on the Figma canvas, 2026-06-24: https://www.figma.com/blog/code-on-the-figma-canvas/
- Agent custom tools, context, skills, 2026-06-24: https://www.figma.com/blog/agent-custom-tools-context-skills/
- Behind the build: generative plugins and shaders, 2026-09-01: https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/
- What's next for Dev Mode, 2024-01-25 (paid from 2024-01-31): https://www.figma.com/blog/dev-mode-ga/

**Figma release notes and developer docs**
- Release notes, entries 2026-03-27 to 2026-09-17 (fact-check read the page's embedded data for titles and dates): https://www.figma.com/release-notes/
- Plugin API updates, 2025-10 to 2026-09-17: https://developers.figma.com/docs/plugins/updates/
- Slots GA, 2026-06-10: https://developers.figma.com/docs/plugins/updates/2026/06/10/update/

**help.figma.com** (all undated; accessed 2026-09-23)
- Navigation bar and left sidebar: https://help.figma.com/hc/en-us/articles/360039831974
- Toolbar: https://help.figma.com/hc/en-us/articles/360041064174
- Right sidebar: https://help.figma.com/hc/en-us/articles/360039832014
- Keyboard: https://help.figma.com/hc/en-us/articles/360040328653
- Actions menu: https://help.figma.com/hc/en-us/articles/23570416033943
- Auto layout guide: https://help.figma.com/hc/en-us/articles/360040451373
- Grid flow: https://help.figma.com/hc/en-us/articles/31289469907863
- Constraints: https://help.figma.com/hc/en-us/articles/360039957734
- Component properties: https://help.figma.com/hc/en-us/articles/5579474826519
- Slots: https://help.figma.com/hc/en-us/articles/38231200344599
- Variables: https://help.figma.com/hc/en-us/articles/15145852043927
- Extended collections: https://help.figma.com/hc/en-us/articles/36346281624471
- Publish a library: https://help.figma.com/hc/en-us/articles/360025508373
- Dev Mode guide: https://help.figma.com/hc/en-us/articles/15023124644247
- Dev Mode statuses: https://help.figma.com/hc/en-us/articles/26781702258583
- Focus view: https://help.figma.com/hc/en-us/articles/23919923330455
- Compare changes: https://help.figma.com/hc/en-us/articles/15023193382935
- Code Connect: https://help.figma.com/hc/en-us/articles/23920389749655
- Comments: https://help.figma.com/hc/en-us/articles/360041068574
- Spotlight: https://help.figma.com/hc/en-us/articles/360040322673
- Cursor chat: https://help.figma.com/hc/en-us/articles/4403130802199
- Audio: https://help.figma.com/hc/en-us/articles/1500004414622
- Version history: https://help.figma.com/hc/en-us/articles/360038006754
- Branching: https://help.figma.com/hc/en-us/articles/360063144053
- Motion timeline: https://help.figma.com/hc/en-us/articles/41405906446999
- Explore Motion: https://help.figma.com/hc/en-us/articles/41274629073303
- What's new from Config 2026: https://help.figma.com/hc/en-us/articles/39582753756695
- What's new from Schema 2025: https://help.figma.com/hc/en-us/articles/35794667554839
- Memory: https://help.figma.com/hc/en-us/articles/360040528173
- Mobile app: https://help.figma.com/hc/en-us/articles/1500007537281

**Community and secondary**
- forum.figma.com threads cited inline, dated Sep 2024 to Jul 2026
- Nearform grid analysis, 2025-06-27

---

## Fact-check (adversarial pass, 2026-09-23)

**Method.** I re-fetched every cited primary page, mostly with curl so I could read the raw page text, including the release-notes page's embedded data for exact entry dates. I then grepped the local Plugin API typings and Figma skills. The session's WebSearch budget was used up, so second sources came from Figma's own pages (help centre, release notes, developer docs and staff forum posts) rather than from press.

**Verified as written**
- UI2 removed 2025-04-30. Source: the UI3 guide dated 2025-03-25, with a forum thread from March–April 2025.
- Floating panels were tried in the beta and reverted. Reasons given: a cramped canvas, weaker rulers, and "slowed people down". Source: blog 2024-10-01.
- The nav bar items are Menu, File, Agents, Assets, Tools, Variables and Notifications.
  - It rolled out in phases from about 2026-01-07/08 (forum). Staff said "slowly rolling out… no specific date" on 2026-04-08 and 2026-06-22.
  - It cannot be hidden on its own. Staff confirmed this on 2026-07-08.
- Figma Motion timeline:
  - Default duration 2000 ms.
  - Loop, Once or Ping-pong playback; auto-keyframe; Space to play; seconds/ms toggle.
  - Springs normalized to bounce 0–1 (`physicalSpringToNormalized`, API 2026-06-23).
  - Export: MP4, GIF, WebM and animated SVG, with Lottie "in the future".
- Plugin API dates:
  - EASING and TIMING variables 2026-08-05.
  - Composed colour variables and the `COLOR_OPACITY` scope 2026-09-17.
  - Video export 2026-07-16; playhead 2026-07-29; `textWrapStyle` 2026-08-14; `SPACE_EVENLY`/`SPACE_AROUND` 2026-08-31; variable fonts 2026-09-03.
- Extended collections: Enterprise only; values-only overrides; no new variables or modes.
- Check designs: 2026-06-04, Org/Ent, with the feature list as written. This is now **primary**; it was a search snippet before.
- The mobile app cannot edit Design files or Slides decks (help quote).
- Memory: 2 GB per tab, including the desktop app; red alert at 90%; file locks at 100%; recovery mode.
- WebGPU blog 2025-09-18, with a dynamic mid-session WebGL fallback.
- Simplified instances deprecated from 2026-03-23.
- Code layers: GitHub or local-folder import, "extract designs" and a one-click update. Source: blog 2026-06-24.
- Slots:
  - open beta 2026-03-05 (Figma Community Support post)
  - `SlotSettings` fields and `limitViolations` (dev docs 2026-06-10)
  - pink hover box, green/orange limit indicators, Cmd+Shift+S (help)
- Agent pop-out window 2026-08-26, desktop app on macOS and Windows.
- Draw eraser and paint bucket 2026-08-24.
- Generative plugins and shaders updates 2026-09-01.
- Opacity variables 2026-09-03.
- Weave "Figma node" 2026-09-17.
- Help-centre details spot-checked and correct:
  - cursor chat: 52 characters, 5 s
  - audio pulse and bubbles
  - spotlight: dashed border, border in the leader's colour
  - comments: 5 images, 100 per hour, top-level attach, time-stamped comments
  - version history: 30-minute checkpoints, 30 days on Starter
  - branching: comments don't carry over; publish only from main
  - Dev Mode statuses: Completed is Org/Ent; the list of what does not trigger Changed
  - toolbar: Annotation and Measurement need a Full seat
  - keyboard: pink box-select cursor, F6
  - variables view: edge-to-edge, Minimize/Expand
- Schema 2025 numbers: 30–60% faster; 3500 ms → 350 ms; 10/20 modes; DTCG 1.0.
- Config 2024 (2024-06-26) and Config 2025 (2025-05-07) recap contents.

**Partly right, corrected in place**
- Agent (claim 4): the beta date 2026-05-20 is right. **Threads visible to collaborators by default applies only from 2026-06-23**, not from launch; earlier threads stay private. On 2026-06-23 the agent also went to open beta on all plans. Added.
- Slots GA (claim 7): the product release note "Sharper controls for every slot" says **"Slots are generally available" on 2026-06-01**. 2026-06-10 is the Plugin API "Slots GA" post. Both are now recorded.
- Config 2026 (claim 5):
  - The announcement date 2026-06-24 and the feature statuses are right: Motion, shaders, generative plugins and Weave tools in open beta; code layers in closed beta.
  - "Moscone, SF" and the full event dates are **unverified**, so the venue was removed.
  - Added what was omitted: 3D transforms and the agent in FigJam and Slides, both as beta sign-ups.
- The Dev Mode timeline row wrongly put the ready-for-dev view and focus view in the January 2024 paid launch. They came at Config 2024. The January blog post is dated 2024-01-25.
- **Grid gaps were out of date.** The Nearform piece (June 2025, beta) says there are no `fr` values and no hug tracks. The current help documents fr multiples and "Hug contents" for tracks, and the API has `GridTrackSize.type 'FLEX'|'FIXED'|'HUG'`. Grid went GA on 2026-05-22 (release note). Corrected in §4 and §17.
- "Variables 2.0" is not Figma's label. The underlying features are real: DTCG import/export and the full-screen authoring modal (both November 2025), and 10/20 modes. Relabelled.
- Agent MCP connectors: the sources name GitHub, Atlassian, Slack, Linear and Hex. **Notion and Excel are unsourced** and were removed.
- Shaders:
  - "one shader's output feeds the next" is a stated goal of the designer's prototype, not a confirmed shipped behaviour. Marked unverified.
  - Variable binding (d.ts) and keyframing in Motion (local skill) are verified.
  - Added that shaders are not yet shown in Dev Mode.
- The "tile rendering" of shaders and plugins was over-read. The blog only describes Figma's canvas as tile-rendered.
- Memory: the help says Figma "loads all components in a component set". It does not say "loaded in the background". Fixed.
- Renderer RAM thread: staff pointed the user to a Technical Quality form; it was not "escalated". Fixed.
- Audio plans: the help lists Professional, Education and Organization, not "paid plans only". Fixed.
- Extended collections: the help says anyone with `can edit` on Enterprise can extend. "Full seats" is unverified.
- Mobile: added the FigJam-on-iPad editing and Make-preview exceptions.
- Motion plans: added that high-resolution video export needs a Full seat on a paid plan, and that Starter gets limited exports.
- The anchor point and motion path help URLs were added. They are verified.
- d.ts snapshot window tightened to 3–16 Sept 2026, because it contains the 2026-09-03 variable-font types.

**Unverified, and tagged in place**
- "Moscone, SF" (removed).
- The "direction" → "flow" rename at Config 2025.
- Blue agent status bubbles as shipped UI; they appear only in blog mockup imagery.
- Whether the follower viewport animates.
- Remaining CSS-Grid gaps in 2026: percentages, auto-fill, named areas, subgrid.
- "One conversation per file" for audio.
- The Minimize UI shortcut: the sources conflict. The UI3 guide and a 2026-07 staff reply say Shift+\; the help says Cmd+Shift+\.

**Not re-checked** (they were low-risk or long-standing):
- the Code Connect help page
- the compare-changes and focus-view articles
- the Actions menu areas beyond their headings
- the UI3 feedback threads cited in §17 (except the toolbar thread, 2024-07-03/10-11, which was checked)
