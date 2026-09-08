import Foundation

/// How hard a research run works, decided from the model and the thinking
/// effort the person already chose.
///
/// There is no separate depth control on any platform. A person who picks a
/// frontier model and turns thinking to max has said what they want — the
/// most thorough answer the product can give — and asking them to say it again
/// in a second menu is the kind of duplicate decision that gets left on its
/// default. The composer shows the depth it derived on the research chip so
/// it is never a surprise, and the server derives the same answer from the
/// same inputs (`src/lib/research/auto-effort.ts`) so the run cannot disagree
/// with the chip.
///
/// The score is the model's price class (the capability proxy the catalog
/// already carries) plus the effort rung, plus one for GPT Pro execution.
/// Keep the table in step with the web's: the two are the same function.
public enum NativeResearchEffort: String, CaseIterable, Sendable, Identifiable {
    case quick
    case standard
    case deep
    case max

    public var id: String { rawValue }

    /// The single word on the chip.
    public var label: String {
        switch self {
        case .quick: String(localized: "Quick")
        case .standard: String(localized: "Standard")
        case .deep: String(localized: "Deep")
        case .max: String(localized: "Max")
        }
    }

    /// One line under the label: who goes out and how much they read.
    /// Mirrors `RESEARCH_TIERS` on the server; retune both together.
    public var summary: String {
        switch self {
        case .quick: String(localized: "1 researcher · up to 40 pages · ~2 min")
        case .standard: String(localized: "3 researchers · up to 120 pages · ~5 min")
        case .deep: String(localized: "5 researchers · up to 220 pages · ~10 min")
        case .max: String(localized: "8 researchers · up to 320 pages · ~15 min")
        }
    }

    /// What the tier is for, for the picker's explanatory line.
    public var note: String {
        switch self {
        case .quick: String(localized: "A focused pass for a narrow question")
        case .standard: String(localized: "A small team, several angles")
        case .deep: String(localized: "A full team with follow-up rounds")
        case .max: String(localized: "Everything the tier allows, for hard questions")
        }
    }

    /// The depth a run gets for these choices.
    ///
    /// - Parameters:
    ///   - priceClass: The catalog's `economy` / `standard` / `premium`. Nil
    ///     (auto mode, or a model without pricing) counts as the middle.
    ///   - reasoningEffort: The thinking level, nil where the model has no
    ///     control. A model with no effort control still thinks; it gets the
    ///     middle rung rather than the floor so a strong non-reasoning model
    ///     is not sent out as a quick pass.
    ///   - proMode: GPT Pro execution.
    public static func derived(
        priceClass: String?,
        reasoningEffort: NativeReasoningEffort?,
        proMode: Bool
    ) -> NativeResearchEffort {
        let tier: Int =
            switch priceClass {
            case "economy": 1
            case "premium": 3
            default: 2
            }
        let rung: Int =
            switch reasoningEffort {
            case .none: 1
            case .minimal, .low: 0
            case .medium: 1
            case .high: 2
            case .xhigh, .max: 3
            }
        let score = tier + rung + (proMode ? 1 : 0)
        if score >= 6 { return .max }
        if score >= 4 { return .deep }
        if score >= 2 { return .standard }
        return .quick
    }
}
