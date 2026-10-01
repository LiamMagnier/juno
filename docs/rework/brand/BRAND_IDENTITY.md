# Alevr identity and design system

Working concept · 2026-10-01 · based on Juno Refoundation V3.

## Meaning and pronunciation

**Alevr**, pronounced **AL-ver**, two syllables, with stress on the first. The spelling is compact and distinctive but needs pronunciation support on first introduction. Do not present it as effortless to pronounce or universally understood. Keep title case; avoid AleVR, which suggests virtual reality.

The name is coined, **inspired by aleph and mathematical infinite cardinalities**. It is not a dictionary translation, an astronomical object or a claim that the assistant knows everything. The promise is expanding understanding and turning it into useful work. The cosmic reference is scale, trajectory and relationships; mathematics supplies precision and construction.

Positioning: a calm intelligence you can talk to, with persistent agents that carry work forward. Audience: people who research, write, design, operate and build. Character: capable, lucid, curious and measured. Signature line: **Go further.** Functional description: **Conversation. Agents. Code.** Neither line is a capability guarantee.

## Identity concept: Continuum — selected direction

The owner selected Continuum with "I really like Continuum", after rejecting
the initial A-shaped Open Fold. Continuum is the logo concept name; the product
is still Alevr. Relay and Parallax remain unselected alternatives. The rejected
artwork is preserved under archive/open-fold and must not be implemented.

The symbol's broad curved folded paths surround an open central aperture.
Connected trajectories suggest a conversation becoming sustained work, while
open counterspace suggests understanding that can continue to expand. This is
symbolic design intent, not a universal interpretation or a mathematical claim.
The master is not an initial A, literal infinity glyph, star or planet.

Use assets/alevr-continuum-symbol.png as the current raster shape reference.
Preserve the selected orientation, asymmetric silhouette, open channels and
pointed path ends across Chat, Orbit, Code, the launcher icon and thinking mark.
Production should reconstruct/refine this as reviewed editable segmented vector
geometry; do not trace tonal noise or silently substitute a generic swirl.

- Uniform graphite on light, pale neutral on dark; a small presence-tone handoff is permitted only for truthful active thinking/work feedback.
- Clear space: at least one broad path width around the mark. Wordmark gap: approximately 1.5 path widths, optically adjusted.
- Proposed minimum: symbol 16 px, wordmark 72 px wide. Optical masters must preserve visible channels and be checked at 16/20/24 before production.
- Wordmark: upright Newsreader 600 as starting face, optical kerning; do not rename it Continuum or italicize the brand.
- App-icon composition: shared master on an unmasked opaque charcoal square, pale neutral symbol occupying approximately 64% width with generous mask-safe margins. Platform-catalog exports remain future artwork.
- Thinking: preserve the exact stationary silhouette and pass tonal emphasis through existing segments beside truthful phase words. Read [the motion and thinking specification](MOTION_AND_THINKING.md).
- No arbitrary rotation, closed counterspace, internal glow, extra stars or copied provider marks. Constant decorative logo/orbit loops remain disallowed.
- Orbit's secondary glyph stays two separated open elliptical arcs. Code's secondary glyph stays opposed brackets/cursor. Neither replaces the shared application identity.

The selected raster may contain slight generated tonal variation. Final vectors
and optical exports must use the exact uniform fills in the specification.
Selection of the visual direction does not clear Alevr's name or finalize all
production assets.

## V3 foundation: exact values

Inherited from src/app/dev/design/juno/tokens.css, checked 2026-10-01. Implementation must map semantic roles to existing production/native contracts rather than introduce a parallel palette.

| Role | Light | Dark | Use |
|---|---|---|---|
| Ground | #fcfcfd | #18191b | Main content panel |
| Frame / sidebar | #f3f4f5 | #111213 | Desktop chrome |
| Surface | #ffffff | #222326 | Content surfaces |
| Raised | #ffffff | #27282b | Elevated surface |
| Card | #f5f6f7 | #1f2023 | Quiet grouped content |
| Well | #eff0f1 | #2d2e31 | Recessed controls |
| User bubble | #eff0f1 | #252629 | User turns |
| Inline bubble token | #ffffff | #37383c | Context inside user turns |
| Primary ink | #191b1e | #e8e9eb | Content and active labels |
| Secondary ink | #4e5054 | #b4b6ba | Supporting text |
| Tertiary ink | #686b70 | #95979c | Lowest permitted text tier |
| Decorative ink | #9a9ca0 | #6c6e72 | Non-text ornament only |
| Interactive edge | #86898d | #707276 | Fields and switches |
| Presence | #2d49c9 | #97a6e6 | Live work, voice, composer focus |
| Attention | #8f5406 | #d6a865 | Words requiring the person's response |
| Danger / removal | #b3261e | #f0928a | Errors and destructive operations |
| Addition | #1b7a3a | #74c68a | Diff/data additions |

Neutrals dominate. At most two live presence accents on one screen; use tonal selection for navigation. Agent body colors and third-party marks identify entities and do not recolor the whole shell. Attention is text, never a pill, badge or ambient dot. Contrast must be checked against each actual rendered surface, including translucency; the board is not contrast evidence.

## Typography

| Purpose | Family | Specification |
|---|---|---|
| Wordmark and display | Newsreader | Upright 400–600; optical sizing; no italic-name greeting |
| Cyrillic display fallback | Literata | Preserve locale coverage and layout |
| Interface and body | Inter | 400, 500, 600; baseline 14/20 px |
| Code and technical values | JetBrains Mono | 400–600; tabular alignment where useful |

Proposed identity specimens: display 48/52, title 32/38, section 20/26, body 14/20, metadata 12/16. These are brand-document specimens, not a blanket replacement of V3 component-specific typography. Keep system/script fallbacks where required. Orbit agent names use the same serif display treatment; role, state, permissions and receipts use UI text.

## Space, material and components

- Desktop uses the V3 frame with an inset content panel: 8 px top/right/bottom gutter and 14 px panel radius. Sidebar sits on the frame. Phone content is full bleed.
- Inherit radii: keycap 5, inline token 7, row 8, card 12, popover 14, composer 22 px. Capsule controls remain capsules where already specified; state remains words.
- Use a 4 px spacing unit and 8/12/16/24/32/48 px composition steps. Preserve V3's actual local spacing when it is more specific.
- Composer is centered on home; a crisp edge and surface define it, with no drop shadow. Context tokens are editable objects in the sentence, not a toolbar of decorative badges.
- Menus, popovers, sheets, toasts, sticky headers and dock backdrops may use D-033 restrained translucent blur. Main content surfaces stay opaque. Solid fallbacks apply with reduced transparency.
- Popover material: white at 70% light, rgb(40 41 44) at 72% dark. Sheet: white 82%, rgb(36 37 40) 84%. Bar: rgb(252 252 253) 80%, rgb(24 25 27) 78%.
- Popover blur is 18 px light / 20 px dark; bar 20/22 px. Respect source saturation and fallback contracts; do not infer an all-glass UI.
- Dark theme is layered charcoal with lifted/desaturated blue and pale graphite text. Never recolor every element by inversion.

## Mathematical and cosmic visual world

Use a small grammar: an open curve, an ellipse, a measured construction grid and a restrained horizon. These express continuation, relationships and scale. Keep the geometry accurate when it represents data. Editorial diagrams may be abstract but must not pretend to be measurements.

On identity boards, onboarding covers and owned marketing: quiet orbital diagrams, generous empty space, occasional charcoal fields and blue trajectories. In operational UI: geometry lives in the logo, Orbit glyph and purposeful diagrams only. No starfield wallpaper, space-themed terminology for ordinary controls, glowing HUD, particle loading field or constant rotating orbit.

The mathematical theme is a design rationale, not a claim to mathematical correctness in generated decorative art. The logo's meaning and the user workflow must remain understandable without knowing set theory.

## Orbit: agents that carry work forward

**Alevr Orbit** is the agent workspace. Navigation may read Orbit; the first-use descriptor reads Your agents. People create an agent, give it a name, discuss its role and review the permissions and standing work. The agent has a persistent thread and contextual side panel. Orbit is not an extra mode required to turn a conversation into work.

Keep the user at the center of control: who is doing what, what needs an answer, and what was finished. Use agent names in events: Mira needs your answer; Scout is researching; Otto finished the summary. State is said in words. Activity belongs to the relevant thread, not a decorative mission dashboard.

Character direction inherits D-034: original flocked designer toys with short velvet texture, crisp saturated silhouettes, matte graphic eyes, one soft body mass and bold removable accessories. No mouth, blush, glossy animal eyes or long shaggy fur. Do not copy OpenAI dots shapes or exact color/accessory combinations. New concept images explore this family; existing shipped characters remain until a final character is approved.

Customization preserves independent shape, color, graphic-eye style and accessory choices. Cosmos may influence form names in the editor's descriptions, never force astronaut costumes or make an agent's job depend on its appearance. Example roles: Research, Operations, Writing, Engineering; these are descriptive roles, not additional subbrands.

States: Ready, Working, Thinking, Needs your answer, Blocked, Finished. Body/eye pose supports state but does not replace the readable label. Permission labels remain Allowed, Ask first, Blocked. Waiting does not authorize continuing.

Use cached sprites for sidebar/composer faces at 28 px and below. One shared renderer; live large preview renders on demand, stops when hidden. Any subtle large-character idle is disabled under Reduce Motion. The image boards do not imply that a new model or rig has been delivered.

## Motion and interaction

| Token | Duration | Purpose |
|---|---|---|
| Press | 70 ms | Immediate physical feedback |
| Fast | 120 ms | Tonal/short state change |
| Exit | 160 ms | Dismissal |
| Base | 220 ms | Normal transition |
| Slow | 360 ms | Larger spatial change |
| Emphasis | 560 ms | Rare deliberate emphasis |

V3 curves: out (.33,1,.68,1), strong (.32,.72,0,1), expo (.16,1,.3,1), in (.4,0,1,1), inout (.65,0,.35,1). Reuse existing contracts and state machines.

Solo icon-button press may scale to .9 over 70 ms. Labelled rows change tone without moving the glyph. Hover motion is opt-in for low-frequency navigation, fine pointers only; composer actions, menus, lists and keyboard focus remain stable. Copy becomes check, Send becomes Stop, Mic becomes a waveform reflecting actual audio. Decorative logo/orbit loops never indicate progress. The owner explicitly requested purposeful Continuum thinking feedback; the stationary tonal path handoff in MOTION_AND_THINKING.md is permitted beside truthful real-activity words.

Reduce Motion uses stable poses and brief fades without travel, scale or loops. Keyboard response is immediate; inherited delayed-loader and approval-arming timing must not be altered for brand animation. No character motion implies consent or success.

## App icon, favicon and exports

One master Alevr symbol across web and native. Proposed launcher icon: graphite tile with pale mark, softened platform geometry; optional subtle surface relief on macOS only. Alternate light tile for approved contexts. App-icon silhouettes must agree with the flat master; no separate cosmic illustration.

Favicon: simplified monochrome Open Fold, no wordmark, carefully hinted at 16/32 px. Apple touch / web manifest artwork uses the full icon with platform safe zones. Orbit remains a feature glyph, not a second app icon.

Final editable assets required later: symbol and lockups in SVG/PDF; monochrome/light/dark/presence variants; optical 16/20/24 px icon masters; favicon ICO with 16/32/48; Apple touch 180; web manifest 192/512 and separate maskable 512; iOS marketing 1024 opaque square with no pre-rounded corners; complete macOS asset-catalog sizes generated from a reviewed master. Honor target platform rules and actual existing catalog scales. Do not ship the generated concept PNG as a production vector or a finished platform catalog.

## Voice and copy

Clear verbs and concrete outcomes. Talk to the person as a capable collaborator. Prefer Create agent, Review changes, Ask first, Continue, Stop, Try again. Avoid cosmic role-play such as launch mission, summon intelligence or deploy constellation. State limitations and uncertainty directly. Use Alevr Orbit in explanatory product copy and Orbit in established navigation; use the agent's own name during work.

Accessibility names describe actions, not logo metaphors. The application name is Alevr; decorative logo SVGs inside a labelled link are hidden from accessibility. Agent pictures have useful identity text only when the nearby name does not already provide it. No essential information depends on color, texture or animation.

## Review boundary

This is an implementable proposed specification and generated visual direction. Availability is unresolved, artwork requires review and the app has not been renamed. Actual cross-platform workflow validation belongs to the later implementation. The stopped development/release record remains unchanged.
