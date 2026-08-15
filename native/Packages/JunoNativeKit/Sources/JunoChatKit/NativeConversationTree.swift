import Foundation
import JunoStorage

/// Where one message sits among the alternatives that share its parent.
///
/// This is what `‹ 2 / 3 ›` is made of. It exists as a value rather than as
/// fields on ``NativeChatMessage`` because a message's position in the tree is a
/// property of the *tree*, not of the message: the same row is revision 2 of 3
/// today and revision 2 of 4 the moment the reader edits it again, and copying
/// that number onto the message would give every screen holding an older copy a
/// confidently wrong pager.
public struct NativeMessageBranchPosition: Equatable, Sendable {
    /// Zero-based position among the siblings. The pager adds one for display —
    /// readers count from one, trees do not.
    public let index: Int

    /// The sibling ids in the order the pager steps through them, oldest branch
    /// first. Carried here so stepping never has to re-derive an ordering and
    /// risk disagreeing with the number it just displayed.
    public let siblingMessageIDs: [String]

    public var siblingsCount: Int { siblingMessageIDs.count }

    /// Whether there is anything to switch between. A message that has never
    /// been edited is `1 / 1`, and a pager on it would be a control that does
    /// nothing — so the UI asks this instead of comparing counts itself.
    public var hasAlternatives: Bool { siblingMessageIDs.count > 1 }

    public init(index: Int, siblingMessageIDs: [String]) {
        self.index = index
        self.siblingMessageIDs = siblingMessageIDs
    }

    /// The sibling `offset` steps away, or nil at either end.
    ///
    /// Nil rather than wrapping: a pager that jumps from `3 / 3` back to `1 / 3`
    /// on a forward tap reads as a lost branch, not as a wrap.
    public func siblingID(steppedBy offset: Int) -> String? {
        let target = index + offset
        guard target >= 0, target < siblingMessageIDs.count else { return nil }
        return siblingMessageIDs[target]
    }
}

/// The active timeline plus the branch positions needed to draw it.
public struct NativeConversationTree: Equatable, Sendable {
    /// The messages on the active path, in reading order.
    public let timeline: [NativeChatMessage]

    /// Branch position per message id — for every message in the conversation
    /// that has a recorded place in the tree, including the ones on branches
    /// the reader is not currently looking at.
    public let positions: [String: NativeMessageBranchPosition]

    /// Whether this conversation has any recorded topology at all.
    ///
    /// False means the transcript is a plain line — which is the state of every
    /// conversation synced from the server, since the backend stores message
    /// *versions* and has no parent link to send. It is not "unknown"; it is
    /// "never branched", and the timeline is then simply every message.
    public let isBranched: Bool

    public init(
        timeline: [NativeChatMessage],
        positions: [String: NativeMessageBranchPosition],
        isBranched: Bool
    ) {
        self.timeline = timeline
        self.positions = positions
        self.isBranched = isBranched
    }
}

/// Turns a flat transcript plus a set of parent links into the timeline the
/// reader sees.
///
/// **The active timeline is a projection, never a stored list.** Storing the
/// visible path as its own array would mean two sources of truth for the same
/// conversation, and the failure mode is not subtle: any edit that updated one
/// and not the other would leave the reader looking at a transcript that no
/// longer matches the tree it came from, with no way to tell which half is real.
/// Walking the tree costs a dictionary build per load and removes that class of
/// bug entirely.
public enum NativeConversationTreeProjection {
    /// Walks from the root, taking the active child at every branch point.
    ///
    /// - Parameters:
    ///   - messages: every persisted message of one conversation, any order.
    ///   - links: the branch edges recorded for that conversation. **Empty is
    ///     the normal case** — it means the conversation was never branched, and
    ///     the answer is the whole transcript in timestamp order, byte-identical
    ///     to what this app showed before trees existed.
    public static func project(
        messages: [NativeChatMessage],
        links: [MessageBranchLink]
    ) -> NativeConversationTree {
        let ordered = messages.sorted(by: chronological)
        guard !links.isEmpty else {
            return NativeConversationTree(
                timeline: ordered,
                positions: [:],
                isBranched: false
            )
        }

        let messagesByID = Dictionary(
            ordered.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        // Edges whose message no longer exists are dropped rather than followed.
        // A deleted message must not become a hole that stops the walk: the rest
        // of the reader's conversation is still there and still theirs.
        let liveLinks = links.filter { messagesByID[$0.messageID] != nil }
        guard !liveLinks.isEmpty else {
            return NativeConversationTree(
                timeline: ordered,
                positions: [:],
                isBranched: false
            )
        }

        var childrenByParent: [String?: [MessageBranchLink]] = [:]
        var linksByMessageID: [String: MessageBranchLink] = [:]
        for link in liveLinks {
            childrenByParent[link.parentMessageID, default: []].append(link)
            linksByMessageID[link.messageID] = link
        }
        for parent in childrenByParent.keys {
            childrenByParent[parent]?.sort(by: siblingOrder)
        }

        var positions: [String: NativeMessageBranchPosition] = [:]
        for (_, siblings) in childrenByParent {
            let ids = siblings.map(\.messageID)
            for (index, sibling) in siblings.enumerated() {
                positions[sibling.messageID] = NativeMessageBranchPosition(
                    index: index,
                    siblingMessageIDs: ids
                )
            }
        }

        var timeline: [NativeChatMessage] = []
        var visited = Set<String>()
        var parent: String?
        while let siblings = childrenByParent[parent], !siblings.isEmpty {
            let active = siblings.first(where: \.isActiveBranch) ?? siblings[0]
            // A cycle can only come from a corrupt or hand-edited database, but
            // an unguarded walk would spin forever rendering the same message —
            // a hang the reader would read as the app dying, not as bad data.
            guard visited.insert(active.messageID).inserted,
                let message = messagesByID[active.messageID]
            else { break }
            timeline.append(message)
            parent = active.messageID
        }

        // Messages the tree has not placed yet. These are rows that landed from
        // sync after the last reconciliation, and the only ones it is safe to
        // show are those newer than every edge in the tree: those provably
        // arrived at the tip, because the tip is the only place this app sends.
        // An unplaced message *older* than the tree belongs to a branch nobody
        // recorded; appending it to the current path would splice one branch's
        // words into another's, so it waits for reconciliation instead of being
        // shown in the wrong conversation.
        let newestPlaced = ordered.last { linksByMessageID[$0.id] != nil }
        if let newestPlaced {
            for message in ordered
            where linksByMessageID[message.id] == nil
                && chronological(newestPlaced, message)
            {
                timeline.append(message)
            }
        }

        return NativeConversationTree(
            timeline: timeline,
            positions: positions,
            isBranched: true
        )
    }

    /// The links a conversation needs so that every message has a place in the
    /// tree, given the links it already has.
    ///
    /// Returns an empty array in the two cases where writing anything would be a
    /// lie: a conversation with no edges at all (it was never branched, and
    /// inventing a spine for it would turn every synced transcript in the
    /// account into client-owned topology), and one where every message is
    /// already placed.
    ///
    /// Unplaced messages are attached to the tip of the *active* path, in
    /// timestamp order, recomputing the tip after each. That is not a guess: a
    /// branched conversation only ever receives new messages at the end of the
    /// path the reader is looking at, because that is the only path this app
    /// sends into.
    public static func reconciliationLinks(
        conversationID: String,
        messages: [NativeChatMessage],
        links: [MessageBranchLink],
        now: Date
    ) -> [MessageBranchLink] {
        guard !links.isEmpty else { return [] }
        let ordered = messages.sorted(by: chronological)
        var placed = Set(links.map(\.messageID))
        let unplaced = ordered.filter { !placed.contains($0.id) }
        guard !unplaced.isEmpty else { return [] }

        var known = links
        var created: [MessageBranchLink] = []
        for message in unplaced {
            let tip = project(
                messages: ordered.filter { placed.contains($0.id) },
                links: known
            ).timeline.last?.id
            let link = MessageBranchLink(
                conversationID: conversationID,
                messageID: message.id,
                parentMessageID: tip,
                // The tip has no other children yet — if it had, this message
                // would be arriving into a branch point the reader never made.
                branchIndex: 0,
                isActiveBranch: true,
                createdAt: now
            )
            known.append(link)
            created.append(link)
            placed.insert(message.id)
        }
        return created
    }

    /// The linear spine to record for a conversation that is about to gain its
    /// first branch.
    ///
    /// Nothing is written until the reader actually forks, so an account that
    /// never edits a message never grows a single row in `message_branches`.
    /// The spine is the transcript exactly as it reads today, which is why
    /// laying it down changes nothing on screen.
    public static func spineLinks(
        conversationID: String,
        messages: [NativeChatMessage],
        now: Date
    ) -> [MessageBranchLink] {
        var parent: String?
        var links: [MessageBranchLink] = []
        for message in messages.sorted(by: chronological) {
            links.append(
                MessageBranchLink(
                    conversationID: conversationID,
                    messageID: message.id,
                    parentMessageID: parent,
                    branchIndex: 0,
                    isActiveBranch: true,
                    createdAt: now
                )
            )
            parent = message.id
        }
        return links
    }

    /// Message ids on the active path from `messageID` onwards, inclusive.
    ///
    /// Used to hide the path an edit is replacing *while the new answer is still
    /// streaming* — the rows are not deleted, and switching back to that branch
    /// brings every one of them back.
    public static func activeSuffix(
        from messageID: String,
        timeline: [NativeChatMessage]
    ) -> Set<String> {
        guard let index = timeline.firstIndex(where: { $0.id == messageID }) else {
            return []
        }
        return Set(timeline[index...].map(\.id))
    }

    /// The comparator the rest of the chat code already sorts transcripts by.
    /// Duplicated deliberately as a single shared function so a projection can
    /// never disagree with the list it is projecting.
    static func chronological(
        _ lhs: NativeChatMessage,
        _ rhs: NativeChatMessage
    ) -> Bool {
        lhs.createdAt == rhs.createdAt ? lhs.id < rhs.id : lhs.createdAt < rhs.createdAt
    }

    private static func siblingOrder(
        _ lhs: MessageBranchLink,
        _ rhs: MessageBranchLink
    ) -> Bool {
        if lhs.branchIndex != rhs.branchIndex { return lhs.branchIndex < rhs.branchIndex }
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
        return lhs.messageID < rhs.messageID
    }
}
