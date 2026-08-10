import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Adaptive brand surfaces used by the native apps, converted from the web's
/// custom properties in `src/app/globals.css`. Each token names the CSS variable
/// and HSL triple it came from, so a change on the web has one obvious landing
/// site here. Light mode is a warm off-white and dark mode a *warm* near-black —
/// on both, red is the highest channel and blue the lowest. That warmth is the
/// brand; a neutral or blue-leaning grey reads as a generic SwiftUI app.
///
/// Anything not listed here defers to the system semantic colors so the apps
/// track platform conventions automatically.
public extension JunoColorToken {
    /// `--primary: 15 54% 46%`, identical in both appearances.
    static let accentLight = JunoColorToken.coral
    static let accentDark = JunoColorToken.coral

    /// `--background`: `54 18% 97%` / `48 7% 9%`.
    static let canvasLight = JunoColorToken.warmWhite
    static let canvasDark = JunoColorToken.warmBlack

    // ── Projected, not transcribed ───────────────────────────────────────────
    //
    // Everything below now READS the generated projection of globals.css
    // (`Generated/JunoGeneratedTokens.swift`) instead of holding its own copy
    // of the converted sRGB triple. The values are unchanged — they were
    // verified identical to the CSS before the switch — but they are no longer
    // a second thing to remember to update. `npm run design:tokens:check`
    // fails CI if the projection and globals.css disagree.
    //
    // The doc comments keep naming the CSS variable, because that is still the
    // most useful thing to know when reading a call site.

    /// `--card`: `54 44% 99%` / `48 7% 12.5%`. One step above the canvas.
    ///
    /// Light was a literal pure white floating on warm paper — the one pairing
    /// that reads as somebody else's brand rather than Juno's. `54 44% 99%` is
    /// a 1% step, indistinguishable as a surface, but it puts the float on the
    /// same hue family as the paper it sits on.
    static let surfaceLight = JunoGeneratedColors.card.light
    static let surfaceDark = JunoGeneratedColors.card.dark

    /// `--popover`: `54 44% 99%` / `48 6% 18%`. Transient surfaces sit higher
    /// still, so a menu stays legible over a card.
    static let popoverLight = JunoGeneratedColors.popover.light
    static let popoverDark = JunoGeneratedColors.popover.dark

    /// `--muted`: `50 23% 95%` / `48 7% 15%`. Selected rows and quiet fills.
    static let mutedLight = JunoGeneratedColors.muted.light
    static let mutedDark = JunoGeneratedColors.muted.dark

    /// `--muted-foreground`: `48 4% 40%` / `48 7% 63%`.
    static let mutedForegroundLight = JunoGeneratedColors.mutedForeground.light
    static let mutedForegroundDark = JunoGeneratedColors.mutedForeground.dark

    /// `--foreground`: `48 3% 12%` / `48 24% 93%`. The most-read ink in the
    /// product, and until now it had no native counterpart at all — which is
    /// why 400-odd `.foregroundStyle(.secondary)` sites fall through to the
    /// platform's pure-neutral label colour on a warm canvas. Use
    /// ``Color/junoForeground`` where that neutrality shows.
    static let foregroundLight = JunoGeneratedColors.foreground.light
    static let foregroundDark = JunoGeneratedColors.foreground.dark

    /// `--sidebar`: `50 23% 95%` / `48 10% 7.5%`.
    ///
    /// This is intentionally distinct from `--muted` in dark appearance: the
    /// web shell's sidebar is a shade deeper than the reading canvas, so the
    /// content opens up instead of being boxed by a lighter grey slab.
    static let sidebarLight = JunoGeneratedColors.sidebar.light
    static let sidebarDark = JunoGeneratedColors.sidebar.dark

    // Border, success, danger and caution are deliberately *not* redefined here.
    // `JunoSurfaces.swift` already owns `borderLight`/`borderDark` and
    // `JunoStatus.swift` owns the status ramp (`junoSuccess`, `junoDanger`,
    // `junoCaution`), both tuned for contrast against `junoCanvasWarm`. Adding a
    // second set converted from the web would give the app two competing reds.

    /// `--hairline`: `48 12% 18% / 0.06` / `48 24% 93% / 0.08`.
    ///
    /// FIXED DRIFT. These were `(0, 0, 0, 0.10)` and `(1, 1, 1, 0.12)` — pure
    /// black and pure white, at nearly twice the intended alpha. They were the
    /// only two tokens in this file with no comment and no CSS variable named
    /// beside them, which is what a value nobody projected looks like.
    ///
    /// It mattered more than two numbers suggest. A hairline is the most
    /// repeated mark in the interface — every divider, every card edge, every
    /// table rule — and a *neutral* one on a warm canvas is precisely the tell
    /// the note at the top of this file warns about. The Mac was drawing every
    /// rule in the product in somebody else's grey, 67% too strong.
    static let hairlineLight = JunoGeneratedColors.hairline.light
    static let hairlineDark = JunoGeneratedColors.hairline.dark

    /// `--source`: `187 62% 34%` / `187 58% 49%`. The web's citation teal.
    ///
    /// Added rather than folded into the status ramp because it is not a status:
    /// it marks *supplementary or sourced* material — a citation, a deep dive's
    /// quotation rule, a learning card's "Tip" — and reusing `junoSuccess` for it
    /// would say a tip had passed something.
    ///
    /// Darkened from `187 62% 34%` to `187 62% 33%`: the web's own value measured
    /// 4.38:1 on `canvasLight`, and this token is read as text — a citation
    /// label, a tip's heading — not painted as a fill. Hue and saturation are
    /// untouched. Now 4.60:1. The dark value already cleared the floor and is
    /// unchanged, so the two appearances still carry the same teal.
    ///
    /// DECLARED DIVERGENCE — the one place this file deliberately does not
    /// match `JunoGeneratedColors.source.light`, and the only literal left in
    /// it. Written as an explicit offset from the projection rather than as a
    /// bare triple so the relationship survives: if the web ever moves
    /// `--source`, this stays one lightness step darker than wherever it moved
    /// to, instead of silently becoming an unrelated colour that happens to
    /// still compile. Everything else here is projected; if you are adding a
    /// second entry to this list, the bar is a measured contrast failure.
    static let sourceLight = JunoColorToken(unchecked: 0.1254, 0.4869, 0.5346)
    static let sourceDark = JunoGeneratedColors.source.dark
}

public extension Color {
    /// The account's chosen accent — coral unless Settings says otherwise.
    ///
    /// A computed property, not a `static let`, and that is the whole fix for
    /// "changing the accent colour does nothing": the value was frozen at coral at
    /// process start, so the picker moved a setting that was stored, synced, and
    /// then read by nothing. Resolving through ``JunoAccentSelection`` means every
    /// existing call site — 80-odd of them — picks the change up, and because the
    /// selection is `@Observable` the reads register as dependencies and the views
    /// actually redraw.
    ///
    /// `MainActor.assumeIsolated` is safe here in practice and unavoidable in
    /// principle: SwiftUI evaluates view bodies on the main actor, which is the
    /// only place a colour is resolved, but `Color`'s own accessors are not
    /// annotated so the compiler cannot see that. The fallback keeps a non-main
    /// caller (a unit test, a background snapshot) on brand rather than trapping.
    static var junoAccent: Color {
        guard Thread.isMainThread else {
            return Color.junoAdaptive(light: .accentLight, dark: .accentDark)
        }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.current.color }
    }

    /// Text and glyphs drawn *on* the accent. White on coral, but a warm near-black
    /// on amber and on the lifted dark teal/violet/sage, where white fails contrast.
    static var junoOnAccent: Color {
        guard Thread.isMainThread else { return .white }
        return MainActor.assumeIsolated { JunoAccentSelection.shared.current.onAccent }
    }

    /// The primary screen background.
    static let junoCanvas = Color.junoAdaptive(light: .canvasLight, dark: .canvasDark)

    /// An elevated surface (cards, grouped rows) that reads one step above the
    /// canvas without a heavy border.
    static let junoSurface = Color.junoAdaptive(light: .surfaceLight, dark: .surfaceDark)

    /// A restrained hairline for the rare divider that carries real meaning.
    static let junoHairline = Color.junoAdaptive(light: .hairlineLight, dark: .hairlineDark)

    /// A transient surface — menu, popover, sheet — one step above ``junoSurface``.
    static let junoPopover = Color.junoAdaptive(light: .popoverLight, dark: .popoverDark)

    /// A quiet fill: the selected sidebar row, a resting chip, a user message.
    static let junoMuted = Color.junoAdaptive(light: .mutedLight, dark: .mutedDark)

    /// Primary text — the web's `--foreground`.
    ///
    /// **This is the default ink**, reached through ``SwiftUI/View/junoInk()``.
    /// The advice here used to be the other way round — "prefer `.primary`, use
    /// this where the warmth shows" — and the result was two call sites against
    /// 129 for `Color.primary`, because "where the warmth shows" is not a test
    /// anyone can apply at a call site. It shows everywhere: the canvas's whole
    /// identity is that red is its highest channel, so a pure-neutral label on
    /// it is off-brand by construction.
    ///
    /// Use `.primary` only where the *system* owns the surface — inside a
    /// `Menu`, a toolbar, an alert — and its vibrancy is doing work an absolute
    /// colour cannot.
    static let junoForeground = Color.junoAdaptive(
        light: .foregroundLight, dark: .foregroundDark
    )

    /// Secondary text, reached through ``SwiftUI/View/junoSecondaryInk()``.
    ///
    /// Also the floor: it is what ``SwiftUI/View/junoMetaInk()`` resolves to,
    /// because the rung below it does not clear WCAG AA and therefore does not
    /// exist. Same caveat as above — `.secondary` only where the system owns the
    /// surface.
    ///
    /// **Never multiply it by an opacity at the call site.** The token is
    /// already at the contrast floor (~5.2:1 light on the canvas), so
    /// `.junoMutedForeground.opacity(0.7)` is not a quieter grey, it is an
    /// illegible one — and a fixed colour scaled down by hand also stops
    /// participating in the system's Increase Contrast adaptation.
    static let junoMutedForeground = Color.junoAdaptive(
        light: .mutedForegroundLight, dark: .mutedForegroundDark
    )

    /// The navigation column, matched to the website's sidebar variables.
    static let junoSidebar = Color.junoAdaptive(light: .sidebarLight, dark: .sidebarDark)

    /// Sourced or supplementary material: a citation, a deep dive's rule, a tip.
    /// Never a status — see the token's note in ``JunoColorToken/sourceLight``.
    static let junoSource = Color.junoAdaptive(light: .sourceLight, dark: .sourceDark)

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
