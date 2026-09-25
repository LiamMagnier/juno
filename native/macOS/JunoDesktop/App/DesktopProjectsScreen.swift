import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// **Projects** — the web's `/projects` on the page template (Phase 4 A5).
///
/// "Projects", its lede, and New project; a controls row with the search,
/// All / Pinned with counts, the sort and "{n} of {m}"; then the tiles, 1 / 2 /
/// 3 across at 640 / 1024 of the page. A tile opens its project on this
/// destination's stack (``DesktopProjectPage``), and the system's back button
/// returns. New project is withheld from the header while the page is loading
/// or empty, because the empty state carries it as the page's one prominent
/// button.
struct DesktopProjectsScreen: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    /// A project file's bytes, for the covers.
    var fileAccess: ((String) async -> NativeProjectFileAccess?)?
    /// `POST /api/projects` for a project with no name (the server names it
    /// from its first chat); nil keeps the name required.
    var createUnnamed: (() async -> String?)?

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Filter: Hashable { case all, pinned }

    @State private var query = ""
    @State private var filter = Filter.all
    @AppStorage("juno.desktop.projects.sort") private var storedSort = DesktopProjectSort.updated.rawValue
    @State private var showingNewProject = false
    @State private var renaming: JunoRenameRequest?
    @State private var confirmation: JunoConfirmation?
    @State private var dealt = false

    private var sort: DesktopProjectSort { DesktopProjectSort(rawValue: storedSort) ?? .updated }

    private var summaries: [DesktopProjectSummary] {
        model.projects.map { DesktopProjectSummary(project: $0, model: model) }
    }

    private var visible: [DesktopProjectSummary] {
        DesktopProjectListing.visible(summaries, query: query, pinnedOnly: filter == .pinned, sort: sort)
    }

    private var isLoading: Bool {
        model.projects.isEmpty && (model.phase == .idle || model.phase == .loading)
    }

    private var failed: Bool {
        if case .failed = model.phase { return model.projects.isEmpty }
        return false
    }

    private var isEmpty: Bool { !isLoading && !failed && model.projects.isEmpty }

    var body: some View {
        JunoPage(measure: .wide, scrolling: .page) {
            JunoPageHeader("Projects", lede: "A topic’s chats, instructions, and files, kept together.") {
                if !isLoading, !isEmpty, !failed {
                    Button {
                        showingNewProject = true
                    } label: {
                        Label("New project", icon: .plus)
                    }
                        .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                }
            }
        } controls: {
            if !isLoading, !failed, !isEmpty {
                controls
            }
        } content: {
            content
        }
        .sheet(isPresented: $showingNewProject) {
            DesktopNewProjectSheet(model: model, createUnnamed: createUnnamed) { id in
                push(.project(id))
            }
        }
        .junoRenameSheet($renaming)
        .junoConfirmation($confirmation)
        .onChange(of: isLoading) { _, loading in if !loading { dealt = true } }
    }

    // MARK: Controls

    private var controls: some View {
        JunoPageControls {
            JunoPageSearchField(text: $query, prompt: "Search projects…")
            JunoSegmented(
                options: [
                    .init(Filter.all, "All", count: model.projects.count),
                    .init(Filter.pinned, "Pinned", count: model.projects.filter(\.starred).count),
                ],
                selection: $filter,
                accessibilityLabel: "Filter projects"
            )
            JunoPageMenu(
                options: DesktopProjectSort.allCases.map { JunoPageMenuOption($0, $0.label, menuTitle: $0.menuTitle) },
                selection: Binding(get: { sort }, set: { storedSort = $0.rawValue }),
                accessibilityLabel: "Sort projects"
            )
        } trailing: {
            Text("\(visible.count) of \(model.projects.count)")
                .junoType(.ui)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize()
                .accessibilityLabel("\(visible.count) of \(model.projects.count) projects")
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if failed {
            JunoEmptyState(
                title: "Couldn’t load your projects",
                message: "Check your connection and try once more.",
                icon: .triangleAlert,
                actionLabel: "Try again",
                action: { Task { await model.reload() } },
                tone: .error
            )
        } else if isLoading {
            DesktopProjectSkeletonGrid()
        } else if isEmpty {
            JunoEmptyState(
                title: "No projects yet",
                message: "Create one to keep a topic’s chats, instructions, and files together.",
                icon: .projects
            ) {
                Button {
                    showingNewProject = true
                } label: {
                    Label("New project", icon: .plus)
                }
                    .contentShape(.rect)
                .buttonStyle(.junoProminent)
            }
        } else if visible.isEmpty {
            JunoEmptyState(
                title: "No matching projects",
                message: filter == .pinned && query.trimmingCharacters(in: .whitespaces).isEmpty
                    ? "Pin a project to see it here."
                    : "Try another search term.",
                icon: .search,
                size: .panel
            ) {
                Button("Clear filters") {
                    query = ""
                    filter = .all
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentShape(.rect)
            }
        } else {
            DesktopPageLayoutReader { layout in
                grid(width: layout.pageWidth)
            }
        }
    }

    private func grid(width: CGFloat) -> some View {
        let columns = width >= 1_024 ? 3 : (width >= 640 ? 2 : 1)
        return LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.regular, alignment: .top), count: columns),
            alignment: .leading,
            spacing: JunoSpace.regular
        ) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, summary in
                DesktopProjectTile(
                    summary: summary,
                    cover: coverLoader(summary),
                    open: { push(.project(summary.id)) },
                    togglePin: { togglePin(summary.project) }
                ) {
                    projectActions(summary.project)
                }
                .junoDealt(index: index, active: !dealt, reduceMotion: reduceMotion)
            }
        }
    }

    private func coverLoader(_ summary: DesktopProjectSummary) -> (() async -> NativeProjectFileAccess?)? {
        guard let fileAccess, let cover = summary.cover else { return nil }
        return { await fileAccess(cover.id) }
    }

    // MARK: Actions

    @ViewBuilder
    private func projectActions(_ project: NativeProject) -> some View {
        Button(project.starred ? "Unpin" : "Pin") { togglePin(project) }
            .contentShape(.rect)
        Button("Rename…") { rename(project) }
            .contentShape(.rect)
        Divider()
        Button("Delete…", role: .destructive) { confirmDelete(project) }
            .contentShape(.rect)
    }

    private func togglePin(_ project: NativeProject) {
        Task {
            await model.updateProject(id: project.id, starred: !project.starred)
            if model.lastErrorDescription != nil { toast(.error("Couldn’t update project pin.")) }
        }
    }

    private func rename(_ project: NativeProject) {
        renaming = DesktopProjectActions.rename(project, model: model, toast: toast)
    }

    private func confirmDelete(_ project: NativeProject) {
        confirmation = DesktopProjectActions.delete(project, model: model, toast: toast) {}
    }
}

// MARK: - Shared project actions

/// The words and the writes every project surface shares: the list's tiles
/// and the project page's header.
@MainActor
enum DesktopProjectActions {
    static func rename(
        _ project: NativeProject,
        model: NativeProjectModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier
    ) -> JunoRenameRequest {
        JunoRenameRequest(
            title: "Rename project",
            message: "Change the name of this project.",
            fieldLabel: "Project name",
            confirmTitle: "Rename Project",
            current: project.name,
            maximumLength: 160
        ) { name in
            await model.updateProject(id: project.id, name: name)
            if model.lastErrorDescription != nil {
                toast(.error("Couldn’t rename project."))
                return false
            }
            return true
        }
    }

    static func delete(
        _ project: NativeProject,
        model: NativeProjectModel<SQLiteAccountRepository>,
        toast: JunoToastNotifier,
        deleted: @escaping @MainActor () -> Void
    ) -> JunoConfirmation {
        JunoConfirmation(
            title: "Delete this project?",
            message: "Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.",
            confirmTitle: "Delete Project"
        ) {
            Task {
                deleted()
                await model.deleteProject(id: project.id)
                if model.lastErrorDescription != nil {
                    toast(.error("Couldn’t delete project."))
                } else {
                    toast(.success("Project deleted."))
                }
            }
        }
    }
}

// MARK: - Listing rules

/// The web's three sorts (`projects/page.tsx`).
enum DesktopProjectSort: String, CaseIterable, Hashable {
    case updated, name, chats

    var label: String {
        switch self {
        case .updated: "Last updated"
        case .name: "Name"
        case .chats: "Most chats"
        }
    }

    var menuTitle: String {
        switch self {
        case .updated: "Last Updated"
        case .name: "Name"
        case .chats: "Most Chats"
        }
    }
}

/// One project as the list and the page count it: its chats, its sources
/// (the cover excluded), and the cover.
struct DesktopProjectSummary: Identifiable, Equatable {
    /// The project's picture is its file named `__cover__`
    /// (`src/app/api/projects/route.ts`). Never a source, never counted.
    static let coverFileName = "__cover__"

    let project: NativeProject
    let chatCount: Int
    let sources: [NativeProjectFile]
    let cover: NativeProjectFile?

    var id: String { project.id }

    init(project: NativeProject, chatCount: Int, files: [NativeProjectFile]) {
        self.project = project
        self.chatCount = chatCount
        sources = files.filter { $0.fileName != Self.coverFileName }
        cover = files.first { $0.fileName == Self.coverFileName }
    }

    @MainActor
    init(project: NativeProject, model: NativeProjectModel<SQLiteAccountRepository>) {
        self.init(
            project: project,
            chatCount: model.conversationsByProject[project.id]?.count ?? 0,
            files: model.filesByProject[project.id] ?? []
        )
    }

    /// The instructions as the web's tile reads them (`promptPreview`): the
    /// section tags stripped, whitespace collapsed, for a two-line clamp.
    var instructionsPreview: String {
        JunoPromptPreview.text(project.instructions, fallback: "No instructions yet.")
    }
}

/// The list's filtering and sorting, apart from the view so it can be tested.
enum DesktopProjectListing {
    /// The search matches name and instructions (the web's filter); Pinned
    /// keeps the pinned; the sort breaks every tie on the id.
    static func visible(
        _ summaries: [DesktopProjectSummary],
        query: String,
        pinnedOnly: Bool,
        sort: DesktopProjectSort
    ) -> [DesktopProjectSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return summaries
            .filter { !pinnedOnly || $0.project.starred }
            .filter {
                needle.isEmpty
                    || $0.project.name.localizedCaseInsensitiveContains(needle)
                    || $0.project.instructions.localizedCaseInsensitiveContains(needle)
            }
            .sorted { lhs, rhs in
                switch sort {
                case .updated:
                    if lhs.project.updatedAt != rhs.project.updatedAt { return lhs.project.updatedAt > rhs.project.updatedAt }
                case .name:
                    let order = lhs.project.name.localizedStandardCompare(rhs.project.name)
                    if order != .orderedSame { return order == .orderedAscending }
                case .chats:
                    if lhs.chatCount != rhs.chatCount { return lhs.chatCount > rhs.chatCount }
                }
                return lhs.id < rhs.id
            }
    }
}

// MARK: - The tile

/// A project tile: a 36pt inset (the cover, or the folder), the name, two
/// lines of instructions, and a footer over the chat and source counts and
/// "Updated {ago}". Pin and More wait for the pointer — except a pinned
/// project's pin, which stays: the page's signature detail.
struct DesktopProjectTile<MenuContent: View>: View {
    let summary: DesktopProjectSummary
    let cover: (() async -> NativeProjectFileAccess?)?
    let open: () -> Void
    let togglePin: () -> Void
    @ViewBuilder let menu: () -> MenuContent

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                DesktopProjectInset(cover: cover, coverID: summary.cover?.id, hovering: hovering)
                Spacer(minLength: 0)
                HStack(spacing: 0) {
                    pinButton
                        .opacity(summary.project.starred || hovering ? 1 : 0)
                    moreMenu
                        .opacity(hovering ? 1 : 0)
                }
            }
            Text(summary.project.name)
                .junoType(.ui)
                .fontWeight(.medium)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.top, JunoSpace.cozy)
            // Two lines, always: a hidden two-line run holds the room, so a
            // one-line project's tile is as tall as its neighbour's.
            ZStack(alignment: .topLeading) {
                Text(verbatim: "M\nM")
                    .hidden()
                    .accessibilityHidden(true)
                Text(summary.instructionsPreview)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, JunoSpace.tight)
            Rectangle()
                .fill(Color.junoBorder.opacity(0.7))
                .frame(height: 1)
                .padding(.top, JunoSpace.regular)
                .accessibilityHidden(true)
            HStack(spacing: JunoSpace.cozy) {
                count(.chats, summary.chatCount, summary.chatCount == 1 ? "chat" : "chats")
                count(.file, summary.sources.count, summary.sources.count == 1 ? "source" : "sources")
                Spacer(minLength: 0)
                Text("Updated \(DesktopRelativeTime.short(summary.project.updatedAt))")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            .padding(.top, JunoSpace.snug)
        }
        .padding(JunoSpace.regular)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(hovering ? Color.junoHover : Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .contentShape(.rect(cornerRadius: JunoRadius.card))
        .onTapGesture(perform: open)
        .desktopKeyboardOpen(open)
        .onHover { hovering = $0 }
        .contextMenu { menu() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary.project.name)
        .accessibilityValue("\(summary.chatCount) chats, \(summary.sources.count) sources\(summary.project.starred ? ", pinned" : "")")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open", open)
        .accessibilityAction(named: summary.project.starred ? "Unpin" : "Pin", togglePin)
    }

    private var pinButton: some View {
        Button(action: togglePin) {
            JunoIconView(.pin, size: 16, isOn: summary.project.starred)
                .foregroundStyle(summary.project.starred ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help(summary.project.starred ? "Unpin project" : "Pin project")
        .accessibilityLabel(summary.project.starred ? "Unpin project" : "Pin project")
    }

    private var moreMenu: some View {
        Menu {
            menu()
        } label: {
            JunoIconView(.ellipsis, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .help("More actions for \(summary.project.name)")
        .accessibilityLabel("More actions for \(summary.project.name)")
    }

    private func count(_ icon: JunoIcon, _ value: Int, _ noun: String) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 12)
                .accessibilityHidden(true)
            Text("\(value)")
                .monospacedDigit()
        }
        .junoType(.caption)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value) \(noun)")
    }
}

/// The 36pt inset: the cover when there is one, the folder otherwise. The
/// glyph steps from the secondary ink to the foreground under the pointer.
struct DesktopProjectInset: View {
    let cover: (() async -> NativeProjectFileAccess?)?
    let coverID: String?
    var hovering = false
    var side: CGFloat = 36

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                JunoIconView(.projects, size: 16)
                    .foregroundStyle(hovering ? Color.junoForeground : Color.junoSecondaryInk)
            }
        }
        .frame(width: side, height: side)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .accessibilityHidden(true)
        .task(id: coverID) {
            guard let cover, coverID != nil else {
                image = nil
                return
            }
            let data = await DesktopLibraryUploads.bytes(await cover())
            let picture = data.flatMap(NSImage.init(data:))
            withAnimation(JunoMotion.fast) { image = picture }
        }
    }
}

/// "2h ago", "3d ago", the web's `timeAgo`.
enum DesktopRelativeTime {
    static func short(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days < 30 { return "\(days)d ago" }
        let months = days / 30
        if months < 12 { return "\(months)mo ago" }
        return "\(days / 365)y ago"
    }
}

/// Loading, shaped like the tiles.
private struct DesktopProjectSkeletonGrid: View {
    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.regular), count: 2),
            spacing: JunoSpace.regular
        ) {
            ForEach(0..<4, id: \.self) { _ in
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                        .frame(width: 36, height: 36)
                    Capsule().fill(Color.junoSecondary).frame(width: 160, height: 10)
                    Capsule().fill(Color.junoSecondary).frame(height: 8)
                    Capsule().fill(Color.junoSecondary).frame(width: 200, height: 8)
                }
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
            }
        }
        .opacity(dimmed ? 0.55 : 1)
        .animation(
            JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe), when: reduceMotion),
            value: dimmed
        )
        .onAppear { if !reduceMotion { dimmed = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading projects")
    }
}

// MARK: - New project

/// New project, in the web's words: a name that may be left blank, for Juno
/// to name from the first chat.
struct DesktopNewProjectSheet: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    /// Creates a project with no name on the server; nil keeps the name
    /// required (the sync mutation needs one).
    let createUnnamed: (() async -> String?)?
    let created: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var creating = false
    @State private var failure: String?

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canCreate: Bool { !creating && (!trimmed.isEmpty || createUnnamed != nil) }

    var body: some View {
        DesktopNewProjectSheetBody(
            name: $name,
            failure: failure,
            canCreate: canCreate,
            creating: creating,
            cancel: { dismiss() },
            create: create
        )
    }

    private func create() {
        guard canCreate else { return }
        creating = true
        failure = nil
        Task {
            let id: String?
            if trimmed.isEmpty, let createUnnamed {
                id = await createUnnamed()
            } else {
                id = await model.createProject(name: trimmed)
            }
            creating = false
            guard let id else {
                failure = model.lastErrorDescription ?? "Juno couldn’t create this project."
                return
            }
            dismiss()
            created(id)
        }
    }
}

/// The sheet's body, apart so the snapshot harness can draw it.
struct DesktopNewProjectSheetBody: View {
    @Binding var name: String
    let failure: String?
    let canCreate: Bool
    let creating: Bool
    let cancel: () -> Void
    let create: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("New project")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Name it, or leave it blank and Juno will name it from your first chat.")
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Project name (optional)")
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                TextField("Leave blank to auto-name it", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(create)
                    .accessibilityLabel("Project name (optional)")
                if let failure {
                    Text(failure)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoDestructiveInk)
                }
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Cancel", action: cancel)
                    .contentShape(.rect)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                Button(creating ? "Creating…" : "Create Project", action: create)
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 440)
        .onAppear { focused = true }
    }
}
