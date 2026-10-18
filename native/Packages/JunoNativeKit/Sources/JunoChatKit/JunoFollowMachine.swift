import CoreGraphics
import Foundation
import JunoDesignSystem

/// Reading-first follow (audit G18, REA chat UX §3.1): one rule set for where
/// the transcript may move while an answer streams.
///
/// The reader's eyes win over the stream. When a turn starts, its question is
/// pinned near the top of the viewport and the answer grows downward into a
/// reserved region below it, the *answer bed*. Nothing scrolls while the
/// answer fills the bed. Once it outgrows the bed the viewport still holds and
/// Jump to Latest appears; the transcript follows again only when the reader
/// goes back to the end themselves.
///
/// The Swift twin of `src/lib/chat/follow-machine.ts`. Both are held to the
/// same table in `contracts/chat/follow-machine.fixtures.json`, every state
/// against every event, so the web, Mac and iOS transcripts cannot drift.
public enum JunoFollowState: String, CaseIterable, Sendable {
    /// New content keeps the end in view.
    case following
    /// A turn just started: its question is pinned and the answer grows into
    /// the bed. The end of the scroll range is the pin.
    case placed
    /// The answer outgrew the bed; the viewport holds.
    case reading
    /// The reader moved; nothing moves on its own until they come back.
    case free
}

public enum JunoFollowEvent: String, CaseIterable, Sendable {
    /// A send, regenerate or resend: a new answer began.
    case turnStart = "turn-start"
    /// The answer passed the bottom of the viewport.
    case overflow
    /// The reader's own gesture moved up or left the end.
    case scrollAway = "scroll-away"
    /// The reader selected text in the transcript.
    case select
    /// The reader's own gesture reached the end of the scroll range.
    case nearEnd = "near-end"
    /// Jump to Latest.
    case jump
    /// The answer finished streaming.
    case settle
    /// A different conversation opened in place.
    case reset
}

public enum JunoFollowMachine {
    /// The pinned question's top sits this far below the top of the viewport
    /// (`JunoSpace.section`, the web's `--space-6`).
    public static let pinInset: CGFloat = JunoSpace.section
    /// A question taller than this share of the viewport (below the inset)
    /// is pinned by its foot, so its answer always has room on screen.
    public static let pinnedTurnShare: CGFloat = 0.5

    public static func next(_ state: JunoFollowState, on event: JunoFollowEvent) -> JunoFollowState {
        switch event {
        case .turnStart:
            return .placed
        case .jump, .reset:
            return .following
        case .overflow:
            return state == .placed ? .reading : state
        case .scrollAway, .select:
            return .free
        case .nearEnd:
            return state == .placed ? .placed : .following
        case .settle:
            return state == .placed ? .following : state
        }
    }

    /// Whether new content may move the viewport toward the end of the scroll range.
    public static func followsEnd(_ state: JunoFollowState) -> Bool {
        state == .following || state == .placed
    }

    public struct AnswerBed: Equatable, Sendable {
        /// The reserved space below the content, in whole points.
        public var height: CGFloat
        /// The content offset that lands `inset` below the viewport's top.
        public var anchorTop: CGFloat
        /// The content passed the bottom of the viewport.
        public var overflow: Bool

        public init(height: CGFloat, anchorTop: CGFloat, overflow: Bool) {
            self.height = height
            self.anchorTop = anchorTop
            self.overflow = overflow
        }
    }

    /// The answer bed for a pinned turn, sized so the end of the scroll range
    /// is exactly the pinned position. As the answer fills the bed, the bed
    /// shrinks by the same amount and the viewport stays still.
    public static func answerBed(
        viewportHeight: CGFloat,
        turnTop: CGFloat,
        turnHeight: CGFloat,
        contentEnd: CGFloat,
        inset: CGFloat = pinInset
    ) -> AnswerBed {
        let room = max(0, viewportHeight - inset)
        let clamp = max(0, turnHeight - room * pinnedTurnShare)
        let anchorTop = turnTop + clamp
        let used = contentEnd - anchorTop
        // `Math.round` on the web: halves round up, toward positive infinity.
        let height = max(0, (room - used + 0.5).rounded(.down))
        return AnswerBed(height: height, anchorTop: anchorTop, overflow: used > room + 1)
    }

    /// One transcript row, as turn detection needs it.
    public struct Row: Equatable, Sendable {
        public var key: String
        public var isQuestion: Bool
        public var isStreaming: Bool

        public init(key: String, isQuestion: Bool, isStreaming: Bool = false) {
            self.key = key
            self.isQuestion = isQuestion
            self.isStreaming = isStreaming
        }
    }

    /// The question to pin when this change started a turn, else nil: the
    /// newest row is an answer being written that was not there before,
    /// directly under a question, in a transcript that continues the previous
    /// one (see `startedTurn` in follow-machine.ts).
    public static func startedTurn(previousKeys: Set<String>, rows: [Row]) -> String? {
        guard rows.count >= 2, !previousKeys.isEmpty else { return nil }
        let answer = rows[rows.count - 1]
        let question = rows[rows.count - 2]
        guard !answer.isQuestion, answer.isStreaming, !previousKeys.contains(answer.key), question.isQuestion
        else { return nil }
        if previousKeys.contains(question.key) { return question.key }
        if rows.count >= 3, previousKeys.contains(rows[rows.count - 3].key) { return question.key }
        return nil
    }
}

/// The per-transcript bookkeeping the Mac and iOS transcripts share: the
/// machine's state, the pinned question and the bed's height.
public struct JunoPinnedTurn: Equatable, Sendable {
    public private(set) var state: JunoFollowState = .following
    /// The question pinned by the latest turn, until the next turn.
    public private(set) var pinnedID: String?
    /// The answer bed: extra space after the transcript's content.
    public private(set) var bedHeight: CGFloat = 0
    /// A turn started and its placement scroll has not happened yet: it waits
    /// for the first measurement, so it lands on a bed that exists.
    public private(set) var needsPlacement = false

    public init() {}

    /// New content may move the viewport toward the end.
    public var follows: Bool { JunoFollowMachine.followsEnd(state) }

    public mutating func send(_ event: JunoFollowEvent) {
        state = JunoFollowMachine.next(state, on: event)
    }

    public mutating func startTurn(pinning id: String) {
        pinnedID = id
        needsPlacement = true
        send(.turnStart)
    }

    /// A different conversation: no pin, no bed, following.
    public mutating func reset() {
        pinnedID = nil
        bedHeight = 0
        needsPlacement = false
        send(.reset)
    }

    /// Keeps the pin on the latest question when the store replaces a local
    /// row with the server's (a new id for the same turn).
    public mutating func reconcile(ids: [String], latestQuestionID: String?) {
        guard let pinned = pinnedID, !ids.contains(pinned) else { return }
        pinnedID = latestQuestionID
        if latestQuestionID == nil { bedHeight = 0 }
    }

    /// Sizes the bed from a measurement and reports overflow to the machine.
    /// Returns true once per turn, when the caller should scroll to the end:
    /// with the bed in place, the end is the pinned question.
    ///
    /// - Parameters:
    ///   - viewportHeight: the height content can be read in (the scroll
    ///     view less its insets: bars above, the composer and keyboard below).
    ///   - turnFrame: the pinned question's frame in content coordinates, or
    ///     nil when it is not laid out.
    ///   - contentEnd: where the transcript's own content ends, without the bed.
    ///   - inset: how far below the top of that height the question lands;
    ///     zero where a top content margin already provides the gap.
    public mutating func measure(
        viewportHeight: CGFloat,
        turnFrame: CGRect?,
        contentEnd: CGFloat,
        inset: CGFloat = JunoFollowMachine.pinInset
    ) -> Bool {
        guard pinnedID != nil, let turnFrame, viewportHeight > 0 else { return false }
        let bed = JunoFollowMachine.answerBed(
            viewportHeight: viewportHeight,
            turnTop: turnFrame.minY,
            turnHeight: turnFrame.height,
            contentEnd: contentEnd,
            inset: inset
        )
        if abs(bed.height - bedHeight) >= 1 { bedHeight = bed.height }
        if bed.overflow, state == .placed { send(.overflow) }
        guard needsPlacement else { return false }
        needsPlacement = false
        return true
    }
}
