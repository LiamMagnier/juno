import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The six things the inspector is *for*.
///
/// The pane's width decides what can honestly live in it: lists can, editors and
/// viewports cannot. So the inspector keeps exactly the list-shaped concerns and
/// nothing else. The diff moved to the review canvas, machine output to the
/// console drawer, the preview to its own window and the file tree to Open
/// Quickly — each because it needs a width or a lifetime a 320pt trailing column
/// cannot give it.
///
/// Sub-agents earned a segment of their own rather than staying a section of
/// Activity. A delegated run is several concurrent agents with their own names,
/// states and durations; folded under a heading between "what tool is running"
/// and the screen-capture controls, the one surface that answers "what is
/// happening in parallel right now" was three scroll positions from the top of a
/// pane the reader had no reason to open.
public enum CodeInspectorPane: String, CaseIterable, Identifiable, Sendable {
    case environment
    case changes
    case activity
    case subagents
    case preview
    case repository

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .environment: "Environment"
        case .changes: "Changes"
        case .activity: "Activity"
        case .subagents: "Sub-agents"
        case .preview: "Preview"
        case .repository: "Repository"
        }
    }

    /// What the segmented control says.
    ///
    /// Shorter than ``label`` because a fourth segment costs every other one
    /// about 20pt: at the inspector's 260pt minimum a segment has roughly 55pt
    /// of text to work with, and a picker whose labels truncate to "Reposi…" is
    /// worse than one that abbreviates on purpose. The full names stay on the
    /// tooltip and the accessibility label.
    public var segmentLabel: String {
        switch self {
        case .environment: "Environment"
        case .changes: "Changes"
        case .activity: "Activity"
        case .subagents: "Agents"
        case .preview: "Preview"
        case .repository: "Repo"
        }
    }

    public var symbol: String {
        switch self {
        case .environment: "externaldrive"
        case .changes: "arrow.triangle.2.circlepath"
        case .activity: "waveform.path.ecg"
        case .subagents: "person.2"
        case .preview: "rectangle.on.rectangle"
        case .repository: "arrow.triangle.branch"
        }
    }

    public var purpose: String {
        switch self {
        case .environment: "Working tree, branch, changes and sources for this task"
        case .changes: "Files this session changed, and the way into the review"
        // Screen control lives here, so the help names it: a reader looking for
        // the kill switch should not have to open three panes to find it.
        case .activity: "What the run is doing, and its screen control"
        case .subagents: "Every sub-agent this session delegated, running and finished"
        case .preview: "Open the live workspace preview"
        case .repository: "Branch, working tree, commits and pull request"
        }
    }
}

/// The trailing inspector.
///
/// Labelled segments instead of nine glyph tabs behind an overflow menu. Nothing
/// here paints its own background: an inspector is a vibrant region on macOS,
/// and filling it turns a native pane into a grey slab.
public struct InspectorView: View {
    @Bindable private var controller: SessionController
    private let openPreview: (() -> Void)?
    private let openSources: (() -> Void)?
    private let openWorkspace: (() -> Void)?
    @SceneStorage("juno.code.inspector.pane.v2") private var storedPane =
        CodeInspectorPane.environment.rawValue

    public init(
        controller: SessionController,
        openPreview: (() -> Void)? = nil,
        openSources: (() -> Void)? = nil,
        openWorkspace: (() -> Void)? = nil
    ) {
        self.controller = controller
        self.openPreview = openPreview
        self.openSources = openSources
        self.openWorkspace = openWorkspace
    }

    /// The session's own review — the same object the canvas renders.
    ///
    /// This used to be `@Environment(ReviewModel.self) ?? localReview`, waiting
    /// for a window that never injected anything: no `.environment(ReviewModel…)`
    /// exists anywhere in the app or the package, so the fallback was always the
    /// one taken. The inspector therefore drove a `@State` model nobody rendered,
    /// and the Changes tab's whole purpose — its own subtitle calls it "the way
    /// into the review" — silently did nothing. Clicking a changed file loaded a
    /// diff into a throwaway.
    ///
    /// Reading `controller.review` removes the indirection rather than adding the
    /// missing injection: there is exactly one review per session, the controller
    /// already owns it (`SessionController.review`), and `CodeSessionSurface`
    /// hands that same instance to `ReviewCanvasView`. An environment hop could
    /// only reintroduce the possibility of the two disagreeing.
    private var review: ReviewModel { controller.review }

    private var pane: Binding<CodeInspectorPane> {
        Binding(
            get: { CodeInspectorPane(rawValue: storedPane) ?? .environment },
            set: { storedPane = $0.rawValue }
        )
    }

    private func segmentLabel(for candidate: CodeInspectorPane) -> String {
        guard candidate == .subagents, !controller.subagents.isEmpty else {
            return candidate.segmentLabel
        }
        return "\(candidate.segmentLabel) \(controller.subagents.count)"
    }

    private var paneAccessibilityValue: String {
        guard pane.wrappedValue == .subagents else { return pane.wrappedValue.label }
        let active = controller.subagents.filter(\.isActive).count
        let done = controller.subagents.count - active
        return "\(active) active, \(done) done"
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Text(pane.wrappedValue.label)
                    .font(.headline)
                Spacer(minLength: 0)
                Menu {
                    Section("Inspect") {
                        ForEach(CodeInspectorPane.allCases) { candidate in
                            Button {
                                pane.wrappedValue = candidate
                            } label: {
                                HStack {
                                    JunoIconView(systemImage: candidate.symbol, size: 14)
                                    Text(segmentLabel(for: candidate))
                                    Spacer(minLength: JunoSpace.regular)
                                    if pane.wrappedValue == candidate {
                                        JunoIconView(.check, size: 13)
                                    }
                                }
                            }
                        }
                    }
                } label: {
                    JunoIconView(.ellipsis, size: 15)
                        .frame(width: 30, height: 30)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Circle())
                }
                .menuStyle(.borderlessButton)
                .help("Choose inspector pane")
                .accessibilityLabel("Inspector pane")
                .accessibilityValue(paneAccessibilityValue)
                .accessibilityIdentifier("juno.code.inspector.pane")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .help(pane.wrappedValue.purpose)

            Divider().overlay(Color.junoSeparator)

            // The content must fill the pane: a segment whose body does not
            // expand would otherwise shrink the stack and drag the picker into
            // the middle of the column.
            Group {
                switch pane.wrappedValue {
                case .environment:
                    EnvironmentTab(
                        controller: controller,
                        review: review,
                        openSources: openSources,
                        openWorkspace: openWorkspace
                    )
                case .changes:
                    ChangesTab(controller: controller, review: review)
                case .activity:
                    ActivityTab(controller: controller)
                case .subagents:
                    SubagentPane(controller: controller)
                case .preview:
                    PreviewTab(controller: controller, openPreview: openPreview)
                case .repository:
                    RepositoryTab(controller: controller)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .inspectorColumnWidth(
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
        )
        .task(id: controller.sessionID) {
            #if DEBUG
            let arguments = CommandLine.arguments
            if let flag = arguments.firstIndex(of: "--juno-preview-inspector-pane"),
               arguments.indices.contains(arguments.index(after: flag)),
               let requested = CodeInspectorPane(
                   rawValue: arguments[arguments.index(after: flag)]
               )
            {
                storedPane = requested.rawValue
            }
            #endif
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
                        row(change)
                            // Pinned inside the row, where it outranks the
                            // emphasis style the selected row pushes in. White
                            // ink on the pale selection fill below would be
                            // invisible.
                            .junoSidebarRowInk()
                            .tag(change.path)
                    }
                    .listStyle(.inset)
                    // macOS paints a focused list selection in the *app's*
                    // accent, and Juno's accent asset is coral — so choosing a
                    // changed file lit a full-width saturated orange bar inside
                    // Juno Code's inspector. The web spends coral on one primary
                    // action and never on a whole row; its selected row is
                    // `--sidebar-accent`, a warm grey barely a step off the
                    // surface, which is exactly what this tint installs.
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

// MARK: - Preview

/// The compact entry point for the same preview window available from the
/// session-tools menu. The inspector is where the reader looks while reviewing
/// a run, so preview should not require remembering a keyboard shortcut first.
struct PreviewTab: View {
    @Bindable var controller: SessionController
    let openPreview: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                JunoIconLabel("Live preview", icon: .artifactsTool)
                    .font(.headline)
                Text("Open the workspace preview beside the Code session. It uses the current project files and refreshes as the agent changes them.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let root = controller.context?.access.rootURL {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(systemImage: "folder")
                        .junoSecondaryInk()
                    Text(root.lastPathComponent.isEmpty ? root.path : root.lastPathComponent)
                        .junoCode()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Preview workspace \(root.path)")

                Button("Open Preview", action: { openPreview?() })
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(openPreview == nil)
                    .accessibilityIdentifier("juno.code.preview.open")
            } else {
                JunoEmptyState(
                    title: "No workspace",
                    message: "Open a local Code session to preview its project.",
                    symbol: "folder.badge.questionmark"
                )
            }

            Spacer(minLength: 0)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
