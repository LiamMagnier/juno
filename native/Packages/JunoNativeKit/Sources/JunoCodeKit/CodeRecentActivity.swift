import JunoCore

public extension NativeCodeTask {
    /// Projects a Cloud/Remote Code task into the shared activity vocabulary.
    /// Code's approval state is represented by its canonical status. A failed
    /// task also belongs in the native attention rail: it is a user-actionable
    /// outcome even though it is not waiting for an approval response.
    var junoRecentItem: JunoRecentItem {
        JunoRecentItem(
            sourceID: id,
            kind: .code,
            title: title,
            updatedAt: updatedAt,
            status: status.rawValue,
            needsAttention: status == .awaitingApproval || status == .failed,
            subtitle: whereItRuns.isEmpty ? nil : whereItRuns
        )
    }
}
