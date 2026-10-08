import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

/// One project — the web's `/projects/{id}`, pushed onto the Projects stack
/// (Phase 4 A5).
///
/// A caption ("Project"), the name, and one line of counts; Instructions, a
/// pin and More. Then the tabs: Overview, Tasks (when there are any), Sources
/// and Settings. The Overview's rail — Instructions, Sources, Memory — sits
/// level with the field you type into: the page's signature detail, because
/// those are what Juno reads before it answers here.
struct DesktopProjectPage: View {
    let projectID: String
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    var workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
    var workModel: NativeWorkModel?
    var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    var modelCatalog: [NativeChatModelOption] = []
    var fileAccess: ((String) async -> NativeProjectFileAccess?)?
    let openConversation: (String) -> Void
    /// A new chat in this project, with its first words.
    let startConversation: (String) -> Void
    var openMemory: (() -> Void)?
    /// The tab the page opens on (the snapshot harness's; otherwise the one
    /// remembered for this project).
    var initialTab: DesktopProjectTab?

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @Environment(\.dismiss) private var dismiss

    @State private var tab: DesktopProjectTab = .overview
    @State private var renaming: JunoRenameRequest?
    @State private var confirmation: JunoConfirmation?
    @State private var editingInstructions = false
    @State private var choosingCover = false
    @State private var choosingSources = false
    @State private var deleting: NativeProject?
    @State private var moving = false

    private var project: NativeProject? { model.projects.first { $0.id == projectID } }

    private var summary: DesktopProjectSummary? {
        project.map { DesktopProjectSummary(project: $0, model: model) }
    }

    private var chats: [NativeProjectConversation] {
        (model.conversationsByProject[projectID] ?? []).sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    private var tasks: [WorkSessionSummary] {
        (workModel?.sessions ?? []).filter { $0.projectID == projectID && !$0.archived }
    }

    private var artifacts: [NativeArtifact] {
        let ids = Set(chats.map(\.id))
        return (artifactModel?.artifacts ?? []).filter { ids.contains($0.conversationID) }
    }

    private var tabs: [DesktopProjectTab] {
        DesktopProjectTab.visible(taskCount: tasks.count)
    }

    var body: some View {
        Group {
            if let project, let summary {
                page(project, summary)
            } else {
                JunoEmptyState(
                    title: "Project not found",
                    message: "It may have been deleted on another device.",
                    icon: .projects
                )
            }
        }
        .navigationTitle(project?.name ?? "Project")
        .onAppear {
            tab = initialTab ?? DesktopProjectTab.remembered(for: projectID) ?? .overview
            if !tabs.contains(tab) { tab = .overview }
        }
        .onChange(of: tab) { _, value in DesktopProjectTab.remember(value, for: projectID) }
    }

    private func page(_ project: NativeProject, _ summary: DesktopProjectSummary) -> some View {
        JunoPage(measure: .wide, scrolling: .page) {
            JunoPageHeader(project.name, caption: "Project", lede: lede(summary)) {
                Button {
                    editingInstructions = true
                } label: {
                    Label("Instructions", icon: .compose)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                Button {
                    togglePin(project)
                } label: {
                    JunoIconView(.pin, size: 16, isOn: project.starred)
                        .foregroundStyle(project.starred ? Color.junoForeground : Color.junoSecondaryInk)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help(project.starred ? "Unpin project" : "Pin project")
                .accessibilityLabel(project.starred ? "Unpin project" : "Pin project")
                headerMore(project, summary)
            }
        } controls: {
            let crumbs = model.breadcrumbs(for: project.id)
            if !crumbs.isEmpty {
                DesktopProjectBreadcrumbs(crumbs: crumbs, current: project.name)
                    .padding(.bottom, JunoSpace.tight)
            }
            JunoSegmented(
                options: tabs.map { tab in
                    JunoSegmented<DesktopProjectTab>.Option(tab, tab.label, count: count(for: tab, summary))
                },
                selection: $tab,
                accessibilityLabel: "Project sections",
                fills: false
            )
            .padding(.bottom, JunoPageMetrics.controlsGap)
        } content: {
            switch tab {
            case .overview: overview(project, summary)
            case .tasks: tasksTab
            case .sources: sourcesTab(project, summary)
            case .settings: settingsTab(project)
            }
        }
        .junoRenameSheet($renaming)
        .junoConfirmation($confirmation)
        .desktopProjectDelete($deleting, model: model) { dismiss() }
        .sheet(isPresented: $moving) {
            DesktopMoveProjectSheet(projectID: project.id, model: model)
        }
        .task(id: project.id) { await model.loadFolderDetail(id: project.id) }
        .sheet(isPresented: $editingInstructions) {
            DesktopProjectInstructionsSheet(project: project) { instructions in
                await model.updateProject(id: project.id, instructions: instructions)
                if model.lastErrorDescription == nil {
                    toast(.success("Project instructions saved."))
                    return true
                }
                toast(.error("Couldn’t save. Your text is still here, so check your connection and try again."))
                return false
            }
        }
        .fileImporter(isPresented: $choosingCover, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { setCover(url, summary: summary) }
        }
        .fileImporter(isPresented: $choosingSources, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { addSources(urls) }
        }
    }

    /// "{n} chats · {n} sources[ · {n} tasks] · Updated {ago}", in SF with
    /// tabular digits (register #58). Sources are files and artifacts, as the
    /// web's header counts them and as the Sources tab lists them.
    private func lede(_ summary: DesktopProjectSummary) -> String {
        let sources = summary.sources.count + artifacts.count
        var parts = [
            "\(summary.chatCount) \(summary.chatCount == 1 ? "chat" : "chats")",
            "\(sources) \(sources == 1 ? "source" : "sources")",
        ]
        if !tasks.isEmpty { parts.append("\(tasks.count) \(tasks.count == 1 ? "task" : "tasks")") }
        parts.append("Updated \(DesktopRelativeTime.short(summary.project.updatedAt))")
        return parts.joined(separator: " · ")
    }

    private func count(for tab: DesktopProjectTab, _ summary: DesktopProjectSummary) -> Int? {
        switch tab {
        case .overview, .settings: nil
        case .tasks: tasks.count
        case .sources: summary.sources.count + artifacts.count
        }
    }

    private func headerMore(_ project: NativeProject, _ summary: DesktopProjectSummary) -> some View {
        Menu {
            Button("Rename…") { renaming = DesktopProjectActions.rename(project, model: model, toast: toast) }
            Button(summary.cover == nil ? "Add Project Image…" : "Change Image…") { choosingCover = true }
            if summary.cover != nil {
                Button("Remove Image") { removeCover(summary) }
            }
            Button("Move To…") { moving = true }
            Divider()
            Button("Delete Project…", role: .destructive) { deleting = project }
        } label: {
            JunoIconView(.ellipsis, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .help("More project actions")
        .accessibilityLabel("More project actions")
    }

    // MARK: - Overview

    private func overview(_ project: NativeProject, _ summary: DesktopProjectSummary) -> some View {
        DesktopPageLayoutReader { layout in
            let wide = layout.pageWidth >= 896
            let columns = wide
                ? AnyLayout(HStackLayout(alignment: .top, spacing: JunoSpace.section))
                : AnyLayout(VStackLayout(alignment: .leading, spacing: JunoSpace.section))
            columns {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    DesktopProjectAskField(projectName: project.name, send: startConversation)
                    DesktopProjectChats(
                        chats: chats,
                        projects: model.projects,
                        projectID: projectID,
                        conversationModel: conversationModel,
                        open: openConversation
                    )
                    DesktopProjectFoldersSection(projectID: projectID, model: model)
                    let inherited = model.inherited(for: projectID)
                    if !inherited.isEmpty {
                        DesktopProjectInheritedSection(inherited: inherited)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                DesktopProjectRail(
                    project: project,
                    summary: summary,
                    fileAccess: fileAccess,
                    editInstructions: { editingInstructions = true },
                    addFile: { choosingSources = true },
                    viewSources: { tab = .sources },
                    openMemory: openMemory
                )
                .frame(width: wide ? DesktopProjectRail.width : nil)
                .frame(maxWidth: wide ? nil : .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Tasks

    private var tasksTab: some View {
        DesktopProjectTasks(tasks: tasks, open: { task in
            if let conversationID = task.conversationID { openConversation(conversationID) }
        })
    }

    // MARK: - Sources

    private func sourcesTab(_ project: NativeProject, _ summary: DesktopProjectSummary) -> some View {
        DesktopProjectSources(
            files: summary.sources,
            artifacts: artifacts,
            fileAccess: fileAccess,
            browse: { choosingSources = true },
            uploader: DesktopProjectUploader(model: model, projectID: projectID),
            remove: { file in
                Task {
                    await model.deleteFile(id: file.id)
                    if model.lastErrorDescription != nil { toast(.error("Couldn’t remove that file.")) }
                }
            },
            openArtifact: { artifact in push(.artifact(artifact.id, version: nil)) }
        )
    }

    // MARK: - Settings

    private func settingsTab(_ project: NativeProject) -> some View {
        DesktopProjectSettings(
            project: project,
            model: model,
            workspaceModel: workspaceModel,
            modelCatalog: modelCatalog,
            openFullEditor: { editingInstructions = true }
        )
    }

    // MARK: - Actions

    private func togglePin(_ project: NativeProject) {
        Task {
            await model.updateProject(id: project.id, starred: !project.starred)
            if model.lastErrorDescription != nil { toast(.error("Couldn’t update project pin.")) }
        }
    }

    private func addSources(_ urls: [URL]) {
        Task {
            await DesktopProjectUploader(model: model, projectID: projectID).upload(urls)
            if model.lastErrorDescription != nil { toast(.error("Couldn’t add that file.")) }
        }
    }

    private func setCover(_ url: URL, summary: DesktopProjectSummary) {
        Task {
            guard let file = DesktopLibraryUploads.read([url]).first else { return }
            if let existing = summary.cover { await model.deleteFile(id: existing.id) }
            await model.uploadFile(
                data: file.data,
                fileName: DesktopProjectSummary.coverFileName,
                mimeType: file.mimeType,
                projectID: projectID
            )
            if model.lastErrorDescription != nil {
                toast(.error("Couldn’t upload cover image."))
            } else {
                toast(.success("Project cover image updated."))
            }
        }
    }

    private func removeCover(_ summary: DesktopProjectSummary) {
        guard let cover = summary.cover else { return }
        Task {
            await model.deleteFile(id: cover.id)
            if model.lastErrorDescription != nil {
                toast(.error("Couldn’t remove cover image."))
            } else {
                toast(.success("Cover image removed."))
            }
        }
    }
}

// MARK: - Tabs

enum DesktopProjectTab: String, Hashable, CaseIterable {
    case overview, tasks, sources, settings

    var label: String {
        switch self {
        case .overview: "Overview"
        case .tasks: "Tasks"
        case .sources: "Sources"
        case .settings: "Settings"
        }
    }

    /// Tasks only when the project has any, as on the web. (Code is left out
    /// until a Code session can be opened from here; Phase 4 §7.)
    static func visible(taskCount: Int) -> [DesktopProjectTab] {
        taskCount > 0 ? [.overview, .tasks, .sources, .settings] : [.overview, .sources, .settings]
    }

    private static func key(_ projectID: String) -> String { "juno.desktop.project.tab.\(projectID)" }

    static func remembered(for projectID: String) -> DesktopProjectTab? {
        UserDefaults.standard.string(forKey: key(projectID)).flatMap(DesktopProjectTab.init(rawValue:))
    }

    static func remember(_ tab: DesktopProjectTab, for projectID: String) {
        UserDefaults.standard.set(tab.rawValue, forKey: key(projectID))
    }
}

// MARK: - The field you type into

/// An opaque, composer-shaped field (register #69): the panel radius, a
/// hairline, never glass — the one real composer keeps the glass. Return
/// starts a new chat in the project with these words in its composer.
struct DesktopProjectAskField: View {
    let projectName: String
    let send: (String) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var placeholder: String {
        projectName.count > 32 ? "Ask anything about this project…" : "Ask anything about \(projectName)…"
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        HStack(alignment: .bottom, spacing: JunoSpace.snug) {
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .junoType(.body)
                .lineLimit(1...6)
                .focused($focused)
                .onSubmit(submit)
                .padding(.vertical, JunoSpace.tight)
                .accessibilityLabel(placeholder)
            // The product's one "send this" disc: grey until there are words,
            // then the coral Send (§0.4, §10.1), as every composer draws it.
            ComposerPrimaryDisc(
                face: trimmed.isEmpty ? .disabled("Start a chat in this project") : .send,
                label: "Start a chat in this project",
                help: "Start a chat in this project",
                identifier: "juno.desktop.project.ask.send",
                action: submit
            )
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(focused ? Color.junoRing : Color.junoBorder, lineWidth: 1)
        )
        .contentShape(.rect)
        .onTapGesture { focused = true }
    }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        let words = trimmed
        text = ""
        send(words)
    }
}

// MARK: - Chats in this project

struct DesktopProjectChats: View {
    let chats: [NativeProjectConversation]
    let projects: [NativeProject]
    let projectID: String
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let open: (String) -> Void

    @Environment(\.junoToast) private var toast
    @State private var query = ""
    @State private var hovered: String?
    @State private var confirmation: JunoConfirmation?

    private var matching: [NativeProjectConversation] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty ? chats : chats.filter { $0.title.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.cozy) {
                Text("Chats in this project")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if !chats.isEmpty {
                    JunoPageSearchField(text: $query, prompt: "Search chats…")
                        .frame(maxWidth: 240)
                }
            }
            if chats.isEmpty {
                JunoEmptyState(
                    title: "No chats in this project yet",
                    message: "Start one above. Juno reads the project’s instructions and files first.",
                    icon: .chats,
                    size: .panel
                )
            } else {
                let pinned = matching.filter(\.pinned)
                let recent = matching.filter { !$0.pinned }
                if !pinned.isEmpty { section("Pinned", pinned) }
                if !recent.isEmpty { section("Recent", recent) }
                if matching.isEmpty {
                    Text("No chat here matches “\(query)”.")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
        .junoConfirmation($confirmation)
    }

    private func section(_ title: String, _ rows: [NativeProjectConversation]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoType(.ui)
                .fontWeight(.medium)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(rows) { chat in row(chat) }
            }
        }
    }

    private func row(_ chat: NativeProjectConversation) -> some View {
        let isHovered = hovered == chat.id
        return HStack(spacing: JunoSpace.cozy) {
            Text(chat.title.isEmpty ? "New chat" : chat.title)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(DesktopRelativeTime.short(chat.lastMessageAt))
                .junoType(.caption)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
            HStack(spacing: 0) {
                Button {
                    pin(chat)
                } label: {
                    JunoIconView(.pin, size: 14, isOn: chat.pinned)
                        .foregroundStyle(chat.pinned ? Color.junoForeground : Color.junoSecondaryInk)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help(chat.pinned ? "Unpin chat" : "Pin chat")
                .accessibilityLabel(chat.pinned ? "Unpin chat" : "Pin chat")
                .opacity(chat.pinned || isHovered ? 1 : 0)
                Menu {
                    actions(chat)
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
                .opacity(isHovered ? 1 : 0)
                .help("More actions for this chat")
                .accessibilityLabel("More actions for this chat")
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.tight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(isHovered ? Color.junoHover : Color.clear)
        )
        .contentShape(.rect)
        .onTapGesture { open(chat.id) }
        .desktopKeyboardOpen { open(chat.id) }
        .onHover { inside in
            if inside { hovered = chat.id } else if hovered == chat.id { hovered = nil }
        }
        .contextMenu { actions(chat) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open") { open(chat.id) }
    }

    @ViewBuilder
    private func actions(_ chat: NativeProjectConversation) -> some View {
        Button(chat.pinned ? "Unpin Chat" : "Pin Chat") { pin(chat) }
            .contentShape(.rect)
        Menu("Move to Project") {
            ForEach(projects.filter { $0.id != projectID }) { other in
                Button(other.name) { move(chat, to: other) }
            }
            Divider()
            Button("Remove from Project") { move(chat, to: nil) }
        }
            .contentShape(.rect)
        Divider()
        Button("Delete…", role: .destructive) {
            confirmation = JunoConfirmation(
                title: "Delete this chat?",
                message: "It’s removed from every device. This can’t be undone.",
                confirmTitle: "Delete Chat"
            ) {
                Task {
                    await conversationModel?.deleteConversation(id: chat.id)
                    toast(.success("Chat deleted."))
                }
            }
        }
            .contentShape(.rect)
    }

    private func pin(_ chat: NativeProjectConversation) {
        Task {
            await conversationModel?.setPinned(id: chat.id, pinned: !chat.pinned)
            toast(.success(chat.pinned ? "Chat unstarred." : "Chat starred."))
        }
    }

    private func move(_ chat: NativeProjectConversation, to project: NativeProject?) {
        Task {
            await conversationModel?.setProject(id: chat.id, projectID: project?.id)
            if let project { toast(.success("Chat moved to \(project.name).")) }
        }
    }
}

// MARK: - The rail

/// The Overview's 304pt rail: the cover, Instructions, Sources, Memory.
struct DesktopProjectRail: View {
    static let width: CGFloat = 304

    let project: NativeProject
    let summary: DesktopProjectSummary
    let fileAccess: ((String) async -> NativeProjectFileAccess?)?
    let editInstructions: () -> Void
    let addFile: () -> Void
    let viewSources: () -> Void
    let openMemory: (() -> Void)?

    var body: some View {
        // One column divided by hairlines, the web's rail
        // (`project-overview-rail.tsx`), not three cards stacked beside the
        // chats: the rail is reference, and a card each made it louder than
        // the list it sits beside.
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let cover = summary.cover, let fileAccess {
                DesktopProjectCover(fileID: cover.id, fileAccess: fileAccess)
            }
            section("Instructions", trailing: {
                iconAction(.edit, "Edit instructions", action: editInstructions)
            }) {
                instructions
            }
            divider
            section("Sources", count: summary.sources.count, trailing: {
                iconAction(.plus, "Add a file", action: addFile)
            }) {
                sources
            }
            divider
            section("Memory", trailing: { EmptyView() }) {
                Text("What Juno learns in this project’s chats stays here. Your other chats never see it.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let openMemory {
                    Button("Manage memory", action: openMemory)
                        .contentShape(.rect)
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .padding(.top, JunoSpace.tight)
                }
            }
        }
    }

    /// The web's excerpt: the source in the mono caption, muted, four lines,
    /// then its size; the whole block opens the editor.
    @ViewBuilder
    private var instructions: some View {
        let text = project.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            Text("A prompt Juno follows in every chat, task and code session filed here.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Button(action: editInstructions) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text(verbatim: text)
                        .junoType(.monoSmall)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(4)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Self.sizeLine(text))
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Edit instructions")
        }
    }

    @ViewBuilder
    private var sources: some View {
        if summary.sources.isEmpty {
            Text("PDFs, documents and data Juno reads before answering here.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(summary.sources.prefix(5)) { file in
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(file.kind.uppercased() == "IMAGE" ? .image : .file, size: 14)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .accessibilityHidden(true)
                        Text(file.fileName)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            if summary.sources.count > 5 {
                Button("View all \(summary.sources.count)", action: viewSources)
                    .contentShape(.rect)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.top, JunoSpace.tight)
            }
        }
    }

    /// "1,204 chars · 18 lines", tabular.
    static func sizeLine(_ text: String) -> String {
        let chars = text.count.formatted()
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
        return "\(chars) chars · \(lines) \(lines == 1 ? "line" : "lines")"
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.junoBorder.opacity(0.6))
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    private func iconAction(_ icon: JunoIcon, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help(label)
        .accessibilityLabel(label)
    }

    private func section<Trailing: View, Content: View>(
        _ title: String,
        count: Int? = nil,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                Text(title)
                    .junoType(.ui)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                if let count, count > 0 {
                    Text("\(count)")
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Spacer(minLength: 0)
                trailing()
            }
            .frame(minHeight: 28)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The cover, full width of the rail, at the card radius.
private struct DesktopProjectCover: View {
    let fileID: String
    let fileAccess: (String) async -> NativeProjectFileAccess?

    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Color.junoSecondary
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(height: 140)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .accessibilityHidden(true)
        .task(id: fileID) {
            let data = await DesktopLibraryUploads.bytes(await fileAccess(fileID))
            let picture = data.flatMap(NSImage.init(data:))
            withAnimation(JunoMotion.fast) { image = picture }
        }
    }
}

// MARK: - Tasks

struct DesktopProjectTasks: View {
    let tasks: [WorkSessionSummary]
    let open: (WorkSessionSummary) -> Void

    @State private var query = ""

    private var matching: [WorkSessionSummary] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty ? tasks : tasks.filter {
            $0.title.localizedCaseInsensitiveContains(needle) || $0.goal.localizedCaseInsensitiveContains(needle)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if tasks.isEmpty {
                JunoEmptyState(
                    title: "No delegated work yet",
                    message: "Delegate long-running goals and automations; they run with this project’s context.",
                    icon: .task,
                    size: .panel
                )
            } else {
                JunoPageSearchField(text: $query, prompt: "Search work…")
                DesktopProjectRowList(items: matching) { task in
                    HStack(spacing: JunoSpace.cozy) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title.isEmpty ? task.goal : task.title)
                                .junoType(.ui)
                                .fontWeight(.medium)
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                            Text(task.status.capitalized)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        Spacer(minLength: 0)
                        Text(DesktopRelativeTime.short(task.lastActivityAt))
                            .junoType(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    .contentShape(.rect)
                    .onTapGesture { open(task) }
                    .desktopKeyboardOpen { open(task) }
                    .accessibilityAddTraits(.isButton)
                }
            }
        }
    }
}

/// Rows in one card, divided at 70%.
struct DesktopProjectRowList<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.7))
                        .frame(height: 1)
                        .padding(.horizontal, JunoSpace.regular)
                        .accessibilityHidden(true)
                }
                row(item)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.snug)
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }
}

// MARK: - Sources

struct DesktopProjectSources: View {
    enum Filter: Hashable { case all, files, artifacts }

    let files: [NativeProjectFile]
    let artifacts: [NativeArtifact]
    let fileAccess: ((String) async -> NativeProjectFileAccess?)?
    let browse: () -> Void
    /// Where dropped files go: this project, through its model.
    let uploader: DesktopProjectUploader
    let remove: (NativeProjectFile) -> Void
    let openArtifact: (NativeArtifact) -> Void

    @Environment(\.junoToast) private var toast
    @State private var query = ""
    @State private var filter = Filter.all
    @State private var dropping = false
    @State private var download: (document: DesktopLibraryFileDocument, name: String)?

    private var needle: String { query.trimmingCharacters(in: .whitespaces) }

    private var shownFiles: [NativeProjectFile] {
        guard filter != .artifacts else { return [] }
        return needle.isEmpty ? files : files.filter { $0.fileName.localizedCaseInsensitiveContains(needle) }
    }

    private var shownArtifacts: [NativeArtifact] {
        guard filter != .files else { return [] }
        return needle.isEmpty ? artifacts : artifacts.filter { $0.title.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(spacing: JunoSpace.snug) {
                JunoPageSearchField(text: $query, prompt: "Search files and artifacts…")
                JunoSegmented(
                    options: [
                        .init(Filter.all, "All", count: files.count + artifacts.count),
                        .init(Filter.files, "Files", count: files.count),
                        .init(Filter.artifacts, "Artifacts", count: artifacts.count),
                    ],
                    selection: $filter,
                    accessibilityLabel: "Filter sources"
                )
                Spacer(minLength: 0)
            }
            dropWell
            if filter != .artifacts {
                if files.isEmpty {
                    JunoEmptyState(
                        title: "No files yet",
                        message: "Add PDFs, documents, code or data to ground every answer in this project.",
                        icon: .file,
                        size: .panel
                    )
                } else if !shownFiles.isEmpty {
                    DesktopProjectRowList(items: shownFiles) { file in fileRow(file) }
                }
            }
            if filter != .files {
                if artifacts.isEmpty {
                    JunoEmptyState(
                        title: "No artifacts yet",
                        message: "Artifacts Juno builds in this project’s chats will collect here.",
                        icon: .artifacts,
                        size: .panel
                    )
                } else if !shownArtifacts.isEmpty {
                    DesktopProjectRowList(items: shownArtifacts) { artifact in artifactRow(artifact) }
                }
            }
        }
        .fileExporter(
            isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
            document: download?.document,
            contentType: .data,
            defaultFilename: download?.name
        ) { _ in download = nil }
    }

    private var dropWell: some View {
        Button(action: browse) {
            VStack(spacing: JunoSpace.tight) {
                JunoIconView(.upload, size: 18)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(dropping ? "Drop to add to this project" : "Drop files here, or click to browse")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                Text("Upload files")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, JunoSpace.section)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(dropping ? Color.junoHover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
            let wanted = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
            guard !wanted.isEmpty else { return false }
            let uploader = uploader
            for provider in wanted {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in await uploader.upload([url]) }
                }
            }
            return true
        }
        .accessibilityLabel("Upload files")
    }

    private func fileRow(_ file: NativeProjectFile) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(file.kind.uppercased() == "IMAGE" ? .image : .file, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.fileName)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("\(DesktopLibraryScreen.sizeLabel(file.size)) · \(DesktopRelativeTime.short(file.createdAt))")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
            if fileAccess != nil {
                iconButton(.download, "Download \(file.fileName)") { downloadFile(file) }
            }
            iconButton(.trash, "Remove \(file.fileName)") { remove(file) }
        }
    }

    private func artifactRow(_ artifact: NativeArtifact) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(DesktopArtifactKinds.icon(artifact.kind), size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(DesktopArtifactKinds.meta(artifact))
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
        .onTapGesture { openArtifact(artifact) }
        .desktopKeyboardOpen { openArtifact(artifact) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private func iconButton(_ icon: JunoIcon, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help(label)
        .accessibilityLabel(label)
    }

    private func downloadFile(_ file: NativeProjectFile) {
        guard let fileAccess else { return }
        Task {
            guard let data = await DesktopLibraryUploads.bytes(await fileAccess(file.id)) else {
                toast(.error("Couldn’t download that file."))
                return
            }
            download = (DesktopLibraryFileDocument(data: data), file.fileName)
        }
    }
}

/// Adds files to one project through its model.
struct DesktopProjectUploader: Sendable {
    let model: NativeProjectModel<SQLiteAccountRepository>
    let projectID: String

    @MainActor
    func upload(_ urls: [URL]) async {
        for (data, name, mime) in DesktopLibraryUploads.read(urls) {
            await model.uploadFile(data: data, fileName: name, mimeType: mime, projectID: projectID)
        }
    }
}

// MARK: - Settings

/// Cards, each with its own Save — the one prominent button in each card,
/// disabled until something in it changed.
struct DesktopProjectSettings: View {
    let project: NativeProject
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    var workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
    var modelCatalog: [NativeChatModelOption] = []
    let openFullEditor: () -> Void

    @Environment(\.junoToast) private var toast
    @State private var instructions = ""
    @State private var persona = ""
    @State private var preferredModel: String?
    @State private var saving = false

    /// The web's `INSTRUCTIONS_SOFT_WARN`: advice, not a limit.
    static let softWarnLength = 50_000

    private var workspace: ProjectWorkspaceConfiguration? { workspaceModel?.workspaces[project.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            instructionsCard
            if workspaceModel != nil {
                identityCard
                toolsCard
            }
        }
        .task(id: project.id) { seed() }
    }

    private var instructionsCard: some View {
        DesktopSettingsCard(
            title: "System instructions",
            detail: "Prepended to every chat, work run, and code session in this project."
        ) {
            TextEditor(text: $instructions)
                .junoMono()
                .scrollContentBackground(.hidden)
                .padding(JunoSpace.snug)
                .frame(minHeight: 160)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoCanvas)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoInput, lineWidth: 1)
                )
                .accessibilityLabel("System instructions")
            HStack(spacing: JunoSpace.cozy) {
                Text("\(instructions.count) chars")
                    .monospacedDigit()
                Text("Updated \(DesktopRelativeTime.short(project.updatedAt))")
                Spacer(minLength: 0)
                Button("Full editor", action: openFullEditor)
                    .contentShape(.rect)
                    .buttonStyle(.bordered)
                    .tint(nil)
                Button("Save") { Task { await saveInstructions() } }
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .disabled(instructions == project.instructions || saving)
            }
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            if instructions.count > Self.softWarnLength {
                Text("Very long instructions: a model may not attend to all of it.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoDestructiveInk)
            }
        }
    }

    private var identityCard: some View {
        DesktopSettingsCard(
            title: "Identity and model",
            detail: "What Juno is called here, and which model answers by default."
        ) {
            // The page's own field and menu, not the system's rounded box and
            // grey pop-up: one field and one menu recipe across every page.
            DesktopSkillField(label: "Persona name", text: $persona, placeholder: project.name)
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Preferred model")
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                JunoPageMenu(
                    options: [JunoPageMenuOption(String?.none, "Account default", menuTitle: "Account Default")]
                        + modelCatalog.filter { $0.modality != "image" }.map { option in
                            JunoPageMenuOption(String?.some(option.id), option.displayName)
                        },
                    selection: $preferredModel,
                    accessibilityLabel: "Preferred model"
                )
                .fixedSize()
            }
            HStack {
                Spacer(minLength: 0)
                Button("Save") { saveIdentity() }
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .disabled(!identityChanged)
            }
        }
    }

    private var toolsCard: some View {
        DesktopSettingsCard(
            title: "Tools",
            detail: "Narrow what Juno may reach for while answering here."
        ) {
            Toggle("Restrict assistant tools", isOn: restrictionBinding)
                .toggleStyle(.switch)
                .tint(Color.junoAccent)
            if workspace?.toolAccess.isRestricted == true {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(ProjectWorkspaceTool.allCases) { tool in
                        Toggle(tool.displayName, isOn: toolBinding(tool))
                            .toggleStyle(.switch)
                            .tint(Color.junoAccent)
                    }
                }
                .padding(.leading, JunoSpace.regular)
            }
            Text("Restrictions narrow what is available while Juno generates in this project. They do not disconnect anything.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var identityChanged: Bool {
        let name = persona.trimmingCharacters(in: .whitespacesAndNewlines)
        return (name.isEmpty ? nil : name) != workspace?.personaName || preferredModel != workspace?.preferredModelID
    }

    private var restrictionBinding: Binding<Bool> {
        Binding(
            get: { workspace?.toolAccess.isRestricted ?? false },
            set: { restricted in
                save { $0.toolAccess = restricted ? .restricted(Set(ProjectWorkspaceTool.allCases)) : .inheritsAccountDefaults }
            }
        )
    }

    private func toolBinding(_ tool: ProjectWorkspaceTool) -> Binding<Bool> {
        Binding(
            get: { workspace?.toolAccess.allows(tool) ?? true },
            set: { allowed in
                save { configuration in
                    var tools: Set<ProjectWorkspaceTool>
                    if case .restricted(let existing) = configuration.toolAccess {
                        tools = existing
                    } else {
                        tools = Set(ProjectWorkspaceTool.allCases)
                    }
                    if allowed { tools.insert(tool) } else { tools.remove(tool) }
                    configuration.toolAccess = .restricted(tools)
                }
            }
        )
    }

    private func seed() {
        instructions = project.instructions
        persona = workspace?.personaName ?? ""
        preferredModel = workspace?.preferredModelID
    }

    private func saveInstructions() async {
        saving = true
        defer { saving = false }
        await model.updateProject(id: project.id, instructions: instructions)
        if model.lastErrorDescription == nil {
            toast(.success("Project instructions saved."))
        } else {
            toast(.error("Couldn’t save. Your text is still here, so check your connection and try again."))
        }
    }

    private func saveIdentity() {
        let name = persona.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = preferredModel
        save { configuration in
            configuration.personaName = name.isEmpty ? nil : name
            configuration.preferredModelID = model
        }
    }

    private func save(_ edit: @escaping (inout ProjectWorkspaceConfiguration) -> Void) {
        guard let workspaceModel else { return }
        let projectID = project.id
        Task { await workspaceModel.update(projectID: projectID, edit) }
    }
}

/// A settings card: its heading on the `heading` rung (register #71), one
/// line of what it is for, then its controls.
struct DesktopSettingsCard<Content: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(title)
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(detail)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }
}

// MARK: - Instructions sheet

/// The instructions editor, in the room a prompt needs, with the web's
/// discard question when it is closed with changes.
struct DesktopProjectInstructionsSheet: View {
    let project: NativeProject
    let save: @MainActor (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    @State private var saving = false
    @State private var confirmingDiscard = false

    init(project: NativeProject, save: @escaping @MainActor (String) async -> Bool) {
        self.project = project
        self.save = save
        _draft = State(initialValue: project.instructions)
    }

    private var changed: Bool { draft != project.instructions }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Instructions")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Prepended to every chat, work run, and code session in this project.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            TextEditor(text: $draft)
                .junoMono()
                .scrollContentBackground(.hidden)
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoCanvas)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoInput, lineWidth: 1)
                )
                .accessibilityLabel("Project instructions")
            HStack(spacing: JunoSpace.cozy) {
                Text("\(draft.count) chars")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer(minLength: 0)
                Button("Cancel") {
                    if changed { confirmingDiscard = true } else { dismiss() }
                }
                .contentShape(.rect)
                .tint(nil)
                .keyboardShortcut(.cancelAction)
                Button(saving ? "Saving…" : "Save Changes") {
                    Task {
                        saving = true
                        let saved = await save(draft)
                        saving = false
                        if saved { dismiss() }
                    }
                }
                    .contentShape(.rect)
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!changed || saving)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 600, height: 480)
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
    }
}
