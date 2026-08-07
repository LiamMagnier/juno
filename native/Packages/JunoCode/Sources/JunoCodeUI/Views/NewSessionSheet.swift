import AppKit
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Configuration sheet for a new code session.
struct NewSessionSheet: View {
    @Bindable var model: WorkbenchModel
    let onRemoteTaskStarted: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    @State private var workspaceID: WorkspaceID?
    @State private var modelID = ""
    @State private var reasoningEffort: ReasoningEffort = .medium
    @State private var role: AgentRole = .engineer
    @State private var permissionMode: PermissionMode = .askBeforeChanges
    @State private var location: SessionLocation = .local
    @State private var computerUseEnabled = false

    // Cloud and Remote are server-owned tasks, so they need a target and an
    // initial prompt before they can be dispatched. These selections stay in
    // the sheet rather than being smuggled into the local session model.
    @State private var remoteRepositories: [RemoteRepositoryReference] = []
    @State private var remoteDevices: [RemoteDeviceTarget] = []
    @State private var remoteRepositoryID: String?
    @State private var remoteDeviceID: String?
    @State private var remoteWorkspaceID: String?
    @State private var remoteBaseRef = ""
    @State private var remotePrompt = ""
    @State private var remoteTargetsLoading = false
    @State private var remoteError: String?
    @State private var remoteTask: RemoteSessionHandle?
    @State private var isCreatingRemote = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("New Code Session")
                .font(.title2.weight(.semibold))
                .padding(JunoCodeTheme.Spacing.section)

            if let remoteTask {
                remoteTaskCreated(remoteTask)
            } else {
                Form {
                    if location == .local {
                        Picker("Workspace", selection: $workspaceID) {
                            Text("Choose…").tag(WorkspaceID?.none)
                            ForEach(model.workspaces, id: \.id) { record in
                                Text(record.descriptor.displayName)
                                    .tag(WorkspaceID?.some(record.id))
                            }
                        }
                        Button("Open Another Folder…") {
                            openPanel()
                        }
                        .buttonStyle(.link)
                    }

                    Divider()

                    Picker("Model", selection: $modelID) {
                        ForEach(model.availableModels) { option in
                            Text(option.displayName).tag(option.modelID)
                        }
                    }
                    Picker("Reasoning", selection: $reasoningEffort) {
                        Text("Low").tag(ReasoningEffort.low)
                        Text("Medium").tag(ReasoningEffort.medium)
                        Text("High").tag(ReasoningEffort.high)
                    }
                    Picker("Role", selection: $role) {
                        Text("Engineer").tag(AgentRole.engineer)
                        Text("Reviewer").tag(AgentRole.reviewer)
                        Text("Explainer").tag(AgentRole.explainer)
                    }
                    Picker("Permissions", selection: $permissionMode) {
                        Text("Read-only").tag(PermissionMode.readOnly)
                        Text("Ask before edits and commands").tag(PermissionMode.askBeforeChanges)
                        Text("Workspace write").tag(PermissionMode.workspaceWrite)
                        Text("Full access (critical actions still ask)").tag(PermissionMode.fullAccess)
                    }
                    Toggle("Enable Computer Use (Screen & Input Control)", isOn: $computerUseEnabled)
                    Picker("Runs", selection: $location) {
                        Text("On this Mac").tag(SessionLocation.local)
                        Text("Juno Cloud").tag(SessionLocation.cloud)
                        Text("Remote computer").tag(SessionLocation.remote)
                    }

                    if location == .local {
                        Text("Runs locally inside the selected workspace.")
                            .font(.caption)
                            .junoSecondaryInk()
                    } else {
                        remoteTargetForm
                    }
                }
                .formStyle(.grouped)

                HStack {
                    Spacer()
                    Button("Cancel", role: .cancel) {
                        dismiss()
                    }
                    .keyboardShortcut(.escape, modifiers: [])
                    Button(location == .local ? "Create Session" : "Start Remote Task") {
                        if location == .local {
                            createLocal()
                        } else {
                            Task { await createRemote() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(JunoCodeTheme.accent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSubmit)
                }
                .padding(JunoCodeTheme.Spacing.section)
            }
        }
        .frame(width: 460)
        .onAppear {
            workspaceID = model.workspaces.first?.id
            modelID = model.availableModels.first?.modelID ?? ""
        }
        .onChange(of: location) { _, newLocation in
            guard newLocation != .local else {
                remoteError = nil
                return
            }
            Task { await loadRemoteTargets(for: newLocation) }
        }
        .onChange(of: remoteDeviceID) { _, newID in
            let device = remoteDevices.first { $0.id == newID }
            remoteWorkspaceID = device?.workspaces.first?.id
        }
    }

    private var canSubmit: Bool {
        if location == .local {
            return workspaceID != nil && !modelID.isEmpty
        }
        return !isCreatingRemote
            && remoteTarget != nil
            && !remotePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var remoteTarget: CodeExecutionLocation? {
        switch location {
        case .local:
            return nil
        case .cloud:
            guard let repository = remoteRepositories.first(where: { $0.id == remoteRepositoryID })
            else { return nil }
            let branch = remoteBaseRef.trimmingCharacters(in: .whitespacesAndNewlines)
            return .cloud(repository: repository, baseRef: branch.isEmpty ? nil : branch)
        case .remote:
            guard let device = remoteDevices.first(where: { $0.id == remoteDeviceID }),
                let workspace = device.workspaces.first(where: { $0.id == remoteWorkspaceID }),
                device.canAcceptWork
            else { return nil }
            return .remote(device: device.reference, workspace: workspace)
        }
    }

    @ViewBuilder
    private var remoteTargetForm: some View {
        Section("Remote target") {
            if remoteTargetsLoading {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Loading available targets…")
                        .font(.caption)
                        .junoSecondaryInk()
                }
            }

            switch location {
            case .cloud:
                Picker("Repository", selection: $remoteRepositoryID) {
                    Text("Choose…").tag(String?.none)
                    ForEach(remoteRepositories, id: \.id) { repository in
                        Text(repository.id).tag(String?.some(repository.id))
                    }
                }
                TextField("Base branch", text: $remoteBaseRef)
                    .textContentType(.none)
                if remoteRepositories.isEmpty && !remoteTargetsLoading {
                    Text(remoteError ?? "No GitHub repositories are available to this account.")
                        .font(.caption)
                        .junoSecondaryInk()
                }

            case .remote:
                Picker("Computer", selection: $remoteDeviceID) {
                    Text("Choose…").tag(String?.none)
                    ForEach(remoteDevices) { device in
                        Text(deviceLabel(device)).tag(String?.some(device.id))
                    }
                }
                if let device = remoteDevices.first(where: { $0.id == remoteDeviceID }) {
                    Picker("Workspace", selection: $remoteWorkspaceID) {
                        Text("Choose…").tag(String?.none)
                        ForEach(device.workspaces, id: \.id) { workspace in
                            Text(workspace.name).tag(String?.some(workspace.id))
                        }
                    }
                    Text(device.canAcceptWork
                        ? "Ready to accept queued work."
                        : device.online
                            ? "Online, but this computer is not accepting queued work."
                            : "Offline. Start Juno Code on this computer first.")
                        .font(.caption)
                        .foregroundStyle(device.canAcceptWork ? Color.junoMutedForeground : Color.junoCaution)
                } else if !remoteTargetsLoading {
                    Text(remoteError ?? "No remote computers are available to this account.")
                        .font(.caption)
                        .junoSecondaryInk()
                }

            case .local:
                EmptyView()
            }

            Text("What should Juno do?")
                .font(.caption.weight(.medium))
            TextEditor(text: $remotePrompt)
                .frame(minHeight: 72, maxHeight: 120)
                .overlay {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.junoBorder)
                }

            if let remoteError {
                Label(remoteError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Refresh targets") {
                Task { await loadRemoteTargets(for: location) }
            }
            .buttonStyle(.link)
            .disabled(remoteTargetsLoading)
        }
    }

    private func deviceLabel(_ device: RemoteDeviceTarget) -> String {
        if device.canAcceptWork { return device.name }
        if device.online { return "\(device.name) · not accepting work" }
        return "\(device.name) · offline"
    }

    private func loadRemoteTargets(for location: SessionLocation) async {
        guard location != .local else { return }
        remoteTargetsLoading = true
        remoteError = nil
        defer { remoteTargetsLoading = false }

        switch location {
        case .cloud:
            switch await model.loadRemoteRepositories() {
            case .success(let repositories):
                remoteRepositories = repositories
                if !repositories.contains(where: { $0.id == remoteRepositoryID }) {
                    remoteRepositoryID = repositories.first?.id
                }
            case .failure(let error):
                remoteRepositories = []
                remoteRepositoryID = nil
                remoteError = error.localizedDescription
            }
        case .remote:
            switch await model.loadRemoteDevices() {
            case .success(let devices):
                remoteDevices = devices
                let selected = devices.first(where: { $0.id == remoteDeviceID && $0.canAcceptWork })
                    ?? devices.first(where: { $0.canAcceptWork })
                    ?? devices.first
                remoteDeviceID = selected?.id
                remoteWorkspaceID = selected?.workspaces.first?.id
            case .failure(let error):
                remoteDevices = []
                remoteDeviceID = nil
                remoteWorkspaceID = nil
                remoteError = error.localizedDescription
            }
        case .local:
            break
        }
    }

    private func openPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Workspace"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            if let record = await model.addWorkspace(grantedURL: url) {
                workspaceID = record.id
            }
        }
    }

    private func createLocal() {
        guard let workspaceID else { return }
        let configuration = AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            role: role,
            permissionMode: permissionMode,
            location: location,
            computerUseEnabled: computerUseEnabled
        )
        Task {
            await model.createSession(workspaceID: workspaceID, configuration: configuration)
        }
        dismiss()
    }

    private func createRemote() async {
        guard let remoteTarget else { return }
        isCreatingRemote = true
        remoteError = nil
        defer { isCreatingRemote = false }
        let result = await model.startRemoteSession(
            prompt: remotePrompt,
            at: remoteTarget
        )
        switch result {
        case .success(let task):
            remoteTask = task
            onRemoteTaskStarted?()
        case .failure(let error):
            remoteError = error.localizedDescription
        }
    }

    private func remoteTaskCreated(_ task: RemoteSessionHandle) -> some View {
        VStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.section) {
            Spacer(minLength: 0)
            Label("Remote task queued", systemImage: "checkmark.circle.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.junoSuccess)
            Text("Juno accepted the task on \(task.location.displayName).")
                .junoSecondaryInk()
            HStack(spacing: JunoCodeTheme.Spacing.tight) {
                Text("Task ID")
                    .font(.caption.weight(.medium))
                Text(task.taskID)
                    .font(.system(.caption, design: .monospaced))
                    .junoSecondaryInk()
                    .textSelection(.enabled)
            }
            Text("The task remains server-owned and can be followed from your signed-in Juno Code clients.")
                .font(.caption)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .tint(JunoCodeTheme.accent)
            }
        }
        .padding(JunoCodeTheme.Spacing.section)
    }
}
