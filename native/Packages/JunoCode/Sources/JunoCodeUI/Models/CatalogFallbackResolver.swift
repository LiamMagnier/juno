import Foundation
import JunoCodeRuntime
import JunoDesignSystem

/// Picks a fallback model from the live model catalog when the primary model is
/// unavailable.
///
/// The selection rules:
///
/// 1. Never fall back to the same model or the same provider.
/// 2. Prefer models with tool-calling capability (code agents need tools).
/// 3. Among candidates, prefer the one the catalog lists first — the catalog is
///    already sorted by the website's quality ranking.
///
/// This replaces the hardcoded map that shipped before (Gemini→Claude,
/// Claude→OpenAI, OpenAI→Qwen) which produced model IDs that didn't exist in
/// the catalog, silently failed, and couldn't adapt to what was actually
/// available on the account's plan.
public struct CatalogFallbackResolver: ModelFallbackResolver {
    /// A snapshot of the available models at the time the resolver is created.
    /// This is a value type, so the resolver is Sendable and cheap to pass
    /// across actor boundaries.
    private let availableModelIDs: [(id: String, providerID: String, hasToolUse: Bool)]

    public init(availableModels: [ModelOption]) {
        self.availableModelIDs = availableModels.map { option in
            (
                id: option.modelID,
                providerID: option.catalog?.providerID ?? Self.inferProvider(from: option.modelID),
                hasToolUse: option.catalog?.capabilities.contains(.tools) ?? true
            )
        }
    }

    public func resolveFallback(for currentModelID: String) async -> String? {
        let currentProvider = availableModelIDs
            .first(where: { $0.id == currentModelID })?
            .providerID ?? Self.inferProvider(from: currentModelID)

        // First pass: a tool-capable model from a different provider.
        if let candidate = availableModelIDs.first(where: {
            $0.id != currentModelID
                && $0.providerID != currentProvider
                && $0.hasToolUse
        }) {
            return candidate.id
        }

        // Second pass: any model from a different provider.
        if let candidate = availableModelIDs.first(where: {
            $0.id != currentModelID
                && $0.providerID != currentProvider
        }) {
            return candidate.id
        }

        // Third pass: a different model from the same provider (in case the
        // unavailability was model-specific, not provider-wide).
        if let candidate = availableModelIDs.first(where: {
            $0.id != currentModelID && $0.hasToolUse
        }) {
            return candidate.id
        }

        return nil
    }

    /// Extracts the provider prefix from a compound model ID like
    /// `anthropic:claude-sonnet-5`. Falls back to the whole ID when there
    /// is no colon — models with a flat ID are treated as their own provider
    /// so the "different provider" check still works.
    private static func inferProvider(from modelID: String) -> String {
        if let colon = modelID.firstIndex(of: ":") {
            return String(modelID[..<colon]).lowercased()
        }
        return modelID.lowercased()
    }
}
