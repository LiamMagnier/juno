import SwiftUI
import JunoCodeCore

/// Renders one transcript event in the agent canvas.
struct TranscriptRow: View {
    let event: SessionEvent
    let controller: SessionController

    var body: some View {
        switch event.payload {
        case let .userPrompt(prompt):
            userRow(prompt.text)
        case let .assistantMessage(message):
            assistantRow(message.text)
        case let .reasoningSummary(summary):
            reasoningRow(summary.summary)
        case let .toolProposed(proposed):
            ToolActivityRow(proposed: proposed, controller: controller)
        case let .approvalRequested(request):
            if !controller.pendingApprovals.contains(where: { $0.id == request.id }) {
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

    // MARK: - Rows

    private func userRow(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 60)
            Text(text)
                .textSelection(.enabled)
                .padding(JunoCodeTheme.Spacing.control)
                .background(JunoCodeTheme.accent.opacity(0.16))
                .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
        }
        .accessibilityLabel("You: \(text)")
    }

    private func assistantRow(_ text: String) -> some View {
        Text(LocalizedStringKey(text))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Agent: \(text)")
    }

    private func reasoningRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: JunoCodeTheme.Spacing.compact) {
            Image(systemName: "brain")
                .foregroundStyle(.tertiary)
                .imageScale(.small)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func resolvedApprovalRow(_ request: ApprovalRequest) -> some View {
        let resolution = controller.events.lazy.compactMap { event -> ApprovalDecision? in
            if case let .approvalResolved(resolved) = event.payload,
               resolved.approvalID == request.id
            {
                return resolved.decision
            }
            return nil
        }.first
        return HStack(spacing: JunoCodeTheme.Spacing.compact) {
            Image(
                systemName: resolution == .approved
                    ? "checkmark.shield"
                    : "xmark.shield"
            )
            .foregroundStyle(resolution == .approved ? JunoCodeTheme.success : JunoCodeTheme.failure)
            Text("\(request.summary) — \(resolution == .approved ? "approved" : "denied")")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func fileChangeRow(_ change: FileChangedEvent) -> some View {
        HStack(spacing: JunoCodeTheme.Spacing.compact) {
            Image(systemName: iconName(for: change.kind))
                .foregroundStyle(JunoCodeTheme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text(PathDisplay.fileName(change.path.value))
                    .font(.junoMono)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let directory = PathDisplay.directory(change.path.value) {
                    Text(directory)
                        .font(.junoMonoSmall)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer()
            if change.linesAdded > 0 {
                Text("+\(change.linesAdded)")
                    .font(.junoMonoSmall)
                    .foregroundStyle(JunoCodeTheme.success)
            }
            if change.linesRemoved > 0 {
                Text("−\(change.linesRemoved)")
                    .font(.junoMonoSmall)
                    .foregroundStyle(JunoCodeTheme.failure)
            }
        }
        .padding(.vertical, JunoCodeTheme.Spacing.tight)
        .padding(.horizontal, JunoCodeTheme.Spacing.control)
        .background(JunoCodeTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.control))
    }

    private func testRow(_ run: TestRunCompletedEvent) -> some View {
        HStack(spacing: JunoCodeTheme.Spacing.compact) {
            Image(systemName: run.passed ? "checkmark.seal.fill" : "xmark.seal.fill")
                .foregroundStyle(run.passed ? JunoCodeTheme.success : JunoCodeTheme.failure)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.passed ? "Tests passed" : "Tests failed")
                    .font(.callout.weight(.medium))
                Text(testDetail(run))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(JunoCodeTheme.Spacing.control)
        .background(JunoCodeTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
    }

    private func errorRow(_ error: ErrorEvent) -> some View {
        HStack(alignment: .top, spacing: JunoCodeTheme.Spacing.compact) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(error.isRecoverable ? JunoCodeTheme.caution : JunoCodeTheme.failure)
            Text(error.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    private func completionRow(_ completed: RunCompletedEvent) -> some View {
        VStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.compact) {
            HStack(spacing: JunoCodeTheme.Spacing.compact) {
                Image(systemName: "flag.checkered")
                Text("Run finished")
                    .font(.callout.weight(.semibold))
                Spacer()
                Text(durationText(completed.durationSeconds))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: JunoCodeTheme.Spacing.content) {
                Label(
                    "\(PathDisplay.fileCount(completed.filesChanged)) changed",
                    systemImage: "doc.badge.gearshape"
                )
                if let testsPassed = completed.testsPassed {
                    Label(
                        testsPassed ? "Tests green" : "Tests failing",
                        systemImage: testsPassed ? "checkmark.seal" : "xmark.seal"
                    )
                    .foregroundStyle(testsPassed ? JunoCodeTheme.success : JunoCodeTheme.failure)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(JunoCodeTheme.Spacing.control)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JunoCodeTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
    }

    // MARK: - Helpers

    private func iconName(for kind: FileChangeKind) -> String {
        switch kind {
        case .created: return "plus.square"
        case .modified: return "pencil"
        case .deleted: return "trash"
        case .moved: return "arrow.right.square"
        }
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

/// A proposed/running/finished tool call with expandable streamed output.
struct ToolActivityRow: View {
    let proposed: ToolProposedEvent
    let controller: SessionController
    @State private var expanded = false

    private var completion: ToolCompletedEvent? {
        for event in controller.events.reversed() {
            if case let .toolCompleted(completed) = event.payload,
               completed.toolCallID == proposed.toolCallID
            {
                return completed
            }
        }
        return nil
    }

    private var output: [ToolOutputEvent] {
        controller.events.compactMap { event in
            if case let .toolOutput(chunk) = event.payload,
               chunk.toolCallID == proposed.toolCallID
            {
                return chunk
            }
            return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
            } label: {
                HStack(spacing: JunoCodeTheme.Spacing.compact) {
                    statusIcon
                    Text(proposed.summary)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if let completion {
                        Text(String(format: "%.1fs", completion.durationSeconds))
                            .font(.junoMonoSmall)
                            .foregroundStyle(.tertiary)
                    } else {
                        ProgressView().controlSize(.mini)
                    }
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .imageScale(.small)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityText)

            if expanded {
                VStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.tight) {
                    if let completion {
                        Text(completion.resultSummary)
                            .font(.junoMonoSmall)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    if !output.isEmpty {
                        // Same rule as the Terminal tab: fixed-width output
                        // scrolls sideways rather than wrapping.
                        ScrollView([.vertical, .horizontal]) {
                            VStack(alignment: .leading, spacing: 1) {
                                ForEach(Array(output.enumerated()), id: \.offset) { _, chunk in
                                    Text(chunk.text)
                                        .font(.junoMonoSmall)
                                        .foregroundStyle(
                                            chunk.channel == .stderr
                                                ? JunoCodeTheme.failure
                                                : .secondary
                                        )
                                        .textSelection(.enabled)
                                        .lineLimit(1)
                                        .fixedSize(horizontal: true, vertical: false)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        .frame(maxHeight: 180)
                        .padding(JunoCodeTheme.Spacing.compact)
                        .background(JunoCodeTheme.well)
                        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.control))
                    }
                }
                .padding(.top, JunoCodeTheme.Spacing.tight)
                .padding(.leading, 22)
            }
        }
        .padding(.vertical, JunoCodeTheme.Spacing.tight)
        .padding(.horizontal, JunoCodeTheme.Spacing.control)
        .background(JunoCodeTheme.surface.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.control))
    }

    @ViewBuilder
    private var statusIcon: some View {
        if let completion {
            switch completion.status {
            case .succeeded:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(JunoCodeTheme.success)
            case .failed:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(JunoCodeTheme.failure)
            case .denied:
                Image(systemName: "hand.raised.slash")
                    .foregroundStyle(JunoCodeTheme.caution)
            case .cancelled:
                Image(systemName: "stop.circle")
                    .foregroundStyle(.secondary)
            }
        } else {
            Image(systemName: "gearshape")
                .foregroundStyle(JunoCodeTheme.accent)
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
