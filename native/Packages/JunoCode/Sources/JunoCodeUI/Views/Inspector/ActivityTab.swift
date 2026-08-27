import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The shape of the run: what is happening now, and what the session has
/// actually been allowed to do to the machine.
///
/// Nothing here is inferred. There are no token or cost figures because the
/// local runtime does not report `Usage`, and no progress bars because no tool
/// reports progress — the running row's spinner is indeterminate for exactly
/// that reason, and says only that something is executing.
struct ActivityTab: View {
    @Bindable var controller: SessionController

    /// The tool that has actually started and not finished.
    ///
    /// Derived from `toolStarted` minus `toolCompleted` — the same reading
    /// `CodeToolDigest` gives the transcript's working row — rather than from
    /// `toolProposed`. The orchestrator appends the proposal *before* it suspends
    /// in `authorizeInvocation` and only appends `toolStarted` once the call is
    /// authorized, so counting proposals reported a run blocked on the reader as
    /// executing. It also reported one forever after a hard quit: the store's
    /// crash repair appends `statusChanged` and `errorOccurred` and never a
    /// `toolCompleted`, so the interrupted call stayed open in the transcript.
    /// Nothing can be executing outside a live run, which is what closes that
    /// second case whatever the transcript ends on.
    private var runningTool: (name: String, summary: String)? {
        guard controller.isRunning else { return nil }
        let open = CodeToolDigest.runningToolCallIDs(in: controller.events)
        guard !open.isEmpty else { return nil }
        // `ToolStartedEvent` carries only an identifier, so the name and the
        // summary come from the proposal that opened the same call.
        for event in controller.events.reversed() {
            if case let .toolProposed(proposed) = event.payload,
               open.contains(proposed.toolCallID)
            {
                return (proposed.toolName, proposed.summary)
            }
        }
        return nil
    }

    /// The decision the run is blocked on, and how many are queued behind it.
    /// Read from the approval queue rather than from the transcript so this pane
    /// and the card above the composer name the same request.
    private var blockingApproval: (request: ApprovalRequest, others: Int)? {
        guard let first = controller.pendingApprovals.first else { return nil }
        return (first, controller.pendingApprovals.count - 1)
    }

    var body: some View {
        // The Computer Use stop sits outside the list, so it cannot scroll away
        // while the agent is driving the pointer. It renders nothing at all
        // unless the coordinator reports capture as live.
        VStack(spacing: 0) {
            ComputerUseStopBar(controller: controller)
            list
        }
    }

    private var list: some View {
        List {
            Section("Run") {
                // Above the running row because a run waiting on the reader is
                // the more urgent fact, and because the two are independent: a
                // parallel turn can have one call executing while another waits.
                approvalRow
                runningRow
                if controller.isRunning, controller.runStartedAt != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Elapsed", value: elapsedLabel)
                    }
                }
                // Read from the checkpoint store, not counted off the transcript:
                // a checkpoint is one file's content from before one change, and
                // there is no run-level snapshot for a session to rewind to.
                LabeledContent(
                    "Restorable file versions",
                    value: "\(controller.checkpointCount)"
                )
            }

            delegationSummary

            // Consent, the two TCC grants, the captured display, the latest
            // capture and the action record — see `ComputerUsePane.swift` for
            // why the safety surface lives in this pane rather than its own.
            ComputerUseSections(controller: controller)
        }
        .listStyle(.inset)
        .computerUseWatch(controller)
    }

    // MARK: - What the run is doing

    /// A run blocked on the reader, drawn as blocked.
    ///
    /// It carries the approval mark and the caution tint the card above the
    /// composer uses, so the two surfaces agree at a glance, and it is worded as
    /// waiting rather than as progress: a pane that reports a blocked run as
    /// working is a pane that stops the reader looking for the card.
    @ViewBuilder
    private var approvalRow: some View {
        if let blockingApproval {
            LabeledContent {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(blockingApproval.request.toolName).junoCode()
                    Text(blockingApproval.request.summary)
                        .junoCaption()
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                    if blockingApproval.others > 0 {
                        Text("\(blockingApproval.others) more waiting")
                            .junoCaption()
                            .junoMetaInk()
                    }
                }
            } label: {
                JunoIconLabel("Waiting for approval", icon: .permission)
                    .foregroundStyle(Color.junoCaution)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "Waiting for approval: \(blockingApproval.request.toolName), \(blockingApproval.request.summary)"
            )
            .accessibilityIdentifier("juno.code.activity.awaiting-approval")
        }
    }

    /// The session's own status belongs to the toolbar and the transcript; this
    /// row answers the narrower question of what tool is executing right now, and
    /// "No tool" is a real answer to it.
    @ViewBuilder
    private var runningRow: some View {
        if let runningTool {
            LabeledContent {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(runningTool.name).junoCode()
                    Text(runningTool.summary)
                        .junoCaption()
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    ProgressView().controlSize(.small)
                    Text("Running")
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Running \(runningTool.name), \(runningTool.summary)")
            .accessibilityIdentifier("juno.code.activity.running")
        } else {
            LabeledContent("Running", value: "No tool")
                .accessibilityIdentifier("juno.code.activity.running")
        }
    }

    // MARK: - Sub-agents

    /// How much of this run is happening in parallel, and nothing more.
    ///
    /// The agents themselves moved to their own pane. What belongs here is the
    /// same question this pane already answers about tools — *what is the run
    /// doing right now* — for which the count of live agents is the answer and a
    /// second list of them would be a duplicate. It is drawn only while a
    /// delegation exists, so a session that never delegated carries no row about
    /// delegation.
    @ViewBuilder
    private var delegationSummary: some View {
        let runs = controller.subagents
        let active = runs.filter(\.isActive).count
        if !runs.isEmpty {
            Section("Delegation") {
                LabeledContent(
                    "Sub-agents",
                    value: active > 0
                        ? "\(active) of \(runs.count) running"
                        : "\(runs.count) finished"
                )
                .help("Open the Sub-agents pane to read each one")
            }
        }
    }

    private var elapsedLabel: String {
        guard let seconds = controller.elapsedSeconds else { return "—" }
        let whole = Int(seconds)
        return whole < 60
            ? "\(whole)s"
            : "\(whole / 60)m \(whole % 60)s"
    }
}
