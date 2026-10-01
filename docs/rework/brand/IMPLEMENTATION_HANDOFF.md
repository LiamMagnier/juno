# Alevr — handoff for later Claude implementation

2026-10-01. Design and documentation only. The owner explicitly requested that implementation happen later. This brief is not authorization to resume the stopped code/release work, deploy, push, change source assets or wake another implementation chat.

## Read before implementing

**Current artwork decision:** Continuum is the owner-selected Alevr master-logo direction. The rejected A-shaped Open Fold is archived and must not be implemented. Use the current Continuum symbol and updated three-system boards, then make reviewed segmented vector/optical/platform exports. Read [MOTION_AND_THINKING.md](MOTION_AND_THINKING.md) for the owner's explicit branded-thinking and feature-motion requirement. Raster concepts are references, not finished vector/animation masters.

Use BRAND_IDENTITY.md for identity foundations and NAMES_AND_ICONS.md for user-facing names. Use DECISIONS D-027–D-034 for V3 inheritance; D-035 records this proposed direction. Read NAMING_SCREEN.md before treating Alevr as final. HANDOFF.md and PROGRESS.md remain the truthful coding/release status.

Preserve the conversation-first operational architecture: persistent named agent threads and panels, understandable approvals and receipts, clear service permissions and readable state. Character artwork is customizable expression, not a substitute for work controls. Do not build a disconnected agent wizard or decorative constellation dashboard.

## Located source surfaces

This is a source-surface inventory from read-only inspection, not a completed enumeration of every localized string or call site.

| Surface | Existing source / asset location | Later work |
|---|---|---|
| V3 foundations | src/app/dev/design/juno/tokens.css and design-v3/foundations artifacts | Preserve exact palette, framed shell, type and geometry |
| Site/application identity | src/app/layout.tsx; src/app/manifest.ts | Titles, owned metadata, manifest name/short name and icons |
| Web icon assets | src/app/favicon.ico; src/app/icon.png; src/app/apple-icon.png; public/brand/app-icon-mac.png | Reviewed new brand exports; assess browser caches |
| Web interface family | src/components/ui/juno-icons/drawings.ts, index.tsx, icons.css; src/lib/app-icons.ts | Shared semantic registry and optical masters; preserve export compatibility |
| Agent entry points | src/app/(app)/agents/page.tsx; agents/[id]/page.tsx; agents/new/page.tsx | Orbit destination copy and conversation-first routing |
| Agent UI | src/components/agents/agents-home.tsx; agent-hire.tsx; agent-panel.tsx; agent-thread-header.tsx | Names, states, setup actions and profile surfaces |
| Character system | src/components/agents/agent-face.tsx; face-rig.ts; agent-face-studio.tsx; public/crew/manifest.json | Only implement reviewed final characters; preserve current artwork until then |
| macOS identity | native/macOS/JunoDesktop/Resources/Info.plist and Assets.xcassets/AppIcon.appiconset | Display name and complete native icon catalog; signing/bundle identity stays stable |
| iOS identity | native/iOS/JunoMobile/Resources/Info.plist and Assets.xcassets/AppIcon.appiconset | Display name, marketing icon, platform catalog; no pre-rounded source icon |
| Widgets | native/iOS/JunoMobile/Widgets/Info.plist | Visible brand references and widget metadata |
| Native localization | native/iOS/JunoMobile/Resources/Localizable.xcstrings | Human-visible names and translator comments; preserve stable compatibility where needed |
| Web localization | src/lib/i18n.ts; src/lib/i18n-server.ts; src/lib/i18n-catalog.generated.ts (generator output); src/components/i18n/auto-translate.tsx; src/app/api/i18n/translations/route.ts; scripts/generate-i18n-catalog.mjs | Trace actual source catalog and on-demand translation cache; avoid stale translated brand strings |
| Electron surface | native/desktop-electron/src/renderer/products and components/icons.tsx | Include only if this surface remains maintained; document exceptions |
| Code package | native/Packages/JunoCode and native/Scripts/write-build-metadata.sh | Human-facing Alevr Code prose only; existing package/protocol identity stays stable |
| Localizations / release surfaces | Locate from actual i18n config and release pipelines before editing | Every supported locale, owned emails/help, installers/download strings, notifications and accessibility |

No top-level messages directory was found. Web locale code describes on-demand machine translation; trace its actual catalog/cache generation instead of inventing static locale paths. The iOS string catalog is located above. Inventory the current production shell/sidebar/owned marketing surfaces before changing them; the dev gallery is a reference, not proof of coverage.

## Concrete future deliverables

1. Resolve name availability and final production-artwork review; preserve the already-selected Continuum direction.
2. Create editable segmented Continuum vector geometry, optical favicon masters, wordmark and Orbit glyph; retain reproducible geometry and license/provenance notes for fonts.
3. Export symbol-light/dark/mono.svg, wordmark-light/dark.svg, lockup-light/dark.svg and orbit-16/20/24.svg from the same reviewed family. Names describe deliverables, not files already produced.
4. Produce favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, maskable-512.png, iOS-1024.png and the existing native catalogs' required scale/size entries. The generated concept mark is a raster reference, not a drop-in source.
5. Apply the naming map to owned display text, full localization catalogs, accessible names, metadata, installer/download references, native display surfaces and actual tool-facing presentation. Preserve third-party names and stable technical identifiers.
6. Project shared icon geometry to native. Keep the approved current character art until the final new art/rig is ready and accepted. Record every intentionally retained historical/internal Juno or crew string.
7. Validate authenticated web and installed native workflows in both themes, desktop/phone/tablet, keyboard, reduced motion and reduced transparency. Inspect 16 px tabs and installed icons; validate agent creation, permission review, working/waiting/finished states, receipts and Code controls.

No source replacement should be inferred merely from a generated board. Generated UI text/spacing is illustrative; the written V3 contract and actual state machines govern. Never change approval timing, semantics or security rules to match a visual.

## Acceptance evidence

Record settled real-route screenshots, installed-icon screenshots, localized name sweep with explicit internal/historical exceptions, vector/raster export inventory and cross-platform glyph comparison. Separate passing checks from open work. Do not claim cross-platform parity or a cleared name based on these concept images.
