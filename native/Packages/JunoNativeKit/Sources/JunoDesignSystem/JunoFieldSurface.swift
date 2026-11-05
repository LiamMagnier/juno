import SwiftUI

/// The same field states as the website's Input, Textarea and Select. Reading
/// the generated semantic pairs keeps forms, search and editors on one surface
/// recipe when the palette changes; a field never borrows the account's accent.
public struct JunoFieldAppearance: Equatable, Sendable {
    public let surface: JunoGeneratedPair
    public let border: JunoGeneratedPair
    public let showsFocus: Bool
    public let opacity: Double

    public init(focused: Bool, hovered: Bool, enabled: Bool, increaseContrast: Bool) {
        let active = enabled && (focused || hovered)
        surface = active ? JunoGeneratedColors.fieldSurfaceActive : JunoGeneratedColors.fieldSurface
        showsFocus = enabled && focused
        opacity = enabled ? 1 : 0.5
        if increaseContrast {
            border = JunoGeneratedColors.fieldRing
        } else if showsFocus {
            border = JunoGeneratedColors.fieldFocus
        } else if enabled && hovered {
            border = JunoGeneratedColors.fieldHover
        } else {
            border = JunoGeneratedColors.fieldBorder
        }
    }
}

public enum JunoFieldMetrics {
    /// Native controls keep their platform density while sharing their states.
    public static var minimumHeight: CGFloat {
        #if os(macOS)
        JunoSpace.region
        #else
        JunoLayout.touchTarget
        #endif
    }
    public static let horizontalInset: CGFloat = JunoSpace.cozy
    public static let verticalInset: CGFloat = JunoSpace.snug
}

public extension View {
    /// The surface only, for a field with accessories and its own geometry.
    /// Supply the field's live FocusState value; the focus ring must follow
    /// keyboard focus as well as a pointer or touch.
    func junoFieldSurface(isFocused: Bool, cornerRadius: CGFloat = JunoRadius.field) -> some View {
        modifier(JunoFieldSurface(isFocused: isFocused, cornerRadius: cornerRadius))
    }

    /// A standalone text field or editor. Search fields with leading/trailing
    /// controls use `junoFieldSurface` around the whole row instead.
    func junoField(isFocused: Bool) -> some View {
        textFieldStyle(.plain)
            .padding(.horizontal, JunoFieldMetrics.horizontalInset)
            .padding(.vertical, JunoFieldMetrics.verticalInset)
            .frame(minHeight: JunoFieldMetrics.minimumHeight)
            .junoFieldSurface(isFocused: isFocused)
    }
}

private struct JunoFieldSurface: ViewModifier {
    let isFocused: Bool
    let cornerRadius: CGFloat

    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.junoAccessibility) private var accessibility
    @Environment(\.colorScheme) private var colorScheme

    private var appearance: JunoFieldAppearance {
        JunoFieldAppearance(
            focused: isFocused,
            hovered: hovered,
            enabled: isEnabled,
            increaseContrast: accessibility.increaseContrast
        )
    }

    private func color(_ pair: JunoGeneratedPair) -> Color {
        Color(juno: pair.resolve(dark: colorScheme == .dark, highContrast: accessibility.increaseContrast))
    }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .foregroundStyle(Color.junoForeground)
            .background(color(appearance.surface), in: shape)
            .overlay {
                shape.strokeBorder(color(appearance.border), lineWidth: 1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .overlay {
                shape.inset(by: -2)
                    .stroke(color(JunoGeneratedColors.fieldRing), lineWidth: 2)
                    .opacity(appearance.showsFocus ? 1 : 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .opacity(appearance.opacity)
            .contentShape(shape)
            .onHover { hovered = $0 && isEnabled }
            .animation(
                JunoMotion.reduced(JunoMotion.fast, when: accessibility.reduceMotion, tier: .tint),
                value: appearance
            )
    }
}
