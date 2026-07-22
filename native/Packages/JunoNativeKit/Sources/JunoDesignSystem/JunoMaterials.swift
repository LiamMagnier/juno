import SwiftUI

/// Liquid Glass is reserved for floating chrome (composers, toolbars, floating
/// controls) — never the main reading surface. This helper applies the OS 26+
/// glass effect where available and falls back to a system material on the
/// minimum deployment targets, so one call adapts across OS versions.
public extension View {
    func junoFloatingGlass(cornerRadius: CGFloat = JunoCornerRadius.floating) -> some View {
        modifier(JunoFloatingGlass(cornerRadius: cornerRadius))
    }
}

private struct JunoFloatingGlass: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

/// A glass-or-material background for input capsules and floating controls,
/// usable directly in a `.background(...)`.
public struct JunoGlassBackground: View {
    private let cornerRadius: CGFloat

    public init(cornerRadius: CGFloat = JunoCornerRadius.control) {
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(.quaternary.opacity(0.5))
        }
    }
}
