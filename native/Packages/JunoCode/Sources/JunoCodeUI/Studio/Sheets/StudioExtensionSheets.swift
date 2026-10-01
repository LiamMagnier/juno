import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

// `/permissions`, `/agents`, `/mcp`, `/hooks` and `/tasks` (CODE_AGENT_SPEC
// §5.4, §5.8). Each item says where it was declared — this project, yours,
// or from Claude Code — and a change the reader makes here meets the
// project's `ConfigChange` hooks before it takes effect.

// MARK: - /permissions

struct StudioPermissionsSheet: View {
    let controller: SessionController
    let done: () -> Void
    @Bindable private var settings = CodeSettingsModel.shared
    @State private var scope: CodeSettingsScope = .user
    @State private var draft = ""
    @State private var list: CodeSettingsModel.RuleList = .allow
    @State private var problem: String?

    var body: some View {
        StudioSheetFrame(
            title: "Permissions",
            subtitle: "What Juno may do without asking, by where the rule is written. Deny beats ask beats allow; nothing silences an action that leaves the project.",
            done: done
        ) {
            Form {
                Section {
                    Picker("Rules in", selection: $scope) {
                        ForEach(CodeSettingsScope.allCases) { option in
                            Text(option.label).tag(option).disabled(!settings.isAvailable(option))
                        }
                    }
                    .pickerStyle(.segmented)
                    Text(scope.detail).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.tertiary)
                }
                ForEach(CodeSettingsModel.RuleList.allCases) { list in
                    Section(Self.title(list)) {
                        let rules = settings.rules(list, in: scope)
                        if rules.isEmpty {
                            Text("None").foregroundStyle(Studio.Ink.tertiary)
                        }
                        ForEach(rules, id: \.self) { rule in
                            HStack {
                                Text(rule.description).font(Studio.Font.mono)
                                Spacer()
                                Button("Remove") { Task { await change(.remove(rule, list)) } }
                                    .buttonStyle(.link)
                            }
                        }
                    }
                }
                Section("Add a rule") {
                    HStack {
                        Picker("", selection: $list) {
                            ForEach(CodeSettingsModel.RuleList.allCases) { Text(Self.title($0)).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                        TextField("Bash(npm run test *)", text: $draft)
                            .font(Studio.Font.mono)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                            .onSubmit { Task { await change(.add(draft, list)) } }
                        Button("Add") { Task { await change(.add(draft, list)) } }
                            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || !settings.isAvailable(scope))
                    }
                    if let problem {
                        Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                    }
                }
                Section("Task grants") {
                    Text("None. A goal can grant exact commands while it is active; nothing else can.")
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Section("Screen control") {
                    StudioSheetRow(
                        label: controller.computerUseActive ? "On in this session" : "Off in this session",
                        note: "Screen Recording: \(Self.state(controller.computerUseScreenPermission)). Accessibility: \(Self.state(controller.computerUseAccessibilityPermission))."
                    )
                }
                Section("Recently declined") {
                    let denials = Self.recentDenials(in: controller.events)
                    if denials.isEmpty {
                        Text("Nothing declined in this session.").foregroundStyle(Studio.Ink.tertiary)
                    }
                    ForEach(denials, id: \.self) { denial in
                        Text(denial).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .onAppear {
            settings.selectProject(controller.context?.access.rootURL)
            settings.reload()
        }
    }

    enum Change {
        case add(String, CodeSettingsModel.RuleList)
        case remove(PermissionRule, CodeSettingsModel.RuleList)

        /// Whether the change takes a permission away: a new deny or ask
        /// rule, or an allow rule removed. Such a change always goes
        /// through. A `ConfigChange` hook is very often the project's, and a
        /// project's automation keeping an allow rule the reader is removing
        /// would hold Juno's permissions wider than the reader wants them.
        var isNarrowing: Bool {
            switch self {
            case let .add(_, list): list != .allow
            case let .remove(_, list): list == .allow
            }
        }
    }

    /// A rule change meets the project's `ConfigChange` hooks first. A hook
    /// that blocks keeps the file as it was when the change would widen what
    /// Juno may do; one that takes a permission away is only told.
    private func change(_ change: Change) async {
        problem = nil
        var blocked: String?
        await controller.signalHooks { hooks, id in
            let answer = await hooks.configChanging(
                sessionID: id,
                source: scope == .user ? "user_settings" : scope == .project ? "project_settings" : "local_settings",
                filePath: settings.url(scope)?.path
            )
            blocked = answer.blockReason
            return answer
        }
        if let blocked, !change.isNarrowing {
            problem = "A hook kept the rules as they were: \(blocked)"
            return
        }
        switch change {
        case let .add(text, list):
            if settings.addRule(text, to: list, in: scope) {
                draft = ""
            } else {
                problem = "That is not a rule. Use a tool name, optionally with a pattern in parentheses."
            }
        case let .remove(rule, list):
            settings.removeRule(rule, from: list, in: scope)
        }
    }

    static func title(_ list: CodeSettingsModel.RuleList) -> String {
        switch list {
        case .allow: "Allow without asking"
        case .ask: "Always ask"
        case .deny: "Never allow"
        }
    }

    static func state(_ permission: ComputerUsePermissionState) -> String {
        switch permission {
        case .granted: "granted"
        case .denied: "not granted"
        case .notDetermined: "not asked yet"
        }
    }

    /// What was declined this session, newest first, in words.
    static func recentDenials(in events: [SessionEvent], limit: Int = 10) -> [String] {
        var asked: [String: String] = [:]
        var denials: [String] = []
        for event in events {
            switch event.payload {
            case let .approvalRequested(request):
                asked[request.id] = request.summary
            case let .approvalResolved(resolved) where resolved.decision == .denied:
                if let summary = asked[resolved.approvalID] {
                    denials.append("Declined: \(summary)")
                }
            case let .toolCompleted(completed) where completed.status == .denied:
                denials.append("Not run: \(completed.resultSummary)")
            default:
                continue
            }
        }
        return Array(denials.suffix(limit).reversed())
    }
}

// MARK: - /agents

struct StudioAgentsSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var agents: [CustomAgentDefinition] = []
    @State private var overridden: [CustomAgentDefinition] = []
    @State private var newName = ""
    @State private var problem: String?

    private var imports: UserExtensionPolicyStore? { controller.context?.userExtensionPolicy }

    var body: some View {
        StudioSheetFrame(
            title: "Agents",
            subtitle: "Agents Juno can hand work to with delegate_task. An agent can narrow what a sub-agent may do, never widen it.",
            done: done
        ) {
            Form {
                Section("Built in") {
                    ForEach(BuiltInAgents.all, id: \.name) { agent in
                        StudioSheetRow(label: agent.name.capitalized, value: "read-only", note: agent.description)
                    }
                }
                Section("Custom") {
                    if agents.isEmpty {
                        Text("None yet. Add Markdown files to .juno/agents or ~/.juno/agents.")
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                    ForEach(agents) { agent in
                        if agent.scope == .claudeImport {
                            Toggle(isOn: Binding(
                                get: { imports?.isEnabled(kind: "agent", name: agent.targetName) ?? false },
                                set: { enabled in setImport(agent, enabled: enabled) }
                            )) {
                                row(agent)
                            }
                        } else {
                            row(agent)
                        }
                    }
                }
                if !overridden.isEmpty {
                    Section("Replaced by one of the same name") {
                        ForEach(overridden) { agent in
                            StudioSheetRow(label: agent.name, note: "\(agent.scope.label) · \(agent.path)")
                        }
                    }
                }
                Section("New agent") {
                    HStack {
                        TextField("name, like data-migrator", text: $newName)
                            .font(Studio.Font.mono)
                        Button("Create in .juno/agents") { Task { await create() } }
                            .disabled(!CustomAgentDiscovery.isSafeName(newName) || controller.context == nil)
                    }
                    if let problem {
                        Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .task { load() }
    }

    private func row(_ agent: CustomAgentDefinition) -> some View {
        var traits: [String] = [agent.scope.label]
        if let mode = agent.mode { traits.append(mode == .readOnly ? "read-only" : "may write in a worktree") }
        if let model = agent.model { traits.append(model) }
        if let tools = agent.tools { traits.append("tools: " + tools.joined(separator: ", ")) }
        if let steps = agent.maxSteps { traits.append("at most \(steps) steps") }
        var lines = [agent.description].filter { !$0.isEmpty } + [traits.joined(separator: " · "), agent.path]
        if agent.isShadowedByBuiltIn {
            lines.append("Not used: Juno's built-in \(agent.targetName) keeps this name. Rename the file, or put it in ~/.juno/agents to replace the built-in.")
        }
        return StudioSheetRow(
            label: agent.name,
            value: agent.isShadowedByBuiltIn ? "not used" : agent.targetName,
            note: lines.joined(separator: "\n")
        )
    }

    private func load() {
        guard let context = controller.context else { return }
        let found = CustomAgentDiscovery(access: context.access, user: context.userExtensionDirectories).discoverAll()
        agents = found.agents
        overridden = found.overridden
    }

    private func setImport(_ agent: CustomAgentDefinition, enabled: Bool) {
        try? imports?.setEnabled(enabled, kind: "agent", name: agent.targetName)
        Task { await controller.refreshWorkspacePanels() }
        load()
    }

    /// Writes `.juno/agents/<name>.md` from a template, after the project's
    /// `ConfigChange` hooks.
    private func create() async {
        problem = nil
        guard let context = controller.context,
              let path = try? WorkspacePath(".juno/agents/\(newName).md")
        else { return }
        var blocked: String?
        await controller.signalHooks { hooks, id in
            let answer = await hooks.configChanging(sessionID: id, source: "project_agents", filePath: path.value)
            blocked = answer.blockReason
            return answer
        }
        if let blocked {
            problem = "A hook stopped this: \(blocked)"
            return
        }
        let template = """
            ---
            name: \(newName)
            description: What this agent is for, in one line.
            mode: read_only
            ---
            You are the \(newName) agent. Describe how it works and what it returns.
            """
        do {
            _ = try await context.files.create(path, content: template + "\n", sessionID: controller.sessionID)
            newName = ""
            await controller.refreshWorkspacePanels()
            load()
            if let document = await controller.openWorkspaceFile(path) {
                done()
                controller.review.openDocument = document
            }
        } catch {
            problem = "Could not create it: \(error.localizedDescription)"
        }
    }
}

// MARK: - /mcp

struct StudioMCPSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var configuration = MCPConfigurationSet(servers: [])
    @State private var states: [String: String] = [:]
    @State private var toolCounts: [String: Int] = [:]
    @State private var problem: String?
    @Bindable private var defaults = CodeDefaults.shared

    var body: some View {
        StudioSheetFrame(
            title: "MCP servers",
            subtitle: "Servers Juno's tools can come from. A project's servers start only once you allow them; yours start when needed; Claude Code's start once you turn them on. Every tool call still asks.",
            done: done
        ) {
            Form {
                if configuration.servers.isEmpty {
                    Section {
                        Text("No servers. Add one to ~/.juno/mcp.json for every project, or to .juno/mcp.json for this one.")
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
                ForEach(ExtensionScope.allCases, id: \.self) { scope in
                    let servers = configuration.servers.filter { $0.scope == scope }
                    if !servers.isEmpty {
                        Section(scope.label) {
                            ForEach(servers, id: \.name) { server in
                                serverRow(server)
                            }
                        }
                    }
                }
                if !configuration.overridden.isEmpty {
                    Section("Replaced by one of the same name") {
                        ForEach(configuration.overridden, id: \.consentDigest) { server in
                            StudioSheetRow(label: server.name, note: "\(server.scope.label) · \(server.declaredIn)", mono: true)
                        }
                    }
                }
                ForEach(configuration.problems, id: \.self) { problem in
                    Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                }
                if let problem {
                    Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                }
                Section("Add a server") {
                    HStack {
                        Button("Open ~/.juno/mcp.json") {
                            if let home = controller.context?.userSettingsDirectory ?? Optional(CodeSettingsStore.defaultUserDirectory) {
                                StudioFiles.openOrCreate(home.appendingPathComponent("mcp.json"))
                            }
                        }
                        Button("Open .juno/mcp.json") {
                            if let root = controller.context?.access.rootURL {
                                StudioFiles.openOrCreate(root.appendingPathComponent(".juno/mcp.json"))
                            }
                        }
                        .disabled(controller.context == nil)
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .task { await load() }
    }

    private func serverRow(_ server: MCPServerConfiguration) -> some View {
        let enabled = defaults.isMCPServerEnabled(server.name)
        let consent = consentLine(server)
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            StudioSheetRow(
                label: server.name,
                value: states[server.name],
                note: [
                    server.transport == .stdio ? "\(server.command) \(server.arguments.joined(separator: " "))" : server.url?.absoluteString,
                    consent,
                    toolCounts[server.name].map { StudioFormat.plural($0, "tool") },
                ].compactMap { $0 }.joined(separator: " · "),
                mono: true
            )
            HStack {
                Toggle("On", isOn: Binding(
                    get: { enabled },
                    set: { defaults.setMCPServer(server.name, enabled: $0) }
                ))
                .toggleStyle(.switch)
                .controlSize(.small)
                switch server.scope {
                case .project:
                    let allowed = controller.context?.mcpPolicyStore.allows(server) ?? false
                    Button(allowed ? "Revoke" : "Allow") { Task { await setConsent(server, allowed: !allowed) } }.contentShape(.rect)
                case .claudeImport:
                    let on = controller.context?.userExtensionPolicy?.isEnabled(kind: "mcp", name: server.name) ?? false
                    Button(on ? "Turn off" : "Turn on") {
                        try? controller.context?.userExtensionPolicy?.setEnabled(!on, kind: "mcp", name: server.name)
                        Task { await load() }
                    }.contentShape(.rect)
                case .user:
                    EmptyView()
                }
                Button("Reconnect") { Task { await reconnect(server) } }
                    .disabled(!enabled).contentShape(.rect)
                Spacer()
            }
        }
    }

    private func consentLine(_ server: MCPServerConfiguration) -> String {
        switch server.scope {
        case .project:
            (controller.context?.mcpPolicyStore.allows(server) ?? false) ? "allowed by you" : "waiting for you to allow it"
        case .user:
            "yours"
        case .claudeImport:
            (controller.context?.userExtensionPolicy?.isEnabled(kind: "mcp", name: server.name) ?? false)
                ? "turned on" : "off until you turn it on"
        }
    }

    private func load() async {
        guard let context = controller.context else { return }
        let user = context.userExtensionDirectories
        do {
            configuration = try MCPConfigurationLoader.loadAll(
                from: context.access,
                userConfigurationFile: user?.junoHome.appendingPathComponent("mcp.json"),
                claudeConfigurationFile: user?.claudeConfigFile
            )
        } catch {
            problem = error.localizedDescription
        }
        guard let registry = context.mcpRegistry else { return }
        for server in configuration.servers {
            if let state = try? await registry.state(for: server.name) {
                states[server.name] = Self.describe(state)
            }
            if let tools = try? await registry.cachedTools(for: server.name) {
                toolCounts[server.name] = tools.count
            }
        }
    }

    private func setConsent(_ server: MCPServerConfiguration, allowed: Bool) async {
        do {
            try await controller.context?.setMCPServerConsent(server, allowed: allowed)
        } catch {
            problem = error.localizedDescription
        }
        await load()
    }

    private func reconnect(_ server: MCPServerConfiguration) async {
        guard let registry = controller.context?.mcpRegistry else { return }
        try? await registry.disconnect(serverID: server.name)
        do {
            try await registry.connect(serverID: server.name)
        } catch {
            problem = "\(server.name): \(error.localizedDescription)"
        }
        await load()
    }

    static func describe(_ state: MCPClientState) -> String {
        switch state {
        case .ready: "Connected"
        case .idle: "Starts when needed"
        case .connecting: "Connecting"
        case .closing, .closed: "Not running"
        case .failed: "Could not start"
        }
    }
}

// MARK: - /hooks

struct StudioHooksSheet: View {
    let controller: SessionController
    let done: () -> Void

    var body: some View {
        StudioSheetFrame(title: "Hooks", subtitle: "Commands, endpoints and checks that run around Juno's work.", done: done) {
            Form {
                StudioHooksSettings(
                    hooks: controller.hookDiscoveryResult,
                    policy: controller.hookPolicy,
                    setAllowed: { allowed in
                        guard let context = controller.context else { return }
                        _ = try? context.setRepositoryHooksAllowed(allowed, discovered: controller.hookDiscoveryResult)
                        Task { await controller.refreshWorkspacePanels() }
                    }
                )
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - /tasks

struct StudioTasksSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var shells: [(info: ShellSessionInfo, tail: String)] = []
    @State private var children: [BackgroundSubagents.Snapshot] = []

    var body: some View {
        StudioSheetFrame(title: "Background work", subtitle: "Shells and sub-agents this session started that run on their own.", done: done) {
            Form {
                Section("Shells") {
                    if shells.isEmpty {
                        Text("None running.").foregroundStyle(Studio.Ink.tertiary)
                    }
                    ForEach(shells, id: \.info.id) { shell in
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            HStack {
                                StudioSheetRow(label: shell.info.command, value: shell.info.state.isRunning ? "Running" : "Ended", mono: true)
                                if shell.info.state.isRunning {
                                    Button("Stop") { Task { await stopShell(shell.info.id) } }
                                }
                            }
                            if !shell.tail.isEmpty {
                                Text(shell.tail)
                                    .font(Studio.Font.monoSmall)
                                    .foregroundStyle(Studio.Ink.secondary)
                                    .lineLimit(8)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                Section("Sub-agents") {
                    let running = controller.subagentActivity
                    if children.isEmpty, running.isEmpty {
                        Text("None running.").foregroundStyle(Studio.Ink.tertiary)
                    }
                    ForEach(Array(running.keys).sorted { $0.value < $1.value }, id: \.self) { id in
                        StudioSheetRow(label: running[id] ?? "", value: "Working")
                    }
                    ForEach(children, id: \.id) { child in
                        HStack {
                            StudioSheetRow(
                                label: child.title,
                                value: Self.state(child.status),
                                note: child.answer.map { String($0.prefix(400)) }
                            )
                            if child.finishedAt == nil {
                                Button("Stop") {
                                    Task {
                                        _ = await BackgroundSubagents.shared.cancel(id: child.id, parentSessionID: controller.sessionID)
                                        await load()
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func load() async {
        children = await BackgroundSubagents.shared.snapshots(parentSessionID: controller.sessionID)
        guard let context = controller.context else { return }
        var loaded: [(ShellSessionInfo, String)] = []
        for info in context.shells.sessions(ownedBy: controller.sessionID) {
            let tail = (try? await context.shells.output(
                id: info.id,
                ownerSessionID: controller.sessionID,
                since: nil,
                tailLines: 8,
                maximumBytes: 4_096,
                waitSeconds: 0
            ))?.text ?? ""
            loaded.append((info, tail))
        }
        shells = loaded.map { (info: $0.0, tail: $0.1) }
    }

    private func stopShell(_ id: String) async {
        guard let context = controller.context else { return }
        _ = try? await context.shells.kill(id: id, ownerSessionID: controller.sessionID, signal: .terminate)
        await load()
    }

    static func state(_ status: SubagentStatus) -> String {
        switch status {
        case .queued: "Waiting to start"
        case .preparing: "Starting"
        case .running: "Working"
        case .waitingForApproval: "Waiting for you"
        case .completed: "Done"
        case .failed: "Failed"
        case .cancelled: "Stopped"
        case .interrupted: "Interrupted"
        }
    }
}
