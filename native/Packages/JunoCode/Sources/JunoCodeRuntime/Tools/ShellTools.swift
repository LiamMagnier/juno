import Foundation
import JunoCodeCore

/// The working-directory argument of a shell tool: workspace-relative, or
/// the session's current folder when absent.
private func workingDirectory(
    _ input: JSONValue,
    sessionID: CodeSessionID,
    directories: SessionWorkingDirectories?
) throws -> WorkspacePath? {
    guard let raw = input["cwd"]?.stringValue?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
        return directories?.current(for: sessionID)
    }
    guard !raw.hasPrefix("/"), !raw.hasPrefix("~") else {
        throw ToolError.invalidInput(message: "cwd is relative to the workspace root, not an absolute path.")
    }
    do {
        // From the root, not the current folder: an explicit cwd names one
        // place however earlier commands moved.
        return try SessionWorkingDirectories.resolve(raw, from: nil, workspaceRoot: "/")
    } catch {
        throw ToolError.invalidInput(message: "cwd must be a folder inside the workspace, relative to its root.")
    }
}

/// How a shell's state reads in a tool result header.
private func statusFields(_ info: ShellSessionInfo) -> [String] {
    var fields = ["\"id\":\"\(info.id)\""]
    if let name = info.name { fields.append("\"name\":\(ReadFileTool.quoted(name))") }
    switch info.state {
    case let .running(pid):
        fields.append("\"status\":\"running\"")
        fields.append("\"pid\":\(pid)")
    case let .exited(code):
        fields.append("\"status\":\"exited\"")
        fields.append("\"exit_code\":\(code)")
    case let .signalled(signal):
        fields.append("\"status\":\"killed\"")
        fields.append("\"signal\":\"\(ShellSignal(rawSignal: signal)?.rawValue ?? String(signal))\"")
    case let .failed(reason):
        fields.append("\"status\":\"failed\"")
        fields.append("\"reason\":\(ReadFileTool.quoted(reason))")
    }
    return fields
}

/// Starts a long-lived process in the background.
public struct ShellStartTool: CodeTool {
    private let shells: any ShellSessionManaging
    private let directories: SessionWorkingDirectories?
    private let classifier = CommandClassifier()

    public init(shells: any ShellSessionManaging, directories: SessionWorkingDirectories? = nil) {
        self.shells = shells
        self.directories = directories
    }

    /// How long a start waits for first output, so a command that fails at
    /// once says so in the same result.
    static let startupWaitSeconds = 1.5

    public let name = "shell_start"
    public let description = """
        Start a long-running command in the background — a dev server, a \
        watcher, a slow build or test run you want to check on later — and \
        get its shell id back at once. It runs in the same sandbox as \
        run_command, in "cwd" (workspace-relative) or the session's current \
        folder, and keeps running across tool calls and turns until you stop \
        it with shell_kill or the session ends.

        Read its output with shell_output (new output since your last read, \
        or the last lines); send it input with shell_write. Give it a short \
        "name" to tell several apart. Do not add a trailing '&'. For a finite \
        command whose result you need now, use run_command instead. For a \
        web project's dev server prefer preview_server start; a server you \
        start here opens in the Preview pane once its process listens on a \
        loopback address it printed (or attach it with preview_server).
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "command": ["type": "string"],
                "cwd": ["type": "string", "description": "Workspace-relative folder to run in"],
                "name": ["type": "string", "description": "A short label, e.g. \"dev server\""],
            ],
            "required": ["command"],
        ]
    }

    /// As run_command sizes a command, but never below `execute`: a process
    /// that keeps running is not a read, whatever it runs.
    public func assessRisk(input: JSONValue) -> ActionRisk {
        guard let command = input["command"]?.stringValue else { return .critical }
        switch classifier.classify(command) {
        case let .permitted(risk, _):
            return max(risk, .execute)
        case .forbidden:
            return .critical
        }
    }

    public func summary(input: JSONValue) -> String {
        "Start in background: \(input["command"]?.stringValue ?? "?")"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let command = input["command"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !command.isEmpty
        else {
            return .invalidInput(message: "Missing non-empty 'command'.")
        }
        if ShellBackgrounding.runsInBackground(command) {
            return .invalidInput(message: "shell_start already runs the command in the background; drop the '&'.")
        }
        if case let .forbidden(reason) = classifier.classify(command) {
            return .denied(reason: reason)
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let command = input["command"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'command'.")
        }
        let directory = try workingDirectory(input, sessionID: context.sessionID, directories: directories)
        // A run stopped while this call waited for approval starts nothing:
        // a process started now would outlive the Stop that meant to end it.
        try Task.checkCancellation()
        let started = try await shells.start(
            command: command,
            workingDirectory: directory,
            name: input["name"]?.stringValue,
            ownerSessionID: context.sessionID,
            risk: assessRisk(input: input)
        )
        // A moment for early output — a port, or an immediate failure.
        let early = try await shells.output(
            id: started.id,
            ownerSessionID: context.sessionID,
            since: nil,
            tailLines: nil,
            maximumBytes: 8 * 1_024,
            waitSeconds: Self.startupWaitSeconds
        )
        var header = statusFields(early.info)
        header.append("\"cwd\":\(ReadFileTool.quoted(directory?.value ?? "."))")
        header.append("\"next_offset\":\(early.nextOffset)")
        let failed: Bool
        if case let .exited(code) = early.info.state { failed = code != 0 } else { failed = !early.info.state.isRunning }
        let output = early.text.isEmpty ? "(no output yet)" : early.text
        return ToolResult(
            content: "{\(header.joined(separator: ","))}\n\(output)",
            isError: failed
        )
    }
}

/// Reads a background shell's output, or lists the session's shells.
public struct ShellOutputTool: CodeTool {
    private let shells: any ShellSessionManaging

    public init(shells: any ShellSessionManaging) {
        self.shells = shells
    }

    public static let defaultMaximumBytes = 24 * 1_024
    public static let maximumBytesCap = 64 * 1_024
    public static let maximumWaitSeconds = 30.0

    public let name = "shell_output"
    public let description = """
        Read output from a background shell started with shell_start. The \
        header says whether it is still running (or its exit code) and gives \
        "next_offset".

        With just "id": everything new since your last read; a burst too large \
        to show keeps its start and end and says which bytes were left out. \
        "since": read from that offset instead (one page, up to max_bytes; \
        "more": true means call again with the new next_offset). \
        "tail_lines": only the last N lines. "wait_seconds" (up to 30) waits \
        for new output or for the process to end before answering — use it \
        to wait for a server to come up instead of polling.

        Without "id": lists this session's shells and their state.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "since": ["type": "integer", "description": "Byte offset to read from (a next_offset)"],
                "tail_lines": ["type": "integer"],
                "wait_seconds": ["type": "number"],
                "max_bytes": ["type": "integer"],
            ],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        input["id"]?.stringValue.map { "Read output of \($0)" } ?? "List background shells"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let id = input["id"]?.stringValue else {
            let owned = shells.sessions(ownedBy: context.sessionID)
            guard !owned.isEmpty else {
                return ToolResult(content: "No background shells in this session. Start one with shell_start.")
            }
            let lines = owned.map { info in
                "\(info.label): \(info.state.summary) — \(info.command)"
                    + (info.workingDirectory.map { " (in \($0.value))" } ?? "")
                    + " — \(info.outputBytes) bytes of output"
            }
            return ToolResult(content: lines.joined(separator: "\n"))
        }
        let maximum = min(max(input["max_bytes"]?.intValue ?? Self.defaultMaximumBytes, 256), Self.maximumBytesCap)
        let chunk: ShellOutputChunk
        do {
            chunk = try await shells.output(
                id: id,
                ownerSessionID: context.sessionID,
                since: input["since"]?.intValue,
                tailLines: input["tail_lines"]?.intValue,
                maximumBytes: maximum,
                waitSeconds: min(max(input["wait_seconds"]?.numberValue ?? 0, 0), Self.maximumWaitSeconds)
            )
        } catch let error as ShellSessionError {
            throw ToolError.executionFailed(message: error.description)
        }
        var header = statusFields(chunk.info)
        header.append("\"start_offset\":\(chunk.startOffset)")
        header.append("\"next_offset\":\(chunk.nextOffset)")
        header.append("\"total_bytes\":\(chunk.info.outputBytes)")
        if chunk.nextOffset < chunk.info.outputBytes {
            header.append("\"more\":true")
        }
        if chunk.droppedBytes > 0 {
            header.append("\"dropped_bytes\":\(chunk.droppedBytes)")
            header.append("\"note\":\"\(chunk.droppedBytes) older bytes are no longer kept\"")
        } else if chunk.omittedBytes > 0 {
            let headEnd = chunk.startOffset + (chunk.text.components(separatedBy: "\n… [omitted] …\n").first?.utf8.count ?? 0)
            header.append("\"omitted_bytes\":\(chunk.omittedBytes)")
            header.append("\"note\":\"the middle was left out; read it with since \(headEnd)\"")
        }
        let body = chunk.text.isEmpty ? "(no new output)" : chunk.text
        return ToolResult(content: "{\(header.joined(separator: ","))}\n\(body)")
    }
}

/// Sends text to a background shell's standard input.
public struct ShellWriteTool: CodeTool {
    private let shells: any ShellSessionManaging
    private let classifier = CommandClassifier()

    public init(shells: any ShellSessionManaging) {
        self.shells = shells
    }

    /// The most one write sends: what the reader is asked about must be
    /// something they can read.
    public static let maximumTextBytes = 16 * 1_024

    public let name = "shell_write"
    public let description = """
        Write text to the standard input of a background shell this session \
        started with shell_start — an answer to a prompt, a line for a REPL. \
        Include "\\n" to press return. Refused when the shell has ended, closed \
        its input, or is not reading what it was already sent. Read the \
        response with shell_output.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "text": ["type": "string"],
            ],
            "required": ["id", "text"],
        ]
    }

    /// Input to a process can do whatever the process does with input, so it
    /// is asked about at least at the tier the process was started at.
    ///
    /// And to a shell or interpreter reading its program from its input —
    /// `bash`, `python3`, `node` started bare — the text IS a program, one no
    /// rule of the classifier ever reads: exactly the inline program
    /// `bash -c "…"` is, rated `destructive` so every mode asks. At the start
    /// tier instead (`critical` for a bare `bash`), Full Access ran whatever
    /// was typed into it — `rm`, `osascript`, a `curl | sh` — unasked.
    public func assessRisk(input: JSONValue) -> ActionRisk {
        guard let id = input["id"]?.stringValue, let info = shells.info(id: id) else { return .execute }
        let started = max(info.risk, .execute)
        return classifier.readsProgramFromInput(info.command) ? max(started, .destructive) : started
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let id = input["id"]?.stringValue, !id.isEmpty else {
            return .invalidInput(message: "Missing 'id'.")
        }
        guard let text = input["text"]?.stringValue, !text.isEmpty else {
            return .invalidInput(message: "Missing non-empty 'text'.")
        }
        guard text.utf8.count <= Self.maximumTextBytes else {
            return .invalidInput(message: "Send at most \(Self.maximumTextBytes / 1_024) KB per write.")
        }
        return nil
    }

    /// The text as it will be sent, whole, so an approval shows all of it;
    /// line breaks read as ⏎.
    public func summary(input: JSONValue) -> String {
        let text = input["text"]?.stringValue ?? ""
        return "Send to \(input["id"]?.stringValue ?? "?"): \(text.replacingOccurrences(of: "\n", with: "⏎"))"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let id = input["id"]?.stringValue, let text = input["text"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'id' or 'text'.")
        }
        do {
            let written = try await shells.write(id: id, ownerSessionID: context.sessionID, text: text)
            let total = text.utf8.count
            return ToolResult(
                content: written == total
                    ? "Wrote \(written) bytes to \(id)."
                    : "Wrote \(written) of \(total) bytes to \(id); it stopped reading.",
                isError: written != total
            )
        } catch let error as ShellSessionError {
            throw ToolError.executionFailed(message: error.description)
        }
    }
}

/// Stops a background shell.
public struct ShellKillTool: CodeTool {
    private let shells: any ShellSessionManaging

    public init(shells: any ShellSessionManaging) {
        self.shells = shells
    }

    public let name = "shell_kill"
    public let description = """
        Stop a background shell this session started, and everything it \
        started. "signal" is SIGTERM by default; SIGINT is Ctrl-C, SIGKILL \
        cannot be ignored. The result says whether it has exited.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "signal": ["type": "string", "enum": .array(ShellSignal.allCases.map { .string($0.rawValue) })],
            ],
            "required": ["id"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .execute }

    public func summary(input: JSONValue) -> String {
        "Stop \(input["id"]?.stringValue ?? "?")"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        if let raw = input["signal"]?.stringValue, ShellSignal(rawValue: raw.uppercased()) == nil {
            return .invalidInput(message: "signal is one of \(ShellSignal.allCases.map(\.rawValue).joined(separator: ", ")).")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let id = input["id"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'id'.")
        }
        let signal = input["signal"]?.stringValue.flatMap { ShellSignal(rawValue: $0.uppercased()) } ?? .terminate
        do {
            let info = try await shells.kill(id: id, ownerSessionID: context.sessionID, signal: signal)
            if info.state.isRunning {
                return ToolResult(
                    content: "Sent \(signal.rawValue) to \(info.label); it is still running. Try SIGKILL.",
                    isError: true
                )
            }
            return ToolResult(content: "\(info.label) \(info.state.summary).")
        } catch let error as ShellSessionError {
            throw ToolError.executionFailed(message: error.description)
        }
    }
}
