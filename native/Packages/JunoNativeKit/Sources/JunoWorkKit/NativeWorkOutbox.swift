import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// One thing that happened during a run, on its way from the Mac that did it to
/// everybody watching.
///
/// `seq` is the *producer's* sequence and belongs to this host, not to the
/// relay: the relay keeps its own `lastSeq` and hands back how far it has
/// accepted, so the two cursors can be compared without either side guessing.
/// That is what lets a Mac that was offline for an hour re-send from exactly the
/// event the relay is missing rather than from the beginning.
public struct WorkRunEvent: Equatable, Sendable {
    public let seq: Int
    /// One of `WORK_EVENT_KINDS` in `src/lib/work/domain.ts`. Raw rather than an
    /// enum because the vocabulary is the server's; a kind this build does not
    /// know is a 400 that names itself, which is more useful than a Swift
    /// enumeration that cannot express it.
    public let kind: String
    public let payload: [String: JunoJSONValue]
    /// A stable identity for this event, so a re-sent batch is recognised as a
    /// re-send instead of appended twice. Nil for events with nothing stable to
    /// key on.
    public let eventKey: String?

    public init(
        seq: Int,
        kind: String,
        payload: [String: JunoJSONValue] = [:],
        eventKey: String? = nil
    ) {
        self.seq = seq
        self.kind = kind
        self.payload = payload
        self.eventKey = eventKey
    }
}

/// What the relay made of one drained batch.
public struct WorkRunOutboxReceipt: Equatable, Sendable {
    /// The producer sequence the relay agrees it holds everything up to. The
    /// host's next `afterSeq`.
    public let acceptedThrough: Int
    /// The first producer sequence the relay never received. Non-nil means the
    /// batch was truncated there and the host must re-send from it.
    public let firstGap: Int?

    public init(acceptedThrough: Int, firstGap: Int?) {
        self.acceptedThrough = acceptedThrough
        self.firstGap = firstGap
    }
}

/// Where a run's transcript goes.
///
/// A seam because the failures worth exercising are all about a network that
/// came and went: a batch delivered twice, a batch with a hole in it, and a
/// drain that fails while the run keeps producing.
public protocol WorkRunReporting: Sendable {
    func appendRunEvents(
        hostID: String,
        runID: String,
        afterSeq: Int,
        events: [WorkRunEvent],
        for accountID: AccountID
    ) async throws -> WorkRunOutboxReceipt
}

extension NativeWorkClient: WorkRunReporting {
    /// The relay's ceiling on one drain. Matched here so an over-long batch is
    /// split by the caller rather than refused wholesale by the route — a Mac
    /// reconnecting after an hour offline has thousands of events, and a
    /// rejected batch is a transcript nobody ever sees.
    public static let maximumOutboxBatch = 500

    /// Drains part of one run's outbox.
    ///
    /// Nothing here retries. The caller owns the buffer and therefore owns the
    /// decision to re-send, which is the only place that can honour `firstGap`:
    /// a retry at this layer would re-post the same batch the relay has already
    /// told it to rewind past.
    public func appendRunEvents(
        hostID: String,
        runID: String,
        afterSeq: Int,
        events: [WorkRunEvent],
        for accountID: AccountID
    ) async throws -> WorkRunOutboxReceipt {
        try validateRelayIdentifier(hostID)
        try validateRelayIdentifier(runID)
        guard !events.isEmpty, events.count <= Self.maximumOutboxBatch else {
            throw WorkRemoteError.malformedResponse
        }

        let body: [String: JunoJSONValue] = [
            "runId": .string(runID),
            "afterSeq": .number(Double(max(0, afterSeq))),
            "events": .array(
                events.map { event in
                    var item: [String: JunoJSONValue] = [
                        "seq": .number(Double(event.seq)),
                        "kind": .string(event.kind),
                        "payload": .object(event.payload),
                    ]
                    if let key = event.eventKey { item["eventKey"] = .string(key) }
                    // `visibility` is deliberately never sent. The per-kind table
                    // in `domain.ts` decides, and a host asserting `user` on an
                    // internal kind would publish executor detail into somebody's
                    // transcript.
                    return .object(item)
                }
            ),
        ]

        let response = try await relaySend(
            .post, "/api/work/hosts/\(hostID)/events", body: .object(body), for: accountID
        )
        guard let root = try relayObject(response) else { throw WorkRemoteError.malformedResponse }
        return WorkRunOutboxReceipt(
            acceptedThrough: root["acceptedThrough"]?.numberValue.map(Int.init) ?? afterSeq,
            firstGap: root["firstGap"]?.numberValue.map(Int.init)
        )
    }
}
