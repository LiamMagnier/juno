import SwiftUI
import JunoCodeCore

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
}

/// Right zone: the inspector with Changes/Diff/Terminal/Tests/Git/Files/
/// Context/Computer tabs.
struct InspectorView: View {
    @Bindable var controller: SessionController
    @State private var tab: InspectorTab = .changes
    @State private var selectedDiffPath: String?

    var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector tab", selection: $tab) {
                ForEach(InspectorTab.allCases) { tab in
                    Image(systemName: tab.systemImage)
                        .help(tab.label)
                        .tag(tab)
                        .accessibilityLabel(tab.label)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(JunoCodeTheme.Spacing.compact)

            Divider().overlay(JunoCodeTheme.separator)

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
        .background(JunoCodeTheme.surface)
        .task(id: controller.sessionID) {
            await controller.refreshWorkspacePanels()
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
                description: Text("Files the agent modifies appear here for review.")
            )
        } else {
            VStack(spacing: 0) {
                List(controller.changes) { change in
                    changeRow(change)
                }
                .listStyle(.inset)
                Divider().overlay(JunoCodeTheme.separator)
                HStack {
                    Text(summaryText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Reject All") {
                        Task { await controller.rejectAll() }
                    }
                    Button("Accept All") {
                        controller.acceptAll()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(JunoCodeTheme.accent)
                }
                .padding(JunoCodeTheme.Spacing.control)
            }
        }
    }

    private var summaryText: String {
        let added = controller.changes.reduce(0) { $0 + $1.linesAdded }
        let removed = controller.changes.reduce(0) { $0 + $1.linesRemoved }
        return "\(controller.changes.count) files · +\(added) −\(removed)"
    }

    private func changeRow(_ change: TrackedChange) -> some View {
        HStack(spacing: JunoCodeTheme.Spacing.compact) {
            reviewIcon(change.reviewState)
            VStack(alignment: .leading, spacing: 1) {
                Text(change.path)
                    .font(.junoMono)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(change.kind.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text("+\(change.linesAdded)")
                .font(.junoMonoSmall)
                .foregroundStyle(JunoCodeTheme.success)
            Text("−\(change.linesRemoved)")
                .font(.junoMonoSmall)
                .foregroundStyle(JunoCodeTheme.failure)
        }
        .contentShape(Rectangle())
        .onTapGesture { openDiff(change.path) }
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
            Image(systemName: "circle.dotted").foregroundStyle(.secondary)
        case .accepted:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(JunoCodeTheme.success)
        case .rejected:
            Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(.secondary)
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
                    description: Text("Select a changed file to see its diff.")
                )
            } else {
                Picker("File", selection: $selectedPath) {
                    ForEach(controller.changes) { change in
                        Text(change.path).tag(String?.some(change.path))
                    }
                }
                .padding(JunoCodeTheme.Spacing.compact)
                if let diff, !diff.isEmpty {
                    DiffContentView(diff: diff)
                } else {
                    ContentUnavailableView(
                        "No differences",
                        systemImage: "equal.circle",
                        description: Text("The file matches its original content.")
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
}

/// Line-by-line diff rendering with gutters.
struct DiffContentView: View {
    let diff: TextDiff

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.hunks.enumerated()), id: \.offset) { _, hunk in
                    Text(hunk.header)
                        .font(.junoMonoSmall)
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, JunoCodeTheme.Spacing.tight)
                        .padding(.horizontal, JunoCodeTheme.Spacing.compact)
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        diffLine(line)
                    }
                }
            }
            .padding(.vertical, JunoCodeTheme.Spacing.compact)
        }
        .background(JunoCodeTheme.well)
    }

    private func diffLine(_ line: DiffLine) -> some View {
        HStack(spacing: 0) {
            Text(line.oldLineNumber.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(line.newLineNumber.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(marker(for: line.kind))
                .frame(width: 16)
                .foregroundStyle(markerColor(for: line.kind))
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .context ? .secondary : .primary)
            Spacer(minLength: 0)
        }
        .font(.junoMonoSmall)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background(for: line.kind))
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
        case .added: return JunoCodeTheme.success
        case .removed: return JunoCodeTheme.failure
        }
    }

    private func background(for kind: DiffLineKind) -> Color {
        switch kind {
        case .context: return .clear
        case .added: return JunoCodeTheme.diffAddedBackground
        case .removed: return JunoCodeTheme.diffRemovedBackground
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
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(controller.terminal) { line in
                            Text(line.text)
                                .font(.junoMonoSmall)
                                .foregroundStyle(
                                    line.channel == .stderr
                                        ? JunoCodeTheme.failure
                                        : .primary
                                )
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(JunoCodeTheme.Spacing.compact)
                }
                .background(JunoCodeTheme.well)
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
                    HStack {
                        Image(systemName: lastRun.passed ? "checkmark.seal.fill" : "xmark.seal.fill")
                            .foregroundStyle(
                                lastRun.passed ? JunoCodeTheme.success : JunoCodeTheme.failure
                            )
                        VStack(alignment: .leading) {
                            Text(lastRun.command).font(.junoMono)
                            Text(detail(lastRun))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Re-run") {
                            run(lastRun.command)
                        }
                        .disabled(running || controller.isRunning)
                    }
                }
            }
            Section("Detected test commands") {
                if controller.testSuggestions.isEmpty {
                    Text("No test toolchain detected in this workspace.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(controller.testSuggestions) { suggestion in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(suggestion.command).font(.junoMono)
                                Text(suggestion.toolchain)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Run") {
                                run(suggestion.command)
                            }
                            .disabled(running || controller.isRunning)
                        }
                    }
                }
            }
        }
        .listStyle(.inset)
        .overlay(alignment: .bottom) {
            if running {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Running tests…")
                        .font(.caption)
                }
                .padding(JunoCodeTheme.Spacing.control)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .padding()
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
