import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

// Project folders on the Mac — the web's project subfolders
// (src/components/projects/project-folders.tsx): breadcrumbs above a folder's
// page, a Folders section with New folder, what a folder inherits from the
// projects above it, Move to…, and a Delete that asks where the subfolders go.
//
// Plain controls throughout: text buttons, the SF Symbol folder glyph, a
// grouped Form in the sheets and a system confirmation dialog.

// MARK: - Breadcrumbs

/// "Atlas launch / Research / Notes": each ancestor opens its page, the
/// current project is plain text. Drawn only for a project inside another.
struct DesktopProjectBreadcrumbs: View {
    let crumbs: [NativeProjectCrumb]
    let current: String

    @Environment(\.desktopPush) private var push

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            ForEach(crumbs) { crumb in
                Button(crumb.name) { push(.project(crumb.id)) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                    .help("Open \(crumb.name)")
                Text("/")
                    .foregroundStyle(Color.junoTertiaryInk)
                    .accessibilityHidden(true)
            }
            Text(current)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
        }
        .junoType(.ui)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Folder path")
    }
}

// MARK: - Folders section

/// The folders directly inside a project, each opening its own page, and New
/// folder. Empty, it says what a folder is for, as the web's FoldersEmpty does.
struct DesktopProjectFoldersSection: View {
    let projectID: String
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @State private var creating = false

    private var project: NativeProject? { model.projects.first { $0.id == projectID } }
    private var folders: [NativeProject] { model.children(of: projectID) }
    private var refusal: NativeProjectMoveRefusal? { model.newFolderRefusal(in: projectID) }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                Text("Folders")
                    .junoType(.ui)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if refusal == nil {
                    Button {
                        creating = true
                    } label: {
                        Label("New folder", image: JunoIcon.folderPlus.assetName)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                    .disabled(project?.isPending ?? true)
                }
            }
            .frame(minHeight: 28)

            if folders.isEmpty {
                Text(refusal.map(\.message)
                    ?? "A folder keeps one part of \(project?.name ?? "this project") together. Its chats follow this project’s instructions and read its files.")
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 0) {
                    ForEach(folders) { folder in
                        row(folder)
                        if folder.id != folders.last?.id { Divider() }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $creating) {
            DesktopNewFolderSheet(parentName: project?.name ?? "this project") { name in
                guard let id = await model.createFolder(name: name, in: projectID) else {
                    return model.lastErrorDescription ?? "Alevr couldn’t create this folder."
                }
                toast(.success("Folder created."))
                push(.project(id))
                return nil
            }
        }
    }

    private func row(_ folder: NativeProject) -> some View {
        Button {
            push(.project(folder.id))
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Image(JunoIcon.projects.assetName)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(folder.name)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Text(DesktopProjectFolderLine.summary(folder, model: model))
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.tight)
                Image(JunoIcon.chevronRight.assetName)
                    .foregroundStyle(Color.junoTertiaryInk)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, JunoSpace.tight)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(folder.name)
        .accessibilityHint(DesktopProjectFolderLine.summary(folder, model: model))
    }
}

/// "3 chats · 2 files · 1 folder", in plain text.
@MainActor
enum DesktopProjectFolderLine {
    static func summary(_ project: NativeProject, model: NativeProjectModel<SQLiteAccountRepository>) -> String {
        let chats = model.conversationsByProject[project.id]?.count ?? 0
        let files = (model.filesByProject[project.id] ?? [])
            .filter { $0.fileName != DesktopProjectSummary.coverFileName }.count
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

/// What a folder's chats also receive from the projects above it, read-only:
/// "From Atlas launch", its instructions, and how many of its files are read.
struct DesktopProjectInheritedSection: View {
    let inherited: [NativeProjectInheritance]

    @Environment(\.desktopPush) private var push

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Inherited")
                .junoType(.ui)
                .fontWeight(.semibold)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
                .frame(minHeight: 28)
            ForEach(inherited) { source in
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Button("From \(source.name)") { push(.project(source.id)) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .junoType(.caption)
                        .contentShape(.rect)
                        .help("Open \(source.name)")
                    let instructions = source.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !instructions.isEmpty {
                        Text(instructions)
                            .junoType(.body)
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(6)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if source.fileCount > 0 {
                        Text("Reads \(DesktopProjectFolderLine.plural(source.fileCount, "file")) from \(source.name)")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - New folder

struct DesktopNewFolderSheet: View {
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
        Form {
            Section {
                TextField("Folder name", text: $name, prompt: Text("Research, Drafts, Q4…"))
                    .focused($focused)
                    .onSubmit(submit)
            } header: {
                Text("Inside \(parentName)")
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(Color.junoDestructiveInk)
                } else {
                    Text("A project inside this one. Its chats follow \(parentName)’s instructions and read its files, then the folder’s own.")
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("New folder")
        .frame(width: 420)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create folder", action: submit)
                    .disabled(trimmed.isEmpty || creating)
            }
        }
        .onAppear { focused = true }
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

/// Every place a project can go: the top level, then each project in tree
/// order, indented by depth. A destination the tree refuses says why and
/// cannot be chosen.
struct DesktopMoveProjectSheet: View {
    let projectID: String
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>

    @Environment(\.dismiss) private var dismiss
    @Environment(\.junoToast) private var toast
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
        Form {
            Section {
                ForEach(destinations) { destination in
                    row(destination)
                }
            } header: {
                Text("Move “\(project?.name ?? "project")” to")
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(Color.junoDestructiveInk)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 440, height: 460)
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

    private func row(_ destination: NativeProjectMoveDestination) -> some View {
        Button {
            choice = .some(destination.projectID)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Image((destination.projectID == nil ? JunoIcon.box : JunoIcon.projects).assetName)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text(destination.name)
                    .foregroundStyle(destination.isAllowed ? Color.junoForeground : Color.junoSecondaryInk)
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.tight)
                if destination.isCurrent {
                    Text("Current").foregroundStyle(Color.junoSecondaryInk)
                } else if let refusal = destination.refusal {
                    Text(refusal.shortLabel).foregroundStyle(Color.junoSecondaryInk)
                } else if chosen?.id == destination.id {
                    Image(JunoIcon.check.assetName)
                        .foregroundStyle(Color.junoForeground)
                        .accessibilityLabel("Selected")
                }
            }
            .junoType(.ui)
            .padding(.leading, CGFloat(max(destination.depth - 1, 0)) * JunoSpace.regular)
            .frame(minHeight: 28)
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
                toast(.success("Moved to \(chosen.name)."))
                dismiss()
            } else {
                failure = model.lastErrorDescription ?? "Alevr couldn’t move this project."
            }
        }
    }
}

// MARK: - Delete

/// The one Delete every project surface uses. A project with no folders
/// inside is deleted as before; one that holds folders asks whether they move
/// up a level (lift) or go with it (cascade).
struct DesktopProjectDeleteDialog: ViewModifier {
    @Binding var target: NativeProject?
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    var deleted: @MainActor () -> Void = {}

    @Environment(\.junoToast) private var toast

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
                Button("Delete Project", role: .destructive) { delete(project, nil) }.contentShape(.rect)
            }
            Button("Cancel", role: .cancel) {}.contentShape(.rect)
        } message: { _ in
            if folderCount > 0 {
                Text("It holds \(DesktopProjectFolderLine.plural(folderCount, "folder")). Keep them to move them \(destination), with everything in them, or delete them too. Chats are kept, unlinked. This can’t be undone.")
            } else {
                Text("Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.")
            }
        }
    }

    private func delete(_ project: NativeProject, _ mode: NativeProjectChildrenMode?) {
        Task {
            deleted()
            if let mode {
                await model.deleteProject(id: project.id, children: mode)
            } else {
                await model.deleteProject(id: project.id)
            }
            if model.lastErrorDescription != nil {
                toast(.error("Couldn’t delete project."))
            } else {
                toast(.success("Project deleted."))
            }
        }
    }
}

extension View {
    func desktopProjectDelete(
        _ target: Binding<NativeProject?>,
        model: NativeProjectModel<SQLiteAccountRepository>,
        deleted: @escaping @MainActor () -> Void = {}
    ) -> some View {
        modifier(DesktopProjectDeleteDialog(target: target, model: model, deleted: deleted))
    }
}
