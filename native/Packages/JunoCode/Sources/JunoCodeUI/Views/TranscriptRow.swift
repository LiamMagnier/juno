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
    /// Opens the review pane, optionally on one file. The completion card's
    /// diff stat is the bridge from "the run finished" to "look at what it
    /// did", and it lands here rather than the row reaching for the controller.
    var openReview: @MainActor @Sendable (String?) -> Void = { _ in }
    /// Opens the Create pull request sheet, or nil where the session cannot
    /// open one — no repository, a read-only mode, a preview.
    var createPullRequest: (() -> Void)?
    /// The session's current diff totals, for the completion card's pill:
    /// lines added, lines removed, files changed.
    var diffTotals: (added: Int, removed: Int, files: Int) = (0, 0, 0)

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
        depth: Int = 0,
        openReview: @escaping @MainActor @Sendable (String?) -> Void = { _ in },
        createPullRequest: (() -> Void)? = nil,
        diffTotals: (added: Int, removed: Int, files: Int) = (0, 0, 0)
    ) {
        self.events = events
        self.pendingApprovalIDs = pendingApprovalIDs
        self.loadSubAgent = loadSubAgent
        self.loadDiff = loadDiff
        self.subagents = Dictionary(grouping: subagents, by: \.toolCallID)
        self.subagentActivity = subagentActivity
        self.retryLastTurn = retryLastTurn
        self.depth = depth
        self.openReview = openReview
        self.createPullRequest = createPullRequest
        self.diffTotals = diffTotals
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
        case let .userInstruction(instruction):
            instructionRow(instruction)
        case let .assistantMessage(message):
            assistantRow(message.text)
        case let .reasoningSummary(summary):
            ReasoningRow(text: summary.summary)
        case let .toolProposed(proposed):
            ToolActivityRow(proposed: proposed, startedAt: event.timestamp, context: context)
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
        case let .compaction(compaction):
            CompactionRow(event: compaction)
        default:
            EmptyView()
        }
    }

    // MARK: - Messages

    /// The reader's own turn: a small centred timestamp, then their words as a
    /// quiet bubble on the right — a secondary fill, no shadow, no coral — so
    /// the two voices in the thread are told apart by side and depth rather
    /// than by a coloured pill.
    private func userRow(_ text: String) -> some View {
        VStack(spacing: JunoSpace.snug) {
            TranscriptTimestamp(date: event.timestamp)
            HStack(spacing: 0) {
                Spacer(minLength: JunoSpace.region)
                Text(text)
                    .junoBody()
                    .junoInk()
                    .textSelection(.enabled)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.cozy)
                    .junoInsetWell()
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(text)")
    }

    private func instructionRow(_ instruction: UserInstructionEvent) -> some View {
        VStack(spacing: JunoSpace.snug) {
            TranscriptTimestamp(date: event.timestamp)
            HStack(spacing: 0) {
                Spacer(minLength: JunoSpace.region)
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text(instruction.kind == .steer ? "Steering" : "Queued follow-up")
                        .junoCaption()
                        .junoSecondaryInk()
                    Text(instruction.text)
                        .junoBody()
                        .junoInk()
                        .textSelection(.enabled)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.cozy)
                .junoInsetWell()
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(instruction.kind == .steer ? "Steering instruction" : "Queued follow-up"): \(instruction.text)"
        )
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
            .padding(.horizontal, JunoSpace.tight)
            .accessibilityLabel("Juno said: \(text)")
    }

    // MARK: - Activity

    private func resolvedApprovalRow(_ request: ApprovalRequest) -> some View {
        let approved = context.decision(forApproval: request.id) == .approved
        return ActivityRow(
            icon: approved ? .check : .close,
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
            icon: run.passed ? .check : .error,
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
            JunoIconView(.error, size: 15)
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
                    JunoIconLabel(verbatim: "Retry", icon: .refresh, size: 14)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
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

    /// The run's closing card: the summary, the evidence, and the way into
    /// review.
    ///
    /// The diff stat is a *button* — `+12 −3 · 4 files` opens the review pane
    /// on the first changed file — because that is the moment a reader most
    /// wants to look, and the audit's finding was that getting to a diff took
    /// three clicks through the inspector. It is the one raised surface in the
    /// transcript besides the reader's own prompts, so completion evidence is
    /// distinguishable from prose at a glance.
    private func completionRow(_ completed: RunCompletedEvent) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.check, size: 15)
                    .foregroundStyle(Color.junoSuccess)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text("Run finished")
                    .font(.callout.weight(.semibold))
                Spacer(minLength: JunoSpace.snug)
                Text(durationText(completed.durationSeconds))
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .monospacedDigit()
            }

            if !completed.summary.isEmpty {
                JunoMarkdownText(completed.summary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 18 + JunoSpace.snug)
            }

            // Wraps rather than truncating: on a 900pt window with the
            // inspector open these facts would otherwise collide.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: JunoSpace.cozy) { completionFacts(completed) }
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    completionFacts(completed)
                }
            }
            .padding(.leading, 18 + JunoSpace.snug)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.transcript.completion")
    }

    @ViewBuilder
    private func completionFacts(_ completed: RunCompletedEvent) -> some View {
        let totals = context.diffTotals
        let files = totals.files > 0 ? totals.files : completed.filesChanged
        if files > 0 {
            Button {
                context.openReview(nil)
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    DiffStatPill(added: totals.added, removed: totals.removed, files: files)
                    JunoIconView(.chevronRight, size: 11)
                        .junoMetaInk()
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.capsule)
            }
            .buttonStyle(.junoPress)
            .help("Review the changes (⌥⌘R)")
            .accessibilityLabel("Review \(PathDisplay.fileCount(files)), \(totals.added) added, \(totals.removed) removed")
            .accessibilityIdentifier("juno.code.transcript.completion.review")
        } else {
            JunoIconLabel(verbatim: "No files changed", icon: .file, size: 14)
                .junoCaption()
        }
        if let testsPassed = completed.testsPassed {
            JunoIconLabel(
                verbatim: testsPassed ? "Tests green" : "Tests failing",
                icon: testsPassed ? .check : .error,
                size: 14
            )
            .junoCaption()
            .foregroundStyle(testsPassed ? Color.junoSuccess : Color.junoDanger)
        }
        if files > 0, let createPullRequest = context.createPullRequest {
            Button {
                createPullRequest()
            } label: {
                JunoIconLabel(verbatim: "Create pull request", icon: .pulls, size: 13)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .accessibilityIdentifier("juno.code.transcript.completion.pull-request")
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
            JunoIconView(
                PermissionModeLabel.junoIcon(for: configuration.effectivePermissionMode),
                size: 13
            )
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
    let icon: JunoIcon
    var tint: Color = .junoMutedForeground
    let title: String
    var titleIsCode = false
    var subtitle: String?
    var subtitleTruncation: Text.TruncationMode = .tail
    var accessibilityLabel: String?
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 15)
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
                        .junoMetaInk()
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
        icon: JunoIcon,
        tint: Color = .junoMutedForeground,
        title: String,
        titleIsCode: Bool = false,
        subtitle: String? = nil,
        subtitleTruncation: Text.TruncationMode = .tail,
        accessibilityLabel: String? = nil
    ) {
        self.init(
            icon: icon,
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

/// `+12 −3 · 4 files`, as one capsule: the completion card's way into review.
struct DiffStatPill: View {
    let added: Int
    let removed: Int
    let files: Int

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text("+\(added)")
                .foregroundStyle(Color.junoSuccess)
            Text("−\(removed)")
                .foregroundStyle(Color.junoDanger)
            Text("·").junoMetaInk()
            Text(PathDisplay.fileCount(files))
                .junoInk()
        }
        .junoCodeSmall()
        .monospacedDigit()
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
        .background(Color.junoMuted, in: Capsule(style: .continuous))
        .overlay(Capsule(style: .continuous).strokeBorder(Color.junoHairline))
        .accessibilityHidden(true)
    }
}

/// The model's context was folded. One quiet line: it is provenance, not
/// content, and a reader who did not ask for it only needs to know why the
/// agent may now be working from a summary of the early turns.
struct CompactionRow: View {
    let event: CompactionEvent
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.refresh, size: 13)
                        .junoMetaInk()
                        .frame(width: 18)
                    Text(event.requestedByUser ? "Context compacted" : "Context compacted automatically")
                    Text("· \(event.messageCountSummary)")
                        .junoMetaInk()
                    if let tokens = event.beforeTokens {
                        Text("· was \(JunoModelFormatting.contextWindow(tokens))")
                            .junoMetaInk()
                    }
                    Spacer(minLength: JunoSpace.snug)
                    JunoIconView(.chevronRight, size: 11)
                        .junoMetaInk()
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .junoCaption()
                .padding(.horizontal, JunoSpace.cozy)
                .frame(minHeight: CodeRowMetrics.minHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Context compacted, \(event.messageCountSummary)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows the summary the model now works from")

            if expanded {
                Text(event.summary)
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, JunoSpace.cozy + 18 + JunoSpace.snug)
                    .padding(.trailing, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
            }
        }
        .accessibilityIdentifier("juno.code.transcript.compaction")
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
        JunoAIcssReasoningStream(lines: lines, streaming: false, label: "Reasoning")
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .accessibilityLabel("Reasoning")
            .accessibilityHint("Shows how Juno approached this step")
    }
}

// MARK: - Tool activity

/// A proposed/running/finished tool call with expandable streamed output.
///
/// **The row is drawn at its final geometry from the first frame.** Both slots
/// that change when the call returns — the status mark and the duration — are
/// fixed-width, so a transcript with six calls in flight does not re-flow six
/// times as they land. A row that resizes on completion makes the whole column
/// jump under the reader's eye at exactly the moment they are trying to read
/// the result that caused it.
///
/// Neither slot spins, either. A running call shows the vocabulary's running
/// mark and a live elapsed count, which passes the still-frame test: paused,
/// "1.4s" and climbing is a different picture from "1.4s" and stuck, where two
/// paused spinners are the same picture.
struct ToolActivityRow: View {
    let proposed: ToolProposedEvent
    /// When the call was proposed — the clock the live elapsed count runs from.
    let startedAt: Date
    let context: TranscriptContext
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The duration column's width, chosen so the longest value it can hold
    /// ("120.0s") fits without the column moving. Both states use it.
    private static let durationColumn: CGFloat = 46

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
                            .junoMetaInk()
                            .lineLimit(1)
                    }

                    Spacer(minLength: JunoSpace.snug)

                    Group {
                        if let completion {
                            Text(String(format: "%.1fs", completion.durationSeconds))
                        } else {
                            // The one place a `TimelineView` earns its keep: a
                            // number that is genuinely changing once a second,
                            // in the slot the final number will occupy.
                            TimelineView(.periodic(from: startedAt, by: 1)) { timeline in
                                Text(
                                    String(
                                        format: "%.1fs",
                                        max(0, timeline.date.timeIntervalSince(startedAt))
                                    )
                                )
                            }
                        }
                    }
                    .junoCodeSmall()
                    .junoMetaInk()
                    .monospacedDigit()
                    .frame(width: Self.durationColumn, alignment: .trailing)

                    if hasDetail {
                        JunoIconView(.chevronRight, size: 11)
                            .junoMetaInk()
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.tight)
                .frame(minWidth: 44, minHeight: 44)
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
                    .junoSecondaryInk()
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

    /// The call's state, in the window's one status vocabulary.
    ///
    /// It used to be four locally-declared symbols plus a spinner, which is
    /// four of the six loose glyphs the audit counted. `CodeStatusGlyph` draws
    /// the same four concepts in the same circle family the sidebar and the
    /// page header use, at a fixed width, swapped in place on `fast`.
    private var statusIcon: some View {
        CodeStatusGlyph(status, size: 12)
    }

    private var status: CodeRunStatus {
        guard let completion else { return CodeRunStatus(CodeRunState.running) }
        switch completion.status {
        case .succeeded: return CodeRunStatus(CodeRunState.finished)
        case .failed: return CodeRunStatus(CodeRunState.failed)
        // A denied call is one a person stopped, which is what
        // `needsApproval`'s caution mark says everywhere else in the window.
        case .denied: return CodeRunStatus(CodeRunState.needsApproval)
        case .cancelled: return CodeRunStatus(CodeRunState.stopped)
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
                                .junoMetaInk()
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: JunoSpace.snug)
                    SubagentElapsed(run: run)
                    if run.childSessionID != nil {
                        JunoIconView(.chevronRight, size: 11)
                            .junoMetaInk()
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
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
///
/// It draws through ``CodeStatusGlyph``, which is what makes that sentence true
/// across surfaces rather than only across these two. This used to be a second
/// status vocabulary with its own table — a `clock` where the run table draws
/// `circle.dotted`, a `hand.raised.fill` where it draws
/// `exclamationmark.circle.fill`, and a `ProgressView` for running, which is a
/// spinner inside a transcript row that also re-flows the row when it resolves.
/// A delegated agent and the run that delegated it therefore reported the same
/// four states in two different alphabets, a few hundred pixels apart.
///
/// The projection below is the whole of the difference between the two enums,
/// stated once. `SubagentStatus` is the wire vocabulary from
/// `runner/agent-core`'s `AgentEvent` union — `SessionEvents.swift` copies its
/// raw values character-for-character and says so — so it is not ours to
/// change; mapping it is correct where renaming it would not be.
struct SubagentStatusGlyph: View {
    let status: SubagentStatus

    /// `preparing` folds into `queued` because the distinction — accepted
    /// versus building its tool registry — is real to the runtime and invisible
    /// to a reader watching a list. `interrupted` maps to `hostOffline` rather
    /// than to `stopped`: both mean the process went away without being asked,
    /// which is the caution-coloured "something ended this for you" state, and
    /// `stopped` is reserved for the case where somebody chose it.
    private var runState: CodeRunState {
        switch status {
        case .queued, .preparing: .queued
        case .running: .running
        case .waitingForApproval: .needsApproval
        case .completed: .finished
        case .failed: .failed
        case .cancelled: .stopped
        case .interrupted: .hostOffline
        }
    }

    var body: some View {
        CodeStatusGlyph(CodeRunStatus(runState), size: 11)
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
            .junoMetaInk()
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
                                : AnyShapeStyle(Color.junoMutedForeground)
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
            RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                .fill(Color.junoTerminal)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                .strokeBorder(Color.junoSeparator)
        )
    }
}

// MARK: - File changes

private func fileChangeIcon(for kind: FileChangeKind) -> JunoIcon {
    switch kind {
    case .created: return .plus
    case .modified: return .pencil
    case .deleted: return .close
    case .moved: return .external
    }
}

private func fileChangeTint(for kind: FileChangeKind) -> Color {
    kind == .deleted ? .junoDanger : .junoMutedForeground
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
                    icon: fileChangeIcon(for: change.kind),
                    tint: fileChangeTint(for: change.kind),
                    title: PathDisplay.fileName(change.path.value),
                    titleIsCode: true,
                    subtitle: PathDisplay.directory(change.path.value),
                    subtitleTruncation: .head,
                    accessibilityLabel: accessibilityText(for: change)
                ) {
                    HStack(spacing: JunoSpace.tight) {
                        if change.checkpointID != nil {
                            JunoIconView(.refresh, size: 14)
                                .junoMetaInk()
                                .help("Checkpointed before this edit — this change can be reverted")
                                .accessibilityHidden(true)
                        }
                        DiffStat(added: change.linesAdded, removed: change.linesRemoved)
                        if canOpen {
                            JunoIconView(.chevronRight, size: 11)
                                .junoMetaInk()
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                        }
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
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
                            .junoSecondaryInk()
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

// MARK: - The inset well

extension View {
    /// The reader's own words, recessed into the page.
    ///
    /// The brief's one depth cue for the transcript: agent prose is flat on
    /// the canvas, a user prompt is a gently inset well — a secondary fill with
    /// an inner hairline, no shadow — so the two voices are told apart by
    /// depth rather than by a coloured bubble. Card radius, so the bubble and
    /// the composer it came from share a curve.
    func junoInsetWell() -> some View {
        background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoMuted.opacity(0.7))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }
}

/// A small centred monospaced time above the reader's turn — the one
/// timestamp a thread needs, since everything between two prompts is the
/// agent's reply to the first.
struct TranscriptTimestamp: View {
    let date: Date

    var body: some View {
        Text(date, format: .dateTime.hour().minute())
            .junoCodeSmall()
            .junoMetaInk()
            .monospacedDigit()
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}
