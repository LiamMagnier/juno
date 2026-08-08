import JunoCore

public extension NativeCodeTask {
    /// Projects a Cloud/Remote Code task into the shared activity vocabulary.
    /// Code's approval state is represented by its canonical status, while a
    /// failed task remains visible through the shared failed filter.
    var junoRecentItem: JunoRecentItem {
        JunoRecentItem(
            sourceID: id,
            kind: .code,
            title: title,
            updatedAt: updatedAt,
            status: status.rawValue,
            needsAttention: status == .awaitingApproval,
            subtitle: whereItRuns.isEmpty ? nil : whereItRuns
        )
    }
}
