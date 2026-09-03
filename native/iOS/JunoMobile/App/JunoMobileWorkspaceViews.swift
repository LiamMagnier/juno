import JunoChatKit
import JunoDesignSystem
import JunoStorage
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// **Projects and Artifacts** — two of the three places the account's own
/// content lives. The Library is its own screen, see `JunoMobileLibraryView`.
///
/// All three were plain `List`s with an SF Symbol, a bold line and a grey line:
/// the default shape you get for free, which is why they read as filler beside
/// the rest of the app. They are rebuilt here on the same system as Connections,
/// Tasks and Code — a serif page heading, cards on the warm canvas, a quiet
/// metadata line, and grouping that means something (favourites, file kind,
/// artifact kind) rather than one undifferentiated column.

// MARK: - Projects

struct JunoMobileProjectsView: View {
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  var workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  let openConversation: (String) -> Void
  @State private var showingCreate = false
  @State private var renameTarget: NativeProject?
  @State private var renameValue = ""
  @State private var deleteTarget: NativeProject?
  @State private var query = ""
  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @Namespace private var zoom
  @Environment(\.horizontalSizeClass) private var sizeClass

  private var filtered: [NativeProject] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return model.projects }
    return model.projects.filter {
      $0.name.localizedCaseInsensitiveContains(trimmed)
        || $0.instructions.localizedCaseInsensitiveContains(trimmed)
    }
  }

  private var pinned: [NativeProject] { filtered.filter(\.starred) }
  private var others: [NativeProject] { filtered.filter { !$0.starred } }

  var body: some View {
    Group {
      switch model.phase {
      case .idle, .loading:
        JunoMobileQuietLoading()
      case .failed where model.projects.isEmpty:
        ContentUnavailableView {
          Label {
            Text("Projects unavailable")
          } icon: {
            JunoIconView(.error, size: 30)
          }
        } description: {
          Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
          Button("Retry") { Task { await model.reload() } }
            .buttonStyle(.borderedProminent)
            .contentShape(.rect)
        }
      default:
        if sizeClass == .regular {
          grid
        } else {
          list
        }
      }
    }
    .junoScreenCanvas()
    .navigationTitle("navigation.projects")
    .navigationBarTitleDisplayMode(.large)
    .searchable(text: $query, prompt: "Search projects")
    .junoHaptic(JunoMobileHaptic.pin, trigger: pinHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showingCreate = true
        } label: {
          JunoIconView(.plus, size: 17)
        }
        .disabled(model.isMutating)
        .accessibilityLabel("New project")
        .accessibilityIdentifier("juno.mobile.project-new")
      }
    }
    .navigationDestination(for: String.self) { projectID in
      if let project = model.projects.first(where: { $0.id == projectID }) {
        JunoMobileProjectDetail(
          model: model,
          workspaceModel: workspaceModel,
          conversationModel: conversationModel,
          project: project,
          openConversation: openConversation
        )
        .onAppear { model.selectedProjectID = projectID }
        .modifier(JunoMobileZoomTransitionSource(id: projectID, namespace: zoom))
      }
    }
    .sheet(isPresented: $showingCreate) {
      JunoMobileProjectCreateSheet { name, instructions in
        await model.createProject(name: name, instructions: instructions)
      }
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
    }
    .alert(
      "Rename project",
      isPresented: Binding(
        get: { renameTarget != nil },
        set: { if !$0 { renameTarget = nil } }
      )
    ) {
      TextField("Name", text: $renameValue)
      Button("Cancel", role: .cancel) { renameTarget = nil }
        .contentShape(.rect)
      Button("Save") {
        if let target = renameTarget {
          Task { await model.updateProject(id: target.id, name: renameValue) }
        }
        renameTarget = nil
      }
      .contentShape(.rect)
    }
    .confirmationDialog(
      deleteTarget.map { "Delete “\($0.name)”?" } ?? "",
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete project", role: .destructive) {
        if let target = deleteTarget {
          deleteHaptic.fire()
          Task { await model.deleteProject(id: target.id) }
        }
        deleteTarget = nil
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { deleteTarget = nil }
        .contentShape(.rect)
    } message: {
      Text("Conversations are kept and unlinked; project files are removed.")
    }
  }

  // MARK: Phone: a list

  /// Native `List`, inset grouped: the hero tile leads, then Pinned, then the
  /// rest. Rows carry swipe actions; the tile stays a custom card because it
  /// is the one hero surface on the screen.
  private var list: some View {
    List {
      Section {
        JunoMobileWorkspaceStatus(
          conflicted: model.conflictedMutationCount > 0,
          offline: model.phase == .offline,
          message: model.lastErrorDescription,
          conflictMessage: "A project changed on another device.",
          offlineMessage: "Offline — showing saved projects.",
          retry: { Task { await model.reload() } },
          keepMine: { Task { await model.resolveConflicts(keepLocalChanges: true) } },
          useServer: { Task { await model.resolveConflicts(keepLocalChanges: false) } }
        )
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        if !model.projects.isEmpty {
          overview
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
      }

      if model.projects.isEmpty {
        Section {
          empty
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
      } else if filtered.isEmpty {
        Section {
          ContentUnavailableView.search(text: query)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
      } else {
        if !pinned.isEmpty {
          Section("Pinned") {
            ForEach(pinned) { row($0) }
          }
        }
        if !others.isEmpty {
          Section(pinned.isEmpty ? "Projects" : "All projects") {
            ForEach(others) { row($0) }
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .refreshable { await model.reload() }
    .accessibilityIdentifier("juno.mobile.project-list")
  }

  private func row(_ project: NativeProject) -> some View {
    NavigationLink(value: project.id) {
      JunoMobileProjectRow(
        project: project,
        conversations: model.conversationsByProject[project.id]?.count ?? 0,
        files: model.filesByProject[project.id]?.count ?? 0
      )
    }
    .listRowBackground(Color.junoSurface)
    .modifier(JunoMobileZoomTransitionAnchor(id: project.id, namespace: zoom))
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        pinHaptic.fire()
        Task { await model.updateProject(id: project.id, starred: !project.starred) }
      } label: {
        Label(project.starred ? "Unpin" : "Pin", systemImage: project.starred ? "pin.slash" : "pin")
      }
      .tint(Color.junoAccent)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        deleteTarget = project
      } label: {
        Label("Delete", systemImage: "trash")
      }
      Button {
        renameValue = project.name
        renameTarget = project
      } label: {
        Label("Rename", systemImage: "pencil")
      }
      .tint(Color.junoMutedForeground)
    }
    .contextMenu { projectMenu(project) }
    .disabled(project.isPending)
    .accessibilityIdentifier("juno.mobile.project-row-\(project.id)")
  }

  // MARK: iPad: a grid

  private var grid: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
        JunoMobileWorkspaceStatus(
          conflicted: model.conflictedMutationCount > 0,
          offline: model.phase == .offline,
          message: model.lastErrorDescription,
          conflictMessage: "A project changed on another device.",
          offlineMessage: "Offline — showing saved projects.",
          retry: { Task { await model.reload() } },
          keepMine: { Task { await model.resolveConflicts(keepLocalChanges: true) } },
          useServer: { Task { await model.resolveConflicts(keepLocalChanges: false) } }
        )
        if model.projects.isEmpty {
          empty
        } else {
          overview
          if !pinned.isEmpty {
            JunoGroupLabel(text: "Pinned")
            tiles(pinned)
          }
          if !others.isEmpty {
            JunoGroupLabel(text: pinned.isEmpty ? "Projects" : "All projects")
            tiles(others)
          }
          if filtered.isEmpty {
            ContentUnavailableView.search(text: query)
          }
        }
      }
      .padding(.horizontal, JunoSpace.section)
      .padding(.bottom, JunoSpace.section)
    }
    .refreshable { await model.reload() }
    .accessibilityIdentifier("juno.mobile.project-list")
  }

  private func tiles(_ projects: [NativeProject]) -> some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 260, maximum: 360), spacing: JunoSpace.cozy)],
      alignment: .leading,
      spacing: JunoSpace.cozy
    ) {
      ForEach(projects) { project in
        NavigationLink(value: project.id) {
          JunoMobileProjectTile(
            project: project,
            conversations: model.conversationsByProject[project.id]?.count ?? 0,
            files: model.filesByProject[project.id]?.count ?? 0
          )
        }
        .buttonStyle(.junoPress)
        .modifier(JunoMobileZoomTransitionAnchor(id: project.id, namespace: zoom))
        .contextMenu { projectMenu(project) }
        .disabled(project.isPending)
      }
    }
  }

  // MARK: Hero

  /// Orientation before the reader chooses a project. Every value comes from
  /// the local project snapshot, and the status is the store's own — never a
  /// string that says "Synced" whatever is happening.
  private var overview: some View {
    let conversations = model.conversationsByProject.values.reduce(0) { $0 + $1.count }
    let files = model.filesByProject.values.reduce(0) { $0 + $1.count }
    return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(spacing: JunoSpace.tight) {
        JunoWorkspaceGlyph(icon: .projects, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text("Your workspace")
            .font(JunoSerif.cardTitle)
          Text("^[\(model.projects.count) project](inflect: true)")
            .junoCaption()
        }
        Spacer(minLength: 4)
        JunoMobileProjectsSyncStatus(
          phase: model.phase,
          pending: model.pendingMutationCount,
          conflicted: model.conflictedMutationCount
        )
      }
      HStack(spacing: 0) {
        metric("Projects", value: model.projects.count, icon: .projects)
        Divider().frame(height: 28)
        metric("Chats", value: conversations, icon: .conversation)
        Divider().frame(height: 28)
        metric("Files", value: files, icon: .file)
      }
    }
    .padding(JunoSpace.regular)
    .junoCard(cornerRadius: JunoRadius.card)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.projects-overview")
  }

  private func metric(_ title: String, value: Int, icon: JunoIcon) -> some View {
    HStack(spacing: 6) {
      JunoIconView(icon, size: 12)
        .foregroundStyle(Color.junoMutedForeground)
      VStack(alignment: .leading, spacing: 1) {
        Text("\(value)")
          .junoFont(size: 16, relativeTo: .body, weight: .semibold)
          .monospacedDigit()
        Text(title)
          .junoFont(size: 10, relativeTo: .caption2, weight: .medium)
          .junoMetaInk()
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      Text("No projects yet").junoEmptyTitle()
      Text(
        "A project groups conversations and files, and gives every chat in it the same standing instructions."
      )
      .font(.callout)
      .junoSecondaryInk()
      Button {
        showingCreate = true
      } label: {
        Text("New project").fontWeight(.semibold)
      }
      .junoProminentAction()
      .controlSize(.large)
      .padding(.top, JunoSpace.hairline)
      .contentShape(.rect)
    }
    .padding(JunoSpace.regular)
    .frame(maxWidth: .infinity, alignment: .leading)
    .junoCard(cornerRadius: JunoRadius.card)
  }

  @ViewBuilder
  private func projectMenu(_ project: NativeProject) -> some View {
    Button {
      pinHaptic.fire()
      Task { await model.updateProject(id: project.id, starred: !project.starred) }
    } label: {
      Label {
        Text(project.starred ? "Unpin" : "Pin")
      } icon: {
        JunoIconView(.pin, size: 15)
      }
    }
    Button {
      renameValue = project.name
      renameTarget = project
    } label: {
      Label {
        Text("Rename")
      } icon: {
        JunoIconView(.pencil, size: 15)
      }
    }
    Divider()
    Button(role: .destructive) {
      deleteTarget = project
    } label: {
      Label {
        Text("Delete")
      } icon: {
        JunoIconView(.trash, size: 15)
      }
    }
  }
}

/// One project as a list row: glyph, name, the two counts, recency.
private struct JunoMobileProjectRow: View {
  let project: NativeProject
  let conversations: Int
  let files: Int

  var body: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoWorkspaceGlyph(icon: .projects, size: 38)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: JunoSpace.tight) {
          Text(project.name)
            .junoFont(size: 16, relativeTo: .body, weight: .medium)
            .foregroundStyle(.primary)
            .lineLimit(1)
          if project.starred {
            JunoIconView(.pin, size: 11)
              .foregroundStyle(Color.junoAccent)
              .accessibilityLabel("Pinned")
          }
          if project.isPending {
            JunoIconView(.refresh, size: 11)
              .junoSecondaryInk()
              .accessibilityLabel("Waiting to sync")
          }
        }
        HStack(spacing: JunoSpace.tight) {
          Text("^[\(conversations) chat](inflect: true)")
          Text("·").accessibilityHidden(true)
          Text("^[\(files) file](inflect: true)")
          Text("·").accessibilityHidden(true)
          Text(project.updatedAt.formatted(.relative(presentation: .named)))
        }
        .junoFont(size: 12, relativeTo: .caption)
        .junoMetaInk()
        .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, JunoSpace.hairline)
    .accessibilityElement(children: .combine)
  }
}

/// One project as a raised tile, for the iPad grid.
private struct JunoMobileProjectTile: View {
  let project: NativeProject
  let conversations: Int
  let files: Int

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .top, spacing: JunoSpace.cozy) {
        JunoWorkspaceGlyph(icon: .projects, size: 42)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: JunoSpace.tight) {
            Text(project.name)
              .font(JunoSerif.cardTitle)
              .foregroundStyle(.primary)
              .lineLimit(1)
            if project.starred {
              JunoIconView(.pin, size: 12)
                .foregroundStyle(Color.junoAccent)
            }
          }
          Text(project.updatedAt.formatted(.relative(presentation: .named)))
            .junoFont(size: 11, relativeTo: .caption2)
            .junoMetaInk()
        }
        Spacer(minLength: 0)
      }
      Text(project.instructions.isEmpty
        ? "Add instructions to give every chat a shared point of view."
        : JunoPromptPreview.text(project.instructions))
        .junoFont(size: 12, relativeTo: .caption)
        .junoSecondaryInk()
        .lineLimit(3)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: JunoSpace.snug) {
        Text("^[\(conversations) chat](inflect: true)")
        Text("·").accessibilityHidden(true)
        Text("^[\(files) file](inflect: true)")
      }
      .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
      .junoMetaInk()
    }
    .padding(JunoSpace.regular)
    .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
    .junoCard(cornerRadius: JunoRadius.card)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// "Synced", "Syncing…", "Offline" or "Conflict" — from the store's state.
struct JunoMobileProjectsSyncStatus: View {
  let phase: NativeProjectModel<SQLiteAccountRepository>.Phase
  let pending: Int
  let conflicted: Int

  private var label: (text: String, tint: Color, filled: Bool) {
    if conflicted > 0 { return ("Conflict", Color.junoCaution, true) }
    switch phase {
    case .offline: return ("Offline", Color.junoMutedForeground, false)
    case .failed: return ("Sync failed", Color.junoDanger, true)
    case .idle, .loading: return ("Syncing…", Color.junoAccent, false)
    case .ready: return (pending > 0 ? "Syncing…" : "Synced", pending > 0 ? Color.junoAccent : Color.junoSuccess, false)
    }
  }

  var body: some View {
    let state = label
    JunoStatusPill(text: state.text, tint: state.tint, filled: state.filled)
      .accessibilityLabel("Sync status: \(state.text)")
  }
}

/// A real project form rather than an alert with two cramped text fields. The
/// project name is the identity; instructions are a longer document, so the
/// two fields get distinct surfaces and enough room to edit on a phone.
private struct JunoMobileProjectCreateSheet: View {
  @Environment(\.dismiss) private var dismiss
  let create: (String, String) async -> String?
  @State private var name = ""
  @State private var instructions = ""
  @State private var isSaving = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
          VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("A home for focused work")
              .junoPageHeading(compact: true)
            Text("Every conversation in this project inherits its instructions and files.")
              .font(.callout)
              .junoSecondaryInk()
          }

          JunoCard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
              Text("Name")
                .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                .junoMetaInk()
              TextField("Project name", text: $name)
                .textFieldStyle(.plain)
                .junoFont(size: 17, relativeTo: .headline, weight: .medium)
                .submitLabel(.next)
                .accessibilityIdentifier("juno.mobile.project-create-name")
            }
          }

          JunoCard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("Instructions")
                  .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                  .junoMetaInk()
                Spacer()
                Text("Optional")
                  .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                  .junoMetaInk()
              }
              TextEditor(text: $instructions)
                .frame(minHeight: 120)
                .junoFont(size: 14, relativeTo: .subheadline, design: .monospaced)
                .scrollContentBackground(.hidden)
                .accessibilityIdentifier("juno.mobile.project-create-instructions")
            }
          }

          if let error {
            Label {
              Text(error)
            } icon: {
              JunoIconView(.error, size: 14)
            }
            .font(.caption)
            .foregroundStyle(Color.junoDanger)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.regular)
        .padding(.bottom, JunoSpace.section)
      }
      .junoScreenCanvas()
      .navigationTitle("New project")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(isSaving)
        }
        ToolbarItem(placement: .confirmationAction) {
          if isSaving {
            ProgressView()
          } else {
            Button("Create") { save() }
              .fontWeight(.semibold)
              .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }
    }
    .junoSheetSurface(.page)
  }

  private func save() {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedName.isEmpty else { return }
    isSaving = true
    error = nil
    Task {
      let id = await create(trimmedName, instructions)
      if id == nil {
        error = "Juno could not create this project. Check the name and try again."
      } else {
        dismiss()
      }
      isSaving = false
    }
  }
}

/// One file inside the project's Files card.
///
/// **A row, not a card.** It used to wrap itself in `JunoCard(padding: 12)`, and
/// the only place it is used already puts it inside a `JunoCard(padding: 0)` — so
/// every file was a 16pt-radius card sitting inside a 16pt-radius card, its
/// corners a few points from its parent's, with two hairlines running in
/// parallel. The inset was asymmetric on top of that (16 horizontal, 10
/// vertical), which is what tipped it from "nested" to visibly crooked.
///
/// The conversations section directly above it has always drawn plain rows
/// separated by dividers. This now matches it exactly — same 16/12 padding, same
/// press style, same divider — so the two sections of one screen stop being two
/// different designs.
private struct JunoMobileProjectFileRow: View {
  let file: NativeProjectFile
  let busy: Bool
  var projectName: String?
  let open: () -> Void
  let rename: () -> Void
  let delete: () -> Void

  var body: some View {
    Button(action: open) {
      HStack(spacing: JunoSpace.cozy) {
        JunoWorkspaceGlyph(
          icon: file.kind == "IMAGE" ? .photos : .file,
          size: 34
        )
        VStack(alignment: .leading, spacing: 3) {
          Text(file.fileName)
            .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.middle)
          HStack(spacing: JunoSpace.tight) {
            Text(
              ByteCountFormatter.string(
                fromByteCount: Int64(file.size), countStyle: .file
              )
            )
            if let projectName, !projectName.isEmpty {
              Text("· \(projectName)").lineLimit(1)
            }
          }
          .junoFont(size: 12, relativeTo: .caption)
          .monospacedDigit()
          .junoMetaInk()
        }
        Spacer(minLength: 0)
        if busy { ProgressView().controlSize(.small) }
        Menu {
          Button("Open", action: open)
          Button("Rename", action: rename)
          Divider()
          Button("Delete", role: .destructive, action: delete)
        } label: {
          JunoIconView(.ellipsis, size: 16)
            .junoSecondaryInk()
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("File options")
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .accessibilityLabel(file.fileName)
  }
}

enum JunoMobileFilePreview {
  static func url(
    for access: NativeProjectFileAccess,
    fileName: String
  ) throws -> URL {
    switch access {
    case .remote(let url):
      return url
    case .downloaded(let data):
      let ext = URL(fileURLWithPath: fileName).pathExtension
        .filter { $0.isLetter || $0.isNumber }
      let name =
        "juno-preview-\(UUID().uuidString)"
        + (ext.isEmpty ? "" : ".\(ext)")
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent(name)
      try data.write(to: url, options: [.atomic])
      return url
    }
  }
}

// MARK: - Artifacts

struct JunoMobileArtifactsView: View {
  @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
  let openConversation: (String) -> Void
  @State private var searchText = ""
  @State private var kindFilter: NativeArtifactKind?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var filteredArtifacts: [NativeArtifact] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    return model.artifacts.filter { artifact in
      if let kindFilter, artifact.kind != kindFilter { return false }
      guard !query.isEmpty else { return true }
      return artifact.title.localizedCaseInsensitiveContains(query)
        || artifact.conversationTitle.localizedCaseInsensitiveContains(query)
    }
  }

  /// Only the kinds actually present. A filter row offering six chips when the
  /// account has two artifacts is a menu of dead ends.
  private var availableKinds: [NativeArtifactKind] {
    NativeArtifactKind.allCases.filter { kind in
      model.artifacts.contains { $0.kind == kind }
    }
  }

  var body: some View {
    Group {
      switch model.phase {
      case .idle, .loading:
        JunoMobileQuietLoading()
      case .failed where model.artifacts.isEmpty:
        ContentUnavailableView {
          Label {
            Text("Artifacts unavailable")
          } icon: {
            JunoIconView(.error, size: 30)
          }
        } description: {
          Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
          Button("Retry") { Task { await model.reload() } }
            .buttonStyle(.borderedProminent)
            .contentShape(.rect)
        }
      default:
        content
      }
    }
    .background(Color.junoCanvas)
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(
      text: $searchText,
      placement: .navigationBarDrawer(displayMode: .always),
      prompt: "Search artifacts"
    )
    .navigationDestination(for: String.self) { id in
      if let artifact = model.artifacts.first(where: { $0.id == id }) {
        JunoMobileArtifactDetail(
          model: model,
          artifact: artifact,
          openConversation: openConversation
        )
        .id(artifact.id)
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
        JunoPageTitle(title: "navigation.artifacts", subtitle: "artifacts.subtitle")
          .padding(.top, JunoSpace.tight)

        JunoMobileWorkspaceStatus(
          conflicted: false,
          offline: model.phase == .offline,
          message: model.lastErrorDescription,
          conflictMessage: "",
          offlineMessage: "Offline — showing saved artifacts.",
          retry: { Task { await model.reload() } },
          keepMine: {},
          useServer: {}
        )

        if availableKinds.count > 1 { kindChips }

        if model.artifacts.isEmpty {
          JunoCard {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
              Text("No artifacts yet").junoFont(size: 17, relativeTo: .headline, weight: .semibold)
              Text(
                "When Juno builds a page, a component or a diagram in a chat, it is kept here — every version of it."
              )
              .font(.callout)
              .junoSecondaryInk()
            }
          }
        } else if filteredArtifacts.isEmpty {
          Text("Nothing matches this search.")
            .font(.callout)
            .junoSecondaryInk()
            .frame(maxWidth: .infinity)
            .padding(.vertical, JunoSpace.region)
        } else {
          ForEach(filteredArtifacts) { card($0) }
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.bottom, JunoSpace.section)
    }
    .accessibilityIdentifier("juno.mobile.artifact-list")
  }

  private var kindChips: some View {
    ScrollView(.horizontal) {
      HStack(spacing: JunoSpace.snug) {
        chip(nil, label: "All")
        ForEach(availableKinds, id: \.self) { kind in
          chip(kind, label: Self.kindLabel(kind))
        }
      }
      // 1pt, so the chips' capsules are not clipped by the scroll view's
      // bounds. Not a gap, so not on the ladder.
      .padding(.vertical, 1)
    }
    .scrollIndicators(.hidden)
    .scrollBounceBehavior(.basedOnSize)
  }

  /// The web's `bg-foreground text-background` inversion, not the accent.
  ///
  /// Coral is spent on primary actions and never on a filter — a row of chips
  /// where the selected one is the brightest thing on the screen reads as five
  /// buttons of which one is urgent. Ink-on-canvas says "this one" just as
  /// clearly and costs the accent nothing. The Mac's connector chips already
  /// follow this rule; this is the phone catching up.
  private func chip(_ kind: NativeArtifactKind?, label: String) -> some View {
    let active = kindFilter == kind
    return Button {
      withAnimation(
        JunoMotion.reduced(
          JunoMotion.outSoft(JunoMotion.Duration.base), when: reduceMotion
        )
      ) {
        kindFilter = kind
      }
    } label: {
      Text(label)
        .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
        .foregroundStyle(active ? Color.junoCanvas : Color.primary)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 32)
        .background(
          Capsule().fill(active ? Color.primary : Color.primary.opacity(0.06))
        )
    }
    .buttonStyle(JunoMobileChipPressStyle())
    .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect)
  }

  private func card(_ artifact: NativeArtifact) -> some View {
    NavigationLink(value: artifact.id) {
      JunoCard(padding: JunoSpace.regular) {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          HStack(spacing: JunoSpace.snug) {
            JunoWorkspaceGlyph(icon: Self.kindIcon(artifact.kind), size: 32)
            Text(Self.kindLabel(artifact.kind))
              .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
              .junoMetaInk()
            Spacer(minLength: 4)
            JunoStatusPill(
              text: "v\(artifact.currentVersion)", tint: Color.junoAccent
            )
          }
          Text(artifact.title)
            .font(JunoSerif.cardTitle)
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          HStack(spacing: JunoSpace.tight) {
            JunoIconView(.conversation, size: 12)
              .junoMetaInk()
            Text(artifact.conversationTitle)
              .font(.caption)
              .junoSecondaryInk()
              .lineLimit(1)
            Text("·").junoMetaInk()
            Text(artifact.updatedAt.formatted(.relative(presentation: .named)))
              .font(.caption)
              .junoSecondaryInk()
              .lineLimit(1)
          }
        }
      }
    }
    .buttonStyle(.plain)
  }

  private static func kindIcon(_ kind: NativeArtifactKind) -> JunoIcon {
    switch kind {
    case .html: .web
    case .react: .code
    case .code: .code
    case .markdown: .file
    case .svg: .artifacts
    case .mermaid: .branch
    case .design: .writing
    }
  }

  private static func kindLabel(_ kind: NativeArtifactKind) -> String {
    switch kind {
    case .html: "Page"
    case .react: "Component"
    case .code: "Code"
    case .markdown: "Document"
    case .svg: "Vector"
    case .mermaid: "Diagram"
    case .design: "Design"
    }
  }
}

// MARK: - Shared

/// The tinted rounded-square a workspace row leads with. A bare SF Symbol on the
/// canvas is what made these lists read as unfinished; a contained glyph gives
/// the row a left edge to align to.
private struct JunoWorkspaceGlyph: View {
  let icon: JunoIcon
  var size: CGFloat = 38

  init(icon: JunoIcon, size: CGFloat = 38) {
    self.icon = icon
    self.size = size
  }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        .fill(Color.junoAccent.opacity(0.12))
      JunoIconView(icon, size: size * 0.44)
        .foregroundStyle(Color.junoAccent)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// The offline / error / conflict strip these three screens share.
///
/// It sits *in* the scroll content rather than pinned over the bottom edge: as a
/// `safeAreaInset` it covered the last row on every one of these screens, and an
/// offline notice that hides your most recent file is worse than the outage it
/// is reporting.
struct JunoMobileWorkspaceStatus: View {
  let conflicted: Bool
  let offline: Bool
  let message: String?
  let conflictMessage: String
  let offlineMessage: String
  let retry: () -> Void
  let keepMine: () -> Void
  let useServer: () -> Void

  var body: some View {
    if conflicted {
      JunoCard(padding: JunoSpace.cozy) {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
          Label {
            Text(conflictMessage)
          } icon: {
            JunoIconView(.refresh, size: 14)
          }
          .font(.caption)
          .junoSecondaryInk()
          HStack(spacing: JunoSpace.cozy) {
            Button("Keep mine", action: keepMine)
              .contentShape(.rect)
            Spacer(minLength: 0)
            Button("Use server version", action: useServer)
              .contentShape(.rect)
          }
          .font(.caption.weight(.semibold))
          .buttonStyle(.plain)
          .foregroundStyle(Color.junoAccent)
        }
      }
      .accessibilityIdentifier("juno.mobile.project-conflict")
    } else if offline || message != nil {
      JunoInlineError(message: message ?? offlineMessage, retry: retry)
    }
  }
}
private struct JunoMobileProjectDetail: View {
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  var workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  let project: NativeProject
  let openConversation: (String) -> Void
  @State private var showingRename = false
  @State private var editName = ""
  @State private var showingInstructions = false
  @State private var instructionsDraft = ""
  @State private var showingDelete = false
  @State private var showingImporter = false
  @State private var renameFileID: String?
  @State private var renameValue = ""
  @State private var previewURL: URL?
  @State private var localError: String?
  @State private var showingAssistant = false

  private var assistantConfiguration: ProjectWorkspaceConfiguration? {
    workspaceModel?.workspaces[project.id]
  }

  /// The project's own identity, stated once in the editorial serif with its
  /// two counts beneath — the same header shape the projects *list* uses for
  /// each card, so opening one does not land somewhere that looks unrelated.
  private var header: some View {
    JunoCard(padding: 16) {
      VStack(alignment: .leading, spacing: JunoSpace.cozy) {
        HStack(spacing: JunoSpace.cozy) {
          JunoWorkspaceGlyph(icon: .projects, size: 48)
          VStack(alignment: .leading, spacing: 4) {
            Text(project.name)
              .junoPageHeading(compact: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityAddTraits(.isHeader)
            Text("Project workspace")
              .junoFont(size: 12, relativeTo: .caption, weight: .medium)
              .junoMetaInk()
          }
        }

        // Scrollable, as the artifact header's chips are. Three chips fit an
        // iPhone in English and do not fit one in German, and a fixed HStack
        // answers that by squeezing every chip until the words truncate.
        ScrollView(.horizontal) {
          HStack(spacing: JunoSpace.tight) {
            if project.starred {
              JunoMobileMetaChip(title: "Pinned", icon: .pin)
            }
            JunoMobileMetaChip(
              title: count(model.selectedConversations.count, "conversation"),
              icon: .conversation
            )
            JunoMobileMetaChip(
              title: count(model.selectedFiles.count, "file"),
              icon: .attach
            )
            JunoMobileMetaChip(
              title: "Updated \(project.updatedAt.formatted(.relative(presentation: .named)))",
              icon: .refresh
            )
          }
          .padding(.vertical, 1)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)

        Divider()

        HStack(spacing: JunoSpace.snug) {
          Button {
            createProjectConversation()
          } label: {
            JunoIconLabel("New chat", icon: .new, size: 13)
              .fontWeight(.semibold)
              .lineLimit(1)
              .minimumScaleFactor(0.85)
              .frame(maxWidth: .infinity)
          }
          .junoProminentAction()
          .controlSize(.small)
          .disabled(project.isPending || conversationModel == nil)
          .contentShape(.rect)

          Button {
            showingImporter = true
          } label: {
            JunoIconLabel("Add file", icon: .attach, size: 13)
              .lineLimit(1)
              .minimumScaleFactor(0.85)
              .frame(maxWidth: .infinity)
          }
          .modifier(JunoMobileWorkspaceActionStyle())
          .controlSize(.small)
          .disabled(project.isPending || model.isPerformingFileAction)
          .contentShape(.rect)

          Button {
            instructionsDraft = project.instructions
            showingInstructions = true
          } label: {
            JunoIconLabel("Edit", icon: .pencil, size: 13)
              .lineLimit(1)
              .minimumScaleFactor(0.85)
              .frame(maxWidth: .infinity)
          }
          .modifier(JunoMobileWorkspaceActionStyle())
          .controlSize(.small)
          .disabled(project.isPending || model.isMutating)
          .contentShape(.rect)
        }
        .frame(minHeight: 44)
      }
    }
    .padding(.top, JunoSpace.tight)
  }

  private func createProjectConversation() {
    guard !project.isPending, let conversationModel else { return }
    Task {
      if let id = await conversationModel.createConversation(
        model: assistantConfiguration?.preferredModelID,
        projectID: project.id
      ) {
        openConversation(id)
      }
    }
  }

  private func count(_ value: Int, _ noun: String) -> String {
    "\(value) \(noun)\(value == 1 ? "" : "s")"
  }

  private enum Tab: String, CaseIterable, Identifiable {
    case chats, files, instructions
    var id: String { rawValue }
    var title: String {
      switch self {
      case .chats: "Chats"
      case .files: "Files"
      case .instructions: "Instructions"
      }
    }
  }

  @State private var tab: Tab = .chats
  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()

  private func conversationRow(_ conversation: NativeProjectConversation) -> some View {
    Button {
      openConversation(conversation.id)
    } label: {
      HStack(spacing: JunoSpace.cozy) {
        if conversation.pinned {
          JunoIconView(.pin, size: 12)
            .foregroundStyle(Color.junoAccent)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(conversation.title)
            .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
            .foregroundStyle(.primary)
            .lineLimit(1)
          Text(conversation.lastMessageAt, style: .relative)
            .junoFont(size: 12, relativeTo: .caption)
            .monospacedDigit()
            .foregroundStyle(Color.junoMutedForeground)
        }
        Spacer(minLength: 8)
        JunoIconView(.chevronRight, size: 12)
          .foregroundStyle(Color.junoMutedForeground)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(conversation.title)
  }

  /// Chats · Files · Instructions, one at a time under the header.
  ///
  /// The screen used to stack four card sections and open on forty lines of
  /// prompt; a reader looking for a file scrolled past all of it. Segmented,
  /// each tab is a native `List` or `Form` at full height.
  var body: some View {
    VStack(spacing: 0) {
      header
        .padding(.horizontal, JunoSpace.regular)
      ScrollView(.horizontal, showsIndicators: false) {
        JunoMobileSegmented(
          options: Tab.allCases.map { JunoMobileSegmented<Tab>.Option($0, $0.title) },
          selection: $tab,
          accessibilityLabel: "Project section"
        )
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
      }
      switch tab {
      case .chats: chatsTab
      case .files: filesTab
      case .instructions: instructionsTab
      }
    }
    .junoScreenCanvas()
    .navigationTitle(project.name)
    .navigationBarTitleDisplayMode(.inline)
    .junoHaptic(JunoMobileHaptic.pin, trigger: pinHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          pinHaptic.fire()
          Task {
            await model.updateProject(
              id: project.id,
              starred: !project.starred
            )
          }
        } label: {
          JunoIconView(.pin, size: 16)
            .foregroundStyle(project.starred ? Color.junoAccent : Color.primary)
        }
        .disabled(project.isPending || model.isMutating)
        .accessibilityLabel(project.starred ? "Unpin project" : "Pin project")
        .accessibilityIdentifier("juno.mobile.project-pin")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Rename") {
            editName = project.name
            showingRename = true
          }
          if workspaceModel != nil {
            Button("Assistant…") { showingAssistant = true }
          }
          Button("Delete", role: .destructive) { showingDelete = true }
        } label: {
          JunoIconView(.ellipsis, size: 17)
        }
        .tint(Color.primary)
        .disabled(project.isPending || model.isMutating)
        .accessibilityLabel("Project actions")
        .accessibilityIdentifier("juno.mobile.project-menu")
      }
    }
    .alert("Rename project", isPresented: $showingRename) {
      TextField("Name", text: $editName)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        Task { await model.updateProject(id: project.id, name: editName) }
      }
    }
    .sheet(isPresented: $showingAssistant) {
      if let workspaceModel {
        JunoMobileProjectAssistantEditor(
          project: project,
          files: model.selectedFiles,
          models: conversationModel?.selectableModels ?? [],
          model: workspaceModel,
          dismiss: { showingAssistant = false }
        )
      }
    }
    .alert("Delete project?", isPresented: $showingDelete) {
      Button("Cancel", role: .cancel) {}
      Button("Delete", role: .destructive) {
        deleteHaptic.fire()
        Task { await model.deleteProject(id: project.id) }
      }
    } message: {
      Text("Linked conversations are kept. Project files are removed.")
    }
    .alert(
      "Rename file",
      isPresented: Binding(
        get: { renameFileID != nil },
        set: { if !$0 { renameFileID = nil } }
      )
    ) {
      TextField("File name", text: $renameValue)
      Button("Cancel", role: .cancel) { renameFileID = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let id = renameFileID else { return }
        renameFileID = nil
        Task { await model.renameFile(id: id, fileName: renameValue) }
      }
      .contentShape(.rect)
    }
    .alert(
      "File unavailable",
      isPresented: Binding(
        get: { localError != nil },
        set: { if !$0 { localError = nil } }
      )
    ) {
      Button("OK") { localError = nil }
        .contentShape(.rect)
    } message: {
      Text(localError ?? "Try again.")
    }
    .fileImporter(
      isPresented: $showingImporter,
      allowedContentTypes: [.data],
      allowsMultipleSelection: false
    ) { result in
      switch result {
      case .success(let urls):
        if let url = urls.first { importFile(url) }
      case .failure(let error):
        localError = error.localizedDescription
      }
    }
    .quickLookPreview($previewURL)
    .onAppear { instructionsDraft = project.instructions }
    .onChange(of: project.instructions) { old, new in
      // A change from another device lands unless the reader is mid-edit.
      if instructionsDraft == old { instructionsDraft = new }
    }
  }

  private var chatsTab: some View {
    List {
      if model.selectedConversations.isEmpty {
        ContentUnavailableView {
          Label { Text("No chats yet") } icon: { JunoIconView(.conversation, size: 28) }
        } description: {
          Text("Every chat started here shares this project's files and instructions.")
        } actions: {
          Button("New chat") { createProjectConversation() }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .disabled(project.isPending || conversationModel == nil)
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      } else {
        Section {
          ForEach(model.selectedConversations) { conversation in
            conversationRow(conversation)
              .listRowBackground(Color.junoSurface)
              .swipeActions(edge: .trailing) {
                Button {
                  Task {
                    await conversationModel?.setProject(id: conversation.id, projectID: nil)
                  }
                } label: {
                  Label("Remove", systemImage: "folder.badge.minus")
                }
                .tint(Color.junoMutedForeground)
              }
          }
        } header: {
          HStack {
            Text("^[\(model.selectedConversations.count) chat](inflect: true)")
            Spacer()
            Button("New chat") { createProjectConversation() }
              .textCase(nil)
              .disabled(project.isPending || conversationModel == nil)
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .accessibilityIdentifier("juno.mobile.project-chats")
  }

  private var filesTab: some View {
    List {
      if model.selectedFiles.isEmpty {
        ContentUnavailableView {
          Label { Text("No files yet") } icon: { JunoIconView(.attach, size: 28) }
        } description: {
          Text("Files added here are available to every conversation in the project.")
        } actions: {
          Button("Add file") { showingImporter = true }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .disabled(project.isPending || model.isPerformingFileAction)
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      } else {
        Section {
          ForEach(model.selectedFiles) { file in
            JunoMobileProjectFileRow(
              file: file,
              busy: model.isPerformingFileAction,
              open: { openFile(file) },
              rename: {
                renameValue = file.fileName
                renameFileID = file.id
              },
              delete: { Task { await model.deleteFile(id: file.id) } }
            )
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.junoSurface)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              Button(role: .destructive) {
                deleteHaptic.fire()
                Task { await model.deleteFile(id: file.id) }
              } label: {
                Label("Delete", systemImage: "trash")
              }
              Button {
                renameValue = file.fileName
                renameFileID = file.id
              } label: {
                Label("Rename", systemImage: "pencil")
              }
              .tint(Color.junoMutedForeground)
            }
          }
        } header: {
          HStack {
            Text("^[\(model.selectedFiles.count) file](inflect: true)")
            Spacer()
            Button("Add file") { showingImporter = true }
              .textCase(nil)
              .disabled(project.isPending || model.isPerformingFileAction)
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .accessibilityIdentifier("juno.mobile.project-files")
  }

  /// Instructions and the assistant, as a `Form`: the editor in place with
  /// Save, and the assistant's facts as rows that open the editor.
  private var instructionsTab: some View {
    Form {
      Section {
        TextEditor(text: $instructionsDraft)
          .junoFont(size: 14, relativeTo: .subheadline, design: .monospaced)
          .frame(minHeight: 160)
          .accessibilityIdentifier("juno.mobile.project-instructions")
        HStack {
          Text("\(instructionsDraft.count) chars")
            .junoCodeSmall()
            .junoMetaInk()
          Spacer()
          Button("Revert") { instructionsDraft = project.instructions }
            .disabled(instructionsDraft == project.instructions)
          Button("Save") {
            Task { await model.updateProject(id: project.id, instructions: instructionsDraft) }
          }
          .buttonStyle(.borderedProminent)
          .tint(Color.junoAccent)
          .disabled(project.isPending || model.isMutating || instructionsDraft == project.instructions)
        }
      } header: {
        Text("Instructions")
      } footer: {
        Text("Included in every conversation linked to this project.")
      }

      Section {
        if let assistantConfiguration {
          LabeledContent("Persona", value: assistantConfiguration.personaName ?? project.name)
          LabeledContent(
            "Model",
            value: conversationModel?.selectableModels.first {
              $0.id == assistantConfiguration.preferredModelID
            }?.displayName ?? "Account default"
          )
          LabeledContent(
            "Tools",
            value: assistantConfiguration.toolAccess.isRestricted ? "Restricted" : "Account defaults"
          )
          if !assistantConfiguration.knowledgeFileIDs.isEmpty {
            LabeledContent("Knowledge", value: count(assistantConfiguration.knowledgeFileIDs.count, "file"))
          }
        } else {
          Text("Uses the project instructions and your account defaults.")
            .junoCaption()
        }
        if workspaceModel != nil {
          Button(assistantConfiguration == nil ? "Set up assistant" : "Edit assistant") {
            showingAssistant = true
          }
          .disabled(project.isPending)
          .accessibilityIdentifier("juno.mobile.project-assistant")
        }
      } header: {
        Text("Assistant")
      } footer: {
        Text("Persona, model, tools and knowledge sync across your Juno devices.")
      }
    }
    .scrollContentBackground(.hidden)
    .scrollDismissesKeyboard(.interactively)
  }

  private func importFile(_ url: URL) {
    let projectID = project.id
    Task {
      do {
        let payload = try await Task.detached(priority: .userInitiated) {
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
          if let size, size > NativeProjectAPIClient.maximumUploadBytes {
            throw NativeProjectAPIError.fileTooLarge(
              maximumBytes: NativeProjectAPIClient.maximumUploadBytes
            )
          }
          let data = try Data(contentsOf: url, options: [.mappedIfSafe])
          let mime =
            UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
          return (data, url.lastPathComponent, mime)
        }.value
        await model.uploadFile(
          data: payload.0,
          fileName: payload.1,
          mimeType: payload.2,
          projectID: projectID
        )
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  private func openFile(_ file: NativeProjectFile) {
    Task {
      guard let access = await model.accessFile(id: file.id) else { return }
      do {
        previewURL = try JunoMobileFilePreview.url(
          for: access,
          fileName: file.fileName
        )
      } catch {
        localError = error.localizedDescription
      }
    }
  }
}

private struct JunoMobileAssistantFact: View {
  let title: String
  let value: String
  let icon: JunoIcon

  var body: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoIconView(icon, size: 16)
      .frame(width: 20)
      .foregroundStyle(Color.junoAccent)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .junoFont(size: 12, relativeTo: .caption)
          .junoMetaInk()
        Text(value)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(.primary)
      }
      Spacer(minLength: 0)
    }
  }
}

private struct JunoMobileProjectAssistantEditor: View {
  let project: NativeProject
  let files: [NativeProjectFile]
  let models: [NativeChatModelOption]
  @Bindable var model: ProjectWorkspaceModel<SQLiteAccountRepository>
  let dismiss: () -> Void

  @State private var persona: String
  @State private var preferredModelID: String?
  @State private var overridesInstructions: Bool
  @State private var instructions: String
  @State private var restrictsTools: Bool
  @State private var tools: Set<ProjectWorkspaceTool>
  @State private var knowledgeFileIDs: Set<String>

  init(
    project: NativeProject,
    files: [NativeProjectFile],
    models: [NativeChatModelOption],
    model: ProjectWorkspaceModel<SQLiteAccountRepository>,
    dismiss: @escaping () -> Void
  ) {
    self.project = project
    self.files = files
    self.models = models.filter(\.isChatCapable)
    self.model = model
    self.dismiss = dismiss
    let current = model.workspaces[project.id]
    _persona = State(initialValue: current?.personaName ?? "")
    _preferredModelID = State(initialValue: current?.preferredModelID)
    _overridesInstructions = State(initialValue: current?.instructionsOverride != nil)
    _instructions = State(initialValue: current?.instructionsOverride ?? project.instructions)
    if case .restricted(let allowed)? = current?.toolAccess {
      _restrictsTools = State(initialValue: true)
      _tools = State(initialValue: allowed)
    } else {
      _restrictsTools = State(initialValue: false)
      _tools = State(initialValue: Set(ProjectWorkspaceTool.allCases))
    }
    _knowledgeFileIDs = State(initialValue: Set(current?.knowledgeFileIDs ?? []))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(project.name, text: $persona)
          Picker("Preferred model", selection: $preferredModelID) {
            Text("Account default").tag(String?.none)
            ForEach(models) { option in
              Text(option.displayName).tag(String?.some(option.id))
            }
          }
        } header: {
          Text("Persona")
        } footer: {
          Text("These defaults follow the project on every Juno device. A model picked in the composer still wins for that chat.")
        }

        Section("Instructions") {
          Toggle("Replace project instructions", isOn: $overridesInstructions)
          if overridesInstructions {
            TextEditor(text: $instructions)
              .junoFont(size: 14, relativeTo: .subheadline, design: .monospaced)
              .frame(minHeight: 140)
          }
        }

        Section {
          Toggle("Restrict tools", isOn: $restrictsTools)
          if restrictsTools {
            ForEach(ProjectWorkspaceTool.allCases) { tool in
              Toggle(tool.displayName, isOn: toolBinding(tool))
            }
          }
        } header: {
          Text("Tools")
        } footer: {
          Text("A project can narrow your account permissions. It cannot grant a tool your account or the selected model does not have.")
        }

        if !files.isEmpty {
          Section {
            ForEach(files) { file in
              Toggle(file.fileName, isOn: knowledgeBinding(file.id))
            }
          } header: {
            Text("Knowledge")
          } footer: {
            Text("Only selected files are treated as standing reference material for this assistant.")
          }
        }

        if model.workspaces[project.id] != nil {
          Section {
            Button("Reset assistant", role: .destructive) {
              Task {
                await model.delete(projectID: project.id)
                dismiss()
              }
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .junoScreenCanvas()
      .navigationTitle("Assistant")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: dismiss)
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.isSaving {
            ProgressView()
          } else {
            Button("Save") { Task { await save() } }
          }
        }
      }
    }
    .junoSheetSurface(.page)
  }

  private func toolBinding(_ tool: ProjectWorkspaceTool) -> Binding<Bool> {
    Binding(
      get: { tools.contains(tool) },
      set: { enabled in
        if enabled { tools.insert(tool) } else { tools.remove(tool) }
      }
    )
  }

  private func knowledgeBinding(_ id: String) -> Binding<Bool> {
    Binding(
      get: { knowledgeFileIDs.contains(id) },
      set: { enabled in
        if enabled { knowledgeFileIDs.insert(id) } else { knowledgeFileIDs.remove(id) }
      }
    )
  }

  private func save() async {
    let existing = model.workspaces[project.id]
    let trimmedPersona = persona.trimmingCharacters(in: .whitespacesAndNewlines)
    let saved = await model.save(ProjectWorkspaceConfiguration(
      projectID: project.id,
      personaName: trimmedPersona.isEmpty ? nil : trimmedPersona,
      instructionsOverride: overridesInstructions ? instructions : nil,
      toolAccess: restrictsTools ? .restricted(tools) : .inheritsAccountDefaults,
      allowedConnectorIDs: existing?.allowedConnectorIDs,
      knowledgeFileIDs: files.map(\.id).filter(knowledgeFileIDs.contains),
      preferredModelID: preferredModelID
    ))
    if saved { dismiss() }
  }
}

/// Internal, not private: the chat transcript shows this beside the thread on a
/// wide screen and over it on a phone, which is the two shapes the website's
/// canvas takes.
///
/// **Two chromes, one screen.** Pushed from the Artifacts list this is a *page*:
/// the navigation bar owns the title and the actions, and the artifact's identity
/// is stated once in the editorial serif below it. Opened from a conversation it
/// is the web's *canvas* instead — `close` is non-nil — and it draws
/// `canvas-panel.tsx`'s own header: the title small and semibold, a quiet
/// meta line under it, then the view switch, share and the close control on one
/// line. That mode deliberately sets no `navigationTitle` and adds no toolbar
/// items: docked, it is a pane inside the *conversation's* navigation stack, and
/// either one would rename the chat the reader is still looking at.
struct JunoMobileArtifactDetail: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
  let artifact: NativeArtifact
  let openConversation: (String) -> Void
  /// Dismisses the canvas. Non-nil only where this view *is* the presentation —
  /// the docked pane and the phone's sheet. Nil when pushed as a page, where
  /// the navigation bar's back button already does this job.
  var close: (() -> Void)?
  @State private var selectedVersion = 0
  @State private var displayMode = JunoMobileArtifactViewMode.preview
  @State private var showingRename = false
  @State private var renameValue = ""
  @State private var showingEditor = false
  @State private var editValue = ""
  @State private var showingDelete = false
  @State private var exportURL: URL?
  @State private var localError: String?
  @State private var designDraft: String?
  @State private var designReloadToken = UUID()

  private var version: NativeArtifactVersion? {
    let target = selectedVersion == 0 ? artifact.currentVersion : selectedVersion
    return artifact.versions.first { $0.version == target }
  }

  private var isLatestVersion: Bool {
    version?.version == artifact.currentVersion
  }

  /// The views this artifact has. See ``JunoMobileArtifactViewMode``.
  private var availableModes: [JunoMobileArtifactViewMode] {
    JunoMobileArtifactViewMode.available(for: artifact.kind)
  }

  /// What is on screen, as opposed to what the reader last chose. Clamped here
  /// rather than written back, because writing state during a body evaluation
  /// to correct a one-frame mismatch is how SwiftUI is made to loop.
  private var resolvedMode: JunoMobileArtifactViewMode {
    availableModes.contains(displayMode) ? displayMode : (availableModes.first ?? .source)
  }

  private var modeSelection: Binding<JunoMobileArtifactViewMode> {
    Binding(get: { resolvedMode }, set: { displayMode = $0 })
  }

  private var isDesignDirty: Bool {
    guard artifact.kind.isDesignDocument, let designDraft, let stored = version?.content else {
      return false
    }
    return designDraft != stored
  }

  /// The one place the artifact's own identity is stated: the editorial serif
  /// for the title, then the facts about it as quiet chips. The navigation bar
  /// keeps the title too, for the moment it scrolls away.
  private var header: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      Text(artifact.title)
        .junoPageHeading(compact: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)

      ScrollView(.horizontal) {
        HStack(spacing: JunoSpace.tight) {
          JunoMobileMetaChip(
            title: artifact.conversationTitle,
            icon: .conversation
          ) {
            openConversation(artifact.conversationID)
          }
          JunoMobileMetaChip(title: kindName, icon: kindGlyph)
          if let language = artifact.language, !language.isEmpty {
            JunoMobileMetaChip(title: language)
          }
          if artifact.versions.count > 1 {
            versionChip
          }
        }
        // 1pt, so the chips' capsules are not clipped by the scroll
        // view's bounds. Not a gap, so not on the ladder.
        .padding(.vertical, 1)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollIndicators(.hidden)
    }
  }

  /// The kind as a word rather than a shout: the wire value is `MARKDOWN`, and
  /// a chip full of capitals reads as an error code.
  private var kindName: String {
    switch artifact.kind {
    case .html: "HTML"
    case .react: "React"
    case .code: "Code"
    case .markdown: "Markdown"
    case .svg: "SVG"
    case .mermaid: "Diagram"
    case .design: "Design"
    }
  }

  private var kindGlyph: JunoIcon {
    switch artifact.kind {
    case .react, .html: .code
    case .svg: .artifacts
    case .mermaid: .branch
    case .design: .writing
    case .markdown: .file
    case .code: .code
    }
  }

  /// A menu rather than a `Picker`: the bare `Picker` in a header rendered as a
  /// naked wheel label with no indication it opened anything.
  private var versionChip: some View {
    Menu {
      ForEach(artifact.versions.reversed()) { candidate in
        Button {
          selectedVersion = candidate.version
        } label: {
          if candidate.version == selectedVersion {
            JunoIconLabel(
              verbatim: "Version \(candidate.version)",
              icon: .check
            )
          } else {
            Text("Version \(candidate.version)")
          }
        }
      }
    } label: {
      JunoMobileMetaChip(
        title: "v\(selectedVersion == 0 ? artifact.currentVersion : selectedVersion)",
        icon: .refresh
      )
    }
    .accessibilityLabel("Version")
    .accessibilityIdentifier("juno.mobile.artifact-version")
    .contentShape(.rect)
  }

  /// One switch and the shares, on one line. Kinds with a single view — a code
  /// artifact — get no switch at all rather than a disabled one. A page, a
  /// graphic or a component gets three: Preview, Source and the live canvas.
  private var controls: some View {
    HStack(spacing: JunoSpace.cozy) {
      if availableModes.count > 1 {
        JunoMobileSegmented(
          options: availableModes.map { .init($0, $0.title) },
          selection: modeSelection,
          accessibilityLabel: "View"
        )
        .accessibilityIdentifier("juno.mobile.artifact-view-mode")
      }

      Spacer(minLength: 0)

      designDraftControls

      ShareLink(item: version?.content ?? "") {
        JunoIconView(.share, size: 16)
          .foregroundStyle(Color.primary.opacity(0.75))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .disabled(version == nil)
      .accessibilityLabel("Share source")

      if let exportURL {
        ShareLink(item: exportURL) {
          JunoIconView(.files, size: 16)
            .foregroundStyle(Color.primary.opacity(0.75))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Share export")
      }
    }
  }

  /// The website's canvas header: identity, then one line of facts, then the
  /// controls. `canvas-panel.tsx` draws the same three things in the same
  /// order, and the fact line is what makes an artifact read as a *file*
  /// rather than as another card in the chat.
  private var canvasHeader: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
        VStack(alignment: .leading, spacing: 2) {
          Text(artifact.title)
            .junoFont(size: 15, relativeTo: .subheadline, weight: .semibold)
            .lineLimit(1)
            .truncationMode(.tail)
            .accessibilityAddTraits(.isHeader)
          Text(metaLine)
            .junoFont(size: 12, relativeTo: .caption)
            .monospacedDigit()
            .foregroundStyle(Color.junoMutedForeground)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 6)
        if let version, version.version != artifact.currentVersion {
          restoreButton
        }
        designDraftControls
        actionsMenu
        if let close {
          Button(action: close) {
            JunoIconView(.close, size: 14)
              .foregroundStyle(Color.primary)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close artifact")
          .accessibilityIdentifier("juno.mobile.artifact-close")
        }
      }

      HStack(spacing: JunoSpace.cozy) {
        if artifact.versions.count > 1 { versionChip }
        controls
      }
    }
    .padding(.horizontal, JunoSpace.regular)
    // Taller at the top than the bottom: presented as a sheet there is no
    // navigation bar above this, only the drag indicator, and a title that
    // starts flush under it reads as a collision.
    .padding(.top, JunoSpace.regular)
    .padding(.bottom, JunoSpace.cozy)
    // `bg-card/50` over a hairline: the header is chrome, so it reads one
    // step off the canvas the artifact itself sits on.
    .background(Color.junoSurface.opacity(0.5))
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Color.junoHairline)
        .frame(height: 1)
        .accessibilityHidden(true)
    }
  }

  /// `runtime · where it came from · version`, the web's own order.
  private var metaLine: String {
    var parts = [kindName]
    if let language = artifact.language, !language.isEmpty {
      parts.append(language)
    }
    parts.append("From this conversation")
    parts.append("v\(selectedVersion == 0 ? artifact.currentVersion : selectedVersion)")
    return parts.joined(separator: " · ")
  }

  private var restoreButton: some View {
    Button("Restore") {
      guard let version else { return }
      Task { await model.restoreArtifact(id: artifact.id, version: version.version) }
    }
    .disabled(model.isMutating)
    .contentShape(.rect)
  }

  /// Whichever header this presentation calls for, then the artifact itself.
  private var surface: some View {
    VStack(spacing: 0) {
      if close == nil {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
          header
          controls
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.hairline)
        .padding(.bottom, JunoSpace.regular)
      } else {
        canvasHeader
      }

      if let version {
        JunoMobileArtifactBody(
          kind: artifact.kind,
          content: version.content,
          mode: resolvedMode,
          readOnly: !isLatestVersion,
          onEdit: isLatestVersion ? { designDraft = $0 } : nil
        )
        .id("\(artifact.id)#\(version.version)#\(designReloadToken)")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .fill(Color.junoSurface)
        )
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .padding(.horizontal, close == nil ? 16 : 12)
        .padding(.top, close == nil ? 0 : 12)
        .padding(.bottom, close == nil ? 16 : 12)
      } else {
        ContentUnavailableView {
          Label {
            Text("Version unavailable")
          } icon: {
            JunoIconView(.refresh, size: 30)
          }
        } description: {
          Text("Reconnect to hydrate the latest artifact content.")
        }
      }
    }
    .junoScreenCanvas()
  }

  /// The navigation chrome, applied **only** in page mode.
  ///
  /// Docked, this view is a pane inside the conversation's own navigation
  /// stack: a `navigationTitle` here would rename the chat the reader is still
  /// looking at, and a `toolbar` would move the artifact's actions onto the
  /// conversation's bar. Both live in ``canvasHeader`` in that mode instead.
  @ViewBuilder
  private func pageChrome(_ content: some View) -> some View {
    if close == nil {
      content
        .navigationTitle(artifact.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          if let version, version.version != artifact.currentVersion {
            ToolbarItem(placement: .topBarTrailing) { restoreButton }
          }
          ToolbarItem(placement: .topBarTrailing) { actionsMenu }
        }
    } else {
      content
    }
  }

  /// The overflow, shared by the page's navigation bar and the canvas header so
  /// an artifact opened from a chat can do everything one opened from the
  /// library can.
  private var actionsMenu: some View {
    Menu {
      Button("Edit") {
        editValue = artifact.currentContent ?? ""
        showingEditor = true
      }
      .disabled(artifact.currentContent == nil || artifact.kind.isDesignDocument)
      Button("Rename") {
        renameValue = artifact.title
        showingRename = true
      }
      if !model.availableExportFormats.isEmpty {
        Section("Export") {
          ForEach(model.availableExportFormats, id: \.rawValue) { format in
            Button(format.rawValue) { export(format) }
          }
        }
      }
      Button("Delete", role: .destructive) { showingDelete = true }
    } label: {
      JunoIconView(.ellipsis, size: 16)
    }
    .tint(Color.primary)
    .disabled(model.isMutating || model.isExporting)
    .accessibilityLabel("Artifact actions")
    .accessibilityIdentifier("juno.mobile.artifact-menu")
    .contentShape(.rect)
  }

  /// Header, then one switch, then the artifact — with the artifact getting the
  /// screen.
  ///
  /// What this replaces: a coral text button standing in for a link to the
  /// conversation, a full-width `.segmented` `Picker`, a naked `Picker` for the
  /// version, and a second coral row reading "Share source" — four competing
  /// controls stacked above a hairline, and *then* the thing the screen is
  /// about. The identity is now stated once at the top, the facts are quiet
  /// chips, Share is an icon beside the switch, and the artifact starts higher
  /// up the screen than it used to end.
  var body: some View {
    pageChrome(surface)
      .onAppear {
        selectedVersion = artifact.currentVersion
        displayMode = artifact.kind.supportsRenderedPreview ? .preview : .source
        designDraft = nil
        Task { await model.openArtifact(id: artifact.id) }
      }
      .onChange(of: artifact.currentVersion) { _, value in
        selectedVersion = value
        designDraft = nil
        designReloadToken = UUID()
      }
      .onChange(of: selectedVersion) { _, _ in
        designDraft = nil
        designReloadToken = UUID()
      }
      .alert("Rename artifact", isPresented: $showingRename) {
        TextField("Title", text: $renameValue)
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          Task { await model.renameArtifact(id: artifact.id, title: renameValue) }
        }
      }
      .alert("Delete artifact?", isPresented: $showingDelete) {
        Button("Cancel", role: .cancel) {}
        Button("Delete", role: .destructive) {
          Task {
            await model.deleteArtifact(id: artifact.id)
            if model.lastErrorDescription == nil {
              if let close { close() } else { dismiss() }
            }
          }
        }
      } message: {
        Text(
          isDesignDirty
            ? "All versions and these unsaved design edits will be removed."
            : "All versions of this artifact will be removed.")
      }
      .alert(
        "Artifact unavailable",
        isPresented: Binding(
          get: { localError != nil },
          set: { if !$0 { localError = nil } }
        )
      ) {
        Button("OK") { localError = nil }
          .contentShape(.rect)
      } message: {
        Text(localError ?? "Try again.")
      }
      .sheet(isPresented: $showingEditor) {
        NavigationStack {
          TextEditor(text: $editValue)
            .font(.system(.body, design: .monospaced))
            .padding(JunoSpace.snug)
            .junoScreenCanvas()
            .navigationTitle("Edit artifact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { showingEditor = false }
              }
              ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                  showingEditor = false
                  Task {
                    await model.saveArtifact(
                      id: artifact.id,
                      content: editValue
                    )
                  }
                }
              }
            }
        }
        .junoSheetSurface(.page)
      }
  }

  private func export(_ format: NativeArtifactExportFormat) {
    Task {
      guard let result = await model.exportArtifact(id: artifact.id, format: format)
      else { return }
      do {
        exportURL = try JunoMobileExportFile.write(
          data: result.data,
          fileName: result.fileName
        )
      } catch {
        localError = error.localizedDescription
      }
    }
  }

  @ViewBuilder
  private var designDraftControls: some View {
    if isDesignDirty {
      Button("Discard") {
        designDraft = nil
        designReloadToken = UUID()
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .accessibilityIdentifier("juno.mobile.design.discard")
      .contentShape(.rect)

      Button("Save") {
        guard let designDraft else { return }
        Task {
          await model.saveArtifact(id: artifact.id, content: designDraft)
          if model.lastErrorDescription == nil {
            self.designDraft = nil
          }
        }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .disabled(model.isMutating)
      .accessibilityIdentifier("juno.mobile.design.save")
      .contentShape(.rect)
    }
  }
}

private enum JunoMobileExportFile {
  static func write(data: Data, fileName: String) throws -> URL {
    let safeName = fileName.replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "\\", with: "_")
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("juno-\(UUID().uuidString)-\(safeName)")
    try data.write(to: url, options: [.atomic])
    return url
  }
}
