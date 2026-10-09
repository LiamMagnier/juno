import Foundation
import JunoCodeCore
import JunoDesignSystem
import Observation

/// Which engine runs a selection (SPEC §2): Alevr's own Swift orchestrator for
/// the `alevr` and BYOK instances, the local env server for subscriptions.
public enum CodeV2Engine: Equatable, Sendable {
    case alevr
    case envServer

    public static func route(_ selection: CodeV2.ModelSelection) -> CodeV2Engine {
        guard let kind = CodeV2.instanceKind(of: selection.instanceId) else { return .alevr }
        return CodeV2.runsOnEnvServer(kind) ? .envServer : .alevr
    }
}

/// The Alevr catalogue as a provider instance, built from the models the
/// Mac already lists (the native manifest).
public enum CodeV2AlevrCatalog {
    public static func instance(from models: [ModelOption], plan: String? = nil) -> CodeV2.ProviderInstance {
        CodeV2.ProviderInstance(
            id: "alevr",
            kind: .alevr,
            label: "Alevr",
            account: plan.map { CodeV2.ProviderAccount(plan: $0) },
            status: .ready,
            capabilities: CodeV2KnownSubscription.alevrEngineCapabilities,
            models: codingModels(models)
        )
    }

    /// Agentic coding models only, "best for coding" first: the manifest's
    /// curated rank, then intelligence, then name.
    public static func codingModels(_ models: [ModelOption]) -> [CodeV2.ProviderModel] {
        let usable = models.filter { option in
            guard let catalog = option.catalog else { return true }
            return catalog.codeAgentic != false && catalog.modality == .chat
        }
        let ordered = usable.enumerated().sorted { lhs, rhs in
            let a = lhs.element.catalog, b = rhs.element.catalog
            switch (a?.codeRank, b?.codeRank) {
            case let (x?, y?) where x != y: return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            default:
                let ia = a?.intelligenceGrade ?? 0, ib = b?.intelligenceGrade ?? 0
                return ia == ib ? lhs.offset < rhs.offset : ia > ib
            }
        }
        return ordered.map { _, option in
            CodeV2.ProviderModel(
                id: option.modelID,
                label: option.displayName,
                contextTiers: tiers(option),
                effortLevels: option.supportedReasoningEfforts.compactMap { CodeV2.EffortLevel(rawValue: $0.rawValue) },
                isDefault: nil
            )
        }
    }

    /// The manifest's tiers, or one tier from its window and list price.
    static func tiers(_ option: ModelOption) -> [CodeV2.ContextTier]? {
        guard let catalog = option.catalog else { return nil }
        if !catalog.contextTiers.isEmpty {
            return catalog.contextTiers.map {
                CodeV2.ContextTier(
                    tokens: $0.tokens, label: $0.label, inputPerMTok: $0.inputPerMTok, outputPerMTok: $0.outputPerMTok,
                    cachedInputPerMTok: $0.cachedInputPerMTok, note: $0.note, unverified: $0.unverified
                )
            }
        }
        guard let window = catalog.contextWindowTokens else { return nil }
        return [CodeV2.ContextTier(
            tokens: window,
            label: CodeV2ContextMath.label(tokens: window),
            inputPerMTok: catalog.price?.inputPerMillion ?? 0,
            outputPerMTok: catalog.price?.outputPerMillion ?? 0
        )]
    }
}

/// The composer's choices for one thread: the model selection, the
/// orchestration draft, the runtime mode and plan mode (DESIGN §5.6–§5.11).
/// Remembered per user as the default for the next new thread.
@MainActor
@Observable
public final class CodeV2ComposerModel {
    public var selection: CodeV2.ModelSelection {
        didSet {
            if roles.preset == .solo { roles.lead = selection }
            persist()
        }
    }
    public var roles: CodeV2RoleDraft { didSet { persist() } }
    public var runtimeMode: CodeV2.RuntimeMode { didSet { persist() } }
    public var interactionMode: CodeV2.InteractionMode = .default
    /// The client-side Lean option (same rates, earlier compaction).
    public var lean = false
    public var draft = ""
    public var escape = CodeV2DoubleEscape()
    /// "Press Esc again to stop" is showing.
    public var escapeHintVisible = false

    @ObservationIgnored private let defaultsKey: String?

    public init(
        selection: CodeV2.ModelSelection,
        runtimeMode: CodeV2.RuntimeMode = .autoEdit,
        roles: CodeV2RoleDraft? = nil,
        defaultsKey: String? = nil
    ) {
        self.defaultsKey = defaultsKey
        var restored: Stored?
        if let defaultsKey, let data = UserDefaults.standard.data(forKey: defaultsKey) {
            restored = try? JSONDecoder().decode(Stored.self, from: data)
        }
        self.selection = restored?.selection ?? selection
        self.runtimeMode = restored?.runtimeMode ?? runtimeMode
        self.roles = roles ?? restored.map { CodeV2RoleDraft(routing: $0.routing) } ?? CodeV2RoleDraft(lead: selection)
    }

    public var engine: CodeV2Engine { CodeV2Engine.route(selection) }

    /// The routing sent with a turn: nil for a plain solo run.
    public var routing: CodeV2.RoleRouting? {
        roles.preset == .solo && roles.budgetUsd == CodeV2RoleDraft.defaultBudgetUsd ? nil : roles.routing
    }

    public func traitsLabel(fastAvailable: Bool = false) -> String {
        CodeV2Traits.label(effort: selection.effort, contextTokens: selection.contextTokens, fast: selection.fast == true && fastAvailable, lean: lean)
    }

    /// ⌘⇧E.
    public func cycleEffort(levels: [CodeV2.EffortLevel]) {
        selection.effort = CodeV2.EffortLevel.cycled(from: selection.effort, in: levels)
    }

    /// ⌘⇧A.
    public func cycleMode(allowed: [CodeV2.RuntimeMode]) {
        let modes = allowed.isEmpty ? CodeV2.RuntimeMode.allCases : allowed
        let index = modes.firstIndex(of: runtimeMode) ?? -1
        runtimeMode = modes[(index + 1) % modes.count]
    }

    /// Chooses a model; keeps effort when the new model offers it.
    public func choose(instanceId: String, model: CodeV2.ProviderModel) {
        let levels = model.effortLevels ?? []
        let effort = selection.effort.flatMap { levels.contains($0) ? $0 : nil } ?? model.defaultEffort ?? levels.first(where: { $0 == .high }) ?? levels.last
        selection = CodeV2.ModelSelection(
            instanceId: instanceId, model: model.id, effort: effort,
            contextTokens: model.contextTiers.flatMap { CodeV2ContextMath.sorted($0).first?.tokens },
            fast: nil
        )
        lean = false
    }

    private struct Stored: Codable {
        var selection: CodeV2.ModelSelection
        var runtimeMode: CodeV2.RuntimeMode
        var routing: CodeV2.RoleRouting
    }

    private func persist() {
        guard let defaultsKey else { return }
        let stored = Stored(selection: selection, runtimeMode: runtimeMode, routing: roles.routing)
        if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
