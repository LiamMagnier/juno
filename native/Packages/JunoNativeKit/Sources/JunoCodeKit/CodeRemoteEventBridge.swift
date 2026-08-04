import Foundation
import JunoCore

/// Streams a hosted session's events to the relay, durably.
///
/// The failure this exists to prevent is the one the phone actually sees. A
/// remote session runs on the Mac; everything the person holding the phone
/// knows about it arrives through here. If a post is dropped on a transient
/// error, the phone's transcript is missing a tool call, a diff or an approval
/// request — and there is no second copy anywhere, because the Mac's own
/// transcript is local. A gap here is not a degraded view, it is the only view.
///
/// So events leave the buffer only once the relay has acknowledged them, and
/// the sequence is assigned here rather than by the relay: a consumer resuming
/// from a cursor needs the numbering to be stable across retries, and a number
/// handed out by the server would change when a batch was re-sent.
public actor CodeRemoteEventBridge {
    /// Bound on what an outage may buffer before the oldest middle is dropped.
    public static let defaultCapacity = 1_000
    /// Ceiling on one POST, so a burst does not become a body the relay refuses.
    public static let maximumBatch = 100

    public struct Pending: Equatable, Sendable {
        public let event: CodeRemoteSessionEvent
        public init(event: CodeRemoteSessionEvent) { self.event = event }
    }

    /// The one operation this needs. A closure rather than the whole client:
    /// the bridge's job is buffering and retry, and coupling that to a concrete
    /// transport would make the retry policy testable only against a network.
    public typealias Post = @Sendable ([CodeRemoteSessionEvent]) async throws -> Void

    private let post: Post
    private let capacity: Int
    private let sleep: @Sendable (Duration) async throws -> Void

    private var buffer: [CodeRemoteSessionEvent] = []
    private var nextSeq = 1
    private var flushing = false
    /// Counted rather than silently absorbed, so the gap can be announced.
    public private(set) var droppedCount = 0
    public private(set) var lastError: String?

    public init(
        capacity: Int = CodeRemoteEventBridge.defaultCapacity,
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        post: @escaping Post
    ) {
        self.capacity = capacity
        self.sleep = sleep
        self.post = post
    }

    /// The bridge for one hosted session, posting through the relay client.
    public static func relaying(
        deviceID: String,
        sessionID: String,
        accountID: AccountID,
        client: NativeCodeRemoteClient,
        capacity: Int = CodeRemoteEventBridge.defaultCapacity
    ) -> CodeRemoteEventBridge {
        CodeRemoteEventBridge(capacity: capacity) { events in
            try await client.postEvents(
                deviceID: deviceID, sessionID: sessionID,
                events: events, for: accountID
            )
        }
    }

    public var pendingCount: Int { buffer.count }
    /// The highest sequence assigned so far — the cursor a client resumes from.
    public var highWaterMark: Int { nextSeq - 1 }

    /// Buffers one event and assigns its sequence.
    ///
    /// Sequencing at enqueue rather than at send means a retried batch carries
    /// the numbers it carried the first time, so a relay that stored some of it
    /// can drop exactly the duplicates and keep the rest.
    public func enqueue(kind: String, payload: [String: JunoJSONValue]) {
        let event = CodeRemoteSessionEvent(
            seq: nextSeq, kind: kind, payload: payload, createdAt: Date()
        )
        nextSeq += 1
        buffer.append(event)
        trim()
    }

    /// Enforces the capacity by dropping from the middle.
    ///
    /// The beginning of a session says what it was asked to do and the end says
    /// how it finished. The middle is what a reader can most afford to lose,
    /// and dropping the newest would lose the outcome — the one thing that has
    /// to survive.
    private func trim() {
        guard buffer.count > capacity else { return }
        let excess = buffer.count - capacity
        buffer.removeSubrange((capacity / 2)..<((capacity / 2) + excess))
        droppedCount += excess
    }

    /// Sends everything buffered, retrying transient failures.
    ///
    /// Reentrancy-guarded: the session emits events while a flush is in
    /// flight, and two concurrent flushes would post the same batch twice.
    @discardableResult
    public func flush(maximumAttempts: Int = 5) async -> Bool {
        guard !flushing else { return false }
        flushing = true
        defer { flushing = false }

        while !buffer.isEmpty {
            let batch = Array(buffer.prefix(Self.maximumBatch))
            var attempt = 0
            var sent = false

            while attempt < maximumAttempts, !sent {
                do {
                    try await post(batch)
                    sent = true
                } catch let error as CodeRemoteError where !error.isRetryable {
                    // A revoked device or a deleted session will never accept
                    // these. Retrying forever would keep a decommissioned Mac
                    // posting at a relay that has already refused it.
                    lastError = error.localizedDescription
                    buffer.removeAll()
                    return false
                } catch {
                    attempt += 1
                    lastError = error.localizedDescription
                    if attempt >= maximumAttempts { break }
                    try? await sleep(backoff(attempt: attempt))
                }
            }

            guard sent else { return false } // Stays buffered for the next flush.
            buffer.removeFirst(batch.count)
            lastError = nil
        }
        return true
    }

    /// Exponential with jitter. Every host that lost the relay at the same
    /// moment would otherwise come back at the same moment.
    private func backoff(attempt: Int) -> Duration {
        let capped = min(attempt, 5)
        let seconds = min(pow(2.0, Double(capped)), 30)
        return .milliseconds(Int(seconds * 1000 * Double.random(in: 0.5...1.5)))
    }

    /// A transcript entry announcing what was lost, when anything was.
    ///
    /// Announced rather than hidden: a phone showing a session with a silent
    /// hole in it reads as a complete transcript, which is the failure the
    /// buffering exists to avoid arriving one layer down.
    public func drainDropNotice() -> (kind: String, payload: [String: JunoJSONValue])? {
        guard droppedCount > 0 else { return nil }
        let count = droppedCount
        droppedCount = 0
        return (
            kind: "error",
            payload: [
                "message": .string(
                    "\(count) update(s) were dropped while this Mac could not reach Juno. "
                        + "The start and end of this session are intact."
                )
            ]
        )
    }
}
