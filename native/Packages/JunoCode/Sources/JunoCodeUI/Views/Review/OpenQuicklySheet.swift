import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The file browser, on demand.
///
/// A permanent file tree is a third navigation system in a product whose whole
/// point is that the agent does the navigating, and a `DisclosureGroup` tree in a
/// 320pt inspector is the worst version of it. So the tree lives here, behind one
/// keystroke: a name search over the workspace index, falling back to the lazy
/// tree when the query is empty so browsing is still possible.
///
/// Carries an explicit frame. A self-sizing sheet re-measures the window while
/// AppKit is laying out the split view, which is the feedback loop that
/// previously crashed this product.
public struct OpenQuicklySheet: View {
    @Bindable private var controller: SessionController
    private let onOpen: (WorkspacePath) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [FileEntry] = []
    @State private var searching = false

    public init(controller: SessionController, onOpen: @escaping (WorkspacePath) -> Void) {
        self.controller = controller
        self.onOpen = onOpen
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(systemImage: "magnifyingglass")
                    .junoSecondaryInk()
                TextField("Open a file by name", text: $query)
                    .textFieldStyle(.plain)
                    .junoBody()
                    .accessibilityIdentifier("juno.code.open-quickly.field")
                if searching {
                    ProgressView().controlSize(.small)
                }
                Button("Done") { dismiss() }
                    .controlSize(.small)
                    .keyboardShortcut(.escape, modifiers: [])
            }
            .padding(JunoSpace.cozy)

            Divider().overlay(Color.junoSeparator)

            if query.isEmpty {
                List {
                    WorkspaceTreeRows(
                        controller: controller,
                        entries: controller.rootEntries,
                        openFile: open
                    )
                }
                .listStyle(.inset)
            } else if results.isEmpty, !searching {
                JunoEmptyState(
                    title: "No matching files",
                    message: "Nothing in this workspace has “\(query)” in its name.",
                    icon: .search
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(results) { entry in
                    Button {
                        open(entry)
                    } label: {
                        HStack(spacing: JunoSpace.snug) {
                            JunoIconView(systemImage: "doc")
                                .junoSecondaryInk()
                            Text(entry.path.value)
                                .junoCode()
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 0)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.inset)
            }
        }
        // A fixed size, not an ideal one. A macOS sheet that reports an *ideal*
        // size makes SwiftUI re-solve it through
        // `SheetBridge.sheetSize(presentationID:presenterSize:currentSize:)`
        // every time the parent window's frame changes — and when that frame
        // change is an `NSAnimation`, that solve trapped and took the process
        // (EXC_BREAKPOINT, seen in a real 0.2.0 crash report). Open Quickly wants
        // one size anyway; it has no content that should grow it.
        .frame(width: 640, height: 520)
        .task(id: query) {
            guard !query.isEmpty else {
                results = []
                searching = false
                return
            }
            searching = true
            // Debounced: the index walks the workspace, and a keystroke-per-walk
            // makes the field feel slower the faster you type.
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            results = await controller.findFiles(nameContains: query, limit: 100)
            searching = false
        }
    }

    private func open(_ entry: FileEntry) {
        guard !entry.isDirectory else { return }
        onOpen(entry.path)
        dismiss()
    }
}

/// The lazy workspace tree. Children are listed only when a directory is
/// expanded, so opening the browser never walks the whole repository.
struct WorkspaceTreeRows: View {
    let controller: SessionController
    let entries: [FileEntry]
    let openFile: (FileEntry) -> Void

    var body: some View {
        ForEach(entries) { entry in
            if entry.isDirectory {
                WorkspaceTreeDirectory(
                    controller: controller,
                    entry: entry,
                    openFile: openFile
                )
            } else {
                Button {
                    openFile(entry)
                } label: {
                    JunoIconLabel(verbatim: entry.path.lastComponent, icon: .file)
                        .junoRowLabel()
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct WorkspaceTreeDirectory: View {
    let controller: SessionController
    let entry: FileEntry
    let openFile: (FileEntry) -> Void
    @State private var expanded = false
    @State private var children: [FileEntry] = []

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            WorkspaceTreeRows(
                controller: controller,
                entries: children,
                openFile: openFile
            )
        } label: {
            JunoIconLabel(verbatim: entry.path.lastComponent, icon: .projects)
                .junoRowLabel()
        }
        .task(id: expanded) {
            if expanded, children.isEmpty {
                children = await controller.listDirectory(entry.path)
            }
        }
    }
}
