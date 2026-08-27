import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The index into the review: which files changed, by how much, and what has
/// been dealt with. The diff itself stays on the wide review canvas; this pane
/// remains the fast, scannable index into that work.
struct ChangesTab: View {
    @Bindable var controller: SessionController
    @Bindable var review: ReviewModel
    @State private var selection: String?
    @State private var revertingAll = false
    @State private var confirmsRevertAll = false
    @State private var pendingRevertPath: String?
    @State private var pendingForcedRevertPath: String?
    @State private var revertFailureTitle = ""
    @State private var revertFailureMessage: String?

    var body: some View {
        Group {
            if controller.changes.isEmpty {
                JunoEmptyState(
                    title: "No changes yet",
                    message: "Files Juno edits appear here, with the diff one click away.",
                    symbol: "plusminus.circle"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    changeSummary
                    Divider().overlay(Color.junoSeparator)

                    List(controller.changes, selection: $selection) { change in
                        row(change)
                            .junoSidebarRowInk()
                            .tag(change.path)
                    }
                    .listStyle(.inset)
                    .junoSidebarSelectionTint()
                    .accessibilityIdentifier("juno.code.changes")
                    .onChange(of: selection) {
                        guard let selection else { return }
                        review.present(path: selection)
                    }

                    Divider().overlay(Color.junoSeparator)
                    footer
                }
            }
        }
        .confirmationDialog(
            "Revert all unreviewed files?",
            isPresented: $confirmsRevertAll,
            titleVisibility: .visible
        ) {
            Button("Revert All", role: .destructive) {
                revertingAll = true
                Task {
                    let result = await controller.rejectAll()
                    await review.load(from: controller)
                    revertingAll = false
                    if let message = result.failureSummary {
                        revertFailureTitle = "Some Files Were Not Reverted"
                        revertFailureMessage = message
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Juno restores each file from its checkpoint. Files changed afterward are left untouched."
            )
        }
        .confirmationDialog(
            "Revert this file?",
            isPresented: Binding(
                get: { pendingRevertPath != nil },
                set: { if !$0 { pendingRevertPath = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let path = pendingRevertPath {
                Button("Revert \(PathDisplay.fileName(path))", role: .destructive) {
                    pendingRevertPath = nil
                    revertFile(path, force: false)
                }
            }
            Button("Cancel", role: .cancel) { pendingRevertPath = nil }
        } message: {
            Text("The file is restored from Juno's checkpoints unless newer content is detected.")
        }
        .confirmationDialog(
            "That file changed since Juno captured it",
            isPresented: Binding(
                get: { pendingForcedRevertPath != nil },
                set: { if !$0 { pendingForcedRevertPath = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let path = pendingForcedRevertPath {
                Button("Restore Anyway", role: .destructive) {
                    pendingForcedRevertPath = nil
                    revertFile(path, force: true)
                }
            }
            Button("Cancel", role: .cancel) { pendingForcedRevertPath = nil }
        } message: {
            Text("Restoring now discards content written after Juno's latest checkpoint.")
        }
        .alert(
            revertFailureTitle,
            isPresented: Binding(
                get: { revertFailureMessage != nil },
                set: { if !$0 { revertFailureMessage = nil } }
            )
        ) {
            Button("OK") { revertFailureMessage = nil }
        } message: {
            Text(revertFailureMessage ?? "The restore could not be completed.")
        }
    }

    private var changeSummary: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(systemImage: "arrow.triangle.2.circlepath", size: 14)
                .junoSecondaryInk()
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(PathDisplay.fileCount(controller.changes.count))
                    .junoRowLabel()
                Text("Select a file to review its diff in the main canvas")
                    .junoCaption()
                    .junoSecondaryInk()
            }
            Spacer(minLength: JunoSpace.tight)
            DiffStat(added: totalAdded, removed: totalRemoved)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(PathDisplay.fileCount(controller.changes.count)), \(totalAdded) added, \(totalRemoved) removed"
        )
    }

    private var footer: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) {
                summary
                Spacer(minLength: JunoSpace.snug)
                actions
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                summary
                HStack(spacing: JunoSpace.snug) {
                    Spacer(minLength: 0)
                    actions
                }
            }
        }
        .padding(JunoSpace.cozy)
    }

    private var summary: some View {
        HStack(spacing: JunoSpace.tight) {
            Text(PathDisplay.fileCount(controller.changes.count))
            DiffStat(added: totalAdded, removed: totalRemoved)
        }
        .junoCaption()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(PathDisplay.fileCount(controller.changes.count)), \(totalAdded) added, \(totalRemoved) removed"
        )
    }

    @ViewBuilder
    private var actions: some View {
        if revertingAll {
            ProgressView().controlSize(.small)
        }
        Button("Revert All") {
            confirmsRevertAll = true
        }
        .controlSize(.small)
        .disabled(revertingAll || !isEditable)
        .help(
            isEditable
                ? "Restore every changed file from its checkpoint"
                : "Ask and Plan sessions are read-only"
        )
        .accessibilityIdentifier("juno.code.changes.revert-all")

        Button("Keep All") {
            controller.acceptAll()
        }
        .controlSize(.small)
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .disabled(revertingAll)
        .help("Mark every change reviewed and keep it")
        .accessibilityIdentifier("juno.code.changes.keep-all")
    }

    private var isEditable: Bool {
        controller.session.configuration.behavior == .code
    }

    private var totalAdded: Int { controller.changes.reduce(0) { $0 + $1.linesAdded } }
    private var totalRemoved: Int { controller.changes.reduce(0) { $0 + $1.linesRemoved } }

    private func row(_ change: TrackedChange) -> some View {
        HStack(spacing: JunoSpace.snug) {
            ReviewStateGlyph(state: change.reviewState)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(PathDisplay.fileName(change.path))
                    .junoCode()
                    .lineLimit(1)
                Text(subtitle(change))
                    .font(.caption2)
                    .junoMetaInk()
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: JunoSpace.tight)
            DiffStat(added: change.linesAdded, removed: change.linesRemoved)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(change.path), \(change.kind.rawValue), \(change.linesAdded) added, \(change.linesRemoved) removed"
        )
        .accessibilityHint("Opens this file in the review")
        .contextMenu {
            Button("Show in Review") { review.present(path: change.path) }
            Button("Open File") { open(change) }
            Divider()
            Button("Keep") { controller.acceptChange(path: change.path) }
            Button("Revert", role: .destructive) {
                pendingRevertPath = change.path
            }
            .disabled(!isEditable)
        }
    }

    private func open(_ change: TrackedChange) {
        guard let path = try? WorkspacePath(change.path) else { return }
        Task { await review.open(path, using: controller) }
    }

    private func revertFile(_ path: String, force: Bool) {
        Task {
            let result = await review.revertFile(
                path,
                force: force,
                using: controller
            )
            switch result {
            case .restored:
                break
            case .diverged where !force:
                pendingForcedRevertPath = path
            case .diverged:
                revertFailureTitle = "Could Not Revert File"
                revertFailureMessage =
                    result.failureMessage ?? "The file still differs from its checkpoint."
            case let .failed(message):
                revertFailureTitle = "Could Not Revert File"
                revertFailureMessage = message
            }
        }
    }

    private func subtitle(_ change: TrackedChange) -> String {
        guard let directory = PathDisplay.directory(change.path) else {
            return change.kind.rawValue
        }
        return "\(change.kind.rawValue) · \(directory)"
    }
}
