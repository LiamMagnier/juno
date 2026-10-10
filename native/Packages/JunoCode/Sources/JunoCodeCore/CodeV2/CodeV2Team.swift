import Foundation

/// The Team orchestrator (team lane): the composer's always-visible Team chip
/// and its role editor read and write a ``CodeV2RoleDraft`` through this.
///
/// Four roles map onto the contract's routing:
/// Architect → `architect` (plans), Builder → `workers` (implements, N in
/// parallel), Verifier → `reviewer` (reviews and tests), Explorer →
/// `explorer` (optional, read-only). The lead (`orchestrator`) is always the
/// composer's own model.
///
/// The web twin is `src/lib/code-v2/team.ts`; both read
/// `contracts/code/team-summaries.json`, so the chip reads the same on both.
public enum CodeV2Team {
    /// The presets the editor offers, in order.
    public enum Preset: String, CaseIterable, Sendable, Hashable {
        case solo
        case planBuildVerify
        case bestOfN

        public var title: String {
            switch self {
            case .solo: "Solo"
            case .planBuildVerify: "Plan → Build → Verify"
            case .bestOfN: "Best of N"
            }
        }

        /// The segmented control's short label.
        public var shortTitle: String {
            switch self {
            case .solo: "Solo"
            case .planBuildVerify: "Team"
            case .bestOfN: "Best of N"
            }
        }

        public var line: String {
            switch self {
            case .solo: "One model does everything."
            case .planBuildVerify: "One model plans, others build in parallel, another checks the result."
            case .bestOfN: "Several models try the same task. You keep the best."
            }
        }

        public var contractPreset: CodeV2.RolePreset {
            switch self {
            case .solo: .solo
            case .planBuildVerify: .planBuildVerify
            case .bestOfN: .bestOfN
            }
        }

        /// `lead-workers` reads as the team it most resembles.
        public init(_ preset: CodeV2.RolePreset) {
            switch preset {
            case .solo: self = .solo
            case .bestOfN: self = .bestOfN
            case .leadWorkers, .planBuildVerify: self = .planBuildVerify
            }
        }
    }

    public enum Role: String, CaseIterable, Sendable, Hashable {
        case architect, builder, verifier, explorer

        public var name: String {
            switch self {
            case .architect: "Architect"
            case .builder: "Builder"
            case .verifier: "Verifier"
            case .explorer: "Explorer"
            }
        }

        public var duty: String {
            switch self {
            case .architect: "Plans the structure and approach"
            case .builder: "Writes the implementation"
            case .verifier: "Reviews and tests the result"
            case .explorer: "Maps the code first, read-only"
            }
        }

        /// Where the role lives in the contract's routing.
        public var routingKey: String {
            switch self {
            case .architect: "architect"
            case .builder: "workers"
            case .verifier: "reviewer"
            case .explorer: "explorer"
            }
        }

        /// The phase it runs in; the Explorer has none of its own.
        public var phase: CodeV2.TeamPhase? {
            switch self {
            case .architect: .plan
            case .builder: .build
            case .verifier: .verify
            case .explorer: nil
            }
        }
    }

    /// The phase a subagent of this contract role runs in.
    public static func phase(of role: CodeV2.AgentRole) -> CodeV2.TeamPhase? {
        switch role {
        case .architect: .plan
        case .worker: .build
        case .reviewer: .verify
        default: nil
        }
    }

    public static func phaseTitle(_ phase: CodeV2.TeamPhase) -> String {
        switch phase {
        case .plan: "Plan"
        case .build: "Build"
        case .verify: "Verify"
        }
    }

    // MARK: The chip's words

    /// A model's family name, short enough for the chip.
    public static func shortModelName(_ modelID: String) -> String {
        let bare = modelID.firstIndex(of: ":").map { String(modelID[modelID.index(after: $0)...]) } ?? modelID
        let id = bare.lowercased()
        let rules: [(test: (String) -> Bool, name: String)] = [
            ({ $0.contains("opus") }, "Opus"),
            ({ $0.contains("sonnet") }, "Sonnet"),
            ({ $0.contains("haiku") }, "Haiku"),
            ({ $0.contains("fable") }, "Fable"),
            ({ $0.contains("flash") }, "Flash"),
            ({ $0.contains("gemini") }, "Gemini"),
            ({ $0.hasPrefix("gpt") || $0.hasPrefix("chatgpt") || $0.contains("codex") || isOSeries($0) }, "GPT"),
            ({ $0.contains("grok") }, "Grok"),
            ({ $0.contains("deepseek") }, "DeepSeek"),
            ({ $0.contains("qwen") || $0.contains("qwq") }, "Qwen"),
            ({ $0.contains("kimi") }, "Kimi"),
            ({ $0.contains("glm") }, "GLM"),
            ({ $0.contains("mistral") || $0.contains("devstral") || $0.contains("codestral") }, "Mistral"),
            ({ $0.contains("llama") }, "Llama"),
        ]
        for rule in rules where rule.test(id) { return rule.name }
        let first = bare.split(whereSeparator: { "-_/ .".contains($0) }).first.map(String.init) ?? bare
        guard let head = first.first else { return "Model" }
        return head.uppercased() + first.dropFirst()
    }

    private static func isOSeries(_ id: String) -> Bool {
        guard id.count >= 2, id.first == "o" else { return false }
        return id.dropFirst().first?.isNumber ?? false
    }

    public static let summaryMaximum = 44

    /// The chip's summary, nil for Solo: "Opus plans · Sonnet ×2 builds · GPT
    /// verifies"; past `maximum` characters the verbs go ("Opus · Sonnet ×2 ·
    /// GPT"), then only the size remains ("Team of 4").
    public static func summary(_ routing: CodeV2.RoleRouting?, maximum: Int = summaryMaximum) -> String? {
        guard let routing, routing.preset != .solo else { return nil }
        let workers = routing.workers ?? []
        let n = workers.count
        if routing.preset == .bestOfN { return "Best of \(max(2, n))" }
        func name(_ selection: CodeV2.ModelSelection?) -> String { selection.map { shortModelName($0.model) } ?? "" }
        let builders = n > 1 ? "\(name(workers.first)) ×\(n)" : name(workers.first ?? routing.orchestrator)
        var parts: [(String, String)]
        if routing.preset == .leadWorkers {
            parts = [(name(routing.orchestrator), "leads"), (builders, "builds")]
            if let reviewer = routing.reviewer { parts.append((name(reviewer), "reviews")) }
        } else {
            parts = [
                (name(routing.architect ?? routing.orchestrator), "plans"),
                (builders, "builds"),
                (name(routing.reviewer ?? routing.orchestrator), "verifies"),
            ]
        }
        let full = parts.map { "\($0.0) \($0.1)" }.joined(separator: " · ")
        if full.count <= maximum { return full }
        let compact = parts.map(\.0).joined(separator: " · ")
        if compact.count <= maximum { return compact }
        return "Team of \(parts.count - 1 + max(1, n))"
    }
}

// MARK: - Editing a draft by role

extension CodeV2RoleDraft {
    public var teamPreset: CodeV2Team.Preset { CodeV2Team.Preset(preset) }

    /// Switch preset. Plan → Build → Verify starts every role on the lead,
    /// with two builders and the default cap, keeping choices already made.
    public mutating func applyTeamPreset(_ choice: CodeV2Team.Preset) {
        switch choice {
        case .solo:
            preset = .solo
        case .bestOfN:
            preset = .bestOfN
            if candidates.count < Self.candidateRange.lowerBound { setCandidateCount(3) }
        case .planBuildVerify:
            if preset == .solo {
                worker = lead
                workerCount = 2
            }
            preset = .planBuildVerify
            if budgetUsd == nil { budgetUsd = Self.defaultBudgetUsd }
        }
    }

    /// A role's model; Architect and Verifier fall back to the lead, as the engines do.
    public func selection(for role: CodeV2Team.Role) -> CodeV2.ModelSelection? {
        switch role {
        case .architect: architect ?? lead
        case .builder: worker
        case .verifier: reviewer ?? lead
        case .explorer: explorer
        }
    }

    /// Set a role's model; nil clears the optional Explorer (and puts the
    /// Architect and Verifier back on the lead).
    public mutating func setSelection(_ selection: CodeV2.ModelSelection?, for role: CodeV2Team.Role) {
        switch role {
        case .architect: architect = selection
        case .builder: if let selection { worker = selection }
        case .verifier: reviewer = selection
        case .explorer: explorer = selection
        }
    }

    /// Change one role's effort, keeping its model.
    public mutating func setEffort(_ effort: CodeV2.EffortLevel?, for role: CodeV2Team.Role) {
        guard var current = selection(for: role) else { return }
        current.effort = effort
        setSelection(current, for: role)
    }

    /// The chip's words for this draft.
    public var teamSummary: String? { CodeV2Team.summary(preset == .solo ? nil : routing) }
}

// MARK: - Persistence: per thread, with a per-project default

/// Where a thread's team is kept: its own, else the project's default (the
/// last team edited in that project), in `UserDefaults` under the same keys
/// the web uses in `localStorage`.
public struct CodeV2TeamStore: Sendable {
    public struct Scope: Equatable, Sendable {
        public var session: String?
        public var project: String?
        public init(session: String? = nil, project: String? = nil) {
            self.session = session
            self.project = project
        }
    }

    public static let sessionPrefix = "alevr.code.team.session:"
    public static let projectPrefix = "alevr.code.team.project:"

    private let suiteName: String?

    /// `suiteName` nil is the standard defaults; tests pass their own suite.
    public init(suiteName: String? = nil) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    private func read(_ key: String) -> CodeV2.RoleRouting? {
        guard let value = defaults.string(forKey: key), let data = value.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(CodeV2.RoleRouting.self, from: data)
    }

    /// The thread's team, else the project's default, else nil.
    public func load(_ scope: Scope) -> CodeV2.RoleRouting? {
        if let session = scope.session, let own = read(Self.sessionPrefix + session) { return own }
        if let project = scope.project { return read(Self.projectPrefix + project) }
        return nil
    }

    /// Saves for the thread and makes it the project's default.
    public func save(_ routing: CodeV2.RoleRouting, scope: Scope) {
        guard let data = try? JSONEncoder().encode(routing), let value = String(data: data, encoding: .utf8) else { return }
        if let session = scope.session { defaults.set(value, forKey: Self.sessionPrefix + session) }
        if let project = scope.project { defaults.set(value, forKey: Self.projectPrefix + project) }
    }
}
