import Foundation
import JunoCodeCore

public struct RunCommandTool: CodeTool {
    public static let defaultTimeoutSeconds: Double = 120
    public static let maximumTimeoutSeconds: Double = 600

    private let executor: any CommandExecuting
    private let classifier = CommandClassifier()
    /// Optional, because a registry can be built without a scannable workspace
    /// root (inspection mode, tests with a stub executor). When it is absent
    /// the tool reports nothing about files rather than guessing.
    private let changes: (any WorkspaceChangeDetecting)?
    /// Each session's current folder. Nil runs every command at the root.
    private let directories: SessionWorkingDirectories?
    /// The root's absolute path, so `cd /abs/inside/workspace` is understood.
    private let workspaceRoot: String

    public init(
        executor: any CommandExecuting,
        changes: (any WorkspaceChangeDetecting)? = nil,
        directories: SessionWorkingDirectories? = nil,
        workspaceRoot: String = ""
    ) {
        self.executor = executor
        self.changes = changes
        self.directories = directories
        self.workspaceRoot = workspaceRoot
    }

    public let name = "run_command"
    public let description = """
        Run a finite shell command. Output is streamed and bounded; commands \
        that exceed the timeout are terminated.

        Working directory: each call starts a fresh shell in the session's \
        current folder — the workspace root until you change it. A command \
        that is ONLY `cd <dir>` changes that folder for every later \
        run_command and shell_start in this session (it cannot leave the \
        workspace). A cd inside a longer command (`cd app && make`) applies to \
        that command alone. "cwd" (workspace-relative) runs one command \
        elsewhere without changing the current folder. Variables exported by \
        one call do not reach the next.

        Do NOT end a command with & or start dev servers, watchers or other \
        long-running processes here: use shell_start, which keeps them \
        running in the background, and read them with shell_output. For a \
        website preview in Juno's browser, use open_preview.

        Files this command changes are NOT checkpointed: only the structured \
        file tools (create_file, write_file, apply_patch, multi_edit, \
        delete_file, move_file) can be undone from the transcript. Prefer \
        those for edits you intend to be reviewable, and use a command when \
        running one is the point.

        Commands usually run in a sandbox that writes only inside the \
        workspace, the temporary folder and package-manager caches. Give \
        xcodebuild a -derivedDataPath inside the workspace.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "command": ["type": "string"],
                "timeout_seconds": ["type": "number"],
                "cwd": ["type": "string", "description": "Workspace-relative folder for this command only"],
            ],
            "required": ["command"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk {
        guard let command = input["command"]?.stringValue else { return .critical }
        // A lone `cd` runs nothing: the tool resolves it itself and refuses
        // any folder outside the workspace, so `cd ..` back up from a
        // subfolder is not the escape its text would suggest.
        if directories != nil, Self.wholeCommandDirectoryChange(command) != nil {
            return .read
        }
        switch classifier.classify(command) {
        case let .permitted(risk, _):
            return risk
        case .forbidden:
            return .critical
        }
    }

    public func summary(input: JSONValue) -> String {
        let command = input["command"]?.stringValue ?? "?"
        return "Run: \(command)"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let command = input["command"]?.stringValue else { return nil }
        if let previewError = checkForUnmanagedPreviewServer(command) {
            return previewError
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
        if let previewError = checkForUnmanagedPreviewServer(command) {
            throw previewError
        }
        if case let .forbidden(reason) = classifier.classify(command) {
            throw ToolError.denied(reason: reason)
        }
        if let target = Self.wholeCommandDirectoryChange(command) {
            return try changeDirectory(to: target, sessionID: context.sessionID)
        }
        let directory = try commandDirectory(input, sessionID: context.sessionID)
        let timeout = min(
            max(input["timeout_seconds"]?.numberValue ?? Self.defaultTimeoutSeconds, 1),
            Self.maximumTimeoutSeconds
        )
        let before = await changes?.snapshot()
        var collected = ""
        var result: CommandResult?
        let stream: AsyncThrowingStream<CommandEvent, Error>
        if let directory {
            guard let scoped = executor as? any DirectoryScopedCommandExecuting else {
                throw ToolError.executionFailed(message: "This workspace runs commands only at its root.")
            }
            stream = scoped.stream(
                command,
                timeoutSeconds: timeout,
                outputLimit: .commandOutput,
                workingDirectory: directory
            )
        } else {
            stream = executor.stream(command, timeoutSeconds: timeout, outputLimit: .commandOutput)
        }
        for try await event in stream {
            switch event {
            case let .stdout(text):
                collected += text
                await context.emitOutput(.stdout, text)
            case let .stderr(text):
                collected += text
                await context.emitOutput(.stderr, text)
            case let .completed(final):
                result = final
            }
        }
        guard let result else {
            throw ToolError.executionFailed(message: "Command stream ended unexpectedly.")
        }
        var footer = "\n[exit \(result.exitCode)"
        if let directory { footer += ", in \(directory.value)" }
        if result.wasTimeout { footer += ", timed out" }
        if result.wasTruncated { footer += ", output truncated" }
        footer += String(format: ", %.1fs]", result.durationSeconds)

        // What the command did to the workspace, as far as a before/after scan
        // can tell. These carry no checkpoint id, which is the literal truth:
        // they are visible in the transcript and they are not undoable from it.
        var report: WorkspaceChangeReport?
        if let before, let detector = changes {
            report = WorkspaceChangeReport.comparing(before: before, after: await detector.snapshot())
        }
        if let report, !report.isEmpty {
            footer += "\n" + Self.changeSummary(report)
        }

        let limited = OutputLimiter.applyKeepingEnds(.commandOutput, to: collected)
        return ToolResult(
            content: limited.text + footer,
            isError: !result.succeeded,
            sideEffects: Self.changeEvents(report)
        )
    }

    static func changeSummary(_ report: WorkspaceChangeReport) -> String {
        var parts: [String] = []
        if !report.created.isEmpty { parts.append("\(report.created.count) added") }
        if !report.modified.isEmpty { parts.append("\(report.modified.count) changed") }
        if !report.deleted.isEmpty { parts.append("\(report.deleted.count) deleted") }
        let counts = parts.joined(separator: ", ")
        let qualifier = report.isPartial ? "at least " : ""
        return
            "[files: \(qualifier)\(counts). These were changed by the command, not by a file tool, "
            + "so they are not checkpointed and cannot be undone from the transcript.]"
    }

    private static func changeEvents(_ report: WorkspaceChangeReport?) -> [SessionEventPayload] {
        guard let report else { return [] }
        let entries: [(WorkspacePath, FileChangeKind)] =
            report.created.map { ($0, .created) }
            + report.modified.map { ($0, .modified) }
            + report.deleted.map { ($0, .deleted) }
        return entries.map { path, kind in
            .fileChanged(
                FileChangedEvent(
                    path: path,
                    kind: kind,
                    linesAdded: 0,
                    linesRemoved: 0,
                    // Nil is the whole point: no checkpoint exists, so the undo
                    // affordance must not appear for these rows.
                    checkpointID: nil
                )
            )
        }
    }

    // MARK: - Working directory

    /// The target of a command that is nothing but `cd <dir>` (or bare `cd`,
    /// the root), or nil for any other command.
    static func wholeCommandDirectoryChange(_ command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed == "cd" || trimmed.hasPrefix("cd ") || trimmed.hasPrefix("cd\t") else { return nil }
        let argument = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        if argument.isEmpty { return "" }
        // One argument: a single quoted string, or one word with no shell
        // syntax in it. Anything more is a real command line and runs as one.
        if let first = argument.first, first == "\"" || first == "'" {
            guard argument.count >= 2, argument.last == first,
                  !argument.dropFirst().dropLast().contains(first)
            else { return nil }
            return argument
        }
        let syntax = CharacterSet(charactersIn: " \t;&|<>()$`\\\"'*?[]{}!#")
        guard argument.unicodeScalars.allSatisfy({ !syntax.contains($0) }) else { return nil }
        return argument
    }

    private func changeDirectory(to target: String, sessionID: CodeSessionID) throws -> ToolResult {
        guard let directories else {
            throw ToolError.executionFailed(
                message: "A lone cd has no effect here: every command runs at the workspace root. Chain it instead (cd dir && command)."
            )
        }
        let previous = directories.current(for: sessionID)
        let resolved: WorkspacePath?
        do {
            resolved = try SessionWorkingDirectories.resolve(target, from: previous, workspaceRoot: workspaceRoot)
        } catch let error as ShellSessionError {
            throw ToolError.executionFailed(message: error.description)
        }
        if let resolved {
            guard let scoped = executor as? any DirectoryScopedCommandExecuting else {
                throw ToolError.executionFailed(message: "This workspace runs commands only at its root.")
            }
            do {
                try scoped.validateWorkingDirectory(resolved)
            } catch {
                throw ToolError.executionFailed(message: String(describing: error))
            }
        }
        directories.set(resolved, for: sessionID)
        let now = resolved?.value ?? "the workspace root"
        let before = previous?.value ?? "the workspace root"
        return ToolResult(
            content: "Working directory for run_command and shell_start is now \(now) (was \(before))."
        )
    }

    /// The folder this call runs in: its own `cwd`, else the session's.
    private func commandDirectory(_ input: JSONValue, sessionID: CodeSessionID) throws -> WorkspacePath? {
        guard let raw = input["cwd"]?.stringValue?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return directories?.current(for: sessionID)
        }
        guard !raw.hasPrefix("/"), !raw.hasPrefix("~") else {
            throw ToolError.invalidInput(message: "cwd is relative to the workspace root, not an absolute path.")
        }
        do {
            return try SessionWorkingDirectories.resolve(raw, from: nil, workspaceRoot: workspaceRoot)
        } catch {
            throw ToolError.invalidInput(message: "cwd must be a folder inside the workspace, relative to its root.")
        }
    }

    // MARK: - Refusals

    private func checkForUnmanagedPreviewServer(_ command: String) -> ToolError? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        if ShellBackgrounding.runsInBackground(trimmed) {
            return .denied(
                reason: "run_command waits for its command to finish, so it does not run '&' background jobs. Start long-running processes with shell_start and read them with shell_output (open_preview for a website preview)."
            )
        }
        let lower = trimmed.lowercased()
        if lower.contains("http.server") || lower.contains("simplehttpserver")
            || lower.hasPrefix("npx serve") || lower.hasPrefix("npx -y serve") || lower.contains(" -y serve")
            || lower.hasPrefix("serve ") || lower == "serve"
            || lower.hasPrefix("http-server") || lower.hasPrefix("live-server")
            || lower == "npm run dev" || lower == "pnpm run dev" || lower == "yarn dev" || lower == "bun run dev"
            || lower.hasPrefix("vite") || lower.hasPrefix("next dev") || lower.hasPrefix("astro dev")
        {
            return .denied(
                reason: "A development server never finishes, so run_command would wait on it until it timed out. Start it with shell_start and read it with shell_output, or use open_preview for a website preview in Juno's browser."
            )
        }
        return nil
    }
}

public struct RunTestsTool: CodeTool {
    public static let defaultTimeoutSeconds: Double = 600

    private let tests: any TestRunning
    private let classifier = CommandClassifier()

    public init(tests: any TestRunning) {
        self.tests = tests
    }

    public let name = "run_tests"
    public let description = """
        Run an explicit project test or verification command. The user is asked \
        to approve the exact command every time it runs, in every permission \
        mode that allows commands at all — a read-only session refuses it \
        outright rather than offering the prompt.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["command": ["type": "string"]],
            "required": ["command"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk {
        // Test commands execute repository-controlled code — package scripts,
        // compiler plugins, build phases, test binaries — but inside the
        // granted workspace. That is what `.critical` means.
        .critical
    }

    /// The bit `.critical` could not carry.
    ///
    /// Full Access exists to let `.critical` through, so the description's
    /// promise that "the exact command always requires approval" was false in
    /// exactly the mode where running an arbitrary repository-authored script
    /// unseen matters most. The pin states the requirement directly instead of
    /// trying to encode it as blast radius.
    public var approvalPolicy: ApprovalPolicy { .alwaysRequiresApproval }

    public func summary(input: JSONValue) -> String {
        "Run tests: \(input["command"]?.stringValue ?? "?")"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let command = explicitCommand(from: input) else {
            return .invalidInput(message: "Missing non-empty 'command'.")
        }
        if case let .forbidden(reason) = classifier.classify(command) {
            return .denied(reason: reason)
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let command = explicitCommand(from: input) else {
            throw ToolError.invalidInput(message: "Missing non-empty 'command'.")
        }
        if case let .forbidden(reason) = classifier.classify(command) {
            throw ToolError.denied(reason: reason)
        }
        var collected = ""
        var result: CommandResult?
        for try await event in tests.stream(
            command: command,
            timeoutSeconds: Self.defaultTimeoutSeconds
        ) {
            switch event {
            case let .stdout(text):
                collected += text
                await context.emitOutput(.stdout, text)
            case let .stderr(text):
                collected += text
                await context.emitOutput(.stderr, text)
            case let .completed(final):
                result = final
            }
        }
        guard let result else {
            throw ToolError.executionFailed(message: "Test stream ended unexpectedly.")
        }
        let outcome = TestOutputParser.parse(
            command: command,
            output: collected,
            exitCode: result.exitCode,
            durationSeconds: result.durationSeconds
        )
        var report = outcome.passed ? "Tests passed" : "Tests failed"
        if let run = outcome.testsRun {
            report += " — \(run) run"
            if let failures = outcome.failures {
                report += ", \(failures) failed"
            }
        }
        report += String(format: " (%.1fs)", outcome.durationSeconds)
        let limited = OutputLimiter.apply(
            OutputLimit(maximumBytes: 32 * 1_024),
            to: collected.suffix(40_000).description
        )
        return ToolResult(
            content: report + "\n" + limited.text,
            isError: !outcome.passed,
            sideEffects: [
                .testRunCompleted(
                    TestRunCompletedEvent(
                        command: command,
                        passed: outcome.passed,
                        testsRun: outcome.testsRun,
                        failures: outcome.failures,
                        durationSeconds: outcome.durationSeconds
                    )
                )
            ]
        )
    }

    private func explicitCommand(from input: JSONValue) -> String? {
        guard let rawCommand = input["command"]?.stringValue else {
            return nil
        }
        let command = rawCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { return nil }
        return command
    }
}
