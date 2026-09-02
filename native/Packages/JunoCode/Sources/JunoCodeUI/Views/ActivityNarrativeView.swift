import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// A run of machine activity between two conversational events, as one quiet
/// line the reader can open.
///
/// This is the transcript's work log. The collapsed row is a sentence about the
/// group — "Read 4 files · ran 2 commands · edited 3 files" — with the files and
/// lines it touched and how long it took; opening it shows every tool call the
/// group folded, each with its state, its duration and the tail of its output.
/// The raw rows are still there underneath (the group links back to its
/// transcript events), so nothing is paraphrased that the reader cannot see in
/// full one click away.
///
/// Flat by design: it is content, so it carries no material and no shadow, only
/// a hairline well the way a user prompt does. Forty of these down a transcript
/// have to read as one column of log lines, not forty cards.
public struct ActivityNarrativeView<Raw: View>: View {
    public let group: ActivityNarrativeGroup
    /// The transcript's own rows for this group's events, shown under the
    /// records when the reader asks for them. Nil where the caller has none —
    /// a sub-agent's embedded transcript, a preview.
    private let raw: (() -> Raw)?
    @State private var isExpanded = false
    @State private var showsRaw = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(group: ActivityNarrativeGroup, @ViewBuilder raw: @escaping () -> Raw) {
        self.group = group
        self.raw = raw
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                Divider().overlay(Color.junoSeparator)
                detail
                    .transition(.junoInline)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(group.status == .running ? Color.junoRowHover : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
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
            HStack(spacing: JunoSpace.snug) {
                statusMark
                    .frame(width: 18, alignment: .center)

                VStack(alignment: .leading, spacing: 1) {
                    Text(group.title)
                        .font(.callout)
                        .junoInk()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if !summaryLine.isEmpty {
                        Text(summaryLine)
                            .junoCodeSmall()
                            .junoMetaInk()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                Spacer(minLength: JunoSpace.snug)

                if group.linesAdded > 0 || group.linesRemoved > 0 {
                    DiffStat(added: group.linesAdded, removed: group.linesRemoved)
                }

                durationLabel
                    .junoCodeSmall()
                    .junoMetaInk()
                    .monospacedDigit()

                if group.hasDetail {
                    JunoIconView(.chevronRight, size: 11)
                        .junoMetaInk()
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!group.hasDetail)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(group.hasDetail ? (isExpanded ? "Expanded" : "Collapsed") : "")
        .accessibilityHint(group.hasDetail ? "Shows each step in this work log" : "")
    }

    /// "3 files · 1.2s" — what the title's verbs do not already say.
    private var summaryLine: String {
        var parts: [String] = []
        let files = group.filesTouched.count
        if files > 0 {
            parts.append("\(files) \(files == 1 ? "file" : "files")")
        }
        if group.status == .running,
           let current = group.toolCallRecords.last(where: { $0.status == .running || $0.status == .proposed })
        {
            parts.append(current.summary)
        } else if group.status == .interrupted {
            parts.append("Interrupted")
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var durationLabel: some View {
        if let seconds = group.durationSeconds {
            Text(Self.duration(seconds))
        } else {
            // A live count, once a second, in the slot the final number will
            // take — the still-frame test: paused, "4.1s" and climbing reads
            // differently from "4.1s" and stuck.
            TimelineView(.periodic(from: group.startedAt, by: 1)) { timeline in
                Text(Self.duration(max(0, timeline.date.timeIntervalSince(group.startedAt))))
            }
        }
    }

    @ViewBuilder
    private var statusMark: some View {
        switch group.status {
        case .running: CodeStatusGlyph(CodeRunStatus(CodeRunState.running), size: 12)
        case .completed: CodeStatusGlyph(CodeRunStatus(CodeRunState.finished), size: 12)
        case .interrupted: CodeStatusGlyph(CodeRunStatus(CodeRunState.stopped), size: 12)
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(group.toolCallRecords) { record in
                ActivityToolRecordRow(record: record)
            }
            if raw != nil {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        showsRaw.toggle()
                    }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(showsRaw ? .chevronDown : .chevronRight, size: 11)
                        Text(showsRaw ? "Hide raw transcript rows" : "Show raw transcript rows")
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
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    private var accessibilityLabel: String {
        var text = group.title
        if !summaryLine.isEmpty { text += ", \(summaryLine)" }
        switch group.status {
        case .running: text += ", in progress"
        case .completed: text += ", finished"
        case .interrupted: text += ", interrupted"
        }
        return text
    }

    static func duration(_ seconds: Double) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : String(format: "%dm %02ds", Int(seconds) / 60, Int(seconds) % 60)
    }
}

extension ActivityNarrativeView where Raw == EmptyView {
    public init(group: ActivityNarrativeGroup) {
        self.group = group
        self.raw = nil
    }
}

/// One tool call inside an opened work log: its state, what it did, how long it
/// took, and the tail of what it printed.
struct ActivityToolRecordRow: View {
    let record: ActivityNarrativeGroup.ToolCallRecord

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                CodeStatusGlyph(status, size: 11)
                Text(record.summary)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: JunoSpace.snug)
                Text(record.toolName)
                    .junoCodeSmall()
                    .junoMetaInk()
                    .lineLimit(1)
                if let seconds = record.durationSeconds {
                    Text(ActivityNarrativeView<EmptyView>.duration(seconds))
                        .junoCodeSmall()
                        .junoMetaInk()
                        .monospacedDigit()
                }
            }
            if let result = record.resultSummary, !result.isEmpty {
                Text(result)
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .lineLimit(2)
                    .padding(.leading, CodeRowMetrics.markColumn + JunoSpace.snug)
            }
            if !record.outputLines.isEmpty {
                OutputWell(
                    lines: record.outputLines.suffix(8).map { ($0, ToolOutputChannel.stdout) },
                    maxHeight: 120
                )
                .padding(.leading, CodeRowMetrics.markColumn + JunoSpace.snug)
            }
        }
        .padding(.vertical, JunoSpace.hairline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(record.summary), \(record.status.rawValue)")
    }

    private var status: CodeRunStatus {
        switch record.status {
        case .proposed: CodeRunStatus(CodeRunState.queued)
        case .running: CodeRunStatus(CodeRunState.running)
        case .succeeded: CodeRunStatus(CodeRunState.finished)
        case .failed: CodeRunStatus(CodeRunState.failed)
        case .denied: CodeRunStatus(CodeRunState.needsApproval)
        case .cancelled: CodeRunStatus(CodeRunState.stopped)
        }
    }
}
