import JunoChatKit
import JunoDesignSystem
import JunoStorage
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// One project — or one folder inside a project — as the website's
/// `/projects/{id}` and the Mac's project overview draw it.
///
/// **Why not a form.** The page was an `.insetGrouped` `List`: New Chat as a
/// row, then Chats, Folders, Files, Instructions and Assistant as five grey
/// Settings sections. It read as the project's *preferences*, not the project.
/// It is now a page: the project's own cover drawing across the top, its name
/// in the display serif with one line of counts, the two things you do here
/// (New chat, Instructions), then what it holds in the web's order — folders
/// first as compact tiles, then the chats, the files as real previews, the
/// instructions, what a folder inherits, and the assistant.
///
/// A folder is a project inside a project, so it opens this same page, with
/// the path above its name. Every way into another project's page — a folder
/// tile, a breadcrumb, "From …" — is a destination link (`NavigationLink {
/// destination } label:`), never `NavigationLink(value:)`: the phone's stack
/// has a typed path of sections, and a pushed `String` had nowhere to go.
struct JunoMobileProjectDetail: View {
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
  @State private var creatingFolder = false
  @State private var headingPassed = false
  @State private var previews = NativeFilePreviewLoader()
  @State private var pinHaptic = JunoMobileHapticTrigger()
  @State private var deleteHaptic = JunoMobileHapticTrigger()
  @Environment(\.dismiss) private var dismissPage

  private var assistantConfiguration: ProjectWorkspaceConfiguration? {
    workspaceModel?.workspaces[project.id]
  }

  private var summary: JunoMobileProjectSummary { JunoMobileProjectSummary(project, model: model) }
  private var isFolder: Bool { !model.breadcrumbs(for: project.id).isEmpty }

  private var chats: [NativeProjectConversation] {
    model.selectedConversations.sorted { lhs, rhs in
      if lhs.pinned != rhs.pinned { return lhs.pinned }
      return lhs.lastMessageAt > rhs.lastMessageAt
    }
  }

  private var files: [NativeProjectFile] {
    model.selectedFiles.filter { $0.fileName != JunoMobileProjectSummary.coverFileName }
  }

  /// Another project's page (a folder, an ancestor, an inherited source), as a
  /// destination link pushes it on whichever stack this page sits in.
  private func page(_ id: String) -> AnyView {
    guard let other = model.projects.first(where: { $0.id == id }) else { return AnyView(EmptyView()) }
    return AnyView(
      JunoMobileProjectDetail(
        model: model,
        workspaceModel: workspaceModel,
        conversationModel: conversationModel,
        project: other,
        openConversation: openConversation
      )
      .onAppear { model.selectedProjectID = id }
    )
  }

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.wide) {
          header
          status
          JunoMobileProjectFolderSection(
            model: model,
            project: project,
            width: proxy.size.width - JunoLayout.Page.gutter * 2,
            create: { creatingFolder = true },
            destination: page
          )
          chatsSection
          filesSection(width: proxy.size.width - JunoLayout.Page.gutter * 2)
          instructionsSection
          JunoMobileInheritedSections(inherited: model.inherited(for: project.id), destination: page)
          assistantSection
        }
        .padding(.horizontal, JunoLayout.Page.gutter)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.vast)
        .frame(maxWidth: JunoMobileProjectPageMetrics.measure)
        .frame(maxWidth: .infinity)
      }
      .junoMobileTracksHeading($headingPassed, threshold: JunoMobileProjectPageMetrics.headingThreshold)
      .refreshable { await model.reload() }
    }
    .background(Color.junoCanvas.ignoresSafeArea())
    .accessibilityIdentifier("juno.mobile.project-detail")
    .junoMobileSerifTitle(project.name, revealed: headingPassed)
    .junoHaptic(JunoMobileHaptic.pin, trigger: pinHaptic)
    .junoHaptic(JunoMobileHaptic.delete, trigger: deleteHaptic)
    .toolbar { toolbar }
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
          files: files,
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

  // MARK: - Toolbar

  /// Pin and More, side by side so the bar draws them as one glass capsule —
  /// the chat header's pair.
  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        togglePin()
      } label: {
        // A drawn view, not a `Label(_, image:)`: the bar bridges that to a
        // bar item and shows its title when it cannot resolve the symbol set.
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

  // MARK: - Header

  /// The cover across the page — the same drawing the project's tile wears,
  /// so the page is recognisably the tile you pressed — then the path, the
  /// serif name, the counts and the two actions.
  private var header: some View {
    VStack(alignment: .leading, spacing: JunoSpace.regular) {
      ZStack(alignment: .bottomLeading) {
        JunoMobileProjectCover(
          seed: project.id,
          folders: summary.folders,
          coverID: summary.cover?.id,
          load: { await model.accessFile(id: $0) }
        )
        .frame(maxWidth: .infinity)
        .frame(height: JunoMobileProjectPageMetrics.cover)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
      }

      VStack(alignment: .leading, spacing: JunoSpace.snug) {
        let crumbs = model.breadcrumbs(for: project.id)
        if !crumbs.isEmpty {
          JunoMobileProjectBreadcrumbs(crumbs: crumbs, current: project.name, destination: page)
        }
        JunoMobileSerifHeading(
          project.name,
          caption: crumbs.isEmpty ? String(localized: "Project") : nil,
          lede: lede
        )
      }

      HStack(spacing: JunoSpace.snug) {
        Button {
          createProjectConversation()
        } label: {
          JunoMobileCapsuleLabel(String(localized: "New chat"), icon: .newChat)
        }
        .junoMobileCapsulePrimary()
        .contentShape(Capsule())
        .disabled(project.isPending || conversationModel == nil)
        .accessibilityIdentifier("juno.mobile.project-new-chat")

        NavigationLink {
          JunoMobileProjectInstructionsEditor(model: model, project: project)
        } label: {
          JunoMobileCapsuleLabel(String(localized: "Instructions"), icon: .compose)
        }
        .junoMobileCapsuleAction()
        .contentShape(Capsule())
        .disabled(project.isPending)
      }
    }
  }

  /// "3 chats · 2 files · Updated 2 hr", in tabular digits.
  private var lede: String {
    var parts = [
      JunoMobileProjectFolderLine.plural(summary.chats, "chat"),
      JunoMobileProjectFolderLine.plural(files.count, "file"),
    ]
    if summary.folders > 0 { parts.append(JunoMobileProjectFolderLine.plural(summary.folders, "folder")) }
    parts.append(String(localized: "Updated \(JunoMobileRelativeDate.text(project.updatedAt))"))
    return parts.joined(separator: " · ")
  }

  @ViewBuilder
  private var status: some View {
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
  }

  // MARK: - Chats

  private var newChatAction: (() -> Void)? {
    guard !project.isPending, conversationModel != nil else { return nil }
    return { createProjectConversation() }
  }

  private var addFileAction: (() -> Void)? {
    guard !project.isPending else { return nil }
    return { showingImporter = true }
  }

  private var chatsSection: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      JunoMobilePageSectionHeader("Chats", count: chats.count)
      if chats.isEmpty {
        JunoMobileProjectInvitation(
          icon: .chats,
          text: "Chats started here share \(project.name)’s files and instructions.",
          actionTitle: String(localized: "New chat"),
          actionIcon: .newChat,
          action: newChatAction
        )
      } else {
        VStack(spacing: 0) {
          ForEach(Array(chats.enumerated()), id: \.element.id) { index, conversation in
            if index > 0 {
              Divider().padding(.leading, JunoSpace.regular)
            }
            conversationRow(conversation)
          }
        }
        .background(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .fill(Color.junoCard)
        )
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.project-chats")
  }

  private func conversationRow(_ conversation: NativeProjectConversation) -> some View {
    Button {
      openConversation(conversation.id)
    } label: {
      HStack(spacing: JunoSpace.cozy) {
        JunoIconView(conversation.pinned ? .pin : .conversation, size: JunoLayout.Row.touchGlyph, isOn: conversation.pinned)
          .foregroundStyle(conversation.pinned ? Color.junoForeground : Color.junoSecondaryInk)
          .frame(width: JunoLayout.Row.glyphSlot)
          .accessibilityHidden(true)
        Text(conversation.title)
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
        Spacer(minLength: JunoSpace.snug)
        Text(JunoMobileRelativeDate.text(conversation.lastMessageAt))
          .junoFont(size: 13, relativeTo: .footnote)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
      }
      .padding(.horizontal, JunoSpace.regular)
      .frame(minHeight: JunoLayout.Row.height + JunoSpace.hairline * 2)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button { openConversation(conversation.id) } label: {
        Label("Open", image: JunoIcon.conversation.assetName(.regular))
      }
      Button {
        Task { await conversationModel?.setProject(id: conversation.id, projectID: nil) }
      } label: {
        Label("Remove from Project", image: JunoIcon.projects.assetName(.regular))
      }
    }
    .accessibilityLabel(conversation.pinned ? "\(conversation.title), pinned" : conversation.title)
  }

  // MARK: - Files

  private func filesSection(width: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      JunoMobilePageSectionHeader("Files", count: files.count) {
        if !files.isEmpty {
          Button {
            showingImporter = true
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Add file"), icon: .plus)
          }
          .junoMobileCapsuleAction(.regular)
          .contentShape(Capsule())
          .disabled(project.isPending || model.isPerformingFileAction)
        }
      }
      if files.isEmpty {
        JunoMobileProjectInvitation(
          icon: .files,
          text: "Files added here are read by every chat in \(project.name).",
          actionTitle: String(localized: "Add file"),
          actionIcon: .plus,
          action: addFileAction
        )
      } else {
        LazyVGrid(columns: JunoMobileLibraryMetrics.columns(forWidth: width), spacing: JunoSpace.cozy) {
          ForEach(files) { file in
            fileTile(file)
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.project-files")
  }

  private func fileTile(_ file: NativeProjectFile) -> some View {
    let request = NativeFilePreviewRequest(file)
    return Button {
      openFile(file)
    } label: {
      JunoMobileFileTile(request: request, state: previews.state(for: file.id), date: file.createdAt)
    }
    .buttonStyle(NativeFilePreviewPressStyle())
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .contextMenu {
      Button { openFile(file) } label: { Label("Open", image: JunoIcon.eye.assetName(.regular)) }
      Button {
        renameValue = file.fileName
        renameFileID = file.id
      } label: { Label("Rename", image: JunoIcon.pencil.assetName(.regular)) }
      Divider()
      Button(role: .destructive) {
        deleteHaptic.fire()
        Task { await model.deleteFile(id: file.id) }
      } label: { Label("Delete", image: JunoIcon.trash.assetName(.regular)) }
    }
    .task(id: file.id) { await previews.load(request) { await model.accessFile(id: file.id) } }
  }

  // MARK: - Instructions

  /// Read in place (clamped, with Show all), edited on their own page.
  private var instructionsSection: some View {
    let trimmed = project.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
    return VStack(alignment: .leading, spacing: JunoSpace.snug) {
      JunoMobilePageSectionHeader("Instructions") {
        if !trimmed.isEmpty {
          NavigationLink {
            JunoMobileProjectInstructionsEditor(model: model, project: project)
          } label: {
            JunoMobileCapsuleLabel(String(localized: "Edit"), icon: .pencil)
          }
          .junoMobileCapsuleAction(.regular)
          .contentShape(Capsule())
          .disabled(project.isPending)
        }
      }
      if trimmed.isEmpty {
        JunoMobileProjectInvitation(
          icon: .compose,
          text: "Instructions are included in every chat in \(project.name): who to be, what to know, how to answer.",
          actionTitle: String(localized: "Add instructions"),
          actionIcon: .plus,
          destination: project.isPending ? nil : AnyView(JunoMobileProjectInstructionsEditor(model: model, project: project))
        )
      } else {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          JunoMobileClampedText(text: project.instructions, lineLimit: 6, monospaced: false)
          Text("Included in every chat in this project.")
            .junoFont(size: 12, relativeTo: .caption)
            .foregroundStyle(Color.junoTertiaryInk)
        }
        .padding(JunoLayout.Page.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .fill(Color.junoCard)
        )
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.project-instructions")
  }

  // MARK: - Assistant

  private var assistantSection: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      JunoMobilePageSectionHeader("Assistant") {
        if workspaceModel != nil {
          Button {
            showingAssistant = true
          } label: {
            JunoMobileCapsuleLabel(
              assistantConfiguration == nil ? String(localized: "Set up") : String(localized: "Edit"),
              icon: assistantConfiguration == nil ? .sparkles : .pencil
            )
          }
          .junoMobileCapsuleAction(.regular)
          .contentShape(Capsule())
          .disabled(project.isPending)
          .accessibilityIdentifier("juno.mobile.project-assistant")
        }
      }
      VStack(spacing: 0) {
        if let assistantConfiguration {
          assistantLine("Persona", assistantConfiguration.personaName ?? project.name)
          Divider().padding(.leading, JunoSpace.regular)
          assistantLine(
            "Model",
            conversationModel?.selectableModels.first {
              $0.id == assistantConfiguration.preferredModelID
            }?.displayName ?? String(localized: "Account default")
          )
          Divider().padding(.leading, JunoSpace.regular)
          assistantLine(
            "Tools",
            assistantConfiguration.toolAccess.isRestricted ? String(localized: "Restricted") : String(localized: "Account defaults")
          )
          if !assistantConfiguration.knowledgeFileIDs.isEmpty {
            Divider().padding(.leading, JunoSpace.regular)
            assistantLine(
              "Knowledge",
              JunoMobileProjectFolderLine.plural(assistantConfiguration.knowledgeFileIDs.count, "file")
            )
          }
        } else {
          HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoIconView(.userCircle, size: JunoLayout.Row.touchGlyph)
              .foregroundStyle(Color.junoSecondaryInk)
              .accessibilityHidden(true)
            Text("Uses the project instructions and your account defaults. Persona, model, tools and knowledge sync across your Alevr devices.")
              .junoFont(size: 14, relativeTo: .subheadline)
              .foregroundStyle(Color.junoSecondaryInk)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
          .padding(JunoLayout.Page.cardPadding)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .fill(Color.junoCard)
      )
      .overlay(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
      )
    }
  }

  private func assistantLine(_ title: LocalizedStringKey, _ value: String) -> some View {
    HStack(spacing: JunoSpace.cozy) {
      Text(title)
        .junoFont(size: 15, relativeTo: .subheadline)
        .foregroundStyle(Color.junoForeground)
      Spacer(minLength: JunoSpace.snug)
      Text(value)
        .junoFont(size: 15, relativeTo: .subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(1)
    }
    .padding(.horizontal, JunoSpace.regular)
    .frame(minHeight: JunoLayout.Row.height)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Actions

  private func togglePin() {
    pinHaptic.fire()
    Task { await model.updateProject(id: project.id, starred: !project.starred) }
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
        previewURL = try JunoMobileFilePreview.url(for: access, fileName: file.fileName)
      } catch {
        localError = error.localizedDescription
      }
    }
  }
}

enum JunoMobileProjectPageMetrics {
  /// The cover band across the top of the page.
  static let cover: CGFloat = JunoSpace.vast * 2 + JunoSpace.region
  /// The page's reading measure on an iPad: the web's `max-w-4xl` column.
  static let measure: CGFloat = 896
  /// Scrolled this far, the serif name has left the screen and the bar takes
  /// over the title.
  static let headingThreshold: CGFloat = cover + JunoSpace.vast + JunoSpace.region
}

// MARK: - Invitation

/// A section with nothing in it yet, said in the section's own voice with the
/// verb beside it — the Mac's folders invitation: a glyph in a soft circle, one
/// sentence, one capsule, inside a dashed well rather than a bare grey line.
struct JunoMobileProjectInvitation: View {
  let icon: JunoIcon
  let text: String
  var actionTitle: String?
  var actionIcon: JunoIcon = .plus
  var action: (() -> Void)?
  /// For an action that opens a page rather than doing something.
  var destination: AnyView?

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .center, spacing: JunoSpace.cozy) {
        JunoIconView(icon, size: JunoLayout.Row.touchGlyph)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(width: JunoSpace.expanse, height: JunoSpace.expanse)
          .background(Circle().fill(Color.junoSecondary))
          .accessibilityHidden(true)
        Text(text)
          .junoFont(size: 14, relativeTo: .subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if let actionTitle {
        if let destination {
          NavigationLink {
            destination
          } label: {
            JunoMobileCapsuleLabel(actionTitle, icon: actionIcon)
          }
          .junoMobileCapsuleAction(.regular)
          .contentShape(Capsule())
          .padding(.leading, JunoSpace.expanse + JunoSpace.cozy)
        } else if let action {
          Button(action: action) {
            JunoMobileCapsuleLabel(actionTitle, icon: actionIcon)
          }
          .junoMobileCapsuleAction(.regular)
          .contentShape(Capsule())
          .padding(.leading, JunoSpace.expanse + JunoSpace.cozy)
        }
      }
    }
    .padding(JunoLayout.Page.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
    )
  }
}
