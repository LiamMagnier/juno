import Foundation
import JunoCodeCore

/// The lifecycle events Juno runs hooks for, named as Claude Code names them
/// (CODE_AGENT_SPEC §5.9; https://code.claude.com/docs/en/hooks.md).
///
/// The raw values are the configuration keys, so a repository's existing
/// `.claude/settings.json` works unchanged. Juno's own earlier names
/// (`before_command`, `after_command`, `session_start`, `session_stop`) are
/// still accepted when parsing and land on their Claude equivalents.
///
/// Two are Juno's own: `GoalSet` and `GoalVerdict`, about the goal loop
/// (§2). `PreModelSwitch` and `PostModelSwitch` are Juno's too. Claude Code's
/// `Setup`, `UserPromptExpansion`, `MessageDisplay`, `TeammateIdle`,
/// `DirectoryAdded`, `CwdChanged`, `Elicitation` and `ElicitationResult` are
/// not adopted: a key Juno would never fire is diagnosed, not accepted.
public enum HookLifecycleEvent: String, CaseIterable, Codable, Sendable {
    case preToolUse = "PreToolUse"
    case postToolUse = "PostToolUse"
    case postToolUseFailure = "PostToolUseFailure"
    case postToolBatch = "PostToolBatch"
    case userPromptSubmit = "UserPromptSubmit"
    case stop = "Stop"
    case stopFailure = "StopFailure"
    case subagentStart = "SubagentStart"
    case subagentStop = "SubagentStop"
    case sessionStart = "SessionStart"
    case sessionEnd = "SessionEnd"
    case notification = "Notification"
    case permissionRequest = "PermissionRequest"
    case permissionDenied = "PermissionDenied"
    case taskCreated = "TaskCreated"
    case taskCompleted = "TaskCompleted"
    case preCompact = "PreCompact"
    case postCompact = "PostCompact"
    case instructionsLoaded = "InstructionsLoaded"
    case configChange = "ConfigChange"
    case fileChanged = "FileChanged"
    case worktreeCreate = "WorktreeCreate"
    case worktreeRemove = "WorktreeRemove"
    case preModelSwitch = "PreModelSwitch"
    case postModelSwitch = "PostModelSwitch"
    case goalSet = "GoalSet"
    case goalVerdict = "GoalVerdict"

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
        case "sessionstart":
            self = .sessionStart
        case "sessionend":
            self = .sessionEnd
        default:
            // Every other event is spelled exactly as Claude Code spells it,
            // give or take case and separators.
            guard let match = Self.allCases.first(where: { $0.rawValue.lowercased() == key }) else {
                return nil
            }
            self = match
        }
    }

    /// The key Claude Code's settings file uses for this event.
    public var claudeConfigurationKey: String { rawValue }

    /// Whether exit code 2 (or `"decision": "block"`) changes what happens.
    /// For the rest, Claude Code shows the hook's error to the reader only,
    /// and so does Juno.
    ///
    /// What a block means depends on the event, and it only ever narrows:
    /// a tool call does not run, a prompt is not sent, the agent keeps
    /// working instead of stopping, a pending approval is declined, a todo
    /// is not added or not marked done, a settings change or a model switch
    /// made in the app does not happen. After a tool already ran or failed,
    /// a block is a note the model reads with the result.
    public var canBlock: Bool {
        switch self {
        case .preToolUse, .postToolUse, .postToolUseFailure, .userPromptSubmit, .stop, .subagentStop,
             .permissionRequest, .taskCreated, .taskCompleted, .configChange, .preModelSwitch:
            true
        case .postToolBatch, .stopFailure, .subagentStart, .sessionStart, .sessionEnd, .notification,
             .permissionDenied, .preCompact, .postCompact, .instructionsLoaded, .fileChanged,
             .worktreeCreate, .worktreeRemove, .postModelSwitch, .goalSet, .goalVerdict:
            false
        }
    }

    /// Whether a hook's plain standard output becomes context for the model.
    /// Claude Code does this for exactly these; everywhere else stdout is
    /// only read for its JSON.
    public var addsStandardOutputToContext: Bool {
        self == .userPromptSubmit || self == .sessionStart
    }

    /// Whether a `prompt` hook means anything here: a small model's
    /// `{ok, reason}` can only block, so it is offered where a block does.
    public var acceptsPromptHooks: Bool { canBlock }

    /// The default timeout for a hook of `kind` on this event, in seconds,
    /// when its entry names none (§5.9): 600 for commands and HTTP, 30 for
    /// prompts, and 30 for anything on `UserPromptSubmit`, which holds the
    /// reader's message while it runs.
    public func defaultTimeoutSeconds(for kind: HookHandlerKind) -> Double {
        if self == .userPromptSubmit { return HookExecutionLimits.promptSubmitTimeoutSeconds }
        switch kind {
        case .command, .http: return HookExecutionLimits.defaultTimeoutSeconds
        case .prompt: return HookExecutionLimits.promptTimeoutSeconds
        }
    }
}

/// How a hook answers (§5.9). `mcp_tool` is later (P2) and `agent` hooks are
/// not adopted: upstream marks them experimental.
public enum HookHandlerKind: String, CaseIterable, Codable, Sendable {
    /// A shell command, contained like the agent's own commands, reading the
    /// event as JSON on standard input.
    case command
    /// An HTTP POST of the same JSON, answered with the same output JSON.
    case http
    /// A single turn of a small model that answers `{ok, reason}`; `ok:
    /// false` blocks. It can never allow anything.
    case prompt
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
    /// `Stop`, `SubagentStop`, `StopFailure`: the agent's last words.
    public let lastAssistantMessage: String?
    /// Set when the hook runs for a delegated sub-agent: its id and the
    /// agent it was started as (`explorer`, a custom agent's name…).
    public let agentID: String?
    public let agentType: String?
    /// The event's own fields beyond the ones above, in Claude Code's
    /// spelling (`trigger`, `error`, `file_path`, `goal`…), merged into the
    /// payload as they are.
    public let fields: [String: JSONValue]
    /// What matchers on this event compare against when the fields above do
    /// not say: `PreCompact`'s trigger, `FileChanged`'s file name.
    public let matcherSubject: String?

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
        notificationType: String? = nil,
        lastAssistantMessage: String? = nil,
        agentID: String? = nil,
        agentType: String? = nil,
        fields: [String: JSONValue] = [:],
        matcherSubject: String? = nil
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
        self.lastAssistantMessage = lastAssistantMessage
        self.agentID = agentID
        self.agentType = agentType
        self.fields = fields
        self.matcherSubject = matcherSubject
    }

    /// The tool name hooks see: Claude Code's where Juno has an equivalent.
    public var hookToolName: String? {
        toolName.map(HookToolNames.hookName(for:))
    }

    /// The values a matcher is tested against, or nil when the event takes no
    /// matcher at all. Claude Code ignores matchers on `UserPromptSubmit`,
    /// `Stop`, `PostToolBatch` and a few more, and matches the others against
    /// the tool name, the source, the reason, the trigger or the file name.
    ///
    /// A tool event offers both names, Claude's first, so a matcher written
    /// for Claude Code (`Bash`) and one written for Juno (`run_command`) both
    /// match the same call.
    public var matcherCandidates: [String]? {
        switch event {
        case .preToolUse, .postToolUse, .postToolUseFailure, .permissionRequest, .permissionDenied:
            guard let toolName else { return [] }
            let mapped = HookToolNames.hookName(for: toolName)
            return mapped == toolName ? [toolName] : [mapped, toolName]
        case .sessionStart:
            return source.map { [$0] } ?? []
        case .sessionEnd:
            return reason.map { [$0] } ?? []
        case .notification:
            return notificationType.map { [$0] } ?? []
        case .subagentStart, .subagentStop:
            // A session's own `Stop` takes no matcher; a sub-agent's matches
            // the agent it was started as.
            return agentType.map { [$0] } ?? []
        case .preCompact, .postCompact, .configChange, .fileChanged, .instructionsLoaded, .stopFailure:
            return matcherSubject.map { [$0] } ?? []
        case .userPromptSubmit, .stop, .postToolBatch, .taskCreated, .taskCompleted,
             .worktreeCreate, .worktreeRemove, .preModelSwitch, .postModelSwitch, .goalSet, .goalVerdict:
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
        if let agentID {
            fields["agent_id"] = .string(agentID)
        }
        if let agentType {
            fields["agent_type"] = .string(agentType)
        }
        switch event {
        case .preToolUse, .postToolUse, .postToolUseFailure, .permissionRequest, .permissionDenied:
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
            if event == .postToolUseFailure {
                fields["error"] = .string(Self.bounded(toolResult?.content ?? reason ?? ""))
                fields["is_interrupt"] = .bool(false)
            }
            if event == .permissionDenied {
                fields["reason"] = .string(reason ?? "")
            }
        case .userPromptSubmit:
            fields["prompt"] = .string(prompt ?? "")
        case .stop, .subagentStop:
            fields["stop_hook_active"] = .bool(stopHookActive ?? false)
            if let lastAssistantMessage {
                fields["last_assistant_message"] = .string(Self.bounded(lastAssistantMessage))
            }
        case .stopFailure:
            fields["error"] = .string(reason ?? "")
            if let lastAssistantMessage {
                fields["last_assistant_message"] = .string(Self.bounded(lastAssistantMessage))
            }
        case .sessionStart:
            fields["source"] = .string(source ?? "startup")
        case .sessionEnd:
            fields["reason"] = .string(reason ?? "other")
        case .notification:
            fields["message"] = .string(message ?? "")
            if let notificationType {
                fields["notification_type"] = .string(notificationType)
            }
        case .postToolBatch, .subagentStart, .taskCreated, .taskCompleted, .preCompact, .postCompact,
             .instructionsLoaded, .configChange, .fileChanged, .worktreeCreate, .worktreeRemove,
             .preModelSwitch, .postModelSwitch, .goalSet, .goalVerdict:
            break
        }
        // The event's own fields last; they never replace the common ones.
        for (key, value) in self.fields where fields[key] == nil {
            fields[key] = value
        }
        return .object(fields)
    }

    /// Long text a hook is handed (a failure's output, the agent's last
    /// message), bounded so one large result is not a large stdin write for
    /// every hook.
    public static func bounded(_ text: String) -> String {
        let limit = HookExecutionLimits.maximumToolResponseBytes
        guard text.utf8.count > limit else { return text }
        return String(decoding: Array(text.utf8.prefix(limit)), as: UTF8.self) + "…"
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

/// One normalized hook. For a `command` hook the command is retained
/// verbatim for the existing command classifier and executor; it is never
/// interpolated into a larger shell command by this module. For an `http`
/// hook `command` holds the URL, and for a `prompt` hook the prompt, so every
/// surface that shows "what it runs" shows the thing the reader would read.
public struct HookDefinition: Identifiable, Equatable, Codable, Sendable {
    public let id: String
    public let event: HookLifecycleEvent
    public let matcher: HookMatcher
    public let command: String
    public let timeoutSeconds: Double
    public let source: ExtensibilitySource
    public let path: String
    /// Where the hook sits in its file, for ordering and nothing else: it is
    /// not part of the ID.
    public let ordinal: Int
    public let trust: ExtensibilityTrust
    public let risk: ActionRisk
    /// How the hook answers. Older stored definitions are commands.
    public let kind: HookHandlerKind
    /// `http`: the endpoint, already validated as http(s) with a host.
    public let url: URL?
    /// `http`: headers sent with the POST, as written.
    public let headers: [String: String]
    /// `prompt`: the model the entry asks for, or nil for Juno's small model.
    public let model: String?

    /// - Parameter occurrence: which copy this is of an entry listed more
    ///   than once, identically, in one file — 0 for the first. It keeps
    ///   those IDs apart without making any ID depend on a position.
    public init(
        id: String? = nil,
        event: HookLifecycleEvent,
        matcher: HookMatcher = HookMatcher(),
        command: String,
        timeoutSeconds: Double = HookExecutionLimits.defaultTimeoutSeconds,
        source: ExtensibilitySource,
        path: String,
        ordinal: Int = 0,
        occurrence: Int = 0,
        trust: ExtensibilityTrust = .untrustedWorkspace,
        risk: ActionRisk? = nil,
        kind: HookHandlerKind = .command,
        url: URL? = nil,
        headers: [String: String] = [:],
        model: String? = nil
    ) {
        self.event = event
        self.matcher = matcher
        self.command = command
        self.timeoutSeconds = timeoutSeconds
        self.source = source
        self.path = path
        self.ordinal = ordinal
        self.trust = trust
        self.kind = kind
        self.url = url
        self.headers = headers
        self.model = model
        self.risk = risk ?? HookDefinition.classify(kind: kind, command: command, url: url)
        self.id = id ?? HookDefinition.makeID(
            event: event,
            matcher: matcher,
            command: command,
            source: source,
            path: path,
            occurrence: occurrence,
            kind: kind,
            headers: headers,
            model: model
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id, event, matcher, command, timeoutSeconds, source, path, ordinal, trust, risk
        case kind, url, headers, model
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        event = try container.decode(HookLifecycleEvent.self, forKey: .event)
        matcher = try container.decode(HookMatcher.self, forKey: .matcher)
        command = try container.decode(String.self, forKey: .command)
        timeoutSeconds = try container.decode(Double.self, forKey: .timeoutSeconds)
        source = try container.decode(ExtensibilitySource.self, forKey: .source)
        path = try container.decode(String.self, forKey: .path)
        ordinal = try container.decode(Int.self, forKey: .ordinal)
        trust = try container.decode(ExtensibilityTrust.self, forKey: .trust)
        risk = try container.decode(ActionRisk.self, forKey: .risk)
        kind = try container.decodeIfPresent(HookHandlerKind.self, forKey: .kind) ?? .command
        url = try container.decodeIfPresent(URL.self, forKey: .url)
        headers = try container.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
        model = try container.decodeIfPresent(String.self, forKey: .model)
    }

    public var commandFingerprint: String {
        Digests.sha256Hex(command)
    }

    public var isUntrusted: Bool {
        trust == .untrustedWorkspace
    }

    /// Where the hook was declared, in the extension vocabulary: the
    /// reader's own `~/.juno/settings.json`, or the project.
    public var scope: ExtensionScope { ExtensionScope.of(path: path) }

    /// Whether an `http` hook's endpoint is on this Mac. A repository's HTTP
    /// hooks may only post there: the payload carries tool inputs and the
    /// reader's prompts, and a cloned repository must not be able to send
    /// them anywhere else. The reader's own file may name any endpoint.
    public var postsToLoopback: Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    /// A short name the thread can use: the script the command runs, with the
    /// project-directory variable taken off, or else the start of the command.
    ///
    /// `"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh` reads as
    /// `.claude/hooks/guard.sh`, and `python3 hooks/lint.py` as
    /// `hooks/lint.py` — the file the reader would open to change it. An HTTP
    /// hook is its host and path; a prompt hook says it is one.
    public var displayName: String {
        switch kind {
        case .http:
            guard let url else { return "HTTP hook" }
            let host = url.host ?? ""
            let port = url.port.map { ":\($0)" } ?? ""
            return host + port + url.path
        case .prompt:
            let firstLine = command.split(separator: "\n").first.map(String.init) ?? command
            let text = firstLine.count <= 40 ? firstLine : String(firstLine.prefix(39)) + "…"
            return "Prompt: " + text
        case .command:
            break
        }
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

    /// What running the hook risks, in the ladder's terms.
    ///
    /// A command is graded like the agent's own commands. A prompt hook can
    /// only answer, so it is a read. An HTTP hook sends session data off the
    /// process: to this Mac it is graded like a contained command, anywhere
    /// else like a command that reaches the network.
    static func classify(kind: HookHandlerKind, command: String, url: URL?) -> ActionRisk {
        switch kind {
        case .prompt:
            return .read
        case .http:
            let host = url?.host?.lowercased() ?? ""
            let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
            return local ? .execute : .critical
        case .command:
            switch CommandClassifier().classify(command) {
            case let .permitted(risk, _): return risk
            case .forbidden: return .destructive
            }
        }
    }

    /// A hook's identity is what it is, not where it sits: its file, event,
    /// matcher, kind and what it runs. The reader's allowing and switching
    /// off are both keyed by it, so a position in the file would move them
    /// onto other hooks — or off these — whenever an entry above was added or
    /// removed, and a teammate's new `Notification` hook would silently stop
    /// the guards below it until they were allowed again.
    ///
    /// A command hook's ID is the one earlier builds gave it, so an allowed
    /// command stays allowed. An HTTP hook's headers and a prompt hook's
    /// model are part of its identity: changing where data goes, or who
    /// judges it, is a new hook that waits to be allowed.
    static func makeID(
        event: HookLifecycleEvent,
        matcher: HookMatcher,
        command: String,
        source: ExtensibilitySource,
        path: String,
        occurrence: Int,
        kind: HookHandlerKind = .command,
        headers: [String: String] = [:],
        model: String? = nil
    ) -> String {
        var identity = [
            source.rawValue,
            path,
            event.rawValue,
            matcher.pattern ?? "*",
            String(occurrence),
            command,
        ]
        if kind != .command {
            identity.append(kind.rawValue)
            identity.append(headers.keys.sorted().map { "\($0)=\(headers[$0] ?? "")" }.joined(separator: "\u{1e}"))
            identity.append(model ?? "")
        }
        return "hook-" + Digests.sha256Hex(identity.joined(separator: "\u{1f}"))
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
    /// The file set `disableAllHooks`. How far that reaches depends on whose
    /// file it is; `HookDiscovery` decides.
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
    /// The file whose `disableAllHooks` switched hooks off, if one did: the
    /// reader's own file switches off every hook, a repository file only the
    /// repository's (see `disablesReaderHooks`).
    public let disabledBy: String?

    /// Whether `disabledBy` reached the reader's own hooks, which only the
    /// reader's own file can do.
    public var disablesReaderHooks: Bool {
        disabledBy == HookConfigurationFile.junoUser.path
    }

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
/// Allowing a repository hook lets its entry run at all: the allowlist holds
/// hook IDs, and an ID covers the entry's file, event, matcher and command,
/// so an entry added or edited later waits to be allowed. It does not cover
/// what the command runs — the script it names, the `package.json` behind
/// `npm run lint` — and the agent can rewrite those files wherever the mode
/// lets it edit without asking. So an allowed repository hook still goes
/// through the permission mode on every run, exactly as the same command
/// would through `run_command`: Full access runs it, Edit automatically and
/// Ask before edits ask (unless the reader's own rules allow the command),
/// and a command that leaves the workspace always asks. Otherwise allowing
/// one hook would hand the agent every command it can write into that
/// script, in the very modes that promise commands ask.
///
/// The reader's own `~/.juno/settings.json` is spared the prompt. The reader
/// wrote the line, the agent cannot change that file without asking, and a
/// notifier that asked before announcing an approval would defeat itself.
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
            return .denied(reason: hook.kind == .command ? "The hook command is empty." : "The hook is empty.")
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

        switch hook.kind {
        case .prompt:
            // A small model's answer can only block, so there is nothing to
            // ask the reader about once the hook itself is allowed.
            guard hook.event.acceptsPromptHooks else {
                return .denied(reason: "A prompt hook cannot answer this event.")
            }
            return .allowed

        case .http:
            guard let url = hook.url,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  url.host != nil
            else {
                return .denied(reason: "The hook URL must be http or https with a host.")
            }
            // The reader's own file may post anywhere: they wrote the line.
            guard hook.isUntrusted else { return .allowed }
            guard hook.postsToLoopback else {
                return .denied(
                    reason: "A project's HTTP hook may only post to this Mac (localhost). Put it in ~/.juno/settings.json to post elsewhere."
                )
            }
            let expected = HookDefinition.classify(kind: .http, command: hook.command, url: url)
            guard hook.risk == expected else {
                return .denied(reason: "The hook risk metadata does not match its endpoint.")
            }
            switch PermissionPolicy.ruling(mode: permissionMode, risk: hook.risk) {
            case .allow: return .allowed
            case .requireApproval: return .requiresPermission(reason: "A project hook posts this session's data to \(url.absoluteString).")
            case let .deny(reason): return .denied(reason: reason)
            }

        case .command:
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
                guard hook.isUntrusted else { return .allowed }
                switch PermissionPolicy.ruling(mode: permissionMode, risk: risk) {
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

/// What a hook printed on standard output — or an HTTP hook answered, or a
/// prompt hook's model decided — in Claude Code's JSON shape. Read only
/// after exit code 0 (or a 2xx answer), as Claude Code does.
public struct HookOutput: Equatable, Sendable {
    /// `"continue": false` ends the run.
    public var continueRun: Bool
    public var stopReason: String?
    /// `"suppressOutput": true`: the hook's output is not shown in the
    /// thread. Decisions it carries still count.
    public var suppressOutput: Bool
    /// `"block"`, or the deprecated `"approve"` a `PreToolUse` hook may send.
    public var decision: String?
    public var reason: String?
    public var systemMessage: String?
    /// `PreToolUse`: `allow`, `deny` or `ask`; `defer` reads as `ask`.
    /// `PermissionRequest`: `hookSpecificOutput.decision.behavior`.
    public var permissionDecision: HookPermissionDecision?
    public var permissionDecisionReason: String?
    public var additionalContext: String?
    /// `PreToolUse`: arguments to run the tool with instead. Juno validates
    /// them against the tool's schema and authorizes the call again from
    /// scratch, at no lower a risk than the original arguments.
    public var updatedInput: JSONValue?

    public init(
        continueRun: Bool = true,
        stopReason: String? = nil,
        suppressOutput: Bool = false,
        decision: String? = nil,
        reason: String? = nil,
        systemMessage: String? = nil,
        permissionDecision: HookPermissionDecision? = nil,
        permissionDecisionReason: String? = nil,
        additionalContext: String? = nil,
        updatedInput: JSONValue? = nil
    ) {
        self.continueRun = continueRun
        self.stopReason = stopReason
        self.suppressOutput = suppressOutput
        self.decision = decision
        self.reason = reason
        self.systemMessage = systemMessage
        self.permissionDecision = permissionDecision
        self.permissionDecisionReason = permissionDecisionReason
        self.additionalContext = additionalContext
        self.updatedInput = updatedInput
    }

    /// Parses `stdout` as the JSON form, or nil when it is not a JSON object
    /// — plain text is a normal, supported answer.
    public init?(stdout: String, event: HookLifecycleEvent) {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"),
              let value = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)),
              let object = value.objectValue
        else { return nil }
        self.init(object: object, event: event)
    }

    /// Reads one already-decoded answer object.
    public init(object: [String: JSONValue], event: HookLifecycleEvent) {
        continueRun = object["continue"]?.boolValue ?? true
        stopReason = object["stopReason"]?.stringValue
        suppressOutput = object["suppressOutput"]?.boolValue ?? false
        decision = object["decision"]?.stringValue?.lowercased()
        reason = object["reason"]?.stringValue
        systemMessage = object["systemMessage"]?.stringValue

        // Event-specific fields count only when they say which event they are
        // for; a mismatch is a hook written for somewhere else.
        let specific = object["hookSpecificOutput"]?.objectValue
        let named = specific?["hookEventName"]?.stringValue
        if let specific, named == nil || named == event.rawValue {
            if event == .permissionRequest, let nested = specific["decision"]?.objectValue {
                permissionDecision = nested["behavior"]?.stringValue.flatMap(Self.permission(named:))
                permissionDecisionReason = nested["message"]?.stringValue
            } else {
                permissionDecision = specific["permissionDecision"]?.stringValue.flatMap(Self.permission(named:))
                permissionDecisionReason = specific["permissionDecisionReason"]?.stringValue
            }
            additionalContext = specific["additionalContext"]?.stringValue
            if event == .preToolUse, let updated = specific["updatedInput"], updated.objectValue != nil {
                updatedInput = updated
            } else {
                updatedInput = nil
            }
        } else {
            permissionDecision = nil
            permissionDecisionReason = nil
            additionalContext = nil
            updatedInput = nil
        }
    }

    /// `allow`, `deny`, `ask`; `defer` is an `ask` (§5.9).
    static func permission(named value: String) -> HookPermissionDecision? {
        let lowered = value.lowercased()
        return lowered == "defer" ? .ask : HookPermissionDecision(rawValue: lowered)
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
    /// the process when it prints more. An HTTP hook's answer body too.
    public static let maximumOutputBytes = 64 * 1_024
    /// Claude Code's default for a command or HTTP hook: ten minutes.
    public static let defaultTimeoutSeconds = 600.0
    /// A prompt hook's default: a small model's single turn.
    public static let promptTimeoutSeconds = 30.0
    /// Any hook on `UserPromptSubmit`, which holds the reader's message.
    public static let promptSubmitTimeoutSeconds = 30.0
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
    /// A prompt hook's text, after `$ARGUMENTS` is filled in.
    public static let maximumPromptHookCharacters = 24_000
}
