import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The composer's model control: the website's (model-selector.tsx).
///
/// A model with thinking levels opens on the effort panel first, the thing
/// most turns change; the model's name in that panel opens the full
/// catalogue. Every other model (one effort, Auto, image, video, audio) opens
/// the catalogue straight away. The chip is the web's words: the model's name,
/// the effort only when it is not the model's usual one, one chevron.
///
/// Both stages are ``JunoModelPickerControl`` from the design system, the same
/// control the Code Studio composer mounts, so the two products cannot drift.
/// What stays here is Chat's: the catalog's loading and failure states, the
/// account's favorites, Flash and Pro.
struct ComposerModelChip: View {
    /// The selected model as the catalog describes it; nil while the catalog is
    /// loading, failed, or does not list the id (Auto before the catalog lands).
    let selectedModel: NativeChatModelOption?
    let selectedModelID: String
    let catalog: [NativeChatModelOption]
    /// Why the catalog could not be loaded, when it could not.
    let catalogError: String?
    let scale: NativeThinkingScale?
    /// The selected stop on `scale`, by `NativeThinkingStop.id`.
    @Binding var stopID: String?
    @Binding var fastMode: Bool
    /// Pro: drawn in the effort panel only for a model whose scale has it.
    @Binding var proMode: Bool
    /// The account's starred models, and how to star one; nil where there is
    /// no settings store (the preview world), which hides Favorites.
    let favorites: Set<String>
    let toggleFavorite: ((String) -> Void)?
    let choose: (String) -> Void
    let reload: () -> Void

    @State private var stage: JunoModelPickerStage?
    @State private var retryShown = false

    private var isUnavailable: Bool { catalog.isEmpty && catalogError != nil }
    private var isLoading: Bool { catalog.isEmpty && catalogError == nil }

    private var name: String {
        if isUnavailable { return "Models unavailable" }
        return selectedModel?.displayName ?? "Auto"
    }

    private var ladder: JunoThinkingLadder { scale?.junoLadder ?? .unavailable }

    var body: some View {
        if isUnavailable {
            unavailableChip
        } else {
            JunoModelPicker(
                models: catalog.map(\.junoDescriptor),
                selectedModelID: selectedModelID,
                ladder: ladder,
                stopID: $stopID,
                fastMode: $fastMode,
                proMode: $proMode,
                favorites: favorites,
                toggleFavorite: toggleFavorite,
                fallbackName: name,
                isLoading: isLoading,
                accessibilityID: "juno.desktop.chat-model",
                stage: $stage,
                select: { choose($0.id) }
            )
            .desktopPreviewOverlays(popover: { stage = .first(for: ladder) })
        }
    }

    /// A failed catalog: the chip says so, and its popover offers the one
    /// thing that can help.
    private var unavailableChip: some View {
        Button {
            retryShown = true
        } label: {
            JunoModelChipLabel(name: name, isOpen: retryShown)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(catalogError ?? "Models unavailable")
        .accessibilityLabel("Model")
        .accessibilityValue(name)
        .accessibilityIdentifier("juno.desktop.chat-model")
        .onDisappear { retryShown = false }
        .popover(isPresented: $retryShown, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            HStack(spacing: JunoSpace.close) {
                JunoIconView(.error, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text("Models unavailable")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .help(catalogError ?? "")
                Spacer(minLength: 0)
                Button("Try Again") {
                    retryShown = false
                    reload()
                }
                .buttonStyle(.junoGlass)
                .tint(nil)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.chat-model.retry")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(width: JunoEffortPanelMetrics.width, height: ComposerModelChip.retryHeight)
        }
    }

    /// The retry popover's height: one row.
    nonisolated static let retryHeight: CGFloat = 56
}
