import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// A run of machine activity between two conversational events, as one quiet
/// "Worked for 8m 29s" line the reader can open.
///
/// This is the transcript's work log. The collapsed row says how long the
/// agent worked and, underneath, one sentence about what it did — "Read 4
/// files · ran 2 commands"; opening it shows the work grouped by kind: the
/// files it read, the commands it ran, the files it edited, the agents it
/// delegated to. The raw rows are still there underneath (the group links back
/// to its transcript events), so nothing is paraphrased that the reader cannot
/// see in full one click away.
///
/// Flat by design: it is content, so it carries no material, no shadow and no
/// box. Forty of these down a transcript have to read as one column of log
/// lines, not forty cards.
public struct ActivityNarrativeView<Raw: View>: View {
    public let group: ActivityNarrativeGroup
    /// The agents this group's `delegate_task` calls asked for, so the opened
    /// log can name them rather than saying "delegated 2 tasks".
    private let subagents: [SubagentRun]
    /// The transcript's own rows for this group's events, shown under the
    /// records when the reader asks for them. Nil where the caller has none —
    /// a sub-agent's embedded transcript, a preview.
    private let raw: (() -> Raw)?
    @State private var isExpanded = false
    @State private var showsRaw = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        group: ActivityNarrativeGroup,
        subagents: [SubagentRun] = [],
        @ViewBuilder raw: @escaping () -> Raw
    ) {
        self.group = group
        self.subagents = subagents
        self.raw = raw
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                detail
                    .transition(.junoInline)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: isExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.transcript.work-log")
    }

    private var header: some View {
        Button {
            guard group.hasDetail else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                isExpanded.toggle()
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.tight) {
                    workedForLabel
                        .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                        .junoInk()
                        .monospacedDigit()
                    if group.hasDetail {
                        JunoIconView(.chevronDown, size: 11)
                            .junoMetaInk()
                            .rotationEffect(.degrees(isExpanded ? 0 : -90))
                            .accessibilityHidden(true)
                    }
                    Spacer(minLength: JunoSpace.snug)
                    if group.linesAdded > 0 || group.linesRemoved > 0 {
                        DiffStat(added: group.linesAdded, removed: group.linesRemoved)
                    }
                }
                if !isExpanded {
                    Text(collapsedSummary)
                        .junoFont(size: 13, relativeTo: .subheadline)
                        .junoSecondaryInk()
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.horizontal, JunoSpace.tight)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!group.hasDetail)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(group.hasDetail ? (isExpanded ? "Expanded" : "Collapsed") : "")
        .accessibilityHint(group.hasDetail ? "Shows each step in this work log" : "")
    }

    /// "Worked for 8m 29s", or a live "Working · 0:42" while the group is
    /// still open. Still-frame honest: paused, a climbing count reads
    /// differently from a stuck one.
    @ViewBuilder
    private var workedForLabel: some View {
        switch group.status {
        case .completed:
            Text("Worked for \(Self.duration(group.durationSeconds ?? 0))")
        case .interrupted:
            Text("Worked for \(Self.duration(group.durationSeconds ?? 0)) · interrupted")
        case .running:
            TimelineView(.periodic(from: group.startedAt, by: 1)) { timeline in
                Text("Working · \(Self.duration(max(0, timeline.date.timeIntervalSince(group.startedAt))))")
            }
        }
    }

    /// One line about the work: the group's own sentence, plus what is in
    /// flight while it is still going.
    private var collapsedSummary: String {
        var parts: [String] = [group.title]
        if group.status == .running,
           let current = group.toolCallRecords.last(where: { $0.status == .running || $0.status == .proposed })
        {
            parts.append(current.summary)
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Opened

    /// The work by kind, then the delegated agents by name, then the raw rows
    /// on request.
    private var detail: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(Self.rows(for: group.toolCallRecords)) { row in
                ActivityNarrativeRow(row: row)
            }
            ForEach(subagents) { run in
                ActivityNarrativeSubagentRow(run: run)
            }
            if raw != nil {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        showsRaw.toggle()
                    }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(showsRaw ? .chevronDown : .chevronRight, size: 11)
                        Text(showsRaw ? "Hide every step" : "Show every step")
                    }
                    .junoCaption()
                    .junoSecondaryInk()
                    .frame(minHeight: CodeRowMetrics.minHeight)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.code.transcript.work-log.raw")
                if showsRaw, let raw {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        raw()
                    }
                    .padding(.leading, JunoSpace.snug)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Color.junoSeparator).frame(width: 1)
                    }
                }
            }
        }
        .padding(.horizontal, JunoSpace.tight)
        .padding(.bottom, JunoSpace.snug)
    }

    private var accessibilityLabel: String {
        var text: String
        switch group.status {
        case .running: text = "Working, \(group.title)"
        case .completed: text = "Worked for \(Self.duration(group.durationSeconds ?? 0)), \(group.title)"
        case .interrupted: text = "Worked for \(Self.duration(group.durationSeconds ?? 0)), interrupted, \(group.title)"
        }
        if group.linesAdded > 0 || group.linesRemoved > 0 {
            text += ", \(group.linesAdded) added, \(group.linesRemoved) removed"
        }
        return text
    }

    static func duration(_ seconds: Double) -> String {
        seconds < 60
            ? String(format: "%.0fs", seconds)
            : String(format: "%dm %02ds", Int(seconds) / 60, Int(seconds) % 60)
    }

    // MARK: - Grouping

    /// Folds the records into one line per kind of work, in the order the
    /// kinds first appeared: "Read files" with the files, "Ran a command"
    /// with the command, "Edited files", "Ran the tests".
    static func rows(for records: [ActivityNarrativeGroup.ToolCallRecord]) -> [ActivityNarrativeRow.Row] {
        var order: [ActivityNarrativeRow.Kind] = []
        var buckets: [ActivityNarrativeRow.Kind: [ActivityNarrativeGroup.ToolCallRecord]] = [:]
        for record in records {
            let kind = ActivityNarrativeRow.Kind(toolName: record.toolName)
            if buckets[kind] == nil { order.append(kind) }
            buckets[kind, default: []].append(record)
        }
        return order.compactMap { kind in
            guard let items = buckets[kind], !items.isEmpty else { return nil }
            return ActivityNarrativeRow.Row(kind: kind, records: items)
        }
    }
}

extension ActivityNarrativeView where Raw == EmptyView {
    public init(group: ActivityNarrativeGroup, subagents: [SubagentRun] = []) {
        self.group = group
        self.subagents = subagents
        self.raw = nil
    }
}

/// One kind of work inside an opened log: a Lucide mark, a verb, and the
/// things it touched, at 13pt secondary ink.
struct ActivityNarrativeRow: View {
    enum Kind: Hashable {
        case read, command, edit, test, delegate, other

        init(toolName: String) {
            switch toolName {
            case "read_file", "list_directory", "glob", "grep", "find_files",
                 "git_status", "git_diff", "git_log", "web_search", "web_fetch":
                self = .read
            case "create_file", "write_file", "apply_patch", "delete_file", "move_file":
                self = .edit
            case "run_command":
                self = .command
            case "run_tests":
                self = .test
            case SubagentDigest.toolName:
                self = .delegate
            default:
                self = .other
            }
        }

        var icon: JunoIcon {
            switch self {
            case .read: .file
            case .command: .terminal
            case .edit: .pencil
            case .test: .check
            case .delegate: .agents
            case .other: .box
            }
        }

        func verb(count: Int) -> String {
            switch self {
            case .read: count == 1 ? "Read a file" : "Read files"
            case .command: count == 1 ? "Ran a command" : "Ran commands"
            case .edit: count == 1 ? "Edited a file" : "Edited files"
            case .test: count == 1 ? "Ran the tests" : "Ran \(count) test runs"
            case .delegate: count == 1 ? "Delegated a task" : "Delegated tasks"
            case .other: count == 1 ? "Used a tool" : "Used \(count) tools"
            }
        }
    }

    struct Row: Identifiable {
        let kind: Kind
        let records: [ActivityNarrativeGroup.ToolCallRecord]
        var id: Kind { kind }
    }

    let row: Row

    /// The one-line tail: the file names, or the commands, with a "+n more"
    /// past the third.
    private var detail: String {
        let names = row.records.map { record -> String in
            switch row.kind {
            case .read, .edit:
                let summary = record.summary
                let path = summary.split(separator: " ").last.map(String.init) ?? summary
                return PathDisplay.fileName(path)
            case .command, .test:
                return record.summary.replacingOccurrences(of: "Run ", with: "")
            case .delegate, .other:
                return record.summary
            }
        }
        let shown = names.prefix(3).joined(separator: ", ")
        let rest = names.count - min(names.count, 3)
        return rest > 0 ? "\(shown) +\(rest) more" : shown
    }

    private var failed: Bool {
        row.records.contains { $0.status == .failed }
    }

    private var isRunning: Bool {
        row.records.contains { $0.status == .running || $0.status == .proposed }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(row.kind.icon, size: 13)
                .foregroundStyle(failed ? Color.junoDanger : Color.junoMutedForeground)
                .frame(width: 16, alignment: .center)
                .accessibilityHidden(true)
            Text(row.kind.verb(count: row.records.count))
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoSecondaryInk()
                .lineLimit(1)
            Text(detail)
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoMetaInk()
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            if isRunning {
                ProgressView().controlSize(.mini)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.kind.verb(count: row.records.count)): \(detail)")
    }
}

/// A delegated agent, by name, inside an opened log.
struct ActivityNarrativeSubagentRow: View {
    let run: SubagentRun

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            SubagentStatusGlyph(status: run.status)
                .frame(width: 16, alignment: .center)
            Text(run.title)
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoSecondaryInk()
                .lineLimit(1)
                .truncationMode(.middle)
            Text(run.isActive ? run.currentActivity : (run.status == .completed ? "done" : run.status.rawValue))
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoMetaInk()
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            SubagentElapsed(run: run)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SubagentFormatting.accessibilityLabel(run))
    }
}
