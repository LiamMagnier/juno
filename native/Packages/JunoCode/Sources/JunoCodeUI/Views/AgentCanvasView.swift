import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Central zone: session header, transcript, approvals, and the composer.
struct AgentCanvasView: View {
    @Bindable var controller: SessionController
    let model: WorkbenchModel

    /// The transcript's measure. Long-form agent prose past roughly 90
    /// characters is measurably harder to read, and a full-screen window is
    /// otherwise 1800pt of single-column text.
    private static let measure: CGFloat = 720

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            transcript
        }
        .background(Color.junoCanvasWarm)
        // The composer floats *over* the transcript rather than sitting in the
        // stack below it, so the last line of output is never hidden behind it
        // and the glass has something to refract.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: JunoSpace.snug) {
                if let error = controller.transientError {
                    errorBar(error)
                }
                approvals
                composer
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)
            .frame(maxWidth: Self.measure + JunoSpace.regular * 2)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Header

    /// One compact line. The previous header stacked a headline over a
    /// three-fact caption and then repeated the status as a fourth element,
    /// spending 56pt to say what fits in 32.
    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 1) {
                Text(controller.session.title)
                    .junoTitle()
                    .lineLimit(1)
                    .truncationMode(.middle)

                // Facts drop off from the right as the window narrows rather
                // than truncating mid-word or wrapping onto a second line.
                ViewThatFits(in: .horizontal) {
                    sessionFacts(includeBranch: true, includePermission: true)
                    sessionFacts(includeBranch: true, includePermission: false)
                    sessionFacts(includeBranch: false, includePermission: false)
                }
            }

            Spacer(minLength: JunoSpace.snug)

            statusBadge

            if controller.isRunning {
                Button(role: .destructive) {
                    Task { await controller.stop() }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                        .labelStyle(.titleAndIcon)
                }
                .controlSize(.small)
                .keyboardShortcut(".", modifiers: .command)
                .help("Stop the agent immediately (⌘.)")
                .accessibilityLabel("Stop the agent")
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug + 2)
    }

    private func sessionFacts(includeBranch: Bool, includePermission: Bool) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(controller.workspaceDisplayName)
                .lineLimit(1)
                .truncationMode(.head)
            if includeBranch, let branch = controller.session.gitBranch {
                Text("·")
                Image(systemName: "arrow.triangle.branch").imageScale(.small)
                Text(branch).lineLimit(1)
            }
            if includePermission {
                Text("·")
                Text(permissionModeLabel(controller.session.configuration.permissionMode))
                    .lineLimit(1)
            }
        }
        .junoCaption()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch controller.session.status {
        case .running, .stopping:
            HStack(spacing: JunoSpace.tight) {
                ProgressView().controlSize(.small)
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if let elapsed = controller.elapsedSeconds {
                        Text(durationText(elapsed))
                            .monospacedDigit()
                    }
                }
            }
            .junoCaption()
            .accessibilityLabel(
                controller.session.status == .stopping ? "Stopping" : "Running"
            )
        case .waitingForApproval:
            StatusChip(
                "Waiting for approval",
                systemImage: "hand.raised.fill",
                tint: .junoCaution
            )
        case .failed:
            StatusChip("Failed", systemImage: "exclamationmark.circle.fill", tint: .junoDanger)
        case .completed:
            StatusChip("Completed", systemImage: "checkmark.circle.fill", tint: .junoSuccess)
        case .cancelled:
            StatusChip("Stopped", systemImage: "stop.circle.fill", tint: .secondary)
        case .idle:
            EmptyView()
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        if visibleEvents.isEmpty {
            preRunSuggestions
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
                        ForEach(visibleEvents) { event in
                            TranscriptRow(event: event, controller: controller)
                                .id(event.id)
                        }
                    }
                    .padding(.horizontal, JunoSpace.tight)
                    .padding(.top, JunoSpace.regular)
                    .padding(.bottom, JunoSpace.snug)
                    .frame(maxWidth: Self.measure, alignment: .leading)
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
            case .sessionCreated, .statusChanged, .toolOutput, .approvalResolved, .toolStarted:
                return false
            default:
                return true
            }
        }
    }

    /// The new-session state. Left-aligned on the transcript's own measure so
    /// the first agent reply lands where the suggestions were, rather than the
    /// whole canvas re-flowing from centred to left the moment a run starts.
    private var preRunSuggestions: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(controller.workspaceDisplayName)
                    .font(.system(.title2, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.head)
                Text("Ask Juno to examine or change this project. Every edit is checkpointed, and anything outside \(permissionModeLabel(controller.session.configuration.permissionMode).lowercased()) asks first.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 1) {
                suggestionButton(
                    "Explain this codebase",
                    systemImage: "map",
                    prompt: "Give me a tour of this codebase: structure, key modules, and how they fit together."
                )
                suggestionButton(
                    "Find and fix a bug",
                    systemImage: "ant",
                    prompt: "Look for likely bugs in the most recently changed files and propose fixes."
                )
                if controller.testSuggestions.first != nil {
                    suggestionButton(
                        "Run the tests and fix failures",
                        systemImage: "checkmark.seal",
                        prompt: "Run the project's tests. If anything fails, fix it and run them again."
                    )
                }
            }
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder)
            )
        }
        .frame(maxWidth: Self.measure, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(.horizontal, JunoSpace.regular)
    }

    private func suggestionButton(
        _ title: String,
        systemImage: String,
        prompt: String
    ) -> some View {
        Button {
            controller.composerText = prompt
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: systemImage)
                    .imageScale(.small)
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 16)
                Text(title).junoRowLabel()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug + 1)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Puts this prompt in the composer")
    }

    // MARK: - Approvals

    @ViewBuilder
    private var approvals: some View {
        ForEach(controller.pendingApprovals, id: \.id) { request in
            ApprovalCard(request: request, controller: controller)
        }
    }

    // MARK: - Composer

    /// The floating Liquid Glass composer, matched to Chat's.
    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            TextField(
                composerPrompt,
                text: $controller.composerText,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(1...10)
            .font(.body)
            .onSubmit(send)
            .accessibilityLabel("Message the agent")

            HStack(spacing: JunoSpace.snug) {
                PermissionModePicker(controller: controller)

                Spacer(minLength: JunoSpace.snug)

                if controller.isRunning {
                    Button(role: .destructive) {
                        Task { await controller.stop() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoDanger)
                    .clipShape(.circle)
                    .keyboardShortcut(".", modifiers: .command)
                    .help("Stop (⌘.)")
                    .accessibilityLabel("Stop the agent")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .clipShape(.circle)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                    .help("Send (⌘⏎)")
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug + 2)
        .junoFloatingGlass(cornerRadius: JunoRadius.floating)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.floating, style: .continuous)
                .strokeBorder(Color.junoBorder)
        )
    }

    private var composerPrompt: String {
        controller.isRunning
            ? "Juno is working — your next message is queued"
            : "Ask Juno to examine or change this project…"
    }

    private var canSend: Bool {
        !controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !controller.isRunning
    }

    private func send() {
        guard canSend else { return }
        Task { await controller.send() }
    }

    private func errorBar(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: "exclamationmark.triangle.fill")
                .imageScale(.small)
                .foregroundStyle(Color.junoCaution)
            Text(message)
                .font(.callout)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoCaution.opacity(0.14))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(message)")
    }

    private func permissionModeLabel(_ mode: PermissionMode) -> String {
        PermissionModePicker.label(for: mode)
    }

    private func durationText(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Status chip

/// A compact, tinted state pill. One shape for every status in the product, so
/// "Failed" and "Completed" differ by colour and glyph and nothing else.
struct StatusChip: View {
    let title: String
    let systemImage: String
    let tint: Color

    init(_ title: String, systemImage: String, tint: Color) {
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            Image(systemName: systemImage).imageScale(.small)
            Text(title)
        }
        .font(.caption)
        .foregroundStyle(tint)
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, 3)
        .background(
            Capsule(style: .continuous).fill(tint.opacity(0.13))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }
}

// MARK: - Permission mode

/// The session's permission mode, in the composer where it governs what the
/// next message is allowed to do.
///
/// It was previously reachable only from the inspector's Context tab — four
/// clicks and a hidden pane away from the decision it affects.
struct PermissionModePicker: View {
    let controller: SessionController

    static func label(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: return "Read-only"
        case .askBeforeChanges: return "Ask before changes"
        case .workspaceWrite: return "Workspace write"
        case .fullAccess: return "Full access"
        }
    }

    static func glyph(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: return "eye"
        case .askBeforeChanges: return "hand.raised"
        case .workspaceWrite: return "square.and.pencil"
        case .fullAccess: return "lock.open"
        }
    }

    private var mode: PermissionMode { controller.session.configuration.permissionMode }

    var body: some View {
        Menu {
            Picker("Permissions", selection: binding) {
                ForEach(PermissionMode.allCases, id: \.self) { mode in
                    Label(Self.label(for: mode), systemImage: Self.glyph(for: mode))
                        .tag(mode)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: Self.glyph(for: mode)).imageScale(.small)
                Text(Self.label(for: mode))
                    .lineLimit(1)
            }
            .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("What the agent may do without asking")
        .accessibilityLabel("Permissions")
        .accessibilityValue(Self.label(for: mode))
    }

    private var binding: Binding<PermissionMode> {
        Binding(
            get: { controller.session.configuration.permissionMode },
            set: { newMode in
                Task { await controller.setPermissionMode(newMode) }
            }
        )
    }
}

// MARK: - Approvals

/// A pending approval.
///
/// This is the highest-stakes surface in Juno Code — the reader is authorising
/// the agent to act on their machine — and the previous build rendered it as a
/// tinted strip with two unlabelled-risk buttons, visually lighter than the
/// completion card next to it. It now states the risk explicitly, names the
/// tool, and puts the destructive choice first in reading order with its
/// shortcut visible.
struct ApprovalCard: View {
    let request: ApprovalRequest
    let controller: SessionController

    /// Only `critical` — destructive, escaping, networked or privilege-elevating
    /// — gets the danger colour. Tinting every approval red trains the reader to
    /// dismiss the colour, which is exactly the wrong reflex on this surface.
    private var tint: Color {
        request.risk == .critical ? .junoDanger : .junoCaution
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: "hand.raised.fill")
                    .imageScale(.small)
                    .foregroundStyle(tint)
                Text("Approval required")
                    .font(.system(.callout, weight: .semibold))
                Spacer(minLength: JunoSpace.snug)
                StatusChip(
                    "\(request.risk.rawValue.capitalized) risk",
                    systemImage: "exclamationmark.triangle.fill",
                    tint: tint
                )
            }

            Text(request.summary)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            Text(request.toolName)
                .junoCodeSmall()
                .foregroundStyle(.tertiary)

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Deny") {
                    Task { await controller.deny(request.id) }
                }
                .keyboardShortcut(.escape, modifiers: .shift)
                .help("Deny (⇧⎋)")

                Button("Approve") {
                    Task { await controller.approve(request.id) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .keyboardShortcut(.return, modifiers: .shift)
                .help("Approve (⇧⏎)")
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(tint.opacity(0.55), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Approval required, \(request.risk.rawValue) risk: \(request.summary)"
        )
    }
}
