import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Messages

/// The reader's message: a quiet bubble on the trailing side, so the eye can
/// find the turn boundaries without reading.
///
/// `action` hangs off the bubble's leading edge and is told whether the row is
/// hovered, so a per-message action — Rewind — can stay out of sight until it
/// is wanted. An overlay rather than a column beside the bubble: an action
/// nobody can see must not take width from the message.
struct StudioUserMessage<Action: View>: View {
    let text: String
    var caption: String?
    @ViewBuilder var action: (_ isHovered: Bool) -> Action

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
            Text(text)
                .studioReadingFont()
                .foregroundStyle(Studio.Ink.primary)
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.horizontal, JunoSpace.cozy + 2)
                .padding(.vertical, JunoSpace.snug + 1)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.card + 4, style: .continuous)
                        .fill(Studio.Surface.muted)
                )
                .accessibilityElement(children: .combine)
                .accessibilityLabel("You: \(text)")
                .overlay(alignment: .leading) {
                    action(hovering)
                        .alignmentGuide(.leading) { $0[.trailing] + JunoSpace.tight }
                }
                // A reader's message is a turn marker, not a column: capped
                // so a long prompt does not read as the agent's reply.
                .frame(maxWidth: Studio.Metrics.measure * 0.78, alignment: .trailing)
            if let caption {
                Text(caption)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .padding(.trailing, JunoSpace.snug)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 64)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
    }
}

extension StudioUserMessage where Action == EmptyView {
    init(text: String, caption: String? = nil) {
        self.init(text: text, caption: caption) { _ in EmptyView() }
    }
}

/// The agent's prose. Full width, no bubble: it is the thing being read.
struct StudioAssistantMessage: View {
    let text: String
    var streaming = false

    var body: some View {
        JunoMarkdownText(text, streaming: streaming)
            .studioReadingFont()
            .foregroundStyle(Studio.Ink.primary)
            .lineSpacing(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Disclosure

/// A row that opens: a chevron, a title, trailing facts. The one disclosure
/// idiom in the thread — the audit found five.
struct StudioDisclosureRow<Title: View, Trailing: View, Detail: View>: View {
    @Binding var isExpanded: Bool
    var canExpand = true
    @ViewBuilder var title: () -> Title
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var detail: () -> Detail

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Button {
                guard canExpand else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.chevronRight, size: 11)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .opacity(canExpand ? (hovering || isExpanded ? 1 : 0.55) : 0)
                    title()
                    Spacer(minLength: JunoSpace.snug)
                    trailing()
                }
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .accessibilityAddTraits(canExpand ? .isButton : [])
            .accessibilityValue(canExpand ? (isExpanded ? "Expanded" : "Collapsed") : "")

            if isExpanded {
                detail()
                    .padding(.leading, JunoSpace.cozy + 5)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// MARK: - Activity

/// One stretch of machine work, as one sentence: "Read 4 files · ran 2
/// commands". Opens to the individual steps.
struct StudioActivityRow: View {
    let group: ActivityNarrativeGroup
    let reasoning: [String]
    let density: StudioThreadDensity
    @Binding var isExpanded: Bool
    let openFile: (String) -> Void

    private var isRunning: Bool { group.status == .running }

    /// While a stretch is live, balanced density shows its newest steps under
    /// the sentence, so the reader can see what is happening without opening
    /// anything. They fold away when the stretch ends.
    private var liveTail: [ActivityNarrativeGroup.ToolCallRecord] {
        guard isRunning, density == .balanced, !isExpanded else { return [] }
        return Array(group.toolCallRecords.suffix(2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            StudioDisclosureRow(isExpanded: $isExpanded, canExpand: group.hasDetail) {
                if isRunning {
                    JunoShimmerText(group.title, font: Studio.Font.label, active: true)
                } else {
                    Text(group.title)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.secondary)
                }
            } trailing: {
                HStack(spacing: JunoSpace.snug) {
                    if group.linesAdded > 0 || group.linesRemoved > 0 {
                        StudioDiffStat(added: group.linesAdded, removed: group.linesRemoved)
                    }
                    if let seconds = group.durationSeconds, seconds >= 1 {
                        Text(StudioFormat.duration(seconds))
                            .font(Studio.Font.metaDigits)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
            } detail: {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(reasoning.indices, id: \.self) { index in
                        Text(reasoning[index])
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .italic()
                            .padding(.vertical, 2)
                    }
                    ForEach(group.toolCallRecords) { record in
                        StudioToolLine(record: record, openFile: openFile)
                    }
                }
            }
            ForEach(liveTail) { record in
                StudioToolLine(record: record, openFile: openFile)
                    .padding(.leading, JunoSpace.cozy + 5)
                    .transition(.opacity)
            }
        }
    }
}

/// One step: what it did, to what, and how it went.
struct StudioToolLine: View {
    let record: ActivityNarrativeGroup.ToolCallRecord
    let openFile: (String) -> Void

    @State private var showsOutput = false

    private static let editTools: Set<String> = [
        "create_file", "write_file", "apply_patch", "delete_file", "move_file", "multi_edit",
    ]

    /// The verb and its object, split so the object can be set in monospace.
    private var parts: (verb: String, object: String) {
        let summary = record.summary
        guard let space = summary.firstIndex(of: " ") else { return (summary, "") }
        return (String(summary[..<space]), String(summary[summary.index(after: space)...]))
    }

    private var isEdit: Bool { Self.editTools.contains(record.toolName) }

    private var isCommand: Bool { record.toolName == "run_command" }

    private var hasOutput: Bool { !record.outputLines.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                statusMark
                    .frame(width: 12, height: 12)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(parts.verb)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                if !parts.object.isEmpty {
                    objectLabel
                }
                Spacer(minLength: JunoSpace.snug)
                if hasOutput {
                    Button(showsOutput ? "Hide output" : "Output") { showsOutput.toggle() }
                        .buttonStyle(StudioQuietButtonStyle())
                        .font(Studio.Font.meta)
                }
                if let duration = record.durationSeconds, duration >= 1 {
                    Text(StudioFormat.duration(duration))
                        .font(Studio.Font.metaDigits)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }
            .frame(minHeight: 20)

            if record.status == .failed || record.status == .denied,
               let result = record.resultSummary, !result.isEmpty
            {
                Text(result)
                    .font(Studio.Font.meta)
                    .foregroundStyle(record.status == .failed ? Studio.Ink.danger : Studio.Ink.tertiary)
                    .lineLimit(3)
                    .padding(.leading, 18)
            }
            if showsOutput || (record.status == .failed && hasOutput) {
                StudioOutputWell(
                    lines: record.outputLines,
                    command: isCommand ? parts.object : nil,
                    limit: showsOutput ? 12 : 6
                )
                .padding(.leading, 18)
                .padding(.top, 2)
                .transition(.opacity)
            }
        }
    }

    @ViewBuilder
    private var objectLabel: some View {
        let label = Text(parts.object)
            .font(Studio.Font.mono)
            .foregroundStyle(Studio.Ink.primary.opacity(0.85))
            .lineLimit(1)
            .truncationMode(.middle)
        if isEdit, record.status == .succeeded {
            Button { openFile(parts.object) } label: { label }
                .buttonStyle(.plain)
                .pointerStyle(.link)
                .help("Review this change")
        } else {
            label
        }
    }

    @ViewBuilder
    private var statusMark: some View {
        switch record.status {
        case .proposed, .running:
            StudioSpinner(color: Studio.Ink.secondary, lineWidth: 1.25)
                .frame(width: 9, height: 9)
        case .succeeded:
            JunoIconView(.check, size: 11).foregroundStyle(Studio.Ink.tertiary)
        case .failed:
            JunoIconView(.close, size: 11).foregroundStyle(Studio.Ink.danger)
        case .denied, .cancelled:
            JunoIconView(.circleSlash, size: 11).foregroundStyle(Studio.Ink.tertiary)
        }
    }
}

/// A command's output as a small terminal: the command on the first line
/// after a `$`, then the tail of what it printed, in a monospace well with a
/// hairline. When more was printed than is shown, the first line says how
/// many lines came before, so a reader never mistakes a tail for the whole.
struct StudioOutputWell: View {
    let lines: [String]
    /// The command that printed them, when the row knows it.
    var command: String? = nil
    var limit = 12

    private var shown: ArraySlice<String> { lines.suffix(limit) }
    private var hidden: Int { max(0, lines.count - limit) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let command {
                HStack(spacing: JunoSpace.tight) {
                    Text("$")
                        .foregroundStyle(Studio.Ink.tertiary)
                    Text(command)
                        .foregroundStyle(Studio.Ink.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .font(Studio.Font.monoSmall)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.tight + 1)
                .studioHairline(.bottom)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    if hidden > 0 {
                        Text("… \(hidden) earlier \(hidden == 1 ? "line" : "lines")")
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                    Text(shown.joined(separator: "\n"))
                        .foregroundStyle(Studio.Ink.secondary)
                        .textSelection(.enabled)
                }
                .font(Studio.Font.monoSmall)
                .lineSpacing(2)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .fill(Studio.Surface.muted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }
}

// MARK: - Reasoning

struct StudioReasoningRow: View {
    let text: String
    @Binding var isExpanded: Bool

    var body: some View {
        StudioDisclosureRow(isExpanded: $isExpanded) {
            Text("Reasoning")
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.tertiary)
        } trailing: {
            EmptyView()
        } detail: {
            Text(text)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineSpacing(2)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Small facts

/// An answered approval: "Allowed · Run npm install".
struct StudioDecisionRow: View {
    let summary: String
    let allowed: Bool

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(allowed ? .check : .circleSlash, size: 11)
                .foregroundStyle(Studio.Ink.tertiary)
            Text(allowed ? "Allowed" : "Declined")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            Text(summary)
                .font(Studio.Font.mono)
                .foregroundStyle(Studio.Ink.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.leading, 17)
    }
}

/// What a project hook did, once and quietly: "Blocked by hook
/// .claude/hooks/guard.sh", with the hook's own reason beneath.
///
/// Neutral ink on purpose. A hook doing its job is not an error, and coral is
/// kept for work in flight and for the reader being needed; even a failed
/// hook left the run going, so it reads as a note rather than an alarm.
struct StudioHookRow: View {
    let event: HookActivityEvent

    private var title: String {
        switch event.outcome {
        case .blocked:
            event.hookEvent == "UserPromptSubmit" ? "Not sent. Blocked by hook" : "Blocked by hook"
        case .feedback: "Note from hook"
        case .continued: "Kept working at a hook's request"
        case .stopped: event.hookName.isEmpty ? "Stopped" : "Stopped by hook"
        case .failed: "Hook failed"
        case .message: "Hook"
        }
    }

    private var icon: JunoIcon {
        switch event.outcome {
        case .blocked: .circleSlash
        case .feedback, .message: .message
        case .continued: .rotateCcw
        case .stopped: .circleStop
        case .failed: .triangleAlert
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(icon, size: 11)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .frame(width: 11)
                Text(title)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                if !event.hookName.isEmpty {
                    Text(event.hookName)
                        .font(Studio.Font.mono)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if !event.message.isEmpty {
                Text(event.message)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .lineLimit(4)
                    .textSelection(.enabled)
                    .padding(.leading, 11 + JunoSpace.tight)
            }
        }
        .padding(.leading, 17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [title, event.hookName, event.message].filter { !$0.isEmpty }.joined(separator: ": ")
        )
    }
}

/// The agent's plan, at its latest state.
struct StudioPlanCard: View {
    let goal: SessionGoal

    private var done: Int { goal.steps.filter { $0.status == .completed }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                Text("Plan")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                Text("\(done) of \(goal.steps.count)")
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(goal.steps) { step in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        stepMark(step.status)
                            .frame(width: 12, height: 12)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        Text(step.title)
                            .font(Studio.Font.label)
                            .foregroundStyle(
                                step.status == .completed ? Studio.Ink.tertiary : Studio.Ink.primary
                            )
                            .strikethrough(step.status == .completed, color: Studio.Ink.tertiary)
                    }
                }
            }
        }
        .padding(JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }

    @ViewBuilder
    private func stepMark(_ status: GoalStepStatus) -> some View {
        switch status {
        case .completed:
            JunoIconView(.squareCheck, size: 12).foregroundStyle(Studio.Ink.tertiary)
        case .inProgress:
            StudioSpinner(color: Studio.Ink.accent, lineWidth: 1.25).frame(width: 10, height: 10)
        case .blocked:
            JunoIconView(.circleSlash, size: 12).foregroundStyle(Studio.Ink.danger)
        case .pending:
            JunoIconView(.square, size: 12).foregroundStyle(Studio.Ink.tertiary)
        }
    }
}

/// A delegated sub-agent: what it was asked, where it is, what it said.
struct StudioSubagentRow: View {
    let update: SubagentUpdateEvent
    @Binding var isExpanded: Bool

    private var statusLabel: String { StudioSubagentFormat.label(update.status) }

    private var status: StudioStatus {
        switch update.status {
        case .queued, .preparing, .running: .working
        case .waitingForApproval: .needsYou
        case .failed: .failed
        case .completed, .cancelled, .interrupted: .idle
        }
    }

    var body: some View {
        StudioDisclosureRow(isExpanded: $isExpanded, canExpand: update.summary != nil || update.error != nil) {
            HStack(spacing: JunoSpace.tight) {
                Text("Agent")
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.tertiary)
                Text(update.title)
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.secondary)
                    .lineLimit(1)
                if status != .idle {
                    StudioStatusGlyph(status: status, size: 7)
                }
            }
        } trailing: {
            Text(update.currentActivity.isEmpty ? statusLabel : update.currentActivity)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .lineLimit(1)
        } detail: {
            if let error = update.error {
                Text(error).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
            } else if let summary = update.summary {
                JunoMarkdownText(summary)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
            }
        }
    }
}

struct StudioTestsRow: View {
    let run: TestRunCompletedEvent

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(run.passed ? .check : .close, size: 11)
                .foregroundStyle(run.passed ? Studio.Ink.success : Studio.Ink.danger)
            Text(run.passed ? "Tests passed" : "Tests failed")
                .font(Studio.Font.label)
                .foregroundStyle(run.passed ? Studio.Ink.secondary : Studio.Ink.danger)
            if let count = run.testsRun {
                Text((run.failures ?? 0) > 0 ? "\(run.failures ?? 0) of \(count) failed" : StudioFormat.plural(count, "test"))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            Spacer()
            Text(StudioFormat.duration(run.durationSeconds))
                .font(Studio.Font.metaDigits)
                .foregroundStyle(Studio.Ink.tertiary)
        }
        .padding(.leading, 17)
    }
}

struct StudioErrorRow: View {
    let message: String
    let retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.triangleAlert, size: 12)
                .foregroundStyle(Studio.Ink.danger)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(message)
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(StudioSecondaryButtonStyle())
            }
        }
        .padding(JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .fill(Studio.Ink.danger.opacity(0.07))
        )
    }
}

/// Where the model's context was folded: one quiet divider, the summary
/// behind it.
///
/// The thread itself loses nothing — every turn is still on screen; only what
/// the model is sent shrank — so the summary is not something to read in
/// passing. It is there for the moment a reader wonders what the agent still
/// remembers, which is exactly when a run starts acting as if it forgot.
struct StudioCompactionDivider: View {
    let event: CompactionEvent
    @Binding var isExpanded: Bool

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.cozy) {
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                    HStack(spacing: JunoSpace.tight) {
                        Text("Context compacted")
                            .font(Studio.Font.meta)
                            .foregroundStyle(hovering || isExpanded ? Studio.Ink.secondary : Studio.Ink.tertiary)
                        JunoIconView(.chevronRight, size: 9)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .opacity(hovering || isExpanded ? 1 : 0.55)
                    }
                    .fixedSize()
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                }
                .frame(maxWidth: .infinity, minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .help(isExpanded ? "Hide the summary" : "Show what Juno kept of the earlier conversation")
            .accessibilityLabel("Context compacted")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("juno.code.transcript.compaction")

            if isExpanded {
                detail
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(origin + " · " + event.messageCountSummary)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
            if let focus = event.focus {
                Text("Keeping: \(focus)")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .textSelection(.enabled)
            }
            JunoMarkdownText(event.summary)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineSpacing(2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.transcript.compaction.summary")
    }

    /// Who wrote the summary and why, in the reader's terms.
    private var origin: String {
        switch event.summarySource {
        case .model:
            return event.requestedByUser
                ? "Summarised by the model at your request"
                : "Summarised by the model as the context filled"
        case .structural:
            if let reason = event.fallbackReason {
                return "Kept as notes because \(reason)"
            }
            return event.requestedByUser
                ? "Kept as notes at your request"
                : "Kept as notes as the context filled"
        }
    }
}

/// A centred caption between two hairlines: a mode or model change.
struct StudioDividerCaption: View {
    let text: String

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            Text(text)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .fixedSize()
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
        }
        .padding(.vertical, JunoSpace.hairline)
    }
}

/// How a run ended: "Worked for 2m 14s · 3 files", and the way into review.
struct StudioRunSummary: View {
    let run: RunCompletedEvent
    let turn: StudioThreadItem.TurnTotals
    /// The session's tracked changes for this turn's files, for the card's
    /// rows. Empty draws the card's header alone.
    var changes: [TrackedChange] = []
    let openReview: () -> Void
    var openFile: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            workedDivider
            if !turn.files.isEmpty {
                StudioChangesCard(
                    fileCount: turn.files.count,
                    added: turn.added,
                    removed: turn.removed,
                    changes: changes,
                    openReview: openReview,
                    openFile: openFile
                )
            }
        }
        .padding(.top, JunoSpace.hairline)
    }

    /// "Worked for 1m 1s" between two hairlines: the end of a turn, said once.
    private var workedDivider: some View {
        HStack(spacing: JunoSpace.snug) {
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            HStack(spacing: JunoSpace.tight) {
                Text("Worked for \(StudioFormat.duration(run.durationSeconds))")
                    .foregroundStyle(Studio.Ink.tertiary)
                // Only a failure is worth restating here: a passing run
                // already has its own row just above.
                if run.testsPassed == false {
                    Text("·").foregroundStyle(Studio.Ink.tertiary)
                    Text("tests failed").foregroundStyle(Studio.Ink.danger)
                }
            }
            .font(Studio.Font.meta)
            .fixedSize()
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What a turn changed, as a card at its end: how many files and lines, a
/// five-cell diff bar, Review, and a row per file — its kind as a lettered
/// badge, its name whole and its folder giving way, its own counts. A row
/// opens that file's diff beside the thread.
struct StudioChangesCard: View {
    let fileCount: Int
    let added: Int
    let removed: Int
    let changes: [TrackedChange]
    let openReview: () -> Void
    let openFile: (String) -> Void

    /// More rows than this fold behind "n more files".
    private static let visibleRows = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.fileDiff, size: 13)
                    .foregroundStyle(Studio.Ink.secondary)
                Text("Changed \(StudioFormat.plural(fileCount, "file"))")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                StudioDiffStat(added: added, removed: removed)
                StudioDiffBar(added: added, removed: removed)
                Spacer(minLength: JunoSpace.snug)
                Button("Review", action: openReview)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .help("Open the changes beside the thread (⌥⌘R)")
                    .accessibilityIdentifier("juno.code.transcript.review")
            }
            .padding(.leading, JunoSpace.cozy)
            .padding(.trailing, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)

            if !changes.isEmpty {
                VStack(spacing: 0) {
                    ForEach(changes.prefix(Self.visibleRows)) { change in
                        StudioChangeLine(change: change) { openFile(change.path) }
                    }
                    if changes.count > Self.visibleRows {
                        Button(action: openReview) {
                            Text("\(changes.count - Self.visibleRows) more \(changes.count - Self.visibleRows == 1 ? "file" : "files")")
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, JunoSpace.cozy)
                                .frame(height: 30)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .studioHairline(.top)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .fill(Studio.Surface.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
        .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Changed \(StudioFormat.plural(fileCount, "file")), \(added) lines added, \(removed) removed")
    }
}

/// One file in a changes card.
struct StudioChangeLine: View {
    let change: TrackedChange
    let open: () -> Void

    @State private var hovering = false

    private var name: String { (change.path as NSString).lastPathComponent }
    private var folder: String {
        let parent = (change.path as NSString).deletingLastPathComponent
        return parent.isEmpty ? "" : parent + "/"
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.snug) {
                StudioChangeKindBadge(kind: change.kind)
                Text(name)
                    .font(Studio.Font.mono)
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
                StudioDiffStat(added: change.linesAdded, removed: change.linesRemoved)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 30)
            .background(hovering ? Studio.Surface.hover : Color.clear)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(JunoMotion.fast, value: hovering)
        .help("Review \(change.path)")
        .accessibilityLabel("\(StudioChangeKindBadge.word(change.kind)) \(change.path), \(change.linesAdded) added, \(change.linesRemoved) removed")
    }
}

/// A file's kind as a lettered badge: A added, M modified, D deleted, R
/// renamed, in a small tinted tile so the column of letters reads at a glance.
struct StudioChangeKindBadge: View {
    let kind: FileChangeKind

    static func word(_ kind: FileChangeKind) -> String {
        switch kind {
        case .created: "Added"
        case .modified: "Modified"
        case .deleted: "Deleted"
        case .moved: "Renamed"
        }
    }

    private var letter: (String, Color) {
        switch kind {
        case .created: ("A", Studio.Ink.added)
        case .modified: ("M", Studio.Ink.secondary)
        case .deleted: ("D", Studio.Ink.removed)
        case .moved: ("R", Studio.Ink.secondary)
        }
    }

    var body: some View {
        Text(letter.0)
            .font(Studio.Font.monoSmall.weight(.semibold))
            .foregroundStyle(letter.1)
            .frame(width: 18, height: 18)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                    .fill(letter.1.opacity(0.12))
            )
            .accessibilityHidden(true)
    }
}

/// What a reader can do about a sub-agent, beside its row: answer what it is
/// waiting on, stop it, or — for one that edited an isolated worktree — bring
/// its changes into the checkout or throw them away.
struct StudioSubagentControls: View {
    let controller: SessionController
    let update: SubagentUpdateEvent

    @State private var pending: [ApprovalRequest] = []
    @State private var outcome: String?
    @State private var isApplying = false
    @State private var hasReview = false

    private var childID: CodeSessionID? { update.childSessionID }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(pending, id: \.id) { request in
                HStack(spacing: JunoSpace.snug) {
                    Text(StudioApprovalCopy(request).question)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                    Text(StudioApprovalCopy(request).subject)
                        .font(Studio.Font.mono)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: JunoSpace.snug)
                    Button("Decline") {
                        guard let childID else { return }
                        Task { await controller.denySubagent(childID, approvalID: request.id); await refresh() }
                    }
                    .buttonStyle(StudioQuietButtonStyle())
                    Button("Allow") {
                        guard let childID else { return }
                        Task { await controller.approveSubagent(childID, approvalID: request.id); await refresh() }
                    }
                    .buttonStyle(StudioPrimaryButtonStyle())
                }
                .padding(JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                        .strokeBorder(Studio.Ink.accent.opacity(0.45))
                )
            }
            if !update.status.isTerminal, childID != nil, pending.isEmpty {
                Button("Stop agent") {
                    guard let childID else { return }
                    Task { await controller.stopSubagent(childID) }
                }
                .buttonStyle(StudioQuietButtonStyle())
            }
            if hasReview, update.status == .completed, update.executionMode == .workspaceWrite, outcome == nil {
                HStack(spacing: JunoSpace.snug) {
                    Text("Its changes are in a separate worktree.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                    Spacer()
                    Button("Discard") {
                        guard let childID else { return }
                        Task {
                            outcome = await controller.discardSubagentChanges(childID)
                                ? "Discarded." : (controller.transientError ?? "Could not discard.")
                        }
                    }
                    .buttonStyle(StudioQuietButtonStyle())
                    Button(isApplying ? "Applying…" : "Apply changes") {
                        guard let childID else { return }
                        isApplying = true
                        Task {
                            outcome = await controller.applySubagentChanges(childID)
                                ? "Applied to the checkout." : (controller.transientError ?? "Could not apply.")
                            isApplying = false
                        }
                    }
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .disabled(isApplying)
                }
            }
            if let outcome {
                Text(outcome).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
            }
        }
        .padding(.leading, JunoSpace.cozy + 5)
        .task(id: "\(update.status.rawValue)-\(childID?.value ?? "")") {
            await refresh()
            // Approvals arrive from the child's own run. The runtime marks the
            // row as waiting when one does, but a request must never depend on
            // that alone: an unanswered one holds the child and the parent's
            // turn until Stop. So a live child is looked at every second, and a
            // request that has run out its time is declined on the same tick,
            // as the session's own approval card does.
            while !update.status.isTerminal || !pending.isEmpty, let childID, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await controller.sweepSubagentApprovals(childID)
                await refresh()
            }
        }
    }

    private func refresh() async {
        guard let childID else { return }
        pending = await controller.subagentPendingApprovals(childID)
        if update.status == .completed, update.executionMode == .workspaceWrite {
            hasReview = await controller.subagentWorktreeReview(childID) != nil
        }
    }
}

/// A sub-agent's status, in the words its row uses. Never a friendlier word
/// than the truth: a stopped agent must not read as done.
enum StudioSubagentFormat {
    static func label(_ status: SubagentStatus) -> String {
        switch status {
        case .queued: "Queued"
        case .preparing: "Starting"
        case .running: "Working"
        case .waitingForApproval: "Needs you"
        case .completed: "Done"
        case .failed: "Failed"
        case .cancelled: "Stopped"
        case .interrupted: "Interrupted"
        }
    }
}
