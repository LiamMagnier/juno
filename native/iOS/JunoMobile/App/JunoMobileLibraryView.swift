import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoWorkKit
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
    /// What Alevr made (`/api/library/made`); nil hides the row that opens it.
    var madeModel: NativeLibraryMadeModel? = nil
    var artifactModel: NativeArtifactModel<SQLiteAccountRepository>? = nil
    var workClient: NativeWorkClient? = nil
    /// Opens Artifacts, which the phone drawer folds into Library.
    var openArtifacts: (() -> Void)? = nil

    @State private var editing: NativeProjectFile?
    /// Opens "Made by Alevr" straight away: `--juno-preview-library-made` (DEBUG).
    @State private var showingMade = false

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 4),
        count: 3
    )

    /// `libraryFiles`, not `files`: a file taken out of the Library is still
    /// synced, because the chat or project that uses it still shows it.
    private var files: [NativeProjectFile] {
        JunoLibraryFilter.apply(
            model.libraryFiles, filter: filter, search: searchText, sort: sort
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
        .navigationTitle("navigation.library")
        .navigationBarTitleDisplayMode(.large)
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
        .navigationDestination(isPresented: $showingMade) { madeDestination }
        #if DEBUG
        .task {
            if CommandLine.arguments.contains("--juno-preview-library-made"), madeModel != nil {
                try? await Task.sleep(for: .milliseconds(600))
                showingMade = true
            }
        }
        #endif
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
                        JunoIconLabel(verbatim: "Add Document…", icon: .file)
                    }
                    .accessibilityIdentifier("juno.mobile.library-add-document")
                }
                Button {
                    Task { await model.reload() }
                } label: {
                    JunoIconLabel("library.refresh", icon: .refresh)
                }
            } label: {
                JunoIconLabel("library.options", icon: .ellipsis)
            }
            .accessibilityIdentifier("juno.mobile.library-options")
        }
    }

    // MARK: - Content

    /// Images, then documents, in one stock `List`.
    ///
    /// Round 2 (native first): the Library was a grid of bordered 26pt cards
    /// under a glass chip bar, with a floating hand-made search capsule. It is the
    /// shape Photos and Files use now — a segmented `Picker` that scrolls with the
    /// content, the pictures as a tight thumbnail grid with small corners and no
    /// frames, documents as plain rows, and `.searchable` for the field.
    @ViewBuilder
    private var content: some View {
        List {
            Section {
                Picker("library.filter", selection: filterSelection) {
                    ForEach(JunoLibraryFilter.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 12, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("juno.mobile.library-filter")

                if model.phase == .offline || model.lastErrorDescription != nil {
                    statusRow
                }

                if madeModel != nil, filter == .all, searchText.isEmpty {
                    NavigationLink(value: JunoLibraryMadeRoute()) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Made by Alevr")
                                    .font(.body)
                                Text("Pages, documents, spreadsheets and decks")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        } icon: {
                            Image(systemName: "square.stack")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                    .accessibilityIdentifier("juno.mobile.library-made")
                }
                if let openArtifacts, filter == .all, searchText.isEmpty {
                    Button(action: openArtifacts) {
                        HStack {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Artifacts")
                                        .font(.body)
                                    Text("Code, pages and diagrams from your chats")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            } icon: {
                                Image(systemName: "square.on.square")
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                    .accessibilityIdentifier("juno.mobile.library-artifacts")
                }
            }

            documentIndexSection

            if !images.isEmpty {
                Section {
                    LazyVGrid(columns: columns, spacing: Self.gridSpacing) {
                        ForEach(images) { file in
                            JunoLibraryThumbnail(
                                file: file,
                                previews: previews,
                                open: { open(file) },
                                rename: { beginRename(file) },
                                remove: { Task { await model.removeFromLibrary(id: file.id) } },
                                edit: canEdit(file) ? { editing = file } : nil,
                                load: { await model.accessFile(id: file.id) }
                            )
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
                    .listRowSeparator(.hidden)
                    .animation(
                        JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: images.count
                    )
                } header: {
                    if filter == .all { Text("library.filter.images") }
                }
            }

            if !documents.isEmpty {
                Section {
                    ForEach(documents) { file in
                        JunoLibraryDocumentRow(
                            file: file,
                            open: { open(file) },
                            rename: { beginRename(file) },
                            remove: { Task { await model.removeFromLibrary(id: file.id) } }
                        )
                    }
                } header: {
                    if filter == .all { Text("library.filter.documents") }
                }
            }

            if files.isEmpty {
                empty
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .searchable(text: $searchText, prompt: Text("library.search"))
        .refreshable { await model.reload() }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("juno.mobile.file-list")
        .navigationDestination(for: JunoLibraryMadeRoute.self) { _ in madeDestination }
    }

    private static let gridSpacing: CGFloat = 4

    private var images: [NativeProjectFile] { files.filter { $0.kind.uppercased() == "IMAGE" } }
    private var documents: [NativeProjectFile] { files.filter { $0.kind.uppercased() != "IMAGE" } }

    private var filterSelection: Binding<JunoLibraryFilter> {
        Binding(
            get: { filter },
            set: { value in
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { filter = value }
            }
        )
    }

    private func beginRename(_ file: NativeProjectFile) {
        renameValue = file.fileName
        renameFileID = file.id
    }

    @ViewBuilder
    private var madeDestination: some View {
        if let madeModel {
            JunoMobileLibraryMadeView(
                model: madeModel,
                artifactModel: artifactModel,
                accountID: accountID,
                workClient: workClient,
                openConversation: openConversation
            )
        }
    }

    /// Offline or a failed refresh, as one plain row with a Retry button.
    private var statusRow: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: model.phase == .offline ? "wifi.slash" : "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(model.lastErrorDescription ?? "Offline — showing saved files.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("Retry") { Task { await model.reload() } }
                .contentShape(.rect)
                .font(.subheadline)
        }
        .listRowSeparator(.hidden)
    }

    // MARK: - Local document index

    /// What the on-device index has to say, or nothing at all: a summary row,
    /// any failure, then the matching passages as plain rows.
    @ViewBuilder
    private var documentIndexSection: some View {
        if let index = documentIndex, index.isReady, indexPanelHasContent(index) {
            Section {
                indexSummary(index)
                if let failure = documentPickerFailure ?? index.lastErrorDescription {
                    indexFailure(failure, index: index)
                }
                indexResults(index)
            } header: {
                Text("On this iPhone")
            }
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
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: "doc.text.magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(indexSummaryLine(index))
                .font(.subheadline)
                .foregroundStyle(.secondary)
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
                    Image(systemName: "ellipsis")
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Manage indexed documents")
                .accessibilityIdentifier("juno.mobile.library-document-index-manage")
            }
        }
    }

    /// The counts come from the index, and the OCR clause appears only when some
    /// document really was transcribed. The memory-only note is stated rather
    /// than assumed: nothing here writes document text to disk.
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
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Dismiss") {
                documentPickerFailure = nil
                index.clearError()
            }
            .contentShape(.rect)
            .font(.subheadline)
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
            if index.isSearching, index.passages.isEmpty {
                Text("Searching your documents…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if index.passages.isEmpty {
                Text("No indexed document mentions “\(query)”.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(index.passages) { passage in
                    passageRow(passage)
                }
            }
        }
    }

    /// One hit: where it came from, then what it says.
    private func passageRow(_ passage: NativeDocumentPassage) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(passage.locator)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(passage.text)
                .font(.subheadline)
                .lineLimit(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(passage.locator). \(passage.text)")
        .accessibilityIdentifier("juno.mobile.library-document-passages")
    }

    /// Reads the chosen files one after another, so the progress line always
    /// names the file actually being read.
    private func ingest(_ urls: [URL]) async {
        guard let documentIndex else { return }
        for url in urls {
            await documentIndex.ingest(contentsOf: url)
        }
    }

    @ViewBuilder
    private var empty: some View {
        if model.libraryFiles.isEmpty {
            ContentUnavailableView {
                Label("library.empty.title", systemImage: "photo.on.rectangle")
            } description: {
                Text("library.empty.detail")
            }
        } else {
            ContentUnavailableView {
                Label("library.no-matches.title", systemImage: "magnifyingglass")
            } description: {
                Text("library.no-matches.detail")
            }
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

/// The push into "Made by Alevr".
private struct JunoLibraryMadeRoute: Hashable {}

// MARK: - Thumbnail

/// One picture in the grid: the thumbnail itself, small corners, no frame.
private struct JunoLibraryThumbnail: View {
    let file: NativeProjectFile
    let previews: NativeFilePreviewLoader
    let open: () -> Void
    let rename: () -> Void
    let remove: () -> Void
    /// Present only for an image, and only when a model on this account can edit
    /// one. Absent rather than disabled — see `JunoMobileLibraryView`.
    let edit: (() -> Void)?
    /// Fetches the bytes. Passed as a closure so the cell never holds the model.
    let load: () async -> NativeProjectFileAccess?

    private var request: NativeFilePreviewRequest { NativeFilePreviewRequest(file) }

    var body: some View {
        Button(action: open) {
            Color(.secondarySystemFill)
                .aspectRatio(1, contentMode: .fit)
                .overlay { picture }
                .clipShape(.rect(cornerRadius: 6, style: .continuous))
                .contentShape(.rect(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .contextMenu {
            Button { open() } label: { Label("Open", systemImage: "eye") }
            if let edit { Button { edit() } label: { Label("Edit Image…", systemImage: "wand.and.stars") } }
            Button { rename() } label: { Label("Rename", systemImage: "pencil") }
            Divider()
            let removal = JunoLibraryRemovalLabel(file.libraryUse)
            Button(role: .destructive, action: remove) {
                Label(removal.title, systemImage: "trash")
                if let detail = removal.detail { Text(detail) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(file.fileName), \(request.sizeLabel)")
        .accessibilityAddTraits(.isButton)
        .task(id: file.id) { await previews.load(request, using: load) }
    }

    @ViewBuilder
    private var picture: some View {
        switch previews.state(for: file.id) {
        case .ready(let image):
            Image(decorative: image, scale: 1)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
        case .loading:
            EmptyView()
        case .unavailable:
            Image(systemName: "photo")
                .font(.title3)
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Document row

/// One document as a plain list row: the type's symbol, the name, then size and
/// date in secondary text.
private struct JunoLibraryDocumentRow: View {
    let file: NativeProjectFile
    let open: () -> Void
    let rename: () -> Void
    let remove: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: Self.symbol(for: file.fileName))
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
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
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: remove) {
                Label(JunoLibraryRemovalLabel(file.libraryUse).title, systemImage: "trash")
            }
            Button(action: rename) { Label("Rename", systemImage: "pencil") }
        }
        .contextMenu {
            Button { open() } label: { Label("Open", systemImage: "eye") }
            Button { rename() } label: { Label("Rename", systemImage: "pencil") }
            Divider()
            let removal = JunoLibraryRemovalLabel(file.libraryUse)
            Button(role: .destructive, action: remove) {
                Label(removal.title, systemImage: "trash")
                if let detail = removal.detail { Text(detail) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let size = ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
        return "\(size) · \(JunoMobileRelativeDate.text(file.createdAt))"
    }

    static func symbol(for fileName: String) -> String {
        switch URL(fileURLWithPath: fileName).pathExtension.lowercased() {
        case "pdf": "doc.richtext"
        case "xls", "xlsx", "csv", "numbers": "tablecells"
        case "ppt", "pptx", "key": "rectangle.on.rectangle"
        case "zip", "gz", "tar": "doc.zipper"
        case "mp3", "m4a", "wav", "aac": "waveform"
        case "mov", "mp4", "m4v": "film"
        case "swift", "js", "ts", "tsx", "py", "json", "html", "css": "chevron.left.forwardslash.chevron.right"
        default: "doc.text"
        }
    }
}

/// "Now", "2 min", "3 hr", "Yesterday", "Tuesday", "12 Sep", "12 Sep 2024" —
/// the short relative stamps Mail and Messages use. Shared by the workspace
/// lists so every row reads its date the same way.
enum JunoMobileRelativeDate {
    static func text(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return String(localized: "Now") }
        if seconds < 3_600 {
            return Duration.seconds(seconds).formatted(.units(allowed: [.minutes], width: .abbreviated))
        }
        if calendar.isDateInToday(date) {
            return Duration.seconds(seconds).formatted(.units(allowed: [.hours], width: .abbreviated))
        }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday") }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }
}


// MARK: - Removal

/// The words on a card's destructive action.
///
/// The server keeps a file that a chat or project uses, and deletes a file
/// nothing uses. So what the action does depends on the file, and the menu
/// says which before the tap.
struct JunoLibraryRemovalLabel: Equatable {
    let title: String
    let detail: String?

    init(_ use: NativeLibraryUse?) {
        switch use {
        case .chat:
            title = String(localized: "library.remove")
            detail = String(localized: "library.remove.kept-in-chat")
        case .project:
            title = String(localized: "library.remove")
            detail = String(localized: "library.remove.kept-in-project")
        case nil:
            title = String(localized: "Delete")
            detail = nil
        }
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
