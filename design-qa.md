# Juno macOS redesign design QA

## Evidence

- Source visual truth: `/private/tmp/juno-native-redesign-audit/01-code-home-before.png`, supported by the user-provided Code, composer, sidebar, artifact, and inspector screenshots from 2026-08-15.
- Implementation screenshots: `/private/tmp/juno-native-redesign-audit/07-code-home-xctest.png` and `/private/tmp/juno-native-redesign-audit/09-code-subagents-rail-2.png`.
- Combined full-view comparison: `/private/tmp/juno-native-redesign-audit/code-home-before-after.png`.
- Combined focused comparison: `/private/tmp/juno-native-redesign-audit/code-home-focused-before-after.png`.
- State: dark appearance; Code home with a local repository selected; active Code session with the Sub-agents inspector visible.
- Viewport and density: the source capture is 1352 x 768 px. The implementation home capture is 2704 x 1824 px at native Retina density (1352 x 912 points). For the like-for-like comparison, its top 2704 x 1536 px region was downsampled to 1352 x 768 px. CSS size and `deviceScaleFactor` are not applicable to this native SwiftUI app.

## Findings

No actionable P0, P1, or P2 visual differences remain against the requested direction.

- Fonts and typography: native system typography has a clear title/body/metadata hierarchy, readable optical weights, stable wrapping, and consistent truncation across the sidebar, home actions, transcript, and inspector.
- Spacing and layout rhythm: search now sits below the brand and traffic-light region; the Code-only toolbar no longer carries the Chat/Work control; the home actions use a balanced two-column layout; the composer is bounded and aligned; and the inspector is a stable 320-point rail rather than an overlapping detached surface.
- Colors and visual tokens: surfaces use the native canvas, separator, semantic status, and Liquid Glass treatments without accent-colored focus borders. Contrast remains legible in the inspected dark appearance.
- Image and asset fidelity: visible branding and controls use the app's existing source assets and native SF Symbols. No placeholder imagery, hand-drawn SVG, emoji, or CSS-style art was introduced.
- Copy and content: prompts, action descriptions, permission copy, project metadata, and inspector empty-state language are concise and product-specific.
- Icons and controls: the toolbar, sidebar actions, permission selector, model and thinking controls, voice action, and inspector selector are optically aligned and use consistent native iconography.
- Interaction and accessibility: the selected signed UI tests confirm direct Code launch, composer availability, toolbar controls, and hide/restore behavior for the Sub-agents inspector. Native semantic controls and practical target sizes are retained.

## Focused comparison

The focused comparison covers the areas whose details were too small in the full view: titlebar/search placement and the first-turn composer. It confirms that search no longer sits behind the traffic lights, the Code toolbar is product-specific, and the composer is a single coherent native surface with repository context and controls grouped by task.

## Comparison history

### Iteration 1

- Earlier P1 findings: search overlapped the traffic-light zone; Chat/Work appeared without a coherent glass container and incorrectly appeared in Code; the Code composer read as a large generic slab; the attachment controls had conflicting custom chrome; and opening the Sub-agents inspector could break AppKit window constraints.
- Fixes: moved search into sidebar content, removed Chat/Work from the Code toolbar, rebuilt the home and discussion composers around native glass, regrouped attachment/model/thinking controls, and replaced the unstable inserted AppKit inspector with a deterministic SwiftUI trailing rail.
- Post-fix evidence: `/private/tmp/juno-native-redesign-audit/07-code-home-xctest.png` and `/private/tmp/juno-native-redesign-audit/09-code-subagents-rail-2.png`.

### Iteration 2

- Rechecked the full screen and the focused header/composer regions at normalized density.
- No P0, P1, or P2 findings remained. No additional visual fix was required.

## Primary interactions verified

- Direct launch into the Code home.
- First-turn composer and its voice/model/permission controls.
- Active Code session toolbar.
- Sub-agents inspector visible, hidden, and restored without a crash or broken layout.
- Direct project selection, project expansion, rename, unpin/delete menus, artifact source editing, component selection, and export paths are covered by implementation review and targeted unit/package tests.

## Residual test gaps

- The supplied visual references do not define alternate-width or light-appearance targets precisely enough for pixel-fidelity comparison. Those states remain covered by native adaptive layout and build/test validation rather than a source-matched screenshot pass.

## Final result

final result: passed
