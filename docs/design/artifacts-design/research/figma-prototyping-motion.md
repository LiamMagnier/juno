# Figma: prototyping, interactions, motion and effects (as of 2026-09-23)

Lens: how Figma lets people make designs move and respond (prototype triggers, actions and transitions, Figma Motion's keyframe timeline, easing and springs, shaders and effects), and what that means for Juno merging Artifacts with Juno Design.

Confidence tags: **[P]** primary (Figma's own docs, blog, release notes, forum staff posts, or the locally installed 2026 Figma plugin skills and Plugin API typings). **[S]** secondary (press, reviews, community posts). **[I]** inferred by me.

Local primary evidence, read in full:
- `~/.claude/plugins/synced/.../figma/skills/figma-use-motion/SKILL.md`, `references/motion-patterns.md`, `references/motion-easing.md`. Referred to below as **[skill:use-motion]**.
- `.../figma-implement-motion/SKILL.md` plus `references/{gotchas, unsupported-and-fallbacks, motion-lint-rules, framework-recommendations, examples-and-anti-examples, svg-and-path-motion}.md`. Referred to as **[skill:implement-motion]**.
- `.../figma-shaders/SKILL.md`, `references/authoring.md`. Referred to as **[skill:shaders]**.
- `.../figma-use/references/plugin-api-standalone.d.ts` (10,191 lines). Referred to as **[d.ts]**, with line numbers.
- Juno: `docs/design/artifacts-design/01-AUDIT-WEB.md` §5 and `src/lib/design/types.ts:86-300, 640-735`.
- Claude: `docs/design/artifacts-design/research/claude-primary-evidence.md`, taken as authoritative.

The skills and typings are synced plugin files dated 2026. They describe the API that shipped, including internal gating (`metronome` flag). The web search budget ran out partway through, so a few older, pre-2026 facts rest only on help-center pages, which carry no dates.

---

## 1. Timeline: what shipped when

| Date | Event | Source |
|---|---|---|
| 2025-05-07 (Config 2025) | Progressive blur, noise and texture effects arrive with Figma Draw | [P] [Introducing Figma Draw](https://www.figma.com/blog/introducing-figma-draw/) (2025-05-07; lists "Noise", "Texture" and "Progressive blur"). Fact-check upgraded this from a LinkedIn post. |
| 2025-07-17 | Plugin API update 116 adds the **Glass** effect in beta. It works on frames only and cannot bind variables. | [P] [developers.figma.com update 116](https://developers.figma.com/docs/plugins/updates/2025/07/17/version-1-update-116) |
| 2026-01-27 | **Glass leaves beta.** It now applies to any object, shape or text, supports non-uniform corners, adds a *Splay* property and can bind variables. | [P] [Figma Forum product update](https://forum.figma.com/product-updates-3/glass-is-officially-out-of-beta-50185) |
| 2026-06-23 | Figma agent launches to everyone (the recap says "launched to everyone yesterday"; the forum roundup says it is available on all paid plans, in open beta) | [P] [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/) (2026-06-24); [P] [Forum: Everything announced](https://forum.figma.com/product-updates-3/everything-announced-at-config-2026-55221) |
| **2026-06-24** | **Config 2026.** Figma Motion (open beta), custom **shader** effects and fills (open beta), generative plugins, Weave tools in Design, an agent update, and code layers (closed beta; early access from July). 3D transforms and the agent in FigJam and Slides are on a waitlist. | [P] [Introducing Figma Motion](https://www.figma.com/blog/introducing-figma-motion/) (David Hornsby, PM, 2026-06-24); [P] [What's new from Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026); [P] [Forum: Everything announced](https://forum.figma.com/product-updates-3/everything-announced-at-config-2026-55221) |
| 2026-09-01 | "Updates to generative plugins and shaders": **animated and mouse-interactive shaders**, publishing to Community and to an org, a code viewer, MCP editing, and shaders rendering in React code copied to agents | [P] [Figma release notes](https://www.figma.com/release-notes/) (2026-09-01 entry); [P] [Behind the build blog](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/) |
| 2026-09-16 | Fix ships for Motion animations that flashed their end state on page transitions and did not play in overlays | [P] staff reply in the [Forum glitch thread](https://forum.figma.com/report-a-problem-6/figma-motion-feedback-glitch-55346) |

Pre-2025 prototyping foundations still in force: Smart Animate, interactive components (the "Change to" action), variables, multiple actions and conditionals. These are documented in undated help pages, cited per claim below.

---

## 2. Prototyping model (the Prototype tab)

### 2.1 Structure and information architecture
- The right sidebar has **Design** and **Prototype** tabs. In the Prototype tab you drag a *noodle* (a blue connection arrow) from a hotspot to a destination. A **flow** is a set of connected frames with a named **starting point**, and a page can hold several flows ([P] [Guide to prototyping](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma)).
- Each interaction is a **Reaction**: one trigger plus an ordered list of actions (`Reaction = { trigger, actions[] }`, [d.ts:3344]). Unlimited actions can be stacked on one trigger. They run top to bottom and can be reordered by dragging. Multiple actions and conditionals need a paid plan ([P] [Multiple actions and conditionals](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals)).
- Prototype settings sit on the page: `flowStartingPoints`, `prototypeStartNode` and `prototypeBackgrounds` ([d.ts:8164-8179]). Prototypes are per page.

### 2.2 Triggers (12 in the UI) [P]
[Prototype triggers](https://help.figma.com/hc/en-us/articles/360040035834-Prototype-triggers):
On click/tap · On drag (left/right/up/down; scrubs the transition back and forth) · While hovering (reverts when the cursor leaves) · While pressing (reverts on release) · Key/Gamepad (a single key or a chord; Xbox One, PS4 and Switch Pro controllers) · Mouse enter · Mouse leave · Mouse down (touch down) · Mouse up (touch up) · After delay (ms) · When video hits a timestamp · When video ends.

The API shape ([d.ts:3456-3486]): `ON_CLICK | ON_HOVER | ON_PRESS | ON_DRAG`, `AFTER_TIMEOUT{timeout}`, `MOUSE_UP/DOWN{delay}`, `MOUSE_ENTER/LEAVE{delay}`, `ON_KEY_DOWN{device, keyCodes[]}`, `ON_MEDIA_HIT{mediaHitTime}`, `ON_MEDIA_END`.

Figma has **no scroll-into-view trigger**. Users have long asked for one ([S] [forum request](https://forum.figma.com/suggest-a-feature-11/on-scroll-for-prototyping-21247)). Juno already has one (§6).

### 2.3 Actions (15 in the UI) [P]
[Prototype actions](https://help.figma.com/hc/en-us/articles/360040035874-Prototype-actions):
Navigate to · Back · Set variable · Set variable mode · Conditional (if/else) · Scroll to (instant or animated) · Open link (new tab) · Open overlay · Close overlay · Swap overlay (not added to history) · Play/pause video · Mute/unmute · Set video to time · Jump forward/back · **Change to** (switch a variant in a component set).

API ([d.ts:3383-3435]):
- `NODE{destinationId, navigation: NAVIGATE|SWAP|OVERLAY|SCROLL_TO|CHANGE_TO, transition, overlayRelativePosition, resetVideoPosition, resetScrollPosition, resetInteractiveComponents}`
- `SET_VARIABLE{variableId, variableValue}`, `SET_VARIABLE_MODE`, `CONDITIONAL{conditionalBlocks[{condition, actions}]}`
- `UPDATE_MEDIA_RUNTIME{PLAY|PAUSE|TOGGLE_PLAY_PAUSE|MUTE|UNMUTE|TOGGLE_MUTE_UNMUTE|SKIP_FORWARD|SKIP_BACKWARD|SKIP_TO}`
- `URL{url, openInNewTab}`, `BACK|CLOSE`

**Overlays:** position `CENTER | TOP_LEFT | TOP_CENTER | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_CENTER | BOTTOM_RIGHT | MANUAL`; background `NONE | SOLID_COLOR(rgba)`; background interaction `NONE | CLOSE_ON_CLICK_OUTSIDE` ([d.ts:3870-3896, 6548-6568]).

**Expressions** for Set variable and Conditional ([d.ts:3350-3380]): ADDITION, SUBTRACTION, MULTIPLICATION, DIVISION, EQUALS, NOT_EQUAL, LESS_THAN(_OR_EQUAL), GREATER_THAN(_OR_EQUAL), AND, OR, NOT, NEGATE, VAR_MODE_LOOKUP. A checkout example: free shipping if the cart total is above a threshold ([P] [Multiple actions and conditionals](https://help.figma.com/hc/en-us/articles/15253220891799-Multiple-actions-and-conditionals)).

### 2.4 Transitions [P]
[Prototype animations](https://help.figma.com/hc/en-us/articles/360040522373-Prototype-animations):
- **Instant**, **Dissolve**, **Smart Animate**, **Move in / Move out**, **Push**, **Slide in / Slide out**. The directional ones take left/right/top/bottom.
- **Push** moves the old frame out while the new one arrives, which reads as a swipe. **Slide** offsets the frame as it dissolves. **Move** keeps the original frame still.
- Duration runs from 1 to 10,000 ms ([P] [Guide to prototyping](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma)).
- API ([d.ts:3437-3455]): `SimpleTransition{DISSOLVE|SMART_ANIMATE|SCROLL_ANIMATE, easing, duration}` and `DirectionalTransition{MOVE_IN|MOVE_OUT|PUSH|SLIDE_IN|SLIDE_OUT, direction, matchLayers, easing, duration}`.
  - `matchLayers: true` runs Smart Animate inside a directional transition ([P] [Transition API](https://developers.figma.com/docs/plugins/api/Transition)).
  - `SCROLL_ANIMATE` is undocumented. It is most likely the animated option of *Scroll to* [I].
  - Transition duration is stored in **seconds**; the example is `0.2` ([d.ts:6600-6615]).

**Smart Animate** ([P] [Smart animate help](https://help.figma.com/hc/en-us/articles/360039818874-Smart-animate-layers-between-frames)):
- It matches layers by **name plus position in the hierarchy**. The recommended habit is to duplicate frames so names stay the same.
- It tweens position, scale, rotation, opacity and fills (colour, gradient, image).
- New layers in the destination frame **dissolve** in. When Smart Animate runs as "matching layers" inside another transition, unmatched layers use that main transition instead.
- Not supported: drop and inner shadows (these fall back to a dissolve), shape morphing, and overlay actions. Noise and texture effects are randomly generated, so Figma advises duplicating frames to keep them matched.

### 2.5 Easing and springs (prototype side) [P]
[Easing and spring animations](https://help.figma.com/hc/en-us/articles/360051748654-Prototype-easing-and-spring-animations):
- Seven bezier presets: Linear, Ease In, Ease Out, Ease In And Out, Ease In Back, Ease Out Back, Ease In And Out Back.
- **Custom bezier** is a curve editor with 4 control points; the values can be copied between interactions. The doc says a custom curve **cannot be saved for reuse** (see §3.4 for the Motion-side change).
- Four spring presets:
  - **Gentle**: neutral, subtle.
  - **Quick**: suited to toasts and notifications.
  - **Bouncy**: suited to playful moments like a heart bounce.
  - **Slow**: for scaling up full-screen content.
- A **custom spring** takes stiffness, damping and mass. Changing mass changes the displayed duration.
- API: `EasingFunctionSpring{mass, stiffness, damping, initialVelocity}` ([d.ts:3519-3524]). This is the *physical* form. Motion keyframes use a *normalized* form instead (§3.4).

### 2.6 Scroll, overflow, sticky [P]
[Scroll and overflow](https://help.figma.com/hc/en-us/articles/360039818734-Prototype-scroll-and-overflow-behavior):
- Overflow: no scrolling, vertical, horizontal, or both.
- Child position: scroll with parent, **Fixed**, or **Sticky**. Sticky scrolls until its top edge meets the parent's top, then stays; a nested sticky item stays inside its direct parent.
- Navigation can preserve or reset scroll position.
- A fixed child inside auto layout needs absolute position.
- Model: fixed children form a *section* of the child list rather than a per-layer boolean (`numberOfFixedChildren`, [d.ts:6548-6556]).
- A top-level frame taller than the device scrolls automatically.

### 2.7 Interactive components, variables, video
- **Interactive components** ([P] [help](https://help.figma.com/hc/en-us/articles/360061175334-Create-interactive-components-with-variants)): interactions are drawn between variants in the component set using **Change to**. Every instance inherits them. A nested instance can "Change to" its parent's variant. Custom fonts may fall back to Inter when overrides conflict.
- **Variables** now come in six types: Color, Number, String, Boolean, **Timing** (ms) and **Easing** (a curve or spring) ([P] [Variables guide](https://help.figma.com/hc/en-us/articles/14506821864087)). Timing and Easing apply to Motion presets and keyframes. `VariableResolvedDataType` includes `'EASING' | 'TIMING'` ([d.ts:9097]).
- **Video:** `VideoPaint` with FILL/FIT/CROP/TILE scale modes ([d.ts:2601]), video triggers and media actions (above). `PatternPaint` also exists ([d.ts:2637]).

### 2.8 Playing and sharing prototypes [P]
[Play your prototype](https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototype):
- **Present** (⌘⌥↩ / Ctrl+Alt+Enter) opens a new tab with:
  - a flows sidebar that shows each flow's description;
  - a bottom bar with prev/next arrows and restart. **R** restarts; arrow keys and **N** move between frames;
  - an Options menu: enable Figma shortcuts, **Show hints on click** (blue hotspot boxes), offline, accessibility, **Hide UI**;
  - scaling: Fit width, Fill screen, Actual size (100%), **Responsive** (content reflows via constraints and auto layout);
  - a **Show device frame** toggle.
- **Inline preview** (the Preview button or **Shift+Space**) plays in a window on the canvas and picks up design edits as they happen.
- Sharing ([P] [Share or embed](https://help.figma.com/hc/en-us/articles/360040531773-Share-or-embed-your-files-and-prototypes)):
  - **prototype-only access** on paid plans, which hides the file;
  - a link that opens to a specific frame;
  - embed code;
  - password (paid) and link expiry (Enterprise);
  - comments work in presentation view.

### 2.9 Figma Slides transitions (for comparison with Claude Slides)
`SlideTransition.style` ([d.ts:9737-9790]):
- NONE, DISSOLVE, SLIDE_FROM_{L,R,T,B}, PUSH_FROM_{…}, MOVE_FROM_{…}, SLIDE_OUT_TO_{…}, MOVE_OUT_TO_{…}, SMART_ANIMATE.
- `curve`: the 4 bezier presets plus the 4 spring presets.
- `timing`: ON_CLICK, or AFTER_DELAY with a delay in seconds.

Claude Slides has fewer transitions (`fade | push | magic`) plus build-ins `fade | rise | pop` (claude-primary-evidence.md).

---

## 3. Figma Motion (open beta since 2026-06-24)

### 3.1 Positioning
- Motion is described as native to the canvas. Motion lives in the same file as components and variables, and **components carry motion** across screens and files the way fills and type do ([P] [Introducing Figma Motion](https://www.figma.com/blog/introducing-figma-motion/), 2026-06-24).
- Ways in: add preset animation styles ("fade, move, scale") as "the quickest way in", keyframe by hand on the timeline, or prompt the agent. The blog does not frame these as exactly "three ways in" (fact-check wording fix).
- In Dev Mode the full timeline can be inspected; Figma says every timing value, curve and keyframe is readable ([P] [Config 2026 recap](https://www.figma.com/blog/config-2026-recap/)).
- Availability: open beta, "Available for Full seats on all plans" (the Explore help page says "Available on any plan" to anyone with can-edit access). "Publishing animated components, generating animations with the Figma agent, and high-resolution video exports require a **Full seat on a paid plan**" ([P] [What's new from Config 2026](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026)). Starter users "can access motion with limited exports" ([P] [blog](https://www.figma.com/blog/introducing-figma-motion/)). "Figma Motion is not available on Figma for Government plans" ([P] same What's new page; also [S] [TechTimes 2026-06-25](https://www.techtimes.com/articles/319041/20260625/figma-config-2026-code-layers-challenge-cursor-gpu-shaders-hit-paid-plans.htm)). Motion itself uses no AI credits; agent-made motion will use credits once the agent is GA ([P] What's new).
- The Plugin API gates motion behind the `metronome` user feature flag. Without it, every motion property throws "not a supported API" ([P][skill:use-motion]).

### 3.2 Where things live (UI)
- **Mode switch in the toolbar.** Motion sits next to Design, Draw and Dev ([P] [blog](https://www.figma.com/blog/introducing-figma-motion/); [P] [Explore Figma Motion](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion)). One user says they keep clicking it by mistake when switching between Dev and Design ([S] [forum 2026-06-30](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314)).
- **The timeline runs across the bottom of the screen** ([P] [Use the Figma Motion timeline](https://help.figma.com/hc/en-us/articles/41405906446999-Use-the-Figma-Motion-timeline)):
  - Play button, and **Spacebar** plays in Motion mode.
  - Duration field; **new animations default to 2000 ms**.
  - A current-time field to jump to a moment.
  - A seconds/ms unit toggle.
  - Playback modes that cycle **Loop → Once → Ping-pong**.
  - Drag the top edge to resize.
  - Zoom with a slider, trackpad, or ⌘/Ctrl+wheel.
  - Layer tracks grouped by object; drag a track to shift it in time, or drag its end handles to change its duration.
  - A "Collapse layers" button.
- **Keyframes in the right sidebar** ([P] [Add, select, and delete keyframes](https://help.figma.com/hc/en-us/articles/41307938657559)):
  - Every animatable property shows a **diamond** next to its field.
  - Put the playhead where you want it, click the diamond, and enter a value. Move the playhead and change the value, and a second keyframe appears.
  - Double-click a keyframe to jump to it. Delete removes the keyframe; Delete with the whole property row selected removes all its keyframes.
  - Keyframes drag along the time axis.
- **Auto-keyframe (record) mode** keyframes every change. Figma itself warns that stray edits then become keyframes ([P] same article).
- **Animations section** in the right sidebar: the **+** button adds a preset animation style, and **composite animation styles** apply several presets at once. A style shows as a bar on the timeline; drag it to move it and drag its handles to change its duration ([P] [Preset animation styles](https://help.figma.com/hc/en-us/articles/41307886266135)).
- **Anchor point** (transform origin): Transform section → "Edit anchor point", or **⌥R / Alt+R**, then drag the target icon. **In Motion mode position is measured from the object's centre; in Design mode from its top-left corner** ([P] [Anchor point](https://help.figma.com/hc/en-us/articles/41352588622615-Move-a-layer-s-anchor-point)).
- **Motion paths on the canvas:** position keyframes draw as boxes, with **dots spaced to show the easing** between them. Drag the boxes, or ⌘/Ctrl-drag for bezier handles that curve the path ([P] [Edit an object's motion path](https://help.figma.com/hc/en-us/articles/41780233501591-Edit-an-object-s-motion-path); staff confirmation in [forum 2026-07-02](https://forum.figma.com/ask-the-community-7/questions-about-figma-motion-motion-paths-prototyping-and-variants-55468)).
- **Path trim:** Stroke section → start and end (0–100%) keyframes, or a preset "path" style. The preset works on open paths only; closed paths need keyframes; strokes must be center-aligned; one preset per object ([P] [Path trim](https://help.figma.com/hc/en-us/articles/42200302811927-Animate-strokes-with-path-trim)).
- **Animated component instances show as purple tracks.** You can move them in time, but you edit their duration and properties only on the main component. **Component properties cannot be changed while in Motion mode** ([P] [Animated components](https://help.figma.com/hc/en-us/articles/41307940738967)).
- **Frames that carry motion show a Motion icon on the canvas** ([P] [Agent motion help](https://help.figma.com/hc/en-us/articles/41159708615319)).
- **Comments can be tied to a moment in the timeline** ([P] [Explore](https://help.figma.com/hc/en-us/articles/41274629073303-Explore-Figma-Motion); [blog](https://www.figma.com/blog/introducing-figma-motion/)).

### 3.3 The data model (from the Plugin API and skills) [P][skill:use-motion][d.ts]
- **One timeline per top-level frame** in the UI today. `node.timelines` returns a read-only timeline *list* for the containing top-level frame (`{id, duration}` in seconds), and `setTimelineDuration(id, s)` sets it. The API shape is plural, which leaves room for more than one timeline per frame later [I]. Top-level frames themselves cannot be animated; you animate their descendants.
- There are two authoring layers that compose:
  1. **Manual keyframe tracks.** `node.manualKeyframeTracks` is keyed by field, plus `fills[i]`, `strokes[i]` and `effects[i][FIELD]`. Helpers `applyManualKeyframeTrack(field, track)` and `removeManualKeyframeTrack`.
     - A keyframe is `{id, timelinePosition (s), value, easing}`.
     - A track is `{id, baseValue, keyframes[]}`. The resolved track also carries `keyframeOperation: SET | OFFSET | SCALE` ([d.ts:~3690]).
  2. **Animation styles** (presets). `node.animationStyles[] = {id, styleId, name, duration, timelineOffset, props}`. Discover them with `figma.motion.figmaAnimationStyles()`; `props` come back as documentation strings, not setter shapes. Helpers `applyAnimationStyle(styleId, config)` and `removeAnimationStyle(id)`.
     - Known styles: **Fade, Move, Scale, Rotate, Resize**, a **path** style and composites ([P] [figma.com/motion](https://www.figma.com/motion/); [blog](https://www.figma.com/blog/introducing-figma-motion/)). Fade's props include `timing: "in"|"out"` and `easing` [skill:use-motion].
     - **Custom animation styles are "coming soon"**. Authoring `"figma:motion"` preset modules is internal and out of scope for the API.
  - `node.animations` (read-only, resolved) currently reflects **manual tracks only**. Style-generated tracks are not materialized there yet.
- **Transform tracks compose with the resting transform. Other fields replace their value.**
  - Composing (relative): `TRANSLATION_X/Y/XY` in px, additive with neutral 0. `ROTATION` in degrees, additive, positive = counter-clockwise, and not normalized, so −360 is one full turn. `SCALE_X/Y/XY` multiplicative with neutral 1. Rotation and scale pivot on the visual centre (the anchor point).
  - Absolute (replace the value for the animation window): OPACITY; CORNER_RADIUS and the 4 per-corner radii; STROKE_WEIGHT and per-side BORDER_*_WEIGHT; auto-layout `STACK_SPACING`, `STACK_COUNTER_SPACING`, the 4 paddings, `GRID_ROW_GAP`, `GRID_COLUMN_GAP`; `PATH_TRIM_START/END` (0–1); WIDTH and HEIGHT (not for groups or vectors).
  - Colour: **solid** fill and stroke colours by paint index, as `{r,g,b,a}` 0–1.
  - **Effect fields:** OFFSET_X/Y, RADIUS, SPREAD, COLOR, SECONDARY_COLOR, EFFECT_OPACITY, START_RADIUS (progressive blur), NOISE_SIZE_X/Y, DENSITY, and glass fields REFRACTION_RADIUS, REFRACTION_INTENSITY, SPECULAR_ANGLE, SPECULAR_INTENSITY, CHROMATIC_ABERRATION and SPLAY, with the normalized ones on 0–1.
  - **Shader properties** can be keyframed through `{collection:'fills'|'effects', index, propertyId}` ([d.ts:3777-3806]). The `KeyframeValue` union has `CIRCLE`, `LINE`, `CIRCLE_POINT` and `COLOR_POINT`, which mirror the shader control types (point-radius, point-point-line, point-angle-radius, color-point). It also has `TEXT_DATA` and `BOOL` ([d.ts:3595-3650]).
  - Public field names that **throw** today: SHEAR, SCROLL_OFFSET_X/Y, DISSOLVE_PROGRESS, MEDIA_CURRENT_TIME, 3D transform fields, polygon/arc fields, VARIANT_PROPERTIES. They exist internally, which points to a roadmap: scroll-linked motion, video time, variant morphing and 3D [I].
- **Holds:** the first keyframe's value holds back to t=0, and the last keyframe's value holds to the end. You do not need a "pinning" keyframe.
- **Easing belongs to the incoming segment.** A keyframe's easing controls the move from the previous keyframe to this one, so the first keyframe's easing is unused. Juno does the reverse (§6).
- **The playback/loop mode lives on the timeline.** MCP exposes it as `loopMode: 'once' | 'loop' | 'boomerang'` [skill:implement-motion].

### 3.4 Motion easing [P]
[Adjust an animation's easing](https://help.figma.com/hc/en-us/articles/41414048690839); [skill:use-motion] motion-easing.md; `MotionEasing` [d.ts:3528-3546]:
- Named curves: Linear, Ease in, Ease out, Ease in and out, Ease in back, Ease out back, Ease in and out back, and **Hold**. Hold is a step, exported as CSS `steps(1, jump-end)`.
- Springs: **Gentle, Quick, Bouncy, Slow**, plus **Custom spring**, which has one **Bounce** field (0–1) and a spring editor. `figma.motion.physicalSpringToNormalized({mass, stiffness, damping})` converts physical parameters to that bounce value. Motion is therefore **duration + bounce**, while prototype transitions still take mass/stiffness/damping/initialVelocity.
- Custom bezier: a curve editor with handles, or typed values.
- **Where you set it:** click the line between two keyframes on the timeline, or use a preset's Easing menu.
- **Custom curves and springs can be saved as Easing variables**, with modes. Keyframe easing and style props accept a `VariableAlias` ([d.ts:3567, 3677]). This reverses the older rule on the prototype side that custom curves cannot be saved.
- Guidance Figma gives its agent: keep motion subtle at about **0.25–0.7 s**, stagger related elements, sequence to show hierarchy, prefer EASE_OUT / EASE_IN_AND_OUT / GENTLE / QUICK, and avoid flashy loops and heavy bounce [skill:use-motion]. The help center's fundamentals series covers Timing, Sequencing, Easing, Transformation and Exaggeration ([P] [Motion design fundamentals](https://help.figma.com/hc/en-us/articles/41236826432791-Motion-design-fundamentals-Overview)).

### 3.5 Motion as a design system
- Components hold animation, and publishing them to a library builds a "motion system" ([P] [Animated components](https://help.figma.com/hc/en-us/articles/41307940738967)).
- Timing variables (ms) and Easing variables, with **modes**, let one mode switch retime every animation that references them ([P] [blog](https://www.figma.com/blog/introducing-figma-motion/); [Variables guide](https://help.figma.com/hc/en-us/articles/14506821864087)).
- Figma's own library-generation skill treats `TIMING` and `EASING` as first-class token types (`figma-generate-library/scripts/createSemanticTokens.js:12-13`) [P].
- Requested but missing: "animation sets" per component, meaning several animations on one object picked from a dropdown ([S] [forum 2026-08-27](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314)).

### 3.6 The agent authors motion
- Open the **Agents** panel in the left navigation and prompt, ideally for several variants: "Create 3 motion variants…". The agent writes **real keyframes** into the timeline. The designer switches the toolbar to Motion and presses Play to judge them ([P] [Generate motion with the agent](https://help.figma.com/hc/en-us/articles/41159708615319)).
- Figma's advice is to say how many variants you want, which layers, the intent, the feel, what may vary (easing, spring tension, duration, stagger) and what must stay fixed. It says narrowing three options to one is faster than getting the first try right.
- It can make bulk edits of more than 100 keyframes across designs ([P] same).
- Several prompts can run at once ([P] [blog](https://www.figma.com/blog/introducing-figma-motion/)).
- From outside Figma, agents write motion with `use_figma` Plugin API scripts. They check motion by rendering it with `export_video` (server-side, slow and costly: size at WIDTH 320, 5 fps, `quality:"low"`) and pulling frames out with ffmpeg. `get_screenshot` shows only the resting state [skill:use-motion].

### 3.7 Handoff and export
- **Dev Mode:** select the animated frame, open Inspect → **Motion** tab → **Show in timeline view** to get a read-only timeline next to its code. Switch between **CSS / React (motion.dev) / JSON** and click Copy. This needs a Full or Dev seat on a paid plan ([P] [Hand off animations](https://help.figma.com/hc/en-us/articles/41296356954263-Hand-off-animations-to-development)).
- **MCP `get_motion_context`** "returns keyframe animation data for an animated node" ([P] [MCP tools](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)). Detail from [skill:implement-motion]:
  - `codeSnippets` gives CSS `@keyframes` and motion.dev; Figma says to use these verbatim.
  - `keyframeBindings` is a fallback, and a `motionSummary` appears only when there is no snippet.
  - `fallbackNodeId` covers componentized instances.
  - `recursive:true` covers up to 500 nodes.
  - Recursive responses carry a top-level `timelineCohorts[{rootNodeId, durationMs, loopMode, memberNodeIds}]`, which tells you to drive all members from one lifecycle.
  - `get_design_context` marks where motion goes: `data-node-id`, `data-motion-keys`, `data-motion-wrapper-for`, `data-motion-transform-template`. The last one handles a static base transform nested under an animated one, with the animated rotation offset by the base.
  - SwiftUI clients get the CSS form and map it to `.timingCurve`, `.spring(duration:bounce:)` or `KeyframeAnimator`.
  - `prefers-reduced-motion` is mandatory.
  - Repeated motion is factored into variants, not pasted per element.
- **Lint messages MCP must show verbatim** [skill:implement-motion motion-lint-rules.md]:
  - (Error) Prototype interactions and Smart Animate are **not** supported in MCP. Code shows only the start and end states.
  - (Error) GIF and animated SVG cannot come through MCP.
  - (Warning) The **"sites runtime"** gives groups `display: contents`, so animated groups may break. `gotchas.md` also names a source path, `sites-runtime/src/attributes/masks.ts`, for mask positioning during group animation. Both point to Motion's code output sharing the **Figma Sites runtime**, but no Figma page says so [I].
- **Known code-export gaps** [skill:implement-motion]:
  - arc-path properties;
  - GenEffect (shader) visuals, which are missing from code export and from video exported via MCP;
  - animated masks, where the mask itself cannot be animated;
  - complex vector networks and booleans;
  - some path-trim timings;
  - variant transitions (use CSS state classes instead);
  - a rotation-pivot bug for orbiting children;
  - static SVG assets that bake the t=0 state;
  - interpolation in RGB, where OKLCH would be better for saturated endpoints.
- **Export (the Animated tab of the Export section, top-level frames only):** MP4, WebM, GIF, animated SVG. Settings are resolution, frame rate, quality (video formats) and loop (GIF). **Above 1920×1080 or 30 fps needs a paid plan** ([P] [Export animations](https://help.figma.com/hc/en-us/articles/41307983648407)). **Lottie is "coming"**: "We will introduce additional formats in the future, including Lottie" ([P] [What's new](https://help.figma.com/hc/en-us/articles/39582753756695-What-s-new-from-Config-2026); also listed as coming soon in the [blog](https://www.figma.com/blog/introducing-figma-motion/)). The export help page itself does not mention Lottie. **Audio is on the roadmap** ([P] [Workflow lab](https://help.figma.com/hc/en-us/articles/42847574436119-Workflow-lab-New-tools-more-expression-with-Figma-Motion-Figma-Weave-and-shaders)).

### 3.8 Motion in prototypes: the biggest gap
- Motion animations **auto-play when the prototype loads**, looping or not according to the timeline's Playback setting. **They cannot be triggered by a prototype interaction.**
  - Staff said on 2026-06-29 that this "doesn't appear to be available yet" ([P/S] Tom Reem, Figmate, [forum](https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428)).
  - Staff said on 2026-07-02 there is no way to do it yet and it would be flagged ([P/S] [forum](https://forum.figma.com/ask-the-community-7/questions-about-figma-motion-motion-paths-prototyping-and-variants-55468)).
- Workaround ([S] giuseppe.zagaria, [forum 2026-07-16](https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428)): leave 1 ms of idle at the start of the animation, add an "After delay" 1 ms interaction with the **Play/pause** action to stop autoplay, then use a click or mouse-enter interaction to play it. A user thanked the poster on 2026-09-21, but nobody confirmed in the thread that it works. Note that the workaround implies the Play/pause action can already reach an animated layer, which softens staff's "no way to do it" [I]. A second workaround ("variants driven by After-delay with a 'set playhead' trick", said to be from 2026-07-10) could not be found in either cited thread (unverified).
- Also requested ([S] Wan_Souza, same thread, 2026-07-30): an "Animation" section with autoplay and loop controls, like the one for video.
- **Smart Animate between variants cannot be keyframed.** Staff suggested cross-fading two layers instead ([P/S] forum 2026-07-02; request [2026-07-27](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314)).
- Sheet reversal: closing a sheet replays the inner animation backwards, and there is no control to stop that ([S] [forum 2026-06-25](https://forum.figma.com/share-your-feedback-26/figma-motion-for-prototyping-55300)).
- Coming soon: "every screen-to-screen transition now has a full timeline", with per-element timing inside transitions ([P] [figma.com/motion](https://www.figma.com/motion/); [blog](https://www.figma.com/blog/introducing-figma-motion/)). This is Figma's planned merge of Smart Animate into Motion.
- Bugs: the end state flashed for about 0.5 s on page transitions, and animations did not play in overlays. Reported 2026-06-26 and **fixed 2026-09-16** ([P] staff, [forum](https://forum.figma.com/report-a-problem-6/figma-motion-feedback-glitch-55346)).

---

## 4. Effects, glass and shaders

### 4.1 Built-in effect stack [P][d.ts:2115-2445]
`Effect = DropShadow | InnerShadow | Blur(LAYER_BLUR | BACKGROUND_BLUR; NORMAL | PROGRESSIVE) | Noise | Texture | Glass | Shader`.
- **Progressive blur:** `startRadius`, end `radius`, and `startOffset` / `endOffset` in normalized object space (0,0 is top-left, 1,1 is bottom-right).
- **Noise:** MONOTONE, DUOTONE (with a secondary colour) or MULTITONE (with opacity); `noiseSize` or `noiseSizeVector`, `density`, `blendMode`. Cannot bind variables yet.
- **Texture:** `noiseSize`, `radius`, `clipToShape`.
- **Glass:**
  - `lightIntensity` 0–1, `lightAngle` in degrees;
  - `refraction` 0–1, `depth` ≥ 1;
  - `dispersion` 0–1 (chromatic aberration);
  - frost `radius`;
  - Splay, which is exposed as a keyframe field.
  - It was beta on frames only (2025-07-17). At GA (2026-01-27) it gained any-object support, per-corner radii, Splay and variables ([P] links in §1).
  - The typings still say "Glass effects currently do not support binding variables", which conflicts with the GA post. Keep both.
- The API also has `PatternPaint` (tile a source node rectangularly or hexagonally) and `VideoPaint`.
- Every numeric effect field can be keyframed in Motion (§3.3).

### 4.2 Custom shaders (open beta since 2026-06-24)
- **Two kinds.** An **effect** samples and transforms the rendered layer underneath (blur, distortion, glow, grading, pixelation, halftone). A **fill** generates pixels with no input (gradients, patterns, noise, procedural backgrounds) [P][skill:shaders]. Fills also apply to strokes (`ShaderPaint` in `fills`/`strokes`, [d.ts:2671-2693]).
- **Made by prompting the agent** (Agents panel → "Build me a shader…"). A reference image can be supplied and turned into a shader, and you ask for the controls you want, such as a blur slider or a colour picker ([P] [Shaders quick start](https://help.figma.com/hc/en-us/articles/41147702210071-Quick-start-guide-to-generative-plugins-and-shaders)).
  - The result shows up in the **Effects** section or in the **Fill/Stroke** pickers, and can be browsed from the **Tools** tab.
  - Shaders stack with other effects and can become a **style** published to team libraries.
  - Community publishing arrived 2026-09-01; org publishing needs an Organization or Enterprise plan ([P] [release notes 2026-09-01](https://www.figma.com/release-notes/)).
- **Runtime:**
  - WebGPU with WGSL in a sandboxed JS module: `setup(device, frame)` and `render(device, frame)`, plus `defineProperties(Effect, {...})` from `figma:shaders` [P][skill:shaders].
  - `frame` carries `input` (effects only), `output`, `params`, `state`, `time` (absolute ms), `deltaTime`, `frame` (the frame counter) and `mousePosition` (layer-local).
  - Effects use premultiplied alpha and fills use straight alpha.
  - Build limits: no DOM, fetch or timers, and no module-scope variables.
- **Control types:**
  - `boolean`;
  - `string` (for genuine free text only);
  - `number` as a slider, an input with units, or a numeric **select**;
  - `color`;
  - `gradient` (2–8 stops);
  - `point` in `canvas_and_ui` mode with % units, which puts an **on-canvas handle** on the layer;
  - `point-radius`, `point-point-line`, `point-angle-radius`, `color-point`.
  - Figma built the control system as **PropsKit**, "a web components–based Figma UI kit", so agents can generate controls ([P] [Behind the build](https://www.figma.com/blog/how-we-built-generative-plugins-and-shaders/)).
- **Motion and interaction:**
  - A shader that reads `frame.time` or `mousePosition` must set `metadata.isAnimated` or `usesMouse`. If those capabilities are gated, the agent is told to offer a static shader "whose exposed properties can be keyframed in Motion mode" instead [P][skill:shaders].
  - Animated and hover-interactive shaders arrived 2026-09-01 ([P] release notes).
  - **Only one animated or interactive shader runs on a page at a time**, and you press Play on the layer to run it ([P] [quick start](https://help.figma.com/hc/en-us/articles/41147702210071-Quick-start-guide-to-generative-plugins-and-shaders)).
- **Export:**
  - PNG (a fixed frame) (unverified); MP4 / WebP / GIF by keyframing the shader in the Motion timeline and exporting ([P] quick start).
  - To Figma Make via MCP, but exported instances "won't stay connected" to the source shader.
  - The code viewer (2026-09-01) shows the source and allows download. Since 2026-09-01, frames copied to an external agent render their shaders in the generated React ([P] release notes and quick start).
  - Motion **code** export still drops GenEffect visuals, and MCP video export does not render them [P][skill:implement-motion].
- **Built-in examples:** pixel stretch, lens distortion, slice shift, bloom, nebula, S-gradient ([P] [Workflow lab](https://help.figma.com/hc/en-us/articles/42847574436119-Workflow-lab-New-tools-more-expression-with-Figma-Motion-Figma-Weave-and-shaders)). Press lists dithering, pixelation, frosted glass, liquid metal and fractal noise ([S] [TechTimes](https://www.techtimes.com/articles/319041/20260625/figma-config-2026-code-layers-challenge-cursor-gpu-shaders-hit-paid-plans.htm)).
- **Limits:**
  - Needs WebGPU, and **Firefox has it off by default**, so shaders do not render there ([S] TechTimes).
  - Figma notes possible performance issues during the beta.
  - No monetization.
  - Plan availability is contradictory. Help says all plans in Design, and building costs no AI credits during the beta. TechTimes says shader fills are live for Full seats on paid plans.

---

## 5. Weaknesses and complaints (concrete)

1. **Motion cannot be triggered by an interaction.** It auto-plays on load. Figma staff confirmed this on 2026-06-29 and 2026-07-02. The only way around it is an unconfirmed community trick using a 1 ms After-delay Play/pause interaction (§3.8).
2. **Two easing systems that disagree.** Prototype springs are physical (mass/stiffness/damping/initialVelocity) and their custom curves "cannot be saved". Motion springs are normalized (bounce) and can be saved as variables. There are also two transition models: Smart Animate infers by layer name, Motion is explicit keyframes. The screen-transition timeline that would unify them is "coming soon".
3. **Timeline ergonomics** ([S] [usability thread, 2026-06-26 to 08-27](https://forum.figma.com/suggest-a-feature-11/figma-motion-usability-feedback-and-feature-requests-55314); [feedback thread 2026-06-25](https://forum.figma.com/share-your-feedback-26/figma-motion-feedback-55303)):
   - nested layers clutter the timeline, with no collapsible groups or property filter;
   - no snapping to 100 ms marks or to keyframes, and no way to type a keyframe's time;
   - no layer in/out points;
   - new layers land at t=0 rather than at the playhead;
   - no multi-select in the Animations panel;
   - presets show their raw properties instead of their name;
   - copying easing takes several clicks, with no ⌘C/⌘V;
   - no select-all-keyframes for a property;
   - **no graph editor spanning several keyframes**, only easing per segment;
   - no parenting (one layer following another);
   - no trim paths on closed shapes (the preset);
   - no alignment tools inside Motion mode;
   - the state separation between Design and Motion modes confuses people.
4. **The model is shallow next to Rive and After Effects** ([S] [Rive Masterclass 2026-06-25](https://www.rivemasterclass.com/blog/figma-motion-vs-rive); [Motion the Agency 2026-07-14](https://www.motiontheagency.com/blog/figma-motion-vs-after-effects); [MakerStack 2026-06-27](https://makerstack.co/reviews/figma-motion-review/)):
   - no state machine, data binding, constraints or bones;
   - "one timeline per artboard", and an export that plays the same way every time;
   - no expressions (After Effects' "Expressions and the Graph Editor" have no equivalent) and no frame-level precision;
   - no particles or compositing.
5. **Paywall:** publishing animated components, generating motion with the agent, and HD export (above 1080p or 30 fps) all need a Full paid seat ([P] §3.1, §3.7).
6. **Export and handoff holes:** no Lottie yet, no audio, animation export only from top-level frames, and MCP loses prototype and Smart Animate data plus shader visuals (§3.7).
7. **Beta instability:** the end-state flash and dead overlay animations lasted about 12 weeks before the 2026-09-16 fix (§3.8).
8. **Shader constraints:** one live animated shader per page, Firefox unsupported, exported instances disconnected (§4.2).
9. **Smart Animate** cannot animate shadows, shape morphs, noise or texture effects, and matches by layer name, which is fragile when renaming ([P] §2.4).

---

## 6. Juno Design's motion model compared with Figma
Juno sources: `01-AUDIT-WEB.md` §5.2 and §7, and `src/lib/design/types.ts:640-735`, read first-hand.

| Aspect | Figma (2026) | Juno Design (today) | Implication |
|---|---|---|---|
| Triggers | 12: click, drag, hover-while, press-while, key/gamepad, mouse enter/leave/down/up, after delay, video hit/end | 7: click, hover, press, drag, key, delay, **scroll-into-view** (`types.ts:645-652`) | Juno has **scroll-into-view**, which Figma users are asking for. It lacks enter/leave, down/up and media triggers. |
| Actions | 15, incl. Conditional, Swap overlay, Change to, media, multiple actions per trigger | 10: navigate, back, open/close overlay, scroll-to, open-url, set-variable, set-variable-mode, set-variant, **play-animation(reverse)** (`types.ts:654-664`). One action per interaction; no conditionals. | **`play-animation` answers Figma's #1 Motion complaint** (§3.8). It needs a runtime, though: the audit says transitions reach no runtime and there is no player (M61). |
| Transitions | Instant, Dissolve, Smart Animate, Move in/out, Push, Slide in/out, Scroll animate; matchLayers on directional | instant, dissolve, slide, push, move, plus `matchStableIds` (matches by stable id, not by name) | Id-based matching is more robust than Figma's name+hierarchy. But the export drops every transition (M61). |
| Keyframe semantics | Easing on the **incoming** segment; first keyframe holds back to 0 and last holds to the end; transforms **relative** (additive translate/rotate, multiplicative scale) over the layout position; anchor point editable | Easing on the **outgoing** segment (`types.ts:714`); **13 absolute** properties including x/y | Juno's absolute x/y is the root cause of **M64** (x/y tracks do nothing on auto-layout children in preview but move 100 px in export). Figma's relative-offset model avoids this by design. |
| Animatable fields | Transforms, opacity, radii, stroke/border weights, **auto-layout gap and padding, grid gaps**, path trim, W/H, fill/stroke colour by index, **every effect field (incl. glass, noise)**, **shader properties** | x, y, w, h, scale, rotation, opacity, cornerRadius, fill/stroke colour, fontSize, letterSpacing, blur | Juno animates font size and letter spacing, which Figma does not expose publicly. Juno lacks path trim, layout spacing and effect fields. |
| Easing | 7 curves + Hold + custom bezier; springs Gentle/Quick/Bouncy/Slow + custom **bounce**; saveable Easing and Timing **variables with modes** | linear, ease-in/out/in-out, cubic-bezier, spring(stiffness, damping, mass); no presets or curve editor; no duration+bounce springs even though `lib/motion.ts` uses that form | Adopt Figma's naming and preset set, **duration+bounce** springs, **Hold**, and easing/timing tokens. |
| Presets | Animation styles (Fade, Move, Scale, Rotate, Resize, Path, composites) as bars with duration handles; stackable | None | Presets are the **cheapest thing for a chat model to emit**: one style id and three params, not N keyframes. |
| Timeline | One per top-level frame; default 2000 ms; Loop/Once/Ping-pong; zoom; resizable; auto-key; motion paths on canvas; time-stamped comments | Named animations with `loop`, scrub and play; no zoom, multi-select, copy, snapping or record; Delete deletes *layers* (M66) | Juno's multiple named animations per document plus `state` is closer to "animation sets" (a Figma user request) and to Rive states, but has no UI. |
| Player | Present (new tab, flows, device frame, hints, hide UI, responsive scale), inline preview Shift+Space, prototype-only share | **No player anywhere** (M61; §7 of the audit) | This is table stakes for the merged surface. Claude Design has **Play** mode (`<a href>` prototype links). |
| Code handoff | Dev Mode read-only timeline, CSS/React/JSON copy; MCP `get_motion_context` with snippets and timeline cohorts; SwiftUI mapping | Only the HTML prototype runs motion. React and SwiftUI print a note. Springs export as ease-out (L20). | A motion IR with emitters (CSS @keyframes, motion.dev, SwiftUI `KeyframeAnimator`/`.spring(duration:bounce:)`) matches Figma's architecture. |
| Media export | MP4, WebM, GIF, animated SVG (Lottie soon) | None | Juno lacks media export entirely. |
| Effects | Shadows, layer/background blur incl. **progressive**, noise (3 kinds), texture, glass (incl. dispersion and splay), **shader** | 7 kinds: drop, inner, layer blur, background blur, noise, texture, glass (blur, saturation, refraction, depth, tint, light intensity and angle). **Shader deliberately excluded**: "a shader is a program… Eight exporters cannot" (`types.ts:117-123`). No progressive blur. | Juno's "every effect is a recipe every exporter can honour" rule is principled. Figma pays the price it avoids: GenEffects missing from code and video export, Firefox, one live shader per page. In a merged Artifacts surface, a shader could live as an **HTML/React artifact layer** rather than a scene effect [I]. |
| AI authoring | Agent writes real keyframes; "N variants" pattern; bulk edits of 100+ keyframes | The compact chat grammar **cannot express motion**, and a chat revision deletes motion (D6) | The key merge risk: motion must survive AI round-trips. |

---

## 7. Takeaways for the merged Juno surface [I]
1. **One player, everywhere an artifact appears.** Figma splits it three ways: Present tab, inline preview, and Motion-mode Play. Claude has Play for Design and Present for Slides. Juno needs one player that works in the Canvas, in full screen and at the share link, with the timeline's Loop/Once/Ping-pong and reduced-motion honoured.
2. **Unify Smart Animate and keyframes before Figma does.** Figma's "screen transitions get a full timeline" is still unshipped. Juno already has `matchStableIds` and `play-animation`. A transition could be a generated, editable timeline between matched ids.
3. **Switch to relative transform tracks, incoming-segment easing and holds** to match Figma's semantics. This fixes M64 and L21, and makes Figma's MCP output a near-lossless import format.
4. **Put motion tokens in the Design System type.** Juno's product ladder (6 durations, 9 curves) becomes Timing and Easing tokens. Designs and artifacts reference them, and mode switches retime everything, as Figma's variables with modes do.
5. **Presets first for the model.** A chat model emits `{style: "fade", timing: "in", duration: "@motion.short", easing: "@ease.out"}` far more reliably than raw keyframes. Figma's own agent guidance asks for variants, feel and constraints.
6. **Time-stamped comments** tie into the unified comments model that Claude has (anchored threads, comments sent to the model).
7. **Handoff IR:** copy Figma's snippet-plus-cohort contract (`timelineCohorts`, `loopMode`, `transformOrigin` per element, reduced-motion required) for the React and SwiftUI emitters and for the Juno Code handoff.
8. **Avoid Figma's two-easing-systems mistake.** Use one spring form (duration+bounce) and one easing type across prototype transitions, keyframes, slides and product motion.

---

## Fact-check (2026-09-23)

An adversarial pass re-read each load-bearing claim: the cited URLs were fetched again and the local Figma plugin skills and `plugin-api-standalone.d.ts` were grepped. The web-search budget was already spent, so second sources come from fetching other Figma pages directly.

**Verified, no change needed**
- Figma Motion open beta at Config 2026 (23–24 June; Motion rolled out 2026-06-24). It has a timeline, keyframes, presets, Dev Mode CSS/React/JSON, and MP4/WebM/GIF/animated SVG export. Sources: the blog (David Hornsby, 2026-06-24), What's new, and the forum roundup.
- Motion cannot be triggered by prototype interactions and auto-plays on load. Staff said so twice: Tom Reem on 2026-06-29 ("doesn't appear to be available yet") and adamsmasher on 2026-07-02 ("There isn't a way to do this right now").
- Transform tracks are relative: translate and rotate add, scale multiplies. Other fields are absolute. A keyframe's easing controls the segment arriving at it, and the first/last values hold (`motion-patterns.md:71-120`).
- Motion custom springs use a single `bounce` (0–1; `NormalizedSpring`, d.ts:3558). Prototype springs use mass, stiffness, damping and initialVelocity (d.ts:3519). The help page names the Bounce field but gives no range.
- Timing (ms) and Easing are variable types (six types in all) and support modes. "Custom curves and springs can be saved as variables."
- New animations default to 2000 ms. Playback cycles Loop, Once, Ping-pong. Spacebar plays. Zoom, the unit toggle, and Collapse layers are all confirmed.
- Export above 1920×1080 or 30 fps is paid-only. Audio support is "on the roadmap" (Workflow lab FAQ). Lottie is promised as a future format.
- MCP `get_motion_context`: snippets (CSS `@keyframes` plus motion.dev), `timelineCohorts` with `loopMode: once|loop|boomerang`, and the verbatim lint rule that prototype interactions and Smart Animate are not supported.
- Shaders: open beta at Config. The 2026-09-01 release note adds shaders "that incorporate motion and [are] reactive to mouse movements", Community/org publishing, a code viewer, and MCP/React rendering. "Only one animated or interactive shader can run on a page at a time." While in beta, building shaders costs no AI credits.
- Glass: beta in Plugin API update 116 on 2025-07-17 (frames only, no variables). It left beta on 2026-01-27 with any-object support, non-uniform corners, Splay and variables.
- Coming soon: the screen-to-screen transition timeline, 3D transforms, custom animation styles (figma.com/motion and the blog), and Lottie (blog and What's new).
- The glitch fix: reported 2026-06-26 (Floandfish). Staff member Celyn_L said on 2026-09-16 that a fix had been rolled out.
- Also checked: UI details (anchor point ⌥R, center versus top-left origin; motion-path boxes and dots, ⌘-drag handles; path-trim rules; purple instance tracks; the auto-keyframe red bar and its warning); prototype triggers (12) and actions (15); the 1–10,000 ms duration range; Present shortcuts; prototype spring presets and the rule that custom curves cannot be saved; Dev Mode needing a Full or Dev seat on paid plans; the three review articles and their dates; the forum complaint threads and their dates; Juno `types.ts` line references; and the Claude Slides transition names.

**Corrected**
- *Paywall wording (§3.1).* The earlier text said a "Full seat" is needed. The primary source says a Full seat **on a paid plan** is needed to publish animated components, generate motion with the agent, and export high-res video. Base Motion is "Available for Full seats on all plans". The Government-plan exclusion is now cited to Figma's own What's new page, not only TechTimes.
- *Progressive blur, noise and texture (§1).* Upgraded from an unfetched LinkedIn post to the Figma Draw blog (2025-05-07).
- *Workarounds (§3.8).* The 1 ms After-delay + Play/pause workaround is dated 2026-07-16 (giuseppe.zagaria) and nobody confirmed it works. The "set playhead" variant trick dated 2026-07-10 was not found in either thread and is tagged unverified. The workaround's use of Play/pause is noted as a softening of the "cannot be triggered" limit.
- *Smart Animate (§2.4).* Unmatched layers dissolve only in a plain Smart Animate transition. Inside another transition they use the main transition. The help page does not say noise and texture "fall back to dissolve"; it says they are randomly generated and advises duplicating frames.
- *MCP cohorts (§3.7).* `timelineCohorts` appears in **recursive** responses.
- *After Effects comparison (§5.4).* Changed "limited expressions" to "no expressions / no frame-level precision", which matches the source.
- *Ways into Motion (§3.1).* Reworded. The blog does not describe "three ways in".
- *Timelines (§3.3).* `node.timelines` is a list. "One timeline per frame" describes the current UI.

**Inferred or unverifiable (kept, labelled)**
- The idea that Motion code export runs on the Figma Sites runtime is still inferred. The evidence is stronger than before: the lint rule says "sites runtime", and `gotchas.md` cites `sites-runtime/src/attributes/masks.ts`. No Figma page states it.
- Exporting a shader to PNG is unverified.
- `SCROLL_ANIMATE` meaning "the animated Scroll to" is inferred. The Transition docs list it without explaining it.
- Transition duration in seconds rests only on the d.ts example value `0.2`; the Transition docs give no unit.
- The Rive review's claim of "no variables" in Figma Motion is wrong, because Timing and Easing variables exist. These notes do not repeat it.
