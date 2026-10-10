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
    /// A subscription was chosen in the composer: the host starts the
    /// session and hands its first message to the env server.
    public var handsOff = false

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
    /// A prompt (and where to run it) handed in from outside, such as quick
    /// entry. Watched, not only read at init: a hand-off to a landing that is
    /// already on screen keeps this view and its state, so reading it once
    /// dropped the prompt.
    let initialPrompt: String?
    let initialEnvironment: CodeEnvironmentChoice?
    /// Called once the hand-off is taken, so the host can let go of it: a
    /// value left behind showed up again in some later, unrelated landing,
    /// and a second hand-off of the same text changed nothing to observe.
    let adoptedInitialPrompt: (() -> Void)?
    /// The Code v2 composer (model trigger, + menu, team). Nil keeps the
    /// classic chips.
    let v2: CodeV2StudioContext?

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
        adoptedInitialPrompt: (() -> Void)? = nil,
        v2: CodeV2StudioContext? = nil,
        selectProject: @escaping (WorkspaceID?) -> Void,
        addProject: @escaping () -> Void,
        startLocal: @escaping (StudioDraft) -> Void,
        openTask: @escaping (NativeCodeTask) -> Void
    ) {
        self.workbench = workbench
        self.code = code
        self.project = project
        self.isStarting = isStarting
        self.initialPrompt = initialPrompt
        self.initialEnvironment = initialEnvironment
        self.adoptedInitialPrompt = adoptedInitialPrompt
        self.v2 = v2
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
            if code.devices.isEmpty { return "No other computer is signed in to Alevr." }
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

    public var body: some View {
        GeometryReader { proxy in
            VStack(spacing: JunoSpace.section) {
                greetingView
                VStack(spacing: JunoSpace.snug) {
                    composer
                    footnote
                }
            }
            .frame(maxWidth: Studio.Metrics.measure)
            .padding(.horizontal, Studio.Metrics.gutter)
            .frame(maxWidth: .infinity)
            // The question sits at about 38% of the canvas (TARGET §4).
            .padding(.top, max(JunoSpace.region, proxy.size.height * 0.38 - 60))
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .background(Studio.Surface.canvas)
        .onAppear {
            focused = true
            // Seeded at init; the host can let go of it now.
            if initialPrompt != nil || initialEnvironment != nil { adoptedInitialPrompt?() }
        }
        .onChange(of: initialPrompt) { _, next in
            guard let next else { return }
            // A draft already in the composer is the reader's too, so the
            // new text goes after it rather than over it; nothing sends
            // until they do.
            prompt = trimmed.isEmpty ? next : prompt + "\n\n" + next
            focused = true
            adoptedInitialPrompt?()
        }
        .onChange(of: initialEnvironment) { _, next in
            guard let next else { return }
            environment = next
            adoptedInitialPrompt?()
        }
        .task(id: project?.id) { await loadBranch() }
        .onChange(of: environment) { _, choice in configureRemote(choice) }
        .onChange(of: workbench.availableModels.map(\.modelID)) { _, ids in
            if !ids.contains(modelID) { modelID = ids.first ?? "" }
        }
    }

    private var composer: some View {
        StudioComposer(
            text: $prompt,
            placeholder: isRemote ? "Describe the task" : "Ask for a change. @ for files, / for commands",
            attachments: attachments,
            addAttachment: isRemote ? nil : { attachments.append($0) },
            removeAttachment: { id in attachments.removeAll { $0.id == id } },
            slashCommands: CodeSlashCommandLibrary.builtIn.excludingActions(),
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
                return true
            },
            canSend: canSend,
            send: send,
            focus: $focused,
            fieldIdentifier: "juno.code.launch-prompt",
            plusMenu: v2.map { AnyView(CodeV2PlusMenuItems(model: $0.composer, directory: $0.directory)) },
            contextStrip: AnyView(placeStrip),
            minimumLines: 3
        ) {
            if let v2 {
                CodeV2ComposerLeading(
                    model: v2.composer, directory: v2.directory, isEnabled: !isRemote,
                    openConnections: v2.openConnections, setup: v2.setup
                )
                .codeV2TeamScope(session: nil, project: project?.descriptor.displayName)
            } else {
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
                if mode != .autoEdit {
                    StudioModeChip(mode: mode, select: { mode = $0 }, isEnabled: !isRemote)
                }
            }
        } trailing: {
            EmptyView()
        }
    }

    /// The question in the display rung (TARGET §4): "What should we build in
    /// storefront?", the project's name dotted-underlined and a menu to change
    /// it. Without a project, "What should we build?".
    private var greetingView: some View {
        Group {
            if let project, environment.isLocal {
                HStack(spacing: 0) {
                    Text("What should we build in ")
                    Menu {
                        projectMenuItems
                    } label: {
                        Text(project.descriptor.displayName)
                            .underline(pattern: .dot, color: Studio.Ink.tertiary)
                    }
                    .menuStyle(.button)
                    .menuIndicator(.hidden)
                    .buttonStyle(.plain)
                    .fixedSize()
                    .help("Choose the project")
                        .contentShape(.rect)
                    Text("?")
                }
            } else {
                Text("What should we build?")
            }
        }
        .studioType(.display)
        .foregroundStyle(Studio.Ink.primary)
        .lineLimit(1)
        .frame(maxWidth: .infinity)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("juno.code.greeting")
    }

    // MARK: Place

    /// Where the session runs, under the composer: the project (or repository
    /// or computer) and branch at the left, where it runs at the right.
    private var placeStrip: some View {
        HStack(spacing: JunoSpace.tight) {
            switch environment {
            case .local, .worktree:
                projectMenu
            case .cloud:
                repositoryMenu
            case .device:
                deviceMenu
            }
            if environment.isLocal, let branch {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.branch, size: 12)
                    Text(branch).lineLimit(1).truncationMode(.middle)
                }
                .studioType(.small)
                .foregroundStyle(Studio.Ink.secondary)
                .padding(.horizontal, JunoSpace.tight + 2)
                .help(environment == .worktree ? "A new worktree branches from \(branch)" : "The branch this session works on")
            }
            Spacer(minLength: JunoSpace.snug)
            environmentMenu
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 32)
        .background(
            UnevenRoundedRectangle(
                cornerRadii: .init(topLeading: 0, bottomLeading: 16, bottomTrailing: 16, topTrailing: 0),
                style: .continuous
            )
            .fill(Studio.Surface.muted)
        )
        .overlay(
            UnevenRoundedRectangle(
                cornerRadii: .init(topLeading: 0, bottomLeading: 16, bottomTrailing: 16, topTrailing: 0),
                style: .continuous
            )
            .strokeBorder(Studio.Surface.hairline)
            .mask(Rectangle().padding(.top, 1))
        )
        .padding(.horizontal, 22)
    }

    @ViewBuilder
    private var projectMenuItems: some View {
        ForEach(workbench.workspaces) { record in
            Button {
                selectProject(record.id)
            } label: {
                if record.id == project?.id {
                    Label(record.descriptor.displayName, image: JunoIcon.check.assetName)
                } else {
                    Text(record.descriptor.displayName)
                }
            }
                .contentShape(.rect)
        }
        if !workbench.workspaces.isEmpty { Divider() }
        Button("No Project") { selectProject(nil) }
            .contentShape(.rect)
        Button("Open Folder…", action: addProject)
            .contentShape(.rect)
    }

    private var projectMenu: some View {
        Menu {
            projectMenuItems
        } label: {
            StudioStripLabel(title: project?.descriptor.displayName ?? "Choose project", icon: project == nil ? .folderPlus : .projects)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .help("The folder Alevr works in (⌘O to open another)")
        .accessibilityIdentifier("juno.code.launch-project")
            .contentShape(.rect)
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
            StudioStripLabel(title: environment == .local ? "This Mac" : environment.label, icon: environmentIcon)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .help(environment.detail)
        .accessibilityIdentifier("juno.code.launch-target")
            .contentShape(.rect)
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
                StudioStripLabel(title: code.selectedRepository?.fullName ?? "Choose repository", icon: .branch)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
                .contentShape(.rect)
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
                StudioStripLabel(
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
                .contentShape(.rect)
        }
    }

    /// One line under the composer, only when there is something to say:
    /// starting, or why Send is off. Never a status line at rest.
    @ViewBuilder
    private var footnote: some View {
        let message = remoteError ?? (canSend || trimmed.isEmpty ? nil : blockingReason)
            ?? (environment == .worktree ? blockingReason : nil)
        if isStarting || isSubmittingRemote || message != nil {
            HStack(spacing: JunoSpace.tight) {
                if isStarting || isSubmittingRemote {
                    StudioSpinner().frame(width: 10, height: 10)
                    Text("Starting").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                } else if let message {
                    Text(message)
                        .studioType(.small)
                        .foregroundStyle(remoteError == nil ? Studio.Ink.secondary : Studio.Ink.danger)
                }
            }
            .frame(minHeight: 18)
        }
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
            var chosenMode = mode
            var chosenModel = modelID
            var chosenEffort = effort
            var handsOff = false
            if let v2 {
                let composer = v2.composer
                chosenMode = composer.interactionMode == .plan
                    ? .plan
                    : StudioMode(behavior: .code, permission: CodeV2EngineMapping.permission(for: composer.runtimeMode))
                if composer.engine == .alevr, let id = CodeV2EngineMapping.engineModelID(for: composer.selection) {
                    chosenModel = id
                    chosenEffort = CodeV2EngineMapping.effort(composer.selection.effort)
                } else if composer.engine == .envServer {
                    handsOff = true
                }
            }
            var draft = StudioDraft(
                workspaceID: project?.id,
                prompt: trimmed,
                mode: chosenMode,
                modelID: chosenModel,
                reasoningEffort: chosenEffort,
                isolatedWorktree: environment == .worktree && project?.descriptor.isGitRepository == true,
                attachments: attachments,
                fileReferences: fileReferences
            )
            draft.handsOff = handsOff
            startLocal(draft)
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

/// A control's face in the strip under the composer: glyph, words,
/// chevron, all 12pt muted.
struct StudioStripLabel: View {
    let title: String
    var icon: JunoIcon?

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if let icon { JunoIconView(icon, size: 12) }
            Text(title).lineLimit(1).truncationMode(.middle)
            JunoIconView(.chevronDown, size: 9)
        }
        .studioType(.small)
        .foregroundStyle(Studio.Ink.secondary)
        .padding(.horizontal, JunoSpace.tight + 2)
        .frame(minHeight: 28)
        .contentShape(.rect)
    }
}
