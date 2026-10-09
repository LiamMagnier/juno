import Foundation

/// Every place a model can run, in the order the picker's rail and the
/// Connections page list them (DESIGN §5.8, §5.13; SPEC §2).
///
/// Built from three sources: the Alevr catalogue (always present), the
/// instances the local env server reports (subscriptions: Claude, Codex, ACP
/// agents), and the user's own API keys. The UI branches on an instance's
/// declared capabilities and status, never on the vendor's name; the only
/// vendor knowledge here is the list of known subscriptions, so a row can
/// offer Install before the env server has probed anything.
public struct CodeV2ProviderDirectory: Equatable, Sendable {
    public var instances: [CodeV2.ProviderInstance]

    public init(instances: [CodeV2.ProviderInstance]) {
        self.instances = instances
    }

    /// Assembles the directory. Env-server instances replace the known
    /// placeholders with the same id; unknown ones are appended. Antigravity is
    /// a normal provider since the owner enabled it on 2026-10-09
    /// (PROVIDERS-LEGAL.md); `antigravityEnabled: false` still hides it.
    public static func build(
        alevr: CodeV2.ProviderInstance,
        envInstances: [CodeV2.ProviderInstance]?,
        byokKeys: Set<CodeV2.ByokProvider> = [],
        antigravityEnabled: Bool = true
    ) -> CodeV2ProviderDirectory {
        var result: [CodeV2.ProviderInstance] = [alevr]
        let reported = envInstances ?? []
        var seen = Set<String>()
        for known in CodeV2KnownSubscription.allCases where known != .antigravity || antigravityEnabled {
            if let live = reported.first(where: { $0.id == known.instanceId }) {
                result.append(live)
            } else {
                result.append(known.placeholder(envServerRunning: envInstances != nil))
            }
            seen.insert(known.instanceId)
        }
        for instance in reported where !seen.contains(instance.id) && instance.kind != .alevr && instance.kind != .byok {
            if instance.id == CodeV2KnownSubscription.antigravity.instanceId, !antigravityEnabled { continue }
            result.append(instance)
        }
        for lab in CodeV2.ByokProvider.allCases where byokKeys.contains(lab) {
            let reportedKey = reported.first { $0.id == CodeV2.byokInstanceId(lab) }
            result.append(reportedKey ?? CodeV2.ProviderInstance(
                id: CodeV2.byokInstanceId(lab), kind: .byok, label: lab.displayName,
                status: .ready, capabilities: CodeV2KnownSubscription.alevrEngineCapabilities
            ))
        }
        return CodeV2ProviderDirectory(instances: result)
    }

    // MARK: Rail

    public enum RailGroup: Int, Comparable, Sendable {
        case alevr, connected, notConnected, byok
        public static func < (a: RailGroup, b: RailGroup) -> Bool { a.rawValue < b.rawValue }
    }

    public static func railGroup(_ instance: CodeV2.ProviderInstance) -> RailGroup {
        switch instance.kind {
        case .alevr: return .alevr
        case .byok: return .byok
        default:
            return instance.status == .ready || instance.status == .limited ? .connected : .notConnected
        }
    }

    /// Alevr, connected subscriptions, installed-but-not-connected, then keys.
    public var rail: [CodeV2.ProviderInstance] {
        instances.enumerated()
            .sorted { lhs, rhs in
                let a = Self.railGroup(lhs.element), b = Self.railGroup(rhs.element)
                return a == b ? lhs.offset < rhs.offset : a < b
            }
            .map(\.element)
    }

    public func instance(_ id: String) -> CodeV2.ProviderInstance? {
        instances.first { $0.id == id }
    }

    /// ⌘⇧↑ / ⌘⇧↓ in the picker.
    public func neighbour(of id: String, step: Int) -> CodeV2.ProviderInstance? {
        let rail = self.rail
        guard !rail.isEmpty else { return nil }
        let index = rail.firstIndex { $0.id == id } ?? 0
        return rail[(index + step + rail.count) % rail.count]
    }

    // MARK: Sentences (status is words, never a badge)

    /// The one sentence under the instance header in the picker.
    public static func headerSentence(_ instance: CodeV2.ProviderInstance, alevrPlan: String? = nil) -> String {
        switch instance.kind {
        case .alevr:
            return alevrPlan.map { "Alevr models on your \($0) plan." } ?? "Alevr models, billed to your Alevr plan."
        case .byok:
            let lab = instance.id.split(separator: ":").last.flatMap { CodeV2.ByokProvider(rawValue: String($0)) }
            let name = lab?.labName ?? "your provider"
            return "Your \(name) key. Billed by \(name), not Alevr."
        default:
            switch instance.status {
            case .ready, .limited:
                var parts: [String] = ["Runs your own \(binaryName(instance)) on this Mac."]
                if let plan = instance.account?.plan { parts.append(planName(plan) + " plan" + (windowSummary(instance).map { ", " + $0 } ?? "") + ".") }
                else if let window = windowSummary(instance) { parts.append(window.prefix(1).uppercased() + window.dropFirst() + ".") }
                return parts.joined(separator: " ")
            default:
                return statusSentence(instance)
            }
        }
    }

    /// The facts sentence on a Connections row (binary + version, account, plan)
    /// or what is wrong, in words.
    public static func statusSentence(_ instance: CodeV2.ProviderInstance) -> String {
        if let message = instance.statusMessage, instance.status != .ready {
            return message.hasSuffix(".") ? message : message + "."
        }
        switch instance.status {
        case .notInstalled:
            return "Not installed. Alevr opens a terminal with the install command so you can read it first."
        case .signedOut:
            return instance.version == nil ? "Installed, not signed in." : "Installed (\(instance.version!)), not signed in."
        case .unknown:
            return "Not checked yet."
        case .error:
            return "Could not start. Re-check, or open the terminal to see why."
        case .limited, .ready:
            var parts: [String] = []
            var binary = "Your own \(binaryName(instance))"
            if let version = instance.version { binary += ", version \(version)" }
            parts.append(binary)
            if let email = instance.account?.email {
                parts.append("Signed in as \(email)" + (instance.account?.plan.map { ", \(planName($0)) plan" } ?? ""))
            } else if let plan = instance.account?.plan {
                parts.append("\(planName(plan)) plan")
            }
            return parts.joined(separator: ". ") + "."
        }
    }

    /// Tooltip for a rail button: the name, then the state in words.
    public static func tooltip(_ instance: CodeV2.ProviderInstance) -> String {
        switch instance.status {
        case .ready, .limited:
            if let summary = windowSummary(instance) {
                let plan = instance.account?.plan.map { planName($0) + " plan, " } ?? ""
                return "\(instance.label): \(plan)\(summary)"
            }
            return instance.label
        case .notInstalled: return "\(instance.label): not installed"
        case .signedOut: return "\(instance.label): not signed in"
        case .error: return "\(instance.label): could not start"
        case .unknown: return "\(instance.label): not checked yet"
        }
    }

    /// "5-hour window 38% used, resets 16:40".
    public static func windowSummary(_ instance: CodeV2.ProviderInstance, timeZone: TimeZone = .current) -> String? {
        guard let window = instance.limits?.first, let used = window.usedPct else { return nil }
        var text = "\(window.label.lowercased()) window \(Int(used.rounded()))% used"
        if let resets = window.resetsAt.flatMap({ CodeV2Formatting.clockTime(iso: $0, timeZone: timeZone) }) {
            text += ", resets \(resets)"
        }
        return text
    }

    /// The vendor's limit sentence for the Limited state (DESIGN §6).
    public static func limitedSentence(_ instance: CodeV2.ProviderInstance, resumeAt: String?, timeZone: TimeZone = .current) -> String {
        let vendor = instance.label.replacingOccurrences(of: " (your subscription)", with: "")
        let time = (resumeAt ?? instance.limits?.first(where: { ($0.usedPct ?? 0) >= 100 })?.resetsAt)
            .flatMap { CodeV2Formatting.clockTime(iso: $0, timeZone: timeZone) }
        return "\(vendor) plan limit reached." + (time.map { " Resets at \($0)." } ?? "")
    }

    public static func binaryName(_ instance: CodeV2.ProviderInstance) -> String {
        if let path = instance.binaryPath { return (path as NSString).lastPathComponent }
        if let command = instance.acpCommand?.first { return command }
        return instance.label
    }

    public static func planName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "max", "claude_max": "Max"
        case "pro", "claude_pro": "Pro"
        case "plus": "Plus"
        case "team": "Team"
        case "enterprise": "Enterprise"
        default: raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    // MARK: Billing

    /// Dollars are shown for Alevr and BYOK instances; subscriptions show
    /// their plan windows instead (DESIGN §5.10).
    public static func billsInDollars(_ kind: CodeV2.ProviderKind) -> Bool {
        kind == .alevr || kind == .byok
    }

    /// The vendor name used in "Counts against your Claude plan".
    public static func vendorName(_ instance: CodeV2.ProviderInstance) -> String {
        if let known = CodeV2KnownSubscription.allCases.first(where: { $0.instanceId == instance.id }) {
            return known.vendor
        }
        return instance.label.replacingOccurrences(of: " (your subscription)", with: "")
    }
}

/// The subscriptions Alevr knows how to start (SPEC §2), in display order.
/// Used for placeholders and for the install / sign-in commands the client
/// can offer when the env server has not answered `provider.setup`.
public enum CodeV2KnownSubscription: String, CaseIterable, Sendable {
    case claude, codex, gemini, grok, deepseek, opencode, antigravity

    public var instanceId: String {
        switch self {
        case .claude: "claude-agent:default"
        case .codex: "codex:default"
        case .gemini: "acp:gemini"
        case .grok: "acp:grok"
        case .deepseek: "acp:dsh"
        case .opencode: "acp:opencode"
        case .antigravity: "acp:antigravity"
        }
    }

    public var kind: CodeV2.ProviderKind {
        switch self {
        case .claude: .claudeAgent
        case .codex: .codex
        default: .acp
        }
    }

    /// The display name. Claude is "Claude (your subscription)": the user's
    /// own `claude`, never presented as Alevr's.
    public var displayName: String {
        switch self {
        case .claude: "Claude (your subscription)"
        case .codex: "ChatGPT (Codex)"
        case .gemini: "Gemini CLI"
        case .grok: "Grok"
        case .deepseek: "DeepSeek Harness"
        case .opencode: "OpenCode"
        case .antigravity: "Antigravity"
        }
    }

    public var vendor: String {
        switch self {
        case .claude: "Claude"
        case .codex: "ChatGPT"
        case .gemini: "Gemini"
        case .grok: "Grok"
        case .deepseek: "DeepSeek"
        case .opencode: "OpenCode"
        case .antigravity: "Antigravity"
        }
    }

    /// The provider-mark asset id (`provider-<id>`), drawn in currentColor.
    public var markID: String {
        switch self {
        case .claude: "anthropic"
        case .codex: "openai"
        case .gemini, .antigravity: "google"
        case .grok: "xai"
        case .deepseek: "deepseek"
        case .opencode: "opencode"
        }
    }

    public var binary: String {
        switch self {
        case .claude: "claude"
        case .codex: "codex"
        case .gemini: "gemini"
        case .grok: "grok"
        case .deepseek: "dsh"
        case .opencode: "opencode"
        case .antigravity: "antigravity-acp"
        }
    }

    public var acpCommand: [String]? {
        switch self {
        case .claude, .codex: nil
        case .gemini: ["gemini", "--experimental-acp"]
        case .grok: ["grok", "agent", "stdio"]
        case .deepseek: ["dsh", "--profile", "acp"]
        case .opencode: ["opencode", "acp"]
        case .antigravity: ["antigravity-acp"]
        }
    }

    /// Installed and signed in by the env server (provider.install / provider.auth).
    public var isManagedRuntime: Bool { self == .antigravity }

    /// A short note shown on the Connections row whatever the state.
    public var note: String? {
        switch self {
        case .gemini: "Personal Google accounts can't be used here."
        case .antigravity: "Alevr downloads Google's own runtime, checks it, and you sign in with Google in your browser."
        default: nil
        }
    }

    /// Alevr installs (the vendor's release, checked against a pinned
    /// SHA-256) and signs in this runtime itself, through the env server,
    /// instead of typing a command into Terminal.
    public var managedRuntime: Bool { self == .antigravity }

    /// Fallback setup steps (the env server's `provider.setup` wins). Typed
    /// into a terminal, never run by Alevr.
    public func fallbackStep(_ action: CodeV2.ProviderSetupAction) -> CodeV2.ProviderSetupStep? {
        switch (self, action) {
        case (.claude, .install):
            CodeV2.ProviderSetupStep(action: .install, command: "curl -fsSL https://claude.ai/install.sh | bash", label: "Install Claude")
        case (.claude, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "claude auth login", label: "Sign in to Claude",
                                     note: "Signs in your own claude CLI. Alevr never sees the credential.")
        case (.codex, .install):
            CodeV2.ProviderSetupStep(action: .install, command: "npm install -g @openai/codex", label: "Install Codex")
        case (.codex, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "codex login", label: "Sign in to Codex")
        case (.gemini, .install):
            CodeV2.ProviderSetupStep(action: .install, command: "npm install -g @google/gemini-cli", label: "Install Gemini CLI")
        case (.gemini, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "gemini", label: "Sign in to Gemini CLI",
                                     note: "Choose an API key, Vertex or Enterprise sign-in.")
        case (.grok, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "grok login", label: "Sign in to Grok")
        case (.opencode, .install):
            CodeV2.ProviderSetupStep(action: .install, command: "curl -fsSL https://opencode.ai/install | bash", label: "Install OpenCode")
        case (.opencode, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "opencode auth login", label: "Sign in to OpenCode")
        case (.deepseek, .login):
            CodeV2.ProviderSetupStep(action: .login, command: "dsh login", label: "Sign in to DeepSeek Harness")
        default:
            nil
        }
    }

    /// Before the env server has probed: "not checked" while it runs, else
    /// "not installed" so the row still offers Install.
    public func placeholder(envServerRunning: Bool) -> CodeV2.ProviderInstance {
        CodeV2.ProviderInstance(
            id: instanceId, kind: kind, label: displayName, acpCommand: acpCommand,
            status: envServerRunning ? .unknown : .notInstalled,
            // Antigravity is installed and signed in by the env server itself, not a terminal.
            install: isManagedRuntime ? CodeV2.ProviderInstallState(phase: .idle) : nil
        )
    }

    /// The Alevr engine's capabilities, which BYOK instances share.
    public static let alevrEngineCapabilities = CodeV2.ProviderCapabilities(
        steering: true, queue: true, interrupt: true, resume: true, fork: true, rollback: true,
        planMode: true, approvals: [.readOnly, .ask, .autoEdit, .auto, .full], subagents: true,
        computerUse: true, contextTiers: true, effortLevels: [.low, .medium, .high, .xhigh, .max],
        images: true, mcpInjection: false
    )
}

public extension CodeV2.ByokProvider {
    /// "Anthropic key" as a rail tooltip and picker header.
    var displayName: String { labName + " key" }

    var labName: String {
        switch self {
        case .anthropic: "Anthropic"
        case .openai: "OpenAI"
        case .google: "Google"
        case .xai: "xAI"
        case .deepseek: "DeepSeek"
        }
    }

    /// The provider-mark asset id.
    var markID: String { self == .google ? "google" : rawValue }

    /// The key's expected prefix, for paste validation.
    var keyPrefix: String? {
        switch self {
        case .anthropic: "sk-ant-"
        case .openai: "sk-"
        case .xai: "xai-"
        case .deepseek: "sk-"
        case .google: nil
        }
    }

    /// `sk-ant-…4f2a`: never more than the prefix and the last four.
    static func maskedKey(_ key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 8 else { return "…" }
        let tail = trimmed.suffix(4)
        let head: Substring
        if let dash = trimmed.dropFirst(3).firstIndex(of: "-"), trimmed.distance(from: trimmed.startIndex, to: dash) <= 7 {
            head = trimmed[...dash]
        } else {
            head = trimmed.prefix(3)
        }
        return head + "…" + tail
    }
}
