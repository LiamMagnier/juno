# Juno design QA

## Comparison target

- Source visual truth: `/tmp/juno-redesign-audit-20260812/chat.png`.
- Rendered implementation: `/tmp/juno-qa-chat-loaded-1280x720-20260812.jpg`.
- Combined full-view and focused comparison input: `/tmp/juno-chat-design-qa-comparison-20260812.png` (source on the left, implementation on the right).
- Viewport: 1280 x 720 CSS pixels, device scale factor 1.
- Source pixels: 1280 x 720. Implementation pixels: 1280 x 720. No density normalization was required.
- State: authenticated Owner account, dark theme, empty Chat home, expanded desktop sidebar, Chat selected, composer idle. The time-aware greeting differs only because it is dynamic content.
- The original Projects capture was not used as a matched-state fidelity target because it predates the current `Untitled project` fixture. It was used only as audit evidence for the sidebar and empty-state treatment.

## Full-view comparison evidence

The source and implementation were placed together in one image at identical viewport dimensions. The implementation preserves Juno's information architecture, sidebar proportions, centered greeting/composer composition, serif display voice, sans UI hierarchy, coral action color, icon family, and Chat/Work control. The deliberate changes are flatter surfaces, a darker neutral canvas, tighter radii, shallower elevation, no decorative dot field, no composer glow, and a denser selected-state treatment. Those changes remove the generic glass-and-glow treatment while retaining the product's recognizable structure and signature type/accent pairing.

## Focused comparison evidence

The second row of `/tmp/juno-chat-design-qa-comparison-20260812.png` contains matching 840 x 360 crops of the greeting and composer. Composer width, field padding, control order, coral voice action, model label, effort label, and icon alignment remain consistent. The implementation's border is clearer at rest, the shadow is materially shallower, and the greeting/composer relationship remains balanced. A separate active-navigation check is captured at `/tmp/juno-projects-expanded-sidebar-20260812.jpg`; the former orange left rail is absent.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the display serif is reserved for Juno's greeting while product headings, dialogs, settings, and utility labels use the sans/mono hierarchy. Weights, wrapping, truncation, and line height are readable at 1280 x 720 and 390 x 844.
- Spacing and layout rhythm: page gutters, sidebar width, section dividers, composer alignment, card radii, modal padding, and responsive stacking form a consistent rhythm. No tested page has horizontal overflow or obscured persistent controls.
- Colors and visual tokens: the near-black canvas, warm neutral surfaces, coral primary action, semantic success/error states, muted borders, and neutral focus outline are coherent. Accent color is no longer used as a decorative focus rail.
- Image quality and asset fidelity: no source product imagery was replaced. Existing Juno marks and the project's icon library remain in use; no emoji, placeholder illustration, custom SVG approximation, or CSS-drawn asset was introduced.
- Copy and content: page headings and empty states are concise. Owner-plan copy is consistent in the account menu. Deep Research names progress, cost, evidence, and sources; Voice Mode names provider, connection state, recovery action, and unavailable reason.
- Icons and controls: visible controls use one stroke icon family with consistent sizing. Menus, dialogs, segmented controls, switches, and primary/secondary buttons have distinct roles without decorative motion.
- Behavior and accessibility: focus remains visible but neutral, dialogs and menus expose semantic roles and labels, reduced-motion rules remain, mobile tap targets are practical, and unavailable/error states are announced.
- P3 follow-up only: the model label intentionally truncates at 390 px so effort and voice controls stay reachable. Its accessible name remains complete.

## Comparison history

1. The source audit found P2 over-containerization: large dashed empty boxes, glossy cards, glow, blur, and excessive elevation competed with content. Shared cards, empty states, composer surfaces, menus, dialogs, and shadows were flattened and tightened. Post-fix evidence: `/tmp/juno-chat-design-qa-comparison-20260812.png`.
2. A responsive pass found a P2 Settings layout issue at the narrow desktop content width: the usage panel entered a two-column split too early. The split breakpoint moved from `md` to `lg` and the stacked state gained a clear divider. Post-fix evidence: `/tmp/juno-settings-latest-20260812.jpg` and `/tmp/juno-mobile-settings-20260812.jpg`.
3. Navigation QA found the P2 orange active rail shown in the supplied Projects screenshot and an over-branded focus outline. The active rail was removed, selected navigation now uses a neutral fill, and the global focus outline was changed to neutral foreground while remaining visible. Post-fix evidence: `/tmp/juno-projects-expanded-sidebar-20260812.jpg` and `/tmp/juno-mobile-menu-focus-final-20260812.jpg`.
4. The final matched-state comparison found no remaining P0, P1, or P2 visual differences.

## Primary interactions tested

- Sidebar expansion, desktop navigation, mobile drawer, and selected states.
- New-project dialog open/close without creating or deleting data.
- Owner account menu and General Settings modal.
- Deep Research completed run, progress stages, cost, and source list.
- Voice Mode start, connecting state, unavailable alert, retry affordance, and end flow. A clean-server verification made one token request and stopped on the non-retryable unavailable state.
- Desktop at 1440 x 900 and matched comparison at 1280 x 720.
- Mobile Chat, drawer, Projects, and Settings at 390 x 844.
- Final browser warning/error log: empty.

## Verification

- `npm run build`: passed; all 110 static pages generated and the production route manifest completed.
- Targeted ESLint across the refined shell, primitives, chat, research, voice, settings, profile, projects, artifacts, connections, compare, upgrade, and auth surfaces: passed with zero warnings or errors.
- Full-repository `npm run lint` remains blocked by four pre-existing untracked helper scripts that use CommonJS imports; they were outside this UI scope and were not modified.
- The development preview is running at `http://localhost:3000` with the authenticated Owner fixture.

## Implementation checklist

- [x] Preserve Juno's existing information architecture and signature visual language.
- [x] Refine shared tokens, typography, surfaces, controls, navigation, menus, dialogs, and motion.
- [x] Apply the system across authenticated product pages and auth chrome.
- [x] Verify Deep Research, Voice Mode, settings, and project interactions.
- [x] Verify desktop and mobile breakpoints.
- [x] Pass a production build and targeted lint.
- [x] Complete matched-state visual comparison and browser-log check.

final result: passed
