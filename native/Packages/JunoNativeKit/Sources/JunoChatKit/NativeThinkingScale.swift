import Foundation

/// One stop on the Thinking control.
///
/// A stop is what the *user* picks; `effort` is what the request carries. The
/// two differ for on/off models, where the single "Thinking" stop is sent as
/// `high` — the value the chat route reads as "on" for those models.
public enum NativeThinkingStop: Equatable, Sendable, Identifiable {
    /// Reasoning disabled — the model answers directly.
    case instant
    /// The single "on" state of an on/off model (no depths to choose from).
    case thinking
    case effort(NativeReasoningEffort)

    public var id: String {
        switch self {
        case .instant: "instant"
        case .thinking: "thinking"
        case .effort(let effort): effort.rawValue
        }
    }

    /// The value to send. `nil` means "omit reasoningEffort".
    public var effort: NativeReasoningEffort? {
        switch self {
        case .instant: nil
        case .thinking: .high
        case .effort(let effort): effort
        }
    }

    public var label: String {
        switch self {
        case .instant: "Off"
        case .thinking: "Thinking"
        case .effort(let effort): effort.label
        }
    }

    /// The longer form used by VoiceOver and the popover's caption.
    public var accessibilityLabel: String {
        switch self {
        case .instant: "Thinking off"
        case .thinking: "Thinking on"
        case .effort(let effort): "Thinking \(effort.label.lowercased())"
        }
    }
}

public extension NativeReasoningEffort {
    var label: String {
        switch self {
        case .minimal: "Minimal"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }

    /// Depth order, shallowest first. Drives clamping when a model supports a
    /// shorter ladder than the one the user had selected.
    var depth: Int {
        switch self {
        case .minimal: 0
        case .low: 1
        case .medium: 2
        case .high: 3
        case .xhigh: 4
        case .max: 5
        }
    }
}

/// The outcome of re-fitting a thinking selection onto a different model.
public struct NativeThinkingAdjustment: Equatable, Sendable {
    public let stop: NativeThinkingStop?
    /// Non-nil only when the selection actually moved — the one line the UI
    /// shows to explain why, so a silent change never surprises the user.
    public let explanation: String?

    public var effort: NativeReasoningEffort? { stop?.effort }
}

/// The exact set of thinking stops one model supports, derived from the
/// server's capability metadata — never from a hard-coded ladder.
///
/// `stops` is empty in three different situations the UI treats differently:
/// a model with no reasoning at all, a model that always reasons with no
/// exposed control, and Auto (`isAutomatic`), which reasons at a depth the
/// server picks per message.
public struct NativeThinkingScale: Equatable, Sendable {
    public let stops: [NativeThinkingStop]
    public let isAutomatic: Bool
    public let modelName: String

    public init(model: NativeChatModelOption) {
        modelName = model.displayName
        isAutomatic = model.choosesReasoningAutomatically
        if model.choosesReasoningAutomatically || !model.supportsReasoning {
            stops = []
        } else if model.isOnOffReasoningOnly {
            stops = model.canDisableReasoning ? [.instant, .thinking] : [.thinking]
        } else {
            var built: [NativeThinkingStop] = model.canDisableReasoning ? [.instant] : []
            built.append(contentsOf: model.supportedReasoningEfforts
                .sorted { $0.depth < $1.depth }
                .map(NativeThinkingStop.effort))
            // An always-on model with no published tiers has nothing to choose:
            // the provider's own default is the only reachable state.
            stops = built.count > 1 ? built : []
        }
    }

    /// Whether the composer should show a Thinking control at all.
    public var isPresentable: Bool { isAutomatic || !stops.isEmpty }

    /// Whether the control can be dragged (Auto is shown, but not adjustable).
    public var isAdjustable: Bool { stops.count > 1 }

    public func index(of effort: NativeReasoningEffort?) -> Int? {
        stops.firstIndex { $0.effort == effort }
    }

    public func stop(at index: Int) -> NativeThinkingStop? {
        stops.indices.contains(index) ? stops[index] : nil
    }

    /// The stop a freshly selected model starts on. Off wherever the model
    /// allows it — deep thinking is slower and pricier, so it is opted into.
    /// An always-on model starts at a sensible middle tier instead, matching
    /// `defaultReasoning` on the web so both clients open on the same value.
    public var defaultStop: NativeThinkingStop? {
        guard let first = stops.first else { return nil }
        if first == .instant { return .instant }
        if stops.contains(.effort(.medium)) { return .effort(.medium) }
        return stop(at: min(1, stops.count - 1))
    }

    /// Re-fits `effort` onto this model. Returns the nearest supported stop at
    /// or below the requested depth, and an explanation whenever the value moved.
    public func adjusting(_ effort: NativeReasoningEffort?) -> NativeThinkingAdjustment {
        if isAutomatic {
            return NativeThinkingAdjustment(
                stop: nil,
                explanation: effort == nil
                    ? nil
                    : "Auto picks the thinking depth for each message."
            )
        }
        guard !stops.isEmpty else {
            return NativeThinkingAdjustment(
                stop: nil,
                explanation: effort == nil
                    ? nil
                    : "\(modelName) has no thinking levels to set."
            )
        }
        if let match = stops.first(where: { $0.effort == effort }) {
            return NativeThinkingAdjustment(stop: match, explanation: nil)
        }
        // On/off models have one depth-less "on" state. Any requested depth maps
        // to it — the same collapse the chat route performs server-side.
        if stops.contains(.thinking) {
            guard effort != nil else {
                return NativeThinkingAdjustment(
                    stop: .thinking,
                    explanation: "\(modelName) always thinks."
                )
            }
            return NativeThinkingAdjustment(
                stop: .thinking,
                explanation: "\(modelName) has a single thinking mode."
            )
        }
        guard let requested = effort else {
            // The previous selection was Off and this model always thinks.
            let fallback = stops[0]
            return NativeThinkingAdjustment(
                stop: fallback,
                explanation: "\(modelName) always thinks — set to \(fallback.label)."
            )
        }
        let atOrBelow = stops.filter { stop in
            guard let candidate = stop.effort else { return false }
            return candidate.depth <= requested.depth
        }
        let fallback = atOrBelow.last ?? stops[0]
        return NativeThinkingAdjustment(
            stop: fallback,
            explanation: "\(modelName) supports up to \(deepestLabel) — thinking set to \(fallback.label)."
        )
    }

    private var deepestLabel: String {
        stops.last?.label ?? "no thinking"
    }
}
