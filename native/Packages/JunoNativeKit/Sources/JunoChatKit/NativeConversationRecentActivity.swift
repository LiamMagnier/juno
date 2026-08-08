import JunoCore

public extension NativeConversation {
    /// Projects the conversation into the shared activity vocabulary.
    var junoRecentItem: JunoRecentItem {
        JunoRecentItem(
            sourceID: id,
            kind: .chat,
            title: title,
            updatedAt: lastMessageAt,
            pinned: pinned,
            projectID: projectId
        )
    }
}
