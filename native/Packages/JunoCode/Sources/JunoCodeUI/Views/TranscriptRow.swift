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
    /// Selects a session in the sidebar.
    var openSession: @MainActor @Sendable (CodeSessionID) -> Void = { _ in }
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
        openSession: @escaping @MainActor @Sendable (CodeSessionID) -> Void = { _ in },
        depth: Int = 0
    ) {
        self.events = events
        self.pendingApprovalIDs = pendingApprovalIDs
        self.loadSubAgent = loadSubAgent
        self.openSession = openSession
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

    /// The context for a sub-agent's own transcript.
    func child(events: [SessionEvent]) -> TranscriptContext {
        TranscriptContext(
            events: events,
            pendingApprovalIDs: [],
            loadSubAgent: loadSubAgent,
            openSession: openSession,
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
            fileChangeRow(change)
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
    /// The checkpoint indicator is the honest half of this row: it says whether
    /// the change can still be undone. A change with no checkpoint cannot be
    /// reverted from the Changes tab, and the reader deserves to know that at
    /// the moment it happens rather than when Reject fails.
    private func fileChangeRow(_ change: FileChangedEvent) -> some View {
        ActivityRow(
            glyph: glyphName(for: change.kind),
            tint: tint(for: change.kind),
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
            }
        }
    }

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

    private func glyphName(for kind: FileChangeKind) -> String {
        switch kind {
        case .created: return "plus.circle.fill"
        case .modified: return "pencil.circle.fill"
        case .deleted: return "minus.circle.fill"
        case .moved: return "arrow.right.circle.fill"
        }
    }

    /// Deletion is the one file change that carries risk, so it is the one that
    /// gets a colour. The rest stay secondary: forty coral glyphs down the
    /// transcript is noise, not emphasis.
    private func tint(for kind: FileChangeKind) -> Color {
        kind == .deleted ? .junoDanger : .secondary
    }

    private func accessibilityText(for change: FileChangedEvent) -> String {
        var text = "\(change.kind.rawValue) \(change.path.value)"
        if change.linesAdded > 0 { text += ", \(change.linesAdded) added" }
        if change.linesRemoved > 0 { text += ", \(change.linesRemoved) removed" }
        text += change.checkpointID != nil ? ", revertible" : ", not revertible"
        return text
    }

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
struct ReasoningRow: View {
    let text: String
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var firstLine: String {
        text.split(separator: "\n").first.map(String.init) ?? text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    Image(systemName: "sparkles")
                        .imageScale(.small)
                        .frame(width: 18)
                    Text(expanded ? "Reasoning" : firstLine)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reasoning")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows how Juno approached this step")

            if expanded {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 18 + JunoSpace.snug)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
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

    /// The sub-agent this call delegated to, when it got far enough to create
    /// one. Correlated through the marker line the tool returns, which is the
    /// only link there is: a child is an ordinary session with no parent field.
    private var childSessionID: CodeSessionID? {
        guard proposed.toolName == SubagentDigest.toolName,
              context.depth == 0,
              let summary = completion?.resultSummary
        else { return nil }
        return SubagentDigest.childSessionID(in: summary)
    }

    /// Only an unfinished or failed call is worth opening on sight. A succeeded
    /// call with output the reader did not ask for is noise.
    private var hasDetail: Bool {
        !output.isEmpty
            || !(completion?.resultSummary.isEmpty ?? true)
            || childSessionID != nil
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
                        Text(proposed.toolName)
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
            if let childSessionID {
                SubAgentTranscript(childSessionID: childSessionID, context: context)
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

/// A delegated sub-agent's own transcript, expandable in place.
///
/// The child is a real session in the same store, so it renders through the same
/// rows as its parent rather than through a summary of them — a sub-agent that
/// read six files and concluded the wrong thing is only inspectable if its steps
/// are the same shape as everything else in the window. Loaded when the reader
/// asks, because a run can delegate several times and eagerly reading every
/// child's transcript would mean a disk read per row.
struct SubAgentTranscript: View {
    let childSessionID: CodeSessionID
    let context: TranscriptContext

    @State private var events: [SessionEvent] = []
    @State private var loaded = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: JunoSpace.hairline) {
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text("Sub-agent transcript")
                    }
                    .font(.caption)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Sub-agent transcript")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")

                Button("Open sub-agent") {
                    context.openSession(childSessionID)
                }
                .buttonStyle(.link)
                .font(.caption)
                .help("Select this sub-agent's session in the sidebar")

                Spacer(minLength: 0)
            }

            if expanded {
                if loaded, events.isEmpty {
                    Text("This sub-agent's transcript is no longer in the store.")
                        .junoCaption()
                } else if !loaded {
                    ProgressView().controlSize(.small)
                } else {
                    // Left rule rather than a nested card: the child's rows are
                    // the same rows, one indent in.
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        ForEach(events) { event in
                            TranscriptRow(event: event, context: context.child(events: events))
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
        }
        .task(id: expanded) {
            guard expanded, !loaded else { return }
            events = await context.loadSubAgent(childSessionID)
            loaded = true
        }
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
