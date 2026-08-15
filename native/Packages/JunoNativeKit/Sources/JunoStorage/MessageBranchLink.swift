import Foundation

/// One durable parent → child edge in a conversation's message tree.
///
/// **Why this is not a field on the message payload.** `StoredRecord.payload`
/// holds the bytes the *server* sent, and every sync page rewrites it wholesale.
/// A parent link written in there would survive exactly until the next pull
/// touched that message and would then vanish — silently collapsing a branched
/// conversation back into a straight line and stranding entire edits the reader
/// could still see a moment earlier. The backend has message *versions*
/// (`MessageVersion`, `GET /api/messages/:id/versions`), which are prior
/// *contents* of one row, not a tree; nothing on the wire carries a parent. So
/// the topology is client-owned and lives in its own table that sync never
/// writes.
///
/// **Absence is not a default.** A message with no row here is not a root and is
/// not an orphan: it is a message whose position was never branched, which the
/// active-timeline projection reads as "plain linear transcript". That is the
/// state every row synced from a branch-unaware server starts in, and it must
/// keep rendering exactly as it did before this table existed.
public struct MessageBranchLink: Hashable, Sendable {
    /// The conversation the edge belongs to. Carried on the edge rather than
    /// looked up through the message, so a branch read never has to decrypt a
    /// message payload to find out which transcript it is drawing.
    public let conversationID: String

    /// The message this edge describes — the *child* end.
    public let messageID: String

    /// The message this one answers, or **nil when this message opens the
    /// conversation**.
    ///
    /// Nil states a fact ("this is a root"), never ignorance. A message whose
    /// parent is genuinely unknown has no row in this table at all — see the
    /// type's note above. Two different absences, two different meanings, and
    /// conflating them is what would let a mid-transcript message be drawn as
    /// the first thing the reader ever said.
    public let parentMessageID: String?

    /// Position among the siblings sharing `parentMessageID`, zero-based, fixed
    /// when the branch is created.
    ///
    /// It is what lets `‹ 2 / 3 ›` keep saying *two* for the same revision.
    /// Deriving the order from timestamps instead would renumber the pager
    /// whenever two messages landed in the same millisecond, which is exactly
    /// what an edit followed immediately by a resend produces.
    public let branchIndex: Int

    /// Whether the active-timeline walk descends into this child.
    ///
    /// At most one sibling under a parent may carry `true`, and the repository
    /// enforces that on write. Two active siblings is not a state the projection
    /// can render: it would have to pick one silently, and the reader would have
    /// no way to tell which half of their conversation had been dropped.
    public let isActiveBranch: Bool

    /// When the edge was created — the branch's own age, not the message's.
    /// Used only as a stable tiebreaker between siblings whose `branchIndex`
    /// somehow collides on a database written by an older build.
    public let createdAt: Date

    public init(
        conversationID: String,
        messageID: String,
        parentMessageID: String?,
        branchIndex: Int,
        isActiveBranch: Bool,
        createdAt: Date
    ) {
        self.conversationID = conversationID
        self.messageID = messageID
        self.parentMessageID = parentMessageID
        self.branchIndex = branchIndex
        self.isActiveBranch = isActiveBranch
        self.createdAt = createdAt
    }
}
