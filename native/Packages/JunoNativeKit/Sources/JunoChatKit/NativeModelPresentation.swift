import Foundation

/// Formatting shared by every surface that lists models. Kept free of SwiftUI
/// so the rules — and the "never invent a value" guarantees — stay testable.
public enum NativeModelPresentation {
    /// "1M" / "200K", matching `formatContext` on the web so the same model
    /// reads identically in the app and in the browser.
    public static func contextWindow(_ tokens: Int) -> String {
        let million = 1_000_000
        if tokens >= million {
            let value = Double(tokens) / Double(million)
            return value == value.rounded()
                ? "\(Int(value))M"
                : String(format: "%.1fM", value)
        }
        return "\(Int((Double(tokens) / 1000).rounded()))K"
    }

    /// The relative-cost glyph the web selector uses: one "$" per cost tier.
    /// Nil when the server published no pricing (Auto), so nothing is guessed.
    public static func costGlyph(_ pricing: NativeModelPricing?) -> String? {
        switch pricing?.priceClass {
        case "economy": "$"
        case "standard": "$$"
        case "premium": "$$$"
        default: nil
        }
    }

    /// "$3.00 in · $15.00 out per million tokens", or nil without real pricing.
    public static func priceDetail(_ pricing: NativeModelPricing?) -> String? {
        guard let pricing else { return nil }
        return "\(money(pricing.inputPerMillion)) in · \(money(pricing.outputPerMillion)) out per 1M tokens"
    }

    private static func money(_ value: Double) -> String {
        value >= 1 && value == value.rounded()
            ? String(format: "$%.0f", value)
            : String(format: "$%.2f", value)
    }

    /// "pro" → "Pro". Plan names arrive lowercased from the manifest.
    public static func planName(_ raw: String) -> String {
        guard let first = raw.first else { return raw }
        return first.uppercased() + raw.dropFirst()
    }

    /// The one-line reason a model cannot be picked, or nil when it can.
    public static func unavailabilityReason(
        _ model: NativeChatModelOption
    ) -> String? {
        switch model.unavailability {
        case nil: nil
        case .comingSoon: "Coming soon"
        case .requiresPlan(let plan): "Requires \(planName(plan))"
        case .notAChatModel: "Not available in chat"
        }
    }

    /// The capability chips to show for a model — only ones the server actually
    /// reported. An empty result means the model reported no capabilities, not
    /// that they were omitted for space.
    public static func capabilityChips(
        _ model: NativeChatModelOption
    ) -> [NativeModelCapabilityChip] {
        var chips: [NativeModelCapabilityChip] = []
        if model.supportsReasoning { chips.append(.reasoning) }
        if model.supportsVision { chips.append(.vision) }
        if model.supportsWebSearch { chips.append(.search) }
        if model.supportsTools { chips.append(.tools) }
        return chips
    }
}

public enum NativeModelCapabilityChip: String, Identifiable, CaseIterable, Sendable {
    case reasoning
    case vision
    case search
    case tools

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .reasoning: "Reasoning"
        case .vision: "Vision"
        case .search: "Search"
        case .tools: "Tools"
        }
    }

    /// SF Symbols are right for capabilities — these are Apple-platform concepts
    /// (a magnifier, an eye), not brands. Provider identity uses real logos.
    public var systemImage: String {
        switch self {
        case .reasoning: "brain"
        case .vision: "eye"
        case .search: "globe"
        case .tools: "wrench.and.screwdriver"
        }
    }
}
