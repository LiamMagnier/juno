import JunoCodeCore
import XCTest
@testable import JunoCodeRemote

final class CodeLinkReducerTests: XCTestCase {
    private func followed(_ snapshot: CodeV2.SessionSnapshot = Fixture.snapshot()) -> CodeLinkRemoteState {
        var state = CodeLinkRemoteState()
        state.setSessions([Fixture.summary("s1", state: .idle, updatedAt: "2026-10-10T09:00:00Z")])
        state.follow(Fixture.summary("s1", state: .idle, updatedAt: "2026-10-10T09:00:00Z"))
        return state
    }

    func testFollowStartsAtCursorMinusOne() {
        let state = followed()
        XCTAssertEqual(state.cursors, ["s1": -1])
    }

    func testSnapshotThenDeltasStream() {
        var state = followed()
        let message = CodeV2.TurnItem.assistantMessage(CodeV2.AssistantMessage(
            id: "m1", turnId: "t1", createdAt: "2026-10-10T10:00:00Z", text: "Hel", streaming: true
        ))
        let effects = state.apply([
            Fixture.envelope(5, .sessionSnapshot(snapshotSequence: 5, session: Fixture.snapshot(state: .running, items: [message], activeTurnId: "t1"))),
            Fixture.envelope(6, .itemDelta(itemId: "m1", field: "text", append: "lo")),
            Fixture.envelope(7, .itemDelta(itemId: "m1", field: "text", append: ", world")),
        ])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(state.cursors["s1"], 7)
        guard case let .assistantMessage(m)? = state.threads["s1"]?.item("m1") else { return XCTFail("no message") }
        XCTAssertEqual(m.text, "Hello, world")
        XCTAssertTrue(m.streaming)
        state.apply([Fixture.envelope(8, .turnCompleted(turnId: "t1", outcome: .completed, usage: nil))])
        guard case let .assistantMessage(done)? = state.threads["s1"]?.item("m1") else { return XCTFail("no message") }
        XCTAssertFalse(done.streaming)
        XCTAssertEqual(state.threads["s1"]?.snapshot.state, .idle)
        XCTAssertEqual(state.sessions["s1"]?.state, .idle)
    }

    func testDuplicatesAreDropped() {
        var state = followed()
        let message = CodeV2.TurnItem.assistantMessage(CodeV2.AssistantMessage(id: "m1", createdAt: "x", text: "A"))
        state.apply([
            Fixture.envelope(1, .sessionSnapshot(snapshotSequence: 1, session: Fixture.snapshot(items: [message]))),
            Fixture.envelope(2, .itemDelta(itemId: "m1", field: "text", append: "B")),
        ])
        let effects = state.apply([Fixture.envelope(2, .itemDelta(itemId: "m1", field: "text", append: "B"))])
        XCTAssertEqual(effects, [])
        guard case let .assistantMessage(m)? = state.threads["s1"]?.item("m1") else { return XCTFail() }
        XCTAssertEqual(m.text, "AB")
        XCTAssertEqual(state.cursors["s1"], 2)
    }

    func testGapAsksToReopenFromTheCursorOnce() {
        var state = followed()
        state.apply([Fixture.envelope(3, .sessionSnapshot(snapshotSequence: 3, session: Fixture.snapshot()))])
        let effects = state.apply([
            Fixture.envelope(5, .sessionState(state: .running, resumeAt: nil, message: nil)),
            Fixture.envelope(6, .sessionState(state: .idle, resumeAt: nil, message: nil)),
        ])
        XCTAssertEqual(effects, [.reopen(sessionId: "s1", cwd: "/Users/me/code/shop", afterSequence: 3)])
        XCTAssertEqual(state.cursors["s1"], 3, "nothing past the hole is applied")
        XCTAssertEqual(state.threads["s1"]?.snapshot.state, .idle)
    }

    func testEventBeforeAnySnapshotIsAGapWithoutCursor() {
        var state = followed()
        let effects = state.apply([Fixture.envelope(9, .sessionState(state: .running, resumeAt: nil, message: nil))])
        XCTAssertEqual(effects, [.reopen(sessionId: "s1", cwd: "/Users/me/code/s1", afterSequence: nil)])
    }

    func testStaleSnapshotNeverRollsBack() {
        var state = followed()
        let item = CodeV2.TurnItem.userMessage(CodeV2.UserMessage(id: "u1", createdAt: "x", text: "Go"))
        state.apply([
            Fixture.envelope(10, .sessionSnapshot(snapshotSequence: 10, session: Fixture.snapshot(items: [item]))),
        ])
        state.apply([Fixture.envelope(4, .sessionSnapshot(snapshotSequence: 4, session: Fixture.snapshot(items: [])))])
        XCTAssertEqual(state.threads["s1"]?.items.count, 1)
        XCTAssertEqual(state.cursors["s1"], 10)
    }

    func testApprovalPendingThenResolved() {
        var state = followed()
        state.apply([
            Fixture.envelope(1, .sessionSnapshot(snapshotSequence: 1, session: Fixture.snapshot(state: .running, activeTurnId: "t1"))),
            Fixture.envelope(2, .itemAdded(Fixture.approval(.pending))),
        ])
        XCTAssertEqual(state.threads["s1"]?.snapshot.state, .waiting)
        XCTAssertEqual(state.status(of: "s1"), .needsYou)
        XCTAssertEqual(state.sessions["s1"]?.state, .waiting)
        state.apply([Fixture.envelope(3, .itemUpdated(Fixture.approval(.resolved)))])
        XCTAssertEqual(state.threads["s1"]?.snapshot.state, .running)
        XCTAssertEqual(state.status(of: "s1"), .working)
    }

    func testQueueAndStateEvents() {
        var state = followed()
        let queued = CodeV2.QueuedInput(id: "q1", input: CodeV2.UserInput(text: "then the tests"), queuedAt: "x")
        state.apply([
            Fixture.envelope(1, .sessionSnapshot(snapshotSequence: 1, session: Fixture.snapshot())),
            Fixture.envelope(2, .turnStarted(turnId: "t2", selection: Fixture.claudeSub)),
            Fixture.envelope(3, .queueUpdated([queued])),
            Fixture.envelope(4, .sessionState(state: .limited, resumeAt: "2026-10-10T15:00:00Z", message: "Limit reached")),
        ])
        let thread = state.threads["s1"]
        XCTAssertEqual(thread?.snapshot.queue, [queued])
        XCTAssertEqual(thread?.snapshot.selection, Fixture.claudeSub)
        XCTAssertEqual(thread?.snapshot.state, .limited)
        XCTAssertEqual(thread?.stateMessage, "Limit reached")
        XCTAssertEqual(state.status(of: "s1"), .limited)
    }

    func testGlobalStreamFeedsTerminalAndDropsReplays() {
        var state = CodeLinkRemoteState()
        state.openedTerminal("term")
        state.apply([
            CodeV2.ServerEventEnvelope(stream: .global, sessionId: nil, sequence: 1, at: "x", event: .terminalOutput(terminalId: "term", data: "$ ls\r\n")),
            CodeV2.ServerEventEnvelope(stream: .global, sessionId: nil, sequence: 2, at: "x", event: .terminalOutput(terminalId: "term", data: "README.md\r\n")),
        ])
        state.apply([CodeV2.ServerEventEnvelope(stream: .global, sessionId: nil, sequence: 2, at: "x", event: .terminalOutput(terminalId: "term", data: "README.md\r\n"))])
        XCTAssertEqual(state.globalCursor, 2)
        XCTAssertEqual(state.terminals["term"]?.text.trimmingCharacters(in: .whitespacesAndNewlines), "$ ls\nREADME.md")
    }

    // MARK: Session list

    func testListPutsNeedsYouFirstThenWorkingThenNewest() {
        var state = CodeLinkRemoteState()
        state.setSessions([
            Fixture.summary("old", state: .idle, updatedAt: "2026-10-08T10:00:00Z"),
            Fixture.summary("new", state: .idle, updatedAt: "2026-10-10T10:00:00Z"),
            Fixture.summary("busy", state: .running, updatedAt: "2026-10-07T10:00:00Z"),
            Fixture.summary("ask", state: .waiting, updatedAt: "2026-10-01T10:00:00Z"),
            Fixture.summary("err", state: .error, updatedAt: "2026-10-09T10:00:00Z"),
        ])
        XCTAssertEqual(state.orderedSessions.map(\.id), ["ask", "busy", "new", "err", "old"])
    }

    func testLiveEventsMoveARowUpAndAFreshListDoesNotUndoThem() {
        var state = CodeLinkRemoteState()
        let rows = [
            Fixture.summary("a", state: .idle, updatedAt: "2026-10-10T09:00:00Z"),
            Fixture.summary("b", state: .idle, updatedAt: "2026-10-09T09:00:00Z"),
        ]
        state.setSessions(rows)
        state.follow(rows[1])
        state.apply([
            Fixture.envelope(1, .sessionSnapshot(snapshotSequence: 1, session: Fixture.snapshot(id: "b")), session: "b", at: "2026-10-10T11:00:00Z"),
            Fixture.envelope(2, .turnStarted(turnId: "t", selection: Fixture.sonnet), session: "b", at: "2026-10-10T11:00:01Z"),
        ])
        XCTAssertEqual(state.orderedSessions.map(\.id), ["b", "a"])
        XCTAssertEqual(state.sessions["b"]?.updatedAt, "2026-10-10T11:00:01Z")
        // A list fetched before those events still says idle at sequence 0.
        state.setSessions(rows)
        XCTAssertEqual(state.sessions["b"]?.state, .running)
        XCTAssertEqual(CodeLinkSessionStatus(state: .running).words, "Working")
        XCTAssertTrue(CodeLinkSessionStatus(state: .waiting).isLive)
        XCTAssertFalse(CodeLinkSessionStatus(state: .error).isLive)
    }
}
