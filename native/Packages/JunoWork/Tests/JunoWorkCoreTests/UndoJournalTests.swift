import Foundation
import XCTest

@testable import JunoWorkCore

private enum UndoStubError: Error, LocalizedError {
    case diskWentAway

    var errorDescription: String? { "The disk went away." }
}

private actor ActionRecorder {
    private(set) var actions: [WorkUndoAction] = []

    func append(_ action: WorkUndoAction) {
        actions.append(action)
    }
}

/// Reverses everything except the operation at one nominated index, which it
/// refuses — the disk filling up, a file locked by another app, a volume
/// ejected halfway through.
private struct ScriptedPerformer: WorkUndoPerforming {
    let recorder: ActionRecorder
    let failingOperationIndex: Int?

    func perform(_ action: WorkUndoAction, for record: WorkUndoRecord) async throws {
        if record.operationIndex == failingOperationIndex { throw UndoStubError.diskWentAway }
        await recorder.append(action)
    }
}

final class UndoJournalTests: XCTestCase {
    private let grantID = WorkGrantID(value: "grant-1")
    private let applied = Date(timeIntervalSince1970: 5_000)

    private func path(_ raw: String) throws -> GrantedPath {
        try GrantedPath(raw)
    }

    private func movedRecord(_ index: Int, from source: String, to destination: String) throws
        -> WorkUndoRecord
    {
        WorkUndoRecord(
            operationIndex: index,
            kind: .move,
            priorLocation: try path(source),
            newLocation: try path(destination),
            appliedAt: applied
        )
    }

    private func makeJournal(_ records: [WorkUndoRecord]) -> UndoJournal {
        UndoJournal(planDigest: "digest", grantID: grantID, records: records)
    }

    // MARK: - Reversal instructions

    func testAMoveRecordsBothEndsSoUndoingARenameDoesNotLeaveTwoFiles() throws {
        let record = try movedRecord(0, from: "a.pdf", to: "Reports/a.pdf")
        guard case .success(let steps) = record.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(
            steps,
            [.moveBack(from: try path("Reports/a.pdf"), to: try path("a.pdf"))]
        )
    }

    func testAMoveThatReplacedSomethingAlsoPutsTheReplacedFileBack() throws {
        let displaced = WorkContentFingerprint(of: "the file that was already there")
        let record = WorkUndoRecord(
            operationIndex: 0,
            kind: .move,
            priorLocation: try path("a.pdf"),
            newLocation: try path("Reports/a.pdf"),
            priorFingerprint: displaced,
            destinationExisted: true,
            appliedAt: applied
        )
        guard case .success(let steps) = record.reversal else {
            return XCTFail("expected a reversible record")
        }
        // The mover has to vacate the name before the displaced file can go back.
        XCTAssertEqual(
            steps,
            [
                .moveBack(from: try path("Reports/a.pdf"), to: try path("a.pdf")),
                .restoreContent(path: try path("Reports/a.pdf"), fingerprint: displaced),
            ]
        )
    }

    func testARecordThatReplacedSomethingWithoutCapturingItIsNotReversible() throws {
        let record = WorkUndoRecord(
            operationIndex: 0,
            kind: .write,
            newLocation: try path("notes.txt"),
            destinationExisted: true,
            appliedAt: applied
        )
        XCTAssertFalse(record.isReversible)
        guard case .failure(let refusal) = record.reversal else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(refusal, .replacedContentNotCaptured)
    }

    func testAWriteThatCreatedAFileIsUndoneByTakingItAway() throws {
        let record = WorkUndoRecord(
            operationIndex: 0,
            kind: .write,
            newLocation: try path("notes.txt"),
            destinationExisted: false,
            appliedAt: applied
        )
        guard case .success(let steps) = record.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(steps, [.removeCreated(try path("notes.txt"))])
    }

    func testATrashWithoutTheTrashsOwnIdentifierIsNotReversible() throws {
        let withToken = WorkUndoRecord(
            operationIndex: 0,
            kind: .trash,
            priorLocation: try path("a.pdf"),
            trashToken: "trash-item-88",
            appliedAt: applied
        )
        guard case .success(let steps) = withToken.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(steps, [.restoreFromTrash(token: "trash-item-88", to: try path("a.pdf"))])

        let withoutToken = WorkUndoRecord(
            operationIndex: 0,
            kind: .trash,
            priorLocation: try path("a.pdf"),
            appliedAt: applied
        )
        XCTAssertFalse(withoutToken.isReversible)
    }

    func testAFolderThatWasAlreadyThereIsNotRemovedByAnUndo() throws {
        let created = WorkUndoRecord(
            operationIndex: 0,
            kind: .createFolder,
            newLocation: try path("Reports"),
            destinationExisted: false,
            appliedAt: applied
        )
        guard case .success(let createdSteps) = created.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(createdSteps, [.removeCreated(try path("Reports"))])

        let alreadyThere = WorkUndoRecord(
            operationIndex: 0,
            kind: .createFolder,
            newLocation: try path("Reports"),
            destinationExisted: true,
            appliedAt: applied
        )
        guard case .success(let existingSteps) = alreadyThere.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(existingSteps, [])
    }

    func testAnUnarchiveIsUndoneDeepestItemFirst() throws {
        let record = WorkUndoRecord(
            operationIndex: 0,
            kind: .unarchive,
            newLocation: try path("Unpacked"),
            createdPaths: [
                try path("Unpacked"),
                try path("Unpacked/inner"),
                try path("Unpacked/inner/a.txt"),
            ],
            appliedAt: applied
        )
        guard case .success(let steps) = record.reversal else {
            return XCTFail("expected a reversible record")
        }
        XCTAssertEqual(
            steps,
            [
                .removeCreated(try path("Unpacked/inner/a.txt")),
                .removeCreated(try path("Unpacked/inner")),
                .removeCreated(try path("Unpacked")),
            ]
        )
    }

    // MARK: - Undoing

    func testAnUndoRunsInStrictReverseOrderAndReportsItselfComplete() async throws {
        let recorder = ActionRecorder()
        let journal = makeJournal([
            try movedRecord(0, from: "a.pdf", to: "Reports/a.pdf"),
            try movedRecord(1, from: "b.pdf", to: "Reports/b.pdf"),
            try movedRecord(2, from: "c.pdf", to: "Reports/c.pdf"),
        ])

        let outcome = await journal.undo(
            using: ScriptedPerformer(recorder: recorder, failingOperationIndex: nil)
        )

        XCTAssertTrue(outcome.isComplete)
        XCTAssertTrue(outcome.stillApplied.isEmpty)
        XCTAssertNil(outcome.failure)
        XCTAssertEqual(outcome.reversed.map(\.operationIndex), [2, 1, 0])
        XCTAssertEqual(outcome.summary, "Undid all 3 changes.")
        let performed = await recorder.actions
        XCTAssertEqual(
            performed,
            [
                .moveBack(from: try path("Reports/c.pdf"), to: try path("c.pdf")),
                .moveBack(from: try path("Reports/b.pdf"), to: try path("b.pdf")),
                .moveBack(from: try path("Reports/a.pdf"), to: try path("a.pdf")),
            ]
        )
    }

    /// The property the outcome type exists for: after a failure partway, the
    /// report says exactly which operations came back and which are still in
    /// effect, and cannot be read as a completed undo.
    func testAnUndoThatFailsPartwayReportsExactlyWhatWasReversed() async throws {
        let recorder = ActionRecorder()
        let journal = makeJournal([
            try movedRecord(0, from: "a.pdf", to: "Reports/a.pdf"),
            try movedRecord(1, from: "b.pdf", to: "Reports/b.pdf"),
            try movedRecord(2, from: "c.pdf", to: "Reports/c.pdf"),
            try movedRecord(3, from: "d.pdf", to: "Reports/d.pdf"),
        ])

        let outcome = await journal.undo(
            using: ScriptedPerformer(recorder: recorder, failingOperationIndex: 1)
        )

        XCTAssertFalse(outcome.isComplete)
        XCTAssertFalse(outcome.wasRefusedBeforeStarting)
        // Reversal runs newest first, so 3 and 2 came back before 1 refused.
        XCTAssertEqual(outcome.reversed.map(\.operationIndex), [3, 2])
        // Still in effect, in the order they were originally applied.
        XCTAssertEqual(outcome.stillApplied.map(\.operationIndex), [0, 1])
        XCTAssertEqual(outcome.failure?.record.operationIndex, 1)
        XCTAssertEqual(outcome.failure?.completedSteps, 0)
        XCTAssertEqual(outcome.failure?.totalSteps, 1)
        XCTAssertEqual(outcome.failure?.wasPartiallyReversed, false)
        XCTAssertEqual(outcome.failure?.reason, "The disk went away.")
        XCTAssertEqual(
            outcome.summary,
            "Undid 2 of 4 changes and stopped. The disk went away."
        )
        let performed = await recorder.actions
        XCTAssertEqual(performed.count, 2)
    }

    /// Refusing before the first step leaves the folder exactly as the person
    /// last saw it. Discovering the same thing on record eleven of forty leaves
    /// it in a state nobody planned and nobody can describe.
    func testAnUndoRefusesEntirelyWhenAnyRecordCannotBeReversed() async throws {
        let recorder = ActionRecorder()
        let journal = makeJournal([
            try movedRecord(0, from: "a.pdf", to: "Reports/a.pdf"),
            WorkUndoRecord(
                operationIndex: 1,
                kind: .trash,
                priorLocation: try path("b.pdf"),
                appliedAt: applied
            ),
            try movedRecord(2, from: "c.pdf", to: "Reports/c.pdf"),
        ])

        let outcome = await journal.undo(
            using: ScriptedPerformer(recorder: recorder, failingOperationIndex: nil)
        )

        XCTAssertFalse(outcome.isComplete)
        XCTAssertTrue(outcome.wasRefusedBeforeStarting)
        XCTAssertTrue(outcome.reversed.isEmpty)
        XCTAssertEqual(outcome.stillApplied.map(\.operationIndex), [0, 1, 2])
        XCTAssertEqual(outcome.failure?.record.operationIndex, 1)
        XCTAssertTrue(outcome.summary.hasPrefix("Nothing was undone."))
        let performed = await recorder.actions
        XCTAssertTrue(performed.isEmpty, "nothing should have been touched")
    }

    func testAnEmptyJournalIsCompleteAndSaysSo() async {
        let outcome = await makeJournal([]).undo(
            using: ScriptedPerformer(recorder: ActionRecorder(), failingOperationIndex: nil)
        )
        XCTAssertTrue(outcome.isComplete)
        XCTAssertEqual(outcome.summary, "There was nothing to undo.")
    }

    // MARK: - Surviving a restart

    func testTheJournalRoundTripsThroughJSONSoItSurvivesAProcessRestart() throws {
        var original = makeJournal([try movedRecord(0, from: "a.pdf", to: "Reports/a.pdf")])
        original.record(
            WorkUndoRecord(
                operationIndex: 1,
                kind: .trash,
                priorLocation: try path("b.pdf"),
                trashToken: "trash-item-88",
                appliedAt: applied
            )
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let restored = try decoder.decode(
            UndoJournal.self,
            from: try encoder.encode(original)
        )

        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.records.map(\.operationIndex), [0, 1])
        XCTAssertEqual(restored.planDigest, "digest")
        XCTAssertEqual(restored.grantID, grantID)
        XCTAssertTrue(restored.records.allSatisfy(\.isReversible))
    }

    func testAJournalRefusesToDecodeARecordWhoseLocationEscapesTheGrant() {
        let json = Data(
            """
            {
              "planDigest": "digest",
              "grantID": { "value": "grant-1" },
              "records": [
                {
                  "operationIndex": 0,
                  "kind": "move",
                  "priorLocation": "../../etc/passwd",
                  "newLocation": "a.pdf",
                  "destinationExisted": false,
                  "createdPaths": [],
                  "appliedAt": 5000
                }
              ]
            }
            """.utf8
        )
        XCTAssertThrowsError(try JSONDecoder().decode(UndoJournal.self, from: json))
    }
}
