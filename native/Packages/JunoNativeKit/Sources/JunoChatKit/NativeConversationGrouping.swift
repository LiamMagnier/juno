import Foundation

/// The recency buckets the chat sidebar groups conversations into.
///
/// Ordering is the declaration order, so a caller can iterate `allCases` and get
/// the display order for free.
public enum NativeConversationBucket: String, CaseIterable, Identifiable, Sendable {
    case pinned
    case today
    case yesterday
    case previous7Days
    case previous30Days
    case older
    case archived

    public var id: String { rawValue }
}

/// One rendered sidebar group: a bucket and the conversations in it.
public struct NativeConversationGroup: Equatable, Identifiable, Sendable {
    public let bucket: NativeConversationBucket
    public let conversations: [NativeConversation]

    public var id: String { bucket.rawValue }

    public init(bucket: NativeConversationBucket, conversations: [NativeConversation]) {
        self.bucket = bucket
        self.conversations = conversations
    }
}

public enum NativeConversationGrouping {
    /// Groups conversations into the sidebar's recency buckets.
    ///
    /// Rules, in order of precedence:
    /// - archived conversations go to `.archived` regardless of age or pin, so
    ///   archiving always removes a row from the main list;
    /// - pinned conversations go to `.pinned` regardless of age;
    /// - everything else falls into a calendar-relative bucket by
    ///   `lastMessageAt`.
    ///
    /// Buckets are dropped when empty, and each bucket is sorted newest-first.
    /// `calendar` and `now` are injected so the boundaries are testable and so
    /// "today" means the user's calendar day, not a 24-hour window.
    public static func groups(
        for conversations: [NativeConversation],
        now: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [NativeConversationGroup] {
        var buckets: [NativeConversationBucket: [NativeConversation]] = [:]
        for conversation in conversations {
            buckets[bucket(for: conversation, now: now, calendar: calendar), default: []]
                .append(conversation)
        }
        return NativeConversationBucket.allCases.compactMap { bucket in
            guard let items = buckets[bucket], !items.isEmpty else { return nil }
            return NativeConversationGroup(
                bucket: bucket,
                // Ties break on id so the order is stable across reloads rather
                // than reshuffling rows that share a timestamp.
                conversations: items.sorted {
                    $0.lastMessageAt == $1.lastMessageAt
                        ? $0.id < $1.id
                        : $0.lastMessageAt > $1.lastMessageAt
                }
            )
        }
    }

    static func bucket(
        for conversation: NativeConversation,
        now: Date,
        calendar: Calendar
    ) -> NativeConversationBucket {
        if conversation.isArchived { return .archived }
        if conversation.pinned { return .pinned }

        let date = conversation.lastMessageAt
        // Every boundary is measured from the injected `now`, never from
        // `Calendar.isDateInToday(_:)` and friends — those read the system
        // clock, so they would drift away from `now` the moment the caller
        // holds a reference date (a frozen clock, a preview, or a sidebar that
        // read the time once and is still open after midnight).
        let startOfToday = calendar.startOfDay(for: now)
        let startOfDate = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: startOfDate, to: startOfToday).day ?? 0
        // A conversation dated in the future (clock skew between devices is
        // real) reads as the most recent thing, not the oldest, so negative
        // day offsets collapse into today.
        if days <= 0 { return .today }
        if days == 1 { return .yesterday }
        if days <= 7 { return .previous7Days }
        if days <= 30 { return .previous30Days }
        return .older
    }
}
