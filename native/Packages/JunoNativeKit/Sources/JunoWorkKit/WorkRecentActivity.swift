import JunoCore

public extension WorkSessionSummary {
    /// Projects the server-owned Work session without re-deriving its
    /// attention state. The server flag stays authoritative; the shared
    /// projection only understands the common display vocabulary.
    var junoRecentItem: JunoRecentItem {
        JunoRecentItem(
            sourceID: sessionID,
            kind: .work,
            title: title,
            updatedAt: lastActivityAt,
            pinned: pinned,
            status: status,
            needsAttention: needsAttention,
            subtitle: goal.isEmpty ? nil : goal
        )
    }
}
