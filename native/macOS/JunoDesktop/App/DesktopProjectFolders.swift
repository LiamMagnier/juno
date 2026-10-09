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
// Round 3: a folder is drawn as the web draws it — a compact project tile
// with its cover (the project's picture, or its dot-matrix orbit drawing) —
// and every way into a folder is a `NavigationLink(value:)` on the Projects
// stack, so opening one never depends on an environment action reaching a
// pushed page.

// MARK: - Breadcrumbs

/// "Projects › Atlas launch › Research › Notes": each ancestor opens its
/// page, the current project is plain text. Drawn only for a project inside
/// another.
struct DesktopProjectBreadcrumbs: View {
    let crumbs: [NativeProjectCrumb]
    let current: String

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            ForEach(crumbs) { crumb in
                NavigationLink(value: DesktopPageRoute.project(crumb.id)) {
                    Text(crumb.name)
                        .lineLimit(1)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(minHeight: 24)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Open \(crumb.name)")
                JunoIconView(.chevronRight, size: 11)
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

/// The folders directly inside a project as a grid of compact tiles (the
/// web's `ProjectTile compact`), each opening its own page, and New folder.
/// Empty, it says what a folder is for, as the web's FoldersEmpty does.
struct DesktopProjectFoldersSection: View {
    let projectID: String
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    var fileAccess: ((String) async -> NativeProjectFileAccess?)?

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @State private var creating = false
    @State private var moving: NativeProject?
    @State private var deleting: NativeProject?
    @State private var renaming: JunoRenameRequest?

    private var project: NativeProject? { model.projects.first { $0.id == projectID } }
    private var folders: [NativeProject] { model.children(of: projectID) }
    private var refusal: NativeProjectMoveRefusal? { model.newFolderRefusal(in: projectID) }

    /// One column under 480pt, two to 1280, three beyond: the web's
    /// `@[30rem]` and `@[80rem]` steps.
    private func columns(_ width: CGFloat) -> [GridItem] {
        let count = width >= 1_280 ? 3 : (width >= 480 ? 2 : 1)
        return Array(repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top), count: count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            header
            if folders.isEmpty {
                empty
            } else {
                DesktopPageLayoutReader { layout in
                    LazyVGrid(columns: columns(layout.pageWidth), alignment: .leading, spacing: JunoSpace.cozy) {
                        ForEach(folders) { folder in
                            NavigationLink(value: DesktopPageRoute.project(folder.id)) {
                                DesktopProjectFolderTile(
                                    folder: folder,
                                    model: model,
                                    fileAccess: fileAccess
                                )
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Open") { push(.project(folder.id)) }
                                Button(folder.starred ? "Unpin" : "Pin") {
                                    Task { await model.updateProject(id: folder.id, starred: !folder.starred) }
                                }
                                Button("Rename…") {
                                    renaming = DesktopProjectActions.rename(folder, model: model, toast: toast)
                                }
                                Button("Move To…") { moving = folder }
                                Divider()
                                Button("Delete Folder…", role: .destructive) { deleting = folder }
                            }
                            .accessibilityLabel(folder.name)
                            .accessibilityHint(DesktopProjectFolderLine.summary(folder, model: model))
                        }
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
        .sheet(item: $moving) { folder in
            DesktopMoveProjectSheet(projectID: folder.id, model: model)
        }
        .junoRenameSheet($renaming)
        .desktopProjectDelete($deleting, model: model)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text("Folders")
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if !folders.isEmpty {
                Text(folders.count, format: .number)
                    .junoType(.micro)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
            if !folders.isEmpty {
                if let refusal {
                    Text(refusal.message)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .multilineTextAlignment(.trailing)
                } else {
                    newFolderButton
                }
            }
        }
        .frame(minHeight: 30)
    }

    private var newFolderButton: some View {
        Button {
            creating = true
        } label: {
            Label("New folder", icon: .folderPlus)
        }
        .buttonStyle(.junoGlass)
        .controlSize(.small)
        .contentShape(Capsule())
        .disabled(project?.isPending ?? true)
    }

    /// No folders yet: an invitation in the section's own voice, with the
    /// verb beside it — not a dashed placeholder tile.
    private var empty: some View {
        HStack(alignment: .center, spacing: JunoSpace.regular) {
            JunoIconView(.folderOpen, size: 18)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color.junoSecondary))
                .accessibilityHidden(true)
            Text(refusal.map(\.message)
                ?? "A folder keeps one part of \(project?.name ?? "this project") together. Its chats follow this project’s instructions and read its files.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if refusal == nil {
                newFolderButton
            }
        }
        .padding(JunoSpace.regular)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
    }
}

/// A folder as a compact project tile: its cover — the picture, or the
/// project's own orbit drawing — over the serif name and one line of counts.
/// The whole tile is the link; it lifts its hairline and wash under the
/// pointer.
struct DesktopProjectFolderTile: View {
    let folder: NativeProject
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    var fileAccess: ((String) async -> NativeProjectFileAccess?)?

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let coverHeight: CGFloat = 84

    private var summary: DesktopProjectSummary { DesktopProjectSummary(project: folder, model: model) }
    private var folderCount: Int { model.children(of: folder.id).count }

    /// The web's compact meta: chats, its own folders, the age.
    private var meta: String {
        var parts = [DesktopProjectFolderLine.plural(summary.chatCount, "chat")]
        if folderCount > 0 { parts.append(DesktopProjectFolderLine.plural(folderCount, "folder")) }
        parts.append(DesktopRelativeTime.short(folder.updatedAt))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        let inner = RoundedRectangle(cornerRadius: JunoRadius.card - 4, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                cover
                    .frame(maxWidth: .infinity)
                    .frame(height: Self.coverHeight)
                    .clipShape(inner)
                if folder.starred {
                    JunoIconView(.pin, size: 13, isOn: true)
                        .foregroundStyle(Color.junoForeground.opacity(0.75))
                        .padding(JunoSpace.snug)
                        .accessibilityHidden(true)
                }
            }
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(folder.name)
                    .font(JunoSerif.font(size: 17, relativeTo: .headline))
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(meta)
                    .junoType(.micro)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.tight)
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(hovering ? Color.junoHover : Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(hovering ? 1 : 0.8), lineWidth: 1)
        )
        .junoRaisedShadow(hovering)
        .contentShape(.rect(cornerRadius: JunoRadius.card))
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovering)
        .onHover { hovering = $0 }
    }

    @ViewBuilder
    private var cover: some View {
        if let coverFile = summary.cover, fileAccess != nil {
            DesktopProjectCoverImage(fileID: coverFile.id, fileAccess: fileAccess) {
                DesktopProjectCoverArt(seed: folder.id, folders: folderCount, drifting: hovering)
            }
        } else {
            DesktopProjectCoverArt(seed: folder.id, folders: folderCount, drifting: hovering)
        }
    }
}

/// A project's picture, with the drawing under it until (unless) it loads.
struct DesktopProjectCoverImage<Placeholder: View>: View {
    let fileID: String
    let fileAccess: ((String) async -> NativeProjectFileAccess?)?
    @ViewBuilder let placeholder: () -> Placeholder

    @State private var image: NSImage?

    var body: some View {
        ZStack {
            placeholder()
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .task(id: fileID) {
            guard let fileAccess else { return }
            let data = await DesktopLibraryUploads.bytes(await fileAccess(fileID))
            let picture = data.flatMap(NSImage.init(data:))
            withAnimation(JunoMotion.fast) { image = picture }
        }
    }
}

/// A project's cover drawing, after the web's `ProjectCover`: nested orbits
/// at the 1.5 ratio laid on the dot matrix, in one of three arrangements
/// (concentric, tangent like a shell, or drawn from a corner and cropped),
/// with one spoke per folder — a pure function of the project's id, so the
/// same project always wears the same drawing. Monochrome ink on the inset
/// fill; it drifts a few points under the pointer, and holds still under
/// Reduce Motion.
struct DesktopProjectCoverArt: View {
    let seed: String
    var folders: Int = 0
    var drifting = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let drawing = DesktopCoverDrawing(seed: seed, folders: folders)
        Canvas { context, size in
            drawing.draw(in: &context, size: size)
        }
        .background(Color.junoSecondary)
        .offset(x: drifting && !reduceMotion ? -3 : 0)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: drifting)
        .accessibilityHidden(true)
    }
}

/// The drawing behind ``DesktopProjectCoverArt``: seeded, so pure.
struct DesktopCoverDrawing {
    struct Ring { var cx: CGFloat; var cy: CGFloat; var r: CGFloat }

    let rings: [Ring]
    let spokes: [CGFloat]

    init(seed: String, folders: Int) {
        var generator = DesktopSeededRandom(seed: seed)
        let mode = Int(generator.next() * 3)
        let count = 3 + Int(generator.next() * 2)
        let outer: CGFloat = mode == 2 ? generator.pick(0.46, 0.56) : generator.pick(0.3, 0.36)
        let cx: CGFloat = mode == 2
            ? (generator.next() < 0.5 ? generator.pick(0.18, 0.26) : generator.pick(0.74, 0.82))
            : generator.pick(0.4, 0.6)
        let cy: CGFloat = mode == 2 ? generator.pick(0.6, 0.72) : 0.5
        var rings: [Ring] = []
        var r = outer
        for index in 0..<count {
            // Concentric shares a centre; tangent rolls each ring to touch the
            // outer one's edge, like a shell.
            let shift: CGFloat = mode == 1 ? (outer - r) : 0
            rings.append(Ring(cx: cx + shift * (index.isMultiple(of: 2) ? 1 : 0.6), cy: cy, r: r))
            r /= 1.5
        }
        self.rings = rings
        let start = generator.pick(0, .pi * 2)
        self.spokes = (0..<min(folders, 6)).map { start + CGFloat($0) * (.pi * 2 / CGFloat(max(folders, 1))) }
    }

    func draw(in context: inout GraphicsContext, size: CGSize) {
        let unit = size.height
        let pitch: CGFloat = 5
        let ink = Color.junoForeground
        // The matrix: every dot faint, the dots on an orbit firm.
        var y = pitch / 2
        while y < size.height {
            var x = pitch / 2
            while x < size.width {
                var strength: CGFloat = 0.07
                for ring in rings {
                    let dx = x - ring.cx * size.width
                    let dy = y - ring.cy * unit
                    let distance = abs((dx * dx + dy * dy).squareRoot() - ring.r * unit)
                    if distance < 1.6 { strength = max(strength, 0.55); break }
                    if distance < 3.2 { strength = max(strength, 0.22) }
                }
                let dot = CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)
                context.fill(Path(ellipseIn: dot), with: .color(ink.opacity(strength)))
                x += pitch
            }
            y += pitch
        }
        // One spoke per folder, from the inner ring out past the outer one.
        guard let outer = rings.first, let inner = rings.last else { return }
        let center = CGPoint(x: outer.cx * size.width, y: outer.cy * unit)
        for angle in spokes {
            var path = Path()
            path.move(to: CGPoint(x: center.x + cos(angle) * inner.r * unit, y: center.y + sin(angle) * inner.r * unit))
            path.addLine(to: CGPoint(x: center.x + cos(angle) * outer.r * unit * 1.15, y: center.y + sin(angle) * outer.r * unit * 1.15))
            context.stroke(path, with: .color(ink.opacity(0.35)), style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [1.5, 3]))
        }
    }
}

/// FNV-1a over the id, then mulberry32: the web's `hash` and `seeded`.
struct DesktopSeededRandom {
    private var state: UInt32

    init(seed: String) {
        var h: UInt32 = 2_166_136_261
        for unit in seed.utf16 {
            h ^= UInt32(unit)
            h = h &* 16_777_619
        }
        state = h
    }

    mutating func next() -> CGFloat {
        state = state &+ 0x6D2B_79F5
        var t = state
        t = (t ^ (t >> 15)) &* (1 | t)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return CGFloat((t ^ (t >> 14))) / 4_294_967_296
    }

    mutating func pick(_ low: CGFloat, _ high: CGFloat) -> CGFloat {
        low + (high - low) * next()
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
                    NavigationLink(value: DesktopPageRoute.project(source.id)) {
                        Text("From \(source.name)")
                            .foregroundStyle(Color.junoSecondaryInk)
                            .junoType(.caption)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
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
