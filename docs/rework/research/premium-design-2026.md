# Premium design directions 2026: what reads as premium, what reads as slop, and what Juno must do

Phase 2 research, Task D. Written 2026-09-30 on `rework/refoundation` (head `cdb09e56`). Research only; no code changed.

**Method.**
- Read first-party design writing (Linear, Raycast, The Browser Company, Apple WWDC25 sessions, Granola, Figma, Vercel, Claude blog) and design press, 2024-09 to 2026-09.
- Looked at the actual product imagery in the built-in browser on 2026-09-30: Linear's refresh before/after plates, Raycast 2's launch plates, Granola's product plate, and the live chatgpt.com (logged out), cursor.com and perplexity.ai/comet pages. Anything I describe as **observed** comes from those views.
- Computed every colour comparison in OKLCH with a script (sRGB → OKLab → LCh), not by eye.
- Took token values (hex, weights, radii) from design-token aggregators only when no first-party source exists, and labelled them **[aggregator, UNVERIFIED]**. A claim I could not confirm first-hand is marked **UNVERIFIED**.

**Caveats.**
- **Mobbin was unavailable.** Every call to `search_screens` and `search_flows` returned "Mobbin MCP requires a paid plan". No Mobbin screens were examined and no Mobbin URLs can be cited. I did not download substitute images, so `scratchpad/refs/direction/` is empty. Instead, §9 lists the first-party high-resolution image URLs I viewed, ready for the owner's board.
- **The Claude post-merge UI has no design coverage.** No design teardown of Claude's interface after the 2026-09-16 merge exists yet. TechCrunch's launch piece gives no visual specifics. Claude findings therefore come from Anthropic's own posts, the Geist identity coverage and `research/anthropic.md`.
- **Round-2 labs were read in progress.** The notes on round-2 labs in §7 come from untracked work in `src/app/dev/design/` as it stood today. The designers may change it.

---

## 1. Summary: ten findings

1. **The chrome is monochrome and colour belongs to content.** Every product studied that reads as premium in 2026 keeps its interface chrome free of colour. The chatgpt.com home has no accent anywhere (observed). Linear's March 2026 refresh *dimmed* the sidebar and removed coloured team-icon backgrounds. Raycast 2's root list gets all of its colour from the items' own app icons (observed). Dia extends the web page's colour into the tab. In each case the colour comes from the thing being shown, and the chrome carries none.
2. **Premium hierarchy uses size, lightness and spacing, not bold.** Display type is set at regular weight: ChatGPT's greeting "Where should we begin?" (observed), Cursor's hero headline (observed), Perplexity's 400/500 scale [aggregator] and Superhuman's headlines at weight 460 [aggregator, UNVERIFIED]. Two weights is the norm.
3. **Structure should be "felt, not seen."** Linear softened borders and separators (2026-03-12). Apple replaced hard dividers with a scroll-edge blur and says hierarchy "should be expressed through layout and grouping" (WWDC25 356). Fewer lines means more premium.
4. **The chrome recedes and the work is the brightest thing on screen.** Linear's first principle: "Don't compete for attention you haven't earned." The product's own navigation gets quieter every year.
5. **Owned type is the strongest single identity lever.** OpenAI Sans (2025-02), the Anthropic Sans/Serif/Mono family, Cursor Gothic plus Cursor Mono (2025-11), pplxSans and Super Sans are all bespoke. Everyone who can afford to owns their voice. Juno cannot commission a face this phase, so it needs a distinctive open face used with total consistency from brand to product. It also must not borrow another company's corporate face (§7, round-2 note).
6. **Brand is loud outside the product and quiet inside it.**
   - Granola's identity is collage, handwriting and a slab serif. Its product plate is an almost empty off-white page with one slab-serif title and a floating capsule bar (observed).
   - Anthropic's clay "recedes" inside Claude [press].
   - Comet's orbital planets live on the landing page, not in the browser chrome (observed).
7. **Native fidelity is part of what premium means on Apple platforms.** Raycast 2, although built on web technology, adopted the Mac's conventions:
   - no `cursor: pointer`;
   - no hover highlights on most controls;
   - popovers and tooltips as native windows;
   - no flicker on transitions ("a common tell in web apps");
   - Liquid Glass only "in tasteful ways".

   Apple's own rules: glass only on the navigation layer, "always avoid glass on glass", and tint "only... primary elements and actions".
8. **Motion answers interaction; it does not fill idle time.**
   - Liquid Glass "flexes" on touch.
   - Things' Magic Plus deforms "fluid-like" as it is dragged.
   - Dia spends its "novelty budget" on the one surface where no pattern exists yet (the assistant bar).
   - Emil Kowalski's rules: under 300 ms, ease-out, interruptible, and "never animate keyboard initiated actions".
9. **The 2026 slop tells in AI products are specific.** They include sparkles, gradient orbs and "border beams", shimmer on every state, "Good morning, Name" with four starter cards, coloured status pills, and cards inside cards (§5). Several of these effects now ship as off-the-shelf packages. An effect you can `npm install` cannot be a signature.
10. **Of the three round-2 premises, Porcelain is the right base.** Canvas's *tokens drawn with the entity's own mark* is the best single idea across all three, and its dot-grid home is the weakest. Instrument is right for Juno Code and for the dark appearance, but wrong as the brand premise, and its luminous accent is the most generic element in the set (§7).

---

## 2. Teardowns: what each admired product actually does

### 2.1 OpenAI (ChatGPT, 2026 design language)

| Dimension | What they do | Source |
|---|---|---|
| Type | **OpenAI Sans**, made with ABC Dinamo. Geometric, built around circular forms and "the point". It replaced six or seven faces. Principles: "Simplify, Space, Imperfection, Vivid"; "Space is underrated" (Veit Moeller). | Wallpaper*, 2025-02-04 |
| Colour | The product is monochrome. Logged-out chatgpt.com shows a near-black ground, white type, a grey pill composer and no accent at all. Brand colour is reserved for marketing's "watercolour" blues. | observed 2026-09-30 |
| Composer | "Where should we begin?" in one regular-weight line; a pill field with `+`, placeholder "Ask ChatGPT", mic and send; one suggestion ("What can you do?"). Four objects, which is exactly the Juno composer spec in §5. | observed 2026-09-30 |
| Sidebar | Icon plus label rows with no colour and no counts. | observed |
| Motion | The "Emotive Point", a pulsing blue disc for voice (2025). This is now OpenAI's signature, so Juno must avoid it. | Wallpaper* |
| Characters | **dots** (2026-09-29): user-customised cartoon agents, described as a "bubbly, cartoonish persona" [press paraphrase, UNVERIFIED verbatim]. | `research/openai.md` §2.6 |
| Weakness | Greg Brockman on the merged desktop app: "kind of a mess"; tab-free redesign promised by year end. | 9to5Mac, 2026-07-29 |

**Lesson.** OpenAI's product premium comes almost entirely from type, space and removal. The character layer (dots) is new, and it now owns "cute agent avatar". Juno's crew faces must read as *instruments of state*, never as mascots.

### 2.2 Anthropic (Claude after the September merge)

- **Identity.** Custom Anthropic Sans, Serif and Mono (Geist studio with BSPK). Ivory ground #faf9f5, clay #d97757 / #C15F3C, serif greeting. The clay "recedes" inside the product so the conversation leads [press: Studio Siraj, abduzeedo; UNVERIFIED first-party].
- **Structure (first-party).** The Claude Code desktop redesign (2026-04-14) has:
  - a sidebar filterable and groupable by status, project and environment;
  - drag-and-drop panes (terminal, editor, diff, preview, chat);
  - three verbosity modes (Verbose / Normal / Summary);
  - a side chat on ⌘;.

  Agent view uses "a colored state word and a classifier-written headline" instead of raw tool text (`research/anthropic.md` §1.7).
- **Merge (2026-09-16).** Chat, Cowork and artifacts are in one window with no mode switch (TechCrunch). No visual teardown exists yet.

**Lesson.** The ivory-plus-serif-plus-clay triad is Claude's, and Juno today sits ΔE_ok 0.13 from Claude's ivory (`research/naming-identity.md` §1.5). The transferable ideas are structural: state as a word plus a headline, verbosity as a user setting, and panes that appear only when useful.

### 2.3 Perplexity and Comet

- **Type.**
  - Comet uses **Editorial New** (a condensed display serif) as primary, with **FK Grotesk**, **FK Display** and **Berkeley Mono**, by Studio Freight. It uses "variable weights that expand on hover" and "parabolic lines, inspired by orbital paths" (Fonts In Use, 2025-10-23).
  - The product uses **pplxSans** at 400/500, a cream canvas #fdfbfa and a single teal #016a71, with pills at 9999px, containers at 12px and chips at 6px [aggregator, UNVERIFIED].
- **Observed (comet landing, 2026-09-30).** A large condensed serif headline, grainy textured "planets", thin orbital lines and a dark pill CTA.
- **Voice.** Voice in Comet was made browser-level and ambient, not blocking the screen, with an optional floating transcript. Plain descriptive labels replaced "branded terms and cryptic icons" [search summary of a designer's case study; page 404 on fetch, UNVERIFIED].

**Lesson, and a warning for Juno.** Juno's identity brief is titled "Orbital Precision" (`PRODUCT_REFOUNDATION.md` §12). **Orbital line art is Comet's signature.** Keep "orbital" as a system metaphor, as `naming-identity.md` §2.3 already advises, and never draw orbits, rings or planets.

### 2.4 The Browser Company (Dia; Arc before it)

From "The strategy behind Dia's design", Charlie Deets, 2025-06-17:

- **Familiarity first.** "anyone to switch to Dia at 10am on a Tuesday morning". Arc's novelty was the lesson.
- **A novelty budget.** Spend invention only on chat, where no pattern exists, and express it with animation and colour there.
- **Removal as craft.**
  - No update banners; updates install in the background.
  - The bookmark and site-settings buttons appear only on URL hover.
  - The profile switcher hides unless in use.
  - One obvious way to do each thing.
- **Content colours the chrome.** The page's colour extends into the active tab.
- **Motion.** Fluid animation on the most-used surface (the assistant bar) and an animated "tab pile" for attached references.

**Lesson.** Juno's context tokens are Dia's "tab pile" idea done inline. Spend Juno's novelty budget on tokens, crew presence and the task hand-off. Everything else should be boringly familiar.

### 2.5 Linear (2024 → 2026)

- **Part II redesign (2024-03-28).**
  - Theme generation moved to **LCH**, with 98 variables per theme reduced to 3 inputs (base, accent, contrast).
  - Inter Display for headings, Inter for body.
  - Karri Saarinen: a redesign "should not completely disassemble the product".
- **Liquid Glass on iOS (2025-10-21).**
  - They rebuilt the material themselves so the tab bar could exceed five items.
  - They left out refraction because it "can make dense professional interfaces harder to read".
  - Increase Contrast gets solid outlines.
- **"A calmer interface for a product in motion" (2026-03-12).** Principles: "Don't compete for attention you haven't earned" and "Structure should be felt not seen". Observed on the before/after plates:
  - the sidebar is several notches darker than the content;
  - icons are smaller;
  - inactive rows are muted to roughly the section-header level, and only the active row is full white;
  - vertical padding is increased;
  - tab-bar pills are merged into one segmented control;
  - borders are softer;
  - the palette moved "from cool blue-ish hue to warmer gray";
  - team-icon colour backgrounds are gone.

**Lesson.** The most admired product UI of the period evolves by *subtraction* and *dimming*. That is exactly Porcelain's premise, provided Porcelain also finds a signature.

### 2.6 Raycast 2 (Mac, 2026-05-14)

- **Look.** Liquid Glass used "in tasteful ways to enhance the functional nature of a launcher". The system accent colour is respected [manual; third-party].
- **Observed launch plates.**
  - A dark glass panel.
  - Section labels ("Favorites", "Suggestions") in small muted type.
  - Rows made of the item's own coloured icon, a white name, a grey subtitle and a right-aligned grey type word ("Command", "Application").
  - A bottom action bar showing the primary action with its keycaps (`Open Command ↵`, `Actions ⌘K`).
  - The AI chat sidebar is monochrome with no accent at all.
- **Native conventions**, listed in "A technical deep dive" (2026-05-14):
  - no pointer cursor;
  - no hover highlights on most controls;
  - settings in a separate native window;
  - native popovers that can extend past the window;
  - no flicker.

**Lesson.** This is the model for Juno's Mac app and for how context tokens should look (mark plus name, colour only from the mark). Keycap hints in a bottom action bar are a premium detail that costs almost nothing.

### 2.7 Things 3.22 (Cultured Code, 2025-09-16)

- Redesigned curves for windows, to-dos, dialogs and controls, with wider spacing and a translucent sidebar.
- "Glassy buttons that scale and glow in response to touch".
- The Magic Plus button "displays fluid-like deformation when moved".

(MacRumors, 2025-09-16.)

**Lesson.** Things is premium because of one signature object (Magic Plus) that behaves physically when you touch it. Everything else is quiet.

### 2.8 Apple Liquid Glass (iOS / macOS 26)

From WWDC25 "Meet Liquid Glass" (219) and "Get to know the new design system" (356):

- **Where glass goes.** Glass is "best reserved for the navigation layer that floats above the content". Putting it on content would "muddy the hierarchy".
- **No stacking.** "Always avoid glass on glass". Use fills, transparency and vibrancy for elements that sit on glass.
- **Tint sparingly.** "Tinting should only be used to bring emphasis to primary elements and actions." Colour belongs "in the content layer instead".
- **Shape.** Three kinds: *fixed*, *capsule* and *concentric*, where an inner radius equals the outer radius minus the padding. Watch for corners "too pinched—or flared".
- **Type.** Now "bolder and left-aligned" in alerts and onboarding.
- **Dividers.** Scroll-edge effects replace hard dividers, one per view.
- **Accessibility.** Reduce Transparency makes glass frostier, Increase Contrast makes it black or white, and Reduce Motion "disables elastic properties".

**Lesson for Juno.**
- Native: the owner rule (system Liquid Glass) is right. Keep brand colour out of the glass except the one primary action.
- Web: **do not imitate Liquid Glass.** Refraction and blur on the web read as 2021 glassmorphism, and the slop sources name "glassmorphism with a neon glow".

### 2.9 Figma (Config 2026) and the UI3 lesson

- **Config 2026 identity.** "In a time when we have tools that allow us to automate more and create perfect visuals, we wanted to appreciate touches of imperfection" (Figma blog, Config 2026-06). Figma announced Motion, Code Layers and shaders. Coverage summarises the craft of motion as moving "up the stack, from executing animation to directing it" (Qubika recap; UNVERIFIED wording).
- **UI3 floating panels.** Figma shipped floating panels in the UI3 beta. It returned to **fixed panels by default on 2024-10-10** because floating panels "hindered people who spend many hours a day in Figma": they cramped the canvas and let content peek out from behind them (Figma, Threads "Fixed panels are so back"; forum).

**Lesson.** Persistent panels dock; only transient things float. This bears directly on Canvas (§7.2).

### 2.10 Vercel / Geist

- **Type.** Geist and Geist Mono. The palette is stark monochrome, ink #171717, with aggressive negative tracking at display sizes [aggregator, UNVERIFIED].
- **Craft rules.** More useful than the look are the **Web Interface Guidelines** (vercel.com/design/guidelines, undated):
  - visible focus rings;
  - hit targets of 24 px on desktop and 44 px on mobile;
  - loading indicators shown after a 150–300 ms delay and kept for at least 300–500 ms;
  - optimistic updates with rollback or Undo;
  - "Never `transition: all`";
  - motion cancellable by input;
  - tabular numbers, curly quotes, `…` in loading labels;
  - optical ±1 px alignment;
  - two-layer shadows (ambient plus direct);
  - APCA over WCAG 2 for contrast.

**Lesson.** Geist is too widespread to use as a voice (`naming-identity.md` §2.4f). Adopt the guidelines as Juno's micro-interaction floor (§6.3).

### 2.11 Notion (2026)

- The sidebar was reorganised into tabs (pages, agent chats, meetings, notifications) in March 2026.
- Notion AI is represented by a **drawn face** in a floating button.

(Notion releases 2026-03-26, via search summary; UNVERIFIED detail.)

**Lesson.** Notion, OpenAI (dots) and Superhuman (the "Hero" character, 2025-12) all now give their AI a face or character. **The "AI with a face" space is crowded as of this month.** Juno's crew faces are defensible only as precise state instruments, per `PRODUCT_REFOUNDATION.md` §7.

### 2.12 Superhuman (Grammarly rebrand, 2025-10 → 2025-12)

- **Identity** by Smith & Diction:
  - "Hero", a circle-and-triangle character "designed to be there for anything you need";
  - palette "Heart" (a deep warm base) and "Mysteria" (a light wisteria);
  - motion as essential: "When something moves with human qualities, people instantly sense intelligence" (Collin Whitehead, Branding Journal, 2025-12-22).
- **Product craft.** The quality bar is "at least as good as a one-shot Lovable design". Teams prototype in code with real LLM output, and "traditional Figma work" is only "5 to 10% of the work" (Verified Insider, 2026-01-29).

**Lesson.** Premium AI surfaces are designed *with real model output*, not lorem ipsum. Round 2's fixtures must be real transcripts.

### 2.13 Granola (rebrand, 2026-02)

- **Identity** by Ragged Edge:
  - "Calm, but with energy underneath";
  - a hand-drawn, "intentionally imperfect" logo;
  - Quadrant (a slab serif) for display and Melange for UI;
  - a pea-green given "a proper system";
  - custom handwriting assets (Granola blog, 2026-02-02; Gesso, 2026-02-10).
- **Named clichés.** Gesso lists the AI-company clichés Granola avoided: "Geometric sans serif typefaces (Inter, Geist)", "Electric blue and neon green", "Ultra-polished, hyper-clean", "Smooth gradients".
- **Observed product plate.**
  - An off-white page with a slab-serif note title ("Team Stand-up").
  - Two tiny metadata chips.
  - A faint "Write notes…".
  - A floating bottom capsule: a green live-audio glyph, a stop button, "Ask anything" and one recipe chip.
  - The brand green appears only as the *live recording* indicator.

**Lesson.** Granola spends its brand colour on the one thing that is alive. That is the exact rule Porcelain's "presence colour" should adopt (§7.1).

### 2.14 Cursor

- **Identity** by Kimera (2025-11-03):
  - Cursor Gothic, a condensed, higher-contrast take on Waldenburg, with Cursor Mono in the editor;
  - warm-tinted neutrals: "There is some warm undertone to everything";
  - rounded icons that echo the letterforms;
  - "screen-based design often requires abandoning geometric purity for optical truth".
- **Product UI.** Uses the system face for dense chrome [aggregator, UNVERIFIED].
- **Observed on cursor.com (2026-09-30).**
  - A warm near-black ground and a large regular-weight headline.
  - The product window is set on a painted landscape.
  - The agent list is grouped under small-caps section labels with counts ("IN PROGRESS 1", "READY FOR REVIEW 4"). Rows carry a state *sentence* ("Generating plan", "Done. Fonts preload in the head…"), a muted relative time and diff counts as coloured text (+135 −21). There are no badges.
  - The transcript shows tool steps as muted verb plus object ("Read about-acme.md", "Thought 6s").
- **Cursor 3** (2026-04-02, codename "Glass") added the Agents Window.

**Lesson.** This is the best current model for Juno's *Needs you* and task rows: group by state, give state as words, and use colour only for data (diff counts).

---

## 3. Cross-cutting analysis

### 3.1 Typography

| Product | Faces | Weights in use | Notable move |
|---|---|---|---|
| ChatGPT | OpenAI Sans (bespoke) | regular greeting | one-line greeting, no serif |
| Claude | Anthropic Sans / Serif / Mono (bespoke) | — | serif greeting on ivory (Claude's own) |
| Perplexity | pplxSans; Comet: Editorial New, FK Grotesk, Berkeley Mono | 400/500 [agg.] | condensed serif display on marketing only |
| Linear | Inter + Inter Display | 400/500 | one display cut makes Inter feel owned |
| Cursor | Cursor Gothic + Cursor Mono; system in chrome [agg.] | regular headline | one family from brand to editor |
| Superhuman | Super Sans VF (bespoke, non-standard weight axis) | 460 headlines [agg., UNVERIFIED] | between-weights display |
| Granola | Quadrant (slab) + Melange; handwriting | — | slab serif for titles only |
| Raycast | system (SF) | — | follows the OS |
| Vercel | Geist + Geist Mono | — | tight negative tracking [agg.] |

**Patterns.**
- Two weights.
- Display type at regular weight, with hierarchy from size and ink lightness.
- Numbers in tabular figures or mono.
- One expressive cut, used only for display.

**Overused.** Inter as the brand voice, Geist, Space Grotesk, and serif-greeting-on-ivory.

**Fresh.** A single owned-feeling family used identically from wordmark to composer, set at weights between 400 and 500.

### 3.2 Colour systems

- **Neutrals.** Warm-shifted neutrals are the 2025–26 direction: Linear moved cool to warm, Cursor went warm, and Perplexity uses cream. Warmth is therefore no longer distinctive, and on Juno's side of the market warm-ivory *is* Claude.
- **Accent frequency.** Observed:
  - ChatGPT: zero accents on the home.
  - Raycast: zero in chrome (colour only in item icons).
  - Linear: one accent, reserved for selection and primary actions; labels carry data colour.
  - Granola: one colour, used only for live audio.
  - Cursor: none on its agent list except diff numbers.

  **The premium norm is zero to two chromatic spots per screen, and each one means something.**
- **Theme generation.** Linear generates themes from three inputs in LCH. Juno should specify neutrals and accents in OKLCH with lightness steps, not hand-picked hex values.

### 3.3 Density

- Density is "value divided by the time and space the interface occupies", and "loading times are the biggest factor in temporal density" (Matthew Ström-Awn, "UI Density", undated in fetch; Config 2026 speaker).
- Premium tools are dense in *information* and sparse in *design decisions*.
- Linear increased vertical padding while shrinking icons.
- Raycast added a Compact mode.
- ChatGPT is sparse because the product is one field.

**For Juno.**
- Chat and crew: generous (reading).
- Code and Needs-you lists: Linear/Cursor density (13–14 px rows, 28–32 px row height).
- The composer: the one comfortable object.

### 3.4 Radius and shape

- **Apple's concentric rule** is the model: inner radius equals outer radius minus padding, capsules for free-standing controls, concentric shapes aligned with window corners on Mac and iPad.
- **Perplexity** uses three steps: pill, 12 and 6 [agg.].
- **Cursor** uses 8 [agg.].
- **Uniform 16 px on everything** is a template tell. Today's Juno has `--radius: 16px` (`src/app/globals.css:260`).
- **Capsules** are reserved in the best products for the composer, tokens and free-floating bars (Granola's bottom capsule, ChatGPT's field).

### 3.5 Depth

- **One elevated object.** Examples: ChatGPT's composer, Granola's floating bar, Raycast's panel over the desktop.
- **Everything else is flat,** separated by tone steps (Linear's darker sidebar) rather than borders or shadows.
- **Where shadows exist,** they are two-layer (ambient plus direct; Vercel guidelines).
- **Glass** is the navigation layer only (Apple).

### 3.6 Iconography

- **Fewer and smaller** (Linear 2026).
- **Custom sets tuned to the type:** Cursor's rounded icons echo Waldenburg.
- **Entity marks carry colour; UI icons never do** (Raycast).
- **Labels beat icons** for anything non-universal (Perplexity's plain-language pass; NN/g on sparkles).

### 3.7 Signature details: one or two, never ten

- **Linear:** dim chrome plus a keyboard-first flow.
- **Raycast:** keycaps in the action bar.
- **Things:** a deforming Magic Plus.
- **Dia:** page colour in the tab, and the tab pile.
- **Granola:** colour only on the live thing; a slab-serif title.
- **Cursor:** fine-art backgrounds (marketing); state sentences (product).
- **ChatGPT:** the Emotive Point (voice).

Every signature is *attached to a function*.

### 3.8 Motion character

- **Physical and interruptible.** Rauno Freiberg: interruptibility, momentum and spatial consistency ("launch from their source").
- **Scaled to frequency.** "High-frequency interactions benefit from minimal animation."
- **Fast.** Under 300 ms, ease-out (Emil Kowalski); springs for spatial moves.
- **Reactive, not ambient.** Liquid Glass "flexing" on touch; Things' deformation.
- **Brand motion is concentrated.** Dia puts it on the one novel surface; Superhuman gives it to the character.
- **Juno's owner brief already agrees:** motion for arrival, attention and settling, never idling (§7).

---

## 4. Fresh vs overused (2026)

| Overused: reads as template or slop | Why | Fresh: reads as premium and considered |
|---|---|---|
| Indigo→purple or purple→cyan gradients; any "AI gradient" | Tailwind indigo-500 default, now in the training data (925studios; smoothui 2026-06-24) | A single ink-dark accent used at most twice per screen |
| Inter / Geist / Space Grotesk as the voice | Granola/Gesso 2026-02-10 name Inter and Geist; `naming-identity.md` | One distinctive open family at 400–500, display at regular weight |
| Warm ivory plus serif greeting | Claude's identity | A sans greeting set from real state, one line |
| Dark hero, one glowing accent, blur ("Linear look") | "almost every SaaS website looks the same" (LogRocket, 2025-06-07) | Dimmed chrome, content brightest, no glow |
| Glassmorphism on the web; neon glow | smoothui 2026-06-24 | Solid tone steps on the web; system Liquid Glass on native only |
| ✨ sparkles for AI | No NN/g participant read it as AI (2024-09-20) | Text labels; the product *is* the AI, so nothing needs flagging |
| Gradient orb or blob for voice and thinking | OpenAI's Emotive Point; commodity "thinking orb" packages | A state shown by the thing itself (the face, the field, the one line) |
| Shimmer text on every "Thinking…" | Every assistant ships it | One honest sentence of state that updates in place |
| Three or four starter cards ("Write a poem") under "How can I help?" | D-016 round-1 failure; slop lists | At most three suggestions derived from the person's own state, or none (§5) |
| Coloured status pills and dots ("Running", "Idle") | Owner rule; Cursor and Claude moved to words | Group by state under a label with a count; state as a sentence |
| Dot or line grid backgrounds | Anthropic, Perplexity, Stripe, Linear, Vercel, Supabase and Raycast all use them (Veila, "flattening"; year UNVERIFIED) | A real canvas only where things can be placed |
| Floating everything | Figma reverted UI3 to fixed panels (2024-10-10) | Dock persistent panels; float only transient layers |
| Six identical icon+heading+two-line cards; bento as default | 925studios; smoothui | Lists and prose; one elevated object |
| Bounce on hover, staggered mount fades, perpetual loops | smoothui; D-017 | Motion only on change; nothing on keyboard actions |
| Mascot agents with eyes and accessories | dots (2026-09-29), Superhuman Hero, Notion's face | Faces as geometric state instruments |
| Uniform 16 px radius, grey 1 px border on every card | Template default | Concentric radii; borders only where a boundary is interactive |

---

## 5. The tells of "AI slop" UI in AI products, and how top teams avoid them

### 5.1 The tells

These are the tells specific to assistants, beyond the generic web list.

1. **The glowing composer.** A gradient border beam, a rainbow ring or a pulsing glow around the input.
2. **The AI signifier soup.** Sparkles on buttons, a gradient orb for voice, and a sparkle-in-speech-bubble logo (banned for Juno in §12).
3. **The greeting stack.** A large "Good morning, Liam" (often in a serif), a sub-line "How can I help you today?", and four suggestion cards with emoji.
4. **Telemetry as content.** "Called `web_search` with {…}", raw JSON, a spinner per tool call, and shimmer on every row.
5. **Status pill confetti.** "Running", "Idle", "Pro" and "New" as tinted pills with dots.
6. **Model picker as a spec sheet.** Intelligence bars, context windows and prices in the first popover (fixed by §6 of the refoundation).
7. **Cards inside cards.** Every assistant turn in a bordered bubble with an avatar, tool results in a card inside the bubble, and a code block inside that.
8. **Default shadcn register.** Zinc or slate neutrals, indigo-600, Lucide icons at 2 px stroke next to 14 px text, 16 px radius everywhere.
9. **Emoji section headers and bold-everything** in model output (a rendering and system-prompt issue as much as a design one).
10. **Motion as filler.** Staggered message fade-ins, typing dots and a bounce on send.

### 5.2 How the admired teams avoid them

- **They prune.** Linear speaks of "pruning the product's edges"; Dia wants "a single, obvious way" to do each thing; Perplexity replaced branded terms with plain labels (UNVERIFIED).
- **They keep a novelty budget.** Dia invents only where no pattern exists and stays familiar everywhere else.
- **They own the type.** OpenAI, Anthropic, Cursor, Perplexity and Superhuman all have bespoke faces.
- **They keep the brand outside the working surface.** Granola, Anthropic and Comet all do this.
- **They design with real output.** Superhuman says Figma is "5 to 10% of the work" and prototypes in code with live LLM text.
- **They choose optical over mathematical.** Kimera: "optical truth"; Vercel: "Adjust ±1px".
- **They follow native conventions religiously on native** (Raycast's list in §2.6).
- **They run a closed loop.** Build, critique against acceptance criteria, fix, re-evaluate (smoothui 2026-06-24). This is the same shape as round 2's three self-critique passes.

---

## 6. What a Juno direction must do to be recognisably premium and ownable

### 6.1 The contract (every direction, every screen)

1. **Colour means alive.**
   - Chrome is monochrome.
   - The brand primary (ultramarine, OKLCH h 266–271, L 0.44–0.50 in light) appears only where Juno or a crew member is *currently acting*, plus the armed send. That makes at most two spots per screen.
   - Amber appears only as the words that say someone needs you.
   - Every other colour comes from an entity's own mark: an app icon, a file type, a crew face.

   This is Granola's rule plus Raycast's rule, and it is ownable because it is a *behaviour*, not a hue.
2. **One voice.**
   - One text family at two weights (400 and 500, or a variable 400–520) from wordmark to composer.
   - Display at regular weight; tabular or mono numerals; no serif greeting.
   - The face must not be another company's corporate typeface (§7 note).
   - Covers Latin, Cyrillic and Vietnamese.
3. **The content is the brightest surface.** Chrome is one tone step darker (light) or lighter-black (dark) and dimmer in text, following Linear 2026.
4. **Structure is felt.**
   - No divider lines between list rows.
   - Sections separate by space plus a small muted label with a count (Cursor).
   - Scroll-edge blur replaces toolbar borders (Apple).
5. **One elevated object per screen.** Usually the composer; otherwise the active sheet. Everything else is flat.
6. **Concentric shape system.**
   - Capsule for the composer, tokens and floating bars.
   - Concentric radii for nested containers.
   - Small fixed radii (6–8) for rows and chips.
   - Never one radius for everything.
7. **Icons.** One set, tuned to the type's stem weight, used sparingly and smaller than text cap height plus 2. No sparkles, no emoji, no coloured icon tiles in chrome.
8. **State is words.**
   - "Mira is drafting the renewal summary."
   - "Scout needs you: approve the plan."
   - Grouped lists carry a label and a count.
   - No pills or dots (owner rule).
9. **Signature budget: three things, all functional.**
   - Context tokens drawn with the entity's own mark.
   - Crew faces as state instruments.
   - The hand-off moment, when a sentence becomes a task in place.

   Nothing else gets novelty.
10. **Native is native.**
    - System Liquid Glass on the navigation layer only; tint only the primary action; no glass on glass.
    - SF Pro for controls.
    - Raycast's conventions on the Mac: no pointer cursor, no hover washes, native popovers, no flicker.
    - The web never fakes Liquid Glass.
11. **Real content only.** Every rendered frame uses real transcripts, real crew names, real files and real failure states. Lorem ipsum is how slop hides.
12. **Judged against today's frame.** Each screen is better than the current Juno at the same frame (D-016) *and* holds up next to the named reference in §2.

### 6.2 Motion character for Juno

- **Voice.** Precise, quick and physical: an instrument, not a mascot.
- **Durations.** 120–200 ms for high-frequency changes; 220–320 ms springs for spatial moves; nothing over 400 ms except the voice surface.
- **What gets motion:** arrival (a task card forming from the sentence that spawned it), attention (a crew face turning toward you once when it needs you) and settling (a token snapping into the sentence). Idle states are still.
- **Spatial continuity.** Popovers grow from their trigger; the sent message lifts from the composer; an approval resolves in place.
- **No animation** on keyboard-initiated actions (⌘K opening, arrow navigation). Every transition is interruptible. Every animation has a reduced-motion variant.

### 6.3 Micro-interaction floor

Drawn from Vercel's guidelines, Emil Kowalski, Rauno Freiberg, Raycast and Apple:

| Moment | Standard |
|---|---|
| Press | Immediate visual response on pointer-down (not on click), about 100 ms, subtle scale or tone change; no bounce. |
| Hover | Web: a tone change only, no motion. Mac native: none on most controls (Raycast). |
| Focus | Always-visible ring in the ink colour, unobscured, offset from the control. |
| Loading | Show a pending state only after 150–300 ms; once shown, keep it at least 300–500 ms (no flicker). Labels end in `…`. |
| Send | Optimistic: the message appears at once; the composer clears without animation; on failure the message stays, with Retry and the text restored. |
| Tokens | `@` palette opens instantly (keyboard-initiated). The selected token settles into the line in one short step and deletes as one unit with one Backspace. Its popover grows from the token. |
| Streaming | No per-token fades. The cursor or caret stays steady; the single state line updates in place. |
| Approvals | The card resolves in place to its outcome ("Posted to #design, 14:02"). Undo is where the action was. |
| Numbers | Tabular figures in counts, times, diffs and usage. |
| Targets | At least 24 px on desktop and 44 px on touch. On phone, inputs are 16 px or larger. |
| Transitions | Animate `transform` and `opacity` only; never `transition: all`. |
| Copy | Curly quotes, non-breaking spaces before units, sentence case, no exclamation marks. |

---

## 7. Critique of the three round-2 premises

### 7.1 Porcelain: evolved calm off-white, ink and a single presence colour

**What is right.**
- It matches the 2026 consensus almost exactly: monochrome chrome, content forward, removal over addition. ChatGPT, Linear 2026 and Granola's product all work this way.
- It keeps the equity the owner values ("better than today's Juno at the same frame").
- It suits long reading, and it sits naturally beside system Liquid Glass.

**What will sink it if unaddressed.**
1. **The ground cannot be the identity.** A calm off-white has three places to land, and none is ownable:
   - Warm lands on Claude: ivory #faf9f5 is OKLCH 0.982 / 0.005 / 95°, and today's Juno ground #faf9f6 is 0.982 / 0.004 / 91°.
   - Cool lands on Tailwind **slate-50** #f8fafc (0.984 / 0.003 / 248°). A "porcelain" white at h 250–268° with C ≈ 0.003 computes to #f7f9fc–#f9fafc, which is indistinguishable, and cool-grey plus blue is exactly the round-1 diagnosis (D-016).
   - Neutral lands on zinc-50 #fafafa, the shadcn and Vercel ground.

   Porcelain must say explicitly that its identity comes from the ink, the type, the colour behaviour and the signatures, not the paper.
2. **"Calm" is now the category's entry fee.** Linear calls its refresh "a calmer interface", Granola's brief is "calm, but with energy underneath", and Claude is calm. Calm without a signature is anonymous.
3. **"Evolve today" drags Claude DNA along** unless the break is explicit. The Newsreader serif greeting and warm clay primary (`src/app/globals.css:70,82`; `src/app/layout.tsx:19`) must go, and the warm-neutral test gate `testBrandNeutralsAreWarmInBothAppearances` must be retired deliberately (`naming-identity.md` line 318). Evolve the IA, composer and density. Replace the colour and type.
4. **"Single presence colour" needs a definition.**
   - If it is a new hue beside the ultramarine primary and the amber, the screen has three chromatic voices and breaks the "accent in at most two places" brief.
   - It should *be* the primary, governed by "colour means alive" (§6.1-1). That turns a palette into a behaviour, which is the ownable part.

**Make it premium.**
- Make the content plane the whitest thing on screen (near #fff) and the chrome one tone lower and dimmer (Linear).
- Use ink, not black: about L 0.20 with a trace of the primary hue.
- Use the primary only where something is alive, with amber words for needs-you.
- Put all of the direction's novelty into the three signatures.

### 7.2 Canvas: white, dot-grid home, brand-mark tokens, floating contextual panels

**What is right.**
- **Brand-mark tokens are the best idea in round 2.** They implement the refoundation's composer spec (§5) literally. They follow the strongest premium pattern of the period: colour from the entity (Raycast rows, Dia's tab colour, Linear's label colour).
- They also give Juno a signature attached to a function, which Porcelain lacks. Whichever direction wins should inherit them.

**What will sink it.**
1. **A dot-grid home borrows an affordance it does not deliver.**
   - A dot grid means "you can place things here": Figma, FigJam, tldraw, Miro and every node editor.
   - Juno's home is a chat with a composer (§4.1). Nothing is placed on the grid, so it becomes texture that promises a spatial product.
   - It is also one of the most common dev-tool and AI marketing surfaces of 2024–26. Veila lists Anthropic, Perplexity, Linear, Vercel, Supabase, Raycast and Stripe, and notes the trend "flattening".
   - A grid behind reading text costs contrast.
   - Reserve a grid for surfaces that are genuinely canvases: a Design item in the Library.
2. **Floating contextual panels repeat Figma UI3's mistake.** Figma reverted to fixed panels in 2024-10 because floating panels cramped the work and let content peek out behind them. On Apple platforms, panels floating over glass chrome are glass on glass. *Contextual* is right (the inspector appears only when useful, as in `PRODUCT_REFOUNDATION.md` §11). *Floating* is right only for transient layers: popovers, the `@` palette, the phone composer.
3. **Pure white plus near-black ink (#ffffff / #121212 in the lab CSS)** is a correct neutral but has no character. With the grid removed, Canvas needs Porcelain's plane logic or it becomes shadcn with good tokens.

**Make it premium.** Keep the tokens and the contextual inspector (docked). Drop the dot grid. Take "one elevated object" seriously: the composer floats, nothing else does.

### 7.3 Instrument: dark-first pro tool with one luminous accent

**What is right.**
- It is the correct register for **Juno Code**. Cursor, Linear, Raycast and Claude Code all live dark, and long coding sessions favour it.
- "Instrument" is the right *character* for crew faces and state: precise, legible and lit only when working.
- The one-accent discipline is correct.

**What will sink it as the brand premise.**
1. **Dark with one glowing accent is the most imitated SaaS aesthetic of 2023–26.** LogRocket's "Linear design" critique: "almost every SaaS website looks the same". "Luminous" invites glow, bloom and border beams, which are slop tells ("glassmorphism with a neon glow"; glowing borders now ship as packages).
2. **The accent problem is measurable.**
   - *If the accent is the §12 ultramarine:* on a #161618 ground it needs L ≈ 0.61 or more to reach 4.5:1 (computed: L 0.56 gives 3.7:1, L 0.60 gives 4.4:1, L 0.64 gives 5.1–5.3:1). At L 0.56–0.60 it sits about 6–7° of hue from Linear's #5E6AD2 (0.567 / 0.159 / 275°) and Discord's #5865F2 (0.577 / 0.209 / 274°). Lifted to L 0.64–0.68 it drifts toward Google blue #4285F4 (0.63 / 0.18 / 260°) and Apple systemBlue dark #0A84FF (0.624 / 0.206 / 256°). **The ownable ultramarine is least ownable in dark mode.** The dark appearance must drop chroma to about 0.13 and use the colour sparingly, not "luminously".
   - *As built in the lab today:* the signal is a luminous chartreuse, #D4ED5C, OKLCH 0.90 / 0.17 / 118°, in `src/app/dev/design/instrument/tokens.ts`. This (a) contradicts the fixed ultramarine primary in §12, (b) lands on the "electric blue and neon green" cliché Gesso names, and (c) cannot carry text on light grounds at all, so light mode depends on ink keys.
3. **Dark-first is the wrong default for Chat and Crew.** These are for a broad audience reading prose and documents for hours, often on iPhone in daylight. Dark also does not differentiate: ChatGPT's dark is a pure neutral (#212121 is 0.248 / 0 chroma).

**Make it premium.**
- Instrument becomes Juno's **dark appearance** and the **Code workspace's register**: graphite planes, hairlines only where interactive, and state lit on the face and the one live line.
- "Luminous" is expressed as *light emitted by state*, never as glow effects or a neon hue.

### 7.4 Round-2 type choices (lab work in progress, 2026-09-30)

- **Porcelain** has chosen **Wix Madefor Display and Text**: Wix's corporate typeface, by Dalton Maag, 2020.
- **Instrument** has chosen **TikTok Sans**: TikTok's corporate typeface, by Grilli Type in 2023, open-sourced with Type Network. Billions of people see it daily.

Both are OFL and cover the right scripts. By the same argument `naming-identity.md` §2.4(f) uses against Google Sans ("Gemini's voice"), both make Juno speak in another company's voice. TikTok Sans is the most recognisable of any face considered in this phase. Recommend replacing both with a face that is nobody's house brand. The Plex, Geologica and Commissioner candidates in `naming-identity.md` §2.4(e) qualify, or any face from the Canvas lab list that is not Inter or Madefor.

---

## 8. Recommendation

1. **Build on Porcelain.** It is the only premise that matches how the most admired 2026 products actually work, and it starts from today's IA and composer equity.
2. **Graft Canvas's brand-mark tokens** into it as the first signature. Take Canvas's contextual inspector as well, *docked*.
3. **Use Instrument as the dark appearance and the Code workspace.** Use the desaturated ultramarine, not chartreuse, and no glow.
4. **Adopt the §6.1 contract as the round-2 acceptance gate.** "Colour means alive", one voice at two weights, content brightest, structure felt, one elevated object, three functional signatures, native fidelity and real content. Also adopt §6.3 as the micro-interaction floor that the critic panel checks frame by frame.
5. **Resolve before the critic panel:**
   - neutrals specified in OKLCH with the undertone explicitly argued (not ivory, not slate-50);
   - the definition of the presence colour;
   - a typeface that is no company's house face.

---

## 9. Reference board (for the owner)

Mobbin could not be queried (paid plan required), so there are no Mobbin citations and no downloaded files. These first-party images and pages were examined on 2026-09-30 and can be pulled into a board:

| Reference | What to look at | URL |
|---|---|---|
| Linear sidebar before/after (2026-03-12) | Dimmed chrome, muted inactive rows, smaller icons | https://webassets.linear.app/images/ornj730p/production/b6d6be14c96978b10553cfb9205be1065087e793-3904x2720.png |
| Linear softer structure | Segmented control replacing pills; softer borders | https://webassets.linear.app/images/ornj730p/production/67561baa677fbc429d94edd080e95aecabb6bae2-3904x2720.png |
| Linear header system (not viewed) | Location bar and view bar | https://webassets.linear.app/images/ornj730p/production/b15d343ed41c5e938c26f9e2f5a61c7b63285caa-3904x2160.png |
| Linear theme editor (not viewed) | Token tuning | https://webassets.linear.app/images/ornj730p/production/dc2fb694f3a1a1b6fe85acc17260705a8d674be6-3924x2936.png |
| Raycast 2 root search | Colour only from item icons; keycap action bar | https://www.raycast.com/uploads/blog-new-raycast/app.png |
| Raycast 2 AI | Monochrome AI chat; `@` agent palette | https://www.raycast.com/uploads/blog-new-raycast/ai.png |
| Granola product plate | Empty calm page; brand colour only on live audio | https://www.granola.ai/blogImages/brand-announcement/Granola-Final-Identity-15124.png |
| Cursor home | State-grouped agent list, state sentences, diff numbers | https://cursor.com/ |
| ChatGPT logged-out home | Four-object composer, regular-weight one-line greeting, zero accent | https://chatgpt.com/ |
| Comet landing | Orbital line art (avoid), condensed serif display | https://www.perplexity.ai/comet |

---

## 10. Sources

**First-party**
1. Linear, "A calmer interface for a product in motion", 2026-03-12. https://linear.app/now/behind-the-latest-design-refresh (changelog: https://linear.app/changelog/2026-03-12-ui-refresh)
2. Linear, "A Linear spin on Liquid Glass", 2025-10-21. https://linear.app/now/linear-liquid-glass
3. Linear, "How we redesigned the Linear UI (part II)", 2024-03-28. https://linear.app/now/how-we-redesigned-the-linear-ui
4. Raycast, "The New Raycast", 2026-05-14. https://www.raycast.com/blog/the-new-raycast
5. Raycast, "A Technical Deep Dive Into the New Raycast", 2026-05-14. https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast
6. Raycast Manual, "New in v2", undated. https://manual.raycast.com/new-in-v2
7. The Browser Company, "The strategy behind Dia's design", Charlie Deets, 2025-06-17. https://browsercompany.substack.com/p/the-strategy-behind-dias-design
8. Apple, WWDC25 "Meet Liquid Glass" (219), 2025-06. https://developer.apple.com/videos/play/wwdc2025/219/
9. Apple, WWDC25 "Get to know the new design system" (356), 2025-06. https://developer.apple.com/videos/play/wwdc2025/356/
10. Claude blog, "Redesigning Claude Code on desktop for parallel agents", 2026-04-14. https://claude.com/blog/claude-code-desktop-redesign
11. Granola, "Meet the new look Granola", 2026-02-02 (year inferred from press dated 2026-02-10). https://www.granola.ai/blog/a-new-look-for-granola
12. Figma, "Digital Tools, Human Expression: The Visual Identity Behind Config 2026", 2026-06. https://www.figma.com/blog/the-visual-identity-behind-config-2026/
13. Figma, UI3 fixed panels (Threads post; forum "Fixed panels are back"), 2024-10. https://www.threads.com/@figma/post/DAlnAW0vciU and https://forum.figma.com/suggest-a-feature-11/launched-fixed-panels-are-back-23789
14. Vercel, Web Interface Guidelines, undated. https://vercel.com/design/guidelines
15. Cursor forum, "Cursor 3: New Cursor Interface", 2026-04-02. https://forum.cursor.com/t/cursor-3-new-cursor-interface/156506
16. TikTok, "TikTok Sans: Now a Free and Open-Source Font". https://developers.tiktok.com/blog/tiktok-sans-open-source ; Wix Madefor (Dalton Maag). https://www.daltonmaag.com/portfolio/custom-fonts/wix-madefor.html
17. Observed pages, 2026-09-30: https://chatgpt.com/ , https://cursor.com/ , https://www.perplexity.ai/comet

**Practitioners**

18. Rauno Freiberg, "Invisible Details of Interaction Design", 2023. https://rauno.me/craft/interaction-design
19. Emil Kowalski, "Great animations", undated. https://emilkowal.ski/ui/great-animations
20. Matthew Ström-Awn, "UI Density", undated in fetch. https://mattstromawn.com/writing/ui-density/

**Press and analysis**

21. Wallpaper*, OpenAI rebrand, 2025-02-04. https://www.wallpaper.com/tech/openai-has-undergone-its-first-ever-rebrand-giving-fresh-life-to-chatgpt-interactions
22. 9to5Mac, "OpenAI president admits new ChatGPT desktop app is 'kind of a mess'", 2026-07-29. https://9to5mac.com/2026/07/29/openai-president-admits-new-chatgpt-desktop-app-is-kind-of-a-mess-teases-tab-free-design/
23. TechCrunch, "Anthropic merges Claude chat and Cowork in one interface", Ivan Mehta, 2026-09-16. https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/
24. Fonts In Use, "Comet", 2025-10-23. https://fontsinuse.com/uses/72596/comet
25. The Brand Identity, "How Kimera built Cursor's identity around a custom typeface system", 2025-11-03. https://the-brandidentity.com/project/how-kimera-built-cursors-identity-around-a-custom-typeface-system
26. MacRumors, "Things 3.22 Introduces Refreshed Interface", 2025-09-16. https://www.macrumors.com/2025/09/16/things-3-22-refreshed-interface-and-more/
27. The Branding Journal, Superhuman rebrand interview, 2025-12-22. https://www.thebrandingjournal.com/2025/12/inside-the-decision-to-rebrand-grammarly-as-superhuman-exclusive-interview/
28. Verified Insider, "Design at Superhuman", 2026-01-29. https://verifiedinsider.substack.com/p/design-at-superhuman
29. Gesso, "Granola's Rebrand Doesn't Make it Look Like an AI Company", Gurjinder Singh, 2026-02-10. https://gesso.substack.com/p/granolas-rebrand-doesnt-make-it-look
30. NN/g, "The Proliferation and Problem of the ✨ Sparkles ✨ Icon", Kate Kaplan, 2024-09-20. https://www.nngroup.com/articles/ai-sparkles-icon-problem/
31. LogRocket, "Linear design", Daniel Schwarz, 2025-06-07. https://blog.logrocket.com/ux-design/linear-design/
32. smoothui, "AI Design Slop", 2026-06-24. https://smoothui.dev/blog/ai-design-slop
33. 925studios, "AI Slop Fonts and Gradients" (date shown by fetch as 2026-09-30; UNVERIFIED). https://www.925studios.co/blog/ai-slop-design-tells
34. Veila, "The grid is back", Grigorii Lapin, April 27 (year UNVERIFIED). https://www.veila.me/blog/the-grid-is-back-ai-tech-design-trend
35. Studio Siraj on Anthropic's Geist identity (press, undated). https://studiosiraj.com/blog/anthropic-brand-identity-case-study
36. Notion release notes 2026-03-26 (detail via search summary; UNVERIFIED). https://www.notion.com/releases/2026-03-26

**Aggregators (token values; all UNVERIFIED)**

37. shadcn.io, Perplexity design tokens. https://www.shadcn.io/design/perplexity
38. oh-my-design.kr, Superhuman / Cursor / Vercel token pages. https://oh-my-design.kr/design-systems/superhuman
39. withfudge, cursor.com design. https://design.withfudge.com/share/cursor.com-design

**Juno internal:** `docs/rework/PRODUCT_REFOUNDATION.md` §4–§7, §12; `docs/rework/DECISIONS.md` D-016, D-017; `docs/rework/research/naming-identity.md` §1, §2.3–§2.4; `docs/rework/research/openai.md` §2.6; `docs/rework/research/anthropic.md` §1; `src/app/globals.css:60-82,260`; `src/app/layout.tsx:13-41`; `src/app/dev/design/{porcelain,canvas,instrument}/` (untracked, read 2026-09-30).

**Colour computations** were done with a local OKLab script over the hex values cited. Contrast figures are WCAG 2 relative-luminance ratios against #161618.
