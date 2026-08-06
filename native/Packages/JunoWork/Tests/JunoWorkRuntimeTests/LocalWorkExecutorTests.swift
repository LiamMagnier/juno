import Foundation
import JunoWorkCore
import JunoWorkLocal
import JunoWorkRuntime
import XCTest

/// Records what the run host was asked to do, without running a model.
///
/// An actor rather than a lock-guarded class because everything the protocol
/// asks for is already `async`, so isolation costs nothing and the test cannot
/// read a half-written array.
private actor RecordingRunHost: WorkRunHosting {
    struct Stop: Sendable {
        let runID: String
        let reason: String
    }

    private(set) var started: [WorkRunRequest] = []
    private(set) var resumed: [String] = []
    private(set) var paused: [String] = []
    private(set) var stopped: [Stop] = []
    private(set) var answers: [String] = []
    /// Kept apart from `answers`, so a test can prove the executor did not
    /// collapse the two kinds into one — which is exactly the mistake that would
    /// make a steer arrive as though the run had asked for it.
    private(set) var instructions: [String] = []

    func startRun(_ request: WorkRunRequest) async throws { started.append(request) }
    func resumeRun(_ request: WorkRunRequest) async throws { resumed.append(request.runID) }
    func pauseRun(runID: String) async throws { paused.append(runID) }
    func stopRun(runID: String, reason: String) async throws {
        stopped.append(Stop(runID: runID, reason: reason))
    }
    func deliverAnswer(runID: String, text: String) async throws { answers.append(text) }
    func deliverInstruction(runID: String, text: String) async throws {
        instructions.append(text)
    }
}

/// A free function for the same reason ``WorkApprovalCoordinatorTests`` uses
/// one: these tests leave a tool call suspended in a detached `Task` while the
/// executor answers it, and a closure capturing the test case would be capturing
/// something that is not `Sendable`.
private func applyChanges(
    in runtime: WorkGrantRuntime,
    operations: WorkToolValue,
    approvals: WorkApprovalCoordinator,
    runID: String = "run-1"
) async throws -> WorkToolResult {
    try await runtime.tools.invoke(
        toolName: "apply_changes",
        input: ["operations": operations],
        runID: runID,
        toolCallID: "call-1",
        approvals: approvals
    )
}

final class LocalWorkExecutorTests: XCTestCase {
    private struct Harness {
        let sandbox: WorkRuntimeSandbox
        let runtime: WorkGrantRuntime
        let approvals: WorkApprovalCoordinator
        let executor: LocalWorkExecutor
        let runs: RecordingRunHost
        let clock: TestClock
    }

    private func makeHarness(
        policy: WorkPermissionPolicy = .conservative,
        mode: WorkAccessMode = .readWrite,
        grantPicker: (any WorkGrantRequesting)? = nil
    ) throws -> Harness {
        let sandbox = try makeRuntimeSandbox()
        let clock = TestClock()
        let ledger = WorkUndoLedger()
        let runtime = try makeGrantRuntime(sandbox, mode: mode, undo: ledger)
        let approvals = makeCoordinator(policy: policy, clock: clock)
        let runs = RecordingRunHost()
        let executor = LocalWorkExecutor(
            hostID: "mac-1",
            approvals: approvals,
            undo: ledger,
            runs: runs,
            grants: [runtime],
            grantRequests: grantPicker,
            manifest: {
                WorkCapabilityManifest(
                    hostID: "mac-1",
                    displayName: "This Mac",
                    toggles: WorkHostToggles(workEnabled: true, activeFolderGrants: 1),
                    generatedAt: Date(timeIntervalSince1970: 1_800_000_000)
                )
            },
            now: { clock.now }
        )
        return Harness(
            sandbox: sandbox,
            runtime: runtime,
            approvals: approvals,
            executor: executor,
            runs: runs,
            clock: clock
        )
    }

    private func command(
        _ kind: String,
        runID: String? = "run-1",
        payload: [String: WorkToolValue] = [:],
        validFor seconds: TimeInterval = 300,
        clock: TestClock
    ) -> WorkLocalCommand {
        WorkLocalCommand(
            id: "command-\(kind)",
            sessionID: "session-1",
            runID: runID,
            kind: kind,
            payload: payload,
            expiresAt: clock.now.addingTimeInterval(seconds)
        )
    }

    // MARK: - Nothing is guessed, nothing stale is acted on

    /// The rule that keeps a newer phone from making an older Mac improvise. A
    /// "delete" it does not understand must not become the nearest thing it
    /// does.
    func testAnInstructionThisBuildDoesNotUnderstandIsRefused() async throws {
        let harness = try makeHarness()
        await assertThrowsAsync(
            try await harness.executor.execute(
                command("obliterate", clock: harness.clock)
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkLocalExecutionError,
                .unsupportedCommandKind("obliterate")
            )
        }
        let started = await harness.runs.started
        XCTAssertTrue(started.isEmpty)
    }

    /// Checked at execution time, not only when it was claimed. A "stop" claimed
    /// by a Mac that had been asleep for an hour would stop a task the person
    /// has since restarted.
    func testAnExpiredInstructionIsRefusedEvenThoughItsKindIsUnderstood() async throws {
        let harness = try makeHarness()
        let instruction = command("stop", validFor: 60, clock: harness.clock)
        harness.clock.advance(by: 61)

        await assertThrowsAsync(try await harness.executor.execute(instruction)) { error in
            XCTAssertEqual(error as? WorkLocalExecutionError, .commandExpired)
        }
        let stopped = await harness.runs.stopped
        XCTAssertTrue(stopped.isEmpty)
    }

    func testAnInstructionWithoutTheTaskItIsAboutIsRefused() async throws {
        let harness = try makeHarness()
        await assertThrowsAsync(
            try await harness.executor.execute(
                command("start", runID: nil, clock: harness.clock)
            )
        ) { error in
            XCTAssertEqual(error as? WorkLocalExecutionError, .missingField("task"))
        }
    }

    /// A steer reaches the loop as an instruction, never as an answer.
    ///
    /// The two arrive over one route and are two command kinds precisely so that
    /// this Mac can keep them apart. An instruction handed to `deliverAnswer`
    /// would be pasted into the transcript unframed, where it reads as the goal
    /// being restated rather than as a correction to it.
    func testAnInstructionReachesTheLoopAsOneRatherThanAsAnAnswer() async throws {
        let harness = try makeHarness()
        let receipt = try await harness.executor.execute(
            command(
                "steer",
                payload: ["text": .string("Use the March figures, not February.")],
                clock: harness.clock
            )
        )
        XCTAssertEqual(receipt["delivered"], .bool(true))
        XCTAssertEqual(receipt["runId"], .string("run-1"))

        let instructions = await harness.runs.instructions
        XCTAssertEqual(instructions, ["Use the March figures, not February."])
        let answers = await harness.runs.answers
        XCTAssertTrue(answers.isEmpty)
    }

    /// An empty instruction is refused rather than delivered as a blank turn.
    ///
    /// A blank user message is one the model has to interpret with nothing there
    /// to interpret, and the person who typed a sentence would have been told it
    /// landed.
    func testAnInstructionWithNothingInItIsRefused() async throws {
        let harness = try makeHarness()
        await assertThrowsAsync(
            try await harness.executor.execute(
                command("steer", payload: ["text": .string("")], clock: harness.clock)
            )
        ) { error in
            XCTAssertEqual(error as? WorkLocalExecutionError, .missingField("instruction"))
        }
        let instructions = await harness.runs.instructions
        XCTAssertTrue(instructions.isEmpty)
    }

    func testThisMacAnswersAPingAndSaysWhatItCanDo() async throws {
        let harness = try makeHarness()
        let pong = try await harness.executor.execute(
            command("ping", runID: nil, clock: harness.clock)
        )
        XCTAssertEqual(pong["ok"], .bool(true))
        XCTAssertEqual(pong["hostId"], .string("mac-1"))

        let capabilities = try await harness.executor.execute(
            command("refresh_capabilities", runID: nil, clock: harness.clock)
        )
        XCTAssertEqual(
            capabilities["capabilities"],
            .array([.string(WorkCapability.localFiles.rawValue)])
        )
    }

    // MARK: - The escalation boundary

    /// The whole point of routing a dispatched task through this Mac's own
    /// runtime: the folders a run may touch come from the grants the person
    /// made here, and the instruction only says what is wanted.
    func testStartHandsTheRunThisMacsOwnGrantsAndNothingFromThePayload() async throws {
        let harness = try makeHarness()
        _ = try await harness.executor.execute(
            command(
                "start",
                payload: [
                    "goal": "Tidy my scans",
                    "grantId": "a-folder-on-somebody-elses-mac",
                    "approvalPolicy": "permissive",
                ],
                clock: harness.clock
            )
        )

        let started = await harness.runs.started
        XCTAssertEqual(started.count, 1)
        let request = try XCTUnwrap(started.first)
        XCTAssertEqual(request.grants.map(\.grantID.value), ["grant-1"])
        // The payload survives as data the run can read, and buys nothing.
        XCTAssertEqual(request.payload["goal"], .string("Tidy my scans"))
        let policy = await harness.approvals.permissionPolicy
        XCTAssertEqual(policy, .conservative, "a payload must not widen this Mac's policy")
    }

    func testAFolderGrantCannotBeMintedWhenNobodyIsAtTheMac() async throws {
        let harness = try makeHarness()
        await assertThrowsAsync(
            try await harness.executor.execute(
                command("grant_folder", runID: nil, clock: harness.clock)
            )
        ) { error in
            XCTAssertEqual(error as? WorkLocalExecutionError, .grantPickerNotAvailable)
        }
    }

    // MARK: - Answering a question the run is waiting on

    /// The whole loop, end to end: a batch previews itself, suspends on an
    /// approval, a phone answers through the relay, and only then does anything
    /// on disk move.
    func testApprovingThroughAnInstructionUnblocksTheBatchThatWasWaiting() async throws {
        let harness = try makeHarness(policy: .conservative)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")
        try harness.sandbox.writeInGrant("scan-2.pdf", "two")

        let runtime = harness.runtime
        let approvals = harness.approvals
        let batch = Task {
            try await applyChanges(
                in: runtime,
                operations: [
                    ["kind": "create_folder", "path": "Scans"],
                    ["kind": "move", "source": "scan-1.pdf", "destination": "Scans/scan-1.pdf"],
                    ["kind": "move", "source": "scan-2.pdf", "destination": "Scans/scan-2.pdf"],
                ],
                approvals: approvals
            )
        }
        let request = try await awaitPendingApproval(harness.approvals)
        XCTAssertEqual(request.action, "apply_changes")
        XCTAssertEqual(request.runID, "run-1")
        // Nothing has happened yet: an approval that costs something to refuse
        // is not an approval.
        XCTAssertTrue(harness.sandbox.exists("scan-1.pdf"))
        XCTAssertFalse(harness.sandbox.exists("Scans"))

        _ = try await harness.executor.execute(
            command(
                "approve",
                payload: [
                    "approvalId": .string(request.id),
                    "actionDigest": .string(request.actionDigest),
                ],
                clock: harness.clock
            )
        )

        let result = try await batch.value
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(result.detail["applied"], .number(3))
        // The digest the phone answered about is the digest of the batch that
        // ran, which is the whole of what binds one to the other.
        XCTAssertEqual(result.detail["planDigest"], .string(request.actionDigest))
        XCTAssertTrue(harness.sandbox.exists("Scans/scan-1.pdf"))
        XCTAssertTrue(harness.sandbox.exists("Scans/scan-2.pdf"))
        XCTAssertFalse(harness.sandbox.exists("scan-1.pdf"))
    }

    /// An answer that does not echo the digest it was shown is not an answer
    /// about this action, and the batch fails closed rather than running on it.
    func testAnAnswerThatNamesADifferentActionLeavesTheFolderUntouched() async throws {
        let harness = try makeHarness(policy: .conservative)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")

        let runtime = harness.runtime
        let approvals = harness.approvals
        let batch = Task {
            try await applyChanges(
                in: runtime,
                operations: [
                    ["kind": "move", "source": "scan-1.pdf", "destination": "Scans/scan-1.pdf"]
                ],
                approvals: approvals
            )
        }
        let request = try await awaitPendingApproval(harness.approvals)

        _ = try await harness.executor.execute(
            command(
                "approve",
                payload: [
                    "approvalId": .string(request.id),
                    "actionDigest": "the digest of a batch nobody built",
                ],
                clock: harness.clock
            )
        )

        await assertThrowsAsync(try await batch.value) { error in
            guard case .denied(let reason) = error as? WorkToolError else {
                return XCTFail("expected a refusal, got \(error)")
            }
            XCTAssertTrue(reason.contains("different action"), reason)
        }
        XCTAssertTrue(harness.sandbox.exists("scan-1.pdf"))
        XCTAssertFalse(harness.sandbox.exists("Scans"))
    }

    func testAnApproveThatArrivesWithoutItsDigestIsRefused() async throws {
        let harness = try makeHarness()
        await assertThrowsAsync(
            try await harness.executor.execute(
                command(
                    "approve",
                    payload: ["approvalId": "approval-1"],
                    clock: harness.clock
                )
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkLocalExecutionError,
                .missingField("action digest")
            )
        }
    }

    /// Stopping a task takes its unanswered question with it, so nobody is left
    /// holding an approval sheet for work they already cancelled.
    func testStoppingATaskDeniesTheQuestionItWasWaitingOn() async throws {
        let harness = try makeHarness(policy: .conservative)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")

        let runtime = harness.runtime
        let approvals = harness.approvals
        let batch = Task {
            try await applyChanges(
                in: runtime,
                operations: [
                    ["kind": "move", "source": "scan-1.pdf", "destination": "Scans/scan-1.pdf"]
                ],
                approvals: approvals
            )
        }
        _ = try await awaitPendingApproval(harness.approvals)

        _ = try await harness.executor.execute(
            command("stop", payload: ["reason": "Changed my mind"], clock: harness.clock)
        )

        await assertThrowsAsync(try await batch.value) { error in
            guard case .denied(let reason) = error as? WorkToolError else {
                return XCTFail("expected a refusal, got \(error)")
            }
            XCTAssertTrue(reason.contains("stopped"), reason)
        }
        XCTAssertTrue(harness.sandbox.exists("scan-1.pdf"))
        let stopped = await harness.runs.stopped
        XCTAssertEqual(stopped.map(\.reason), ["Changed my mind"])
        let pending = await harness.approvals.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
    }

    // MARK: - Undo

    /// What ran is what comes back, and the journal that says so was flushed as
    /// the batch went rather than at the end of it.
    func testUndoReversesExactlyWhatTheBatchApplied() async throws {
        let harness = try makeHarness(policy: .permissive)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")
        try harness.sandbox.writeInGrant("scan-2.pdf", "two")

        let result = try await applyChanges(
            in: harness.runtime,
            operations: [
                ["kind": "create_folder", "path": "Scans"],
                ["kind": "move", "source": "scan-1.pdf", "destination": "Scans/scan-1.pdf"],
                ["kind": "move", "source": "scan-2.pdf", "destination": "Scans/scan-2.pdf"],
            ],
            approvals: harness.approvals
        )
        XCTAssertFalse(result.isError, result.content)
        XCTAssertTrue(harness.sandbox.exists("Scans/scan-1.pdf"))

        let undone = try await harness.executor.execute(
            command("undo", clock: harness.clock)
        )
        XCTAssertEqual(undone["complete"], .bool(true))
        XCTAssertEqual(undone["reversed"], .number(3))
        XCTAssertEqual(undone["stillApplied"], .number(0))
        XCTAssertEqual(text(at: harness.sandbox.grantURL("scan-1.pdf")), "one")
        XCTAssertEqual(text(at: harness.sandbox.grantURL("scan-2.pdf")), "two")
        XCTAssertFalse(harness.sandbox.exists("Scans"))

        // Undoing twice is not two undos. The second one has nothing recorded
        // and says so rather than reporting a success it did not perform.
        await assertThrowsAsync(
            try await harness.executor.execute(command("undo", clock: harness.clock))
        ) { error in
            XCTAssertEqual(error as? WorkLocalExecutionError, .nothingToUndo)
        }
    }

    /// A batch that was refused before its first operation must not become the
    /// thing "undo that" reverses, or the batch that really ran a minute earlier
    /// is answered with "there is nothing to undo".
    func testARefusedBatchDoesNotDisplaceTheOneThatActuallyRan() async throws {
        let harness = try makeHarness(policy: .permissive)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")

        _ = try await applyChanges(
            in: harness.runtime,
            operations: [
                ["kind": "move", "source": "scan-1.pdf", "destination": "Scans/scan-1.pdf"]
            ],
            approvals: harness.approvals
        )
        XCTAssertTrue(harness.sandbox.exists("Scans/scan-1.pdf"))

        // Its source is long gone, so this one applies nothing at all.
        let refused = try await applyChanges(
            in: harness.runtime,
            operations: [
                ["kind": "move", "source": "scan-1.pdf", "destination": "Elsewhere/scan-1.pdf"]
            ],
            approvals: harness.approvals
        )
        XCTAssertTrue(refused.isError, refused.content)

        let undone = try await harness.executor.execute(command("undo", clock: harness.clock))
        XCTAssertEqual(undone["complete"], .bool(true))
        XCTAssertEqual(text(at: harness.sandbox.grantURL("scan-1.pdf")), "one")
    }

    // MARK: - The batch itself

    /// A write pins the version it believed it was changing. Somebody edits the
    /// file between the read and the batch, and the batch stops rather than
    /// discarding what they wrote.
    func testAWritePinnedToAnOldVersionOfAFileIsRefused() async throws {
        let harness = try makeHarness(policy: .permissive)
        try harness.sandbox.writeInGrant("Note.txt", "the version Juno read")

        let read = try await harness.runtime.tools.invoke(
            toolName: "read_file",
            input: ["path": "Note.txt"],
            runID: "run-1",
            toolCallID: "call-0",
            approvals: harness.approvals
        )
        let base = try XCTUnwrap(
            read.content.split(separator: "\n").first.flatMap { header -> String? in
                guard let range = header.range(of: "\"base\":\"") else { return nil }
                let rest = header[range.upperBound...]
                return rest.prefix(while: { $0 != "\"" }).description
            }
        )

        try harness.sandbox.writeInGrant("Note.txt", "edited by a person, just now")

        let result = try await applyChanges(
            in: harness.runtime,
            operations: [
                [
                    "kind": "write",
                    "path": "Note.txt",
                    "content": "what Juno wanted to write",
                    "expected_base": .string(base),
                ]
            ],
            approvals: harness.approvals
        )
        XCTAssertTrue(result.isError, result.content)
        XCTAssertEqual(
            text(at: harness.sandbox.grantURL("Note.txt")),
            "edited by a person, just now"
        )
    }

    func testAChangeOfAKindThisBuildDoesNotKnowIsRefusedRatherThanApproximated() async throws {
        let harness = try makeHarness(policy: .permissive)
        try harness.sandbox.writeInGrant("scan-1.pdf", "one")

        await assertThrowsAsync(
            try await applyChanges(
                in: harness.runtime,
                operations: [["kind": "delete", "path": "scan-1.pdf"]],
                approvals: harness.approvals
            )
        ) { error in
            guard case .invalidInput(let message) = error as? WorkToolError else {
                return XCTFail("expected a refusal, got \(error)")
            }
            XCTAssertEqual(message, "Change 1: Juno has no change of kind 'delete'.")
        }
        XCTAssertTrue(harness.sandbox.exists("scan-1.pdf"))
    }
}
