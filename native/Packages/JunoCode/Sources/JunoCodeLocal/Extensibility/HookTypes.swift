import Foundation
import JunoCodeCore

/// The small lifecycle surface that Juno currently promises to hooks.
///
/// The names intentionally describe Juno's local events rather than exposing
/// the whole, growing set of provider-specific hook names. The parser accepts
/// the equivalent Claude Code names (`PreToolUse`, `PostToolUse`,
/// `SessionStart`, and `SessionEnd`) and normalizes them here.
public enum HookLifecycleEvent: String, CaseIterable, Codable, Sendable {
    case beforeCommand
    case afterCommand
    case sessionStart
    case sessionStop

    public init?(configurationKey rawValue: String) {
        let key = rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map { String($0) }
            .joined()
            .lowercased()

        switch key {
        case "beforecommand", "pretooluse":
            self = .beforeCommand
        case "aftercommand", "posttooluse":
            self = .afterCommand
        case "sessionstart":
            self = .sessionStart
        case "sessionstop", "sessionend", "stop":
            self = .sessionStop
        default:
            return nil
        }
    }

    /// The names used by Claude Code's settings file for this supported
    /// subset. Useful to integrations that need to display provenance.
    public var claudeConfigurationKey: String {
        switch self {
        case .beforeCommand: "PreToolUse"
        case .afterCommand: "PostToolUse"
        case .sessionStart: "SessionStart"
        case .sessionStop: "SessionEnd"
        }
    }
}

/// Which repository convention supplied a hook or skill.
public enum ExtensibilitySource: String, CaseIterable, Codable, Sendable {
    case juno
    case claude

    public static var junoHooks: Self { .juno }
    public static var claudeSettings: Self { .claude }

    public var hooksPath: String {
        switch self {
        case .juno: ".juno/hooks.json"
        case .claude: ".claude/settings.json"
        }
    }

    public var skillsDirectory: String {
        switch self {
        case .juno: ".juno/skills"
        case .claude: ".claude/skills"
        }
    }
}

/// Repository configuration is executable input, not trusted application
/// configuration. Discovery can report it, but execution requires both an
/// explicit hook-ID allowlist and an explicit permission for untrusted input.
public enum ExtensibilityTrust: String, Codable, Sendable {
    case untrustedWorkspace
}

/// Values available to a hook matcher.
public struct HookInvocationContext: Equatable, Sendable {
    public let event: HookLifecycleEvent
    /// The command line being started or that just completed, when applicable.
    public let command: String?
    /// The Juno tool name, for example `run_command`, when applicable.
    public let toolName: String?
    /// A display-safe session identifier. It is not placed in the shell
    /// command automatically; the eventual integration decides what context
    /// to provide to a hook.
    public let sessionID: String?

    public init(
        event: HookLifecycleEvent,
        command: String? = nil,
        toolName: String? = nil,
        sessionID: String? = nil
    ) {
        self.event = event
        self.command = command
        self.toolName = toolName
        self.sessionID = sessionID
    }

    /// Ordered candidates used by a matcher. A command hook first sees the
    /// tool name (matching Claude's `Bash`/tool matcher convention), then the
    /// concrete command line for Juno-specific matchers.
    public var matcherCandidates: [String] {
        var values: [String] = []
        if let toolName, !toolName.isEmpty {
            values.append(toolName)
            // Claude's settings convention calls Juno's command tool `Bash`.
            // Keep the real Juno name too, so a repository can use either
            // convention without a special integration-side rewrite.
            if toolName == "run_command" {
                values.append("Bash")
            }
        }
        if let command, !command.isEmpty { values.append(command) }
        if values.isEmpty {
            values.append(event.rawValue)
            values.append(event.claudeConfigurationKey)
        }
        return values
    }
}

/// A bounded regular-expression matcher. An empty matcher means "all".
/// Invalid expressions never match and are rejected by the configuration
/// parser before a definition reaches the catalog.
public struct HookMatcher: Equatable, Codable, Sendable {
    public let pattern: String?

    public init(pattern: String? = nil) {
        let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.pattern = trimmed?.isEmpty == true || trimmed == "*" ? nil : trimmed
    }

    public var isAny: Bool { pattern == nil }

    public func matches(_ context: HookInvocationContext) -> Bool {
        guard let pattern else { return true }
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return false
        }
        return context.matcherCandidates.contains { candidate in
            let range = NSRange(candidate.startIndex..., in: candidate)
            return expression.firstMatch(in: candidate, options: [], range: range) != nil
        }
    }
}

public enum HookDiagnosticSeverity: String, Codable, Sendable {
    case warning
    case error
}

/// A parse/discovery issue that is safe to surface in an inspector. It never
/// includes the full hook command, since repository configuration may contain
/// credentials by accident.
public struct HookDiagnostic: Equatable, Codable, Sendable {
    public let path: String
    public let location: String?
    public let severity: HookDiagnosticSeverity
    public let message: String

    public init(
        path: String,
        location: String? = nil,
        severity: HookDiagnosticSeverity = .warning,
        message: String
    ) {
        self.path = path
        self.location = location
        self.severity = severity
        self.message = message
    }
}

/// One normalized command hook. The command is retained verbatim for the
/// existing command classifier/executor; it is never interpolated into a
/// larger shell command by this module.
public struct HookDefinition: Identifiable, Equatable, Codable, Sendable {
    public let id: String
    public let event: HookLifecycleEvent
    public let matcher: HookMatcher
    public let command: String
    public let timeoutSeconds: Double
    public let source: ExtensibilitySource
    public let path: String
    public let ordinal: Int
    public let trust: ExtensibilityTrust
    public let risk: ActionRisk

    public init(
        id: String? = nil,
        event: HookLifecycleEvent,
        matcher: HookMatcher = HookMatcher(),
        command: String,
        timeoutSeconds: Double = HookExecutionLimits.defaultTimeoutSeconds,
        source: ExtensibilitySource,
        path: String,
        ordinal: Int = 0,
        trust: ExtensibilityTrust = .untrustedWorkspace,
        risk: ActionRisk? = nil
    ) {
        self.event = event
        self.matcher = matcher
        self.command = command
        self.timeoutSeconds = timeoutSeconds
        self.source = source
        self.path = path
        self.ordinal = ordinal
        self.trust = trust
        self.risk = risk ?? HookDefinition.classify(command: command)
        self.id = id ?? HookDefinition.makeID(
            event: event,
            matcher: matcher,
            command: command,
            source: source,
            path: path,
            ordinal: ordinal
        )
    }

    public var commandFingerprint: String {
        Digests.sha256Hex(command)
    }

    public var isUntrusted: Bool {
        trust == .untrustedWorkspace
    }

    private static func classify(command: String) -> ActionRisk {
        switch CommandClassifier().classify(command) {
        case let .permitted(risk, _): risk
        case .forbidden: .destructive
        }
    }

    static func makeID(
        event: HookLifecycleEvent,
        matcher: HookMatcher,
        command: String,
        source: ExtensibilitySource,
        path: String,
        ordinal: Int
    ) -> String {
        let identity = [
            source.rawValue,
            path,
            event.rawValue,
            matcher.pattern ?? "*",
            String(ordinal),
            command,
        ].joined(separator: "\u{1f}")
        return "hook-" + Digests.sha256Hex(identity)
    }
}

public enum HookConfigurationError: Error, Equatable, Sendable {
    case invalidJSON(path: String)
    case rootMustBeObject(path: String)
    case hooksMustBeObject(path: String)
}

public struct HookConfiguration: Equatable, Codable, Sendable {
    public let source: ExtensibilitySource
    public let path: String
    public let hooks: [HookDefinition]
    public let diagnostics: [HookDiagnostic]

    public init(
        source: ExtensibilitySource,
        path: String,
        hooks: [HookDefinition],
        diagnostics: [HookDiagnostic] = []
    ) {
        self.source = source
        self.path = path
        self.hooks = hooks
        self.diagnostics = diagnostics
    }
}

public struct HookDiscoveryResult: Equatable, Sendable {
    public let configurations: [HookConfiguration]
    public let hooks: [HookDefinition]
    public let diagnostics: [HookDiagnostic]

    public init(
        configurations: [HookConfiguration] = [],
        hooks: [HookDefinition] = [],
        diagnostics: [HookDiagnostic] = []
    ) {
        self.configurations = configurations
        self.hooks = hooks
        self.diagnostics = diagnostics
    }

    /// Event and matcher selection is kept pure so callers can preview what
    /// would run without granting execution permission.
    public func matchingHooks(
        for event: HookLifecycleEvent,
        context: HookInvocationContext
    ) -> [HookDefinition] {
        guard context.event == event else { return [] }
        return hooks.filter { hook in
            hook.event == event && hook.matcher.matches(context)
        }
    }
}

public struct HookInvocation: Equatable, Sendable {
    public let hook: HookDefinition
    public let context: HookInvocationContext

    public init(hook: HookDefinition, context: HookInvocationContext) {
        self.hook = hook
        self.context = context
    }
}

/// The result of the non-bypassable local policy check. `requiresPermission`
/// is deliberately distinct from `denied`: it gives an adapter around the
/// existing `PermissionCoordinator` a chance to ask the user, while a runner
/// without that adapter still fails closed.
public enum HookAuthorizationDecision: Equatable, Sendable {
    case allowed
    case requiresPermission(reason: String)
    case denied(reason: String)
}

public protocol HookAuthorizing: Sendable {
    func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision
}

/// Local policy that every hook runner applies before it consults an optional
/// approval adapter. An empty allowlist is intentional and is the default.
public struct HookExecutionPolicy: HookAuthorizing, Equatable, Codable, Sendable {
    public static let denyAll = HookExecutionPolicy()

    public let allowedHookIDs: Set<String>
    public let permissionMode: PermissionMode
    public let allowUntrustedHooks: Bool

    public init(
        allowedHookIDs: Set<String> = [],
        permissionMode: PermissionMode = .readOnly,
        allowUntrustedHooks: Bool = false
    ) {
        self.allowedHookIDs = allowedHookIDs
        self.permissionMode = permissionMode
        self.allowUntrustedHooks = allowUntrustedHooks
    }

    public func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        let hook = invocation.hook

        guard hook.event == invocation.context.event else {
            return .denied(reason: "The hook does not belong to this lifecycle event.")
        }
        guard hook.matcher.matches(invocation.context) else {
            return .denied(reason: "The hook matcher does not match this invocation.")
        }
        guard allowedHookIDs.contains(hook.id) else {
            return .denied(reason: "The hook is not explicitly allowlisted.")
        }
        guard !hook.isUntrusted || allowUntrustedHooks else {
            return .denied(reason: "The hook comes from untrusted workspace configuration.")
        }
        guard !hook.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .denied(reason: "The hook command is empty.")
        }
        guard !hook.command.unicodeScalars.contains(where: { $0.value == 0 }) else {
            return .denied(reason: "The hook command contains a NUL byte.")
        }
        guard hook.command.utf8.count <= HookExecutionLimits.maximumCommandBytes else {
            return .denied(reason: "The hook command is too long.")
        }
        guard hook.timeoutSeconds.isFinite,
              hook.timeoutSeconds > 0,
              hook.timeoutSeconds <= HookExecutionLimits.maximumTimeoutSeconds
        else {
            return .denied(reason: "The hook timeout is outside Juno's bounded range.")
        }

        switch CommandClassifier().classify(hook.command) {
        case .forbidden:
            return .denied(reason: "The hook command is forbidden by the command policy.")
        case let .permitted(risk, reason):
            guard hook.risk == risk else {
                return .denied(reason: "The hook risk metadata does not match its command.")
            }
            switch PermissionPolicy.ruling(
                mode: permissionMode,
                risk: risk,
                approvalPolicy: .byRisk
            ) {
            case .allow:
                return .allowed
            case .requireApproval:
                return .requiresPermission(reason: reason)
            case let .deny(reason):
                return .denied(reason: reason)
            }
        }
    }
}

/// A hook runner is deliberately small and dependency-injected. The concrete
/// production executor should be `CommandExecutionService.contained(...)`;
/// tests and a future XPC executor can implement this protocol without shell
/// access from the parser or catalog.
public protocol HookCommandExecuting: CommandExecuting {
    /// The runner refuses an uncontained executor. A test double must opt into
    /// this fact explicitly rather than accidentally making a process capable
    /// of writing outside the workspace look safe.
    var isContained: Bool { get }
}

extension CommandExecutionService: HookCommandExecuting {}

public enum HookExecutionStatus: Equatable, Sendable {
    case succeeded(exitCode: Int32)
    case failed(exitCode: Int32, reason: String?)
    case denied(reason: String)
    case skipped(reason: String)
}

public struct HookExecutionResult: Equatable, Sendable {
    public let hookID: String
    public let event: HookLifecycleEvent
    public let status: HookExecutionStatus
    public let stdout: String
    public let stderr: String

    public init(
        hookID: String,
        event: HookLifecycleEvent,
        status: HookExecutionStatus,
        stdout: String = "",
        stderr: String = ""
    ) {
        self.hookID = hookID
        self.event = event
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }

    public var succeeded: Bool {
        if case .succeeded = status { return true }
        return false
    }
}

public enum HookExecutionLimits {
    public static let maximumConfigurationBytes = 512 * 1_024
    public static let maximumSkillBytes = 256 * 1_024
    public static let maximumCommandBytes = 16 * 1_024
    public static let maximumMatcherBytes = 512
    public static let maximumHooksPerConfiguration = 64
    public static let maximumHooksPerRun = 32
    public static let maximumOutputBytes = 64 * 1_024
    public static let defaultTimeoutSeconds = 30.0
    public static let maximumTimeoutSeconds = 60.0
}
