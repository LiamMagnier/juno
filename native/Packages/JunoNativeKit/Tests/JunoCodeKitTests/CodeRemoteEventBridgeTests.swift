import XCTest
import JunoCore
@testable import JunoCodeKit

/// The durable path from a hosted session to the phone watching it.
///
/// Everything the person holding the phone knows about a remote session
/// arrives through this bridge. The Mac's own transcript is local, so a dropped
/// post is not a degraded view — it is the only view, with a hole in it. These
/// cover the ways that hole could open.
final class CodeRemoteEventBridgeTests: XCTestCase {
    /// A relay that can be told to fail, and records what it accepted.
    private actor Relay {
        private(set) var accepted: [CodeRemoteSessionEvent] = []
        private(set) var attempts = 0
        private var failuresRemaining = 0
        private var permanentFailure: CodeRemoteError?

        func failNext(_ count: Int) { failuresRemaining = count }
        func failPermanently(_ error: CodeRemoteError) { permanentFailure = error }

        func post(_ events: [CodeRemoteSessionEvent]) throws {
            attempts += 1
            if let permanentFailure { throw permanentFailure }
            if failuresRemaining > 0 {
                failuresRemaining -= 1
                throw CodeRemoteError.server(
                    statusCode: 503, message: "relay down", retryable: true
                )
            }
            accepted.append(contentsOf: events)
        }
    }

    private func bridge(_ relay: Relay, capacity: Int = 1_000) -> CodeRemoteEventBridge {
        CodeRemoteEventBridge(
            capacity: capacity,
            // No real waiting: sleeping here would only make the suite slow.
            sleep: { _ in },
            post: { events in try await relay.post(events) }
        )
    }

    func testEventsAreSequencedFromOne() async {
        let relay = Relay()
        let sut = bridge(relay)

        await sut.enqueue(kind: "text", payload: [:])
        await sut.enqueue(kind: "tool", payload: [:])
        _ = await sut.flush()

        let accepted = await relay.accepted
        XCTAssertEqual(accepted.map(\.seq), [1, 2])
        let mark = await sut.highWaterMark
        XCTAssertEqual(mark, 2)
    }

    /// A transient failure must not consume the buffer — that is exactly how a
    /// tool call goes missing from the phone's transcript with nothing said.
    func testATransientFailureLeavesEventsBufferedAndRetriesThem() async {
        let relay = Relay()
        await relay.failNext(2)
        let sut = bridge(relay)

        await sut.enqueue(kind: "text", payload: [:])
        let ok = await sut.flush()

        XCTAssertTrue(ok)
        let accepted = await relay.accepted
        XCTAssertEqual(accepted.map(\.seq), [1], "the event must survive to be delivered")
        let attempts = await relay.attempts
        XCTAssertEqual(attempts, 3, "two failures then a success")
    }

    func testEventsStayBufferedWhenEveryAttemptFails() async {
        let relay = Relay()
        await relay.failNext(99)
        let sut = bridge(relay)

        await sut.enqueue(kind: "text", payload: [:])
        let ok = await sut.flush(maximumAttempts: 2)

        XCTAssertFalse(ok)
        let pending = await sut.pendingCount
        XCTAssertEqual(pending, 1, "a failed flush must not discard the event")
    }

    /// Sequence numbers must not shift when a batch is re-sent, or a consumer
    /// resuming from a cursor cannot tell a duplicate from a new event.
    func testSequenceNumbersAreStableAcrossRetries() async {
        let relay = Relay()
        await relay.failNext(1)
        let sut = bridge(relay)

        await sut.enqueue(kind: "a", payload: [:])
        await sut.enqueue(kind: "b", payload: [:])
        _ = await sut.flush()

        let accepted = await relay.accepted
        XCTAssertEqual(accepted.map(\.seq), [1, 2])
        XCTAssertEqual(accepted.map(\.kind), ["a", "b"])
    }

    /// A revoked device will never accept these. Retrying forever keeps a
    /// decommissioned Mac posting at a relay that has already refused it.
    func testAPermanentRefusalStopsRatherThanRetrying() async {
        let relay = Relay()
        await relay.failPermanently(
            .server(statusCode: 403, message: "device revoked", retryable: false)
        )
        let sut = bridge(relay)

        await sut.enqueue(kind: "text", payload: [:])
        let ok = await sut.flush()

        XCTAssertFalse(ok)
        let attempts = await relay.attempts
        XCTAssertEqual(attempts, 1, "a permanent refusal must not be retried")
        let pending = await sut.pendingCount
        XCTAssertEqual(pending, 0, "and the buffer is released rather than growing forever")
    }

    func testALongOutageIsBoundedAndTheGapIsAnnounced() async {
        let relay = Relay()
        let sut = bridge(relay, capacity: 10)

        for index in 0..<40 { await sut.enqueue(kind: "e\(index)", payload: [:]) }

        let pending = await sut.pendingCount
        XCTAssertEqual(pending, 10, "an outage must not become unbounded memory")

        _ = await sut.flush()
        let accepted = await relay.accepted
        XCTAssertEqual(accepted.first?.kind, "e0", "the start of the session survives")
        XCTAssertEqual(accepted.last?.kind, "e39", "and so does the outcome")

        let notice = await sut.drainDropNotice()
        XCTAssertEqual(notice?.kind, "error")
        XCTAssertTrue(
            String(describing: notice?.payload["message"]).contains("dropped"),
            "a silent hole reads as a complete transcript"
        )
    }

    func testTheDropNoticeIsOnlyIssuedOnce() async {
        let relay = Relay()
        let sut = bridge(relay, capacity: 4)
        for index in 0..<20 { await sut.enqueue(kind: "e\(index)", payload: [:]) }

        // Hoisted: XCTAssert takes an autoclosure, which cannot await.
        let first = await sut.drainDropNotice()
        XCTAssertNotNil(first)
        let second = await sut.drainDropNotice()
        XCTAssertNil(second, "a drained notice must not repeat")
    }

    func testNothingBufferedIsASuccessfulNoOp() async {
        let relay = Relay()
        let sut = bridge(relay)
        let ok = await sut.flush()
        XCTAssertTrue(ok)
        let attempts = await relay.attempts
        XCTAssertEqual(attempts, 0)
    }

    /// A burst is split, so one flush cannot become a body the relay refuses.
    func testALargeBacklogIsSentInBoundedBatches() async {
        let relay = Relay()
        let sut = bridge(relay, capacity: 10_000)
        for index in 0..<250 { await sut.enqueue(kind: "e\(index)", payload: [:]) }

        _ = await sut.flush()

        let attempts = await relay.attempts
        XCTAssertGreaterThan(attempts, 1, "250 events must not go in one body")
        let accepted = await relay.accepted
        XCTAssertEqual(accepted.count, 250, "and all of them must arrive")
        XCTAssertEqual(accepted.map(\.seq), Array(1...250), "in order, with no gaps")
    }
}
