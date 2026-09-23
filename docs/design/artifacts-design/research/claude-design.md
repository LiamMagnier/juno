# Claude Design (Anthropic Labs): features, workflow, UI and motion

Research notes, 2026-09-23. Lens: Claude Design from its 17 Apr 2026 launch to the 16 Sep 2026 move "inside your conversations".
Builds on `docs/design/artifacts-design/research/claude-primary-evidence.md` (the lead's first-hand read of the Design / Design System / Slides / Docs artifact types). That file is treated as authoritative for how the typed artifacts work today, and it is not re-derived here.

Confidence tags:
- **[P]** primary: an Anthropic source (anthropic.com, claude.com, support.claude.com, code.claude.com), or the lead's first-hand evidence.
- **[S]** secondary: press, reviews or partner pages.
- **[C]** community: HN and blogs.
- **[I]** inferred: my own conclusion from the sources.

Raw captures (curl'd HTML to text) were taken during research and are not stored in the repo.

---

## 0. TL;DR

- **What it is:** Claude Design is a chat and canvas product. You describe a visual and Claude builds a first version as live HTML. You then refine it in five ways: chat, inline comments, direct edits, Claude-generated "tweak" sliders, and drawing on the canvas. It launched **17 Apr 2026** as an Anthropic Labs research preview on **Claude Opus 4.7**, for Pro, Max, Team and Enterprise ([Anthropic, 2026-04-17](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P].
- **It is built on the org's design system.** Onboarding builds one from a codebase, design files, decks or brand assets. Every new project then inherits it. From June, Claude checks its output against the system and makes corrections before the user sees it ([claude.com, 2026-06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)) [P].
- **It is code all the way down.** Reviewers describe the output as HTML and JS throughout ([Sam Henri Gold](https://samhenri.gold/blog/20260418-claude-design/)) [C]. In the integrated Design type each artboard is a self-contained "Design Component" page (`.dc.html`), and "tweaks" are declared in the component's `data-props` and shown as levers in the editor ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)) [P]. Whether the standalone app uses the same file format is not publicly documented.
- **Three milestones:**
  - **17 Jun 2026** "stays on brand" update: rebuilt design-system import, an admin lock, `/design-sync` and `/design` with Claude Code, a new editor with drag/resize/align, shared usage limits, and export connectors ([claude.com, 2026-06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)) [P].
  - **17–21 Aug 2026:** `/design` artboards arrive in the Claude Code CLI ([code.claude.com W34](https://code.claude.com/docs/en/whats-new/2026-w34)) [P].
  - **16 Sep 2026:** Design works in any conversation, the Artifacts tab and Claude Code. The standalone claude.ai/design keeps working, with separate settings ([claude.com, 2026-09-16](https://claude.com/blog/cowork-is-now-claude); [Help Center, upd. 2026-09-18](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P].
- **Adoption and market impact:** more than one million people used it in its first week ([claude.com, 2026-06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)) [P]. Figma stock fell about 7% on launch day ([Gizmodo, 2026-04-17](https://gizmodo.com/anthropic-launches-claude-design-figma-stock-immediately-nosedives-2000748071)) [S].
- **Main complaints:**
  - It burned through usage limits at launch. This was fixed on 17 Jun.
  - Output looks generic ("AI-slop homogeneity").
  - Editing is imprecise, and there are no layers.
  - There is no Figma export.
  - Comments are flaky.
  - Multiplayer editing is weak.
  - There is no version history.
  - Mobile is view-only.
  - One user lost access to projects after unsubscribing.

---

## 1. Timeline (all dated)

| Date | Event | Source | Conf. |
|---|---|---|---|
| 2026-04-14 | Mike Krieger (Anthropic CPO) resigned from Figma's board. The Information reported the design-tool plan the same day. | [VentureBeat, 2026-04-17](https://venturebeat.com/technology/anthropic-just-launched-claude-design-an-ai-tool-that-turns-prompts-into-prototypes-and-challenges-figma) | S |
| 2026-04-16 | Claude Opus 4.7 launched. Its maximum image resolution rose from 1,568 to 2,576 px on the long edge, which the press framed as the vision basis for Design. | [Release notes](https://support.claude.com/en/articles/12138966-release-notes); [Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision) (2576 px for "Claude 4.7 and later", 1568 px for others); [VentureBeat, 2026-04-17](https://venturebeat.com/technology/anthropic-just-launched-claude-design-an-ai-tool-that-turns-prompts-into-prototypes-and-challenges-figma) | P / S |
| 2026-04-17 | **Claude Design launched** as a research preview for Pro, Max, Team and Enterprise, rolling out gradually through the day. It was off by default on Enterprise. | [Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs); [@claudeai](https://x.com/claudeai/status/2045156267690213649) | P |
| 2026-04-17 | The claude.ai/design link in the post returned 404 for some users at launch. | [HN 47806725](https://news.ycombinator.com/item?id=47806725) | C |
| 2026-04-17 | Figma fell about 7% on the day (Gizmodo and DesignRush both say 7%). Adobe fell 2.7% and Wix 4.7% (unverified: neither cited article gives these figures). | [Gizmodo](https://gizmodo.com/anthropic-launches-claude-design-figma-stock-immediately-nosedives-2000748071); [DesignRush](https://news.designrush.com/anthropic-claude-design-launch-figma) | S |
| 2026-04-17 | PCWorld used 80% of the weekly Design allowance in about 25 minutes and was locked out for a week. | [PCWorld](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html) | S |
| ~2026-05-18 | Claude Design token allowance reported doubled for every plan (unverified: the page could not be fetched and no Anthropic source mentions it). | [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/2814/claude-design-doubled-limits-2026) (search snippet only) | S (low) |
| 2026-05-13 | "Tell HN: Don't use Claude Design, lost access to my projects after unsubscribing" (302 points). | [HN 48128003](https://news.ycombinator.com/item?id=48128003) | C |
| 2026-06-17 | **"Claude Design now stays on brand for daily work"** (details in section 7.1). The post also says Design "has a new home in the sidebar on the Claude desktop app". | [claude.com](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work); [VentureBeat](https://venturebeat.com/technology/anthropic-ships-major-claude-design-overhaul-with-design-system-imports-code-round-trips-and-a-fix-for-its-token-burning-problem) | P / S |
| 2026-06-23 | Vercel: deploy from Claude Design via the Share menu and the Vercel MCP. | [Vercel changelog](https://vercel.com/changelog/claude-design-and-vercel) | S (partner) |
| 2026-08-17–21 | `/design` skill (research preview) in the Claude Code CLI and Desktop: "publishes a canvas of editable artboards", requires v2.1.234. Current docs say v2.1.265. | [code.claude.com W34](https://code.claude.com/docs/en/whats-new/2026-w34); [CC artifacts docs](https://code.claude.com/docs/en/artifacts) | P |
| 2026-09-16 | **Chat and Cowork merge.** Docs and Slides launch, and Claude Design "now works inside your conversations too". Slide decks move to Claude Slides. | [claude.com](https://claude.com/blog/cowork-is-now-claude); [TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) | P / S |
| 2026-09-16–18 | Help Center rewritten for the integrated Design: design-system migration, Output > Design, export destinations list, known limitations. | [Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) (mod. 2026-09-18); [DS setup](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design) and [Admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) (mod. 2026-09-16) | P |

---

## 2. What it makes

- **At launch** ([Anthropic, 2026-04-17](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P]:
  - realistic interactive prototypes, "without code review or PRs"
  - product wireframes and mockups, handed to Claude Code
  - design explorations
  - pitch decks, exported as PPTX or sent to Canva
  - marketing collateral: landing pages, social assets, campaign visuals
  - "frontier design": code-powered prototypes with voice, video, shaders, 3D and built-in AI
- **Today** (Help Center, mod. 2026-09-18) [P]: "designs, interactive prototypes, one-pagers, and other visual work". The Help Center now says "To make presentations, use Claude Slides", so decks have moved out. The Admin guide adds "interactive microsites" ([Admin, 2026-09-16](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)).
- **The Design artifact type**, first-hand: "websites, landing pages, screens, UI mockups, wireframes, posters, visual social posts, visuals, ads, invites and digital media" ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)) [P].

---

## 3. Workflow, end to end

### 3.1 Entry points (after 16 Sep) [P] ([Get started, 2026-09-18](https://support.claude.com/en/articles/14604416-get-started-with-claude-design))
1. **In a conversation.** Ask naturally ("Mock up the onboarding flow we just discussed") and Claude "builds it beside your conversation". You can also pick **Output > Design** in the message box. Docs uses the same Output menu plus a `/docs` slash command ([Docs help, 2026-09-16](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)).
2. **Artifacts tab.** Pick a **Design template** from the gallery.
3. **Claude Code.** Ask for a design, or use `/design` to create, edit and sync, and `/design-sync` to push a repo's design system. `/design` "drafts the design as artboards on one canvas and publishes the canvas as a Design artifact" ([CC docs](https://code.claude.com/docs/en/artifacts)).
4. **iOS/Android.** Ask for a design, "check back later", then view it full screen in the Artifacts tab. Templates, canvas editing and sharing need web or desktop.
5. **claude.ai/design.** The standalone app "keeps working" with persistent projects and has its own setting. Google Slides export is only here.
6. The product page FAQ says "Claude Tag coming soon", meaning Design from Slack ([claude.com/product/design](https://claude.com/product/design), fetched 2026-09-23) [P]. Claude Tag is "@Claude" in Slack threads, in beta for Team and Enterprise, with Microsoft Teams "coming soon" ([claude.com/product/tag](https://claude.com/product/tag), fetched 2026-09-23) [P].

### 3.2 Standalone project flow (the Apr–Sep canonical flow)
1. **Home and project picker.** The organization switcher sits in the lower-left of the project picker ([DS setup](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)) [P].
2. **New project type.**
   - **Prototype**, with a **Wireframe** or **High fidelity** toggle
   - **Slide deck**, with an optional speaker-notes option
   - **From template** (users can save custom templates)
   - **Other** (blank)
   - Then you name the project and click Create.
   - Sources: [getpushtoprod, 2026-04-19](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about); [designerup, 2026-04-22](https://designerup.co/blog/how-to-use-claude-design-for-ux-ui/) [S].
3. **The design system attaches automatically** from the org default ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P].
4. **Add context** ("Import from anywhere"): a text prompt, uploaded images and documents (DOCX, PPTX, XLSX), a codebase, and a web-capture tool that grabs elements from your own website ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P]. A `.fig` file can also be uploaded from Figma ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S].
5. **Prompt.**
6. **Clarifying-question form.** Claude "uses the entire canvas to give you a taste exam" ([Builder.io, 2026-04-29](https://www.builder.io/blog/claude-design)) [S]. PCWorld spent about a minute answering multiple-choice questions on audience, format, interactions, style and scope ([PCWorld](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html)) [S]. The form's full set of controls and rules is not publicly documented.
7. **Generation.** Claude generates a working design on the canvas beside the conversation ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]. It takes "minutes" ([Builder.io](https://www.builder.io/blog/claude-design)) or 4–7 minutes per prompt iteration ([UX Pilot, 2026-05-04](https://uxpilot.ai/blogs/claude-design-review)) [S]. The PCWorld reviewer got three variations in about 25 minutes [S].
8. **Refine** (section 4).
9. **Present, Share, Export** (section 5).

### 3.3 How the model is steered (integrated Design type, first-hand) [P]
Source: the Design artifact type's own instructions, read first-hand ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)) [P].
- **Craft rules:** no filler, lorem ipsum or fake stats (placeholders such as [YOUR PRICE] instead); rationale goes in chat, not on the artboard; 1–3 typefaces, a toned neutral ground and 0–2 accents; no AI tropes such as gradient washes, left-border cards, emoji, or Inter/Roboto/Arial; touch targets of at least 44px; real form controls even in static mockups; 4.5:1 contrast.
- **Targeted edits.** When revising, the model re-reads the current files first and changes only what was asked. On a conflict it re-reads and redoes the change once, then tells the user.
- **Talk about the result, not the plumbing:** "Tell the user what happens on the canvas, never the mechanism."
- **No self-verification.** The model is told not to take screenshots or run render checks unless the user asks.
- How the standalone claude.ai/design app steers the model is not publicly documented.

---

## 4. Refinement surfaces (the core UX)

Anthropic's own list: "conversation, inline comments, direct edits, or custom sliders (made by Claude)". Also: "use adjustment knobs to tweak spacing, color, and layout live. Then ask Claude to apply your changes across the full design." ([Anthropic, 2026-04-17](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P]

| Surface | Where / how | Behavior | Source |
|---|---|---|---|
| **Chat** | Left panel in standalone. "Beside your conversation" when integrated. | Broad or structural changes, 2–3 alternatives, explanations, accessibility reviews. | [Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P] |
| **Inline comments** | Comment mode toggle in the top toolbar. Click an element and type. | Batch feedback: checkboxes "select for Send to Claude", so several comments are resolved in one turn ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S]. Known bug: comments can vanish before Claude reads them, so the workaround is to paste into chat; they remain visible in the comments view [P]. UX Pilot: annotations are "easy to miss", shown only on hover over chat comments [S]. | [Help Center](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) |
| **Direct edit** | Edit mode opens a property inspector on the right ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S]. It is contextual: font options when a sentence is selected, layout options when a grid is selected. It covers borders, colors, font options and margins, in designer terms such as "tracking" ([Builder.io](https://www.builder.io/blog/claude-design)) [S]. Text can be edited directly ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P]. Opacity controls and "double-click to retype with no AI call" are unverified. | At launch: "You can't just grab elements and freely move them around like you would in Figma" ([Builder.io](https://www.builder.io/blog/claude-design)) [S]. The **17 Jun** new editor added "rich layout controls" to **drag, resize and align**, plus "hundreds of stability fixes" [P]. | [claude.com 06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work) |
| **Tweaks (sliders)** | A Tweaks panel with sliders, toggles and other adjustable parameters ([Builder.io](https://www.builder.io/blog/claude-design)) [S]; sliders and color pickers embedded in the prototype for values such as theme color, accent color and timing ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S]. | Claude generates these per design: "custom sliders (made by Claude)" [P]. They refine the design without a regeneration [S]. In the integrated Design type, tweaks are declared in each artboard's `data-props` JSON (for example a color editor with a default value) and shown as levers in the editor [P]. How a changed tweak is written back to the file is not publicly documented. | [Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs) [P]; [primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md) [P]; reviews as cited [S] |
| **Draw** | Draw mode: sketch on the canvas, with a **queue** of annotations sent together and optional mic narration. | Builder.io calls it a "scratchpad": a light drawing surface you can use even while the agent is working, to draw an arrow or circle an area and say "more like this". | [getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about) [S]; [Builder.io](https://www.builder.io/blog/claude-design) [S] |
| **Element floating toolbar** (unverified) | Appears on click with Comment / Edit text / Adjust (element-level sliders). | Reported by a guide aggregator, not confirmed by Anthropic or by any review the fact-check could open. | search-snippet summary of guides [S, low] |

- **Choosing a surface** (Anthropic's rule of thumb): comments for component-level fixes, chat for structure and new sections, direct edit for quick visual changes ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P].
- **Variations and options.** Claire Vo called the three-variation output "Claude Design's smartest UX choice" ([Lenny's, 2026-04-22](https://www.lennysnewsletter.com/p/what-claude-design-is-actually-good)) [S]. Builder.io found the multi-option view "currently buggy": with several options on screen the canvas switches to a pan-around mode, and you "can't scroll or easily interact with the static-ish mocks" [S]. How options are laid out and labelled is not otherwise publicly documented.
- **Versioning.** There is no version history ("Claude Design doesn't have version history yet"). The workaround is to tell Claude "Save what we have and try a completely different approach" ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]. Builder.io adds that there is "no way to go back in the AI chat history", so a bad AI edit sticks [S]. PCWorld mistook the "undo" button for a back button and wiped all three variations ("The undo wiped everything") [S].
  - [I] This conflicts with the artifact platform, where every publish is a version with labels ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)). The Design *product UI* has not yet exposed it.
- **Model choice.** Opus 4.7 by default at launch, with a mid-conversation switch to Sonnet 4.6 or Haiku 4.5 and no context loss ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S]. PCWorld downgraded to Sonnet 4.6 to save quota [S]. After the merge it presumably uses the conversation's model; Opus 5.5 launched on 22 Sep ([release notes](https://support.claude.com/en/articles/12138966-release-notes)) [I].

---

## 5. Present, share, export, handoff

- **Top-right controls:** the Help Center confirms the "Export" button in the upper right [P]. Present and Share sitting beside it is unverified: designerup does not describe their placement.
  - **Present** offers three views: the current tab, fullscreen or a new tab. A separate canvas **Zoom** control ranges 50–200% ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S].
  - **Share** also holds "Duplicate as Template", which turns any project into a reusable template [S].
- **Export menu today** ([Get started, 2026-09-18](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]:
  - .zip, PDF, PPTX, Google Slides (standalone only), standalone HTML
  - "Send to" connectors: Adobe Experience Manager, Adobe for Creativity, Adobe Journey Optimizer, Base44, Canva, Gamma, HubSpot, Hyperframes, Lovable, Miro, Netlify, Replit, v0, Vercel, Wix
  - Handoff to Claude Code, Send to local coding agent, Send to Claude Code Web
- **Partner imports.** This environment's Netlify MCP exposes `import-claude-design-from-url`, and the Canva MCP exposes `import-design-from-url`, which suggests partners pull a design in from a URL [I]. How each export format is produced is not publicly documented.
- **Artboard export in the integrated type.** "You can export each artboard as PNG or PDF" ([CC docs](https://code.claude.com/docs/en/artifacts)) [P].
- **Handoff to Claude Code** [P] + [S]:
  - "Claude packages everything into a handoff bundle that you can pass to Claude Code with a single instruction" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P].
  - Brilliant: "Including design intent in Claude Code handoffs has made the jump… seamless" [P].
  - Builder.io complained that the handoff means developers "recreate implementation from scratch" [S].
- **Round trip (since 17 Jun).** `/design-sync` pulls a repo's design system into Design and pushes implemented state back. `/design` from Claude Code can "import a design into your codebase, turn your code into a live prototype" ([claude.com 06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)) [P].
- **Deploy.** Vercel sits in the **Share** menu: add Vercel as a destination, connect the Vercel MCP, deploy as a new project, get a live URL ([Vercel, 2026-06-23](https://vercel.com/changelog/claude-design-and-vercel)) [S].
- **Sharing and permissions** [P]:
  - At launch: private, view-only by link within the org, or edit access, "so colleagues can modify the design and chat with Claude together in a group conversation" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)).
  - Now: private until shared. Enterprise shares with anyone in the org holding the link, and external sharing needs an owner toggle (Org settings > Artifacts). Pro, Max and Team share with anyone with a link who has a Claude account ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)).
  - Reviews describe view, comment and edit permission levels [S].
- **Preview isolation.** Previews run in a sandboxed iframe on a separate Anthropic content domain. Access uses short-lived signed tokens that are re-checked against sharing permissions on every open, so revocation takes effect immediately ([Admin, 2026-09-16](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P].

---

## 6. Motion and "liveness"

Anthropic publishes little motion detail for Claude Design, and no durations or easing curves. What follows is limited to public and first-hand sources.

1. **Streaming paint.** How a design paints onto the canvas while it is generated is not publicly documented. The integrated type binds `{{hole}}` placeholders to `renderVals()` of a logic class ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)) [P], but no public source describes its streaming behaviour.
2. **Live tweaks.** Slider and color changes re-render the canvas immediately with no model turn, "drag live and watch the canvas update" (guides [S]); "adjustment knobs to tweak spacing, color, and layout live" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P].
3. **Slides type transitions** (integrated product): `data-transition="fade|push|magic"` (magic = morph) and build-ins `fade|rise|pop` ([primary-evidence](/Users/liammagnier/Developer/project/juno/docs/design/artifacts-design/research/claude-primary-evidence.md)) [P].
4. **Frontier design.** The launch post markets code-powered prototypes with "voice, video, shaders, 3D" [P]. The animation and video tooling behind them is not publicly documented.
5. **Unified-product motion** (primary, thin): "You can select an element and move it, or tell Claude what you want changed" ([claude.com 09-16](https://claude.com/blog/cowork-is-now-claude)) [P]. No durations are published.

---

## 7. Design systems

### 7.1 Creation and onboarding
- **At launch:** "During onboarding, Claude builds a design system for your team by reading your codebase and design files… teams can maintain more than one" ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P].
- **Standalone setup, four steps** ([DS setup, mod. 2026-09-16](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)) [P]:
  1. Create or switch the org from the lower-left org name in the project picker, which redirects to onboarding.
  2. Upload assets: codebases (e.g. a React component library), prototypes and screenshots, decks or PDFs, logos, palettes, type specimens. More sources give better results.
  3. Review the generated "UI kit": palette, typography, components (buttons, cards, nav) and layout patterns (spacing, grid). Validate it with test prompts.
  4. Switch on the **"Published"** toggle. New projects from the homescreen then use it.
  - **To update:** Org settings > **Open** > **Remix** (top right) opens chat on the left.
  - In the review screen the reviewer approved the palette color by color, and it shows foreground-on-surface pairs for the accessibility check. The reviewer also described the desired motion feel in words ([designerup, 2026-04-22](https://designerup.co/blog/how-to-use-claude-design-for-ux-ui/)) [S]. A dedicated "motion settings" panel is unverified.
- **Other routes** [P]:
  - `/design-sync` in Claude Code for React design systems in code ("reads your tokens and components directly").
  - From any conversation: "connected apps, uploaded files, Figma files, decks, logos, and fonts". Best for brand systems.
- **The 17 Jun rebuild:** import from GitHub, design files or raw uploads, "one or several" systems. "Claude builds with your components, checks its output against your design system, and makes corrections before you see it" ([claude.com 06-17](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)) [P].
- **After 16 Sep, migration:** the "revamped Design Systems feature" lives in **Settings > Design systems**.
  - A banner in the **Design tab at the bottom of the sidebar** offers **"Migrate team design systems"**. Each system "becomes an artifact Claude can use in any conversation, including in Claude Code".
  - Migrated systems carry a banner, **"Let Claude clean it up"**, which tidies the guide, tokens and components ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design); [product FAQ](https://claude.com/product/design)) [P].
  - This matches the lead's **Design System type**: README brand book, `tokens.json` with themes and usage notes, component previews and a bundle, assets, and `lastChange` provenance [P].
- **Governance** ([Admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P]:
  - The **Claude Design Admin** permission (Enterprise custom roles, "Can manage") reserves three actions: publish, set the org default, delete.
  - Without it, any member can do these.
  - Others see "contact your administrator".
  - Permission changes take up to 15 minutes to apply.
  - The product page says admins can "lock a team to a single approved design system".
- **Fidelity:** "only as good as its source" ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]. Builder.io estimated 50–75% fidelity when approximating design systems [S].

### 7.2 Recommended rollout (Admin guide) [P]
1. 2–4 brand and product designers build and validate the system and templates.
2. The full design team.
3. PMs and UX researchers.
4. The whole organization.

Turning Design on with no system in place yields "functional but generic output".

---

## 8. Plans, limits, admin, data

- **Plans.** Pro, Max, Team and Enterprise; not Free.
  - On by default for Pro, Max and Team (off via Settings > Capabilities).
  - Enterprise is off until an owner enables it.
  - **Two separate switches** ([Admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P]: *Organization settings > Artifacts > Design* (conversations and Artifacts tab) and *Organization settings > Capabilities > Claude Design* (standalone). On Enterprise, each can be scoped to groups with custom roles. People outside those groups "can still open, comment on, and use designs shared with them".
- **Usage.**
  - At launch there was a separate weekly Design allowance plus optional extra usage [P].
  - Since 17 Jun it is shared with all Claude usage, including Claude Code. Anthropic also cut average tokens per turn and error rates ([VentureBeat 06-17](https://venturebeat.com/technology/anthropic-ships-major-claude-design-overhaul-with-design-system-imports-code-round-trips-and-a-fix-for-its-token-burning-problem)) [S/P].
  - Hitting the limit disables Design until the reset unless usage credits are enabled.
  - Usage-based Enterprise bills at API rates ([Admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P].
  - "Larger requests, like a full deck or design, use more of your limit than a typical message" ([product FAQ](https://claude.com/product/design)) [P].
- **Observability.** Analytics > Claude Design shows DAU/WAU/MAU for the **standalone app only**. Standalone has **no audit logs**. Integrated designs go to the Compliance API at artifact level [P].
- **Data.**
  - Uploaded assets are stored persistently. There is no data residency.
  - The **integrated Design is unavailable for CMEK, ZDR or HIPAA-ready orgs**.
  - It is not available on third-party clouds (Bedrock and similar) [P].
- **Account coupling.** A user lost standalone projects after unsubscribing. Another user noted that the data export contains a `design_chats` directory with the code as JSON ([HN 48128003, 2026-05-13](https://news.ycombinator.com/item?id=48128003)) [C].

---

## 9. What changed on 16 Sep 2026 (and cross-check with the artifact types)

**Announced changes** ([claude.com 09-16](https://claude.com/blog/cowork-is-now-claude); [Get started 09-18](https://support.claude.com/en/articles/14604416-get-started-with-claude-design); [What are artifacts 09-18](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)) [P]:
- Design is available in any conversation, "with the context, skills, and connectors you already have". Design, Slides and Docs are all "artifacts".
- In the new experience "everything you make is saved to the Artifacts tab automatically". The old experience required "Publish".
- Anything made with Design, Slides or Docs "lives at one shareable link you can open on your phone". You can select an element and move it, or tell Claude. Mobile is **view-only** for Design.
- **Decks split off into Claude Slides.** In the integrated product, decks go to Claude Slides: the Help Center says "To make presentations, use Claude Slides", the Admin guide says "Presentations now have their own tool", and the June post's September update says "Slide decks have their own starting point in Claude Slides". [I] Whether the standalone app removed its "Slide deck" project type is unconfirmed. Anthropic says standalone "keeps working as before", and Google Slides export still exists only there.
- Design systems become **artifacts** (Settings > Design systems), with a migration banner and "Let Claude clean it up".
- Claude Code gets `/design` "to create, edit, and sync designs, on desktop or in the terminal" (Get started). In the published canvas you select an element on an artboard and change it, and edits save automatically ([CC docs](https://code.claude.com/docs/en/artifacts)). The earlier quote "same editor and prompting features" is unverified: it appears in none of the cited pages.
- The standalone claude.ai/design stays, with its own projects, setting, analytics and Google Slides export.

**Cross-check against the lead's first-hand evidence** [I]:
- **The integrated file format is known; the standalone one is not.** The observed Design type uses `.dc.html` "Design Components" with `<x-dc>`, `<helmet>`, `{{hole}}` bindings to `renderVals()` of `class Component extends DCLogic`, `data-props` tweaks, `<sc-for>`/`<sc-if>`/`<dc-import>`/`<x-import>`, and `$preview` size [P].
  - Whether the standalone app uses the same format, and so whether the integrated type is the standalone engine re-hosted as an artifact type, is not publicly documented.
- **The container changed.** The standalone app keeps persistent projects with their own setting ([Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]. Its internal file layout is not publicly documented.
  - The integrated type is a `canvas.json` index of **pages (≤40) → artboards** (one `.dc.html` each, placed with x/y/w/h on an infinite canvas), plus **notes and stickies**, user-drawn shapes, a **Theme menu** fed by installed design-system tokens, a **focused** single-artboard view, **Play** mode for `<a href>` prototype links, and letter/A4 print pagination.
  - So the integrated version is a Figma-like board of artboards inside an artifact.
- **Collaboration changed.** The integrated type declares `room` (multiplayer presence), `comments` (anchored, composer_only, customAnchors) and `user`, and comments can be "sent to Claude".
  - The standalone app had group chat on one project but "basic" multi-editing.
  - The Help Center still lists multi-person editing as unreliable [P].
- **Verification.** The integrated type tells the model not to self-verify unless asked [P]. How the standalone app handles verification is not publicly documented.

---

## 10. Reviews and critiques

**Positive**
- For non-designers it is a creative partner that asks questions, offers options and exposes sliders ([Builder.io](https://www.builder.io/blog/claude-design); [Salesdorado 4/5, 2026-06](https://salesdorado.com/en/ai/review-claude-design/)) [S].
- The three variations are a smart default. It is good for landing pages, decks from articles, and playful redesigns ([Lenny's/Claire Vo, 2026-04-22](https://www.lennysnewsletter.com/p/what-claude-design-is-actually-good)) [S].
- It is honestly code ("HTML and JS all the way down"), and the Claude Code integration removes design-to-dev friction. The author sees "Figma's Sketch moment" approaching ([Sam Henri Gold, 2026-04-18](https://samhenri.gold/blog/20260418-claude-design/)) [C].
- It threatens Figma's non-designer majority: per Figma's S-1, only 33% of Figma users in Q1 2025 were designers, with developers at 30% and other roles at 37%. It also runs on a better model than Figma Make (Opus 4.7 against Sonnet 4.5) ([Martin Alderson, 2026-04-19](https://martinalderson.com/posts/figmas-woes-compound-with-claude-design/)) [C].
- Customer quotes: Datadog went "from a rough idea to a working prototype before anyone leaves the room"; Brilliant needed 2 prompts where other tools took 20+ ([Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)) [P].
- Agencies use it to express intent to clients faster ([HN](https://news.ycombinator.com/item?id=47806725)) [C].

**Negative and weaknesses**
- **Usage and cost at launch.**
  - PCWorld: 80% of the weekly allowance in about 25 minutes, then locked out ([PCWorld 04-17](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html)).
  - UX Pilot: about 35 minutes per week on Pro ([UX Pilot 05-04](https://uxpilot.ai/blogs/claude-design-review)).
  - Claire Vo "paid $200 to keep going" [S].
  - Anthropic called the problem out and changed it on 17 Jun [P].
- **Generic output.** "Competent UI… but nothing truly unique", rounded cards, homogeneity ([HN launch thread, 1,235 points / 762 comments](https://news.ycombinator.com/item?id=47806725)) [C]. Without strong direction, output leans "towards a recognizable aesthetic" and "rarely" stands out ([Salesdorado, 2026-06-09](https://salesdorado.com/en/ai/review-claude-design/)) [S].
- **Precision.**
  - No free positioning at launch; the section selector picks the wrong areas; text overlaps.
  - "The editing controls feel like Squarespace with AI attached"; no layers ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about); [UX Pilot](https://uxpilot.ai/blogs/claude-design-review)) [S].
  - "LLMs are blind, and spatial relativity is tremendously hard across layers of nested html / css" ([HN 48128003](https://news.ycombinator.com/item?id=48128003)) [C].
- **Slow.** Minutes per turn, 4–7 minutes per iteration [S].
- **No Figma export.** "Claude Design does not currently offer a direct export to Figma" ([Anima, 2026-09-08](https://animaapp.com/blog/ai-design-en/claude-design-review-features-pros-cons-and-best-alternatives/)); see also [UX Pilot](https://uxpilot.ai/blogs/claude-design-review) [S]. The 18 Sep export list also has no Figma destination [P]. There is a Figma *import*: a .fig upload ([getpushtoprod](https://getpushtoprod.substack.com/p/everything-you-need-to-know-about)) [S].
- **Export fidelity.** In slide-deck exports "texts often overlap" and elements display wrongly ([UX Pilot](https://uxpilot.ai/blogs/claude-design-review)). The Canva export button was "intermittently failing in the research preview" ([dgtl dept, 2026-04-30](https://www.dgtldept.com/p/claude-design-escape-the-default)) [S].
- **Code quality.** "Write-once, read-never" code ([HN](https://news.ycombinator.com/item?id=48128003)) [C]. It needs the same review as other AI code ([Salesdorado](https://salesdorado.com/en/ai/review-claude-design/)) [S].
- **Anthropic's own known limitations:**
  - comments sometimes disappear
  - large repositories cause lag (link them from Claude Code instead)
  - "chat upstream error" means opening a new chat tab
  - mobile is view-only
  - multi-person editing is "basic and may not work reliably"
  - no version history
  - Source: [Get started, 2026-09-18](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) [P].
- **Early instability.** Launch-day 404 ([HN](https://news.ycombinator.com/item?id=47806725)). "Claude Design Is 404ing" on 28 Apr, a 3-point post with no comments, so weak evidence ([HN](https://news.ycombinator.com/item?id=47937918)). A "preview token required" warning appeared when PCWorld clicked between variations ([PCWorld](https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html)) [S]. Projects did not reopen in their current state ([Salesdorado](https://salesdorado.com/en/ai/review-claude-design/)). Auto-send fired before the user was ready ([Builder.io](https://www.builder.io/blog/claude-design)) [C/S].
- **Strategy doubts.** "Anthropic's product area is extremely overextended"; will Anthropic still care about this product in 2–3 years? ([HN](https://news.ycombinator.com/item?id=47806725)) [C].
- **Open-source clones.** "Open Design" reached 57.4k stars in 8 weeks ([VentureBeat 06-17](https://venturebeat.com/technology/anthropic-ships-major-claude-design-overhaul-with-design-system-imports-code-round-trips-and-a-fix-for-its-token-burning-problem)) and "77k stars / 1M+ installs" by 18 Jul. The later figure is only the title of a third-party blog post linked on HN (7 points) ([HN 48957534](https://news.ycombinator.com/item?id=48957534)) [S/C].

---

## 11. Information architecture (as of 2026-09-23)

```
Organization
├─ Design systems (Settings > Design systems; each is a Design System artifact)
│    published / org default / admin-locked (Claude Design Admin)
├─ Conversations (chat + Cowork merged)
│    └─ Output ▸ Design  → Design artifact beside the chat
│         canvas.json: pages → artboards (.dc.html, tweaks = data-props) + notes/stickies
│         Theme menu (DS tokens) · focused view · Play (prototype links) · comments · room
├─ Artifacts tab (gallery of everything made; Design/Slides/Docs templates)
├─ Sidebar "Design" tab (migration banner for legacy team design systems)
├─ Claude Code: /design (artboard canvas → Design artifact), /design-sync (repo DS ↔ Design)
└─ claude.ai/design (standalone, legacy-but-supported)
     Project picker (org switcher bottom-left) → Project
       chat (left) | canvas (right) | modes: Comment · Edit · Draw, plus a Tweaks panel
       top-right: Present · Share (destinations e.g. Vercel) · Export (zip/PDF/PPTX/Slides/HTML/connectors/handoff)
```
Sources: sections 3–9. [P] for the integrated structure and settings paths; [S] for standalone toolbar details.

---

## 12. Implications for Juno's Artifacts and Juno Design merge [I]

1. **One format across containers.** In the integrated product every artboard is a self-contained code file (a `.dc.html` Design Component) placed on a canvas of artboards inside an artifact [P]. Whether Anthropic reused the standalone app's format is not publicly documented. Juno could still use one DESIGN artifact type whose scene holds artboards, where each artboard can be a Juno scene node tree *or* an HTML/React code artifact.
2. **Tweaks are the bridge between prompting and direct manipulation.** They are declared props that the host renders as editor controls [P], and they update the canvas live without a regeneration [P/S]. Whether and how a changed value is written back to source is not publicly documented. The pattern maps directly onto Juno Design's properties panel if code artifacts can declare typed props.
3. **Keep the canvas live.** Tweaks update the canvas as the user drags, with no model turn [P/S]. How Claude Design paints a design while it is being generated is not publicly documented. Juno's Canvas panel should still render partial output rather than wait for completion.
4. **Selections and comments feed context back to the model.** In the integrated type the current artboard and selection are passed to Claude as view state, and comments are anchored threads that can be sent to Claude [P]. How anchors survive a model rewrite is not publicly documented. Juno needs stable node ids across model rewrites.
5. **Ask with forms, not prose.** Reviewers describe an opening form of multiple-choice questions on audience, format, interactions, style and scope, laid out across the canvas [S]. Its full set of controls is not publicly documented. A structured question form is a reusable pattern for Juno's chat.
6. **Ship what Anthropic still lacks.** Anthropic's known gaps are version history in the Design UI, real multiplayer, mobile editing, Figma export and precise layout. These are where a Figma-like Juno Design scene editor can lead, especially on native macOS/iOS where Claude is view-only on mobile.
7. **Avoid Anthropic's split-brain.** Two switches, two analytics views, separate standalone projects, and Google Slides export only in standalone. When merging, migrate old artifacts into the new type in one pass, with a "clean up" assist like Anthropic's migration banner.

---

## Sources

| URL | Date | Type |
|---|---|---|
| https://www.anthropic.com/news/claude-design-anthropic-labs | 2026-04-17 | P |
| https://x.com/claudeai/status/2045156267690213649 | 2026-04-17 | P |
| https://claude.com/blog/claude-design-stays-on-brand-for-daily-work | 2026-06-17 (mod. 2026-09-16) | P |
| https://claude.com/blog/cowork-is-now-claude | 2026-09-16 | P |
| https://claude.com/product/design | fetched 2026-09-23 | P |
| https://support.claude.com/en/articles/14604416-get-started-with-claude-design | mod. 2026-09-18 | P |
| https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design | mod. 2026-09-16 | P |
| https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans | mod. 2026-09-16 | P |
| https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | mod. 2026-09-18 | P |
| https://support.claude.com/en/articles/16923645-get-started-with-claude-docs | mod. 2026-09-16 | P |
| https://support.claude.com/en/articles/12138966-release-notes | mod. 2026-09-22 | P |
| https://code.claude.com/docs/en/artifacts | fetched 2026-09-23 | P |
| https://code.claude.com/docs/en/whats-new/2026-w34 | 2026-08-17–21 | P |
| docs/design/artifacts-design/research/claude-primary-evidence.md | 2026-09-23 | P (first-hand) |
| https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/ | 2026-04-17 | S |
| https://venturebeat.com/technology/anthropic-just-launched-claude-design-an-ai-tool-that-turns-prompts-into-prototypes-and-challenges-figma | 2026-04-17 | S |
| https://venturebeat.com/technology/anthropic-ships-major-claude-design-overhaul-with-design-system-imports-code-round-trips-and-a-fix-for-its-token-burning-problem | 2026-06-17 | S |
| https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/ | 2026-09-16 | S |
| https://www.testingcatalog.com/claude-merges-cowork-and-chat-into-one-experience/ | 2026-09-17 | S |
| https://www.pcworld.com/article/3117811/i-tried-claude-design-for-half-an-hour-im-already-locked-out-for-a-week.html | 2026-04-17 | S |
| https://gizmodo.com/anthropic-launches-claude-design-figma-stock-immediately-nosedives-2000748071 | 2026-04-17 | S (fetched in fact-check) |
| https://news.designrush.com/anthropic-claude-design-launch-figma | 2026-04-17 | S |
| https://platform.claude.com/docs/en/build-with-claude/vision | fetched 2026-09-23 | P |
| https://claude.com/product/tag | fetched 2026-09-23 | P |
| https://www.builder.io/blog/claude-design | 2026-04-29 | S |
| https://www.lennysnewsletter.com/p/what-claude-design-is-actually-good | 2026-04-22 | S |
| https://getpushtoprod.substack.com/p/everything-you-need-to-know-about | 2026-04-19 | S |
| https://designerup.co/blog/how-to-use-claude-design-for-ux-ui/ | 2026-04-22 | S |
| https://www.dgtldept.com/p/claude-design-escape-the-default | 2026-04-30 | S |
| https://uxpilot.ai/blogs/claude-design-review | 2026-05-04 | S |
| https://salesdorado.com/en/ai/review-claude-design/ | 2026-06-09 | S |
| https://animaapp.com/blog/ai-design-en/claude-design-review-features-pros-cons-and-best-alternatives/ | 2026-09-08 | S |
| https://www.datacamp.com/blog/claude-design | 2026 | S |
| https://vercel.com/changelog/claude-design-and-vercel | 2026-06-23 | S (partner) |
| https://news.ycombinator.com/item?id=47806725 | 2026-04-17 | C |
| https://news.ycombinator.com/item?id=48128003 | 2026-05-13 | C |
| https://samhenri.gold/blog/20260418-claude-design/ | 2026-04-18 | C |
| https://martinalderson.com/posts/figmas-woes-compound-with-claude-design/ | 2026-04-19 | C |
| https://pasqualepillitteri.it/en/news/2814/claude-design-doubled-limits-2026 | 2026-05 | S (snippet, low) |

---

## Fact-check (2026-09-23, adversarial pass)

**Method.** I fetched each cited page again (curl to text, or WebFetch), independently of the `raw/` captures. The pages were:
- anthropic.com launch post
- claude.com: the June 17 blog, "cowork-is-now-claude", /product/design, /product/tag and the sitemap
- support.claude.com: Get started (dateModified 2026-09-18), Admin guide and DS setup (both 2026-09-16), What are artifacts, Get started with Docs, and the release notes (2026-09-22)
- code.claude.com: the W34 digest and the artifacts docs
- platform.claude.com vision docs
- press and reviews: Gizmodo, VentureBeat (×2), PCWorld, DesignRush, Vercel changelog, TechCrunch 09-16, getpushtoprod, designerup, Builder.io, Lenny's, UX Pilot, Salesdorado, dgtl dept, Anima, samhenri.gold, martinalderson.com
- HN items through the Firebase and Algolia APIs

**Verified against primary sources** (Anthropic pages):
- The 17 Apr launch: research preview, Opus 4.7, Pro/Max/Team/Enterprise, off by default on Enterprise, "custom sliders (made by Claude)", "frontier design… voice, video, shaders, 3D", and the handoff bundle.
- The 17 Jun post: "Over one million people used Claude Design in its first week", shared limits "including Claude Code", drag/resize/align, "hundreds of stability fixes", `/design-sync` and `/design`, the admin role, and the connectors list.
- 16 Sep: Design "now works inside your conversations too", and standalone "keeps working as before".
- The Help Center's Output > Design, "To make presentations, use Claude Slides", the migration banner text and the export list. The list is an exact match: 15 "Send to" destinations, with Google Slides only at claude.ai/design.
- The known limitations: no version history, and multi-person editing "basic and may not work reliably".
- The Admin guide's CMEK/ZDR/HIPAA exclusion, no standalone audit logs, standalone-only analytics, the Compliance API, the Claude Design Admin permission, the 15-minute propagation, and the sandbox with signed tokens.
- The W34 `/design` entry: research preview, v2.1.234. The artifacts docs now say v2.1.265, with PNG/PDF artboard export.
- "Claude Tag coming soon" on the product page, where Claude Tag is @Claude in Slack.
- Opus 5.5 released 22 Sep.

**Verified against secondary and community sources:**
- Figma down about 7% (Gizmodo, DesignRush).
- Krieger left Figma's board on 14 Apr (VentureBeat). Gizmodo says only "just days ago".
- PCWorld (Pro): 80% of the weekly Design allowance in about 25 minutes, the meter at zero five minutes after switching to Sonnet 4.6, and three variations.
- HN points and dates.
- The Builder.io, UX Pilot, getpushtoprod and Lenny's quotes.
- Open Design at 57.4k stars (VentureBeat).
- Vercel deploys through the Share menu and the Vercel MCP.

**Source-policy pass (2026-09-23):** claims whose only support was leaked (unofficial) Anthropic material were removed, along with the links to it. Conclusions that depended on those claims were rewritten from the remaining evidence or marked "not publicly documented". The Tweaks, Draw and import details that remain were re-checked against getpushtoprod, Builder.io and the Anthropic launch post on 2026-09-23.

**Corrected in this pass:**
- Opus 4.7 resolution now cites the Claude vision docs (2576 px for 4.7+, 1568 px otherwise) instead of "search snippets".
- Present opens in the current tab, fullscreen or a **new tab**, not a new window. The 50–200% range belongs to the canvas Zoom control, not Present.
- Present and Share in the top right: designerup does not say this. Only Export in the upper right is confirmed.
- Direct-edit property list: borders, colors, font options and margins are confirmed, and the panel is contextual (Builder.io). "Opacity" and "double-click to retype, no AI call" are tagged unverified.
- "Circle the bad bit." was an unsourced quote. It is replaced with Builder.io's "scratchpad" description.
- Design-system review screen: it shows color accessibility pairs. "Motion settings" is unverified.
- The `/design` "same editor and prompting features" quote is not found in any cited page, so it was replaced with verified wording.
- Decks moving to Slides is confirmed for the integrated product. Removal of the Slide deck type from standalone is unconfirmed.
- Martin Alderson's post is dated 2026-04-19, not 04-20. The 67% figure is restated from the post: 33% designers per Figma's S-1.
- Salesdorado dated 2026-06-09, and its quote corrected to "towards a recognizable aesthetic". Anima dated 2026-09-08.
- dgtl dept quote corrected: "intermittently failing", not "pretty flaky".
- Enterprise-only qualifier added to group-scoped switches.

**Tagged unverified:**
- Adobe −2.7% and Wix −4.7% (in neither cited article).
- The ~18 May "doubled limits" report (the site could not be reached, and no Anthropic source mentions it).
- The element floating toolbar.
- The @claudeai X post (not opened; X needs login). The launch facts it supports are verified elsewhere.

**Added:**
- PCWorld's undo-wipe and "preview token required" complaints, and Builder.io's "no way to go back in the AI chat history".
- Claude Tag = @Claude in Slack, with Teams coming soon.
- "Duplicate as Template" in Share.
- The desktop-sidebar home from the June post.
- The HN 47937918 post has 3 points and no comments. The 77k-star figure is only a linked blog title.
