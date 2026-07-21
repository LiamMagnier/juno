import AppKit
import SwiftUI
import JunoCodeCore

/// Configuration sheet for a new code session.
struct NewSessionSheet: View {
    @Bindable var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss

    @State private var workspaceID: WorkspaceID?
    @State private var modelID = ""
    @State private var reasoningEffort: ReasoningEffort = .medium
    @State private var role: AgentRole = .engineer
    @State private var permissionMode: PermissionMode = .askBeforeChanges
    @State private var location: SessionLocation = .local

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("New Code Session")
                .font(.title2.weight(.semibold))
                .padding(JunoCodeTheme.Spacing.section)

            Form {
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

                Divider()

                Picker("Model", selection: $modelID) {
                    ForEach(model.dependencies.availableModels) { option in
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
                Picker("Runs", selection: $location) {
                    Text("On this Mac").tag(SessionLocation.local)
                    Text("Juno Cloud (soon)").tag(SessionLocation.cloud)
                    Text("Remote (soon)").tag(SessionLocation.remote)
                }
                if location != .local {
                    Text("Cloud and Remote sessions arrive with the Juno account integration.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) {
                    dismiss()
                }
                .keyboardShortcut(.escape, modifiers: [])
                Button("Create Session") {
                    create()
                }
                .buttonStyle(.borderedProminent)
                .tint(JunoCodeTheme.accent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(workspaceID == nil || location != .local)
            }
            .padding(JunoCodeTheme.Spacing.section)
        }
        .frame(width: 460)
        .onAppear {
            workspaceID = model.workspaces.first?.id
            modelID = model.dependencies.availableModels.first?.modelID ?? ""
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

    private func create() {
        guard let workspaceID else { return }
        let configuration = AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            role: role,
            permissionMode: permissionMode,
            location: location,
            computerUseEnabled: false
        )
        Task {
            await model.createSession(workspaceID: workspaceID, configuration: configuration)
        }
        dismiss()
    }
}
