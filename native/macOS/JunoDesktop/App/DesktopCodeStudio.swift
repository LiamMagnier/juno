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

/// The Code window's navigation column, its selection rules, its status
/// vocabulary, and the two states the detail column shows before a session
/// exists.
///
/// The window shell is ``DesktopCodeWorkspace``. This file previously held a
/// second, competing information architecture: a fixed-width hand-rolled rail
/// with its own destination list, a launchpad, a runs library that listed every
/// run a second time, and a "continue" page for remote work. Because the rail's
/// destination and the selected session were independent state, opening a run
/// could leave the reader on the list instead of the run. There is now one
/// selection value, and it lives here.
///
/// The file name is historical; its contents are the navigation column.

// MARK: - Selection

/// One `Hashable` value for the whole navigation column.
///
/// `List(selection:)` needs a single `Hashable` to drive native selection, and
/// that is what buys arrow-key navigation, type-select, the focus ring and the
/// focused/unfocused accent states. A stack of `Button`s with a hand-drawn pill
/// has none of them, because nothing about it is a selection as far as the
/// platform is concerned.
///
/// A repository is a selectable destination rather than a decoration: selecting
/// one means "the next session is in here", which is the state the detail column
/// renders as a draft.
enum DesktopCodeSidebarItem: Hashable {
    /// The index of every granted project, rather than one of them.
    ///
    /// Selecting a project row means "the next session is in *here*", which is a
    /// useful thing to mean but not the only one — there was no way to ask "what
    /// have I given Juno access to?" without reading it off the sidebar, and
    /// clicking anything under Projects committed you to a specific repository.
    case allProjects
    /// A conversation that has not chosen a project — the composer, with no
    /// repository behind it.
    ///
    /// This is what the Code window opens on for a reader who has granted
    /// nothing yet, and what "New conversation" selects. It is a destination
    /// rather than a modal because the reader must be able to leave it, look at
    /// a project, and come back to what they were typing.
    case draft
    /// The pull requests Juno Code opened, across every project.
    ///
    /// It lives here rather than in Chat's sidebar because a PR is the output of
    /// a coding session, and the website has always filed it under Code. A
    /// reader checking on one is in the same product they started it in.
    case pulls
    /// The account's connected services.
    ///
    /// The website keeps this in Code's own navigation — `app-sidebar.tsx` lists
    /// Plugins beside Pull requests whenever the shell is in code mode — and it
    /// is not filler: GitHub is granted here and nowhere else, and both Cloud
    /// runs and the pull request list above are inert without it. This window
    /// used to drop the "Open Connections" button out of its own "GitHub isn't
    /// connected" empty state because it had no route to that page.
    case connections
    /// The account's own two pages, rendered by this window rather than reached
    /// through it.
    ///
    /// ``JunoDesktopWorkspaceView`` instantiates one product at a time precisely
    /// so two `NavigationSplitView`s never negotiate against the same window, so
    /// there is no such thing as "navigate to Chat's Usage page". Code owns the
    /// same two screens in its own detail column instead — the screens, not
    /// copies of them.
    case usage
    case settings
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
    case cloud = "Cloud"
    case device = "Device"
    case remote = "Remote"
}

/// One row in the navigation column, from any of the four transports.
///
/// Flattening local sessions, cloud runs, device runs and relay-watched sessions
/// into one row type is what lets them share a single recency-grouped list
/// instead of each transport getting its own section — which is how the same run
/// ended up listed twice in the build this replaces.
struct DesktopCodeRun: Identifiable {
    let item: DesktopCodeSidebarItem
    let title: String
    let workspace: String
    let branch: String?
    let environment: CodeRunEnvironment
    let status: CodeRunStatus
    let updatedAt: Date

    var id: DesktopCodeSidebarItem { item }

    /// "workspace · branch · where it runs", with absent facts dropped rather
    /// than rendered as empty separators.
    var caption: String {
        var parts: [String] = []
        if !workspace.isEmpty { parts.append(workspace) }
        if let branch, !branch.isEmpty { parts.append(branch) }
        parts.append(environment.rawValue)
        return parts.joined(separator: " · ")
    }

    /// The caption for a row already nested under its project.
    ///
    /// Printing the project's name on every child is what made the outline hard
    /// to scan — the parent row two pixels above already says it, so the column
    /// read as the same string repeated down the page. `Local` goes for the same
    /// reason: a session nested under a local project has nowhere else to run.
    /// What is left is the branch and how long ago the run last moved, which are
    /// the two facts that actually distinguish one session in a repository from
    /// another. The full caption is still what VoiceOver reads.
    var nestedCaption: String {
        var parts: [String] = []
        if let branch, !branch.isEmpty { parts.append(branch) }
        if environment != .local { parts.append(environment.rawValue) }
        parts.append(updatedAt.formatted(.relative(presentation: .named)))
        return parts.joined(separator: " · ")
    }
}

/// The pure navigation rules behind the Code window's column.
///
/// These are functions over values rather than logic inside a `Binding` in a view
/// body, so the interesting cases — a stored selection whose session was deleted,
/// a repository that is no longer granted, merging four transports into one
/// recency list — are reachable from a test.
enum DesktopCodeNavigationState {
    private static let unitSeparator = "\u{1f}"

    static func encode(_ item: DesktopCodeSidebarItem?) -> String {
        switch item {
        case .none: ""
        case .allProjects: "allProjects"
        case .draft: "draft"
        case .pulls: "pulls"
        case .connections: "connections"
        case .usage: "usage"
        case .settings: "settings"
        case .repository(let id): "repository\(unitSeparator)\(id.value)"
        case .session(let id): "session\(unitSeparator)\(id.value)"
        case .task(let id): "task\(unitSeparator)\(id)"
        case .remote(let deviceID, let sessionID):
            "remote\(unitSeparator)\(deviceID)\(unitSeparator)\(sessionID)"
        }
    }

    static func decode(_ raw: String) -> DesktopCodeSidebarItem? {
        let fields = raw.components(separatedBy: unitSeparator)
        switch (fields.first, fields.count) {
        case ("allProjects", 1): return .allProjects
        case ("draft", 1): return .draft
        case ("pulls", 1): return .pulls
        case ("connections", 1): return .connections
        case ("usage", 1): return .usage
        case ("settings", 1): return .settings
        case ("repository", 2): return .repository(WorkspaceID(value: fields[1]))
        case ("session", 2): return .session(CodeSessionID(value: fields[1]))
        case ("task", 2): return .task(fields[1])
        case ("remote", 3): return .remote(deviceID: fields[1], sessionID: fields[2])
        default: return nil
        }
    }

    /// Drops a restored selection that no longer names anything.
    ///
    /// Scene storage outlives the sessions it points at. A window that reopened
    /// onto a deleted session showed an empty detail with a title, which reads as
    /// a failure rather than as "that run is gone".
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
        // A relay session is not in any local list; it is validated by the relay
        // answering, which the detail surface reports honestly on its own.
        // Always valid: it names the collection, not a member of it.
        case .allProjects: return item
        // Always valid: a draft names nothing that can go missing, and the pull
        // request list, the connected services, the usage ledger and the settings
        // page are account-level pages rather than local records.
        case .draft, .pulls, .connections, .usage, .settings: return item
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

    /// Recency buckets over every transport at once.
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

// MARK: - Status vocabulary

/// One status vocabulary shared by the column, the toolbar and the detail
/// surfaces, so a run does not read as "Running" in one place and "Active" in
/// another.
struct CodeRunStatus {
    let label: String
    let symbol: String
    /// The website's own mark, where the concept has one.
    ///
    /// Most of this vocabulary is native-only: the web draws run status as a
    /// small tinted dot and has no glyph for queued, running or completed, so
    /// an SF Symbol there is an elaboration rather than a divergence. Two of
    /// these states *are* named on the web, though — a permission request is a
    /// shield and a failure is a circle — and those two must not be a raised
    /// hand and a cross here.
    let junoIcon: JunoIcon?
    /// Colour is spent only where the state asks something of the reader.
    ///
    /// The website's sidebar draws a run's state as one small dot and reserves
    /// hue for the three states worth interrupting for — `bg-warning` for an
    /// approval, `bg-destructive` for a failure, `bg-success` for a finish — and
    /// leaves everything else on `bg-muted-foreground/50`. Running used to be the
    /// account accent here, which put a coral spinner on every live row in the
    /// Code column and made the busiest sidebar the loudest one. Nothing about a
    /// run in flight needs to be *found*: it is already the only thing on screen
    /// that moves, so the motion is the signal and the indicator itself stays the
    /// column's own ink.
    let tint: Color
    let isActive: Bool
    let needsApproval: Bool

    private init(
        label: String,
        symbol: String,
        junoIcon: JunoIcon? = nil,
        tint: Color,
        isActive: Bool,
        needsApproval: Bool = false
    ) {
        self.label = label
        self.symbol = symbol
        self.junoIcon = junoIcon
        self.tint = tint
        self.isActive = isActive
        self.needsApproval = needsApproval
    }

    /// - Parameter hasPendingApproval: the session record's own flag, which the
    ///   store keeps current for every session including the ones not on screen.
    ///   A live session blocked on the reader outranks whatever its status says.
    init(_ status: SessionStatus, hasPendingApproval: Bool = false) {
        let resolved: SessionStatus =
            hasPendingApproval && !status.isTerminal ? .waitingForApproval : status
        switch resolved {
        case .idle:
            self.init(label: "Ready", symbol: "circle.dotted", tint: .secondary, isActive: false)
        case .running:
            self.init(label: "Running", symbol: "bolt.fill", tint: .secondary, isActive: true)
        case .waitingForApproval:
            self.init(
                label: "Needs approval",
                symbol: "hand.raised.fill",
                junoIcon: .permission,
                tint: .junoCaution,
                isActive: true,
                needsApproval: true
            )
        case .stopping:
            self.init(label: "Stopping", symbol: "stop.circle", tint: .secondary, isActive: true)
        case .completed:
            self.init(
                label: "Completed",
                symbol: "checkmark.circle.fill",
                tint: .junoSuccess,
                isActive: false
            )
        case .failed:
            self.init(
                label: "Failed",
                symbol: "xmark.circle.fill",
                junoIcon: .error,
                tint: .junoDanger,
                isActive: false
            )
        case .cancelled:
            self.init(
                label: "Stopped",
                symbol: "stop.circle.fill",
                tint: .secondary,
                isActive: false
            )
        }
    }

    init(_ status: NativeCodeTaskStatus) {
        switch status {
        case .queued:
            self.init(label: "Queued", symbol: "clock", tint: .secondary, isActive: true)
        case .running:
            self.init(label: "Running", symbol: "bolt.fill", tint: .secondary, isActive: true)
        case .awaitingApproval:
            self.init(
                label: "Needs approval",
                symbol: "hand.raised.fill",
                junoIcon: .permission,
                tint: .junoCaution,
                isActive: true,
                needsApproval: true
            )
        case .done:
            self.init(
                label: "Completed",
                symbol: "checkmark.circle.fill",
                tint: .junoSuccess,
                isActive: false
            )
        case .failed:
            self.init(
                label: "Failed",
                symbol: "xmark.circle.fill",
                junoIcon: .error,
                tint: .junoDanger,
                isActive: false
            )
        case .cancelled:
            self.init(
                label: "Stopped",
                symbol: "stop.circle.fill",
                tint: .secondary,
                isActive: false
            )
        }
    }

    /// The relay reports a session's state as flags rather than an enum, and a
    /// host that has stopped checking in is stale rather than idle: sending to it
    /// would produce a command nobody claims.
    init(_ summary: CodeRemoteSessionSummary) {
        if summary.isAwaitingApproval {
            self.init(
                label: "Needs approval",
                symbol: "hand.raised.fill",
                junoIcon: .permission,
                tint: .junoCaution,
                isActive: true,
                needsApproval: true
            )
        } else if summary.fresh == false {
            self.init(
                label: "Computer offline",
                symbol: "bolt.horizontal.circle",
                tint: .junoCaution,
                isActive: false
            )
        } else if summary.isRunning {
            self.init(label: "Running", symbol: "bolt.fill", tint: .secondary, isActive: true)
        } else if summary.lastError != nil {
            self.init(
                label: "Failed",
                symbol: "xmark.circle.fill",
                junoIcon: .error,
                tint: .junoDanger,
                isActive: false
            )
        } else {
            self.init(label: "Ready", symbol: "circle.dotted", tint: .secondary, isActive: false)
        }
    }
}

/// The row's real status, drawn with the platform's own indeterminate indicator
/// while a run is live rather than a coloured dot that cannot express motion.
struct CodeStatusIndicator: View {
    let status: CodeRunStatus

    var body: some View {
        Group {
            if status.isActive, !status.needsApproval {
                ProgressView()
                    .controlSize(.small)
                    .tint(status.tint)
            } else if let junoIcon = status.junoIcon {
                JunoIconView(junoIcon, size: 13)
                    .foregroundStyle(status.tint)
            } else {
                Image(systemName: status.symbol)
                    .foregroundStyle(status.tint)
                    .imageScale(.small)
            }
        }
        .frame(width: 16)
        .accessibilityLabel(status.label)
    }
}

// MARK: - Navigation column

/// The navigation column, as a real macOS source list.
///
/// Everything visual here belongs to the platform: `List(selection:)` in
/// `.sidebar` style draws the selection, the hover state, the section headers and
/// the row metrics. The column paints **no background** — a sidebar is a vibrant
/// region on macOS, and the opaque fill the previous rail applied is exactly the
/// failure ``JunoSurfaces`` documents.
private struct DesktopCodeAddProjectLabel: View {
    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            ZStack(alignment: .bottomTrailing) {
                JunoIconView(.projects, size: 15)
                Image(systemName: "plus")
                    .font(.system(size: 7, weight: .bold))
                    .padding(1)
                    .background(Color.junoSidebar)
                    .clipShape(Circle())
            }
            .foregroundStyle(Color.junoSidebarForeground)

            Text("Add project…")
                .junoRowLabel()
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct DesktopCodeSidebar: View {
    @Bindable var workbench: WorkbenchModel
    let code: NativeCodeModel
    let remote: CodeRemoteBrowserModel
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    /// Which half of the app the window is showing, so the switch at the top of
    /// this column can move it. The column does not otherwise read it — it exists
    /// here for the same reason Chat's has always existed, to give the header
    /// something to write through.
    @Binding var product: DesktopProductMode
    let isBootstrapping: Bool
    /// The signed-in account, its photo, its synchronisation state and its plan
    /// meters — the four facts Chat's own column has always shown and this one
    /// never did.
    ///
    /// Optional as a group rather than individually: they all come from the one
    /// configuration, so a column that had some of them and not others would have
    /// nothing coherent to draw. When there is no session the column is exactly
    /// what it was — no half-built account row, no destination that leads to an
    /// apology.
    let session: NativeAuthenticatedSession?
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let plan: DesktopUsagePlan?
    let openRepository: () -> Void
    let newSession: (WorkspaceID) -> Void
    let rename: (CodeSession) -> Void
    @SceneStorage("juno.code.collapsedProjects") private var collapsedProjects = ""
    @State private var projectPendingDeletion: ProjectGroup?
    /// Which project row the pointer is over, so its actions menu can appear only
    /// on approach instead of sitting on every row at rest.
    @State private var hoveredProject: WorkspaceID?

    /// How far a session sits inside its project.
    ///
    /// One constant rather than the 22 and 28 that were written separately at the
    /// two call sites, which is why a session and its project's "No sessions yet"
    /// placeholder used to hang on different left edges. It lines the child's icon
    /// up under the parent's name: the chevron's 12pt frame plus the row spacing.
    private static let childIndent: CGFloat = 12 + JunoSpace.tight + JunoSpace.snug

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

    /// A project is the unit of work; a session belongs to one.
    ///
    /// The column used to be grouped purely by recency, which meant a repository's
    /// sessions were scattered through Today / Yesterday / Earlier and the only
    /// way to see "everything I have done in this repo" was to search for it.
    /// Grouping by project and nesting the sessions under it — a `DisclosureGroup`
    /// inside a `.sidebar` list, which is the platform's own outline row — makes
    /// the project the thing you navigate and the session the thing you open.
    /// Recency still exists, as a flat Recents section for crossing between
    /// projects.
    private struct ProjectGroup: Identifiable {
        let workspaceID: WorkspaceID
        let name: String
        let path: String
        let runs: [DesktopCodeRun]
        var id: WorkspaceID { workspaceID }
    }

    private func projectGroups(from allRuns: [DesktopCodeRun]) -> [ProjectGroup] {
        // Keyed by session so a run's workspace is read from the session record
        // rather than re-parsed out of the row's caption string.
        var runsByWorkspace: [WorkspaceID: [DesktopCodeRun]] = [:]
        for run in allRuns {
            guard case .session(let sessionID) = run.item,
                let session = workbench.sessions.first(where: { $0.id == sessionID }),
                let workspaceID = session.workspaceID
            else { continue }
            runsByWorkspace[workspaceID, default: []].append(run)
        }
        // Driven by `workspaces`, not by the sessions, so a repository the reader
        // has granted but not yet worked in still appears — that empty project is
        // how they start.
        return workbench.workspaces.map { record in
            ProjectGroup(
                workspaceID: record.id,
                name: record.descriptor.displayName,
                path: record.descriptor.localPathHint,
                runs: runsByWorkspace[record.id] ?? []
            )
        }
    }

    /// Finished runs that do not belong to a local Project outline.
    ///
    /// Local sessions already live under their repository, so listing them again
    /// under Recents made the sidebar mostly duplicates. Cloud, dispatched-device
    /// and relay-watched runs have no local `WorkspaceID`; this is their one
    /// durable home after they leave Active.
    ///
    /// A conversation started with no project has no `WorkspaceID` either, and
    /// so belongs here for the same reason — without this it would appear in no
    /// section at all, and a reader who started one, looked away and came back
    /// would have lost it permanently.
    private func relayedRuns(from allRuns: [DesktopCodeRun]) -> [DesktopCodeRun] {
        Array(
            allRuns
                .filter { run in
                    guard !run.status.isActive else { return false }
                    if case .session(let id) = run.item {
                        return workbench.sessions
                            .first { $0.id == id }?
                            .workspaceID == nil
                    }
                    return true
                }
                .sorted { $0.updatedAt > $1.updatedAt }
                .prefix(12)
        )
    }

    var body: some View {
        let allRuns = runs
        let active = DesktopCodeNavigationState.active(allRuns)
        let groups = projectGroups(from: allRuns)

        return List(selection: $selection) {
            // The way back to a blank composer, always in the same place.
            //
            // It is a selectable row rather than a button because it *is* a
            // destination — the reader can leave a half-typed conversation to
            // look at a project and select this again to return to it — and
            // because ⌘N selects the same item, so the two agree.
            Label {
                Text("New conversation").junoRowLabel()
            } icon: {
                JunoIconView(.new, size: 15)
                    .junoSidebarMarkInk(selected: selection == .draft)
            }
            .junoSidebarRowInk()
            .tag(DesktopCodeSidebarItem.draft)
            .accessibilityIdentifier("juno.code.new-conversation")

            // Pull requests sit beside the composer rather than in Chat's
            // sidebar, which is where the website has always filed them: a PR is
            // what a coding session produced, and the reader checking on one is
            // in the product that opened it.
            Label {
                Text("Pull requests").junoRowLabel()
            } icon: {
                JunoIconView(.pulls, size: 15)
                    .junoSidebarMarkInk(selected: selection == .pulls)
            }
            .junoSidebarRowInk()
            .tag(DesktopCodeSidebarItem.pulls)
            .accessibilityIdentifier("juno.code.pulls")

            // Plugins, filed where the website files them.
            //
            // `app-sidebar.tsx` keeps Connections in the Code nav, and the reason
            // is right above this row: GitHub is granted on that page, and both
            // the pull request list and every Cloud run depend on the grant.
            if session != nil {
                Label {
                    Text("Connections").junoRowLabel()
                } icon: {
                    JunoIconView(.connections, size: 15)
                        .junoSidebarMarkInk(selected: selection == .connections)
                }
                .junoSidebarRowInk()
                .tag(DesktopCodeSidebarItem.connections)
                .accessibilityIdentifier("juno.code.connections")
            }

            // Anything running comes first and is never nested. A run needing
            // attention must not be one disclosure triangle away.
            if !active.isEmpty {
                Section("Active") {
                    ForEach(active) { row($0) }
                }
            }

            let favorites = workbench.favoriteSessions
            if !favorites.isEmpty {
                Section("Favorites") {
                    ForEach(favorites, id: \.id) { session in
                        if let run = allRuns.first(where: { $0.id == .session(session.id) }) {
                            row(run)
                        }
                    }
                }
            }

            Section {
                if groups.isEmpty {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Text("Add a project to let Juno read and change real files.")
                            .junoCaption()
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(action: openRepository) {
                            DesktopCodeAddProjectLabel()
                        }
                        .buttonStyle(.plain)
                        .help("Add a project… (⌘O)")
                        .accessibilityIdentifier("juno.code.add-project")
                    }
                    .padding(.vertical, JunoSpace.hairline)
                    .selectionDisabled()
                } else {
                    // The index, above the projects it indexes.
                    //
                    // Every row under this header commits the reader to one
                    // repository; without this there was no way to ask what Juno has
                    // access to overall, which is the question "Projects" looks like
                    // it should answer.
                    Label {
                        Text("All Projects").junoRowLabel()
                    } icon: {
                        JunoIconView(.projects, size: 15)
                            .junoSidebarMarkInk(selected: selection == .allProjects)
                    }
                    .junoSidebarRowInk()
                    .badge(groups.count)
                    .tag(DesktopCodeSidebarItem.allProjects)

                    ForEach(groups) { group in
                        projectRow(group)

                        if !collapsedProjectIDs.contains(group.workspaceID.value) {
                            if group.runs.isEmpty {
                                Text("No sessions yet")
                                    .junoCaption()
                                    .padding(.leading, Self.childIndent)
                                    .selectionDisabled()
                            } else {
                                ForEach(group.runs) { run in
                                    row(run, nested: true)
                                        .padding(.leading, Self.childIndent)
                                }
                            }
                        }
                    }

                    // An ordinary row, not a button in the section header.
                    //
                    // The header this replaces pinned to the top of the List and
                    // collided with the traffic lights, taking its "+" with it. A
                    // row scrolls with the content like everything else, and says
                    // what it does rather than being a bare glyph.
                    Button(action: openRepository) {
                        DesktopCodeAddProjectLabel()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Add a project… (⌘O)")
                    .accessibilityIdentifier("juno.code.add-project")
                    .selectionDisabled()
                }
            }
            // No header on this section, deliberately.
            //
            // A `.sidebar` List **pins** its section headers to the top of its own
            // bounds, and a pinned header is not subject to the `safeAreaInset`
            // that positions the scrolling content — so whichever section came
            // first drew its title level with the traffic lights and behind the
            // window's own title, while the rows underneath sat correctly below
            // them. Raising the inset could not fix it: the header does not move
            // with the content it heads. The opaque strip the switch now sits in
            // changes what that looks like, not whether it is wrong — a pinned
            // header no longer lands on the traffic lights, it lands behind the
            // strip and is never seen at all, which is a worse thing to ship than
            // no header.
            //
            // Nothing is lost by dropping it. "All Projects" is the first row and
            // names the group better than a static caption did, and adding a
            // project lives in the session-tools menu (⌘O) and in the empty state.
            // The remaining sections keep their headers, because none of them is
            // ever first — Active and Favourites precede them when non-empty, and
            // Projects always precedes the rest.

            let relayed = relayedRuns(from: allRuns)
            if !relayed.isEmpty {
                Section("Cloud & devices") {
                    ForEach(relayed) { row($0) }
                }
            }

            if !code.devices.isEmpty {
                otherComputersSection
            }
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        // The Chat / Code switch, on the column it switches, in the strip that
        // used to be reserved and empty.
        //
        // The empty strip's note said product identity belonged in the window
        // chrome. What the strip could not do then was *hold* anything: it was
        // `Color.clear`, so scrolled rows and the section headers this list pins
        // to its own top both slid through it. See
        // ``DesktopSidebarProductHeader`` — the backing is what makes the strip
        // able to carry a control, and it is why the pinned-header note above no
        // longer describes a visible failure.
        .safeAreaInset(edge: .top, spacing: 0) {
            DesktopSidebarProductHeader(product: $product)
        }
        // `safeAreaBar`, not `safeAreaInset`: the bar variant is what the
        // system's bottom scroll-edge effect is measured against, and that
        // effect is what lets the footer sit on a translucent column without an
        // opaque bar painted behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            footer
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
    }

    private var matchingRemoteSessions: [CodeRemoteSessionSummary] {
        let needle = workbench.sessionSearchText
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        guard !needle.isEmpty else { return remote.sessions }
        return remote.sessions.filter {
            $0.title.lowercased().contains(needle)
                || ($0.workspaceName ?? "").lowercased().contains(needle)
        }
    }

    private func isFavorite(_ run: DesktopCodeRun) -> Bool {
        guard case .session(let id) = run.item else { return false }
        return workbench.sessions.first { $0.id == id }?.isFavorite == true
    }

    /// Which projects are collapsed, restored across launches.
    ///
    /// Stored as one delimited string because `@SceneStorage` takes only
    /// `RawRepresentable` values, and a `Set<WorkspaceID>` is not one. Collapsed
    /// state is the interesting half to persist: a reader with eight granted
    /// repositories collapses the seven they are not working in, and having that
    /// undone on every launch is what makes an outline sidebar annoying rather
    /// than useful.
    private func toggleExpansion(for id: WorkspaceID) {
        var collapsed = collapsedProjectIDs
        if collapsed.contains(id.value) {
            collapsed.remove(id.value)
        } else {
            collapsed.insert(id.value)
        }
        collapsedProjects = collapsed.sorted().joined(separator: "\u{1f}")
    }

    private var collapsedProjectIDs: Set<String> {
        Set(collapsedProjects.components(separatedBy: "\u{1f}").filter { !$0.isEmpty })
    }

    /// A project row: the platform's selection, one disclosure control, and
    /// actions that appear on approach.
    ///
    /// **The name is not a `Button`, and that is the fix.** It used to be, which
    /// meant the row had two competing click targets and the `List`'s own
    /// selection was never what responded — a `Button` inside a selectable row
    /// consumes the click, so the row was selected only because the button's action
    /// assigned `selection` by hand. Everything the platform gives a source list
    /// for free was lost with it: arrow-key traversal past the row, type-select,
    /// the focus ring, and click-and-drag across rows. `.tag()` on a plain row
    /// restores all of it, and the assignment by hand is no longer needed.
    ///
    /// The disclosure chevron stays a button because it genuinely is a second
    /// action on one row, and keeping the `Menu` out of the row's own content is
    /// what gives it a precise accessibility frame on macOS.
    private func projectRow(_ group: ProjectGroup) -> some View {
        let isExpanded = !collapsedProjectIDs.contains(group.workspaceID.value)
        return HStack(spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.fast) {
                    toggleExpansion(for: group.workspaceID)
                }
            } label: {
                // One glyph rotated rather than two swapped, so the chevron turns
                // the way every other outline row on the system turns.
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: 12, height: 16)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(isExpanded ? "Collapse \(group.name)" : "Expand \(group.name)")
            .accessibilityLabel(isExpanded ? "Collapse \(group.name)" : "Expand \(group.name)")

            Label {
                Text(group.name)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.middle)
            } icon: {
                JunoIconView(.projects, size: 15)
                    .junoSidebarMarkInk(selected: selection == .repository(group.workspaceID))
            }

            Spacer(minLength: JunoSpace.hairline)

            // Revealed on approach. Shown unconditionally it put a second glyph on
            // every project row at rest, which is most of what made the column read
            // as cluttered — and it duplicates a context menu that is always there.
            if hoveredProject == group.workspaceID {
                projectMenu(group)
                    .transition(.opacity)
            }
        }
        .junoSidebarRowInk()
        // The system's own trailing count, rather than a hand-placed caption. It
        // gets the platform's metrics, its dimmed-on-selection treatment and its
        // VoiceOver phrasing for free.
        .badge(group.runs.count)
        .tag(DesktopCodeSidebarItem.repository(group.workspaceID))
        .onHover { inside in
            hoveredProject = inside ? group.workspaceID : nil
        }
        .contextMenu {
            projectActions(group)
        }
    }

    private func projectMenu(_ group: ProjectGroup) -> some View {
        Menu {
            projectActions(group)
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: 16, height: 16)
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
    private func projectActions(_ group: ProjectGroup) -> some View {
        Button("New Code Session") {
            newSession(group.workspaceID)
        }
        Button("Show in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([
                URL(fileURLWithPath: group.path)
            ])
        }
        Divider()
        Button("Delete Project…", role: .destructive) {
            projectPendingDeletion = group
        }
    }

    /// "Delete Project" deletes Juno's Code sessions and the stored folder
    /// grant, but never calls a filesystem delete. The confirmation says that in
    /// plain language before the user commits.
    private func deleteProject(_ project: ProjectGroup) {
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

    private func projectDeletionMessage(_ project: ProjectGroup) -> String {
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

    /// Counted from the visible set, because this feeds the delete confirmation
    /// and a reader can only weigh a number against the runs they can see. The
    /// sub-agents underneath go with their parents either way.
    private func sessions(in project: ProjectGroup) -> [CodeSession] {
        workbench.visibleSessions.filter { $0.workspaceID == project.workspaceID }
    }

    private func selectionBelongs(to workspaceID: WorkspaceID) -> Bool {
        switch selection {
        case .repository(let id):
            return id == workspaceID
        case .session(let id):
            return workbench.sessions.first { $0.id == id }?.workspaceID == workspaceID
        // The index belongs to no single project, so deleting one never leaves the
        // reader stranded on it.
        case .allProjects, .draft, .pulls, .connections, .usage, .settings, .task, .remote, nil:
            return false
        }
    }

    // MARK: Rows

    /// - Parameter nested: whether this row already sits under its project's own
    ///   row, in which case it drops the facts that row has just stated.
    private func row(_ run: DesktopCodeRun, nested: Bool = false) -> some View {
        HStack(spacing: JunoSpace.tight) {
            CodeStatusIndicator(status: run.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(nested ? run.nestedCaption : run.caption)
                    .junoCaption()
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: JunoSpace.hairline)
            if isFavorite(run) {
                // The accent, because a pin is one of exactly two places the
                // website spends `--primary` inside the whole column
                // (`app-sidebar.tsx` draws both the pinned conversation and the
                // starred project `fill-primary`). It was `junoCaution` here —
                // an amber that matched neither the web's pin nor the Chat
                // column's, so one mark had three colours across two windows.
                JunoIconView(.pin, size: 11)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityLabel("Favorite")
            }
        }
        .junoSidebarRowInk()
        .tag(run.item)
        .contextMenu { rowMenu(run) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(run.title), \(run.caption), \(run.status.label)")
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
                    Button("New Session in This Repository") {
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
                // Stopping opens the run first: `cancelOpenTask` acts on the
                // followed task, and stopping something the reader cannot see is
                // worse than stopping something they are looking at.
                Button("Stop") {
                    selection = run.item
                    code.open(task)
                    Task { await code.cancelOpenTask() }
                }
                .disabled(!task.status.isActive)
            }
        case .remote(let deviceID, let sessionID):
            // Stop is the only action the relay exposes for someone else's
            // session. Renaming, favouriting and deleting belong to the host that
            // owns it, and the relay has no route for any of them.
            Button("Stop") {
                Task { await remote.stopGeneration(deviceID: deviceID, sessionID: sessionID) }
            }
            .disabled(!run.status.isActive || remote.isSendingCommand)
        case .allProjects, .draft, .pulls, .connections, .usage, .settings, .repository:
            // None reaches this row builder: repositories carry their own menu,
            // and neither the index, the composer nor the pull request list is a
            // run.
            EmptyView()
        }
    }

    // MARK: Other computers

    /// Sessions running on another Mac, watched through the relay.
    ///
    /// The picker in the header is not a second navigation: `CodeRemoteBrowserModel`
    /// holds exactly one host's session list at a time, so "which computer" is a
    /// real question with one honest home, and the rows below it are ordinary
    /// selectable sessions like any other.
    private var otherComputersSection: some View {
        Section {
            let matching = matchingRemoteSessions
            if matching.isEmpty {
                Text(
                    workbench.sessionSearchText.isEmpty
                        ? "No sessions on this computer"
                        : "No matching sessions on this computer"
                )
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

    /// What the column pins under the list: a transient workspace notice, and
    /// then the account.
    ///
    /// In that order because the notice is news and the account row is furniture
    /// — a "choose the folder again" prompt that appeared *below* the reader's
    /// own name would be reporting an emergency in the quietest place on screen.
    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 0) {
            workspaceStatus
            if let session {
                DesktopSidebarFooter(
                    session: session,
                    avatarModel: avatarModel,
                    syncModel: syncModel,
                    plan: plan,
                    // Selection, not a closure out of the window: Usage and
                    // Settings are this column's own destinations, so they are
                    // reached the way every other row here is reached.
                    openUsage: { selection = .usage },
                    openSettings: { selection = .settings }
                )
            }
        }
    }

    /// The column's own progress, never skeleton rows.
    ///
    /// Placeholder rows behind a real state are the specific dishonesty the brief
    /// rules out: they claim there is content and then contradict themselves.
    @ViewBuilder
    private var workspaceStatus: some View {
        if isBootstrapping {
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Opening your repositories…").junoCaption()
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
                // The recovery, not just the diagnosis. A lapsed folder grant is
                // the one failure that makes Juno Code unusable end to end — no
                // workspace opens, so no session starts, so no composer ever
                // appears — and it is fixed only by the user picking the folder
                // again. Reporting it without offering that is a dead end.
                if workbench.workspaceNeedingAccess != nil {
                    HStack(spacing: JunoSpace.snug) {
                        Button("Choose Folder Again…", action: regrantAccess)
                            .controlSize(.small)
                            .accessibilityIdentifier("juno.code.regrant")
                        Button("Dismiss") { workbench.dismissAccessPrompt() }
                            .controlSize(.small)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
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
    ///
    /// `NSOpenPanel` directly rather than SwiftUI's `.fileImporter`: the importer
    /// is bound to a `@State` flag on the *workspace* view, and the sidebar is a
    /// column inside it — routing this through there would mean threading a
    /// second presentation flag through the sidebar's whole initializer for one
    /// recovery button. The panel is also what actually re-grants: the sandbox
    /// issues the new bookmark from the user's own selection in it.
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
        // Opens where the folder used to be, so the common case — the grant
        // lapsed but nothing moved — is one click.
        if let hint = record?.descriptor.localPathHint {
            panel.directoryURL = URL(fileURLWithPath: hint).deletingLastPathComponent()
        }

        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await workbench.restoreAccess(to: workspaceID, grantedURL: url) }
    }

}

/// Projects the transports into the column's one row type.
///
/// Relay-watched sessions are deliberately not merged in here: they belong to
/// another computer, and which computer is a real question the "Other computers"
/// section answers in one place. Merging them would list the same session twice.
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
                branch: session.gitBranch,
                environment: .local,
                status: CodeRunStatus(
                    session.status,
                    hasPendingApproval: session.hasPendingApproval
                ),
                updatedAt: session.updatedAt
            )
        }

        // `filteredSessions` has already applied the query to local sessions;
        // cloud and device runs are filtered here so one search field covers the
        // whole column.
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
            branch: summary.activeBranch,
            environment: .remote,
            status: CodeRunStatus(summary),
            updatedAt: summary.updatedAt
        )
    }
}

// MARK: - Pre-session detail states

/// The three real places a Code run can execute.
///
/// `NativeCodeTarget` intentionally has no local case because it models the
/// server relay only. The desktop has a third, genuinely different path: a
/// sandboxed `JunoCode` session working directly in a security-scoped folder on
/// this Mac. Keeping the three-way choice here avoids pretending that a local
/// session was dispatched through the cloud API.
enum DesktopCodeLaunchTarget: String, CaseIterable, Identifiable {
    case local
    case cloud
    case device

    var id: Self { self }

    var label: String {
        switch self {
        case .local: "This Mac"
        case .cloud: "Cloud"
        case .device: "My devices"
        }
    }

    var symbol: String {
        switch self {
        case .local: "laptopcomputer"
        case .cloud: "cloud"
        case .device: "desktopcomputer"
        }
    }

    /// The website's mark for this destination, where it has one.
    ///
    /// The web offers two targets, Device and Cloud, and draws them as a laptop
    /// and a cloud. The Mac has a third — *another* of your computers — which
    /// the web cannot express and therefore has no mark for, so that one keeps
    /// a system symbol. Giving all three the laptop would say the wrong thing
    /// twice over.
    var junoIcon: JunoIcon? {
        switch self {
        case .local: .device
        case .cloud: .cloud
        case .device: nil
        }
    }

    var nativeTarget: NativeCodeTarget? {
        switch self {
        case .local: nil
        case .cloud: .cloud
        case .device: .device
        }
    }
}

/// Everything fixed at the start of a local run.
///
/// A turn's mode, model, reasoning and permissions can still change later from
/// the session composer, but the first turn must not be created with hidden
/// hard-coded values. This value is also the seam that keeps the launch surface
/// independently testable from the local runtime.
struct DesktopLocalCodeDraft: Equatable {
    /// nil starts the conversation with no project: no file tools, no shell,
    /// no Git — see `SessionController.makeProjectlessOrchestrator`.
    let workspaceID: WorkspaceID?
    let prompt: String
    let behavior: AgentBehavior
    let permissionMode: PermissionMode
    let modelID: String
    let reasoningEffort: ReasoningEffort
    let attachments: [CodeAttachment]
    let fileReferences: [WorkspacePath]

    init(
        workspaceID: WorkspaceID?,
        prompt: String,
        behavior: AgentBehavior,
        permissionMode: PermissionMode,
        modelID: String,
        reasoningEffort: ReasoningEffort,
        attachments: [CodeAttachment] = [],
        fileReferences: [WorkspacePath] = []
    ) {
        self.workspaceID = workspaceID
        self.prompt = prompt
        self.behavior = behavior
        self.permissionMode = permissionMode
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.attachments = attachments
        self.fileReferences = fileReferences
    }

    var configuration: AgentConfiguration {
        AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            behavior: behavior,
            permissionMode: permissionMode,
            location: .local
        )
    }

    static func title(from prompt: String) -> String {
        let firstLine = prompt
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? prompt
        return firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
    }
}

/// A repository is open and no session is selected: the real first-turn
/// composer.
///
/// This is a repository work surface, not a marketing empty state. Repository
/// identity stays fixed at the top, the working canvas stays quiet, and the
/// first-turn composer sits where the running session transcript will end. The
/// first send creates and starts the run; it never creates an empty session merely
/// because the reader clicked "New".
struct DesktopCodeDraftDetail: View {
    /// The project this conversation will work in, or nil for one that has
    /// none.
    ///
    /// Nil is the ordinary state on a fresh install and a first-class one
    /// after: the composer is fully usable without it, and the bar at the top
    /// offers a project rather than demanding one. The screen that used to
    /// stand here — a wordmark, a paragraph and a single "Open Repository…"
    /// button — could not be typed into at all, which made "ask Juno a
    /// question" impossible until you had granted a folder to a tool you had
    /// not yet been able to ask anything about.
    let record: WorkspaceRecord?
    let workbench: WorkbenchModel
    let code: NativeCodeModel
    let isStartingLocal: Bool
    let startLocal: (DesktopLocalCodeDraft) -> Void
    let openTask: (NativeCodeTask) -> Void
    /// Opens the folder picker, from the "Open a project…" affordance.
    let addProject: () -> Void
    /// Points the draft at one of the granted projects, or at none.
    ///
    /// The composer does not own which project it is in — the window's
    /// selection does — so this hands the choice back up rather than keeping a
    /// second copy of it that could disagree with the sidebar.
    let selectProject: (WorkspaceID?) -> Void
    /// Starts realtime voice mode from the first-turn composer. The draft has
    /// no `SessionController` yet, so it passes the selected model explicitly.
    let beginVoice: ((String) -> Void)?
    /// The account's linked apps, used by the composer menu to mirror Chat's
    /// connector selection affordance. Code's current task contract does not
    /// carry connector IDs yet, so this remains a local selection state until
    /// that contract is extended.
    let connectorModel: NativeConnectorModel?
    /// The host-owned voice dock, shown directly above this composer while a
    /// call is active. Keeping it outside the glass composer matches Chat.
    let voiceDock: AnyView?

    @SceneStorage("juno.desktop.code.launch-target")
    private var storedTarget = DesktopCodeLaunchTarget.local.rawValue
    @State private var prompt = ""
    @State private var behavior = AgentBehavior.code
    @State private var permissionMode = PermissionMode.askBeforeChanges
    @State private var modelID = ""
    @State private var reasoningEffort = ReasoningEffort.medium
    @State private var dictating = false
    @State private var pendingAttachments: [CodeAttachment] = []
    @State private var fileReferences: [WorkspacePath] = []
    @State private var selectedConnectors: Set<String> = []
    @State private var isDropTargeted = false
    @State private var importError: String?
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Cloud and device runs both need somewhere to run — a repository, or a
    /// folder on a computer — so a conversation with no project is pinned to
    /// this Mac. Leaving the stored target in place would restore a reader
    /// straight onto a composer that `startBlockedReason` refuses, and the
    /// feature would read as broken on its first use.
    private var target: DesktopCodeLaunchTarget {
        guard record != nil else { return .local }
        return DesktopCodeLaunchTarget(rawValue: storedTarget) ?? .local
    }

    private var targetBinding: Binding<DesktopCodeLaunchTarget> {
        Binding(
            get: { target },
            set: { next in
                guard next != target else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    storedTarget = next.rawValue
                    configureNativeTarget(next)
                }
            }
        )
    }

    private var selectedModel: ModelOption? {
        workbench.availableModels.first { $0.modelID == modelID }
    }

    private var modelBinding: Binding<String> {
        Binding(
            get: { modelID },
            set: { next in
                modelID = next
                guard let option = workbench.availableModels.first(where: {
                    $0.modelID == next
                }) else { return }
                let supported = option.supportedReasoningEfforts
                if !supported.contains(reasoningEffort) {
                    reasoningEffort = supported.first ?? .medium
                }
            }
        )
    }

    private var reasoningBinding: Binding<String?> {
        Binding(
            get: { reasoningEffort.rawValue },
            set: { value in
                guard let value, let effort = ReasoningEffort(rawValue: value) else {
                    return
                }
                reasoningEffort = effort
            }
        )
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        let hasDraftContent = !trimmedPrompt.isEmpty
            || !pendingAttachments.isEmpty
            || !fileReferences.isEmpty
        guard hasDraftContent else { return false }
        // A projectless conversation only needs a model — there is no
        // repository, device or workspace for anything else to be blocked on.
        if record == nil { return !modelID.isEmpty && !isStartingLocal }
        switch target {
        case .local:
            return !modelID.isEmpty && !isStartingLocal
        case .cloud, .device:
            // Cloud and device dispatch currently accept a prompt only. Keep
            // the draft visible when the target changes instead of silently
            // dropping its file/image context, but refuse a send until it is
            // aimed back at This Mac.
            guard pendingAttachments.isEmpty, fileReferences.isEmpty else {
                return false
            }
            return !trimmedPrompt.isEmpty
                && code.startBlockedReason == nil
                && !code.isMutating
        }
    }

    private var canAttachImages: Bool {
        target == .local
            && selectedModel?.catalog?.capabilities.contains(.vision) != false
            && pendingAttachments.count < 4
    }

    var body: some View {
        VStack(spacing: 0) {
            repositoryContextBar
            Divider()

            Color.clear.overlay(alignment: .bottom) {
                VStack(spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text(record == nil ? "Start a conversation" : "Start a task")
                            .font(.title2.weight(.semibold))
                        Text(
                            record == nil
                                ? "Ask, plan, or think something through. Open a project when you want Juno to read and change real files."
                                : "Describe the outcome. Juno will inspect the repository before it edits."
                        )
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                    .padding(.horizontal, JunoSpace.roomy)

                    if let voiceDock {
                        voiceDock
                    }

                    composer

                    Text(footerNote)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, JunoSpace.roomy)
                        .accessibilityHidden(true)
                }
                .padding(.bottom, JunoSpace.region)
            }
        }
        .onAppear {
            configureModel()
            configureNativeTarget(target)
            focused = true
        }
        .onChange(of: workbench.availableModels.map(\.modelID)) { _, _ in
            configureModel()
        }
    }

    @ViewBuilder
    private var repositoryContextBar: some View {
        if let record {
            projectContextBar(record)
        } else {
            noProjectBar
        }
    }

    /// The bar for a conversation with no project.
    ///
    /// It states the consequence — no files, no commands — rather than only the
    /// absence, because "No project" alone reads as a setup step the reader
    /// skipped rather than as a working mode. The action is an offer sitting
    /// beside a usable composer, which is the whole difference from the wall
    /// this replaces.
    private var noProjectBar: some View {
        HStack(spacing: JunoSpace.cozy) {
            projectMark

            VStack(alignment: .leading, spacing: 2) {
                Text("No project")
                    .font(.headline)
                Text("Juno can answer and plan here, but cannot read or change files.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: JunoSpace.cozy)

            Button(action: addProject) {
                JunoIconLabel(verbatim: "Open a Project…", icon: .projects, size: 13)
            }
            .buttonStyle(.bordered)
            .keyboardShortcut("o", modifiers: [.command])
            .accessibilityIdentifier("juno.code.draft-open-project")
        }
        .controlSize(.small)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 52)
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.no-project-context")
    }

    /// The leading mark both context bars open with.
    ///
    /// **One definition, because the two bars are the same bar.** They occupy the
    /// same 52pt strip above the same composer and differ only in what they have
    /// to say; a mark written out twice is a mark that disagrees with itself the
    /// first time either is touched, which is how the two ended up as the app's
    /// only 19pt glyphs — the sidebar draws this same icon at 15, the menu at 14,
    /// this bar's own button label at 13.
    ///
    /// A 19pt outline glyph tinted `.tertiary`, floating in a 28pt slot of
    /// whitespace, was the largest and least resolved thing in the bar: nothing
    /// held it, so it read as an unfinished placeholder beside a 13pt title. The
    /// fix is the treatment the rest of the app already uses for a mark that
    /// stands for a thing rather than labelling an action — a quiet fill with the
    /// glyph centred at roughly half the tile, which is the website's own row
    /// idiom and the sidebar's "Add project…" chip idiom in a square. `junoMuted`
    /// is the resting-chip fill by definition, and it is one step off
    /// `windowBackgroundColor` rather than a competing surface.
    ///
    /// Identical in both bars on purpose. The tile is the *slot* a project
    /// occupies; whether one is open is said by the words beside it, which is
    /// where a reader looks for it. Two different inks for the same glyph said
    /// nothing legible and cost the pair their symmetry.
    private var projectMark: some View {
        JunoIconView(.projects, size: 14)
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(Color.junoMuted)
            )
            .accessibilityHidden(true)
    }

    private func projectContextBar(_ record: WorkspaceRecord) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            projectMark

            VStack(alignment: .leading, spacing: 2) {
                Text(record.descriptor.displayName)
                    .font(.headline)
                    .lineLimit(1)
                Text(
                    (record.descriptor.localPathHint as NSString)
                        .abbreviatingWithTildeInPath
                )
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            }

            Spacer(minLength: JunoSpace.cozy)

            Text(record.descriptor.isGitRepository ? "Git repository" : "Folder")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.hairline)
                .background(
                    Capsule(style: .continuous)
                        .fill(Color(nsColor: .controlBackgroundColor))
                )

            Button {
                NSWorkspace.shared.activateFileViewerSelecting([
                    URL(fileURLWithPath: record.descriptor.localPathHint)
                ])
            } label: {
                JunoIconLabel(verbatim: "Show in Finder", icon: .external, size: 14)
            }
            .labelStyle(.iconOnly)
            .help("Show this repository in Finder")
            .accessibilityLabel("Show repository in Finder")
            .accessibilityIdentifier("juno.code.show-in-finder")
        }
        .controlSize(.small)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 52)
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.repository-context")
    }

    private var composer: some View {
        // Keep the context and task surfaces visually connected, but give them
        // separate jobs. The slim upper layer answers "where?"; the lower
        // layer is the place to write and launch. This keeps the composer
        // compact without turning every control into a floating pill.
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            VStack(spacing: -JunoSpace.hairline) {
                destinationRow
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: 560)
                    .junoFloatingChrome(cornerRadius: JunoRadius.panel)
                    .zIndex(1)

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
                                : target == .local
                                    ? "Describe what you want Juno to build, fix, review, or explain…"
                                    : "Describe the task to run…",
                            text: $prompt,
                            axis: .vertical
                        )
                        .textFieldStyle(.plain)
                        .lineLimit(1...5)
                        .font(.body)
                        .focused($focused)
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .topLeading)
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.top, JunoSpace.regular)
                        .padding(.bottom, JunoSpace.snug)
                        .accessibilityIdentifier("juno.code.launch-prompt")
                        .onKeyPress(.return, phases: .down) { press in
                            if press.modifiers.contains(.shift) { return .ignored }
                            if canSend { send() }
                            return .handled
                        }

                        if let issue = importError ?? launchIssue {
                            Label(issue, systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, JunoSpace.cozy)
                                .padding(.bottom, JunoSpace.snug)
                                .transition(.opacity)
                                .accessibilityIdentifier("juno.code.launch-issue")
                        }
                    }

                    HStack(spacing: JunoSpace.snug) {
                        composerAddMenu
                        localControls

                        Spacer(minLength: JunoSpace.cozy)

                        if JunoSpeechService.isSupported {
                            dictateButton
                        }
                        sendButton
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
                }
                .frame(maxWidth: 680)
                .junoGlass(
                    in: RoundedRectangle(
                        cornerRadius: JunoCornerRadius.composer,
                        style: .continuous
                    ),
                    tint: isDropTargeted ? Color.junoAccent.opacity(0.24) : nil
                )
            }
            .padding(.horizontal, JunoSpace.roomy)
        }
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: target
        )
        .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
            receiveDroppedItems(providers)
            return true
        }
    }

    private var destinationRow: some View {
        HStack(spacing: JunoSpace.snug) {
            // Only the local destination is a *project*, and only a project is
            // choosable from here. Cloud picks a repository and Device picks a
            // computer; the run target sits beside this context instead of
            // being repeated in the lower action rail.
            if target == .local {
                projectMenu
            } else {
                destinationIdentity
            }
            Spacer(minLength: JunoSpace.tight)
            Text(destinationDetail)
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.head)

            if record != nil {
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1, height: 18)
                    .accessibilityHidden(true)
                targetMenu
            }

            if target != .local {
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1, height: 18)
                    .accessibilityHidden(true)
                launchControls
            }
        }
        // Project and run target are two independent menus. Keep them as
        // separate controls for keyboard and VoiceOver navigation even though
        // they share one compact context row visually.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(target.label), \(destinationTitle), \(destinationDetail)")
    }

    /// The destination, as text. Used where it is a statement rather than a
    /// choice.
    private var destinationIdentity: some View {
        HStack(spacing: JunoSpace.snug) {
            // `.symbolEffect` is an SF Symbol capability; a Juno mark is an
            // image asset and cannot morph, so the two branches differ in more
            // than which glyph they draw.
            //
            // Neutral, as the website's own target chip is: `code-target-picker.tsx`
            // draws its folder, branch and chevron marks `text-muted-foreground`
            // and keeps `--primary` for the send button at the other end of the
            // same row. A composer with a coral glyph on each side has two
            // primary actions and therefore none.
            if let junoIcon = target.junoIcon {
                JunoIconView(junoIcon, size: 15)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
                    .id(target)
            } else {
                Image(systemName: target.symbol)
                    .foregroundStyle(.secondary)
                    .contentTransition(.symbolEffect(.replace))
            }
            Text(destinationTitle)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    /// Which project this conversation is in — including none.
    ///
    /// The chip used to be a label: it stated "No project" and left the only
    /// way out on the far side of the window, in a bar above the transcript.
    /// The thing you want to change is the thing you should be able to click,
    /// so it is a menu, and every granted project is one item away. "No
    /// project" stays in the list rather than being an escape hatch, because it
    /// is a destination in its own right — plenty of questions are better
    /// answered without handing over a folder.
    private var projectMenu: some View {
        Menu {
            Picker("Project", selection: projectBinding) {
                JunoIconLabel(verbatim: "No project", icon: .conversation, size: 14)
                    .tag(WorkspaceID?.none)

                if !workbench.workspaces.isEmpty {
                    Divider()
                    ForEach(workbench.workspaces) { record in
                        JunoIconLabel(
                            verbatim: record.descriptor.displayName,
                            icon: .projects,
                            size: 14
                        )
                        .tag(Optional(record.id))
                    }
                }
            }
            .pickerStyle(.inline)

            Divider()

            Button(action: addProject) {
                JunoIconLabel(verbatim: "Open a Project…", icon: .new, size: 14)
            }
            .keyboardShortcut("o", modifiers: [.command])
        } label: {
            HStack(spacing: JunoSpace.snug) {
                // Same rule as `destinationIdentity`: the web's project chip is
                // `text-muted-foreground` and the coral in this row belongs to
                // the send button.
                JunoIconView(record == nil ? .conversation : .projects, size: 14)
                    .foregroundStyle(.secondary)
                Text(destinationTitle)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, JunoSpace.hairline)
            .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Choose the project this conversation works in")
        .accessibilityIdentifier("juno.code.draft-project")
    }

    private var projectBinding: Binding<WorkspaceID?> {
        Binding(
            get: { record?.id },
            set: { next in
                guard next != record?.id else { return }
                selectProject(next)
            }
        )
    }

    private var targetMenu: some View {
        Menu {
            Picker("Run on", selection: targetBinding) {
                ForEach(DesktopCodeLaunchTarget.allCases) { choice in
                    Label(choice.label, systemImage: choice.symbol)
                    .tag(choice)
                }
            }
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: target.symbol)
                    .font(.system(size: 13, weight: .medium))
                Text(target.label)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Choose where this task runs")
        .accessibilityIdentifier("juno.code.launch-target")
    }

    @ViewBuilder
    private var launchControls: some View {
        switch target {
        case .local:
            localControls
                .transition(.opacity)
        case .cloud:
            cloudControls
                .transition(.opacity)
        case .device:
            deviceControls
                .transition(.opacity)
        }
    }

    private var localControls: some View {
        HStack(spacing: JunoSpace.snug) {
            contractMenu

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

    private var contractMenu: some View {
        Menu {
            Picker("Mode", selection: $behavior) {
                ForEach(AgentBehavior.allCases, id: \.self) { value in
                    Label(
                        AgentBehaviorLabel.text(for: value),
                        systemImage: AgentBehaviorLabel.glyph(for: value)
                    )
                    .tag(value)
                }
            }

            Divider()

            Picker("Permissions", selection: $permissionMode) {
                ForEach(PermissionMode.allCases, id: \.self) { value in
                    Text(PermissionModeLabel.text(for: value))
                        .tag(value)
                }
            }
            // A permission level governs tools, and a conversation with no
            // project has none. `SessionController` pins such a session to
            // read-only regardless; naming a level here that the session will
            // not use would be the composer claiming a power it does not have.
            .disabled(behavior != .code || record == nil)
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: contractSymbol)
                    .font(.system(size: 13, weight: .medium))
                Text(contractTitle)
            }
            .font(.caption)
            .foregroundStyle(
                permissionMode == .fullAccess && record != nil ? Color.junoCaution : .secondary
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Choose whether Juno answers, plans, or edits—and when it asks")
        .accessibilityLabel("Access")
        .accessibilityValue(contractTitle)
        .accessibilityIdentifier("juno.code.launch-contract")
    }

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

    private var composerAddMenu: some View {
        Menu {
            Button(action: chooseFileReference) {
                Label("Add file context", systemImage: "doc.text")
            }
            .disabled(record == nil || target != .local)

            Button {
                importError = nil
                chooseImages()
            } label: {
                Label("Add picture", systemImage: "photo")
            }
            .disabled(!canAttachImages)

            Menu {
                if connectorModel != nil {
                    if connectedConnectors.isEmpty {
                        Text("No connected apps")
                    } else {
                        ForEach(connectedConnectors) { connector in
                            Button {
                                toggleConnector(connector.id)
                            } label: {
                                if selectedConnectors.contains(connector.id) {
                                    Label(connector.label, systemImage: "checkmark")
                                } else {
                                    Text(connector.label)
                                }
                            }
                            .disabled(
                                !selectedConnectors.contains(connector.id)
                                    && selectedConnectors.count >= 5
                            )
                        }
                    }
                } else {
                    Text("Connectors unavailable")
                }
            } label: {
                JunoIconLabel(
                    verbatim: selectedConnectors.isEmpty
                        ? "Connectors"
                        : "Connectors · \(selectedConnectors.count)",
                    icon: .connections,
                    size: 14
                )
            }
            .disabled(connectorModel == nil)

            Divider()

            Button(action: addProject) {
                Label("Open another project…", systemImage: "folder")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .medium))
                .frame(width: 24, height: 24)
                .contentShape(.circle)
                .overlay(alignment: .topTrailing) {
                    if !selectedConnectors.isEmpty {
                        Circle()
                            .fill(Color.junoAccent)
                            .stroke(Color.junoSurface, lineWidth: 1.5)
                            .frame(width: 8, height: 8)
                            .offset(x: 1, y: -1)
                    }
                }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(.primary)
        .help("Add files, pictures, connected apps, or projects")
        .accessibilityLabel("Add")
        .accessibilityValue(
            selectedConnectors.isEmpty
                ? "No connected apps selected"
                : "\(selectedConnectors.count) connected apps selected"
        )
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
                                    Image(systemName: "photo")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .frame(width: 44, height: 44)
                            .clipShape(
                                RoundedRectangle(
                                    cornerRadius: JunoRadius.row,
                                    style: .continuous
                                )
                            )

                            Button {
                                pendingAttachments.removeAll { $0.id == attachment.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.caption)
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(Color.junoOnAccent, Color.secondary)
                            }
                            .buttonStyle(.plain)
                            .offset(x: 5, y: -5)
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
            Image(systemName: "doc.text")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text(path.lastComponent)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(path.value)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: 150, alignment: .leading)

            Button {
                removeFileReference(path)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.junoOnAccent, Color.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove (path.lastComponent)")
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 44)
        .junoGlass(
            in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous),
            tint: Color.primary.opacity(0.05)
        )
        .help("Attached file (path.value)")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached file (path.value)")
    }

    private var dictateButton: some View {
        Button {
            focused = false
            withAnimation(JunoMotion.fast) { dictating = true }
        } label: {
            Image(systemName: "mic")
                .font(.body)
                .foregroundStyle(Color.primary.opacity(0.76))
                .frame(width: 34, height: 34)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .help("Dictate a message")
        .accessibilityLabel("Dictate a message")
        .accessibilityIdentifier("juno.code.composer.dictate")
    }

    /// The same morphing primary action Chat uses: voice mode when the prompt
    /// is empty, Send once the reader has written something, and a spinner while
    /// a task is being created. Voice lives in this slot so it is discoverable
    /// without adding a second row of controls to the Code composer.
    @ViewBuilder
    private var sendButton: some View {
        if trimmedPrompt.isEmpty,
            pendingAttachments.isEmpty,
            fileReferences.isEmpty,
            let beginVoice
        {
            Button {
                beginVoice(modelID)
            } label: {
                Image(systemName: "waveform")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .foregroundStyle(Color.primary)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .junoGlass(
                in: Circle(),
                tint: Color.primary.opacity(modelID.isEmpty ? 0.04 : 0.14),
                interactive: true
            )
            .disabled(modelID.isEmpty)
            .help("Start a voice conversation")
            .accessibilityLabel("Start voice mode")
            .accessibilityIdentifier("juno.code.composer.voice")
        } else {
            Button(action: send) {
                Group {
                    if isStartingLocal || code.isMutating {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 12, weight: .bold))
                    }
                }
                .frame(width: 30, height: 30)
                .foregroundStyle(canSend ? Color.primary : Color.secondary)
                .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .junoGlass(
                in: Circle(),
                tint: Color.primary.opacity(canSend ? 0.14 : 0.04),
                interactive: true
            )
            .disabled(!canSend)
            .help("Start this task (Return)")
            .accessibilityLabel("Start task")
            .accessibilityIdentifier("juno.code.launch-send")
        }
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let existing = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = existing.isEmpty ? dictated : "\(existing) \(dictated)"
    }

    private func chooseFileReference() {
        guard let record, target == .local else { return }

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

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    private func toggleConnector(_ id: String) {
        if selectedConnectors.contains(id) {
            selectedConnectors.remove(id)
        } else if selectedConnectors.count < 5 {
            selectedConnectors.insert(id)
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

    /// Receives both Finder file URLs and image bytes from apps that do not
    /// expose a file URL. An image file becomes a thumbnail; any other file
    /// inside the selected project becomes a removable file-context chip.
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
        guard target == .local else {
            importError = "Files and pictures can be added on This Mac only."
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

    private var contractTitle: String {
        guard behavior == .code, record != nil else {
            return AgentBehaviorLabel.text(for: behavior)
        }
        return permissionMode == .fullAccess ? "Full access" : "Ask before edits"
    }

    private var contractSymbol: String {
        guard behavior == .code, record != nil else {
            return AgentBehaviorLabel.glyph(for: behavior)
        }
        return permissionMode == .fullAccess ? "shield.fill" : "shield"
    }

    private var destinationTitle: String {
        switch target {
        case .local:
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
        switch target {
        case .local:
            record.map { ($0.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath }
                ?? "Answers only — no files, no commands"
        case .cloud:
            code.selectedRepository.map { "\($0.defaultBranch) · opens a pull request" }
                ?? "GitHub Actions"
        case .device:
            code.selectedWorkspace?.path
                ?? code.selectedDevice.map {
                    $0.online ? "Online" : "Offline"
                }
                ?? "Juno Code host"
        }
    }

    private var launchIssue: String? {
        switch target {
        case .local:
            if workbench.availableModels.isEmpty {
                return "Your Code model catalog is still loading."
            }
            return nil
        case .cloud, .device:
            if !pendingAttachments.isEmpty || !fileReferences.isEmpty {
                return "Pictures and file context run on This Mac only."
            }
            return code.lastErrorDescription ?? code.startBlockedReason
        }
    }

    private var footerNote: String {
        switch target {
        case .local:
            record == nil
                ? "No files, no commands — open a project when you want Juno to read or change real ones."
                : behavior == .code
                ? PermissionModeLabel.explanation(for: permissionMode)
                : AgentBehaviorLabel.explanation(for: behavior)
        case .cloud:
            "Cloud runs work on an isolated checkout and report their pull request here."
        case .device:
            "The selected device works only inside the workspace it has already granted."
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

    private func configureModel() {
        guard modelID.isEmpty
                || !workbench.availableModels.contains(where: { $0.modelID == modelID })
        else { return }
        modelID = workbench.availableModels.first?.modelID ?? ""
        if let selectedModel {
            reasoningEffort = selectedModel.supportedReasoningEfforts.first ?? .medium
        }
    }

    private func configureNativeTarget(_ choice: DesktopCodeLaunchTarget) {
        guard let nativeTarget = choice.nativeTarget else { return }
        code.target = nativeTarget
        switch nativeTarget {
        case .cloud:
            code.loadRepositoriesIfNeeded()
        case .device:
            if code.selectedDeviceID == nil {
                code.selectedDeviceID =
                    code.devices.first(where: \.online)?.id ?? code.devices.first?.id
            }
            if code.selectedWorkspaceKey == nil {
                code.selectedWorkspaceKey = code.selectedDevice?.workspaces.first?.id
            }
        }
    }

    private func send() {
        guard canSend else { return }
        switch target {
        case .local:
            startLocal(
                DesktopLocalCodeDraft(
                    workspaceID: record?.id,
                    prompt: trimmedPrompt,
                    behavior: behavior,
                    permissionMode: permissionMode,
                    modelID: modelID,
                    reasoningEffort: reasoningEffort,
                    attachments: pendingAttachments,
                    fileReferences: fileReferences
                )
            )
        case .cloud, .device:
            guard let nativeTarget = target.nativeTarget else { return }
            code.target = nativeTarget
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
///
/// The sidebar answers "which project am I working in"; this answers "what does
/// Juno have access to, and what has happened in each" — the question the
/// Projects header looks like it should answer and previously could not, because
/// every row under it committed you to a single repository.
///
/// Deliberately a list rather than a grid of cards: the useful facts here are a
/// path, a session count and a date, which are text, and a grid would space three
/// short strings across a window this wide.
struct DesktopCodeAllProjects: View {
    @Bindable var workbench: WorkbenchModel
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
            if workbench.workspaces.isEmpty {
                JunoEmptyState(
                    title: "No projects yet",
                    message: """
                        A project is a folder Juno Code may read and write in. \
                        Add one to start a session.
                        """,
                    symbol: "folder.badge.plus",
                    actionLabel: "Add Project…",
                    action: addProject
                )
            } else {
                JunoDetailPage(maxWidth: 820) {
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
                    // A dot and a caption, not coral text.
                    //
                    // The website marks a running task with `bg-success` and a
                    // pulse (`TASK_STATUS_META`) and never with `--primary`, which
                    // it keeps for the actions on the right of this same card.
                    // Colouring the *count* in the accent made the card look as
                    // though something needed doing.
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
                // One prominent action per card, in the accent, exactly as the
                // web's default `Button` variant renders `bg-primary` — and the
                // secondary one below it stays bordered rather than becoming a
                // second coral fill.
                Button("Open") { open(row.record.id) }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .controlSize(.small)
                Button("New Session") { newSession(row.record.id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(JunoSpace.regular)
        .junoCard(cornerRadius: JunoCornerRadius.card)
        .contextMenu {
            Button("Show in Finder") {
                revealInFinder(row.record.descriptor.localPathHint)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.record.descriptor.displayName), \(summary(row))")
    }

    /// "12 sessions · Git repository · last used yesterday", with absent facts
    /// dropped rather than printed as empty separators.
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
