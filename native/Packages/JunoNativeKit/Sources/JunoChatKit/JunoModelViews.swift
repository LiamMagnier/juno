import JunoDesignSystem
import SwiftUI

/// Chat's bridge to the shared model picker and Thinking control.
///
/// The views themselves moved down to JunoDesignSystem, because Juno Code is a
/// package that cannot import the app *or* the chat stack, and a third copy of a
/// 400-line selector is how two products stop looking like one. What is left
/// here is the adapter: `NativeChatModelOption` and `NativeThinkingScale`
/// projected onto the presentation-neutral ``JunoModelDescriptor`` and
/// ``JunoThinkingLadder`` those views take.
///
/// The wrapper views below keep their old names and signatures on purpose — the
/// desktop and mobile chat surfaces call them today, and renaming a control at
/// the same time as moving it makes both changes unreviewable.

// MARK: - Adapters

public extension NativeThinkingScale {
    /// This scale as the shared control sees it. Stop ids are
    /// `NativeThinkingStop.id`, so the mapping back is exact.
    var junoLadder: JunoThinkingLadder {
        JunoThinkingLadder(
            stops: stops.map {
                JunoThinkingStop(
                    id: $0.id,
                    label: $0.label,
                    accessibilityLabel: $0.accessibilityLabel
                )
            },
            isAutomatic: isAutomatic,
            modelName: modelName,
            caption: caption,
            fastModeRateMultiplier: fastModeRateMultiplier,
            supportsProMode: supportsProMode
        )
    }

    /// The one line under the slider that explains a ladder the reader would
    /// otherwise have to infer from the number of detents.
    private var caption: String? {
        switch stops.count {
        case 2 where stops.contains(.thinking):
            "This model has one thinking mode rather than depths."
        case 2:
            "This model offers two levels."
        default:
            nil
        }
    }

    /// The stop id for an effort, for driving the shared control from a stored
    /// `NativeReasoningEffort`.
    func stopID(for effort: NativeReasoningEffort?) -> String? {
        stops.first { $0.effort == effort }?.id
    }

    /// The effort a stop id sends. Nil means "omit reasoningEffort".
    func effort(forStopID id: String?) -> NativeReasoningEffort? {
        guard let id else { return nil }
        return stops.first { $0.id == id }?.effort
    }
}

public extension NativeChatModelOption {
    /// This manifest row as the shared selector sees it.
    ///
    /// Every value is copied or formatted from something the server published.
    /// Nothing is filled in — a model without pricing has no cost glyph, and a
    /// router without grades gets no meters.
    var junoDescriptor: JunoModelDescriptor {
        JunoModelDescriptor(
            id: id,
            providerID: providerID,
            providerName: providerName,
            displayName: displayName,
            summary: summary,
            highlights: highlights,
            modality: JunoModelModality(raw: modality.isEmpty ? "chat" : modality),
            isLegacy: isLegacy,
            released: released,
            contextWindowTokens: contextWindowTokens,
            costGlyph: NativeModelPresentation.costGlyph(pricing),
            priceDetail: NativeModelPresentation.priceDetail(pricing),
            speedGrade: grades?.speed,
            intelligenceGrade: grades?.intelligence,
            capabilities: NativeModelPresentation.capabilityChips(self),
            thinking: NativeThinkingScale(model: self).junoLadder,
            unavailabilityReason: NativeModelPresentation.unavailabilityReason(self),
            deprecationNote: deprecationNote,
            retiresOn: retiresOn,
            choosesThinkingAutomatically: choosesReasoningAutomatically
        )
    }
}

// MARK: - Chat-side wrappers

public struct JunoCapabilityChips: View {
    private let model: NativeChatModelOption
    private let compact: Bool

    public init(model: NativeChatModelOption, compact: Bool = false) {
        self.model = model
        self.compact = compact
    }

    public var body: some View {
        JunoModelCapabilityChips(
            capabilities: NativeModelPresentation.capabilityChips(model),
            compact: compact
        )
    }
}

public struct JunoModelDetailView: View {
    private let model: NativeChatModelOption
    private let showsHeader: Bool

    public init(model: NativeChatModelOption, showsHeader: Bool = true) {
        self.model = model
        self.showsHeader = showsHeader
    }

    public var body: some View {
        JunoModelSpecSheet(model: model.junoDescriptor, showsHeader: showsHeader)
    }
}

public struct JunoThinkingPopover: View {
    private let scale: NativeThinkingScale
    @Binding private var effort: NativeReasoningEffort?
    private let width: CGFloat
    private let fastMode: Binding<Bool>?
    private let proMode: Binding<Bool>?

    /// The two mode bindings default to nil so every existing call site keeps
    /// compiling and keeps rendering exactly what it did — a surface that has no
    /// state for these toggles must not be given them.
    public init(
        scale: NativeThinkingScale,
        effort: Binding<NativeReasoningEffort?>,
        width: CGFloat,
        fastMode: Binding<Bool>? = nil,
        proMode: Binding<Bool>? = nil
    ) {
        self.scale = scale
        _effort = effort
        self.width = width
        self.fastMode = fastMode
        self.proMode = proMode
    }

    /// Whether this popover will draw the Flash/Pro row, so a macOS caller can
    /// state the matching fixed height. iOS self-sizes and can ignore it.
    public var showsModeToggles: Bool {
        (fastMode != nil && scale.fastModeRateMultiplier != nil)
            || (proMode != nil && scale.supportsProMode)
    }

    public var body: some View {
        JunoThinkingPanel(
            ladder: scale.junoLadder,
            stopID: scale.junoStopIDBinding(for: $effort),
            width: width,
            fastMode: fastMode,
            proMode: proMode
        )
    }
}

public struct JunoThinkingSlider: View {
    private let scale: NativeThinkingScale
    @Binding private var effort: NativeReasoningEffort?

    public init(scale: NativeThinkingScale, effort: Binding<NativeReasoningEffort?>) {
        self.scale = scale
        _effort = effort
    }

    public var body: some View {
        JunoThinkingTrack(
            ladder: scale.junoLadder,
            stopID: scale.junoStopIDBinding(for: $effort)
        )
    }
}

private extension NativeThinkingScale {
    /// Projects an effort binding onto a stop-id binding, which is what the
    /// shared control writes. The round trip is lossless because a stop id *is*
    /// a `NativeThinkingStop.id`.
    func junoStopIDBinding(
        for effort: Binding<NativeReasoningEffort?>
    ) -> Binding<String?> {
        Binding(
            get: { self.stopID(for: effort.wrappedValue) },
            set: { id in effort.wrappedValue = self.effort(forStopID: id) }
        )
    }
}
