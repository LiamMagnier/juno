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
    /// Juno Design, rendered in this window rather than reached through it —
    /// the same call the two account pages above make, and for the same reason:
    /// there is no such thing as "navigate to Chat's Design page" when only one
    /// `NavigationSplitView` is ever alive.
    ///
    /// It is not in the column's list either. Design is a destination in the
    /// footer, beside the account row, exactly where the website puts it — see
    /// ``DesktopSidebarDesignRow``.
    case design
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
        case .design: "design"
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
        case ("design", 1): return .design
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
        // request list, the connected services, the usage ledger, the settings
        // page and the design launcher are account-level pages rather than local
        // records.
        case .draft, .pulls, .connections, .usage, .settings, .design: return item
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
//
// **It is not here any more.** `CodeRunStatus`, its three transport
// projections and the mark that draws it moved to
// `JunoCodeUI/Components/CodeRunStatus.swift`, which is the one table for the
// whole product — the column, the toolbar, the page header and the two remote
// canvases all read it, and iOS can reach it too.
//
// What used to live here was only the *value*. The marks were declared
// separately at six other call sites, which is how one window ended up drawing
// a shield, a spinner, a filled dot, a green check, a red exclamation and a
// hollow dot with nothing to relate them and no legend anywhere. There is now
// one circle family, three inks, and `CodeStatusLegend` to read it from.
//
// The old definition is deleted rather than aliased. A `typealias` pointing at
// the new one would be a fourth half-finished migration.

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
                    // Caption-class, not the 7pt it shipped at: 7pt is below
                    // the scale's floor — illegible rather than merely small —
                    // and a frozen `.system(size:)` stayed 7pt at every
                    // accessibility setting. `.caption2` is the smallest rung
                    // the scale allows, and it moves with Dynamic Type.
                    .font(.caption2.weight(.bold))
                    .padding(1)
                    .background(Color.junoSidebar)
                    .clipShape(Circle())
            }
            .foregroundStyle(Color.junoSidebarForeground)

            Text("Add project…")
                .junoRowLabel()
                .junoSecondaryInk()
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
    @Binding var searchText: String
    var searchFocused: FocusState<Bool>.Binding
    var openSettingsModal: (() -> Void)? = nil
    @State private var projectPendingDeletion: ProjectGroup?
    @State private var projectPendingRename: ProjectGroup?
    @State private var projectRenameDraft = ""
    @State private var expandedProjects: Set<WorkspaceID> = []
    /// The footer bar's glass namespace. One container, one participant, one
    /// identity — a loose `.glassEffect` gets inconsistent sampling and no
    /// morphing, which is the failure `GlassEffectContainer` exists to prevent.
    @Namespace private var footerGlass

    static let footerGlassID = "juno.code.sidebar.footer"

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

    /// A project destination keeps repository identity and its session count
    /// together. Session history remains flat in Recent/Pinned above, so the
    /// sidebar never repeats the same run under multiple project disclosures.
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

    /// The compact history for the column. A local session has one home here;
    /// active work lives above it, pinned work lives in Pinned, and projects are
    /// represented by their own rows below. Keeping those sets disjoint is what
    /// stops one session from appearing three times in the same sidebar.
    private func recentRuns(from allRuns: [DesktopCodeRun]) -> [DesktopCodeRun] {
        Array(
            allRuns
                .filter { run in
                    guard !run.status.isActive, !isFavorite(run) else { return false }
                    guard case .session(let id) = run.item,
                          let session = workbench.sessions.first(where: { $0.id == id })
                    else { return false }
                    return session.workspaceID != nil
                }
                .sorted { $0.updatedAt > $1.updatedAt }
                .prefix(10)
        )
    }

    var body: some View {
        let allRuns = runs
        let active = DesktopCodeNavigationState.active(allRuns)
        let groups = projectGroups(from: allRuns)

        return List(selection: $selection) {
            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "magnifyingglass")
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                TextField("Search sessions…", text: $searchText)
                    .textFieldStyle(.plain)
                    .focused(searchFocused)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .junoMetaInk()
                    }
                    .buttonStyle(.plain)
                    .contentShape(.rect)
                    .accessibilityLabel("Clear search")
                } else {
                    Text("⌘K")
                        .junoFont(size: 10, relativeTo: .caption2, weight: .semibold, design: .rounded)
                        .junoMetaInk()
                        .padding(.horizontal, 4)
                        .padding(.vertical, 2)
                        .background(Color.junoRaised.opacity(0.8), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 32)
            .background(Color.junoMuted.opacity(0.45), in: RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 0.5)
            )
            .listRowInsets(EdgeInsets(top: JunoSpace.tight, leading: JunoSpace.snug, bottom: JunoSpace.snug, trailing: JunoSpace.snug))
            .listRowBackground(Color.clear)
            .selectionDisabled()
            .accessibilityIdentifier("juno.code.sidebar-search")

            Section {
                Label {
                    HStack {
                        Text("New task").junoRowLabel()
                        Spacer(minLength: JunoSpace.hairline)
                        Text("⌘N")
                            .junoFont(size: 10, relativeTo: .caption2, weight: .medium, design: .rounded)
                            .junoMetaInk()
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
            }

            if !active.isEmpty {
                Section("Working now") {
                    ForEach(active) { row($0) }
                }
            }

            let pinned = workbench.favoriteSessions.compactMap { session in
                allRuns.first(where: { $0.id == .session(session.id) })
            }.filter { run in
                !active.contains(where: { $0.id == run.id })
            }
            if !pinned.isEmpty {
                Section("Pinned") {
                    ForEach(pinned) { row($0) }
                }
            }

            let recent = recentRuns(from: allRuns)
            if !recent.isEmpty {
                Section("Recent") {
                    ForEach(recent) { row($0) }
                }
            }

            Section("Projects") {
                if groups.isEmpty {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Text("Open a folder to let Juno read and change real files.")
                            .junoCaption()
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
                        projectSummaryRow(group)
                        if expandedProjects.contains(group.workspaceID) {
                            ForEach(group.runs) { run in
                                row(run, nested: true)
                                    .padding(.leading, JunoSpace.cozy)
                            }
                        }
                    }

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
        // to its own top both slid through it. The strip is now laid out above
        // the list rather than inset into it, which is what finally settles the
        // pinned-header note above: the list's own top begins below the strip.
        .junoSidebarProductHeader(product: $product)
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

    /// A project is a destination, not a second session history. Session rows
    /// live in Recent/Pinned above, so this row only answers where work belongs
    /// and how many local runs are available there.
    private func projectSummaryRow(_ group: ProjectGroup) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.fast) {
                    if expandedProjects.contains(group.workspaceID) {
                        expandedProjects.remove(group.workspaceID)
                    } else {
                        expandedProjects.insert(group.workspaceID)
                    }
                }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(expandedProjects.contains(group.workspaceID) ? 90 : 0))
                    .frame(width: 14, height: 18)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .junoSecondaryInk()
            .help(expandedProjects.contains(group.workspaceID) ? "Collapse project" : "Expand project")

            Button {
                selection = .repository(group.workspaceID)
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.projects, size: 15)
                        .junoSidebarMarkInk(selected: selection == .repository(group.workspaceID))
                    Text(group.name)
                        .junoRowLabel()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if group.runs.count > 0 {
                Text(group.runs.count, format: .number)
                    .junoCaption()
            }

            projectMenu(group)
        }
        .junoSidebarRowInk()
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
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
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
        case .allProjects, .draft, .pulls, .connections, .usage, .settings, .design, .task,
            .remote, nil:
            return false
        }
    }

    // MARK: Rows

    /// - Parameter nested: whether this row already sits under its project's own
    ///   row, in which case it drops the facts that row has just stated.
    private func row(_ run: DesktopCodeRun, nested: Bool = false) -> some View {
        // `CodeSessionRow` owns the shape — mark column, two lines, truncation
        // ends, 44pt target, the combined VoiceOver label. This column used to
        // build it by hand, and so did the cloud monitor and the relay list,
        // each with its own metrics.
        CodeSessionRow(
            title: run.title,
            caption: nested ? run.nestedCaption : run.caption,
            status: run.status
        ) {}
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
        case .allProjects, .draft, .pulls, .connections, .usage, .settings, .design, .repository:
            // None reaches this row builder: repositories carry their own menu,
            // and neither the index, the composer, the pull request list nor the
            // design launcher is a run.
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

    /// What the column pins under the list: a transient workspace notice, the
    /// door to Design, and then the account.
    ///
    /// The notice is first because it is news and the account row is furniture —
    /// a "choose the folder again" prompt that appeared *below* the reader's own
    /// name would be reporting an emergency in the quietest place on screen.
    /// Design sits between them for the reason the website puts it there: it is a
    /// destination, so it belongs with the destinations at the bottom rather than
    /// among the runs above, and it is not part of the account block it precedes.
    ///
    /// It is drawn whether or not there is a session, unlike the account rows: the
    /// page it opens reads this Mac's own artifact store, which does not depend on
    /// the four account facts ``DesktopSidebarFooter`` needs to draw anything
    /// coherent.
    /// **The footer is a glass bar, and that is what fixes the overlap.**
    ///
    /// It used to paint nothing at all and rely on the bottom scroll edge
    /// effect to fade the rows sliding under it. That works for a bar one row
    /// tall — the effect fades content across roughly its own inset — and this
    /// footer is three rows and about a hundred points. So the last project row
    /// arrived under the footer still legible, half-transparent and sliced
    /// through the middle of its own glyphs by the row above, which is the
    /// clipped ghost the audit photographed. Nothing was drawing over anything;
    /// nothing was drawing *at all*.
    ///
    /// One `GlassEffectContainer` holding one glass element is the fix, and it
    /// is the right one rather than a convenient one: a pinned bar over
    /// scrolling content is exactly what the material is for, the sidebar is
    /// this window's designated glass layer, and glass carries its own edge so
    /// the bar needs no painted separator. The rows underneath now refract
    /// instead of showing through. The scroll edge effect stays — it is what
    /// softens the handful of points immediately above the bar.
    @ViewBuilder
    private var footer: some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
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
                        // Selection, not a closure out of the window: Usage and
                        // Settings are this column's own destinations, so they are
                        // reached the way every other row here is reached.
                        openUsage: { selection = .usage },
                        openSettings: {
                            if let openSettingsModal {
                                openSettingsModal()
                            } else {
                                selection = .settings
                            }
                        }
                    )
                }
            }
            .frame(maxWidth: .infinity)
            .junoGlass(in: Rectangle())
            .junoGlassID(DesktopCodeSidebar.footerGlassID, in: footerGlass)
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
    @State private var auraState = DesktopChatAuraState()
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

    /// A short set of useful first moves. These are prompts, not decoration:
    /// choosing one fills the real composer so the user can edit the request,
    /// change its contract, and send it through the same path as a typed task.
    private struct LaunchIntent: Identifiable {
        let id: String
        let title: String
        let detail: String
        let prompt: String
        let behavior: AgentBehavior
        let icon: String
        let color: Color
    }

    private var launchIntents: [LaunchIntent] {
        if record == nil {
            return [
                LaunchIntent(
                    id: "scaffold",
                    title: "Scaffold Feature",
                    detail: "Generate components & models",
                    prompt: "Scaffold a new feature with clean architecture, typed data models, robust error handling, and unit tests.",
                    behavior: .code,
                    icon: "sparkles",
                    color: Color.junoAccent
                ),
                LaunchIntent(
                    id: "survey",
                    title: "Codebase Audit",
                    detail: "Analyze patterns & risks",
                    prompt: "Audit this codebase for architectural patterns, performance bottlenecks, and security vulnerabilities.",
                    behavior: .survey,
                    icon: "scope",
                    color: .blue
                ),
                LaunchIntent(
                    id: "refactor",
                    title: "Refactor & Modernize",
                    detail: "Clean debt & improve types",
                    prompt: "Refactor and modernize code to reduce technical debt, improve type safety, and eliminate redundant logic.",
                    behavior: .code,
                    icon: "bolt.fill",
                    color: .orange
                ),
                LaunchIntent(
                    id: "tests",
                    title: "Generate Tests",
                    detail: "Unit, integration & E2E",
                    prompt: "Write comprehensive unit and integration tests covering core workflows, edge cases, and error states.",
                    behavior: .code,
                    icon: "checkmark.seal.fill",
                    color: .green
                ),
                LaunchIntent(
                    id: "troubleshoot",
                    title: "Troubleshoot & Fix",
                    detail: "Trace root cause & patch",
                    prompt: "Diagnose and fix the root cause of this error. Propose the most reliable and minimal patch.",
                    behavior: .ask,
                    icon: "wrench.and.screwdriver.fill",
                    color: .red
                ),
                LaunchIntent(
                    id: "plan",
                    title: "Architecture & Schema",
                    detail: "Design models & contracts",
                    prompt: "Design the data models, database migration schema, and API contracts for this system.",
                    behavior: .plan,
                    icon: "network",
                    color: .purple
                ),
            ]
        }

        return [
            LaunchIntent(
                id: "draft",
                title: "Draft a Feature",
                detail: "Build and implement outcome",
                prompt: "Design and implement this feature from the outcome I describe, keeping the solution focused and maintainable.",
                behavior: .code,
                icon: "hammer.fill",
                color: Color.junoAccent
            ),
            LaunchIntent(
                id: "survey-project",
                title: "Survey Codebase",
                detail: "Map boundaries and risks",
                prompt: "Survey this project: map its entry points, main modules, runtime boundaries, recent changes, and highest-risk unknowns. Use read-only inspection and cite the evidence.",
                behavior: .survey,
                icon: "scope",
                color: .blue
            ),
            LaunchIntent(
                id: "review",
                title: "Review Changes",
                detail: "Spot risks before commit",
                prompt: "Review the current working tree for correctness, regressions, and missing tests. Summarize the highest-value fixes.",
                behavior: .ask,
                icon: "checklist",
                color: .orange
            ),
            LaunchIntent(
                id: "tests",
                title: "Run Test Suite",
                detail: "Check state & fix regressions",
                prompt: "Run the relevant test suite, report failures clearly, and fix failures that are caused by this project.",
                behavior: .code,
                icon: "checkmark.seal.fill",
                color: .green
            ),
            LaunchIntent(
                id: "fix",
                title: "Fix a Bug",
                detail: "Trace root cause & patch",
                prompt: "Find the root cause of this bug, implement a focused fix, and add or update the smallest useful regression test.",
                behavior: .code,
                icon: "ladybug.fill",
                color: .red
            ),
            LaunchIntent(
                id: "explain-project",
                title: "Explain Architecture",
                detail: "Map modules & entry points",
                prompt: "Explain the architecture of this project, its main entry points, and where a new contributor should start.",
                behavior: .ask,
                icon: "text.book.closed.fill",
                color: .purple
            ),
        ]
    }

    var body: some View {
        VStack(spacing: 0) {
            repositoryContextBar
            Divider()

            ZStack {
                DesktopChatAuraLayer(
                    state: auraState,
                    docked: false,
                    viewport: nil
                )
                .allowsHitTesting(false)

                VStack(spacing: JunoSpace.roomy) {
                    VStack(alignment: .center, spacing: JunoSpace.snug) {
                        Image(systemName: "sparkles")
                            .junoFont(size: 26, relativeTo: .title2, weight: .medium)
                            .foregroundStyle(Color.junoAccent)
                            .padding(.bottom, 2)

                        Text(record == nil ? "What do you want to build?" : "What are we working on?")
                            .junoFont(size: 30, relativeTo: .largeTitle, weight: .bold, design: .serif)
                            .junoInk()
                            .multilineTextAlignment(.center)

                        Text(
                            record == nil
                                ? "Autonomous coding tasks in your workspace or on a cloud runner with GitHub review."
                                : "Juno inspects your codebase, plans architectures, generates code, runs tests, and reviews diffs."
                        )
                            .font(.callout)
                            .junoSecondaryInk()
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 580)
                    }
                    .frame(maxWidth: 680, alignment: .center)

                    if trimmedPrompt.isEmpty {
                        launchIntentList
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    if let voiceDock {
                        voiceDock
                    }

                    composer

                    Text(footerNote)
                        .font(.caption2)
                        .junoMetaInk()
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.vertical, JunoSpace.regular)
            }
        }
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: trimmedPrompt.isEmpty
        )
        .onAppear {
            configureModel()
            configureNativeTarget(target)
            focused = true
            syncAura()
        }
        .onChange(of: workbench.availableModels.map(\.modelID)) { _, _ in
            configureModel()
            syncAura()
        }
        .onChange(of: modelID) { _, _ in
            syncAura()
        }
        .onChange(of: reasoningEffort) { _, _ in
            syncAura()
        }
        .onChange(of: focused) { _, next in
            auraState.focused = next
        }
    }

    private func syncAura() {
        auraState.providerID = selectedModel?.catalog?.providerID ?? ""
        auraState.think = JunoProviderGlow.auraThink(
            effort: reasoningEffort.rawValue,
            hasEffortControl: selectedModel?.supportedReasoningEfforts.isEmpty == false
        )
    }

    private var launchIntentList: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: JunoSpace.snug), GridItem(.flexible(), spacing: JunoSpace.snug)], spacing: JunoSpace.snug) {
            ForEach(launchIntents.prefix(4)) { intent in
                Button {
                    apply(intent)
                } label: {
                    HStack(alignment: .top, spacing: JunoSpace.snug) {
                        Image(systemName: intent.icon)
                            .junoFont(size: 13, relativeTo: .body, weight: .semibold)
                            .foregroundStyle(intent.color)
                            .frame(width: 26, height: 26)
                            .background(intent.color.opacity(0.12), in: RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous))

                        VStack(alignment: .leading, spacing: 2) {
                            Text(intent.title)
                                .font(.subheadline.weight(.semibold))
                                .junoInk()
                            Text(intent.detail)
                                .font(.caption)
                                .junoSecondaryInk()
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(JunoSpace.snug)
                    .frame(minWidth: 44, minHeight: 44)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                            .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
                }
                .buttonStyle(.junoPress)
                .accessibilityIdentifier("juno.code.launch-intent.\(intent.id)")
            }
        }
        .frame(maxWidth: 720)
    }

    private func apply(_ intent: LaunchIntent) {
        prompt = intent.prompt
        behavior = intent.behavior
        focused = true
    }

    /// The strip above the launchpad: which project this conversation is in,
    /// what that means, and the way to change it.
    @ViewBuilder
    private var repositoryContextBar: some View {
        if let record {
            CodePageHeader(
                icon: .projects,
                title: record.descriptor.displayName,
                subtitle: (record.descriptor.localPathHint as NSString)
                    .abbreviatingWithTildeInPath,
                subtitleIsPath: true,
                badge: record.descriptor.isGitRepository ? "Git repository" : "Folder"
            ) {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([
                        URL(fileURLWithPath: record.descriptor.localPathHint)
                    ])
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                        .junoFont(size: 14, relativeTo: .body, weight: .medium)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help("Show this repository in Finder")
                .accessibilityLabel("Show repository in Finder")
                .accessibilityIdentifier("juno.code.show-in-finder")
            }
            .accessibilityIdentifier("juno.code.repository-context")
        } else {
            CodePageHeader(
                icon: .projects,
                title: "No project",
                subtitle: "Juno can answer and plan here, but cannot read or change files."
            ) {
                Button(action: addProject) {
                    JunoIconLabel(verbatim: "Open a Project…", icon: .projects, size: 13)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("o", modifiers: [.command])
                .accessibilityIdentifier("juno.code.draft-open-project")
            }
            .accessibilityIdentifier("juno.code.no-project-context")
        }
    }

    /// **One pane of glass, and therefore no seam.**
    ///
    /// This was the window's most visible defect: the destination row was its
    /// own glass element at `JunoRadius.well` (10) and 560pt wide, laid on the
    /// input's glass at `JunoRadius.composer` (26) and 680pt wide, with a
    /// negative gap between them. Two different corner curves met at two
    /// different insets and the join was legible from across the room — the
    /// picker read as a separate box balanced on top of the composer rather
    /// than as its first row.
    ///
    /// ``CodeComposerShell`` is one glass element with the destination row
    /// *inside* it, separated by a hairline. There is no second edge left to
    /// mismatch, and the shape is published as the container shape so nested
    /// chips stay concentric with it.
    private var composer: some View {
        CodeComposerShell(
            // Full-alpha or nothing: `Glass.tint(_:)` honours alpha, so a
            // diluted accent stops establishing a predictable luminance and
            // reads as whatever is behind the window. A drop hover is the
            // composer's one moment of full emphasis.
            tint: isDropTargeted ? Color.junoAccent : nil,
            maxWidth: 720
        ) {
            destinationRow
        } input: {
            composerInput
        } actions: {
            VStack(spacing: JunoSpace.tight) {
                activeConnectorsBar

                HStack(spacing: JunoSpace.snug) {
                    composerAddMenu
                    localControls

                    Spacer(minLength: JunoSpace.cozy)

                    voiceButton
                    sendButton
                }
            }
        }
        .padding(.horizontal, JunoSpace.roomy)
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: target
        )
        .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
            receiveDroppedItems(providers)
            return true
        }
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
                        .junoSecondaryInk()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.bottom, JunoSpace.snug)
                        .transition(.opacity)
                        .accessibilityIdentifier("juno.code.launch-issue")
                }
            }
        }
    }

    /// Where this run will happen — the composer's first row, inside the
    /// composer's own glass.
    ///
    /// Run location is a per-conversation control sitting directly under the
    /// prompt rather than a global setting in a preferences window, because it
    /// is a decision about *this* task: the same reader wants a throwaway
    /// question answered on this Mac and a long refactor dispatched to the
    /// cloud, ten seconds apart.
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
                CodeContextSeparator()
                targetMenu
            }

            if target != .local {
                CodeContextSeparator()
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
                    .junoSecondaryInk()
                    .transition(.opacity)
                    .id(target)
            } else {
                Image(systemName: target.symbol)
                    .junoSecondaryInk()
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
            // Same rule as `destinationIdentity`: the web's project chip is
            // `text-muted-foreground` and the coral in this row belongs to the
            // send button at the other end of it.
            CodeContextChipLabel(
                destinationTitle,
                icon: record == nil ? .conversation : .projects
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(minWidth: 44, minHeight: 44)
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
            CodeContextChipLabel(target.label, systemImage: target.symbol)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
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

    private struct DevToolOption: Identifiable {
        let id: String
        let name: String
        let icon: String
    }

    private var defaultDevTools: [DevToolOption] {
        [
            DevToolOption(id: "github", name: "GitHub", icon: "arrow.triangle.branch"),
            DevToolOption(id: "terminal", name: "Terminal", icon: "terminal"),
            DevToolOption(id: "postgres", name: "PostgreSQL", icon: "cylinder.split.1x2"),
            DevToolOption(id: "web_search", name: "Web Search", icon: "globe"),
            DevToolOption(id: "linear", name: "Linear", icon: "checklist"),
            DevToolOption(id: "slack", name: "Slack", icon: "bubble.left.and.bubble.right"),
        ]
    }

    private func connectorIcon(for id: String) -> String {
        switch id {
        case "github": return "arrow.triangle.branch"
        case "terminal": return "terminal"
        case "postgres": return "cylinder.split.1x2"
        case "web_search": return "globe"
        case "linear": return "checklist"
        case "slack": return "bubble.left.and.bubble.right"
        default: return "network"
        }
    }

    private func connectorName(for id: String) -> String {
        if let found = defaultDevTools.first(where: { $0.id == id }) {
            return found.name
        }
        if let found = connectedConnectors.first(where: { $0.id == id }) {
            return found.label
        }
        return id.capitalized
    }

    private func connectorChip(for connectorID: String) -> some View {
        let name = connectorName(for: connectorID)
        let icon = connectorIcon(for: connectorID)
        return Button {
            selectedConnectors.remove(connectorID)
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: icon)
                    .font(.caption2)
                Text(name)
                    .font(.caption2.weight(.medium))
                Image(systemName: "xmark")
                    .junoFont(size: 9, relativeTo: .caption2, weight: .bold)
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.hairline + 2)
            .background(
                Color.junoRaised.opacity(0.8),
                in: Capsule()
            )
            .overlay(
                Capsule().stroke(Color.junoHairline, lineWidth: 0.5)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove \(name)")
    }

    @ViewBuilder
    private var activeConnectorsBar: some View {
        if !selectedConnectors.isEmpty {
            let sortedIDs = Array(selectedConnectors).sorted()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: JunoSpace.tight) {
                    ForEach(sortedIDs, id: \.self) { connectorID in
                        connectorChip(for: connectorID)
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.bottom, JunoSpace.tight)
            }
        }
    }

    private var connectorsMenuButton: some View {
        Menu {
            Section("Developer Tools & Integrations") {
                ForEach(defaultDevTools) { tool in
                    Button {
                        toggleConnector(tool.id)
                    } label: {
                        HStack {
                            Label(tool.name, systemImage: tool.icon)
                            if selectedConnectors.contains(tool.id) {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }

            if !connectedConnectors.isEmpty {
                Divider()
                Section("Connected Services") {
                    ForEach(connectedConnectors) { connector in
                        Button {
                            toggleConnector(connector.id)
                        } label: {
                            HStack {
                                Text(connector.label)
                                if selectedConnectors.contains(connector.id) {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "network")
                    .junoFont(size: 13, relativeTo: .caption, weight: .medium)
                Text(selectedConnectors.isEmpty ? "Connectors" : "Connectors (\(selectedConnectors.count))")
                    .font(.caption)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(selectedConnectors.isEmpty ? Color.secondary : Color.junoAccent)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(minHeight: CodeRowMetrics.minHeight)
            .background(
                selectedConnectors.isEmpty ? Color.junoMuted.opacity(0.4) : Color.junoAccent.opacity(0.12),
                in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
            )
            .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Toggle developer tools and active connectors")
        .accessibilityIdentifier("juno.code.composer.connectors-menu")
    }

    private var localControls: some View {
        HStack(spacing: JunoSpace.snug) {
            connectorsMenuButton

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
            ForEach(AgentBehavior.allCases, id: \.self) { value in
                Button {
                    selectContract(value)
                } label: {
                    contractMenuItem(
                        AgentBehaviorLabel.text(for: value),
                        systemImage: AgentBehaviorLabel.glyph(for: value),
                        selected: behavior == value
                    )
                }
            }

            Divider()

            ForEach(PermissionMode.allCases, id: \.self) { value in
                Button {
                    selectContract(value)
                } label: {
                    contractMenuItem(
                        PermissionModeLabel.text(for: value),
                        systemImage: PermissionModeLabel.glyph(for: value),
                        selected: permissionMode == value
                    )
                }
                .disabled(behavior != .code || record == nil)
            }
            // A permission level governs tools, and a conversation with no
            // project has none. `SessionController` pins such a session to
            // read-only regardless; naming a level here that the session will
            // not use would be the composer claiming a power it does not have.
            .disabled(behavior != .code || record == nil)
        } label: {
            CodeContextChipLabel(
                contractTitle,
                systemImage: contractSymbol,
                // The one place this row spends hue: full access is the
                // contract where Juno stops asking, and that is worth saying
                // in a colour.
                tint: permissionMode == .fullAccess && record != nil
                    ? Color.junoCaution : nil
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Choose whether Juno answers, plans, or edits—and when it asks")
        .accessibilityLabel("Access")
        .accessibilityValue(contractTitle)
        .accessibilityIdentifier("juno.code.launch-contract")
    }

    /// A menu selection can arrive while AppKit is still closing the menu
    /// window. The contract label and footer both change for Full access, so a
    /// synchronous state write makes SwiftUI lay out the anchor during that
    /// dismissal and can crash in `NSPopover`/ViewBridge. Yield one main-actor
    /// turn so the native menu is gone before the draft is relaid out.
    private func selectContract(_ value: AgentBehavior) {
        Task { @MainActor in
            await Task.yield()
            behavior = value
        }
    }

    private func selectContract(_ value: PermissionMode) {
        Task { @MainActor in
            await Task.yield()
            permissionMode = value
        }
    }

    @ViewBuilder
    private func contractMenuItem(
        _ title: String,
        systemImage: String,
        selected: Bool
    ) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer(minLength: JunoSpace.regular)
            if selected {
                Image(systemName: "checkmark")
                    .accessibilityHidden(true)
            }
        }
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
                .junoFont(size: 16, relativeTo: .body, weight: .medium)
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
        .frame(minWidth: 44, minHeight: 44)
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
                                        .junoSecondaryInk()
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
                                    .foregroundStyle(Color.junoOnAccent, Color.junoMutedForeground)
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
                .junoFont(size: 15, relativeTo: .body, weight: .medium)
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
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.junoOnAccent, Color.junoMutedForeground)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove (path.lastComponent)")
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 44)
        // A flat quiet fill, not glass: this chip lives *inside* the composer's
        // glass, and a second pane of glass inside a glass surface flattens
        // both back into translucent rounded rectangles — the same reason the
        // workspace's Stop button is plain inside its pill. `junoMuted` is the
        // resting-chip fill by definition; the diluted `primary.opacity(0.05)`
        // glass tint this replaces was also the one thing `Glass.tint(_:)`
        // must never be given.
        .background(
            Color.junoMuted,
            in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
        )
        .help("Attached file (path.value)")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached file (path.value)")
    }

    /// **One microphone.**
    ///
    /// The composer used to end in two of them: a quiet `mic` for dictation and,
    /// immediately to its right, a coral `waveform` orb for voice mode. Two
    /// adjacent microphone glyphs, one of them the loudest thing in the window,
    /// and nothing on either saying which one talks to Juno and which one types
    /// for you.
    ///
    /// So there is one mark for speaking, and it owns both ways of doing it.
    /// Pressing it dictates — the common case, and the one that leaves the
    /// reader's words in the composer where they can still edit them. The menu
    /// beside it starts a voice conversation, which is a different thing and is
    /// now named as one instead of being inferred from an orb. `primaryAction:`
    /// is the platform's own control for exactly this shape: a button that also
    /// has a menu.
    ///
    /// The accent circle to its right no longer morphs. It is Send, always —
    /// see ``sendButton``.
    @ViewBuilder
    private var voiceButton: some View {
        let canDictate = JunoSpeechService.isSupported
        let canConverse = beginVoice != nil && !modelID.isEmpty

        if canDictate || canConverse {
            Menu {
                if canDictate {
                    Button {
                        startDictation()
                    } label: {
                        Label("Dictate into the composer", systemImage: "mic")
                    }
                }
                if let beginVoice {
                    Button {
                        beginVoice(modelID)
                    } label: {
                        Label("Start a voice conversation", systemImage: "waveform")
                    }
                    .disabled(modelID.isEmpty)
                }
            } label: {
                Image(systemName: "mic")
                    .font(.body)
                    // The ramp has three rungs and no in-betweens: a hand-mixed
                    // `primary.opacity(0.76)` was a fourth ink no other control
                    // used. Secondary is the rung for a quiet neutral control.
                    .junoSecondaryInk()
                    // 44pt of target under a 34pt mark, because a control this
                    // small beside the send button is one the pointer misses.
                    .frame(width: 44, height: 44)
                    .contentShape(.circle)
            } primaryAction: {
                if canDictate {
                    startDictation()
                } else if let beginVoice {
                    beginVoice(modelID)
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(canDictate ? "Dictate, or start a voice conversation" : "Start a voice conversation")
            .accessibilityLabel("Voice")
            .accessibilityIdentifier("juno.code.composer.voice")
        }
    }

    private func startDictation() {
        focused = false
        withAnimation(JunoMotion.fast) { dictating = true }
    }

    /// The composer's one primary action, and the only tinted thing in it.
    ///
    /// It used to morph into a voice orb whenever the prompt was empty, which
    /// meant the single most emphatic control in the window changed what it did
    /// depending on whether the reader had typed anything — and put a second
    /// microphone next to the first. Send is now Send: present in every state,
    /// tinted only when there is something to send, in one position the pointer
    /// never has to re-find.
    private var sendButton: some View {
        Button(action: send) {
            Group {
                if isStartingLocal || code.isMutating {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        // The named rung Chat's send arrow uses — callout
                        // bold is the same 12pt at the default setting,
                        // and it moves with Dynamic Type.
                        .font(.callout.weight(.bold))
                }
            }
            // On-accent, not `junoForeground`: the glyph sits on the
            // accent-tinted glass, and canvas ink there is the contrast
            // failure the on-accent token exists to prevent.
            .foregroundStyle(canSend ? Color.junoOnAccent : Color.junoMutedForeground)
            // 44, not the 30 it shipped at. `accentGlassAction` puts the glass
            // on the button itself, so the label's frame *is* the target: a
            // 30pt circle is below the minimum in a row where the two controls
            // beside it are menus.
            .frame(width: 44, height: 44)
            .contentShape(.circle)
        }
        .accentGlassAction(active: canSend)
        .disabled(!canSend)
        .help("Start this task (Return)")
        .accessibilityLabel("Start task")
        .accessibilityIdentifier("juno.code.launch-send")
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
    /// Whether the folder grants are still being reopened.
    ///
    /// The page used to have one state — the list — and answered both "still
    /// opening" and "you have none" with the same empty poster, so a reader
    /// whose grants were mid-restore was told they had no projects. Loading,
    /// empty and broken are three different sentences and now read as three.
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
                // Skeleton cards at the real card geometry, not a spinner: the
                // rows that are coming have a known shape, so claiming it is
                // both honest and stops the page jumping when they land.
                JunoDetailPage(maxWidth: 820) {
                    CodeLoadingList(count: 4, label: "Opening your projects")
                }
            } else if let error = workbench.lastError, workbench.workspaces.isEmpty {
                // Broken, with the reason and the recovery. A lapsed folder
                // grant is the one failure that makes Juno Code unusable end to
                // end — no workspace opens, so no session starts — and it is
                // fixed only by the reader picking the folder again.
                CodeErrorState(
                    title: "Juno could not open your projects",
                    reason: error,
                    retryTitle: workbench.workspaceNeedingAccess == nil
                        ? "Add Project…" : "Choose Folder Again…",
                    retry: addProject
                )
            } else if workbench.workspaces.isEmpty {
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
        .junoCard(cornerRadius: JunoRadius.card)
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
