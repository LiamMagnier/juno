import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

/// What one project declares: its MCP servers, hooks, skills and agents, read
/// through the workspace's own access gateway.
///
/// A value the Settings page loads per project, because these live in the
/// repository and not in the account: a `.mcp.json` is a fact about a folder.
/// The page reads them on demand — opening Settings must not spawn an MCP
/// server — and the counts it shows for tools come from the live session's
/// registry when one is open, and are honestly absent otherwise.
public struct CodeWorkspaceExtensions: Equatable, Sendable {
    public var mcpServers: [MCPServerConfiguration] = []
    public var mcpConfigurationError: String?
    public var hooks: HookDiscoveryResult = HookDiscoveryResult()
    public var skills: SkillDiscoveryResult = SkillDiscoveryResult()
    public var agents: [CustomAgentDefinition] = []
    /// Tools each connected MCP server reports, by server name, when a live
    /// session has connected to it. Nil means "not connected yet".
    public var mcpToolCounts: [String: Int] = [:]
    /// Exact declarations the reader explicitly approved for startup. A changed
    /// command, endpoint, argument, header or environment becomes unapproved.
    public var approvedMCPServerDigests: Set<String> = []

    public init() {}

    /// Reads a workspace's declarations. Pure filesystem work through the
    /// gateway; nothing is started.
    public static func discover(in context: WorkspaceContext) async -> CodeWorkspaceExtensions {
        var extensions = CodeWorkspaceExtensions()
        extensions.mcpServers = (try? MCPConfigurationLoader.load(from: context.access)) ?? []
        extensions.approvedMCPServerDigests = Set(
            extensions.mcpServers.filter(context.mcpPolicyStore.allows).map(\.consentDigest)
        )
        extensions.mcpConfigurationError = context.mcpConfigurationError
        extensions.hooks = HookDiscovery(access: context.access).discover()
        extensions.skills = SkillDiscovery(access: context.access).discover()
        extensions.agents = CustomAgentDiscovery(access: context.access).discover()
        if let registry = context.mcpRegistry {
            for server in extensions.mcpServers {
                if let tools = try? await registry.cachedTools(for: server.name) {
                    extensions.mcpToolCounts[server.name] = tools.count
                }
            }
        }
        return extensions
    }
}

/// The Code section of Settings.
///
/// Defaults first — permission, model and effort, environment — because
/// those decide what every new task starts as. Then the
/// per-project lists, behind a project picker, because a hook or an MCP server
/// belongs to a repository and the page has to say which one it is showing.
/// Remote hosting stays the tile it was; it is handed in by the host because
/// the model behind it lives in the app.
public struct CodeSettingsView<RemoteHosting: View>: View {
    /// Which slice of the page to draw.
    ///
    /// The Code window's sidebar reaches two of these directly — Plugins is
    /// the per-project MCP, hooks, skills and agents; Security is the
    /// permission and environment defaults plus remote hosting — so a reader
    /// lands on the tiles the row named rather than scrolling a settings page
    /// for them. The Settings window still draws the whole thing.
    public enum Scope: Sendable {
        case all
        case plugins
        case security
    }

    @Bindable private var defaults: CodeDefaults
    private let workbench: WorkbenchModel?
    private let availableModels: [ModelOption]
    private let scope: Scope
    private let remoteHosting: RemoteHosting

    @State private var selectedWorkspaceID: WorkspaceID?
    @State private var extensions: CodeWorkspaceExtensions?
    @State private var isLoadingExtensions = false
    @State private var pendingMCPApproval: MCPServerConfiguration?

    public init(
        defaults: CodeDefaults = .shared,
        workbench: WorkbenchModel?,
        availableModels: [ModelOption],
        scope: Scope = .all,
        @ViewBuilder remoteHosting: () -> RemoteHosting
    ) {
        self.defaults = defaults
        self.workbench = workbench
        self.availableModels = availableModels
        self.scope = scope
        self.remoteHosting = remoteHosting()
    }

    private var workspaces: [WorkspaceRecord] { workbench?.workspaces ?? [] }

    private var selectedWorkspace: WorkspaceRecord? {
        workspaces.first { $0.id == selectedWorkspaceID } ?? workspaces.first
    }

    public var body: some View {
        JunoDetailPage(maxWidth: JunoSettingsMetrics.readingWidth) {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                header
                switch scope {
                case .all:
                    defaultsTile
                    environmentTile
                    projectPicker
                    mcpTile
                    hooksTile
                    skillsTile
                    agentsTile
                    remoteHosting
                case .plugins:
                    projectPicker
                    mcpTile
                    hooksTile
                    skillsTile
                    agentsTile
                case .security:
                    defaultsTile
                    environmentTile
                    remoteHosting
                }
            }
        }
        .task(id: selectedWorkspace?.id) { await loadExtensions() }
        .confirmationDialog(
            "Allow this MCP server to start?",
            isPresented: Binding(
                get: { pendingMCPApproval != nil },
                set: { showing in if !showing { pendingMCPApproval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Allow this exact server") {
                guard let server = pendingMCPApproval else { return }
                pendingMCPApproval = nil
                setMCPServerConsent(server, allowed: true)
            }
            Button("Cancel", role: .cancel) { pendingMCPApproval = nil }
        } message: {
            if let server = pendingMCPApproval {
                Text(mcpApprovalDetail(server))
            }
        }
        .accessibilityIdentifier(scopeIdentifier)
    }

    private var scopeIdentifier: String {
        switch scope {
        case .all: "juno.desktop.settings.code"
        case .plugins: "juno.code.plugins"
        case .security: "juno.code.security"
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(headerTitle)
                .junoPageHeading()
            Text(headerDetail)
                .junoRowLabel()
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headerTitle: String {
        switch scope {
        case .all: "Code"
        case .plugins: "Plugins"
        case .security: "Security"
        }
    }

    private var headerDetail: String {
        switch scope {
        case .all: "What a new task starts with, and what each project adds to it."
        case .plugins: "The MCP servers, hooks, skills and agents each project declares."
        case .security: "What a new task may touch, where it runs, and who may reach this Mac."
        }
    }

    // MARK: - Defaults

    private var defaultsTile: some View {
        JunoSettingsTile("New task defaults") {
            LabeledContent("Permissions") {
                Picker("Permissions", selection: $defaults.permissionMode) {
                    ForEach(PermissionMode.allCases, id: \.self) { mode in
                        Text(PermissionModeLabel.text(for: mode)).tag(mode)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 260)
                .accessibilityIdentifier("juno.desktop.settings.code.permission")
            }
            Text(PermissionModeLabel.explanation(for: defaults.permissionMode))
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            LabeledContent("Model") {
                Picker("Model", selection: modelBinding) {
                    Text("First available").tag("")
                    ForEach(availableModels) { model in
                        Text(model.displayName).tag(model.modelID)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 260)
                .accessibilityIdentifier("juno.desktop.settings.code.model")
            }

            LabeledContent("Reasoning") {
                Picker("Reasoning", selection: effortBinding) {
                    Text("Instant").tag("")
                    ForEach(supportedEfforts, id: \.self) { effort in
                        Text(effort.rawValue.capitalized).tag(effort.rawValue)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 260)
                .accessibilityIdentifier("juno.desktop.settings.code.effort")
            }
        }
    }

    private var supportedEfforts: [ReasoningEffort] {
        availableModels.first { $0.modelID == defaults.modelID }?.supportedReasoningEfforts
            ?? ModelOption.contractReasoningEfforts
    }

    private var modelBinding: Binding<String> {
        Binding(get: { defaults.modelID }, set: { defaults.modelID = $0 })
    }

    private var effortBinding: Binding<String> {
        Binding(
            get: { defaults.reasoningEffort?.rawValue ?? "" },
            set: { defaults.reasoningEffort = ReasoningEffort(rawValue: $0) }
        )
    }

    private var environmentTile: some View {
        JunoSettingsTile("Environment") {
            Picker("Environment", selection: $defaults.environment) {
                ForEach(CodeEnvironmentChoice.defaultable) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 260)
            .accessibilityIdentifier("juno.desktop.settings.code.environment")
            Text(defaults.environment.detail)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            LabeledContent("Worktree location") {
                Text(".juno/worktrees inside each project")
                    .junoCodeSmall()
                    .junoSecondaryInk()
            }
            // Not a chooser. Every worktree Juno makes stays inside the folder
            // the reader granted — `WorktreeManager` refuses any destination
            // outside it — so a location elsewhere on the disk would be a
            // promise the runtime cannot keep.
            Text("Worktrees are created inside the project you granted, so Juno never writes outside it. Branches are named juno/<base>-<stamp>.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Per-project

    @ViewBuilder
    private var projectPicker: some View {
        if workspaces.isEmpty {
            JunoSettingsTile("Project") {
                Text("Open a project in Juno Code to see its MCP servers, hooks, skills and agents.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            JunoSettingsTile("Project") {
                Picker("Project", selection: Binding(
                    get: { selectedWorkspace?.id },
                    set: { selectedWorkspaceID = $0 }
                )) {
                    ForEach(workspaces) { record in
                        Text(record.descriptor.displayName).tag(Optional(record.id))
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 320)
                .accessibilityIdentifier("juno.desktop.settings.code.project")
                if let path = selectedWorkspace?.descriptor.localPathHint {
                    Text((path as NSString).abbreviatingWithTildeInPath)
                        .junoCodeSmall()
                        .junoSecondaryInk()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if isLoadingExtensions {
                    HStack(spacing: JunoSpace.snug) {
                        ProgressView().controlSize(.small)
                        Text("Reading the project's configuration…").junoCaption()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var mcpTile: some View {
        if let extensions {
            JunoSettingsTile("MCP servers") {
                if let error = extensions.mcpConfigurationError {
                    Text(error)
                        .junoCaption()
                        .foregroundStyle(Color.junoDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if extensions.mcpServers.isEmpty {
                    Text("No servers declared. Add a `.mcp.json` or `.juno/mcp.json` to the project.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(extensions.mcpServers, id: \.name) { server in
                        Toggle(isOn: Binding(
                            get: { extensions.approvedMCPServerDigests.contains(server.consentDigest) },
                            set: { allowed in
                                if allowed { pendingMCPApproval = server }
                                else { setMCPServerConsent(server, allowed: false) }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                                HStack(spacing: JunoSpace.snug) {
                                    Text(server.name).junoRowLabel()
                                    Text(server.transport.rawValue)
                                        .junoCodeSmall()
                                        .junoMetaInk()
                                }
                                Text(mcpDetail(server, toolCount: extensions.mcpToolCounts[server.name]))
                                    .junoCaption()
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .toggleStyle(.switch)
                        .tint(Color.junoAccent)
                        .disabled(!server.enabled)
                        .accessibilityIdentifier("juno.desktop.settings.code.mcp.\(server.name)")
                    }
                    Text("Turning this on explicitly permits this exact server to start or make its discovery request in this project. A changed declaration needs approval again. Every MCP call still asks for approval.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func mcpDetail(_ server: MCPServerConfiguration, toolCount: Int?) -> String {
        var parts: [String] = []
        if !server.enabled {
            parts.append("Disabled in the project's configuration")
        } else if !extensionsApproved(server) {
            parts.append("Needs your approval before it can start")
        } else if let toolCount {
            parts.append("\(toolCount) \(toolCount == 1 ? "tool" : "tools")")
        } else {
            parts.append("Not connected")
        }
        if let url = server.url {
            parts.append(url.absoluteString)
        } else if !server.command.isEmpty {
            parts.append(([server.command] + server.arguments).joined(separator: " "))
        }
        return parts.joined(separator: " · ")
    }

    private func mcpApprovalDetail(_ server: MCPServerConfiguration) -> String {
        if let url = server.url {
            return "Juno will contact \(url.absoluteString) to discover its tools. This approval applies only to this exact endpoint and headers."
        }
        let command = ([server.command] + server.arguments).joined(separator: " ")
        let cwd = server.workingDirectory ?? "."
        let declaredKeys = server.environment.keys.sorted()
        let declared = declaredKeys.isEmpty ? "no additional environment values" : "environment values for \(declaredKeys.joined(separator: ", "))"
        return "Juno will run \(command) in \(cwd). It receives only PATH, HOME, TMPDIR and locale settings, plus \(declared). Every tool call will still ask for approval."
    }

    private func extensionsApproved(_ server: MCPServerConfiguration) -> Bool {
        extensions?.approvedMCPServerDigests.contains(server.consentDigest) ?? false
    }

    private func setMCPServerConsent(_ server: MCPServerConfiguration, allowed: Bool) {
        guard let workbench, let record = selectedWorkspace else { return }
        Task {
            guard let context = await workbench.context(for: record.id) else { return }
            do {
                try await context.setMCPServerConsent(server, allowed: allowed)
                extensions = await CodeWorkspaceExtensions.discover(in: context)
            } catch {
                // Keep the control in its old state; the next discovery preserves
                // the fact that no consent was written.
                extensions = await CodeWorkspaceExtensions.discover(in: context)
            }
        }
    }

    @ViewBuilder
    private var hooksTile: some View {
        if let extensions {
            JunoSettingsTile("Hooks") {
                if extensions.hooks.hooks.isEmpty {
                    Text("No hooks declared. Add `.juno/hooks.json` or hooks in `.claude/settings.json`.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(extensions.hooks.hooks) { hook in
                        Toggle(isOn: Binding(
                            get: { defaults.isHookEnabled(hook.id) },
                            set: { defaults.setHook(hook.id, enabled: $0) }
                        )) {
                            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                                HStack(spacing: JunoSpace.snug) {
                                    Text(hook.event.rawValue).junoRowLabel()
                                    if let pattern = hook.matcher.pattern {
                                        Text(pattern).junoCodeSmall().junoMetaInk()
                                    }
                                }
                                Text(hook.command)
                                    .junoCodeSmall()
                                    .junoSecondaryInk()
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Text(hookRunDetail(hook))
                                    .junoCaption()
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .toggleStyle(.switch)
                        .tint(Color.junoAccent)
                        .accessibilityIdentifier("juno.desktop.settings.code.hook.\(hook.id)")
                    }
                    Text("Hooks run only after you trust them for a session in the Repository tab. A hook switched off here stays off even then.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(Array(extensions.hooks.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                    Text("\(diagnostic.path): \(diagnostic.message)")
                        .junoCaption()
                        .foregroundStyle(diagnostic.severity == .error ? Color.junoDanger : Color.junoCaution)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func hookRunDetail(_ hook: HookDefinition) -> String {
        var parts = ["\(hook.source.rawValue) · \(hook.path)"]
        if let last = defaults.hookLastRun[hook.id] {
            parts.append("last ran \(last.formatted(.relative(presentation: .named)))")
        } else {
            parts.append("never run")
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var skillsTile: some View {
        if let extensions {
            JunoSettingsTile("Skills") {
                if extensions.skills.skills.isEmpty {
                    Text("No skills found. Add a `SKILL.md` under `.juno/skills/<name>/` or `.claude/skills/<name>/`.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(extensions.skills.skills) { skill in
                        Toggle(isOn: Binding(
                            get: { defaults.isSkillEnabled(skill.id) },
                            set: { defaults.setSkill(skill.id, enabled: $0) }
                        )) {
                            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                                Text(skill.name).junoRowLabel()
                                Text(skill.path)
                                    .junoCodeSmall()
                                    .junoSecondaryInk()
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .toggleStyle(.switch)
                        .tint(Color.junoAccent)
                        .accessibilityIdentifier("juno.desktop.settings.code.skill.\(skill.id)")
                    }
                    Text("An enabled skill's instructions are added to the agent's context on its next turn. They are context, never policy.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private var agentsTile: some View {
        if let extensions {
            JunoSettingsTile("Agents") {
                ForEach(AgentRoleOption.options(custom: extensions.agents)) { option in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        JunoIconView(.user, size: 14)
                            .junoSecondaryInk()
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            HStack(spacing: JunoSpace.snug) {
                                Text(option.label).junoRowLabel()
                                if case .builtIn = option {
                                    Text("Built in").junoCodeSmall().junoMetaInk()
                                }
                            }
                            Text(option.detail)
                                .junoCaption()
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, JunoSpace.hairline)
                    .accessibilityElement(children: .combine)
                }
                Text("Add an agent as `.juno/agents/<name>.md` or `.claude/agents/<name>.md`; choose it on the New task screen.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func loadExtensions() async {
        guard let workbench, let record = selectedWorkspace else {
            extensions = nil
            return
        }
        isLoadingExtensions = true
        defer { isLoadingExtensions = false }
        guard let context = await workbench.context(for: record.id) else {
            extensions = CodeWorkspaceExtensions()
            return
        }
        extensions = await CodeWorkspaceExtensions.discover(in: context)
    }
}
