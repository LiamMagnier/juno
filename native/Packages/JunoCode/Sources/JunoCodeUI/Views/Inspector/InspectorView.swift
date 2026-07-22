import SwiftUI
import JunoCodeCore
import JunoDesignSystem

enum InspectorTab: String, CaseIterable, Identifiable {
    case changes
    case diff
    case terminal
    case tests
    case git
    case files
    case context
    case computer

    var id: String { rawValue }

    var label: String {
        switch self {
        case .changes: return "Changes"
        case .diff: return "Diff"
        case .terminal: return "Terminal"
        case .tests: return "Tests"
        case .git: return "Git"
        case .files: return "Files"
        case .context: return "Context"
        case .computer: return "Computer"
        }
    }

    var systemImage: String {
        switch self {
        case .changes: return "plusminus.circle"
        case .diff: return "text.line.first.and.arrowtriangle.forward"
        case .terminal: return "terminal"
        case .tests: return "checkmark.seal"
        case .git: return "arrow.triangle.branch"
        case .files: return "folder"
        case .context: return "doc.text.magnifyingglass"
        case .computer: return "display"
        }
    }

    /// What this pane is for, in one line, for the tooltip and for VoiceOver.
    var purpose: String {
        switch self {
        case .changes: return "Files the agent edited, with accept and reject"
        case .diff: return "Line-by-line diff of one changed file"
        case .terminal: return "Live command and test output"
        case .tests: return "Detected test commands and the last run"
        case .git: return "Branch, working tree status and recent commits"
        case .files: return "Browse and filter the workspace"
        case .context: return "What the agent knows about this session"
        case .computer: return "Screen control (off)"
        }
    }

    /// The four panes a reader opens the inspector *for*. The rest stay
    /// reachable but do not get scarce horizontal room at 260pt.
    static let primary: [InspectorTab] = [.changes, .diff, .terminal, .tests]
    static let secondary: [InspectorTab] = [.git, .files, .context, .computer]
}

/// Right zone: the inspector.
///
/// The tab strip was eight unlabelled 20pt glyphs in a segmented control — at
/// 260pt each segment was 32pt wide, nothing said what any of them meant, and
/// `display` versus `doc.text.magnifyingglass` is not a distinction anyone makes
/// at that size. It is now four labelled primary tabs plus an overflow menu that
/// names the other four, so every destination in the pane is readable.
struct InspectorView: View {
    @Bindable var controller: SessionController
    @State private var tab: InspectorTab = .changes
    @State private var selectedDiffPath: String?
    @State private var showsLabels = true

    var body: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider().overlay(Color.junoSeparator)

            // The tab content must fill the pane. Without this, a tab whose
            // body does not expand (any ContentUnavailableView empty state)
            // shrinks the whole VStack and SwiftUI centres it vertically,
            // dragging the tab picker into the middle of the inspector.
            Group {
                switch tab {
                case .changes:
                    ChangesTab(
                        controller: controller,
                        openDiff: { path in
                            selectedDiffPath = path
                            tab = .diff
                        }
                    )
                case .diff:
                    DiffTab(controller: controller, selectedPath: $selectedDiffPath)
                case .terminal:
                    TerminalTab(controller: controller)
                case .tests:
                    TestsTab(controller: controller)
                case .git:
                    GitTab(controller: controller)
                case .files:
                    FilesTab(controller: controller)
                case .context:
                    ContextTab(controller: controller)
                case .computer:
                    ComputerTab()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.junoRaised)
        .task(id: controller.sessionID) {
            await controller.refreshWorkspacePanels()
        }
    }

    // MARK: - Tab strip

    /// Below this the four labels no longer fit beside the overflow menu, so the
    /// strip falls back to glyphs with tooltips. Measured rather than guessed:
    /// "Terminal" + "Changes" + "Diff" + "Tests" at `.caption` with their glyphs
    /// and padding comes to roughly 300pt, and the inspector's own minimum is
    /// 260pt.
    private static let labelledStripMinimumWidth: CGFloat = 330

    private var tabStrip: some View {
        HStack(spacing: JunoSpace.hairline) {
            ForEach(InspectorTab.primary) { candidate in
                tabButton(candidate, badge: badge(for: candidate))
            }

            Spacer(minLength: 0)

            Menu {
                ForEach(InspectorTab.secondary) { candidate in
                    Button {
                        tab = candidate
                    } label: {
                        Label(candidate.label, systemImage: candidate.systemImage)
                    }
                }
            } label: {
                // The overflow shows the *selected* secondary tab rather than a
                // generic ellipsis, so a reader in Git can see they are in Git.
                if InspectorTab.secondary.contains(tab) {
                    if showsLabels {
                        Label(tab.label, systemImage: tab.systemImage)
                            .labelStyle(.titleAndIcon)
                    } else {
                        Image(systemName: tab.systemImage)
                    }
                } else {
                    Image(systemName: "ellipsis")
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .font(.caption)
            .foregroundStyle(
                InspectorTab.secondary.contains(tab) ? Color.junoAccent : Color.secondary
            )
            .padding(.horizontal, JunoSpace.tight)
            .help("More inspector panes")
            .accessibilityLabel("More panes")
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.tight)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            showsLabels = width >= Self.labelledStripMinimumWidth
        }
    }

    private func tabButton(_ candidate: InspectorTab, badge: Int?) -> some View {
        let selected = tab == candidate
        return Button {
            tab = candidate
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: candidate.systemImage)
                    .imageScale(.small)
                // The label drops before the glyph as the pane narrows, so a
                // 260pt inspector still shows four distinguishable targets.
                if showsLabels {
                    Text(candidate.label).lineLimit(1)
                }
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .foregroundStyle(selected ? Color.junoAccent : Color.secondary)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight + 1)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(selected ? Color.junoRowSelected : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(candidate.purpose)
        .accessibilityLabel(candidate.label)
        .accessibilityHint(candidate.purpose)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private func badge(for candidate: InspectorTab) -> Int? {
        switch candidate {
        case .changes: return controller.changes.count
        default: return nil
        }
    }
}

// MARK: - Changes

struct ChangesTab: View {
    @Bindable var controller: SessionController
    let openDiff: (String) -> Void

    var body: some View {
        if controller.changes.isEmpty {
            ContentUnavailableView(
                "No changes yet",
                systemImage: "plusminus.circle",
                description: Text("Files the agent edits appear here for review.")
            )
        } else {
            VStack(spacing: 0) {
                List(controller.changes) { change in
                    changeRow(change)
                }
                .listStyle(.inset)

                Divider().overlay(Color.junoSeparator)

                // Wraps at narrow inspector widths rather than clipping the
                // buttons off the trailing edge.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: JunoSpace.snug) {
                        summaryLabel
                        Spacer(minLength: JunoSpace.snug)
                        reviewButtons
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        summaryLabel
                        HStack(spacing: JunoSpace.snug) {
                            Spacer(minLength: 0)
                            reviewButtons
                        }
                    }
                }
                .padding(JunoSpace.cozy)
            }
        }
    }

    private var summaryLabel: some View {
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
    private var reviewButtons: some View {
        Button("Reject All") {
            Task { await controller.rejectAll() }
        }
        .controlSize(.small)
        .help("Restore every changed file from its checkpoint")

        Button("Accept All") {
            controller.acceptAll()
        }
        .controlSize(.small)
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .help("Mark every change reviewed and keep it")
    }

    private var totalAdded: Int { controller.changes.reduce(0) { $0 + $1.linesAdded } }
    private var totalRemoved: Int { controller.changes.reduce(0) { $0 + $1.linesRemoved } }

    /// "modified · Sources/JunoCodeUI/Theme" — the directory truncates from the
    /// head so the innermost, most identifying folder stays visible.
    private func changeSubtitle(_ change: TrackedChange) -> String {
        guard let directory = PathDisplay.directory(change.path) else {
            return change.kind.rawValue
        }
        return "\(change.kind.rawValue) · \(directory)"
    }

    private func changeRow(_ change: TrackedChange) -> some View {
        HStack(spacing: JunoSpace.snug) {
            reviewIcon(change.reviewState)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(PathDisplay.fileName(change.path))
                    .junoCode()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(changeSubtitle(change))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: JunoSpace.tight)
            DiffStat(added: change.linesAdded, removed: change.linesRemoved)
        }
        .contentShape(Rectangle())
        .onTapGesture { openDiff(change.path) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(change.path), \(change.kind.rawValue), \(change.linesAdded) added, \(change.linesRemoved) removed"
        )
        .accessibilityHint("Opens the diff")
        .contextMenu {
            Button("Show Diff") { openDiff(change.path) }
            Divider()
            Button("Accept") { controller.acceptChange(path: change.path) }
            Button("Reject (Undo)", role: .destructive) {
                Task { await controller.rejectChange(path: change.path) }
            }
        }
    }

    @ViewBuilder
    private func reviewIcon(_ state: TrackedChange.ReviewState) -> some View {
        switch state {
        case .pending:
            Image(systemName: "circle.dotted")
                .foregroundStyle(.secondary)
                .help("Not reviewed")
        case .accepted:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.junoSuccess)
                .help("Accepted")
        case .rejected:
            Image(systemName: "arrow.uturn.backward.circle")
                .foregroundStyle(.secondary)
                .help("Reverted")
        }
    }
}

// MARK: - Diff

struct DiffTab: View {
    @Bindable var controller: SessionController
    @Binding var selectedPath: String?
    @State private var diff: TextDiff?

    var body: some View {
        VStack(spacing: 0) {
            if controller.changes.isEmpty {
                ContentUnavailableView(
                    "No diff to show",
                    systemImage: "text.line.first.and.arrowtriangle.forward",
                    description: Text("Change a file, or pick one in Changes.")
                )
            } else {
                filePicker
                Divider().overlay(Color.junoSeparator)
                if let diff, !diff.isEmpty {
                    DiffContentView(diff: diff)
                } else {
                    ContentUnavailableView(
                        "No differences",
                        systemImage: "equal.circle",
                        description: Text("This file matches its original content.")
                    )
                }
            }
        }
        .task(id: selectedPath ?? controller.changes.first?.path) {
            let path = selectedPath ?? controller.changes.first?.path
            if selectedPath == nil { selectedPath = path }
            guard let path else {
                diff = nil
                return
            }
            diff = await controller.diff(for: path)
        }
    }

    /// A menu rather than a `Picker`: at 260pt a pop-up button showing a long
    /// filename clips, and the menu can carry the directory as a subtitle where
    /// two files share a name — `Package.swift` twice told the reader nothing.
    private var filePicker: some View {
        Menu {
            ForEach(controller.changes) { change in
                Button {
                    selectedPath = change.path
                } label: {
                    if let directory = PathDisplay.directory(change.path) {
                        Text("\(PathDisplay.fileName(change.path)) — \(directory)")
                    } else {
                        Text(PathDisplay.fileName(change.path))
                    }
                }
            }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                Text(selectedPath.map(PathDisplay.fileName) ?? "Select a file")
                    .junoCode()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityLabel("Diff file")
        .accessibilityValue(selectedPath.map(PathDisplay.fileName) ?? "None selected")
    }
}

/// Line-by-line diff rendering with gutters.
///
/// The gutters are a fixed 34pt each and the marker column 14pt, so line
/// numbers stay column-aligned into four digits; past that the number is
/// allowed to run rather than the row re-flowing.
struct DiffContentView: View {
    let diff: TextDiff

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.hunks.enumerated()), id: \.offset) { _, hunk in
                    Text(hunk.header)
                        .junoCodeSmall()
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, JunoSpace.hairline)
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.junoRowHover)
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        diffLine(line)
                    }
                }
            }
            .padding(.bottom, JunoSpace.snug)
        }
        .background(Color.junoTerminal)
    }

    private func diffLine(_ line: DiffLine) -> some View {
        HStack(spacing: 0) {
            Text(line.oldLineNumber.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(line.newLineNumber.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(marker(for: line.kind))
                .frame(width: 14)
                .foregroundStyle(markerColor(for: line.kind))
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .context ? .secondary : .primary)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.cozy)
        }
        .junoCodeSmall()
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background(for: line.kind))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(for: line))
    }

    private func accessibilityText(for line: DiffLine) -> String {
        switch line.kind {
        case .context: return "Unchanged: \(line.text)"
        case .added: return "Added: \(line.text)"
        case .removed: return "Removed: \(line.text)"
        }
    }

    private func marker(for kind: DiffLineKind) -> String {
        switch kind {
        case .context: return " "
        case .added: return "+"
        case .removed: return "−"
        }
    }

    private func markerColor(for kind: DiffLineKind) -> Color {
        switch kind {
        case .context: return .secondary
        case .added: return .junoSuccess
        case .removed: return .junoDanger
        }
    }

    private func background(for kind: DiffLineKind) -> Color {
        switch kind {
        case .context: return .clear
        case .added: return .junoDiffAdded
        case .removed: return .junoDiffRemoved
        }
    }
}

// MARK: - Terminal

struct TerminalTab: View {
    @Bindable var controller: SessionController

    var body: some View {
        if controller.terminal.isEmpty {
            ContentUnavailableView(
                "No output yet",
                systemImage: "terminal",
                description: Text("Command and test output streams here live.")
            )
        } else {
            ScrollViewReader { proxy in
                // Command output is column-aligned, fixed-width text. Soft
                // wrapping breaks the alignment and doubles the height of every
                // line, so the pane scrolls horizontally instead — the way a
                // terminal does.
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(controller.terminal) { line in
                            Text(line.text)
                                .junoCodeSmall()
                                .foregroundStyle(
                                    line.channel == .stderr
                                        ? AnyShapeStyle(Color.junoDanger)
                                        : AnyShapeStyle(.primary)
                                )
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(JunoSpace.snug)
                }
                .background(Color.junoTerminal)
                .onChange(of: controller.terminal.count) {
                    if let last = controller.terminal.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

// MARK: - Tests

struct TestsTab: View {
    @Bindable var controller: SessionController
    @State private var running = false

    var body: some View {
        List {
            if let lastRun = controller.lastTestRun {
                Section("Last run") {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        HStack(spacing: JunoSpace.snug) {
                            Image(
                                systemName: lastRun.passed
                                    ? "checkmark.seal.fill"
                                    : "xmark.seal.fill"
                            )
                            .foregroundStyle(lastRun.passed ? Color.junoSuccess : Color.junoDanger)
                            Text(lastRun.passed ? "Passed" : "Failed")
                                .font(.system(.callout, weight: .medium))
                            Spacer(minLength: JunoSpace.snug)
                            Button("Re-run") { run(lastRun.command) }
                                .controlSize(.small)
                                .disabled(running || controller.isRunning)
                        }
                        Text(lastRun.command)
                            .junoCode()
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        Text(detail(lastRun))
                            .junoCaption()
                    }
                    .padding(.vertical, JunoSpace.hairline)
                    .accessibilityElement(children: .combine)
                }
            }

            Section("Detected test commands") {
                if controller.testSuggestions.isEmpty {
                    Text("No test toolchain detected in this workspace.")
                        .junoCaption()
                } else {
                    ForEach(controller.testSuggestions) { suggestion in
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            HStack(spacing: JunoSpace.snug) {
                                Text(suggestion.toolchain)
                                    .font(.system(.callout, weight: .medium))
                                Spacer(minLength: JunoSpace.snug)
                                Button("Run") { run(suggestion.command) }
                                    .controlSize(.small)
                                    .disabled(running || controller.isRunning)
                            }
                            Text(suggestion.command)
                                .junoCode()
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, JunoSpace.hairline)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(suggestion.toolchain): \(suggestion.command)")
                    }
                }
            }
        }
        .listStyle(.inset)
        .overlay(alignment: .bottom) {
            if running {
                HStack(spacing: JunoSpace.snug) {
                    ProgressView().controlSize(.small)
                    Text("Running tests…").font(.caption)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingGlass(cornerRadius: 20)
                .padding(JunoSpace.cozy)
                .accessibilityLabel("Running tests")
            }
        }
    }

    private func run(_ command: String) {
        running = true
        Task {
            await controller.runTest(command: command)
            running = false
        }
    }

    private func detail(_ run: TestRunCompletedEvent) -> String {
        var parts: [String] = []
        if let tests = run.testsRun { parts.append("\(tests) tests") }
        if let failures = run.failures { parts.append("\(failures) failed") }
        parts.append(String(format: "%.1fs", run.durationSeconds))
        return parts.joined(separator: " · ")
    }
}
