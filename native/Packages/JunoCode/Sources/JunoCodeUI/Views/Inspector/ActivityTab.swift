import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The selected run's command-center overview.
///
/// This is intentionally the first inspector surface a reader sees. A coding
/// agent should answer four questions without making someone hunt through a
/// diagnostic rail: what state is the run in, does it need me, what is it doing
/// now, and how much work has it produced or delegated? The deeper Changes,
/// Agents, Environment and Repository panes remain the places to inspect those
/// facts in detail.
///
/// Nothing here invents progress. The local runtime reports lifecycle events,
/// elapsed time, concrete file changes, checkpoints, approvals and sub-agent
/// states, but it does not report a trustworthy percentage complete. The view
/// therefore uses counts and status text rather than a decorative progress bar.
struct ActivityTab: View {
    @Bindable var controller: SessionController

    private var status: CodeRunStatus {
        CodeRunStatus(
            controller.session.status,
            hasPendingApproval: !controller.pendingApprovals.isEmpty
        )
    }

    private var runningTool: (name: String, summary: String)? {
        guard controller.isRunning else { return nil }
        let open = CodeToolDigest.runningToolCallIDs(in: controller.events)
        guard !open.isEmpty else { return nil }
        for event in controller.events.reversed() {
            if case let .toolProposed(proposed) = event.payload,
               open.contains(proposed.toolCallID)
            {
                return (proposed.toolName, proposed.summary)
            }
        }
        return nil
    }

    private var blockingApproval: (request: ApprovalRequest, others: Int)? {
        guard let first = controller.pendingApprovals.first else { return nil }
        return (first, controller.pendingApprovals.count - 1)
    }

    private var activeAgents: Int {
        controller.subagents.filter(\.isActive).count
    }

    private var finishedAgents: Int {
        controller.subagents.count - activeAgents
    }

    private var statusDetail: String {
        if let blockingApproval {
            return blockingApproval.others > 0
                ? "Waiting for \(blockingApproval.request.toolName) and \(blockingApproval.others) more approval request\(blockingApproval.others == 1 ? "" : "s")"
                : "Waiting for approval to use \(blockingApproval.request.toolName)"
        }
        if let runningTool {
            let summary = runningTool.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            return summary.isEmpty ? "Using \(runningTool.name)" : summary
        }
        if activeAgents > 0 {
            return "\(activeAgents) delegated agent\(activeAgents == 1 ? " is" : "s are") still working"
        }
        switch status.state {
        case .ready: return "Ready for your next instruction"
        case .planning: return "Building the implementation approach"
        case .queued: return "Waiting for execution capacity"
        case .running: return "Working through the task"
        case .waitingForProvider: return "Waiting for the model provider"
        case .degraded: return "Continuing with reduced capability"
        case .needsApproval: return "A decision is required before work can continue"
        case .stopping: return "Finishing the current operation before stopping"
        case .finished: return "Task completed"
        case .failed: return "The run stopped because something went wrong"
        case .stopped: return "The run was stopped"
        case .hostOffline: return "The computer running this session is offline"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            runHeader
            Divider().overlay(Color.junoSeparator)
            ComputerUseStopBar(controller: controller)
            overview
        }
        .computerUseWatch(controller)
    }

    private var runHeader: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            CodeStatusGlyph(status, size: 15)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.tight) {
                    Text(status.label)
                        .font(.headline)
                    if controller.isRunning {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityLabel("Run in progress")
                    }
                }
                Text(statusDetail)
                    .junoCaption()
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(status.label). \(statusDetail)")
        .accessibilityIdentifier("juno.code.activity.summary")
    }

    private var overview: some View {
        List {
            if let blockingApproval {
                Section("Needs you") {
                    approvalRow(blockingApproval)
                }
            }

            Section("Now") {
                currentWorkRow
                if controller.runStartedAt != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Elapsed", value: elapsedLabel)
                    }
                }
            }

            Section("Work produced") {
                metricRow(label: "Changed files", value: "\(controller.changes.count)", symbol: "doc.badge.ellipsis")
                metricRow(label: "Restorable versions", value: "\(controller.checkpointCount)", symbol: "clock.arrow.circlepath")
            }

            if !controller.subagents.isEmpty {
                Section("Delegation") {
                    metricRow(label: "Agents running", value: "\(activeAgents)", symbol: "person.2")
                    metricRow(label: "Agents finished", value: "\(finishedAgents)", symbol: "checkmark.circle")
                }
            }

            Section("Session") {
                LabeledContent("Model", value: controller.session.configuration.modelID)
                    .accessibilityIdentifier("juno.code.activity.model")
                LabeledContent(
                    "Mode",
                    value: AgentBehaviorLabel.text(for: controller.session.configuration.behavior)
                )
                .accessibilityIdentifier("juno.code.activity.mode")
            }

            ComputerUseSections(controller: controller)
        }
        .listStyle(.inset)
        .accessibilityIdentifier("juno.code.activity")
    }

    @ViewBuilder
    private var currentWorkRow: some View {
        if let runningTool {
            LabeledContent {
                VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                    Text(runningTool.name)
                        .junoCode()
                    if !runningTool.summary.isEmpty {
                        Text(runningTool.summary)
                            .junoCaption()
                            .lineLimit(3)
                            .multilineTextAlignment(.trailing)
                    }
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    ProgressView().controlSize(.small)
                    Text("Current tool")
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Current tool: \(runningTool.name), \(runningTool.summary)")
            .accessibilityIdentifier("juno.code.activity.running")
        } else if activeAgents > 0 {
            LabeledContent("Current work", value: "Delegated to \(activeAgents) agent\(activeAgents == 1 ? "" : "s")")
                .accessibilityIdentifier("juno.code.activity.running")
        } else {
            LabeledContent("Current work", value: status.label)
                .accessibilityIdentifier("juno.code.activity.running")
        }
    }

    private func approvalRow(_ blockingApproval: (request: ApprovalRequest, others: Int)) -> some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                Text(blockingApproval.request.toolName)
                    .junoCode()
                Text(blockingApproval.request.summary)
                    .junoCaption()
                    .lineLimit(3)
                    .multilineTextAlignment(.trailing)
                if blockingApproval.others > 0 {
                    Text("+\(blockingApproval.others) more")
                        .junoCaption()
                        .junoMetaInk()
                }
            }
        } label: {
            JunoIconLabel("Approval", icon: .permission)
                .foregroundStyle(Color.junoCaution)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Approval required: \(blockingApproval.request.toolName), \(blockingApproval.request.summary)")
        .accessibilityIdentifier("juno.code.activity.awaiting-approval")
    }

    private func metricRow(label: String, value: String, symbol: String) -> some View {
        LabeledContent {
            Text(value)
                .monospacedDigit()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(systemImage: symbol, size: 13)
                    .junoSecondaryInk()
                    .frame(width: 16)
                Text(label)
            }
        }
    }

    private var elapsedLabel: String {
        guard let seconds = controller.elapsedSeconds else { return "—" }
        let whole = Int(seconds)
        if whole < 60 { return "\(whole)s" }
        if whole < 3_600 { return "\(whole / 60)m \(whole % 60)s" }
        return "\(whole / 3_600)h \((whole % 3_600) / 60)m"
    }
}
