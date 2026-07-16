# 04 — Native design system and shared token contract

**Status:** Phase 0 design decision record
**Audit date:** 2026-07-16
**Scope:** Juno web, the legacy SwiftUI app, and the greenfield Mac shell

This document distinguishes repository evidence (**Observed**) from rebuild decisions (**Proposed**). The rendered website and its source are the identity reference. Native controls should feel at home on Apple platforms, but the product must still read as Juno rather than as the unrelated graphite redesign or generic system chrome.

## Source map

The paths below are the exact audited sources. Web paths are relative to this repository. Native paths are relative to the sibling `juno-app-rebuild` repository at `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild`.

| Area | Exact source |
|---|---|
| Web semantic colors, themes, accents, focus, reduced motion, elevation | `src/app/globals.css:5-225` |
| Web typography and font loading | `src/app/layout.tsx:1-16,43-66`; `tailwind.config.ts:126-145` |
| Web radii, spacing, motion, animations | `tailwind.config.ts:93-125,146-335` |
| Runtime custom accent behavior | `src/components/app/app-provider.tsx:134-165` |
| Web button, card, input, dialog patterns | `src/components/ui/button.tsx:6-33`; `src/components/ui/card.tsx:5-21,44-56`; `src/components/ui/input.tsx:4-19`; `src/components/ui/dialog.tsx:13-52` |
| Web shell and route motion | `src/components/app/app-shell.tsx:67-125`; `src/components/app/page-transition.tsx:6-31` |
| Web signature motion | `src/components/signature/dot-field.tsx:6-146`; `src/components/signature/thinking-dots.tsx`; `src/components/signature/dot-matrix.tsx` |
| Existing web/native design notes; reference only | `design.md:1-223` |
| Legacy Swift colors, geometry, motion, type, material | `Juno/DesignSystem/Theme.swift:40-330` |
| Legacy Swift interaction components | `Juno/DesignSystem/Components.swift:5-29,31-62,154-260` |
| Legacy Swift signature layer | `Juno/DesignSystem/Signature.swift:3-149,151-275` |
| Greenfield Mac token copy | `apps/desktop/JunoDesktop/DesignTokens.swift:3-76` |

## Observed identity and drift

### Observed — web contract

The live source expresses a warm editorial identity, not a graphite-first one:

- Light canvas is warm paper (`--background: 48 33% 97%`); dark canvas is warm charcoal (`40 6% 10%`). Text, cards, popovers, secondary fills, borders, sidebar colors, destructive, success, warning, source, and focus ring are semantic CSS variables in `src/app/globals.css:14-148`.
- Coral is the default accent. Teal, violet, amber, and sage have explicit light/dark values and matching foreground colors in `src/app/globals.css:150-165`.
- A user-provided hex accent is also accepted at runtime. The web derives an HSL value and foreground, then overrides `--primary`, `--ring`, and `--primary-foreground` in `src/components/app/app-provider.tsx:134-165`.
- Theme is class-driven; `next-themes` owns `.dark`, while the initial theme and accent arrive before the app renders through `src/app/layout.tsx:52-66`.
- Motion has three shared curves and 120/220/360 ms durations in `src/app/globals.css:63-70` and `tailwind.config.ts:116-125`. Global reduced-motion behavior collapses animation and transition duration in `src/app/globals.css:198-205`.
- Focus is a high-contrast, accent-derived two-pixel ring in `src/app/globals.css:207-211`.
- The signature vocabulary is the dot matrix, thinking constellation, dotted field/divider, restrained editorial labels, and a quiet film-grain layer. `src/components/signature/dot-field.tsx:27-35,88-143` explicitly pauses work and honors reduced motion.
- Reading content is intentionally flat. Depth utilities are used for controls and chrome; the transcript and prose rules remain calm and opaque (`src/app/globals.css:228-374`; `design.md:207-223`).

### Observed — duplicate native contracts

There are two independent Swift token sources, and neither matches the web exactly:

| Facet | Legacy native | Greenfield Mac shell | Consequence |
|---|---|---|---|
| Canvas | Graphite-dark ladder (`Juno/DesignSystem/Theme.swift:40-80`) | Separate RGB warm neutrals (`apps/desktop/JunoDesktop/DesignTokens.swift:6-22`) | Three products can render three different themes. |
| Accent | Five native accents with values different from web (`Theme.swift:131-171`) | Terracotta only (`DesignTokens.swift:24-28`) | A synced accent changes appearance by client; custom web accents have no native representation. |
| Radius | 7/10/12/14/16/22 (`Theme.swift:100-109`) | 6/10/16 (`DesignTokens.swift:38-42`) | Component geometry drifts; neither maps the web's 24/28 large radii. |
| Motion | 100/180/300 ms (`Theme.swift:111-122`) | No motion contract | The same state change has different rhythm on each client. |
| Typography | System serif for display, SF system UI, system mono (`Theme.swift:173-208`) | Ad hoc view fonts | It is a reasonable native mapping but is not documented or generated from one type-role contract. |
| Material | Direct `.glassEffect` helpers (`Theme.swift:268-277`; `Components.swift:154-178`) | Opaque hairline cards (`DesignTokens.swift:56-76`) | Availability, Reduce Transparency, and fallback behavior are inconsistent. |

The legacy signature views are the closest cross-platform match: their comments name the corresponding web sources, reproduce the dot timings, pause off-screen, and expose VoiceOver labels (`Juno/DesignSystem/Signature.swift:3-8,39-149`). They are reuse candidates after snapshot, performance, and accessibility tests; they are not a token source.

## Proposed — canonical token architecture

### One machine-readable source

Create `design/tokens.juno.json` in the web/backend repository and make it the only hand-edited semantic design-data source. Use a DTCG-style shape with a small documented extension for theme and accent axes. Store colors as numeric HSL plus alpha so generation preserves the website values without parsing CSS strings.

```json
{
  "$schema": "./tokens.schema.json",
  "version": 1,
  "color": {
    "background": {
      "light": { "space": "hsl", "components": [48, 0.33, 0.97], "alpha": 1 },
      "dark":  { "space": "hsl", "components": [40, 0.06, 0.10], "alpha": 1 }
    }
  },
  "accent": {
    "coral": {
      "light": { "space": "hsl", "components": [15, 0.54, 0.51], "alpha": 1 },
      "dark":  { "space": "hsl", "components": [15, 0.54, 0.51], "alpha": 1 },
      "onLight": "#ffffff",
      "onDark": "#ffffff"
    }
  },
  "motion": {
    "duration": { "fastMs": 120, "baseMs": 220, "slowMs": 360 },
    "curve": { "outSoft": [0.33, 1, 0.68, 1] }
  }
}
```

The portable contract contains:

- Semantic colors for light/dark, five named accents, and validated custom-accent input.
- Foreground pairs, focus, selection, status colors, diff colors, and Computer Use/approval risk colors.
- Spacing, radii, minimum control sizes, dividers, dot atoms, and type roles.
- Motion durations, curves, and semantic transitions; Reduce Motion resolves each transition to `identity` or a crossfade.
- Portable elevation intent (`flat`, `inset`, `raised`, `floating`) rather than a CSS shadow copied into Swift.
- Component-state roles (`rest`, `hover`, `pressed`, `selected`, `focused`, `disabled`, `danger`) without platform-specific rendering instructions.
- A `tokenVersion` included in web bootstrap and native diagnostics so screenshots and bug reports identify the active contract.

Platform rendering belongs in thin adapters:

- Web-only shadow recipes and backdrop filters remain a generated CSS/platform overlay.
- Swift maps portable elevation intent to opaque fills, standard materials, shadow styles, or Liquid Glass according to OS and accessibility settings.
- Arbitrary custom accents are normalized by one shared algorithm and stored as a canonical color plus verified `onAccent`; clients must not independently guess foreground contrast.

### Generated outputs

One deterministic generator produces:

| Output | Consumer |
|---|---|
| `src/app/generated/juno-tokens.css` | CSS custom properties for light/dark/accent selectors |
| `src/lib/generated/juno-tokens.ts` | Typed token names, accent enum, runtime custom-accent validator |
| `Juno/DesignSystem/Generated/JunoTokens.generated.swift` | Swift color, metric, type-role, and motion values |
| `Juno/Resources/JunoColors.xcassets/**` | Appearance-aware asset colors where system asset lookup is preferable |
| `design/tokens.snapshot.json` | Stable review artifact for semantic diffs and migration checks |

Generated files carry a do-not-edit header. CI must fail when generation produces a diff, when a semantic foreground/background pair misses the agreed contrast threshold, when a token is orphaned, or when a component introduces an unapproved raw color, duration, or radius. Website and native repositories pin the same token package/version; neither silently tracks `main`.

## Proposed — material and Liquid Glass rules

Apple describes Liquid Glass as a functional layer for controls and navigation and advises against using it in content. It recommends the regular variant for legibility, reserves clear glass for rich media, and notes that Reduce Transparency and Increase Contrast can change the material's appearance. See [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [SwiftUI `glassEffect`](https://developer.apple.com/documentation/swiftui/view/glasseffect%28_%3Ain%3A%29), and [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views).

Juno's native rules are therefore:

1. Prefer system `Toolbar`, navigation, sidebar, popover, menu, inspector, sheet, and button styles so platform material behavior arrives automatically.
2. Use regular Liquid Glass only for functional chrome: mode/navigation controls, the floating composer frame, command palette, approval/permission prompts, and temporary controls above content.
3. Keep transcript rows, editors, terminals, tables, file trees, diffs, test logs, Git views, and long-form content opaque. Standard materials may separate content layers; no glass-on-glass nesting.
4. Use clear glass only over intentionally rich media and only with an evaluated dimming layer. It is not a default Juno surface.
5. Tint indicates prominence or selection, not decoration. Coral remains Juno's primary accent; destructive/success/warning semantics remain distinct and never depend on hue alone.
6. On supported OS versions, group related custom effects in the smallest useful `GlassEffectContainer`. Limit the simultaneous effect count and profile animation/rendering hitches; Apple explicitly warns that excess containers/effects can degrade performance.
7. On older supported macOS versions, fall back to a standard material or an opaque semantic surface without changing layout. A material API must always be availability-gated.
8. With Reduce Transparency, replace glass with an opaque `popover`/`card` fill and strong separator. With Increase Contrast, strengthen the separator and focus indicator. With Reduce Motion, disable glass morphs and use an immediate state change or short opacity crossfade.

The existing unguarded calls in `Juno/DesignSystem/Theme.swift:268-277` and `Juno/DesignSystem/Components.swift:140-143,170-172` must be replaced by one accessibility- and availability-aware `JunoChromeMaterial` abstraction.

## Proposed — typography and font licensing

Observed web typography is Newsreader for the full interface and JetBrains Mono for code/metadata (`src/app/layout.tsx:2-16`; `tailwind.config.ts:126-145`). Native currently maps display moments to the system serif, working text to SF system type, and code/metrics to the system monospaced design (`Juno/DesignSystem/Theme.swift:173-194`).

The native mapping is intentional:

| Semantic role | Web | Native default | License/distribution rule |
|---|---|---|---|
| Editorial display and human moments | Newsreader variable serif | System serif design, with Newsreader optional | Bundle Newsreader only after its exact font files, license text, modification/subsetting rights, attribution, and update process are recorded in `THIRD_PARTY_NOTICES`. `next/font` use is not proof of native redistribution clearance. |
| Controls, navigation, dense workbench | Newsreader today | System UI (SF family through semantic SwiftUI styles) | Use system APIs; never bundle or refer to private font files. This is a documented platform adaptation, not identity drift. |
| Reading/prose | Newsreader | Approved Newsreader bundle if available; otherwise system serif | Preserve editorial rhythm and optical sizing, but prioritize Dynamic Type and legibility. |
| Code, terminal, diff, tokens | JetBrains Mono | System monospaced/SF Mono through SwiftUI | Bundle JetBrains Mono only with an approved license inventory; otherwise use the system monospaced design. |
| Eyebrow/metadata | JetBrains Mono, uppercase, tracked | System monospaced, uppercase, tracked | Generate size/line-height/tracking intent; let native metrics adapt. |

Never address SF Pro, New York, or SF Mono by private file/name. Use semantic `Font` APIs. All text roles must support localization expansion, right-to-left layout, selectable text where expected, and native text scaling. The Code editor/terminal may expose a separate user-selectable monospaced size.

## Proposed — component patterns

Retain Juno interaction language while rebuilding each primitive natively:

| Pattern | Observed web evidence | Native contract |
|---|---|---|
| Primary/secondary/destructive/ghost actions | `src/components/ui/button.tsx:6-33` | One primary action per surface; role-aware keyboard shortcut, hover, pressed, focus, disabled, progress, and VoiceOver state. No copied external-product wording or icons. |
| Flat/raised/interactive cards | `src/components/ui/card.tsx:5-21` | Semantic surface intent; dense content stays flat, clickable cards gain hover/focus without becoming glass. |
| Recessed fields | `src/components/ui/input.tsx:4-19` | Native `TextField`/`SecureField` first; explicit validation/help/error relationship and visible keyboard focus. |
| Modal and floating layer | `src/components/ui/dialog.tsx:13-52` | Native sheet/popover/window when semantics match; glass only on its functional chrome, not the scrolling body. |
| Sidebar and adaptive drawer | `src/components/app/app-shell.tsx:67-125` | Mac sidebar/inspector and iOS split/drawer are separate compositions backed by shared routes and tokens. |
| Route transition | `src/components/app/page-transition.tsx:6-31` | Preserve state and streaming; use opacity/selection transitions that do not remount active content. |
| Thinking and signature dots | `src/components/signature/**`; native `Juno/DesignSystem/Signature.swift` | Reuse Juno-owned geometry/behavior after snapshot, off-screen pause, Reduce Motion, energy, and VoiceOver QA. |
| Permission/approval | Mission requirement | Juno risk semantics, precise command/path/destination, once/always/deny choices, keyboard default safety, and an always-visible stop action. Never imitate another product's card copy or visual trade dress. |

## Proposed — Mac and iOS split

Tokens, product nouns, accessibility semantics, and state machines are shared. Window composition and local capabilities are not.

| Mac | iPhone/iPad |
|---|---|
| Resizable multi-pane Code workbench; keyboard-first commands; hover, context menus, inspectors, menu-bar commands, multiple windows, security-scoped workspace access, local PTY/process execution, Git/worktrees, preview, and explicit Computer Use. | Chat/projects/settings parity, adaptive `NavigationStack`/`NavigationSplitView`, safe-area-aware composer, 44 pt touch targets, native sheets, share/import flows, and remote Code observation/approval. No claim of local shell/filesystem hosting unless a separately reviewed iOS capability exists. |
| Pointer controls may be visually compact while their focus and context-menu affordances remain discoverable. | Touch controls meet minimum hit targets and avoid hover-only disclosure. |
| System serif can be limited to greetings, prose, and editorial headings; dense workbench UI uses system UI type. | Editorial display can be more prominent, but Dynamic Type and content-size changes determine layout. |
| Window toolbar/sidebar material follows Mac conventions. | Navigation bars, tab bars, and sheets follow iOS/iPadOS conventions. |

Do not scatter `#if os(...)` through tokens. Platform-specific layouts and capabilities live at the feature-composition boundary.

## Accessibility acceptance contract

Every component and every screenshot fixture is evaluated for:

- Light/dark, all named accents, one low-luminance custom accent, and one high-luminance custom accent.
- Reduce Transparency, Increase Contrast, Reduce Motion, Differentiate Without Color, keyboard-only use, Full Keyboard Access, VoiceOver, and text-size changes.
- A visible focus indicator with at least the semantic focus token; no hover-only action and no status conveyed only by red/green.
- Correct accessibility role, label, value, selected/expanded/busy state, ordered traversal, and live announcement for agent/test/command completion without reading every streamed token.
- Opaque emergency-stop and approval actions that stay legible over any underlying content.
- Minimum iOS touch targets and usable Mac pointer targets; destructive actions require clear wording and safe default focus.

## Visual QA and governance

1. Create reference fixtures for shell, empty chat, streaming chat, long transcript, project, settings, command palette, permission prompt, three-pane Code workbench, editor/diff/terminal, and Computer Use state.
2. Capture web and native references for light/dark and each accessibility mode. Compare semantic hierarchy, color, type role, spacing rhythm, and brand atoms—not pixel identity across platforms.
3. Add token unit tests for generated CSS/TS/Swift equivalence and contrast. Compare generated sRGB values within a documented tolerance and fail on unreviewed drift.
4. Add Swift snapshot tests at representative Mac window sizes and iPhone/iPad sizes, including long localization strings and largest supported text sizes.
5. Run VoiceOver and keyboard scripts, Accessibility Inspector audits, and manual focus-order review for every interactive fixture.
6. Profile scrolling transcripts, animated dots, resizable workbench panes, and glass-heavy chrome with Instruments. Record animation hitches, energy, memory, and fallback screenshots.
7. Require a semantic token diff and visual before/after for token changes. Product Design owns meaning; Native and Web Design Systems own generators/adapters; Accessibility and QA approve release fixtures.

## Definition of done

- `design/tokens.juno.json` is canonical, versioned, schema-validated, and documented.
- CSS/TypeScript/Swift/asset outputs are generated and CI proves there is no drift.
- No production component introduces raw brand colors, arbitrary timing, or ad hoc radii outside an explicit platform exception.
- Web and native render the same semantic themes and synced accents.
- Native glass is functional, sparse, availability-gated, accessible, and never used as the reading/content layer.
- Typography has a recorded legal mapping and third-party notices where fonts are bundled.
- Visual, accessibility, localization, performance, and energy baselines pass before feature parity is signed off.
