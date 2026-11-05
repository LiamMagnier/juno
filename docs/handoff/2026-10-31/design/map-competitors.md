# Competitor craft map: Claude, ChatGPT, Apple (as of 31 Oct 2026)

Research brief for Alevr's UI quality push. The aim is behaviour and measurable patterns (sizes, radii, timings, easings, states), not branding. Each claim carries a source tag such as `[O1a]`, and every tag resolves to a URL in the **Sources** section at the end.

## How to read this report

**Evidence strength differs a lot by product, so read the confidence notes.**

- **ChatGPT is the best evidenced.** OpenAI publishes `openai/apps-sdk-ui`, "a lightweight, accessible design system for building high-quality ChatGPT apps", with Tailwind tokens and React components [O1]. I cloned it (commit `0f00143`, 5 May 2026) and read the CSS directly. These are real production tokens: menu radius, shadows, easings, press scales and so on. One caveat is that the package targets apps embedded *in* ChatGPT, not the ChatGPT shell itself. It does, however, ship ChatGPT-shell tokens (`--composer-radius`, `--chat-max-width`, `--user-message-background-color`), so it clearly mirrors the host [O1b].
- **Apple is well evidenced for rules and poorly evidenced for pixels.** I read the HIG pages in full through Apple's DocC JSON endpoints, along with WWDC transcripts and SwiftUI API docs. Apple publishes rules and a few hard numbers (hit targets, type scales, spring parameters). It does not publish menu pixel metrics; those come from third-party replicas and are marked as such.
- **Claude is the weakest evidenced.** Anthropic publishes no design system. Behaviour comes from official support articles, which I read in full. Visual values come from third-party teardowns, a DOM-automation tool's notes, and search-indexed CSS. **No public source gives Claude's motion timings or exact radii.**
- **Several hosts were blocked by this session's network policy.** These include claude.ai and its asset CDN, help.openai.com, developers.openai.com, react-spectrum.adobe.com, ai-design-patterns.pages.dev, aiuxplayground.com, smashingmagazine.com, nngroup.com, m3.material.io, daringfireball.net and macrumors.com. For those I relied on search-engine result summaries; their tags carry *(summary)* in the source list. Allowing those hosts would let someone verify the summarised claims.

---

## 1. Menus

### 1.1 Side-by-side

| Attribute | ChatGPT (apps-sdk-ui tokens) | Apple (HIG + WWDC25) | Claude (support docs + teardowns) |
|---|---|---|---|
| Container radius | 12px (`--menu-radius: var(--radius-xl)`) [O1b][O1c] | Concentric with the source control. Menus "pop open" out of the glass button [W3][W6] | Not published |
| Inner inset (gutter) | 6px padding (`spacing(1.5)`) [O1b] | "Concentric shapes calculate their radius by subtracting padding from the parent's" [W4] | Not published |
| Item highlight radius | `calc(menu-radius − gutter)` = **6px**, so the highlight is concentric [O1a] | Same concentric rule [W4][W7] | Not published |
| Item height (pointer) | 6px + 20px line + 6px = **32px**; padding 6px/8px; icon gap 6px [O1b] | Not published. Third-party macOS replicas use 20–22pt rows and a 6pt container radius [X6][X7 *(summary)*]. Minimum macOS control 20×20pt, default 28×28pt [A16] | Not published |
| Item height (touch) | No separate touch token. Control scale runs 22–48px, including a 44px size [O1c] | Hit target ≥44×44pt on iOS [A17][A16]. Third-party iOS 26 kit taken from Apple's Figma: **286pt wide, 34pt radius, 52pt rows, 10pt vertical padding, 16pt group padding** [X5] | Not published |
| Menu text | 14px / 20px line height. The code comment says the line height must be "~an even number for centering with icons" [O1b] | macOS body 13/16; iOS body 17/22 [A13] | UI in Anthropic Sans [C11 *(summary)*] |
| Width | `min-width: 300px` default, `max-width` = available viewport [O1a]. Select list defaults to the trigger width [O1f] | iOS 26 ≈286pt [X5] | Not published |
| Max height | `min(available, 1200px)`, then scrolls [O1a]. Select list `min(400px, available)` [O1f] | Long menus are acceptable only for user or dynamic content (History, Bookmarks); otherwise split them or add a submenu [A1] | Teardown: the "+" menu list "gets long" [C8 *(summary)*] |
| Columns | Indicator slot → icon → label → trailing actions. Radio/checkbox indicators can sit at the end via `data-indicator-position="end"` [O1a] | WWDC25: menus on every platform share one anatomy, "selection indicator, icon, label, and accessory item" [W4]. Icons sit "consistently on the leading edge" [W7] and form "a single column that's easy to scan" [W5] | No shortcut column documented. (For contrast, ChatGPT's "+" menu shows "Add photos & files ⌘U" [O3]) |
| Hover/keyboard highlight | Neutral fill at 8% alpha (light) / 10% (dark); text colour does not change [O1b][O1a] | System-defined [A10] | — |
| Selection (persisting state) | Select: **semibold label + 16px check** [O1f]. Menu radio: filled 18px dot. Checkbox: filled 18px circle [O1a][O1b] | **Checkmark** for "an attribute currently in effect" [A1]. Pop-up buttons show the current selection in the button itself [A3] | Model menu marks the recommended effort "Default". Thinking is a **toggle switch** inside the Effort submenu [C1]. Web search shows as a **checkmark** in the "+" menu [C9 *(summary)*] |
| Section headers | Option group heading: secondary text colour, same padding as items, 6px extra top margin, none on the first group [O1f] | Context menus "seldom" have a title; add one only to clarify the effect, e.g. "3 messages" [A2] | — |
| Separators | 1px, `--color-border` (10%/12% alpha), **full-bleed** (negative horizontal margin = gutter), 6px vertical gap [O1a][O1b][O1c] | Separator is "a horizontal line or a short gap". Context menus should have no more than **about three groups** [A1][A2] | — |
| Disabled | `opacity: 0.5`, no highlight, `not-allowed` cursor [O1a] | Menus: dim unavailable items [A1]. **Context menus: hide them instead**, except Cut/Copy/Paste on macOS [A2] | — |
| Destructive | — | Red text, placed last in context menus [A2]. Pull-down destructive item triggers a confirming action sheet or popover [A4] | — |
| Icons in menus | Icon slot optional | **2026 reversal.** HIG (8 Jun 2026): "Use menu item icons sparingly", and "provide icons for all menu items in a group, or none of them" [A1]. macOS 27 SDK hides menu item images by default (`preferredImageVisibility`) [X1 *(summary)*][X2 *(summary)*] | — |

### 1.2 Submenus

- **Apple's rules.** A chevron after the label signals a submenu. Use submenus sparingly, keep them to **one level**, and if a submenu holds **more than about five items**, consider a new menu instead [A1][A2]. Name the submenu with the repeated term, e.g. "Sort by" [A1]. Keep the submenu openable even when all of its children are disabled [A1].
- **Open delay and safe triangle, measured in Radix.** ChatGPT's design system is built on Radix: it uses `--radix-dropdown-menu-*` variables [O1a]. A third-party DOM probe reports that Claude's model picker also uses a Radix popover [C10]. In `@radix-ui/react-menu` 2.2.1 [R1]:
  - A sub-trigger opens **100ms** after pointer movement over it.
  - On pointer-leave, Radix builds a grace polygon. It runs from the pointer (with a 5px bleed) to the near and far corners of the submenu, and stays valid for **300ms** while the pointer keeps moving toward that side.
  - Typeahead resets after **1000ms**.
- **Classic menu-aim, for comparison.** jQuery-menu-aim (the Amazon pattern) uses a **300ms** delay, a **75px** tolerance and the last **3** mouse positions [R2][R3 *(summary)*]. Baymard suggests 300–500ms when you rely on delay alone [R4 *(summary)*]. That is slower than geometry-based aim.
- **ChatGPT submenu affordance.** The trailing chevron sits at 75% opacity and goes to 100% when the item is highlighted or open. Its `margin-right: -2px` corrects the SVG canvas offset [O1a].
- **Claude.** Flyouts (Skills, More models, Connectors → Manage connectors) open on hover and **keep the parent "+" menu open** [C2][C8 *(summary)*]. The Effort submenu opens on "mouse over" [C1].

### 1.3 Search and keyboard inside menus

- **macOS.** The Help menu has a search field that finds menu commands and highlights where each lives. ⌘⇧/ opens it [X8 *(summary)*].
- **Claude.** Typing "/" in the composer opens the same menu as "+" [C2]. Whether it filters as you type is not confirmed in official docs.
- **Radix menus (ChatGPT, and reportedly Claude).** Type-to-jump works, with a 1s buffer [R1].
- **ChatGPT.** Shows keyboard shortcuts as a trailing column ("Add photos & files ⌘U"). Escape closes the menu once; a second Escape removes the armed tool pill [O3].
- **Apple shortcut rules.** Show shortcuts in main menus, not in context menus [A2]. Modifier order is always **Control, Option, Shift, Command** [A19].

### 1.4 Labels and structure (Apple rules worth adopting verbatim)

- Use title-style capitalisation, drop articles, and add an ellipsis "…" when the item needs more input [A1].
- Put frequent items first. Context menus should order items so the most used sits **nearest the pointer**, which can mean reversing the list when the menu opens upward [A2].
- Pull-down menus should have **at least 3 items**; fewer is better served by buttons or toggles [A4].
- iOS menus offer a "small" layout (top row of 4 icon-only items) and a "medium" layout (3 icon+label items) for frequent actions [A1].

---

## 2. Composer

### 2.1 ChatGPT

- **Layout.** Single rounded field: `--composer-radius` = **24px**, background = elevated surface (white in light, `#303030` in dark), 12px gutter (8px compact). The thread gutter is 16px, which the code comment explains as "12px (composer gutter) + 4px (input inset)". Chat column `--chat-max-width: 800px` [O1b][O1d].
- **Left side.** A "+" button labelled "Add files and more" [O3]. As of 15 Jun 2026 its menu held:
  - "Add photos & files ⌘U" and "Recent files"
  - **radio** items "Create image", "Deep research" and "Web search"
  - "More" (submenu) and "Projects"
- **Armed tools become removable pills** inside the composer ("Search, click to remove"). Deep research replaces the placeholder ("Get a detailed report") and adds "Apps" and "Sites" pickers in the composer [O3]. Third-party analysis describes this as keeping "the default bar sparse" and using removable chips to show scope before send [O7 *(summary)*].
- **Model picker sits in the composer**, no longer in the header [O6 *(summary)*]. In June 2026 its menu listed "Instant, Medium, High, Extra High, Pro Extended" plus a "GPT-5.5" submenu [O3]. OpenAI's help centre describes Instant, Thinking and a Configure option [O5 *(summary)*].
- **Right side.** Small mic = dictation; waveform = voice mode [O10 *(summary)*]. Users report the mic is replaced by Send as soon as a character is typed [O9 *(summary)*].
- **Send ↔ Stop.** Distinct `send-button` and `stop-button` controls occupy the same slot. The automation tool also sends Escape to stop generation; that this is a user-facing shortcut is unverified [O4]. The Apps SDK `Stop` glyph is a 12/24 rounded square with a 2-unit corner radius [O1j].
- **Growth.** The Apps SDK Textarea auto-resizes up to `maxRows`, default `max(rows, 10)` [O1l]. For the ChatGPT composer itself, the automation tool's selector chain targets `#prompt-textarea` and ProseMirror contenteditable fallbacks [O4].
- **Attachments.** Each attachment is a `role="group"` chip named by filename, with a "Remove file" button and a `progressbar` while uploading [O4].
- **User bubble.** Fill at 5% alpha (light) / 8% (dark) of the text colour [O1b].

### 2.2 Claude

- **Left side.** A "+" button sits in the lower-left of the chat box; typing "/" opens the same menu [C2][C3]. Items include "Add files or photos" and Connectors (hover → "Manage connectors") [C2][C3]. Teardowns also list screenshot, project, skills, plugins, style and a web-search toggle [C8 *(summary)*][C9 *(summary)*]. An older article placed tools behind a "Search and tools" button [C6]; the current model/effort article no longer mentions it [C1].
- **Right side.** The model menu sits **next to the send button** and shows the model name and effort level inline [C1]. Inside it:
  - "More models"
  - an "Effort" submenu (Low, Medium, High, Extra high, Max, with one tagged "Default")
  - a Thinking toggle
  - Changes "apply starting with Claude's next response" [C1].
- **Voice.** On web and desktop, a sound-wave button sits in the lower right. Voice mode stays on until you press the "Stop" button in the same corner [C4].
- **Mobile.** Mic on the right of the input, with the voice-mode wave icon next to it. Dictation shows an arrow to send and an "X" to cancel [C5][C4].
- **Attachments.** Drag-and-drop into the window, paste images, up to **20 files per chat**, 500MB per file, images up to 8000×8000px [C3]. Teardown: images show "inside the composer card above the prompt" [C8 *(summary)*].
- **Implementation.** ProseMirror contenteditable; send button `aria-label="Send message"`; `data-is-streaming` on the streaming turn [C10]. Claude has had a stop control since 2024 [C13 *(summary)*].
- **Known rough edge.** A user report says the web mic disappears once the composer has text, so interrupted dictation cannot resume [C15 *(summary)*].

### 2.3 Pattern both chat apps converge on

- One rounded card holds the text plus a bottom tools row.
- Left side: add/attach entry point.
- Right side: model/mode control, then voice/mic, then a send button that **morphs into stop** while streaming.
- Armed modes are made visible before send, as a pill (ChatGPT) or a checkmark or toggle (Claude).

Apple's parallel principle: keep primary actions discoverable and never hide them all in one pull-down [A4]. Toolbar groups should stay at **three or fewer** [A10].

---

## 3. Dialogs, sheets, popovers, toasts

| Topic | ChatGPT tokens | Apple |
|---|---|---|
| Dialog size | min 250px, **max 450px**, inner padding 20px [O1b] | macOS sheets: "reasonable default size", resizable only when useful [A6] |
| Scrim | Black **30% (light) / 50% (dark)**. Alternative "fade" backdrop = elevated surface at 60% [O1b] | The parent is dimmed for modality [A6]. Liquid Glass sheets pair with a dimming layer [W4]. Clear glass over bright content needs a **35%** dark dim [A14] |
| Popover | radius 12px, min 300px, max 700px, opt-in translucent blur(16px) [O1e][O1b] | Arrow points at the source; one popover at a time; no cascades; animate size changes [A9] |
| Alert/inline alert | radius 12px, gap 12px, padding 16px, 14px text, semibold title [O1b] | Title, optional message, **≤3 buttons**. Default action trailing (row) or top (stack); Cancel leading or bottom. Destructive style only for actions the person *didn't* explicitly choose. Esc or ⌘. cancels. Titles ≤2 lines [A7] |
| Action sheet | — | ≤4 buttons including Cancel. Destructive at the top, Cancel at the bottom [A8]. On iPad, anchored to the source with no Cancel button, because tapping outside cancels [W6] |
| Sheets (mobile) | — | Medium (~half) and large detents, a grabber, swipe to dismiss. Cancel leading, Done trailing; never show Cancel, Done and Back together; one sheet at a time [A6]. iOS 26: partial-height sheets are **inset with Liquid Glass**, then turn opaque and anchor to the screen edges at full height [W7]. Sheets, menus, alerts and popovers **morph out of the button that presents them** [W6][W7] |
| Toasts | No toast component in apps-sdk-ui [O1] | No toast component. Prefer status shown in context; reserve alerts for critical, actionable information; confirm completions only when significant [A18][A7] |

Claude: no public spec for dialog sizes or toasts. The Connectors directory opens as a modal [C2].

---

## 4. Iconography

- **Apple.** SF Symbols come in **9 weights** that map to SF font weights, plus 3 scales (small/medium/large) defined relative to SF cap height, so symbols stay weight-matched to adjacent text [A11]. Use outline variants in toolbars and lists and fill variants for tab bars and selection [A11]. Match icon weight to adjacent text; pad asymmetric icons for **optical** centering; keep size, detail and stroke consistent [A12]. Negative side margins align badged symbols [A11]. Toolbar symbols go borderless because "the section provides a visible container" [A10].
- **Apple icon density lesson.** Tahoe's icon-on-every-item menus (~12×12px glyphs) were widely criticised [X4 *(summary)*]. Apple reversed course in 2026, both in the HIG and in the macOS 27 SDK defaults [A1][X1 *(summary)*][X3 *(summary)*]. WWDC25 guidance still applies: "When actions are closely related, such as multiple ways to copy, don't repeat or tweak icons. Use the symbol once to introduce the group" [W4].
- **ChatGPT.** All 755 icons use a 24×24 viewBox [O1j]:
  - **Stroke.** Strokes are outlined to fills at a **2-unit stroke with round caps** (e.g. Plus `M12 5a1 1 0 0 1 1 1v5h5…`). That renders as 1.33px at 16px, 1.5px at 18px and 1.67px at 20px.
  - **Size variants.** The Sm/Md/Lg variants change the glyph's extent on the canvas, not the stroke (ArrowUpSm spans y 5–19, ArrowUpLg y 3–21).
  - **Context-tuned variants.** `PlusComposer` uses a heavier 2.13-unit stroke; `VoiceBold` uses 3-unit bars against `VoiceLight`'s 2-unit bars.
  - **Icon sizes.** Control icons come in 16/18/20/22/24px [O1c].
  - **Hand-tuned offsets.** Menu code applies optical nudges: −2px on the submenu chevron, −5px on trailing item actions [O1a].
- **Claude.** No official icon spec found.

---

## 5. Motion

### 5.1 ChatGPT, measured from tokens

| Element | Enter | Exit | Notes |
|---|---|---|---|
| Menu / Popover / Select | **350ms**, opacity 0→1 + scale **0.95→1**, `cubic-bezier(0.19, 1, 0.22, 1)` | **200ms**, back to 0.95 / 0, `cubic-bezier(0.8, 0, 0.4, 1)` | `transform-origin` = the Radix-computed trigger side, so the menu grows *from* its anchor. An `[data-interrupted]` state retargets mid-animation [O1a][O1e][O1f][O1c] |
| Perceived timing | Enter reaches 90% at **~108ms** and 95% at ~139ms | Exit reaches 50% at ~115ms | My computation from the bezier curves. The "350ms" enter *feels* like ~110ms |
| Item highlight | 150ms, scale 0.98→1 + fade, enter curve | — | Press shrinks the pill back to `--scale` [O1a][O1c] |
| Press scale | Width-aware: ≤80px → **0.96**, ≤150 → 0.97, ≤220 → 0.98, default 0.985, >600px → 0.995 | — | Set on pointer-enter [O1i][O1h] |
| Radio / checkbox indicator | 400ms scale-in / 500ms fade-in | — | **Suppressed while the menu itself is entering** [O1a] |
| Tooltip | open delay **150ms** | — | radius 8px, max 300px [O1g] |
| Other curves | `--cubic-exit-snappy: (0.65, 0, 0.4, 1)` "less inertia delay"; `--cubic-move: (0.65, 0, 0.35, 1)`; basic `ease` 150ms | | [O1c] |
| Reduced motion | `prefersReducedMotion()` helper; animated scroll is skipped | | [O1i] |

### 5.2 Apple

- **Springs are the default.** SwiftUI's default `spring(duration: 0.5, bounce: 0.0)` [D1]. Presets: `.smooth` (no bounce), `.snappy` ("small amount of bounce"), `.bouncy` ("higher amount of bounce"), each 0.5s by default and tunable with `extraBounce` [D2].
- **Bounce guidance** [W1]:
  - "A small bounce, like around 15%" feels brisk; ~30% feels noticeably bouncy.
  - Be "cautious about using values higher than around 0.4".
  - "When you're not sure, use a spring with bounce 0."
  - `duration` is a *perceptual* duration, not the settling time.
- **Interruptibility and velocity** [W1][W2][W8]. Springs keep velocity continuous on retarget. Interfaces must allow "constant redirection and interruption", and people should be able to cancel motion rather than wait for it [A5].
- **Brevity** [A5]. Feedback motion should be "brief and precise". Avoid adding motion to frequent interactions, and keep motion optional (pair it with haptics or sound).
- **Liquid Glass motion** [W3].
  - Menus **pop open from the tapped control** ("keeps everything right where you just tapped").
  - Glass "materialize[s]" by modulating lensing rather than fading.
  - Glass grows "thicker", with "deeper, richer shadows", as it expands into a menu.
  - It responds to touch by "instantly flexing and energizing with light".
  - On a trackpad the effect is "more subdued" [A5].
- **Reduce Motion** [A16]. Tighten springs (less bounce). Track gestures directly. Avoid animating z-depth. **Replace x/y/z transitions with fades.** Avoid animating into and out of blur.

### 5.3 Claude

No published motion values. Treat Claude as the "quiet" reference only by observation; nothing citable.

### 5.4 Cross-industry heuristics (secondary)

NN/g's guidance as quoted elsewhere: ~100ms for simple feedback, 200–300ms for modals, ~400–500ms upper bound [R5 *(summary)*]. ChatGPT's tokens fit this: ~110ms perceived enter, faster exit.

---

## 6. Elevation, borders, dark mode

- **ChatGPT floating surfaces.** Menus, popovers, selects and tooltips all use `--shadow` plus `--shadow-hairline` [O1a][O1e][O1g].
  - `--shadow` = `0 10px 15px -3px` + `0 4px 6px -4px`, at **10% black (light) / 20% (dark)**.
  - Hairline ring = `0 0 0 1px`, which drops to **0.5px on ≥1.5dppx screens**. Colour is black 8% → 10% at 0.5px (light) and **white 10% → 12%** (dark) [O1c][O1d].
- **ChatGPT elevation scale.** 100: `0 1 2 −1`; 200: `0 2 4 −1`; 300: `0 4 8 −2`; 400: `0 8 16 −4` [O1d].
  - Alpha: 0.08/0.08/0.10/0.12 in light; **0.20/0.20/0.36/0.30 in dark** [O1d].
  - Each level also has "strong" (×1.25) and "stronger" (×1.6) variants [O1c].
- **ChatGPT dark surfaces get lighter as they rise.**
  - Secondary and tertiary surfaces `#181818` / `#131313`, main surface `#212121`, elevated `#303030`, elevated-secondary `#414141` [O1c][O1d].
  - On a lighter elevated grey, the hairline is dropped ("no edge on lighter gray") [O1d].
  - Borders run 5/10/15% alpha in light and 6/12/20% in dark [O1c].
- **Apple.** Dark Mode uses **base** (dimmer) and **elevated** (brighter) background sets; popovers and sheets switch to elevated automatically [A15]. Minimum contrast is 4.5:1, aim for 7:1 on small custom text [A15]. Liquid Glass shadows adapt to what's behind: more opaque over text, lighter over plain light backgrounds [W3]. Scroll-edge effects **replace hard dividers** with a subtle blur, one per view [W4]. Test with Increase Contrast and Reduce Transparency [A15].
- **Claude (third-party, unverified).** Light canvas ≈ `#faf9f5` with a coral accent [C12 *(summary)*]. Dark ≈ `#262624` chat, `#1f1e1d` sidebar, `#30302e` elevated [C12 *(summary)*]. Commentators describe the depth as thin borders and rings rather than heavy drop shadows. Treat this as a direction only.

---

## 7. Typography rhythm

- **Apple.**
  - Defaults: iOS body **17/22** (minimum 11pt); macOS body **13/16** (minimum 10pt) [A13].
  - iOS Large (default) scale: Large Title 34/41, Title 1 28/34, Title 2 22/28, Title 3 20/25, Headline 17/22 semibold, Callout 16/21, Subhead 15/20, Footnote 13/18, Caption 12/16 and 11/13 [A13].
  - Tracking is size-specific: 17pt −0.43pt, 13pt −0.08pt, 12pt 0, 11pt +0.06pt [A13].
  - Avoid Ultralight, Thin and Light weights at small sizes [A13].
  - iOS 26 typography is "bolder and left-aligned" in alerts and onboarding [W4].
  - Toolbar titles stay under 15 characters [A10].
- **ChatGPT.**
  - System font stack (`ui-sans-serif, -apple-system, system-ui, "Segoe UI"…`), tracking 0 [O1c].
  - Text sizes: xs 12/18, sm 14/20 (menus, controls), md 16/24, lg 18/29. Weights 400/500/600/700 [O1c].
  - Headings: xs 16/24, sm 18/26, md 20/26, lg 24/28, xl 32/38, 2xl 36/42 (up to 5xl 72/72), semibold [O1c].
  - **Response rhythm** [O1k]: `p` margin 1em; `li` 0.5em; `h2` 2rem above / 1rem below; `h3` 1.125rem / 0.625rem; `h4` 1rem / 0.5rem; `hr` 2em; blockquote bar 4px with 24px indent.
  - Apps embedded in ChatGPT may not use custom fonts at all [O2 *(summary)*].
- **Claude.** UI in **Anthropic Sans**, responses in **Anthropic Serif**, code in **Anthropic Mono**, all variable fonts (300–800) with system fallbacks [C11 *(summary)*]. This serif-for-answers, sans-for-chrome split is Claude's most distinctive typographic choice.

---

## 8. What this means for Alevr: a draft craft spec

These are my recommendations, built from the evidence above. Numbers marked "≈" are judgment calls.

1. **Menu container.** Radius 12px, 6px inset, item highlight radius 6px so it stays concentric. Rows are 32px on pointer devices (14/20 text, 6/8 padding) and ≥44px on touch (≈48px row). Min width ≈240–300px; clamp max width and height to the viewport; selects cap at 400px tall [O1][A17][W4].
2. **Menu columns.** A fixed 16px leading slot for icon or check, the label (flex), then trailing shortcut text in tertiary colour, then a 16px trailing chevron. Icons are all-or-none per group, and used only where they genuinely aid recognition [A1][W4][W5].
3. **States.**
   - Highlight: a neutral 8% (light) / 10% (dark) fill, with no text colour change.
   - Exclusive choice: a check.
   - Binary setting that shouldn't close the menu: an inline switch (Claude's Thinking toggle).
   - Disabled: dimmed in menus, hidden in context menus.
   - Destructive: last and red [O1a][A1][A2][C1].
4. **Submenus.** One level only. Open 100ms after hover. Safe-triangle grace of 300ms. Keep the parent open; open with → and close with ←. Cap at about 5 items [R1][A1].
5. **Menu motion.**
   - Enter: scale 0.95→1 plus fade, `transform-origin` at the trigger, 300–350ms on `cubic-bezier(.19,1,.22,1)` (~110ms perceived) or a spring with duration ≈0.3s and bounce 0.
   - Exit: 150–200ms, ease-in-heavy.
   - Hover fills: 150ms.
   - Any animation must be retargetable mid-flight.
   - Reduced motion: opacity only, ≈100ms, no scale or blur [O1a][W1][A16].
6. **Press feedback.** Width-aware scale (0.96 for icon buttons down to 0.995 for wide rows) on `:active`, 150ms [O1i].
7. **Composer.**
   - One 24px-radius card. Left: "+" (with "/" as the keyboard opener). Right: model/mode, then mic, then send.
   - Send → stop morph in place, as an icon replacement with a scale/opacity crossfade ≈150ms; Esc stops (recommended, not a verified competitor shortcut).
   - Armed tools appear as removable pills inside the card.
   - Attachment chips above the text, each with a remove control and upload progress.
   - Auto-grow to about 10 rows, then scroll.
   - Chat column ≈760–800px [O1b][O3][O4][C1][C2].
8. **Dialogs.** Max width ≈450px for confirmations, 20px padding. Scrim black 30% (light) / 50% (dark). Primary action trailing, Cancel leading, destructive style only when the action wasn't explicitly chosen, Esc cancels. Prefer inline status to toasts [O1b][A7][A18].
9. **Elevation.** Floating surfaces get a soft two-layer shadow plus a 0.5px hairline on HiDPI screens. In dark mode, raise elevation by **lightening the surface** (≈#212121 → #303030) and roughly triple the shadow alpha; drop the hairline on light-grey elevated surfaces [O1c][O1d][A15].
10. **Icons.** One family on a 24 grid with a 2-unit stroke (≈1.5px at 18px). Sm/Lg variants change extent, not weight. Add a bolder variant for the composer's hero icons; nudge chevrons and asymmetric glyphs optically [O1j][A12].
11. **Type.** UI 14/20; body 16/24 (or a serif reading face for answers, Claude-style); size-specific negative tracking on large sizes only; paragraph spacing 1em, list items 0.5em [O1c][O1k][A13][C11].

---

## 9. Gaps and how to close them

- **Claude.** Radius, shadow and motion values are unverified. Closing this needs DevTools access to claude.ai (blocked here) or a manual measurement pass.
- **Apple macOS and iOS menus.** Pixel metrics (row height, radius, inset) are not published. The figures above come from third-party replicas [X5][X6][X7]. Apple Design Resources (Figma/Sketch kits) would settle them.
- **ChatGPT shell.** The apps-sdk-ui tokens are for embedded apps. Composer-shell motion (the send/stop morph timing) is not in the package.
- **Blocked hosts.** Allowing help.openai.com, developers.openai.com, aiuxplayground.com, react-spectrum.adobe.com and daringfireball.net would let someone verify the *(summary)* claims first-hand.

---

## Sources

How each source was accessed: **[read]** means I fetched and read it in full; ***(summary)*** means the host was blocked, so I used a search-engine summary of the page.

### Apple: Human Interface Guidelines (read via developer.apple.com DocC JSON)
- [A1] Menus (change log: icon guidance updated 8 Jun 2026): https://developer.apple.com/design/human-interface-guidelines/menus
- [A2] Context menus: https://developer.apple.com/design/human-interface-guidelines/context-menus
- [A3] Pop-up buttons: https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons
- [A4] Pull-down buttons: https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons
- [A5] Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- [A6] Sheets (button placement updated 24 Mar 2026): https://developer.apple.com/design/human-interface-guidelines/sheets
- [A7] Alerts: https://developer.apple.com/design/human-interface-guidelines/alerts
- [A8] Action sheets: https://developer.apple.com/design/human-interface-guidelines/action-sheets
- [A9] Popovers: https://developer.apple.com/design/human-interface-guidelines/popovers
- [A10] Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars
- [A11] SF Symbols: https://developer.apple.com/design/human-interface-guidelines/sf-symbols
- [A12] Icons: https://developer.apple.com/design/human-interface-guidelines/icons
- [A13] Typography: https://developer.apple.com/design/human-interface-guidelines/typography
- [A14] Materials: https://developer.apple.com/design/human-interface-guidelines/materials
- [A15] Dark Mode: https://developer.apple.com/design/human-interface-guidelines/dark-mode
- [A16] Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- [A17] Buttons: https://developer.apple.com/design/human-interface-guidelines/buttons
- [A18] Feedback: https://developer.apple.com/design/human-interface-guidelines/feedback
- [A19] Keyboards: https://developer.apple.com/design/human-interface-guidelines/keyboards

### Apple: WWDC transcripts and API docs (read)
- [W1] Animate with springs (WWDC23): https://developer.apple.com/videos/play/wwdc2023/10158/
- [W2] Designing Fluid Interfaces (WWDC18): https://developer.apple.com/videos/play/wwdc2018/803/
- [W3] Meet Liquid Glass (WWDC25): https://developer.apple.com/videos/play/wwdc2025/219/
- [W4] Get to know the new design system (WWDC25): https://developer.apple.com/videos/play/wwdc2025/356/
- [W5] Build an AppKit app with the new design (WWDC25): https://developer.apple.com/videos/play/wwdc2025/310/
- [W6] Build a UIKit app with the new design (WWDC25): https://developer.apple.com/videos/play/wwdc2025/284/
- [W7] Build a SwiftUI app with the new design (WWDC25): https://developer.apple.com/videos/play/wwdc2025/323/
- [W8] Enhance your UI animations and transitions (WWDC24): https://developer.apple.com/videos/play/wwdc2024/10145/
- [D1] SwiftUI `spring(duration:bounce:blendDuration:)`: https://developer.apple.com/documentation/swiftui/animation/spring(duration:bounce:blendduration:)
- [D2] SwiftUI `snappy` / `smooth` / `bouncy`: https://developer.apple.com/documentation/swiftui/animation/snappy, https://developer.apple.com/documentation/swiftui/animation/smooth, https://developer.apple.com/documentation/swiftui/animation/bouncy

### Apple: third-party reporting and replicas
- [X1] Blake Crosley, "Menu images hidden in macOS 27" *(summary)*: https://blakecrosley.com/blog/menu-images-hidden-macos-27
- [X2] Daring Fireball, macOS 27 removes menu item icons *(summary)*: https://daringfireball.net/2026/06/macos_27_golden_gate_removes_the_dumb_icons_from_menu_items, and https://daringfireball.net/2026/03/what_to_do_about_those_menu_item_icons_in_macos_26_tahoe
- [X3] MacRumors, macOS 27 menu items *(summary)*: https://www.macrumors.com/2026/06/11/macos-27-golden-gate-menu-items/
- [X4] Coverage of Tonsky's "It's hard to justify Tahoe icons" *(summary)*: https://www.iphoneincanada.ca/2026/01/06/experts-criticize-macos-tahoe-menu-icons/, https://daringfireball.net/linked/2026/01/05/hard-to-justify-tahoe-icons
- [X5] LiqKit `LiqMenu` (iOS 26 metrics from Apple's Figma kit) [read]: https://pub.dev/documentation/liqkit_ui/latest/liqkit_ui/LiqMenu-class.html
- [X6] macos_ui 2.2.2 `pulldown_button.dart` / `popup_button.dart` (`_kMenuItemHeight = 20`) [read]: https://pub.dev/packages/macos_ui
- [X7] uzor macOS menu theme (item height 22, radius 6) *(summary)*: https://docs.rs/crate/uzor/1.0.13/source/src/macos/themes/menu.rs
- [X8] Apple Support, macOS Help menu search *(summary)*: https://support.apple.com/en-asia/guide/mac-help/hlpvw003/10.15/mac

### OpenAI / ChatGPT
- [O1] `openai/apps-sdk-ui` (cloned, commit `0f00143`, 5 May 2026) [read]: https://github.com/openai/apps-sdk-ui
  - [O1a] Menu CSS: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Menu/Menu.module.css
  - [O1b] Component tokens: https://github.com/openai/apps-sdk-ui/blob/main/src/styles/variables-components.css
  - [O1c] Semantic tokens: https://github.com/openai/apps-sdk-ui/blob/main/src/styles/variables-semantic.css
  - [O1d] Primitive tokens: https://github.com/openai/apps-sdk-ui/blob/main/src/styles/variables-primitive.css
  - [O1e] Popover CSS: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Popover/Popover.module.css
  - [O1f] Select CSS: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Select/Select.module.css
  - [O1g] Tooltip CSS and TSX: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Tooltip/Tooltip.module.css, https://github.com/openai/apps-sdk-ui/blob/main/src/components/Tooltip/Tooltip.tsx
  - [O1h] Button CSS: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Button/Button.module.css
  - [O1i] Press-scale and reduced-motion helpers: https://github.com/openai/apps-sdk-ui/blob/main/src/lib/helpers.ts
  - [O1j] Icon SVGs: https://github.com/openai/apps-sdk-ui/tree/main/src/components/Icon/svg
  - [O1k] Markdown CSS: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Markdown/Markdown.module.css
  - [O1l] Textarea: https://github.com/openai/apps-sdk-ui/blob/main/src/components/Textarea/Textarea.tsx
- [O2] OpenAI Apps SDK UI guidelines *(summary)*: https://developers.openai.com/apps-sdk/concepts/ui-guidelines
- [O3] agbrowse 0.1.16, ChatGPT composer live probe dated 2026-06-15 (read from the npm tarball): https://cdn.jsdelivr.net/npm/agbrowse@0.1.16/devlog/_fin/260615_chatgpt_composer_tools_live_probe.md
- [O4] agbrowse 0.1.16 `web-ai/chatgpt-composer.mjs`, `chatgpt.mjs`, `chatgpt-attachments.mjs` (DOM selectors) [read]: https://www.npmjs.com/package/agbrowse
- [O5] OpenAI Help, GPT-5.5 in ChatGPT *(summary)*: https://help.openai.com/en/articles/11909943
- [O6] TechRadar, model picker moved into the prompt box *(summary)*: https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-just-made-it-easier-to-pick-the-right-model-just-like-gemini-does-heres-when-to-use-instant-thinking-or-pro
- [O7] AI UX Playground, ChatGPT composer teardown *(summary)*: https://aiuxplayground.com/teardowns/chatgpt/composer
- [O8] BGR, Tools menu next to "+" *(summary)*: https://bgr.com/tech/chatgpt-got-a-makeover-but-all-of-your-ai-tools-are-still-there
- [O9] User report, mic replaced by send on typing *(summary)*: https://reddit.sentinel-team.org/posts/1u38tmz/snapshots/2026-06-12T22%3A07%3A36.764145Z
- [O10] Dictation vs voice mode icons *(summary)*: https://www.getvoibe.com/resources/dictate-in-chatgpt/

### Anthropic / Claude
- [C1] Change the model, effort and extended thinking settings [read]: https://support.claude.com/en/articles/8664678-change-the-model-effort-and-extended-thinking-settings
- [C2] Connectors (the "+" and "/" menu; hover Connectors) [read]: https://support.claude.com/en/articles/11176164
- [C3] Uploading files to Claude [read]: https://support.claude.com/en/articles/8241126-uploading-files-to-claude
- [C4] Use voice mode [read]: https://support.claude.com/en/articles/11101966-use-voice-mode
- [C5] Dictation on mobile [read]: https://support.claude.com/en/articles/10065434-using-dictation-on-the-claude-mobile-apps
- [C6] Using extended thinking (older "Search and tools" button) [read]: https://support.claude.com/en/articles/10574485
- [C7] Redesigning Claude Code on desktop, 14 Apr 2026 [read]: https://claude.com/blog/claude-code-desktop-redesign
- [C8] AI UX Playground, Claude composer teardown (≈Jun 2026) *(summary)*: https://aiuxplayground.com/teardowns/claude/composer/
- [C9] AI UX Playground, Claude tool switching *(summary)*: https://aiuxplayground.com/gallery/claude-tool-switching/
- [C10] agbrowse 0.1.16, Claude provider DOM notes (ProseMirror, Radix popover, `data-is-streaming`) [read]: https://cdn.jsdelivr.net/npm/agbrowse@0.1.16/devlog/_fin/260519_provider_expansion/01_claude.md
- [C11] claude.ai stylesheet (Anthropic Sans/Serif/Mono, variable 300–800) *(summary; host blocked)*: https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c6a992d55-Cb4ksHML.css
- [C12] Third-party Claude palettes *(summary)*: https://www.shadcn.io/design/claude, https://www.nodeseek.com/post-958821-1
- [C13] Tom's Guide, Claude adds a stop button *(summary)*: https://tomsguide.com/ai/you-can-finally-make-claude-3-shut-up-anthropic-adds-stop-button-to-its-chatbot
- [C14] assistant-ui "Claude clone": a third-party reproduction, not evidence of Claude itself; it approximates a 16px-radius composer with 32px buttons [read]: https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/pages/examples/claude.tsx
- [C15] User bug report, mic disappears when composer has text *(summary)*: https://claudeissues.com/issue/90618-bug-web-desktop-composer-mic-button-disappears-when-text-is-present-so-interrupt

### Interaction libraries and research
- [R1] `@radix-ui/react-menu` 2.2.1 (sub-trigger opens at 100ms, grace polygon 300ms, typeahead 1000ms) [read from the npm dist]: https://www.npmjs.com/package/@radix-ui/react-menu, source https://github.com/radix-ui/primitives/blob/main/packages/react/menu/src/menu.tsx
- [R2] jQuery-menu-aim (`DELAY = 300`, `tolerance: 75`, `MOUSE_LOCS_TRACKED = 3`) [read]: https://github.com/kamens/jQuery-menu-aim/blob/master/jquery.menu-aim.js
- [R3] Ben Kamens, "Breaking down Amazon's mega dropdown" *(summary)*: https://bjk5.com/post/44698559168
- [R4] Baymard, dropdown hover delay 300–500ms *(summary)*: https://baymard.com/research-articles/dropdown-menu-flickering-issue
- [R5] NN/g animation duration, as quoted by secondary sources *(summary)*: https://www.nngroup.com/articles/animation-duration/
