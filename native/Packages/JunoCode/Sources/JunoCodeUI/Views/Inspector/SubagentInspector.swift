import AppKit
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The index over everything this session delegated: **Active · N** above
/// **Done · N**, newest first, each row an agent rather than a tool call.
///
/// The transcript already shows a delegation where it happened, with each
/// agent's own rows nested under it. This is the other view of the same facts —
/// one list of agents, so a run that delegated four times can be read as a list
/// instead of by scrolling the whole transcript looking for them.
///
/// Clicking a row drills into that agent *inside this pane*, with a back arrow.
/// It never selects the agent's session: a sub-agent is work happening inside
/// this conversation, and a panel that navigates away from the conversation to
/// show it would be re-creating the second chat the whole design removes.
///
/// Everything on a row is a recorded value. Statuses, start and finish times
/// come from the agent's own lifecycle events in this transcript; its steps and
/// result are read from its session when the row is opened. Nothing in between
/// is estimated — there is no progress bar, because nothing reports progress.
struct SubagentPane: View {
    let controller: SessionController

    /// The agent being read, or nil for the list. Held here rather than in a
    /// `NavigationStack` path because the drill-in is one level deep and always
    /// will be: a sub-agent cannot delegate, so there is nothing under it to
    /// push.
    @State private var focused: String?

    var body: some View {
        // Folded once per pass: every section below is a split of this list, not
        // another walk of the transcript.
        let runs = controller.subagents
        return Group {
            if let focused, let run = runs.first(where: { $0.agentID == focused }) {
                SubagentDetailPane(
                    run: run,
                    controller: controller,
                    back: { self.focused = nil }
                )
            } else if runs.isEmpty {
                // One honest empty state, never placeholder rows: a list of grey
                // rectangles under the words "nothing delegated" claims content
                // that does not exist.
                JunoEmptyState(
                    title: "No sub-agents yet",
                    message:
                        "When Juno splits work across sub-agents, each one appears here while it runs.",
                    symbol: "person.2"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list(runs)
            }
        }
        // The pane is a rail, not a modal: a delegation that finishes while the
        // reader is reading one agent must not throw them back to the list.
        .animation(JunoMotion.standard, value: focused)
    }

    private func list(_ runs: [SubagentRun]) -> some View {
        List {
            section("Active", runs: SubagentDigest.active(in: runs))
            section("Done", runs: SubagentDigest.finished(in: runs))
        }
        .listStyle(.inset)
        .accessibilityIdentifier("juno.code.subagents")
    }

    @ViewBuilder
    private func section(_ title: String, runs: [SubagentRun]) -> some View {
        if !runs.isEmpty {
            Section {
                ForEach(runs) { run in
                    SubagentListRow(
                        run: run,
                        activity: activity(for: run),
                        open: { focused = run.agentID }
                    )
                    // Opaque and raised, not glass: this is content a reader
                    // studies, and the section reads as one panel of divided
                    // rows rather than as loose text on the inspector.
                    .listRowBackground(Color.junoRaised)
                }
            } header: {
                HStack(spacing: JunoSpace.tight) {
                    Text(title)
                    Text("·")
                    Text("\(runs.count)").monospacedDigit()
                    Spacer(minLength: 0)
                }
            }
        }
    }

    /// The live step, where the agent is still working and has published one.
    private func activity(for run: SubagentRun) -> String {
        guard run.isActive else { return "" }
        if let child = run.childSessionID,
           let live = controller.subagentActivity[child],
           !live.isEmpty
        {
            return live
        }
        return run.currentActivity
    }
}

// MARK: - One row

/// One agent: its mark, its name, what it is doing, and how long it has been
/// doing it.
private struct SubagentListRow: View {
    let run: SubagentRun
    let activity: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                SubagentStatusGlyph(status: run.status)
                    .frame(width: JunoSpace.regular, alignment: .center)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(run.title)
                        .junoRowLabel()
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: JunoSpace.tight) {
                        if let role = run.role {
                            SubagentRoleChip(role: role)
                        }
                        Text(activity.isEmpty ? SubagentFormatting.label(run.status) : activity)
                            .junoCaption()
                            .foregroundStyle(
                                activity.isEmpty
                                    ? SubagentFormatting.tint(run.status)
                                    : Color.secondary
                            )
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                        SubagentElapsed(run: run)
                    }
                }
                Image(systemName: "chevron.right")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, JunoSpace.hairline)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(SubagentFormatting.accessibilityLabel(run))
        .accessibilityHint("Opens this sub-agent's report")
        .accessibilityIdentifier("juno.code.subagents.row")
    }
}

// MARK: - One agent

/// One agent's own report, in the pane the reader was already looking at: what
/// it was asked, what it did, and what it concluded.
///
/// The steps are the agent's real tool calls, read from its session — a
/// sub-agent that read six files and concluded the wrong thing is only
/// inspectable if its steps are visible. They are summaries rather than the
/// agent's full transcript, which is the honest ceiling for a 320pt column and
/// the reason the diff, the console and the preview were all evicted from this
/// inspector. The full transcript is one indent under the delegating call in the
/// canvas, where there is width for it.
private struct SubagentDetailPane: View {
    let run: SubagentRun
    let controller: SessionController
    let back: () -> Void

    /// What the store returned for the agent's session.
    ///
    /// `.missing` is a real answer rather than an error — a session can be
    /// deleted, and the preview harness has no store at all — so it is a case
    /// the pane can state plainly instead of a `nil` it would have to guess
    /// about.
    private enum Load: Equatable {
        case loading
        case loaded(SubagentDetail)
        case missing
    }

    @State private var load: Load = .loading

    private var activity: String {
        guard run.isActive, let child = run.childSessionID else { return "" }
        return controller.subagentActivity[child] ?? run.currentActivity
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    if !activity.isEmpty {
                        field("Now", text: activity)
                    }
                    field("Task", text: run.task)
                    if let error = run.error {
                        field("Problem", text: error, tint: SubagentFormatting.tint(run.status))
                    }
                    steps
                    if let summary = run.summary {
                        field("Result", text: summary)
                    } else if run.isActive {
                        Text("This sub-agent has not written a result yet.").junoCaption()
                    }
                    usage
                    session
                }
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // Re-read while the agent works, so an open report grows with it rather
        // than freezing at whatever had been recorded when it was opened.
        .task(id: SubagentLoadKey(agentID: run.agentID, activity: activity, status: run.status)) {
            guard let child = run.childSessionID else {
                load = .missing
                return
            }
            if let detail = await controller.subAgentDetail(child) {
                load = .loaded(detail)
            } else {
                load = .missing
            }
        }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            Button(action: back) {
                Image(systemName: "chevron.backward")
                    .imageScale(.small)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            // Deliberately no Escape shortcut: the inspector is a permanently
            // visible column, and claiming Escape here would swallow it for the
            // composer and every sheet the window can present.
            .help("Back to every sub-agent")
            .accessibilityLabel("Back to every sub-agent")
            .accessibilityIdentifier("juno.code.subagents.back")

            SubagentStatusGlyph(status: run.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .junoRowLabel()
                    .lineLimit(2)
                Text(SubagentFormatting.label(run.status))
                    .junoCaption()
                    .foregroundStyle(SubagentFormatting.tint(run.status))
            }
            Spacer(minLength: JunoSpace.tight)
            SubagentElapsed(run: run)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    @ViewBuilder
    private var steps: some View {
        switch load {
        case .loading:
            ProgressView().controlSize(.small)
        case .missing:
            Text(
                run.childSessionID == nil
                    ? "This sub-agent never opened a session, so it recorded no steps."
                    : "Juno could not read this sub-agent's session from the store."
            )
            .junoCaption()
        case let .loaded(detail):
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Steps").junoSidebarSection()
                if detail.steps.isEmpty {
                    Text("This sub-agent recorded no tool calls.").junoCaption()
                } else {
                    ForEach(detail.steps) { step in
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
                        .accessibilityLabel(
                            "\(step.summary), \(SubagentFormatting.label(step.status))"
                        )
                    }
                }
            }
        }
    }

    /// Only what the provider actually reported. Juno tokenizes nothing itself,
    /// and an estimate here would disagree with the number the account is
    /// billed for.
    @ViewBuilder
    private var usage: some View {
        if run.inputTokens != nil || run.outputTokens != nil {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Tokens").junoSidebarSection()
                HStack(spacing: JunoSpace.cozy) {
                    if let input = run.inputTokens {
                        Label("\(input) in", systemImage: "arrow.down")
                    }
                    if let output = run.outputTokens {
                        Label("\(output) out", systemImage: "arrow.up")
                    }
                    Spacer(minLength: 0)
                }
                .junoCaption()
                .monospacedDigit()
            }
        }
    }

    @ViewBuilder
    private var session: some View {
        if let child = run.childSessionID {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Session").junoSidebarSection()
                HStack(spacing: JunoSpace.tight) {
                    Text(child.value)
                        .junoCodeSmall()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(child.value, forType: .string)
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
    }

    private func field(_ label: String, text: String, tint: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(label).junoSidebarSection()
            Text(text)
                .font(.callout)
                .foregroundStyle(tint ?? Color.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// What an open report is currently showing. Reloading is keyed on this so a
/// running agent's steps keep arriving and a finished one is read once.
private struct SubagentLoadKey: Equatable {
    let agentID: String
    let activity: String
    let status: SubagentStatus
}

// MARK: - Role

/// The role the delegation asked for.
///
/// Absent when a legacy call named none — `SubagentRun.role` is optional for
/// exactly that case — and then nothing is drawn. The tool's own fallback is a
/// runtime detail, and a chip claiming a role the caller never wrote would be
/// inventing the record.
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

/// Presentation for recorded sub-agent values. Kept in one place so the
/// transcript row, the list row and the report cannot describe the same agent
/// with three different words.
enum SubagentFormatting {
    /// "12.4s" / "3m 07s". A delegated investigation is commonly sub-minute, so
    /// seconds keep a decimal and minutes do not.
    static func duration(_ seconds: Double) -> String {
        guard seconds >= 60 else { return String(format: "%.1fs", seconds) }
        let whole = Int(seconds.rounded())
        return String(format: "%dm %02ds", whole / 60, whole % 60)
    }

    /// The recorded status, spelled for a reader. Never a friendlier word for
    /// it: a cancelled agent must not read as "finished".
    static func label(_ status: SubagentStatus) -> String {
        switch status {
        case .queued: "Waiting to start"
        case .preparing: "Starting"
        case .running: "Running"
        case .waitingForApproval: "Waiting for approval"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .interrupted: "Interrupted"
        }
    }

    static func tint(_ status: SubagentStatus) -> Color {
        switch status {
        case .completed: .junoSuccess
        case .failed: .junoDanger
        case .waitingForApproval, .interrupted: .junoCaution
        case .running, .preparing: .junoAccent
        case .queued, .cancelled: .secondary
        }
    }

    static func accessibilityLabel(_ run: SubagentRun) -> String {
        var parts = [run.title]
        if let role = run.role {
            parts.append(role.rawValue.capitalized)
        }
        parts.append(label(run.status))
        if let seconds = run.durationSeconds {
            parts.append(duration(seconds))
        }
        return parts.joined(separator: ", ")
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
}
