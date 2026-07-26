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
    @Binding var product: DesktopProductMode
    @Binding var selection: DesktopCodeSidebarItem?
    @Binding var remoteDeviceID: String
    let searchFocus: FocusState<Bool>.Binding
    let isBootstrapping: Bool
    let openRepository: () -> Void
    let newSession: (WorkspaceID) -> Void
    let rename: (CodeSession) -> Void
    @SceneStorage("juno.code.collapsedProjects") private var collapsedProjects = ""

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
                runs: runsByWorkspace[record.id] ?? []
            )
        }
    }

    /// The most recently touched runs, across every project and transport.
    ///
    /// Deliberately includes runs that are also nested under a project. A row
    /// appearing in both places is not a duplicate in the sense that matters —
    /// Projects and Recents answer different questions, and suppressing a session
    /// from Recents because it happens to live in a granted repository would make
    /// Recents useless exactly when the reader has organised their work well.
    private func recentRuns(from allRuns: [DesktopCodeRun]) -> [DesktopCodeRun] {
        Array(allRuns.sorted { $0.updatedAt > $1.updatedAt }.prefix(6))
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

            Section("Projects") {
                ForEach(groups) { group in
                    DisclosureGroup(isExpanded: expansion(for: group.workspaceID)) {
                        if group.runs.isEmpty {
                            Text("No sessions yet")
                                .junoCaption()
                        } else {
                            ForEach(group.runs) { row($0) }
                        }
                    } label: {
                        projectLabel(group)
                    }
                }
            }

            // Recents crosses projects. The nesting above answers "what have I
            // done in this repository"; this answers "what was I just doing",
            // which is a different question and the one a reader has on launch.
            // Capped, because an uncapped Recents is just the project list again
            // with the grouping removed.
            let recents = recentRuns(from: allRuns)
            if !recents.isEmpty {
                Section("Recents") {
                    ForEach(recents) { row($0) }
                }
            }

            if !code.devices.isEmpty {
                otherComputersSection
            }
        }
        .listStyle(.sidebar)
        // The Chat column's treatment, applied here too: macOS paints a focused
        // sidebar selection in the app's accent, which is coral, so a selected
        // session became a full-width saturated bar. The web uses
        // `--sidebar-accent`, a subtle warm grey. Tinting keeps the platform's own
        // selection — arrow keys, type-select, focus ring, inactive state — and
        // only says what colour it is.
        .junoSidebarSelectionTint()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
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

    /// Which projects are expanded, restored across launches.
    ///
    /// Stored as one delimited string because `@SceneStorage` takes only
    /// `RawRepresentable` values, and a `Set<WorkspaceID>` is not one. Collapsed
    /// state is the interesting half to persist: a reader with eight granted
    /// repositories collapses the seven they are not working in, and having that
    /// undone on every launch is what makes an outline sidebar annoying rather
    /// than useful.
    private func expansion(for id: WorkspaceID) -> Binding<Bool> {
        Binding(
            get: { !collapsedProjectIDs.contains(id.value) },
            set: { expanded in
                var collapsed = collapsedProjectIDs
                if expanded {
                    collapsed.remove(id.value)
                } else {
                    collapsed.insert(id.value)
                }
                collapsedProjects = collapsed.sorted().joined(separator: "\u{1f}")
            }
        )
    }

    private var collapsedProjectIDs: Set<String> {
        Set(collapsedProjects.components(separatedBy: "\u{1f}").filter { !$0.isEmpty })
    }

    /// The project row: a folder, its name, and how many sessions are inside.
    ///
    /// Selectable in its own right — selecting a project is how the reader gets
    /// the project's own surface rather than one of its sessions — so it carries
    /// a `.tag`, and the disclosure triangle only opens the children.
    private func projectLabel(_ group: ProjectGroup) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Label {
                Text(group.name)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.middle)
            } icon: {
                // Juno's own projects glyph rather than SF Symbols' folder: the
                // sidebar's other rows are Lucide-derived Juno icons, and one
                // system folder among them reads as a different app's row.
                JunoIconView(.projects, size: 15)
            }
            Spacer(minLength: JunoSpace.hairline)
            if !group.runs.isEmpty {
                Text(group.runs.count.formatted())
                    .junoCaption()
                    .monospacedDigit()
                    .accessibilityLabel("\(group.runs.count) sessions")
            }
        }
        .junoSidebarRowInk()
        .tag(DesktopCodeSidebarItem.repository(group.workspaceID))
        .contextMenu {
            Button("New Session in \(group.name)") {
                newSession(group.workspaceID)
            }
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

    // MARK: Repositories

    private var repositoriesSection: some View {
        Section("Repositories") {
            ForEach(workbench.workspaces, id: \.id) { record in
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(record.descriptor.displayName)
                            .junoRowLabel()
                            .lineLimit(1)
                        // Truncated from the head: the trailing folders identify
                        // the repository, the leading ones are shared noise.
                        Text(abbreviatedPath(record.descriptor.localPathHint))
                            .junoCaption()
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                } icon: {
                    Image(
                        systemName: record.descriptor.isGitRepository
                            ? "arrow.triangle.branch"
                            : "folder"
                    )
                }
                .tag(DesktopCodeSidebarItem.repository(record.id))
                .contextMenu {
                    Button("New Session Here") { newSession(record.id) }
                    Button("Remove from Recents", role: .destructive) {
                        Task { await workbench.removeWorkspace(id: record.id) }
                    }
                }
            }

            Button(action: openRepository) {
                Label("Open Repository…", systemImage: "folder.badge.plus")
                    .junoRowLabel()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.junoAccent)
            .keyboardShortcut("o", modifiers: .command)
            .selectionDisabled()
            .accessibilityIdentifier("juno.code.open-repository")
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

    private func abbreviatedPath(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
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
        JunoEmptyState(
            title: "Open a repository",
            message: """
                Juno Code works in a folder you choose, and reads and writes only \
                inside it.
                """,
            symbol: "folder.badge.plus",
            actionLabel: "Open Repository…",
            action: openRepository
        )
        .frame(maxWidth: .infinity, minHeight: 320)
    }
}

/// A repository is open and no session is selected: a draft.
///
/// The starters do not launch. Each one creates the session and lands its text in
/// the composer, so the reader edits a real prompt in the place they will edit
/// every later prompt, and the transcript grows exactly where the starters were
/// rather than the layout re-flowing from centred to left.
struct DesktopCodeDraftDetail: View {
    let record: WorkspaceRecord
    let isStarting: Bool
    let start: (String?) -> Void

    /// The four things a reader actually opens a coding agent to do.
    ///
    /// Named by intent rather than by prompt text. The card is the label; the
    /// prompt behind it is what gets sent, and keeping the two separate means the
    /// wording sent to the model can be tuned without changing what the reader
    /// chose. A wall of four full sentences read as a list of things to read
    /// rather than a set of things to pick.
    /// One accent, not four hues.
    ///
    /// These carried a blue, a purple, a green and an orange glyph, which is the
    /// convention in other tools but not Juno's: the design language is a single
    /// restrained coral accent, and four saturated colours on the first surface of
    /// the product reads as someone else's palette. Colour here would also be
    /// carrying no information — the glyph and the label already say what the card
    /// does — so it is spent on the one thing that matters, which is that all four
    /// are equally available choices.
    private struct Starter: Identifiable {
        let title: String
        let symbol: String
        let prompt: String
        var id: String { title }
    }

    private static let starters: [Starter] = [
        Starter(
            title: "Explore and understand code",
            symbol: "text.magnifyingglass",
            prompt: "Map this codebase and explain how it fits together."
        ),
        Starter(
            title: "Build a new feature, app, or tool",
            symbol: "hammer",
            prompt: """
                I want to build something new here. Ask me what it is, then plan it \
                before writing any code.
                """
        ),
        Starter(
            title: "Review code and suggest changes",
            symbol: "checklist",
            prompt: "Review my uncommitted changes for correctness and risk."
        ),
        Starter(
            title: "Fix issues and failures",
            symbol: "wrench.and.screwdriver",
            prompt: "Run the test suite and fix what fails."
        ),
    ]

    var body: some View {
        JunoDetailPage {
            draftBody
        }
    }

    private var draftBody: some View {
        VStack(spacing: JunoSpace.section) {
            Image(systemName: "apple.terminal")
                .font(.system(size: 44, weight: .thin))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)

            // The project name is part of the sentence, and underlined because it
            // is the one word in it that changes: it tells the reader which of
            // their repositories this session will be allowed to touch, at the
            // moment they are deciding what to ask for.
            Text(
                "What should we work on in \(Text(record.descriptor.displayName).underline())?"
            )
            .font(JunoSerif.font(size: 27, relativeTo: .title, face: .regular))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)

            starterGrid

            VStack(spacing: JunoSpace.tight) {
                Text(abbreviatedPath)
                    .junoMono()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Text("A session may read and write inside this folder, and asks before it changes anything.")
                    .junoCaption()
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: JunoSpace.cozy) {
                Button("Start a Session") { start(nil) }
                    .junoProminentGlassButton()
                    .disabled(isStarting)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("juno.code.start-session")
                if isStarting {
                    ProgressView().controlSize(.small)
                }
            }
        }
    }

    /// Four cards across on a roomy window, two when the inspector is open and the
    /// canvas is narrow. `adaptive` rather than a fixed count so the wrap is the
    /// layout's decision and not a breakpoint someone has to maintain.
    private var starterGrid: some View {
        // The width bound belongs on the grid, not only on the enclosing stack.
        // `.adaptive` decides its column count from the width it is *proposed*;
        // proposed an unbounded width it lays the four cards out in one column and
        // reports a height four times what it needs, which propagates all the way
        // out to the window's split view.
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 156), spacing: JunoSpace.cozy)],
            spacing: JunoSpace.cozy
        ) {
            ForEach(Self.starters) { starter in
                Button { start(starter.prompt) } label: {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Image(systemName: starter.symbol)
                            .imageScale(.medium)
                            .foregroundStyle(Color.junoAccent)
                        Text(starter.title)
                            .junoRowLabel()
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                    .padding(JunoSpace.cozy)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .junoPanel()
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 0.5)
                )
                .disabled(isStarting)
                .help(starter.prompt)
            }
        }
        .frame(maxWidth: 720)
    }

    private var abbreviatedPath: String {
        (record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath
    }
}
