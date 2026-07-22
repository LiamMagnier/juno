import Foundation

public struct TestSuggestion: Hashable, Codable, Sendable, Identifiable {
    public var id: String { command }
    public let command: String
    /// Display name of the detected toolchain, e.g. "Swift Package".
    public let toolchain: String

    public init(command: String, toolchain: String) {
        self.command = command
        self.toolchain = toolchain
    }
}

public struct TestRunOutcome: Hashable, Codable, Sendable {
    public let command: String
    public let passed: Bool
    public let testsRun: Int?
    public let failures: Int?
    public let durationSeconds: Double

    public init(
        command: String,
        passed: Bool,
        testsRun: Int?,
        failures: Int?,
        durationSeconds: Double
    ) {
        self.command = command
        self.passed = passed
        self.testsRun = testsRun
        self.failures = failures
        self.durationSeconds = durationSeconds
    }
}

/// Detects project test toolchains and runs test commands with streaming
/// output through the command execution layer.
public protocol TestRunning: Sendable {
    /// Suggested test commands for the workspace, best match first.
    func detectSuggestions() async -> [TestSuggestion]

    /// Streams a test run; the final `.completed` event carries the exit
    /// status the parser combines with the collected output.
    func stream(command: String, timeoutSeconds: Double) -> AsyncThrowingStream<CommandEvent, Error>
}

/// Pure parsing of well-known test-summary formats. Falls back to the exit
/// code when no summary is recognized.
public enum TestOutputParser {
    public static func parse(
        command: String,
        output: String,
        exitCode: Int32,
        durationSeconds: Double
    ) -> TestRunOutcome {
        var testsRun: Int?
        var failures: Int?

        // XCTest: "Executed 12 tests, with 2 failures (0 unexpected) in 0.5"
        if let match = firstMatch(
            in: output,
            pattern: "Executed ([0-9]+) tests?, with ([0-9]+) failures?",
            options: []
        ), match.count >= 3 {
            // Take the LAST occurrence (the overall suite summary).
            let all = allMatches(
                in: output,
                pattern: "Executed ([0-9]+) tests?, with ([0-9]+) failures?"
            )
            if let last = all.last, last.count >= 3 {
                testsRun = Int(last[1])
                failures = Int(last[2])
            } else {
                testsRun = Int(match[1])
                failures = Int(match[2])
            }
        }
        // Swift Testing: "Test run with 34 tests in 7 suites passed after 0.5 seconds."
        else if let match = firstMatch(
            in: output,
            pattern: "Test run with ([0-9]+) tests?[^\\n]* (passed|failed)",
            options: []
        ), match.count >= 3 {
            testsRun = Int(match[1])
            failures = match[2] == "passed" ? 0 : nil
        }
        // Jest/Vitest: "Tests: 1 failed, 5 passed, 6 total"
        else if let match = firstMatch(
            in: output,
            pattern: "Tests:[^\\n]*?([0-9]+) total",
            options: []
        ), match.count >= 2 {
            testsRun = Int(match[1])
            if let failedMatch = firstMatch(
                in: output,
                pattern: "Tests:[^\\n]*?([0-9]+) failed",
                options: []
            ), failedMatch.count >= 2 {
                failures = Int(failedMatch[1])
            } else {
                failures = 0
            }
        }
        // pytest: "3 passed, 1 failed in 1.2s" / "5 passed in 0.1s"
        else if let match = firstMatch(
            in: output,
            pattern: "=+ (?:[0-9]+ [a-z]+, )*[0-9]+ [a-z]+ in [0-9.]+s",
            options: []
        ), !match.isEmpty {
            let summary = match[0]
            var run = 0
            if let passed = firstMatch(in: summary, pattern: "([0-9]+) passed", options: []),
               passed.count >= 2
            {
                run += Int(passed[1]) ?? 0
            }
            if let failed = firstMatch(in: summary, pattern: "([0-9]+) failed", options: []),
               failed.count >= 2
            {
                failures = Int(failed[1])
                run += Int(failed[1]) ?? 0
            } else {
                failures = 0
            }
            if let errored = firstMatch(in: summary, pattern: "([0-9]+) error", options: []),
               errored.count >= 2
            {
                failures = (failures ?? 0) + (Int(errored[1]) ?? 0)
                run += Int(errored[1]) ?? 0
            }
            testsRun = run > 0 ? run : nil
        }
        // cargo: "test result: ok. 10 passed; 0 failed;"
        else if let match = firstMatch(
            in: output,
            pattern: "test result: (?:ok|FAILED)\\. ([0-9]+) passed; ([0-9]+) failed",
            options: []
        ), match.count >= 3 {
            let passed = Int(match[1]) ?? 0
            failures = Int(match[2])
            testsRun = passed + (failures ?? 0)
        }

        return TestRunOutcome(
            command: command,
            passed: exitCode == 0,
            testsRun: testsRun,
            failures: failures,
            durationSeconds: durationSeconds
        )
    }

    private static func firstMatch(
        in text: String,
        pattern: String,
        options: NSRegularExpression.Options
    ) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }
        return captureGroups(match, in: text)
    }

    private static func allMatches(in text: String, pattern: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, options: [], range: range).map {
            captureGroups($0, in: text)
        }
    }

    private static func captureGroups(_ match: NSTextCheckingResult, in text: String) -> [String] {
        (0..<match.numberOfRanges).map { index in
            guard let range = Range(match.range(at: index), in: text) else { return "" }
            return String(text[range])
        }
    }
}
