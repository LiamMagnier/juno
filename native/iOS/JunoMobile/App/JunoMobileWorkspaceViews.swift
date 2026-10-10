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
  @State private var headingPassed = false
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
        ScrollView {
          JunoMobileComposedEmpty(
            "Projects unavailable",
            message: model.lastErrorDescription ?? "Check your connection and try again."
          ) {
            Button {
              Task { await model.reload() }
            } label: {
              JunoMobileCapsuleLabel(String(localized: "Try again"), icon: .refresh)
            }
            .junoMobileCapsuleAction()
            .contentShape(Capsule())
          }
        }
      default:
        page
      }
    }
    .background(Color.junoCanvas.ignoresSafeArea())
    .junoMobileSerifTitle(String(localized: "Projects"), revealed: headingPassed)
    .searchable(text: $query, prompt: "Search projects")
    .junoHaptic(JunoMobileHaptic.pin, trigger: pinHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
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

  // MARK: The page

  /// The serif heading and New project, then the projects as tiles — Pinned
  /// first, then the rest — in two columns on a phone and more on an iPad.
  ///
  /// It was a plain `List` of folder glyphs and grey lines. The website and the
  /// Mac draw a project as a tile with its own cover, and a grid of covers is
  /// what makes two projects tell apart before their names are read.
  private var page: some View {
    GeometryReader { proxy in
      let width = proxy.size.width - JunoLayout.Page.gutter * 2
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
          heading
          if model.conflictedMutationCount > 0 || model.phase == .offline || model.lastErrorDescription != nil {
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
            .padding(JunoSpace.cozy)
            .background(
              RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
            )
          }

          if model.projects.isEmpty {
            JunoMobileComposedEmpty(
              "No projects yet",
              message: "A project keeps a topic’s chats, instructions and files together, and gives every chat in it the same instructions."
            ) {
              Button {
                showingCreate = true
              } label: {
                JunoMobileCapsuleLabel(String(localized: "New project"), icon: .plus)
              }
              .junoMobileCapsulePrimary()
              .contentShape(Capsule())
            }
          } else if filtered.isEmpty {
            JunoMobileComposedEmpty(
              "No matching projects",
              message: "Nothing is called “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”. Try another word.",
              mark: .panel
            ) {
              Button {
                query = ""
              } label: {
                JunoMobileCapsuleLabel(String(localized: "Clear search"), icon: .close)
              }
              .junoMobileCapsuleAction()
              .contentShape(Capsule())
            }
          } else {
            if !pinned.isEmpty {
              group(String(localized: "Pinned"), pinned, width: width)
            }
            if !others.isEmpty {
              group(pinned.isEmpty ? nil : String(localized: "All projects"), others, width: width)
            }
          }
        }
        .padding(.horizontal, JunoLayout.Page.gutter)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.vast)
      }
      .junoMobileTracksHeading($headingPassed, threshold: JunoSpace.vast + JunoSpace.cozy)
      .refreshable { await model.reload() }
      .accessibilityIdentifier("juno.mobile.project-list")
    }
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: JunoSpace.regular) {
      JunoMobileSerifHeading(
        String(localized: "Projects"),
        lede: model.projects.isEmpty ? nil : headingLede
      )
      if !model.projects.isEmpty {
        Button {
          showingCreate = true
        } label: {
          JunoMobileCapsuleLabel(String(localized: "New project"), icon: .plus)
        }
        .junoMobileCapsulePrimary()
        .contentShape(Capsule())
        .disabled(model.isMutating)
        .accessibilityIdentifier("juno.mobile.project-new")
      }
    }
  }

  private var headingLede: String {
    let count = model.topLevelProjects.count
    let pinnedCount = model.topLevelProjects.filter(\.starred).count
    var line = JunoMobileProjectFolderLine.plural(count, "project")
    if pinnedCount > 0 { line += " · \(pinnedCount) pinned" }
    return line
  }

  private func group(_ title: String?, _ projects: [NativeProject], width: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if let title {
        Text(title)
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .foregroundStyle(Color.junoSecondaryInk)
          .accessibilityAddTraits(.isHeader)
      }
      LazyVGrid(columns: JunoMobileProjectTileMetrics.columns(forWidth: width), spacing: JunoSpace.cozy) {
        ForEach(projects) { tile($0) }
      }
    }
  }

  private func tile(_ project: NativeProject) -> some View {
    // A destination link: the phone's stack has a typed path of sections, so
    // `NavigationLink(value: project.id)` had nowhere to go and a tap only
    // highlighted the tile.
    NavigationLink {
      projectPage(project.id)
    } label: {
      JunoMobileProjectTile(
        summary: JunoMobileProjectSummary(project, model: model),
        loadCover: { await model.accessFile(id: $0) }
      )
    }
    .buttonStyle(NativeFilePreviewPressStyle())
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .modifier(JunoMobileZoomTransitionAnchor(id: project.id, namespace: zoom))
    .contextMenu { projectMenu(project) }
    .disabled(project.isPending)
    .accessibilityIdentifier("juno.mobile.project-row-\(project.id)")
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
    // A destination link, for the same reason as the projects list's rows.
    NavigationLink {
      JunoMobileArtifactDetail(
        model: model,
        artifact: artifact,
        openConversation: openConversation
      )
      .id(artifact.id)
    } label: {
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

/// The project's instructions on a page of their own: one text editor, Save in
/// the navigation bar.
struct JunoMobileProjectInstructionsEditor: View {
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

struct JunoMobileProjectAssistantEditor: View {
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
