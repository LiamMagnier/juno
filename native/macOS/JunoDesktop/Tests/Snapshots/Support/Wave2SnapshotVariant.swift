import AppKit
import JunoDesignSystem
import SwiftUI

/// The macOS half of the spec's native screenshot matrix (§14): light, dark,
/// Increase Contrast, Reduce Transparency and text size .xxl.
///
///     try await Wave2Snapshot.render(MyView(), name: "bubble", into: dir)
///
/// writes bubble-light.png, bubble-dark.png, bubble-xxl-light.png,
/// bubble-increase-contrast-light.png and bubble-reduce-transparency-light.png
/// through ``TranscriptSnapshotRenderer`` (offscreen, nothing on screen).
///
/// Increase Contrast and Reduce Transparency are applied through SwiftUI's
/// writable environment twins (`_colorSchemeContrast`,
/// `_accessibilityReduceTransparency`), which is what the views read; the
/// window's appearance stays aqua, because AppKit's high-contrast appearance
/// names cannot be instantiated.
enum Wave2SnapshotVariant: String, CaseIterable, Sendable {
    case light
    case dark
    case xxl
    case increaseContrast = "increase-contrast"
    case reduceTransparency = "reduce-transparency"

    /// Text size .xxl is 20px over the 16px default: ×1.25 (spec §3.5).
    /// Wave2TextScaleTests checks this against DesktopTextSize.xxl.
    static let xxlTextScale: CGFloat = 1.25

    var isDark: Bool { self == .dark }
    var appearance: NSAppearance.Name { isDark ? .darkAqua : .aqua }
    var colorScheme: ColorScheme { isDark ? .dark : .light }
    var textScale: CGFloat { self == .xxl ? Self.xxlTextScale : 1 }
    var contrast: ColorSchemeContrast { self == .increaseContrast ? .increased : .standard }
    var reducesTransparency: Bool { self == .reduceTransparency }

    /// The name passed to the renderer, which appends -light or -dark itself.
    func fileStem(_ name: String) -> String {
        switch self {
        case .light, .dark: name
        default: "\(name)-\(rawValue)"
        }
    }
}

struct Wave2SnapshotEnvironment: ViewModifier {
    let variant: Wave2SnapshotVariant

    func body(content: Content) -> some View {
        content
            .environment(\.colorScheme, variant.colorScheme)
            .environment(\.junoTextScale, variant.textScale)
            .environment(\._colorSchemeContrast, variant.contrast)
            .environment(\._accessibilityReduceTransparency, variant.reducesTransparency)
            // Offscreen drawing cannot composite Liquid Glass in any variant;
            // every glass control shows its opaque Reduce Transparency recipe.
            .environment(\.junoSnapshotOpaqueGlass, true)
    }
}

extension View {
    func wave2Snapshot(_ variant: Wave2SnapshotVariant) -> some View {
        modifier(Wave2SnapshotEnvironment(variant: variant))
    }
}
