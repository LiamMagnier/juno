import SwiftUI
import JunoCodeCore
import JunoCodeKit
import JunoDesignSystem

/// Everything a new local session starts with.
public struct StudioDraft: Equatable {
    public let workspaceID: WorkspaceID?
    public let prompt: String
    public let mode: StudioMode
    public let modelID: String
    public let reasoningEffort: ReasoningEffort?
    public let isolatedWorktree: Bool
    public let attachments: [CodeAttachment]
    public let fileReferences: [WorkspacePath]

    public var configuration: AgentConfiguration {
        AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            behavior: mode.behavior,
            // Plan and Answer are read-only by behaviour; the stored level is
            // what the session returns to if the reader switches it to editing.
            permissionMode: mode.behavior == .code ? mode.permission : .askBeforeChanges,
            location: .local
        )
    }

    /// A thread's title from its first line, bounded.
    public var title: String {
        let firstLine = prompt
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? prompt
        return firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
    }
}

/// The screen a session starts on: a greeting, where it runs, and the
/// composer. Nothing else — no starter cards, no hero mark. The sidebar holds
/// the history; this holds the next thing.
public struct StudioLanding: View {
    let workbench: WorkbenchModel
    let code: NativeCodeModel?
    let project: WorkspaceRecord?
    let isStarting: Bool
    let selectProject: (WorkspaceID?) -> Void
    let addProject: () -> Void
    let startLocal: (StudioDraft) -> Void
    let openTask: (NativeCodeTask) -> Void

    @State private var prompt: String
    @State private var environment: CodeEnvironmentChoice
    @State private var mode: StudioMode
    @State private var modelID: String
    @State private var effort: ReasoningEffort?
    @State private var attachments: [CodeAttachment] = []
    @State private var fileReferences: [WorkspacePath] = []
    @State private var branch: String?
    @State private var remoteError: String?
    /// Set the moment a cloud or device start is sent, before the task that
    /// sends it has run. `isStarting` is the host's local-only flag and
    /// `NativeCodeModel.isMutating` is set only once that task's body starts,
    /// so a second Return or a Return then a click in between created, and
    /// billed, a second remote task for the same prompt.
    @State private var isSubmittingRemote = false
    @FocusState private var focused: Bool

    public init(
        workbench: WorkbenchModel,
        code: NativeCodeModel?,
        project: WorkspaceRecord?,
        isStarting: Bool,
        initialPrompt: String? = nil,
        initialEnvironment: CodeEnvironmentChoice? = nil,
        selectProject: @escaping (WorkspaceID?) -> Void,
        addProject: @escaping () -> Void,
        startLocal: @escaping (StudioDraft) -> Void,
        openTask: @escaping (NativeCodeTask) -> Void
    ) {
        self.workbench = workbench
        self.code = code
        self.project = project
        self.isStarting = isStarting
        self.selectProject = selectProject
        self.addProject = addProject
        self.startLocal = startLocal
        self.openTask = openTask
        let defaults = CodeDefaults.shared.configuration(availableModels: workbench.availableModels)
        _prompt = State(initialValue: initialPrompt ?? "")
        _environment = State(initialValue: initialEnvironment ?? CodeDefaults.shared.environment)
        _mode = State(initialValue: StudioMode(behavior: .code, permission: defaults.permissionMode))
        _modelID = State(initialValue: defaults.modelID)
        _effort = State(initialValue: defaults.reasoningEffort)
    }

    private var isRemote: Bool { !environment.isLocal }

    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Why Send is off, said once under the composer.
    private var blockingReason: String? {
        switch environment {
        case .local:
            return nil
        case .worktree:
            if project == nil { return "Choose a project to work in a worktree." }
            if project?.descriptor.isGitRepository == false {
                return "This folder is not a Git repository, so the session will work in it directly."
            }
            return nil
        case .cloud:
            guard let code else { return "Cloud runs are unavailable." }
            if !attachments.isEmpty { return "Pictures and file mentions run on this Mac only." }
            if code.selectedRepository == nil { return "Choose a GitHub repository." }
            return code.startBlockedReason
        case .device:
            guard let code else { return "Other computers are unavailable." }
            if !attachments.isEmpty { return "Pictures and file mentions run on this Mac only." }
            if code.devices.isEmpty { return "No other computer is signed in to Juno." }
            return code.startBlockedReason
        }
    }

    private var canSend: Bool {
        !isStarting && !isSubmittingRemote
            && !(isRemote && (code?.isMutating ?? false))
            && (!trimmed.isEmpty || !attachments.isEmpty)
            && (environment == .worktree || blockingReason == nil)
            && !modelID.isEmpty
    }

    private var greeting: String {
        if let project { return "What should we build in \(project.descriptor.displayName)?" }
        return "What should we build?"
    }

    public var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: JunoSpace.region)
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                Text(greeting)
                    .font(Studio.Font.display)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentTransition(.opacity)

                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    placeRow
                    StudioComposer(
                        text: $prompt,
                        placeholder: isRemote ? "Describe the task" : "Describe the change you want",
                        attachments: attachments,
                        addAttachment: isRemote ? nil : { attachments.append($0) },
                        removeAttachment: { id in attachments.removeAll { $0.id == id } },
                        searchFiles: fileSearch,
                        chooseFile: { entry in
                            if !entry.isDirectory, !fileReferences.contains(entry.path) {
                                fileReferences.append(entry.path)
                            }
                        },
                        runCommand: { command, _ in
                            if let behavior = command.behavior {
                                mode = StudioMode(behavior: behavior, permission: mode.permission)
                            }
                        },
                        canSend: canSend,
                        send: send,
                        focus: $focused,
                        fieldIdentifier: "juno.code.launch-prompt"
                    ) {
                        StudioModeChip(mode: mode, select: { mode = $0 }, isEnabled: !isRemote)
                    } trailing: {
                        StudioModelChip(
                            models: workbench.availableModels,
                            modelID: modelID,
                            effort: effort,
                            selectModel: { id in
                                modelID = id
                                if let model = workbench.availableModels.first(where: { $0.modelID == id }),
                                   let refitted = model.refittingEffort(effort)
                                {
                                    effort = refitted
                                }
                            },
                            selectEffort: { effort = $0 },
                            isEnabled: !isRemote
                        )
                    }
                    footnote
                }
            }
            .frame(maxWidth: 680)
            .padding(.horizontal, Studio.Metrics.gutter)
            Spacer(minLength: JunoSpace.region)
            Spacer(minLength: JunoSpace.region)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Studio.Surface.canvas)
        .onAppear { focused = true }
        .task(id: project?.id) { await loadBranch() }
        .onChange(of: environment) { _, choice in configureRemote(choice) }
        .onChange(of: workbench.availableModels.map(\.modelID)) { _, ids in
            if !ids.contains(modelID) { modelID = ids.first ?? "" }
        }
    }

    // MARK: Place

    /// Where the session runs: the project, the environment, the branch.
    private var placeRow: some View {
        HStack(spacing: JunoSpace.hairline) {
            switch environment {
            case .local, .worktree:
                projectMenu
            case .cloud:
                repositoryMenu
            case .device:
                deviceMenu
            }
            environmentMenu
            if environment.isLocal, let branch {
                StudioChipLabel(title: branch, icon: .branch, showsChevron: false)
                    .help(environment == .worktree ? "A new worktree branches from \(branch)" : "The branch this session works on")
            }
            Spacer()
        }
        .padding(.leading, JunoSpace.hairline)
    }

    private var projectMenu: some View {
        Menu {
            ForEach(workbench.workspaces) { record in
                Button {
                    selectProject(record.id)
                } label: {
                    if record.id == project?.id {
                        Label(record.descriptor.displayName, systemImage: "checkmark")
                    } else {
                        Text(record.descriptor.displayName)
                    }
                }
            }
            if !workbench.workspaces.isEmpty { Divider() }
            Button("No Project") { selectProject(nil) }
            Button("Open Folder…", action: addProject)
        } label: {
            StudioChipLabel(
                title: project?.descriptor.displayName ?? "No project",
                icon: project == nil ? .folderPlus : .projects
            )
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .help("The folder Juno works in (⌘O to open another)")
        .accessibilityIdentifier("juno.code.launch-project")
    }

    private var environmentMenu: some View {
        Menu {
            Section("On this Mac") {
                ForEach([CodeEnvironmentChoice.local, .worktree]) { choice in
                    Button { environment = choice } label: {
                        Text(choice.label)
                        Text(choice.detail)
                    }
                    .disabled(choice == .worktree && project?.descriptor.isGitRepository != true)
                }
            }
            if code != nil {
                Section("Elsewhere") {
                    ForEach([CodeEnvironmentChoice.cloud, .device]) { choice in
                        Button { environment = choice } label: {
                            Text(choice.label)
                            Text(choice.detail)
                        }
                    }
                }
            }
        } label: {
            StudioChipLabel(title: environment.label, icon: environmentIcon)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .help(environment.detail)
        .accessibilityIdentifier("juno.code.launch-target")
    }

    private var environmentIcon: JunoIcon {
        switch environment {
        case .local: .monitor
        case .worktree: .fork
        case .cloud: .cloud
        case .device: .device
        }
    }

    @ViewBuilder
    private var repositoryMenu: some View {
        if let code {
            Menu {
                switch code.repositories {
                case .idle, .loading:
                    Text("Loading repositories…")
                case let .ready(repositories):
                    if repositories.isEmpty { Text("No repositories") }
                    ForEach(repositories) { repository in
                        Button(repository.fullName) { code.selectedRepository = repository }
                    }
                case .unavailable:
                    Text("GitHub is not connected")
                }
            } label: {
                StudioChipLabel(title: code.selectedRepository?.fullName ?? "Choose repository", icon: .branch)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
        }
    }

    @ViewBuilder
    private var deviceMenu: some View {
        if let code {
            Menu {
                ForEach(code.devices) { device in
                    Section(device.name + (device.online ? "" : " · offline")) {
                        ForEach(device.workspaces) { workspace in
                            Button(workspace.name) {
                                code.selectedDeviceID = device.id
                                code.selectedWorkspaceKey = workspace.id
                            }
                        }
                    }
                }
            } label: {
                StudioChipLabel(
                    title: [code.selectedDevice?.name, code.selectedWorkspace?.name]
                        .compactMap { $0 }
                        .joined(separator: " · ")
                        .nonEmpty ?? "Choose computer",
                    icon: .device
                )
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
        }
    }

    @ViewBuilder
    private var footnote: some View {
        let message = remoteError ?? (canSend || trimmed.isEmpty ? nil : blockingReason)
            ?? (environment == .worktree ? blockingReason : nil)
        HStack {
            if isStarting || isSubmittingRemote {
                StudioSpinner().frame(width: 10, height: 10)
                Text("Starting…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
            } else if let message {
                Text(message)
                    .font(Studio.Font.meta)
                    .foregroundStyle(remoteError == nil ? Studio.Ink.tertiary : Studio.Ink.danger)
            } else {
                Text(mode.detail)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 18)
    }

    // MARK: Actions

    private var fileSearch: ((String) async -> [FileEntry])? {
        guard let project, environment.isLocal else { return nil }
        return { query in
            guard let context = await workbench.context(for: project.id) else { return [] }
            return (try? await context.index.findFiles(nameContains: query, limit: 24)) ?? []
        }
    }

    private func loadBranch() async {
        branch = nil
        guard let project, project.descriptor.isGitRepository,
              let context = await workbench.context(for: project.id)
        else { return }
        branch = try? await context.git.status().branch
    }

    private func configureRemote(_ choice: CodeEnvironmentChoice) {
        remoteError = nil
        guard let code else { return }
        switch choice {
        case .local, .worktree:
            return
        case .cloud:
            code.target = .cloud
            code.isTargetless = false
            code.loadRepositoriesIfNeeded()
        case .device:
            code.target = .device
            code.isTargetless = false
            if code.selectedDeviceID == nil {
                code.selectedDeviceID = code.devices.first(where: \.online)?.id ?? code.devices.first?.id
            }
            if code.selectedWorkspaceKey == nil {
                code.selectedWorkspaceKey = code.selectedDevice?.workspaces.first?.id
            }
        }
    }

    private func send() {
        guard canSend else { return }
        switch environment {
        case .local, .worktree:
            startLocal(
                StudioDraft(
                    workspaceID: project?.id,
                    prompt: trimmed,
                    mode: mode,
                    modelID: modelID,
                    reasoningEffort: effort,
                    isolatedWorktree: environment == .worktree && project?.descriptor.isGitRepository == true,
                    attachments: attachments,
                    fileReferences: fileReferences
                )
            )
        case .cloud, .device:
            guard let code, !isSubmittingRemote else { return }
            isSubmittingRemote = true
            let submitted = trimmed
            Task {
                defer { isSubmittingRemote = false }
                guard let task = await code.startTask(prompt: submitted) else {
                    remoteError = code.lastErrorDescription ?? code.startBlockedReason
                    return
                }
                prompt = ""
                openTask(task)
            }
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
