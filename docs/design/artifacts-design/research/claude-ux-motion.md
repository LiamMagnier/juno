# Claude apps: UX craft and motion around made things (Sept 2026)

Lens: how Claude's apps *feel* when they make things. Covers panel open/close and resize, streaming text versus streaming artifacts, "thinking" and tool indicators, how a transcript card links to the artifact, version transitions, inline visuals (Imagine / custom visuals / `show_widget`), MCP Apps, the desktop and mobile apps, accessibility and reduced motion, and Anthropic's visual language.

Researched 2026-09-23 for Juno's Artifacts + Design merge. This builds on `docs/design/artifacts-design/research/claude-primary-evidence.md`, which is authoritative for the typed-artifact platform (Design, Design System, Docs, Slides, capabilities and versions) and is not repeated here.

## How to read the confidence tags

- **primary**: a vendor source. That means anthropic.com, claude.com, support.claude.com or GitHub/MCP spec pages. It also includes two first-hand sources observed on this machine:
  - **[bundle]**: observed in the shipped Claude desktop app (`/Applications/Claude.app`, version 2.7032.0, built 2026-09-22). I read its stylesheets, scripts and English UI strings. These notes keep only short factual values (durations, easings, sizes, colours) and plain descriptions of behaviour; they do not reproduce code, internal identifiers or lists of internal strings. The motion values are **exact shipped values**. The mapping of an animation to a surface is sometimes inferred from naming in the code, and I mark those cases.
  - **[imagine]**: the "Imagine — Visual Creation Suite" design contract. The `visualize` tool (`read_me` + `show_widget`) serves it to Claude in this environment, and it governs every inline visual Claude draws. I read all 1,203 lines on 2026-09-23. It embeds **CDS (Claude Design System)** token and principle docs, including a motion layer. Quotes from it are kept short.
- **secondary**: press, reviews, tutorials.
- **inferred**: my reading of observed behaviour or code structure. It is not stated anywhere.

Research limits: the shared WebSearch budget ran out partway through. Community evidence therefore comes mostly from Hacker News threads, fetched through the Algolia API. Reddit and The Verge refused fetches.

---

## 0. TL;DR: what Claude gets right, what hurts, and what Juno should take

1. **Every made thing is one of three tiers, each with its own weight.**
   - *Inline visual*: an ephemeral widget in the transcript that "change[s] or disappear[s] as the conversation evolves" ([claude.com/blog/claude-builds-visuals](https://claude.com/blog/claude-builds-visuals), 2026-03-12, primary).
   - *Artifact card → panel/canvas beside chat*.
   - *Hosted artifact page at one link*, with typed Docs/Slides/Design, comments and versions (primary-evidence doc).
   
   The merge of 16 Sept 2026 removed the *mode* choice. The *tiers* stayed. Claude routes between them, and the composer still offers an explicit **Output ▸ Docs / Design** menu ([support: Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design); [support: Claude Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), primary).
2. **Claude's motion is a small token ladder used everywhere** [bundle, primary]:
   - durations: fast 60ms, snap 120ms, base 200ms, sheet 300ms, slow 450ms
   - ease-out `cubic-bezier(.165,.84,.44,1)` (quart-out)
   - snap easing `cubic-bezier(.32,.72,0,1)`
   - overshoot easing `cubic-bezier(.34,1.3,.64,1)`
   
   Almost every rule reads these tokens. The most-used are ease-out (72 occurrences in the CSS, 66 of them token reads) and the snap duration (56, 53 reads).
3. **Streaming text is animated at the tail, not the whole message.** New words fade in (100ms linear, only under `prefers-reduced-motion: no-preference`) [bundle]. The markdown renderer has fast paths for open code fences, lists and tables, so half-streamed structures render as they arrive [bundle, inferred from code]. *(Fact-check correction: the grapheme blur-in — opacity 0 + `blur(6px)` → clear over 90ms `cubic-bezier(.215,.61,.355,1)`, 30ms stagger — is **not** a response-streaming style. In the app it is used only for **session titles in the sidebar row and a renamed-title component**: when a title arrives or changes, the old text blurs out over 200ms and the new title cascades in per grapheme [bundle].)*
4. **"Working" is shown with restrained, clay-tinted signals rather than spinners.** They include:
   - a 3s shimmer band across status text;
   - a 1.8s dot pulse;
   - a clay status dot that "breathes" (scale .86↔1, 3s);
   - a status line that rises in (240ms) and falls out (180ms) in a progress timeline, with a "spark depart" (420ms) as a step completes;
   - a ladder of status labels that escalates the longer Claude thinks, from "Thinking…" to "Almost done thinking…" [bundle].
5. **The artifact card in the transcript is a small object with a physical feel.** It is ≤520px wide. It carries a 56px "sheet" thumbnail with its own micro-animation for each file kind:
   - code types a line with a riding caret (8 steps over 360ms); plain text shows a blinking caret;
   - image corner brackets tighten (320ms);
   - an archive zips.
   
   On hover the sheet lifts 2px, a light sweeps across it (light angle 165°→200° and the highlight strength rising, over the slow duration, 450ms), and an under-sheet fans out behind it at −4° (450ms ease-out). Only the *latest* edit card of an artifact stays visible, and earlier edit cards go to opacity 0 [bundle]. *(Fact-check correction: the scale 1.035 + 0.065rad (≈3.7°) tilt + springy `cubic-bezier(0,.9,.5,1.35)` over 400ms belongs to a **different, fallback card** — a legacy artifact block whose 52×71px preview page rests tilted 0.1rad (≈5.7°) and on hover straightens to ≈3.7° and scales 1.035. The new sheet card does not scale or rotate.)*
6. **Inline visuals are designed to be indistinguishable from the host.**
   - Rules: "Users shouldn't notice where claude.ai ends and your widget begins." Flat, no gradients or shadows, 0.5px borders, Anthropic Sans at 400/500 only, sentence case, 680px wide, auto-height iframe.
   - They stream token by token *into the live DOM*. Style comes first and script last, scripts run after streaming, and nothing may be hidden during streaming.
   - Animation must be `transform`/`opacity` only, loop in under ~2s, and sit behind `prefers-reduced-motion: no-preference`.
   - The widget's own code gets **no fullscreen**: `requestFullscreen` is dead in the iframe and the model must not call display-mode host APIs [imagine, primary]. *(Fact-check correction: the **host** does offer it. The help centre says that once a visual appears you can "click buttons, adjust sliders, expand it to full screen" ([support 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork), accessed 2026-09-23, primary). So fullscreen is host-owned chrome, not "no fullscreen by design".)*
   - Visuals are ephemeral by default, but the user can keep one: **Copy as image**, **Download** (.svg or .html) or **Save as artifact** (support 13979539, primary).
7. **Reduced motion is an in-app setting as well as an OS one.** Settings has **Motion: System | Reduced**, described as "Reduce animation in streaming responses and other interface elements." It sets a single attribute on the document root. The CSS carries 61+18+… `prefers-reduced-motion: reduce` blocks, and components' motion-safe variants are gated on that attribute [bundle, primary].
8. **Typography signals who is speaking.** "Claude's responses render in serif; the surrounding chrome stays sans" [imagine/CDS principles]. The chat-font setting offers serif (default), sans, system, **Atkinson Hyperlegible Next** (shown only behind a feature flag or if already selected) and **OpenDyslexic**. There is a separate interface-font setting [bundle].
9. **Clay (#d97757) is reserved for what Claude does.** That covers send, generate and the spark mark. User primary actions use neutral accent blue [imagine/CDS; bundle values: clay #d97757, emphasized clay #c6613f]. The brand fill uses the emphasized clay at rest and clay on hover [imagine].
10. **The weak spots are mobile editing, persistence and trust.**
    - Mobile editing: help-centre pages say designs, decks and docs can only be *viewed* in the native phone apps' Artifacts tab; editing is web/desktop only. Anthropic's launch post only says the link is one "you can open on your phone" ([blog](https://claude.com/blog/cowork-is-now-claude), 2026-09-16). TechCrunch went further and wrote that users can "edit them on their phone" ([TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/), 2026-09-16). The contradiction is between the press reading and the help centre. Anthropic's own copy only implies it.
    - Persistence: people lost access to Claude Design projects after downgrading ([HN 48128003](https://news.ycombinator.com/item?id=48128003), 2026-05-13).
    - Trust and quality: Tweaks are "still pretty buggy" ([Builder.io](https://www.builder.io/blog/claude-design), 2026-04-29), and output looks generic (HN launch thread).
    - Unasked-for visuals can make output feel more confident than it is: the feature "improves the perceived confidence of the LLM but doesn't do much for correctness" (captainbland, [HN 47352751](https://news.ycombinator.com/item?id=47352751), 2026-03-12).

---

## 1. The surfaces map: where a made thing appears (Sept 2026)

| Tier | Where it renders | Lifetime | Who/what edits | Source |
|---|---|---|---|---|
| **Inline visual** (`show_widget`: SVG or HTML widget) | Inside the transcript, in a card, at 680px width, auto-height sandboxed iframe; host can expand it to full screen; web and desktop only (does not render on iOS/Android) | Ephemeral: "temporary—they change or disappear as the conversation evolves"; can be kept via Copy as image, Download (.svg/.html) or Save as artifact | Claude, by its own choice or on request ("draw this as a diagram") | [claude.com/blog/claude-builds-visuals](https://claude.com/blog/claude-builds-visuals) 2026-03-12 (primary); [support 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork) (primary); [imagine] |
| **MCP App** (third-party interactive UI, `ui://` resource) | Inline in the transcript; host offers the inline and fullscreen display modes | Session | User + the app; the app can call tools | [claude.com/blog/interactive-tools-in-claude](https://claude.com/blog/interactive-tools-in-claude) 2026-01-26 (primary); [bundle] host context |
| **Artifact card → panel** (code/HTML/React/SVG/Mermaid/markdown) | Card in the transcript; opens "in a dedicated window to the right of the main chat" | Persistent, versioned | Claude; user via "Edit with Claude" on selected markdown | [support 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) (primary) |
| **Typed artifact** (Design canvas, Docs, Slides, Design System) | "a conversation with a canvas" beside it; also a hosted page at one link | Persistent, shareable, commentable | Claude + people (live editing, comments sent to Claude) | [support 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design); primary-evidence doc |
| **Artifacts tab / library** | Sidebar "Artifacts" view with "Filter by" and "New artifact"; redesigned Projects gained a *library* of added files and Claude-made artifacts on 2026-09-17 (beta, Claude Code cloud projects for select Pro/Max first) | Persistent | n/a | [support 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork); [claude.com/blog/projects-redesigned](https://claude.com/blog/projects-redesigned) 2026-09-17 (primary) |
| **Claude Code artifacts** | Hosted page at claude.ai/code/artifact/…; "refreshes in place" as the session publishes | Versioned at the same link | Claude Code session | [claude.com/blog/artifacts-in-claude-code](https://claude.com/blog/artifacts-in-claude-code) 2026-06-18 (primary) |

**Entry points into a made thing** (primary, help centre):

- Ask in any conversation. Claude "automatically decides which tool fits the task". The Chat/Cowork mode selector was removed ([support 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)).
- **Output ▸ Design**, **Output ▸ Docs** (and a deck/Slides choice: "select 'Output' in the message box and choose one" of design, deck or doc, [support 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)) in the message box, and `/docs`.
- The **Artifacts tab**: pick a template or "New artifact".
- In Claude Code: `/design` and `/design-sync`.
- claude.ai/design still exists as the standalone Claude Design surface.

**Permission posture in the composer**: **Auto** or **Manual (default)**. Manual means "Claude asks before taking actions" ([support 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude), primary).

*Implication (inferred):* Claude kept a visible, explicit way to say "make me a Doc/Design" even though routing is automatic. The merge removed the *mode*, not the *intent affordance*.

---

## 2. How a transcript card links to the artifact

### 2.1 Card anatomy [bundle, primary]

- **Container**:
  - At most 520px wide, with the message-block corner radius (falling back to the base radius + 4px), a 0.5px strong border, a vertical gradient fill tinted for each type, and a soft drop shadow.
  - Background, border, shadow and gradient-stop changes transition over the base duration (200ms) with ease-out.
  - While the artifact is open in the panel, the card takes an "open" tint; an older variant used an accent-coloured border.
- **Thumbnail**:
  - A 56×56 stylised **sheet of paper**, with a glyph and tint chosen from the file extension or type.
  - Types map to four groups: File (text, markdown), Artifacts (HTML, React), Code, and Image (SVG, Mermaid).
  - Tints come from a palette. A real thumbnail image switches the card to gray.
- **Hover micro-story per kind** (the kinds are doc, txt, markdown, pdf, sheet, csv, code, json, html, slides, image, archive). Each "mark" on the sheet animates after a 120ms mark delay (the snap duration), with small per-part delays:
  - **code**: a rule "stamps", then a second rule *types* in 8 steps over 360ms with a caret that "rides" along;
  - **txt**: a lone caret blinks (a hard on/off step, 0.8s);
  - **markdown**: a hash mark, a rule, a bullet dot and a rule appear in sequence;
  - **sheet**: a sparkline path draws over 320ms;
  - **json**: two rules draw over 220ms, offset by 100ms;
  - **html**: a header bar stamps and a rule draws over 240ms;
  - **slides**: a conic sweep, 320ms;
  - **image**: four corner brackets "tighten" inward, 320ms;
  - **archive**: a zip of ticks.
  
  The sheet itself lifts 2px. The light angle (165°→200°), light reach and highlight strength animate, so a highlight sweeps the page (strength .75 in light mode, .12 in dark). Position and colours use the base duration; the lighting uses the slow duration (450ms), both ease-out. An under-sheet fans out behind it at −4° and opacity .7 (450ms, ease-out) [bundle].
  *(Fact-check correction: this card does **not** scale or rotate. The scale 1.035 / rotate ±0.065rad (≈3.7°) / 400ms `cubic-bezier(0,.9,.5,1.35)` hover belongs to the **fallback** artifact block, used when no override card is injected. There a 52×71px preview page peeks from the bottom, tilted 0.1rad (≈5.7°) at rest, and on hover straightens to ≈3.7° and scales 1.035. That fallback is also the "older variant" with the accent-coloured border when open.)*
- **Edit cards**: when an artifact is edited several times in a thread, cards for non-last edits are hidden at once (opacity 0, not clickable, no transition). The transcript shows one live card per artifact instead of a stack of stale ones.
- **Open affordance**: the whole card is one button that opens the artifact, with a separate path for modifier-click. The focus-visible ring is drawn on the card rather than on the inner button.
- **Library rows** animate in: a 12px drop into place and a fade over 300ms ease-out, with a backwards fill so staggered delays work [bundle].

### 2.2 Panel region and keyboard [bundle, primary]

- The panel is a region landmark labelled with the artifact's title, and it can take focus programmatically.
- **Escape** closes it (unless a nested popover or overlay is open) and **restores focus to the trigger**, falling back to the composer.
- The header has a **frame switcher** for moving between several artifacts in one conversation, plus pop-out, expand-preview, full-screen and version-history controls.
- The help centre describes "a slider icon in upper right" for navigating between multiple artifacts. Controls in the lower right cover view code, copy and download. There is a **version selector** ([support 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), primary).
- **Errors**: a "Try fixing with Claude" button copies the error into a new message (help centre; also present in the app).
- **Selection-to-edit**: in markdown artifacts, highlight text → "Edit with Claude" → changes apply "directly in the artifact window" (help centre).

### 2.3 Claude Science: a sibling pattern for linking and versions (primary)

[claude.com/docs/claude-science/artifacts](https://claude.com/docs/claude-science/artifacts), accessed 2026-09-23:

- Click a linked file in the conversation and it opens "in a tab beside the chat". **Ctrl/Cmd-click opens it full screen.** HTML gets zoom controls, including fit to width.
- Menu: Open, **Open beside session**, **View in context**, **Provenance**, Versions, Copy link, Star, Rename, Download, Delete.
- **Versions**: a **version stepper and a diff toggle** appear on an open file. Diff mode lets you pick the version to compare against, defaulting to the previous one. **Links Claude puts in the conversation point to the specific version that existed at the time.** This is a strong answer to "which version does this card show?".

---

## 3. Panel and window motion (open, close, resize, split)

### 3.1 Measured values [bundle, primary unless marked]

| Element | Behaviour | Values |
|---|---|---|
| Framed content swap | Content **crossfades** when the framed page swaps | opacity 120ms (snap duration); no transition under reduced motion |
| Split panes | Unfocused pane actions fade; a pane shows a 2px inset accent ring when **⌘ is held** over it (drag-to-rearrange hint) after a **600ms** delay; the dragged pane animates its shadow | actions opacity 120ms ease-out; ring 100ms; drag shadow 120ms |
| Pane grip | 32×3px pill fades in on hover | opacity 120ms |
| Sidebar collapsed "peek" | Hovering the edge reveals the sidebar body; the header clip swaps with a 140ms visibility delay to avoid flicker | body opacity 140ms ease + transform 180ms `cubic-bezier(.32,.72,0,1)` |
| Phone-width sidebar | A **drawer sheet** slides in from the left; it follows the finger while dragging, with transitions off | transform over the sheet duration with ease-out = 300ms quart-out |
| Any resize | **All transitions disabled while resizing** so panes track the pointer 1:1 | no transition |
| Sidebar edit scrim | Dim outside content | opacity/filter 200ms ease-out |
| Rail panels (Claude Code desktop) | Body fades in after the panel opens and exits immediately | enter opacity 120ms ease-out, delayed 60ms (fast duration); exit delay 0 |
| Tile overlays | translate with their own duration and easing tokens | (tokenised) |
| Image preview | **View Transitions API** morphs the thumbnail into the lightbox, animating inset, radius and a growing shadow | 350ms `cubic-bezier(.32,.72,0,1)` |

**Resize handles** exist for the sidebar, tasks panel, file tree, file viewer, pane rows and columns, adjacent pane pairs, and the logs drawer (UI strings) [bundle].

**Split view** (desktop): UI copy covers opening a session in split view, split view tiling into an adaptive grid, Cmd-click or drag to move a session out to its own window, and keyboard navigation between split panes [bundle]. The Claude Code desktop redesign (2026-04-14) made "every pane … drag-and-drop" with a side chat on **⌘;** and a shortcut sheet on **⌘/** ([claude.com/blog/claude-code-desktop-redesign](https://claude.com/blog/claude-code-desktop-redesign), primary).

### 3.2 Artifact-panel open/close: observed pattern (inferred)

Unlike the frame shell, I found no dedicated slide keyframe for the artifact panel itself in the CSS. The panel mounts as a split column. When there is no artifact it stays mounted but invisible and zero-sized, so the sandbox stays warm, and it swaps content with the 120ms crossfade. *Inferred*: Claude favours an **instant layout change plus a short fade** over a long slide, and turns off transitions during drag-resize.

---

## 4. Streaming: text versus artifacts versus visuals

### 4.1 Response text [bundle, primary values; mapping partly inferred]

- **Word fade at the streaming tail**: the streaming markdown renderer marks only the words at the streaming tail for animation. New words fade from opacity 0 to 1 over **100ms linear**, with a backwards fill. The renderer carries partial characters across chunks so a word split across chunks doesn't animate twice.
- **Grapheme blur-in** (not a streaming style; fact-check correction): opacity 0 + `blur(6px)` → clear over **90ms** `cubic-bezier(.215,.61,.355,1)` (cubic-out), with a 30ms stagger per grapheme. It is a per-character cascade used for **sidebar session titles and renamed titles**. When the title text changes, the old text blurs out over 200ms (opacity and blur, ease-out) and the new one cascades in. A visually hidden copy carries the text for screen readers. It is a good pattern for a Canvas/artifact title that Claude renames mid-stream.
- **Word reveal for marketing and greeting text**: a per-word fade of 400ms ease-out, and a separate greeting fade-in.
- **Incomplete markdown**: code fences, lists, tables and paragraphs have "fast paths", so an open fence renders as a code block before it closes. That avoids re-layout jumps (inferred from the renderer's fast-path code for open fences, lists and tables).
- **User message entry**: the user's bubble animates from scale .92 and 6px lower to rest over **450ms** `cubic-bezier(.34,1.3,.64,1)` (overshoot), with the transform origin on the right. The bubble pops in from the send side.
- **Message fade-up** (the surface is inferred, probably onboarding or greeting): a 10px rise over 1.1s with a CSS `linear()` spring curve that overshoots to ~1.16 and settles.
- **Message actions** (copy, retry and so on) reveal on focus/hover with the snap duration and snap easing.
- The setting copy ties reduced motion *explicitly* to streaming: "Reduce animation in streaming responses and other interface elements."

### 4.2 Artifacts while they are being made

- Help-centre view (primary): substantial outputs (script, markdown doc, Mermaid, React) go to "a separate panel on the right side". A code view and a preview exist per artifact, and a version selector appears when there are several versions.
- App (primary, structure) [bundle]: the panel tracks whether code or preview is showing, a raw-source toggle, sandbox loading, whether a refresh is possible, and the version count and selected version. Execution errors are tracked per version ("Try fixing with Claude").
- **Hosted artifacts update in place.** Claude Code artifacts: "the open page refreshes in place and teammates see the updates the moment they're published" ([blog, 2026-06-18](https://claude.com/blog/artifacts-in-claude-code), primary).
- **Hot swap (inferred from the runtime)** [bundle]: the artifact frame runtime includes a live-code engine. It installs component records, accepts **incremental deltas** against a base version, and swaps only the changed parts of a component (state, memoised values, handlers, effects) while keeping state. State is re-initialised only when its initialiser changes (checked by hash). *Inferred:* when Claude revises a Design page, the open page patches itself. It does not reload, so scroll, inputs and component state survive a new version. That is the smoothest "transition between versions" pattern observed. *(Fact-check: the delta handling and the initialiser hash check on state are in the runtime, and the runtime loads this engine as its live-code engine. The engine's files never mention Design Components, so the link to Design pages specifically remains inference.)*
- **Conflicts are surfaced in plain words** (UI strings) [bundle]: one message warns that a save would overwrite a version made while you were editing; another explains that someone else saved a newer version and the latest files reload with your edits preserved for you to review; a third tells you there is nothing new to save until a file is edited.

### 4.3 Inline visuals while streaming [imagine, primary]

- "Output streams token-by-token. Structure code so useful content appears early." For HTML: short `<style>` → content → `<script>` last. For SVG: `<defs>` → shapes immediately.
- Inline `style=""` is preferred so "inputs/controls must look correct mid-stream".
- "Gradients, shadows, and blur flash during streaming DOM diffs. Use solid flat fills instead." This shows the host **diffs the partial HTML into a live DOM as tokens arrive**.
- "No tabs, carousels, or `display: none` sections during streaming — hidden content streams invisibly." JS-driven steppers are fine *after* streaming. "Scripts execute after streaming".
- "Each SVG streams in with its own animation and card, creating a visual narrative"; several small diagrams separated by prose are preferred over one dense one.
- **Loading messages**: `show_widget` takes 1–4 `loading_messages` (~5 words each; playful unless the topic is serious, then "BORING"). The client parses them **from the partial JSON of the tool call while it streams** and shows them before any widget code arrives. The app also has a fallback loading state for when none are available [bundle].
- Community: "felt magical to watch that diagram slowly animating to life" (atonse, [HN 47352751](https://news.ycombinator.com/item?id=47352751), 2026-03-12).

---

## 5. Working, thinking and tool-use indicators

| Signal | What animates | Values | Source |
|---|---|---|---|
| **Shimmer text** (status labels such as "Thinking…", tool rows) | An `aria-hidden` clone overlays the text with a 120° highlight band sweeping across. Peak colour = the text colour mixed 30% with white, so it adapts to every text tone and to dark mode | `3s linear infinite`, inner keyframe eased `cubic-bezier(.714,.121,.211,.888)` between 15% and 85%; per-instance delay and play state | [bundle] |
| Older shimmer | background-position sweep | `2.25s infinite` | [bundle] |
| **Dot pulse** | 3px dot brightens alpha-3 → alpha-7 → alpha-3 | `1.8s linear infinite`, quart-out segments | [bundle] |
| **Clay status dot** ("Claude is working") | Breathes: scale .86↔1, brightness .96↔1.06 | `3s ease-in-out infinite`; disabled under reduced motion | [bundle] |
| **Progress timeline** (Cowork-style task steps) | Status line rises in and falls out; a spark mark "departs" (holds, then fades) as a step completes, then the next status fades in after it; three clay "quiet dots" bob while idle; step blocks enter with blur(4px) + translateY(5px) scale(.9) → clear | rise `.24s cubic-bezier(.3,.7,.4,1)`; fall `.18s ease-out` (−4px); spark depart `.42s linear`; status after spark `.25s` delayed `.21s`; quiet dots `1.9s` clay 3px; expand `.2s cubic-bezier(.19,1,.22,1)` via `grid-template-rows 0fr→1fr` | [bundle] |
| **To-do rail** | Shimmer band travels down the rail (paused until active); a newly revealed to-do row flashes alpha-1 and decays | `1.6s ease-in-out`; reveal-decay `1.4s` | [bundle] |
| Progress rail and knob | Rail grows scaleY 0→1; knob pops from scale .4 | `.22s` / `.18s ease-out`, motion-safe only | [bundle] |
| Checklist rows | chip-in translateY(10px) | `.28s cubic-bezier(.2,0,0,1)` | [bundle] |
| **Skeletons** | Placeholder rows **only appear after 0.5s** so fast loads never flash a skeleton; then a sweep band runs. Transcript placeholders wait longer: 2.5s | reveal `.15s ease-out` after .5s; sweep `2s linear` | [bundle] |
| **Comment being worked on** (editor comments; surface inferred from naming in the CSS, since the JS that applies it is not in the desktop app) | The commented text span's highlight pulses (toward the active-comment background at 50%) while it is being worked on; under reduced motion it becomes a static 2px underline | `1.6s ease-in-out infinite` | [bundle] |
| Saved tick | A "saved" check fades out after 2.5s | `.3s ease-out 2.5s` | [bundle] |
| Sent chip / byline | Sent chip ticks up 5px over 160ms; byline "sent" pulse | `.16s`; `.9s` | [bundle] |
| Approval promote (Claude Code) | A permission prompt is promoted into place | `.22s cubic-bezier(.215,.61,.355,1)` from −6px, scale .97 | [bundle] |
| Context compaction | Progress bar approaches but never passes 95% until done (an exponential approach with a 25s time constant) | asymptotic | [bundle, JS] |

**Copy ladder for thinking** (UI strings) [bundle]: a set of status labels that escalates the longer Claude thinks, from "Thinking…" to "Almost done thinking…", plus variants that name Claude or the connected tool. Thinking has three **view modes** (normal, thinking, verbose). Claude Code desktop documents "Verbose, Normal, and Summary" ([blog 2026-04-14](https://claude.com/blog/claude-code-desktop-redesign)). Settings let you show full thinking or a one-line recap of Claude's thinking above each tool group.

**Work-in-background copy** [bundle]: status copy tells the user that Claude is working on something in a task they can open to follow along (or hand off something else), or that Claude is working in Chrome and updates will appear as it progresses. This matches "start on desktop, track progress on mobile" ([support 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)).

*Inferred design rule:* **the only moving colour is clay, and it means Claude is acting.** Everything else in-flight is grey shimmer or alpha dots.

---

## 6. Versions and transitions between versions

- **Chat artifacts**: a version selector in the panel ([support 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)).
- **Cowork / unified artifacts**: "Each change saves a new version. Open version history to compare an earlier version with the current one or restore it." When sharing, you choose **Latest** or a **specific version**. "the link doesn't update until you select 'Latest' under Shared version" ([support 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork), primary). Since **2026-08-19**, older "live artifacts" can't be edited in place but stay viewable (same page).
- **Claude Code artifacts**: "a new version at the same link, with version history so you can restore at any time" ([blog 2026-06-18](https://claude.com/blog/artifacts-in-claude-code)).
- **Claude Docs**: "No version history yet" is a listed limitation ([support 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), primary). The Docs viewer bundle nevertheless contains `VersionBar` and `VersionPreviewPane` modules (primary-evidence doc). *Inferred:* it is being built.
- UI strings [bundle]: the app's version UI covers a versions list, earlier and older versions, restoring a version, making a copy of a numbered version, naming a version, an empty state when there are no other versions, and a prompt asking the user to allow Claude to save a version of an artifact.
- **Transition style** (inferred from the above): version changes are **swaps, not animations**. That means a 120ms crossfade of the frame, or a live in-place patch of the page (hot swap), plus a stepper or diff toggle for comparison. I found no morph or slide between versions.

---

## 7. Typed artifacts: how Design, Docs and Slides feel (brief; see primary-evidence doc for the model)

- **Claude Design** (launched 2026-04-17; inside conversations since 2026-09-16):
  - "a conversation with a canvas" beside it. Refine by chat (broad), **inline comments** (component-level: click a spot on the canvas) and **direct canvas edits**, meaning "drag, resize, and align elements" ([support 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), primary).
  - The announcement: "adjustment knobs to tweak spacing, color, and layout live" with "custom sliders (made by Claude)" ([anthropic.com/news/claude-design-anthropic-labs](https://www.anthropic.com/news/claude-design-anthropic-labs), 2026-04-17, primary).
  - **Tweaks** sits in the top toolbar next to **Comment** and **Present**. Clicking through controls re-renders the canvas live, with "No chat round-trip, no prompts, no waiting". You can ask chat for more tweaks ([aiuxdesign.guide](https://www.aiuxdesign.guide/guides/claude-design-learning-path/tweaks-explore-variations-without-chat), 2026-09-17, secondary).
  - Comments carry "Select for Send to Claude" checkboxes to **batch** several into one turn (secondary) (unverified: not on the cited aiuxdesign.guide Tweaks page). The app's comment layer can send a queued batch of comment cards, and element comments carry a reference to a screen capture [bundle].
  - A **scratchpad/drawing** surface sends doodles as context. Edit mode uses designer vocabulary ("tracking"). As of April you "can't just grab elements and freely move them around" (Alice Moore, [Builder.io](https://www.builder.io/blog/claude-design), 2026-04-29, secondary). Generation takes "minutes".
  - The September launch copy says you "can select an element and move it" ([claude.com/blog/cowork-is-now-claude](https://claude.com/blog/cowork-is-now-claude), 2026-09-16, primary). Direct manipulation has improved since April.
- **Docs**:
  - "Click into the doc and type. Your changes save automatically".
  - Select text → comment; @Claude in a thread asks for an edit.
  - "People with edit access can work on the same doc at the same time".
  - Charts come from connected data but "don't update on their own".
  - Export to Word, PDF, Markdown or Google Docs.
  
  Source: [support 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) (primary).
- **Slides**: edit in place, "present straight from Claude", download PPTX or PDF. Slides-type transitions are `fade | push | magic` (morph), and build-ins are `fade | rise | pop` (primary-evidence doc). Whether exported PPTX keeps editable text boxes is undocumented ([coursiv](https://coursiv.io/blog/claude-docs-slides-design), 2026-09-16, secondary).
- **Composer-type picker hover**: the "sheet-card" system animates when you hover a type or artifact block. *Inferred* from the shared sheet-kind CSS; only the code kind is explicitly keyed in the CSS, and the other kinds are keyed in JS [bundle].

---

## 8. Inline visuals: the "Imagine" design contract in detail [imagine, primary]

**History**: "Imagine with Claude" was a temporary research preview in which "Claude generates software on the fly", available "to Max subscribers for the next five days" at claude.ai/imagine, launched with Sonnet 4.5 on 2025-09-29 ([anthropic.com/news/claude-sonnet-4-5](https://www.anthropic.com/news/claude-sonnet-4-5), primary; [x.com/claudeai](https://x.com/claudeai/status/1972706823305052518)). A later extension to Pro is (unverified) ([DataCamp](https://www.datacamp.com/tutorial/imagine-with-claude), secondary). It had no persistence: "Once we refresh the page, everything is gone". Rendering broke in games (DataCamp). It became **custom visuals in chat** on **2026-03-12** as a beta "available on all plan types" ([claude.com/blog/claude-builds-visuals](https://claude.com/blog/claude-builds-visuals), primary). The help centre says it is "available to all Claude users on web and desktop, in both chat and Cowork", and that visuals "don't render on Claude for iOS or Claude for Android" ([support 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork), accessed 2026-09-23, primary). On launch day an HN user reported "iOS/iPadOS apps are not yet supporting the visualization API" (data-ottawa, HN 47352751). *(Fact-check: the quote "Mobile support … still coming" could not be found in any cited source (unverified). Business Standard does not mention platforms for visuals.)* Cowork followed on 2026-04-22, "on all paid plans" (blog update note). The tool is still named "Imagine — Visual Creation Suite".

**Philosophy** (quoted short):
- "Seamless: Users shouldn't notice where claude.ai ends and your widget begins."
- "Flat" (no gradients, mesh, noise).
- "Compact".
- Text goes in the response and visuals go in the tool, so there is no prose inside widgets. The user's chat-font setting applies only to response text.

**Layout and sizing**:
- The container is `display:block; width:100%`, **680px** wide.
- The SVG viewBox must be `0 0 680 H` so 1 unit = 1 CSS px. Safe area x 40–640.
- The iframe **auto-sizes to in-flow content height**. `position: fixed` collapses it to `min-height:100px`, so modal mockups use a normal-flow faux viewport.
- No nested scrolling.

**No widget-initiated fullscreen** (the host owns it):
- `requestFullscreen` is dead inside the iframe, and the model must "never call display-mode host APIs".
- If a user asks for "expand", build an **expanded-layout toggle**: "a synchronous CSS class flip on in-flow content… symmetric enter/exit". Mutate classes; never rebuild the DOM. "The host resizes to fit your content automatically."
- The host chrome itself does let users "expand it to full screen" ([support 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork), primary). So the rule keeps fullscreen out of model-authored code and does not deny it to users.

**Tokens** (host-provided CSS vars that adapt to light and dark):
- `--surface-0/1/2`, `--text-primary/secondary/muted`, role tints, `--border` (hairline) `/-strong/-stronger`, `--font-sans/-voice/-mono`, `--radius` 8px, `--pad-*`, `--gap-*`.
- Cards: white surface, 0.5px border, **12px radius**, padding 1rem 1.25rem.
- Metric cards: surface-1, no border, 13px label + 24px/500 value.
- Borders are always **0.5px**. The one exception is a **2px** `--border-accent` on a featured option.
- Buttons: transparent, 0.5px strong border, hover `--surface-1`, **active `scale(0.98)`**. A button that triggers `sendPrompt` ends with **↗**.
- Form controls come pre-styled: 36px inputs; range 4px track + 18px thumb.

**Typography**:
- Anthropic Sans by default; `--font-voice` (Anthropic Serif) for rare editorial moments.
- Stat-tile hero numbers use Anthropic Serif at ≥48px with tabular lining numerals.
- h1 22 / h2 18 / h3 16 at weight 500; body 16/400, line-height 1.7.
- "Two weights only: 400 regular, 500 bold", because 600/700 "look heavy against the host UI".
- Sentence case everywhere. Minimum 11px. SVG text is 14px (labels) or 12px (subtitles) only.

**Colour**:
- 9 ramps × 7 stops (purple, teal, coral, pink, gray, blue, green, amber, red), each with a light-mode quick pick (50 fill, 600 stroke, 800 title / 600 subtitle) and a dark-mode one (800 fill, 200 stroke, 100/200 text).
- Colour encodes meaning, never sequence; ≤2 ramps per diagram.
- Charts use a fixed **categorical order ("Cove")**: blue #2a78d6, orange #eb6834, aqua #1baf7a, yellow #eda100, magenta #e87ba4, green #008300, violet #6250d6, red #e34948. The 9th series folds into "Other".
- One y-axis only. Never colour alone; pair it with dash, marker or hatching.

**Icons**: the Tabler outline webfont only. No emoji, no hand-drawn icon paths.

**Interaction**:
- `sendPrompt(text)` sends a chat message "as if the user typed it", for drill-downs. Filtering, sorting and maths stay in JS.
- Links go through the host's link-confirmation dialog.
- SVG nodes with `class="node"` get a built-in hover dim and are clickable by default.
- Inputs must validate inline: 13px `--text-danger` error, cleared on edit.

**Sandbox**: the CSP allows only cdnjs, esm.sh, jsdelivr, unpkg and Google Fonts.

**Motion inside visuals**: animation is allowed only in interactive HTML visuals. It must use CSS `@keyframes` on `transform` and `opacity` only, keep loops under ~2s, and wrap every animation in `@media (prefers-reduced-motion: no-preference)`. Animations must show how the system *behaves*, such as convection or flow. The reference example uses:
- a 1.6s linear dash-offset flow;
- 0.6–0.8s flame flicker;
- a 3s glow;
- `.5s` opacity for state changes;
- `.2s` toggle thumb.

**Accessibility (mandatory)**:
- HTML widgets start with a visually hidden `<h2 class="sr-only">` one-sentence summary.
- SVG root: `role="img"` + `<title>` + `<desc>`.
- Chart.js canvases: `role="img"` + `aria-label` + fallback text.
- Icon-only buttons get `aria-label`, and decorative icons get `aria-hidden`.

**Settings and sharing** [bundle]:
- A toggle, "Inline visualizations", controls whether Claude may generate interactive visualizations, charts and diagrams directly in the conversation.
- Sharing is split (fact-check correction). The help centre says that in a shared chat "the visual renders for the recipient on web and desktop only and they must be logged in to view". Cowork visuals don't render via a share link because "Cowork sessions run locally" ([support 13979539](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork), primary). The app's placeholder "Interactive visual hidden when shared" renders only on the **path for MCP-served tool results** in a shared view. That matches the Cowork/MCP-served visualize tool, not every shared chat.
- In Cowork, clicking inside a visual does not send a follow-up prompt yet (no `sendPrompt` click-to-follow-up) (support 13979539).
- A hint suggests phrases such as "visualize this" or "show me" to get more visuals.

**Escalation rule**: "If the visual is complex … consider creating an artifact instead." This keeps the inline tier light.

---

## 9. MCP Apps: third-party UI inside chat

- Launched **2026-01-26** as "the first official MCP extension". Initial apps were Asana, Slack, Figma, Canva, Box, Hex, monday.com, Amplitude and others. Available "on mobile, web and desktop" per the updated blog ([claude.com/blog/interactive-tools-in-claude](https://claude.com/blog/interactive-tools-in-claude), primary); launch-day press said web and desktop ([MacRumors](https://www.macrumors.com/2026/01/27/claude-app-integration-asana-slack-figma-canva/), 2026-01-27, secondary).
- Spec: tools declare `ui://` HTML resources, and the host renders them "within a sandboxed iframe", with notifications in both directions and tool calls from the UI. Display modes are inline, fullscreen and picture-in-picture. Hosts theme through CSS variables, and apps auto-resize ([github.com/modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps), stable 2026-01-26, primary).
- **What Claude actually offers** [bundle]: the host context Claude sends uses the spec's fields for theme, locale, time zone, platform (desktop or web), device capabilities (hover detection), styles (Claude's tokens and fonts are pushed into the app), safe-area insets and container dimensions. It lists **only the inline and fullscreen display modes** (no picture-in-picture). UI copy tells users when an MCP server ships an MCP App with a visual UI.
- In the Claude Code desktop MCP App host, the display modes are inline only, or inline plus fullscreen when a pane host is available. There, fullscreen opens the app in an MCP App pane [bundle].
- *Inferred contrast (revised by fact-check)*: Claude-authored inline visuals may not **request** fullscreen from their own code, but users can still expand them through host chrome. Third-party MCP Apps may request fullscreen through the display-mode API.

---

## 10. The motion system (CDS)

### 10.1 Tokens [bundle, primary; the motion layer is also described in the imagine/CDS docs]

| Token | Value | Typical use |
|---|---|---|
| fast duration | 60ms | stagger offsets, delayed bodies |
| snap duration | 120ms | hovers, reveals, crossfades, message actions |
| base duration | 200ms | state changes, scrims, card colours |
| sheet duration | 300ms | drawers and sheets |
| slow duration | 450ms | lifts, user-bubble pop, lighting |
| ease-out | `cubic-bezier(.165,.84,.44,1)` (quart-out); a second definition `cubic-bezier(0,0,.2,1)` exists in another scope | default |
| snap easing | `cubic-bezier(.32,.72,0,1)` (the desktop frame shell's ease-out uses the same curve) | panels, sheets, view transitions |
| overshoot easing | `cubic-bezier(.34,1.3,.64,1)` | pops, bubbles, knobs |
| Tailwind extras | ease-in-out `cubic-bezier(.4,0,.2,1)`, ease-in `cubic-bezier(.4,0,1,1)` | legacy |

CDS docs call motion layer 6: "durations + easing curves (mode/density-invariant)". Density is a separate switch: `compact` for dev tools, `comfortable` for consumer, and a rem scale of 16/17 [imagine/CDS; bundle].

### 10.2 Signature motions

| Motion | Spec | Where |
|---|---|---|
| Reveal-in | translateY(4px)+fade, snap duration, ease-out | popovers, rows |
| Morph-in | translateY(3px)+fade, 180ms `cubic-bezier(.2,0,0,1)` | inline swaps |
| Slide-in-end | translateX(12px)+fade, 200ms | side content |
| Palette card morph | FLIP-style translate from origin, base duration, ease-out | command palette |
| Resolve check | checkbox glyph colour flips at 75% of twice the snap duration | task resolve |
| Grid rows in / expand rows | `grid-template-rows 0fr→1fr` + fade, 150–200ms | collapsibles, sidebar groups |
| Scroll fades | edge fade masks animate in and out as you scroll | lists, strips |
| Idle activity ripple | activity-bar scaleY ripple with CSS `linear()` spring, 550ms | desktop |

### 10.3 Reduced motion [bundle, primary]

- **Settings ▸ Appearance ▸ Motion**: segmented **System | Reduced**. Description: "Reduce animation in streaming responses and other interface elements." It sets a single attribute on the document root. Components' motion-safe variants are gated on that attribute, and pure-CSS paths also respect `@media (prefers-reduced-motion: reduce)` (61 blocks in the main sheet, 18 in shared styles, and more elsewhere).
- Under reduced motion:
  - the clay breathe stops (no animation, no transform);
  - timeline status enter/exit animations stop;
  - the frame crossfade becomes instant;
  - the sidebar scrim and edit transitions go off;
  - skeleton pulse and file-thumbnail pulses stop;
  - smooth scrolling into view becomes an instant jump (the artifact comments runtime checks the OS reduced-motion preference).
- Inline visuals must opt *in* to motion (`no-preference`), so the default is still [imagine].

---

## 11. Visual language: typography, colour, voice

- **Anthropic Type family**: Anthropic Sans, Serif and Mono, each with text and display variants. The identity is by **Geist** (Portland), and **Chester Jenkins (BSPK)** designed Sans and Serif ([Gooova, 2026-05-20](https://gooova.com/en/anthropic-designed-its-own-type-family/), secondary). The desktop app ships Anthropic Sans and Serif as variable fonts (roman and italic) plus web font cuts, including Anthropic Mono [bundle].
- **Voice rule**: "Serif is Claude's voice… Typography signals who's speaking before a word is read" (CDS principles [imagine]). Chat-font options [bundle]:
  - Serif (default): Claude text in serif, user text in UI sans;
  - Sans;
  - System;
  - "Atkinson Hyperlegible Next" (only listed when a feature flag is on or it is already selected);
  - OpenDyslexic.
  
  A separate **Interface font** covers "menus, sidebars, and panels" (Anthropic Sans | System | OpenDyslexic). Claude Code desktop also has a **transcript width** setting (Narrow / …).
- **Colour** [bundle / imagine]:
  - Clay #d97757 (emphasized #c6613f) is "Claude's color", reserved for "send, generate, the spark mark". User primary actions are accent blue, and everything else stays grey. The brand fill role uses the emphasized clay at rest and clay on hover, and it is fill-only (no brand text, background or border).
  - Surfaces: page #f9f9f7 (light) / #0b0b0b (dark); cards one step above (#fcfcfb / #1a1a19 in chart tokens).
  - Hairline `rgba(11,11,11,.10)` / `rgba(255,255,255,.10)`. Backdrop `#00000080`. Popover shadow `0 8px 24px /12%, 0 2px 6px /8%`.
  - Focus ring: `0 0 0 1px accent, 0 0 6px 1px bg-accent`.
- **Restraint rules** (CDS):
  - at most one accent-filled button per view;
  - "Avoid disabled buttons" (keep them enabled and explain on use);
  - dense lists use bordered rows, not cards;
  - at most **two floating elevations** on screen;
  - "too cluttered" is the most common design note.
- **UI copy voice** (CDS content):
  - sentence case; contractions;
  - "Ellipsis = in progress only" ("Claude is thinking…");
  - UI speaks as the product and never says "I". Only Claude in chat says "I";
  - no "successfully", "please", "!", "seamless/unlock/empower", or "simply/just/easy".

---

## 12. Desktop and mobile apps

- **Desktop** (macOS/Windows, Electron; 2.7032.0 on 2026-09-22):
  - bundles the web front end;
  - split view with an adaptive grid, and sessions dragged out into windows;
  - Pop out, full screen, resize handles everywhere;
  - a built-in browser in Claude Desktop (exists per [support 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude); launch date 2026-08-26 per [releasebot](https://releasebot.io/updates/anthropic/claude), secondary, date unverified);
  - files Claude creates save to a **Storage folder**, with **Trusted folders** in Settings ([support 16761823](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)).
  
  Claude Code desktop has drag-and-drop panes, ⌘; side chat and three view modes ([blog 2026-04-14](https://claude.com/blog/claude-code-desktop-redesign)). Local work (files, browser, computer use) needs Claude Desktop to stay open (same support page).
- **Mobile (iOS/Android)**:
  - The help centre says: ask for a design, deck or doc "and view the result in the Artifacts tab", but editing, templates and sharing changes need web or desktop ([support 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them); [support 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs), primary).
  - The **launch blog** says everything lives at "one shareable link you can open on your phone", then separately "You can select an element and move it". TechCrunch reports that users "can share generated documents or slides with a link and edit them on their phone" ([techcrunch 2026-09-16](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/), secondary).
  - *Reconciliation (inferred)*: the hosted artifact page is responsive and editable in a **mobile browser**. The desktop frame shell has a phone-width drawer sheet that follows a drag [bundle], and the Docs viewer has a `BottomSheet` module (primary-evidence doc). The *native* apps are view-first.
  - Mobile is also the **monitor** surface: tasks started on desktop show there, and you can redirect them.
  - App Store notes are generic ("Squashed some bugs…", v1.260916.19) ([App Store](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684), accessed 2026-09-23).

---

## 13. Accessibility summary

- **Panel**: a region landmark with the title, Escape to close, and focus restored to the trigger or composer [bundle].
- **Reduced motion**: an in-app setting plus the OS query, with streaming animation explicitly covered [bundle].
- **Readable fonts**: Atkinson Hyperlegible and OpenDyslexic for chat; OpenDyslexic for the interface [bundle].
- **Inline visuals**: an sr-only summary, SVG `role=img` + title/desc, canvas aria-label + fallback, colour never used alone, 11px minimum, 44px-class touch targets in Design output (primary-evidence doc) [imagine].
- **Shimmer text**: the animated clone is `aria-hidden`, so screen readers hear the label once [bundle].
- **Gaps (inferred)**: I found no evidence of live-region announcements for streaming artifact completion. Inline visuals do not render for logged-out share viewers, on the phone apps, or from Cowork share links. That is an accessibility and archival gap for shared links.

---

## 14. Weaknesses and user complaints

- **Mobile editing contradiction**: press coverage (TechCrunch) says phone editing and Anthropic's launch copy implies it, while support pages say view-only in the native apps (see §12).
- **Design comments can vanish**: the help centre lists "an intermittent issue where comments can disappear before Claude reads them" and says to paste feedback into chat instead ([support 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), primary).
- **Persistence**: users lost access to Claude Design projects after downgrading (Tell HN, 302 points, [HN 48128003](https://news.ycombinator.com/item?id=48128003), 2026-05-13). Anthropic's Thariq replied, "we'll make sure it's possible to download them even after you unsubscribe". A workaround is the data export, which has a `design_chats` directory.
- **Design output quality and sameness**: "You'll get a competent UI with little effort but nothing truly unique" (ljm, [HN 47806725](https://news.ycombinator.com/item?id=47806725), 2026-04-17, 762 comments). Critics call it an HTML generator with parametric controls rather than a layered canvas.
- **Tweaks buggy**: "Sometimes tweaks are mutually exclusive, and not all permutations actually react to your intent" (Builder.io, 2026-04-29). There was no history or branching ("no way to go back in the AI chat history"), and "there's no export to Figma" (same article).
- **Direct manipulation lagged** (April): elements couldn't be freely moved. By September, "select an element and move it" is advertised.
- **Inline visuals can over-persuade**: the feature "improves the perceived confidence of the LLM but doesn't do much for correctness of other outputs" (captainbland, HN 47352751, 2026-03-12). *(Fact-check: the earlier quote "removes the user from seeing the chat output" is not in that thread.)* A general UX jab in the same thread, "Anthropic's UX is just trash", came from **Razengan** and was about Sign in with Apple, not visuals (the notes had attributed it to Wowfunhappy, who in fact defended Anthropic). Visuals did not render on iOS at launch (data-ottawa; jzig got "a wonky HTML artifact" in the iOS app). Usage limits came up too: a periodic-table visual used up a $20-plan user's daily limit and came back as a JSX artifact, not inline (czk). *(Fact-check: huylenq's comment was a tip to say "show me a widget that…" to get inline output, not a usage-limit complaint.)*
- **Docs/Slides beta gaps**: no Docs version history, no comment-only access level, and doc activity missing from the Compliance API ([support 16923645](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)). PPTX editability is undocumented (coursiv, aitrove, 2026-09-16/17). *(Fact-check: coursiv also calls Docs co-editing undocumented, but the help centre documents it: "People with edit access can work on the same doc at the same time", with everyone's edits showing in real time (support 16923645).)* Some reviewers call the launch "a rename of existing features" (coursiv summary of reception).
- **Performance of Claude Design**: generation takes "minutes" (Builder.io). The help centre documents an occasional "Chat upstream error" with a new-tab workaround ([support 14604416](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)).
- **Sharing inline visuals**: shared chats show them only to logged-in viewers on web/desktop, and Cowork share links drop them (the placeholder reads "Interactive visual hidden when shared") [support 13979539; bundle].
- **Legacy churn**: live artifacts from Cowork lost in-place editing on 2026-08-19 ([support 14729249](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork)).

---

## 15. What this means for Juno's merge (cross-referenced with the Juno audit)

Juno's audit (`00-AUDIT-OVERVIEW.md`) already credits Juno with "a mature product motion system", meaning one token ladder across CSS, framer and Swift. The gaps it records: dock exits ignore reduced motion, the Mac canvas slides under Reduce Motion, document motion has no player, and the chat card is "rebuilt with a streaming sweep". Against Claude:

1. **Keep three tiers with distinct weights** (inline visual → card+panel → hosted typed artifact) and an explicit **Output ▸ Doc/Design/…** affordance in the composer, even when routing is automatic.
2. **One live card per artifact.** Hide superseded edit cards the way Claude does (opacity 0), and make the card a small physical object: a kind-specific thumbnail micro-animation on hover, a 2px lift, a light sweep and a fanned under-sheet within ~450ms. Links should point at the version that existed when the message was written (the Claude Science pattern).
3. **Version changes are swaps, not shows.** Use a ≤120ms crossfade or in-place patch, plus a stepper and diff toggle. Claude's runtime *patches* live pages and preserves state, which Juno's "Canvas remounts on a synthetic empty version" (X-02) and "dock shows previous revision" defects violate.
4. **Adopt Claude's in-flight vocabulary**:
   - shimmer text with an aria-hidden clone;
   - a 0.5s skeleton delay (never flash a skeleton for a fast load);
   - an asymptotic progress bar;
   - a comment-working pulse on the anchored text;
   - a progressive "thinking" copy ladder;
   - a single reserved "Claude colour" for Claude-initiated motion.
5. **Streaming**: animate only the tail. That means a word fade of ~100ms, plus fast paths for open fences, tables and lists. Keep the grapheme blur-in (90ms, 30ms stagger, 200ms blur-out of the old text) for titles that change, which is how Claude uses it. For generated HTML/SVG, stream into a live DOM with *style first, script last, nothing hidden during streaming, no gradients or shadows mid-stream*, and show model-authored `loading_messages` parsed from partial tool JSON.
6. **Reduced motion as an in-app setting** that names streaming explicitly, gated through one attribute on `:root`. Turn off all transitions during pointer-resize.
7. **Fullscreen policy**: Claude keeps fullscreen out of model-authored widget code (no `requestFullscreen`, no display-mode calls) and puts an "expand to full screen" control in host chrome. Third-party MCP Apps can request fullscreen through the spec's display-mode API. For Juno: the host owns expansion, and generated code never does.
8. **Don't repeat Claude's weak spots**:
   - make the native phone apps at least able to *comment* on and lightly edit typed artifacts, not just view them;
   - never gate access to made things on plan state;
   - keep inline visuals in shared views for every viewer, for example as a static snapshot. Claude already has "Copy as image", Download and "Save as artifact" for keeping a visual.

---

## Sources

| URL | Date | Type |
|---|---|---|
| https://claude.com/blog/cowork-is-now-claude | 2026-09-16 | primary |
| https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/ | 2026-09-16 | secondary |
| https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude | accessed 2026-09-23 | primary |
| https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | accessed 2026-09-23 | primary |
| https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork | accessed 2026-09-23 (notes 2026-08-19 change) | primary |
| https://support.claude.com/en/articles/14604416-get-started-with-claude-design | accessed 2026-09-23 | primary |
| https://support.claude.com/en/articles/16923645-get-started-with-claude-docs | accessed 2026-09-23 | primary |
| https://www.anthropic.com/news/claude-design-anthropic-labs | 2026-04-17 | primary |
| https://claude.com/blog/claude-builds-visuals | 2026-03-12 (updated 2026-04-22) | primary |
| https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork | accessed 2026-09-23 | primary |
| https://www.anthropic.com/news/claude-sonnet-4-5 | 2025-09-29 | primary |
| https://claude.com/blog/projects-redesigned | 2026-09-17 | primary |
| https://claude.com/blog/interactive-tools-in-claude | 2026-01-26 | primary |
| https://github.com/modelcontextprotocol/ext-apps | stable 2026-01-26 | primary |
| https://claude.com/blog/artifacts-in-claude-code | 2026-06-18 | primary |
| https://claude.com/blog/claude-code-desktop-redesign | 2026-04-14 | primary |
| https://claude.com/docs/claude-science/artifacts | accessed 2026-09-23 | primary |
| Observed in the shipped Claude desktop app, `/Applications/Claude.app` v2.7032.0 (stylesheets, scripts, UI strings, artifact frame runtime) | built 2026-09-22 | primary (first-hand) |
| `visualize` tool `read_me` ("Imagine — Visual Creation Suite" + CDS token and principle docs) | read 2026-09-23 | primary (first-hand) |
| https://releasebot.io/updates/anthropic/claude | Sept 2026 | secondary |
| https://x.com/claudeai/status/1972706823305052518 | 2025-09-29 | primary (vendor social) |
| https://www.datacamp.com/tutorial/imagine-with-claude | 2025-10 | secondary |
| https://www.business-standard.com/technology/tech-news/anthropic-claude-make-interactive-charts-visuals-chats-126031300438_1.html | 2026-03-13 | secondary |
| https://www.macrumors.com/2026/01/27/claude-app-integration-asana-slack-figma-canva/ | 2026-01-27 | secondary |
| https://www.builder.io/blog/claude-design | 2026-04-29 | secondary |
| https://www.aiuxdesign.guide/guides/claude-design-learning-path/tweaks-explore-variations-without-chat | ~2026-09-17 | secondary |
| https://gooova.com/en/anthropic-designed-its-own-type-family/ | 2026-05-20 | secondary |
| https://coursiv.io/blog/claude-docs-slides-design | 2026-09-16/17 | secondary |
| https://www.serverman.co.uk/ai/claude/claude-docs-and-slides-what-they-can-and-cant-do/ | 2026-09-16 | secondary |
| https://www.aitrove.ai/blog/claude-docs-slides-one-claude-workspace-2026 | 2026-09-17 | secondary |
| https://apps.apple.com/us/app/claude-by-anthropic/id6473753684 | accessed 2026-09-23 | primary (store listing) |
| https://news.ycombinator.com/item?id=47352751 (visuals launch thread) | 2026-03-12 | community |
| https://news.ycombinator.com/item?id=47806725 (Claude Design launch thread) | 2026-04-17 | community |
| https://news.ycombinator.com/item?id=48128003 (lost Design projects) | 2026-05-13 | community |
| https://samhenri.gold/blog/20260418-claude-design/ | 2026-04-18 | community |

---

## Fact-check (2026-09-23, adversarial pass)

**Method.** I re-read the shipped Claude desktop app directly: `/Applications/Claude.app` 2.7032.0, built 2026-09-22 06:02 UTC. That covered its stylesheets, scripts and English UI string catalogue. I re-read the full `visualize` read_me (1,203 lines). I fetched the cited help-centre articles and blog posts as raw HTML, plus HN threads through the Algolia API, the MCP Apps spec on GitHub and the App Store lookup API. WebSearch was exhausted, so second sources come from fetches only.

**Verified as written**
- Motion tokens: fast 60ms, snap .12s, base .2s, sheet .3s, slow .45s; ease-out `(.165,.84,.44,1)` (plus a second scope `(0,0,.2,1)`); snap `(.32,.72,0,1)`; overshoot `(.34,1.3,.64,1)`.
- Settings ▸ Appearance ▸ Motion is **System | Reduced**, with the exact description string. The code gates on a single root attribute. There are 61 `prefers-reduced-motion: reduce` blocks in the main sheet and 18 in shared styles.
- The word fade is 100ms linear with a backwards fill, applied only under `no-preference`.
- Card details: 520px maximum width, 56×56 thumbnail, and non-last edit cards hidden (opacity 0, not clickable, no transition).
- Inline-visual contract: 680px width; iframe sized to in-flow height; `transform`/`opacity`-only animation inside `no-preference`; "Gradients, shadows, and blur flash during streaming DOM diffs"; CDN allowlist; clay reserved for Claude-initiated actions.
- The MCP App host context lists the inline and fullscreen display modes. The spec (stable 2026-01-26) also defines picture-in-picture.
- Output ▸ Design / Docs and `/docs`; Auto vs Manual (default) in the message box; Chat/Cowork options removed. Native apps are view-only for designs and docs. Docs "Version history isn't available yet", has no comment-only access, and in-doc activity is missing from the Compliance API.
- Claude Science: version stepper + diff toggle; links point to "the specific version that existed at the time"; Ctrl/Cmd-click opens full screen.
- Skeleton reveal after `.5s` (transcript placeholders 2.5s). Editor-comment pulse `1.6s ease-in-out infinite`.
- Chat-font options (default → serif, Claude serif / user sans-serif; sans; system; Atkinson Hyperlegible Next; OpenDyslexic) and the Interface font setting (Anthropic Sans | System | OpenDyslexic).
- Other verified items: the timeline, shimmer, dot-pulse, clay-breathe and user-bubble values; the framed-content 120ms crossfade; the image view transition 350ms; the 600ms ⌘-held pane hint; and every cited UI string.
- Blog dates and quotes: visuals 2026-03-12 and Cowork 2026-04-22; MCP Apps 2026-01-26 on mobile, web and desktop; Claude Code artifacts 2026-06-18 "refreshes in place"; Code desktop redesign 2026-04-14 (⌘; side chat, ⌘/ shortcuts, Verbose/Normal/Summary); Claude Design 2026-04-17 ("adjustment knobs", "custom sliders (made by Claude)"); merge post 2026-09-16.
- Other verified sources: HN 48128003 (302 points, Thariq's reply, `design_chats`); ljm quote in HN 47806725; Builder.io quotes except one (below); aiuxdesign Tweaks page; Gooova type-family attribution; App Store 1.260916.19 dated 2026-09-17.

**Corrected (refuted or partly wrong)**
1. **Grapheme blur-in** was listed as a streaming-text style. It is used for **sidebar session titles and renamed titles** (old text blurs out over 200ms, new graphemes cascade in). Fixed in the TL;DR, §4.1 and the Juno list.
2. **Card hover.** The current sheet card lifts 2px, sweeps light and fans the under-sheet at −4° over 450ms. The scale 1.035 / 0.065rad / 400ms `cubic-bezier(0,.9,.5,1.35)` belongs to the **fallback legacy card**, which rests at 0.1rad and straightens on hover. The "8 steps / 360ms riding caret" is the **code** kind, not text. Fixed in the TL;DR and §2.1.
3. **"No fullscreen by design"** was only true of widget code. The help centre says users can "expand it to full screen", so the host owns fullscreen. Fixed in the TL;DR, §8, §9 and Juno item 7.
4. **"Hidden in shared chats"**: shared chats render visuals for logged-in web/desktop viewers. The app's placeholder sits on the share path for MCP-served tool results, which matches the help centre's note that Cowork visuals don't render via share links. Fixed in §8, §13 and §14.
5. **Mobile contradiction wording.** Anthropic's blog says "open on your phone". The phone-editing claim is TechCrunch's ("edit them on their phone"). The earlier quote "edit capabilities on mobile devices" does not appear in that article. Fixed.
6. **HN attributions.** "removes the user from seeing the chat output" is not in HN 47352751; replaced with captainbland's actual quote. "Anthropic's UX is just trash" is by Razengan and is about Sign in with Apple, not by Wowfunhappy. The usage-limit complaint is czk's; huylenq's comment was a "widget" prompting tip. Fixed.
7. **Builder.io "non-functional"** is not in the article. Replaced with the real wording.
8. **coursiv on "co-editing undocumented"** is contradicted by help centre 16923645. Noted.
9. **Visuals platforms.** The blog says "all plan types" and names no platforms. Web+desktop-only and no iOS/Android rendering come from help centre 13979539. The quote "Mobile support … still coming" was not found, so it is tagged unverified.
10. **Imagine with Claude.** Now sourced to anthropic.com (2025-09-29, Max, five days). "then Pro" is tagged unverified.
11. **Projects library** re-sourced to the primary blog (2026-09-17, Claude Code projects beta).
12. **Minor fixes:** message-fade-up overshoot is ~1.16, not ~1.11; Atkinson is "Atkinson Hyperlegible Next" and flag-gated; the clay brand fill uses clay-emphasized at rest; the Output menu also offers decks; token counts are 72/56 occurrences, of which 66/53 are token reads.

**Added from the checks:** the ways to keep a visual (Copy as image, Download .svg/.html, Save as artifact); no click-to-follow-up in Cowork; the Design inline-comment disappearance known issue; and the Code-desktop MCP host's conditional fullscreen.

**Still inferred or unverified:**
- The live-code hot swap preserving state for Design pages. The runtime behaviour is confirmed, but the link to Design pages is not.
- The comment-pulse surface. The CSS is confirmed, but the applying JS is not in the desktop app.
- Partial-JSON parsing of `loading_messages`.
- The "Select for Send to Claude" checkboxes.
- The releasebot 2026-08-26 built-in-browser date.
