import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeLocal

extension CodeV2AlevrCatalog {
    /// The Alevr models the Mac's own Code picker lists, in its order, as the
    /// env server's Alevr engine takes them (`env.configure` › `backend.models`):
    /// the agent proxy path and wire for each (the same resolver the Mac's own
    /// engine uses), and the picker's thinking levels, default level and best
    /// model, so a paired phone lists exactly what the Mac lists.
    public static func backendModels(from models: [ModelOption]) -> [EnvBackendModel] {
        let byID = Dictionary(models.map { ($0.modelID, $0) }, uniquingKeysWith: { first, _ in first })
        return displayModels(models).compactMap { model -> EnvBackendModel? in
            guard let route = CodeModelProviderResolver.default.route(for: model.id) else { return nil }
            let option = byID[model.id]
            let levels = model.effortLevels ?? []
            // The picker's own default (declared, else Instant as `none`).
            let declared = model.defaultEffort
            return EnvBackendModel(
                provider: route.providerID,
                providerName: option?.catalog?.providerName,
                kind: route.wireProtocol == .anthropicMessages ? "anthropic" : "openai",
                model: route.providerModelID,
                label: model.label,
                available: option?.catalog?.unavailabilityReason == nil,
                contextWindow: option?.catalog?.contextWindowTokens,
                api: route.wireProtocol == .openAIResponses ? "responses" : nil,
                effortLevels: levels.isEmpty ? nil : levels,
                defaultEffort: declared.flatMap { levels.contains($0) ? $0 : nil },
                isDefault: model.isDefault
            )
        }
    }
}
