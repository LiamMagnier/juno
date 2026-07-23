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
    /// `--primary: 15 54% 51%`, identical in both appearances.
    static let accentLight = JunoColorToken.coral
    static let accentDark = JunoColorToken.coral

    /// `--background`: `48 33% 97%` / `28 9% 9%`.
    static let canvasLight = JunoColorToken.warmWhite
    static let canvasDark = JunoColorToken.warmBlack

    /// `--card`: `0 0% 100%` / `28 7% 12.5%`. One step above the canvas.
    static let surfaceLight = JunoColorToken(unchecked: 1, 1, 1)
    static let surfaceDark = JunoColorToken(unchecked: 0.1337, 0.1244, 0.1162)

    /// `--popover`: `0 0% 100%` / `28 6% 18%`. Transient surfaces sit higher
    /// still, so a menu stays legible over a card.
    static let popoverLight = JunoColorToken(unchecked: 1, 1, 1)
    static let popoverDark = JunoColorToken(unchecked: 0.1908, 0.1793, 0.1692)

    /// `--muted`: `50 23% 95%` / `30 7% 15%`. Selected rows and quiet fills.
    static let mutedLight = JunoColorToken(unchecked: 0.9615, 0.9577, 0.9385)
    static let mutedDark = JunoColorToken(unchecked: 0.1605, 0.15, 0.1395)

    /// `--muted-foreground`: `40 4% 40%` / `37 7% 63%`.
    static let mutedForegroundLight = JunoColorToken(unchecked: 0.416, 0.4053, 0.384)
    static let mutedForegroundDark = JunoColorToken(unchecked: 0.6559, 0.636, 0.6041)

    // Border, success, danger and caution are deliberately *not* redefined here.
    // `JunoSurfaces.swift` already owns `borderLight`/`borderDark` and
    // `JunoStatus.swift` owns the status ramp (`junoSuccess`, `junoDanger`,
    // `junoCaution`), both tuned for contrast against `junoCanvasWarm`. Adding a
    // second set converted from the web would give the app two competing reds.

    static let hairlineLight = JunoColorToken(unchecked: 0, 0, 0, 0.10)
    static let hairlineDark = JunoColorToken(unchecked: 1, 1, 1, 0.12)
}

public extension Color {
    /// The Juno accent (coral), brightened slightly in dark mode. Prefer the
    /// app `AccentColor` asset for `.tint`; use this where an explicit brand
    /// fill is needed.
    static let junoAccent = Color.junoAdaptive(light: .accentLight, dark: .accentDark)

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

    /// Secondary text. Prefer `.secondary` where the system's own ramp is right;
    /// use this where the warm brand tint matters, as in large calm surfaces.
    static let junoMutedForeground = Color.junoAdaptive(
        light: .mutedForegroundLight, dark: .mutedForegroundDark
    )

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
