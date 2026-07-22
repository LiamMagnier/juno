import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import SwiftUI

/// The composer's Thinking control: a compact chip showing the current level,
/// which opens a small popover anchored directly above it holding a discrete
/// slider over exactly the levels the selected model supports.
///
/// It renders nothing at all for a model that cannot reason — an inert control
/// would be a lie about what the model does — and shows a non-adjustable "Auto"
/// state for the router, which chooses depth per message on the server.
struct JunoMobileThinkingControl: View {
    let scale: NativeThinkingScale
    @Binding var effort: NativeReasoningEffort?

    @State private var presented = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var currentStop: NativeThinkingStop? {
        scale.stops.first { $0.effort == effort }
    }

    private var label: String {
        if scale.isAutomatic { return "Auto" }
        return currentStop?.label ?? "Off"
    }

    var body: some View {
        if scale.isPresentable {
            Button {
                guard scale.isAdjustable else { return }
                presented = true
            } label: {
                HStack(spacing: 5) {
                    Text(label)
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .lineLimit(1)
                    if scale.isAdjustable {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(scale.isAutomatic ? Color.secondary : Color.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .modifier(JunoMobileComposerChipBackground())
            }
            .buttonStyle(.plain)
            .disabled(!scale.isAdjustable)
            .accessibilityLabel("Thinking")
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(scale.isAdjustable ? "Opens the thinking level picker" : "")
            .accessibilityIdentifier("juno.mobile.chat-thinking")
            .popover(isPresented: $presented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                JunoThinkingPopover(scale: scale, effort: $effort, width: popoverWidth)
                    // Stays a compact anchored popover on iPhone too: a full
                    // sheet would detach the control from the value it sets.
                    // The fixed size is also what keeps it off the keyboard.
                    .presentationCompactAdaptation(.popover)
            }
            // Keyed on the scale: the catalog arrives after first render, so a
            // plain `.task` runs while the default model is still selected —
            // typically Auto, which is not adjustable — and never retries once
            // the real model lands.
            .task(id: scale) {
                #if DEBUG
                guard JunoComposerPreviewFlags.opensThinking, scale.isAdjustable else { return }
                try? await Task.sleep(nanoseconds: 500_000_000)
                presented = true
                #endif
            }
        }
    }

    /// Grows only with Dynamic Type; a fixed width keeps the popover compact
    /// and keeps its measuring content from feeding back into its own layout.
    private var popoverWidth: CGFloat {
        typeSize.isAccessibilitySize ? 320 : 268
    }

    private var accessibilityValue: String {
        if scale.isAutomatic { return "Chosen automatically for each message" }
        guard let currentStop else { return "Off" }
        let range = scale.stops.map(\.label).joined(separator: ", ")
        return "\(currentStop.label). Available levels: \(range)"
    }
}

// MARK: - Shared chip background

/// The composer's small controls all share one Liquid Glass capsule, so the
/// model chip and the Thinking chip read as parts of the same control row
/// rather than as two unrelated buttons.
struct JunoMobileComposerChipBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}
