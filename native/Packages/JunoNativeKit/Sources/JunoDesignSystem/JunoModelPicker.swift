import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

// MARK: - The model control
//
// The web's `ModelSelector` (src/components/chat/model-selector.tsx), shared by
// Chat and Code: a chip, and what it opens depends on the model.
//
// A model with thinking levels opens on the effort panel first (the thing most
// turns change); the model's name in that panel opens the full catalogue.
// Every other model (one effort, Auto, image, video, audio) opens the catalogue
// straight away. Both stages hang off one `.popover(item:)`, so changing the
// item from the panel to the catalogue is what dismisses one and presents the
// other: the two are never on screen together, and no timer guesses when the
// first has gone.
//
// The popover is the system's, which on macOS 26 is Liquid Glass; nothing
// inside draws glass of its own.

/// What the chip has open.
public enum JunoModelPickerStage: String, Identifiable, Sendable {
    /// The effort panel: how hard the model in use thinks.
    case effort
    /// The full catalogue.
    case catalog

    public var id: String { rawValue }

    /// The stage the chip opens on: the effort panel for a text model with at
    /// least two rungs to choose between, the catalogue for everything else.
    public static func first(
        for ladder: JunoThinkingLadder,
        modality: JunoModelModality = .chat
    ) -> JunoModelPickerStage {
        modality == .chat && !ladder.isAutomatic && ladder.isAdjustable ? .effort : .catalog
    }
}

/// The two-stage control, generic over the chip's label and the catalogue, so
/// a product with a catalogue of its own (Code v2's provider rail) keeps it
/// and still opens on the shared effort panel first.
///
/// `stage` is a binding so the owner can open a stage directly: a keyboard
/// shortcut, a preview harness.
public struct JunoModelPickerControl<Label: View, Catalog: View>: View {
    @Binding private var stage: JunoModelPickerStage?
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?
    private let fastMode: Binding<Bool>?
    private let modelName: String
    private let modality: JunoModelModality
    private let catalogSize: CGSize
    private let arrowEdge: Edge
    private let isEnabled: Bool
    private let accessibilityValue: String
    private let accessibilityID: String
    private let help: String
    private let label: (Bool) -> Label
    private let catalog: (@escaping () -> Void) -> Catalog

    public init(
        stage: Binding<JunoModelPickerStage?>,
        ladder: JunoThinkingLadder,
        stopID: Binding<String?>,
        fastMode: Binding<Bool>? = nil,
        modelName: String,
        modality: JunoModelModality = .chat,
        catalogSize: CGSize,
        arrowEdge: Edge = .bottom,
        isEnabled: Bool = true,
        accessibilityValue: String,
        accessibilityID: String,
        help: String = "Choose a model and how much it thinks",
        @ViewBuilder label: @escaping (_ isOpen: Bool) -> Label,
        @ViewBuilder catalog: @escaping (_ close: @escaping () -> Void) -> Catalog
    ) {
        _stage = stage
        self.ladder = ladder
        _stopID = stopID
        self.fastMode = fastMode
        self.modelName = modelName
        self.modality = modality
        self.catalogSize = catalogSize
        self.arrowEdge = arrowEdge
        self.isEnabled = isEnabled
        self.accessibilityValue = accessibilityValue
        self.accessibilityID = accessibilityID
        self.help = help
        self.label = label
        self.catalog = catalog
    }

    private var firstStage: JunoModelPickerStage { .first(for: ladder, modality: modality) }

    public var body: some View {
        Button {
            stage = firstStage
        } label: {
            label(stage != nil)
        }
        .buttonStyle(.plain)
        .contentShape(Capsule())
        .fixedSize()
        .disabled(!isEnabled)
        .help(help)
        .accessibilityLabel("Model")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint(firstStage == .effort ? "Opens the thinking effort, then the models" : "Opens the models")
        .accessibilityIdentifier(accessibilityID)
        // Torn down with the chip, always: a popover whose anchor leaves the
        // hierarchy while presented makes AppKit order a child window against
        // a window that is already going (the `NSRemoteView` exception).
        .onDisappear { stage = nil }
        .popover(item: $stage, attachmentAnchor: .rect(.bounds), arrowEdge: arrowEdge) { shown in
            switch shown {
            case .effort:
                JunoEffortPanel(
                    ladder: ladder,
                    stopID: $stopID,
                    modelName: modelName,
                    fastMode: fastMode,
                    // Swapping the item closes the panel and opens the catalogue.
                    openModels: { stage = .catalog }
                )
                .frame(width: JunoEffortPanelMetrics.width, height: JunoEffortPanelMetrics.height)
            case .catalog:
                catalog { stage = nil }
                    .frame(width: catalogSize.width, height: catalogSize.height)
            }
        }
    }
}

/// The chip itself, the web's composer chip (C17): the model's name in the
/// second ink, the effort in the third only when it is not the model's usual
/// one, one chevron. No logo, no pill edge, no border; a tone under the
/// pointer and while open.
public struct JunoModelChipLabel: View {
    private let name: String
    private let effort: String?
    private let isOpen: Bool
    private let isLoading: Bool
    private let mark: Mark?

    /// The lab's mark the chip leads with, in the third ink: the product's
    /// own for Auto, the lab's for every other model (the web's `ModelMark`).
    public enum Mark: Equatable, Sendable {
        case product
        case provider(id: String, name: String)
    }

    @State private var hovered = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(name: String, effort: String? = nil, mark: Mark? = nil, isOpen: Bool, isLoading: Bool = false) {
        self.mark = mark
        self.name = name
        self.effort = effort
        self.isOpen = isOpen
        self.isLoading = isLoading
    }

    /// The chip's height: the web's 32px.
    public static let height: CGFloat = 32

    private var tone: Color {
        if isOpen {
            return colorScheme == .dark ? Color.white.opacity(0.09) : Color.junoForeground.opacity(0.085)
        }
        return Color.junoForeground.opacity(hovered && isEnabled ? 0.045 : 0)
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            switch mark {
            case .product:
                JunoMark(size: 14)
                    .foregroundStyle(Color.junoTertiaryInk)
            case .provider(let id, let providerName):
                JunoProviderMark(providerID: id, providerName: providerName, size: 14)
                    .foregroundStyle(Color.junoTertiaryInk)
                    .opacity(0.85)
            case nil:
                EmptyView()
            }
            HStack(spacing: JunoSpace.tight) {
                Text(name)
                    .foregroundStyle(hovered || isOpen ? Color.junoForeground : Color.junoSecondaryInk)
                if let effort {
                    Text(effort)
                        .foregroundStyle(Color.junoTertiaryInk)
                        .contentTransition(.opacity)
                }
            }
            .junoType(.ui)
            .lineLimit(1)
            .truncationMode(.tail)
            .redacted(reason: isLoading ? .placeholder : [])
            JunoIconView(.chevronDown, size: 14)
                .foregroundStyle(Color.junoTertiaryInk)
        }
        .padding(.leading, JunoSpace.close)
        .padding(.trailing, JunoSpace.snug)
        .frame(height: Self.height)
        .frame(maxWidth: 256)
        .background(Capsule().fill(tone))
        .contentShape(Capsule())
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isOpen)
    }
}

/// The whole control over ``JunoModelDescriptor``s: the chip, the effort
/// panel and ``JunoModelSelector``. What Chat and the Studio composer mount.
public struct JunoModelPicker: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let ladder: JunoThinkingLadder?
    @Binding private var stopID: String?
    private let fastMode: Binding<Bool>?
    private let favorites: Set<String>
    private let toggleFavorite: ((String) -> Void)?
    private let select: (JunoModelDescriptor) -> Void
    private let fallbackName: String
    private let isLoading: Bool
    private let isEnabled: Bool
    private let arrowEdge: Edge
    private let accessibilityID: String
    private let stageBinding: Binding<JunoModelPickerStage?>?

    @State private var ownStage: JunoModelPickerStage?

    /// - Parameters:
    ///   - ladder: the thinking ladder the product can actually send for the
    ///     selected model; nil takes the descriptor's own.
    ///   - stopID: the selected stop's id on that ladder.
    ///   - fastMode: Flash, or nil where the product has no such mode.
    ///   - fallbackName: what the chip reads before the catalogue has
    ///     described the selected model.
    ///   - stage: an outside handle on what is open, for shortcuts.
    public init(
        models: [JunoModelDescriptor],
        selectedModelID: String,
        ladder: JunoThinkingLadder? = nil,
        stopID: Binding<String?>,
        fastMode: Binding<Bool>? = nil,
        favorites: Set<String> = [],
        toggleFavorite: ((String) -> Void)? = nil,
        fallbackName: String = "Choose model",
        isLoading: Bool = false,
        isEnabled: Bool = true,
        arrowEdge: Edge = .bottom,
        accessibilityID: String = "juno.model-picker",
        stage: Binding<JunoModelPickerStage?>? = nil,
        select: @escaping (JunoModelDescriptor) -> Void
    ) {
        self.models = models
        self.selectedModelID = selectedModelID
        self.ladder = ladder
        _stopID = stopID
        self.fastMode = fastMode
        self.favorites = favorites
        self.toggleFavorite = toggleFavorite
        self.fallbackName = fallbackName
        self.isLoading = isLoading
        self.isEnabled = isEnabled
        self.arrowEdge = arrowEdge
        self.accessibilityID = accessibilityID
        self.stageBinding = stage
        self.select = select
    }

    private var selected: JunoModelDescriptor? { models.first { $0.id == selectedModelID } }
    private var name: String { selected?.displayName ?? fallbackName }
    private var resolvedLadder: JunoThinkingLadder { ladder ?? selected?.thinking ?? .unavailable }

    /// The chip's third ink: the effort, only when it is not the model's usual
    /// one ("Opus 5.5 High"). Never for Auto or a model with one effort.
    nonisolated public static func effortLabel(ladder: JunoThinkingLadder, stopID: String?) -> String? {
        guard ladder.isAdjustable, !ladder.isAutomatic,
              let defaultStopID = ladder.defaultStopID,
              let stop = ladder.stop(id: stopID), stop.id != defaultStopID
        else { return nil }
        return stop.label
    }

    public var body: some View {
        let ladder = resolvedLadder
        let effort = Self.effortLabel(ladder: ladder, stopID: stopID)
        JunoModelPickerControl(
            stage: stageBinding ?? $ownStage,
            ladder: ladder,
            stopID: $stopID,
            fastMode: fastMode,
            modelName: name,
            modality: selected?.modality ?? .chat,
            catalogSize: fittedMetrics.size,
            arrowEdge: arrowEdge,
            isEnabled: isEnabled && !models.isEmpty,
            accessibilityValue: [isLoading ? "Loading" : name, effort].compactMap { $0 }.joined(separator: ", "),
            accessibilityID: accessibilityID
        ) { open in
            JunoModelChipLabel(name: name, effort: effort, mark: chipMark, isOpen: open, isLoading: isLoading)
        } catalog: { close in
            JunoModelSelector(
                models: models,
                selectedModelID: selectedModelID,
                metrics: fittedMetrics,
                favorites: favorites,
                toggleFavorite: toggleFavorite,
                select: { model in
                    select(model)
                    close()
                }
            )
        }
    }

    private var chipMark: JunoModelChipLabel.Mark? {
        guard let selected else { return isLoading ? .product : nil }
        if JunoModelSelectorCatalog.isAuto(selected) { return .product }
        return .provider(id: selected.providerID, name: selected.providerName)
    }

    private var fittedMetrics: JunoModelSelectorMetrics {
        #if canImport(AppKit)
        JunoModelSelectorMetrics.standard.clamped(to: NSApp?.keyWindow?.contentView?.bounds.size)
        #else
        JunoModelSelectorMetrics.standard
        #endif
    }
}
