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

    public init(
        executor: any CommandExecuting,
        changes: (any WorkspaceChangeDetecting)? = nil
    ) {
        self.executor = executor
        self.changes = changes
    }

    public let name = "run_command"
    public let description = """
        Run a shell command in the workspace root. Output is streamed and \
        bounded; long commands are cut at the timeout.

        Files this command changes are NOT checkpointed: only the structured \
        file tools (create_file, write_file, apply_patch, delete_file, \
        move_file) can be undone from the transcript. Prefer those for edits \
        you intend to be reviewable, and use a command when running one is the \
        point.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "command": ["type": "string"],
                "timeout_seconds": ["type": "number"],
            ],
            "required": ["command"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk {
        guard let command = input["command"]?.stringValue else { return .critical }
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
        if case let .forbidden(reason) = classifier.classify(command) {
            return .denied(reason: reason)
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let command = input["command"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'command'.")
        }
        if case let .forbidden(reason) = classifier.classify(command) {
            throw ToolError.denied(reason: reason)
        }
        let timeout = min(
            max(input["timeout_seconds"]?.numberValue ?? Self.defaultTimeoutSeconds, 1),
            Self.maximumTimeoutSeconds
        )
        let before = await changes?.snapshot()
        var collected = ""
        var result: CommandResult?
        for try await event in executor.stream(
            command,
            timeoutSeconds: timeout,
            outputLimit: .commandOutput
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
            throw ToolError.executionFailed(message: "Command stream ended unexpectedly.")
        }
        var footer = "\n[exit \(result.exitCode)"
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

        let limited = OutputLimiter.apply(.commandOutput, to: collected)
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
