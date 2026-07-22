import AppKit
import SwiftUI
import JunoCodeCore

/// Left zone: workspaces, search, favorites, and sessions grouped by date.
struct SidebarView: View {
    @Bindable var model: WorkbenchModel
    @Binding var showingNewSession: Bool
    @State private var renamingSessionID: CodeSessionID?
    @State private var renameText = ""

    var body: some View {
        List(selection: $model.selectedSessionID) {
            workspacesSection
            if !model.favoriteSessions.isEmpty {
                Section("Favorites") {
                    ForEach(model.favoriteSessions, id: \.id) { session in
                        sessionRow(session)
                    }
                }
            }
            ForEach(model.groupedSessions, id: \.title) { group in
                Section(group.title) {
                    ForEach(group.sessions, id: \.id) { session in
                        sessionRow(session)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $model.sessionSearchText, placement: .sidebar, prompt: "Search sessions")
        .safeAreaInset(edge: .bottom) {
            newSessionButton
        }
        .overlay {
            if model.sessions.isEmpty, model.sessionSearchText.isEmpty {
                ContentUnavailableView(
                    "No sessions yet",
                    systemImage: "clock",
                    description: Text("Create a code session to get started.")
                )
                .allowsHitTesting(false)
            }
        }
        .alert("Rename Session", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Rename") {
                if let id = renamingSessionID {
                    let title = renameText
                    Task { await model.renameSession(id: id, title: title) }
                }
                renamingSessionID = nil
            }
            Button("Cancel", role: .cancel) {
                renamingSessionID = nil
            }
        }
    }

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renamingSessionID != nil },
            set: { if !$0 { renamingSessionID = nil } }
        )
    }

    // MARK: - Workspaces

    private var workspacesSection: some View {
        Section("Workspaces") {
            ForEach(model.workspaces.prefix(6), id: \.id) { record in
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(record.descriptor.displayName)
                            .lineLimit(1)
                        Text(abbreviatedPath(record.descriptor.localPathHint))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                } icon: {
                    Image(systemName: record.descriptor.isGitRepository
                        ? "arrow.triangle.branch"
                        : "folder")
                }
                .contextMenu {
                    Button("New Session Here") {
                        Task {
                            await model.createSession(
                                workspaceID: record.id,
                                configuration: AgentConfiguration(
                                    modelID: model.availableModels.first?.modelID
                                        ?? "default"
                                )
                            )
                        }
                    }
                    Button("Remove from Recents", role: .destructive) {
                        Task { await model.removeWorkspace(id: record.id) }
                    }
                }
            }
            Button {
                openWorkspacePanel()
            } label: {
                Label("Open Workspace…", systemImage: "plus.rectangle.on.folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .keyboardShortcut("o", modifiers: [.command, .shift])
            .accessibilityLabel("Open a workspace folder")
        }
    }

    private func openWorkspacePanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose a project folder for Juno Code"
        panel.prompt = "Open Workspace"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await model.addWorkspace(grantedURL: url) }
    }

    // MARK: - Sessions

    private func sessionRow(_ session: CodeSession) -> some View {
        HStack(spacing: JunoCodeTheme.Spacing.compact) {
            statusIndicator(session)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title)
                    .lineLimit(1)
                HStack(spacing: JunoCodeTheme.Spacing.tight) {
                    Text(model.workspaceName(for: session.workspaceID))
                    if let branch = session.gitBranch {
                        Text("·")
                        Image(systemName: "arrow.triangle.branch")
                            .imageScale(.small)
                        Text(branch)
                    }
                    Text("·")
                    Text(session.configuration.location.rawValue.capitalized)
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            }
            Spacer()
            if session.isFavorite {
                Image(systemName: "star.fill")
                    .imageScale(.small)
                    .foregroundStyle(JunoCodeTheme.caution)
            }
        }
        .tag(session.id)
        .contextMenu {
            Button(session.isFavorite ? "Remove Favorite" : "Add to Favorites") {
                Task { await model.toggleFavorite(id: session.id) }
            }
            Button("Rename…") {
                renameText = session.title
                renamingSessionID = session.id
            }
            Divider()
            Button("Delete", role: .destructive) {
                Task { await model.deleteSession(id: session.id) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(sessionAccessibilityLabel(session))
    }

    @ViewBuilder
    private func statusIndicator(_ session: CodeSession) -> some View {
        switch session.status {
        case .running, .stopping:
            ProgressView()
                .controlSize(.small)
                .tint(JunoCodeTheme.accent)
                .accessibilityLabel("Running")
        case .waitingForApproval:
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(JunoCodeTheme.caution)
                .accessibilityLabel("Waiting for approval")
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(JunoCodeTheme.failure)
                .accessibilityLabel("Failed")
        case .completed:
            Image(systemName: "checkmark.circle")
                .foregroundStyle(JunoCodeTheme.success)
                .accessibilityLabel("Completed")
        case .cancelled:
            Image(systemName: "stop.circle")
                .foregroundStyle(.secondary)
                .accessibilityLabel("Stopped")
        case .idle:
            Image(systemName: "circle.dotted")
                .foregroundStyle(.tertiary)
                .accessibilityLabel("Idle")
        }
    }

    private func sessionAccessibilityLabel(_ session: CodeSession) -> String {
        var parts = [session.title, model.workspaceName(for: session.workspaceID)]
        parts.append(session.status.rawValue)
        if session.hasPendingApproval { parts.append("waiting for approval") }
        return parts.joined(separator: ", ")
    }

    private var newSessionButton: some View {
        Button {
            showingNewSession = true
        } label: {
            Label("New Code Session", systemImage: "plus")
                .frame(maxWidth: .infinity)
        }
        .controlSize(.large)
        .buttonStyle(.borderedProminent)
        .tint(JunoCodeTheme.accent)
        .keyboardShortcut("n", modifiers: .command)
        .padding(JunoCodeTheme.Spacing.control)
        .background(.ultraThinMaterial)
        .accessibilityLabel("New code session")
    }

    private func abbreviatedPath(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }
}
