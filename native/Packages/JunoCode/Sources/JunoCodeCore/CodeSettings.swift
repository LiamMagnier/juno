import Foundation

/// One Juno Code settings file, as written on disk.
///
/// Three of them layer, lowest first, the arrangement Claude Code made
/// familiar:
///
/// 1. `~/.juno/settings.json` — the reader's own, every project;
/// 2. `<project>/.juno/settings.json` — the team's, checked in;
/// 3. `<project>/.juno/settings.local.json` — the reader's, for one project,
///    kept out of Git.
///
/// Every field is optional so a file says only what it means to change. Lists
/// (permission rules) accumulate across files; everything else is decided by
/// the closest file that sets it.
public struct CodeSettingsFile: Codable, Equatable, Sendable {
    public var permissions: Permissions?
    /// Variables every command the agent runs receives. Never a place for
    /// secrets the model should not see: commands can print them.
    public var env: [String: String]?
    public var sandbox: Sandbox?
    public var agent: Agent?
    public var git: Git?
    /// Standing instructions added to every session's system prompt.
    public var instructions: String?
    /// Hooks, in Claude Code's shape. Kept as the JSON the reader wrote:
    /// `HookConfigurationParser` is what reads it, and holding it here is what
    /// stops the Settings window from erasing it when it saves an unrelated
    /// change to the same file.
    public var hooks: JSONValue?
    /// Claude Code's switch for turning hooks off at once. In a project's
    /// file it reaches only that project's hooks; see `HookDiscovery`.
    public var disableAllHooks: Bool?

    public init(
        permissions: Permissions? = nil,
        env: [String: String]? = nil,
        sandbox: Sandbox? = nil,
        agent: Agent? = nil,
        git: Git? = nil,
        instructions: String? = nil,
        hooks: JSONValue? = nil,
        disableAllHooks: Bool? = nil
    ) {
        self.permissions = permissions
        self.env = env
        self.sandbox = sandbox
        self.agent = agent
        self.git = git
        self.instructions = instructions
        self.hooks = hooks
        self.disableAllHooks = disableAllHooks
    }

    public struct Permissions: Codable, Equatable, Sendable {
        public var allow: [PermissionRule]?
        public var ask: [PermissionRule]?
        public var deny: [PermissionRule]?
        /// The most a session started from another device may do on this Mac.
        public var remoteCeiling: PermissionMode?

        enum CodingKeys: String, CodingKey {
            case allow, ask, deny, remoteCeiling
        }

        public init(
            allow: [PermissionRule]? = nil,
            ask: [PermissionRule]? = nil,
            deny: [PermissionRule]? = nil,
            remoteCeiling: PermissionMode? = nil
        ) {
            self.allow = allow
            self.ask = ask
            self.deny = deny
            self.remoteCeiling = remoteCeiling
        }

        public init(from decoder: Decoder) throws {
            // One bad rule should not throw away the whole file: an unreadable
            // entry is skipped, the rest still apply.
            let container = try decoder.container(keyedBy: CodingKeys.self)
            allow = Self.lenientRules(container, .allow)
            ask = Self.lenientRules(container, .ask)
            deny = Self.lenientRules(container, .deny)
            remoteCeiling = try? container.decodeIfPresent(PermissionMode.self, forKey: .remoteCeiling)
        }

        private static func lenientRules(
            _ container: KeyedDecodingContainer<CodingKeys>,
            _ key: CodingKeys
        ) -> [PermissionRule]? {
            guard let texts = try? container.decodeIfPresent([String].self, forKey: key) else {
                return nil
            }
            return texts.compactMap(PermissionRule.init(parsing:))
        }
    }

    public struct Sandbox: Codable, Equatable, Sendable {
        /// Whether commands may reach the network at all.
        public var network: Bool?
        /// Extra folders commands may write to, beyond the project and caches.
        public var writablePaths: [String]?

        public init(network: Bool? = nil, writablePaths: [String]? = nil) {
            self.network = network
            self.writablePaths = writablePaths
        }
    }

    public struct Agent: Codable, Equatable, Sendable {
        /// Model turns one run may take before it stops and says so.
        public var maxTurns: Int?
        public var autoCompact: Bool?
        /// Fraction of the context window that triggers compaction.
        public var compactThreshold: Double?
        /// Whether an unavailable model may be swapped for another provider's.
        public var modelFallback: Bool?

        public init(
            maxTurns: Int? = nil,
            autoCompact: Bool? = nil,
            compactThreshold: Double? = nil,
            modelFallback: Bool? = nil
        ) {
            self.maxTurns = maxTurns
            self.autoCompact = autoCompact
            self.compactThreshold = compactThreshold
            self.modelFallback = modelFallback
        }
    }

    public struct Git: Codable, Equatable, Sendable {
        /// Adds a `Co-authored-by: Juno` trailer to commits the agent makes.
        public var coAuthorTrailer: Bool?
        /// Prefix for branches Juno creates, e.g. `juno/`.
        public var branchPrefix: String?

        public init(coAuthorTrailer: Bool? = nil, branchPrefix: String? = nil) {
            self.coAuthorTrailer = coAuthorTrailer
            self.branchPrefix = branchPrefix
        }
    }
}

/// The settings a session actually runs with: every layer applied, every
/// default filled in.
public struct ResolvedCodeSettings: Equatable, Sendable {
    public var rules: PermissionRuleSet
    public var remoteCeiling: PermissionMode
    public var environment: [String: String]
    public var allowsNetwork: Bool
    public var writablePaths: [String]
    public var maxTurns: Int
    public var autoCompact: Bool
    public var compactThreshold: Double
    public var modelFallback: Bool
    public var coAuthorTrailer: Bool
    public var branchPrefix: String
    /// User-level instructions, then project-level, in that order.
    public var instructions: [String]

    public static let defaults = ResolvedCodeSettings(
        rules: .empty,
        remoteCeiling: .askBeforeChanges,
        environment: [:],
        allowsNetwork: true,
        writablePaths: [],
        maxTurns: 200,
        autoCompact: true,
        compactThreshold: 0.80,
        modelFallback: false,
        coAuthorTrailer: true,
        branchPrefix: "juno/",
        instructions: []
    )

    public static let maxTurnsRange = 10...1_000
    public static let compactThresholdRange = 0.50...0.95

    /// Applies `layers` lowest first.
    public static func resolve(_ layers: [CodeSettingsFile]) -> ResolvedCodeSettings {
        var resolved = defaults
        for layer in layers {
            if let permissions = layer.permissions {
                resolved.rules = resolved.rules.merging(
                    PermissionRuleSet(
                        allow: permissions.allow ?? [],
                        ask: permissions.ask ?? [],
                        deny: permissions.deny ?? []
                    )
                )
                if let ceiling = permissions.remoteCeiling {
                    resolved.remoteCeiling = ceiling
                }
            }
            if let env = layer.env {
                resolved.environment.merge(env) { _, closer in closer }
            }
            if let sandbox = layer.sandbox {
                if let network = sandbox.network { resolved.allowsNetwork = network }
                if let paths = sandbox.writablePaths { resolved.writablePaths += paths }
            }
            if let agent = layer.agent {
                if let turns = agent.maxTurns {
                    resolved.maxTurns = min(max(turns, maxTurnsRange.lowerBound), maxTurnsRange.upperBound)
                }
                if let auto = agent.autoCompact { resolved.autoCompact = auto }
                if let threshold = agent.compactThreshold {
                    resolved.compactThreshold = min(
                        max(threshold, compactThresholdRange.lowerBound),
                        compactThresholdRange.upperBound
                    )
                }
                if let fallback = agent.modelFallback { resolved.modelFallback = fallback }
            }
            if let git = layer.git {
                if let trailer = git.coAuthorTrailer { resolved.coAuthorTrailer = trailer }
                if let prefix = git.branchPrefix { resolved.branchPrefix = prefix }
            }
            if let text = layer.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty
            {
                resolved.instructions.append(text)
            }
        }
        return resolved
    }
}
