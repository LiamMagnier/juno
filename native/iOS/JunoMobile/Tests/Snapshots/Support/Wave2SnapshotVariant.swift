import JunoDesignSystem
import SwiftUI
import UIKit

/// The iOS half of the spec's native screenshot matrix (§14): light, dark,
/// Increase Contrast, Reduce Transparency and Dynamic Type AX3.
///
/// Each variant is applied twice, so UIKit-backed and SwiftUI views agree:
/// as window trait overrides (interface style, accessibility contrast,
/// content size category) and as the SwiftUI environment. Reduce
/// Transparency has no trait to override; it uses SwiftUI's writable twin
/// `_accessibilityReduceTransparency`, plus the design system's opaque-glass
/// recipe every offscreen snapshot uses.
enum Wave2SnapshotVariant: String, CaseIterable, Sendable {
    case light
    case dark
    case increaseContrast = "increase-contrast"
    case reduceTransparency = "reduce-transparency"
    case ax3

    var isDark: Bool { self == .dark }
    var colorScheme: ColorScheme { isDark ? .dark : .light }
    var interfaceStyle: UIUserInterfaceStyle { isDark ? .dark : .light }
    var contrast: ColorSchemeContrast { self == .increaseContrast ? .increased : .standard }
    var accessibilityContrast: UIAccessibilityContrast { self == .increaseContrast ? .high : .normal }
    var reducesTransparency: Bool { self == .reduceTransparency }
    /// AX3 is `accessibility3` in SwiftUI and `accessibilityExtraLarge` in UIKit.
    var dynamicTypeSize: DynamicTypeSize { self == .ax3 ? .accessibility3 : .large }
    var contentSizeCategory: UIContentSizeCategory { self == .ax3 ? .accessibilityExtraLarge : .large }

    func fileName(_ name: String) -> String { "ios-\(name)-\(rawValue).png" }
}

struct Wave2SnapshotEnvironment: ViewModifier {
    let variant: Wave2SnapshotVariant

    func body(content: Content) -> some View {
        content
            .environment(\.colorScheme, variant.colorScheme)
            .environment(\.dynamicTypeSize, variant.dynamicTypeSize)
            .environment(\._colorSchemeContrast, variant.contrast)
            .environment(\._accessibilityReduceTransparency, variant.reducesTransparency)
            .environment(\.junoSnapshotOpaqueGlass, true)
    }
}

extension View {
    func wave2Snapshot(_ variant: Wave2SnapshotVariant) -> some View {
        modifier(Wave2SnapshotEnvironment(variant: variant))
    }
}
