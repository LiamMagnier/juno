import Foundation

/// Finds the stored row behind an artifact a reply mentions.
///
/// The web keeps one map per conversation — `artifactsByIdentifier`, keyed by
/// the tag's `identifier` — and every inline card reads its artifact from it
/// (`message-item.tsx`). The Mac drew cards from the tag body alone, so a card
/// never knew its version, never knew it had been revised, and the canvas
/// opened on whatever the tag carried — which, for a revision written under
/// the same identifier, was the previous one (Artifacts & Design audit,
/// mac-artifacts-1).
///
/// Built from ``NativeArtifactModel/artifacts`` for one conversation; a value,
/// so a row can carry it through the environment and a test can build one
/// from a literal.
public struct ChatArtifactResolver: Equatable, Sendable {
    public let conversationID: String?
    /// This conversation's rows, keyed by their **own** identifier. A row M11
    /// retired to `{identifier}~{last 6 of id}` when a re-emission changed its
    /// type (`artifacts-store.ts` `retiredIdentifier`) is its own key here.
    private let byIdentifier: [String: NativeArtifact]

    public init(artifacts: [NativeArtifact], conversationID: String?) {
        self.conversationID = conversationID
        guard let conversationID, !conversationID.isEmpty else {
            byIdentifier = [:]
            return
        }
        var rows: [String: NativeArtifact] = [:]
        for artifact in artifacts where artifact.conversationID == conversationID {
            // Only rows that genuinely share an identifier meet here — a
            // streamed row beside its synced self — and the one further along
            // wins. A retired row has an identifier of its own and never
            // competes with the row that took its old one.
            if let existing = rows[artifact.identifier], existing.currentVersion >= artifact.currentVersion {
                continue
            }
            rows[artifact.identifier] = artifact
        }
        byIdentifier = rows
    }

    public static let empty = ChatArtifactResolver(artifacts: [], conversationID: nil)

    /// The stored row a tag in one message means — the web's
    /// `resolveArtifactTag` (`src/lib/chat-client-state.ts`).
    ///
    /// Usually the one row with the tag's identifier. When a re-emission
    /// changed the type, the server gave the identifier to a new row and
    /// retired the old one to `{identifier}~{id tail}`; a tag written before
    /// that change must still open what it made. So among the rows that have
    /// held the identifier, the one this message created wins; otherwise the
    /// newest that existed when the message was written; otherwise the oldest.
    ///
    /// Two candidates can both be this message's own (one message emitted
    /// both types); the oldest by `(createdAt, id)` wins, so the answer never
    /// depends on dictionary order.
    ///
    /// - Parameters:
    ///   - messageID: the message carrying the tag.
    ///   - messageCreatedAt: when it was written. A streaming placeholder
    ///     passes its local stamp. Nil reads as "before every candidate", as
    ///     the web's `Date.parse` of a missing stamp does.
    public func artifact(
        for reference: NativeMessageContent.ArtifactReference,
        messageID: String?,
        messageCreatedAt: Date?
    ) -> NativeArtifact? {
        let identifier = reference.identifier
        guard !identifier.isEmpty else { return nil }
        let current = byIdentifier[identifier]
        let retiredPrefix = identifier + "~"
        var held = byIdentifier.filter { $0.key.hasPrefix(retiredPrefix) }.map(\.value)
        if held.isEmpty { return current }
        if let current { held.append(current) }
        held.sort { lhs, rhs in
            lhs.createdAt != rhs.createdAt ? lhs.createdAt < rhs.createdAt : lhs.id < rhs.id
        }
        if let messageID, let own = held.first(where: { $0.messageID == messageID }) {
            return own
        }
        var pick = held[0]
        if let messageCreatedAt {
            for candidate in held where candidate.createdAt <= messageCreatedAt {
                pick = candidate
            }
        }
        return pick
    }

    /// The stored row with this id, if it is one of this conversation's.
    /// The canvas dock follows the row it opened by id, so a later type
    /// change — which gives the tag's identifier to a new row — cannot swap
    /// what is open.
    public func artifact(id: String) -> NativeArtifact? {
        byIdentifier.values.first { $0.id == id }
    }

    /// The stored row whose **own** identifier this is — a reference made
    /// from a row (the toolbar's Outputs, the ⌘K panel), which names that row
    /// and no other, so no retired-identifier rule applies.
    public func artifact(identifier: String) -> NativeArtifact? {
        byIdentifier[identifier]
    }

    /// Everything an inline card draws, resolved the way the web resolves it.
    public func card(
        for reference: NativeMessageContent.ArtifactReference,
        messageID: String,
        messageCreatedAt: Date?,
        messageIsPending: Bool
    ) -> ChatArtifactCard {
        ChatArtifactCard(
            reference: reference,
            stored: artifact(for: reference, messageID: messageID, messageCreatedAt: messageCreatedAt),
            messageID: messageID,
            messageIsPending: messageIsPending
        )
    }

    /// ``card(for:messageID:messageCreatedAt:messageIsPending:)`` for a message.
    public func card(
        for reference: NativeMessageContent.ArtifactReference,
        message: NativeChatMessage,
        messageIsPending: Bool
    ) -> ChatArtifactCard {
        card(for: reference, messageID: message.id, messageCreatedAt: message.createdAt, messageIsPending: messageIsPending)
    }
}

/// What an inline artifact card shows: the web's `ArtifactInlineCard` props,
/// taken from the stored row where there is one and from the tag where there
/// is not (`message-item.tsx`).
public struct ChatArtifactCard: Equatable, Sendable {
    public let reference: NativeMessageContent.ArtifactReference
    public let stored: NativeArtifact?
    /// The model is still writing this tag in this message.
    public let isStreaming: Bool
    /// This message revised an artifact an earlier turn created.
    public let isUpdated: Bool

    public init(
        reference: NativeMessageContent.ArtifactReference,
        stored: NativeArtifact?,
        messageID: String,
        messageIsPending: Bool
    ) {
        self.reference = reference
        self.stored = stored
        isStreaming = reference.streaming && messageIsPending
        // The row stays pinned to the message that first wrote it; any other
        // message carrying the same identifier revised it.
        isUpdated = stored.map { $0.messageID != nil && $0.messageID != messageID } ?? false
    }

    public var title: String {
        let title = stored?.title ?? reference.title
        return title.isEmpty ? "Untitled artifact" : title
    }

    /// `stored?.type ?? part.artifactType ?? "CODE"`.
    public var kind: NativeArtifactKind {
        stored?.kind ?? NativeArtifactKind(rawValue: reference.kind.uppercased()) ?? .code
    }

    public var language: String? {
        stored?.language ?? reference.language
    }

    /// The stored row's latest source — except while this message is still
    /// writing, when the tag is the source being written. (The web reads the
    /// stored row even then, which shows a revision's *previous* body under
    /// "Writing"; the tag is what is arriving.)
    public var content: String {
        if isStreaming { return reference.content }
        return stored?.currentContent ?? reference.content
    }

    /// `v{n}` is shown from the second version on.
    public var version: Int? {
        guard !isStreaming, let version = stored?.currentVersion, version > 1 else { return nil }
        return version
    }

    /// Whether the card draws a design: only from the stored row, whose body
    /// is the expanded `DesignDocument`. The tag carries the model's compact
    /// authoring form, which no native renderer reads (Artifacts & Design
    /// audit, X-11), so without a row — and while the model is still
    /// writing — a design shows its source.
    public var drawsDesign: Bool {
        kind.isDesignDocument && !isStreaming && stored?.currentContent != nil
    }

    public var runtime: NativeArtifactRuntimeInfo {
        NativeArtifactRuntimeInfo.resolve(kind: kind, language: language)
    }
}
