import Foundation
import JunoCodeCore
import JunoDesignSystem

/// Juno Code's side of the shared model picker.
///
/// Code's own ``ModelOption`` is deliberately thin — the runtime only ever needs
/// an id — so everything the selector shows arrives as a
/// ``JunoModelDescriptor`` built by whoever owns the account's catalog. When no
/// descriptor was supplied this file synthesizes the smallest honest one:
/// the id, the name, and nothing else. It never invents a provider, a price or a
/// capability.

public extension ReasoningEffort {
    /// The same words Chat and the website use for these depths. Code used to
    /// say "Brief / Standard / Extended" for the identical three values, which
    /// meant the same model read differently in two windows of one app.
    var junoLabel: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        }
    }

    /// The longer form VoiceOver reads.
    var junoAccessibilityLabel: String { "Thinking \(junoLabel.lowercased())" }

    /// Depth order, shallowest first. Drives clamping when a model supports a
    /// shorter ladder than the one the session had selected.
    var junoDepth: Int {
        switch self {
        case .low: 0
        case .medium: 1
        case .high: 2
        }
    }

    var junoStop: JunoThinkingStop {
        JunoThinkingStop(
            id: rawValue,
            label: junoLabel,
            accessibilityLabel: junoAccessibilityLabel
        )
    }
}

public extension JunoThinkingLadder {
    /// A ladder over Code's own effort values.
    ///
    /// `efforts` is ordered before use, so a caller cannot produce a slider whose
    /// detents run out of order.
    static func code(
        efforts: [ReasoningEffort],
        modelName: String = ""
    ) -> JunoThinkingLadder {
        JunoThinkingLadder(
            stops: efforts
                .sorted { $0.junoDepth < $1.junoDepth }
                .map(\.junoStop),
            modelName: modelName
        )
    }
}

public extension ModelOption {
    /// The three depths the Code request contract itself defines.
    ///
    /// This is not a claim about any model — it is the set of values
    /// `SessionConfiguration.reasoningEffort` can hold. A model whose catalog
    /// entry publishes a shorter ladder narrows it; a model with no catalog entry
    /// falls back to it, because the session always sends one of these three.
    static var contractReasoningEfforts: [ReasoningEffort] { ReasoningEffort.allCases }

    /// The catalog entry the selector renders, or the minimum honest stand-in
    /// when this option was built from an id and a name alone.
    var descriptor: JunoModelDescriptor {
        if let catalog { return catalog }
        return JunoModelDescriptor(
            id: modelID,
            // No asset resolves for an unknown provider, so the mark falls back
            // to a monogram rather than borrowing someone else's logo.
            providerID: "",
            providerName: "Unknown provider",
            displayName: displayName,
            thinking: thinkingLadder
        )
    }

    /// The thinking stops this model actually offers, in depth order.
    ///
    /// Prefers the **catalog's own ladder** — the one Chat and the website show —
    /// so a model's published depth names and the explanatory caption under the
    /// slider survive into Code. Rebuilding the ladder from bare efforts, which
    /// is all this did before, relabelled every model's depths "Low / Medium /
    /// High" and dropped the caption, so the same model read differently in two
    /// windows of one app.
    ///
    /// Two guards decide when the catalog's ladder can be used verbatim:
    ///
    /// * **Every stop must map to a `ReasoningEffort`.** The session can only
    ///   send the three the Code request contract defines; offering a depth that
    ///   cannot be transmitted would be a control that silently does nothing.
    /// * **It must not be automatic.** A router that picks its own depth sends
    ///   no effort at all, which Code has no way to express — those fall back to
    ///   the contract ladder.
    var thinkingLadder: JunoThinkingLadder {
        if let published = catalog?.thinking,
            !published.isAutomatic,
            !published.stops.isEmpty,
            published.stops.allSatisfy({ ReasoningEffort(rawValue: $0.id) != nil })
        {
            return published
        }
        return .code(efforts: supportedReasoningEfforts, modelName: displayName)
    }

    /// Re-fits a stored effort onto this model: the deepest supported depth at
    /// or below the requested one, or the shallowest if none qualifies.
    ///
    /// Returns nil when the value already fits, so a caller can tell "no change
    /// needed" from "changed to the same thing" and avoid a pointless write.
    func clampingReasoningEffort(_ effort: ReasoningEffort) -> ReasoningEffort? {
        let supported = supportedReasoningEfforts.sorted { $0.junoDepth < $1.junoDepth }
        guard !supported.isEmpty, !supported.contains(effort) else { return nil }
        return supported.last { $0.junoDepth <= effort.junoDepth } ?? supported[0]
    }
}
