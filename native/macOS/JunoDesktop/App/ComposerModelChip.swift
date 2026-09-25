import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The two things the model chip opens (§5.7).
///
/// One `.popover(item:)` over both, rather than two `isPresented` flags. When
/// the item changes identity SwiftUI dismisses the presented popover and shows
/// the new one — which is exactly "Change model dismisses stage one and presents
/// stage two on the same chip", with no window in which both are live or a
/// timer guessing when the first one has gone.
enum ComposerModelStage: String, Identifiable {
    /// The model in use and how hard it thinks: all most turns need.
    case settings
    /// The full catalogue.
    case catalog

    var id: String { rawValue }
}

/// The composer's model chip and its two-stage popover (§5.3, §5.7).
///
/// **One chip, no thinking chip beside it.** Effort used to be a second glass
/// pill on the row, which put two controls on one decision and two chevrons on
/// one strip. It now lives in stage one, under the model it belongs to — the
/// web's arrangement, and ChatGPT's, for the same reason: effort changes between
/// messages, the model a few times a day.
///
/// **Always a model.** The chip reads "Auto" until the reader picks something
/// else, and it reads "Auto" while the catalog is still on its way (redacted,
/// so it is plainly a placeholder) — because the composer sends to Auto in that
/// window too. "Choose model" is gone: a send button beside it that could not
/// send was a dead control with no reason given.
///
/// **Explicit frames** on both stages (crash rule 2). AppKit cannot negotiate a
/// popover whose content measures itself, and the thinking panel contains a
/// `GeometryReader`; stage one's height is therefore computed from the scale
/// before the panel exists.
struct ComposerModelChip: View {
    /// The selected model as the catalog describes it; nil while the catalog is
    /// loading, failed, or does not list the id (Auto before the catalog lands).
    let selectedModel: NativeChatModelOption?
    let selectedModelID: String
    let catalog: [NativeChatModelOption]
    /// Why the catalog could not be loaded, when it could not.
    let catalogError: String?
    let scale: NativeThinkingScale?
    @Binding var effort: NativeReasoningEffort?
    @Binding var fastMode: Bool
    @Binding var proMode: Bool
    let choose: (String) -> Void
    let reload: () -> Void

    @State private var stage: ComposerModelStage?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Stage one's width and its model row's band: 8 + a 40pt two-line row + 8.
    nonisolated static let settingsWidth: CGFloat = 384
    nonisolated static let settingsRowBand: CGFloat = 56

    /// Stage one's height: the row band, plus the thinking panel and the rule
    /// above it when the model has anything to set.
    nonisolated static func settingsHeight(for scale: NativeThinkingScale?) -> CGFloat {
        let thinking = JunoThinkingPopover.height(for: scale)
        return settingsRowBand + (thinking > 0 ? thinking + 1 : 0)
    }

    private var isUnavailable: Bool { catalog.isEmpty && catalogError != nil }
    private var isLoading: Bool { catalog.isEmpty && catalogError == nil }

    private var isAuto: Bool {
        guard let selectedModel else { return selectedModelID == ChatComposerModels.autoModelID }
        return selectedModel.choosesReasoningAutomatically
            || selectedModel.providerID == JunoModelSelectorCatalog.junoProviderID
    }

    private var name: String {
        if isUnavailable { return "Models unavailable" }
        return selectedModel?.displayName ?? "Auto"
    }

    var body: some View {
        Button {
            stage = .settings
        } label: {
            HStack(spacing: 6) {
                mark(size: 16)
                Text(name)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .frame(maxWidth: 160, alignment: .leading)
                JunoIconView(.chevronDown, size: 10, weight: .bold)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .opacity(0.7)
                    .rotationEffect(.degrees(stage == nil ? 0 : 180))
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: stage == nil)
            }
            .redacted(reason: isLoading ? .placeholder : [])
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: JunoComposerMetrics.controlHeight)
            .contentShape(.rect)
        }
        .buttonStyle(ComposerControlStyle())
        .fixedSize()
        .help(isUnavailable ? (catalogError ?? "Models unavailable") : "Choose a model and how much it thinks")
        .accessibilityLabel("Model")
        .accessibilityValue(isLoading ? "Loading" : name)
        .accessibilityIdentifier("juno.desktop.chat-model")
        .popover(item: $stage, attachmentAnchor: .rect(.bounds), arrowEdge: .top) { stage in
            switch stage {
            case .settings:
                settingsStage
                    .frame(width: Self.settingsWidth, height: isUnavailable ? Self.settingsRowBand : Self.settingsHeight(for: scale))
            case .catalog:
                catalogStage
                    .frame(width: JunoModelSelectorMetrics.standard.width, height: JunoModelSelectorMetrics.standard.height)
            }
        }
        // Torn down with the chip. A popover whose anchor leaves the hierarchy
        // while presented makes AppKit order a child window against a window
        // that is already going — the uncaught `NSRemoteView` exception this
        // composer shipped once, reproduced by opening the picker and clicking
        // another sidebar row.
        .onDisappear { stage = nil }
        .desktopPreviewOverlays(popover: { stage = .settings })
    }

    // MARK: Mark

    @ViewBuilder
    private func mark(size: CGFloat) -> some View {
        if isUnavailable {
            JunoIconView(.error, size: size)
                .foregroundStyle(Color.junoSecondaryInk)
        } else if isAuto {
            // Auto is Juno's router, so it wears Juno's chat mark rather than a
            // lab's logo.
            JunoIconView(.conversation, size: size)
                .foregroundStyle(Color.junoSecondaryInk)
        } else if let selectedModel {
            JunoProviderMark(
                providerID: selectedModel.providerID,
                providerName: selectedModel.providerName,
                size: size
            )
        } else {
            JunoIconView(.conversation, size: size)
                .foregroundStyle(Color.junoSecondaryInk)
        }
    }

    // MARK: Stage one

    @ViewBuilder
    private var settingsStage: some View {
        if isUnavailable {
            unavailableRow
        } else {
            VStack(spacing: 0) {
                changeModelRow
                if JunoThinkingPopover.height(for: scale) > 0, let scale {
                    Divider()
                    JunoThinkingPopover(
                        scale: scale,
                        effort: $effort,
                        width: Self.settingsWidth,
                        fastMode: $fastMode,
                        proMode: $proMode
                    )
                    .frame(maxHeight: .infinity, alignment: .top)
                }
            }
        }
    }

    /// The door to stage two: the model in use, and where to change it.
    private var changeModelRow: some View {
        Button {
            // Swapping the item is what closes this popover and opens the next.
            stage = .catalog
        } label: {
            HStack(spacing: JunoSpace.close) {
                mark(size: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Text("Change model")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Spacer(minLength: 0)
                JunoIconView(.chevronRight, size: 12, weight: .bold)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 40)
            .contentShape(.rect)
        }
        .buttonStyle(ComposerPopoverRowStyle())
        .padding(JunoSpace.snug)
        .accessibilityLabel("Change model")
        .accessibilityValue(name)
        .accessibilityIdentifier("juno.desktop.chat-model.change")
    }

    /// A failed catalog: say so, and offer the one thing that can help.
    private var unavailableRow: some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(.error, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            Text("Models unavailable")
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .help(catalogError ?? "")
            Spacer(minLength: 0)
            Button("Try Again", action: reload)
                .buttonStyle(.bordered)
                // The popover inherits the composer's accent tint; a secondary
                // button never wears it (§0.4).
                .tint(nil)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.chat-model.retry")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(maxHeight: .infinity)
    }

    // MARK: Stage two

    private var catalogStage: some View {
        JunoModelSelector(
            models: catalog.map(\.junoDescriptor),
            selectedModelID: selectedModelID,
            metrics: .standard,
            select: { descriptor in
                choose(descriptor.id)
                stage = nil
            }
        )
    }
}

/// A row inside a popover: the popover's own hover fill, radius 8 (§7.1).
///
/// The fill is `junoGlassHover` because the popover is system glass — the
/// opaque content hover would read as a patch of paper on it.
struct ComposerPopoverRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                        .fill(Color.junoGlassHover)
                        .opacity((hovered || configuration.isPressed) && isEnabled ? 1 : 0)
                }
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        }
    }
}
