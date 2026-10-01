import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

// Stand-ins for the autonomous loop's tests: tools whose side effects are the
// ledger's inputs (an edit, a check, a diff read), a scripted judge, a check
// runner, and an injected clock. No network, no real screen, no real
// commands.

/// Changes one file, as an edit tool reports it.
struct EditStubTool: CodeTool {
    let name = "edit_stub"
    let description = "Edits a file (test stand-in)."
    let inputSchema: JSONValue = ["type": "object", "properties": ["path": ["type": "string"]]]

    func assessRisk(input _: JSONValue) -> ActionRisk { .write }
    func summary(input: JSONValue) -> String { "Edit \(input["path"]?.stringValue ?? "a file")" }

    func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let path = input["path"]?.stringValue ?? "src/menu.ts"
        return ToolResult(
            content: "Edited \(path).",
            sideEffects: [.fileChanged(FileChangedEvent(
                path: try WorkspacePath(path),
                kind: .modified,
                linesAdded: 3,
                linesRemoved: 1,
                checkpointID: nil
            ))]
        )
    }
}

/// Runs a check and records its result as evidence. `passed` and `excerpt`
/// come from the call, so a script decides how each run goes.
struct CheckStubTool: CodeTool {
    let name = "check_stub"
    let description = "Runs the project's check (test stand-in)."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": ["passed": ["type": "boolean"], "excerpt": ["type": "string"], "command": ["type": "string"]],
    ]

    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Run the check" }

    func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let passed = input["passed"]?.boolValue ?? true
        let command = input["command"]?.stringValue ?? "swift test"
        return ToolResult(
            content: passed ? "\(command) passed" : "\(command) failed",
            isError: !passed,
            sideEffects: [.verificationRecorded(VerificationRecord(
                command: command,
                kind: .test,
                exitCode: passed ? 0 : 1,
                passed: passed,
                workspaceRevision: -1,
                durationMs: 900,
                excerpt: input["excerpt"]?.stringValue ?? (passed ? "4 tests passed" : "1 failure")
            ))]
        )
    }
}

/// Reads the diff, as `git_diff` does.
struct DiffStubTool: CodeTool {
    let name = "git_diff"
    let description = "Shows the diff (test stand-in)."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Read the diff" }

    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "diff --git a/src/menu.ts b/src/menu.ts")
    }
}

/// A tool that does nothing, for turns that only need to make a call.
struct NoopStubTool: CodeTool {
    let name = "noop_stub"
    let description = "Does nothing (test stand-in)."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Look around" }

    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "ok")
    }
}

/// A judge that answers from a script: a verdict, or a failure.
actor ScriptedJudge: CompletionJudging {
    enum Answer {
        case verdict(GoalVerdictKind, String, [String] = [])
        case failure
    }

    private var answers: [Answer]
    private(set) var calls: [JudgeInput] = []

    init(_ answers: [Answer]) {
        self.answers = answers
    }

    func judge(_ input: JudgeInput) async throws -> GoalVerdict {
        calls.append(input)
        let answer = answers.isEmpty ? .verdict(.notMet, "not yet") : answers.removeFirst()
        switch answer {
        case let .verdict(kind, reason, unmet):
            return GoalVerdict(kind: kind, reason: reason, unmetCriteria: unmet, revision: 0)
        case .failure:
            throw CompletionJudgeError.malformedVerdict("scripted failure")
        }
    }
}

/// Runs recipe checks for the stop check, but only a command the reader's
/// rules or a task grant already allow without a prompt — as Lane B's runner
/// must, through the same coordinator.
actor RecordingCheckRunner: GateCheckRunning {
    private let permissions: PermissionCoordinator
    private let recipe: GateRecipe
    private let passes: Bool
    private(set) var ran: [[String]] = []

    init(permissions: PermissionCoordinator, recipe: GateRecipe, passes: Bool = true) {
        self.permissions = permissions
        self.recipe = recipe
        self.passes = passes
    }

    func runChecks(ids: [String], sessionID _: CodeSessionID) async -> [VerificationRecord] {
        ran.append(ids)
        var records: [VerificationRecord] = []
        for id in ids {
            guard let check = recipe.check(id: id),
                  await permissions.allowsWithoutPrompt(toolName: "run_command", subject: .command(check.command), risk: .execute)
            else { continue }
            records.append(VerificationRecord(
                checkID: id,
                command: check.command,
                kind: check.kind,
                exitCode: passes ? 0 : 1,
                passed: passes,
                workspaceRevision: -1,
                durationMs: 1_000,
                excerpt: passes ? "passed" : "1 failure"
            ))
        }
        return records
    }
}

/// A clock a test moves by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
        current = start
    }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(minutes: Double) {
        lock.lock()
        current = current.addingTimeInterval(minutes * 60)
        lock.unlock()
    }
}

extension ScriptedModelClient.Step {
    static func call(_ name: String, _ input: JSONValue = [:], id: String = UUID().uuidString) -> Self {
        .toolCalls([(id: id, name: name, input: input)], text: "")
    }

    static func calls(_ calls: [(String, JSONValue)]) -> Self {
        .toolCalls(calls.map { (id: UUID().uuidString, name: $0.0, input: $0.1) }, text: "")
    }
}

/// The runtime note a request ends with, if it ends with one.
func lastRuntimeNote(_ request: ModelTurnRequest) -> String? {
    for message in request.messages.reversed() {
        guard case let .user(text) = message else { continue }
        if RuntimeNote.isRuntimeNote(text) { return text }
        if text.hasPrefix("<session_state") { continue }
        return nil
    }
    return nil
}
