import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// The index over everything this session delegated: **Active · N** above
/// **Done · N**, newest first, each row an agent rather than a tool call.
///
/// The transcript already shows a delegation where it happened, with each
/// agent's own rows nested under it. This is the other view of the same facts —
/// one list of agents, so a run that delegated four times can be read as a list
/// instead of by scrolling the whole transcript looking for them.
///
/// Clicking a row drills into that agent *inside this pane*, under a named back
/// control. It never selects the agent's session: a sub-agent is work inside
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
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                        Text(run.title)
                            .junoRowLabel()
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .layoutPriority(1)
                        Spacer(minLength: JunoSpace.tight)
                        SubagentElapsed(run: run)
                        Image(systemName: "chevron.right")
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                    }
                    HStack(spacing: JunoSpace.tight) {
                        Text(SubagentFormatting.listLabel(run.status))
                            .junoCaption()
                            .foregroundStyle(SubagentFormatting.tint(run.status))
                            .lineLimit(1)
                        if let role = run.role {
                            Text("·")
                                .junoCaption()
                                .foregroundStyle(.tertiary)
                            Text(role.rawValue.capitalized)
                                .junoCaption()
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    if !activity.isEmpty {
                        Text(activity)
                            .junoCaption()
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.vertical, JunoSpace.tight)
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
    @State private var worktreeReview: WorktreeReview?
    @State private var isApplying = false
    @State private var isDiscarding = false
    @State private var confirmApply = false
    @State private var confirmDiscard = false
    @State private var actionMessage: String?
    @State private var actionFailed = false
    @State private var pendingApprovals: [ApprovalRequest] = []
    @State private var isStopping = false

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
                    liveControls
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
                    worktreePanel
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
                pendingApprovals = []
                return
            }
            if let detail = await controller.subAgentDetail(child) {
                load = .loaded(detail)
            } else {
                load = .missing
            }
            if run.executionMode == .workspaceWrite {
                worktreeReview = await controller.subagentWorktreeReview(child)
            } else {
                worktreeReview = nil
            }
        }
        // A child approval is a live capability, not a transcript event. Poll
        // only while this detail is open so the inspector reacts promptly
        // without adding a second event stream to the parent session.
        .task(id: SubagentApprovalLoadKey(
            agentID: run.agentID,
            childSessionID: run.childSessionID,
            status: run.status
        )) {
            guard let child = run.childSessionID else {
                pendingApprovals = []
                return
            }
            while !Task.isCancelled {
                pendingApprovals = await controller.subagentPendingApprovals(child)
                if !run.isActive && pendingApprovals.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(400))
            }
        }
        .confirmationDialog(
            "Apply this sub-agent's changes?",
            isPresented: $confirmApply,
            titleVisibility: .visible
        ) {
            // Applying is an explicit merge into the parent, but it is not a
            // destructive action. Reserve the destructive treatment for the
            // separate discard confirmation below so the two choices are not
            // visually conflated.
            Button("Apply Changes") {
                applyWorktree()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Juno will merge the finalized isolated branch only if the parent workspace is still clean and unchanged."
            )
        }
        .confirmationDialog(
            "Discard this sub-agent's worktree?",
            isPresented: $confirmDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard Worktree", role: .destructive) {
                discardWorktree()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The isolated checkout is removed. The parent workspace is not changed."
            )
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            backControl
            HStack(spacing: JunoSpace.snug) {
                SubagentStatusGlyph(status: run.status)
                VStack(alignment: .leading, spacing: 1) {
                    Text(run.title)
                        .junoRowLabel()
                        .lineLimit(2)
                    Text(pendingApprovals.isEmpty
                        ? SubagentFormatting.label(run.status)
                        : "Waiting for approval")
                        .junoCaption()
                        .foregroundStyle(pendingApprovals.isEmpty
                            ? SubagentFormatting.tint(run.status)
                            : Color.junoCaution)
                }
                Spacer(minLength: JunoSpace.tight)
                SubagentElapsed(run: run)
            }
            liveActionBar
            if run.executionMode == .workspaceWrite {
                worktreeActions
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    /// The only way out of a report, and sized like one.
    ///
    /// It was a bare `chevron.backward` with the content shape on the glyph, so
    /// the sole exit from this pane was a ~7x11pt target that a click two points
    /// off missed entirely — while the copy button further down this same pane
    /// got a full control-sized one. The named destination goes with the size:
    /// this is a rail with one level in it, and "All sub-agents" says where back
    /// leads without the reader having to try it.
    ///
    /// On its own row rather than beside the title because at the inspector's
    /// 260pt minimum a text label, the status mark, a two-line agent title and
    /// the elapsed time do not share a line without the title truncating.
    private var backControl: some View {
        Button(action: back) {
            Label("All sub-agents", systemImage: "chevron.backward")
                .junoRowLabel()
                .padding(.vertical, JunoSpace.hairline)
                .padding(.trailing, JunoSpace.snug)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        // Deliberately no Escape shortcut: the inspector is a permanently
        // visible column, and claiming Escape here would swallow it for the
        // composer and every sheet the window can present.
        .help("Back to every sub-agent")
        .accessibilityLabel("Back to every sub-agent")
        .accessibilityIdentifier("juno.code.subagents.back")
    }

    @ViewBuilder
    private var liveControls: some View {
        if let child = run.childSessionID, !pendingApprovals.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Label("Waiting for approval", systemImage: "hand.raised.fill")
                    .junoSidebarSection()
                    .foregroundStyle(Color.junoCaution)
                ForEach(pendingApprovals, id: \.id) { request in
                    SubagentApprovalCard(
                        request: request,
                        childSessionID: child,
                        controller: controller
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var liveActionBar: some View {
        if run.isActive, let child = run.childSessionID {
            HStack(spacing: JunoSpace.tight) {
                if pendingApprovals.isEmpty {
                    Label("Agent is working", systemImage: "bolt.horizontal.fill")
                        .junoCaption()
                        .foregroundStyle(.secondary)
                } else {
                    Label("Agent is paused", systemImage: "pause.fill")
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                }
                Spacer(minLength: JunoSpace.tight)
                Button {
                    isStopping = true
                    Task {
                        await controller.stopSubagent(child)
                        isStopping = false
                    }
                } label: {
                    if isStopping {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Stop", systemImage: "stop.fill")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(Color.junoDanger)
                .disabled(isStopping)
                .help("Stop this sub-agent and deny its pending approvals")
                .accessibilityIdentifier("juno.code.subagents.stop")
            }
            .padding(.top, JunoSpace.hairline)
        }
    }

    private var worktreePanel: some View {
        guard run.executionMode == .workspaceWrite else {
            return AnyView(EmptyView())
        }
        return AnyView(
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.tight) {
                    Label("Isolated worktree", systemImage: "arrow.triangle.branch")
                        .junoSidebarSection()
                    Spacer(minLength: 0)
                    Text(worktreeLifecycleLabel)
                        .junoCaption()
                        .foregroundStyle(worktreeLifecycleTint)
                }
                if let review = worktreeReview {
                    let changedPathCount = review.untrackedPaths.count
                        + review.status.split(separator: "\n").count
                    let pathSuffix = changedPathCount == 1 ? "" : "s"
                    Text(
                        changedPathCount == 0
                            ? "No pending file changes in the isolated branch."
                            : "\(changedPathCount) changed path\(pathSuffix) staged in the isolated branch."
                    )
                    .junoCaption()
                    .foregroundStyle(.secondary)
                } else {
                    Text(
                        run.isActive
                            ? "The isolated branch is updated when the agent finishes."
                            : "Reading the isolated branch…"
                    )
                    .junoCaption()
                    .foregroundStyle(.secondary)
                }
                if let actionMessage {
                    Text(actionMessage)
                        .junoCaption()
                        .foregroundStyle(actionFailed ? Color.junoDanger : Color.secondary)
                        .textSelection(.enabled)
                }
            }
        )
    }

    private var worktreeActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.tight) {
                worktreeStatusLabel
                Spacer(minLength: JunoSpace.tight)
                applyButton(compact: false)
                discardButton(compact: false)
            }
            HStack(spacing: JunoSpace.tight) {
                worktreeStatusLabel
                Spacer(minLength: JunoSpace.tight)
                applyButton(compact: true)
                discardButton(compact: true)
            }
        }
        .padding(.top, JunoSpace.hairline)
    }

    private var worktreeStatusLabel: some View {
        Label("Worktree \(worktreeLifecycleLabel)", systemImage: "arrow.triangle.branch")
            .junoCaption()
            .foregroundStyle(worktreeLifecycleTint)
            .lineLimit(1)
    }

    private func applyButton(compact: Bool) -> some View {
        Button {
            confirmApply = true
        } label: {
            if isApplying {
                ProgressView().controlSize(.small)
            } else if compact {
                Image(systemName: "arrow.down.to.line.compact")
            } else {
                Label("Apply", systemImage: "arrow.down.to.line.compact")
            }
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .controlSize(.small)
        .disabled(!canApply || isApplying || isDiscarding)
        .help("Merge the finalized sub-agent branch into the parent workspace")
        .accessibilityLabel("Apply sub-agent changes")
    }

    private func discardButton(compact: Bool) -> some View {
        Button {
            confirmDiscard = true
        } label: {
            if isDiscarding {
                ProgressView().controlSize(.small)
            } else if compact {
                Image(systemName: "trash")
            } else {
                Label("Discard", systemImage: "trash")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!canDiscard || isApplying || isDiscarding)
        .help("Remove the sub-agent's isolated worktree")
        .accessibilityLabel("Discard sub-agent worktree")
    }

    private var canApply: Bool {
        run.status.isTerminal
            && worktreeReview?.worktree.lifecycle == .finalized
    }

    private var canDiscard: Bool {
        guard run.status.isTerminal,
              let lifecycle = worktreeReview?.worktree.lifecycle
        else { return false }
        return lifecycle != .removed && lifecycle != .removing
    }

    private var worktreeLifecycleLabel: String {
        guard let lifecycle = worktreeReview?.worktree.lifecycle else {
            return run.isActive ? "running" : "checking"
        }
        return lifecycle.rawValue.replacingOccurrences(of: "_", with: " ")
    }

    private var worktreeLifecycleTint: Color {
        if canApply { return Color.junoAccent }
        if actionFailed { return Color.junoDanger }
        return .secondary
    }

    private func applyWorktree() {
        guard let child = run.childSessionID else { return }
        isApplying = true
        actionMessage = nil
        Task {
            let succeeded = await controller.applySubagentChanges(child)
            if succeeded {
                actionMessage = "Changes applied to the parent workspace."
                actionFailed = false
            } else {
                actionMessage = controller.transientError ?? "Juno could not apply the changes."
                actionFailed = true
            }
            worktreeReview = await controller.subagentWorktreeReview(child)
            isApplying = false
        }
    }

    private func discardWorktree() {
        guard let child = run.childSessionID else { return }
        isDiscarding = true
        actionMessage = nil
        Task {
            let succeeded = await controller.discardSubagentChanges(child)
            if succeeded {
                actionMessage = "The isolated worktree was discarded."
                actionFailed = false
            } else {
                actionMessage = controller.transientError ?? "Juno could not discard the worktree."
                actionFailed = true
            }
            worktreeReview = await controller.subagentWorktreeReview(child)
            isDiscarding = false
        }
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

private struct SubagentApprovalLoadKey: Equatable {
    let agentID: String
    let childSessionID: CodeSessionID?
    let status: SubagentStatus
}

/// Approval controls for a child live in the child inspector, beside the
/// agent's own task. Reusing the parent card here would route the decision to
/// the wrong permission coordinator, so this small card binds every action to
/// the child session explicitly.
private struct SubagentApprovalCard: View {
    let request: ApprovalRequest
    let childSessionID: CodeSessionID
    let controller: SessionController

    @State private var expired = false
    @State private var actionInFlight = false

    private var tint: Color {
        request.risk == .destructive ? .junoDanger : .junoCaution
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(tint)
                Text("Approval required")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: JunoSpace.tight)
                ApprovalCountdown(expiresAt: request.expiresAt)
            }
            Text(request.summary)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("(request.toolName) · (request.risk.rawValue.capitalized) risk")
                .junoCaption()
                .foregroundStyle(.secondary)
            HStack(spacing: JunoSpace.tight) {
                if expired {
                    Text("Expired")
                        .junoCaption()
                        .foregroundStyle(Color.junoDanger)
                }
                Spacer(minLength: 0)
                Button(expired ? "Dismiss" : "Deny") {
                    actionInFlight = true
                    Task {
                        await controller.denySubagent(childSessionID, approvalID: request.id)
                        actionInFlight = false
                    }
                }
                .disabled(actionInFlight)
                Button("Approve") {
                    actionInFlight = true
                    Task {
                        await controller.approveSubagent(childSessionID, approvalID: request.id)
                        actionInFlight = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .disabled(expired || actionInFlight)
            }
        }
        .padding(JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .strokeBorder(tint.opacity(0.55), lineWidth: 1)
        )
        .task(id: request.id) {
            let delay = request.expiresAt.timeIntervalSinceNow
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            guard !Task.isCancelled else { return }
            expired = true
            await controller.sweepSubagentApprovals(childSessionID)
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

    /// The one-line status used in the inspector list. The detail header keeps
    /// the full wording; list rows need a compact label so status, role and a
    /// live activity sentence remain readable at the 260pt minimum.
    static func listLabel(_ status: SubagentStatus) -> String {
        switch status {
        case .queued: "Queued"
        case .preparing: "Starting"
        case .running: "Running"
        case .waitingForApproval: "Needs approval"
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
