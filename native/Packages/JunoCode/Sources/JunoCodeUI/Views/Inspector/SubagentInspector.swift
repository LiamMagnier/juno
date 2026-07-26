import AppKit
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The index over everything this session delegated.
///
/// The transcript already shows a `delegate_task` call where it happened, with
/// the child's rows nested under it. This is the other view of the same facts:
/// one row per delegation, in the order they were proposed, so a run that
/// delegated six times can be read as a list instead of by scrolling the whole
/// transcript looking for them.
///
/// Everything on a row is a recorded value. The delegating call's own state
/// comes from the parent transcript (`SubagentDigest`); the child's status,
/// steps and result are read from the session store when the row is opened. The
/// two are kept visibly separate because they can legitimately disagree — a
/// delegating call that failed still leaves a child session behind.
struct SubagentSection: View {
    let controller: SessionController
    /// Selects a sub-agent's own session in the sidebar. Absent when the host
    /// has no selection to drive, in which case the row still expands in place
    /// and the control is not offered at all rather than offered and inert.
    var selectSession: ((CodeSessionID) -> Void)?

    var body: some View {
        let runs = controller.subagents
        Section {
            if runs.isEmpty {
                Text("No task has been delegated in this session.")
                    .junoCaption()
            } else {
                ForEach(runs) { run in
                    SubagentRow(
                        run: run,
                        controller: controller,
                        selectSession: selectSession
                    )
                    // Opaque and raised, not glass: this is content a reader
                    // studies, and the section reads as one panel of divided
                    // rows rather than as loose text on the inspector.
                    .listRowBackground(Color.junoRaised)
                }
            }
        } header: {
            HStack(spacing: JunoSpace.tight) {
                Text("Sub-agents")
                Spacer(minLength: 0)
                if !runs.isEmpty {
                    Text("\(runs.count)")
                        .junoCaption()
                        .monospacedDigit()
                        .help(
                            runs.count == 1
                                ? "1 delegated task"
                                : "\(runs.count) delegated tasks"
                        )
                }
            }
        } footer: {
            if !runs.isEmpty {
                Text(
                    "A sub-agent runs as its own read-only session. Its steps and result are read from that session."
                )
                .junoCaption()
            }
        }
    }
}

// MARK: - One delegated task

/// One delegation: what was asked, what state the asking call is in, and — once
/// it has one — what its sub-agent's own session recorded.
///
/// The child is loaded when the row is opened rather than kept in sync. The
/// delegating tool blocks until the child finishes, so there is no intermediate
/// state to stream, and reading on demand keeps a long-finished sub-agent out of
/// the parent's live state. `Reload` exists for the one case where the stored
/// value can move underneath the row: a child that was still active when it was
/// first read.
private struct SubagentRow: View {
    let run: SubagentRun
    let controller: SessionController
    var selectSession: ((CodeSessionID) -> Void)?

    /// What the store returned for the child session.
    ///
    /// `.missing` is a real answer rather than an error — a session can be
    /// deleted, and the preview harness has no store at all — so it is a case
    /// the row can state plainly instead of a `nil` it would have to guess
    /// about.
    private enum ChildLoad: Equatable {
        case idle
        case loading
        case loaded(SubagentDetail)
        case missing
    }

    @State private var isExpanded = false
    @State private var load: ChildLoad = .idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            header
            if isExpanded {
                expansion
            }
        }
        .padding(.vertical, JunoSpace.hairline)
        .task(id: isExpanded) {
            guard isExpanded, load == .idle, let childID = run.childSessionID else { return }
            await reload(childID)
        }
    }

    // MARK: Header

    private var header: some View {
        Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                stateGlyph
                    .frame(width: JunoSpace.regular, alignment: .center)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(run.title)
                        .junoRowLabel()
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    meta
                }
                Spacer(minLength: JunoSpace.tight)
                Image(systemName: "chevron.right")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint("Shows the delegated task and what the sub-agent did")
        .accessibilityIdentifier("juno.code.activity.subagent")
    }

    private var meta: some View {
        HStack(spacing: JunoSpace.tight) {
            if let role = run.role {
                SubagentRoleChip(role: role)
            }
            Text(stateLabel)
                .junoCaption()
                .foregroundStyle(stateTint)
            Spacer(minLength: 0)
            timing
        }
    }

    /// A duration exists only once the delegating call has completed. Until
    /// then this shows when the task was delegated, which is a recorded fact —
    /// an elapsed time counted from the proposal would silently include however
    /// long the call waited for an approval.
    @ViewBuilder
    private var timing: some View {
        if let seconds = run.durationSeconds {
            Text(SubagentFormatting.duration(seconds))
                .junoCodeSmall()
                .foregroundStyle(.tertiary)
                .monospacedDigit()
                .help("How long the delegating call took")
        } else {
            Text(run.proposedAt, style: .relative)
                .junoCodeSmall()
                .foregroundStyle(.tertiary)
                .monospacedDigit()
                .help("How long ago this task was delegated")
        }
    }

    @ViewBuilder
    private var stateGlyph: some View {
        switch run.state {
        case .pending:
            Image(systemName: "clock")
                .imageScale(.small)
                .foregroundStyle(.secondary)
        case .running:
            ProgressView().controlSize(.small)
        case let .finished(status):
            Image(systemName: SubagentFormatting.glyph(status))
                .imageScale(.small)
                .foregroundStyle(SubagentFormatting.tint(status))
        }
    }

    // MARK: Expansion

    /// Indented to the title's leading edge — the glyph column plus its gap —
    /// so the detail reads as belonging to the row above it.
    private var expansion: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if showsTask {
                field("Task", text: run.task)
            }
            if let result = SubagentFormatting.resultBody(run.resultSummary) {
                field("Result", text: result)
            }
            child
        }
        .padding(.leading, JunoSpace.regular + JunoSpace.snug)
    }

    /// The title is the task's first line when the model passed no `title`, so
    /// a row whose title *is* the whole task would otherwise print it twice.
    private var showsTask: Bool { run.title != run.task }

    @ViewBuilder
    private var child: some View {
        if let childID = run.childSessionID {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                childHeader(childID)
                childBody(childID)
            }
        } else {
            Text(unlinkedChildExplanation).junoCaption()
        }
    }

    /// Why there is no child session to open.
    ///
    /// `CodeSession` carries no parent identifier: the only link between a
    /// delegation and its sub-agent is the marker line `DelegateTaskTool` writes
    /// into its result. When that line is absent the link genuinely does not
    /// exist, and saying so is the only honest option — there is nothing to
    /// search the store by.
    private var unlinkedChildExplanation: String {
        switch run.state {
        case .pending:
            "This delegation has not started, so there is no sub-agent session yet."
        case .running:
            "The sub-agent's own session is linked when the delegating call returns."
        case .finished:
            "This result records no sub-agent session, so its transcript cannot be linked: sessions carry no parent, and the identifier in the result is the only link there is."
        }
    }

    private func childHeader(_ childID: CodeSessionID) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(spacing: JunoSpace.tight) {
                Text("Sub-agent session").junoSidebarSection()
                Spacer(minLength: 0)
                if let selectSession {
                    Button("Open") { selectSession(childID) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help("Select this sub-agent's session in the sidebar")
                        .accessibilityIdentifier("juno.code.activity.subagent.open")
                }
            }
            HStack(spacing: JunoSpace.tight) {
                Text(childID.value)
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(childID.value, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Copy this sub-agent's session identifier")
                .accessibilityLabel("Copy sub-agent session identifier")
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func childBody(_ childID: CodeSessionID) -> some View {
        switch load {
        case .idle, .loading:
            ProgressView().controlSize(.small)

        case .missing:
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Juno could not read this session from the session store.")
                    .junoCaption()
                reloadButton(childID)
            }

        case let .loaded(detail):
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.tight) {
                    Text(SubagentFormatting.label(detail.session.status))
                        .junoCaption()
                        .foregroundStyle(SubagentFormatting.tint(detail.session.status))
                    Spacer(minLength: 0)
                    reloadButton(childID)
                }

                if detail.steps.isEmpty {
                    Text("This sub-agent recorded no tool calls.").junoCaption()
                } else {
                    ForEach(detail.steps) { step in
                        stepRow(step)
                    }
                }

                childAnswer(detail)
            }
        }
    }

    /// The child's own last message.
    ///
    /// Shown only when the delegating call has not already carried it up:
    /// `DelegateTaskTool` returns the child's answer as its result, so printing
    /// both would be the same paragraph twice under two different headings.
    @ViewBuilder
    private func childAnswer(_ detail: SubagentDetail) -> some View {
        if SubagentFormatting.resultBody(run.resultSummary) == nil {
            if let answer = detail.answer {
                field("Sub-agent result", text: answer)
            } else if detail.session.status.isActive {
                Text("This sub-agent has not written a result yet.").junoCaption()
            } else {
                Text("This sub-agent ended without writing a result.").junoCaption()
            }
        }
    }

    private func stepRow(_ step: SubagentDetail.Step) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            Image(systemName: SubagentFormatting.glyph(step.status))
                .imageScale(.small)
                .foregroundStyle(SubagentFormatting.tint(step.status))
            Text(step.summary)
                .junoCaption()
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(step.summary), \(SubagentFormatting.label(step.status))")
    }

    private func reloadButton(_ childID: CodeSessionID) -> some View {
        Button("Reload") {
            Task { await reload(childID) }
        }
        .buttonStyle(.link)
        .font(.caption)
        .disabled(load == .loading)
        .help("Read this sub-agent's session from the store again")
        .accessibilityIdentifier("juno.code.activity.subagent.reload")
    }

    private func field(_ label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(label).junoSidebarSection()
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Loading

    @MainActor
    private func reload(_ childID: CodeSessionID) async {
        load = .loading
        if let detail = await controller.subAgentDetail(childID) {
            load = .loaded(detail)
        } else {
            load = .missing
        }
    }

    // MARK: Labels

    private var stateLabel: String {
        switch run.state {
        case .pending: "Waiting to start"
        case .running: "Running"
        // The recorded completion status, never a friendlier word for it: a
        // denied delegation must not read as "finished".
        case let .finished(status): status.rawValue.capitalized
        }
    }

    private var stateTint: Color {
        switch run.state {
        case .pending: .secondary
        case .running: .junoAccent
        case let .finished(status): SubagentFormatting.tint(status)
        }
    }

    private var accessibilitySummary: String {
        var parts = [run.title]
        if let role = run.role {
            parts.append(role.rawValue.capitalized)
        }
        parts.append(stateLabel)
        if let seconds = run.durationSeconds {
            parts.append(SubagentFormatting.duration(seconds))
        }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Role

/// The role the delegation asked for.
///
/// Absent when the call named none — `SubagentRun.role` is optional for exactly
/// that case — and then nothing is drawn. The tool's own fallback is a runtime
/// detail, and a chip claiming a role the caller never wrote would be inventing
/// the record.
private struct SubagentRoleChip: View {
    let role: AgentRole

    var body: some View {
        Label(role.rawValue.capitalized, systemImage: symbol)
            .font(.caption)
            .imageScale(.small)
            .foregroundStyle(.secondary)
            .padding(.horizontal, JunoSpace.tight)
            .padding(.vertical, JunoSpace.hairline)
            .background(Capsule().fill(Color.junoRowSelected))
            .accessibilityLabel("\(role.rawValue.capitalized) role")
    }

    private var symbol: String {
        switch role {
        case .engineer: "hammer"
        case .reviewer: "checkmark.seal"
        case .explainer: "text.book.closed"
        }
    }
}

// MARK: - Formatting

/// Presentation for recorded sub-agent values. Kept in one place so the row and
/// its expansion cannot describe the same status with two different words.
enum SubagentFormatting {
    /// "12.4s" / "3m 07s". A tool call's duration is recorded in seconds and is
    /// commonly sub-minute, so seconds keep a decimal and minutes do not.
    static func duration(_ seconds: Double) -> String {
        guard seconds >= 60 else { return String(format: "%.1fs", seconds) }
        let whole = Int(seconds.rounded())
        return String(format: "%dm %02ds", whole / 60, whole % 60)
    }

    /// A `delegate_task` result with its correlation marker removed.
    ///
    /// `DelegateTaskTool` returns `Sub-agent session: <id>` as the first line
    /// and the child's answer beneath it. The identifier is shown as an
    /// identifier elsewhere on the row, so printing it again inside the result
    /// text would be noise. Returns `nil` when nothing is left, which is the
    /// case for a call that was denied before it produced anything.
    static func resultBody(_ summary: String?) -> String? {
        guard let summary else { return nil }
        var lines = summary.split(separator: "\n", omittingEmptySubsequences: false)
        if let first = lines.first,
           first.trimmingCharacters(in: .whitespaces).hasPrefix(SubagentDigest.sessionMarker)
        {
            lines.removeFirst()
        }
        let body = lines
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? nil : body
    }

    static func glyph(_ status: ToolCompletionStatus?) -> String {
        switch status {
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .denied: "hand.raised.fill"
        case .cancelled: "stop.circle.fill"
        // A proposed step with no completion event: the call is either still
        // open or the transcript ends mid-step.
        case nil: "circle.dotted"
        }
    }

    static func tint(_ status: ToolCompletionStatus?) -> Color {
        switch status {
        case .succeeded: .junoSuccess
        case .failed: .junoDanger
        case .denied, .cancelled: .junoCaution
        case nil: .secondary
        }
    }

    static func label(_ status: ToolCompletionStatus?) -> String {
        switch status {
        case .some(let status): status.rawValue.capitalized
        case nil: "No completion recorded"
        }
    }

    /// The child session's own status, spelled for a reader rather than raw.
    /// Every case is a real `SessionStatus`; none is collapsed into another.
    static func label(_ status: SessionStatus) -> String {
        switch status {
        case .idle: "Idle"
        case .running: "Running"
        case .waitingForApproval: "Waiting for approval"
        case .stopping: "Stopping"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }

    static func tint(_ status: SessionStatus) -> Color {
        switch status {
        case .completed: .junoSuccess
        case .failed: .junoDanger
        case .waitingForApproval: .junoCaution
        case .running, .stopping: .junoAccent
        case .idle, .cancelled: .secondary
        }
    }
}
