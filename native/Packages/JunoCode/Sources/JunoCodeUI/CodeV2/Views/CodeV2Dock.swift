import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The dock's tabs (DESIGN §5.16). Screen shows only while computer use has
/// frames; the Mac's Alevr engine keeps its own Terminal in the side panel.
public enum CodeV2DockTab: String, CaseIterable, Identifiable, Sendable {
    case changes, agents, screen
    public var id: String { rawValue }

    var title: String {
        switch self {
        case .changes: "Changes"
        case .agents: "Agents"
        case .screen: "Screen"
        }
    }

    var icon: JunoIcon {
        switch self {
        case .changes: .diff
        case .agents: .agents
        case .screen: .monitor
        }
    }
}

/// The dock for an env-server session: text tabs with counts, then the
/// tab's content. Flat on the page ground with a hairline edge; never
/// elevated.
public struct CodeV2Dock: View {
    @Binding var tab: CodeV2DockTab
    let tabs: [CodeV2DockTab]
    var counts: [CodeV2DockTab: Int] = [:]
    var close: (() -> Void)?
    let content: (CodeV2DockTab) -> AnyView

    public init(
        tab: Binding<CodeV2DockTab>, tabs: [CodeV2DockTab], counts: [CodeV2DockTab: Int] = [:],
        close: (() -> Void)? = nil, content: @escaping (CodeV2DockTab) -> AnyView
    ) {
        self._tab = tab
        self.tabs = tabs
        self.counts = counts
        self.close = close
        self.content = content
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.tight) {
                ForEach(tabs) { option in
                    CodeV2DockTabButton(tab: option, count: counts[option], isSelected: tab == option) { tab = option }
                }
                Spacer()
                if let close {
                    Button(action: close) { JunoIconView(.panelRight, size: 14) }
                        .buttonStyle(StudioIconButtonStyle()).contentShape(.rect)
                        .help("Close the dock")
                        .accessibilityLabel("Close dock")
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 44)
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
            HStack(spacing: JunoSpace.tight + 1) {
                JunoIconView(tab.icon, size: 14)
                Text(tab.title)
                if let count, count > 0 {
                    Text("\(count)").monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
            }
            .font(Studio.Font.label)
            .foregroundStyle(isSelected || hovering ? Studio.Ink.primary : Studio.Ink.secondary)
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 30)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(isSelected ? Studio.Surface.selected : (hovering ? Studio.Surface.hover : Color.clear))
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Changes

/// Dock › Changes (DESIGN §5.16): "This turn / Whole thread", the totals and
/// Commit…, then each file under a sticky header with its hunks. Each hunk
/// header carries Reject and Accept; once decided it says so and a rejected
/// hunk dims.
public struct CodeV2ChangesPane: View {
    public enum Scope: String, Hashable, Sendable { case turn, thread }

    let files: [CodeV2DiffFile]
    @Binding var scope: Scope
    var decisions: CodeV2HunkDecisions
    var focusedPath: String?
    var decide: ((CodeV2DiffFile, DiffHunk, CodeV2HunkDecisions.Decision) -> Void)?
    var commit: (() -> Void)?
    var failure: String?

    @State private var collapsed: Set<String> = []

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

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                JunoSegmented(
                    options: [JunoSegmentedOption(Scope.turn, "This turn"), JunoSegmentedOption(Scope.thread, "Whole thread")],
                    selection: $scope, accessibilityLabel: "Scope", size: .compact
                )
                .fixedSize()
                Spacer()
                CodeV2DiffCounts(additions: additions, deletions: deletions, font: Studio.Font.labelDigits)
                if let commit {
                    Button("Commit…", action: commit).buttonStyle(CodeV2InkButtonStyle()).disabled(files.isEmpty).contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 44)
            if let failure {
                Text(failure).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.cozy).padding(.bottom, JunoSpace.snug)
            }
            if files.isEmpty {
                Text(scope == .turn ? "Nothing changed in this turn." : "Nothing has changed in this thread yet.")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    .padding(JunoSpace.regular)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            ForEach(files) { file in
                                Section {
                                    if !collapsed.contains(file.path) {
                                        ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                                            CodeV2HunkCard(
                                                hunk: hunk,
                                                decision: decisions.decision(for: hunk),
                                                decide: decide.map { decide in { decide(file, hunk, $0) } }
                                            )
                                        }
                                    }
                                } header: {
                                    fileHeader(file)
                                }
                                .id(file.path)
                            }
                        }
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.bottom, JunoSpace.regular)
                    }
                    .onAppear { if let focusedPath { proxy.scrollTo(focusedPath, anchor: .top) } }
                    .onChange(of: focusedPath) { _, path in if let path { proxy.scrollTo(path, anchor: .top) } }
                }
            }
        }
    }

    private func fileHeader(_ file: CodeV2DiffFile) -> some View {
        Button {
            if collapsed.contains(file.path) { collapsed.remove(file.path) } else { collapsed.insert(file.path) }
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.chevronRight, size: 11)
                    .rotationEffect(.degrees(collapsed.contains(file.path) ? 0 : 90))
                    .foregroundStyle(Studio.Ink.secondary)
                Text(file.fileName).font(Studio.Font.mono).foregroundStyle(Studio.Ink.primary)
                Text(file.directory).font(Studio.Font.mono).foregroundStyle(Studio.Ink.secondary).lineLimit(1).truncationMode(.head)
                Spacer()
                CodeV2DiffCounts(additions: file.additions, deletions: file.deletions, font: Studio.Font.mono)
            }
            .frame(height: 38)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(Studio.Surface.canvas)
    }
}

/// One hunk in a card: its range in mono on a muted header with Reject and
/// Accept, then the lines with the diff fills and a word-level highlight on
/// a one-line change.
struct CodeV2HunkCard: View {
    let hunk: DiffHunk
    let decision: CodeV2HunkDecisions.Decision?
    var decide: ((CodeV2HunkDecisions.Decision) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Text(hunk.header).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                Spacer()
                if let decision {
                    Text(decision == .accepted ? "Accepted" : "Rejected")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                } else if let decide {
                    Button("Reject") { decide(.rejected) }.buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                    Button("Accept") { decide(.accepted) }.buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 30)
            .background(Studio.Surface.muted)
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        StudioDiffLineRow(line: line, wraps: false)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .background(Studio.Surface.raised)
        .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).strokeBorder(Studio.Surface.hairline))
        .opacity(decision == .rejected ? 0.6 : 1)
    }
}
