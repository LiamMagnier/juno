import Foundation
import JunoCore
import XCTest

@testable import JunoWorkKit

/// The rest of the old Work window's log readers, moved into JunoWorkKit in
/// Phase 5 Stage D: every visible event as a line, what the run touched,
/// whether a batch still stands, and the work between turns.
final class WorkEventLogStageDTests: XCTestCase {
    private func event(_ seq: Int, _ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue] = [:]) -> WorkEvent {
        WorkEvent(
            seq: seq, kind: kind.rawValue, payload: payload, agentID: nil,
            createdAt: Date(timeIntervalSince1970: 1_000 + Double(seq) * 30)
        )
    }

    // MARK: Entries

    /// The plan's own events are drawn by the plan, not the log; everything
    /// else visible is a line with its mark and tone.
    func testEntriesSayEachEventAndLeaveThePlanOut() {
        let entries = WorkEventLog.entries(in: [
            event(1, .runStarted, ["target": .string("local")]),
            event(2, .planCreated, ["steps": .array([])]),
            event(3, .toolStarted, ["tool": .string("read_file")]),
            event(4, .approvalResolved, ["decision": .string("denied"), "summary": .string("Send the memo")]),
            event(5, .filesChanged, ["files": .array([.string("a"), .string("b")])]),
            event(6, .runFinished, ["reason": .string("completed")]),
            event(7, .error, ["message": .string("The portal stopped answering.")]),
        ])
        XCTAssertEqual(entries.map(\.id), [1, 3, 4, 5, 6, 7])
        XCTAssertEqual(entries[0].title, "Started")
        XCTAssertEqual(entries[0].mark, .started)
        XCTAssertEqual(entries[1].mark, .tool)
        XCTAssertEqual(entries[2].title, "You refused an action")
        XCTAssertEqual(entries[2].detail, "Send the memo")
        XCTAssertEqual(entries[3].title, "2 files changed")
        XCTAssertEqual(entries[4].title, "Finished")
        XCTAssertEqual(entries[4].tone, .good)
        XCTAssertEqual(entries[5].title, "Something went wrong")
        XCTAssertEqual(entries[5].mark, .problem)
        XCTAssertEqual(entries[5].tone, .bad)
    }

    /// A kind this build does not know hides rather than leaks.
    func testAnUnknownKindIsLeftOut() {
        let unknown = WorkEvent(
            seq: 9, kind: "from_the_future", payload: [:], agentID: nil, createdAt: Date()
        )
        XCTAssertTrue(WorkEventLog.entries(in: [unknown]).isEmpty)
    }

    // MARK: References

    /// A changed file is named, never given by path; a change that cannot be
    /// named is stated by its size.
    func testReferencesNameFilesAndNeverPrintAPath() {
        let references = WorkEventLog.references(in: [
            event(1, .sourceCited, ["title": .string("Corvid price list"), "url": .string("https://corvid.example/prices")]),
            event(2, .filesChanged, ["files": .array([
                .object(["name": .string("Q3 reconciliation.xlsx"), "change": .string("created")]),
            ])]),
            event(3, .filesChanged, ["files": .array([.string("/Users/liam/Finance/q3.xlsx")])]),
        ])
        XCTAssertEqual(references.map(\.direction), [.read, .written, .written])
        XCTAssertEqual(references[0].label, "Corvid price list")
        XCTAssertEqual(references[1].label, "Q3 reconciliation.xlsx")
        XCTAssertEqual(references[1].detail, "Created")
        XCTAssertEqual(references[2].label, "1 file changed")
        XCTAssertFalse(references.contains { $0.label.contains("/Users/") })
    }

    // MARK: Batches and groups

    func testABatchStandsUntilItIsUndone() {
        XCTAssertFalse(WorkEventLog.hasAppliedBatch(in: []))
        XCTAssertTrue(WorkEventLog.hasAppliedBatch(in: [event(1, .batchApplied)]))
        XCTAssertFalse(WorkEventLog.hasAppliedBatch(in: [event(1, .batchApplied), event(2, .batchUndone)]))
    }

    /// Work between two turns folds into one group that leads up to the turn;
    /// work after the last turn has none.
    func testWorkGroupsBreakAtTurns() {
        let groups = WorkEventLog.workGroups(in: [
            event(1, .toolStarted, ["summary": .string("Reading the invoices")]),
            event(3, .toolFinished, ["summary": .string("Read the invoices")]),
            event(4, .assistantMessage, ["text": .string("Found 212 invoices.")]),
            event(5, .stepStarted, ["title": .string("Match to orders")]),
        ])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].entries.map(\.id), [1, 3])
        XCTAssertNotNil(groups[0].beforeTurnID)
        XCTAssertEqual(groups[0].title, "Worked for 1m")
        XCTAssertNil(groups[1].beforeTurnID)
        XCTAssertEqual(groups[1].title, "Worked")
    }
}
