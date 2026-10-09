import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The dock's tabs (DESIGN §5.16). Screen shows only while computer use has
/// frames. Terminal, Files and Preview belong to the thread's folder on this
/// Mac; the Alevr engine's threads keep the side panel instead.
public enum CodeV2DockTab: String, CaseIterable, Identifiable, Sendable {
    case changes, agents, terminal, files, preview, screen
    public var id: String { rawValue }

    var title: String {
        switch self {
        case .changes: "Changes"
        case .agents: "Agents"
        case .terminal: "Terminal"
        case .files: "Files"
        case .preview: "Preview"
        case .screen: "Screen"
        }
    }

    var icon: JunoIcon {
        switch self {
        case .changes: .diff
        case .agents: .agents
        case .terminal: .terminal
        case .files: .files
        case .preview: .canvas
        case .screen: .monitor
        }
    }
}

/// Which tabs an env-server thread's dock shows, in order.
public enum CodeV2DockTabs {
    public static func visible(hasTerminal: Bool, hasWorkspace: Bool, hasFrames: Bool) -> [CodeV2DockTab] {
        var tabs: [CodeV2DockTab] = [.changes, .agents]
        if hasTerminal { tabs.append(.terminal) }
        if hasWorkspace { tabs += [.files, .preview] }
        if hasFrames { tabs.append(.screen) }
        return tabs
    }
}

/// The right panel (TARGET §10): one strip of text tabs, 36 tall, the
/// selected one in 12/500 ink, then the tab's content. Header actions (Stop
/// while the screen is used) and close sit at the right. Flat, one hairline.
public struct CodeV2Dock: View {
    @Binding var tab: CodeV2DockTab
    let tabs: [CodeV2DockTab]
    var counts: [CodeV2DockTab: Int] = [:]
    var close: (() -> Void)?
    var headerAction: ((CodeV2DockTab) -> AnyView?)?
    let content: (CodeV2DockTab) -> AnyView

    public init(
        tab: Binding<CodeV2DockTab>, tabs: [CodeV2DockTab], counts: [CodeV2DockTab: Int] = [:],
        close: (() -> Void)? = nil, headerAction: ((CodeV2DockTab) -> AnyView?)? = nil,
        content: @escaping (CodeV2DockTab) -> AnyView
    ) {
        self._tab = tab
        self.tabs = tabs
        self.counts = counts
        self.close = close
        self.headerAction = headerAction
        self.content = content
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                HStack(spacing: JunoSpace.tight) {
                    ForEach(tabs) { option in
                        CodeV2DockTabButton(tab: option, count: counts[option], isSelected: tab == option) { tab = option }
                    }
                }
                Spacer(minLength: JunoSpace.snug)
                if let action = headerAction?(tab) { action }
                if let close {
                    Button(action: close) { JunoIconView(.panelRight, size: 14) }
                        .buttonStyle(StudioIconButtonStyle())
                        .help("Close the panel")
                        .accessibilityLabel("Close panel")
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 40)
            .studioHairline(.bottom)
            content(tab)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(Studio.Surface.canvas)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.v2.dock")
    }
}

struct CodeV2DockTabButton: View {
    let tab: CodeV2DockTab
    let count: Int?
    let isSelected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.tight) {
                Text(tab.title).studioType(isSelected ? .smallMedium : .small)
                if let count, count > 0 {
                    Text("\(count)").studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
            }
            .foregroundStyle(isSelected || hovering ? Studio.Ink.primary : Studio.Ink.secondary)
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 28)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(isSelected ? Studio.Surface.selected : (hovering ? Studio.Surface.hover : Color.clear))
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Changes

/// Panel › Changes (TARGET §10.1): a toolbar (scope, totals, view options,
/// Commit…), then each file under its header with its hunks. No Accept or
/// Reject per hunk; hovering a hunk offers Revert, and a reverted hunk says so.
public struct CodeV2ChangesPane: View {
    public enum Scope: String, Hashable, Sendable { case turn, thread }

    let files: [CodeV2DiffFile]
    @Binding var scope: Scope
    var decisions: CodeV2HunkDecisions
    var focusedPath: String?
    var decide: ((CodeV2DiffFile, DiffHunk, CodeV2HunkDecisions.Decision) -> Void)?
    var commit: (() -> Void)?
    var failure: String?

    @State private var collapsed: Set<String>?
    @State private var wraps = false

    public init(
        files: [CodeV2DiffFile], scope: Binding<Scope>, decisions: CodeV2HunkDecisions,
        focusedPath: String? = nil,
        decide: ((CodeV2DiffFile, DiffHunk, CodeV2HunkDecisions.Decision) -> Void)? = nil,
        commit: (() -> Void)? = nil, failure: String? = nil
    ) {
        self.files = files
        self._scope = scope
        self.decisions = decisions
        self.focusedPath = focusedPath
        self.decide = decide
        self.commit = commit
        self.failure = failure
    }

    private var additions: Int { files.reduce(0) { $0 + $1.additions } }
    private var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
    /// More than five files start folded.
    private var folded: Set<String> { collapsed ?? (files.count > 5 ? Set(files.map(\.path)) : []) }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Menu {
                    Picker("Scope", selection: $scope) {
                        Text("This Turn").tag(Scope.turn)
                        Text("Whole Session").tag(Scope.thread)
                    }
                    .pickerStyle(.inline)
                } label: {
                    CodeV2TextControlLabel(title: scope == .turn ? "This turn" : "Whole session")
                }
                .menuStyle(.button).menuIndicator(.hidden)
                .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize()
                CodeV2DiffCounts(additions: additions, deletions: deletions)
                Spacer()
                Menu {
                    Toggle("Wrap Lines", isOn: $wraps)
                    Button("Expand All") { collapsed = [] }
                    Button("Collapse All") { collapsed = Set(files.map(\.path)) }
                } label: {
                    JunoIconView(.ellipsis, size: 14)
                }
                .menuStyle(.button).menuIndicator(.hidden)
                .buttonStyle(StudioIconButtonStyle()).fixedSize()
                .help("View options")
                .accessibilityLabel("View options")
                if let commit {
                    Button("Commit…", action: commit)
                        .buttonStyle(.bordered).controlSize(.small)
                        .disabled(files.isEmpty)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 40)
            if let failure {
                Text(failure).studioType(.small).foregroundStyle(Studio.Ink.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.regular).padding(.bottom, JunoSpace.snug)
            }
            if files.isEmpty {
                Text(scope == .turn ? "Nothing changed in this turn." : "Nothing has changed in this session yet.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .padding(JunoSpace.regular)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                            ForEach(files) { file in
                                Section {
                                    if !folded.contains(file.path) {
                                        hunks(file)
                                    }
                                } header: {
                                    fileHeader(file)
                                }
                                .id(file.path)
                            }
                        }
                        .padding(.bottom, JunoSpace.regular)
                    }
                    .onAppear { if let focusedPath { proxy.scrollTo(focusedPath, anchor: .top) } }
                    .onChange(of: focusedPath) { _, path in if let path { proxy.scrollTo(path, anchor: .top) } }
                }
            }
        }
    }

    private func toggle(_ path: String) {
        var set = folded
        if set.contains(path) { set.remove(path) } else { set.insert(path) }
        collapsed = set
    }

    private func fileHeader(_ file: CodeV2DiffFile) -> some View {
        Button { toggle(file.path) } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.chevronRight, size: 10)
                    .rotationEffect(.degrees(folded.contains(file.path) ? 0 : 90))
                    .foregroundStyle(Studio.Ink.secondary)
                Text(file.fileName).studioType(.textMedium).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                Text(file.directory).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1).truncationMode(.head)
                Spacer(minLength: JunoSpace.snug)
                CodeV2DiffCounts(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: 36)
            .background(Studio.Surface.canvas)
            .overlay(alignment: .top) { Rectangle().fill(Studio.Surface.hairline).frame(height: 1) }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func hunks(_ file: CodeV2DiffFile) -> some View {
        ForEach(Array(file.hunks.enumerated()), id: \.offset) { index, hunk in
            let previousEnd = index == 0 ? 1 : file.hunks[index - 1].newStart + file.hunks[index - 1].newCount
            let gap = hunk.newStart - previousEnd
            if gap > 0 {
                CodeV2UnchangedBar(count: gap)
            }
            CodeV2Hunk(
                hunk: hunk,
                wraps: wraps,
                decision: decisions.decision(for: hunk),
                revert: decide.map { decide in { decide(file, hunk, .rejected) } }
            )
        }
    }
}

/// "120 unchanged lines": the collapsed context between hunks.
struct CodeV2UnchangedBar: View {
    let count: Int

    var body: some View {
        Text("\(count) unchanged \(count == 1 ? "line" : "lines")")
            .studioType(.small).monospacedDigit()
            .foregroundStyle(Studio.Ink.secondary)
            .frame(maxWidth: .infinity)
            .frame(height: 24)
            .background(Studio.Surface.muted.opacity(0.6))
    }
}

/// One hunk's lines: numbers in the gutter, a 2pt edge in the strong diff
/// colour, the line fill. Revert on hover; a reverted hunk dims.
struct CodeV2Hunk: View {
    let hunk: DiffHunk
    var wraps = false
    let decision: CodeV2HunkDecisions.Decision?
    var revert: (() -> Void)?

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                CodeV2DiffLineRow(line: line, wraps: wraps)
            }
        }
        .padding(.vertical, 2)
        .overlay(alignment: .topTrailing) {
            if decision == .rejected {
                Text("Reverted").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .padding(.horizontal, JunoSpace.snug).padding(.top, 2)
            } else if hovering, let revert {
                Button("Revert", action: revert)
                    .buttonStyle(.bordered).controlSize(.small)
                    .padding(.horizontal, JunoSpace.snug).padding(.top, 2)
            }
        }
        .opacity(decision == .rejected ? 0.5 : 1)
        .onHover { hovering = $0 }
    }
}

struct CodeV2DiffLineRow: View {
    let line: DiffLine
    var wraps = false

    private var fill: Color {
        switch line.kind {
        case .added: Studio.Diff.add
        case .removed: Studio.Diff.del
        default: .clear
        }
    }

    private var edge: Color {
        switch line.kind {
        case .added: Studio.Ink.added.opacity(0.7)
        case .removed: Studio.Ink.removed.opacity(0.7)
        default: .clear
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Group {
                Text(line.oldLineNumber.map(String.init) ?? "")
                    .frame(width: 34, alignment: .trailing)
                Text(line.newLineNumber.map(String.init) ?? "")
                    .frame(width: 34, alignment: .trailing)
            }
            .studioType(.small).monospacedDigit()
            .foregroundStyle(Studio.Ink.tertiary)
            Text(line.text.isEmpty ? " " : line.text)
                .studioType(.code)
                .foregroundStyle(Studio.Ink.primary)
                .lineLimit(wraps ? nil : 1)
                .textSelection(.enabled)
                .padding(.leading, JunoSpace.cozy)
            Spacer(minLength: JunoSpace.snug)
        }
        .padding(.vertical, 1)
        .background(fill)
        .overlay(alignment: .leading) { Rectangle().fill(edge).frame(width: 2) }
    }
}
