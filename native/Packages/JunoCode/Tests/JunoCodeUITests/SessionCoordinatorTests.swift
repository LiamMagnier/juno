import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// Characterisation tests for the three coordinators split out of
/// ``SessionController``.
///
/// Each was a private method on a 2,400-line `@MainActor @Observable` class, so
/// exercising any of it meant standing up a workspace, a store, a permission
/// coordinator and a model client. As values they need none of that, which is
/// the point of the split: the console's line assembly and the changes
/// projection are the two pieces of that class most likely to be quietly wrong,
/// and neither had a test.
final class SessionTerminalLogTests: XCTestCase {
    private func log(_ chunks: [(ToolOutputChannel, String, String?)]) -> SessionTerminalLog {
        var log = SessionTerminalLog()
        for (channel, text, toolCallID) in chunks {
            log.append(channel: channel, text: text, toolCallID: toolCallID)
        }
        return log
    }

    func testWholeLinesBecomeLines() {
        let log = log([(.stdout, "one\ntwo\n", "call")])
        XCTAssertEqual(log.lines.map(\.text), ["one", "two"])
    }

    func testAChunkEndingMidLineIsContinuedByTheNext() {
        // Output arrives as pipe reads, not as lines. This is the whole reason
        // the pending-line state exists.
        let log = log([(.stdout, "hel", "call"), (.stdout, "lo\n", "call")])
        XCTAssertEqual(log.lines.map(\.text), ["hello"])
    }

    func testAContinuedLineIsReemittedUnderAFreshID() {
        // Pinned as it behaves, not as it ideally would. The partial row is
        // removed and the completed line appended with the next counter value,
        // so a line that arrives in three chunks is three different SwiftUI row
        // identities. Recorded here because it is invisible from the call site
        // and would otherwise be "fixed" by accident: changing it is a
        // behaviour change to the console's animation, not a refactor, and this
        // test is what makes that a decision rather than a side effect.
        var log = SessionTerminalLog()
        log.append(channel: .stdout, text: "hel", toolCallID: "call")
        let firstID = log.lines.first?.id
        log.append(channel: .stdout, text: "lo\n", toolCallID: "call")
        XCTAssertEqual(log.lines.count, 1)
        XCTAssertEqual(log.lines.first?.text, "hello")
        XCTAssertEqual(log.lines.first?.id, (firstID ?? 0) + 1)
    }

    func testAPartialLineIsNotContinuedAcrossChannels() {
        // stdout and stderr interleave. Splicing stderr into the middle of an
        // unfinished stdout sentence invents a line neither stream printed.
        let log = log([(.stdout, "out", "call"), (.stderr, "err\n", "call")])
        XCTAssertEqual(log.lines.map(\.text), ["out", "err"])
    }

    func testAPartialLineIsNotContinuedAcrossToolCalls() {
        let log = log([(.stdout, "first", "a"), (.stdout, "second\n", "b")])
        XCTAssertEqual(log.lines.map(\.text), ["first", "second"])
    }

    func testCarriageReturnsAreLineBreaks() {
        // Commands run with TERM=dumb and NO_COLOR, so a lone \r is a progress
        // redraw with no cursor to honour it.
        let log = log([(.stdout, "50%\r100%\r\ndone\n", nil)])
        XCTAssertEqual(log.lines.map(\.text), ["50%", "100%", "done"])
    }

    func testAnEmptyChunkChangesNothing() {
        var log = SessionTerminalLog()
        log.append(channel: .stdout, text: "kept", toolCallID: nil)
        let before = log.lines
        log.append(channel: .stdout, text: "", toolCallID: nil)
        XCTAssertEqual(log.lines, before)
    }

    func testTheBoundCountsLinesNotChunks() {
        // A single chunk carrying more than the limit must still leave exactly
        // the limit behind — this is what makes the console a tail rather than
        // an archive.
        var log = SessionTerminalLog()
        let flood = (0..<(SessionTerminalLog.lineLimit + 500))
            .map { "line \($0)" }
            .joined(separator: "\n") + "\n"
        log.append(channel: .stdout, text: flood, toolCallID: nil)
        XCTAssertEqual(log.lines.count, SessionTerminalLog.lineLimit)
        // The oldest went, not the newest.
        XCTAssertEqual(log.lines.last?.text, "line \(SessionTerminalLog.lineLimit + 499)")
    }

    func testIdsKeepClimbingAfterTheBoundDropsLines() {
        var log = SessionTerminalLog()
        for index in 0..<(SessionTerminalLog.lineLimit + 10) {
            log.append(channel: .stdout, text: "l\(index)\n", toolCallID: nil)
        }
        let ids = log.lines.map(\.id)
        XCTAssertEqual(ids, ids.sorted())
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testRebuildingFromATranscriptReplaysRecordedOutput() {
        // Reopening a session used to show an empty console beside a transcript
        // full of tool output.
        var log = SessionTerminalLog()
        log.rebuild(from: [
            event(0, .toolOutput(ToolOutputEvent(toolCallID: "a", channel: .stdout, text: "one\n"))),
            event(1, .assistantMessage(AssistantMessageEvent(text: "ignored"))),
            event(2, .toolOutput(ToolOutputEvent(toolCallID: "a", channel: .stdout, text: "two\n"))),
        ])
        XCTAssertEqual(log.lines.map(\.text), ["one", "two"])
    }

    func testRebuildingDiscardsWhateverWasThereBefore() {
        var log = SessionTerminalLog()
        log.append(channel: .stdout, text: "stale\n", toolCallID: nil)
        log.rebuild(from: [])
        XCTAssertTrue(log.lines.isEmpty)
        XCTAssertEqual(log.lineCounter, 0)
    }

    func testAdoptingAFixtureKeepsNewIdsAboveIt() {
        // The preview harness seeds finished lines; anything appended after
        // must not collide with their ids.
        var log = SessionTerminalLog()
        log.adopt(lines: [TerminalLine(id: 7, channel: .stdout, text: "seeded")])
        log.append(channel: .stdout, text: "next\n", toolCallID: nil)
        XCTAssertEqual(log.lines.map(\.id), [7, 8])
    }
}

final class TrackedChangeProjectionTests: XCTestCase {
    private func change(
        _ path: String,
        _ kind: FileChangeKind,
        added: Int,
        removed: Int,
        checkpoint: String? = nil
    ) -> SessionEventPayload {
        .fileChanged(
            FileChangedEvent(
                path: try! WorkspacePath(path),
                kind: kind,
                linesAdded: added,
                linesRemoved: removed,
                checkpointID: checkpoint
            )
        )
    }

    func testRepeatedEditsToOneFileBecomeOneRow() {
        let rows = TrackedChangeProjection.project(
            events: [
                event(0, change("a.swift", .created, added: 10, removed: 0, checkpoint: "c1")),
                event(1, change("a.swift", .modified, added: 5, removed: 2, checkpoint: "c2")),
            ],
            reviewStates: [:],
            lineStatsOverrides: [:]
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].linesAdded, 15)
        XCTAssertEqual(rows[0].linesRemoved, 2)
        // The latest kind wins: created-then-edited reads as an edit.
        XCTAssertEqual(rows[0].kind, .modified)
        // Every checkpoint is kept — undo needs all of them.
        XCTAssertEqual(rows[0].checkpointIDs, ["c1", "c2"])
    }

    func testRowsAreOrderedByFirstTouch() {
        let rows = TrackedChangeProjection.project(
            events: [
                event(0, change("b.swift", .modified, added: 1, removed: 0)),
                event(1, change("a.swift", .modified, added: 1, removed: 0)),
                event(2, change("b.swift", .modified, added: 1, removed: 0)),
            ],
            reviewStates: [:],
            lineStatsOverrides: [:]
        )
        XCTAssertEqual(rows.map(\.path), ["b.swift", "a.swift"])
    }

    func testAnOverrideReplacesTheAggregateRatherThanAddingToIt() {
        // After accepting one hunk of five, the honest number is the diff still
        // on disk, not the running total of everything the agent ever wrote.
        let rows = TrackedChangeProjection.project(
            events: [
                event(0, change("a.swift", .modified, added: 40, removed: 30)),
                event(1, change("a.swift", .modified, added: 40, removed: 30)),
            ],
            reviewStates: [:],
            lineStatsOverrides: ["a.swift": (added: 3, removed: 1)]
        )
        XCTAssertEqual(rows[0].linesAdded, 3)
        XCTAssertEqual(rows[0].linesRemoved, 1)
    }

    func testReviewStateDefaultsToPendingAndIsAppliedLast() {
        let events = [event(0, change("a.swift", .modified, added: 1, removed: 0))]
        XCTAssertEqual(
            TrackedChangeProjection.project(events: events, reviewStates: [:], lineStatsOverrides: [:])[0].reviewState,
            .pending
        )
        XCTAssertEqual(
            TrackedChangeProjection.project(
                events: events,
                reviewStates: ["a.swift": .rejected],
                lineStatsOverrides: [:]
            )[0].reviewState,
            .rejected
        )
    }

    func testStateForAPathThatWasNeverTouchedInventsNoRow() {
        let rows = TrackedChangeProjection.project(
            events: [],
            reviewStates: ["ghost.swift": .accepted],
            lineStatsOverrides: ["ghost.swift": (added: 9, removed: 9)]
        )
        XCTAssertTrue(rows.isEmpty)
    }

    func testNonFileEventsAreIgnored() {
        let rows = TrackedChangeProjection.project(
            events: [event(0, .assistantMessage(AssistantMessageEvent(text: "hello")))],
            reviewStates: [:],
            lineStatsOverrides: [:]
        )
        XCTAssertTrue(rows.isEmpty)
    }
}

final class SessionSubagentIndexTests: XCTestCase {
    private let child = CodeSessionID(value: "child-1")

    private func update(_ status: SubagentStatus, activity: String = "") -> SubagentUpdateEvent {
        SubagentUpdateEvent(
            agentID: "agent-1",
            toolCallID: "call-1",
            childSessionID: child,
            title: "Reviewer",
            task: "check the diff",
            role: .reviewer,
            status: status,
            currentActivity: activity
        )
    }

    func testARunningAgentIsIndexedWithItsActivity() {
        var index = SessionSubagentIndex()
        index.apply(update(.running, activity: "Reading Sources/App.swift"))
        XCTAssertTrue(index.isRunning(child))
        XCTAssertEqual(index.activity[child], "Reading Sources/App.swift")
    }

    func testATerminalStatusForgetsTheAgentEntirely() {
        // Leaving the activity behind would keep a finished agent showing a
        // "still working" line for the life of the session.
        var index = SessionSubagentIndex()
        index.apply(update(.running, activity: "Working"))
        index.apply(update(.completed))
        XCTAssertFalse(index.isRunning(child))
        XCTAssertNil(index.activity[child])
    }

    func testAnUpdateWithNoChildSessionIsIgnored() {
        // A queued agent has no session yet, and a failure can arrive before it
        // ever got one.
        var index = SessionSubagentIndex()
        index.apply(
            SubagentUpdateEvent(
                agentID: "a",
                toolCallID: "c",
                childSessionID: nil,
                title: "t",
                task: "t",
                role: .engineer,
                status: .queued
            )
        )
        XCTAssertTrue(index.activity.isEmpty)
        XCTAssertTrue(index.running.isEmpty)
    }

    func testAChildsOwnStepsDriveTheTicker() {
        var index = SessionSubagentIndex()
        index.apply(update(.running))
        index.applyStep(
            SessionEvent(
                sessionID: child,
                sequence: 1,
                timestamp: Date(timeIntervalSince1970: 0),
                payload: .toolProposed(
                    ToolProposedEvent(
                        toolCallID: "t",
                        toolName: "read_file",
                        input: .null,
                        risk: .read,
                        summary: "Read Sources/App.swift"
                    )
                )
            )
        )
        // The transcript's own sentence, not a vocabulary invented for the panel.
        XCTAssertEqual(index.activity[child], "Read Sources/App.swift")
    }

    func testRebuildingIndexesOnlyTheUnfinishedAgents() {
        // A finished agent's session is closed, so anything still arriving on
        // it is somebody re-opening it, not this run continuing.
        var index = SessionSubagentIndex()
        index.rebuild(from: [
            event(0, .subagentUpdated(update(.running, activity: "Working"))),
            event(1, .subagentUpdated(update(.completed))),
        ])
        XCTAssertTrue(index.running.isEmpty)
        XCTAssertTrue(index.activity.isEmpty)
    }

    func testRebuildingDiscardsWhateverWasThereBefore() {
        var index = SessionSubagentIndex()
        index.apply(update(.running, activity: "stale"))
        index.rebuild(from: [])
        XCTAssertTrue(index.running.isEmpty)
        XCTAssertTrue(index.activity.isEmpty)
    }
}

/// A transcript entry with a fixed clock — nothing here depends on wall time.
private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
    SessionEvent(
        sessionID: CodeSessionID(value: "session-1"),
        sequence: sequence,
        timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)),
        payload: payload
    )
}
