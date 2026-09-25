import JunoDesignSystem
import SwiftUI

/// The reader's text size on this Mac: the web's six steps
/// (`src/components/settings/font-size.ts`), stored per device under the web's
/// ids, and applied as ``SwiftUI/EnvironmentValues/junoTextScale`` = px ÷ 16
/// (P3-6: Juno's own type and controls scale; the sidebar, menus and toolbar
/// keep macOS's sizes).
enum DesktopTextSize: String, CaseIterable, Identifiable, Sendable {
    case xs
    case small
    case `default`
    case large
    case xl
    case xxl

    static let storageKey = "juno.textSize"

    var id: String { rawValue }

    /// The root font size the web sets for this step.
    var px: Int {
        switch self {
        case .xs: 14
        case .small: 15
        case .default: 16
        case .large: 17
        case .xl: 18
        case .xxl: 20
        }
    }

    /// The factor on every ``JunoType`` rung.
    var scale: CGFloat { CGFloat(px) / 16 }

    /// The step's position on the six-step slider.
    var step: Int { Self.allCases.firstIndex(of: self) ?? 2 }

    /// A stored id, or the default for anything this build does not know.
    init(stored: String?) {
        self = DesktopTextSize(rawValue: stored ?? "") ?? .default
    }

    init(step: Int) {
        let cases = Self.allCases
        self = cases[min(max(step, 0), cases.count - 1)]
    }
}

private struct DesktopTextScaleModifier: ViewModifier {
    @AppStorage(DesktopTextSize.storageKey) private var stored = DesktopTextSize.default.rawValue

    func body(content: Content) -> some View {
        content.environment(\.junoTextScale, DesktopTextSize(stored: stored).scale)
    }
}

extension View {
    /// Sets ``SwiftUI/EnvironmentValues/junoTextScale`` from this Mac's text
    /// size, and follows it when Settings changes it. Once per window root.
    func desktopTextScale() -> some View {
        modifier(DesktopTextScaleModifier())
    }
}
