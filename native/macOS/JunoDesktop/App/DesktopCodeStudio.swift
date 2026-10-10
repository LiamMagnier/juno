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
            if !hasDevice { return "No connected computer is online. Sign in to Alevr on another Mac to run there." }
            return nil
        }
    }
}

// MARK: - The column

/// The Code window's navigation column, drawn in the Chat column's recipes
/// (the web's `code-work-list.tsx` under `AppSidebar`).
///
/// WHAT IT SAYS is Code's: New session, Search, Open a project and Customize
/// as the headerless action block, then one list of work under the projects
/// filter. Sessions that need you come first, then working ones, then the
/// rest by recency; anything finished and untouched for three days folds
/// under Settled, and archived sessions fold under Archived at the end.
///
/// HOW IT LOOKS is Chat's: ``DesktopSidebarNavRow`` for the actions, the
/// mono heading rung for the filter and the folds, the 8pt-inset hover and
/// selected fills on every row, and the Chat list's two quiet lines when
/// there is nothing to show. A session row is the web's two-line row: the
/// title with its age, the project and branch under it. The trailing slot is
/// the only state a row shows, and the only coral in the column: a spinner
/// while it works, a raised hand when it needs you.
///
/// The navigation model (what a selection is, how it survives a relaunch) is
/// `DesktopCodeNavigationState` above; the split into active and settled work
/// is ``DesktopCodeWorkList``.
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
    /// The clock the ages and the Settled fold read. Snapshots pin it.
    var now = Date()
    /// Snapshots draw the Settled fold open; the app never sets it.
    var startsShowingSettled = false

    @State private var searchOpen = false
    @State private var searchFocused = false
    @State private var projectPendingRemoval: WorkspaceRecord?
    @State private var showsSettled = false
    @State private var showsArchived = false
    @State private var projectFilter: WorkspaceID?

    private var workspaceNames: [WorkspaceID: String] {
        Dictionary(
            workbench.workspaces.map { ($0.id, $0.descriptor.displayName) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    private var runs: [DesktopCodeRun] {
        DesktopCodeRunBuilder.runs(
            sessions: workbench.filteredSessions,
            workspaceNames: workspaceNames,
            tasks: code.tasks,
            query: workbench.sessionSearchText
        )
    }

    private var isSearching: Bool {
        !workbench.sessionSearchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        let known = workspaceNames
        let work = DesktopCodeWorkList.split(
            runs.filter { run in
                guard let projectFilter else { return true }
                return run.workspaceID == projectFilter
            },
            now: now
        )
        let archived = workbench.filteredArchivedSessions

        return List(selection: $selection) {
            actionBlock

            projectsHeading(title: projectFilter.flatMap { known[$0] } ?? "All projects")
            ForEach(work.active) { run in row(run, project: run.workspaceID.flatMap { known[$0] }) }

            if work.active.isEmpty, work.settled.isEmpty, !isBootstrapping {
                emptyLines
            }

            if !work.settled.isEmpty {
                // Searching opens the folds: a match hidden behind a fold is
                // a match the reader cannot see.
                let open = showsSettled || isSearching
                DesktopSidebarHeadingRow(title: "Settled · \(work.settled.count)", action: { showsSettled.toggle() }) {
                    DesktopCodeFoldChevron(isOpen: open)
                }
                .help(showsSettled ? "Hide settled sessions" : "Show settled sessions")
                .accessibilityValue(open ? "Shown" : "Hidden")
                if open {
                    ForEach(work.settled) { run in row(run, project: run.workspaceID.flatMap { known[$0] }) }
                }
            }

            if !archived.isEmpty {
                let open = showsArchived || isSearching
                DesktopSidebarHeadingRow(title: "Archived · \(archived.count)", action: { showsArchived.toggle() }) {
                    DesktopCodeFoldChevron(isOpen: open)
                }
                .help(showsArchived ? "Hide archived sessions" : "Show archived sessions")
                .accessibilityValue(open ? "Shown" : "Hidden")
                if open {
                    ForEach(archivedRuns(archived)) { run in row(run, project: run.workspaceID.flatMap { known[$0] }) }
                }
            }

            if !code.devices.isEmpty, !remote.sessions.isEmpty {
                DesktopSidebarHeadingRow(title: "Other computers") {
                    Picker("Computer", selection: $remoteDeviceID) {
                        ForEach(code.devices) { device in
                            Text(device.online ? device.name : "\(device.name), offline").tag(device.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .fixedSize()
                }
                ForEach(remote.sessions.filter(matchesSearch)) { summary in
                    row(DesktopCodeRunBuilder.run(for: summary), project: summary.workspaceName)
                }
            }
        }
        .listStyle(.sidebar)
        // The web's rows set their own heights, as Chat's column does.
        .environment(\.defaultMinListRowHeight, 0)
        .junoSidebarSelectionTint()
        .safeAreaBar(edge: .bottom, spacing: 0) {
            footer
        }
        .junoSidebarScrollEdge()
        .onAppear {
            if startsShowingSettled { showsSettled = true }
        }
        .confirmationDialog(
            "Remove \u{201C}\(projectPendingRemoval?.descriptor.displayName ?? "")\u{201D} from Alevr?",
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
                if projectFilter == record.id { projectFilter = nil }
                Task { await workbench.removeWorkspace(id: record.id) }
            }
                .contentShape(.rect)
        } message: { _ in
            Text("The folder and its files stay on disk. Alevr stops its running sessions and forgets its access; the sessions stay in your history.")
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

    // MARK: Actions

    /// New session and Search, then Open a project and Customize: Chat's
    /// headerless block, in the contract's words and the web's glyphs.
    @ViewBuilder
    private var actionBlock: some View {
        // A button and never a tagged row: a draft selects nothing.
        DesktopSidebarNavRow(
            icon: JunoShellCodeSidebar.Action.new.icon,
            title: JunoShellCodeSidebar.Action.new.label,
            action: { newSession(projectFilter) }
        )
        .help(JunoShortcutRegistry.help(JunoShellCodeSidebar.Action.new.title, .newChat))
        .accessibilityIdentifier("juno.code.new-conversation")

        // Search filters this list in place, so its field opens under the
        // row rather than in a panel over the window.
        DesktopSidebarNavRow(
            icon: JunoShellCodeSidebar.Action.search.icon,
            title: JunoShellCodeSidebar.Action.search.label,
            gesture: .tilts,
            action: {
                searchOpen = true
                searchFocused = true
            }
        )
        .help("Search sessions")
        .accessibilityIdentifier("juno.code.sidebar.search")

        if searchOpen || isSearching {
            DesktopSidebarSearchField(
                text: $workbench.sessionSearchText,
                prompt: "Search sessions",
                isFocused: $searchFocused
            )
            .padding(.horizontal, DesktopSidebarMetrics.fillInset - DesktopSidebarMetrics.listOrigin + JunoSpace.hairline)
            .padding(.vertical, JunoSpace.micro)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .selectionDisabled()
            .onChange(of: searchFocused) { _, focused in
                if !focused, !isSearching { searchOpen = false }
            }
        }

        DesktopSidebarNavRow(
            icon: .folderPlus,
            title: "Open a project",
            gesture: .folderOpens,
            action: openRepository
        )
        .help(JunoShortcutRegistry.help("Open a project", .codeOpenFolder))
        .accessibilityIdentifier("juno.code.add-project")

        // Customize wears the web's sliders, as Chat's row does, and opens
        // the settings for the product on screen.
        DesktopSidebarNavRow(
            icon: .sliders,
            title: JunoShellDestination.customize.label,
            gesture: .turns,
            action: openSettings
        )
        .help("Customize Code")
        .accessibilityIdentifier("juno.code.sidebar.customize")
    }

    // MARK: The filter

    /// The list's first heading is its filter: the heading rung's mono words
    /// with a chevron, opening the projects menu. The words brighten under
    /// the pointer as a folding heading's do.
    private func projectsHeading(title: String) -> some View {
        DesktopCodeProjectsHeading(title: title) { projectMenu }
    }

    /// The projects filter's menu: which project's work to list, opening and
    /// removing projects, and the destinations that left the column.
    @ViewBuilder
    private var projectMenu: some View {
        Button {
            projectFilter = nil
        } label: {
            if projectFilter == nil { Label("All Projects", image: JunoIcon.check.assetName) } else { Text("All Projects") }
        }
            .contentShape(.rect)
        ForEach(workbench.workspaces) { record in
            Button {
                projectFilter = record.id
            } label: {
                if projectFilter == record.id {
                    Label(record.descriptor.displayName, image: JunoIcon.check.assetName)
                } else {
                    Text(record.descriptor.displayName)
                }
            }
                .contentShape(.rect)
        }
        Divider()
        Button("Open Project…", action: openRepository)
            .contentShape(.rect)
        if let projectFilter, let record = workbench.workspaces.first(where: { $0.id == projectFilter }) {
            Button("New Session in \(record.descriptor.displayName)") { newSession(record.id) }
                .contentShape(.rect)
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: record.descriptor.localPathHint)])
            }
                .contentShape(.rect)
            Button("Remove from Alevr…", role: .destructive) { projectPendingRemoval = record }
                .contentShape(.rect)
        }
        Divider()
        Button("Pull Requests") { selection = .pulls }
            .contentShape(.rect)
        Button("Artifacts") { DesktopPageRouter.shared.open(.artifacts) }
            .contentShape(.rect)
        ForEach(JunoShellCodeSidebar.More.items, id: \.destination) { item in
            Button(item.destination.title) { DesktopSettingsRouter.open(.connectors) }
                .contentShape(.rect)
        }
    }

    // MARK: Empty

    /// The Chat list's two quiet lines, in Code's words: what is missing,
    /// then where to start it.
    private var emptyLines: some View {
        let lines = DesktopCodeWorkList.emptyLines(
            searching: isSearching,
            project: projectFilter.flatMap { workspaceNames[$0] },
            hasProjects: !workbench.workspaces.isEmpty
        )
        return VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text(lines.first ?? "")
                .junoFont(size: 13, relativeTo: .callout)
                .junoSecondaryInk()
            if lines.count > 1 {
                Text(lines[1])
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoSecondaryInk()
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .selectionDisabled()
        .accessibilityElement(children: .combine)
    }

    // MARK: Rows

    private func row(_ run: DesktopCodeRun, project: String?) -> some View {
        let selected = selection == run.item
        return DesktopCodeSessionRow(run: run, project: project, now: now, isSelected: selected) {
            archive(run)
        }
        .tag(run.item)
        .contextMenu { menu(for: run) }
    }

    private func archive(_ run: DesktopCodeRun) {
        guard case .session(let id) = run.item, !workbench.isArchived(id) else { return }
        Task {
            if case .done = await workbench.archive(id), selection == .session(id) {
                selection = nil
            }
        }
    }

    /// Archived sessions as sidebar rows, newest first.
    private func archivedRuns(_ sessions: [CodeSession]) -> [DesktopCodeRun] {
        sorted(DesktopCodeRunBuilder.runs(
            sessions: sessions,
            workspaceNames: workspaceNames,
            tasks: [],
            query: workbench.sessionSearchText
        ))
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
        if workbench.isArchived(id) {
            Button("Unarchive") { workbench.unarchive(id) }
                .contentShape(.rect)
        } else {
            Button("Archive") {
                Task {
                    // A refusal (a worktree with changes, a run working) is
                    // said in the footer, and the session stays.
                    if case .done = await workbench.archive(id), selection == .session(id) {
                        selection = nil
                    }
                }
            }
            .contentShape(.rect)
        }
    }

    @ViewBuilder
    private func menu(for run: DesktopCodeRun) -> some View {
        switch run.item {
        case .session(let id):
            if let session = workbench.sessions.first(where: { $0.id == id }) {
                Button("Rename…") { rename(session) }
                    .contentShape(.rect)
                Button(session.isFavorite ? "Unpin" : "Pin") {
                    Task { await workbench.toggleFavorite(id: id) }
                }
                    .contentShape(.rect)
                if let workspaceID = session.workspaceID {
                    Button("New Session in This Project") { newSession(workspaceID) }
                        .contentShape(.rect)
                }
                Divider()
                sessionShipItems(id)
                Divider()
                Button("Delete", role: .destructive) {
                    if selection == run.item { selection = nil }
                    Task { await workbench.deleteSession(id: id) }
                }
                    .contentShape(.rect)
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
                    .contentShape(.rect)
            }
        case .remote(let deviceID, let sessionID):
            Button("Stop") {
                Task { await remote.stopGeneration(deviceID: deviceID, sessionID: sessionID) }
            }
                .contentShape(.rect)
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

    /// Chat's footer, verbatim, with its gear pointed at Code's settings: the
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

// MARK: - The list of work

/// How the column splits its sessions (the web's `workList`): pure, so the
/// order and the Settled rule are reachable from a test.
enum DesktopCodeWorkList {
    /// How long a finished session stays in the list before it settles.
    static let settleAfter: TimeInterval = 3 * 24 * 60 * 60

    /// Needs you, then working, then the rest by recency; and the settled
    /// rest, newest first.
    static func split(_ runs: [DesktopCodeRun], now: Date) -> (active: [DesktopCodeRun], settled: [DesktopCodeRun]) {
        func rank(_ run: DesktopCodeRun) -> Int {
            switch StudioStatus(run.status) {
            case .needsYou: 0
            case .working: 1
            default: 2
            }
        }
        var active: [DesktopCodeRun] = []
        var settled: [DesktopCodeRun] = []
        for run in runs {
            if rank(run) == 2, now.timeIntervalSince(run.updatedAt) > settleAfter {
                settled.append(run)
            } else {
                active.append(run)
            }
        }
        active.sort { a, b in rank(a) == rank(b) ? a.updatedAt > b.updatedAt : rank(a) < rank(b) }
        settled.sort { $0.updatedAt > $1.updatedAt }
        return (active, settled)
    }

    /// What the list says when it has nothing to show, line by line.
    static func emptyLines(searching: Bool, project: String?, hasProjects: Bool) -> [String] {
        if searching { return ["No matches.", "Try another word, or a project's name."] }
        if let project { return ["No sessions in \(project) yet.", "Start one above."] }
        if !hasProjects { return ["No sessions yet.", "Open a project to start one."] }
        return JunoShellCodeSidebar.emptyLines
    }
}

// MARK: - Headings

/// The projects filter as the list's first heading: the mono heading rung
/// on the 16pt edge, its chevron always drawn because it opens a menu.
private struct DesktopCodeProjectsHeading<Items: View>: View {
    let title: String
    @ViewBuilder let items: () -> Items

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            Menu {
                items()
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    Text(title)
                        .junoFont(size: DesktopSidebarMetrics.headingSize, relativeTo: .caption, design: .monospaced)
                        .tracking(DesktopSidebarMetrics.headingTracking)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    JunoIconView(.chevronDown, size: 10)
                }
                .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(height: DesktopSidebarMetrics.headingHeight)
                .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .onHover { hovered = $0 }
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
            .help("Show one project's sessions")
            .accessibilityLabel("Projects")
            .accessibilityValue(title)
            .accessibilityIdentifier("juno.code.sidebar.projects")
            Spacer(minLength: 0)
        }
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .padding(.trailing, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .padding(.top, DesktopSidebarMetrics.headingGap)
        .frame(maxWidth: .infinity, alignment: .bottomLeading)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .selectionDisabled()
    }
}

/// A fold's chevron at its heading's end: down while open, right while shut.
private struct DesktopCodeFoldChevron: View {
    let isOpen: Bool

    var body: some View {
        JunoIconView(isOpen ? .chevronDown : .chevronRight, size: 10)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(width: DesktopSidebarMetrics.trailingSlot, height: DesktopSidebarMetrics.trailingSlot)
            .accessibilityHidden(true)
    }
}

// MARK: - The session row

/// One session: the web's two-line work row in the Chat column's fills.
///
/// The title on the first line with its age at the end; the project and the
/// branch under it in the muted ink. The age gives way to a coral spinner
/// while the session works and a coral raised hand when it needs you, the
/// column's only colour, and to Archive under the pointer.
struct DesktopCodeSessionRow: View {
    let run: DesktopCodeRun
    var project: String?
    var now = Date()
    var isSelected = false
    var archive: (() -> Void)?

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var status: StudioStatus { StudioStatus(run.status) }

    /// Another conversation messaged this session and the reader has not
    /// opened it since: the title reads like any unread row (full ink,
    /// medium weight), with no mark.
    private var hasUnreadMessage: Bool {
        guard !isSelected, case let .session(id) = run.item else { return false }
        return CodeCrossInbox.shared.isUnread(id)
    }

    /// The second line: the project, then where the work sits.
    private var place: String? {
        let name = project ?? (run.workspace.isEmpty ? nil : run.workspace)
        return name
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(spacing: JunoSpace.snug) {
                Text(run.title)
                    .junoFont(size: DesktopSidebarMetrics.labelSize, relativeTo: .body, weight: hasUnreadMessage ? .medium : .regular)
                    .foregroundStyle(isSelected || hovered || hasUnreadMessage ? Color.junoForeground : Color.junoSidebarInk)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                    .frame(minWidth: DesktopSidebarMetrics.trailingSlot, minHeight: DesktopSidebarMetrics.trailingSlot, alignment: .trailing)
            }
            HStack(spacing: JunoSpace.tight) {
                if let place {
                    Text(place)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                if let branch = run.branch, !branch.isEmpty {
                    JunoIconView(.branch, size: 11)
                    Text(branch)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .junoFont(size: 12, relativeTo: .caption)
            .foregroundStyle(Color.junoSecondaryInk)
        }
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .padding(.trailing, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin + JunoSpace.micro)
        .onHover { hovered = $0 }
        .desktopSidebarRow(selected: isSelected, hovered: hovered, height: JunoLayout.Row.height)
        .help("\(run.title)\n\(run.caption)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var trailing: some View {
        if hovered, let archive, case .session = run.item {
            Button(action: archive) {
                JunoIconView(.archive, size: 13)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: DesktopSidebarMetrics.trailingSlot, height: DesktopSidebarMetrics.trailingSlot)
                    .contentShape(Rectangle().inset(by: -JunoSpace.micro))
            }
            .buttonStyle(.plain)
            .help("Archive")
            .accessibilityLabel("Archive")
        } else {
            switch status {
            case .working:
                Group {
                    if reduceMotion {
                        Circle().stroke(Studio.Signal.edge, lineWidth: 1.4)
                    } else {
                        StudioSpinner(color: Studio.Signal.edge, lineWidth: 1.4)
                    }
                }
                .frame(width: 11, height: 11)
                .frame(width: DesktopSidebarMetrics.trailingSlot, height: DesktopSidebarMetrics.trailingSlot)
                .accessibilityHidden(true)
            case .needsYou:
                JunoIconView(.hand, size: 13)
                    .foregroundStyle(Studio.Signal.edge)
                    .frame(width: DesktopSidebarMetrics.trailingSlot, height: DesktopSidebarMetrics.trailingSlot)
                    .accessibilityHidden(true)
            case .failed:
                age.foregroundStyle(Color.junoDestructiveInk)
            case .idle:
                age.foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }

    private var age: some View {
        Text(CodeSidebarSession.age(run.updatedAt, now: now))
            .junoFont(size: 12, relativeTo: .caption)
            .monospacedDigit()
            .lineLimit(1)
    }

    private var accessibilityText: String {
        var parts = [run.title]
        if let place { parts.append(place) }
        switch status {
        case .working: parts.append("working")
        case .needsYou: parts.append("needs you")
        case .failed: parts.append("failed")
        case .idle: break
        }
        return parts.joined(separator: ", ")
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
