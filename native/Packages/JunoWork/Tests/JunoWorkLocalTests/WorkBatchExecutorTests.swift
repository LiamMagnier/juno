import Foundation
import JunoWorkCore
import XCTest

@testable import JunoWorkLocal

final class WorkBatchExecutorTests: XCTestCase {
    private let grantID = WorkGrantID(value: "grant-1")

    private struct Harness {
        let sandbox: WorkSandbox
        let access: GrantAccess
        let service: WorkFileService
        let executor: WorkBatchExecutor
        let journalURL: URL
    }

    private func makeHarness(mode: WorkAccessMode = .readWrite) throws -> Harness {
        let sandbox = try makeWorkSandbox()
        let access = try GrantAccess(grantID: grantID, mode: mode, grantedURL: sandbox.grant)
        let service = WorkFileService(access: access)
        // Both live outside the grant, deliberately: a stash of replaced files
        // kept inside the folder being reorganised would itself be reorganised,
        // and a journal inside it would show up in the person's own listings.
        let support = sandbox.root.appendingPathComponent("support", isDirectory: true)
        let journalURL = support.appendingPathComponent("journal.json")
        return Harness(
            sandbox: sandbox,
            access: access,
            service: service,
            executor: WorkBatchExecutor(
                access: access,
                service: service,
                replacedContentDirectory: support.appendingPathComponent("replaced"),
                journalURL: journalURL
            ),
            journalURL: journalURL
        )
    }

    private func approval(
        for plan: WorkBatchPlan,
        at now: Date = Date(),
        lifetime: TimeInterval = WorkBatchApproval.timeToLive
    ) -> WorkBatchApproval {
        WorkBatchApproval(
            grantID: plan.grantID,
            planDigest: plan.digest,
            decidedAt: now,
            expiresAt: now.addingTimeInterval(lifetime)
        )
    }

    private func snapshot(existing: [String], fingerprints: [String: String] = [:]) throws
        -> WorkFileSnapshot
    {
        var facts: [GrantedPath: WorkPathFacts] = [:]
        for raw in existing {
            facts[try GrantedPath(raw)] = WorkPathFacts(
                exists: true,
                isDirectory: false,
                fingerprint: fingerprints[raw].map { WorkContentFingerprint(of: $0) }
            )
        }
        return WorkFileSnapshot(facts)
    }

    // MARK: - Stopping partway

    /// The failure case the journal exists for. Five operations, the third one's
    /// source is gone by the time the batch runs, and afterwards the person must
    /// be able to put the folder back exactly as they left it — not partly, and
    /// not by undoing operations that never happened.
    func testABatchThatFailsOnTheThirdOfFiveLeavesAJournalOfExactlyTheFirstTwo() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        try harness.sandbox.writeInGrant("b.txt", "beta")
        try harness.sandbox.writeInGrant("c.txt", "gamma")

        let operations: [WorkFileOperation] = [
            .createFolder(path: try GrantedPath("Archive")),
            .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt")),
            .copy(source: try GrantedPath("b.txt"), destination: try GrantedPath("Archive/b.txt")),
            .copy(source: try GrantedPath("c.txt"), destination: try GrantedPath("Archive/c.txt")),
            .createFolder(path: try GrantedPath("Archive/Sub")),
        ]
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: operations,
            against: try snapshot(existing: ["a.txt", "b.txt", "c.txt"])
        )
        XCTAssertEqual(plan.operations, operations, "this batch needed no reordering")

        // Between the preview and the run, the person deletes b.txt themselves.
        try FileManager.default.removeItem(at: harness.sandbox.grantURL("b.txt"))

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))

        XCTAssertFalse(execution.isComplete)
        XCTAssertEqual(execution.failure?.operationIndex, 2)
        XCTAssertEqual(execution.failure?.kind, .copy)
        XCTAssertEqual(execution.journal.records.map(\.operationIndex), [0, 1])
        XCTAssertEqual(execution.journal.records.map(\.kind), [.createFolder, .copy])

        // The disk agrees with the journal, in both directions.
        XCTAssertTrue(harness.sandbox.exists(harness.sandbox.grantURL("Archive")))
        XCTAssertTrue(harness.sandbox.exists(harness.sandbox.grantURL("Archive/a.txt")))
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive/b.txt")))
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive/c.txt")))
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive/Sub")))

        // The journal was flushed as it went, not at the end — which is the only
        // version of it that survives the crash it exists for.
        let persisted = try JSONDecoder.workJournalDecoder().decode(
            UndoJournal.self,
            from: try Data(contentsOf: harness.journalURL)
        )
        XCTAssertEqual(persisted.records.map(\.operationIndex), [0, 1])
        XCTAssertEqual(persisted.planDigest, plan.digest)

        let outcome = await harness.executor.undo(execution.journal)
        XCTAssertTrue(outcome.isComplete, outcome.summary)
        XCTAssertEqual(outcome.reversed.map(\.operationIndex), [1, 0], "undo runs newest first")
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive")))
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive/a.txt")))
        // Everything the batch never touched is exactly where it was.
        XCTAssertEqual(text(at: harness.sandbox.grantURL("a.txt")), "alpha")
        XCTAssertEqual(text(at: harness.sandbox.grantURL("c.txt")), "gamma")
    }

    // MARK: - The approval is bound to one exact batch

    /// The model reconsiders and rebuilds the plan after the person has already
    /// said yes. The new plan is a different batch, its digest is different, and
    /// last minute's consent does not carry.
    func testAPlanWhoseDigestNoLongerMatchesTheApprovalIsRefusedBeforeAnythingRuns() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")

        let approved = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt"))
            ],
            against: try snapshot(existing: ["a.txt"])
        )
        let rebuilt = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(
                    source: try GrantedPath("a.txt"),
                    destination: try GrantedPath("Somewhere Else/a.txt")
                )
            ],
            against: try snapshot(existing: ["a.txt"])
        )
        XCTAssertNotEqual(approved.digest, rebuilt.digest)

        await assertThrowsAsync(
            try await harness.executor.execute(rebuilt, approvedBy: approval(for: approved))
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchExecutionRefusal,
                .approvalDoesNotAuthorizeThisPlan
            )
        }
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Somewhere Else")))
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive")))
        XCTAssertFalse(harness.sandbox.exists(harness.journalURL))
    }

    /// The other half of the same rule: a digest cannot be lifted off the batch
    /// the person approved and carried onto a different one. The plan refuses to
    /// decode at all, so the executor never sees it.
    func testAPlanCannotTravelWithADigestThatBelongsToDifferentOperations() throws {
        let approved = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt"))
            ]
        )
        let tampered = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.trash(path: try GrantedPath("a.txt"))]
        )

        var approvedJSON = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try JSONEncoder().encode(approved))
                as? [String: Any]
        )
        let tamperedJSON = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try JSONEncoder().encode(tampered))
                as? [String: Any]
        )
        // The operations of one batch, carrying the digest of the other.
        approvedJSON["operations"] = tamperedJSON["operations"]
        let spliced = try JSONSerialization.data(withJSONObject: approvedJSON)

        XCTAssertThrowsError(try JSONDecoder().decode(WorkBatchPlan.self, from: spliced))
    }

    func testAnExpiredApprovalIsRefused() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt"))
            ],
            against: try snapshot(existing: ["a.txt"])
        )
        let decidedAt = Date()
        let expired = approval(for: plan, at: decidedAt, lifetime: 60)

        await assertThrowsAsync(
            try await harness.executor.execute(
                plan,
                approvedBy: expired,
                at: decidedAt.addingTimeInterval(61)
            )
        ) { error in
            XCTAssertEqual(error as? WorkBatchExecutionRefusal, .approvalDoesNotAuthorizeThisPlan)
        }
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive")))
    }

    func testAPlanForADifferentGrantIsRefused() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        let otherGrant = WorkGrantID(value: "grant-2")
        let plan = try WorkBatchPlan.plan(
            grantID: otherGrant,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt"))
            ],
            against: try snapshot(existing: ["a.txt"])
        )

        await assertThrowsAsync(
            try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchExecutionRefusal,
                .planIsForADifferentGrant(planGrantID: "grant-2", grantID: "grant-1")
            )
        }
    }

    func testAGrantSharedWithoutDeletePermissionRefusesTheWholeBatchBeforeItStarts() async throws {
        let harness = try makeHarness(mode: .readWriteNoDelete)
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        try harness.sandbox.writeInGrant("b.txt", "beta")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt")),
                .trash(path: try GrantedPath("b.txt")),
            ],
            against: try snapshot(existing: ["a.txt", "b.txt"])
        )

        await assertThrowsAsync(
            try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchExecutionRefusal,
                .modeForbidsOperations(indices: [1], mode: .readWriteNoDelete)
            )
        }
        // Not even the permitted first operation ran: a batch that half happens
        // is a batch nobody approved.
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Archive")))
    }

    // MARK: - Writes

    func testWriteBytesMustHashToWhatWasApproved() async throws {
        let harness = try makeHarness()
        let path = try GrantedPath("Note.txt")
        let approvedText = "the paragraph you read"
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .write(
                    path: path,
                    content: WorkContentFingerprint(of: approvedText),
                    expectedBase: nil
                )
            ]
        )

        await assertThrowsAsync(
            try await harness.executor.execute(
                plan,
                approvedBy: approval(for: plan),
                writeContents: [path: Data("something else entirely".utf8)]
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchExecutionRefusal,
                .writeContentDoesNotMatchApproval(path: "Note.txt")
            )
        }
        await assertThrowsAsync(
            try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchExecutionRefusal,
                .writeContentMissing(path: "Note.txt")
            )
        }
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Note.txt")))

        let execution = try await harness.executor.execute(
            plan,
            approvedBy: approval(for: plan),
            writeContents: [path: Data(approvedText.utf8)]
        )
        XCTAssertTrue(execution.isComplete)
        XCTAssertEqual(text(at: harness.sandbox.grantURL("Note.txt")), approvedText)

        let outcome = await harness.executor.undo(execution.journal)
        XCTAssertTrue(outcome.isComplete, outcome.summary)
        XCTAssertFalse(
            harness.sandbox.exists(harness.sandbox.grantURL("Note.txt")),
            "undoing a write that created the file removes it again"
        )
    }

    // MARK: - Conflicts at execution time

    /// The file somebody saved between reading the preview and tapping approve.
    /// Nothing in the preview mentioned replacing it, so nothing may.
    func testSomethingNewAtTheDestinationStopsTheBatchRatherThanBeingOverwritten() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("kept.txt"))
            ],
            against: try snapshot(existing: ["a.txt"])
        )
        XCTAssertTrue(plan.analysis.conflicts.isEmpty, "the preview promised nothing was there")

        try harness.sandbox.writeInGrant("kept.txt", "written by a person, just now")

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        XCTAssertFalse(execution.isComplete)
        XCTAssertEqual(execution.failure?.operationIndex, 0)
        XCTAssertTrue(execution.journal.isEmpty)
        XCTAssertEqual(
            text(at: harness.sandbox.grantURL("kept.txt")),
            "written by a person, just now"
        )
    }

    /// A replacement the preview *did* show goes ahead, the displaced bytes are
    /// kept, and undoing puts them back.
    func testAnApprovedReplacementIsAppliedAndTheDisplacedFileComesBack() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        try harness.sandbox.writeInGrant("kept.txt", "shared")
        try harness.sandbox.writeInGrant("dup.txt", "shared")

        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("kept.txt")),
                .rename(path: try GrantedPath("dup.txt"), newName: "dup2.txt"),
            ],
            against: try snapshot(
                existing: ["a.txt", "kept.txt", "dup.txt"],
                fingerprints: ["a.txt": "alpha", "kept.txt": "shared", "dup.txt": "shared"]
            )
        )
        XCTAssertEqual(plan.analysis.conflicts.map(\.operationIndex), [0])
        XCTAssertEqual(
            plan.analysis.duplicates.first?.paths.map(\.value),
            ["dup.txt", "kept.txt"],
            "the planner recorded what it saw at both of these locations"
        )

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        XCTAssertTrue(execution.isComplete, execution.failure?.reason ?? "")
        XCTAssertEqual(text(at: harness.sandbox.grantURL("kept.txt")), "alpha")
        XCTAssertEqual(text(at: harness.sandbox.grantURL("dup2.txt")), "shared")
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("dup.txt")))

        let outcome = await harness.executor.undo(execution.journal)
        XCTAssertTrue(outcome.isComplete, outcome.summary)
        XCTAssertEqual(text(at: harness.sandbox.grantURL("kept.txt")), "shared")
        XCTAssertEqual(text(at: harness.sandbox.grantURL("dup.txt")), "shared")
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("dup2.txt")))
    }

    /// The same approved replacement, except the destination changed after the
    /// preview was built. They approved replacing a different version.
    func testADestinationThatChangedSincePlanningStopsTheBatch() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        try harness.sandbox.writeInGrant("kept.txt", "shared")
        try harness.sandbox.writeInGrant("dup.txt", "shared")

        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("kept.txt")),
                .rename(path: try GrantedPath("dup.txt"), newName: "dup2.txt"),
            ],
            against: try snapshot(
                existing: ["a.txt", "kept.txt", "dup.txt"],
                fingerprints: ["kept.txt": "shared", "dup.txt": "shared"]
            )
        )
        try harness.sandbox.writeInGrant("kept.txt", "edited while you were reading")

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        XCTAssertFalse(execution.isComplete)
        XCTAssertEqual(execution.failure?.operationIndex, 0)
        XCTAssertTrue(execution.journal.isEmpty)
        XCTAssertEqual(
            text(at: harness.sandbox.grantURL("kept.txt")),
            "edited while you were reading"
        )
    }

    // MARK: - Trash and undo

    func testTrashingThroughABatchRecordsEnoughToBringTheItemBack() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("Old.txt", "not so old after all")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.trash(path: try GrantedPath("Old.txt"))],
            against: try snapshot(existing: ["Old.txt"])
        )

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        XCTAssertTrue(execution.isComplete, execution.failure?.reason ?? "")
        let token = try XCTUnwrap(execution.journal.records.first?.trashToken)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: token) }
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.grantURL("Old.txt")))

        let outcome = await harness.executor.undo(execution.journal)
        XCTAssertTrue(outcome.isComplete, outcome.summary)
        XCTAssertEqual(text(at: harness.sandbox.grantURL("Old.txt")), "not so old after all")
    }

    /// A path is re-resolved at execution time, never taken from what the plan
    /// implied. Between the preview and the run, the destination folder became a
    /// link out of the grant.
    func testAPathThatBecameASymlinkAfterPlanningIsRefusedAtExecutionTime() async throws {
        let harness = try makeHarness()
        try harness.sandbox.writeInGrant("a.txt", "alpha")
        try harness.sandbox.writeInGrant("Archive/placeholder.txt", "here first")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try GrantedPath("a.txt"), destination: try GrantedPath("Archive/a.txt"))
            ],
            against: try snapshot(existing: ["a.txt", "Archive"])
        )

        // The folder the batch was going to write into is replaced by a link.
        try FileManager.default.removeItem(at: harness.sandbox.grantURL("Archive"))
        try FileManager.default.createSymbolicLink(
            atPath: harness.sandbox.grantURL("Archive").path,
            withDestinationPath: harness.sandbox.outside.path
        )

        let execution = try await harness.executor.execute(plan, approvedBy: approval(for: plan))
        XCTAssertFalse(execution.isComplete)
        XCTAssertTrue(execution.journal.isEmpty)
        XCTAssertFalse(harness.sandbox.exists(harness.sandbox.outsideURL("a.txt")))
    }
}

extension JSONDecoder {
    /// Matches the encoder the executor flushes the journal with.
    fileprivate static func workJournalDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
