import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

#if DEBUG
  import JunoPreviewSupport
#endif

// Project folders on iPhone and iPad — the web's project subfolders
// (src/components/projects/project-folders.tsx). Breadcrumbs over a folder's
// page, a Folders tab with New folder, what a folder inherits from the
// projects above it, Move to…, and a Delete that asks where the subfolders go.
// Plain List / Form / sheets / confirmationDialog and the SF Symbol folder.

// MARK: - Breadcrumbs

/// "Atlas launch / Research / Notes". Each ancestor opens its own page on the
/// projects stack; the current project is plain text.
struct JunoMobileProjectBreadcrumbs: View {
  let crumbs: [NativeProjectCrumb]
  let current: String
  /// The page a crumb opens. A destination link, not `NavigationLink(value:)`:
  /// the phone's stack has a typed path of sections, so a pushed `String`
  /// value had no destination and a tap only highlighted the row.
  let destination: (String) -> AnyView

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: JunoSpace.hairline) {
        ForEach(crumbs) { crumb in
          NavigationLink {
            destination(crumb.id)
          } label: {
            Text(crumb.name)
              .foregroundStyle(Color.junoMutedForeground)
              .frame(minHeight: 32)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Opens \(crumb.name)")
          Text("/")
            .foregroundStyle(Color.junoMutedForeground)
            .accessibilityHidden(true)
        }
        Text(current)
          .foregroundStyle(.primary)
      }
      .font(.subheadline)
      .lineLimit(1)
    }
    .scrollIndicators(.hidden)
    .scrollBounceBehavior(.basedOnSize)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Folder path")
    .accessibilityIdentifier("juno.mobile.project-breadcrumbs")
  }
}

// MARK: - Folders tab

/// The project page's Folders section: one row per folder (the folder symbol,
/// its name, what it holds), then New Folder. Nothing at all when the project
/// has no folders and cannot take one.
struct JunoMobileProjectFolderSection: View {
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  let project: NativeProject
  let create: () -> Void
  /// The folder page a row opens (see JunoMobileProjectBreadcrumbs.destination).
  let destination: (String) -> AnyView

  private var folders: [NativeProject] { model.children(of: project.id) }
  private var refusal: NativeProjectMoveRefusal? { model.newFolderRefusal(in: project.id) }

  var body: some View {
    if !folders.isEmpty || refusal == nil {
      Section {
        ForEach(folders) { folder in
          NavigationLink {
            destination(folder.id)
          } label: {
            HStack(spacing: JunoSpace.cozy) {
              JunoSymbol(.projects)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 32)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(folder.name)
                  .font(.body)
                  .foregroundStyle(.primary)
                  .lineLimit(1)
                Text(JunoMobileProjectFolderLine.summary(folder, model: model))
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
          }
          .accessibilityIdentifier("juno.mobile.project-folder-\(folder.id)")
        }
        if refusal == nil {
          Button(action: create) {
            Label("New Folder", image: JunoIcon.plus.assetName(.regular))
          }
          .disabled(project.isPending || model.isMutating)
        }
      } header: {
        Text("Folders")
      } footer: {
        if folders.isEmpty {
          Text("A folder keeps one part of \(project.name) together. Its chats follow this project’s instructions and read its files.")
        }
      }
      .accessibilityIdentifier("juno.mobile.project-folders")
    }
  }
}

/// "3 chats · 2 files · 1 folder", plain text.
@MainActor
enum JunoMobileProjectFolderLine {
  static func summary(
    _ project: NativeProject,
    model: NativeProjectModel<SQLiteAccountRepository>
  ) -> String {
    let chats = model.conversationsByProject[project.id]?.count ?? 0
    let files = model.filesByProject[project.id]?.count ?? 0
    let folders = model.children(of: project.id).count
    var parts = [plural(chats, "chat"), plural(files, "file")]
    if folders > 0 { parts.append(plural(folders, "folder")) }
    return parts.joined(separator: " · ")
  }

  static func plural(_ count: Int, _ noun: String) -> String {
    "\(count) \(noun)\(count == 1 ? "" : "s")"
  }
}

// MARK: - Inherited context

/// Read-only sections for the instructions tab: what this folder's chats also
/// receive from each project above it.
struct JunoMobileInheritedSections: View {
  let inherited: [NativeProjectInheritance]
  /// The project page "Open …" leads to (see JunoMobileProjectBreadcrumbs.destination).
  let destination: (String) -> AnyView

  var body: some View {
    ForEach(inherited) { source in
      Section {
        let instructions = source.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if !instructions.isEmpty {
          Text(instructions)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(8)
            .textSelection(.enabled)
        }
        if source.fileCount > 0 {
          Text("Reads \(JunoMobileProjectFolderLine.plural(source.fileCount, "file"))")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        NavigationLink {
          destination(source.id)
        } label: {
          Text("Open \(source.name)")
        }
      } header: {
        Text("From \(source.name)")
      }
    }
  }
}

// MARK: - New folder

struct JunoMobileNewFolderSheet: View {
  let parentName: String
  /// Creates the folder; returns the failure to show, or nil when done.
  let create: @MainActor (String) async -> String?

  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var creating = false
  @State private var failure: String?
  @FocusState private var focused: Bool

  private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Research, Drafts, Q4…", text: $name)
            .focused($focused)
            .submitLabel(.done)
            .onSubmit(submit)
        } header: {
          Text("Inside \(parentName)")
        } footer: {
          if let failure {
            Text(failure).foregroundStyle(Color.junoDestructive)
          } else {
            Text("Its chats follow \(parentName)’s instructions and read its files, then the folder’s own.")
          }
        }
      }
      .navigationTitle("New folder")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create", action: submit)
            .disabled(trimmed.isEmpty || creating)
        }
      }
      .onAppear { focused = true }
    }
  }

  private func submit() {
    guard !trimmed.isEmpty, !creating else { return }
    creating = true
    failure = nil
    Task {
      let problem = await create(trimmed)
      creating = false
      if let problem { failure = problem } else { dismiss() }
    }
  }
}

// MARK: - Move to…

struct JunoMobileMoveProjectSheet: View {
  let projectID: String
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>

  @Environment(\.dismiss) private var dismiss
  @State private var choice: String??
  @State private var moving = false
  @State private var failure: String?

  private var project: NativeProject? { model.projects.first { $0.id == projectID } }
  private var destinations: [NativeProjectMoveDestination] { model.moveDestinations(for: projectID) }
  private var chosen: NativeProjectMoveDestination? {
    guard let choice else { return nil }
    return destinations.first { $0.projectID == choice }
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(destinations) { destination in
            row(destination)
          }
        } footer: {
          if let failure {
            Text(failure).foregroundStyle(Color.junoDestructive)
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Move “\(project?.name ?? "project")”")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Move", action: move)
            .disabled(chosen?.isAllowed != true || moving)
        }
      }
    }
    .accessibilityIdentifier("juno.mobile.project-move")
  }

  private func row(_ destination: NativeProjectMoveDestination) -> some View {
    Button {
      choice = .some(destination.projectID)
    } label: {
      HStack(spacing: JunoSpace.snug) {
        JunoSymbol(destination.projectID == nil ? JunoIcon.archive : JunoIcon.projects)
          .foregroundStyle(Color.junoMutedForeground)
          .frame(width: 22)
          .accessibilityHidden(true)
        Text(destination.name)
          .foregroundStyle(destination.isAllowed ? Color.primary : Color.secondary)
          .lineLimit(1)
        Spacer(minLength: JunoSpace.tight)
        if destination.isCurrent {
          Text("Current").foregroundStyle(.secondary)
        } else if let refusal = destination.refusal {
          Text(refusal.shortLabel).foregroundStyle(.secondary)
        } else if chosen?.id == destination.id {
          JunoSymbol(.check)
            .foregroundStyle(.tint)
            .accessibilityLabel("Selected")
        }
      }
      .padding(.leading, CGFloat(max(destination.depth - 1, 0)) * JunoSpace.regular)
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(!destination.isAllowed)
    .accessibilityAddTraits(chosen?.id == destination.id ? .isSelected : [])
  }

  private func move() {
    guard let chosen, chosen.isAllowed else { return }
    moving = true
    failure = nil
    Task {
      let moved = await model.moveProject(id: projectID, to: chosen.projectID)
      moving = false
      if moved {
        dismiss()
      } else {
        failure = model.lastErrorDescription ?? "Alevr couldn’t move this project."
      }
    }
  }
}

// MARK: - Delete

/// The one Delete both project screens use. A project holding folders asks
/// whether they move up a level (lift) or go with it (cascade).
struct JunoMobileProjectDeleteDialog: ViewModifier {
  @Binding var target: NativeProject?
  @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
  var deleted: @MainActor () -> Void = {}

  private var folderCount: Int { target.map { model.children(of: $0.id).count } ?? 0 }

  private var destination: String {
    guard let parentID = target?.parentID,
      let parent = model.projects.first(where: { $0.id == parentID })
    else { return "up to the top level" }
    return "up into \(parent.name)"
  }

  func body(content: Content) -> some View {
    content.confirmationDialog(
      target.map { "Delete “\($0.name)”?" } ?? "Delete project?",
      isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
      titleVisibility: .visible,
      presenting: target
    ) { project in
      if folderCount > 0 {
        Button("Delete, keep the folders", role: .destructive) { delete(project, .lift) }.contentShape(.rect)
        Button("Delete all", role: .destructive) { delete(project, .cascade) }.contentShape(.rect)
      } else {
        Button("Delete project", role: .destructive) { delete(project, nil) }.contentShape(.rect)
      }
      Button("Cancel", role: .cancel) {}.contentShape(.rect)
    } message: { _ in
      if folderCount > 0 {
        Text("It holds \(JunoMobileProjectFolderLine.plural(folderCount, "folder")). Keep them to move them \(destination), or delete them too. Chats are kept, unlinked.")
      } else {
        Text("Conversations are kept and unlinked; project files are removed.")
      }
    }
  }

  private func delete(_ project: NativeProject, _ mode: NativeProjectChildrenMode?) {
    deleted()
    Task {
      if let mode {
        await model.deleteProject(id: project.id, children: mode)
      } else {
        await model.deleteProject(id: project.id)
      }
    }
  }
}

extension View {
  func junoProjectDelete(
    _ target: Binding<NativeProject?>,
    model: NativeProjectModel<SQLiteAccountRepository>,
    deleted: @escaping @MainActor () -> Void = {}
  ) -> some View {
    modifier(JunoMobileProjectDeleteDialog(target: target, model: model, deleted: deleted))
  }
}

// MARK: - Preview world

/// The project page the preview world opens straight away
/// (`--juno-preview-project <id>`); nil outside a DEBUG preview run.
enum JunoMobileProjectPreview {
  static var initialProject: String? {
    #if DEBUG
      guard JunoPreviewEnvironment.isActive else { return nil }
      return JunoPreviewEnvironment.initialProject
    #else
      return nil
    #endif
  }
}
