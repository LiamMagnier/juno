import SwiftUI
import JunoCodeCore

/// Central zone: session header, transcript, approvals, and the composer.
struct AgentCanvasView: View {
    @Bindable var controller: SessionController
    let model: WorkbenchModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
                .overlay(JunoCodeTheme.separator)
            transcript
            if let error = controller.transientError {
                errorBar(error)
            }
            approvals
            composer
        }
        .background(JunoCodeTheme.background)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: JunoCodeTheme.Spacing.control) {
            VStack(alignment: .leading, spacing: 2) {
                Text(controller.session.title)
                    .font(.headline)
                HStack(spacing: JunoCodeTheme.Spacing.tight) {
                    Text(controller.context.record.descriptor.displayName)
                    if let branch = controller.session.gitBranch {
                        Text("·")
                        Image(systemName: "arrow.triangle.branch").imageScale(.small)
                        Text(branch)
                    }
                    Text("·")
                    Text(permissionModeLabel(controller.session.configuration.permissionMode))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            statusBadge
            if controller.isRunning {
                Button(role: .destructive) {
                    Task { await controller.stop() }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .keyboardShortcut(".", modifiers: .command)
                .help("Stop the agent immediately (⌘.)")
                .accessibilityLabel("Stop the agent")
            }
        }
        .padding(.horizontal, JunoCodeTheme.Spacing.content)
        .padding(.vertical, JunoCodeTheme.Spacing.control)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch controller.session.status {
        case .running, .stopping:
            HStack(spacing: JunoCodeTheme.Spacing.tight) {
                ProgressView().controlSize(.small)
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if let elapsed = controller.elapsedSeconds {
                        Text(durationText(elapsed))
                            .monospacedDigit()
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .waitingForApproval:
            Label("Waiting for approval", systemImage: "hand.raised.fill")
                .font(.caption)
                .foregroundStyle(JunoCodeTheme.caution)
        case .failed:
            Label("Failed", systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(JunoCodeTheme.failure)
        case .completed:
            Label("Completed", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(JunoCodeTheme.success)
        case .cancelled:
            Label("Stopped", systemImage: "stop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .idle:
            EmptyView()
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        if controller.events.count <= 1 {
            preRunSuggestions
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.control) {
                        ForEach(visibleEvents) { event in
                            TranscriptRow(event: event, controller: controller)
                                .id(event.id)
                        }
                    }
                    .padding(JunoCodeTheme.Spacing.content)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: controller.events.count) {
                    if let last = visibleEvents.last {
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private var visibleEvents: [SessionEvent] {
        controller.events.filter { event in
            switch event.payload {
            case .sessionCreated, .statusChanged, .toolOutput, .approvalResolved:
                return false
            default:
                return true
            }
        }
    }

    private var preRunSuggestions: some View {
        VStack(spacing: JunoCodeTheme.Spacing.content) {
            Spacer()
            Text(controller.context.record.descriptor.displayName)
                .font(.system(size: 30, weight: .semibold))
            Text("What should the agent work on?")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.compact) {
                suggestionButton(
                    "Explain this codebase",
                    prompt: "Give me a tour of this codebase: structure, key modules, and how they fit together."
                )
                suggestionButton(
                    "Find and fix a bug",
                    prompt: "Look for likely bugs in the most recently changed files and propose fixes."
                )
                if controller.testSuggestions.first != nil {
                    suggestionButton(
                        "Run the tests and fix failures",
                        prompt: "Run the project's tests. If anything fails, fix it and run them again."
                    )
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func suggestionButton(_ title: String, prompt: String) -> some View {
        Button {
            controller.composerText = prompt
        } label: {
            HStack {
                Image(systemName: "sparkles")
                    .foregroundStyle(JunoCodeTheme.accent)
                Text(title)
                Spacer()
            }
            .padding(JunoCodeTheme.Spacing.control)
            .frame(width: 380)
            .background(JunoCodeTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Approvals

    @ViewBuilder
    private var approvals: some View {
        ForEach(controller.pendingApprovals, id: \.id) { request in
            ApprovalBanner(request: request, controller: controller)
        }
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(spacing: 0) {
            Divider().overlay(JunoCodeTheme.separator)
            HStack(alignment: .bottom, spacing: JunoCodeTheme.Spacing.compact) {
                TextField(
                    "Ask the agent to examine or change this project…",
                    text: $controller.composerText,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .font(.body)
                .padding(JunoCodeTheme.Spacing.control)
                .background(JunoCodeTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
                .onSubmit(send)
                .accessibilityLabel("Message the agent")

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(
                            controller.composerText.isEmpty || controller.isRunning
                                ? AnyShapeStyle(.tertiary)
                                : AnyShapeStyle(JunoCodeTheme.accent)
                        )
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(controller.composerText.isEmpty || controller.isRunning)
                .help("Send (⌘⏎)")
                .accessibilityLabel("Send")
            }
            .padding(JunoCodeTheme.Spacing.content)
        }
        .background(.ultraThinMaterial)
    }

    private func send() {
        guard !controller.composerText.isEmpty, !controller.isRunning else { return }
        Task { await controller.send() }
    }

    private func errorBar(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(JunoCodeTheme.caution)
            Text(message)
                .font(.callout)
                .lineLimit(2)
            Spacer()
        }
        .padding(JunoCodeTheme.Spacing.control)
        .background(JunoCodeTheme.caution.opacity(0.12))
    }

    private func permissionModeLabel(_ mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: return "Read-only"
        case .askBeforeChanges: return "Ask before changes"
        case .workspaceWrite: return "Workspace write"
        case .fullAccess: return "Full access"
        }
    }

    private func durationText(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// A pending approval with Approve/Deny actions.
struct ApprovalBanner: View {
    let request: ApprovalRequest
    let controller: SessionController

    var body: some View {
        HStack(spacing: JunoCodeTheme.Spacing.control) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(JunoCodeTheme.caution)
            VStack(alignment: .leading, spacing: 2) {
                Text(request.summary)
                    .font(.callout.weight(.medium))
                Text("\(request.toolName) · \(request.risk.rawValue) risk")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Deny") {
                Task { await controller.deny(request.id) }
            }
            .keyboardShortcut(.escape, modifiers: .shift)
            Button("Approve") {
                Task { await controller.approve(request.id) }
            }
            .buttonStyle(.borderedProminent)
            .tint(JunoCodeTheme.accent)
            .keyboardShortcut(.return, modifiers: .shift)
        }
        .padding(JunoCodeTheme.Spacing.control)
        .background(JunoCodeTheme.caution.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: JunoCodeTheme.Radius.card))
        .padding(.horizontal, JunoCodeTheme.Spacing.content)
        .padding(.bottom, JunoCodeTheme.Spacing.compact)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Approval required: \(request.summary)")
    }
}
