import Foundation
import Observation
import JunoCodeCore

/// Where a new task runs.
///
/// Four choices, drawn as one row of selectors on the New task screen. The two
/// local ones are this Mac's — a session in the checkout, or in an isolated Git
/// worktree beside it — and the two remote ones are the account's runners. It is
/// deliberately one enum rather than the launch target plus a "use a worktree"
/// switch, because Codex and Claude Code both present it as one decision and a
/// reader arriving from either should find the same shape here.
public enum CodeEnvironmentChoice: String, CaseIterable, Identifiable, Sendable, Codable {
    case local
    case worktree
    case cloud
    case device

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .local: "Local"
        case .worktree: "Worktree"
        case .cloud: "Cloud"
        case .device: "Device"
        }
    }

    public var detail: String {
        switch self {
        case .local: "Works directly in the checkout on this Mac."
        case .worktree: "Works in an isolated Git worktree beside the checkout."
        case .cloud: "Runs on Juno's cloud runner and opens a pull request."
        case .device: "Runs on another computer signed in to your account."
        }
    }

    /// Whether the session's files live on this Mac.
    public var isLocal: Bool {
        switch self {
        case .local, .worktree: true
        case .cloud, .device: false
        }
    }

    /// The two that can be defaults. Cloud and Device need a repository or a
    /// computer chosen per task, so they are never a standing preference.
    public static let defaultable: [CodeEnvironmentChoice] = [.local, .worktree]
}

/// The reader's standing preferences for Juno Code, read when a task is created.
///
/// Every value here is a *default* — the New task screen shows it, and the
/// reader can override it for one task without changing the preference. That
/// is the difference between this and the session's own configuration: a
/// session records what it was started with; this records what the next one
/// should start with.
///
/// Backed by `UserDefaults` rather than the account's synced settings, because
/// a worktree location is a path on this Mac and a disabled MCP server is a
/// decision about this machine's processes. Neither means anything on the
/// phone.
@MainActor
@Observable
public final class CodeDefaults {
    public static let shared = CodeDefaults()

    public enum Key {
        public static let permissionMode = "juno.code.defaults.permission-mode"
        public static let modelID = "juno.code.defaults.model-id"
        public static let reasoningEffort = "juno.code.defaults.reasoning-effort"
        public static let environment = "juno.code.defaults.environment"
        public static let worktreeLocation = "juno.code.defaults.worktree-location"
        public static let disabledMCPServers = "juno.code.defaults.disabled-mcp-servers"
        public static let disabledHooks = "juno.code.defaults.disabled-hooks"
        public static let disabledSkills = "juno.code.defaults.disabled-skills"
        public static let hookLastRun = "juno.code.defaults.hook-last-run"
    }

    private let store: UserDefaults

    public init(store: UserDefaults = .standard) {
        self.store = store
        permissionMode = store.string(forKey: Key.permissionMode)
            .flatMap(PermissionMode.init(rawValue:)) ?? .askBeforeChanges
        modelID = store.string(forKey: Key.modelID) ?? ""
        reasoningEffort = store.string(forKey: Key.reasoningEffort)
            .flatMap(ReasoningEffort.init(rawValue:))
        environment = store.string(forKey: Key.environment)
            .flatMap(CodeEnvironmentChoice.init(rawValue:)) ?? .local
        worktreeLocation = store.string(forKey: Key.worktreeLocation) ?? ""
        disabledMCPServers = Set(store.stringArray(forKey: Key.disabledMCPServers) ?? [])
        disabledHooks = Set(store.stringArray(forKey: Key.disabledHooks) ?? [])
        disabledSkills = Set(store.stringArray(forKey: Key.disabledSkills) ?? [])
        hookLastRun = (store.dictionary(forKey: Key.hookLastRun) as? [String: Date]) ?? [:]
    }

    /// The permission level a new Code task starts with.
    public var permissionMode: PermissionMode {
        didSet { store.set(permissionMode.rawValue, forKey: Key.permissionMode) }
    }

    /// The model a new task starts with, or empty for "the first available".
    public var modelID: String {
        didSet { store.set(modelID, forKey: Key.modelID) }
    }

    /// The thinking depth a new task starts with; nil sends no thinking
    /// parameter — the website's "Instant".
    public var reasoningEffort: ReasoningEffort? {
        didSet {
            if let reasoningEffort {
                store.set(reasoningEffort.rawValue, forKey: Key.reasoningEffort)
            } else {
                store.removeObject(forKey: Key.reasoningEffort)
            }
        }
    }

    /// Local or Worktree. Cloud and Device are per-task choices and never a
    /// standing default; a stored value naming one is read back as Local.
    public var environment: CodeEnvironmentChoice {
        didSet {
            if !CodeEnvironmentChoice.defaultable.contains(environment) {
                environment = .local
                return
            }
            store.set(environment.rawValue, forKey: Key.environment)
        }
    }

    /// Where isolated worktrees are created. Empty means beside the checkout,
    /// which is what `WorktreeManager` does when told nothing.
    public var worktreeLocation: String {
        didSet { store.set(worktreeLocation, forKey: Key.worktreeLocation) }
    }

    /// MCP servers the reader switched off, by name. A server a repository
    /// declares is offered to the agent unless it is here.
    public var disabledMCPServers: Set<String> {
        didSet { store.set(Array(disabledMCPServers).sorted(), forKey: Key.disabledMCPServers) }
    }

    /// Hooks the reader switched off individually, by hook identifier. The
    /// repository-wide trust switch still governs whether any hook runs at all.
    public var disabledHooks: Set<String> {
        didSet { store.set(Array(disabledHooks).sorted(), forKey: Key.disabledHooks) }
    }

    /// Skills the reader switched off, by skill identifier.
    public var disabledSkills: Set<String> {
        didSet { store.set(Array(disabledSkills).sorted(), forKey: Key.disabledSkills) }
    }

    /// When each hook last ran, keyed by hook identifier.
    public private(set) var hookLastRun: [String: Date] {
        didSet { store.set(hookLastRun, forKey: Key.hookLastRun) }
    }

    public func recordHookRun(id: String, at date: Date = Date()) {
        hookLastRun[id] = date
    }

    public func isMCPServerEnabled(_ name: String) -> Bool {
        !disabledMCPServers.contains(name)
    }

    public func setMCPServer(_ name: String, enabled: Bool) {
        if enabled { disabledMCPServers.remove(name) } else { disabledMCPServers.insert(name) }
    }

    public func isHookEnabled(_ id: String) -> Bool {
        !disabledHooks.contains(id)
    }

    public func setHook(_ id: String, enabled: Bool) {
        if enabled { disabledHooks.remove(id) } else { disabledHooks.insert(id) }
    }

    public func isSkillEnabled(_ id: String) -> Bool {
        !disabledSkills.contains(id)
    }

    public func setSkill(_ id: String, enabled: Bool) {
        if enabled { disabledSkills.remove(id) } else { disabledSkills.insert(id) }
    }

    /// The configuration a new local task starts with, before the reader
    /// changes anything on the New task screen.
    ///
    /// - Parameter availableModels: the account's Code catalog, so a stored
    ///   model that is no longer offered falls back to the first one rather
    ///   than starting a session on a model the transport will refuse.
    public func configuration(
        behavior: AgentBehavior = .code,
        availableModels: [ModelOption]
    ) -> AgentConfiguration {
        let model = availableModels.first { $0.modelID == modelID } ?? availableModels.first
        // `refittingEffort` answers with an outer nil for "no change needed".
        let effort: ReasoningEffort?
        if let model, let refitted = model.refittingEffort(reasoningEffort) {
            effort = refitted
        } else {
            effort = reasoningEffort
        }
        return AgentConfiguration(
            modelID: model?.modelID ?? modelID,
            reasoningEffort: effort,
            behavior: behavior,
            permissionMode: permissionMode,
            location: .local
        )
    }
}
