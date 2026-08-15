import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// A newer server must never break an older client's event log.
///
/// The rollback verbs (`rollback_ready`, `accept_change`, `reject_change`,
/// `undo_change`, `rollback_result`) were added to `NativeCodeEvent.Kind` after
/// shipped builds already existed, and the whole design rests on an assumption
/// nothing was asserting: that a kind a build has never heard of is *dropped*
/// rather than throwing. `decodeEvent` gets that right today because
/// `Kind(rawValue:)` is failable and its `guard` returns nil into a
/// `compactMap` — but that is one `try` away from becoming a stream that
/// finishes with an error, which on this surface reads to the owner as "that
/// task is broken" for a task that is running perfectly well. There is no
/// second layer catching it: `events(taskID:afterSeq:for:)` forwards a thrown
/// error straight to the caller via `continuation.finish(throwing:)`.
///
/// So this drives the real public entry point over a real SSE body rather than
/// poking at the enum. Testing `Kind(rawValue: "…") == nil` would pass even if
/// somebody made the decoder throw on the nil, which is exactly the regression
/// worth catching.
final class NativeCodeEventForwardCompatibilityTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    /// The frame carries one kind from a hypothetical future server alongside
    /// the kinds this build knows. The unknown one must cost nothing: the frame
    /// still arrives, and every event either side of it still decodes.
    func testAKindThisBuildHasNeverHeardOfIsDroppedRatherThanFailingTheStream() async throws {
        let frames = try await collectFrames(
            events: [
                event(seq: 1, kind: "text", payload: #"{"text":"Working on it"}"#),
                // Deliberately not a plausible near-future verb: the point is
                // that the decoder needs no foreknowledge at all.
                event(seq: 2, kind: "quantum_rebase", payload: #"{"anything":"at all"}"#),
                event(seq: 3, kind: "done", payload: "{}"),
            ]
        )

        let frame = try XCTUnwrap(frames.first, "the unknown kind must not lose the whole frame")
        guard case .snapshot(_, let events, _) = frame else {
            return XCTFail("expected a snapshot frame, got \(frame)")
        }
        XCTAssertEqual(
            events.map(\.seq), [1, 3],
            "the unrecognised event is skipped and its neighbours survive"
        )
    }

    /// `rollback_ready` is the host announcing a capability, not something that
    /// happened to the reader's files. It is decoded — so the log does not
    /// break on it — and then deliberately not shown, because a transcript line
    /// saying the host *could* roll back means nothing to somebody reading the
    /// run back afterwards.
    func testTheCapabilityAnnouncementDecodesButNeverBecomesALogLine() async throws {
        let frames = try await collectFrames(
            events: [
                event(
                    seq: 1, kind: "rollback_ready",
                    payload: #"{"paths":["src/app/page.tsx"]}"#
                ),
                event(seq: 2, kind: "accept_change", payload: #"{"path":"src/app/page.tsx"}"#),
            ]
        )

        guard case .snapshot(_, let events, _) = try XCTUnwrap(frames.first) else {
            return XCTFail("expected a snapshot frame")
        }
        XCTAssertEqual(events.map(\.seq), [2], "capability in, no line out")
        XCTAssertEqual(events.first?.kind, .acceptChange)
        XCTAssertEqual(
            events.first?.detail, "src/app/page.tsx",
            "a per-file verb names the one file it touched"
        )
    }

    /// Three outcomes, three sentences. Folding "nothing to roll back" into the
    /// failure case would send the reader hunting for a fault that is not
    /// there — the host is reporting it holds no snapshot, which is a fact
    /// about the checkpoint net rather than a broken rollback.
    ///
    /// Asserted as three *distinct* titles rather than three English strings on
    /// purpose: these keys carry `defaultValue:` fallbacks only until the iOS
    /// string catalogue gains the entries, and a test that pins the English
    /// would then fail on a pure translation change.
    func testTheThreeRollbackOutcomesAreNeverFoldedIntoTwo() async throws {
        let frames = try await collectFrames(
            events: [
                event(
                    seq: 1, kind: "rollback_result",
                    payload: #"{"requestId":"r1","status":"applied","paths":["a.ts","b.ts"]}"#
                ),
                event(
                    seq: 2, kind: "rollback_result",
                    payload: #"{"requestId":"r2","status":"unsupported"}"#
                ),
                event(
                    seq: 3, kind: "rollback_result",
                    payload: #"{"requestId":"r3","status":"failed","message":"the file moved"}"#
                ),
            ]
        )

        guard case .snapshot(_, let events, _) = try XCTUnwrap(frames.first) else {
            return XCTFail("expected a snapshot frame")
        }
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(Set(events.map(\.title)).count, 3, "each outcome reads differently")
        XCTAssertEqual(
            events[0].detail, "a.ts, b.ts",
            "the reader is told which files came back, not how many"
        )
        XCTAssertEqual(events[2].detail, "the file moved")
    }

    // MARK: - Fixtures

    private func event(seq: Int, kind: String, payload: String) -> String {
        """
        {"seq":\(seq),"kind":"\(kind)","payload":\(payload),\
        "createdAt":"2026-08-15T12:00:0\(seq)Z"}
        """
    }

    private func collectFrames(events: [String]) async throws -> [NativeCodeTaskClient.StreamFrame] {
        let body = """
            data: {"type":"snapshot","task":{"id":"task-1","title":"Run",\
            "prompt":"Run","status":"running","target":"cloud","repoOwner":"liam",\
            "repoName":"juno","lastSeq":0,"createdAt":"2026-08-15T12:00:00Z",\
            "updatedAt":"2026-08-15T12:00:00Z"},"events":[\(events.joined(separator: ","))]}

            """
        let client = NativeCodeTaskClient(
            sender: UnusedSender(), streamer: FixedBodyStreamer(body: body)
        )
        var frames: [NativeCodeTaskClient.StreamFrame] = []
        for try await frame in try await client.events(taskID: "task-1", afterSeq: 0, for: accountID) {
            frames.append(frame)
        }
        return frames
    }
}

/// `events(taskID:afterSeq:for:)` never reaches the request sender, so a double
/// that answers anything at all would be pretending. This one fails loudly if
/// the code path ever grows a call it did not have.
private struct UnusedSender: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        XCTFail("the event stream must not issue an ordinary request")
        return HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data())
    }
}

/// Byte at a time, exactly as `URLSession.bytes` delivers them — the parser is
/// a byte-wise state machine, and handing it one big chunk would skip the
/// framing it exists to do.
private struct FixedBodyStreamer: NativeAuthenticatedByteStreaming {
    let body: String

    func stream(
        _: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let bytes = Array(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            bytes: AsyncThrowingStream { continuation in
                for byte in bytes { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}
