import Foundation

/// The record of a spoken conversation, ordered **by the conversation rather
/// than by the network**.
///
/// This is a value type on its own because the rule it enforces is subtle enough
/// to have already been got wrong once, and because a rule that cannot be tested
/// without a live WebSocket does not get tested.
///
/// **The problem.** A realtime relay does not deliver a turn in the order it
/// happened. The model begins answering the moment the reader stops speaking,
/// while their own words are still being transcribed — so the assistant's line
/// arrives first and the question that prompted it arrives second, sometimes a
/// full second later. Appending frames as they land therefore prints every
/// question *underneath* its own answer, which is the one ordering a
/// conversation cannot have.
///
/// **The fix.** Remember where the current answer begins, and file the late
/// question there. The boundary is knowable exactly once — the instant the
/// answer starts — which is why it is recorded rather than reconstructed.
///
/// **Why not walk backwards.** The obvious repair is to step back over the
/// trailing run of assistant lines and insert above it. That is right for the
/// first turn and wrong for every turn after it: until the question is inserted
/// there is nothing separating turn two's answer from turn one's, so the walk
/// steps over both and files the second question above the first answer. The
/// transcript then reads Q1 Q2 A1 A2, which is worse than the bug it replaced
/// because it is only wrong further down the page, where it is less likely to be
/// noticed.
public struct JunoVoiceTranscriptRecord: Equatable, Sendable {

    /// One line of the record. `final` is false while the utterance is still
    /// being spoken, which is what lets a growing string rewrite its own row
    /// instead of printing the same sentence a dozen times.
    public struct Line: Identifiable, Equatable, Sendable {
        public let id: UUID
        public let role: JunoVoiceTranscriptRole
        public var text: String
        public var final: Bool
        /// Uploaded `Attachment` ids for the images/documents the reader showed
        /// the model on this turn.
        ///
        /// The line is where they have to live, because the line is the only
        /// thing that survives the call: the record is what gets posted to
        /// `/api/voice/transcript` on hang-up, and an id that is not on a line
        /// is an image absent from the saved conversation while the words that
        /// answered it are still there.
        public var attachmentIDs: [String]
        /// Bounded durable document context used to reseed a reconnect. It is
        /// kept separate from `text` so the visible transcript never displays
        /// parser output as if the reader had spoken it.
        public var context: String?

        public init(
            id: UUID = UUID(),
            role: JunoVoiceTranscriptRole,
            text: String,
            final: Bool,
            attachmentIDs: [String] = [],
            context: String? = nil
        ) {
            self.id = id
            self.role = role
            self.text = text
            self.final = final
            self.attachmentIDs = attachmentIDs
            self.context = context
        }
    }

    /// How many lines are kept. A long call otherwise grows an array that SwiftUI
    /// re-diffs on every partial transcript, several times a second.
    public static let capacity = 200

    public private(set) var lines: [Line] = []

    /// Where the answer currently being spoken begins. Nil between turns, when a
    /// question simply appends.
    private var answerStart: Int?

    public init() {}

    /// The relay says the model has started answering. Whatever the reader said
    /// belongs immediately above this point.
    ///
    /// Called from the relay's own turn frame rather than inferred from the first
    /// assistant word, because some relays send the frame first and some do not —
    /// and ``upsert(role:text:final:)`` covers the ones that do not.
    public mutating func beginAnswer() {
        answerStart = lines.endIndex
    }

    /// Rewrites the open line for this speaker, or opens one in the right place.
    ///
    /// `attachmentIDs` is applied only when it is non-empty. Every frame after
    /// the first carries none — the images arrive once, on the relay's echo of a
    /// composed turn, while the partials that rewrite the same row keep coming —
    /// so assigning unconditionally would clear the pictures off a line that had
    /// them a moment ago.
    public mutating func upsert(
        role: JunoVoiceTranscriptRole,
        text: String,
        final: Bool,
        attachmentIDs: [String] = [],
        context: String? = nil
    ) {
        if let index = lines.lastIndex(where: { $0.role == role && !$0.final }) {
            lines[index].text = text
            lines[index].final = final
            if !attachmentIDs.isEmpty { lines[index].attachmentIDs = attachmentIDs }
            if let context, !context.isEmpty { lines[index].context = context }
            trim()
            return
        }

        if role == .user, let at = answerStart, at <= lines.endIndex {
            lines.insert(
                Line(
                    role: role,
                    text: text,
                    final: final,
                    attachmentIDs: attachmentIDs,
                    context: context
                ), at: at
            )
            // Consumed. The next answer records its own start, and a second
            // question in the same turn belongs after this one, not on top of it.
            answerStart = nil
        } else {
            if role == .user {
                // The reader's words arrived before the model said anything —
                // the ordinary case, and there is no boundary left to honour.
                answerStart = nil
            } else if answerStart == nil {
                // An answer opening with no turn frame seen: it begins here, so a
                // late question still lands above it.
                answerStart = lines.endIndex
            }
            lines.append(
                Line(
                    role: role,
                    text: text,
                    final: final,
                    attachmentIDs: attachmentIDs,
                    context: context
                )
            )
        }
        trim()
    }

    public mutating func reset() {
        lines = []
        answerStart = nil
    }

    private mutating func trim() {
        guard lines.count > Self.capacity else { return }
        let dropped = lines.count - Self.capacity
        lines.removeFirst(dropped)
        // The boundary is an index into the array that just shifted. Left stale,
        // it would file the next question into the middle of an older answer.
        answerStart = answerStart.map { max(0, $0 - dropped) }
    }
}
