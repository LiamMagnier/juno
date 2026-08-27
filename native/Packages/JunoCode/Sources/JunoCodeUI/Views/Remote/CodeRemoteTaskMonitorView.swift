import JunoCodeKit
import JunoDesignSystem
import SwiftUI

/// The account's Cloud and Remote task ledger.
///
/// Juno Code's local workbench is intentionally session-oriented, while a
/// Cloud or Remote run is server-owned and can continue after this window has
/// changed modes or closed. This monitor is the bridge between those two
/// lifetimes: the list is account history, and the detail follows one task's
/// SSE cursor with the same approval and cancellation controls as Desktop Code
/// Studio.
public struct CodeRemoteTaskMonitorView: View {
    @Bindable private var model: NativeCodeModel
    @State private var selection: String?
    @Environment(\.dismiss) private var dismiss

    public init(model: NativeCodeModel) {
        self.model = model
    }

    public var body: some View {
        NavigationSplitView {
            taskList
                .navigationTitle("Remote tasks")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            JunoIconView(.refresh, size: 16)
                        }
                        .help("Refresh remote tasks")
                        .disabled(model.phase == .loading)
                    }
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        } detail: {
            detail
        }
        .frame(minWidth: 860, minHeight: 560)
        .task {
            await model.refresh()
            selectInitialTask()
        }
        .onChange(of: model.tasks) { _, _ in
            normalizeSelection()
        }
        .onChange(of: selection) { _, _ in
            openSelectedTask()
        }
        .onDisappear {
            // Polling remains account-scoped, but an SSE transcript should not
            // stay open after the reader dismisses the monitor.
            model.closeOpenTask()
        }
    }

    private var activeTasks: [NativeCodeTask] {
        model.tasks.filter(\.status.isActive)
    }

    private var completedTasks: [NativeCodeTask] {
        model.tasks.filter { !$0.status.isActive }
    }

    private var taskList: some View {
        List(selection: $selection) {
            if !activeTasks.isEmpty {
                Section("Active") {
                    ForEach(activeTasks) { taskRow($0) }
                }
            }

            if !completedTasks.isEmpty {
                Section("Recent") {
                    ForEach(completedTasks) { taskRow($0) }
                }
            }

            if model.tasks.isEmpty {
                ContentUnavailableView {
                    JunoIconLabel(verbatim: "No remote tasks", icon: .cloud, size: 20)
                } description: {
                    Text(
                        model.lastErrorDescription
                            ?? "Cloud and Remote runs will appear here."
                    )
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.sidebar)
        .frame(minWidth: 270, idealWidth: 310, maxWidth: 380)
        .overlay(alignment: .bottom) {
            if let error = model.lastErrorDescription, !model.tasks.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .lineLimit(3)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.tight)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Opaque: an error message is the most important text on
                    // this surface, and material behind it makes its contrast
                    // depend on the desktop picture.
                    .background(Color.junoSurface)
            }
        }
    }

    private func taskRow(_ task: NativeCodeTask) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            statusView(task.status)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .lineLimit(1)
                Text(task.whereItRuns.isEmpty ? task.target.label : task.whereItRuns)
                    .font(.caption2)
                    .junoSecondaryInk()
                    .lineLimit(1)
                Text(task.updatedAt, style: .relative)
                    .font(.caption2)
                    .junoMetaInk()
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .tag(task.id)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(task.title), \(task.status.label), \(task.whereItRuns), updated \(task.updatedAt.formatted())"
        )
    }

    @ViewBuilder
    private var detail: some View {
        if let selection {
            CodeRemoteTaskDetailView(
                model: model,
                taskID: selection,
                selection: $selection
            )
        } else {
            ContentUnavailableView {
                JunoIconLabel(verbatim: "Select a remote task", icon: .cloud, size: 20)
            } description: {
                Text("Choose an active or recent run to follow its live events.")
            }
        }
    }

    private func selectInitialTask() {
        guard selection == nil else {
            normalizeSelection()
            return
        }
        selection = model.openTask?.id ?? model.tasks.first?.id
        openSelectedTask()
    }

    private func normalizeSelection() {
        guard let selection else {
            selectInitialTask()
            return
        }
        guard model.tasks.contains(where: { $0.id == selection }) else {
            self.selection = model.tasks.first?.id
            return
        }
        if model.openTask?.id != selection {
            openSelectedTask()
        }
    }

    private func openSelectedTask() {
        guard let selection,
            let task = model.tasks.first(where: { $0.id == selection })
        else {
            model.closeOpenTask()
            return
        }
        model.open(task)
    }

    @ViewBuilder
    private func statusView(_ status: NativeCodeTaskStatus) -> some View {
        switch status {
        case .queued:
            JunoIconView(.refresh, size: 15)
                .junoSecondaryInk()
                .accessibilityLabel("Queued")
        case .running:
            ProgressView()
                .controlSize(.small)
                .tint(Color.junoAccent)
                .accessibilityLabel("Running")
        case .awaitingApproval:
            JunoIconView(.permission, size: 15)
                .foregroundStyle(Color.junoCaution)
                .accessibilityLabel("Waiting for approval")
        case .done:
            JunoIconView(.check, size: 15)
                .foregroundStyle(Color.junoSuccess)
                .accessibilityLabel("Completed")
        case .failed:
            JunoIconView(.error, size: 15)
                .foregroundStyle(Color.junoDanger)
                .accessibilityLabel("Failed")
        case .cancelled:
            JunoIconView(.stop, size: 15)
                .junoSecondaryInk()
                .accessibilityLabel("Cancelled")
        }
    }
}

/// The reusable detail surface for one account-owned remote/cloud task.
///
/// The monitor presents it inside a split view, while the integrated macOS
/// Code workspace embeds the same surface in its main canvas. Keeping this as a
/// public view prevents the two entry points from drifting: approvals,
/// cancellation, PR links, live reconnect state and follow-up turns are one
/// product surface regardless of where the task was opened.
public struct CodeRemoteTaskDetailView: View {
    @Bindable var model: NativeCodeModel
    let taskID: String
    @Binding var selection: String?
    @State private var approvalActionInFlight = false
    @State private var followUpDraft = ""
    @State private var followUpInFlight = false

    public init(
        model: NativeCodeModel,
        taskID: String,
        selection: Binding<String?>
    ) {
        self.model = model
        self.taskID = taskID
        self._selection = selection
    }

    private static let measure: CGFloat = 760

    private var task: NativeCodeTask? {
        model.tasks.first { $0.id == taskID }
    }

    public var body: some View {
        Group {
            if let task {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                            header(task)
                            Divider().overlay(Color.junoSeparator)
                            if model.events.isEmpty {
                                Text("Waiting for the first event…")
                                    .junoSecondaryInk()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } else {
                                ForEach(model.events) { event in
                                    eventRow(event).id(event.seq)
                                }
                            }
                            if model.streamReconnectAttempt > 0 {
                                HStack(spacing: JunoSpace.snug) {
                                    ProgressView().controlSize(.small)
                                    Text("Reconnecting to this run…")
                                        .font(.caption)
                                        .junoSecondaryInk()
                                    Text("attempt \(model.streamReconnectAttempt)")
                                        .font(.caption2)
                                        .junoMetaInk()
                                        .monospacedDigit()
                                }
                            } else if model.isStreaming {
                                HStack(spacing: JunoSpace.snug) {
                                    ProgressView().controlSize(.small)
                                    Text("Following this run")
                                        .font(.caption)
                                        .junoSecondaryInk()
                                }
                            }
                        }
                        .frame(maxWidth: Self.measure, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(JunoSpace.region)
                    }
                    .onChange(of: model.events.count) { _, _ in
                        guard let last = model.events.last?.seq else { return }
                        withAnimation(JunoMotion.fast) {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    footer(task)
                }
            } else {
                ContentUnavailableView {
                    JunoIconLabel(
                        verbatim: "That task is no longer available",
                        icon: .cloud,
                        size: 20
                    )
                } description: {
                    Text("Refresh the remote task list to continue.")
                }
            }
        }
        .background(Color.junoCanvasWarm)
    }

    private func header(_ task: NativeCodeTask) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: JunoSpace.cozy)
                statusLabel(task.status)
            }
            HStack(spacing: JunoSpace.snug) {
                JunoIconLabel(
                    verbatim: task.target.label,
                    icon: task.target.junoIcon,
                    size: 14
                )
                if !task.whereItRuns.isEmpty {
                    Text("·")
                    Text(task.whereItRuns)
                }
                if let branch = task.baseRef, !branch.isEmpty {
                    Text("·")
                    JunoIconLabel(verbatim: branch, icon: .branch, size: 14)
                }
            }
            .font(.caption)
            .junoSecondaryInk()
            Text(task.prompt)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func statusLabel(_ status: NativeCodeTaskStatus) -> some View {
        Text(status.label)
            .font(.caption.weight(.medium))
            .foregroundStyle(status.color)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, 5)
            .background(status.color.opacity(0.12), in: Capsule())
    }

    private func eventRow(_ event: NativeCodeEvent) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoIconView(event.kind.junoIcon, size: 15)
                .foregroundStyle(event.kind.color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(event.title)
                    .font(.callout)
                if let detail = event.detail {
                    Text(detail)
                        .font(.system(.caption, design: event.kind.isTechnical ? .monospaced : .default))
                        .junoSecondaryInk()
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            Text(event.createdAt, style: .time)
                .font(.caption2)
                .junoMetaInk()
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func footer(_ task: NativeCodeTask) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let approval = model.pendingApproval {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoIconLabel(verbatim: "Approval required", icon: .permission, size: 15)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Color.junoCaution)
                    Text(approval.summary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = approval.detail {
                        Text(detail)
                            .font(.caption)
                            .junoSecondaryInk()
                            .textSelection(.enabled)
                    }
                    HStack {
                        Button("Deny", role: .destructive) {
                            respondToApproval(approve: false)
                        }
                        .disabled(approvalActionInFlight)
                        Button("Approve") {
                            respondToApproval(approve: true)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .disabled(approvalActionInFlight)
                        if approvalActionInFlight {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("Sending approval response")
                        }
                    }
                }
                .padding(JunoSpace.cozy)
                .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.well))
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.well)
                        .strokeBorder(Color.junoCaution.opacity(0.45))
                }
            }

            if task.status.isTerminal, task.conversationID != nil {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoIconLabel(
                        verbatim: "Continue this Code conversation",
                        icon: .conversation,
                        size: 15
                    )
                    .font(.callout.weight(.medium))
                    Text(
                        "Start a fresh run with the same durable transcript and workspace target."
                    )
                    .font(.caption)
                    .junoSecondaryInk()
                    TextField("Ask Juno to continue…", text: $followUpDraft, axis: .vertical)
                        .lineLimit(2...5)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { sendFollowUp() }
                    HStack {
                        Spacer(minLength: 0)
                        Button(followUpInFlight ? "Starting…" : "Send follow-up") {
                            sendFollowUp()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .disabled(
                            followUpInFlight
                                || followUpDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                    }
                }
                .padding(JunoSpace.cozy)
                .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.well))
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.well)
                        .strokeBorder(Color.junoSeparator)
                }
            }

            HStack(spacing: JunoSpace.cozy) {
                if let url = task.pullRequestURL {
                    Link(destination: url) {
                        JunoIconLabel(verbatim: "Open pull request", icon: .external, size: 14)
                    }
                }
                Spacer(minLength: 0)
                if task.status.isActive {
                    Button(model.isMutating ? "Stopping…" : "Stop task", role: .destructive) {
                        Task { await model.cancelOpenTask() }
                    }
                    .disabled(model.isMutating)
                }
            }
        }
        .frame(maxWidth: Self.measure, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, JunoSpace.region)
        .padding(.bottom, JunoSpace.regular)
    }

    private func respondToApproval(approve: Bool) {
        guard !approvalActionInFlight else { return }
        approvalActionInFlight = true
        Task {
            await model.respondToApproval(approve: approve)
            approvalActionInFlight = false
        }
    }

    private func sendFollowUp() {
        guard !followUpInFlight else { return }
        let prompt = followUpDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        followUpInFlight = true
        Task {
            if let task = await model.sendFollowUp(prompt: prompt) {
                followUpDraft = ""
                selection = task.id
            }
            followUpInFlight = false
        }
    }
}

private extension NativeCodeTarget {
    var label: String {
        switch self {
        case .cloud: "Cloud"
        case .device: "Remote computer"
        }
    }

    var junoIcon: JunoIcon {
        switch self {
        case .cloud: .cloud
        case .device: .device
        }
    }
}

private extension NativeCodeTaskStatus {
    var label: String {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        case .awaitingApproval: "Waiting for approval"
        case .done: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }

    var color: Color {
        switch self {
        case .awaitingApproval: Color.junoCaution
        case .done: Color.junoSuccess
        case .failed: Color.junoDanger
        default: .junoMutedForeground
        }
    }
}

private extension NativeCodeEvent.Kind {
    var junoIcon: JunoIcon {
        switch self {
        case .status: .refresh
        case .user: .user
        case .text: .conversation
        case .tool: .tools
        case .fileChange: .file
        case .approvalRequest, .approvalResponse: .permission
        case .cancelRequest: .stop
        case .error: .error
        case .done: .check
        case .agent: .user
        case .preview: .device
        case .testRun: .check
        // The rollback verbs. `rollbackReady` is a host capability
        // advertisement that `decodeEvent` deliberately keeps so the log
        // decodes without dropping it, and which the monitor does not render;
        // the other four are real, user-visible outcomes of a change being
        // accepted, rejected or undone. They are enumerated rather than left to
        // a `default` so the next verb added to `NativeCodeEvent.Kind` fails
        // this switch instead of silently rendering as a dotted circle.
        case .rollbackReady: .refresh
        case .acceptChange: .check
        case .rejectChange: .close
        case .undoChange: .refresh
        case .rollbackResult: .refresh
        }
    }

    var color: Color {
        switch self {
        case .error: Color.junoDanger
        case .approvalRequest, .approvalResponse: Color.junoCaution
        case .preview: Color.junoAccent
        case .testRun: Color.junoSuccess
        default: .junoMutedForeground
        }
    }

    var isTechnical: Bool {
        self == .tool || self == .fileChange || self == .error || self == .testRun || self == .preview
    }
}
