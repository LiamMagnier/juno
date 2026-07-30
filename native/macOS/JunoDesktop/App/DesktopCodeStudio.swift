import AppKit
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoDesignSystem
import SwiftUI

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
    let tint: Color
    let isActive: Bool
    let needsApproval: Bool

    private init(
        label: String,
        symbol: String,
        tint: Color,
        isActive: Bool,
        needsApproval: Bool = false
    ) {
        self.label = label
        self.symbol = symbol
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
            self.init(label: "Running", symbol: "bolt.fill", tint: .junoAccent, isActive: true)
        case .waitingForApproval:
            self.init(
                label: "Needs approval",
                symbol: "hand.raised.fill",
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
            self.init(label: "Running", symbol: "bolt.fill", tint: .junoAccent, isActive: true)
        case .awaitingApproval:
            self.init(
                label: "Needs approval",
                symbol: "hand.raised.fill",
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
            self.init(label: "Running", symbol: "bolt.fill", tint: .junoAccent, isActive: true)
        } else if summary.lastError != nil {
            self.init(
                label: "Failed",
                symbol: "xmark.circle.fill",
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
struct DesktopCodeSidebar: View {
    @Bindable var workbench: WorkbenchModel
    let code: NativeCodeModel
    let remote: CodeRemoteBrowserModel
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    let isBootstrapping: Bool
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
                let session = workbench.sessions.first(where: { $0.id == sessionID })
            else { continue }
            runsByWorkspace[session.workspaceID, default: []].append(run)
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
    private func relayedRuns(from allRuns: [DesktopCodeRun]) -> [DesktopCodeRun] {
        Array(
            allRuns
                .filter { run in
                    guard !run.status.isActive else { return false }
                    if case .session = run.item { return false }
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
                        Text("Projects keep Code sessions and their files together.")
                            .junoCaption()
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(action: openRepository) {
                            Label("Add project…", systemImage: "folder.badge.plus")
                                .junoRowLabel()
                        }
                        .buttonStyle(.plain)
                        .help("Add a project… (⌘O)")
                        .accessibilityIdentifier("juno.code.add-project")
                    }
                    .padding(.vertical, JunoSpace.hairline)
                    .selectionDisabled()
                } else {
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
                                    row(run)
                                        .padding(.leading, Self.childIndent)
                                }
                            }
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Projects")
                    Spacer(minLength: 0)
                    Button(action: openRepository) {
                        Image(systemName: "plus")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Add a project… (⌘O)")
                    .accessibilityIdentifier("juno.code.add-project")
                }
            }

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
        // No hand-inserted top inset.
        //
        // There used to be a `Color.clear.frame(height: 28)` here, compensating for
        // the sidebar being given the titlebar safe area by a `.searchable` attached
        // to the split view — the bug whose real fix was moving that modifier onto
        // the **detail** column, where `DesktopCodeWorkspace` now documents it at
        // length. Both fixes shipped, so the column carried 28pt of dead space above
        // its first section header on top of the inset the platform already
        // provides, which is what pushed "Projects" up against the window controls.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
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

    private func sessions(in project: ProjectGroup) -> [CodeSession] {
        workbench.sessions.filter { $0.workspaceID == project.workspaceID }
    }

    private func selectionBelongs(to workspaceID: WorkspaceID) -> Bool {
        switch selection {
        case .repository(let id):
            return id == workspaceID
        case .session(let id):
            return workbench.sessions.first { $0.id == id }?.workspaceID == workspaceID
        case .task, .remote, nil:
            return false
        }
    }

    // MARK: Rows

    private func row(_ run: DesktopCodeRun) -> some View {
        HStack(spacing: JunoSpace.tight) {
            CodeStatusIndicator(status: run.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(run.caption)
                    .junoCaption()
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: JunoSpace.hairline)
            if isFavorite(run) {
                Image(systemName: "star.fill")
                    .imageScale(.small)
                    .foregroundStyle(Color.junoCaution)
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
                Button("New Session in This Repository") {
                    newSession(session.workspaceID)
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
        case .repository:
            // Repository rows carry their own menu; they never reach this row
            // builder.
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

    /// The column's own progress, never skeleton rows.
    ///
    /// Placeholder rows behind a real state are the specific dishonesty the brief
    /// rules out: they claim there is content and then contradict themselves.
    @ViewBuilder
    private var footer: some View {
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
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.junoCaution)
                        .imageScale(.small)
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
                workspace: workspaceNames[session.workspaceID] ?? "Workspace",
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

/// Nothing has ever been opened.
///
/// One honest state with one action, not a decorative greeting. The previous
/// build spent the whole canvas on a wordmark, a target picker, a behaviour
/// picker and four suggestion cards before the reader had granted access to
/// anything at all.
struct DesktopCodeFirstRun: View {
    let openRepository: () -> Void

    var body: some View {
        VStack(spacing: JunoSpace.roomy) {
            Spacer()
            ZStack {
                Circle()
                    .fill(Color.junoAccent.opacity(0.12))
                    .frame(width: 80, height: 80)
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(Color.junoAccent)
            }

            VStack(spacing: JunoSpace.snug) {
                Text("Open a repository")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.primary)

                Text("Juno Code works from a folder on your Mac. File tools stay inside it, and shell commands follow your permission settings.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            }

            Button(action: openRepository) {
                HStack(spacing: JunoSpace.tight) {
                    Image(systemName: "folder.badge.plus")
                    Text("Open Repository…")
                }
                .font(.callout.weight(.medium))
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.tight)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .controlSize(.large)
            .keyboardShortcut("o", modifiers: [.command])
            .accessibilityIdentifier("juno.code.first-run-open")

            Spacer()
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .junoReadingCanvas()
    }
}

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
    let workspaceID: WorkspaceID
    let prompt: String
    let behavior: AgentBehavior
    let permissionMode: PermissionMode
    let modelID: String
    let reasoningEffort: ReasoningEffort

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
    let record: WorkspaceRecord
    let workbench: WorkbenchModel
    let code: NativeCodeModel
    let isStartingLocal: Bool
    let startLocal: (DesktopLocalCodeDraft) -> Void
    let openTask: (NativeCodeTask) -> Void

    @SceneStorage("juno.desktop.code.launch-target")
    private var storedTarget = DesktopCodeLaunchTarget.local.rawValue
    @State private var prompt = ""
    @State private var behavior = AgentBehavior.code
    @State private var permissionMode = PermissionMode.askBeforeChanges
    @State private var modelID = ""
    @State private var reasoningEffort = ReasoningEffort.medium
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Suggestion: Identifiable {
        let title: String
        let symbol: String
        let prompt: String
        var id: String { title }
    }

    private static let suggestions: [Suggestion] = [
        Suggestion(
            title: "Review uncommitted changes",
            symbol: "checklist",
            prompt: "Review my uncommitted changes for correctness, regressions, and security risk."
        ),
        Suggestion(
            title: "Fix failing tests",
            symbol: "wrench.and.screwdriver",
            prompt: "Run the relevant tests, diagnose every failure, and fix the root causes."
        ),
        Suggestion(
            title: "Plan a feature",
            symbol: "list.bullet.clipboard",
            prompt: "Explore this codebase and propose an implementation plan before editing anything."
        ),
        Suggestion(
            title: "Explain this repository",
            symbol: "text.magnifyingglass",
            prompt: "Map this repository and explain its architecture, data flow, and important conventions."
        ),
    ]

    private var target: DesktopCodeLaunchTarget {
        DesktopCodeLaunchTarget(rawValue: storedTarget) ?? .local
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
        guard !trimmedPrompt.isEmpty else { return false }
        switch target {
        case .local:
            return !modelID.isEmpty && !isStartingLocal
        case .cloud, .device:
            return code.startBlockedReason == nil && !code.isMutating
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            repositoryContextBar
            Divider()

            Color.clear.overlay(alignment: .bottom) {
                VStack(spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text("Start a task")
                            .font(.title2.weight(.semibold))
                        Text("Describe the outcome. Juno will inspect the repository before it edits.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                    .padding(.horizontal, JunoSpace.roomy)

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

    private var repositoryContextBar: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: record.descriptor.isGitRepository ? "folder.fill" : "folder")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)

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
                Label("Show in Finder", systemImage: "arrow.forward.square")
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
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            VStack(spacing: JunoSpace.cozy) {
                destinationRow

                TextField(
                    target == .local
                        ? "Ask Juno to build, fix, review, or explain…"
                        : "Describe the task to run…",
                    text: $prompt,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(3...9)
                .font(.body)
                .focused($focused)
                .padding(.horizontal, JunoSpace.tight)
                .padding(.vertical, JunoSpace.tight)
                .accessibilityIdentifier("juno.code.launch-prompt")
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    if canSend { send() }
                    return .handled
                }

                if let issue = launchIssue {
                    Label(issue, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, JunoSpace.tight)
                        .transition(.opacity)
                        .accessibilityIdentifier("juno.code.launch-issue")
                }

                HStack(spacing: JunoSpace.snug) {
                    targetMenu

                    Rectangle()
                        .fill(Color.junoHairline)
                        .frame(width: 1, height: 19)
                        .padding(.horizontal, 2)
                        .accessibilityHidden(true)

                    launchControls

                    Spacer(minLength: JunoSpace.tight)

                    suggestionsMenu
                    sendButton
                }
            }
            .padding(JunoSpace.cozy)
            .frame(maxWidth: 760)
            .junoFloatingChrome(cornerRadius: JunoCornerRadius.composer)
            .padding(.horizontal, JunoSpace.roomy)
        }
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: target
        )
    }

    private var destinationRow: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: target.symbol)
                .foregroundStyle(Color.junoAccent)
                .contentTransition(.symbolEffect(.replace))
            Text(destinationTitle)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: JunoSpace.tight)
            Text(destinationDetail)
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.head)
        }
        .padding(.horizontal, JunoSpace.tight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(target.label), \(destinationTitle), \(destinationDetail)")
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
            Label(target.label, systemImage: target.symbol)
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
            .disabled(behavior != .code)
        } label: {
            Label(
                behavior == .code
                    ? "\(AgentBehaviorLabel.text(for: behavior)) · \(PermissionModeLabel.shortText(for: permissionMode))"
                    : AgentBehaviorLabel.text(for: behavior),
                systemImage: AgentBehaviorLabel.glyph(for: behavior)
            )
            .font(.caption)
            .foregroundStyle(permissionMode == .fullAccess ? Color.junoCaution : .secondary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Choose whether Juno answers, plans, or edits—and when it asks")
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

    private var suggestionsMenu: some View {
        Menu {
            ForEach(Self.suggestions) { suggestion in
                Button {
                    prompt = suggestion.prompt
                    focused = true
                } label: {
                    Label(suggestion.title, systemImage: suggestion.symbol)
                }
            }
        } label: {
            Image(systemName: "sparkles")
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .help("Prompt suggestions")
        .accessibilityLabel("Prompt suggestions")
        .accessibilityIdentifier("juno.code.launch-suggestions")
    }

    private var sendButton: some View {
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
            .contentShape(.circle)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.circle)
        .tint(Color.junoAccent)
        .foregroundStyle(Color.junoOnAccent)
        .disabled(!canSend)
        .help("Start this task (Return)")
        .accessibilityLabel("Start task")
        .accessibilityIdentifier("juno.code.launch-send")
    }

    private var destinationTitle: String {
        switch target {
        case .local:
            record.descriptor.displayName
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
            (record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath
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
            return code.lastErrorDescription ?? code.startBlockedReason
        }
    }

    private var footerNote: String {
        switch target {
        case .local:
            behavior == .code
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
                    workspaceID: record.id,
                    prompt: trimmedPrompt,
                    behavior: behavior,
                    permissionMode: permissionMode,
                    modelID: modelID,
                    reasoningEffort: reasoningEffort
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
