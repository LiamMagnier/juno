import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// The Library: everything you have ever attached to a chat or a project, shown
/// as what it actually is.
///
/// **Why a grid of previews rather than a list of rows.** The old screen was a
/// stack of named rows with a `photo` or `doc.text` glyph, which is a filing
/// cabinet: to find the screenshot you sent last week you had to remember what
/// the phone called it. Nobody remembers `IMG_4821.HEIC`. A library of things
/// you *sent* is recognised by sight, so the cell is the file — a real
/// thumbnail for a picture, a real rendered first page for a document — and the
/// name moves to where names are actually useful: search, the context menu and
/// VoiceOver.
struct JunoMobileLibraryView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    /// Everything the image editor needs. All optional, and the Edit action is
    /// absent rather than disabled when any of it is missing — a menu item that
    /// cannot work is worse than one that is not there.
    var accountID: AccountID?
    var attachmentClient: NativeAttachmentAPIClient?
    var generateClient: NativeChatAPIClient?
    var modelCatalog: [NativeChatModelOption] = []
    var openConversation: ((String) -> Void)?

    @State private var editing: NativeProjectFile?

    @State private var filter: JunoLibraryFilter = .all
    @State private var sort: JunoLibrarySort = .newest
    @State private var searchText = ""
    @State private var previews = NativeFilePreviewLoader()
    @State private var previewURL: URL?
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var localError: String?
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
    ]

    private var files: [NativeProjectFile] {
        JunoLibraryFilter.apply(
            model.files, filter: filter, search: searchText, sort: sort
        )
    }

    var body: some View {
        Group {
            if model.phase == .loading || model.phase == .idle {
                JunoMobileQuietLoading()
            } else {
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("navigation.library")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { libraryToolbar }
        .alert("Rename file", isPresented: Binding(
            get: { renameFileID != nil },
            set: { if !$0 { renameFileID = nil } }
        )) {
            TextField("File name", text: $renameValue)
            Button("Cancel", role: .cancel) { renameFileID = nil }
            Button("Save") {
                guard let id = renameFileID else { return }
                renameFileID = nil
                Task { await model.renameFile(id: id, fileName: renameValue) }
            }
        }
        .alert("File unavailable", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "Try again.")
        }
        .quickLookPreview($previewURL)
        .sheet(item: $editing) { file in
            if let accountID, let attachmentClient, let generateClient {
                NativeImageEditSheet(
                    attachmentID: file.id,
                    fileName: file.fileName,
                    accountID: accountID,
                    attachments: attachmentClient,
                    client: generateClient,
                    models: modelCatalog,
                    openConversation: openConversation,
                    close: { editing = nil }
                )
            }
        }
    }

    /// Only an image, and only when the manifest says some available model can
    /// edit one. Offering the action otherwise would open an editor whose
    /// Generate button could never be pressed.
    private func canEdit(_ file: NativeProjectFile) -> Bool {
        file.kind.uppercased() == "IMAGE"
            && accountID != nil && attachmentClient != nil && generateClient != nil
            && modelCatalog.contains { $0.modality == "image" && $0.imageEditSupport != .none }
    }

    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("library.sort", selection: $sort) {
                    ForEach(JunoLibrarySort.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                Button {
                    Task { await model.reload() }
                } label: {
                    Label("library.refresh", systemImage: "arrow.clockwise")
                }
            } label: {
                Label("library.options", systemImage: "ellipsis")
            }
            .accessibilityIdentifier("juno.mobile.library-options")
        }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            filterBar

            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(files) { file in
                    JunoLibraryCard(
                        file: file,
                        previews: previews,
                        open: { open(file) },
                        rename: {
                            renameValue = file.fileName
                            renameFileID = file.id
                        },
                        delete: { Task { await model.deleteFile(id: file.id) } },
                        edit: canEdit(file) ? { editing = file } : nil,
                        load: { await model.accessFile(id: file.id) }
                    )
                }
            }
            .padding(.horizontal, 16)
            // Clears the floating search field, so the last row is never
            // trapped underneath it.
            .padding(.bottom, 96)
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: files.count
            )

            if files.isEmpty { empty }
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("juno.mobile.file-list")
        .safeAreaInset(edge: .bottom) { searchField }
    }

    /// All · Images · Documents. A filter, not navigation — the reader is
    /// narrowing one collection, not moving between three.
    ///
    /// **In the scroll, not pinned above it.** It used to be a
    /// `safeAreaInset(edge: .top)` painted with `.bar`, which put an opaque
    /// full-width strip directly under the navigation bar — two stacked bars in
    /// the same material, a hard horizontal seam across the top of the screen,
    /// and a permanent slab of chrome for three words the reader touches once.
    /// Nothing else in this app pins content-level controls: the project screen,
    /// Memory and Settings all scroll their sections, and the status strip in
    /// particular is documented as belonging *in* the content. It scrolls now,
    /// and the only floating surface left on the screen is the search field,
    /// which is glass on purpose because it is always reachable.
    private var filterBar: some View {
        VStack(spacing: 0) {
            JunoMobileWorkspaceStatus(
                conflicted: false,
                offline: model.phase == .offline,
                message: model.lastErrorDescription,
                conflictMessage: "",
                offlineMessage: "Offline — showing saved files.",
                retry: { Task { await model.reload() } },
                keepMine: {},
                useServer: {}
            )
            .padding(.horizontal, 16)

            // The container stays: the selected chip is a glass element, and glass
            // laid down outside one samples independently instead of blending
            // with its neighbours. It is the `.bar` slab behind the row that is
            // gone, not the chips' own material.
            JunoGlass(spacing: 10) {
                HStack(spacing: 8) {
                    ForEach(JunoLibraryFilter.allCases) { option in
                        chip(option)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 12)
        }
    }

    private func chip(_ option: JunoLibraryFilter) -> some View {
        let selected = filter == option
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                filter = option
            }
        } label: {
            Text(option.title)
                .font(.system(size: 17, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .padding(.horizontal, 18)
                .frame(height: 40)
                .modifier(JunoLibraryChipBackground(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("juno.mobile.library-filter.\(option.rawValue)")
    }

    /// The search field floats over the grid rather than sitting in the
    /// navigation bar. On a screen whose whole content is a grid, a search field
    /// pinned to the top costs a row of previews on every scroll; down here it
    /// costs nothing and is where the thumb already is.
    private var searchField: some View {
        JunoGlass(spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField("library.search", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .focused($searchFocused)
                    .submitLabel(.search)
                    .accessibilityIdentifier("juno.mobile.library-search")
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("library.search.clear")
                }
            }
            .padding(.horizontal, 18)
            .frame(height: 52)
            .junoGlass(in: Capsule(), interactive: true)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private var empty: some View {
        if model.files.isEmpty {
            JunoLibraryMessage(
                symbol: "tray",
                title: "library.empty.title",
                detail: "library.empty.detail"
            )
        } else {
            JunoLibraryMessage(
                symbol: "magnifyingglass",
                title: "library.no-matches.title",
                detail: "library.no-matches.detail"
            )
        }
    }

    private func open(_ file: NativeProjectFile) {
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

private struct JunoLibraryMessage: View {
    let symbol: String
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.system(size: 17, weight: .semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 40)
        .padding(.top, 60)
        .frame(maxWidth: .infinity)
    }
}

/// The selected filter chip's background. Glass when selected, nothing when not
/// — a run of four glass capsules would read as four equally-active controls.
private struct JunoLibraryChipBackground: ViewModifier {
    let selected: Bool

    func body(content: Content) -> some View {
        if selected {
            content.junoGlass(in: Capsule(), interactive: true)
        } else {
            content.contentShape(Capsule())
        }
    }
}

// MARK: - Card

/// One file, shown as itself.
private struct JunoLibraryCard: View {
    let file: NativeProjectFile
    let previews: NativeFilePreviewLoader
    let open: () -> Void
    let rename: () -> Void
    let delete: () -> Void
    /// Present only for an image, and only when a model on this account can edit
    /// one. Absent rather than disabled — see `JunoMobileLibraryView`.
    let edit: (() -> Void)?
    /// Fetches the bytes. Passed as a closure so the card never holds the model.
    let load: () async -> NativeProjectFileAccess?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var request: NativeFilePreviewRequest { NativeFilePreviewRequest(file) }

    var body: some View {
        Button(action: open) {
            // The card, its fallback and its press behaviour are the shared ones
            // — the attach-from-Library picker draws exactly this, and the two
            // had already drifted into two designs once.
            NativeFilePreviewTile(
                file: request,
                state: previews.state(for: file.id),
                cornerRadius: 26
            )
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .contextMenu {
            Button("Open", action: open)
            if let edit { Button("Edit Image…", action: edit) }
            Button("Rename", action: rename)
            Divider()
            Button("Delete", role: .destructive, action: delete)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .task(id: file.id) { await previews.load(request, using: load) }
    }

    private var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
    }

    private var accessibilityLabel: String {
        "\(file.fileName), \(sizeLabel)"
    }
}

// MARK: - Filtering

/// What the library is showing.
enum JunoLibraryFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case images
    case documents

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .all: "library.filter.all"
        case .images: "library.filter.images"
        case .documents: "library.filter.documents"
        }
    }

    func matches(_ file: NativeProjectFile) -> Bool {
        switch self {
        case .all: true
        case .images: file.kind == "IMAGE"
        case .documents: file.kind != "IMAGE"
        }
    }

    /// The screen's whole selection rule, as one pure function so the filter,
    /// the search and the ordering can be tested without a screen.
    static func apply(
        _ files: [NativeProjectFile],
        filter: JunoLibraryFilter,
        search: String,
        sort: JunoLibrarySort
    ) -> [NativeProjectFile] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return files
            .filter { filter.matches($0) }
            .filter { query.isEmpty || $0.fileName.localizedCaseInsensitiveContains(query) }
            .sorted(by: sort.areInOrder)
    }
}

enum JunoLibrarySort: String, CaseIterable, Identifiable, Sendable {
    case newest
    case name

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .newest: "library.sort.newest"
        case .name: "library.sort.name"
        }
    }

    func areInOrder(_ lhs: NativeProjectFile, _ rhs: NativeProjectFile) -> Bool {
        switch self {
        case .newest:
            // Ties broken by name so the order is stable across reloads rather
            // than reshuffling files uploaded in the same second.
            lhs.createdAt == rhs.createdAt
                ? lhs.fileName.localizedCompare(rhs.fileName) == .orderedAscending
                : lhs.createdAt > rhs.createdAt
        case .name:
            lhs.fileName.localizedCompare(rhs.fileName) == .orderedAscending
        }
    }
}
