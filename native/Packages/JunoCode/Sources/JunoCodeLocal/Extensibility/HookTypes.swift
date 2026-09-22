import Foundation
import JunoCodeCore

/// The lifecycle events Juno runs hooks for, named as Claude Code names them.
///
/// The raw values are the configuration keys, so a repository's existing
/// `.claude/settings.json` works unchanged. Juno's own earlier names
/// (`before_command`, `after_command`, `session_start`, `session_stop`) are
/// still accepted when parsing and land on their Claude equivalents.
/// `PreCompact` is deliberately absent: compaction has its own owner, and a
/// hook Juno would never fire is better diagnosed than silently accepted.
public enum HookLifecycleEvent: String, CaseIterable, Codable, Sendable {
    case preToolUse = "PreToolUse"
    case postToolUse = "PostToolUse"
    case userPromptSubmit = "UserPromptSubmit"
    case stop = "Stop"
    case subagentStop = "SubagentStop"
    case sessionStart = "SessionStart"
    case sessionEnd = "SessionEnd"
    case notification = "Notification"

    public init?(configurationKey rawValue: String) {
        let key = rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map { String($0) }
            .joined()
            .lowercased()

        switch key {
        case "pretooluse", "beforecommand", "beforetool":
            self = .preToolUse
        case "posttooluse", "aftercommand", "aftertool":
            self = .postToolUse
        case "userpromptsubmit":
            self = .userPromptSubmit
        // Juno's old `session_stop` ran at the end of every run, which is
        // exactly when Claude Code's `Stop` runs; `SessionEnd` is the end of
        // the whole session and is its own event now.
        case "stop", "sessionstop":
            self = .stop
        case "subagentstop":
            self = .subagentStop
        case "sessionstart":
            self = .sessionStart
        case "sessionend":
            self = .sessionEnd
        case "notification":
            self = .notification
        default:
            return nil
        }
    }

    /// The key Claude Code's settings file uses for this event.
    public var claudeConfigurationKey: String { rawValue }

    /// Whether exit code 2 (or `"decision": "block"`) changes what happens.
    /// For the rest, Claude Code shows the hook's error to the reader only,
    /// and so does Juno.
    public var canBlock: Bool {
        switch self {
        case .preToolUse, .postToolUse, .userPromptSubmit, .stop, .subagentStop:
            true
        case .sessionStart, .sessionEnd, .notification:
            false
        }
    }

    /// Whether a hook's plain standard output becomes context for the model.
    /// Claude Code does this for exactly these two; everywhere else stdout is
    /// only read for its JSON.
    public var addsStandardOutputToContext: Bool {
        self == .userPromptSubmit || self == .sessionStart
    }
}

/// Which repository convention supplied a hook or skill.
public enum ExtensibilitySource: String, CaseIterable, Codable, Sendable {
    case juno
    case claude

    public static var junoHooks: Self { .juno }
    public static var claudeSettings: Self { .claude }

    public var skillsDirectory: String {
        switch self {
        case .juno: ".juno/skills"
        case .claude: ".claude/skills"
        }
    }
}

/// A file hooks are read from, in the order they are read.
///
/// Everything but the reader's own `~/.juno/settings.json` lives inside the
/// repository, and so is written by whoever wrote the repository — including,
/// potentially, the agent. Those hooks run only after the reader allows them.
public enum HookConfigurationFile: String, CaseIterable, Codable, Sendable {
    /// `~/.juno/settings.json`
    case junoUser
    /// `.claude/settings.json`
    case claudeProject
    /// `.claude/settings.local.json`
    case claudeLocal
    /// `.juno/hooks.json`, Juno's original hooks file.
    case junoHooks
    /// `.juno/settings.json`
    case junoProject
    /// `.juno/settings.local.json`
    case junoLocal

    /// The path a reader recognises. Workspace-relative for repository files.
    public var path: String {
        switch self {
        case .junoUser: "~/.juno/settings.json"
        case .claudeProject: ".claude/settings.json"
        case .claudeLocal: ".claude/settings.local.json"
        case .junoHooks: ".juno/hooks.json"
        case .junoProject: ".juno/settings.json"
        case .junoLocal: ".juno/settings.local.json"
        }
    }

    public var source: ExtensibilitySource {
        switch self {
        case .claudeProject, .claudeLocal: .claude
        case .junoUser, .junoHooks, .junoProject, .junoLocal: .juno
        }
    }

    public var isInRepository: Bool { self != .junoUser }

    public var trust: ExtensibilityTrust {
        isInRepository ? .untrustedWorkspace : .readerConfiguration
    }
}

/// Repository configuration is executable input, not trusted application
/// configuration. Discovery can report it, but execution requires both an
/// explicit hook-ID allowlist and an explicit permission for untrusted input.
public enum ExtensibilityTrust: String, Codable, Sendable {
    case untrustedWorkspace
    /// The reader's own settings file, outside every repository. It is the
    /// same statement as the reader typing the command, so it needs no
    /// second allowing — the way Claude Code treats `~/.claude/settings.json`.
    case readerConfiguration
}

/// What a tool hook is told about the call's result.
public struct HookToolResult: Equatable, Sendable {
    public let succeeded: Bool
    public let content: String

    public init(succeeded: Bool, content: String) {
        self.succeeded = succeeded
        self.content = content
    }
}

/// Everything one hook invocation knows: what matchers compare against and
/// what the hook reads as JSON on standard input.
public struct HookInvocationContext: Equatable, Sendable {
    public let event: HookLifecycleEvent
    public let sessionID: String?
    /// The session's append-only transcript, when one exists on disk.
    public let transcriptPath: String?
    /// The folder the session works in: the project, or a sub-agent's worktree.
    public let cwd: String?
    public let permissionMode: PermissionMode?
    /// Juno's own tool name, for example `run_command`. Hooks see the name
    /// `HookToolNames` maps it to.
    public let toolName: String?
    public let toolUseID: String?
    public let toolInput: JSONValue?
    public let toolResult: HookToolResult?
    public let prompt: String?
    public let stopHookActive: Bool?
    /// `SessionStart`: `startup` or `resume`.
    public let source: String?
    /// `SessionEnd`: why the session ended.
    public let reason: String?
    /// `Notification`: what Juno wants the reader to know.
    public let message: String?
    /// `Notification`: `permission_prompt` or `idle_prompt`.
    public let notificationType: String?

    public init(
        event: HookLifecycleEvent,
        sessionID: String? = nil,
        transcriptPath: String? = nil,
        cwd: String? = nil,
        permissionMode: PermissionMode? = nil,
        toolName: String? = nil,
        toolUseID: String? = nil,
        toolInput: JSONValue? = nil,
        toolResult: HookToolResult? = nil,
        prompt: String? = nil,
        stopHookActive: Bool? = nil,
        source: String? = nil,
        reason: String? = nil,
        message: String? = nil,
        notificationType: String? = nil
    ) {
        self.event = event
        self.sessionID = sessionID
        self.transcriptPath = transcriptPath
        self.cwd = cwd
        self.permissionMode = permissionMode
        self.toolName = toolName
        self.toolUseID = toolUseID
        self.toolInput = toolInput
        self.toolResult = toolResult
        self.prompt = prompt
        self.stopHookActive = stopHookActive
        self.source = source
        self.reason = reason
        self.message = message
        self.notificationType = notificationType
    }

    /// The tool name hooks see: Claude Code's where Juno has an equivalent.
    public var hookToolName: String? {
        toolName.map(HookToolNames.hookName(for:))
    }

    /// The values a matcher is tested against, or nil when the event takes no
    /// matcher at all. Claude Code ignores matchers on `UserPromptSubmit`,
    /// `Stop` and `SubagentStop`, and matches the others against the source,
    /// the reason or the notification type.
    ///
    /// A tool event offers both names, Claude's first, so a matcher written
    /// for Claude Code (`Bash`) and one written for Juno (`run_command`) both
    /// match the same call.
    public var matcherCandidates: [String]? {
        switch event {
        case .preToolUse, .postToolUse:
            guard let toolName else { return [] }
            let mapped = HookToolNames.hookName(for: toolName)
            return mapped == toolName ? [toolName] : [mapped, toolName]
        case .sessionStart:
            return source.map { [$0] } ?? []
        case .sessionEnd:
            return reason.map { [$0] } ?? []
        case .notification:
            return notificationType.map { [$0] } ?? []
        case .userPromptSubmit, .stop, .subagentStop:
            return nil
        }
    }

    /// The JSON object a hook reads on standard input, in Claude Code's shape.
    public func payload(projectDirectory: String?) -> JSONValue {
        let root = cwd ?? projectDirectory
        var fields: [String: JSONValue] = [
            "hook_event_name": .string(event.rawValue),
            "session_id": .string(sessionID ?? ""),
            "cwd": .string(root ?? ""),
        ]
        if let transcriptPath {
            fields["transcript_path"] = .string(transcriptPath)
        }
        if let permissionMode {
            fields["permission_mode"] = .string(Self.claudePermissionMode(permissionMode))
        }
        switch event {
        case .preToolUse, .postToolUse:
            let name = toolName ?? ""
            let input = toolInput ?? .object([:])
            fields["tool_name"] = .string(HookToolNames.hookName(for: name))
            fields["tool_input"] = HookToolNames.hookInput(
                toolName: name,
                input: input,
                root: root
            )
            if let toolUseID {
                fields["tool_use_id"] = .string(toolUseID)
            }
            if event == .postToolUse {
                fields["tool_response"] = HookToolNames.hookResponse(
                    toolName: name,
                    input: input,
                    result: toolResult ?? HookToolResult(succeeded: true, content: ""),
                    root: root
                )
            }
        case .userPromptSubmit:
            fields["prompt"] = .string(prompt ?? "")
        case .stop, .subagentStop:
            fields["stop_hook_active"] = .bool(stopHookActive ?? false)
        case .sessionStart:
            fields["source"] = .string(source ?? "startup")
        case .sessionEnd:
            fields["reason"] = .string(reason ?? "other")
        case .notification:
            fields["message"] = .string(message ?? "")
            if let notificationType {
                fields["notification_type"] = .string(notificationType)
            }
        }
        return .object(fields)
    }

    /// Claude Code's names for the four modes, so a hook that branches on
    /// `permission_mode` reads Juno's ladder the way it reads Claude's.
    static func claudePermissionMode(_ mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: "plan"
        case .askBeforeChanges: "default"
        case .workspaceWrite: "acceptEdits"
        case .fullAccess: "bypassPermissions"
        }
    }
}

/// A hook matcher, read the way Claude Code documents it.
///
/// Empty, missing or `*` matches everything. A pattern of only letters,
/// digits, `_` and `|` is a list of exact names — `Edit|Write` matches those
/// two tools and not `MultiEdit`. Anything else is a regular expression
/// searched for in the name, so `mcp__.*` matches every MCP tool. Invalid
/// expressions never match and are rejected by the parser before a
/// definition reaches the catalog.
public struct HookMatcher: Equatable, Codable, Sendable {
    public let pattern: String?

    public init(pattern: String? = nil) {
        let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.pattern = trimmed?.isEmpty == true || trimmed == "*" ? nil : trimmed
    }

    public var isAny: Bool { pattern == nil }

    /// Whether the pattern is a `|`-separated list of exact names.
    public var isExactList: Bool {
        guard let pattern else { return false }
        return pattern.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII
                && (CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "|")
        }
    }

    public func matches(_ context: HookInvocationContext) -> Bool {
        guard let pattern else { return true }
        guard let candidates = context.matcherCandidates else { return true }
        if isExactList {
            let names = Set(pattern.split(separator: "|").map(String.init))
            return candidates.contains { names.contains($0) }
        }
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return false
        }
        return candidates.contains { candidate in
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

    /// A short name the thread can use: the script the command runs, with the
    /// project-directory variable taken off, or else the start of the command.
    ///
    /// `"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh` reads as
    /// `.claude/hooks/guard.sh`, and `python3 hooks/lint.py` as
    /// `hooks/lint.py` — the file the reader would open to change it.
    public var displayName: String {
        let words = command
            .split(whereSeparator: \.isWhitespace)
            .map { $0.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "'", with: "") }
        guard var candidate = words.first else { return "" }
        let interpreters: Set<String> = [
            "bash", "sh", "zsh", "python", "python3", "node", "ruby", "perl", "deno", "bun", "uv",
        ]
        if interpreters.contains((candidate as NSString).lastPathComponent),
           words.count > 1,
           !words[1].hasPrefix("-")
        {
            candidate = words[1]
        }
        for prefix in [
            "$CLAUDE_PROJECT_DIR/", "${CLAUDE_PROJECT_DIR}/", "$JUNO_PROJECT_DIR/", "${JUNO_PROJECT_DIR}/",
        ] where candidate.hasPrefix(prefix) {
            candidate = String(candidate.dropFirst(prefix.count))
        }
        if candidate.contains("/") {
            return candidate.count <= 48 ? candidate : (candidate as NSString).lastPathComponent
        }
        let firstLine = command.split(separator: "\n").first.map(String.init) ?? command
        return firstLine.count <= 48 ? firstLine : String(firstLine.prefix(47)) + "…"
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
    /// The file set `disableAllHooks`. Claude Code reads that as "no hooks at
    /// all", whichever file says it, and so does discovery.
    public let disablesAllHooks: Bool

    public init(
        source: ExtensibilitySource,
        path: String,
        hooks: [HookDefinition],
        diagnostics: [HookDiagnostic] = [],
        disablesAllHooks: Bool = false
    ) {
        self.source = source
        self.path = path
        self.hooks = hooks
        self.diagnostics = diagnostics
        self.disablesAllHooks = disablesAllHooks
    }
}

public struct HookDiscoveryResult: Equatable, Sendable {
    public let configurations: [HookConfiguration]
    public let hooks: [HookDefinition]
    public let diagnostics: [HookDiagnostic]
    /// The file whose `disableAllHooks` turned every hook off, if one did.
    public let disabledBy: String?

    public init(
        configurations: [HookConfiguration] = [],
        hooks: [HookDefinition] = [],
        diagnostics: [HookDiagnostic] = [],
        disabledBy: String? = nil
    ) {
        self.configurations = configurations
        self.hooks = hooks
        self.diagnostics = diagnostics
        self.disabledBy = disabledBy
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

    /// The hooks configured for one event, in the order they run.
    public func hooks(for event: HookLifecycleEvent) -> [HookDefinition] {
        hooks.filter { $0.event == event }
    }

    /// Hooks that come from the repository rather than the reader's own file.
    public var repositoryHooks: [HookDefinition] {
        hooks.filter(\.isUntrusted)
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
///
/// Allowing a repository hook is the reader's approval of that exact command:
/// the allowlist holds hook IDs, and an ID is a digest of the command, its
/// matcher and where it was declared, so an edited hook is a new hook that
/// has to be allowed again. Because of that, an allowed hook is not asked
/// about again on every run — a `PreToolUse` hook that prompted before every
/// tool call would make hooks unusable, and it would be asking the reader a
/// question they have already answered. Two things still stop it: a
/// read-only session runs nothing, and a command that leaves the workspace
/// (`destructive`) asks every time, as it does everywhere else in Juno.
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

    /// Whether this policy lets the hook run at all, before its command and
    /// the session's mode are considered. What Settings shows as "allowed".
    public func admits(_ hook: HookDefinition) -> Bool {
        switch hook.trust {
        case .readerConfiguration:
            return true
        case .untrustedWorkspace:
            return allowUntrustedHooks && allowedHookIDs.contains(hook.id)
        }
    }

    public func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        let hook = invocation.hook

        guard hook.event == invocation.context.event else {
            return .denied(reason: "The hook does not belong to this lifecycle event.")
        }
        guard hook.matcher.matches(invocation.context) else {
            return .denied(reason: "The hook matcher does not match this invocation.")
        }
        if hook.isUntrusted {
            guard allowedHookIDs.contains(hook.id) else {
                return .denied(reason: "The hook is not explicitly allowlisted.")
            }
            guard allowUntrustedHooks else {
                return .denied(reason: "The hook comes from untrusted workspace configuration.")
            }
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
        guard permissionMode != .readOnly else {
            return .denied(reason: "The session is read-only, so no hook runs.")
        }

        switch CommandClassifier().classify(hook.command) {
        case .forbidden:
            return .denied(reason: "The hook command is forbidden by the command policy.")
        case let .permitted(risk, reason):
            guard hook.risk == risk else {
                return .denied(reason: "The hook risk metadata does not match its command.")
            }
            // The reader's own file is spared the prompt: a notifier in
            // `~/bin` is outside every workspace by definition, and the
            // reader wrote the line that runs it.
            if risk == .destructive, hook.isUntrusted {
                return .requiresPermission(reason: reason)
            }
            return .allowed
        }
    }
}

/// Runs one hook command with its JSON on standard input. The production
/// executor is `CommandExecutionService.contained(...)`; tests and a future
/// XPC executor can implement this without shell access from the parser or
/// catalog.
public protocol HookCommandExecuting: Sendable {
    /// The runner refuses an uncontained executor. A test double must opt into
    /// this fact explicitly rather than accidentally making a process capable
    /// of writing outside the workspace look safe.
    var isContained: Bool { get }

    func runHook(
        _ commandLine: String,
        standardInput: Data,
        environment: [String: String],
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String)
}

extension CommandExecutionService: HookCommandExecuting {
    public func runHook(
        _ commandLine: String,
        standardInput: Data,
        environment: [String: String],
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        var stdout = ""
        var stderr = ""
        var result: CommandResult?
        for try await event in stream(
            commandLine,
            timeoutSeconds: timeoutSeconds,
            outputLimit: outputLimit,
            standardInput: standardInput,
            additionalEnvironment: environment
        ) {
            switch event {
            case let .stdout(text): stdout += text
            case let .stderr(text): stderr += text
            case let .completed(final): result = final
            }
        }
        guard let result else {
            throw CommandExecutionError.launchFailed(message: "Stream ended without completion.")
        }
        return (result, stdout, stderr)
    }
}

public enum HookExecutionStatus: Equatable, Sendable {
    case succeeded(exitCode: Int32)
    /// Exit code 2: the hook blocked whatever triggered it, and its standard
    /// error says why.
    case blocked(reason: String)
    case failed(exitCode: Int32, reason: String?)
    case denied(reason: String)
    case skipped(reason: String)
}

/// A `PreToolUse` hook's view of the approval prompt.
public enum HookPermissionDecision: String, Codable, Sendable {
    case allow
    case deny
    case ask
}

/// What a hook printed on standard output, when it printed Claude Code's
/// JSON. Read only after exit code 0, as Claude Code does.
public struct HookOutput: Equatable, Sendable {
    /// `"continue": false` ends the run.
    public var continueRun: Bool
    public var stopReason: String?
    /// `"block"`, or the deprecated `"approve"` a `PreToolUse` hook may send.
    public var decision: String?
    public var reason: String?
    public var systemMessage: String?
    public var permissionDecision: HookPermissionDecision?
    public var permissionDecisionReason: String?
    public var additionalContext: String?

    /// Parses `stdout` as the JSON form, or nil when it is not a JSON object
    /// — plain text is a normal, supported answer.
    public init?(stdout: String, event: HookLifecycleEvent) {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"),
              let value = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)),
              let object = value.objectValue
        else { return nil }

        continueRun = object["continue"]?.boolValue ?? true
        stopReason = object["stopReason"]?.stringValue
        decision = object["decision"]?.stringValue?.lowercased()
        reason = object["reason"]?.stringValue
        systemMessage = object["systemMessage"]?.stringValue

        // Event-specific fields count only when they say which event they are
        // for; a mismatch is a hook written for somewhere else.
        let specific = object["hookSpecificOutput"]?.objectValue
        let named = specific?["hookEventName"]?.stringValue
        if let specific, named == nil || named == event.rawValue {
            permissionDecision = specific["permissionDecision"]?.stringValue
                .flatMap { HookPermissionDecision(rawValue: $0.lowercased()) }
            permissionDecisionReason = specific["permissionDecisionReason"]?.stringValue
            additionalContext = specific["additionalContext"]?.stringValue
        } else {
            permissionDecision = nil
            permissionDecisionReason = nil
            additionalContext = nil
        }
    }
}

public struct HookExecutionResult: Equatable, Sendable {
    public let hookID: String
    public let hookName: String
    public let event: HookLifecycleEvent
    public let status: HookExecutionStatus
    public let stdout: String
    public let stderr: String
    /// The JSON answer, when the hook exited 0 and printed one.
    public let output: HookOutput?

    public init(
        hookID: String,
        hookName: String = "",
        event: HookLifecycleEvent,
        status: HookExecutionStatus,
        stdout: String = "",
        stderr: String = "",
        output: HookOutput? = nil
    ) {
        self.hookID = hookID
        self.hookName = hookName
        self.event = event
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
        self.output = output
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
    /// Standard output and error together, per hook run. The executor stops
    /// the process when it prints more.
    public static let maximumOutputBytes = 64 * 1_024
    /// Claude Code's default for a command hook.
    public static let defaultTimeoutSeconds = 60.0
    /// A longer `timeout` is clamped to this rather than rejected, so a
    /// repository written for Claude Code's ten-minute ceiling still loads.
    public static let maximumTimeoutSeconds = 600.0
    /// What one event's hooks may add to the model's context, the bound
    /// Claude Code applies to the same output.
    public static let maximumContextCharacters = 10_000
    /// A reason shown in the thread or returned to the model.
    public static let maximumReasonCharacters = 2_000
    /// A tool's result as `tool_response` sees it. The model's copy is
    /// bounded separately; this keeps a large read from becoming a large
    /// stdin write for every `PostToolUse` hook.
    public static let maximumToolResponseBytes = 64 * 1_024
}
