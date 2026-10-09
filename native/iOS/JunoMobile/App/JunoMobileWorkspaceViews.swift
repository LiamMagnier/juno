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
  @State private var moveTarget: NativeProject?
  @State private var previewProjectID: String?
  @State private var openedPreviewProject = false
  @State private var query = ""
  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @Namespace private var zoom

  /// Top-level projects; a folder is reached from the project it sits in.
  /// A search looks through every project, folders included.
  private var filtered: [NativeProject] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return model.topLevelProjects }
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
          Label("Projects unavailable", image: JunoIcon.triangleAlert.assetName(.regular))
        } description: {
          Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
          Button("Retry") { Task { await model.reload() } }
            .contentShape(.rect)
            .modifier(JunoMobileWorkspaceActionStyle())
            .controlSize(.large)
        }
      default:
        list
      }
    }
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
          Label("New project", image: JunoIcon.plus.assetName(.regular))
        }
        .disabled(model.isMutating)
        .accessibilityIdentifier("juno.mobile.project-new")
      }
    }
    .navigationDestination(for: String.self) { projectID in
      projectPage(projectID)
    }
    .navigationDestination(item: $previewProjectID) { projectID in
      projectPage(projectID)
    }
    .onAppear {
      // The preview world's `--juno-preview-project <id>`, followed once.
      guard !openedPreviewProject else { return }
      openedPreviewProject = true
      previewProjectID = JunoMobileProjectPreview.initialProject
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
    .junoProjectDelete($deleteTarget, model: model) { deleteHaptic.fire() }
    .sheet(item: $moveTarget) { project in
      JunoMobileMoveProjectSheet(projectID: project.id, model: model)
        .presentationDetents([.medium, .large])
    }
  }

  @ViewBuilder
  private func projectPage(_ projectID: String) -> some View {
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

  // MARK: The list

  /// A plain `List`: Pinned, then the rest, each row a folder symbol, the name
  /// and one secondary line. Round 2 removed the "Your workspace" card and its
  /// stat tiles — counts belong on the rows they describe.
  private var list: some View {
    List {
      if model.conflictedMutationCount > 0 || model.phase == .offline || model.lastErrorDescription != nil {
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
        }
        .listRowSeparator(.hidden)
      }

      if model.projects.isEmpty {
        empty
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if filtered.isEmpty {
        ContentUnavailableView.search(text: query)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else {
        if !pinned.isEmpty {
          Section("Pinned") {
            ForEach(pinned) { row($0) }
          }
        }
        if !others.isEmpty {
          Section {
            ForEach(others) { row($0) }
          } header: {
            if !pinned.isEmpty { Text("Projects") }
          }
        }
      }
    }
    .listStyle(.plain)
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
    .modifier(JunoMobileZoomTransitionAnchor(id: project.id, namespace: zoom))
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button {
        pinHaptic.fire()
        Task { await model.updateProject(id: project.id, starred: !project.starred) }
      } label: {
        Label(project.starred ? "Unpin" : "Pin", image: (project.starred ? JunoIcon.pinOff : JunoIcon.pin).assetName(.regular))
      }
      .tint(.orange)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) {
        deleteTarget = project
      } label: {
        Label("Delete", image: JunoIcon.trash.assetName(.regular))
      }
      Button {
        renameValue = project.name
        renameTarget = project
      } label: {
        Label("Rename", image: JunoIcon.pencil.assetName(.regular))
      }
      .tint(.gray)
    }
    .contextMenu { projectMenu(project) }
    .disabled(project.isPending)
    .accessibilityIdentifier("juno.mobile.project-row-\(project.id)")
  }

  private var empty: some View {
    ContentUnavailableView {
      Label("No Projects", image: JunoIcon.projects.assetName(.regular))
    } description: {
      Text("A project groups chats and files, and gives every chat in it the same instructions.")
    } actions: {
      Button("New Project") { showingCreate = true }
        .contentShape(.rect)
        .modifier(JunoMobileWorkspaceActionStyle())
        .controlSize(.large)
    }
  }

  @ViewBuilder
  private func projectMenu(_ project: NativeProject) -> some View {
    Button {
      pinHaptic.fire()
      Task { await model.updateProject(id: project.id, starred: !project.starred) }
    } label: {
      Label(project.starred ? "Unpin" : "Pin", image: (project.starred ? JunoIcon.pinOff : JunoIcon.pin).assetName(.regular))
    }
    .contentShape(.rect)
    Button {
      renameValue = project.name
      renameTarget = project
    } label: {
      Label("Rename", image: JunoIcon.pencil.assetName(.regular))
    }
    .contentShape(.rect)
    Button {
      moveTarget = project
    } label: {
      Label("Move to…", image: JunoIcon.projects.assetName(.regular))
    }
    .contentShape(.rect)
    Divider()
    Button(role: .destructive) {
      deleteTarget = project
    } label: {
      Label("Delete", image: JunoIcon.trash.assetName(.regular))
    }
    .contentShape(.rect)
  }
}

/// One project as a list row: folder symbol, name, then counts and recency.
private struct JunoMobileProjectRow: View {
  let project: NativeProject
  let conversations: Int
  let files: Int

  var body: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoSymbol(.projects)
        .font(.title3)
        .foregroundStyle(.secondary)
        .frame(width: 32)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(project.name)
          .font(.body)
          .foregroundStyle(.primary)
          .lineLimit(1)
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if project.isPending {
        ProgressView()
          .controlSize(.small)
          .accessibilityLabel("Waiting to sync")
      }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
  }

  private var detail: String {
    var parts: [String] = []
    if project.starred { parts.append(String(localized: "Pinned")) }
    parts.append(JunoMobileProjectFolderLine.plural(conversations, "chat"))
    parts.append(JunoMobileProjectFolderLine.plural(files, "file"))
    parts.append(JunoMobileRelativeDate.text(project.updatedAt))
    return parts.joined(separator: " · ")
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
      Form {
        Section {
          TextField("Project name", text: $name)
            .submitLabel(.next)
            .accessibilityIdentifier("juno.mobile.project-create-name")
        } footer: {
          Text("Every chat in this project shares its instructions and files.")
        }

        Section {
          TextField("Optional", text: $instructions, axis: .vertical)
            .lineLimit(5...12)
            .accessibilityIdentifier("juno.mobile.project-create-instructions")
        } header: {
          Text("Instructions")
        } footer: {
          if let error {
            Text(error).foregroundStyle(Color.junoDanger)
          }
        }
      }
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
  }

  private func save() {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedName.isEmpty else { return }
    isSaving = true
    error = nil
    Task {
      let id = await create(trimmedName, instructions)
      if id == nil {
        error = "Alevr couldn’t create this project. Check the name and try again."
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
        JunoSymbol(file.kind == "IMAGE" ? JunoIcon.image : JunoIcon.file)
          .font(.title3)
          .foregroundStyle(.secondary)
          .frame(width: 32)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(file.fileName)
            .font(.body)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.middle)
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        if busy { ProgressView().controlSize(.small) }
      }
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button(action: open) { Label("Open", image: JunoIcon.eye.assetName(.regular)) }
      Button(action: rename) { Label("Rename", image: JunoIcon.pencil.assetName(.regular)) }
      Divider()
      Button(role: .destructive, action: delete) { Label("Delete", image: JunoIcon.trash.assetName(.regular)) }
    }
    .accessibilityLabel(file.fileName)
  }

  private var detail: String {
    var parts = [ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)]
    if let projectName, !projectName.isEmpty { parts.append(projectName) }
    parts.append(JunoMobileRelativeDate.text(file.createdAt))
    return parts.joined(separator: " · ")
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
  @State private var showingDeleted = false

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
          Label("Artifacts unavailable", image: JunoIcon.triangleAlert.assetName(.regular))
        } description: {
          Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
          Button("Retry") { Task { await model.reload() } }
            .contentShape(.rect)
            .modifier(JunoMobileWorkspaceActionStyle())
            .controlSize(.large)
        }
      default:
        content
      }
    }
    .navigationTitle("navigation.artifacts")
    .navigationBarTitleDisplayMode(.large)
    .searchable(text: $searchText, prompt: "Search artifacts")
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
    .toolbar {
      if availableKinds.count > 1 {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Picker("Show", selection: $kindFilter) {
              Text("All Artifacts").tag(NativeArtifactKind?.none)
              ForEach(availableKinds, id: \.self) { kind in
                Text(Self.kindLabel(kind)).tag(NativeArtifactKind?.some(kind))
              }
            }
          } label: {
            // Drawn glyphs: a bar item built from `Label(_, image:)` showed
            // its title in a capsule (docs/native/spacing-pass/AUDIT.md X5).
            JunoIconView(.filter, size: JunoLayout.Control.glyph, isOn: kindFilter != nil)
              .accessibilityLabel("Filter")
          }
          .accessibilityIdentifier("juno.mobile.artifacts-filter")
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showingDeleted = true
        } label: {
          JunoIconView(.trash, size: JunoLayout.Control.glyph)
            .accessibilityLabel("Recently Deleted")
        }
        .accessibilityIdentifier("juno.mobile.artifacts-recently-deleted")
      }
    }
    .sheet(isPresented: $showingDeleted) {
      JunoMobileRecentlyDeletedArtifacts(model: model) { showingDeleted = false }
    }
    .modifier(JunoMobileArtifactsPreviewHooks(model: model, showingDeleted: $showingDeleted))
  }

  /// A plain `List` of rows — kind symbol, title, one secondary line — with
  /// the kind filter in a toolbar menu rather than a row of capsule chips.
  @ViewBuilder
  private var content: some View {
    List {
      if model.phase == .offline || model.lastErrorDescription != nil {
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
        .listRowSeparator(.hidden)
      }

      if model.artifacts.isEmpty {
        ContentUnavailableView {
          Label("No Artifacts", image: JunoIcon.copy.assetName(.regular))
        } description: {
          Text("When Alevr builds a page, a component or a diagram in a chat, it’s kept here — every version of it.")
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      } else if filteredArtifacts.isEmpty {
        ContentUnavailableView.search(text: searchText)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else {
        ForEach(filteredArtifacts) { row($0) }
      }
    }
    .listStyle(.plain)
    .refreshable { await model.reload() }
    .accessibilityIdentifier("juno.mobile.artifact-list")
  }

  private func row(_ artifact: NativeArtifact) -> some View {
    NavigationLink(value: artifact.id) {
      HStack(spacing: JunoSpace.cozy) {
        JunoIconView(Self.kindIcon(artifact.kind), size: 20)
          .foregroundStyle(.secondary)
          .frame(width: 32)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(artifact.title)
            .font(.body)
            .foregroundStyle(.primary)
            .lineLimit(1)
          Text(
            [Self.kindLabel(artifact.kind), artifact.conversationTitle,
             JunoMobileRelativeDate.text(artifact.updatedAt)]
              .filter { !$0.isEmpty }
              .joined(separator: " · ")
          )
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        }
      }
      .frame(minHeight: 44)
      .accessibilityElement(children: .combine)
    }
  }

  static func kindIcon(_ kind: NativeArtifactKind) -> JunoIcon {
    switch kind {
    case .html: .web
    case .react, .code: .code
    case .markdown, .document: .file
    case .svg: .image
    case .mermaid: .workflow
    case .design: .design
    case .spreadsheet: .grid
    case .presentation: .artifacts
    }
  }

  static func kindLabel(_ kind: NativeArtifactKind) -> String {
    switch kind {
    case .html: "Page"
    case .react: "Component"
    case .code: "Code"
    case .markdown: "Document"
    case .svg: "Vector"
    case .mermaid: "Diagram"
    case .design: "Design"
    case .spreadsheet: "Spreadsheet"
    case .document: "Document"
    case .presentation: "Deck"
    }
  }
}

// MARK: - Shared

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
      VStack(alignment: .leading, spacing: JunoSpace.cozy) {
        Label(conflictMessage, image: JunoIcon.refresh.assetName(.regular))
          .font(.subheadline)
          .foregroundStyle(.secondary)
        HStack(spacing: JunoSpace.regular) {
          Button("Keep Mine", action: keepMine).contentShape(.rect)
          Button("Use Server Version", action: useServer).contentShape(.rect)
        }
        .font(.subheadline)
        .buttonStyle(.borderless)
      }
      .accessibilityIdentifier("juno.mobile.project-conflict")
    } else if offline || message != nil {
      HStack(spacing: JunoSpace.cozy) {
        JunoSymbol(offline ? JunoIcon.wifiOff : JunoIcon.triangleAlert)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        Text(message ?? offlineMessage)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
        Spacer(minLength: 0)
        Button("Retry", action: retry).contentShape(.rect)
          .font(.subheadline)
          .buttonStyle(.borderless)
      }
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
  @State private var showingImporter = false
  @State private var renameFileID: String?
  @State private var renameValue = ""
  @State private var previewURL: URL?
  @State private var localError: String?
  @State private var showingAssistant = false
  @State private var deleteTarget: NativeProject?
  @State private var showingMove = false
  @Environment(\.dismiss) private var dismissPage

  private var assistantConfiguration: ProjectWorkspaceConfiguration? {
    workspaceModel?.workspaces[project.id]
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

  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @State private var creatingFolder = false

  private func conversationRow(_ conversation: NativeProjectConversation) -> some View {
    Button {
      openConversation(conversation.id)
    } label: {
      HStack(spacing: JunoSpace.cozy) {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(conversation.title)
            .font(.body)
            .foregroundStyle(.primary)
            .lineLimit(1)
          Text(JunoMobileRelativeDate.text(conversation.lastMessageAt))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        if conversation.pinned {
          JunoSymbol(.pin)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Pinned")
        }
      }
      .frame(minHeight: 44)
      .contentShape(.rect)
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
    List {
      let crumbs = model.breadcrumbs(for: project.id)
      if !crumbs.isEmpty {
        Section {
          JunoMobileProjectBreadcrumbs(crumbs: crumbs, current: project.name)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            .listRowBackground(Color.clear)
        }
      }

      Section {
        Button {
          createProjectConversation()
        } label: {
          Label("New Chat", image: JunoIcon.compose.assetName(.regular))
        }
        .disabled(project.isPending || conversationModel == nil)
        .accessibilityIdentifier("juno.mobile.project-new-chat")
      }

      chatsSection
      JunoMobileProjectFolderSection(
        model: model,
        project: project,
        create: { creatingFolder = true }
      )
      filesSection
      instructionsSection
      JunoMobileInheritedSections(inherited: model.inherited(for: project.id))
      assistantSection
    }
    .listStyle(.insetGrouped)
    .accessibilityIdentifier("juno.mobile.project-detail")
    .navigationTitle(project.name)
    .navigationBarTitleDisplayMode(.large)
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
          // A glyph in the bar's 44pt circle, never a sentence in a capsule
          // (docs/native/spacing-pass/AUDIT.md X5). A drawn view, not a
          // `Label(_, image:)`: the bar bridges that to a bar item and shows
          // its title when it cannot resolve the symbol set.
          JunoIconView(project.starred ? .pinOff : .pin, size: JunoLayout.Control.glyph)
            .accessibilityLabel(project.starred ? "Unpin project" : "Pin project")
        }
        .disabled(project.isPending || model.isMutating)
        .accessibilityIdentifier("juno.mobile.project-pin")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button {
            editName = project.name
            showingRename = true
          } label: { Label("Rename", image: JunoIcon.pencil.assetName(.regular)) }
          Button { showingImporter = true } label: { Label("Add File", image: JunoIcon.attach.assetName(.regular)) }
          if model.newFolderRefusal(in: project.id) == nil {
            Button { creatingFolder = true } label: { Label("New Folder", image: JunoIcon.folderPlus.assetName(.regular)) }
          }
          if workspaceModel != nil {
            Button { showingAssistant = true } label: { Label("Assistant…", image: JunoIcon.userCircle.assetName(.regular)) }
          }
          Button { showingMove = true } label: { Label("Move to…", image: JunoIcon.projects.assetName(.regular)) }
          Divider()
          Button(role: .destructive) { deleteTarget = project } label: { Label("Delete", image: JunoIcon.trash.assetName(.regular)) }
        } label: {
          JunoIconView(.ellipsis, size: JunoLayout.Control.glyph)
            .accessibilityLabel("Project actions")
        }
        .disabled(project.isPending || model.isMutating)
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
    .junoProjectDelete($deleteTarget, model: model) {
      deleteHaptic.fire()
      dismissPage()
    }
    .sheet(isPresented: $showingMove) {
      JunoMobileMoveProjectSheet(projectID: project.id, model: model)
        .presentationDetents([.medium, .large])
    }
    .task(id: project.id) { await model.loadFolderDetail(id: project.id) }
    .sheet(isPresented: $creatingFolder) {
      JunoMobileNewFolderSheet(parentName: project.name) { name in
        guard await model.createFolder(name: name, in: project.id) != nil else {
          return model.lastErrorDescription ?? "Alevr couldn’t create this folder."
        }
        return nil
      }
      .presentationDetents([.medium])
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
  }

  @ViewBuilder
  private var chatsSection: some View {
    Section {
      if model.selectedConversations.isEmpty {
        Text("Chats started here share this project’s files and instructions.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        ForEach(model.selectedConversations) { conversation in
          conversationRow(conversation)
            .swipeActions(edge: .trailing) {
              Button {
                Task {
                  await conversationModel?.setProject(id: conversation.id, projectID: nil)
                }
              } label: {
                Label("Remove", image: JunoIcon.projects.assetName(.regular))
              }
              .tint(.gray)
            }
        }
      }
    } header: {
      Text("Chats")
    }
    .accessibilityIdentifier("juno.mobile.project-chats")
  }

  @ViewBuilder
  private var filesSection: some View {
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
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(role: .destructive) {
            deleteHaptic.fire()
            Task { await model.deleteFile(id: file.id) }
          } label: {
            Label("Delete", image: JunoIcon.trash.assetName(.regular))
          }
          Button {
            renameValue = file.fileName
            renameFileID = file.id
          } label: {
            Label("Rename", image: JunoIcon.pencil.assetName(.regular))
          }
          .tint(.gray)
        }
      }
      Button {
        showingImporter = true
      } label: {
        Label("Add File", image: JunoIcon.plus.assetName(.regular))
      }
      .disabled(project.isPending || model.isPerformingFileAction)
    } header: {
      Text("Files")
    } footer: {
      if model.selectedFiles.isEmpty {
        Text("Files added here are available to every chat in the project.")
      }
    }
    .accessibilityIdentifier("juno.mobile.project-files")
  }

  /// The instructions read in place (clamped, with Show all), and edited on
  /// their own page.
  @ViewBuilder
  private var instructionsSection: some View {
    Section {
      if project.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text("No instructions yet.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        JunoMobileClampedText(text: project.instructions, lineLimit: 6, monospaced: false)
          .padding(.vertical, JunoSpace.tight)
      }
      NavigationLink {
        JunoMobileProjectInstructionsEditor(model: model, project: project)
      } label: {
        Text(project.instructions.isEmpty ? "Add Instructions" : "Edit Instructions")
      }
      .disabled(project.isPending)
    } header: {
      Text("Instructions")
    } footer: {
      Text("Included in every chat in this project.")
    }
    .accessibilityIdentifier("juno.mobile.project-instructions")
  }

  @ViewBuilder
  private var assistantSection: some View {
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
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      if workspaceModel != nil {
        Button(assistantConfiguration == nil ? "Set Up Assistant" : "Edit Assistant") {
          showingAssistant = true
        }
        .disabled(project.isPending)
        .accessibilityIdentifier("juno.mobile.project-assistant")
      }
    } header: {
      Text("Assistant")
    } footer: {
      Text("Persona, model, tools and knowledge sync across your Alevr devices.")
    }
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

/// The project's instructions on a page of their own: one text editor, Save in
/// the navigation bar.
private struct JunoMobileProjectInstructionsEditor: View {
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  let project: NativeProject
  @State private var draft = ""
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        TextEditor(text: $draft)
          .font(.body)
          .frame(minHeight: 280)
          .accessibilityIdentifier("juno.mobile.project-instructions-editor")
      } footer: {
        Text("Included in every chat in this project. \(draft.count) characters.")
      }
    }
    .scrollDismissesKeyboard(.interactively)
    .navigationTitle("Instructions")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          Task {
            await model.updateProject(id: project.id, instructions: draft)
            dismiss()
          }
        }
        .disabled(project.isPending || model.isMutating || draft == project.instructions)
      }
    }
    .onAppear { draft = project.instructions }
    .onChange(of: project.instructions) { old, new in
      // A change from another device lands unless the reader is mid-edit.
      if draft == old { draft = new }
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
          Text("These defaults follow the project on every Alevr device. A model picked in the composer still wins for that chat.")
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
  @State private var publishedURL: URL?
  @State private var showingDiff = false
  @State private var editBaseVersion = 0
  @State private var designBaseVersion: Int?
  @State private var designDraft: String?
  @State private var designReloadToken = UUID()
  @State private var showingHistory = false
  @State private var download: JunoMobileArtifactDownloadFile?
  @State private var notice: String?

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
    case .spreadsheet: "Spreadsheet"
    case .document: "Document"
    case .presentation: "Deck"
    }
  }

  /// Which version is on screen, as a toolbar-style menu.
  private var versionMenu: some View {
    Menu {
      Picker("Version", selection: $selectedVersion) {
        ForEach(artifact.versions.reversed()) { candidate in
          Text(candidate.version == artifact.currentVersion
            ? "Version \(candidate.version) (Current)" : "Version \(candidate.version)")
            .tag(candidate.version)
        }
      }
    } label: {
      Label("Version \(shownVersion)", image: JunoIcon.history.assetName(.regular))
    }
    .contentShape(.rect)
    .accessibilityLabel("Version")
    .accessibilityIdentifier("juno.mobile.artifact-version")
  }

  private var shownVersion: Int {
    selectedVersion == 0 ? artifact.currentVersion : selectedVersion
  }

  /// Preview · Source (· Canvas) as the system segmented control. Kinds with a
  /// single view get no switch at all rather than a disabled one.
  @ViewBuilder
  private var modePicker: some View {
    if availableModes.count > 1 {
      Picker("View", selection: modeSelection) {
        ForEach(availableModes) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .accessibilityIdentifier("juno.mobile.artifact-view-mode")
    }
  }

  /// Opened from a chat (a sheet on iPhone, a pane on iPad): no navigation bar
  /// of its own, so the title, one secondary line and the two round glass
  /// buttons iOS sheets use (actions, close) draw here.
  private var canvasHeader: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .center, spacing: JunoSpace.cozy) {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(artifact.title)
            .font(.headline)
            .lineLimit(1)
            .accessibilityAddTraits(.isHeader)
          Text(metaLine)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: JunoSpace.snug)
        if let version, version.version != artifact.currentVersion {
          restoreButton
        }
        designDraftControls
        actionsMenu
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
        if let close {
          Button(action: close) {
            Label("Close artifact", image: JunoIcon.close.assetName(.regular))
              .labelStyle(.iconOnly)
          }
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .accessibilityIdentifier("juno.mobile.artifact-close")
        }
      }
      modePicker
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.top, JunoSpace.regular)
    .padding(.bottom, JunoSpace.cozy)
  }

  /// `kind · where it came from · version`.
  private var metaLine: String {
    var parts = [kindName]
    if let language = artifact.language, !language.isEmpty {
      parts.append(language.uppercased())
    }
    if !artifact.conversationTitle.isEmpty { parts.append(artifact.conversationTitle) }
    if artifact.versions.count > 1 { parts.append("Version \(shownVersion)") }
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

  /// Whichever header this presentation calls for, then the artifact itself,
  /// edge to edge — no card, no outline.
  private var surface: some View {
    VStack(spacing: 0) {
      if close == nil {
        if availableModes.count > 1 {
          modePicker
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)
        }
      } else {
        canvasHeader
      }

      if let version {
        JunoMobileArtifactBody(
          kind: artifact.kind,
          content: version.content,
          mode: resolvedMode,
          readOnly: !isLatestVersion,
          onEdit: isLatestVersion ? {
            if designDraft == nil { designBaseVersion = artifact.currentVersion }
            designDraft = $0
          } : nil
        )
        .id("\(artifact.id)#\(version.version)#\(designReloadToken)")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView(
          "Version unavailable",
          image: JunoIcon.refresh.assetName(.regular),
          description: Text("Reconnect to load the latest version.")
        )
      }
    }
    .background(Color(.systemBackground))
  }

  /// The navigation chrome, applied **only** in page mode. Docked, this view
  /// is a pane inside the conversation's own navigation stack, and a title or
  /// toolbar here would rename the chat the reader is still looking at.
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
          if isDesignDirty {
            ToolbarItemGroup(placement: .topBarTrailing) { designDraftControls }
          }
          if artifact.versions.count > 1 {
            ToolbarItem(placement: .topBarTrailing) { versionMenu }
          }
          ToolbarItem(placement: .topBarTrailing) {
            ShareLink(item: version?.content ?? "") {
              Label("Share", image: JunoIcon.share.assetName(.regular))
            }
            .disabled(version == nil)
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
      if !artifact.conversationID.isEmpty {
        Button { openConversation(artifact.conversationID) } label: {
          Label("Open Chat", image: JunoIcon.conversation.assetName(.regular))
        }
      }
      if close != nil {
        ShareLink(item: version?.content ?? "") {
          Label("Share Source", image: JunoIcon.share.assetName(.regular))
        }
        if artifact.versions.count > 1 {
          Picker(selection: $selectedVersion) {
            ForEach(artifact.versions.reversed()) { candidate in
              Text("Version \(candidate.version)").tag(candidate.version)
            }
          } label: {
            Label("Version", image: JunoIcon.history.assetName(.regular))
          }
          .pickerStyle(.menu)
        }
      }
      if let exportURL {
        ShareLink(item: exportURL) { Label("Share Export", image: JunoIcon.share.assetName(.regular)) }
      }
      if let publishedURL {
        ShareLink(item: publishedURL) { Text("Share published link") }
        Link("Open published version", destination: publishedURL)
      }
      if artifact.versions.count > 1 {
        Button("Compare with previous version") { showingDiff = true }
      }

      Button("Edit") {
        editValue = artifact.currentContent ?? ""
        editBaseVersion = artifact.currentVersion
          showingEditor = true
      }
      .disabled(artifact.currentContent == nil || artifact.kind.isDesignDocument)
      Button("Rename") {
        renameValue = artifact.title
        showingRename = true
      }
      Button("Version history") { showingHistory = true }
      Button("Make a copy") { makeCopy(version: version?.version) }
      Section("Download") {
        Button("This version") { downloadFile(.file) }
        Button("With history (.zip)") { downloadFile(.zipWithHistory) }
      }
      if !model.availableExportFormats.isEmpty {
        Section("Export") {
          ForEach(model.availableExportFormats, id: \.rawValue) { format in
            Button(format.rawValue.uppercased()) { export(format) }
          }
        }
      }
      Button("Move to Recently Deleted", role: .destructive) { showingDelete = true }
    } label: {
      Label("Artifact actions", image: JunoIcon.ellipsis.assetName(.regular))
        .labelStyle(.iconOnly)
    }
    .frame(minWidth: 44, minHeight: 44)
    .disabled(model.isMutating || model.isExporting)
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
        displayMode = artifact.kind.supportsRenderedPreview || artifact.kind.isSemantic ? .preview : .source
        designDraft = nil
        Task { await model.openArtifact(id: artifact.id) }
      }
      .onChange(of: artifact.currentVersion) { _, value in
        // Preserve local edits and their opened base when another device saves.
        // The next save reports a conflict instead of silently replacing them.
        if designDraft == nil { selectedVersion = value; designReloadToken = UUID() }
      }
      .onChange(of: selectedVersion) { _, _ in
        designDraft = nil
        designReloadToken = UUID()
      }
      .task(id: artifact.id) { publishedURL = await model.publicationURL(id: artifact.id) }
      .sheet(isPresented: $showingDiff) {
        NavigationStack {
          let selected = version
          let previous = artifact.versions.filter { $0.version < (selected?.version ?? 0) }.max { $0.version < $1.version }
          JunoMobileArtifactVersionDiff(previous: previous, selected: selected)
            .navigationTitle("Version changes")
            .toolbar { JunoMobileSheetClose(label: "Done") { showingDiff = false } }
        }
      }
      .alert("Rename artifact", isPresented: $showingRename) {
        TextField("Title", text: $renameValue)
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          Task { await model.renameArtifact(id: artifact.id, title: renameValue) }
        }
      }
      .sheet(isPresented: $showingHistory) {
        JunoMobileArtifactHistory(
          model: model,
          artifact: artifact,
          show: { selectedVersion = $0 },
          copied: { notice = "Copy made. You’ll find it in Artifacts." },
          done: { showingHistory = false }
        )
      }
      .fileExporter(
        isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
        document: download?.document,
        contentType: .data,
        defaultFilename: download?.name
      ) { result in
        if case .failure(let error) = result { localError = error.localizedDescription }
        download = nil
      }
      .alert(
        notice ?? "",
        isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
      ) {
        Button("OK") { notice = nil }.contentShape(.rect)
      }
      .alert("Move to Recently Deleted?", isPresented: $showingDelete) {
        Button("Cancel", role: .cancel) {}
        Button("Move", role: .destructive) {
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
            ? "These unsaved design edits will be lost. You can restore the artifact from Recently Deleted for 30 days."
            : "Its public links stop working until you restore it. You can restore it from Recently Deleted for 30 days.")
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
            .navigationTitle("Edit Artifact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { showingEditor = false }
              }
              ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                  Task {
                    if await model.saveArtifact(id: artifact.id, content: editValue, baseVersion: editBaseVersion) {
                      showingEditor = false
                    }
                  }
                }
              }
            }
        }
        .junoSheetSurface(.page)
      }
  }

  private func makeCopy(version: Int?) {
    Task {
      if await model.duplicateArtifact(id: artifact.id, version: version) != nil {
        notice = "Copy made. You’ll find it in Artifacts."
      } else {
        localError = model.lastErrorDescription ?? "Couldn’t make a copy."
      }
    }
  }

  private func downloadFile(_ format: NativeArtifactDownloadFormat) {
    Task {
      guard let file = await model.downloadArtifact(
        id: artifact.id, version: version?.version ?? artifact.currentVersion, format: format
      ) else {
        localError = model.lastErrorDescription ?? "Couldn’t download the artifact."
        return
      }
      download = JunoMobileArtifactDownloadFile(
        document: JunoMobileArtifactDownloadDocument(data: file.data), name: file.fileName
      )
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
      .accessibilityIdentifier("juno.mobile.design.discard")
      .contentShape(.rect)

      Button("Save") {
        guard let designDraft else { return }
        Task {
          await model.saveArtifact(id: artifact.id, content: designDraft, baseVersion: designBaseVersion ?? selectedVersion)
          if model.lastErrorDescription == nil {
            self.designDraft = nil
          }
        }
      }
      .fontWeight(.semibold)
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

/// Changes are computed only for the opened version pair, with a bounded
/// source size so a pasted log cannot stall the phone's main thread.
private struct JunoMobileArtifactVersionDiff: View {
  let previous: NativeArtifactVersion?
  let selected: NativeArtifactVersion?

  var body: some View {
    if let previous, let selected {
      let old = previous.content.components(separatedBy: "\n")
      let new = selected.content.components(separatedBy: "\n")
      if old.count > 2000 || new.count > 2000 {
        Text("This version is too large to compare on the phone. Export both versions to inspect the changes.")
          .padding().foregroundStyle(.secondary)
      } else {
        let difference = new.difference(from: old)
        if difference.isEmpty {
          Text("These versions have the same source.").padding().foregroundStyle(.secondary)
        } else {
          List {
            Text("Version \(previous.version) → Version \(selected.version)").font(.caption)
            ForEach(Array(difference.enumerated()), id: \.offset) { _, change in
              switch change {
              case .insert(let offset, let line, _):
                Text("+ \(offset + 1)  \(line)").font(.system(.caption, design: .monospaced)).foregroundStyle(Color.junoSuccess).textSelection(.enabled)
              case .remove(let offset, let line, _):
                Text("− \(offset + 1)  \(line)").font(.system(.caption, design: .monospaced)).foregroundStyle(Color.junoDanger).textSelection(.enabled)
              }
            }
          }
        }
      }
    } else {
      ContentUnavailableView("No previous version", image: JunoIcon.file.assetName(.regular))
    }
  }
}
