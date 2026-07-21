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

    public init(tests: any TestRunning) {
        self.tests = tests
    }

    public let name = "run_tests"
    public let description =
        "Run the project's tests. Omit 'command' to use the detected test command."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["command": ["type": "string"]],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .execute }

    public func summary(input: JSONValue) -> String {
        if let command = input["command"]?.stringValue {
            return "Run tests: \(command)"
        }
        return "Run the detected test suite"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let command: String
        if let explicit = input["command"]?.stringValue, !explicit.isEmpty {
            command = explicit
        } else {
            let suggestions = await tests.detectSuggestions()
            guard let first = suggestions.first else {
                throw ToolError.executionFailed(
                    message: "No test toolchain detected; pass an explicit command."
                )
            }
            command = first.command
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
}
