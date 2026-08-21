import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

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
/// **The second half of this screen is local.** Everything above describes files
/// the *account* holds. `Add Document…` is the other direction: a file on this
/// phone — or in iCloud Drive, or in any Files provider — read through
/// ``DocumentIngestionPipeline`` into chunks and put in the account's retrieval
/// index, so the search field at the bottom of this screen finds passages
/// *inside* a PDF and not only file names.
struct JunoMobileLibraryView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    /// This phone's local document index. See
    /// ``JunoMobileRootView``, which owns it so it survives leaving this tab.
    var documentIndex: NativeDocumentIndexModel?
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
    /// Whether the Files picker for `Add Document…` is up.
    @State private var choosingDocument = false
    /// A failure of the *picker*, not of the pipeline. Kept apart from
    /// `documentIndex.lastErrorDescription`: "the picker errored" and "this PDF
    /// has no text in it" want different sentences.
    @State private var documentPickerFailure: String?
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [
        GridItem(.flexible(), spacing: JunoSpace.regular),
        GridItem(.flexible(), spacing: JunoSpace.regular),
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
            .contentShape(.rect)
            Button("Save") {
                guard let id = renameFileID else { return }
                renameFileID = nil
                Task { await model.renameFile(id: id, fileName: renameValue) }
            }
            .contentShape(.rect)
        }
        .alert("File unavailable", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
            .contentShape(.rect)
        } message: {
            Text(localError ?? "Try again.")
        }
        .quickLookPreview($previewURL)
        .fileImporter(
            isPresented: $choosingDocument,
            allowedContentTypes: NativeDocumentIndexModel.readableContentTypes,
            // Several at once, read one after another below: the pipeline reports
            // one file at a time, and a parallel import would make the progress
            // line name whichever happened to finish last.
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                documentPickerFailure = nil
                Task { await ingest(urls) }
            case let .failure(error):
                documentPickerFailure = error.localizedDescription
            }
        }
        // One search field, two corpora. It already narrowed the account's files
        // by name; this is what makes the same keystrokes look *inside* the
        // documents indexed on this phone.
        .onChange(of: searchText) { _, value in documentIndex?.setQuery(value) }
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
                // Absent, not disabled, when there is no index to put a document
                // in — the rule the Edit Image action above follows for the same
                // reason. Absent while a read is in flight too: two imports
                // racing would make the progress line describe neither.
                if let documentIndex, documentIndex.isReady, !documentIndex.isIngesting {
                    Button {
                        documentPickerFailure = nil
                        choosingDocument = true
                    } label: {
                        Label("Add Document…", systemImage: "doc.badge.plus")
                    }
                    .accessibilityIdentifier("juno.mobile.library-add-document")
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

            documentIndexPanel

            LazyVGrid(columns: columns, spacing: JunoSpace.regular) {
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
            .padding(.horizontal, JunoSpace.regular)
            // Clears the floating search field, so the last row is never
            // trapped underneath it.
            .padding(.bottom, JunoSpace.region * 3)
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
            .padding(.horizontal, JunoSpace.regular)

            // The container stays: the selected chip is a glass element, and glass
            // laid down outside one samples independently instead of blending
            // with its neighbours. It is the `.bar` slab behind the row that is
            // gone, not the chips' own material.
            JunoGlass(spacing: JunoSpace.cozy) {
                HStack(spacing: JunoSpace.snug) {
                    ForEach(JunoLibraryFilter.allCases) { option in
                        chip(option)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, JunoSpace.cozy)
        }
    }

    // MARK: - Local document index

    /// What the on-device index has to say, or nothing at all.
    ///
    /// Above the grid rather than below it, because while a search is running
    /// these passages are the *answer* and the thumbnails are context. It
    /// collapses entirely when the index is empty and idle, so a reader who never
    /// indexes a document never sees a strip of chrome for a feature they are not
    /// using.
    @ViewBuilder
    private var documentIndexPanel: some View {
        if let index = documentIndex, index.isReady, indexPanelHasContent(index) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                indexSummary(index)
                if let failure = documentPickerFailure ?? index.lastErrorDescription {
                    indexFailure(failure, index: index)
                }
                indexResults(index)
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Documents indexed on this phone")
            .accessibilityIdentifier("juno.mobile.library-document-index")
        }
    }

    private func indexPanelHasContent(_ index: NativeDocumentIndexModel) -> Bool {
        !index.documents.isEmpty
            || index.isIngesting
            || index.lastErrorDescription != nil
            || documentPickerFailure != nil
    }

    private func indexSummary(_ index: NativeDocumentIndexModel) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: "text.magnifyingglass")
                .junoSecondaryInk()
                .accessibilityHidden(true)
            Text(indexSummaryLine(index))
                .junoFont(size: 15, relativeTo: .subheadline)
                .lineLimit(2)
            Spacer(minLength: 0)
            if index.isIngesting {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityHidden(true)
            } else if !index.documents.isEmpty {
                Menu {
                    ForEach(index.documents) { document in
                        Button("Remove \(document.sourceName)", role: .destructive) {
                            Task { await index.remove(document) }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .junoFont(size: 17, relativeTo: .body)
                        .junoSecondaryInk()
                }
                .accessibilityLabel("Manage indexed documents")
                .accessibilityIdentifier("juno.mobile.library-document-index-manage")
                .contentShape(.rect)
            }
        }
    }

    /// The counts come from the index, and the OCR clause appears only when some
    /// document really was transcribed — a blanket "may contain OCR errors" over
    /// documents that carried embedded text would warn about something that did
    /// not happen. The memory-only note is stated rather than assumed: nothing
    /// here writes document text to disk, so quitting does empty the index, and a
    /// reader who expected otherwise would call the feature broken.
    private func indexSummaryLine(_ index: NativeDocumentIndexModel) -> String {
        if let name = index.ingestingFileName { return "Reading \(name)…" }
        guard !index.documents.isEmpty else {
            return "No documents indexed on this phone."
        }
        let documents = index.documents.count
        var line = "\(documents) \(documents == 1 ? "document" : "documents")"
        line += " · \(index.chunkCount) searchable \(index.chunkCount == 1 ? "passage" : "passages")"
        line += ", kept on this phone until you quit"
        if index.documents.contains(where: \.usedOpticalCharacterRecognition) {
            line += " · some text was read by OCR"
        }
        return line
    }

    private func indexFailure(_ message: String, index: NativeDocumentIndexModel) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Dismiss") {
                documentPickerFailure = nil
                index.clearError()
            }
            .buttonStyle(.plain)
            .junoCaption()
            .contentShape(.rect)
        }
        .accessibilityIdentifier("juno.mobile.library-document-index-error")
    }

    /// Three states, kept apart because collapsing any two says something untrue:
    /// nothing when no question was asked, "searching" while the ranker runs, and
    /// "nothing mentions …" only once a search has actually come back empty.
    @ViewBuilder
    private func indexResults(_ index: NativeDocumentIndexModel) -> some View {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty, !index.documents.isEmpty {
            Divider()
            if index.isSearching, index.passages.isEmpty {
                Text("Searching your documents…")
                    .junoCaption()
                    .junoSecondaryInk()
            } else if index.passages.isEmpty {
                Text("No indexed document mentions “\(query)”.")
                    .junoCaption()
                    .junoSecondaryInk()
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(index.passages) { passage in
                        passageRow(passage)
                    }
                }
                .accessibilityIdentifier("juno.mobile.library-document-passages")
            }
        }
    }

    /// One hit: where it came from, then what it says. The locator leads because
    /// it is what a reader checks before trusting the quote, and it names only the
    /// positional facts the extractor actually observed.
    private func passageRow(_ passage: NativeDocumentPassage) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(passage.locator)
                .junoCaption()
                .junoSecondaryInk()
                .lineLimit(1)
                .truncationMode(.middle)
            Text(passage.text)
                .junoFont(size: 15, relativeTo: .subheadline)
                .lineLimit(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(passage.locator). \(passage.text)")
    }

    /// Reads the chosen files one after another, so the progress line always
    /// names the file actually being read. The model re-ranks the query it is
    /// holding as part of storing each document, so a file indexed while a search
    /// was already typed answers that search immediately.
    private func ingest(_ urls: [URL]) async {
        guard let documentIndex else { return }
        for url in urls {
            await documentIndex.ingest(contentsOf: url)
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
                .junoFont(size: 17, relativeTo: .body, weight: selected ? .semibold : .regular)
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .padding(.horizontal, JunoSpace.regular)
                .frame(height: 40)
                .modifier(JunoLibraryChipBackground(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("juno.mobile.library-filter.\(option.rawValue)")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
    }

    /// The search field floats over the grid rather than sitting in the
    /// navigation bar. On a screen whose whole content is a grid, a search field
    /// pinned to the top costs a row of previews on every scroll; down here it
    /// costs nothing and is where the thumb already is.
    private var searchField: some View {
        JunoGlass(spacing: JunoSpace.regular) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: "magnifyingglass")
                    .junoFont(size: 17, relativeTo: .body, weight: .medium)
                    .junoSecondaryInk()
                TextField("library.search", text: $searchText)
                    .textFieldStyle(.plain)
                    .junoFont(size: 17, relativeTo: .body)
                    .focused($searchFocused)
                    .submitLabel(.search)
                    .accessibilityIdentifier("juno.mobile.library-search")
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .junoFont(size: 17, relativeTo: .body)
                            .junoMetaInk()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("library.search.clear")
                    .contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: 52)
            .junoGlass(in: Capsule(), interactive: true)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.bottom, JunoSpace.cozy)
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
        VStack(spacing: JunoSpace.cozy) {
            Image(systemName: symbol)
                .junoFont(size: 28, relativeTo: .title)
                .junoMetaInk()
            Text(title)
                .junoFont(size: 17, relativeTo: .headline, weight: .semibold)
            Text(detail)
                .font(.callout)
                .junoSecondaryInk()
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.top, JunoSpace.region)
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
        .contentShape(.rect)
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
