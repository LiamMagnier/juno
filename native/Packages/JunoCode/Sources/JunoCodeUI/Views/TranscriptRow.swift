import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Everything a transcript row needs beyond the event itself.
///
/// Rows take this rather than a ``SessionController`` for two reasons. The first
/// is correctness: a sub-agent's transcript is a *different* session's event
/// list, and a row that reached into the parent controller would correlate a
/// child's tool call against the parent's completions and find nothing. The
/// second is cost — the previous rows each scanned the whole event array to find
/// their own completion and output, so a long run was quadratic in the number of
/// tool calls. The indices below are built once per transcript.
struct TranscriptContext {
    let events: [SessionEvent]
    /// Approvals still awaiting an answer. Those are rendered as the pinned card
    /// above the composer, so the transcript shows only the resolved ones.
    let pendingApprovalIDs: Set<String>
    /// Loads a sub-agent's own transcript from the shared session store.
    var loadSubAgent: @MainActor @Sendable (CodeSessionID) async -> [SessionEvent] = { _ in [] }
    /// Loads the current diff for one changed path, against its oldest
    /// checkpoint. Nil where the change predates a checkpoint or the file is
    /// gone — in which case the row simply does not offer to open.
    var loadDiff: @MainActor @Sendable (String) async -> TextDiff? = { _ in nil }
    /// The sub-agents this session delegated, grouped by the call that asked for
    /// them, so a `delegate_task` row can show its own agents without walking
    /// the event list again.
    var subagents: [String: [SubagentRun]] = [:]
    /// What each running sub-agent is doing right now, keyed by its session.
    var subagentActivity: [CodeSessionID: String] = [:]
    /// Retries the parent session's most recent user turn. Child transcripts do
    /// not receive this action: a sub-agent cannot be resent from inside its
    /// parent's read-only embedded view.
    var retryLastTurn: @MainActor @Sendable () async -> Void = {}
    /// 0 for the session's own transcript, 1 inside a sub-agent's. A child never
    /// nests further: `DelegateTaskTool` cannot delegate, so there is nothing
    /// deeper to show, and an unbounded tree in a transcript is a maze.
    var depth = 0

    private let completions: [String: ToolCompletedEvent]
    private let outputs: [String: [ToolOutputEvent]]
    private let approvalDecisions: [String: ApprovalDecision]

    init(
        events: [SessionEvent],
        pendingApprovalIDs: Set<String> = [],
        loadSubAgent: @escaping @MainActor @Sendable (CodeSessionID) async -> [SessionEvent]
            = { _ in [] },
        loadDiff: @escaping @MainActor @Sendable (String) async -> TextDiff? = { _ in nil },
        subagents: [SubagentRun] = [],
        subagentActivity: [CodeSessionID: String] = [:],
        retryLastTurn: @escaping @MainActor @Sendable () async -> Void = {},
        depth: Int = 0
    ) {
        self.events = events
        self.pendingApprovalIDs = pendingApprovalIDs
        self.loadSubAgent = loadSubAgent
        self.loadDiff = loadDiff
        self.subagents = Dictionary(grouping: subagents, by: \.toolCallID)
        self.subagentActivity = subagentActivity
        self.retryLastTurn = retryLastTurn
        self.depth = depth
        var completions: [String: ToolCompletedEvent] = [:]
        var outputs: [String: [ToolOutputEvent]] = [:]
        var approvalDecisions: [String: ApprovalDecision] = [:]
        for event in events {
            switch event.payload {
            case let .toolCompleted(completed):
                completions[completed.toolCallID] = completed
            case let .toolOutput(chunk):
                outputs[chunk.toolCallID, default: []].append(chunk)
            case let .approvalResolved(resolved):
                approvalDecisions[resolved.approvalID] = resolved.decision
            default:
                break
            }
        }
        self.completions = completions
        self.outputs = outputs
        self.approvalDecisions = approvalDecisions
    }

    func completion(forToolCall id: String) -> ToolCompletedEvent? { completions[id] }
    func output(forToolCall id: String) -> [ToolOutputEvent] { outputs[id] ?? [] }
    func decision(forApproval id: String) -> ApprovalDecision? { approvalDecisions[id] }

    /// The sub-agents one `delegate_task` call asked for, in the order it asked.
    func subagents(forToolCall id: String) -> [SubagentRun] {
        subagents[id] ?? []
    }

    /// The context for a sub-agent's own transcript.
    func child(events: [SessionEvent]) -> TranscriptContext {
        TranscriptContext(
            events: events,
            pendingApprovalIDs: [],
            loadSubAgent: loadSubAgent,
            loadDiff: loadDiff,
            depth: depth + 1
        )
    }
}

/// Renders one transcript event in the agent canvas.
///
/// The transcript is a **timeline of machine activity**, not a chat log, and the
/// redesign makes it read like one. Every event that is not a message renders
/// through ``ActivityRow``: a fixed 18pt glyph column, a title, and trailing
/// metadata. That single shared shape is what lets a reader scan forty events
/// down the left edge and find the one failure, which the previous build — six
/// bespoke row layouts with six different insets and three different corner
/// radii — did not allow.
///
/// Messages are the exception, and are deliberately the only thing in the
/// transcript that is full-bleed: the agent's prose is the content, everything
/// else is provenance.
struct TranscriptRow: View {
    let event: SessionEvent
    let context: TranscriptContext

    var body: some View {
        switch event.payload {
        case let .turnConfiguration(configuration):
            TurnContractRow(configuration: configuration)
        case let .userPrompt(prompt):
            userRow(prompt.text)
        case let .assistantMessage(message):
            assistantRow(message.text)
        case let .reasoningSummary(summary):
            ReasoningRow(text: summary.summary)
        case let .toolProposed(proposed):
            ToolActivityRow(proposed: proposed, context: context)
        case let .approvalRequested(request):
            if !context.pendingApprovalIDs.contains(request.id) {
                resolvedApprovalRow(request)
            }
        case let .fileChanged(change):
            FileChangeRow(change: change, context: context)
        case let .testRunCompleted(run):
            testRow(run)
        case let .errorOccurred(error):
            errorRow(error)
        case let .runCompleted(completed):
            completionRow(completed)
        default:
            EmptyView()
        }
    }

    // MARK: - Messages

    /// The reader's own turn. Right-aligned and bounded so it reads as *sent*,
    /// on the raised surface with a hairline rather than a coral wash — a tinted
    /// block of body text is harder to read and spends the accent on the one
    /// thing in the transcript that needs no emphasis.
    private func userRow(_ text: String) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: JunoSpace.region)
            Text(text)
                .junoBody()
                .textSelection(.enabled)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug + 1)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                        .fill(Color.junoRaised)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                        .strokeBorder(Color.junoBorder)
                )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(text)")
    }

    /// The agent's prose, through the shared Markdown renderer so a fenced code
    /// block, a table or a list looks identical in Code and in Chat. The
    /// previous build passed the raw string to `Text(LocalizedStringKey:)`,
    /// which rendered `**bold**` but dropped every block construct — and treated
    /// agent output as a localisation key.
    ///
    /// A plan is prose here too. Neither `SessionEventPayload` nor the runtime
    /// carries a structured plan or task list, so the ordered list the agent
    /// writes is rendered as the ordered list it is, rather than dressed up as a
    /// checklist whose boxes nothing could ever tick.
    private func assistantRow(_ text: String) -> some View {
        JunoMarkdownText(text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Juno said: \(text)")
    }

    // MARK: - Activity

    private func resolvedApprovalRow(_ request: ApprovalRequest) -> some View {
        let approved = context.decision(forApproval: request.id) == .approved
        return ActivityRow(
            glyph: approved ? "checkmark.shield.fill" : "xmark.shield.fill",
            tint: approved ? .junoSuccess : .junoDanger,
            title: request.summary,
            subtitle: approved ? "Approved" : "Denied",
            accessibilityLabel: "\(request.summary), \(approved ? "approved" : "denied")"
        )
    }

    /// A file the agent touched. The filename stays whole and only the
    /// directory truncates, so a 90-character path still identifies its file at
    /// a 900pt window width.
    ///

    private func testRow(_ run: TestRunCompletedEvent) -> some View {
        ActivityRow(
            glyph: run.passed ? "checkmark.seal.fill" : "xmark.seal.fill",
            tint: run.passed ? .junoSuccess : .junoDanger,
            title: run.passed ? "Tests passed" : "Tests failed",
            subtitle: testDetail(run),
            accessibilityLabel: "\(run.passed ? "Tests passed" : "Tests failed"), \(testDetail(run))"
        )
    }

    /// An error is the one activity row allowed to wrap: truncating the reason a
    /// run failed to one line is how a reader ends up with no idea what went
    /// wrong.
    private func errorRow(_ error: ErrorEvent) -> some View {
        let tint: Color = error.isRecoverable ? .junoCaution : .junoDanger
        return HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: "exclamationmark.triangle.fill")
                .imageScale(.small)
                .foregroundStyle(tint)
                .frame(width: 18, alignment: .center)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(error.message)
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if error.isRecoverable {
                    Text("Recoverable — the agent can continue.")
                        .junoCaption()
                }
            }
            Spacer(minLength: 0)
            if error.isRecoverable {
                Button {
                    Task { await context.retryLastTurn() }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(tint)
                .help("Retry the last user message")
                .accessibilityLabel("Retry the last message")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(tint.opacity(0.10))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(error.message)")
    }

    /// The run's closing summary. This is the only transcript element with a
    /// heavier weight, because it is the one a reader scrolls back to find.
    private func completionRow(_ completed: RunCompletedEvent) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: "flag.checkered")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text("Run finished")
                    .font(.system(.callout, weight: .semibold))
                Spacer(minLength: JunoSpace.snug)
                Text(durationText(completed.durationSeconds))
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            if !completed.summary.isEmpty {
                Text(completed.summary)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 18 + JunoSpace.snug)
            }

            // Wraps rather than truncating: on a 900pt window with the
            // inspector open these two facts would otherwise collide.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: JunoSpace.regular) { completionFacts(completed) }
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    completionFacts(completed)
                }
            }
            .junoCaption()
            .padding(.leading, 18 + JunoSpace.snug)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder)
        )
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func completionFacts(_ completed: RunCompletedEvent) -> some View {
        Label(
            "\(PathDisplay.fileCount(completed.filesChanged)) changed",
            systemImage: "doc.badge.gearshape"
        )
        if let testsPassed = completed.testsPassed {
            Label(
                testsPassed ? "Tests green" : "Tests failing",
                systemImage: testsPassed ? "checkmark.seal" : "xmark.seal"
            )
            .foregroundStyle(testsPassed ? Color.junoSuccess : Color.junoDanger)
        }
    }

    // MARK: - Helpers


    /// Deletion is the one file change that carries risk, so it is the one that
    /// gets a colour. The rest stay secondary: forty coral glyphs down the
    /// transcript is noise, not emphasis.


    private func testDetail(_ run: TestRunCompletedEvent) -> String {
        var parts: [String] = [run.command]
        if let testsRun = run.testsRun {
            parts.append("\(testsRun) tests")
        }
        if let failures = run.failures, failures > 0 {
            parts.append("\(failures) failed")
        }
        parts.append(durationText(run.durationSeconds))
        return parts.joined(separator: " · ")
    }

    private func durationText(_ seconds: Double) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : String(format: "%dm %02ds", Int(seconds) / 60, Int(seconds) % 60)
    }
}

// MARK: - Turn contract

/// What the turn that follows was allowed to do.
///
/// Mode, model and reasoning effort are chosen in the composer for the *next*
/// message, so without this line the record could not say whether the edit three
/// turns ago happened under Ask-before-changes or full access. It is deliberately
/// the quietest thing in the transcript — a caption, aligned with the user turn
/// it belongs to — because it is provenance, not content.
struct TurnContractRow: View {
    let configuration: TurnConfigurationEvent
    @Environment(\.codeModelDisplayNames) private var modelNames

    private var modelName: String {
        modelNames[configuration.modelID] ?? configuration.modelID
    }

    private var text: String {
        [
            configuration.behavior.rawValue.capitalized,
            modelName,
            PermissionModeLabel.text(for: configuration.effectivePermissionMode),
        ].joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            Spacer(minLength: JunoSpace.region)
            Image(systemName: PermissionModeLabel.glyph(for: configuration.effectivePermissionMode))
                .imageScale(.small)
                .accessibilityHidden(true)
            Text(text)
                .lineLimit(1)
                .truncationMode(.middle)
            // Medium is the default and goes unsaid. Everything else is stated,
            // including Instant — a turn that deliberately did no thinking is at
            // least as worth recording as one that did extra.
            if let effort = configuration.reasoningEffort {
                if effort != .medium {
                    Text("· \(effort.rawValue) reasoning").lineLimit(1)
                }
            } else {
                Text("· thinking off").lineLimit(1)
            }
        }
        .junoCaption()
        .padding(.horizontal, JunoSpace.cozy)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("This turn ran as \(text)")
    }
}

/// Model identifiers are opaque; only the workbench knows what to call them.
/// Passed down the transcript rather than into every row's initialiser, because
/// exactly one row in a hundred needs it.
struct CodeModelDisplayNamesKey: EnvironmentKey {
    static let defaultValue: [String: String] = [:]
}

extension EnvironmentValues {
    var codeModelDisplayNames: [String: String] {
        get { self[CodeModelDisplayNamesKey.self] }
        set { self[CodeModelDisplayNamesKey.self] = newValue }
    }
}

// MARK: - Shared activity shape

/// The one row shape every non-message transcript event uses.
///
/// Fixed 18pt glyph column, a title that never wraps, an optional subtitle that
/// truncates from whichever end keeps the identifying part, and a trailing
/// accessory. Nothing here paints a background — an activity row is a line in a
/// timeline, and forty stacked cards is a worse transcript than forty lines.
struct ActivityRow<Accessory: View>: View {
    let glyph: String
    var tint: Color = .secondary
    let title: String
    var titleIsCode = false
    var subtitle: String?
    var subtitleTruncation: Text.TruncationMode = .tail
    var accessibilityLabel: String?
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: glyph)
                .imageScale(.small)
                .foregroundStyle(tint)
                .frame(width: 18, alignment: .center)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Group {
                    if titleIsCode {
                        Text(title).junoCode()
                    } else {
                        Text(title).font(.callout)
                    }
                }
                .lineLimit(1)
                .truncationMode(.middle)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .junoCodeSmall()
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(subtitleTruncation)
                }
            }

            Spacer(minLength: JunoSpace.snug)
            accessory()
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}

extension ActivityRow where Accessory == EmptyView {
    init(
        glyph: String,
        tint: Color = .secondary,
        title: String,
        titleIsCode: Bool = false,
        subtitle: String? = nil,
        subtitleTruncation: Text.TruncationMode = .tail,
        accessibilityLabel: String? = nil
    ) {
        self.init(
            glyph: glyph,
            tint: tint,
            title: title,
            titleIsCode: titleIsCode,
            subtitle: subtitle,
            subtitleTruncation: subtitleTruncation,
            accessibilityLabel: accessibilityLabel,
            accessory: { EmptyView() }
        )
    }
}

/// `+12 −3`, with the zero side omitted rather than shown as `+0`.
struct DiffStat: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if added > 0 {
                Text("+\(added)")
                    .foregroundStyle(Color.junoSuccess)
            }
            if removed > 0 {
                Text("−\(removed)")
                    .foregroundStyle(Color.junoDanger)
            }
        }
        .junoCodeSmall()
        .monospacedDigit()
        .accessibilityHidden(true)
    }
}

// MARK: - Reasoning

/// The agent's reasoning summary, collapsed by default.
///
/// Reasoning is provenance, not content: expanded by default it pushes the
/// answer off-screen. Collapsed it stays one quiet line the reader can open.
/// The agent's reasoning, in AIcss's viewport.
///
/// What that replaced: a stock `sparkles` glyph beside the trace's first line,
/// which opened into the whole trace as one unbounded `Text`. Two problems, and
/// the same two chat had. The glyph was a system symbol for "AI" rather than
/// anything of Juno's. And the expanded state had no ceiling: a long trace pushed
/// every row after it — including the tool calls the reader was following — off the
/// screen, so opening the reasoning cost you your place in the session.
///
/// The viewport caps at 180pt and masks, and the collapsed line count is now the
/// trace's own paragraphs rather than whichever line happened to be first.
struct ReasoningRow: View {
    let text: String

    private var lines: [String] {
        JunoAIcssReasoningLines.lines(text: text)
    }

    var body: some View {
        JunoAIcssReasoningStream(lines: lines, streaming: false)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .accessibilityLabel("Reasoning")
            .accessibilityHint("Shows how Juno approached this step")
    }
}

// MARK: - Tool activity

/// A proposed/running/finished tool call with expandable streamed output.
struct ToolActivityRow: View {
    let proposed: ToolProposedEvent
    let context: TranscriptContext
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var completion: ToolCompletedEvent? {
        context.completion(forToolCall: proposed.toolCallID)
    }

    private var output: [ToolOutputEvent] {
        context.output(forToolCall: proposed.toolCallID)
    }

    private var isRunning: Bool { completion == nil }

    /// The sub-agents this call delegated, live.
    ///
    /// They exist from the moment the call is authorised, not from the moment it
    /// returns: the runtime records each agent's lifecycle in this transcript, so
    /// a delegation in flight is a named list of agents with their own statuses
    /// rather than a spinner on a row called `delegate_task`. Nested only one
    /// deep, because a sub-agent cannot delegate.
    private var delegated: [SubagentRun] {
        guard proposed.toolName == SubagentDigest.toolName, context.depth == 0 else {
            return []
        }
        return context.subagents(forToolCall: proposed.toolCallID)
    }

    /// Only an unfinished or failed call is worth opening on sight. A succeeded
    /// call with output the reader did not ask for is noise.
    private var hasDetail: Bool {
        !output.isEmpty
            || !(completion?.resultSummary.isEmpty ?? true)
            || !delegated.isEmpty
    }

    /// "2 running · 1 done" — what a delegation is doing, on the collapsed row.
    ///
    /// This replaced the tool's own name as the subtitle for `delegate_task`.
    /// The name said nothing a reader could act on while four agents worked
    /// underneath it, and the row was the only thing on screen describing them.
    private var delegationSubtitle: String? {
        let runs = delegated
        guard !runs.isEmpty else { return nil }
        // Queued is counted apart from running rather than folded into it. An
        // agent waiting for a concurrency slot — or for the reader to authorise
        // the call — is not working, and saying it is would be the row claiming
        // progress that is not happening.
        let queued = runs.filter { $0.status == .queued || $0.status == .preparing }.count
        let running = runs.filter { $0.status == .running || $0.status == .waitingForApproval }
            .count
        let done = runs.count - queued - running
        var parts: [String] = []
        if running > 0 { parts.append("\(running) running") }
        if queued > 0 { parts.append("\(queued) queued") }
        if done > 0 { parts.append("\(done) done") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard hasDetail else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    statusIcon
                        .frame(width: 18, alignment: .center)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(proposed.summary)
                            .font(.callout)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(delegationSubtitle ?? proposed.toolName)
                            .junoCodeSmall()
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: JunoSpace.snug)

                    if let completion {
                        Text(String(format: "%.1fs", completion.durationSeconds))
                            .junoCodeSmall()
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    } else {
                        ProgressView().controlSize(.mini)
                    }

                    if hasDetail {
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.tight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)
            .accessibilityLabel(accessibilityText)
            .accessibilityValue(hasDetail ? (expanded ? "Expanded" : "Collapsed") : "")

            if expanded {
                detail
                    .padding(.leading, JunoSpace.cozy + 18 + JunoSpace.snug)
                    .padding(.trailing, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(isRunning ? Color.junoRowHover : Color.clear)
        )
    }

    @ViewBuilder
    private var detail: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if let completion, !completion.resultSummary.isEmpty {
                Text(completion.resultSummary)
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !output.isEmpty {
                OutputWell(lines: output.map { ($0.text, $0.channel) }, maxHeight: 200)
            }
            ForEach(delegated) { run in
                SubAgentTranscript(run: run, context: context)
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        if let completion {
            switch completion.status {
            case .succeeded:
                Image(systemName: "checkmark.circle.fill")
                    .imageScale(.small)
                    .foregroundStyle(Color.junoSuccess)
            case .failed:
                Image(systemName: "xmark.circle.fill")
                    .imageScale(.small)
                    .foregroundStyle(Color.junoDanger)
            case .denied:
                Image(systemName: "hand.raised.fill")
                    .imageScale(.small)
                    .foregroundStyle(Color.junoCaution)
            case .cancelled:
                Image(systemName: "stop.circle.fill")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
            }
        } else {
            ProgressView().controlSize(.mini)
        }
    }

    private var accessibilityText: String {
        var text = proposed.summary
        if let completion {
            text += ", \(completion.status.rawValue)"
        } else {
            text += ", running"
        }
        return text
    }
}

// MARK: - Sub-agents

/// One delegated sub-agent, in the conversation that delegated it.
///
/// This is the "behind the scenes, but visible" half of delegation. The agent is
/// named, its state is live, and its own steps open *here* — under the call that
/// asked for them, in the parent's own transcript. There is deliberately no way
/// out of this row: the previous build offered "Open sub-agent", which swapped
/// the whole workbench onto the child's session and left the reader in a second
/// conversation they then had to navigate back out of. Everything that link led
/// to is below it instead.
///
/// The child's transcript is loaded when the reader asks, because a run can
/// delegate four agents and eagerly reading every one of them would mean a disk
/// read per row. It reloads while the agent is still working, because a
/// transcript read once mid-run would freeze at whatever the agent had done at
/// the moment it was opened.
struct SubAgentTranscript: View {
    let run: SubagentRun
    let context: TranscriptContext

    @State private var events: [SessionEvent] = []
    @State private var loaded = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var activity: String {
        guard run.isActive else { return "" }
        if let child = run.childSessionID,
           let live = context.subagentActivity[child],
           !live.isEmpty
        {
            return live
        }
        return run.currentActivity
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Button {
                guard run.childSessionID != nil else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    SubagentStatusGlyph(status: run.status)
                        .frame(width: 14, alignment: .center)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(run.title)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if !activity.isEmpty {
                            Text(activity)
                                .junoCodeSmall()
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: JunoSpace.snug)
                    SubagentElapsed(run: run)
                    if run.childSessionID != nil {
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(run.childSessionID == nil)
            .accessibilityLabel(SubagentFormatting.accessibilityLabel(run))
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows this sub-agent's own steps in place")

            if expanded, let childSessionID = run.childSessionID {
                Group {
                    if loaded, events.isEmpty {
                        Text("This sub-agent has not recorded anything yet.")
                            .junoCaption()
                    } else if !loaded {
                        ProgressView().controlSize(.small)
                    } else {
                        // Left rule rather than a nested card: the child's rows
                        // are the same rows, one indent in.
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            ForEach(events) { event in
                                TranscriptRow(
                                    event: event,
                                    context: context.child(events: events)
                                )
                            }
                        }
                        .padding(.leading, JunoSpace.snug)
                        .overlay(alignment: .leading) {
                            Rectangle()
                                .fill(Color.junoSeparator)
                                .frame(width: 1)
                        }
                    }
                }
                // Keyed on the activity as well as on the disclosure, so an open
                // row follows the agent instead of showing the three steps it
                // had taken when it was opened.
                .task(id: TranscriptLoadKey(expanded: expanded, activity: activity)) {
                    events = await context.loadSubAgent(childSessionID)
                    loaded = true
                }
            }
        }
    }
}

/// What an open sub-agent row is currently showing. Reloading is keyed on this
/// rather than on the disclosure alone, so a running agent's steps keep
/// arriving and a finished one is read exactly once.
private struct TranscriptLoadKey: Equatable {
    let expanded: Bool
    let activity: String
}

/// A sub-agent's status as one glyph, shared by the transcript and the panel so
/// the same agent cannot read as two different states in two places.
struct SubagentStatusGlyph: View {
    let status: SubagentStatus

    var body: some View {
        switch status {
        case .queued, .preparing:
            Image(systemName: "clock")
                .imageScale(.small)
                .foregroundStyle(.secondary)
        case .running:
            ProgressView().controlSize(.small)
        case .waitingForApproval:
            Image(systemName: "hand.raised.fill")
                .imageScale(.small)
                .foregroundStyle(Color.junoCaution)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .imageScale(.small)
                .foregroundStyle(Color.junoSuccess)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .imageScale(.small)
                .foregroundStyle(Color.junoDanger)
        case .cancelled:
            Image(systemName: "stop.circle.fill")
                .imageScale(.small)
                .foregroundStyle(.secondary)
        case .interrupted:
            Image(systemName: "bolt.horizontal.circle.fill")
                .imageScale(.small)
                .foregroundStyle(Color.junoCaution)
        }
    }
}

/// How long a sub-agent has been working, or how long it took.
///
/// An active agent ticks: the row is the only place a reader can see that a
/// delegated investigation is progressing rather than wedged, and a static
/// "started 4 minutes ago" answers a different question. It ticks once a second
/// from the agent's own recorded start — never from the delegating call's
/// proposal, which would silently include however long the call waited for an
/// approval.
struct SubagentElapsed: View {
    let run: SubagentRun

    var body: some View {
        if run.isActive, let startedAt = run.startedAt {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                text(timeline.date.timeIntervalSince(startedAt))
            }
        } else if let seconds = run.durationSeconds {
            text(seconds)
        }
    }

    private func text(_ seconds: Double) -> some View {
        Text(SubagentFormatting.duration(max(0, seconds)))
            .junoCodeSmall()
            .foregroundStyle(.tertiary)
            .monospacedDigit()
            .accessibilityHidden(true)
    }
}

/// Fixed-width machine output on the shared terminal well.
///
/// Command output is column-aligned, so it scrolls sideways rather than
/// wrapping — soft-wrapping breaks the alignment and doubles the height of
/// every line. `stderr` is tinted rather than prefixed, because a prefix would
/// shift the columns it is trying to preserve.
struct OutputWell: View {
    let lines: [(text: String, channel: ToolOutputChannel)]
    var maxHeight: CGFloat = 200

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.text)
                        .junoCodeSmall()
                        .foregroundStyle(
                            line.channel == .stderr
                                ? AnyShapeStyle(Color.junoDanger)
                                : AnyShapeStyle(.secondary)
                        )
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(JunoSpace.snug)
        }
        .frame(maxHeight: maxHeight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoTerminal)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .strokeBorder(Color.junoSeparator)
        )
    }
}

// MARK: - File changes

private func glyphName(for kind: FileChangeKind) -> String {
    switch kind {
    case .created: return "plus.circle.fill"
    case .modified: return "pencil.circle.fill"
    case .deleted: return "minus.circle.fill"
    case .moved: return "arrow.right.circle.fill"
    }
}

private func fileChangeTint(for kind: FileChangeKind) -> Color {
    kind == .deleted ? .junoDanger : .secondary
}

private func accessibilityText(for change: FileChangedEvent) -> String {
    var text = "\(change.kind.rawValue) \(change.path.value)"
    if change.linesAdded > 0 { text += ", \(change.linesAdded) added" }
    if change.linesRemoved > 0 { text += ", \(change.linesRemoved) removed" }
    text += change.checkpointID != nil ? ", revertible" : ", not revertible"
    return text
}

/// A file the agent changed, and — on demand — what it changed.
///
/// The row itself is unchanged: filename, directory, the checkpoint indicator and
/// the +/− stat. What is new is that it opens.
///
/// The stat was the whole answer before: "+12 −3" and nothing else, with the diff
/// itself two panes away in the Changes tab. So the transcript could tell you that
/// something had been rewritten under you while you were reading, and could not
/// tell you what — which is the moment a reader most wants to look, and the moment
/// they were most likely to lose their place going to find out.
///
/// The diff is fetched only when the row is opened, and only once. A session can
/// touch hundreds of files, each diff is a checkpoint read plus a file read plus a
/// Myers diff, and doing that eagerly for rows nobody opens would make scrolling
/// the transcript pay for content nobody asked for.
private struct FileChangeRow: View {
    let change: FileChangedEvent
    let context: TranscriptContext

    @State private var expanded = false
    @State private var diff: TextDiff?
    @State private var loaded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A deletion has no "after" to diff against, and a change with no checkpoint
    /// has no "before". Neither can open, and neither pretends it can.
    private var canOpen: Bool {
        change.kind != .deleted && change.checkpointID != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Button {
                guard canOpen else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                ActivityRow(
                    glyph: glyphName(for: change.kind),
                    tint: fileChangeTint(for: change.kind),
                    title: PathDisplay.fileName(change.path.value),
                    titleIsCode: true,
                    subtitle: PathDisplay.directory(change.path.value),
                    subtitleTruncation: .head,
                    accessibilityLabel: accessibilityText(for: change)
                ) {
                    HStack(spacing: JunoSpace.tight) {
                        if change.checkpointID != nil {
                            Image(systemName: "arrow.uturn.backward.circle")
                                .foregroundStyle(.tertiary)
                                .help("Checkpointed before this edit — this change can be reverted")
                                .accessibilityHidden(true)
                        }
                        DiffStat(added: change.linesAdded, removed: change.linesRemoved)
                        if canOpen {
                            Image(systemName: "chevron.right")
                                .imageScale(.small)
                                .foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                        }
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!canOpen)
            .accessibilityValue(canOpen ? (expanded ? "Expanded" : "Collapsed") : "")

            if expanded {
                Group {
                    if let diff, !diff.hunks.isEmpty {
                        // One block per hunk, each with its own header, because a
                        // hunk is the unit the line numbers restart at — running
                        // them together would number the second hunk from the
                        // first one's end and quietly point at the wrong lines.
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            ForEach(Array(diff.hunks.enumerated()), id: \.offset) { _, hunk in
                                JunoAIcssDiff(
                                    file: PathDisplay.fileName(change.path.value),
                                    rows: rows(of: hunk)
                                )
                            }
                        }
                    } else if loaded {
                        // Loaded and empty is a fact worth stating: the file was
                        // touched and then put back, so the record has a change
                        // event and the content has none.
                        Text("No differences against the checkpoint.")
                            .junoCaption()
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(.leading, JunoSpace.cozy + 18 + JunoSpace.snug)
                .padding(.trailing, JunoSpace.cozy)
                .task(id: expanded) {
                    guard !loaded else { return }
                    diff = await context.loadDiff(change.path.value)
                    loaded = true
                }
            }
        }
    }

    /// `DiffLine` → the AIcss row. A straight crossing: both carry the kind, the
    /// text and both line numbers, so nothing is derived and nothing is dropped.
    private func rows(of hunk: DiffHunk) -> [JunoAIcssDiffRow] {
        hunk.lines.enumerated().map { index, line in
            let kind: JunoAIcssDiffRow.Kind =
                switch line.kind {
                case .added: .added
                case .removed: .removed
                case .context: .context
                }
            return JunoAIcssDiffRow(
                id: index,
                old: line.oldLineNumber,
                new: line.newLineNumber,
                kind: kind,
                text: line.text
            )
        }
    }
}
