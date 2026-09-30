import Foundation

/// What a session has spent, per model, kept with the session in the store.
///
/// Per model because a session can be served by more than one — the reader
/// switches, or a fallback answers — and each is priced by its own rates.
/// Sub-agents' calls are added to the session that delegated them, so the
/// figure is what the reader's request cost, not only its parent's steps.
public struct SessionUsageLedger: Equatable, Codable, Sendable {
    /// Keyed by model id; calls that named none are under
    /// ``unattributedModel``.
    public private(set) var byModel: [String: ModelUsageTotals] = [:]

    public static let unattributedModel = ""

    public init() {}

    /// Everything, across models.
    public var total: ModelUsageTotals {
        byModel.values.reduce(into: ModelUsageTotals()) { $0.add($1) }
    }

    public var isEmpty: Bool { total.requests == 0 }

    public mutating func record(_ usage: ModelCallUsage) {
        byModel[usage.modelID ?? Self.unattributedModel, default: ModelUsageTotals()].record(usage)
    }

    public mutating func add(_ other: SessionUsageLedger) {
        for (model, totals) in other.byModel {
            byModel[model, default: ModelUsageTotals()].add(totals)
        }
    }

    /// The estimated cost, in the rates' currency, or nil when no model the
    /// session used has a published price. An estimate for the reader: the
    /// server prices every call from the provider's own usage, and that is
    /// what is billed.
    public func estimatedCost(pricing: (String) -> CodeUsagePricing?) -> Double? {
        var cost = 0.0
        var priced = false
        for (model, totals) in byModel {
            guard let rates = pricing(model) else { continue }
            cost += rates.cost(of: totals)
            priced = true
        }
        return priced ? cost : nil
    }
}

/// A model's published rates, and what its provider charges for cached input
/// relative to fresh input.
public struct CodeUsagePricing: Equatable, Sendable {
    public let inputPerMillion: Double
    public let outputPerMillion: Double
    /// A cache read's price as a fraction of the input rate.
    public let cacheReadMultiplier: Double
    /// A cache write's price as a fraction of the input rate.
    public let cacheWriteMultiplier: Double

    public init(
        inputPerMillion: Double,
        outputPerMillion: Double,
        cacheReadMultiplier: Double,
        cacheWriteMultiplier: Double
    ) {
        self.inputPerMillion = inputPerMillion
        self.outputPerMillion = outputPerMillion
        self.cacheReadMultiplier = cacheReadMultiplier
        self.cacheWriteMultiplier = cacheWriteMultiplier
    }

    /// The published rates with the cache multipliers the model's provider
    /// documents: Anthropic reads at a tenth and writes (five-minute entries,
    /// the kind Juno asks for) at a quarter over; OpenAI's current models read
    /// at a tenth, earlier ones at a quarter or a half; Google at a quarter;
    /// DeepSeek at a tenth. A provider with no documented discount is priced
    /// at the full input rate, which overstates rather than understates.
    public static func forModel(
        _ modelID: String,
        providerID: String,
        inputPerMillion: Double,
        outputPerMillion: Double
    ) -> CodeUsagePricing {
        let provider = providerID.lowercased()
        let model = modelID.lowercased()
        let read: Double
        let write: Double
        switch provider {
        case "anthropic":
            (read, write) = (0.1, 1.25)
        case "openai":
            if model.contains("gpt-4o") || model.contains("o1") {
                read = 0.5
            } else if model.contains("gpt-4.1") {
                read = 0.25
            } else {
                read = 0.1
            }
            write = 1
        case "google":
            (read, write) = (0.25, 1)
        case "deepseek":
            (read, write) = (0.1, 1)
        default:
            (read, write) = (1, 1)
        }
        return CodeUsagePricing(
            inputPerMillion: inputPerMillion,
            outputPerMillion: outputPerMillion,
            cacheReadMultiplier: read,
            cacheWriteMultiplier: write
        )
    }

    public func cost(of totals: ModelUsageTotals) -> Double {
        let perToken = inputPerMillion / 1_000_000
        return Double(totals.freshInputTokens) * perToken
            + Double(totals.cacheReadTokens) * perToken * cacheReadMultiplier
            + Double(totals.cacheWriteTokens) * perToken * cacheWriteMultiplier
            + Double(totals.outputTokens) * outputPerMillion / 1_000_000
    }
}
