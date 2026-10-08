import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// What the side panel shows.
public enum StudioPanelTab: String, CaseIterable, Identifiable, Sendable {
    case changes
    case terminal

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .changes: "Changes"
        case .terminal: "Terminal"
        }
    }
}

/// The panel beside the thread: the session's changes, and a terminal in its
/// folder. The old inspector had six panes behind a menu; review and a shell
/// are the two a reader reaches for while an agent works.
public struct StudioSidePanel: View {
    let controller: SessionController
    @Binding var tab: StudioPanelTab
    let createPullRequest: () -> Void
    let close: () -> Void
    /// Files whose diffs start open — for the product shots and fixtures; the
    /// app opens the panel with every file folded.
    var initiallyExpanded: Set<String> = []

    public init(
        controller: SessionController,
        tab: Binding<StudioPanelTab>,
        createPullRequest: @escaping () -> Void,
        close: @escaping () -> Void,
        initiallyExpanded: Set<String> = []
    ) {
        self.controller = controller
        self._tab = tab
        self.createPullRequest = createPullRequest
        self.close = close
        self.initiallyExpanded = initiallyExpanded
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                // Juno's segmented control, the same raised key the product
                // switch and every in-window filter use, with the change
                // count riding the Changes segment.
                JunoSegmented(
                    options: StudioPanelTab.allCases.map { option in
                        JunoSegmentedOption(
                            option,
                            option.title,
                            icon: option == .changes ? .fileDiff : .terminal,
                            count: option == .changes && !controller.changes.isEmpty ? controller.changes.count : nil
                        )
                    },
                    selection: $tab,
                    accessibilityLabel: "Panel",
                    optionAccessibilityIdentifier: { "juno.code.panel.tab.\($0.rawValue)" },
                    size: .compact
                )
                Spacer()
                Button(action: close) {
                    JunoIconView(.panelRight, size: 14)
                }
                .buttonStyle(StudioIconButtonStyle())
                .help("Close the panel (⌥⌘R)")
                .accessibilityLabel("Close panel")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 48)
            .studioHairline(.bottom)

            switch tab {
            case .changes:
                StudioChangesView(
                    controller: controller,
                    createPullRequest: createPullRequest,
                    initiallyExpanded: initiallyExpanded
                )
            case .terminal:
                StudioTerminalPane(controller: controller)
            }
        }
        .background(Studio.Surface.canvas)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.panel")
    }
}

// MARK: - Changes

/// The review of a session's changes (CODE_AGENT_SPEC §5.10): pick a scope,
/// click any line to leave a comment that rides on the next message, Keep
/// (stage) or Revert per hunk, per file or all, and read the reviewer's
/// findings on their lines.
struct StudioChangesView: View {
    let controller: SessionController
    let createPullRequest: () -> Void

    @State private var expanded: Set<String>

    init(controller: SessionController, createPullRequest: @escaping () -> Void, initiallyExpanded: Set<String> = []) {
        self.controller = controller
        self.createPullRequest = createPullRequest
        _expanded = State(initialValue: initiallyExpanded)
    }
    @State private var committing = false
    @State private var confirmRevertAll = false
    @State private var revertMessage: String?

    private var review: ReviewModel { controller.review }
    private var queue: ReviewQueueModel { controller.reviewQueue }
    private var preferences: StudioPreferences { .shared }

    private var totals: (added: Int, removed: Int) {
        controller.changes.reduce((0, 0)) { ($0.0 + $1.linesAdded, $0.1 + $1.linesRemoved) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if queue.scope == .session, controller.changes.isEmpty {
                scopeBar
                empty
            } else {
                header
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if queue.scope == .session {
                            ForEach(controller.changes) { change in
                                fileSection(change)
                            }
                        } else {
                            scopedSections
                        }
                    }
                    .padding(.bottom, JunoSpace.regular)
                }
            }
            if queue.hasComments {
                commentsBar
            }
        }
        .task(id: controller.changes.map { "\($0.path):\($0.linesAdded):\($0.linesRemoved)" }) {
            await review.load(from: controller)
            if let focused = review.consumeFocus() {
                expanded.insert(focused)
            } else if controller.changes.count <= 3 {
                expanded.formUnion(controller.changes.map(\.path))
            }
        }
        .onChange(of: review.focusedPath) { _, path in
            guard let path else { return }
            expanded.insert(path)
            _ = review.consumeFocus()
        }
        .sheet(isPresented: $committing) {
            StudioCommitSheet(controller: controller, createPullRequest: createPullRequest)
                .junoSheetSurface(.fitted)
        }
        .confirmationDialog(
            "Revert every change in this session?",
            isPresented: $confirmRevertAll
        ) {
            Button("Revert All", role: .destructive) {
                Task {
                    let result = await controller.rejectAll()
                    revertMessage = result.failureSummary
                    await review.load(from: controller)
                }
            }
        } message: {
            Text("Each file goes back to how it was before Alevr changed it. Files you edited since are left alone.")
        }
    }

    private var empty: some View {
        VStack(spacing: JunoSpace.snug) {
            Spacer()
            Text("No changes yet")
                .font(Studio.Font.labelEmphasis)
                .foregroundStyle(Studio.Ink.secondary)
            Text("Files Alevr edits in this session appear here to review.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity)
    }

    /// Which changes the review shows.
    private var scopeBar: some View {
        HStack(spacing: JunoSpace.snug) {
            Menu {
                Picker("Review", selection: Binding(
                    get: { queue.scope },
                    set: { scope in Task { await controller.loadReviewScope(scope) } }
                )) {
                    ForEach(ReviewScope.allCases) { scope in
                        Text(scope.title).tag(scope)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                StudioChipLabel(title: queue.scope.title)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .help("Which changes to review: this session's, everything uncommitted, what is staged, the branch, or the last turn")
            if queue.isLoadingScope {
                StudioSpinner().frame(width: 10, height: 10)
            }
            Spacer()
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.snug)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            scopeBar.padding(.horizontal, -JunoSpace.regular).padding(.top, -JunoSpace.snug)
            HStack(spacing: JunoSpace.snug) {
                if queue.scope == .session {
                    Text(StudioFormat.plural(controller.changes.count, "file") + " changed")
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                    StudioDiffStat(added: totals.added, removed: totals.removed)
                } else {
                    Text(StudioFormat.plural(queue.scopedFiles.count, "file") + " in \(queue.scope.title.lowercased())")
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                }
                Spacer()
                Menu {
                    Button("Expand All") { expanded = Set(allPaths) }
                    Button("Collapse All") { expanded = [] }
                    Divider()
                    Picker("Layout", selection: Binding(
                        get: { preferences.diffLayout },
                        set: { preferences.diffLayout = $0 }
                    )) {
                        ForEach(StudioDiffLayout.allCases) { Text($0.label).tag($0) }
                    }
                    Toggle("Wrap Lines", isOn: Binding(
                        get: { preferences.wrapLines },
                        set: { preferences.wrapLines = $0 }
                    ))
                    if queue.scope == .session {
                        Divider()
                        Button("Keep All Changes") { Task { await controller.keepAll() } }
                        Button("Revert All Changes…", role: .destructive) { confirmRevertAll = true }
                    }
                } label: {
                    JunoIconView(.ellipsis, size: 14)
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(StudioIconButtonStyle())
                .fixedSize()
                .accessibilityLabel("More")

                if controller.isGitRepository {
                    Button("Commit…") { committing = true }
                        .buttonStyle(StudioPrimaryButtonStyle())
                        .keyboardShortcut("k", modifiers: [.command, .option])
                        .help("Commit these changes (⌥⌘K)")
                }
            }
            if let branch = controller.gitStatus?.branch {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.branch, size: 12)
                    Text(branch).font(Studio.Font.mono)
                    if let ahead = controller.gitStatus?.ahead, ahead > 0 {
                        Text("\(ahead) ahead").font(Studio.Font.metaDigits)
                    }
                }
                .foregroundStyle(Studio.Ink.tertiary)
            }
            if let message = revertMessage ?? queue.message {
                Text(message)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .studioHairline(.bottom)
        .task { await controller.refreshWorkspacePanels() }
    }

    private var allPaths: [String] {
        queue.scope == .session ? controller.changes.map(\.path) : queue.scopedFiles.map(\.path)
    }

    private func lineReview(for path: String) -> StudioLineReview {
        let findings = ReviewFindingsProjection.findings(controller.inlineFindings, path: path)
        return StudioLineReview(
            path: path,
            comments: { line in
                queue.comments(for: path, line: line.anchorLine, isOldLine: line.isOldOnly)
            },
            findings: { line in
                guard let number = line.newLineNumber else { return [] }
                return findings.filter { $0.line == number }
            },
            addComment: { line, text in
                controller.queueLineComment(
                    path: path,
                    line: line.anchorLine,
                    isOldLine: line.isOldOnly,
                    quotedLine: line.text,
                    text: text
                )
            },
            sendAll: { Task { await controller.sendQueuedComments() } },
            removeComment: { queue.remove(id: $0) },
            fixFinding: { finding, line in controller.fixFinding(finding, quotedLine: line.text) },
            dismissFinding: { queue.dismiss($0) }
        )
    }

    private func fileSection(_ change: TrackedChange) -> some View {
        let isOpen = expanded.contains(change.path)
        let fileFindings = ReviewFindingsProjection.findings(controller.inlineFindings, path: change.path)
        return VStack(alignment: .leading, spacing: 0) {
            StudioFileRow(path: change.path, kind: change.kind, added: change.linesAdded, removed: change.linesRemoved, isOpen: isOpen) {
                if isOpen { expanded.remove(change.path) } else { expanded.insert(change.path) }
            } keep: {
                Task { await controller.keepFile(change.path) }
            } revert: {
                Task {
                    let result = await review.revertFile(change.path, using: controller)
                    revertMessage = result.failureMessage
                }
            } open: {
                guard let path = try? WorkspacePath(change.path) else { return }
                Task { await review.open(path, using: controller) }
            }
            if isOpen {
                if let diff = review.diffs[change.path] {
                    let unplaced = fileFindings.filter { finding in
                        guard let line = finding.line else { return true }
                        return !diff.hunks.contains { $0.lines.contains { $0.newLineNumber == line } }
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        ForEach(unplaced) { finding in
                            StudioFindingNote(finding: finding, fix: { controller.fixFinding(finding) }, dismiss: { queue.dismiss(finding) })
                        }
                        ForEach(Array(diff.hunks.enumerated()), id: \.element.reviewIdentifier) { index, hunk in
                            StudioHunkView(
                                hunk: hunk,
                                layout: preferences.diffLayout,
                                wraps: preferences.wrapLines,
                                isReverting: review.revertingHunkID == hunk.reviewIdentifier,
                                isKept: controller.isHunkKept(path: change.path, hunk: hunk),
                                failure: review.revertFailures[hunk.reviewIdentifier],
                                review: lineReview(for: change.path),
                                keep: { Task { await controller.keepHunk(path: change.path, hunk: hunk) } },
                                revert: {
                                    Task { await review.revertHunk(at: index, in: change.path, hunk: hunk, using: controller) }
                                }
                            )
                        }
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.cozy)
                } else if review.loadingPaths.contains(change.path) {
                    StudioSpinner().frame(width: 12, height: 12).padding(JunoSpace.regular)
                } else {
                    Text(change.kind == .deleted ? "This file was deleted." : "No text diff to show.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .padding(.horizontal, JunoSpace.regular)
                        .padding(.bottom, JunoSpace.cozy)
                }
            }
        }
        .studioHairline(.bottom)
    }

    /// A scope other than the session's own: Git's view, or the last turn's.
    /// Keep stages; there is no checkpoint here to revert to.
    @ViewBuilder
    private var scopedSections: some View {
        if queue.scopedFiles.isEmpty, !queue.isLoadingScope {
            Text("Nothing in \(queue.scope.title.lowercased()).")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .padding(JunoSpace.regular)
        }
        ForEach(queue.scopedFiles) { file in
            let isOpen = expanded.contains(file.path)
            VStack(alignment: .leading, spacing: 0) {
                StudioFileRow(
                    path: file.path,
                    kind: Self.kind(file.status),
                    added: file.diff.linesAdded,
                    removed: file.diff.linesRemoved,
                    isOpen: isOpen,
                    toggle: {
                        if isOpen { expanded.remove(file.path) } else { expanded.insert(file.path) }
                    },
                    keep: queue.scope == .staged ? nil : {
                        Task {
                            _ = await controller.keepFile(file.path)
                            await controller.loadReviewScope(queue.scope)
                        }
                    },
                    revert: nil,
                    open: {
                        guard let path = try? WorkspacePath(file.path) else { return }
                        Task { await review.open(path, using: controller) }
                    }
                )
                if isOpen {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        ForEach(file.diff.hunks, id: \.reviewIdentifier) { hunk in
                            StudioHunkView(
                                hunk: hunk,
                                layout: preferences.diffLayout,
                                wraps: preferences.wrapLines,
                                isReverting: false,
                                isKept: controller.isHunkKept(path: file.path, hunk: hunk),
                                failure: nil,
                                review: lineReview(for: file.path),
                                keep: queue.scope == .staged ? nil : {
                                    Task { await controller.keepHunk(path: file.path, hunk: hunk) }
                                },
                                revert: nil
                            )
                        }
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.cozy)
                }
            }
            .studioHairline(.bottom)
        }
    }

    static func kind(_ status: String) -> FileChangeKind {
        switch status {
        case "A", "?": .created
        case "D": .deleted
        case "R": .moved
        default: .modified
        }
    }

    private var commentsBar: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(StudioFormat.plural(queue.comments.count, "comment") + " queued for your next message")
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(1)
            Button("Discard") { queue.discardAll() }
                .buttonStyle(StudioQuietButtonStyle())
                .contentShape(.rect)
            Spacer()
            Button("Send now") {
                Task { await controller.sendQueuedComments() }
            }
            .buttonStyle(StudioPrimaryButtonStyle())
            .contentShape(Capsule())
            .keyboardShortcut(.return, modifiers: [.command])
            .help("Send the comments as their own message now (⌘↩). Your draft stays where it is.")
        }
        .padding(.horizontal, JunoSpace.regular)
        .frame(height: 52)
        .studioHairline(.top)
    }
}

/// What a hunk's lines need to take and show comments and findings.
struct StudioLineReview {
    let path: String
    let comments: (DiffLine) -> [QueuedReviewComment]
    let findings: (DiffLine) -> [InlineFinding]
    let addComment: (DiffLine, String) -> Void
    let sendAll: () -> Void
    let removeComment: (UUID) -> Void
    let fixFinding: (InlineFinding, DiffLine) -> Void
    let dismissFinding: (InlineFinding) -> Void
}

extension DiffLine {
    /// The line a comment on it names: the new file's, or the old file's for
    /// a removed line.
    var anchorLine: Int? { newLineNumber ?? oldLineNumber }
    var isOldOnly: Bool { newLineNumber == nil }
    var reviewKey: String { "\(oldLineNumber ?? -1):\(newLineNumber ?? -1)" }
}

/// One changed file: its kind, its name, its size of change.
struct StudioFileRow: View {
    let path: String
    let kind: FileChangeKind
    let added: Int
    let removed: Int
    let isOpen: Bool
    let toggle: () -> Void
    let keep: (() -> Void)?
    let revert: (() -> Void)?
    let open: () -> Void

    @State private var hovering = false

    private var name: String { (path as NSString).lastPathComponent }
    private var folder: String {
        let parent = (path as NSString).deletingLastPathComponent
        return parent.isEmpty ? "" : parent + "/"
    }

    private var kindMark: (String, Color) {
        switch kind {
        case .created: ("A", Studio.Ink.added)
        case .modified: ("M", Studio.Ink.secondary)
        case .deleted: ("D", Studio.Ink.removed)
        case .moved: ("R", Studio.Ink.secondary)
        }
    }

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.chevronRight, size: 10)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                Text(kindMark.0)
                    .font(Studio.Font.caption.monospaced())
                    .foregroundStyle(kindMark.1)
                    .frame(width: 12)
                // The name always reads whole; the folder is what gives way.
                Text(name)
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                    .layoutPriority(1)
                if !folder.isEmpty {
                    Text(folder)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: JunoSpace.snug)
                if hovering {
                    Button(action: open) { JunoIconView(.fileCode, size: 13) }
                        .buttonStyle(StudioIconButtonStyle())
                        .help("Open the file")
                    if let keep {
                        Button("Keep", action: keep)
                            .buttonStyle(StudioQuietButtonStyle())
                            .contentShape(.rect)
                            .font(Studio.Font.meta)
                            .help("Keep this file: stage it and mark it reviewed")
                    }
                    if let revert {
                        Button(action: revert) { JunoIconView(.undo, size: 13) }
                            .buttonStyle(StudioIconButtonStyle())
                            .help("Revert this file")
                    }
                }
                StudioDiffStat(added: added, removed: removed)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 34)
            .background(hovering ? Studio.Surface.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Open File", action: open)
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(path, forType: .string)
            }
            if let keep {
                Divider()
                Button("Keep File", action: keep)
            }
            if let revert {
                Button("Revert File", role: .destructive, action: revert)
            }
        }
    }
}

// MARK: - Hunks

/// One hunk of a diff, unified or side by side, with Keep and Revert, and
/// line comments and findings under their lines.
struct StudioHunkView: View {
    let hunk: DiffHunk
    let layout: StudioDiffLayout
    let wraps: Bool
    let isReverting: Bool
    var isKept = false
    let failure: String?
    let review: StudioLineReview?
    let keep: (() -> Void)?
    let revert: (() -> Void)?

    @State private var hovering = false
    @State private var editingLine: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Text(hunk.header)
                    .font(Studio.Font.monoSmall)
                    .foregroundStyle(Studio.Ink.tertiary)
                if isKept {
                    Text("Kept")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                }
                Spacer()
                if hovering || isReverting {
                    if let keep, !isKept {
                        Button("Keep", action: keep)
                            .buttonStyle(StudioQuietButtonStyle())
                            .contentShape(.rect)
                            .font(Studio.Font.meta)
                            .help("Keep this change: stage exactly this hunk")
                    }
                    if let revert {
                        Button(isReverting ? "Reverting…" : "Revert", action: revert)
                            .buttonStyle(StudioQuietButtonStyle())
                            .contentShape(.rect)
                            .font(Studio.Font.meta)
                            .disabled(isReverting)
                    }
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 26)
            .background(Studio.Surface.muted.opacity(0.6))

            Group {
                if layout == .split {
                    splitBody
                } else {
                    unifiedBody
                }
            }
            if let failure {
                Text(failure)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
                    .padding(JunoSpace.snug)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
        .onHover { hovering = $0 }
    }

    @ViewBuilder
    private var unifiedBody: some View {
        let content = VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                StudioDiffLineRow(line: line, wraps: wraps, onTap: review == nil ? nil : { editingLine = line.reviewKey })
                annotations(for: line)
            }
        }
        if wraps {
            content
        } else {
            ScrollView(.horizontal, showsIndicators: false) { content }
        }
    }

    /// Removed lines on the left, added on the right, context on both, paired
    /// in order within each run of changes.
    private var splitBody: some View {
        let rows = Self.pair(hunk.lines)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 0) {
                    StudioDiffLineRow(line: row.left, wraps: true, showsNewNumber: false, onTap: tapAction(row.left))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Studio.Surface.hairline).frame(width: 1)
                    StudioDiffLineRow(line: row.right, wraps: true, showsOldNumber: false, onTap: tapAction(row.right))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let left = row.left, left.kind == .removed { annotations(for: left) }
                if let right = row.right { annotations(for: right) }
            }
        }
    }

    private func tapAction(_ line: DiffLine?) -> (() -> Void)? {
        guard review != nil, let line else { return nil }
        return { editingLine = line.reviewKey }
    }

    /// The comments, findings and comment field under one line.
    @ViewBuilder
    private func annotations(for line: DiffLine) -> some View {
        if let review {
            ForEach(review.findings(line)) { finding in
                StudioFindingNote(
                    finding: finding,
                    fix: { review.fixFinding(finding, line) },
                    dismiss: { review.dismissFinding(finding) }
                )
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.hairline)
            }
            ForEach(review.comments(line)) { comment in
                StudioQueuedCommentNote(comment: comment, remove: { review.removeComment(comment.id) })
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, JunoSpace.hairline)
            }
            if editingLine == line.reviewKey {
                StudioLineCommentField(
                    location: line.anchorLine.map { "\(review.path):\($0)" } ?? review.path,
                    add: { text in
                        review.addComment(line, text)
                        editingLine = nil
                    },
                    sendAll: { text in
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            review.addComment(line, text)
                        }
                        editingLine = nil
                        review.sendAll()
                    },
                    cancel: { editingLine = nil }
                )
                .padding(JunoSpace.snug)
            }
        }
    }

    static func pair(_ lines: [DiffLine]) -> [(left: DiffLine?, right: DiffLine?)] {
        var rows: [(left: DiffLine?, right: DiffLine?)] = []
        var removed: [DiffLine] = []
        var added: [DiffLine] = []
        func flush() {
            for index in 0..<max(removed.count, added.count) {
                rows.append((index < removed.count ? removed[index] : nil, index < added.count ? added[index] : nil))
            }
            removed = []
            added = []
        }
        for line in lines {
            switch line.kind {
            case .removed: removed.append(line)
            case .added: added.append(line)
            case .context:
                flush()
                rows.append((line, line))
            }
        }
        flush()
        return rows
    }
}

struct StudioDiffLineRow: View {
    let line: DiffLine?
    var wraps: Bool
    var showsOldNumber = true
    var showsNewNumber = true
    /// Click to comment on this line, where the surface takes comments.
    var onTap: (() -> Void)?

    @State private var hovering = false

    private var tint: Color {
        switch line?.kind {
        case .added: Color.junoDiffAdded
        case .removed: Color.junoDiffRemoved
        default: Color.clear
        }
    }

    private var sign: String {
        switch line?.kind {
        case .added: "+"
        case .removed: "−"
        default: " "
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            if showsOldNumber {
                gutter(line?.oldLineNumber)
            }
            if showsNewNumber {
                gutter(line?.newLineNumber)
            }
            Text(sign)
                .foregroundStyle(Studio.Ink.tertiary)
                .frame(width: 14)
            Text(line?.text ?? "")
                .foregroundStyle(Studio.Ink.primary)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: !wraps, vertical: false)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .font(Studio.Font.mono)
        .padding(.vertical, 1)
        .padding(.trailing, JunoSpace.snug)
        .background(tint)
        .background(hovering && onTap != nil ? Studio.Surface.hover : Color.clear)
        .frame(minHeight: 18)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            onTap?()
        }
        .help(onTap == nil ? "" : "Click to comment on this line")
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(Studio.Font.monoSmall)
            .foregroundStyle(Studio.Ink.tertiary)
            .frame(width: 34, alignment: .trailing)
            .padding(.trailing, JunoSpace.tight)
    }
}

/// The comment field under a line: Return adds the comment to the queue,
/// ⌘Return sends every queued comment now, Escape closes it.
struct StudioLineCommentField: View {
    let location: String
    let add: (String) -> Void
    let sendAll: (String) -> Void
    let cancel: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("Comment on \(location)")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            TextField("What should change here?", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Studio.Font.label)
                .lineLimit(1...6)
                .focused($focused)
                .padding(JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                        .fill(Studio.Surface.raised)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                        .strokeBorder(Studio.Surface.hairline)
                )
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.command) {
                        sendAll(text)
                        return .handled
                    }
                    if press.modifiers.contains(.shift) { return .ignored }
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .handled }
                    add(text)
                    return .handled
                }
                .onKeyPress(.escape) {
                    cancel()
                    return .handled
                }
            Text("Return adds it to your next message · ⌘Return sends all now")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
        }
        .onAppear { focused = true }
    }
}

/// A comment waiting for the next message, under its line.
struct StudioQueuedCommentNote: View {
    let comment: QueuedReviewComment
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text("Your comment")
                .font(Studio.Font.metaEmphasis)
                .foregroundStyle(Studio.Ink.secondary)
            Text(comment.text)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            Button("Remove", action: remove)
                .buttonStyle(StudioQuietButtonStyle())
                .contentShape(.rect)
                .font(Studio.Font.meta)
        }
        .padding(JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                .fill(Studio.Surface.muted)
        )
    }
}

/// A reviewer finding under its line: its priority in words, never a badge.
struct StudioFindingNote: View {
    let finding: InlineFinding
    let fix: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline + 1) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Review: \(finding.words)")
                    .font(Studio.Font.metaEmphasis)
                    .foregroundStyle(finding.priority.isBlocking ? Studio.Ink.danger : Studio.Ink.secondary)
                Spacer(minLength: JunoSpace.snug)
                Button("Fix this", action: fix)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    .contentShape(.rect)
                    .font(Studio.Font.meta)
                    .help("Queue this finding as a comment for your next message")
                Button("Dismiss", action: dismiss)
                    .buttonStyle(StudioQuietButtonStyle())
                    .contentShape(.rect)
                    .font(Studio.Font.meta)
            }
            Text(finding.title)
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            if !finding.body.isEmpty {
                Text(finding.body)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                .fill(Studio.Surface.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }
}

/// Commit, and optionally push or open a pull request, in one sheet.
struct StudioCommitSheet: View {
    let controller: SessionController
    let createPullRequest: () -> Void

    @State private var message = ""
    @State private var isWorking = false
    @State private var error: String?
    @State private var pushPlan: GitPushPlan?
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var canCommit: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isWorking
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Commit changes")
                .font(Studio.Font.title)
            Text(
                "\(StudioFormat.plural(controller.changes.count, "file")) on \(controller.gitStatus?.branch ?? "the current branch")"
            )
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.tertiary)
            TextField("Commit message", text: $message, axis: .vertical)
                .textFieldStyle(.plain)
                .studioReadingFont()
                .lineLimit(2...8)
                .focused($focused)
                .padding(JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                        .strokeBorder(Studio.Surface.hairline)
                )
            if let pushPlan {
                Text("Pushes to \(pushPlan.displayTarget)\(pushPlan.setsUpstream ? " and sets it as upstream" : "").")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
            }
            if let error {
                Text(error).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
            }
            HStack(spacing: JunoSpace.snug) {
                if controller.pullRequestUnavailableReason == nil {
                    Button("Create Pull Request…") {
                        dismiss()
                        createPullRequest()
                    }
                    .buttonStyle(StudioQuietButtonStyle())
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button("Commit and Push") { Task { await commit(push: true) } }
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .disabled(!canCommit || pushPlan == nil)
                Button("Commit") { Task { await commit(push: false) } }
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCommit)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 520)
        .task {
            focused = true
            pushPlan = await controller.prepareGitPush()
        }
    }

    private func commit(push: Bool) async {
        isWorking = true
        defer { isWorking = false }
        error = nil
        guard await controller.commit(message: message) else {
            error = controller.transientError ?? "The commit did not go through."
            return
        }
        if push {
            guard let plan = await controller.prepareGitPush(),
                  await controller.publishGitBranch(plan)
            else {
                error = controller.transientError ?? "Committed, but the push did not go through."
                return
            }
        }
        dismiss()
    }
}

// MARK: - Terminal

/// A shell in the session's folder. The reader's, not the agent's: nothing
/// typed here is shown to the model or asks for approval.
struct StudioTerminalPane: View {
    let controller: SessionController

    @State private var input = ""
    @FocusState private var focused: Bool

    private var isRunning: Bool { controller.interactiveTerminalState.isRunning }

    var body: some View {
        VStack(spacing: 0) {
            if let reason = controller.interactiveTerminalUnavailableReason {
                VStack(spacing: JunoSpace.snug) {
                    Spacer()
                    Text(reason)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .multilineTextAlignment(.center)
                    Spacer()
                }
                .padding(JunoSpace.section)
                .frame(maxWidth: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(controller.interactiveTerminal) { line in
                                Text(line.text)
                                    .font(Studio.Font.mono)
                                    .foregroundStyle(line.channel == .stderr ? Studio.Ink.danger : Studio.Ink.primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(line.id)
                            }
                        }
                        .padding(JunoSpace.cozy)
                    }
                    .onChange(of: controller.interactiveTerminal.last?.id) { _, id in
                        if let id { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
                HStack(spacing: JunoSpace.snug) {
                    Text(isRunning ? ">" : "$")
                        .font(Studio.Font.mono)
                        .foregroundStyle(Studio.Ink.tertiary)
                    TextField(isRunning ? "Input" : "Run a command", text: $input)
                        .textFieldStyle(.plain)
                        .font(Studio.Font.mono)
                        .focused($focused)
                        .onSubmit(submit)
                    if isRunning {
                        Button("Stop") { Task { await controller.stopInteractiveTerminal() } }
                            .buttonStyle(StudioQuietButtonStyle())
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 40)
                .studioHairline(.top)
            }
        }
        .background(Studio.Surface.canvas)
        .onAppear { focused = true }
    }

    private func submit() {
        let text = input
        input = ""
        Task {
            if isRunning {
                await controller.writeInteractiveTerminal(text)
            } else if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                await controller.startInteractiveTerminal(text)
            }
        }
    }
}

// MARK: - Documents

/// A file opened from the changes list, in the workspace editor. Presented by
/// the host as a sheet, because the host owns the window.
public struct StudioDocumentSheet: View {
    let controller: SessionController

    public init(controller: SessionController) {
        self.controller = controller
    }

    public var body: some View {
        if let document = controller.review.openDocument {
            WorkspaceDocumentEditor(
                controller: controller,
                document: document,
                onClose: { controller.review.closeDocument() },
                onChange: { controller.review.openDocument = $0 }
            )
        }
    }
}
