import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI

/// The phone's drawer — and the iPad's sidebar column.
///
/// Built on a plain `List` now rather than a `LazyVStack` in a `ScrollView`.
/// Not for the look, which is deliberately the same dense chat drawer as
/// before, but for what a `List` gives a row for free: swipe actions, a
/// selection wash the platform draws, and Dynamic Type metrics the row does
/// not have to compute. The grouped-settings look a `List` is known for is
/// `.insetGrouped`; `.plain` with the separators and the background hidden is a
/// column of rows and nothing else.
///
/// Top to bottom, as the brief lays it out: brand, search, New chat, the
/// product's destinations, Projects (collapsible, the five most recent and a
/// way to the rest), Pinned, Recents grouped by day, and a footer that says who
/// is signed in and on what plan.
struct JunoMobileSidebarDrawer: View {
  @Binding var selection: JunoMobileSection
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  let projectModel: NativeProjectModel<SQLiteAccountRepository>?
  let workModel: NativeWorkModel?
  let codeModel: NativeCodeModel?
  let session: NativeAuthenticatedSession
  /// The account photo's bytes, already fetched through the authenticated file
  /// route. Nil falls back to initials.
  var avatarData: Data?
  var canCreateChat: Bool = true
  /// Reads the plan for the footer. Nil on an unconfigured shell, where the
  /// footer shows the account and nothing else.
  var requestSender: (any NativeAuthenticatedRequestSending)?
  let openDestination: (JunoMobileSection) -> Void
  let openConversation: (String) -> Void
  var openProject: (String) -> Void = { _ in }
  let openRecent: (JunoRecentItem) -> Void
  let newChat: () -> Void
  /// Publishes a conversation and hands the link to the share sheet. Nil
  /// where the app has no share client.
  var shareConversation: ((String) -> Void)?
  /// `.drawer` is the phone's sheet; `.sidebar` is the iPad's column, drawn
  /// in the Mac's row grammar. Same data, same actions, same menus.
  var layout: Layout = .drawer
  /// Whether the open chat is an unsaved draft, which is what selects the
  /// sidebar's New chat row.
  var isDrafting: Bool = false
  /// Plain-text status beside Code and Work in the iPad sidebar.
  var statuses: [JunoMobileSection: JunoMobileSidebarStatus] = [:]
  /// An incognito chat is open: no saved conversation is the current one,
  /// whatever the list last had selected.
  var incognito: Bool = false
  /// The drawer's Research row: a new chat with deep research armed. Nil
  /// hides the row (the iPad sidebar has the composer's own menu for it).
  var startResearch: (() -> Void)? = nil

  enum Layout { case drawer, sidebar }

  @State private var renameTarget: NativeConversation?
  @State private var renameValue = ""
  @State private var deleteTarget: NativeConversation?
  @State private var renameProjectTarget: NativeProject?
  @State private var renameProjectValue = ""
  @State private var deleteProjectTarget: NativeProject?
  @State private var plan: NativeUsagePlan?
  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @State private var archiveHaptic = JunoMobileHapticTrigger()
  @State private var selectionHaptic = JunoMobileHapticTrigger()
  /// Remembered across launches: a collapsed Projects section is a choice.
  @AppStorage("juno.mobile.drawer.projects-expanded") private var projectsExpanded = true
  /// The drawer's own search state: the header becomes a field and the list
  /// becomes matches, in place — ChatGPT's drawer search, not a pushed page.
  @State private var searching = false
  @State private var query = ""
  @FocusState private var searchFocused: Bool
  @Environment(\.junoMobileDrawerOpen) private var drawerOpen
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var projects: [NativeProject] {
    (projectModel?.projects ?? []).sorted { $0.updatedAt > $1.updatedAt }
  }

  private var recentProjects: [NativeProject] {
    // Starred first, then by recency, capped so the section stays a section.
    let starred = projects.filter(\.starred)
    let rest = projects.filter { !$0.starred }
    return Array((starred + rest).prefix(5))
  }

  private var groups: [NativeConversationGroup] {
    NativeConversationGrouping.groups(
      for: conversationModel?.conversations ?? [],
      now: Date()
    )
    .filter { $0.bucket != .archived }
  }

  private var pinnedChats: [NativeConversation] {
    groups.first { $0.bucket == .pinned }?.conversations ?? []
  }

  private var recentGroups: [NativeConversationGroup] {
    groups.filter { $0.bucket != .pinned }
  }

  private var attentionItems: [JunoRecentItem] {
    var sources: [[JunoRecentItem]] = []
    if let workModel {
      sources.append(
        workModel.sessionsNeedingAttention
          .filter { !$0.archived }
          .map(\.junoRecentItem)
      )
    }
    if let codeModel {
      sources.append(
        codeModel.tasks
          .filter { $0.status == .awaitingApproval || $0.status == .failed }
          .map(\.junoRecentItem)
      )
    }
    return JunoRecentActivity.attentionItems(
      from: JunoRecentActivity.merge(sources, limit: 20),
      limit: 6
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      if layout == .drawer {
        header
        if searching {
          searchResults
        } else {
          list
        }
        footer
      } else {
        sidebarList
        sidebarFooter
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .accessibilityIdentifier("juno.mobile.sidebar")
    .junoHaptic(JunoMobileHaptic.pin, trigger: pinHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
    .junoHaptic(JunoMobileHaptic.pin, trigger: archiveHaptic)
    .junoHaptic(JunoMobileHaptic.selection, trigger: selectionHaptic)
    .task {
      guard plan == nil, let requestSender else { return }
      plan = await NativeUsageClient(sender: requestSender)
        .load(range: .month, for: session.profile.id)
        .plan
    }
    .alert(
      "Rename conversation",
      isPresented: Binding(
        get: { renameTarget != nil },
        set: { if !$0 { renameTarget = nil } }
      )
    ) {
      TextField("Title", text: $renameValue)
      Button("Cancel", role: .cancel) { renameTarget = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let target = renameTarget else { return }
        renameTarget = nil
        Task { await conversationModel?.renameConversation(id: target.id, title: renameValue) }
      }
      .contentShape(.rect)
    }
    .confirmationDialog(
      deleteTarget.map { "Delete “\($0.title)”?" } ?? "",
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        deleteHaptic.fire()
        Task { await conversationModel?.deleteConversation(id: target.id) }
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { deleteTarget = nil }
        .contentShape(.rect)
    } message: {
      Text("chat.delete.warning")
    }
    .alert(
      "Rename project",
      isPresented: Binding(
        get: { renameProjectTarget != nil },
        set: { if !$0 { renameProjectTarget = nil } }
      )
    ) {
      TextField("Name", text: $renameProjectValue)
      Button("Cancel", role: .cancel) { renameProjectTarget = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let target = renameProjectTarget else { return }
        renameProjectTarget = nil
        Task { await projectModel?.updateProject(id: target.id, name: renameProjectValue) }
      }
      .contentShape(.rect)
    }
    .confirmationDialog(
      deleteProjectTarget.map { "Delete “\($0.name)”?" } ?? "",
      isPresented: Binding(
        get: { deleteProjectTarget != nil },
        set: { if !$0 { deleteProjectTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteProjectTarget else { return }
        deleteProjectTarget = nil
        deleteHaptic.fire()
        Task { await projectModel?.deleteProject(id: target.id) }
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { deleteProjectTarget = nil }
        .contentShape(.rect)
    } message: {
      Text("Conversations are kept and unlinked; project files are removed.")
    }
  }

  // MARK: - List

  private func projectRow(_ project: NativeProject) -> some View {
    Button {
      selectionHaptic.fire()
      openProject(project.id)
    } label: {
      HStack(spacing: 7) {
        JunoIconView(.projects, size: 14)
          .foregroundStyle(Color.junoSidebarForeground)
        Text(project.name)
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        if project.isPending {
          JunoIconView(.refresh, size: 12)
            .junoSecondaryInk()
        }
      }
      .padding(.horizontal, 10)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        pinHaptic.fire()
        Task { await projectModel?.updateProject(id: project.id, starred: !project.starred) }
      } label: {
        Label(project.starred ? "Unpin" : "Pin", systemImage: project.starred ? "pin.slash" : "pin")
      }
      .tint(Color.junoAccent)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        deleteProjectTarget = project
      } label: {
        Label("Delete", systemImage: "trash")
      }
    }
    .contextMenu {
      Button {
        renameProjectValue = project.name
        renameProjectTarget = project
      } label: {
        Label { Text("Rename") } icon: { JunoIconView(.pencil, size: 15) }
      }
      Button {
        pinHaptic.fire()
        Task { await projectModel?.updateProject(id: project.id, starred: !project.starred) }
      } label: {
        Label { Text(project.starred ? "Unpin" : "Pin") } icon: { JunoIconView(.pin, size: 15) }
      }
      Divider()
      Button(role: .destructive) {
        deleteProjectTarget = project
      } label: {
        Label { Text("Delete") } icon: { JunoIconView(.trash, size: 15) }
      }
    }
    .disabled(project.isPending)
  }

  // MARK: Conversations

  /// One conversation, with everything a swipe or a long press should offer.
  ///
  /// Swipes carry the two-handed habits — pin on the leading edge, archive and
  /// delete on the trailing one, delete never on a full swipe because it asks
  /// for confirmation. The menu carries the rest: rename, move to a project,
  /// share.
  private func conversationRow(
    _ conversation: NativeConversation, pinned: Bool
  ) -> some View {
    JunoMobileConversationRow(
      title: conversation.title,
      // The section header already says so, in both layouts.
      pinned: false,
      pending: conversation.isPending,
      selected: !incognito && selection == .chat
        && conversationModel?.selectedConversationID == conversation.id,
      sidebar: layout == .sidebar,
      action: {
        selectionHaptic.fire()
        openConversation(conversation.id)
      }
    )
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        pinHaptic.fire()
        Task { await conversationModel?.setPinned(id: conversation.id, pinned: !conversation.pinned) }
      } label: {
        Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
      }
      .tint(Color.junoAccent)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        deleteTarget = conversation
      } label: {
        Label("Delete", systemImage: "trash")
      }
      Button {
        archiveHaptic.fire()
        Task { await conversationModel?.setArchived(id: conversation.id, archived: true) }
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      .tint(Color.junoMutedForeground)
    }
    .contextMenu {
      Button {
        renameValue = conversation.title
        renameTarget = conversation
      } label: {
        Label { Text("Rename") } icon: { JunoIconView(.pencil, size: 15) }
      }
      Button {
        pinHaptic.fire()
        Task { await conversationModel?.setPinned(id: conversation.id, pinned: !conversation.pinned) }
      } label: {
        Label { Text(conversation.pinned ? "Unpin" : "Pin") } icon: { JunoIconView(.pin, size: 15) }
      }
      if !projects.isEmpty {
        Menu {
          ForEach(projects) { project in
            Button {
              Task { await conversationModel?.setProject(id: conversation.id, projectID: project.id) }
            } label: {
              if conversation.projectId == project.id {
                Label { Text(project.name) } icon: { JunoIconView(.check, size: 15) }
              } else {
                Text(project.name)
              }
            }
            .disabled(conversation.projectId == project.id)
          }
          if conversation.projectId != nil {
            Divider()
            Button {
              Task { await conversationModel?.setProject(id: conversation.id, projectID: nil) }
            } label: {
              Text("Remove from project")
            }
          }
        } label: {
          Label { Text("Move to project") } icon: { JunoIconView(.projects, size: 15) }
        }
      }
      if let shareConversation {
        Button {
          shareConversation(conversation.id)
        } label: {
          Label { Text("Share…") } icon: { JunoIconView(.share, size: 15) }
        }
      }
      Divider()
      Button {
        archiveHaptic.fire()
        Task { await conversationModel?.setArchived(id: conversation.id, archived: true) }
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      Button(role: .destructive) {
        deleteTarget = conversation
      } label: {
        Label { Text("Delete") } icon: { JunoIconView(.trash, size: 15) }
      }
    }
    // A conversation still syncing cannot be renamed, pinned or deleted —
    // the mutation would target a row the server has never seen.
    .disabled(conversation.isPending)
  }

  private static func title(for bucket: NativeConversationBucket) -> LocalizedStringKey {
    switch bucket {
    case .pinned: "sidebar.pinned"
    case .today: "Today"
    case .yesterday: "Yesterday"
    case .previous7Days: "Previous 7 days"
    case .previous30Days: "Previous 30 days"
    case .older: "Older"
    case .archived: "Archived"
    }
  }

  // MARK: - List (phone drawer)

  /// The phone drawer, laid out as ChatGPT's: a header with the name and a
  /// round search button, a short column of destinations — line glyph and
  /// label, no tiles, no chevrons, no counts — a hairline, then the chats.
  ///
  /// What needs the reader is said on its row in plain words ("2 waiting") in
  /// the attention colour. There is no card for it, no badge and no dot.
  private var list: some View {
    List {
      Group {
        ForEach(Array(drawerRows.enumerated()), id: \.element.id) { index, row in
          drawerRow(row)
            .junoMobileDrawerStagger(index: index)
        }
        Rectangle()
          .fill(Color.junoHairline)
          .frame(height: 1)
          .padding(.horizontal, 12)
          .padding(.top, 10)
          .padding(.bottom, 2)
          .accessibilityHidden(true)
      }
      .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)

      if pinnedChats.isEmpty && recentGroups.isEmpty {
        Text("No recent conversations")
          .junoFont(size: 15, relativeTo: .body)
          .foregroundStyle(Color.junoSecondaryInk)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }

      if !pinnedChats.isEmpty {
        Section {
          ForEach(pinnedChats) { conversationRow($0, pinned: true) }
        } header: {
          sectionLabel("sidebar.pinned")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }

      ForEach(recentGroups) { group in
        Section {
          ForEach(group.conversations) { conversationRow($0, pinned: false) }
        } header: {
          sectionLabel(Self.title(for: group.bucket))
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(0)
    .scrollContentBackground(.hidden)
    .scrollIndicators(.hidden)
    .environment(\.defaultMinListRowHeight, 44)
    // The footer floats over the list's end, so the last chat can scroll
    // clear of it.
    .contentMargins(.bottom, 12, for: .scrollContent)
  }

  /// One entry in the drawer's destination column.
  struct DrawerRow: Identifiable {
    enum Kind: Hashable {
      case destination(JunoMobileSection)
      case research
    }
    let kind: Kind
    var id: Kind { kind }
  }

  /// The column, in ChatGPT's order mapped onto Alevr: where your things are
  /// (Library, Projects, Artifacts), what works for you (Research, Code, Orbit,
  /// Work), what runs on a schedule (Routines), and what Alevr can reach (Apps).
  private var drawerRows: [DrawerRow] {
    var rows = JunoMobileSection.drawerDestinations.map { DrawerRow(kind: .destination($0)) }
    // Research sits with the things that work for you, before Code.
    if startResearch != nil {
      rows.insert(DrawerRow(kind: .research), at: 2)
    }
    return rows
  }

  /// Code's row speaks for Work too, which is reached from Code on the phone.
  private func phoneStatus(for destination: JunoMobileSection) -> JunoMobileSidebarStatus? {
    guard destination == .code else { return statuses[destination] }
    let code = statuses[.code] ?? JunoMobileSidebarStatus()
    let work = statuses[.work] ?? JunoMobileSidebarStatus()
    let merged = JunoMobileSidebarStatus(
      running: code.running + work.running, needsYou: code.needsYou + work.needsYou
    )
    return merged.isEmpty ? nil : merged
  }

  @ViewBuilder
  private func drawerRow(_ row: DrawerRow) -> some View {
    switch row.kind {
    case .destination(let destination):
      JunoMobileDrawerRow(
        symbol: destination.sidebarSymbol,
        title: destination.title,
        selected: selection == destination,
        status: phoneStatus(for: destination)
      ) {
        selectionHaptic.fire()
        openDestination(destination)
      }
      .accessibilityIdentifier("juno.mobile.sidebar-\(destination.rawValue)")
    case .research:
      JunoMobileDrawerRow(symbol: "binoculars", title: "Research", selected: false) {
        selectionHaptic.fire()
        startResearch?()
      }
      .accessibilityIdentifier("juno.mobile.sidebar-research")
    }
  }

  // MARK: - Header

  /// "Alevr" and a round search button — the drawer's whole header. The name
  /// is set in the UI face at the bar's title weight; the brand is in the
  /// app, not in a logo stamped on every surface.
  private var header: some View {
    HStack(spacing: 12) {
      if searching {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass")
            .foregroundStyle(.secondary)
          TextField("Search chats", text: $query)
            .textFieldStyle(.plain)
            .focused($searchFocused)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .accessibilityIdentifier("juno.mobile.sidebar-search-field")
          if !query.isEmpty {
            Button {
              query = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
          }
        }
        .font(.body)
        .padding(.horizontal, 14)
        .frame(height: 44)
        .glassEffect(.regular.interactive(), in: Capsule())
        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .trailing)))

        Button("Cancel") { setSearching(false) }
          .font(.body)
          .tint(Color.primary)
          .transition(.opacity)
      } else {
        Text(verbatim: "Alevr")
          .font(.title3.weight(.semibold))
          .foregroundStyle(Color.junoForeground)
          .accessibilityAddTraits(.isHeader)
          .transition(.opacity)
        Spacer(minLength: 0)
        Button {
          selectionHaptic.fire()
          setSearching(true)
        } label: {
          Image(systemName: "magnifyingglass")
            .font(.body)
            .foregroundStyle(Color.primary)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("navigation.search")
        .accessibilityIdentifier("juno.mobile.sidebar-search")
      }
    }
    .padding(.leading, 20)
    .padding(.trailing, 14)
    .padding(.top, 4)
    .padding(.bottom, 10)
    .animation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion), value: searching)
    .onChange(of: drawerOpen) { _, open in
      if !open { setSearching(false) }
    }
    #if DEBUG
      // `--juno-preview-sidebar --juno-preview-sidebar-search <query>` opens
      // the drawer in its search state with the query typed.
      .task {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--juno-preview-sidebar-search") else { return }
        try? await Task.sleep(for: .milliseconds(700))
        query = arguments.indices.contains(index + 1) ? arguments[index + 1] : ""
        searching = true
      }
    #endif
  }

  private func setSearching(_ on: Bool) {
    withAnimation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion)) {
      searching = on
      if !on { query = "" }
    }
    searchFocused = on
  }

  // MARK: - Search state

  private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var matchingChats: [NativeConversation] {
    let chats = (conversationModel?.conversations ?? []).filter { $0.archivedAt == nil }
      .sorted { $0.lastMessageAt > $1.lastMessageAt }
    guard !trimmedQuery.isEmpty else { return Array(chats.prefix(12)) }
    return chats.filter { $0.title.localizedCaseInsensitiveContains(trimmedQuery) }
  }

  private var matchingProjects: [NativeProject] {
    guard !trimmedQuery.isEmpty else { return [] }
    return projects.filter { $0.name.localizedCaseInsensitiveContains(trimmedQuery) }
  }

  /// Matches as you type: chat titles and project names, newest first, and a
  /// last row that takes the query to the full search (messages and files).
  /// Empty, it lists recent chats, as ChatGPT's does.
  private var searchResults: some View {
    List {
      if !trimmedQuery.isEmpty, matchingChats.isEmpty, matchingProjects.isEmpty {
        ContentUnavailableView.search(text: trimmedQuery)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      if !matchingProjects.isEmpty {
        Section {
          ForEach(matchingProjects) { projectRow($0) }
        } header: {
          sectionLabel("Projects")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      if !matchingChats.isEmpty {
        Section {
          ForEach(matchingChats) { conversationRow($0, pinned: false) }
        } header: {
          sectionLabel(trimmedQuery.isEmpty ? "Recent" : "Chats")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      if !trimmedQuery.isEmpty {
        Button {
          selectionHaptic.fire()
          openDestination(.search)
        } label: {
          Label {
            Text("Search messages and files for “\(trimmedQuery)”")
              .lineLimit(2)
          } icon: {
            Image(systemName: "text.magnifyingglass")
          }
          .font(.body)
          .foregroundStyle(Color.junoForeground)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          .padding(.horizontal, 12)
          .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityIdentifier("juno.mobile.sidebar-search-all")
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(0)
    .scrollContentBackground(.hidden)
    .scrollDismissesKeyboard(.immediately)
    .environment(\.defaultMinListRowHeight, 44)
    .transition(.opacity)
  }

  private func sectionLabel(_ key: LocalizedStringKey) -> some View {
    Text(key)
      .junoFont(size: 13, relativeTo: .footnote)
      .foregroundStyle(Color.junoSecondaryInk)
      .textCase(nil)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12)
      .padding(.top, 6)
      .padding(.bottom, 4)
      .accessibilityAddTraits(.isHeader)
  }

  // MARK: - Footer

  /// New chat as the one ink capsule on the screen, settings as a round glass
  /// button opposite it. The account lives in Settings, one tap from here.
  private var footer: some View {
    GlassEffectContainer(spacing: 12) {
      HStack(spacing: 12) {
        Button {
          selectionHaptic.fire()
          newChat()
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "square.and.pencil")
              .junoFont(size: 16, relativeTo: .body, weight: .regular)
            Text("Chat")
              .junoFont(size: 16, relativeTo: .body, weight: .semibold)
          }
          .foregroundStyle(Color.junoCanvas)
          .padding(.horizontal, 18)
          .frame(height: 48)
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(Color.primary).interactive(), in: Capsule())
        .disabled(!canCreateChat)
        .opacity(canCreateChat ? 1 : 0.4)
        .accessibilityLabel("chat.new")
        .accessibilityIdentifier("juno.mobile.sidebar-new-chat")

        Spacer(minLength: 0)

        // The inbox, beside settings: the header stays ChatGPT's — the name
        // and one search button.
        JunoMobileInboxBell()
          .frame(width: 48, height: 48)
          .glassEffect(.regular.interactive(), in: Circle())

        Button(action: { openDestination(.settings) }) {
          Image(systemName: "gearshape")
            .junoFont(size: 19, relativeTo: .body, weight: .regular)
            .foregroundStyle(Color.primary)
            .frame(width: 48, height: 48)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Open settings for \(profileName)")
        .accessibilityIdentifier("juno.mobile.sidebar-profile")
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 8)
    .padding(.bottom, 10)
  }

  private var profileName: String { session.profile.name ?? session.profile.email }
}

// MARK: - iPad sidebar

extension JunoMobileSidebarDrawer {
  /// The destinations the iPad sidebar lists as rows, in the Mac's order: the
  /// two products that run work, then where content lives. Tasks and
  /// Connections sit behind More, as they do on the Mac.
  /// Since the round-2 redesign, the phone drawer's rows: settings lives in
  /// the footer, and a new chat or a recent one is how you reach Chat.
  fileprivate static let sidebarDestinations: [JunoMobileSection] = JunoMobileSection.drawerDestinations
  fileprivate static let sidebarOverflow: [JunoMobileSection] = []

  /// The iPad column: the Mac's sidebar, row for row.
  ///
  /// New chat and Search first, then the destinations, then pinned projects,
  /// pinned chats and one Recent list. No brand header (the window chrome and
  /// the greeting already carry it) and no attention card: Code and Work say
  /// what is waiting on their own rows.
  var sidebarList: some View {
    List {
      Group {
        JunoMobileIPadSidebarRow(
          icon: .new, title: "chat.new",
          selected: selection == .chat && isDrafting,
          symbol: "square.and.pencil"
        ) {
          selectionHaptic.fire()
          newChat()
        }
        .disabled(!canCreateChat)
        .accessibilityIdentifier("juno.mobile.sidebar-new-chat")

        JunoMobileIPadSidebarRow(
          icon: .search, title: "navigation.search", selected: selection == .search,
          symbol: "magnifyingglass"
        ) {
          selectionHaptic.fire()
          openDestination(.search)
        }
        .accessibilityIdentifier("juno.mobile.sidebar-search")

        ForEach(Self.sidebarDestinations) { destination in
          destinationRow(destination)
        }
        // A destination reached through More is shown as a row while it is
        // open, so the selection always has somewhere to sit.
        if Self.sidebarOverflow.contains(selection) {
          destinationRow(selection)
        }
        if !Self.sidebarOverflow.isEmpty { moreMenu }
      }
      .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)

      let pinnedProjects = projects.filter(\.starred)
      if !pinnedProjects.isEmpty {
        Section {
          ForEach(pinnedProjects) { project in
            projectRow(project)
          }
        } header: {
          sidebarSectionLabel("Pinned projects")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }

      if !pinnedChats.isEmpty {
        Section {
          ForEach(pinnedChats) { conversationRow($0, pinned: true) }
        } header: {
          sidebarSectionLabel("Pinned chats")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }

      let recent = recentGroups.flatMap(\.conversations)
      if !recent.isEmpty {
        Section {
          ForEach(recent) { conversationRow($0, pinned: false) }
        } header: {
          sidebarSectionLabel("Recent")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(.compact)
    .scrollContentBackground(.hidden)
    .scrollIndicators(.hidden)
    .environment(\.defaultMinListRowHeight, 44)
  }

  private func destinationRow(_ destination: JunoMobileSection) -> some View {
    JunoMobileIPadSidebarRow(
      icon: destination.junoIcon,
      title: destination.title,
      selected: selection == destination,
      status: phoneStatus(for: destination),
      symbol: destination.sidebarSymbol
    ) {
      selectionHaptic.fire()
      openDestination(destination)
    }
    .accessibilityIdentifier("juno.mobile.sidebar-\(destination.rawValue)")
  }

  private var moreMenu: some View {
    Menu {
      ForEach(Self.sidebarOverflow) { destination in
        Button {
          openDestination(destination)
        } label: {
          Label { Text(destination.title) } icon: { JunoIconView(destination.junoIcon, size: 15) }
        }
      }
    } label: {
      JunoMobileIPadSidebarRowLabel(icon: .ellipsis, title: "More")
    }
    // A `Menu` tints its label with the accent; the row is ink.
    .tint(Color.primary)
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect(cornerRadius: 8))
    .accessibilityIdentifier("juno.mobile.sidebar-more")
  }

  /// The Mac's section header: small, semibold, secondary ink, sentence case.
  private func sidebarSectionLabel(_ key: LocalizedStringKey) -> some View {
    Text(key)
      .font(.footnote.weight(.semibold))
      .foregroundStyle(Color.junoSecondaryInk)
      .textCase(nil)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10)
      .padding(.top, 16)
      .padding(.bottom, 2)
      .accessibilityAddTraits(.isHeader)
  }

  /// Who is signed in, and the way to Settings: a plain row on a hairline,
  /// as the Mac's footer is. The column itself is the system's glass.
  var sidebarFooter: some View {
    Button(action: { openDestination(.settings) }) {
      HStack(spacing: 10) {
        JunoAvatar(
          imageData: avatarData,
          imageURL: session.profile.imageURL,
          name: profileName,
          size: 28
        )
        VStack(alignment: .leading, spacing: 0) {
          Text(profileName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1)
          if let planName = plan?.planName {
            Text(planName)
              .font(.caption)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 0)
        Image(systemName: "gearshape")
          .font(.body)
          .foregroundStyle(Color.junoSecondaryInk)
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 52)
      .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
      .hoverEffect(.highlight)
      .contentShape(.rect)
    }
    .buttonStyle(JunoSidebarPressStyle())
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect)
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .overlay(alignment: .top) {
      Rectangle().fill(Color.junoHairline).frame(height: 0.5)
    }
    .accessibilityLabel("Open settings for \(profileName)")
    .accessibilityIdentifier("juno.mobile.sidebar-profile")
  }
}

/// A compact workspace tile: 16pt monochrome glyph and label on a quiet fill.
/// The glyph takes the accent only when it is the selected destination.
struct JunoMobileSidebarTile: View {
  let junoIcon: JunoIcon
  let title: LocalizedStringKey
  var selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        JunoIconView(junoIcon, size: 16)
          .frame(width: 18)
          .foregroundStyle(selected ? Color.junoAccent : Color.junoSidebarForeground)
        Text(title)
          .font(.subheadline.weight(selected ? .semibold : .medium))
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(selected ? Color.junoSelectedFill : Color.junoMuted.opacity(0.7))
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoMobilePress)
  }
}

/// A single destination / action row: constant icon column, 44pt tall, with a
/// restrained wash only when selected.
struct JunoMobileSidebarRow: View {
  let junoIcon: JunoIcon
  let title: LocalizedStringKey
  var selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        JunoIconView(junoIcon, size: 19)
          .frame(width: 24)
          .foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
        Text(title)
          .junoFont(size: 16, relativeTo: .body, weight: selected ? .semibold : .regular)
          .foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 44)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(selected ? Color.junoMuted : .clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
  }
}

/// A dense single-line conversation row with tail truncation, and a raised
/// wash when it is the open conversation — the language's "sidebar active
/// row".
struct JunoMobileConversationRow: View {
  let title: String
  var pinned: Bool
  var pending: Bool
  var selected: Bool = false
  /// The iPad sidebar's metrics: the Mac's 15pt label and 8pt wash, with a
  /// pointer highlight.
  var sidebar: Bool = false
  let action: () -> Void

  private var radius: CGFloat { sidebar ? 8 : 10 }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if pinned {
          JunoIconView(.pin, size: 12)
            .foregroundStyle(Color.junoTertiaryInk)
        }
        Text(title)
          .junoFont(size: sidebar ? 15 : 16, relativeTo: .body)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        if pending {
          JunoIconView(.refresh, size: 12)
            .junoSecondaryInk()
        }
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 44)
      .background(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .fill(selected ? (sidebar ? Color.junoSelectedFill : Color.junoMuted) : .clear)
      )
      .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: radius, style: .continuous))
      .hoverEffect(.highlight)
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .frame(minWidth: 44, minHeight: 44)
  }
}


// MARK: - Phone drawer row

/// One destination in the phone drawer: an SF Symbol in the regular weight,
/// the label, and — only when something is waiting — a few plain words in the
/// attention colour. No tile, no chevron, no badge.
struct JunoMobileDrawerRow: View {
  let symbol: String
  let title: LocalizedStringKey
  var selected: Bool = false
  var status: JunoMobileSidebarStatus? = nil
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: symbol)
          .font(.body)
          .foregroundStyle(Color.junoForeground)
          .frame(width: 26)
        Text(title)
          .font(.body)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
        Spacer(minLength: 8)
        if let status, status.needsYou > 0 {
          Text("\(status.needsYou) waiting")
            .junoFont(size: 13, relativeTo: .footnote)
            .monospacedDigit()
            .foregroundStyle(Color.junoCaution)
        } else if let status, status.running > 0 {
          Text("\(status.running) running")
            .junoFont(size: 13, relativeTo: .footnote)
            .monospacedDigit()
            .foregroundStyle(Color.junoSecondaryInk)
        }
      }
      .padding(.horizontal, 12)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(selected ? Color.junoMuted : .clear)
      )
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(JunoSidebarPressStyle())
  }
}

extension EnvironmentValues {
  /// Whether the phone drawer is open — read by its rows to stagger in.
  @Entry var junoMobileDrawerOpen: Bool = true
}

private struct JunoMobileDrawerStagger: ViewModifier {
  let index: Int
  @Environment(\.junoMobileDrawerOpen) private var open
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .opacity(open ? 1 : 0)
      .offset(x: open || reduceMotion ? 0 : -14)
      .animation(
        JunoMotion.reduced(JunoMotion.chatLayout, when: reduceMotion, tier: .tint)?
          .delay(open ? 0.04 + Double(index) * 0.02 : 0),
        value: open
      )
  }
}

extension View {
  /// The drawer's row entrance: 20ms apart, a 14pt slide and a fade as the
  /// conversation is pushed aside; opacity alone under Reduce Motion.
  func junoMobileDrawerStagger(index: Int) -> some View {
    modifier(JunoMobileDrawerStagger(index: index))
  }
}
