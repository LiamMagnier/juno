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
      header
      list
      footer
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

  private var list: some View {
    List {
      Group {
        searchRow
        newChatRow
        ForEach(JunoMobileSection.drawerDestinations.filter { $0 != .projects }) { destination in
          JunoMobileSidebarRow(
            junoIcon: destination.junoIcon,
            title: destination.title,
            selected: selection == destination,
            action: {
              selectionHaptic.fire()
              openDestination(destination)
            }
          )
        }
        if !attentionItems.isEmpty {
          attentionSummary
        }
      }
      .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 8))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)

      projectsSection

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
    .listSectionSpacing(.compact)
    .scrollContentBackground(.hidden)
    .scrollIndicators(.hidden)
    .environment(\.defaultMinListRowHeight, 40)
    .animation(
      JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
      value: projectsExpanded
    )
  }

  /// A search field in shape, a button in behaviour: tapping it opens global
  /// search, which has the real field, the results and the filters. Drawn as
  /// an inset well — the language's "recessed into the page" — so it reads as
  /// a place to type before it is tapped.
  private var searchRow: some View {
    Button {
      selectionHaptic.fire()
      openDestination(.search)
    } label: {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.search, size: 15)
          .foregroundStyle(Color.junoMutedForeground)
        Text("Search")
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(Color.junoMutedForeground)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, JunoSpace.cozy)
      .frame(height: 40)
      .background(
        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
          .fill(Color.junoMuted)
      )
      .overlay(
        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
          .strokeBorder(Color.junoHairline, lineWidth: 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoPress)
    .padding(.horizontal, 2)
    .padding(.bottom, JunoSpace.tight)
    .accessibilityLabel("navigation.search")
    .accessibilityIdentifier("juno.mobile.sidebar-search")
    .frame(minHeight: 44)
  }

  private var newChatRow: some View {
    JunoMobileSidebarRow(
      junoIcon: .new,
      title: "chat.new",
      selected: false,
      action: {
        selectionHaptic.fire()
        newChat()
      }
    )
    .disabled(!canCreateChat)
    .accessibilityIdentifier("juno.mobile.sidebar-new-chat")
  }

  // MARK: Projects

  @ViewBuilder
  private var projectsSection: some View {
    Section {
      if projectsExpanded {
        ForEach(recentProjects) { projectRow($0) }
        if projects.count > recentProjects.count || projects.isEmpty {
          Button {
            selectionHaptic.fire()
            openDestination(.projects)
          } label: {
            HStack(spacing: 7) {
              JunoIconView(.chevronRight, size: 12)
                .junoMetaInk()
                .frame(width: 14)
              Text(projects.isEmpty ? "New project" : "All projects")
                .junoFont(size: 15, relativeTo: .body)
                .foregroundStyle(Color.junoMutedForeground)
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
          }
          .buttonStyle(JunoSidebarPressStyle())
          .accessibilityIdentifier("juno.mobile.sidebar-all-projects")
        }
      }
    } header: {
      Button {
        projectsExpanded.toggle()
      } label: {
        HStack(spacing: JunoSpace.tight) {
          Text("navigation.projects")
            .junoFont(size: 14, relativeTo: .body, weight: .semibold)
            .junoSecondaryInk()
          JunoIconView(.chevronDown, size: 11)
            .junoMetaInk()
            .rotationEffect(.degrees(projectsExpanded ? 0 : -90))
          Spacer(minLength: 0)
          if selection == .projects {
            Circle().fill(Color.junoAccent).frame(width: 5, height: 5)
              .accessibilityHidden(true)
          }
        }
        .padding(.horizontal, 10)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .frame(minHeight: 44)
      .accessibilityLabel(projectsExpanded ? "Collapse projects" : "Expand projects")
      .accessibilityIdentifier("juno.mobile.sidebar-projects-toggle")
    }
    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func projectRow(_ project: NativeProject) -> some View {
    Button {
      selectionHaptic.fire()
      openProject(project.id)
    } label: {
      HStack(spacing: 7) {
        JunoIconView(.projects, size: 14)
          .foregroundStyle(project.starred ? Color.junoAccent : Color.junoSidebarForeground)
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
      .frame(minHeight: 40)
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
      pinned: pinned,
      pending: conversation.isPending,
      selected: selection == .chat && conversationModel?.selectedConversationID == conversation.id,
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

  private var attentionSummary: some View {
    Button {
      if let first = attentionItems.first { openRecent(first) }
    } label: {
      HStack(spacing: 10) {
        Circle()
          .fill(Color.junoCaution)
          .frame(width: 7, height: 7)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Needs attention")
            .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
          Text("\(attentionItems.count) item\(attentionItems.count == 1 ? "" : "s") waiting")
            .junoFont(size: 12, relativeTo: .caption)
            .junoSecondaryInk()
        }
        Spacer(minLength: 0)
        JunoIconView(.chevronRight, size: 12)
          .junoMetaInk()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .junoCard(cornerRadius: JunoRadius.card)
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoPress)
    .padding(.horizontal, 2)
    .padding(.vertical, 6)
    .accessibilityIdentifier("juno.mobile.attention-summary")
    .accessibilityLabel(
      "Needs attention, \(attentionItems.count) item\(attentionItems.count == 1 ? "" : "s") waiting"
    )
    .frame(minWidth: 44, minHeight: 44)
  }

  // MARK: - Header

  private var header: some View {
    HStack(spacing: 9) {
      JunoMark(size: 24)
      Text("Juno")
        .junoFont(size: 22, relativeTo: .body, weight: .semibold)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 10)
  }

  private func sectionLabel(_ key: LocalizedStringKey) -> some View {
    Text(key)
      .junoFont(size: 14, relativeTo: .body, weight: .semibold)
      .junoSecondaryInk()
      .textCase(nil)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10)
      .padding(.top, 12)
      .padding(.bottom, 4)
  }

  // MARK: - Footer

  /// Who is signed in, on what plan, and the drawer's one primary action.
  @ViewBuilder
  private var footer: some View {
    if #available(iOS 26.0, *) {
      GlassEffectContainer(spacing: 10) { footerControls }
    } else {
      footerControls
    }
  }

  private var profileName: String { session.profile.name ?? session.profile.email }

  private var footerControls: some View {
    HStack(spacing: 10) {
      Button(action: { openDestination(.settings) }) {
        HStack(spacing: JunoSpace.snug) {
          JunoAvatar(
            imageData: avatarData,
            imageURL: session.profile.imageURL,
            name: profileName,
            size: 30
          )
          VStack(alignment: .leading, spacing: 1) {
            Text(profileName)
              .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
              .foregroundStyle(.primary)
              .lineLimit(1)
            Text(plan?.planName ?? "Settings")
              .junoFont(size: 11, relativeTo: .caption2)
              .junoSecondaryInk()
              .lineLimit(1)
          }
        }
        .padding(.leading, 7)
        .padding(.trailing, 14)
        .frame(height: 46)
        .modifier(JunoGlassCapsule())
        .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open settings for \(profileName)")
      .accessibilityIdentifier("juno.mobile.sidebar-profile")

      Spacer(minLength: 0)

      Button(action: newChat) {
        HStack(spacing: 3) {
          JunoIconView(.new, size: 12)
          Text("navigation.chat")
            .junoFont(size: 12, relativeTo: .subheadline, weight: .semibold)
        }
        .padding(.horizontal, 1)
        .frame(minWidth: 46, minHeight: 24)
      }
      .buttonStyle(.plain)
      .foregroundStyle(Color.junoOnAccent)
      .junoAccentGlass(in: Capsule())
      .frame(height: 48)
      .disabled(!canCreateChat)
      .opacity(canCreateChat ? 1 : 0.5)
      .accessibilityLabel("chat.new")
      .accessibilityIdentifier("juno.mobile.sidebar-chat")
      .contentShape(.rect)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 8)
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
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if pinned {
          JunoIconView(.pin, size: 12)
            .foregroundStyle(Color.junoAccent)
        }
        Text(title)
          .junoFont(size: 16, relativeTo: .body, weight: selected ? .medium : .regular)
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
      .frame(minHeight: 40)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(selected ? Color.junoMuted : .clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .frame(minWidth: 44, minHeight: 44)
  }
}
