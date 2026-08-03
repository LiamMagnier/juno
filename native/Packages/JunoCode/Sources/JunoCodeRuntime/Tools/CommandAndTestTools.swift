import Foundation
import JunoCodeCore

public struct RunCommandTool: CodeTool {
    public static let defaultTimeoutSeconds: Double = 120
    public static let maximumTimeoutSeconds: Double = 600

    private let executor: any CommandExecuting
    private let classifier = CommandClassifier()

    public init(executor: any CommandExecuting) {
        self.executor = executor
    }

    public let name = "run_command"
    public let description =
        "Run a shell command in the workspace root. Output is streamed and bounded; long commands are cut at the timeout."
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
        let limited = OutputLimiter.apply(.commandOutput, to: collected)
        return ToolResult(
            content: limited.text + footer,
            isError: !result.succeeded
        )
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
