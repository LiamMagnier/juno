import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

/// The pages of Juno Code's settings.
public enum StudioSettingsSection: String, CaseIterable, Identifiable, Sendable {
    case general
    case permissions
    case environment
    case instructions
    case agent
    case git
    case tools
    case appearance
    case notifications
    case keyboard
    case advanced

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .permissions: "Permissions"
        case .environment: "Environment"
        case .instructions: "Instructions"
        case .agent: "Agent"
        case .git: "Git"
        case .tools: "Tools & MCP"
        case .appearance: "Appearance"
        case .notifications: "Notifications"
        case .keyboard: "Keyboard"
        case .advanced: "Advanced"
        }
    }

    var icon: JunoIcon {
        switch self {
        case .general: .sliders
        case .permissions: .shieldCheck
        case .environment: .terminal
        case .instructions: .writing
        case .agent: .agents
        case .git: .branch
        case .tools: .blocks
        case .appearance: .appearance
        case .notifications: .bell
        case .keyboard: .key
        case .advanced: .settings
        }
    }

    /// Pages whose values live in the settings files, and so have a scope.
    var isScoped: Bool {
        switch self {
        case .permissions, .environment, .agent, .git: true
        default: false
        }
    }
}

/// Juno Code's settings: everything a coding agent lets you decide, in one
/// window. The old app spread these across four surfaces; this is the only one.
///
/// Values that describe what the agent may do are written to the settings
/// files (`~/.juno/settings.json`, and a project's `.juno/settings.json` or
/// `settings.local.json`), so the window and the reader's own editor always
/// agree. Presentation choices stay in this Mac's preferences.
public struct StudioSettingsView: View {
    let workbench: WorkbenchModel?
    /// The host's "let other devices use this Mac" control, which lives in the
    /// app because the model behind it does.
    let remoteHosting: AnyView?

    @State private var section: StudioSettingsSection
    @State private var scope: CodeSettingsScope = .user
    @State private var projectID: WorkspaceID?
    @Bindable private var settings = CodeSettingsModel.shared

    public init(
        workbench: WorkbenchModel?,
        initialSection: StudioSettingsSection = .general,
        remoteHosting: AnyView? = nil
    ) {
        self.workbench = workbench
        self.remoteHosting = remoteHosting
        _section = State(initialValue: initialSection)
    }

    private var project: WorkspaceRecord? {
        guard let projectID else { return nil }
        return workbench?.workspaces.first { $0.id == projectID }
    }

    public var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { section }, set: { if let value = $0 { section = value } })) {
                ForEach(StudioSettingsSection.allCases) { item in
                    Label {
                        Text(item.title)
                    } icon: {
                        JunoIconView(item.icon, size: 14)
                    }
                    .tag(item)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        } detail: {
            page
                .navigationTitle(section.title)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        projectPicker
                            .disabled(!(section.isScoped || section == .tools))
                    }
                }
        }
        .frame(minWidth: 760, minHeight: 540)
        .onAppear {
            projectID = projectID ?? workbench?.workspaces.first?.id
            settings.selectProject(project?.access)
            settings.reload()
        }
        .onChange(of: projectID) { _, _ in
            settings.selectProject(project?.access)
            if !settings.isAvailable(scope) { scope = .user }
        }
    }

    private var projectPicker: some View {
        Picker("Project", selection: $projectID) {
            Text("No project").tag(WorkspaceID?.none)
            ForEach(workbench?.workspaces ?? []) { record in
                Text(record.descriptor.displayName).tag(Optional(record.id))
            }
        }
        .pickerStyle(.menu)
        .fixedSize()
        .help("The project whose settings files the project scopes edit")
    }

    @ViewBuilder
    private var page: some View {
        Form {
            if !settings.problems.isEmpty {
                Section {
                    ForEach(settings.problems, id: \.self) { problem in
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Studio.Ink.danger)
                    }
                }
            }
            if section.isScoped {
                StudioScopeSection(scope: $scope, settings: settings)
            }
            // A scope whose file exists but cannot be read is shown, not
            // edited: an edit would write the window's empty copy over it.
            let locked = !settings.canEdit(scope)
            switch section {
            case .general: StudioGeneralSettings(workbench: workbench)
            case .permissions:
                StudioPermissionsSettings(scope: scope, settings: settings)
                    .disabled(locked)
                if scope == .user, let remoteHosting {
                    Section("This Mac as a host") { remoteHosting }
                }
            case .environment: StudioEnvironmentSettings(scope: scope, settings: settings).disabled(locked)
            case .instructions: StudioInstructionsSettings(settings: settings)
            case .agent: StudioAgentSettings(scope: scope, settings: settings).disabled(locked)
            case .git: StudioGitSettings(scope: scope, settings: settings).disabled(locked)
            case .tools: StudioToolsSettings(workbench: workbench, project: project)
            case .appearance: StudioAppearanceSettings()
            case .notifications: StudioNotificationSettings()
            case .keyboard: StudioKeyboardSettings()
            case .advanced: StudioAdvancedSettings(settings: settings)
            }
        }
        .formStyle(.grouped)
    }
}

private extension WorkspaceRecord {
    /// The folder the record grants, when its path is known.
    var access: URL? {
        descriptor.localPathHint.isEmpty ? nil : URL(fileURLWithPath: descriptor.localPathHint, isDirectory: true)
    }
}

// MARK: - Scope

struct StudioScopeSection: View {
    @Binding var scope: CodeSettingsScope
    let settings: CodeSettingsModel

    var body: some View {
        Section {
            Picker("Applies to", selection: $scope) {
                ForEach(CodeSettingsScope.allCases) { option in
                    Text(option.label).tag(option)
                        .disabled(!settings.isAvailable(option))
                }
            }
            .pickerStyle(.segmented)
            HStack {
                Text(scope.detail)
                    .font(Studio.Font.mono)
                    .foregroundStyle(Studio.Ink.tertiary)
                Spacer()
                if let url = settings.url(scope) {
                    Button("Open File") {
                        StudioFiles.openOrCreate(url)
                    }
                    .buttonStyle(.link)
                }
            }
            if settings.awaitingApproval.contains(scope) {
                // A project file arrives with a clone and sits where the agent
                // can write it, so what it widens waits for the reader.
                HStack(alignment: .firstTextBaseline) {
                    Text("Not approved. Its deny and ask rules apply; its allow rules, environment, folders and network access wait until you approve this version.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Approve") { settings.approve(scope) }
                        .help("Put this file in force as it reads now. Any later change to it needs approving again.")
                }
            }
        } footer: {
            Text("Rules add up across all three. For everything else, the most specific file wins, except that a project's files can only lower the remote limit, and apply their allow rules, environment and folders only once you approve them.")
        }
    }
}

enum StudioFiles {
    /// Opens a settings file in the reader's editor, creating an empty one
    /// first so "Open File" never fails on a project that has none yet.
    static func openOrCreate(_ url: URL) {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? "{}\n".write(to: url, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(url)
    }
}

/// A true/false setting in a file where "not set" is also an answer: the
/// user file shows a switch; a project file adds "Inherit".
struct StudioScopedToggle: View {
    let title: String
    var detail: String?
    let scope: CodeSettingsScope
    let value: Bool?
    let inherited: Bool
    let set: (Bool?) -> Void

    var body: some View {
        if scope == .user {
            Toggle(isOn: Binding(get: { value ?? inherited }, set: { set($0) })) {
                labels
            }
        } else {
            Picker(selection: Binding(
                get: { value.map { $0 ? 1 : 0 } ?? -1 },
                set: { set($0 == -1 ? nil : $0 == 1) }
            )) {
                Text("Inherit (\(inherited ? "On" : "Off"))").tag(-1)
                Text("On").tag(1)
                Text("Off").tag(0)
            } label: {
                labels
            }
        }
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            if let detail {
                Text(detail).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
            }
        }
    }
}

// MARK: - General

struct StudioGeneralSettings: View {
    let workbench: WorkbenchModel?
    @Bindable private var defaults = CodeDefaults.shared
    @Bindable private var preferences = StudioPreferences.shared

    private var models: [ModelOption] { workbench?.availableModels ?? [] }

    private var defaultMode: Binding<StudioMode> {
        Binding(
            get: { StudioMode(behavior: .code, permission: defaults.permissionMode) },
            set: { defaults.permissionMode = $0.permission }
        )
    }

    private var efforts: [ReasoningEffort] {
        models.first { $0.modelID == defaults.modelID }?.supportedReasoningEfforts
            ?? ModelOption.contractReasoningEfforts
    }

    var body: some View {
        Section("New sessions") {
            Picker("Mode", selection: defaultMode) {
                ForEach(StudioMode.ladder) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            Text(defaultMode.wrappedValue.detail)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
            Picker("Model", selection: $defaults.modelID) {
                Text("First available").tag("")
                ForEach(models) { model in
                    Text(model.displayName).tag(model.modelID)
                }
            }
            Picker("Thinking", selection: $defaults.reasoningEffort) {
                Text("Instant").tag(ReasoningEffort?.none)
                ForEach(efforts, id: \.self) { effort in
                    Text(effort.junoLabel).tag(Optional(effort))
                }
            }
            Picker("Runs in", selection: $defaults.environment) {
                ForEach(CodeEnvironmentChoice.defaultable) { choice in
                    Text(choice.label).tag(choice)
                }
            }
        }
        Section("While Juno works") {
            Picker("Messages you send", selection: $preferences.followUp) {
                ForEach(StudioFollowUpBehavior.allCases) { Text($0.label).tag($0) }
            }
            Toggle("Keep this Mac awake", isOn: $preferences.keepAwakeWhileRunning)
        }
        Section("Composer") {
            Picker("Send with", selection: $preferences.commandReturnSends) {
                Text("Return").tag(false)
                Text("Command-Return").tag(true)
            }
        }
    }
}

// MARK: - Permissions

struct StudioPermissionsSettings: View {
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    var body: some View {
        ForEach(CodeSettingsModel.RuleList.allCases) { list in
            StudioRuleListSection(list: list, scope: scope, settings: settings)
        }
        Section {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ruleExample("Bash(npm run test *)", "commands starting npm run test")
                ruleExample("Edit(src/**)", "edits anywhere under src/")
                ruleExample("Read(.env)", "any file named .env")
                ruleExample("WebFetch(domain:docs.swift.org)", "pages on one site")
                ruleExample("mcp__github", "every tool of one MCP server")
            }
        } header: {
            Text("How rules read")
        } footer: {
            Text("Deny beats ask beats allow, whichever file a rule is in. A command joined with && or | is checked part by part. Nothing can silence an action that leaves the project: those always ask.")
        }
        if scope == .user {
            Section {
                // Shows and edits the value the reader's own file holds. The
                // resolved value folds in the selected project's files, which
                // can only lower it, so reading it here showed a ceiling this
                // picker could not change and snapped back after every edit.
                Picker("Sessions started from another device", selection: Binding(
                    get: { StudioMode(behavior: .code, permission: userCeiling) },
                    set: { mode in
                        settings.update(.user) { file in
                            var permissions = file.permissions ?? CodeSettingsFile.Permissions()
                            permissions.remoteCeiling = mode.permission
                            file.permissions = permissions
                        }
                    }
                )) {
                    ForEach(StudioMode.ladder) { Text("At most \($0.title.lowercased())").tag($0) }
                }
            } header: {
                Text("Remote")
            } footer: {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("A task your phone or another computer starts on this Mac runs with no one watching. It never gets more than this, whatever it asks for. A project's own settings can lower it, never raise it.")
                    if settings.projectRoot != nil,
                       settings.resolved.remoteCeiling.authorityRank < userCeiling.authorityRank
                    {
                        Text("This project lowers it to \(StudioMode(behavior: .code, permission: settings.resolved.remoteCeiling).title.lowercased()).")
                    }
                }
            }
        }
    }

    private var userCeiling: PermissionMode {
        settings.user.permissions?.remoteCeiling ?? ResolvedCodeSettings.defaults.remoteCeiling
    }

    private func ruleExample(_ rule: String, _ meaning: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(rule).font(Studio.Font.mono)
            Spacer()
            Text(meaning).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
        }
    }
}

struct StudioRuleListSection: View {
    let list: CodeSettingsModel.RuleList
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    @State private var draft = ""
    @State private var invalid = false

    private var title: String {
        switch list {
        case .allow: "Allow without asking"
        case .ask: "Always ask"
        case .deny: "Never allow"
        }
    }

    var body: some View {
        Section {
            let rules = settings.rules(list, in: scope)
            if rules.isEmpty {
                Text("None")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(rules, id: \.self) { rule in
                HStack {
                    Text(rule.description).font(Studio.Font.mono)
                    Spacer()
                    Button {
                        settings.removeRule(rule, from: list, in: scope)
                    } label: {
                        JunoIconView(.minus, size: 12)
                    }
                    .buttonStyle(.borderless)
                    .help("Remove")
                    .accessibilityLabel("Remove \(rule.description)")
                }
            }
            HStack {
                TextField("Add a rule, like Bash(npm run *)", text: $draft)
                    .font(Studio.Font.mono)
                    .textFieldStyle(.plain)
                    .onSubmit(add)
                Button("Add", action: add)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || !settings.isAvailable(scope))
            }
            if invalid {
                Text("That is not a rule. Use a tool name, optionally with a pattern in parentheses.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }
        } header: {
            Text(title)
        }
    }

    private func add() {
        invalid = !settings.addRule(draft, to: list, in: scope)
        if !invalid { draft = "" }
    }
}

// MARK: - Environment

struct StudioEnvironmentSettings: View {
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    @State private var newKey = ""
    @State private var newValue = ""
    @State private var choosingFolder = false

    private var file: CodeSettingsFile { settings.file(scope) }

    var body: some View {
        Section {
            StudioScopedToggle(
                title: "Commands can reach the network",
                detail: "Installs, fetches and pushes need it. Off keeps every command offline.",
                scope: scope,
                value: file.sandbox?.network,
                inherited: settings.resolved.allowsNetwork
            ) { value in
                settings.update(scope) { file in
                    var sandbox = file.sandbox ?? CodeSettingsFile.Sandbox()
                    sandbox.network = value
                    file.sandbox = sandbox
                }
            }
        } header: {
            Text("Network")
        }

        Section {
            let variables = (file.env ?? [:]).sorted { $0.key < $1.key }
            if variables.isEmpty {
                Text("None").foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(variables, id: \.key) { key, value in
                HStack {
                    Text(key).font(Studio.Font.mono)
                    Text(value).font(Studio.Font.mono).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    Spacer()
                    if scope != .user, CodeSettingsEnvironment.isReserved(key) {
                        Text("Not applied")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .help("A project's files cannot set a variable that decides which programs run or what they load. Set it in All projects instead.")
                    }
                    Button {
                        settings.update(scope) { $0.env?.removeValue(forKey: key) }
                    } label: { JunoIconView(.minus, size: 12) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(key)")
                }
            }
            HStack {
                TextField("NAME", text: $newKey).font(Studio.Font.mono).textFieldStyle(.plain)
                TextField("value", text: $newValue).font(Studio.Font.mono).textFieldStyle(.plain)
                Button("Add") {
                    let key = newKey.trimmingCharacters(in: .whitespaces)
                    guard !key.isEmpty else { return }
                    settings.update(scope) { file in
                        var env = file.env ?? [:]
                        env[key] = newValue
                        file.env = env
                    }
                    newKey = ""
                    newValue = ""
                }
                .disabled(newKey.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            Text("Environment variables")
        } footer: {
            Text(scope == .user
                ? "Every command Juno runs receives these. Commands can print them, so keep secrets out."
                : "Every command Juno runs receives these once this file is approved, except PATH, GIT_ and other variables that decide which programs run. Commands can print them, so keep secrets out.")
        }

        Section {
            let paths = file.sandbox?.writablePaths ?? []
            if paths.isEmpty {
                Text("Only the project, temporary files and build caches.").foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(paths, id: \.self) { path in
                HStack {
                    Text((path as NSString).abbreviatingWithTildeInPath).font(Studio.Font.mono)
                    Spacer()
                    Button {
                        settings.update(scope) { $0.sandbox?.writablePaths?.removeAll { $0 == path } }
                    } label: { JunoIconView(.minus, size: 12) }
                    .buttonStyle(.borderless)
                }
            }
            Button("Add Folder…") { choosingFolder = true }
        } header: {
            Text("Folders commands may write to")
        } footer: {
            Text(scope == .user
                ? "Commands run in a macOS sandbox. They can read what you can; they can write only inside the project, temporary folders, package caches and the folders above. Never your home folder itself."
                : "Commands run in a macOS sandbox. A project's files can only add folders inside the project, and only once approved.")
        }
        .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
            guard case let .success(url) = result else { return }
            settings.update(scope) { file in
                var sandbox = file.sandbox ?? CodeSettingsFile.Sandbox()
                var paths = sandbox.writablePaths ?? []
                if !paths.contains(url.path) { paths.append(url.path) }
                sandbox.writablePaths = paths
                file.sandbox = sandbox
            }
        }
    }
}

// MARK: - Instructions

struct StudioInstructionsSettings: View {
    let settings: CodeSettingsModel

    @State private var personal = ""
    @State private var standing = ""
    @State private var standingScope: CodeSettingsScope = .user

    var body: some View {
        Section {
            TextEditor(text: $personal)
                .font(Studio.Font.mono)
                .frame(minHeight: 160)
                .scrollContentBackground(.hidden)
            HStack {
                Text((settings.personalInstructionsURL.path as NSString).abbreviatingWithTildeInPath)
                    .font(Studio.Font.mono)
                    .foregroundStyle(Studio.Ink.tertiary)
                Spacer()
                Button("Revert") { personal = settings.personalInstructions }
                    .disabled(personal == settings.personalInstructions)
                Button("Save") { settings.savePersonalInstructions(personal) }
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(personal == settings.personalInstructions)
            }
        } header: {
            Text("Your instructions, every project")
        } footer: {
            Text("How you like to work: conventions, tools you prefer, things to avoid. Juno reads this before every session and ranks it above project files.")
        }

        Section {
            Picker("Applies to", selection: $standingScope) {
                ForEach(CodeSettingsScope.allCases) { Text($0.label).tag($0).disabled(!settings.isAvailable($0)) }
            }
            TextEditor(text: $standing)
                .font(Studio.Font.mono)
                .frame(minHeight: 100)
                .scrollContentBackground(.hidden)
            HStack {
                Spacer()
                Button("Save") {
                    let text = standing
                    settings.update(standingScope) { $0.instructions = text.isEmpty ? nil : text }
                }
                .disabled(standing == (settings.file(standingScope).instructions ?? ""))
            }
        } header: {
            Text("Standing instructions in settings")
        } footer: {
            Text(standingScope == .project
                ? "A shorter note kept with the other settings. A team's shared file reaches Juno as project context, like AGENTS.md: followed where it applies, never able to grant permissions."
                : "A shorter note kept with the other settings, for every project or just this one.")
        }

        Section("Read from the project automatically") {
            ForEach(["JUNO.md", ".juno/JUNO.md", "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules"], id: \.self) { name in
                Text(name).font(Studio.Font.mono)
            }
        }
        .onAppear {
            personal = settings.personalInstructions
            standing = settings.file(standingScope).instructions ?? ""
        }
        .onChange(of: standingScope) { _, scope in
            standing = settings.file(scope).instructions ?? ""
        }
    }
}

// MARK: - Agent

struct StudioAgentSettings: View {
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    private var agent: CodeSettingsFile.Agent? { settings.file(scope).agent }

    private func update(_ change: @escaping (inout CodeSettingsFile.Agent) -> Void) {
        settings.update(scope) { file in
            var agent = file.agent ?? CodeSettingsFile.Agent()
            change(&agent)
            file.agent = agent
        }
    }

    var body: some View {
        Section {
            let turns = agent?.maxTurns ?? settings.resolved.maxTurns
            Stepper(value: Binding(get: { turns }, set: { value in update { $0.maxTurns = value } }),
                    in: ResolvedCodeSettings.maxTurnsRange, step: 10) {
                HStack {
                    Text("Steps per run")
                    Spacer()
                    Text("\(turns)").font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
            }
            StudioScopedToggle(
                title: "Switch model if the chosen one is unavailable",
                detail: "Off: a run stops and says so instead of continuing on another lab's model.",
                scope: scope,
                value: agent?.modelFallback,
                inherited: settings.resolved.modelFallback
            ) { value in update { $0.modelFallback = value } }
        } header: {
            Text("Runs")
        } footer: {
            Text("A step is one model turn and the tools it calls. Long refactors need a few hundred.")
        }

        Section {
            StudioScopedToggle(
                title: "Compact the context automatically",
                detail: "Older steps are folded into notes before the model's window fills.",
                scope: scope,
                value: agent?.autoCompact,
                inherited: settings.resolved.autoCompact
            ) { value in update { $0.autoCompact = value } }
            let threshold = agent?.compactThreshold ?? settings.resolved.compactThreshold
            HStack {
                Text("Compact at")
                Slider(
                    value: Binding(get: { threshold }, set: { value in update { $0.compactThreshold = value } }),
                    in: ResolvedCodeSettings.compactThresholdRange,
                    step: 0.05
                )
                Text("\(Int(threshold * 100))%")
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.secondary)
                    .frame(width: 40, alignment: .trailing)
            }
        } header: {
            Text("Context")
        }
    }
}

// MARK: - Git

struct StudioGitSettings: View {
    let scope: CodeSettingsScope
    let settings: CodeSettingsModel

    @State private var prefix = ""

    private var git: CodeSettingsFile.Git? { settings.file(scope).git }

    var body: some View {
        Section {
            StudioScopedToggle(
                title: "Credit Juno in commits",
                detail: "Adds a Co-authored-by trailer to commits the agent writes.",
                scope: scope,
                value: git?.coAuthorTrailer,
                inherited: settings.resolved.coAuthorTrailer
            ) { value in
                settings.update(scope) { file in
                    var git = file.git ?? CodeSettingsFile.Git()
                    git.coAuthorTrailer = value
                    file.git = git
                }
            }
            HStack {
                Text("Branch prefix")
                Spacer()
                TextField(settings.resolved.branchPrefix, text: $prefix)
                    .font(Studio.Font.mono)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 160)
                    .onSubmit(savePrefix)
            }
        } header: {
            Text("Commits and branches")
        } footer: {
            Text("Worktrees Juno creates are named with this prefix, e.g. juno/fix-login-481920.")
        }
        .onAppear { prefix = git?.branchPrefix ?? "" }
        .onChange(of: scope) { _, _ in prefix = git?.branchPrefix ?? "" }
    }

    private func savePrefix() {
        let value = prefix.trimmingCharacters(in: .whitespaces)
        settings.update(scope) { file in
            var git = file.git ?? CodeSettingsFile.Git()
            git.branchPrefix = value.isEmpty ? nil : value
            file.git = git
        }
    }
}

// MARK: - Tools

struct StudioToolsSettings: View {
    let workbench: WorkbenchModel?
    let project: WorkspaceRecord?

    @State private var extensions: CodeWorkspaceExtensions?
    @State private var approving: MCPServerConfiguration?
    @Bindable private var defaults = CodeDefaults.shared

    var body: some View {
        if project == nil {
            Section {
                Text("Choose a project in the toolbar. MCP servers, hooks, skills and agents are declared by each project's files.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        } else if let extensions {
            mcpSection(extensions)
            hooksSection(extensions)
            skillsSection(extensions)
            agentsSection(extensions)
        } else {
            Section { ProgressView().controlSize(.small) }
        }
        EmptyView()
            .task(id: project?.id) { await load() }
            .confirmationDialog(
                "Allow \(approving?.name ?? "this server") to start?",
                isPresented: Binding(get: { approving != nil }, set: { if !$0 { approving = nil } }),
                presenting: approving
            ) { server in
                Button("Allow") { setConsent(server, allowed: true) }
            } message: { server in
                Text(server.url.map { "Juno will contact \($0.absoluteString) to list its tools." }
                    ?? "Juno will run \(([server.command] + server.arguments).joined(separator: " ")). Every tool call still asks.")
            }
    }

    private func mcpSection(_ extensions: CodeWorkspaceExtensions) -> some View {
        Section {
            if let error = extensions.mcpConfigurationError {
                Text(error).foregroundStyle(Studio.Ink.danger)
            }
            if extensions.mcpServers.isEmpty {
                Text("No servers. Add a .mcp.json or .juno/mcp.json to the project.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(extensions.mcpServers, id: \.name) { server in
                Toggle(isOn: Binding(
                    get: { extensions.approvedMCPServerDigests.contains(server.consentDigest) },
                    set: { allowed in
                        if allowed { approving = server } else { setConsent(server, allowed: false) }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(server.name)
                            Text(server.transport.rawValue).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.tertiary)
                        }
                        Text(server.url?.absoluteString ?? ([server.command] + server.arguments).joined(separator: " "))
                            .font(Studio.Font.monoSmall)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .disabled(!server.enabled)
            }
        } header: {
            Text("MCP servers")
        } footer: {
            Text("A server starts only after you allow it here, and a changed declaration needs allowing again. Allow its tools without asking with a rule like mcp__\(extensions.mcpServers.first?.name ?? "server").")
        }
    }

    private func hooksSection(_ extensions: CodeWorkspaceExtensions) -> some View {
        Section("Hooks") {
            if extensions.hooks.hooks.isEmpty {
                Text("No hooks. Add .juno/hooks.json, or hooks in .claude/settings.json.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(extensions.hooks.hooks) { hook in
                Toggle(isOn: Binding(
                    get: { defaults.isHookEnabled(hook.id) },
                    set: { defaults.setHook(hook.id, enabled: $0) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hook.event.rawValue)
                        Text(hook.command)
                            .font(Studio.Font.monoSmall)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
        }
    }

    private func skillsSection(_ extensions: CodeWorkspaceExtensions) -> some View {
        Section("Skills") {
            if extensions.skills.skills.isEmpty {
                Text("No skills. Add folders with a SKILL.md under .juno/skills or .claude/skills.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(extensions.skills.skills) { skill in
                Toggle(isOn: Binding(
                    get: { defaults.isSkillEnabled(skill.id) },
                    set: { defaults.setSkill(skill.id, enabled: $0) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skill.name)
                        Text(skill.path).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.tertiary)
                    }
                }
            }
        }
    }

    private func agentsSection(_ extensions: CodeWorkspaceExtensions) -> some View {
        Section("Custom agents") {
            if extensions.agents.isEmpty {
                Text("No agents. Add markdown files under .juno/agents or .claude/agents.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(extensions.agents) { agent in
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name)
                    Text(agent.description).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                }
            }
        }
    }

    private func load() async {
        extensions = nil
        guard let workbench, let project, let context = await workbench.context(for: project.id) else { return }
        extensions = await CodeWorkspaceExtensions.discover(in: context)
    }

    private func setConsent(_ server: MCPServerConfiguration, allowed: Bool) {
        guard let workbench, let project else { return }
        Task {
            guard let context = await workbench.context(for: project.id) else { return }
            try? await context.setMCPServerConsent(server, allowed: allowed)
            extensions = await CodeWorkspaceExtensions.discover(in: context)
        }
    }
}

// MARK: - Appearance

struct StudioAppearanceSettings: View {
    @Bindable private var preferences = StudioPreferences.shared

    var body: some View {
        Section {
            Picker("Detail", selection: $preferences.density) {
                ForEach(StudioThreadDensity.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            Text(preferences.density.detail)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
            Toggle("Show the model's reasoning", isOn: $preferences.showReasoning)
            Toggle("Show how full the context is", isOn: $preferences.showContextMeter)
        } header: {
            Text("Thread")
        }
        Section("Changes") {
            Picker("Diff layout", selection: $preferences.diffLayout) {
                ForEach(StudioDiffLayout.allCases) { Text($0.label).tag($0) }
            }
            Toggle("Wrap long lines", isOn: $preferences.wrapLines)
        }
    }
}

// MARK: - Notifications

struct StudioNotificationSettings: View {
    @Bindable private var preferences = StudioPreferences.shared

    var body: some View {
        Section {
            Toggle("When a run finishes", isOn: $preferences.notifyWhenDone)
            Toggle("When Juno needs your approval", isOn: $preferences.notifyWhenNeedsYou)
            Toggle("Only while Juno is in the background", isOn: $preferences.notifyOnlyInBackground)
            Toggle("Play a sound", isOn: $preferences.notificationSound)
        } footer: {
            Text("macOS asks once for permission to show Juno's notifications.")
        }
    }
}

// MARK: - Keyboard

struct StudioKeyboardSettings: View {
    private let groups: [(String, [(String, String)])] = [
        ("Sessions", [
            ("New session", "⌘N"), ("Open folder", "⌘O"), ("Commands", "⌘K"),
            ("Stop", "⌘."), ("Changes", "⌥⌘R"), ("Terminal", "⌥⌘T"), ("Side panel", "⌥⌘I"),
        ]),
        ("Composer", [
            ("Send", "↩"), ("New line", "⇧↩"), ("Mode: plan · ask · auto-edit · full", "⌥⌘1–4"),
            ("Model", "⇧⌘M"), ("Thinking", "⇧⌘E"), ("Paste an image", "⌘V"),
        ]),
        ("Approvals", [
            ("Allow once", "↩"), ("Always allow", "⌘↩"), ("Decline", "esc"),
        ]),
        ("Review", [
            ("Commit", "⌥⌘K"), ("Send comments to Juno", "⇧⌘↩"),
        ]),
    ]

    var body: some View {
        ForEach(groups, id: \.0) { title, rows in
            Section(title) {
                ForEach(rows, id: \.0) { action, keys in
                    HStack {
                        Text(action)
                        Spacer()
                        Text(keys).font(Studio.Font.labelEmphasis).foregroundStyle(Studio.Ink.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - Advanced

struct StudioAdvancedSettings: View {
    let settings: CodeSettingsModel
    @State private var confirmReset = false

    var body: some View {
        Section("Files") {
            fileRow("Your settings", settings.url(.user))
            fileRow("Your instructions", settings.personalInstructionsURL)
            Button("Reveal ~/.juno in Finder") {
                let url = CodeSettingsStore.defaultUserDirectory
                try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        }
        Section {
            Button("Reset Appearance and Notifications…", role: .destructive) { confirmReset = true }
        } footer: {
            Text("Settings files are left as they are.")
        }
        .confirmationDialog("Reset appearance and notification preferences?", isPresented: $confirmReset) {
            Button("Reset", role: .destructive) { StudioPreferences.shared.resetToDefaults() }
        }
    }

    private func fileRow(_ title: String, _ url: URL?) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(url.map { ($0.path as NSString).abbreviatingWithTildeInPath } ?? "—")
                    .font(Studio.Font.monoSmall)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            Spacer()
            if let url {
                Button("Open") { StudioFiles.openOrCreate(url) }
            }
        }
    }
}
