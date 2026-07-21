import SwiftUI
import JunoCodeCore

// MARK: - Git

struct GitTab: View {
    @Bindable var controller: SessionController
    @State private var commitMessage = ""
    @State private var committing = false

    var body: some View {
        if !controller.context.record.descriptor.isGitRepository {
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
                                .font(.junoMono)
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
                                .foregroundStyle(JunoCodeTheme.success)
                        } else {
                            ForEach(status.files) { file in
                                HStack {
                                    Text("\(file.indexState)\(file.worktreeState)")
                                        .font(.junoMonoSmall)
                                        .foregroundStyle(
                                            file.isConflicted
                                                ? JunoCodeTheme.failure
                                                : file.isStaged
                                                    ? JunoCodeTheme.success
                                                    : JunoCodeTheme.caution
                                        )
                                        .frame(width: 26)
                                    Text(file.path)
                                        .font(.junoMono)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            VStack(alignment: .leading, spacing: JunoCodeTheme.Spacing.compact) {
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
                                    .tint(JunoCodeTheme.accent)
                                    .disabled(
                                        commitMessage.trimmingCharacters(in: .whitespaces).isEmpty
                                            || committing
                                    )
                                }
                            }
                            .padding(.top, JunoCodeTheme.Spacing.tight)
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
                                    Text(commit.shortHash).font(.junoMonoSmall)
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
                .padding(JunoCodeTheme.Spacing.compact)
                .accessibilityLabel("Filter files")
            if searchText.isEmpty {
                List {
                    OutlineGroupView(controller: controller, entries: controller.rootEntries)
                }
                .listStyle(.inset)
            } else {
                List(searchResults) { entry in
                    Label(entry.path.value, systemImage: "doc")
                        .font(.junoMono)
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
            searchResults = (try? await controller.context.index.findFiles(
                nameContains: searchText,
                limit: 100
            )) ?? []
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
                LabeledContent("Name", value: controller.context.record.descriptor.displayName)
                LabeledContent(
                    "Path",
                    value: (controller.context.record.descriptor.localPathHint as NSString)
                        .abbreviatingWithTildeInPath
                )
                LabeledContent(
                    "Git",
                    value: controller.context.record.descriptor.isGitRepository ? "Yes" : "No"
                )
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
                            .font(.junoMono)
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
    var body: some View {
        VStack(spacing: JunoCodeTheme.Spacing.content) {
            Image(systemName: "display")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.secondary)
            Text("Computer Use")
                .font(.headline)
            Text("Screen control is off. It requires Screen Recording and Accessibility permissions, an explicit per-session opt-in, and ships in a later build. Nothing activates automatically.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            Button("Enable…") {}
                .disabled(true)
                .help("Computer Use arrives in a later build.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
