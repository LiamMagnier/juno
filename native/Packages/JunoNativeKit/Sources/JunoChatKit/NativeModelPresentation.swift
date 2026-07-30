import Foundation
import JunoDesignSystem

/// Formatting shared by every surface that lists models. Kept free of SwiftUI
/// so the rules — and the "never invent a value" guarantees — stay testable.
public enum NativeModelPresentation {
    /// "1M" / "200K", matching `formatContext` on the web so the same model
    /// reads identically in the app and in the browser.
    ///
    /// The rule itself now lives in the design system, where Juno Code can reach
    /// it too; this stays as the name the chat surfaces already call.
    public static func contextWindow(_ tokens: Int) -> String {
        JunoModelFormatting.contextWindow(tokens)
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
        // Derived from the two above rather than reported; see
        // ``JunoModelCapability/computerUse``. Last in the list because it is a
        // Juno Code capability rather than a property of the model on its own.
        if JunoModelCapability.computerUse(
            visionReported: model.supportsVision,
            toolsReported: model.supportsTools
        ) {
            chips.append(.computerUse)
        }
        return chips
    }
}

/// The capability vocabulary moved to the design system so Juno Code can render
/// the same chips. This is the chat-side name for it, kept so the mobile and
/// desktop chat surfaces do not have to be rewritten to say the new one.
public typealias NativeModelCapabilityChip = JunoModelCapability
