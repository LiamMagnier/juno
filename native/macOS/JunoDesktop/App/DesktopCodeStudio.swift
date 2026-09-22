import AppKit
import JunoAuth
import JunoChatKit
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The Code window's navigation model: what can be selected, how a selection
/// survives a relaunch, and how the sessions of every transport flatten into
/// one list. Pure values and functions, so the rules are reachable from tests;
/// the column that draws them is `DesktopCodeSidebar`.

// MARK: - Selection

/// One `Hashable` value for the whole navigation column.
///
/// `List(selection:)` needs a single `Hashable` to drive native selection, and
/// that is what buys arrow-key navigation, type-select, the focus ring and the
/// focused/unfocused accent states.
enum DesktopCodeSidebarItem: Hashable {
    /// The index of every granted project, rather than one of them.
    case allProjects
    /// The New task screen with no project chosen yet.
    ///
    /// A destination rather than a modal because the reader must be able to
    /// leave it, look at a session, and come back to what they were typing.
    case draft
    /// The pull requests Juno Code opened, across every project.
    case pulls
    /// Juno Design, reached from the brand menu as the website does it.
    case design
    /// The account's scheduled tasks.
    case scheduled
    /// The MCP servers, hooks, skills and agents each project declares.
    case plugins
    /// What a new task may touch, where it runs, and who may reach this Mac.
    case security
    /// Every granted project, as one page to browse.
    case explore
    /// The New task screen, aimed at this project.
    case repository(WorkspaceID)
    case session(CodeSessionID)
    case task(String)
    case remote(deviceID: String, sessionID: String)
}

/// Where a run executes. Rendered as subtitle text, never as a control: the
/// engine that runs a session is chosen when the session is created and cannot
/// be migrated mid-flight.
enum CodeRunEnvironment: String {
    case local = "Local"
    case worktree = "Worktree"
    case cloud = "Cloud"
    case device = "Device"
    case remote = "Remote"
}

/// One row in the navigation column, from any of the four transports.
///
/// Flattening local sessions, cloud runs, device runs and relay-watched sessions
/// into one row type is what lets them share one filter and one row shape
/// instead of each transport getting its own section.
struct DesktopCodeRun: Identifiable {
    let item: DesktopCodeSidebarItem
    let title: String
    let workspace: String
    let workspaceID: WorkspaceID?
    let branch: String?
    let environment: CodeRunEnvironment
    let status: CodeRunStatus
    let updatedAt: Date

    var id: DesktopCodeSidebarItem { item }

    /// "workspace · branch · where it runs", with absent facts dropped rather
    /// than rendered as empty separators. What VoiceOver reads.
    var caption: String {
        var parts: [String] = []
        if !workspace.isEmpty { parts.append(workspace) }
        if let branch, !branch.isEmpty { parts.append(branch) }
        parts.append(environment.rawValue)
        return parts.joined(separator: " · ")
    }
}

/// The column's one filter: which of the sessions to list.
enum DesktopCodeSessionFilter: String, CaseIterable, Identifiable {
    case all
    case running
    case needsYou
    case done

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "All"
        case .running: "Run"
        case .needsYou: "Needs"
        case .done: "Done"
        }
    }

    /// The label as the sidebar's pull-down states it: "All" alone, at the top
    /// of a column of sessions, does not say all of *what*.
    var menuLabel: String {
        switch self {
        case .all: "All sessions"
        case .running: "Running"
        case .needsYou: "Needs your attention"
        case .done: "Done"
        }
    }

    func includes(_ status: CodeRunStatus) -> Bool {
        switch self {
        case .all: true
        case .running: status.isActive && !status.needsApproval
        case .needsYou: status.needsApproval
        case .done: !status.isActive
        }
    }
}

/// The pure navigation rules behind the Code window's column.
///
/// These are functions over values rather than logic inside a `Binding` in a view
/// body, so the interesting cases — a stored selection whose session was deleted,
/// a repository that is no longer granted, grouping four transports by project —
/// are reachable from a test.
enum DesktopCodeNavigationState {
    private static let unitSeparator = "\u{1f}"

    static func encode(_ item: DesktopCodeSidebarItem?) -> String {
        switch item {
        case .none: ""
        case .allProjects: "allProjects"
        case .draft: "draft"
        case .pulls: "pulls"
        case .design: "design"
        case .scheduled: "scheduled"
        case .plugins: "plugins"
        case .security: "security"
        case .explore: "explore"
        case .repository(let id): "repository\(unitSeparator)\(id.value)"
        case .session(let id): "session\(unitSeparator)\(id.value)"
        case .task(let id): "task\(unitSeparator)\(id)"
        case .remote(let deviceID, let sessionID):
            "remote\(unitSeparator)\(deviceID)\(unitSeparator)\(sessionID)"
        }
    }

    /// The account pages that used to be Code destinations decode to nil:
    /// scene storage written by an older build must not strand the window on
    /// a page it no longer draws. They open in Settings (⌘,) now.
    static func decode(_ raw: String) -> DesktopCodeSidebarItem? {
        let fields = raw.components(separatedBy: unitSeparator)
        switch (fields.first, fields.count) {
        case ("allProjects", 1): return .allProjects
        case ("draft", 1): return .draft
        case ("pulls", 1): return .pulls
        case ("design", 1): return .design
        case ("scheduled", 1): return .scheduled
        case ("plugins", 1): return .plugins
        case ("security", 1): return .security
        case ("explore", 1): return .explore
        case ("repository", 2): return .repository(WorkspaceID(value: fields[1]))
        case ("session", 2): return .session(CodeSessionID(value: fields[1]))
        case ("task", 2): return .task(fields[1])
        case ("remote", 3): return .remote(deviceID: fields[1], sessionID: fields[2])
        default: return nil
        }
    }

    /// Drops a restored selection that no longer names anything.
    static func validate(
        _ item: DesktopCodeSidebarItem?,
        sessions: [CodeSessionID],
        tasks: [String],
        repositories: [WorkspaceID]
    ) -> DesktopCodeSidebarItem? {
        switch item {
        case .session(let id): return sessions.contains(id) ? item : nil
        case .task(let id): return tasks.contains(id) ? item : nil
        case .repository(let id): return repositories.contains(id) ? item : nil
        case .allProjects, .draft, .pulls, .design, .scheduled, .plugins, .security, .explore:
            return item
        case .remote, .none: return item
        }
    }

    /// Active runs, with anything blocked on the reader pinned to the very top.
    static func active(_ runs: [DesktopCodeRun]) -> [DesktopCodeRun] {
        runs
            .filter(\.status.isActive)
            .sorted { first, second in
                if first.status.needsApproval != second.status.needsApproval {
                    return first.status.needsApproval
                }
                return first.updatedAt > second.updatedAt
            }
    }

    /// The runs a filter admits, newest first with blocked runs on top.
    static func filtered(
        _ runs: [DesktopCodeRun],
        by filter: DesktopCodeSessionFilter
    ) -> [DesktopCodeRun] {
        runs
            .filter { filter.includes($0.status) }
            .sorted { first, second in
                if first.status.needsApproval != second.status.needsApproval {
                    return first.status.needsApproval
                }
                if first.status.isActive != second.status.isActive {
                    return first.status.isActive
                }
                return first.updatedAt > second.updatedAt
            }
    }

    /// Recency buckets, kept for the Projects index page.
    static func recencyGroups(
        _ runs: [DesktopCodeRun],
        now: Date,
        calendar: Calendar = .current
    ) -> [(title: String, runs: [DesktopCodeRun])] {
        var today: [DesktopCodeRun] = []
        var yesterday: [DesktopCodeRun] = []
        var thisWeek: [DesktopCodeRun] = []
        var earlier: [DesktopCodeRun] = []
        for run in runs.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            if calendar.isDateInToday(run.updatedAt) {
                today.append(run)
            } else if calendar.isDateInYesterday(run.updatedAt) {
                yesterday.append(run)
            } else if let days = calendar.dateComponents(
                [.day], from: run.updatedAt, to: now
            ).day, days < 7 {
                thisWeek.append(run)
            } else {
                earlier.append(run)
            }
        }
        var groups: [(String, [DesktopCodeRun])] = []
        if !today.isEmpty { groups.append(("Today", today)) }
        if !yesterday.isEmpty { groups.append(("Yesterday", yesterday)) }
        if !thisWeek.isEmpty { groups.append(("This week", thisWeek)) }
        if !earlier.isEmpty { groups.append(("Earlier", earlier)) }
        return groups
    }
}

enum DesktopCodeRunBuilder {
    static func runs(
        sessions: [CodeSession],
        workspaceNames: [WorkspaceID: String],
        tasks: [NativeCodeTask],
        query: String
    ) -> [DesktopCodeRun] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()

        var runs = sessions.map { session in
            DesktopCodeRun(
                item: .session(session.id),
                title: session.title,
                workspace: session.workspaceID
                    .map { workspaceNames[$0] ?? "Workspace" } ?? "No project",
                workspaceID: session.workspaceID,
                branch: session.gitBranch,
                environment: session.executionRootPath == nil ? .local : .worktree,
                status: CodeRunStatus(
                    session.status,
                    hasPendingApproval: session.hasPendingApproval
                ),
                updatedAt: session.updatedAt
            )
        }

        runs += tasks
            .filter { task in
                needle.isEmpty
                    || task.title.lowercased().contains(needle)
                    || task.whereItRuns.lowercased().contains(needle)
            }
            .map { task in
                DesktopCodeRun(
                    item: .task(task.id),
                    title: task.title,
                    workspace: task.whereItRuns,
                    workspaceID: nil,
                    branch: task.baseRef,
                    environment: task.target == .cloud ? .cloud : .device,
                    status: CodeRunStatus(task.status),
                    updatedAt: task.updatedAt
                )
            }

        return runs
    }

    static func run(for summary: CodeRemoteSessionSummary) -> DesktopCodeRun {
        DesktopCodeRun(
            item: .remote(deviceID: summary.deviceID, sessionID: summary.sessionID),
            title: summary.title,
            workspace: summary.workspaceName ?? "Remote workspace",
            workspaceID: nil,
            branch: summary.activeBranch,
            environment: .remote,
            status: CodeRunStatus(summary),
            updatedAt: summary.updatedAt
        )
    }
}

// MARK: - The draft

/// Everything fixed at the start of a local run.
///
/// A turn's mode, model, reasoning and permissions can still change later from
/// the session composer, but the first turn must not be created with hidden
/// hard-coded values. This value is also the seam that keeps the New task
/// screen independently testable from the local runtime.
struct DesktopLocalCodeDraft: Equatable {
    /// nil starts the conversation with no project: no file tools, no shell,
    /// no Git — see `SessionController.makeProjectlessOrchestrator`.
    let workspaceID: WorkspaceID?
    let prompt: String
    let behavior: AgentBehavior
    let permissionMode: PermissionMode
    let modelID: String
    let reasoningEffort: ReasoningEffort?
    /// Local or Worktree. Cloud and Device never reach this value; they are
    /// dispatched through `NativeCodeModel`.
    let environment: CodeEnvironmentChoice
    let customAgentID: String?
    let attachments: [CodeAttachment]
    let fileReferences: [WorkspacePath]

    init(
        workspaceID: WorkspaceID?,
        prompt: String,
        behavior: AgentBehavior,
        permissionMode: PermissionMode,
        modelID: String,
        reasoningEffort: ReasoningEffort?,
        environment: CodeEnvironmentChoice = .local,
        customAgentID: String? = nil,
        attachments: [CodeAttachment] = [],
        fileReferences: [WorkspacePath] = []
    ) {
        self.workspaceID = workspaceID
        self.prompt = prompt
        self.behavior = behavior
        self.permissionMode = permissionMode
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.environment = environment
        self.customAgentID = customAgentID
        self.attachments = attachments
        self.fileReferences = fileReferences
    }

    var configuration: AgentConfiguration {
        AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            behavior: behavior,
            permissionMode: permissionMode,
            location: .local,
            customAgentID: customAgentID
        )
    }

    /// Whether the session should be rooted in a fresh Git worktree.
    var usesIsolatedWorktree: Bool { environment == .worktree && workspaceID != nil }

    static func title(from prompt: String) -> String {
        let firstLine = prompt
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? prompt
        return firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
    }
}

/// Why a New task screen cannot send yet, stated inline under the composer.
///
/// Pure, so the four refusals are pinned by a test: a cloud run with no
/// repository, a device run with no computer, a worktree in a plain folder,
/// and attachments aimed at a runner that cannot take them.
enum DesktopCodeDraftReadiness {
    static func blockingReason(
        environment: CodeEnvironmentChoice,
        hasProject: Bool,
        projectIsGitRepository: Bool,
        hasCloudRepository: Bool,
        hasDevice: Bool,
        hasAttachments: Bool
    ) -> String? {
        switch environment {
        case .local:
            return nil
        case .worktree:
            if !hasProject { return "Choose a project to work in a worktree." }
            if !projectIsGitRepository {
                return "A worktree needs a Git repository. This project is a plain folder, so the task will run in it directly."
            }
            return nil
        case .cloud:
            if hasAttachments { return "Pictures and file context run on this Mac only." }
            if !hasCloudRepository { return "Cloud runs need a GitHub repository. Choose one above." }
            return nil
        case .device:
            if hasAttachments { return "Pictures and file context run on this Mac only." }
            if !hasDevice { return "No connected computer is online. Sign in to Juno on another Mac to run there." }
            return nil
        }
    }
}

// MARK: - The column

/// The Code window's navigation column.
///
/// Top to bottom: New session, search, a "Needs you" fold that exists only
/// while something is waiting, the projects with their sessions, the sessions
/// that belong to no project, and runs elsewhere. The footer holds Settings
/// and the account. One status mark per row, and only when there is a status
/// worth reading.
///
/// The navigation model — what a selection is, how it survives a relaunch —
/// is `DesktopCodeNavigation.swift`.
struct DesktopCodeSidebar: View {
    @Bindable var workbench: WorkbenchModel
    let code: NativeCodeModel
    let remote: CodeRemoteBrowserModel
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    @Binding var product: DesktopProductMode
    let isBootstrapping: Bool
    let session: NativeAuthenticatedSession?
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let plan: DesktopUsagePlan?
    let openRepository: () -> Void
    let newSession: (WorkspaceID?) -> Void
    let rename: (CodeSession) -> Void
    let openSettings: () -> Void

    @State private var searchFocused = false
    @State private var collapsed: Set<WorkspaceID> = []
    @State private var projectPendingRemoval: WorkspaceRecord?

    private var runs: [DesktopCodeRun] {
        DesktopCodeRunBuilder.runs(
            sessions: workbench.filteredSessions,
            workspaceNames: Dictionary(
                workbench.workspaces.map { ($0.id, $0.descriptor.displayName) },
                uniquingKeysWith: { first, _ in first }
            ),
            tasks: code.tasks,
            query: workbench.sessionSearchText
        )
    }

    private var isSearching: Bool {
        !workbench.sessionSearchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        let all = runs
        let waiting = DesktopCodeNavigationState.filtered(all, by: .needsYou)
        let local = all.filter { if case .session = $0.item { return true } else { return false } }
        let conversations = sorted(local.filter { $0.workspaceID == nil })
        let elsewhere = sorted(all.filter { if case .task = $0.item { return true } else { return false } })

        return List(selection: $selection) {
            Section {
                Label {
                    Text("New session")
                } icon: {
                    JunoIconView(.compose, size: 15)
                }
                .tag(DesktopCodeSidebarItem.draft)
                .accessibilityIdentifier("juno.code.new-conversation")
            }

            if !waiting.isEmpty {
                Section("Needs you") {
                    ForEach(waiting) { row($0, showsPlace: true) }
                }
            }

            Section {
                if workbench.workspaces.isEmpty, !isBootstrapping {
                    Button(action: openRepository) {
                        Label {
                            Text("Open a project…")
                        } icon: {
                            JunoIconView(.folderPlus, size: 14)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Studio.Ink.secondary)
                    .selectionDisabled()
                }
                ForEach(workbench.workspaces) { record in
                    project(record, runs: sorted(local.filter { $0.workspaceID == record.id }))
                }
            } header: {
                HStack {
                    Text("Projects")
                    Spacer()
                    Button(action: openRepository) {
                        JunoIconView(.plus, size: 12)
                    }
                    .buttonStyle(.borderless)
                    .help("Open a project (⌘O)")
                    .accessibilityLabel("Open a project")
                    .accessibilityIdentifier("juno.code.add-project")
                }
            }

            if !conversations.isEmpty {
                Section("Conversations") {
                    ForEach(conversations) { row($0, showsPlace: false) }
                }
            }

            if !elsewhere.isEmpty {
                Section("Cloud") {
                    ForEach(elsewhere) { row($0, showsPlace: true) }
                }
            }

            if !code.devices.isEmpty, !remote.sessions.isEmpty {
                Section {
                    ForEach(remote.sessions.filter(matchesSearch)) { summary in
                        row(DesktopCodeRunBuilder.run(for: summary), showsPlace: true)
                    }
                } header: {
                    HStack {
                        Text("Other computers")
                        Spacer()
                        Picker("Computer", selection: $remoteDeviceID) {
                            ForEach(code.devices) { device in
                                Text(device.online ? device.name : "\(device.name) · offline").tag(device.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .fixedSize()
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        .safeAreaInset(edge: .top, spacing: 0) {
            DesktopSidebarSearchField(
                text: $workbench.sessionSearchText,
                prompt: "Search sessions",
                isFocused: $searchFocused
            )
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
        }
        .junoSidebarProductHeader(product: $product)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            footer
        }
        .junoSidebarScrollEdge()
        .confirmationDialog(
            "Remove “\(projectPendingRemoval?.descriptor.displayName ?? "")” from Juno?",
            isPresented: Binding(
                get: { projectPendingRemoval != nil },
                set: { if !$0 { projectPendingRemoval = nil } }
            ),
            presenting: projectPendingRemoval
        ) { record in
            Button("Remove Project", role: .destructive) {
                Task { await workbench.removeWorkspace(id: record.id) }
            }
        } message: { _ in
            Text("The folder and its files stay on disk. Juno forgets its access; the sessions stay in your history.")
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func project(_ record: WorkspaceRecord, runs: [DesktopCodeRun]) -> some View {
        DisclosureGroup(isExpanded: Binding(
            get: { !collapsed.contains(record.id) || isSearching },
            set: { open in if open { collapsed.remove(record.id) } else { collapsed.insert(record.id) } }
        )) {
            ForEach(runs) { row($0, showsPlace: false) }
            if runs.isEmpty {
                Text(isSearching ? "No matches" : "No sessions yet")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .selectionDisabled()
            }
        } label: {
            Label {
                Text(record.descriptor.displayName)
                    .lineLimit(1)
            } icon: {
                JunoIconView(.projects, size: 14)
            }
            .tag(DesktopCodeSidebarItem.repository(record.id))
            .accessibilityIdentifier("juno.code.project.\(record.id.value)")
            .contextMenu {
                Button("New Session") { newSession(record.id) }
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([
                        URL(fileURLWithPath: record.descriptor.localPathHint),
                    ])
                }
                Divider()
                Button("Remove from Juno…", role: .destructive) { projectPendingRemoval = record }
            }
        }
    }

    private func row(_ run: DesktopCodeRun, showsPlace: Bool) -> some View {
        DesktopCodeSessionRow(run: run, showsPlace: showsPlace)
            .tag(run.item)
            .contextMenu { menu(for: run) }
    }

    @ViewBuilder
    private func menu(for run: DesktopCodeRun) -> some View {
        switch run.item {
        case .session(let id):
            if let session = workbench.sessions.first(where: { $0.id == id }) {
                Button("Rename…") { rename(session) }
                Button(session.isFavorite ? "Unpin" : "Pin") {
                    Task { await workbench.toggleFavorite(id: id) }
                }
                if let workspaceID = session.workspaceID {
                    Button("New Session in This Project") { newSession(workspaceID) }
                }
                Divider()
                Button("Delete", role: .destructive) {
                    if selection == run.item { selection = nil }
                    Task { await workbench.deleteSession(id: id) }
                }
            }
        case .task(let id):
            if let task = code.tasks.first(where: { $0.id == id }) {
                if let url = task.pullRequestURL {
                    Link("Open Pull Request", destination: url)
                }
                Button("Stop") {
                    selection = run.item
                    code.open(task)
                    Task { await code.cancelOpenTask() }
                }
                .disabled(!task.status.isActive)
            }
        case .remote(let deviceID, let sessionID):
            Button("Stop") {
                Task { await remote.stopGeneration(deviceID: deviceID, sessionID: sessionID) }
            }
        default:
            EmptyView()
        }
    }

    private func sorted(_ runs: [DesktopCodeRun]) -> [DesktopCodeRun] {
        runs.sorted { first, second in
            if first.status.isActive != second.status.isActive { return first.status.isActive }
            return first.updatedAt > second.updatedAt
        }
    }

    private func matchesSearch(_ summary: CodeRemoteSessionSummary) -> Bool {
        let needle = workbench.sessionSearchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        return summary.title.lowercased().contains(needle)
            || (summary.workspaceName ?? "").lowercased().contains(needle)
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 0) {
            if let error = workbench.lastError {
                Text(error)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
                    .lineLimit(3)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.top, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: JunoSpace.hairline) {
                Button {
                    selection = .pulls
                } label: {
                    Label {
                        Text("Pull requests")
                    } icon: {
                        JunoIconView(.pulls, size: 14)
                    }
                    .font(Studio.Font.label)
                }
                .buttonStyle(StudioQuietButtonStyle())
                Spacer()
                Button(action: openSettings) {
                    JunoIconView(.settings, size: 15)
                }
                .buttonStyle(StudioIconButtonStyle())
                .help("Code settings")
                .accessibilityLabel("Code settings")
                .accessibilityIdentifier("juno.code.settings")
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.top, JunoSpace.snug)
            if let session {
                DesktopSidebarFooter(
                    session: session,
                    avatarModel: avatarModel,
                    syncModel: syncModel,
                    plan: plan,
                    openUsage: { DesktopSettingsRouter.open(.usage) },
                    openSettings: { DesktopSettingsRouter.open(.general) }
                )
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// One session in the column: its title, and on the trailing edge either its
/// status mark or how long ago it moved.
struct DesktopCodeSessionRow: View {
    let run: DesktopCodeRun
    let showsPlace: Bool

    private var status: StudioStatus { StudioStatus(run.status) }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .font(Studio.Font.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if showsPlace, !run.workspace.isEmpty {
                    Text(run.workspace)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: JunoSpace.hairline)
            if status == .idle {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(StudioFormat.age(run.updatedAt, now: context.date))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            } else {
                StudioStatusGlyph(status: status, size: 7)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(run.title), \(status == .idle ? run.caption : status.label)")
    }
}
