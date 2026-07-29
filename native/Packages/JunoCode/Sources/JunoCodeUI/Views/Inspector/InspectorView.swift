import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The three things the inspector is *for*.
///
/// The pane's width decides what can honestly live in it: lists can, editors and
/// viewports cannot. So the inspector keeps exactly the three list-shaped
/// concerns and nothing else. The diff moved to the review canvas, machine
/// output to the console drawer, the preview to its own window and the file tree
/// to Open Quickly — each because it needs a width or a lifetime a 320pt trailing
/// column cannot give it.
public enum CodeInspectorPane: String, CaseIterable, Identifiable, Sendable {
    case changes
    case activity
    case repository

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .changes: "Changes"
        case .activity: "Activity"
        case .repository: "Repository"
        }
    }

    public var purpose: String {
        switch self {
        case .changes: "Files this session changed, and the way into the review"
        // Screen control lives here, so the help names it: a reader looking for
        // the kill switch should not have to open three panes to find it.
        case .activity: "What the run is doing, what it delegated, and its screen control"
        case .repository: "Branch, working tree, commits and pull request"
        }
    }
}

/// The trailing inspector.
///
/// Three labelled segments instead of nine glyph tabs behind an overflow menu.
/// Nothing here paints its own background: an inspector is a vibrant region on
/// macOS, and filling it turns a native pane into a grey slab.
public struct InspectorView: View {
    @Bindable private var controller: SessionController
    /// The window injects the review it owns, so choosing a file here and reading
    /// it in the detail column are the same review. Without an injected one the
    /// inspector still works — it just cannot drive the canvas.
    @Environment(ReviewModel.self) private var sharedReview: ReviewModel?
    @State private var localReview = ReviewModel()
    @SceneStorage("juno.code.inspector.pane") private var storedPane =
        CodeInspectorPane.changes.rawValue

    public init(controller: SessionController) {
        self.controller = controller
    }

    private var review: ReviewModel { sharedReview ?? localReview }

    private var pane: Binding<CodeInspectorPane> {
        Binding(
            get: { CodeInspectorPane(rawValue: storedPane) ?? .changes },
            set: { storedPane = $0.rawValue }
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector pane", selection: pane) {
                ForEach(CodeInspectorPane.allCases) { candidate in
                    Text(candidate.label).tag(candidate)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .help(pane.wrappedValue.purpose)
            .accessibilityIdentifier("juno.code.inspector.pane")

            Divider().overlay(Color.junoSeparator)

            // The content must fill the pane: a segment whose body does not
            // expand would otherwise shrink the stack and drag the picker into
            // the middle of the column.
            Group {
                switch pane.wrappedValue {
                case .changes:
                    ChangesTab(controller: controller, review: review)
                case .activity:
                    ActivityTab(controller: controller)
                case .repository:
                    RepositoryTab(controller: controller)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .inspectorColumnWidth(
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
        )
        .task(id: controller.sessionID) {
            await controller.refreshWorkspacePanels()
        }
    }
}

// MARK: - Changes

/// The index into the review: which files changed, by how much, and what has
/// been dealt with. A list, which is the only shape that stays honest at
/// inspector width.
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
                // One honest empty state. Never placeholder rows behind it: a grid of
                // grey rectangles under the words "no changes" claims content that
                // does not exist.
                JunoEmptyState(
                    title: "No changes yet",
                    message: "Files Juno edits appear here, with the diff one click away.",
                    symbol: "plusminus.circle"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    List(controller.changes, selection: $selection) { change in
                        row(change).tag(change.path)
                    }
                    .listStyle(.inset)
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

    private var footer: some View {
        // Wraps at narrow inspector widths rather than clipping the buttons off
        // the trailing edge.
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
                // The filename stays whole; only the directory truncates, and
                // from the head, so the innermost folder stays readable.
                Text(PathDisplay.fileName(change.path))
                    .junoCode()
                    .lineLimit(1)
                Text(subtitle(change))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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

    /// Opens the file itself rather than its diff, in the same canvas. Git can
    /// report paths a `WorkspacePath` will not accept — a rename reads as
    /// "old -> new" — so a path that does not resolve simply cannot be opened.
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
                // Only a fingerprint mismatch earns an explicit overwrite
                // choice. Missing checkpoints and I/O failures remain errors.
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

    /// "modified · Sources/JunoCodeUI/Views" — the state and where it lives.
    private func subtitle(_ change: TrackedChange) -> String {
        guard let directory = PathDisplay.directory(change.path) else {
            return change.kind.rawValue
        }
        return "\(change.kind.rawValue) · \(directory)"
    }
}
