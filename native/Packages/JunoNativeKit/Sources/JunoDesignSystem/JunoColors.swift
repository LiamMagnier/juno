import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Adaptive brand surfaces used by the native apps. Light mode stays close to
/// white and dark mode is a warm graphite — the main content stays sober while
/// the coral accent is reserved for emphasis. Everything else defers to the
/// system semantic colors so the apps track platform conventions automatically.
public extension JunoColorToken {
    static let accentLight = JunoColorToken.coral
    static let accentDark = JunoColorToken(unchecked: 0.98, 0.451, 0.361)

    static let canvasLight = JunoColorToken(unchecked: 0.975, 0.973, 0.967)
    static let canvasDark = JunoColorToken(unchecked: 0.102, 0.102, 0.110)

    static let surfaceLight = JunoColorToken(unchecked: 1, 1, 1)
    static let surfaceDark = JunoColorToken(unchecked: 0.157, 0.157, 0.170)

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
