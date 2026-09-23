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
    private let byIdentifier: [String: NativeArtifact]

    public init(artifacts: [NativeArtifact], conversationID: String?) {
        self.conversationID = conversationID
        guard let conversationID, !conversationID.isEmpty else {
            byIdentifier = [:]
            return
        }
        var rows: [String: NativeArtifact] = [:]
        for artifact in artifacts where artifact.conversationID == conversationID {
            // One row per identifier per conversation on the server; should two
            // ever meet here (a streamed row beside its synced self), the one
            // further along wins.
            if let existing = rows[artifact.identifier], existing.currentVersion >= artifact.currentVersion {
                continue
            }
            rows[artifact.identifier] = artifact
        }
        byIdentifier = rows
    }

    public static let empty = ChatArtifactResolver(artifacts: [], conversationID: nil)

    /// The stored row for a reference, or nil.
    public func artifact(for reference: NativeMessageContent.ArtifactReference) -> NativeArtifact? {
        guard !reference.identifier.isEmpty else { return nil }
        return byIdentifier[reference.identifier]
    }

    /// Everything an inline card draws, resolved the way the web resolves it.
    public func card(
        for reference: NativeMessageContent.ArtifactReference,
        messageID: String,
        messageIsPending: Bool
    ) -> ChatArtifactCard {
        ChatArtifactCard(reference: reference, stored: artifact(for: reference), messageID: messageID, messageIsPending: messageIsPending)
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
