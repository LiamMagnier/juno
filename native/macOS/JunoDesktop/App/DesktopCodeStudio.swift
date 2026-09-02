import AppKit
import JunoAuth
import JunoChatKit
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import SwiftUI
import UniformTypeIdentifiers

/// The Code window's sessions column, its selection rules, its status
/// vocabulary, and the New task screen.
///
/// The window shell is ``DesktopCodeWorkspace``. This file used to draw six
/// equal-weight sections at once — search, Workspace, Needs attention, In
/// progress, a Recents list mixing pinned, recent and relayed runs, Projects,
/// Other computers — and to host the account's Usage, Settings and Connections
/// pages inside the coding surface. It is now the shape Codex and Claude Code
/// desktop settle on: a column of sessions grouped by project with one filter
/// row, and account pages in the Settings window where a Mac keeps them.
///
/// The file name is historical; its contents are the navigation column and
/// the screen a new task starts on.

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
    /// Juno Design, reached from the footer as the website does it.
    case design
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
        case .running: "Running"
        case .needsYou: "Needs you"
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
        case .allProjects, .draft, .pulls, .design: return item
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

// MARK: - Sessions column

/// A project in the column, with the sessions that belong to it.
struct DesktopCodeProjectGroup: Identifiable {
    let workspaceID: WorkspaceID
    let name: String
    let path: String
    let isGitRepository: Bool
    let runs: [DesktopCodeRun]
    var id: WorkspaceID { workspaceID }
}

/// The sessions column, as a real macOS source list.
///
/// Three things and no more: the product switch and New task at the top, the
/// sessions grouped by the project they run in, and — only when there are any
/// — the account's cloud runs and the sessions on other computers underneath.
/// The account's own pages left the column for the Settings window, reached
/// from the account row in the footer.
///
/// Everything visual here belongs to the platform: `List(selection:)` in
/// `.sidebar` style draws the selection, the hover state, the section headers and
/// the row metrics. The column paints **no background**.
struct DesktopCodeSidebar: View {
    @Bindable var workbench: WorkbenchModel
    let code: NativeCodeModel
    let remote: CodeRemoteBrowserModel
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    @Binding var product: DesktopProductMode
    @Binding var filter: DesktopCodeSessionFilter
    let isBootstrapping: Bool
    let session: NativeAuthenticatedSession?
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let plan: DesktopUsagePlan?
    let openRepository: () -> Void
    let newSession: (WorkspaceID) -> Void
    let rename: (CodeSession) -> Void
    @Binding var searchText: String
    /// Opens the ⌘K palette; the search field's hint names it.
    let openPalette: () -> Void
    @State private var projectPendingDeletion: DesktopCodeProjectGroup?
    @State private var projectPendingRename: DesktopCodeProjectGroup?
    @State private var projectRenameDraft = ""

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

    private func projectGroups(from allRuns: [DesktopCodeRun]) -> [DesktopCodeProjectGroup] {
        var runsByWorkspace: [WorkspaceID: [DesktopCodeRun]] = [:]
        for run in allRuns {
            guard let workspaceID = run.workspaceID else { continue }
            runsByWorkspace[workspaceID, default: []].append(run)
        }
        // Driven by `workspaces`, not by the sessions, so a repository the reader
        // has granted but not yet worked in still appears — that empty project is
        // how they start.
        return workbench.workspaces.map { record in
            DesktopCodeProjectGroup(
                workspaceID: record.id,
                name: record.descriptor.displayName,
                path: record.descriptor.localPathHint,
                isGitRepository: record.descriptor.isGitRepository,
                runs: DesktopCodeNavigationState.filtered(
                    runsByWorkspace[record.id] ?? [],
                    by: filter
                )
            )
        }
    }

    var body: some View {
        let allRuns = runs
        let groups = projectGroups(from: allRuns)
        let cloudRuns = DesktopCodeNavigationState.filtered(
            allRuns.filter { $0.environment == .cloud || $0.environment == .device },
            by: filter
        )
        let conversations = DesktopCodeNavigationState.filtered(
            allRuns.filter { $0.workspaceID == nil && $0.environment == .local },
            by: filter
        )
        let isSearching = !workbench.sessionSearchText.trimmingCharacters(in: .whitespaces).isEmpty

        return List(selection: $selection) {
            Section {
                Label {
                    HStack {
                        Text("New task").junoRowLabel()
                        Spacer(minLength: JunoSpace.hairline)
                        DesktopKeycap("⌘N")
                    }
                } icon: {
                    JunoIconView(.new, size: 15)
                        .junoSidebarMarkInk(selected: selection == .draft)
                }
                .junoSidebarRowInk()
                .tag(DesktopCodeSidebarItem.draft)
                .accessibilityIdentifier("juno.code.new-conversation")

                Label {
                    Text("Pull requests").junoRowLabel()
                } icon: {
                    JunoIconView(.pulls, size: 15)
                        .junoSidebarMarkInk(selected: selection == .pulls)
                }
                .junoSidebarRowInk()
                .tag(DesktopCodeSidebarItem.pulls)
                .accessibilityIdentifier("juno.code.pulls")
            }

            filterRow

            if groups.isEmpty, cloudRuns.isEmpty, conversations.isEmpty {
                emptyProjects
            }

            ForEach(groups) { group in
                if group.runs.isEmpty {
                    // A project with nothing in it collapses to a single row:
                    // selecting it is how the next task starts in there.
                    projectRow(group)
                        .tag(DesktopCodeSidebarItem.repository(group.workspaceID))
                } else {
                    Section {
                        ForEach(group.runs) { row($0) }
                    } header: {
                        projectHeader(group)
                    }
                }
            }

            if !conversations.isEmpty {
                Section("Conversations") {
                    ForEach(conversations) { row($0) }
                }
            }

            if !cloudRuns.isEmpty {
                Section("Cloud and devices") {
                    ForEach(cloudRuns) { row($0) }
                }
            }

            if !groups.isEmpty || isSearching {
                Button(action: openRepository) {
                    DesktopCodeAddProjectLabel()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: CodeRowMetrics.minHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Open a folder as a project (⌘O)")
                .accessibilityIdentifier("juno.code.add-project")
                .selectionDisabled()
            }

            if !code.devices.isEmpty, !remote.sessions.isEmpty || isSearching {
                otherComputersSection
            }
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        .searchable(
            text: $searchText,
            placement: .sidebar,
            prompt: "Search sessions"
        )
        .junoSidebarProductHeader(product: $product)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            footer
                .background(.thickMaterial)
        }
        .junoSidebarScrollEdge()
        .alert(item: $projectPendingDeletion) { project in
            Alert(
                title: Text("Delete “\(project.name)” from Juno?"),
                message: Text(projectDeletionMessage(project)),
                primaryButton: .destructive(Text("Delete Project")) {
                    deleteProject(project)
                },
                secondaryButton: .cancel()
            )
        }
        .alert("Rename project", isPresented: Binding(
            get: { projectPendingRename != nil },
            set: { if !$0 { projectPendingRename = nil } }
        )) {
            TextField("Name", text: $projectRenameDraft)
            Button("Cancel", role: .cancel) { projectPendingRename = nil }
            Button("Rename") { commitProjectRename() }
                .disabled(projectRenameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    /// All · Running · Needs you · Done, as one compact row that is not a
    /// selectable item.
    private var filterRow: some View {
        HStack(spacing: JunoSpace.snug) {
            DesktopSegmented(
                options: DesktopCodeSessionFilter.allCases.map { .init($0, $0.label) },
                selection: $filter,
                accessibilityLabel: "Session filter",
                optionAccessibilityIdentifier: { "juno.code.filter.\($0.rawValue)" }
            )
            Spacer(minLength: 0)
            Button(action: openPalette) {
                DesktopKeycap("⌘K")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Open the command palette (⌘K)")
            .accessibilityLabel("Command palette")
            .accessibilityIdentifier("juno.code.palette-hint")
        }
        .listRowInsets(
            EdgeInsets(top: 0, leading: JunoSpace.snug, bottom: JunoSpace.tight, trailing: JunoSpace.snug)
        )
        .listRowBackground(Color.clear)
        .selectionDisabled()
        .accessibilityIdentifier("juno.code.sidebar-filter")
    }

    private var emptyProjects: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(
                workbench.sessionSearchText.isEmpty
                    ? "Open a folder to let Juno read and change real files."
                    : "No sessions match."
            )
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)
            if workbench.sessionSearchText.isEmpty {
                Button(action: openRepository) {
                    DesktopCodeAddProjectLabel()
                        .frame(minHeight: CodeRowMetrics.minHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Open a folder as a project (⌘O)")
                .accessibilityIdentifier("juno.code.add-project")
            }
        }
        .padding(.vertical, JunoSpace.hairline)
        .selectionDisabled()
    }

    // MARK: Projects

    private func projectHeader(_ group: DesktopCodeProjectGroup) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Button {
                selection = .repository(group.workspaceID)
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(group.isGitRepository ? .branch : .projects, size: 12)
                    Text(group.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Start a task in \(group.name)")
            .accessibilityLabel("Project \(group.name)")
            .accessibilityHint("Starts a new task in this project")
            Spacer(minLength: JunoSpace.hairline)
            projectMenu(group)
        }
        .contextMenu { projectActions(group) }
    }

    private func projectRow(_ group: DesktopCodeProjectGroup) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(group.isGitRepository ? .branch : .projects, size: 15)
                .junoSidebarMarkInk(selected: selection == .repository(group.workspaceID))
            VStack(alignment: .leading, spacing: 1) {
                Text(group.name)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(filter == .all ? "No sessions yet" : "No \(filter.label.lowercased()) sessions")
                    .junoCaption()
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.hairline)
            projectMenu(group)
        }
        .frame(minHeight: CodeRowMetrics.stackedHeight)
        .junoSidebarRowInk()
        .contextMenu { projectActions(group) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(group.name), no sessions")
    }

    private func projectMenu(_ group: DesktopCodeProjectGroup) -> some View {
        Menu {
            projectActions(group)
        } label: {
            JunoIconView(.ellipsis, size: 13)
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Project actions")
        .accessibilityLabel("Project actions for \(group.name)")
        .accessibilityIdentifier("juno.code.project-menu.\(group.workspaceID.value)")
    }

    @ViewBuilder
    private func projectActions(_ group: DesktopCodeProjectGroup) -> some View {
        Button("New Task Here") {
            newSession(group.workspaceID)
        }
        Button("Show in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([
                URL(fileURLWithPath: group.path)
            ])
        }
        Button("Rename…") {
            projectRenameDraft = group.name
            projectPendingRename = group
        }
        Divider()
        Button("Delete Project…", role: .destructive) {
            projectPendingDeletion = group
        }
    }

    private func commitProjectRename() {
        guard let project = projectPendingRename else { return }
        let name = projectRenameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        projectPendingRename = nil
        Task { await workbench.renameWorkspace(id: project.workspaceID, displayName: name) }
    }

    /// "Delete Project" deletes Juno's Code sessions and the stored folder
    /// grant, but never calls a filesystem delete.
    private func deleteProject(_ project: DesktopCodeProjectGroup) {
        let sessions = sessions(in: project)
        if selectionBelongs(to: project.workspaceID) {
            selection = nil
        }
        if workbench.workspaceNeedingAccess == project.workspaceID {
            workbench.dismissAccessPrompt()
        }
        Task { @MainActor in
            for session in sessions {
                await workbench.deleteSession(id: session.id)
            }
            await workbench.removeWorkspace(id: project.workspaceID)
        }
    }

    private func projectDeletionMessage(_ project: DesktopCodeProjectGroup) -> String {
        let projectSessions = sessions(in: project)
        let count = projectSessions.count
        let sessionDescription =
            count == 1 ? "1 Juno Code session" : "\(count) Juno Code sessions"
        let activeCount = projectSessions.filter(\.status.isActive).count
        let activeDescription =
            activeCount == 0
                ? ""
                : activeCount == 1
                    ? " The running session will be stopped."
                    : " \(activeCount) running sessions will be stopped."
        return """
            This removes the project and deletes \(sessionDescription).\(activeDescription) \
            The folder and its files stay on your Mac.
            """
    }

    private func sessions(in project: DesktopCodeProjectGroup) -> [CodeSession] {
        workbench.visibleSessions.filter { $0.workspaceID == project.workspaceID }
    }

    private func selectionBelongs(to workspaceID: WorkspaceID) -> Bool {
        switch selection {
        case .repository(let id):
            return id == workspaceID
        case .session(let id):
            return workbench.sessions.first { $0.id == id }?.workspaceID == workspaceID
        case .allProjects, .draft, .pulls, .design, .task, .remote, nil:
            return false
        }
    }

    // MARK: Rows

    private func row(_ run: DesktopCodeRun) -> some View {
        DesktopCodeSessionRow(run: run, workbench: workbench)
            .junoSidebarRowInk()
            .tag(run.item)
            .contextMenu { rowMenu(run) }
    }

    @ViewBuilder
    private func rowMenu(_ run: DesktopCodeRun) -> some View {
        switch run.item {
        case .session(let id):
            if let session = workbench.sessions.first(where: { $0.id == id }) {
                Button(session.isFavorite ? "Remove from Favorites" : "Add to Favorites") {
                    Task { await workbench.toggleFavorite(id: id) }
                }
                Button("Rename…") { rename(session) }
                if let workspaceID = session.workspaceID {
                    Button("New Task in This Project") {
                        newSession(workspaceID)
                    }
                }
                Divider()
                Button("Delete", role: .destructive) {
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
            .disabled(!run.status.isActive || remote.isSendingCommand)
        case .allProjects, .draft, .pulls, .design, .repository:
            EmptyView()
        }
    }

    // MARK: Other computers

    private var matchingRemoteSessions: [CodeRemoteSessionSummary] {
        let needle = workbench.sessionSearchText
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        let sessions = remote.sessions.filter { filter.includes(CodeRunStatus($0)) }
        guard !needle.isEmpty else { return sessions }
        return sessions.filter {
            $0.title.lowercased().contains(needle)
                || ($0.workspaceName ?? "").lowercased().contains(needle)
        }
    }

    /// Sessions running on another Mac, watched through the relay. A small
    /// footer group, and only when there is something in it.
    private var otherComputersSection: some View {
        Section {
            let matching = matchingRemoteSessions
            if matching.isEmpty {
                Text("No matching sessions on this computer")
                    .junoCaption()
                    .selectionDisabled()
            }
            ForEach(matching) { summary in
                row(DesktopCodeRunBuilder.run(for: summary))
            }
        } header: {
            HStack(spacing: JunoSpace.tight) {
                Text("Other computers")
                Spacer(minLength: JunoSpace.hairline)
                Picker("Computer", selection: $remoteDeviceID) {
                    ForEach(code.devices) { device in
                        Text(device.online ? device.name : "\(device.name) (offline)")
                            .tag(device.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .controlSize(.small)
                .frame(maxWidth: 132)
                .accessibilityIdentifier("juno.code.remote-computer")
            }
        }
    }

    // MARK: Footer

    /// A transient workspace notice, the door to Design, and the account.
    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 0) {
            workspaceStatus
            DesktopSidebarDesignRow(isActive: selection == .design) {
                selection = .design
            }
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

    @ViewBuilder
    private var workspaceStatus: some View {
        if isBootstrapping {
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Opening your projects…").junoCaption()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
        } else if let error = workbench.lastError {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    JunoIconView(.error, size: 13)
                        .foregroundStyle(Color.junoCaution)
                    Text(error)
                        .junoCaption()
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                if workbench.workspaceNeedingAccess != nil {
                    HStack(spacing: JunoSpace.snug) {
                        Button("Choose Folder Again…", action: regrantAccess)
                            .controlSize(.small)
                            .accessibilityIdentifier("juno.code.regrant")
                        Button("Dismiss") { workbench.dismissAccessPrompt() }
                            .controlSize(.small)
                            .buttonStyle(.plain)
                            .junoSecondaryInk()
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Workspace error: \(error)")
        }
    }

    /// Re-grant the lapsed folder, keeping the project's identity.
    private func regrantAccess() {
        guard let workspaceID = workbench.workspaceNeedingAccess else { return }
        let record = workbench.workspaces.first { $0.id == workspaceID }

        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Grant Access"
        panel.message = record.map {
            "Choose “\($0.descriptor.displayName)” again so Juno can reopen it. If it moved, pick it where it is now."
        } ?? "Choose the project folder again so Juno can reopen it."
        if let hint = record?.descriptor.localPathHint {
            panel.directoryURL = URL(fileURLWithPath: hint).deletingLastPathComponent()
        }

        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await workbench.restoreAccess(to: workspaceID, grantedURL: url) }
    }
}

/// One session in the column: status glyph, title, relative time, branch or
/// worktree chip, and — once it has finished — its diff stat.
private struct DesktopCodeSessionRow: View {
    let run: DesktopCodeRun
    let workbench: WorkbenchModel
    @State private var stat: WorkbenchModel.DiffStat?

    private var sessionID: CodeSessionID? {
        if case .session(let id) = run.item { return id }
        return nil
    }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            CodeStatusGlyph(run.status)

            VStack(alignment: .leading, spacing: 2) {
                Text(run.title)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: JunoSpace.tight) {
                    Text(run.updatedAt.formatted(.relative(presentation: .named)))
                        .junoCaption()
                        .lineLimit(1)
                    if run.environment == .worktree || run.environment == .cloud || run.environment == .device || run.environment == .remote {
                        DesktopSessionChip(run.environment.rawValue, icon: run.environment == .worktree ? .branch : .device)
                    }
                    if let branch = run.branch, !branch.isEmpty {
                        DesktopSessionChip(branch, icon: .branch)
                    }
                }
            }

            Spacer(minLength: JunoSpace.hairline)

            if let stat, !stat.isEmpty, !run.status.isActive {
                HStack(spacing: 2) {
                    Text("+\(stat.added)").foregroundStyle(Color.junoSuccess)
                    Text("−\(stat.removed)").foregroundStyle(Color.junoDanger)
                }
                .junoCodeSmall()
                .monospacedDigit()
                .accessibilityHidden(true)
            }
        }
        .frame(minHeight: CodeRowMetrics.stackedHeight)
        .contentShape(.rect)
        .task(id: "\(run.id)\(run.updatedAt.timeIntervalSince1970)") {
            guard let sessionID, !run.status.isActive else { return }
            stat = await workbench.diffStat(for: sessionID)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var text = "\(run.title), \(run.caption), \(run.status.label)"
        if let stat, !stat.isEmpty {
            text += ", \(stat.added) added, \(stat.removed) removed"
        }
        return text
    }
}

/// A branch or an environment, as a quiet capsule inside a row.
private struct DesktopSessionChip: View {
    let title: String
    let icon: JunoIcon

    init(_ title: String, icon: JunoIcon) {
        self.title = title
        self.icon = icon
    }

    var body: some View {
        HStack(spacing: 2) {
            JunoIconView(icon, size: 9)
            Text(title)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .junoFont(size: 10, relativeTo: .caption2, weight: .medium)
        .junoSecondaryInk()
        .padding(.horizontal, JunoSpace.tight)
        .padding(.vertical, 1)
        .background(Color.junoMuted.opacity(0.7), in: Capsule(style: .continuous))
        .frame(maxWidth: 140)
        .accessibilityHidden(true)
    }
}

/// A keyboard shortcut, as the menu bar would print it.
struct DesktopKeycap: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .junoFont(size: 10, relativeTo: .caption2, weight: .medium, design: .rounded)
            .junoMetaInk()
            .padding(.horizontal, JunoSpace.tight)
            .padding(.vertical, 2)
            .background(Color.junoMuted.opacity(0.7), in: RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous))
            .accessibilityHidden(true)
    }
}

private struct DesktopCodeAddProjectLabel: View {
    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            ZStack(alignment: .bottomTrailing) {
                JunoIconView(.projects, size: 15)
                JunoIconView(.plus, size: 8)
                    .padding(1)
                    .background(Color.junoSidebar)
                    .clipShape(Circle())
            }
            .foregroundStyle(Color.junoSidebarForeground)

            Text("Open folder…")
                .junoRowLabel()
                .junoSecondaryInk()
        }
        .accessibilityElement(children: .combine)
    }
}

/// Projects the transports into the column's one row type.
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

// MARK: - New task

/// The screen a task starts on. One composition, whatever brought the reader
/// here: the sidebar's New task, ⌘N, a project row, the menu bar item, the
/// quick-entry panel.
///
/// Title, a row of project chips, the glass composer, three selectors under it
/// — where it runs, what it may touch, which model — and four starters. The
/// project is shown *once*, in the chip row; the audit found it repeated in
/// four places on the old screen. Cloud and Device stay selectable with no
/// project and say what they need instead of silently falling back to Local.
struct DesktopCodeNewTaskScreen: View {
    let record: WorkspaceRecord?
    let workbench: WorkbenchModel
    let code: NativeCodeModel
    let isStartingLocal: Bool
    let startLocal: (DesktopLocalCodeDraft) -> Void
    let openTask: (NativeCodeTask) -> Void
    let addProject: () -> Void
    let selectProject: (WorkspaceID?) -> Void
    let beginVoice: ((String) -> Void)?
    let voiceDock: AnyView?
    /// Text handed in from the quick-entry panel or the menu bar item, placed
    /// in the composer once.
    var initialPrompt: String?

    @State private var prompt = ""
    @State private var behavior = AgentBehavior.code
    @State private var permissionMode = PermissionMode.askBeforeChanges
    @State private var modelID = ""
    @State private var reasoningEffort: ReasoningEffort? = .medium
    @State private var environment = CodeEnvironmentChoice.local
    @State private var customAgentID: String?
    @State private var customAgents: [CustomAgentDefinition] = []
    @State private var dictating = false
    @State private var pendingAttachments: [CodeAttachment] = []
    @State private var fileReferences: [WorkspacePath] = []
    @State private var isDropTargeted = false
    @State private var importError: String?
    @State private var didSeedDefaults = false
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var defaults: CodeDefaults { CodeDefaults.shared }

    private var selectedModel: ModelOption? {
        workbench.availableModels.first { $0.modelID == modelID }
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasDraftContent: Bool {
        !trimmedPrompt.isEmpty || !pendingAttachments.isEmpty || !fileReferences.isEmpty
    }

    private var blockingReason: String? {
        DesktopCodeDraftReadiness.blockingReason(
            environment: environment,
            hasProject: record != nil,
            projectIsGitRepository: record?.descriptor.isGitRepository ?? false,
            hasCloudRepository: code.selectedRepository != nil,
            hasDevice: code.selectedDevice != nil,
            hasAttachments: !pendingAttachments.isEmpty || !fileReferences.isEmpty
        )
    }

    private var canSend: Bool {
        guard hasDraftContent, !modelID.isEmpty else { return false }
        switch environment {
        case .local:
            return !isStartingLocal
        case .worktree:
            // A plain folder falls back to Local, and says so.
            return !isStartingLocal && record != nil
        case .cloud, .device:
            return blockingReason == nil
                && code.startBlockedReason == nil
                && !code.isMutating
        }
    }

    private var canAttachImages: Bool {
        environment.isLocal
            && selectedModel?.catalog?.capabilities.contains(.vision) != false
            && pendingAttachments.count < 4
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                Text("New task")
                    .junoPageHeading()
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("juno.code.start-header")

                projectRow

                VStack(spacing: JunoSpace.snug) {
                    if let voiceDock {
                        voiceDock
                    }
                    composer
                }

                selectors

                if let issue = importError ?? blockingReason ?? launchIssue {
                    JunoIconLabel(verbatim: issue, icon: .error, size: 14)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.junoInline)
                        .accessibilityIdentifier("juno.code.launch-issue")
                }

                if trimmedPrompt.isEmpty {
                    starterGrid
                        .transition(.junoOverlay)
                }
            }
            .frame(maxWidth: JunoReadingMeasure.reading, alignment: .leading)
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .scrollIndicators(.hidden)
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: trimmedPrompt.isEmpty
        )
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: environment
        )
        .onAppear {
            seedDefaults()
            configureModel()
            configureNativeTarget(environment)
            if let initialPrompt, prompt.isEmpty {
                prompt = initialPrompt
            }
            focused = true
        }
        .onChange(of: initialPrompt) { _, next in
            if let next, prompt.isEmpty { prompt = next }
        }
        .onChange(of: workbench.availableModels.map(\.modelID)) { _, _ in
            configureModel()
        }
        .task(id: record?.id) { await loadCustomAgents() }
    }

    // MARK: Project row

    /// Which project this task is in, as chips: none, each granted project,
    /// and Open folder. The one place the project appears on this screen.
    private var projectRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: JunoSpace.snug) {
                projectChip(title: "No project", icon: .conversation, selected: record == nil) {
                    selectProject(nil)
                }
                ForEach(workbench.workspaces) { workspace in
                    projectChip(
                        title: workspace.descriptor.displayName,
                        icon: workspace.descriptor.isGitRepository ? .branch : .projects,
                        selected: record?.id == workspace.id
                    ) {
                        selectProject(workspace.id)
                    }
                    .help((workspace.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath)
                }
                Button(action: addProject) {
                    HStack(spacing: JunoSpace.hairline) {
                        JunoIconView(.plus, size: 12)
                        Text("Open folder…")
                        DesktopKeycap("⌘O")
                    }
                    .junoCaption()
                    .padding(.horizontal, JunoSpace.cozy)
                    .frame(height: 32)
                    .frame(minHeight: 44)
                    .contentShape(.capsule)
                }
                .buttonStyle(.junoPress)
                .help("Open a folder as a project (⌘O)")
                .accessibilityIdentifier("juno.code.draft-open-folder")
            }
            .padding(.vertical, JunoSpace.hairline)
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Project")
        .accessibilityIdentifier("juno.code.draft-project")
    }

    private func projectChip(
        title: String,
        icon: JunoIcon,
        selected: Bool,
        select: @escaping () -> Void
    ) -> some View {
        Button(action: select) {
            HStack(spacing: JunoSpace.hairline) {
                JunoIconView(icon, size: 12)
                Text(title)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .junoFont(size: 12, relativeTo: .caption, weight: selected ? .semibold : .medium)
            .foregroundStyle(selected ? Color.junoForeground : Color.junoMutedForeground)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 32)
            .background(
                Capsule(style: .continuous)
                    .fill(selected ? Color.junoRaised : Color.junoMuted.opacity(0.5))
                    .shadow(
                        color: selected ? Color.junoCardShadow : .clear,
                        radius: JunoElevation.cardBlur,
                        y: JunoElevation.cardOffsetY
                    )
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(selected ? Color.junoBorder : Color.junoHairline, lineWidth: 0.5)
            )
            .frame(minHeight: 44)
            .contentShape(.capsule)
        }
        .buttonStyle(.junoPress)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityLabel(title)
    }

    // MARK: Composer

    private var composer: some View {
        CodeComposerShell(
            tint: isDropTargeted ? Color.junoAccent : nil,
            maxWidth: JunoReadingMeasure.reading
        ) {
            destinationRow
        } input: {
            composerInput
        } actions: {
            HStack(spacing: JunoSpace.snug) {
                composerAddMenu
                Spacer(minLength: JunoSpace.cozy)
                voiceButton
                sendButton
            }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
            receiveDroppedItems(providers)
            return true
        }
    }

    /// The shell's top row: where the run lands, as a statement rather than a
    /// control — the controls are the selectors below.
    private var destinationRow: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(destinationIcon, size: 14)
                .junoSecondaryInk()
            Text(destinationTitle)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: JunoSpace.tight)
            Text(destinationDetail)
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.head)
            if environment == .cloud {
                CodeContextSeparator()
                cloudControls
            } else if environment == .device {
                CodeContextSeparator()
                deviceControls
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(environment.label), \(destinationTitle), \(destinationDetail)")
    }

    @ViewBuilder
    private var composerInput: some View {
        VStack(spacing: 0) {
            draftAttachmentStrip

            if dictating {
                DesktopDictation(
                    onCancel: {
                        withAnimation(JunoMotion.fast) { dictating = false }
                        focused = true
                    },
                    onStop: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) { dictating = false }
                        focused = true
                    },
                    onSend: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) { dictating = false }
                        Task {
                            await Task.yield()
                            send()
                        }
                    }
                )
                .transition(.opacity)
            } else {
                TextField(
                    record == nil
                        ? "Ask about a codebase, an idea, or a fix…"
                        : "Describe what you want Juno to build, fix, review, or explain…",
                    text: $prompt,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(2...8)
                .font(.body)
                .focused($focused)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .topLeading)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.top, JunoSpace.regular)
                .padding(.bottom, JunoSpace.snug)
                .accessibilityIdentifier("juno.code.launch-prompt")
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    if canSend { send() }
                    return .handled
                }
            }
        }
    }

    // MARK: Selectors

    /// Environment · Permissions · Model + effort · Agent, in one row under
    /// the composer. Each is a decision about *this* task, so each lives here
    /// rather than in a preferences window; Settings holds the defaults they
    /// start from.
    private var selectors: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                environmentSelector
                permissionSelector
                modelSelector
                agentSelector
            }
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                environmentSelector
                HStack(spacing: JunoSpace.regular) {
                    permissionSelector
                    modelSelector
                    agentSelector
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.launch-selectors")
    }

    private var environmentSelector: some View {
        selector("Environment") {
            DesktopSegmented(
                options: CodeEnvironmentChoice.allCases.map { .init($0, $0.label) },
                selection: Binding(
                    get: { environment },
                    set: { next in
                        guard next != environment else { return }
                        environment = next
                        configureNativeTarget(next)
                    }
                ),
                accessibilityLabel: "Environment",
                optionAccessibilityIdentifier: { "juno.code.launch-target.\($0.rawValue)" }
            )
        }
    }

    private var permissionSelector: some View {
        selector("Permissions") {
            Menu {
                ForEach(PermissionMode.allCases, id: \.self) { mode in
                    Button {
                        select(permission: mode)
                    } label: {
                        HStack {
                            JunoIconLabel(verbatim: PermissionModeLabel.text(for: mode), icon: PermissionModeLabel.junoIcon(for: mode), size: 14)
                            Spacer(minLength: JunoSpace.regular)
                            if permissionMode == mode {
                                JunoIconView(.check, size: 14).accessibilityHidden(true)
                            }
                        }
                    }
                }
                Divider()
                ForEach(AgentBehavior.allCases, id: \.self) { value in
                    Button {
                        select(behavior: value)
                    } label: {
                        HStack {
                            JunoIconLabel(verbatim: AgentBehaviorLabel.text(for: value), icon: AgentBehaviorLabel.junoIcon(for: value), size: 14)
                            Spacer(minLength: JunoSpace.regular)
                            if behavior == value {
                                JunoIconView(.check, size: 14).accessibilityHidden(true)
                            }
                        }
                    }
                }
                Text(PermissionModeLabel.explanation(for: effectivePermissionMode))
            } label: {
                CodeContextChipLabel(
                    permissionTitle,
                    icon: PermissionModeLabel.junoIcon(for: effectivePermissionMode),
                    tint: effectivePermissionMode == .fullAccess ? Color.junoCaution : nil
                )
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("What Juno may touch, and whether it answers, plans or edits")
            .accessibilityLabel("Permissions")
            .accessibilityValue(permissionTitle)
            .accessibilityIdentifier("juno.code.launch-contract")
        }
    }

    private var effectivePermissionMode: PermissionMode {
        guard behavior == .code, record != nil else { return .readOnly }
        return permissionMode
    }

    private var permissionTitle: String {
        guard behavior == .code else { return "\(AgentBehaviorLabel.text(for: behavior)) · read only" }
        guard record != nil else { return "Read only" }
        return PermissionModeLabel.text(for: permissionMode)
    }

    private var modelSelector: some View {
        selector("Model") {
            HStack(spacing: JunoSpace.snug) {
                JunoModelSelectorButton(
                    models: workbench.availableModels.map(\.descriptor),
                    selectedModelID: modelBinding,
                    placeholder: "Choose model",
                    accessibilityID: "juno.code.launch-model"
                )
                if let selectedModel {
                    JunoThinkingButton(
                        ladder: selectedModel.thinkingLadder,
                        stopID: reasoningBinding,
                        accessibilityID: "juno.code.launch-reasoning"
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var agentSelector: some View {
        if !customAgents.isEmpty {
            selector("Agent") {
                Menu {
                    ForEach(AgentRoleOption.options(custom: customAgents)) { option in
                        Button {
                            if case .custom(let agent) = option {
                                customAgentID = agent.id
                            } else {
                                customAgentID = nil
                            }
                        } label: {
                            HStack {
                                Text(option.label)
                                Spacer(minLength: JunoSpace.regular)
                                if isSelected(option) {
                                    JunoIconView(.check, size: 14).accessibilityHidden(true)
                                }
                            }
                        }
                    }
                } label: {
                    CodeContextChipLabel(selectedAgentLabel, icon: .user)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Which of the project's agents shapes this task")
                .accessibilityLabel("Agent")
                .accessibilityValue(selectedAgentLabel)
                .accessibilityIdentifier("juno.code.launch-agent")
            }
        }
    }

    private func isSelected(_ option: AgentRoleOption) -> Bool {
        switch option {
        case .builtIn(let role): customAgentID == nil && role == .engineer
        case .custom(let agent): customAgentID == agent.id
        }
    }

    private var selectedAgentLabel: String {
        customAgents.first { $0.id == customAgentID }?.displayName ?? "Engineer"
    }

    private func selector<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(title)
                .junoSidebarSection()
            content()
        }
    }

    private var modelBinding: Binding<String> {
        Binding(
            get: { modelID },
            set: { next in
                modelID = next
                guard let option = workbench.availableModels.first(where: { $0.modelID == next })
                else { return }
                if let refitted = option.refittingEffort(reasoningEffort) {
                    reasoningEffort = refitted
                }
            }
        )
    }

    private var reasoningBinding: Binding<String?> {
        Binding(
            get: { reasoningEffort?.rawValue ?? JunoThinkingLadder.instantStopID },
            set: { value in
                guard let value else { return }
                if value == JunoThinkingLadder.instantStopID {
                    reasoningEffort = nil
                    return
                }
                guard let effort = ReasoningEffort(rawValue: value) else { return }
                reasoningEffort = effort
            }
        )
    }

    /// A menu selection can arrive while AppKit is still closing the menu
    /// window; writing synchronously relays out the anchor during the
    /// dismissal and can crash in `NSPopover`/ViewBridge. Yield one turn.
    private func select(behavior value: AgentBehavior) {
        Task { @MainActor in
            await Task.yield()
            behavior = value
        }
    }

    private func select(permission value: PermissionMode) {
        Task { @MainActor in
            await Task.yield()
            permissionMode = value
        }
    }

    // MARK: Starters

    private struct StarterTask: Identifiable {
        let id: String
        let title: String
        let detail: String
        let prompt: String
        let behavior: AgentBehavior
        let icon: JunoIcon
    }

    private var starterTasks: [StarterTask] {
        if record == nil {
            return [
                StarterTask(id: "ask", title: "Ask a question", detail: "Get an answer before you open a project", prompt: "Help me think through this coding question and show a small, concrete example.", behavior: .ask, icon: .conversation),
                StarterTask(id: "plan", title: "Plan a change", detail: "Turn an outcome into an implementation plan", prompt: "Create a focused implementation plan for the change I describe. Call out assumptions, files likely involved, and how to verify it.", behavior: .plan, icon: .sliders),
                StarterTask(id: "explain", title: "Explain a concept", detail: "Work through architecture, APIs, or a bug", prompt: "Explain this coding problem clearly, including the trade-offs and the next step I should take.", behavior: .ask, icon: .knowledge),
                StarterTask(id: "choose-project", title: "Start with a project", detail: "Open a folder to let Juno inspect and edit files", prompt: "Help me understand where to start in this project.", behavior: .survey, icon: .projects),
            ]
        }
        return [
            StarterTask(id: "plan-change", title: "Plan a change", detail: "Inspect first, then outline the work", prompt: "Create a focused implementation plan for the change I describe. Inspect the relevant code first, call out assumptions, and include verification steps.", behavior: .plan, icon: .sliders),
            StarterTask(id: "explain-project", title: "Understand this project", detail: "Map entry points, modules, and risks", prompt: "Explain the architecture of this project: map its entry points, main modules, runtime boundaries, recent changes, and highest-risk unknowns. Use read-only inspection and cite the evidence.", behavior: .survey, icon: .knowledge),
            StarterTask(id: "review-changes", title: "Review current changes", detail: "Find regressions before you commit", prompt: "Review the current working tree for correctness, regressions, and missing tests. Summarize the highest-value fixes.", behavior: .ask, icon: .check),
            StarterTask(id: "run-tests", title: "Run the tests", detail: "Report failures and fix the cause", prompt: "Run the relevant test suite, report failures clearly, and fix failures that are caused by this project.", behavior: .code, icon: .check),
        ]
    }

    /// Four raised tiles. They fill the composer rather than launching — a
    /// one-click launch of a prompt the reader has not read is how a session
    /// starts in the wrong direction.
    private var starterGrid: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(minimum: 140), spacing: JunoSpace.cozy),
                GridItem(.flexible(minimum: 140), spacing: JunoSpace.cozy),
            ],
            spacing: JunoSpace.cozy
        ) {
            ForEach(starterTasks) { task in
                Button {
                    apply(task)
                } label: {
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(task.icon, size: 15)
                            .junoSecondaryInk()
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title)
                                .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                                .junoInk()
                            Text(task.detail)
                                .junoFont(size: 11, relativeTo: .caption2)
                                .junoMetaInk()
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(minHeight: 52)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .junoCard(cornerRadius: JunoRadius.well)
                    .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
                }
                .buttonStyle(.junoPress)
                .accessibilityHint("Puts this prompt in the composer")
                .accessibilityIdentifier("juno.code.launch-intent.\(task.id)")
            }
        }
        .accessibilityIdentifier("juno.code.starter-tasks")
    }

    private func apply(_ task: StarterTask) {
        prompt = task.prompt
        behavior = task.behavior
        focused = true
    }

    // MARK: Cloud and device controls

    @ViewBuilder
    private var cloudControls: some View {
        switch code.repositories {
        case .idle, .loading:
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Loading repositories…").junoCaption()
            }
        case .ready(let repositories):
            if repositories.isEmpty {
                Text("No GitHub repositories").junoCaption()
            } else {
                Picker("Repository", selection: cloudRepositoryBinding(repositories)) {
                    ForEach(repositories) { repository in
                        Text(repository.fullName).tag(repository.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .controlSize(.small)
                .frame(maxWidth: 210)
                .accessibilityIdentifier("juno.code.launch-cloud-repository")
            }
        case .unavailable:
            Button("Retry GitHub") {
                code.loadRepositoriesIfNeeded(force: true)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private var deviceControls: some View {
        if code.devices.isEmpty {
            Text("No connected devices").junoCaption()
        } else {
            Picker("Device", selection: deviceBinding) {
                ForEach(code.devices) { device in
                    Text(device.online ? device.name : "\(device.name) (offline)")
                        .tag(Optional(device.id))
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .frame(maxWidth: 150)
            .accessibilityIdentifier("juno.code.launch-device")

            if let device = code.selectedDevice, !device.workspaces.isEmpty {
                Picker("Workspace", selection: workspaceBinding(device)) {
                    ForEach(device.workspaces) { workspace in
                        Text(workspace.name).tag(Optional(workspace.id))
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .controlSize(.small)
                .frame(maxWidth: 170)
                .accessibilityIdentifier("juno.code.launch-device-workspace")
            }
        }
    }

    private var destinationIcon: JunoIcon {
        switch environment {
        case .local: record == nil ? .conversation : .projects
        case .worktree: .branch
        case .cloud: .cloud
        case .device: .device
        }
    }

    private var destinationTitle: String {
        switch environment {
        case .local, .worktree:
            record?.descriptor.displayName ?? "No project"
        case .cloud:
            code.selectedRepository?.fullName ?? "Choose a GitHub repository"
        case .device:
            code.selectedWorkspace?.name
                ?? code.selectedDevice?.name
                ?? "Choose a connected device"
        }
    }

    private var destinationDetail: String {
        switch environment {
        case .local:
            record.map { ($0.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath }
                ?? "Answers only — no files, no commands"
        case .worktree:
            record.map { _ in "A fresh worktree beside the checkout" } ?? "Choose a project"
        case .cloud:
            code.selectedRepository.map { "\($0.defaultBranch) · opens a pull request" }
                ?? "GitHub Actions"
        case .device:
            code.selectedWorkspace?.path
                ?? code.selectedDevice.map { $0.online ? "Online" : "Offline" }
                ?? "Juno Code host"
        }
    }

    private var launchIssue: String? {
        switch environment {
        case .local, .worktree:
            if workbench.availableModels.isEmpty {
                return "Your Code model catalog is still loading."
            }
            return nil
        case .cloud, .device:
            return code.lastErrorDescription ?? code.startBlockedReason
        }
    }

    private var deviceBinding: Binding<String?> {
        Binding(
            get: { code.selectedDeviceID },
            set: { value in
                code.selectedDeviceID = value
                code.selectedWorkspaceKey = code.selectedDevice?.workspaces.first?.id
            }
        )
    }

    private func workspaceBinding(_ device: NativeCodeDevice) -> Binding<String?> {
        Binding(
            get: { code.selectedWorkspaceKey ?? device.workspaces.first?.id },
            set: { code.selectedWorkspaceKey = $0 }
        )
    }

    private func cloudRepositoryBinding(
        _ repositories: [NativeCodeRepository]
    ) -> Binding<String> {
        Binding(
            get: { code.selectedRepository?.id ?? repositories.first?.id ?? "" },
            set: { id in
                code.selectedRepository = repositories.first { $0.id == id }
            }
        )
    }

    // MARK: Add menu, attachments, files

    private var composerAddMenu: some View {
        Menu {
            Button(action: chooseFileReference) {
                JunoIconLabel(verbatim: "Add file context", icon: .file, size: 14)
            }
            .disabled(record == nil || !environment.isLocal)

            Button {
                importError = nil
                chooseImages()
            } label: {
                JunoIconLabel(verbatim: "Add picture", icon: .photos, size: 14)
            }
            .disabled(!canAttachImages)

            Divider()

            Button(action: addProject) {
                JunoIconLabel(verbatim: "Open folder…", icon: .projects, size: 14)
            }
        } label: {
            JunoIconView(.plus, size: 13)
                .junoInk()
                .frame(width: 32, height: 32)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.circle)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add files, pictures, or a project")
        .accessibilityLabel("Add")
        .accessibilityIdentifier("juno.code.composer.add")
    }

    @ViewBuilder
    private var draftAttachmentStrip: some View {
        if !pendingAttachments.isEmpty || !fileReferences.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: JunoSpace.snug) {
                    ForEach(fileReferences, id: \.value) { path in
                        fileReferenceChip(path)
                    }

                    ForEach(pendingAttachments) { attachment in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if let image = NSImage(data: attachment.image.data) {
                                    Image(nsImage: image)
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                } else {
                                    JunoIconView(.photos, size: 18)
                                        .junoSecondaryInk()
                                }
                            }
                            .frame(width: 44, height: 44)
                            .clipShape(
                                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                            )

                            Button {
                                pendingAttachments.removeAll { $0.id == attachment.id }
                            } label: {
                                JunoIconView(.close, size: 14)
                                    .foregroundStyle(Color.junoMutedForeground)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(.circle)
                            }
                            .buttonStyle(.plain)
                            .offset(x: 12, y: -12)
                            .accessibilityLabel("Remove \(attachment.name)")
                        }
                        .help("\(attachment.name) · \(attachment.sizeDescription)")
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.top, JunoSpace.snug)
            }
            .scrollIndicators(.hidden)
            .frame(height: 60)
        }
    }

    private func fileReferenceChip(_ path: WorkspacePath) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.file, size: 15)
                .junoSecondaryInk()

            VStack(alignment: .leading, spacing: 1) {
                Text(path.lastComponent)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(path.value)
                    .font(.caption2.monospaced())
                    .junoSecondaryInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: 150, alignment: .leading)

            Button {
                removeFileReference(path)
            } label: {
                JunoIconView(.close, size: 14)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(path.lastComponent)")
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 44)
        .background(
            Color.junoMuted,
            in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
        )
        .help("Attached file \(path.value)")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached file \(path.value)")
    }

    @ViewBuilder
    private var voiceButton: some View {
        if JunoSpeechService.isSupported {
            Button(action: startDictation) {
                JunoIconView(.mic, size: 15)
                    .junoSecondaryInk()
                    .frame(width: 32, height: 32)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .help("Dictate into the composer")
            .accessibilityLabel("Dictate")
            .accessibilityIdentifier("juno.code.composer.dictate")
        }
    }

    private func startDictation() {
        focused = false
        withAnimation(JunoMotion.fast) { dictating = true }
    }

    /// The composer's primary action: Voice on an empty prompt, Send otherwise.
    private var sendButton: some View {
        Group {
            if isStartingLocal || code.isMutating {
                Button(action: {}) {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 32, height: 32)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: true)
                .disabled(true)
            } else if trimmedPrompt.isEmpty {
                Button {
                    if let beginVoice, !modelID.isEmpty {
                        beginVoice(modelID)
                    }
                } label: {
                    DesktopCodeVoiceGlyph()
                        .frame(width: 32, height: 32)
                        .frame(minWidth: 44, minHeight: 44)
                        .foregroundStyle(Color.junoOnAccent)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: beginVoice != nil && !modelID.isEmpty)
                .disabled(beginVoice == nil || modelID.isEmpty)
                .help("Start a voice conversation")
                .accessibilityLabel("Start voice conversation")
                .accessibilityIdentifier("juno.code.launch-voice")
            } else {
                Button(action: send) {
                    JunoIconView(.send, size: 15)
                        .foregroundStyle(canSend ? Color.junoOnAccent : Color.junoMutedForeground)
                        .frame(width: 32, height: 32)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: canSend)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .help("Start this task (⌘↩)")
                .accessibilityLabel("Start task")
                .accessibilityIdentifier("juno.code.launch-send")
            }
        }
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let existing = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = existing.isEmpty ? dictated : "\(existing) \(dictated)"
    }

    private func chooseFileReference() {
        guard let record, environment.isLocal else { return }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add File"
        panel.directoryURL = URL(fileURLWithPath: record.descriptor.localPathHint)

        guard panel.runModal() == .OK else { return }

        let root = URL(fileURLWithPath: record.descriptor.localPathHint)
            .standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        let added = panel.urls.compactMap { url -> WorkspacePath? in
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(rootPath),
                let relative = try? WorkspacePath(String(path.dropFirst(rootPath.count)))
            else { return nil }
            return relative
        }
        addFileReferences(added)
    }

    private func chooseImages() {
        guard canAttachImages else { return }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = CodeAttachment.acceptedTypes
        panel.prompt = "Add Pictures"
        panel.message = "Choose pictures to attach to this task."

        guard panel.runModal() == .OK else { return }
        importImages(.success(panel.urls))
    }

    private func importImages(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            let nsError = error as NSError
            guard nsError.code != NSUserCancelledError else { return }
            importError = error.localizedDescription
        case .success(let urls):
            importError = nil
            let remaining = max(0, 4 - pendingAttachments.count)
            if urls.count > remaining {
                importError = "You can attach up to 4 pictures to one task."
            }

            for url in urls.prefix(remaining) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer {
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
                guard let attachment = CodeAttachment.load(contentsOf: url) else {
                    importError = "Could not read \(url.lastPathComponent) as a picture."
                    continue
                }
                appendAttachment(attachment)
            }
        }
    }

    private func addFileReferences(_ references: [WorkspacePath]) {
        let added = references.filter { !fileReferences.contains($0) }
        guard !added.isEmpty else { return }
        fileReferences.append(contentsOf: added)

        let existing = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let tokens = added.map { "@\($0.value)" }.joined(separator: " ")
        prompt = [existing, tokens]
            .filter { !$0.isEmpty }
            .joined(separator: " ") + " "
        importError = nil
        focused = true
    }

    private func removeFileReference(_ path: WorkspacePath) {
        fileReferences.removeAll { $0 == path }
        let token = "@\(path.value)"
        prompt = prompt
            .replacingOccurrences(of: token, with: "")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        if !prompt.isEmpty { prompt += " " }
        focused = true
    }

    private func appendAttachment(_ attachment: CodeAttachment) {
        guard pendingAttachments.count < 4 else {
            importError = "You can attach up to 4 pictures to one task."
            return
        }
        pendingAttachments.append(attachment)
        importError = nil
        focused = true
    }

    private func receiveDroppedItems(_ providers: [NSItemProvider]) {
        importError = nil
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in
                        importDroppedURL(url)
                    }
                }
                continue
            }

            guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
            else { continue }
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) {
                data, _ in
                guard let data,
                    let attachment = CodeAttachment.pasted(
                        data: data,
                        declaredMediaType: nil
                    )
                else { return }
                Task { @MainActor in
                    appendAttachment(attachment)
                }
            }
        }
    }

    @MainActor
    private func importDroppedURL(_ url: URL) {
        guard environment.isLocal else {
            importError = "Files and pictures can be added on this Mac only."
            return
        }

        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }

        let contentType = (try? url.resourceValues(forKeys: [.contentTypeKey])).flatMap {
            $0.contentType
        } ?? UTType(filenameExtension: url.pathExtension)

        if contentType?.conforms(to: .image) == true {
            guard let attachment = CodeAttachment.load(contentsOf: url) else {
                importError = "Could not read \(url.lastPathComponent) as a picture."
                return
            }
            appendAttachment(attachment)
            return
        }

        guard let record else {
            importError = "Open a project before dropping a file."
            return
        }

        let root = URL(fileURLWithPath: record.descriptor.localPathHint)
            .standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(rootPath),
            let relative = try? WorkspacePath(String(path.dropFirst(rootPath.count)))
        else {
            importError = "Files must be inside the selected project."
            return
        }
        addFileReferences([relative])
    }

    // MARK: Lifecycle

    /// Reads the standing defaults once, on first appearance. Later visits keep
    /// whatever the reader changed on this screen.
    private func seedDefaults() {
        guard !didSeedDefaults else { return }
        didSeedDefaults = true
        permissionMode = defaults.permissionMode
        reasoningEffort = defaults.reasoningEffort
        environment = defaults.environment
        if !defaults.modelID.isEmpty {
            modelID = defaults.modelID
        }
    }

    private func configureModel() {
        guard modelID.isEmpty
                || !workbench.availableModels.contains(where: { $0.modelID == modelID })
        else { return }
        modelID = workbench.availableModels.first?.modelID ?? ""
        if let selectedModel, let refitted = selectedModel.refittingEffort(reasoningEffort) {
            reasoningEffort = refitted
        }
    }

    private func configureNativeTarget(_ choice: CodeEnvironmentChoice) {
        switch choice {
        case .local, .worktree:
            return
        case .cloud:
            code.target = .cloud
            code.loadRepositoriesIfNeeded()
        case .device:
            code.target = .device
            if code.selectedDeviceID == nil {
                code.selectedDeviceID =
                    code.devices.first(where: \.online)?.id ?? code.devices.first?.id
            }
            if code.selectedWorkspaceKey == nil {
                code.selectedWorkspaceKey = code.selectedDevice?.workspaces.first?.id
            }
        }
    }

    private func loadCustomAgents() async {
        guard let record, let context = await workbench.context(for: record.id) else {
            customAgents = []
            customAgentID = nil
            return
        }
        customAgents = CustomAgentDiscovery(access: context.access).discover()
        if let customAgentID, !customAgents.contains(where: { $0.id == customAgentID }) {
            self.customAgentID = nil
        }
    }

    private func send() {
        guard canSend else { return }
        switch environment {
        case .local, .worktree:
            startLocal(
                DesktopLocalCodeDraft(
                    workspaceID: record?.id,
                    prompt: trimmedPrompt,
                    behavior: behavior,
                    permissionMode: permissionMode,
                    modelID: modelID,
                    reasoningEffort: reasoningEffort,
                    environment: record?.descriptor.isGitRepository == true ? environment : .local,
                    customAgentID: customAgentID,
                    attachments: pendingAttachments,
                    fileReferences: fileReferences
                )
            )
        case .cloud, .device:
            code.target = environment == .cloud ? .cloud : .device
            let submitted = trimmedPrompt
            Task {
                guard let task = await code.startTask(prompt: submitted) else { return }
                prompt = ""
                openTask(task)
            }
        }
    }
}

// MARK: - All projects

/// Every folder the reader has granted Juno Code, as one page.
struct DesktopCodeAllProjects: View {
    @Bindable var workbench: WorkbenchModel
    let isLoading: Bool
    let open: (WorkspaceID) -> Void
    let newSession: (WorkspaceID) -> Void
    let addProject: () -> Void
    let revealInFinder: (String) -> Void

    private struct Row: Identifiable {
        let record: WorkspaceRecord
        let sessions: Int
        let active: Int
        let lastUsed: Date?
        var id: WorkspaceID { record.id }
    }

    private var rows: [Row] {
        workbench.workspaces.map { record in
            let sessions = workbench.visibleSessions.filter { $0.workspaceID == record.id }
            return Row(
                record: record,
                sessions: sessions.count,
                active: sessions.filter(\.status.isActive).count,
                lastUsed: sessions.map(\.updatedAt).max()
            )
        }
    }

    var body: some View {
        Group {
            if isLoading, workbench.workspaces.isEmpty {
                JunoDetailPage(maxWidth: JunoReadingMeasure.wide) {
                    CodeLoadingList(count: 4, label: "Opening your projects")
                }
            } else if let error = workbench.lastError, workbench.workspaces.isEmpty {
                CodeErrorState(
                    title: "Juno could not open your projects",
                    reason: error,
                    retryTitle: workbench.workspaceNeedingAccess == nil
                        ? "Open Folder…" : "Choose Folder Again…",
                    retry: addProject
                )
            } else if workbench.workspaces.isEmpty {
                JunoEmptyState(
                    title: "No projects yet",
                    message: """
                        A project is a folder Juno Code may read and write in. \
                        Open one to start a task.
                        """,
                    symbol: "folder.badge.plus",
                    actionLabel: "Open Folder…",
                    action: addProject
                )
            } else {
                JunoDetailPage(maxWidth: JunoReadingMeasure.wide) {
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        ForEach(rows) { row in
                            card(row)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func card(_ row: Row) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoIconView(.projects, size: 20)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
                    Text(row.record.descriptor.displayName)
                        .junoTitle()
                    if row.active > 0 {
                        HStack(spacing: JunoSpace.hairline) {
                            DesktopCodeRunningDot()
                            Text(row.active == 1 ? "1 running" : "\(row.active) running")
                                .junoCaption()
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Text(
                    (row.record.descriptor.localPathHint as NSString)
                        .abbreviatingWithTildeInPath
                )
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

                Text(summary(row))
                    .junoCaption()
            }

            Spacer(minLength: JunoSpace.cozy)

            VStack(alignment: .trailing, spacing: JunoSpace.snug) {
                Button("New Task") { newSession(row.record.id) }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .controlSize(.small)
                Button("Show in Finder") { revealInFinder(row.record.descriptor.localPathHint) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(JunoSpace.regular)
        .junoCard(cornerRadius: JunoRadius.card)
        .contextMenu {
            Button("Show in Finder") {
                revealInFinder(row.record.descriptor.localPathHint)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.record.descriptor.displayName), \(summary(row))")
    }

    private func summary(_ row: Row) -> String {
        var parts: [String] = []
        parts.append(row.sessions == 1 ? "1 session" : "\(row.sessions) sessions")
        parts.append(row.record.descriptor.isGitRepository ? "Git repository" : "Folder")
        if let lastUsed = row.lastUsed {
            parts.append(
                "last used \(lastUsed.formatted(.relative(presentation: .named)))"
            )
        }
        return parts.joined(separator: " · ")
    }
}

private struct DesktopCodeVoiceGlyph: View {
    private let heights: [CGFloat] = [7, 13, 18, 11, 6]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(.foreground)
                    .frame(width: 2, height: height)
            }
        }
        .accessibilityHidden(true)
    }
}
