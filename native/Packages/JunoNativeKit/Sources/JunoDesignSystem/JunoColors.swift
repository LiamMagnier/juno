import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Juno's colour tokens: the web's custom properties from `src/app/globals.css`,
/// read from the generated projection (`Generated/JunoGeneratedTokens.swift`)
/// rather than transcribed. Light mode is the warm paper and dark mode the warm
/// charcoal — on both, red is the highest channel and blue the lowest. That
/// warmth is the brand; a neutral or blue-leaning grey reads as a generic
/// SwiftUI app.
///
/// **The names are the redesign's (§8.1 of `MACOS_LIQUID_GLASS_REDESIGN.md`).**
/// Each accessor names the CSS variable it resolves, so a change on the web has
/// one obvious landing site here, and `JunoColorConsumptionTests` fails if an
/// accessor stops resolving to its generated counterpart.
/// `JunoTokenConsumptionTests` holds the ledger of *every* accessor: a new one
/// fails until it resolves to a generated pair there or is registered as
/// native-only with its reason, and a new hand-typed triple anywhere in the
/// product sources fails the same way. The older names
/// (`junoSurface`, `junoMutedForeground`, `junoSidebarForeground`,
/// `junoFocusRing`, `junoSidebarSelection`, …) still compile and resolve to the
/// same values; they are aliases, not a second palette, and each says which
/// redesign name replaces it. They are not marked `@available(deprecated)` yet
/// because together they carry about a thousand call sites across Chat, Code
/// and the phone, and the shared packages build with warnings as errors — the
/// rename lands with each surface's own rework instead.
///
/// Anything not listed here defers to the system semantic colours so the apps
/// track platform conventions automatically.
public extension JunoColorToken {
    /// `--primary` in each appearance: V3's ultramarine, #2D49C9, lifted to
    /// #97A6E6 on the charcoal. The account's accent is
    /// ``SwiftUI/Color/junoAccent``.
    static let accentLight = JunoColorToken.coral
    static let accentDark = JunoGeneratedColors.primary.dark

    /// `--background`: #FAF9F6 / #1F1D1C — the warm paper and the warm
    /// charcoal. The window's `containerBackground` and the reading plane.
    ///
    /// **iOS keeps the 4% ground it shipped with, for now.** The Mac takes the
    /// web's 11.5% charcoal, which is what the redesign asks for and what the
    /// card (14%) and popover (16.5%) steps are tuned against. The phone's
    /// screens were composed on the near-black `warmBlack` this replaced, and
    /// lifting their ground by seven points of lightness is a visible redesign
    /// of every iOS screen rather than a token fix — so it waits for the iOS
    /// pass, and is the one place the two apps' grounds differ. Light mode is
    /// the generated value on both: the old `warmWhite` sat one 8-bit step from
    /// it.
    ///
    /// **iPhone and iPad (round-2 redesign, Oct 2026):** the system's own
    /// grounds — pure white and pure black, `systemBackground` — and neutral
    /// greys one and two steps up for the card and the user bubble, the
    /// values ChatGPT and Apple's own apps sit on. The warm near-blacks read
    /// as muddy next to the system's glass, sheets and keyboard. The Mac keeps
    /// the generated web values.
    #if os(iOS)
    static let canvasLight = JunoColorToken(unchecked: 1, 1, 1)
    static let canvasDark = JunoColorToken(unchecked: 0, 0, 0)
    #else
    static let canvasLight = JunoGeneratedColors.background.light
    static let canvasDark = JunoGeneratedColors.background.dark
    #endif

    /// `--card`: #FEFDFC / #252422. One step above the canvas: run cards, code,
    /// tables, the sources pill, attachment cards. On iOS: #F7F7F8 / #1C1C1E,
    /// the system's secondary grouped steps.
    #if os(iOS)
    static let surfaceLight = JunoColorToken(unchecked: 0.969, 0.969, 0.973)
    static let surfaceDark = JunoColorToken(unchecked: 0.110, 0.110, 0.118)
    #else
    static let surfaceLight = JunoGeneratedColors.card.light
    static let surfaceDark = JunoGeneratedColors.card.dark
    #endif

    /// `--popover`: one step above the card. **Not painted on the Mac**, where
    /// popovers, menus and sheets are system glass; kept for the phone.
    static let popoverLight = JunoGeneratedColors.popover.light
    static let popoverDark = JunoGeneratedColors.popover.dark

    /// `--muted`. The same values as `--secondary` today; kept because the
    /// phone reads it by this name.
    #if os(iOS)
    static let mutedLight = JunoColorToken(unchecked: 0.953, 0.953, 0.957)
    static let mutedDark = JunoColorToken(unchecked: 0.173, 0.173, 0.180)
    #else
    static let mutedLight = JunoGeneratedColors.muted.light
    static let mutedDark = JunoGeneratedColors.muted.dark
    #endif

    /// `--secondary`: #F2F0EB / #302E2C. The user bubble, wells, inline code,
    /// pressed chips, keycaps.
    /// On iOS: #F3F3F4 / #2C2C2E — ChatGPT's bubble greys, without the warm cast.
    #if os(iOS)
    static let secondaryLight = JunoColorToken(unchecked: 0.953, 0.953, 0.957)
    static let secondaryDark = JunoColorToken(unchecked: 0.173, 0.173, 0.180)
    #else
    static let secondaryLight = JunoGeneratedColors.secondary.light
    static let secondaryDark = JunoGeneratedColors.secondary.dark
    #endif

    /// `--accent` — the web's *neutral* hover, not the brand colour (the web
    /// names its action colour `--primary`): #EEECE5 / #383633. The hover fill
    /// on opaque content.
    static let hoverLight = JunoGeneratedColors.accent.light
    static let hoverDark = JunoGeneratedColors.accent.dark

    /// `--selected`: #EBE8E0 / #403D3A. The ground under a control that is
    /// *on* — a rated thumb — so the state reads in a fill as well as in ink.
    /// Not the sidebar's selection (``selectedFillLight``), which is its own
    /// token on the web too.
    static let selectedLight = JunoGeneratedColors.selected.light
    static let selectedDark = JunoGeneratedColors.selected.dark

    /// `--border`: #E1DFD8 / #3C3937, opaque. Hairlines on content, drawn at
    /// ``JunoHairline/opacity(increaseContrast:)``.
    ///
    /// **iOS keeps its translucent black/white hairline for now**, for the same
    /// reason as ``canvasDark``: on the phone's near-black ground an opaque 23%
    /// border is a visibly heavier rule than the one its screens were drawn
    /// with.
    #if os(iOS)
    static let borderLight = JunoColorToken(unchecked: 0, 0, 0, 0.12)
    static let borderDark = JunoColorToken(unchecked: 1, 1, 1, 0.14)
    #else
    static let borderLight = JunoGeneratedColors.border.light
    static let borderDark = JunoGeneratedColors.border.dark
    #endif

    /// `--input`: #CECAC0 / #484541. Field hairlines on content.
    static let inputLight = JunoGeneratedColors.input.light
    static let inputDark = JunoGeneratedColors.input.dark

    /// `--foreground`: #1D1D1B / #F4F3F1. Primary ink; see
    /// ``SwiftUI/Color/junoForeground``.
    static let foregroundLight = JunoGeneratedColors.foreground.light
    static let foregroundDark = JunoGeneratedColors.foreground.dark

    /// `--muted-foreground`: #6A6862 / #AEAAA3. Secondary text, glyphs at rest,
    /// placeholders.
    static let mutedForegroundLight = JunoGeneratedColors.mutedForeground.light
    static let mutedForegroundDark = JunoGeneratedColors.mutedForeground.dark

    /// `--muted-foreground` at 70%: the web's `text-muted-foreground/70`, its
    /// most common quieter-than-secondary ink.
    ///
    /// **2.89:1 on the light canvas** (pinned in `JunoInkContrastTests`), so it
    /// fails AA for text and is allowed only on non-essential text of 13pt and
    /// up — metadata a reader can do without. Keycaps and timers are read, so
    /// they use the secondary ink.
    static let tertiaryInkLight = JunoGeneratedColors.mutedForeground.light.withOpacity(0.7)
    static let tertiaryInkDark = JunoGeneratedColors.mutedForeground.dark.withOpacity(0.7)

    /// `--sidebar`: the web's recessed column (8.8% against an 11.5% canvas in
    /// dark). The Mac's sidebar is system glass and does not paint it; kept
    /// for a column tint, should the shell choose one (errata 3).
    static let sidebarLight = JunoGeneratedColors.sidebar.light
    static let sidebarDark = JunoGeneratedColors.sidebar.dark

    /// `--sidebar-foreground`: #504E49 / #B7B4AE. Sidebar glyphs and labels at
    /// rest.
    static let sidebarForegroundLight = JunoGeneratedColors.sidebarForeground.light
    static let sidebarForegroundDark = JunoGeneratedColors.sidebarForeground.dark

    /// `--hairline`: `48 12% 18% / 0.06` / `45 14% 94% / 0.08`. A warm
    /// translucent rule for dividers laid over something other than the canvas.
    static let hairlineLight = JunoGeneratedColors.hairline.light
    static let hairlineDark = JunoGeneratedColors.hairline.dark

    /// `--source`: the citation teal. Not a status: it marks sourced or
    /// supplementary material — a citation, a deep dive's rule, a tip.
    ///
    /// DECLARED DIVERGENCE, light only: one lightness step darker than the
    /// web's `--source`, because the web's value measures 4.38:1 on the light
    /// canvas and this token is read as text (a citation label, a tip's
    /// heading). Derived from the projection rather than written as a triple,
    /// so it stays one step darker than wherever the web moves `--source`; the
    /// dark value already clears the floor and is the generated one. If you are
    /// adding a second divergence to this file, the bar is a measured contrast
    /// failure.
    static let sourceLight = JunoGeneratedColors.source.light.adjustingLightness(by: -0.01)
    static let sourceDark = JunoGeneratedColors.source.dark

    // ── Status, as the web splits it: a fill and an ink ─────────────────────
    //
    // The fill is for a dot, a bar, a chip's ground; the ink is the AA text
    // ramp (`text-success` on the web resolves to `--success-ink`, not to the
    // fill). The older `junoSuccess`/`junoDanger`/`junoCaution` ramp in
    // `JunoStatus.swift` is hand-tuned text colour and stays as it is until its
    // call sites move onto these — which is why `--success` itself has no
    // token here yet: its redesign name, `junoSuccess`, is still that ramp's
    // (see the note in `JunoStatus.swift`).

    /// `--success-ink`: #347449 / #60AF7A.
    static let successInkLight = JunoGeneratedColors.successInk.light
    static let successInkDark = JunoGeneratedColors.successInk.dark
    /// `--warning`: #B48931 / #D4A954.
    static let warningLight = JunoGeneratedColors.warning.light
    static let warningDark = JunoGeneratedColors.warning.dark
    /// `--warning-foreground`, the warning ink: #846424 / #EAC886. "N left".
    static let warningInkLight = JunoGeneratedColors.warningForeground.light
    static let warningInkDark = JunoGeneratedColors.warningForeground.dark
    /// `--destructive`: #B9533C / #BF553E.
    static let destructiveLight = JunoGeneratedColors.destructive.light
    static let destructiveDark = JunoGeneratedColors.destructive.dark
    /// `--destructive-ink`: #A2442F / #C86B56. Delete, and error text.
    static let destructiveInkLight = JunoGeneratedColors.destructiveInk.light
    static let destructiveInkDark = JunoGeneratedColors.destructiveInk.dark

    /// `--code-string` / `--code-number`: syntax. Keywords are the accent ink.
    static let codeStringLight = JunoGeneratedColors.codeString.light
    static let codeStringDark = JunoGeneratedColors.codeString.dark
    static let codeNumberLight = JunoGeneratedColors.codeNumber.light
    static let codeNumberDark = JunoGeneratedColors.codeNumber.dark

    // ── Inside glass, and selection ─────────────────────────────────────────
    //
    // Derived from `--foreground` at an alpha, not opaque, because these are
    // laid on system glass: an opaque fill would stop the material sampling
    // what is behind it, which is the whole of what makes it glass.

    /// Hover inside glass: foreground at 6% / 8%.
    static let glassHoverLight = JunoGeneratedColors.foreground.light.withOpacity(0.06)
    static let glassHoverDark = JunoGeneratedColors.foreground.dark.withOpacity(0.08)
    /// A resting fill inside glass — the voice disc, armed marks, the plan
    /// pill, the search button: foreground at 8% / 12%.
    static let glassFillLight = JunoGeneratedColors.foreground.light.withOpacity(0.08)
    static let glassFillDark = JunoGeneratedColors.foreground.dark.withOpacity(0.12)

    /// `--sidebar-selected`: the selected sidebar row. **Opaque**, and that is
    /// the point: the platform paints its own selection in the *system* accent
    /// underneath a row background, and any alpha here lets that blue (or
    /// whatever the reader's accent is) show through.
    static let selectedFillLight = JunoGeneratedColors.sidebarSelected.light
    static let selectedFillDark = JunoGeneratedColors.sidebarSelected.dark
    /// The selected row's edge: foreground at 12% / 14%, rising to 24% under
    /// Increase Contrast. On the web the outline is what says "selected"; the
    /// fill is barely a step off the column.
    static let selectedEdgeLight = JunoGeneratedColors.foreground.light.withOpacity(0.12)
    static let selectedEdgeDark = JunoGeneratedColors.foreground.dark.withOpacity(0.14)
    static let selectedEdgeIncreasedLight = JunoGeneratedColors.foreground.light.withOpacity(0.24)
    static let selectedEdgeIncreasedDark = JunoGeneratedColors.foreground.dark.withOpacity(0.24)
}

// MARK: - Colours

public extension Color {
    // ── The accent, by account setting ──────────────────────────────────────
    //
    // Computed properties, not `static let`s, and that is the whole fix for
    // "changing the accent colour does nothing": a stored value was frozen at
    // coral at process start. Resolving through ``JunoAccentSelection`` means
    // every call site picks the change up, and because the selection is
    // `@Observable` the reads register as dependencies and the views redraw.
    //
    // `MainActor.assumeIsolated` is safe in practice and unavoidable in
    // principle: SwiftUI evaluates view bodies on the main actor, which is the
    // only place a colour is resolved, but `Color`'s accessors are not
    // annotated so the compiler cannot see that. The off-main fallback keeps a
    // unit test or a background snapshot on brand rather than trapping.

    /// `--primary`, by accent: the action colour. Spent only where §0.4 of the
    /// redesign allows — the send/stop/busy disc, toggle tracks, sliders and
    /// progress, at most one prominent button per surface, the live status
    /// dot. Never selection, the greeting name, toolbar glyphs, marks, chips
    /// or decoration. Apply it with ``SwiftUI/View/junoAccentTint()``.
    static var junoAccent: Color {
        guard Thread.isMainThread else { return JunoAccent.coral.color }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.color }
    }

    /// `--primary-ink`, by accent: links, accent text, code keywords. A
    /// separate ramp because the fill does not clear 4.5:1 as text in every
    /// accent — dark coral text on the charcoal needs a lighter coral.
    static var junoAccentInk: Color {
        guard Thread.isMainThread else { return JunoAccent.coral.ink }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.ink }
    }

    /// `--primary-foreground`, by accent: glyphs and text drawn *on* the
    /// accent. White on coral, a warm near-black on amber and on the lifted
    /// dark teal/violet/sage, where white fails contrast.
    static var junoOnAccent: Color {
        guard Thread.isMainThread else { return JunoAccent.coral.onAccent }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.onAccent }
    }

    /// The accent block's `--ring`: #5F5C54 / #D1CFC7, neutral in every accent,
    /// so changing the action colour never turns every focused field into a
    /// coloured outline. Equal to the Mac app's graphite `AccentColor` asset,
    /// which is what AppKit draws the system focus ring in.
    static var junoRing: Color {
        guard Thread.isMainThread else { return JunoAccent.coral.ring }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.current.ring }
    }

    // ── Grounds ─────────────────────────────────────────────────────────────

    /// `--background`: the window's ground and the reading plane.
    static let junoCanvas = Color.junoAdaptive(light: .canvasLight, dark: .canvasDark)

    /// `--card`: run cards, code, tables, the sources pill, attachment cards.
    static let junoCard = Color.junoAdaptive(light: .surfaceLight, dark: .surfaceDark)

    /// `--secondary`: the user bubble, wells, inline code, pressed chips,
    /// keycaps.
    static let junoSecondary = Color.junoAdaptive(light: .secondaryLight, dark: .secondaryDark)

    /// `--accent`, the web's neutral hover: the hover fill on opaque content.
    /// Inside glass use ``junoGlassHover``.
    static let junoHover = Color.junoAdaptive(light: .hoverLight, dark: .hoverDark)

    /// `--selected`: the ground under a toggled-on control — a rated thumb in
    /// the message actions. Never the accent, and never the sidebar's
    /// ``junoSelectedFill``.
    static let junoSelected = Color.junoAdaptive(light: .selectedLight, dark: .selectedDark)

    /// `--border`: hairlines on content. Draw it at
    /// ``JunoHairline/opacity(increaseContrast:)``.
    static let junoBorder = Color.junoAdaptive(light: .borderLight, dark: .borderDark)

    /// `--input`: a field's hairline on content.
    static let junoInput = Color.junoAdaptive(light: .inputLight, dark: .inputDark)

    // ── Ink ─────────────────────────────────────────────────────────────────

    /// Primary ink — the web's `--foreground`.
    ///
    /// **This is the default ink**, reached through ``SwiftUI/View/junoInk()``.
    /// The canvas's whole identity is that red is its highest channel, so a
    /// pure-neutral label on it is off-brand by construction. Use `.primary`
    /// only where the *system* owns the surface — inside a `Menu`, a toolbar,
    /// an alert — and its vibrancy is doing work an absolute colour cannot.
    static let junoForeground = Color.junoAdaptive(
        light: .foregroundLight, dark: .foregroundDark
    )

    /// `--muted-foreground`: secondary text, glyphs at rest, placeholders.
    /// Reached through ``SwiftUI/View/junoSecondaryInk()``.
    ///
    /// **Never multiply it by an opacity at the call site.** It is already near
    /// the AA floor (~5.2:1 light on the canvas); the one sanctioned quieter
    /// step is ``junoTertiaryInk``, with its own rules.
    static let junoSecondaryInk = Color.junoAdaptive(
        light: .mutedForegroundLight, dark: .mutedForegroundDark
    )

    /// `--muted-foreground` × 0.7: metadata a reader can do without. 2.89:1 on
    /// the light canvas — **only non-essential text of 13pt and up**. Keycaps,
    /// timers and anything that must be read take ``junoSecondaryInk``.
    static let junoTertiaryInk = Color.junoAdaptive(
        light: .tertiaryInkLight, dark: .tertiaryInkDark
    )

    /// `--sidebar-foreground`: sidebar glyphs and labels at rest. They lift to
    /// ``junoForeground`` when their row is selected.
    static let junoSidebarInk = Color.junoAdaptive(
        light: .sidebarForegroundLight, dark: .sidebarForegroundDark
    )

    // ── Status ──────────────────────────────────────────────────────────────

    /// `--success-ink`: success read as text.
    static let junoSuccessInk = Color.junoAdaptive(light: .successInkLight, dark: .successInkDark)
    /// `--warning`: a warning's dot, bar or chip ground.
    static let junoWarning = Color.junoAdaptive(light: .warningLight, dark: .warningDark)
    /// `--warning-foreground`: a warning read as text — "N left".
    static let junoWarningInk = Color.junoAdaptive(light: .warningInkLight, dark: .warningInkDark)
    /// `--destructive`: a destructive state's dot, bar or chip ground.
    static let junoDestructive = Color.junoAdaptive(
        light: .destructiveLight, dark: .destructiveDark
    )
    /// `--destructive-ink`: Delete, and error text.
    static let junoDestructiveInk = Color.junoAdaptive(
        light: .destructiveInkLight, dark: .destructiveInkDark
    )

    /// Sourced or supplementary material: a citation, a deep dive's rule, a tip.
    /// Never a status — see ``JunoColorToken/sourceLight``.
    static let junoSource = Color.junoAdaptive(light: .sourceLight, dark: .sourceDark)

    /// `--code-string`.
    static let junoCodeString = Color.junoAdaptive(light: .codeStringLight, dark: .codeStringDark)
    /// `--code-number`.
    static let junoCodeNumber = Color.junoAdaptive(light: .codeNumberLight, dark: .codeNumberDark)

    // ── Inside glass, and selection ─────────────────────────────────────────

    /// Hover inside one of the five glass sites (and on the system sidebar):
    /// foreground at 6% / 8%.
    static let junoGlassHover = Color.junoAdaptive(light: .glassHoverLight, dark: .glassHoverDark)

    /// A resting fill inside glass — the voice disc, armed marks, the plan
    /// pill, the search button: foreground at 8% / 12%.
    static let junoGlassFill = Color.junoAdaptive(light: .glassFillLight, dark: .glassFillDark)

    /// `--sidebar-hover`: a sidebar row under the pointer — one rung off the
    /// panel, one rung short of ``junoSelectedFill``.
    static let junoSidebarHover = Color.junoAdaptive(JunoGeneratedColors.sidebarHover)

    /// `--sidebar-selected`, opaque: the selected sidebar row. Never the
    /// accent — selection is not an action.
    static let junoSelectedFill = Color.junoAdaptive(
        light: .selectedFillLight, dark: .selectedFillDark
    )

    /// The selected row's edge at standard contrast: foreground at 12% / 14%.
    /// Views that draw it read Increase Contrast and use
    /// ``junoSelectedEdge(increaseContrast:)``.
    static let junoSelectedEdge = Color.junoAdaptive(
        light: .selectedEdgeLight, dark: .selectedEdgeDark
    )

    /// The selected row's edge for the current contrast setting: 24% under
    /// Increase Contrast.
    ///
    /// A function of the flag rather than one dynamic colour because AppKit
    /// does not reach a SwiftUI `Color` with the high-contrast appearance: a
    /// dynamic `NSColor` resolved through SwiftUI is asked for aqua or dark
    /// aqua and nothing else, so the switch has to be read from
    /// `colorSchemeContrast` (or ``SwiftUI/EnvironmentValues/junoAccessibility``)
    /// by the view that draws the edge.
    static func junoSelectedEdge(increaseContrast: Bool) -> Color {
        increaseContrast ? selectedEdgeIncreased : junoSelectedEdge
    }

    private static let selectedEdgeIncreased = Color.junoAdaptive(
        light: .selectedEdgeIncreasedLight, dark: .selectedEdgeIncreasedDark
    )

    // ── The older names ─────────────────────────────────────────────────────
    //
    // Same values as the redesign names they point at. See the note at the
    // top of the file for why they are not yet `@available(deprecated)`.

    /// The older name for ``junoCard``.
    static let junoSurface = Color.junoCard

    /// The older name for ``junoSecondaryInk``.
    static let junoMutedForeground = Color.junoSecondaryInk

    /// `--muted`: a quiet fill. The same values as ``junoSecondary`` today;
    /// prefer that name in new code.
    static let junoMuted = Color.junoAdaptive(light: .mutedLight, dark: .mutedDark)

    /// `--popover`. **Not painted on the Mac** — popovers, menus and sheets
    /// are system glass there. Kept for the phone.
    static let junoPopover = Color.junoAdaptive(light: .popoverLight, dark: .popoverDark)

    /// `--hairline`: a warm translucent rule for a divider laid over something
    /// other than the canvas.
    static let junoHairline = Color.junoAdaptive(light: .hairlineLight, dark: .hairlineDark)

    /// `--sidebar`, the web's recessed column. The Mac's sidebar is system
    /// glass and does not paint it.
    static let junoSidebar = Color.junoAdaptive(light: .sidebarLight, dark: .sidebarDark)

    // MARK: Building colours

    /// A colour that resolves per appearance. Both halves are always given: a
    /// single value that "works in both" is how the two themes drift.
    static func junoAdaptive(light: JunoColorToken, dark: JunoColorToken) -> Color {
        #if canImport(UIKit)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? .juno(dark) : .juno(light)
        })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return .juno(isDark ? dark : light)
        })
        #else
        return Color(juno: light)
        #endif
    }

    /// A generated pair as a colour.
    static func junoAdaptive(_ pair: JunoGeneratedPair) -> Color {
        junoAdaptive(light: pair.light, dark: pair.dark)
    }
}

// MARK: - Hairlines

/// How strongly a content hairline is drawn.
///
/// `--border` is opaque, and the web draws it at a fraction nearly everywhere
/// (`border-border/60`–`/80`). The redesign settles the Mac on one strength —
/// 0.8 — and full strength under Increase Contrast, so a rule never depends on
/// which fraction the author happened to type.
public enum JunoHairline {
    /// 0.8 at standard contrast, 1.0 under Increase Contrast.
    public static func opacity(increaseContrast: Bool) -> Double {
        increaseContrast ? 1 : 0.8
    }
}

// MARK: - Accent tint

public extension View {
    /// Tints the controls below this point in the account's accent: toggle
    /// tracks, sliders, progress, the one `.borderedProminent` button.
    ///
    /// **Apply it below the view that declares the toolbar**, never on the
    /// window root. Toolbar items inherit the tint of the view that owns the
    /// `.toolbar`, and the redesign keeps toolbar glyphs monochrome (§0.4); a
    /// tint on the root turns every toolbar symbol, and the system's own
    /// sidebar toggle, coral. The window's `AccentColor` asset stays graphite
    /// (``SwiftUI/Color/junoRing``) for the same reason — it is what AppKit
    /// draws focus rings and unstyled selection in.
    ///
    /// A modifier rather than `.tint(Color.junoAccent)` inline so the accent is
    /// read inside a view body, where the ``JunoAccentSelection`` observation
    /// registers and a change in Settings redraws the tint.
    func junoAccentTint() -> some View {
        modifier(JunoAccentTintModifier())
    }
}

private struct JunoAccentTintModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.tint(Color.junoAccent)
    }
}

#if canImport(UIKit)
private extension UIColor {
    static func juno(_ token: JunoColorToken) -> UIColor {
        UIColor(red: token.red, green: token.green, blue: token.blue, alpha: token.opacity)
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    static func juno(_ token: JunoColorToken) -> NSColor {
        NSColor(srgbRed: token.red, green: token.green, blue: token.blue, alpha: token.opacity)
    }
}
#endif

// MARK: - Presence

/// Presence ink and the galaxy's warm core.
///
/// The web states these in its brand layer, not in `globals.css`: presence is
/// `--tm-presence` in `thinking-mark.css` (#2D49C9 / #97A6E6, BRAND_IDENTITY.md:
/// "Presence — live work, voice"), and the core warmth is the galaxy spec's
/// #8A6A3E / #F3D9B1. The generator has no variable to project, so they are
/// typed here once and registered in `JunoTokenConsumptionTests`.
public extension JunoColorToken {
    static let presenceLight = JunoColorToken(unchecked: 0.1765, 0.2863, 0.7882)
    static let presenceDark = JunoColorToken(unchecked: 0.5922, 0.6510, 0.9020)
    static let galaxyCoreLight = JunoColorToken(unchecked: 0.5412, 0.4157, 0.2431)
    static let galaxyCoreDark = JunoColorToken(unchecked: 0.9529, 0.8510, 0.6941)
}

public extension Color {
    /// The brand's one live colour: what is working right now. Spent on a few
    /// stars of ``JunoGalaxyMark`` and nowhere else by default.
    static let junoPresence = Color.junoAdaptive(light: .presenceLight, dark: .presenceDark)
    /// The warmth the galaxy's core is mixed toward (12%).
    static let junoGalaxyCore = Color.junoAdaptive(light: .galaxyCoreLight, dark: .galaxyCoreDark)
}
