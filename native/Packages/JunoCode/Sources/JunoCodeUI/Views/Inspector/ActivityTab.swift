import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The selected run's command-center overview.
///
/// A coding agent should answer four questions without making someone hunt
/// through a diagnostic rail: what state is the run in, does it need me, what
/// is it doing now, and what evidence has it produced? Deeper Changes, Agents,
/// Environment and Repository panes remain available for inspection.
///
/// Nothing here invents progress. The runtime reports lifecycle events,
/// elapsed time, concrete file changes, checkpoints, approvals, test results
/// and sub-agent states, but not a trustworthy percentage complete. This view
/// therefore uses real counts and evidence instead of a decorative progress bar.
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

    private var activeAgents: Int { controller.subagents.filter(\.isActive).count }
    private var finishedAgents: Int { controller.subagents.count - activeAgents }

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

            if let test = controller.lastTestRun {
                Section("Verification") {
                    verificationRow(test)
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
                LabeledContent(
                    "Permission",
                    value: PermissionModeLabel.text(
                        for: controller.session.configuration.behavior == .code
                            ? controller.session.configuration.permissionMode
                            : .readOnly
                    )
                )
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
                    Text(runningTool.name).junoCode()
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

    private func verificationRow(_ test: TestRunCompletedEvent) -> some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                Text(test.passed ? "Passed" : "Failed")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(test.passed ? Color.junoSuccess : Color.junoDanger)
                Text(test.command)
                    .junoCodeSmall()
                    .junoMetaInk()
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
                if let testsRun = test.testsRun {
                    let failures = test.failures ?? 0
                    Text("\(testsRun) test\(testsRun == 1 ? "" : "s") · \(failures) failure\(failures == 1 ? "" : "s") · \(durationLabel(test.durationSeconds))")
                        .junoCaption()
                        .junoSecondaryInk()
                } else {
                    Text(durationLabel(test.durationSeconds))
                        .junoCaption()
                        .junoSecondaryInk()
                }
            }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(test.passed ? .check : .error, size: 14)
                    .foregroundStyle(test.passed ? Color.junoSuccess : Color.junoDanger)
                Text("Latest tests")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Latest tests \(test.passed ? "passed" : "failed"). \(test.command)")
        .accessibilityIdentifier("juno.code.activity.tests")
    }

    private func approvalRow(_ blockingApproval: (request: ApprovalRequest, others: Int)) -> some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                Text(blockingApproval.request.toolName).junoCode()
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
            Text(value).monospacedDigit()
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
        return durationLabel(seconds)
    }

    private func durationLabel(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds))
        if whole < 60 { return "\(whole)s" }
        if whole < 3_600 { return "\(whole / 60)m \(whole % 60)s" }
        return "\(whole / 3_600)h \((whole % 3_600) / 60)m"
    }
}
