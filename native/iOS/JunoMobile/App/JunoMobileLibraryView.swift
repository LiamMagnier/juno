import JunoChatKit
import JunoDesignSystem
import JunoStorage
import QuickLookThumbnailing
import SwiftUI
import UIKit

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

    @State private var filter: JunoLibraryFilter = .all
    @State private var sort: JunoLibrarySort = .newest
    @State private var searchText = ""
    @State private var previews = JunoLibraryPreviewLoader()
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
    let previews: JunoLibraryPreviewLoader
    let open: () -> Void
    let rename: () -> Void
    let delete: () -> Void
    /// Fetches the bytes. Passed as a closure so the card never holds the model.
    let load: () async -> NativeProjectFileAccess?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var state: JunoLibraryPreviewLoader.State { previews.state(for: file.id) }

    var body: some View {
        Button(action: open) {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay { surface }
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .strokeBorder(Color.junoHairline, lineWidth: 1)
                }
                .contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .buttonStyle(JunoLibraryCardPressStyle())
        .contextMenu {
            Button("Open", action: open)
            Button("Rename", action: rename)
            Divider()
            Button("Delete", role: .destructive, action: delete)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .task(id: file.id) { await previews.load(file, using: load) }
    }

    @ViewBuilder
    private var surface: some View {
        switch state {
        case .ready(let image):
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                // A photo is recognised by its middle; a document is recognised
                // by its first lines. Cropping a page to its centre shows a
                // paragraph from nowhere.
                .frame(
                    maxWidth: .infinity,
                    maxHeight: .infinity,
                    alignment: file.kind == "IMAGE" ? .center : .top
                )
                .transition(.opacity)
        case .loading:
            // No spinner: most previews land in a few hundred milliseconds and
            // a grid of spinners reads as the screen being broken.
            Color.junoSurface
        case .unavailable:
            fallback
        }
    }

    /// What a file with no renderable preview looks like: still a card, not a
    /// blank tile — its type, its name and its size.
    private var fallback: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: file.kind == "IMAGE" ? "photo" : "doc.text")
                .font(.system(size: 26))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(file.fileName)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.middle)
            Text(sizeLabel)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.junoSurface)
    }

    private var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
    }

    private var accessibilityLabel: String {
        "\(file.fileName), \(sizeLabel)"
    }
}

/// A card presses in slightly, as a photo in a grid should. No wash: a tint over
/// a picture changes the picture.
private struct JunoLibraryCardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

// MARK: - Previews

/// Turns a stored file into a thumbnail, once.
///
/// Two rules: nothing is fetched until its card is on screen, and nothing is
/// fetched twice — a grid that re-downloaded on every scroll would cost real
/// money on a metered connection. Failures are remembered too, so a file the
/// server cannot serve is attempted once rather than on every appearance.
@MainActor
@Observable
final class JunoLibraryPreviewLoader {
    enum State: Equatable {
        case loading
        case ready(UIImage)
        case unavailable
    }

    /// Documents are rendered by QuickLook, which needs the whole file on disk.
    /// Above this the card falls back to its name and type rather than pulling
    /// tens of megabytes to draw a 300pt square.
    static let documentPreviewByteLimit = 25 * 1024 * 1024

    private var cache: [String: State] = [:]

    func state(for id: String) -> State { cache[id] ?? .loading }

    func load(_ file: NativeProjectFile, using access: () async -> NativeProjectFileAccess?) async {
        guard cache[file.id] == nil else { return }
        cache[file.id] = .loading

        guard file.kind == "IMAGE" || file.size <= Self.documentPreviewByteLimit else {
            cache[file.id] = .unavailable
            return
        }
        guard let access = await access() else {
            cache[file.id] = .unavailable
            return
        }
        guard let data = await Self.bytes(of: access) else {
            cache[file.id] = .unavailable
            return
        }

        let image: UIImage? = file.kind == "IMAGE"
            ? await JunoImageDownsampler.thumbnail(from: data, maxPixelSize: 700)
            : await JunoDocumentThumbnail.render(data, fileName: file.fileName)
        cache[file.id] = image.map(State.ready) ?? .unavailable
    }

    private static func bytes(of access: NativeProjectFileAccess) async -> Data? {
        switch access {
        case .downloaded(let data):
            return data
        case .remote(let url):
            // A signed storage URL: no bearer token, and no reason to route it
            // through the app's authenticated sender.
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode ?? 200 < 400
            else { return nil }
            return data
        }
    }
}

/// Renders a document's first page with QuickLook — the same thumbnail the
/// Files app draws, so a PDF looks like that PDF rather than like a PDF.
enum JunoDocumentThumbnail {
    static func render(_ data: Data, fileName: String) async -> UIImage? {
        let ext = URL(fileURLWithPath: fileName).pathExtension
            .filter { $0.isLetter || $0.isNumber }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "juno-thumb-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
            )
        guard (try? data.write(to: url, options: [.atomic])) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }

        let request = QLThumbnailGenerator.Request(
            fileAt: url,
            size: CGSize(width: 600, height: 600),
            scale: 1,
            representationTypes: .thumbnail
        )
        let representation = try? await QLThumbnailGenerator.shared
            .generateBestRepresentation(for: request)
        return representation?.uiImage
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
