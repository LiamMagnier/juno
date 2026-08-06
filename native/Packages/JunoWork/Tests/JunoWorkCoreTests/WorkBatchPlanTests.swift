import Foundation
import XCTest

@testable import JunoWorkCore

final class WorkBatchPlanTests: XCTestCase {
    private let grantID = WorkGrantID(value: "grant-1")

    private func path(_ raw: String) throws -> GrantedPath {
        try GrantedPath(raw)
    }

    private func snapshot(
        existing: [String] = [],
        fingerprints: [String: WorkContentFingerprint] = [:]
    ) throws -> WorkFileSnapshot {
        var names = Set(existing)
        names.formUnion(fingerprints.keys)
        var facts: [GrantedPath: WorkPathFacts] = [:]
        for raw in names {
            facts[try path(raw)] = WorkPathFacts(
                exists: true,
                isDirectory: !raw.contains("."),
                fingerprint: fingerprints[raw]
            )
        }
        return WorkFileSnapshot(facts)
    }

    // MARK: - Ordering

    func testAMoveIntoAFolderTheBatchCreatesSortsAfterTheCreation() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf")),
                .move(source: try path("b.pdf"), destination: try path("Reports/b.pdf")),
                .createFolder(path: try path("Reports")),
            ],
            against: try snapshot(existing: ["a.pdf", "b.pdf"])
        )
        XCTAssertEqual(plan.operations.first?.kind, .createFolder)
        XCTAssertEqual(plan.operations.map(\.kind), [.createFolder, .move, .move])
        XCTAssertTrue(plan.analysis.conflicts.isEmpty)
        XCTAssertTrue(plan.analysis.noOps.isEmpty)
    }

    func testAnAlreadyExistingFolderImposesNoOrderingAndTheCallersOrderSurvives() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf")),
                .move(source: try path("b.pdf"), destination: try path("Reports/b.pdf")),
            ],
            against: try snapshot(existing: ["a.pdf", "b.pdf", "Reports"])
        )
        XCTAssertEqual(
            plan.operations.compactMap { $0.destination?.value },
            ["Reports/a.pdf", "Reports/b.pdf"]
        )
    }

    func testCopyingBeforeTrashingSortsTheReadAheadOfTheRemoval() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .trash(path: try path("a.pdf")),
                .copy(source: try path("a.pdf"), destination: try path("backup-a.pdf")),
            ],
            against: try snapshot(existing: ["a.pdf"])
        )
        XCTAssertEqual(plan.operations.map(\.kind), [.copy, .trash])
    }

    func testARenameChainSortsSoTheFreedNameIsNotReportedAsAConflict() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .rename(path: try path("b.pdf"), newName: "a.pdf"),
                .rename(path: try path("a.pdf"), newName: "old-a.pdf"),
            ],
            against: try snapshot(existing: ["a.pdf", "b.pdf"])
        )
        XCTAssertEqual(
            plan.operations.compactMap { $0.destination?.value },
            ["old-a.pdf", "a.pdf"]
        )
        XCTAssertTrue(plan.analysis.conflicts.isEmpty)
    }

    /// Two files swapping names. Each needs the other's name freed first, so
    /// there is no order that works — and half of a swap is a folder with one
    /// file missing and one file wrong.
    func testADependencyCycleIsRefusedAtPlanTime() throws {
        XCTAssertThrowsError(
            try WorkBatchPlan.plan(
                grantID: grantID,
                operations: [
                    .move(source: try path("a.pdf"), destination: try path("b.pdf")),
                    .move(source: try path("b.pdf"), destination: try path("a.pdf")),
                ],
                against: try snapshot(existing: ["a.pdf", "b.pdf"])
            )
        ) { error in
            guard case .dependencyCycle(let paths) = error as? WorkBatchPlanError else {
                return XCTFail("expected a dependency cycle, got \(error)")
            }
            XCTAssertEqual(paths, ["a.pdf", "b.pdf"])
        }
    }

    func testTwoOperationsLandingOnTheSameDestinationAreRefusedAtPlanTime() throws {
        XCTAssertThrowsError(
            try WorkBatchPlan.plan(
                grantID: grantID,
                operations: [
                    .copy(source: try path("a.pdf"), destination: try path("merged.pdf")),
                    .copy(source: try path("b.pdf"), destination: try path("merged.pdf")),
                ],
                against: try snapshot(existing: ["a.pdf", "b.pdf"])
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchPlanError,
                .destinationCollision(path: "merged.pdf")
            )
        }
    }

    func testAnEmptyBatchAndAnOversizedBatchAreBothRefused() throws {
        XCTAssertThrowsError(try WorkBatchPlan.plan(grantID: grantID, operations: [])) { error in
            XCTAssertEqual(error as? WorkBatchPlanError, .empty)
        }
        let tooMany = try (0...WorkBatchPlan.maximumOperations).map { index in
            WorkFileOperation.createFolder(path: try path("folder-\(index)"))
        }
        XCTAssertThrowsError(try WorkBatchPlan.plan(grantID: grantID, operations: tooMany)) { error in
            XCTAssertEqual(
                error as? WorkBatchPlanError,
                .tooManyOperations(
                    count: WorkBatchPlan.maximumOperations + 1,
                    maximum: WorkBatchPlan.maximumOperations
                )
            )
        }
    }

    func testARenameToSomethingThatIsNotAFileNameIsRefusedAtPlanTime() throws {
        XCTAssertThrowsError(
            try WorkBatchPlan.plan(
                grantID: grantID,
                operations: [.rename(path: try path("a.pdf"), newName: "Reports/a.pdf")],
                against: try snapshot(existing: ["a.pdf"])
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkBatchPlanError,
                .invalidRename(path: "a.pdf", newName: "Reports/a.pdf")
            )
        }
    }

    // MARK: - Analysis

    func testConflictsDuplicatesAndNoOpsAreAllReported() throws {
        let shared = WorkContentFingerprint(of: "identical")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                // Lands on something that is already there.
                .move(source: try path("a.pdf"), destination: try path("Reports/taken.pdf")),
                // Goes nowhere.
                .copy(source: try path("b.pdf"), destination: try path("b.pdf")),
                // The folder is already there.
                .createFolder(path: try path("Reports")),
                // Nothing is at the source.
                .trash(path: try path("ghost.pdf")),
                // No tags to apply.
                .tag(path: try path("b.pdf"), tags: []),
            ],
            against: try snapshot(
                existing: ["a.pdf", "b.pdf", "Reports", "Reports/taken.pdf"],
                fingerprints: ["a.pdf": shared, "b.pdf": shared]
            )
        )

        let conflicts = plan.analysis.conflicts
        XCTAssertEqual(conflicts.count, 1)
        XCTAssertEqual(conflicts.first?.destination.value, "Reports/taken.pdf")
        XCTAssertEqual(conflicts.first?.reason, .destinationExists)

        XCTAssertEqual(plan.analysis.noOps.count, 4)
        XCTAssertEqual(
            Set(plan.analysis.noOps.map(\.reason)),
            [.sourceIsDestination, .folderAlreadyExists, .nothingAtSource, .noTagsGiven]
        )

        XCTAssertEqual(plan.analysis.duplicates.count, 1)
        XCTAssertEqual(plan.analysis.duplicates.first?.paths.map(\.value), ["a.pdf", "b.pdf"])

        XCTAssertEqual(
            plan.analysis.touchedPaths.map(\.value),
            ["Reports", "Reports/taken.pdf", "a.pdf", "b.pdf", "ghost.pdf"]
        )
    }

    func testAWriteWhoseContentAlreadyMatchesIsANoOpRatherThanAConflict() throws {
        let content = WorkContentFingerprint(of: "unchanged")
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.write(path: try path("notes.txt"), content: content, expectedBase: content)],
            against: try snapshot(existing: ["notes.txt"], fingerprints: ["notes.txt": content])
        )
        XCTAssertEqual(plan.analysis.noOps.map(\.reason), [.contentAlreadyMatches])
        XCTAssertTrue(plan.analysis.conflicts.isEmpty)
    }

    func testOperationsForbiddenUnderAModeAreReportedByIndex() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try path("a.pdf"), destination: try path("b.pdf")),
                .trash(path: try path("a.pdf")),
            ],
            against: try snapshot(existing: ["a.pdf"])
        )
        XCTAssertEqual(plan.operations.map(\.kind), [.copy, .trash])
        XCTAssertEqual(plan.operationsForbidden(under: .readWrite), [])
        XCTAssertEqual(plan.operationsForbidden(under: .readWriteNoDelete), [1])
        XCTAssertEqual(plan.operationsForbidden(under: .read), [0, 1])
    }

    // MARK: - Digest and approval

    func testTheDigestChangesWhenAnyOperationChanges() throws {
        func digest(_ operations: [WorkFileOperation]) throws -> String {
            try WorkBatchPlan.plan(grantID: grantID, operations: operations).digest
        }
        let base: [WorkFileOperation] = [
            .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf"))
        ]
        let original = try digest(base)

        XCTAssertNotEqual(
            original,
            try digest([.move(source: try path("a.pdf"), destination: try path("Archive/a.pdf"))])
        )
        XCTAssertNotEqual(
            original,
            try digest([.copy(source: try path("a.pdf"), destination: try path("Reports/a.pdf"))])
        )
        XCTAssertNotEqual(
            original,
            try digest(
                base + [.move(source: try path("b.pdf"), destination: try path("Reports/b.pdf"))]
            )
        )
        // The same batch under a different grant is a different batch.
        XCTAssertNotEqual(
            original,
            try WorkBatchPlan.plan(grantID: WorkGrantID(value: "grant-2"), operations: base).digest
        )
        // And the same batch planned twice is the same batch.
        XCTAssertEqual(original, try digest(base))
    }

    /// A file name may contain almost any character, including whatever a
    /// canonical form might use to separate its fields. Joined with `:` these
    /// two batches both flatten to `copy:a:b:c`, hash identically, and an
    /// approval for one authorises the other. Length-prefixing each field is
    /// what stops that.
    func testTwoDifferentBatchesCannotBeSpelledIntoTheSameDigest() throws {
        let first = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.copy(source: try path("a:b"), destination: try path("c"))]
        )
        let second = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.copy(source: try path("a"), destination: try path("b:c"))]
        )
        XCTAssertEqual(
            [first, second].map { $0.operations[0].canonicalForm },
            ["4:copy3:a:b1:c", "4:copy1:a3:b:c"]
        )
        XCTAssertNotEqual(first.digest, second.digest)
    }

    func testAnApprovalBoundToTheOldDigestDoesNotAuthoriseTheNewPlan() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let approvedPlan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf"))
            ]
        )
        let approval = WorkBatchApproval(
            grantID: grantID,
            planDigest: approvedPlan.digest,
            decidedAt: now,
            expiresAt: now.addingTimeInterval(WorkBatchApproval.timeToLive)
        )
        XCTAssertTrue(approval.authorizes(approvedPlan, at: now))

        // The model reconsidered and added an item after the person said yes.
        let changedPlan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf")),
                .trash(path: try path("b.pdf")),
            ]
        )
        XCTAssertFalse(approval.authorizes(changedPlan, at: now))

        // Same batch, different folder.
        let otherGrantPlan = try WorkBatchPlan.plan(
            grantID: WorkGrantID(value: "grant-2"),
            operations: [
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf"))
            ]
        )
        XCTAssertFalse(approval.authorizes(otherGrantPlan, at: now))

        // Approvals expire closed.
        XCTAssertFalse(
            approval.authorizes(
                approvedPlan,
                at: now.addingTimeInterval(WorkBatchApproval.timeToLive)
            )
        )
    }

    func testAPlanWhoseStoredDigestDoesNotMatchItsOperationsFailsToDecode() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.trash(path: try path("a.pdf"))]
        )
        let encoded = try JSONEncoder().encode(plan)
        XCTAssertNoThrow(try JSONDecoder().decode(WorkBatchPlan.self, from: encoded))

        guard var object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            return XCTFail("expected a JSON object")
        }
        // The operations are swapped for something the person never approved
        // while the digest they approved travels along unchanged.
        let tampered = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [.trash(path: try path("everything-else.pdf"))]
        )
        let tamperedEncoded = try JSONEncoder().encode(tampered)
        guard
            let tamperedObject = try JSONSerialization.jsonObject(with: tamperedEncoded)
                as? [String: Any]
        else {
            return XCTFail("expected a JSON object")
        }
        object["operations"] = tamperedObject["operations"]
        let forged = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try JSONDecoder().decode(WorkBatchPlan.self, from: forged))
    }

    // MARK: - Preview

    func testThePreviewCarriesNamesAndCountsAndNeverALocation() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: try (0..<30).map { index in
                .move(
                    source: try path("Clients/Ashworth v Reid/statement-\(index).pdf"),
                    destination: try path("Reports/2026/statement-\(index).pdf")
                )
            },
            against: try snapshot(
                existing: (0..<30).map { "Clients/Ashworth v Reid/statement-\($0).pdf" }
                    + ["Reports/2026"]
            )
        )
        let preview = plan.preview()

        XCTAssertEqual(preview.operationCount, 30)
        XCTAssertEqual(preview.items.count, 20)
        XCTAssertEqual(preview.additionalItemCount, 10)
        XCTAssertEqual(preview.headline, "Move 30 items into 2026")
        XCTAssertEqual(preview.counts.map(\.kind), [.move])
        XCTAssertEqual(preview.counts.first?.count, 30)
        XCTAssertEqual(preview.items.first?.displayName, "statement-0.pdf")
        XCTAssertEqual(preview.items.first?.destinationFolderName, "2026")
        XCTAssertEqual(preview.planDigest, plan.digest)

        // Nothing in the rendered preview describes where anything lives. A
        // grant-relative path is still a disclosure: "Clients/Ashworth v Reid"
        // on a lock screen names a client and a matter.
        let json = String(decoding: try JSONEncoder().encode(preview), as: UTF8.self)
        XCTAssertFalse(json.contains("/"), "the preview leaked a path separator")
        XCTAssertFalse(json.contains("Ashworth"))
        XCTAssertFalse(json.contains("Clients"))
    }

    func testAMixedBatchGetsACountHeadlineRatherThanAVerb() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .createFolder(path: try path("Reports")),
                .move(source: try path("a.pdf"), destination: try path("Reports/a.pdf")),
            ],
            against: try snapshot(existing: ["a.pdf"])
        )
        XCTAssertEqual(plan.preview().headline, "2 changes across your folder")
        XCTAssertEqual(plan.preview().counts.map(\.kind), [.createFolder, .move])
    }

    func testThePreviewMarksConflictsAndNoOpsOnTheRowsTheyBelongTo() throws {
        let plan = try WorkBatchPlan.plan(
            grantID: grantID,
            operations: [
                .copy(source: try path("a.pdf"), destination: try path("taken.pdf")),
                .copy(source: try path("b.pdf"), destination: try path("b.pdf")),
            ],
            against: try snapshot(existing: ["a.pdf", "b.pdf", "taken.pdf"])
        )
        let preview = plan.preview()
        XCTAssertEqual(preview.conflictCount, 1)
        XCTAssertEqual(preview.noOpCount, 1)
        XCTAssertEqual(preview.items.map(\.isConflict), [true, false])
        XCTAssertEqual(preview.items.map(\.isNoOp), [false, true])
    }
}
