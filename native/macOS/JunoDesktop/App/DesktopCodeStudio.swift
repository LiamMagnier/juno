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
import UniformTypeIdentifiers

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

/// The Code window's navigation column, in **Chat's grammar** (premium pass,
/// rule 1 of `docs/design/premium-pass/BRIEF.md`).
///
/// The column used to speak a dialect of its own: a search field pinned over
/// the list, a system-blue "New session" glyph, a blue "Open a project…" row,
/// red and coral status dots, system section headers and a footer that was a
/// different component from Chat's. Switching products changed the furniture
/// as well as the contents. Now both columns are built from the same parts:
///
/// - a headerless block of action and destination rows (monochrome 16pt mark
///   and label, the selected row lifting to foreground ink) — New session,
///   Search, then the web's Code destinations (`JunoShellCodeSidebar`):
///   Pull requests, Artifacts and Customize, and a More menu;
/// - ``DesktopSidebarHeading`` for every section: Needs you, Projects,
///   Without a project, Removed projects, Cloud, Other computers;
/// - titles on the nav glyphs' column and one trailing mark per row in the
///   shared ``DesktopSidebarTrailingSlot`` — a live spinner in sidebar ink, the
///   needs-you dot (the one accent in the column) or a failed run's cross;
/// - ``DesktopAccountFooter``, the same footer Chat pins, whose gear opens
///   Code's settings while Code is on screen.
///
/// Search is a row, as in Chat. Pressed, it becomes the filter field in place
/// and stays one while it holds text; emptied and left, it is a row again.
///
/// The navigation model — what a selection is, how it survives a relaunch —
/// is `DesktopCodeNavigationState` above.
struct DesktopCodeSidebar: View {
    @Bindable var workbench: WorkbenchModel
    let code: NativeCodeModel
    let remote: CodeRemoteBrowserModel
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    @Binding var product: DesktopProductMode
    let isBootstrapping: Bool
    let configuration: JunoDesktopConfiguration?
    let session: NativeAuthenticatedSession?
    let openRepository: () -> Void
    let newSession: (WorkspaceID?) -> Void
    let rename: (CodeSession) -> Void
    let openSettings: () -> Void

    @State private var searchOpen = false
    @State private var searchFocused = false
    @State private var collapsed: Set<WorkspaceID> = []
    @State private var projectPendingRemoval: WorkspaceRecord?
    @State private var hoveringProjectsHeader = false

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
        // Local sessions wait in the Runs list; what is left here is the
        // cloud's and other computers'.
        let waiting = DesktopCodeNavigationState.filtered(all, by: .needsYou).filter {
            if case .session = $0.item { return false } else { return true }
        }
        let runSections = isSearching ? [] : workbench.runSections
        let local = all.filter { if case .session = $0.item { return true } else { return false } }
        let conversations = sorted(local.filter { $0.workspaceID == nil })
        // Sessions of a project removed from Juno. They stay in the history,
        // as the removal promises; listed nowhere else, they had vanished
        // from the column.
        let knownProjects = Set(workbench.workspaces.map(\.id))
        let removedProjects = sorted(local.filter { run in
            run.workspaceID.map { !knownProjects.contains($0) } ?? false
        })
        let elsewhere = sorted(all.filter { if case .task = $0.item { return true } else { return false } })

        return List(selection: $selection) {
            Section { navigationBlock }

            // Runs (CODE_AGENT_SPEC §5.1): every session with a run, grouped
            // by what it needs, each answered in its row. The heading carries
            // the count in words; no dots, no badges.
            ForEach(runSections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        StudioRunRow(entry: entry) { answer in
                            // Bound to the approval this row showed.
                            await workbench.answer(answer, shown: entry)
                        }
                        .padding(.leading, JunoSidebarMetrics.titleLeading)
                        .junoSidebarRowSelection(selection == .session(entry.sessionID))
                        .tag(DesktopCodeSidebarItem.session(entry.sessionID))
                        .contextMenu { runMenu(entry.sessionID) }
                    }
                } header: {
                    DesktopSidebarHeading(section.heading)
                }
            }

            if !waiting.isEmpty {
                Section {
                    ForEach(waiting) { row($0) }
                } header: {
                    DesktopSidebarHeading(JunoShellCodeSidebar.Heading.needsYou.label)
                }
            }

            Section {
                if workbench.workspaces.isEmpty, !isBootstrapping {
                    Button(action: openRepository) {
                        Label {
                            Text("Open a project…")
                        } icon: {
                            JunoSymbol(.folderPlus)
                                .foregroundStyle(Color.junoSidebarInk)
                        }
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help(JunoShortcutRegistry.help("Open a project", .codeOpenFolder))
                    .selectionDisabled()
                }
                ForEach(workbench.workspaces) { record in
                    project(record, runs: sorted(local.filter { $0.workspaceID == record.id }))
                }
            } header: {
                projectsHeader
            }

            if !conversations.isEmpty {
                Section {
                    ForEach(conversations) { row($0) }
                } header: {
                    DesktopSidebarHeading("Without a project")
                }
            }

            if !removedProjects.isEmpty {
                Section {
                    ForEach(removedProjects) { row($0) }
                } header: {
                    DesktopSidebarHeading("Removed projects")
                }
            }

            if !elsewhere.isEmpty {
                Section {
                    ForEach(elsewhere) { row($0) }
                } header: {
                    DesktopSidebarHeading("Cloud")
                }
            }

            if !code.devices.isEmpty, !remote.sessions.isEmpty {
                Section {
                    ForEach(remote.sessions.filter(matchesSearch)) { summary in
                        row(DesktopCodeRunBuilder.run(for: summary))
                    }
                } header: {
                    HStack(spacing: JunoSpace.tight) {
                        DesktopSidebarHeading("Other computers")
                        Spacer(minLength: 0)
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
        .junoProductSwitch(product: $product)
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
                // A thread left on screen would have no row to return to and
                // no folder to act in once the project is gone.
                if isInProject(selection, record.id) { selection = .draft }
                Task { await workbench.removeWorkspace(id: record.id) }
            }
        } message: { _ in
            Text("The folder and its files stay on disk. Juno stops its running sessions and forgets its access; the sessions stay in your history.")
        }
        .accessibilityIdentifier("juno.code.sidebar")
        // Titles, projects and pull request links match as you type; this
        // reads the transcripts too, once typing pauses (§5.17).
        .task(id: workbench.sessionSearchText) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await workbench.searchTranscripts(workbench.sessionSearchText)
        }
    }

    // MARK: Navigation block

    /// New session, Search, the destinations and More — Chat's block, with
    /// Code's words (`JunoShellCodeSidebar`).
    @ViewBuilder
    private var navigationBlock: some View {
        // Tagged, unlike Chat's New chat: in Code the new-session screen is a
        // destination the reader can leave and come back to with a draft in it.
        navLabel(JunoShellCodeSidebar.Action.new.label, icon: JunoShellCodeSidebar.Action.new.icon, selected: selection == .draft)
            .junoSidebarRowSelection(selection == .draft)
            .tag(DesktopCodeSidebarItem.draft)
            .help(JunoShortcutRegistry.help(JunoShellCodeSidebar.Action.new.label, .newChat))
            .accessibilityIdentifier("juno.code.new-conversation")

        if searchOpen || isSearching {
            DesktopSidebarSearchField(
                text: $workbench.sessionSearchText,
                prompt: "Search sessions",
                isFocused: $searchFocused
            )
            .selectionDisabled()
            .onChange(of: searchFocused) { _, focused in
                if !focused, !isSearching { searchOpen = false }
            }
        } else {
            Button {
                searchOpen = true
                searchFocused = true
            } label: {
                navLabel(JunoShellCodeSidebar.Action.search.label, icon: JunoShellCodeSidebar.Action.search.icon, selected: false)
            }
            .buttonStyle(.plain)
            .help("Search sessions")
            .accessibilityIdentifier("juno.code.sidebar.search")
        }

        navLabel(JunoShellDestination.pulls.label, icon: JunoShellDestination.pulls.icon, selected: selection == .pulls)
            .junoSidebarRowSelection(selection == .pulls)
            .tag(DesktopCodeSidebarItem.pulls)
            .accessibilityIdentifier("juno.code.sidebar.pulls")

        // Artifacts live in Chat's page stack; the row opens them there, as
        // the web's Code column does.
        Button {
            DesktopPageRouter.shared.open(.artifacts)
        } label: {
            navLabel(JunoShellDestination.artifacts.label, icon: JunoShellDestination.artifacts.icon, selected: false)
        }
        .buttonStyle(.plain)
        .help("Open Artifacts in Chat")
        .accessibilityIdentifier("juno.code.sidebar.artifacts")

        Button(action: openSettings) {
            navLabel(JunoShellDestination.customize.label, icon: JunoShellDestination.customize.icon, selected: false)
        }
        .buttonStyle(.plain)
        .help("Permissions, agents, hooks and tools for Code")
        .accessibilityIdentifier("juno.code.sidebar.customize")

        Menu {
            Button(action: openRepository) {
                Label("Open Project…", image: JunoIcon.folderPlus.assetName)
            }
            ForEach(JunoShellCodeSidebar.More.items, id: \.destination) { item in
                Button {
                    DesktopSettingsRouter.open(.connectors)
                } label: {
                    Label(item.destination.title, image: item.destination.icon.assetName)
                }
            }
        } label: {
            navLabel(JunoShellCodeSidebar.More.label, icon: JunoShellCodeSidebar.More.icon, selected: false)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .accessibilityLabel(JunoShellCodeSidebar.More.label)
        .accessibilityIdentifier("juno.code.sidebar.more")
    }

    /// One nav row's face: the mark and the words in one ink, which lifts to
    /// the foreground on the selected row. Chat's recipe, stated on the mark
    /// too because a `.sidebar` list resolves a `Label`'s icon against the
    /// system accent otherwise.
    private func navLabel(_ title: String, icon: JunoIcon, selected: Bool) -> some View {
        let ink = selected ? Color.junoForeground : Color.junoSidebarInk
        return Label {
            Text(title)
        } icon: {
            JunoSymbol(icon, weight: selected ? .fill : .regular)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    /// "Projects", with Open a project beside it, revealed on hover the way
    /// Chat's "Pinned projects" reveals New project. Always reachable by the
    /// keyboard and VoiceOver.
    private var projectsHeader: some View {
        HStack(spacing: JunoSpace.tight) {
            DesktopSidebarHeading("Projects")
            Spacer(minLength: 0)
            Button(action: openRepository) {
                JunoIconView(.plus, size: 12)
                    .foregroundStyle(Color.junoSidebarInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .opacity(hoveringProjectsHeader || workbench.workspaces.isEmpty ? 1 : 0)
            .help(JunoShortcutRegistry.help("Open a project", .codeOpenFolder))
            .accessibilityLabel("Open a project")
            .accessibilityIdentifier("juno.code.add-project")
        }
        .onHover { hoveringProjectsHeader = $0 }
        .animation(JunoMotion.fast, value: hoveringProjectsHeader)
    }

    // MARK: Rows

    @ViewBuilder
    private func project(_ record: WorkspaceRecord, runs: [DesktopCodeRun]) -> some View {
        let selected = selection == .repository(record.id)
        let ink = selected ? Color.junoForeground : Color.junoSidebarInk
        DisclosureGroup(isExpanded: Binding(
            get: { !collapsed.contains(record.id) || isSearching },
            set: { open in if open { collapsed.remove(record.id) } else { collapsed.insert(record.id) } }
        )) {
            ForEach(runs) { row($0) }
            if runs.isEmpty {
                Text(isSearching ? "No matches" : "No sessions yet")
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.leading, JunoSidebarMetrics.titleLeading)
                    .selectionDisabled()
            }
        } label: {
            Label {
                Text(record.descriptor.displayName)
                    .lineLimit(1)
            } icon: {
                JunoSymbol(.projects, weight: selected ? .fill : .regular)
                    .foregroundStyle(ink)
            }
            .foregroundStyle(ink)
            .junoSidebarRowSelection(selected)
            .tag(DesktopCodeSidebarItem.repository(record.id))
            .help((record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath)
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

    private func row(_ run: DesktopCodeRun) -> some View {
        DesktopCodeSessionRow(run: run)
            .junoSidebarRowSelection(selection == run.item)
            .tag(run.item)
            .contextMenu { menu(for: run) }
    }

    /// A Runs row's menu: open it, fork it, archive it.
    @ViewBuilder
    private func runMenu(_ id: CodeSessionID) -> some View {
        Button("Open") { selection = .session(id) }
            .contentShape(.rect)
        sessionShipItems(id)
    }

    /// Fork, worktree, export and archive (CODE_AGENT_SPEC §5.6, §5.7, §5.17).
    @ViewBuilder
    private func sessionShipItems(_ id: CodeSessionID) -> some View {
        Button("Fork Session") {
            Task {
                if let fork = await workbench.fork(id, throughTurn: nil) {
                    selection = .session(fork.id)
                }
            }
        }
        .contentShape(.rect)
        Button("Fork into Its Own Worktree") {
            Task {
                if let fork = await workbench.fork(id, throughTurn: nil, inNewWorktree: true) {
                    selection = .session(fork.id)
                }
            }
        }
        .contentShape(.rect)
        Button("Export as Markdown…") {
            Task { await DesktopSessionExport.save(id, from: workbench) }
        }
        .contentShape(.rect)
        Button("Archive") {
            if selection == .session(id) { selection = nil }
            Task { _ = await workbench.archive(id) }
        }
        .contentShape(.rect)
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
                sessionShipItems(id)
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

    /// Whether a selection is a project, or one of its sessions.
    private func isInProject(_ item: DesktopCodeSidebarItem?, _ id: WorkspaceID) -> Bool {
        switch item {
        case .repository(let selected):
            return selected == id
        case .session(let sessionID):
            return workbench.sessions.first { $0.id == sessionID }?.workspaceID == id
        default:
            return false
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

    /// Chat's footer, verbatim, with its gear pointed at Code's settings — the
    /// settings for the product on screen. The app's Settings stay one press
    /// away in the account menu and on ⌘,.
    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = workbench.lastError {
                Text(error)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .lineLimit(3)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let configuration, let session {
                DesktopAccountFooter(
                    configuration: configuration,
                    session: session,
                    settingsAction: DesktopFooterSettingsAction(
                        help: "Code settings",
                        identifier: "juno.code.settings",
                        action: openSettings
                    )
                )
            }
        }
    }
}

/// One session in the column, in Chat's row grammar: its title on the nav
/// glyphs' column and at most one trailing mark — a spinner in sidebar ink
/// while it works, the needs-you dot (the column's one accent), a cross when
/// it failed. Where it runs and how long ago it moved are the row's help and
/// part of what VoiceOver reads, not a second line on every row.
struct DesktopCodeSessionRow: View {
    let run: DesktopCodeRun

    private var status: StudioStatus { StudioStatus(run.status) }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text(run.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            DesktopSidebarTrailingSlot { mark }
        }
        .padding(.leading, JunoSidebarMetrics.titleLeading)
        .junoSidebarRowInk()
        .help("\(run.title)\n\(run.caption)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(run.title), \(status == .idle ? run.caption : status.label)")
    }

    private var mark: some View {
        DesktopSidebarStatusMark(tone: {
            switch status {
            case .idle: .neutral
            case .working: .live
            case .needsYou: .attention
            case .failed: .bad
            }
        }())
    }
}

/// Saving a session's transcript where the reader chooses (§5.17).
@MainActor
enum DesktopSessionExport {
    static func save(_ id: CodeSessionID, from workbench: WorkbenchModel) async {
        guard let markdown = await workbench.exportMarkdown(id) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        let title = workbench.sessions.first { $0.id == id }?.title ?? "Session"
        panel.nameFieldStringValue = title.replacingOccurrences(of: "/", with: "-") + ".md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? markdown.write(to: url, atomically: true, encoding: .utf8)
    }
}
