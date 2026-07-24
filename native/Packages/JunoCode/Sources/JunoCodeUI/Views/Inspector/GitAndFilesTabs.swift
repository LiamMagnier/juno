import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Git

struct GitTab: View {
    @Bindable var controller: SessionController
    @State private var commitMessage = ""
    @State private var committing = false

    var body: some View {
        if !controller.isGitRepository {
            ContentUnavailableView(
                "Not a Git repository",
                systemImage: "arrow.triangle.branch",
                description: Text("Initialize a repository to track changes with Git.")
            )
        } else {
            List {
                if let status = controller.gitStatus {
                    Section("Branch") {
                        HStack {
                            Image(systemName: "arrow.triangle.branch")
                            Text(status.branch ?? "detached HEAD")
                                .junoCode()
                            Spacer()
                            if status.ahead > 0 {
                                Label("\(status.ahead)", systemImage: "arrow.up")
                                    .font(.caption)
                            }
                            if status.behind > 0 {
                                Label("\(status.behind)", systemImage: "arrow.down")
                                    .font(.caption)
                            }
                        }
                    }
                    Section("Status") {
                        if status.isClean {
                            Label("Working tree clean", systemImage: "checkmark.circle")
                                .foregroundStyle(Color.junoSuccess)
                        } else {
                            ForEach(status.files) { file in
                                HStack {
                                    Text("\(file.indexState)\(file.worktreeState)")
                                        .junoCodeSmall()
                                        .foregroundStyle(
                                            file.isConflicted
                                                ? Color.junoDanger
                                                : file.isStaged
                                                    ? Color.junoSuccess
                                                    : Color.junoCaution
                                        )
                                        .frame(width: 26)
                                    Text(file.path)
                                        .junoCode()
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                                TextField(
                                    "Commit message",
                                    text: $commitMessage,
                                    axis: .vertical
                                )
                                .lineLimit(1...4)
                                .textFieldStyle(.roundedBorder)
                                HStack {
                                    Spacer()
                                    Button(committing ? "Committing…" : "Stage All & Commit") {
                                        commit()
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(Color.junoAccent)
                                    .disabled(
                                        commitMessage.trimmingCharacters(in: .whitespaces).isEmpty
                                            || committing
                                    )
                                }
                            }
                            .padding(.top, JunoSpace.hairline)
                        }
                    }
                }
                Section("Recent commits") {
                    if controller.gitHistory.isEmpty {
                        Text("No commits yet.").foregroundStyle(.secondary)
                    } else {
                        ForEach(controller.gitHistory) { commit in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(commit.subject)
                                    .lineLimit(1)
                                HStack {
                                    Text(commit.shortHash).junoCodeSmall()
                                    Text(commit.author)
                                    Text(commit.date, style: .relative)
                                }
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .listStyle(.inset)
            .refreshable {
                await controller.refreshWorkspacePanels()
            }
        }
    }

    private func commit() {
        committing = true
        let message = commitMessage
        Task {
            if await controller.commit(message: message) {
                commitMessage = ""
            }
            committing = false
        }
    }
}

// MARK: - Files

struct FilesTab: View {
    @Bindable var controller: SessionController
    @State private var searchText = ""
    @State private var searchResults: [FileEntry] = []

    var body: some View {
        VStack(spacing: 0) {
            TextField("Filter files by name", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .padding(JunoSpace.snug)
                .accessibilityLabel("Filter files")
            if searchText.isEmpty {
                List {
                    OutlineGroupView(controller: controller, entries: controller.rootEntries)
                }
                .listStyle(.inset)
            } else {
                List(searchResults) { entry in
                    Label(entry.path.value, systemImage: "doc")
                        .junoCode()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .listStyle(.inset)
            }
        }
        .task(id: searchText) {
            guard !searchText.isEmpty else {
                searchResults = []
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled else { return }
            searchResults = await controller.findFiles(
                nameContains: searchText,
                limit: 100
            )
        }
    }
}

/// Lazy expanding directory tree.
struct OutlineGroupView: View {
    let controller: SessionController
    let entries: [FileEntry]

    var body: some View {
        ForEach(entries) { entry in
            if entry.isDirectory {
                DirectoryDisclosure(controller: controller, entry: entry)
            } else {
                Label(entry.path.lastComponent, systemImage: "doc")
                    .font(.callout)
            }
        }
    }
}

struct DirectoryDisclosure: View {
    let controller: SessionController
    let entry: FileEntry
    @State private var expanded = false
    @State private var children: [FileEntry] = []

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            OutlineGroupView(controller: controller, entries: children)
        } label: {
            Label(entry.path.lastComponent, systemImage: "folder")
                .font(.callout)
        }
        .task(id: expanded) {
            if expanded, children.isEmpty {
                children = await controller.listDirectory(entry.path)
            }
        }
    }
}

// MARK: - Context

struct ContextTab: View {
    @Bindable var controller: SessionController

    var body: some View {
        List {
            Section("Workspace") {
                LabeledContent("Name", value: controller.workspaceDisplayName)
                LabeledContent("Path", value: controller.workspacePathDisplay)
                LabeledContent("Git", value: controller.isGitRepository ? "Yes" : "No")
            }
            Section("Detected toolchains") {
                if controller.testSuggestions.isEmpty {
                    Text("None detected.").foregroundStyle(.secondary)
                } else {
                    ForEach(controller.testSuggestions) { suggestion in
                        Label(suggestion.toolchain, systemImage: "wrench.and.screwdriver")
                    }
                }
            }
            Section("Instruction files") {
                if controller.instructionFiles.isEmpty {
                    Text("No repository instruction files found.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(controller.instructionFiles) { file in
                        Label(file.path.value, systemImage: "doc.text")
                            .junoCode()
                    }
                    Text("Instructions are context for the agent, never policy: they cannot override permissions or approvals.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Section("Session") {
                LabeledContent("Model", value: controller.session.configuration.modelID)
                LabeledContent(
                    "Reasoning",
                    value: controller.session.configuration.reasoningEffort.rawValue.capitalized
                )
                LabeledContent(
                    "Role",
                    value: controller.session.configuration.role.rawValue.capitalized
                )
                Picker(
                    "Permissions",
                    selection: Binding(
                        get: { controller.session.configuration.permissionMode },
                        set: { newMode in
                            Task { await controller.setPermissionMode(newMode) }
                        }
                    )
                ) {
                    Text("Read-only").tag(PermissionMode.readOnly)
                    Text("Ask before changes").tag(PermissionMode.askBeforeChanges)
                    Text("Workspace write").tag(PermissionMode.workspaceWrite)
                    Text("Full access").tag(PermissionMode.fullAccess)
                }
            }
        }
        .listStyle(.inset)
    }
}

// MARK: - Computer

struct ComputerTab: View {
    @State private var screenCaptureGranted = true
    @State private var accessibilityGranted = true
    @State private var isActive = true
    @State private var journal: [String] = [
        "Session started · Driver ready",
        "Screen Capture Permission: Granted",
        "Accessibility Permission: Granted",
        "Display Bounds: 1728 x 1117 (Retina Display 0)",
        "Safety Envelope: Step-by-step consent active"
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Computer Use Automation", systemImage: "display")
                        .font(.headline)
                    Spacer()
                    Toggle("", isOn: $isActive)
                        .toggleStyle(.switch)
                }

                Text("Allows Juno Code to capture screen state and execute desktop actions with explicit approval step-by-step.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    permissionBadge("Screen Capture", granted: screenCaptureGranted)
                    permissionBadge("Accessibility", granted: accessibilityGranted)
                }
            }
            .padding(14)
            .background(Color.junoRaised)

            Divider()

            List {
                Section("Journal & System Driver Events") {
                    ForEach(journal, id: \.self) { entry in
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(Color.junoSuccess)
                                .font(.caption)
                            Text(entry)
                                .font(.caption.monospaced())
                        }
                    }
                }
            }
            .listStyle(.inset)
        }
    }

    private func permissionBadge(_ name: String, granted: Bool) -> some View {
        HStack(spacing: 4) {
            Circle().fill(granted ? Color.junoSuccess : Color.junoDanger).frame(width: 6, height: 6)
            Text("\(name): \(granted ? "Granted" : "Missing")")
                .font(.caption2)
                .foregroundStyle(granted ? Color.junoSuccess : Color.junoDanger)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(granted ? Color.junoSuccess.opacity(0.12) : Color.junoDanger.opacity(0.12)))
    }
}
