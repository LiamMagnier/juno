import Foundation
import JunoCodeCore
import Observation

/// Which Studio threads run on the env server, and as which env session.
///
/// A thread starts on Alevr's own engine (the Swift `AgentOrchestrator`).
/// Choosing a subscription in its composer and sending hands the thread to
/// the env server: from then on the thread's id maps to an env session here,
/// and the window draws it with ``CodeV2EnvSessionView``. Kept in user
/// defaults — a pointer, not content; the env server's own log holds the
/// thread.
@MainActor
@Observable
public final class CodeV2SessionBindings {
    public struct Binding: Codable, Equatable, Sendable {
        public var envSessionId: String
        public var cwd: String
        public var selection: CodeV2.ModelSelection

        public init(envSessionId: String, cwd: String, selection: CodeV2.ModelSelection) {
            self.envSessionId = envSessionId
            self.cwd = cwd
            self.selection = selection
        }
    }

    public static let shared = CodeV2SessionBindings()

    public private(set) var bindings: [String: Binding]
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "juno.code.v2.env-bindings") {
        self.defaults = defaults
        self.key = key
        if let data = defaults.data(forKey: key), let decoded = try? JSONDecoder().decode([String: Binding].self, from: data) {
            bindings = decoded
        } else {
            bindings = [:]
        }
    }

    public func binding(for threadID: String) -> Binding? { bindings[threadID] }

    public func bind(_ threadID: String, to binding: Binding) {
        bindings[threadID] = binding
        persist()
    }

    public func unbind(_ threadID: String) {
        bindings[threadID] = nil
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(bindings) { defaults.set(data, forKey: key) }
    }
}

/// The Alevr engine's half of the v2 composer: how a v2 choice lands on a
/// `SessionController`'s configuration.
public enum CodeV2EngineMapping {
    public static func permission(for mode: CodeV2.RuntimeMode) -> PermissionMode {
        switch mode {
        case .readOnly: .readOnly
        case .ask: .askBeforeChanges
        case .autoEdit, .auto: .workspaceWrite
        case .full: .fullAccess
        }
    }

    public static func runtimeMode(for permission: PermissionMode) -> CodeV2.RuntimeMode {
        switch permission {
        case .readOnly: .readOnly
        case .askBeforeChanges: .ask
        case .workspaceWrite: .autoEdit
        case .fullAccess: .full
        }
    }

    public static func effort(_ level: CodeV2.EffortLevel?) -> ReasoningEffort? {
        guard let level else { return nil }
        switch level {
        case .none: return nil
        case .minimal: return .minimal
        case .low: return .low
        case .medium: return .medium
        case .high: return .high
        case .xhigh: return .xhigh
        case .max: return .max
        }
    }

    public static func level(_ effort: ReasoningEffort?) -> CodeV2.EffortLevel? {
        effort.flatMap { CodeV2.EffortLevel(rawValue: $0.rawValue) }
    }

    /// The Alevr selection for a session's current model.
    public static func selection(modelID: String, effort: ReasoningEffort?, contextTokens: Int?) -> CodeV2.ModelSelection {
        CodeV2.ModelSelection(instanceId: "alevr", model: modelID, effort: level(effort), contextTokens: contextTokens)
    }
}

/// What a Studio thread's composer needs to be the v2 composer: the shared
/// choices, every place a model can run, and how to hand the thread to the
/// env server when a subscription is chosen.
@MainActor
public struct CodeV2StudioContext {
    public let composer: CodeV2ComposerModel
    public let directory: CodeV2ProviderDirectory
    /// Hands the thread (with this first message) to the env server.
    public let handoff: (String) -> Void
    public var openConnections: (() -> Void)?
    public var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?

    public init(
        composer: CodeV2ComposerModel,
        directory: CodeV2ProviderDirectory,
        handoff: @escaping (String) -> Void,
        openConnections: (() -> Void)? = nil,
        setup: ((String, CodeV2.ProviderSetupAction) -> Void)? = nil
    ) {
        self.composer = composer
        self.directory = directory
        self.handoff = handoff
        self.openConnections = openConnections
        self.setup = setup
    }
}
