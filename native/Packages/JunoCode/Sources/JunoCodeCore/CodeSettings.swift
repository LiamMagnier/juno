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
/// the closest file that sets it, within what that file may decide: a project
/// file widens nothing until the reader approves it and only the reader's own
/// file raises the remote ceiling (see ``ResolvedCodeSettings``), and screen
/// input may be allowed without asking by the reader's own file, the first,
/// alone — a project file's rule for it is dropped even once approved
/// (`withoutScreenInputAllowances`).
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
    /// How far the agent works on its own: the stop check, the soft step
    /// limit, budgets and check-ins. See ``AutonomySettings``.
    public var autonomy: AutonomySettings.Overrides?

    public init(
        permissions: Permissions? = nil,
        env: [String: String]? = nil,
        sandbox: Sandbox? = nil,
        agent: Agent? = nil,
        git: Git? = nil,
        instructions: String? = nil,
        hooks: JSONValue? = nil,
        disableAllHooks: Bool? = nil,
        autonomy: AutonomySettings.Overrides? = nil
    ) {
        self.permissions = permissions
        self.env = env
        self.sandbox = sandbox
        self.agent = agent
        self.git = git
        self.instructions = instructions
        self.hooks = hooks
        self.disableAllHooks = disableAllHooks
        self.autonomy = autonomy
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

/// One settings file as resolution sees it: what it says, where it came from,
/// and whether the reader has approved it as it now reads.
public struct CodeSettingsLayer: Equatable, Sendable {
    public enum Origin: String, Sendable {
        /// `~/.juno/settings.json`: the reader's own, always in force.
        case user
        /// `<project>/.juno/settings.json`: arrives with the repository.
        case project
        /// `<project>/.juno/settings.local.json`: personal, but it lives in
        /// the project, where a clone can carry it and the agent can write it.
        case local
    }

    public var file: CodeSettingsFile
    public var origin: Origin
    /// The reader approved this file's current contents. Their own file
    /// needs no approval.
    public var isApproved: Bool

    public init(_ file: CodeSettingsFile, origin: Origin, isApproved: Bool = false) {
        self.file = file
        self.origin = origin
        self.isApproved = isApproved
    }

    /// Whether this file may widen what the agent can do, rather than only
    /// narrow it.
    public var mayLoosen: Bool { origin == .user || isApproved }
}

extension CodeSettingsFile {
    /// Whether the file asks for anything that widens what the agent may do:
    /// the parts a project file needs the reader's approval for.
    public var loosensAnything: Bool {
        !(permissions?.allow ?? []).isEmpty
            || !(env ?? [:]).isEmpty
            || !(sandbox?.writablePaths ?? []).isEmpty
            || sandbox?.network == true
            || agent?.modelFallback == true
            || autonomy?.raisesAnything == true
    }
}

public extension CodeSettingsFile {
    /// This file as a layer inside a project may apply it: without any allow
    /// rule that would let screen control click, type, press keys or scroll
    /// unasked.
    ///
    /// Screen control acts on the reader's whole Mac, not on the project, so
    /// letting it act without asking is the reader's own decision, and
    /// `~/.juno/settings.json` is the one file no repository can supply. Both
    /// project files can arrive with a clone: the shared one is meant to, and
    /// the ignore line Juno adds for `settings.local.json` keeps the reader's
    /// own out of Git but cannot stop a repository shipping one. A rule in
    /// either would silence every click prompt the moment the reader started
    /// screen control, while the reader believed each click still asked.
    ///
    /// Ask and deny rules stay: they can only make screen control ask more.
    var withoutScreenInputAllowances: CodeSettingsFile {
        guard let allow = permissions?.allow, allow.contains(where: \.coversScreenInput) else {
            return self
        }
        var file = self
        file.permissions?.allow = allow.filter { !$0.coversScreenInput }
        return file
    }
}

/// The settings a session actually runs with: every layer applied, every
/// default filled in.
///
/// **Trust.** A project's files are not the reader's. The checked-in
/// `.juno/settings.json` arrives with a clone, and `settings.local.json`
/// lives in the folder the agent edits. Until the reader approves a project
/// file as it now reads (the approval is kept outside the project, against a
/// digest of the file, so any edit withdraws it), resolution takes only what
/// narrows the agent: deny and ask rules, `network: false`, a lower remote
/// ceiling. Allow rules, the environment, extra writable folders, network
/// access and model fallback wait for approval. Even approved, a project file
/// cannot set the variables that decide which programs run or how they load
/// (``CodeSettingsEnvironment``), nor make anything outside the project
/// writable (``CodeSettingsPaths``).
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
    /// Instructions the reader wrote: their own file's, then their approved
    /// personal project file's. These rank above repository files.
    public var instructions: [String]
    /// Instructions a repository supplied: the checked-in file's, approved
    /// or not, and a personal project file's the reader has not approved.
    /// They are repository data, fenced like `AGENTS.md`, never the reader's
    /// voice: approving a file puts its settings in force, it does not make
    /// its prose the reader's own.
    public var repositoryInstructions: [String]
    /// The stop check, soft step limit, budgets and check-ins. Its step limit
    /// is `maxTurns` unless a file sets `autonomy.stepLimit`.
    public var autonomy: AutonomySettings = .standard

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
        instructions: [],
        repositoryInstructions: []
    )

    public static let maxTurnsRange = 10...1_000
    public static let compactThresholdRange = 0.50...0.95

    /// Applies `layers` lowest first.
    ///
    /// - Parameters:
    ///   - projectRoot: the project the project files belong to; their
    ///     writable folders must lie inside it.
    ///   - homeDirectory: no file may make the home folder, `/`, or anything
    ///     above either writable.
    public static func resolve(
        _ layers: [CodeSettingsLayer],
        projectRoot: URL? = nil,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> ResolvedCodeSettings {
        var resolved = defaults
        var stepLimitSet = false
        for layer in layers {
            let file = layer.file
            let loosens = layer.mayLoosen
            if let autonomy = file.autonomy {
                resolved.autonomy.apply(autonomy, mayLoosen: loosens)
                stepLimitSet = stepLimitSet || autonomy.stepLimit != nil
            }
            if let permissions = file.permissions {
                resolved.rules = resolved.rules.merging(
                    PermissionRuleSet(
                        allow: loosens ? permissions.allow ?? [] : [],
                        ask: permissions.ask ?? [],
                        deny: permissions.deny ?? []
                    )
                )
                if let ceiling = permissions.remoteCeiling {
                    // The remote ceiling is the one setting where the closest
                    // file does not win. It caps what a task started from a
                    // phone may do with nobody at this Mac, so only the
                    // reader's own file may set it; a project's files, which
                    // arrive with a clone or can be written by the agent, may
                    // only lower it, approved or not.
                    resolved.remoteCeiling = layer.origin == .user
                        ? ceiling
                        : resolved.remoteCeiling.capped(at: ceiling)
                }
            }
            if loosens, let env = file.env {
                for (name, value) in env
                where layer.origin == .user || !CodeSettingsEnvironment.isReserved(name) {
                    resolved.environment[name] = value
                }
            }
            if let sandbox = file.sandbox {
                if let network = sandbox.network, loosens || !network {
                    resolved.allowsNetwork = network
                }
                if loosens, let paths = sandbox.writablePaths {
                    resolved.writablePaths += paths.compactMap {
                        CodeSettingsPaths.writablePath(
                            $0,
                            origin: layer.origin,
                            projectRoot: projectRoot,
                            homeDirectory: homeDirectory
                        )
                    }
                }
            }
            if let agent = file.agent {
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
                // Fallback hands the reader's code to another lab's model, so
                // switching it on is a widening like any other.
                if let fallback = agent.modelFallback, loosens || !fallback {
                    resolved.modelFallback = fallback
                }
            }
            if let git = file.git {
                if let trailer = git.coAuthorTrailer { resolved.coAuthorTrailer = trailer }
                if let prefix = git.branchPrefix { resolved.branchPrefix = prefix }
            }
            if let text = file.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty
            {
                switch layer.origin {
                case .user:
                    resolved.instructions.append(text)
                case .local where layer.isApproved:
                    resolved.instructions.append(text)
                case .project, .local:
                    resolved.repositoryInstructions.append(text)
                }
            }
        }
        // The step limit is today's turn limit, made soft, unless a file
        // names it under `autonomy`.
        if !stepLimitSet {
            resolved.autonomy.stepLimit = resolved.maxTurns
        }
        return resolved
    }
}

/// The command-environment variables a project's settings may not set, even
/// once approved.
///
/// Each decides which program runs, what it loads before the code it was
/// asked to run, or where it reads its configuration. `PATH` pointing at a
/// checked-in `.juno/bin/git` turned the `git status` Juno runs while building
/// the system prompt into the repository's own program, before any approval;
/// `GIT_CONFIG_*` installs a `core.fsmonitor` hook the same way; `DYLD_*`
/// injects a library into every process. The reader's own file may still set
/// any of them.
public enum CodeSettingsEnvironment {
    static let reservedNames: Set<String> = [
        "PATH", "HOME", "PWD", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "CDPATH", "FPATH",
        "PROMPT_COMMAND", "PS4", "TMPDIR",
        "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
        "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE",
        "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB",
        "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
        "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE", "BROWSER",
        "SSH_ASKPASS", "SUDO_ASKPASS", "SSH_AUTH_SOCK", "GNUPGHOME",
        "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CC", "CXX", "LD", "AR",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CURL_HOME", "WGETRC",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    ]
    static let reservedPrefixes = [
        "GIT_", "DYLD_", "LD_", "NPM_CONFIG_", "YARN_", "BUNDLE_", "CARGO_", "PIP_",
        "POETRY_", "GEM_", "MALLOC_",
    ]

    /// Compared without case: tools read `npm_config_*` and `http_proxy` in
    /// lower case as readily as upper.
    public static func isReserved(_ name: String) -> Bool {
        let upper = name.uppercased()
        return reservedNames.contains(upper) || reservedPrefixes.contains { upper.hasPrefix($0) }
    }
}

/// Where a settings file may let commands write.
public enum CodeSettingsPaths {
    /// The canonical form of one `sandbox.writablePaths` entry, or nil when it
    /// names a folder that file may not open up.
    ///
    /// Never `/`, the home folder, or anything above either, from any file:
    /// the sandbox allows writes beneath each entry, so any of those grants
    /// the home folder and with it shell profiles, LaunchAgents and keys. A
    /// project file's entries must also lie inside the project once symbolic
    /// links are resolved, so a checked-in link to `~` cannot bring it back.
    /// The reader's own file may name any other folder.
    public static func writablePath(
        _ raw: String,
        origin: CodeSettingsLayer.Origin,
        projectRoot: URL?,
        homeDirectory: URL
    ) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let isProjectFile = origin != .user
        if text == "~" || text.hasPrefix("~/") {
            text = homeDirectory.path + text.dropFirst()
        }
        if !text.hasPrefix("/") {
            // A relative entry means the project's folder; the reader's own
            // file has no project to be relative to.
            guard isProjectFile, let projectRoot else { return nil }
            text = projectRoot.path + "/" + text
        }
        let path = canonical(text)
        guard path != "/", !contains(path, canonical(homeDirectory.path)) else { return nil }
        if isProjectFile {
            guard let projectRoot, contains(canonical(projectRoot.path), path) else { return nil }
        }
        return path
    }

    /// Whether `inner` is `outer` or lies beneath it.
    private static func contains(_ outer: String, _ inner: String) -> Bool {
        outer == "/" || inner == outer || inner.hasPrefix(outer + "/")
    }

    /// The path the kernel sees: `..` removed and symbolic links resolved
    /// through the deepest part that exists.
    static func canonical(_ path: String) -> String {
        var remainder: [String] = []
        var candidate = (path as NSString).standardizingPath
        while !candidate.isEmpty, candidate != "/" {
            if let real = realpath(candidate, nil) {
                defer { free(real) }
                let base = String(cString: real)
                return ([base == "/" ? "" : base] + remainder.reversed()).joined(separator: "/")
            }
            remainder.append((candidate as NSString).lastPathComponent)
            candidate = (candidate as NSString).deletingLastPathComponent
        }
        return "/" + remainder.reversed().joined(separator: "/")
    }
}
