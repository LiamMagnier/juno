import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Messages

/// The reader's message: a quiet bubble on the trailing side, so the eye can
/// find the turn boundaries without reading.
struct StudioUserMessage: View {
    let text: String
    var caption: String?

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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
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
                StudioOutputWell(lines: record.outputLines)
                    .padding(.leading, 18)
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

/// The tail of a command's output, in a quiet monospace well.
struct StudioOutputWell: View {
    let lines: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(lines.suffix(12).joined(separator: "\n"))
                .font(Studio.Font.monoSmall)
                .foregroundStyle(Studio.Ink.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .padding(JunoSpace.snug)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                .fill(Studio.Surface.muted)
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

/// A centred caption between two hairlines: context compacted, mode changed.
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
    let openReview: () -> Void

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("Worked for \(StudioFormat.duration(run.durationSeconds))")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
            // Only a failure is worth restating here: a passing run already
            // has its own row just above.
            if run.testsPassed == false {
                Text("·").foregroundStyle(Studio.Ink.tertiary)
                Text("tests failed")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }
            Spacer()
            if !turn.files.isEmpty {
                Button(action: openReview) {
                    HStack(spacing: JunoSpace.tight) {
                        Text("Review \(StudioFormat.plural(turn.files.count, "file"))")
                            .font(Studio.Font.label)
                        StudioDiffStat(added: turn.added, removed: turn.removed)
                    }
                }
                .buttonStyle(StudioSecondaryButtonStyle())
                .help("Open the changes beside the thread (⌥⌘R)")
            }
        }
        .padding(.top, JunoSpace.hairline)
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
            // Approvals arrive from the child's own run; while it is waiting,
            // look again every second until nothing is outstanding.
            while update.status == .waitingForApproval, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
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
