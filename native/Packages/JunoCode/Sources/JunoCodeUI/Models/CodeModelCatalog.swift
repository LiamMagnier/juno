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
        case .minimal: "Minimal"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }

    /// The longer form VoiceOver reads.
    var junoAccessibilityLabel: String { "Thinking \(junoLabel.lowercased())" }

    /// Depth order, shallowest first. Drives clamping when a model supports a
    /// shorter ladder than the one the session had selected.
    ///
    /// Read off `allCases` rather than written out as a second table, for the
    /// reason the website gives where it does the same thing (`reasoningGlow`
    /// in `src/lib/model-metrics.ts`): a parallel list of these literals is a
    /// thing that drifts, and a tier that silently lands at the wrong depth is
    /// exactly the quiet wrongness that hid `max` in the first place. The enum's
    /// declaration order *is* depth order, so this cannot disagree with it.
    var junoDepth: Int {
        ReasoningEffort.allCases.firstIndex(of: self) ?? 0
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
    /// The depths offered for a model that publishes no ladder of its own.
    ///
    /// Deliberately **not** `ReasoningEffort.allCases`. The enum spans the
    /// website's full six tiers so a published ladder can be carried verbatim,
    /// but this value is the opposite kind of thing: a guess, used only when the
    /// manifest told us nothing about the model. `minimal`, `xhigh` and `max` are
    /// each rejected outright by some providers — `max` 400s on Mistral, `xhigh`
    /// on GPT-5.1, `minimal` on the Codex line — so offering them to a model we
    /// know nothing about would be advertising a depth that fails on send.
    ///
    /// Low / medium / high is the band every reasoning provider in the caps
    /// table accepts some subset of, and it is what Code has always sent. A model
    /// whose catalog entry publishes a real ladder never reaches this.
    static var contractReasoningEfforts: [ReasoningEffort] { [.low, .medium, .high] }

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
    ///   send depths the Code request contract defines; offering one that cannot
    ///   be transmitted would be a control that silently does nothing.
    /// * **It must not be automatic.** A router picks its own depth per message,
    ///   which Code has no way to express.
    ///
    /// When neither holds and this model published no transmissible depths, the
    /// answer is ``JunoThinkingLadder/unavailable`` — no control at all. That is
    /// the honest rendering for a model that does not reason, always reasons, or
    /// only has an on/off switch, and `JunoThinkingButton` already draws nothing
    /// for an empty ladder. It used to synthesize low/medium/high here instead,
    /// which put a depth slider on models with no depths.
    ///
    /// The **"instant" stop is carried through**, not required to map. It has no
    /// `ReasoningEffort` because it is the absence of one: selecting it sets the
    /// session's effort to nil and the request goes out with no thinking parameter.
    /// Requiring every stop to map is what used to sink the whole published ladder
    /// for any model offering an off state — over half the catalog — and take the
    /// off state with it.
    var thinkingLadder: JunoThinkingLadder {
        if let published = catalog?.thinking,
            !published.isAutomatic,
            !published.stops.isEmpty,
            published.stops.allSatisfy({
                $0.id == JunoThinkingLadder.instantStopID
                    || ReasoningEffort(rawValue: $0.id) != nil
            })
        {
            return published
        }
        guard !supportedReasoningEfforts.isEmpty else { return .unavailable }
        return .code(efforts: supportedReasoningEfforts, modelName: displayName)
    }

    /// Whether this model offers the website's "Instant" — thinking off.
    var canDisableThinking: Bool {
        catalog?.thinking.canDisableThinking ?? false
    }

    /// Re-fits a stored effort onto this model, including the off state.
    ///
    /// Returns `.some(nil)` to mean "change it to Instant" and `nil` to mean "it
    /// already fits" — the double optional is ugly to read but it is the
    /// distinction the caller needs, and it is why this is separate from
    /// ``clampingReasoningEffort(_:)``.
    func refittingEffort(_ effort: ReasoningEffort?) -> ReasoningEffort?? {
        guard let effort else {
            // Instant is only valid where the model publishes it. A model that
            // always reasons has to be given a depth back.
            return canDisableThinking ? nil : .some(supportedReasoningEfforts.first)
        }
        guard let clamped = clampingReasoningEffort(effort) else { return nil }
        return .some(clamped)
    }

    /// Whether a thinking parameter may be put on the wire for this model at all.
    ///
    /// False means *omit every thinking field*, not "send a default". Sending one
    /// anyway is a documented hard 400 on the Mistral line, the non-reasoning
    /// OpenAI snapshots and the non-thinking Qwen models.
    var takesThinkingParameter: Bool {
        !supportedReasoningEfforts.isEmpty
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
