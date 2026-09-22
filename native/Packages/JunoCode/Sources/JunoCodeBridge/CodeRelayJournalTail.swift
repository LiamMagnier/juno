import Foundation
import JunoCodeCore

/// The not-yet-uploaded end of each listed session's transcript, held in
/// memory.
///
/// Reading a transcript means decoding its whole file, and a working session
/// grows by an event every few hundred milliseconds. Without this the uploader
/// would re-read a long session from disk for every batch it sends. With it, a
/// session is read once and then kept current from the store's own append
/// notifications.
///
/// Held events are only a cache: whatever it cannot answer exactly — a range it
/// never held, a gap in the appends it saw — returns nil, and the caller reads
/// the file. It also forgets what the relay has acknowledged, so it holds the
/// backlog and no more.
public struct CodeRelayJournalTail: Sendable {
    /// Per session, so one enormous backfill cannot hold a transcript's worth
    /// of events in memory.
    public static let maximumEventsPerSession = 2_000
    public static let maximumSessions = 24

    private struct Tail {
        /// The local sequence of `events.first`, or of the next event when
        /// empty. Held events are contiguous from here.
        var base: Int
        var events: [SessionEvent]
        var lastUsed: Int

        var end: Int { base + events.count }
    }

    private var tails: [CodeSessionID: Tail] = [:]
    private var clock = 0

    public init() {}

    /// Events with local sequences from `start`, at most `limit` and below
    /// `total`, when every one of them is held; nil otherwise.
    ///
    /// Asking from `start` also discards everything before it: the uploader
    /// asks from its cursor, and nothing below the cursor is needed again.
    public mutating func events(
        for sessionID: CodeSessionID, from start: Int, limit: Int, total: Int
    ) -> [SessionEvent]? {
        guard var tail = tails[sessionID], start >= tail.base else { return nil }
        let upper = min(total, start + limit)
        guard upper <= tail.end, start <= upper else { return nil }
        tail.events.removeFirst(start - tail.base)
        tail.base = start
        clock += 1
        tail.lastUsed = clock
        tails[sessionID] = tail
        return Array(tail.events.prefix(upper - start))
    }

    /// Keeps a freshly read transcript from `start` on.
    public mutating func load(_ events: [SessionEvent], for sessionID: CodeSessionID, from start: Int) {
        var held: [SessionEvent] = []
        var expected = start
        for event in events where event.sequence >= start {
            // Stop at the first hole: held events are contiguous or useless.
            guard event.sequence == expected, held.count < Self.maximumEventsPerSession else { break }
            held.append(event)
            expected += 1
        }
        clock += 1
        tails[sessionID] = Tail(base: start, events: held, lastUsed: clock)
        evictIfNeeded()
    }

    /// Adds an event the store just appended, when it continues what is held.
    /// Anything else is left for the next read from disk to pick up.
    public mutating func append(_ event: SessionEvent) {
        guard var tail = tails[event.sessionID], event.sequence == tail.end,
            tail.events.count < Self.maximumEventsPerSession
        else { return }
        tail.events.append(event)
        tails[event.sessionID] = tail
    }

    public mutating func forget(_ sessionID: CodeSessionID) {
        tails.removeValue(forKey: sessionID)
    }

    public func heldCount(for sessionID: CodeSessionID) -> Int {
        tails[sessionID]?.events.count ?? 0
    }

    private mutating func evictIfNeeded() {
        while tails.count > Self.maximumSessions,
            let oldest = tails.min(by: { $0.value.lastUsed < $1.value.lastUsed })?.key
        {
            tails.removeValue(forKey: oldest)
        }
    }
}
