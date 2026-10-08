import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

/// The Library: every file this account has shared with Juno, as the web's
/// `/library` shows it (Phase 4 A4; `src/app/(app)/library/page.tsx`,
/// `components/library/*`).
///
/// **The web's shape.** The header carries the storage caption, Recently
/// deleted and Upload; the controls row the search, All / Images / Files with
/// their counts, the sort and List / Grid — **List** by default. Recently
/// deleted is a view of its own with its own title and a way back. A delete is
/// optimistic with Undo in the window's toast host, as the web's is; nothing
/// asks "are you sure?" about something that can be undone.
///
/// **Mac extras** (register #61): Add Document… (the local index), Copy
/// Names, Quick Look on Space, Edit Image…, and the files dragging out.
///
/// **The second half of the page is local.** `Add Document…` reads a file on
/// this disk into chunks in this Mac's retrieval index, so search finds
/// passages inside a PDF and not only file names. It stays below the header,
/// restyled to the page's rhythm (register #51).
struct DesktopLibraryScreen: View {
    @Bindable var model: NativeLibraryPageModel
    /// This Mac's local document index, or nil where the shell built none.
    var documentIndex: NativeDocumentIndexModel?
    /// Everything the image editor needs. Edit Image… is absent, not
    /// disabled, when any of it is missing.
    var accountID: AccountID?
    var attachmentClient: NativeAttachmentAPIClient?
    var generateClient: NativeChatAPIClient?
    var modelCatalog: [NativeChatModelOption] = []
    /// A file's bytes, for thumbnails, Quick Look and Download. Nil draws
    /// typed tiles and leaves those actions out.
    var fileAccess: ((String) async -> NativeProjectFileAccess?)?
    var openConversation: ((String) -> Void)?
    /// Files picked out when the page opens (the snapshot harness's
    /// selection state).
    var initialSelection: Set<String> = []

    @Environment(\.junoToast) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Presentation: String, CaseIterable {
        case list, grid
    }

    /// Remembered, List by default as on the web (`juno-library-view`).
    @AppStorage("juno.desktop.library.view") private var storedPresentation = Presentation.list.rawValue
    @State private var selection: Set<String> = []
    @State private var selectionAnchor: String?
    @State private var hoveredID: String?
    @State private var previews = NativeFilePreviewLoader()
    @State private var editing: NativeLibraryItem?
    @State private var renaming: JunoRenameRequest?
    @State private var versionsTarget: NativeLibraryItem?
    @State private var choosingUpload = false
    @State private var choosingDocument = false
    @State private var documentPanelFailure: String?
    @State private var dropTargeted = false
    @State private var quickLookURL: URL?
    @State private var download: DesktopLibraryDownload?
    @State private var dealt = false

    private var presentation: Presentation {
        Presentation(rawValue: storedPresentation) ?? .list
    }

    private var presentationBinding: Binding<Presentation> {
        Binding(get: { presentation }, set: { storedPresentation = $0.rawValue })
    }

    private var rows: [NativeLibraryItem] { model.items ?? [] }
    private var isDeletedView: Bool { model.query.deleted }
    private var isLoading: Bool { model.items == nil && !model.failed }
    private var isFiltered: Bool {
        !model.query.q.trimmingCharacters(in: .whitespaces).isEmpty || model.query.kind != .all
    }

    private var isEmptyLibrary: Bool {
        !isFiltered && rows.isEmpty && model.uploads.isEmpty && model.items != nil
    }

    var body: some View {
        JunoPage(measure: .wide, scrolling: .page) {
            header
        } controls: {
            // Only once there is something to filter; a no-results state keeps
            // the row, because the reader needs the field to clear the search.
            if !isLoading, !model.failed, !isEmptyLibrary {
                controls
            }
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                if !isDeletedView {
                    documentIndexPanel
                }
                content
            }
        }
        .overlay { dropVeil }
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted, perform: acceptDrop)
        .junoToastStatus(id: "library.refresh", refreshFailure) { _ in
            JunoToast(
                tone: .error,
                title: "Couldn’t load your files",
                detail: "Check your connection and try again.",
                action: JunoToast.Action("Try Again") { reload() }
            )
        }
        .junoToastSelection(selectionBar, id: selection)
        .junoRenameSheet($renaming)
        .sheet(item: $versionsTarget) { item in
            DesktopLibraryVersionsSheet(item: item, model: model) { versionsTarget = nil }
        }
        .sheet(item: $editing) { editSheet($0) }
        .fileImporter(
            isPresented: $choosingUpload,
            allowedContentTypes: DesktopLibraryUploads.acceptedTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { upload(urls) }
        }
        .fileImporter(
            isPresented: $choosingDocument,
            allowedContentTypes: NativeDocumentIndexModel.readableContentTypes,
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                documentPanelFailure = nil
                Task { await ingest(urls) }
            case .failure(let error):
                documentPanelFailure = error.localizedDescription
            }
        }
        .fileExporter(
            isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
            document: download?.document,
            contentType: .data,
            defaultFilename: download?.name
        ) { _ in download = nil }
        .quickLookPreview($quickLookURL)
        .task {
            if model.items == nil { await model.reload() }
        }
        .onAppear {
            if selection.isEmpty, !initialSelection.isEmpty { selection = initialSelection }
        }
        .onChange(of: model.event) { _, event in
            guard let event else { return }
            post(event)
            model.clearEvent()
        }
        .onChange(of: model.query) { _, _ in pruneSelection() }
        .onChange(of: model.items) { _, _ in pruneSelection() }
        .onChange(of: model.searchText) { _, text in documentIndex?.setQuery(text) }
        .onChange(of: model.items == nil) { _, loading in if !loading { dealt = true } }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        if isDeletedView {
            JunoPageHeader(
                "Recently deleted",
                lede: "Files you remove land here and can be restored. Chats and projects keep the ones they use."
            ) {
                Button {
                    clearSelection()
                    model.setDeleted(false)
                } label: {
                    Label("Back to files", icon: .arrowLeft)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
            }
        } else {
            JunoPageHeader("Library", lede: "Everything you upload or share in chats.") {
                // Withheld while loading or failed, as Projects and
                // Automations withhold theirs: nothing to count or add to yet.
                if let storage = model.storage, !isLoading, !model.failed, !isEmptyLibrary {
                    DesktopPageLayoutReader { layout in
                        if layout.pageWidth >= 640 {
                            Text("\(Self.sizeLabel(storage.usedBytes)) of \(Self.sizeLabel(storage.quotaBytes)) used")
                                .junoType(.ui)
                                .monospacedDigit()
                                .foregroundStyle(Color.junoSecondaryInk)
                                .fixedSize()
                        }
                    }
                }
                Button {
                    clearSelection()
                    model.setDeleted(true)
                } label: {
                    Label("Recently deleted", icon: .trash)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                // Withheld while the empty state carries "Upload files": one
                // prominent button per surface (the web shows both).
                if !isLoading, !model.failed, !isEmptyLibrary {
                    Button {
                        choosingUpload = true
                    } label: {
                        Label("Upload", icon: .upload)
                    }
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .help("Upload files to your library")
                }
                moreMenu
            }
        }
    }

    /// The Mac's extras, behind one 28pt More.
    private var moreMenu: some View {
        Menu {
            Button {
                documentPanelFailure = nil
                choosingDocument = true
            } label: {
                Label("Add Document…", icon: .filePlus)
            }
            // No chords on an in-window menu (§7.1): the menu bar owns every
            // chord, and ⌘R is Chat's Regenerate there.
            .disabled(documentIndex?.isReady != true || documentIndex?.isIngesting == true)
            Button {
                reload()
            } label: {
                Label("Refresh", icon: .refresh)
            }
            .disabled(model.pending)
        } label: {
            JunoIconView(.ellipsis, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .help("More library actions")
        .accessibilityLabel("More library actions")
    }

    // MARK: - Controls

    private var controls: some View {
        JunoPageControls {
            JunoPageSearchField(
                text: $model.searchText,
                prompt: "Search files",
                isSearching: model.pending && !model.searchText.isEmpty,
                accessibilityIdentifier: "juno.desktop.library-search"
            )
            JunoSegmented(
                options: [
                    .init(NativeLibraryQuery.Kind.all, "All", count: model.counts?.all),
                    .init(NativeLibraryQuery.Kind.image, "Images", count: model.counts?.images),
                    .init(NativeLibraryQuery.Kind.file, "Files", count: model.counts?.files),
                ],
                selection: Binding(get: { model.query.kind }, set: { model.setKind($0) }),
                accessibilityLabel: "Filter by type"
            )
            JunoPageMenu(
                options: [
                    JunoPageMenuOption(NativeLibraryQuery.Sort.newest, "Newest first", menuTitle: "Newest First"),
                    JunoPageMenuOption(NativeLibraryQuery.Sort.oldest, "Oldest first", menuTitle: "Oldest First"),
                    JunoPageMenuOption(NativeLibraryQuery.Sort.name, "Name"),
                    JunoPageMenuOption(NativeLibraryQuery.Sort.size, "Largest first", menuTitle: "Largest First"),
                ],
                selection: Binding(get: { model.query.sort }, set: { model.setSort($0) }),
                accessibilityLabel: "Sort files"
            )
        } trailing: {
            if presentation == .grid, !rows.isEmpty {
                Button(selection.isEmpty ? "Select all" : "Clear selection") {
                    if selection.isEmpty {
                        selection = Set(rows.map(\.id))
                    } else {
                        clearSelection()
                    }
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentShape(.rect)
            }
            JunoSegmented(
                options: [
                    .init(Presentation.list, "List", icon: .list),
                    .init(Presentation.grid, "Grid", icon: .grid),
                ],
                selection: presentationBinding,
                accessibilityLabel: "View"
            )
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if model.failed, model.items == nil {
            JunoEmptyState(
                title: "Couldn’t load your files",
                message: "Check your connection and try again.",
                icon: .triangleAlert,
                actionLabel: "Try Again",
                action: reload,
                tone: .error
            )
        } else if isLoading {
            DesktopLibrarySkeleton(presentation: presentation)
        } else if rows.isEmpty, model.uploads.isEmpty {
            emptyState
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                if !model.uploads.isEmpty {
                    uploadRows
                }
                if !rows.isEmpty {
                    if presentation == .grid { grid } else { list }
                }
                if model.hasMore {
                    loadMore
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if isDeletedView, !isFiltered {
            JunoEmptyState(
                title: "Nothing in Recently deleted",
                icon: .trash,
                actionLabel: "Back to files",
                action: { model.setDeleted(false) }
            )
        } else if isFiltered {
            JunoEmptyState(
                title: "No matching files",
                message: "Try another name, or clear the filter.",
                icon: .search,
                size: .panel
            ) {
                Button("Clear filters") { model.clearFilters() }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .contentShape(.rect)
            }
        } else {
            JunoEmptyState(
                title: "No files yet",
                message: "Upload files here, or drop them anywhere on this page. Files you share in chats are kept here too.",
                icon: .library
            ) {
                Button("Upload files") { choosingUpload = true }
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                if openConversation != nil {
                    Button("Go to chat") { openConversation?("") }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .contentShape(.rect)
                }
            }
        }
    }

    // MARK: List

    /// Rows in one card, divided at 70% — the web's list with columns Name ·
    /// Type · Size · Added.
    private var list: some View {
        DesktopPageLayoutReader { layout in
            listBody(width: layout.pageWidth)
        }
    }

    private func listBody(width: CGFloat) -> some View {
        let columns = DesktopLibraryColumns(width: width)
        return VStack(spacing: 0) {
            if columns.showsSize {
                DesktopLibraryListHeader(columns: columns)
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.7))
                        .frame(height: 1)
                        .padding(.horizontal, JunoSpace.regular)
                        .accessibilityHidden(true)
                }
                listRow(item, columns: columns)
                    .junoDealt(index: index, active: !dealt, reduceMotion: reduceMotion)
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(rows.count) \(rows.count == 1 ? "file" : "files")")
        .copyable(selectedNames)
    }

    private func listRow(_ item: NativeLibraryItem, columns: DesktopLibraryColumns) -> some View {
        let selected = selection.contains(item.id)
        let hovered = hoveredID == item.id
        return HStack(spacing: JunoSpace.cozy) {
            DesktopLibraryInset(item: item, state: previewState(item), onSelection: selected)
                .task(id: item.id) { await loadPreview(item) }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.fileName)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !columns.showsSize {
                    // Below 640 the numbers fold into one meta line (the web's
                    // `MetaLine`).
                    Text("\(Self.typeLabel(item)) · \(Self.sizeLabel(item.size)) · \(Self.ageLabel(item.createdAt))")
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                rowNote(item, wide: columns.showsSize)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if columns.showsType {
                Text(Self.kindLabel(item))
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: DesktopLibraryListHeader.typeWidth, alignment: .leading)
            }
            if columns.showsSize {
                Text(Self.sizeLabel(item.size))
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: DesktopLibraryListHeader.sizeWidth, alignment: .leading)
                Text(Self.ageLabel(item.createdAt))
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: DesktopLibraryListHeader.addedWidth, alignment: .leading)
                    .help(item.createdAt.formatted(date: .long, time: .shortened))
            }
            rowMore(item, visible: hovered || selected)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(selected ? Color.junoSecondary : (hovered ? Color.junoHover : Color.clear))
                .padding(.horizontal, JunoSpace.tight)
        )
        .contentShape(.rect)
        .onTapGesture(count: 2) { quickLook(item) }
        .onTapGesture { click(item) }
        // Return opens, Space is Quick Look, as in Finder.
        .desktopKeyboardOpen { quickLook(item) }
        .onKeyPress(.space) {
            quickLook(item)
            return .handled
        }
        .onHover { inside in hover(item, inside) }
        .contextMenu { actions(for: item) }
        .draggable(DesktopLibraryDragItem(name: item.fileName)) {
            Text(item.fileName)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.accessibilityLabel(for: item))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { toggle(item) }
    }

    /// The row's one caption line, in the web's words: where a kept file
    /// stays, else what indexing made of it, else a way to its chat.
    @ViewBuilder
    private func rowNote(_ item: NativeLibraryItem, wide: Bool) -> some View {
        if let kept = item.keptIn {
            Text(kept == .chat ? "Still in chat" : "Still in project")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
        } else if let note = Self.indexNote(item.knowledge) {
            Text(note)
                .junoType(.caption)
                .foregroundStyle(item.knowledge?.state == "failed" ? Color.junoDestructiveInk : Color.junoSecondaryInk)
                .lineLimit(1)
        } else if wide, !isDeletedView, let conversationID = item.conversationID, let openConversation {
            Button {
                openConversation(conversationID)
            } label: {
                Label("Open source chat", icon: .message)
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .contentShape(.rect)
            .help("Open the chat this file was shared in")
        }
    }

    /// What indexing made of a file, when it is worth a line.
    static func indexNote(_ knowledge: NativeLibraryKnowledge?) -> String? {
        switch knowledge?.state {
        case "queued", "processing", "pending": "Indexing for search…"
        case "failed": "This file could not be indexed."
        case "partial": "Only part of this file could be indexed."
        default: nil
        }
    }

    // MARK: Grid

    /// Square tiles, 2 / 3 / 4 columns at 640 / 1024 of the page.
    private var grid: some View {
        DesktopPageLayoutReader { layout in
            gridBody(width: layout.pageWidth)
        }
    }

    private func gridBody(width: CGFloat) -> some View {
        let columns = width >= 1_024 ? 4 : (width >= 640 ? 3 : 2)
        return LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.regular, alignment: .top), count: columns),
            alignment: .leading,
            spacing: JunoSpace.regular
        ) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                tile(item)
                    .junoDealt(index: index, active: !dealt, reduceMotion: reduceMotion)
            }
        }
        .copyable(selectedNames)
    }

    private func tile(_ item: NativeLibraryItem) -> some View {
        let selected = selection.contains(item.id)
        let hovered = hoveredID == item.id
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeFilePreviewTile(
                file: NativeFilePreviewRequest(item),
                state: previewState(item),
                cornerRadius: JunoRadius.card - JunoSpace.snug,
                // The name and size are printed under the picture already.
                fallback: .glyph
            )
            .aspectRatio(1, contentMode: .fit)
            .task(id: item.id) { await loadPreview(item) }
            .overlay(alignment: .topLeading) {
                Button {
                    toggle(item)
                } label: {
                    JunoIconView(selected ? .circleCheck : .circle, size: 18)
                        .foregroundStyle(selected ? Color.junoForeground : Color.junoSecondaryInk)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Color.junoCard.opacity(0.9)))
                }
                    .contentShape(.rect)
                .buttonStyle(.plain)
                .padding(JunoSpace.tight)
                .opacity(selected || hovered ? 1 : 0)
                .help(selected ? "Deselect" : "Select")
                .accessibilityLabel(selected ? "Deselect \(item.fileName)" : "Select \(item.fileName)")
            }
            HStack(alignment: .top, spacing: JunoSpace.tight) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.fileName)
                        .junoType(.ui)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("\(Self.kindLabel(item)) · \(Self.sizeLabel(item.size))")
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                rowMore(item, visible: hovered || selected)
            }
            .padding(.horizontal, JunoSpace.tight)
        }
        .padding(JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(hovered ? Color.junoHover : Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(selected ? Color.junoForeground.opacity(0.4) : Color.junoBorder, lineWidth: selected ? 2 : 1)
        )
        .contentShape(.rect)
        .onTapGesture(count: 2) { quickLook(item) }
        .onTapGesture { click(item) }
        // Return opens, Space is Quick Look, as in Finder.
        .desktopKeyboardOpen { quickLook(item) }
        .onKeyPress(.space) {
            quickLook(item)
            return .handled
        }
        .onHover { inside in hover(item, inside) }
        .contextMenu { actions(for: item) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.accessibilityLabel(for: item))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { toggle(item) }
    }

    private func rowMore(_ item: NativeLibraryItem, visible: Bool) -> some View {
        Menu {
            actions(for: item)
        } label: {
            JunoIconView(.ellipsis, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .opacity(visible ? 1 : 0)
        .help("More actions for \(item.fileName)")
        .accessibilityLabel("More actions for \(item.fileName)")
    }

    // MARK: Row actions

    /// One definition for the More button and the context menu (the web's
    /// `renderActions`). A right-click on a selected row acts on the whole
    /// selection, as every Mac list does.
    @ViewBuilder
    private func actions(for item: NativeLibraryItem) -> some View {
        let targets = targets(for: item)
        if isDeletedView {
            Button("Restore") { restore(targets) }
                .contentShape(.rect)
        } else {
            if targets.count == 1 {
                Button("Rename…") { rename(item) }
                    .contentShape(.rect)
                if item.versionCount > 1 {
                    Button("Versions…") { versionsTarget = item }
                        .contentShape(.rect)
                }
            }
            if targets.count == 1, fileAccess != nil {
                Button("Download…") { downloadFile(item) }
                    .contentShape(.rect)
                Button("Quick Look") { quickLook(item) }
                    .contentShape(.rect)
                    .keyboardShortcut(.space, modifiers: [])
            }
            if targets.count == 1, let conversationID = item.conversationID, let openConversation {
                Button("Open Source Chat") { openConversation(conversationID) }
                    .contentShape(.rect)
            }
            if targets.count == 1, item.isImage, canEdit {
                Button("Edit Image…") { editing = item }
                    .contentShape(.rect)
            }
            Button(Self.copyTitle(count: targets.count)) { copyNames(targets) }
                .contentShape(.rect)
            Divider()
            Button("Delete", role: .destructive) { delete(targets) }
                .contentShape(.rect)
        }
    }

    private func targets(for item: NativeLibraryItem) -> [NativeLibraryItem] {
        guard selection.contains(item.id) else { return [item] }
        return rows.filter { selection.contains($0.id) }
    }

    // MARK: Uploads and paging

    private var uploadRows: some View {
        VStack(spacing: 0) {
            ForEach(Array(model.uploads.enumerated()), id: \.element.id) { index, upload in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.7))
                        .frame(height: 1)
                        .padding(.horizontal, JunoSpace.regular)
                        .accessibilityHidden(true)
                }
                DesktopLibraryUploadRow(
                    upload: upload,
                    retry: { model.retryUpload(upload.id) },
                    dismiss: { model.dismissUpload(upload.id) }
                )
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }

    private var loadMore: some View {
        HStack {
            Spacer()
            Button(model.loadingMore ? "Loading…" : "Load more") {
                Task { await model.loadMore() }
            }
                .contentShape(.rect)
            .buttonStyle(.bordered)
            .tint(nil)
            .disabled(model.loadingMore)
            Spacer()
        }
        .padding(.top, JunoSpace.snug)
        // Near the end of the list, the next page asks for itself.
        .onAppear { Task { await model.loadMore() } }
    }

    // MARK: - The drop veil (the page's signature)

    /// Dragging files anywhere over the page shows an opaque veil — "Drop to
    /// upload" — and a dropped file appears as an uploading row that settles
    /// into the list when it lands. Not in Recently deleted.
    @ViewBuilder
    private var dropVeil: some View {
        if dropTargeted, !isDeletedView {
            DesktopLibraryDropVeil()
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }

    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        guard !isDeletedView else { return false }
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        let model = model
        for provider in fileProviders {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in
                    let files = DesktopLibraryUploads.read([url])
                    if !files.isEmpty { model.upload(files) }
                }
            }
        }
        return true
    }

    private func upload(_ urls: [URL]) {
        let files = DesktopLibraryUploads.read(urls)
        guard !files.isEmpty else { return }
        model.upload(files)
    }

    // MARK: - Selection bar

    private var selectionBar: JunoToastSelection? {
        guard !selection.isEmpty else { return nil }
        let targets = rows.filter { selection.contains($0.id) }
        var actions: [JunoToast.Action] = []
        if isDeletedView {
            actions.append(JunoToast.Action("Restore", icon: .restore) { restore(targets) })
        } else {
            if targets.count == 1, let only = targets.first {
                actions.append(JunoToast.Action("Rename", icon: .edit) { rename(only) })
            }
            actions.append(JunoToast.Action(Self.copyTitle(count: targets.count), icon: .copy) { copyNames(targets) })
            actions.append(JunoToast.Action("Delete", icon: .trash, role: .destructive) { delete(targets) })
        }
        return JunoToastSelection(count: targets.count, actions: actions, clear: { clearSelection() })
    }

    private var refreshFailure: String? {
        model.failed && model.items != nil ? "failed" : nil
    }

    // MARK: - Actions

    private func delete(_ targets: [NativeLibraryItem]) {
        guard !targets.isEmpty else { return }
        clearSelection()
        let deletion = model.delete(targets)
        toast(JunoToast(
            title: deletion.notice.title,
            detail: deletion.notice.detail,
            action: JunoToast.Action("Undo") {
                Task { await model.undo(deletion) }
            },
            duration: .seconds(6)
        ))
    }

    private func restore(_ targets: [NativeLibraryItem]) {
        clearSelection()
        Task { await model.restore(targets) }
    }

    private func rename(_ item: NativeLibraryItem) {
        renaming = JunoRenameRequest(
            title: "Rename file",
            message: "The new name shows everywhere this file appears.",
            fieldLabel: "File name",
            confirmTitle: "Rename",
            current: item.fileName
        ) { name in
            await model.rename(item, to: name)
        }
    }

    private func post(_ event: NativeLibraryEvent) {
        switch event {
        case .deleteFailed(let count):
            toast(.error(count == 1 ? "Couldn’t delete that file." : "Couldn’t delete some of those files."))
        case .undoFailed:
            toast(.error("Couldn’t undo. The files are in Recently deleted."))
        case .restored:
            toast(.success("Restored to your library"))
        case .restoreFailed(let count):
            toast(.error(count == 1 ? "Couldn’t restore that file." : "Couldn’t restore some of those files."))
        case .renameFailed(let message):
            toast(.error(message))
        case .loadMoreFailed:
            toast(.error("Couldn’t load more files."))
        case .uploaded(let hidden):
            if hidden {
                toast(.info("Uploaded. Your filters are hiding it.", action: JunoToast.Action("Show") { model.clearFilters() }))
            }
        case .uploadFailed(let name):
            toast(.error("Couldn’t upload \(name)."))
        case .versionRestored:
            toast(.success("Version restored"))
        case .versionRestoreFailed:
            toast(.error("Couldn’t restore that version."))
        }
    }

    private var canEdit: Bool {
        accountID != nil && attachmentClient != nil && generateClient != nil
            && modelCatalog.contains { $0.modality == "image" && $0.imageEditSupport != .none }
    }

    @ViewBuilder
    private func editSheet(_ item: NativeLibraryItem) -> some View {
        if let accountID, let attachmentClient, let generateClient {
            NativeImageEditSheet(
                attachmentID: item.id,
                fileName: item.fileName,
                accountID: accountID,
                attachments: attachmentClient,
                client: generateClient,
                models: modelCatalog,
                openConversation: openConversation,
                close: { editing = nil }
            )
            .frame(minWidth: 560, minHeight: 640)
        }
    }

    /// With no way to the bytes, the typed tile, never a blank one.
    private func previewState(_ item: NativeLibraryItem) -> NativeFilePreviewLoader.State {
        fileAccess == nil ? .unavailable : previews.state(for: item.id)
    }

    private func loadPreview(_ item: NativeLibraryItem) async {
        guard let fileAccess else { return }
        await previews.load(NativeFilePreviewRequest(item)) {
            await fileAccess(item.id)
        }
    }

    private func quickLook(_ item: NativeLibraryItem) {
        guard let fileAccess else { return }
        Task {
            guard let data = await DesktopLibraryUploads.bytes(await fileAccess(item.id)) else {
                toast(.error("Couldn’t open that file."))
                return
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("juno-quicklook", isDirectory: true)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(item.fileName)
            do {
                try data.write(to: url, options: .atomic)
                quickLookURL = url
            } catch {
                toast(.error("Couldn’t open that file."))
            }
        }
    }

    private func downloadFile(_ item: NativeLibraryItem) {
        guard let fileAccess else { return }
        Task {
            guard let data = await DesktopLibraryUploads.bytes(await fileAccess(item.id)) else {
                toast(.error("Couldn’t download that file."))
                return
            }
            download = DesktopLibraryDownload(document: DesktopLibraryFileDocument(data: data), name: item.fileName)
        }
    }

    private func click(_ item: NativeLibraryItem) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            toggle(item)
        } else if flags.contains(.shift), let anchor = selectionAnchor,
            let start = rows.firstIndex(where: { $0.id == anchor }),
            let end = rows.firstIndex(where: { $0.id == item.id })
        {
            selection.formUnion(rows[min(start, end)...max(start, end)].map(\.id))
        } else {
            selection = [item.id]
            selectionAnchor = item.id
        }
    }

    private func toggle(_ item: NativeLibraryItem) {
        if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
        selectionAnchor = item.id
    }

    private func hover(_ item: NativeLibraryItem, _ inside: Bool) {
        if inside { hoveredID = item.id } else if hoveredID == item.id { hoveredID = nil }
    }

    private func clearSelection() {
        selection = []
        selectionAnchor = nil
    }

    private func pruneSelection() {
        guard !selection.isEmpty else { return }
        selection.formIntersection(Set(rows.map(\.id)))
    }

    private var selectedNames: [String] {
        rows.filter { selection.contains($0.id) }.map(\.fileName)
    }

    private func copyNames(_ targets: [NativeLibraryItem]) {
        let names = targets.map(\.fileName)
        guard !names.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(names.joined(separator: "\n"), forType: .string)
    }

    private func reload() {
        Task { await model.reload() }
    }

    // MARK: - Local document index

    @ViewBuilder
    private var documentIndexPanel: some View {
        if let index = documentIndex, index.isReady, indexPanelHasContent(index) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                indexSummary(index)
                if let failure = documentPanelFailure ?? index.lastErrorDescription {
                    indexFailure(failure, index: index)
                }
                indexResults(index)
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .padding(.bottom, JunoSpace.section)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Documents indexed on this Mac")
            .accessibilityIdentifier("juno.desktop.library-document-index")
        }
    }

    private func indexPanelHasContent(_ index: NativeDocumentIndexModel) -> Bool {
        !index.documents.isEmpty
            || index.isIngesting
            || index.lastErrorDescription != nil
            || documentPanelFailure != nil
    }

    private func indexSummary(_ index: NativeDocumentIndexModel) -> some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.fileSearch)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            Text(indexSummaryLine(index))
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
            if index.isIngesting {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: JunoSpace.snug)
            if !index.documents.isEmpty {
                indexDocumentsMenu(index)
            }
        }
        // Said here rather than nowhere: `DocumentRetrievalIndex` keeps chunks in
        // memory and this screen adds no persistence, so quitting really does
        // empty it. A reader who expected these to survive a relaunch would
        // otherwise conclude the feature is broken.
        .help("Indexed documents stay on this Mac, in memory only, and are cleared when you quit Alevr or sign out.")
    }

    /// "2 documents · 143 passages", "Reading Contract.pdf…", or the OCR note.
    ///
    /// Counts come from the index itself, never from a guess, and the OCR clause
    /// is present only when some document really was transcribed — a blanket "may
    /// contain OCR errors" on documents that carried embedded text would be a
    /// warning about a thing that did not happen.
    private func indexSummaryLine(_ index: NativeDocumentIndexModel) -> String {
        if let name = index.ingestingFileName { return "Reading \(name)…" }
        guard !index.documents.isEmpty else {
            return "No documents indexed on this Mac."
        }
        let documents = index.documents.count
        var line = "\(documents) \(documents == 1 ? "document" : "documents")"
        line += " · \(index.chunkCount) searchable \(index.chunkCount == 1 ? "passage" : "passages")"
        if index.documents.contains(where: \.usedOpticalCharacterRecognition) {
            line += " · some text was read by OCR"
        }
        return line
    }

    private func indexDocumentsMenu(_ index: NativeDocumentIndexModel) -> some View {
        Menu {
            ForEach(index.documents) { document in
                Button("Remove \(document.sourceName)") {
                    Task { await index.remove(document) }
                }
                .help(indexDocumentDetail(document))
            }
        } label: {
            Text("Manage")
                .frame(minHeight: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .contentShape(.rect)
        .help("Remove a document from this Mac's search index")
        .accessibilityIdentifier("juno.desktop.library-document-index-manage")
    }

    /// One document's facts, and only the ones that are known: a CSV has no page
    /// count and prints none, rather than "0 pages".
    private func indexDocumentDetail(_ document: NativeIndexedDocument) -> String {
        var parts = [document.format.rawValue.uppercased()]
        if let pageCount = document.pageCount {
            parts.append("\(pageCount) \(pageCount == 1 ? "page" : "pages")")
        }
        parts.append("\(document.chunkCount) \(document.chunkCount == 1 ? "passage" : "passages")")
        if document.usedOpticalCharacterRecognition {
            parts.append("read by OCR")
        }
        return parts.joined(separator: " · ")
    }

    private func indexFailure(_ message: String, index: NativeDocumentIndexModel) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.triangleAlert)
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Dismiss") {
                documentPanelFailure = nil
                index.clearError()
            }
                .contentShape(.rect)
            .buttonStyle(.borderless)
        }
        .accessibilityIdentifier("juno.desktop.library-document-index-error")
    }

    /// The passages the query matched, most relevant first.
    ///
    /// Three states, and they are three because collapsing any two of them says
    /// something untrue. Nothing is drawn when no question was asked; "searching"
    /// while the ranker is running; and "nothing in these documents mentions …"
    /// only once a search has actually returned empty — which is a fact about the
    /// corpus, not about a search that has not finished.
    @ViewBuilder
    private func indexResults(_ index: NativeDocumentIndexModel) -> some View {
        if !searchQuery.isEmpty, !index.documents.isEmpty {
            Divider()
            if index.isSearching, index.passages.isEmpty {
                Text("Searching your documents…")
                    .junoCaption()
                    .junoSecondaryInk()
            } else if index.passages.isEmpty {
                Text("No indexed document mentions “\(searchQuery)”.")
                    .junoCaption()
                    .junoSecondaryInk()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                        ForEach(index.passages) { passage in
                            passageRow(passage)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Capped so a hit list can never push the file grid off the page:
                // the files are still the subject of this screen.
                .frame(maxHeight: 240)
                .scrollBounceBehavior(.basedOnSize)
                .accessibilityIdentifier("juno.desktop.library-document-passages")
            }
        }
    }

    /// One hit: where it came from, then what it says.
    ///
    /// The locator leads because it is the part a reader checks before trusting
    /// the quote, and it is built by the retrieval layer out of only the
    /// positional facts the extractor actually observed — a passage from a CSV
    /// names its rows and claims no page.
    private func passageRow(_ passage: NativeDocumentPassage) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(passage.locator)
                .junoCaption()
                .junoSecondaryInk()
                .lineLimit(1)
                .truncationMode(.middle)
            Text(passage.text)
                .junoRowLabel()
                .lineLimit(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, JunoSpace.hairline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(passage.locator). \(passage.text)")
    }

    private var searchQuery: String {
        model.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func ingest(_ urls: [URL]) async {
        guard let documentIndex else { return }
        for url in urls {
            await documentIndex.ingest(contentsOf: url)
        }
    }

    // MARK: - Formatting

    static func copyTitle(count: Int) -> String {
        count == 1 ? "Copy Name" : "Copy \(count) Names"
    }

    /// The web's `formatBytes` (`src/lib/utils.ts`): 1024-based, one
    /// decimal at most, "0 B" for nothing.
    static func sizeLabel(_ bytes: Int) -> String {
        guard bytes > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB"]
        let exponent = min(Int(log(Double(bytes)) / log(1_024)), units.count - 1)
        let value = Double(bytes) / pow(1_024, Double(exponent))
        let rounded = (value * 10).rounded() / 10
        let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
        return "\(text) \(units[exponent])"
    }

    static func ageLabel(_ date: Date) -> String {
        guard date > .distantPast else { return "Date unknown" }
        return date.formatted(.relative(presentation: .named))
    }

    /// The web's `typeLabel`: the extension, or the kind.
    static func typeLabel(_ item: NativeLibraryItem) -> String {
        let ext = (item.fileName as NSString).pathExtension.trimmingCharacters(in: .whitespaces)
        if !ext.isEmpty, ext.count <= 8 { return ext.uppercased() }
        return item.isImage ? "Image" : "File"
    }

    /// The web's `kindLabel`: what KIND of file, in a word.
    static func kindLabel(_ item: NativeLibraryItem) -> String {
        if item.isImage { return "Image" }
        let ext = (item.fileName as NSString).pathExtension.lowercased()
        let code: Set<String> = [
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc",
            "cpp", "hpp", "cs", "php", "sh", "sql", "html", "css", "scss", "vue", "svelte", "lua", "r", "scala",
        ]
        if code.contains(ext) { return "Code" }
        let kinds: [String: String] = [
            "pdf": "PDF", "doc": "Document", "docx": "Document", "rtf": "Document", "odt": "Document",
            "pages": "Document", "txt": "Text", "md": "Text", "markdown": "Text", "xls": "Spreadsheet",
            "xlsx": "Spreadsheet", "csv": "Spreadsheet", "tsv": "Spreadsheet", "numbers": "Spreadsheet",
            "ppt": "Presentation", "pptx": "Presentation", "key": "Presentation", "json": "Data", "xml": "Data",
            "yaml": "Data", "yml": "Data", "mov": "Video", "mp4": "Video", "webm": "Video", "mp3": "Audio",
            "wav": "Audio", "m4a": "Audio", "zip": "Archive",
        ]
        return kinds[ext] ?? "File"
    }

    static func accessibilityLabel(for item: NativeLibraryItem) -> String {
        "\(item.fileName), \(kindLabel(item)), \(sizeLabel(item.size)), added \(ageLabel(item.createdAt))"
    }
}

// MARK: - Pieces

/// The list's column heads: Name · Type · Size · Added, in the caption ink.
/// Which of the list's columns the page's width holds: Type from 768,
/// Size and Added from 640 (the web's `@[48rem]` and `@[40rem]`).
struct DesktopLibraryColumns {
    let showsType: Bool
    let showsSize: Bool

    init(width: CGFloat) {
        showsType = width >= 768
        showsSize = width >= 640
    }
}

/// Reads the enclosing page's column, for a layout that follows the page's
/// width rather than the window's.
struct DesktopPageLayoutReader<Content: View>: View {
    @Environment(\.junoPageLayout) private var layout
    @ViewBuilder let content: (JunoPageLayout?) -> Content

    var body: some View {
        content(layout)
    }
}

extension Optional where Wrapped == JunoPageLayout {
    /// The page's own width — its column and both gutters — which is what the
    /// web's `@container/page` breakpoints measure.
    var pageWidth: CGFloat {
        guard let layout = self else { return 1_000 }
        return layout.columnWidth + layout.gutter * 2
    }
}

private struct DesktopLibraryListHeader: View {
    /// The web's caption columns (4.5, 5.5 and 6rem), all left-aligned, 12pt
    /// apart: a right-aligned Size against a left-aligned Added read as one run.
    static let typeWidth: CGFloat = 72
    static let sizeWidth: CGFloat = 88
    static let addedWidth: CGFloat = 96

    let columns: DesktopLibraryColumns
    var showsType: Bool { columns.showsType }

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Text("Name")
                .padding(.leading, DesktopLibraryInset.side + JunoSpace.cozy)
                .frame(maxWidth: .infinity, alignment: .leading)
            if showsType {
                Text("Type").frame(width: Self.typeWidth, alignment: .leading)
            }
            Text("Size").frame(width: Self.sizeWidth, alignment: .leading)
            Text("Added").frame(width: Self.addedWidth, alignment: .leading)
            Color.clear.frame(width: 28, height: 1)
        }
        .junoType(.caption)
        .fontWeight(.medium)
        .foregroundStyle(Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityHidden(true)
    }
}

/// The row's 36pt inset: the picture for an image, the kind glyph otherwise.
struct DesktopLibraryInset: View {
    static let side: CGFloat = 36

    let item: NativeLibraryItem
    let state: NativeFilePreviewLoader.State
    /// On a selected row the inset steps to the card, so it keeps its edge
    /// against the row's selection fill.
    var onSelection = false

    var body: some View {
        Group {
            if item.isImage, case .ready(let image) = state {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFill()
            } else {
                JunoIconView(item.isImage ? .image : .file, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .frame(width: Self.side, height: Self.side)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(onSelection ? Color.junoCard : Color.junoSecondary)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// An upload on its way: its name, its state, Retry and Dismiss when it
/// failed. The bar is indeterminate: the transport reports no byte progress.
private struct DesktopLibraryUploadRow: View {
    let upload: NativeLibraryUpload
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(upload.isImage ? .image : .file, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: DesktopLibraryInset.side, height: DesktopLibraryInset.side)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(upload.fileName)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                switch upload.status {
                case .uploading:
                    ProgressView()
                        .progressViewStyle(.linear)
                        .controlSize(.small)
                        .tint(Color.junoForeground.opacity(0.6))
                        .accessibilityLabel("Uploading \(upload.fileName)")
                case .failed(let message, _):
                    Text(message)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoDestructiveInk)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if case .failed(_, let retryable) = upload.status {
                if retryable {
                    Button("Retry", action: retry)
                        .contentShape(.rect)
                        .buttonStyle(.bordered)
                        .tint(nil)
                }
                Button(action: dismiss) {
                    JunoIconView(.dismiss, size: 14)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help("Dismiss")
                .accessibilityLabel("Dismiss \(upload.fileName)")
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
    }
}

/// "Drop to upload": opaque, over the whole page, in the canvas's own ink.
private struct DesktopLibraryDropVeil: View {
    var body: some View {
        ZStack {
            Color.junoCanvas.opacity(0.94)
            VStack(spacing: JunoSpace.cozy) {
                JunoIconView(.upload, size: 24)
                    .foregroundStyle(Color.junoForeground)
                    .frame(width: 48, height: 48)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoSecondary)
                    )
                Text("Drop to upload")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoForeground.opacity(0.35), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .padding(JunoSpace.regular)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Drop to upload")
    }
}

/// Loading, shaped like the list, breathing on the motion tokens.
private struct DesktopLibrarySkeleton: View {
    let presentation: DesktopLibraryScreen.Presentation

    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { index in
                HStack(spacing: JunoSpace.cozy) {
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                        .frame(width: DesktopLibraryInset.side, height: DesktopLibraryInset.side)
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Capsule().fill(Color.junoSecondary).frame(width: 180, height: 10)
                        Capsule().fill(Color.junoSecondary).frame(width: 96, height: 8)
                    }
                    Spacer()
                    Capsule().fill(Color.junoSecondary).frame(width: 64, height: 8)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
                .opacity(index == 0 ? 1 : 1 - Double(index) * 0.1)
            }
        }
        .opacity(dimmed ? 0.55 : 1)
        .animation(
            JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe), when: reduceMotion),
            value: dimmed
        )
        .onAppear { if !reduceMotion { dimmed = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading your files")
    }
}

/// Versions: the current one marked, Restore on the others.
private struct DesktopLibraryVersionsSheet: View {
    let item: NativeLibraryItem
    let model: NativeLibraryPageModel
    let dismiss: () -> Void

    @State private var versions: [NativeLibraryVersion]?
    @State private var failed = false
    @State private var restoring: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Versions")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(item.fileName)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            DesktopLibraryVersionsList(
                versions: versions,
                failed: failed,
                restoring: restoring,
                restore: restore
            )
            Text("Restoring an earlier version keeps the current one.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            HStack {
                Spacer()
                Button("Done", action: dismiss)
                    .contentShape(.rect)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 440)
        .task {
            do {
                versions = try await model.versions(of: item)
            } catch {
                failed = true
            }
        }
    }

    private func restore(_ version: Int) {
        restoring = version
        Task {
            _ = await model.restoreVersion(version, of: item)
            restoring = nil
            dismiss()
        }
    }
}

/// The versions sheet's body, apart so the snapshot harness can draw it.
struct DesktopLibraryVersionsList: View {
    let versions: [NativeLibraryVersion]?
    let failed: Bool
    let restoring: Int?
    let restore: (Int) -> Void

    var body: some View {
        Group {
            if failed {
                JunoEmptyState(
                    title: "Couldn’t load versions",
                    message: "Check your connection and try again.",
                    icon: .triangleAlert,
                    size: .panel,
                    tone: .error
                )
            } else if let versions {
                if versions.filter({ !$0.current }).isEmpty {
                    JunoEmptyState(
                        title: "No earlier versions",
                        message: "When this file is replaced, the earlier version is kept here.",
                        icon: .history,
                        size: .panel
                    )
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                            if index > 0 {
                                Rectangle().fill(Color.junoBorder.opacity(0.7)).frame(height: 1)
                            }
                            row(version)
                        }
                    }
                    .padding(.vertical, JunoSpace.tight)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).fill(Color.junoCard)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                }
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .accessibilityLabel("Loading versions")
            }
        }
    }

    private func row(_ version: NativeLibraryVersion) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Version \(version.version)")
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                Text("\(DesktopLibraryScreen.sizeLabel(version.size)) · \(DesktopLibraryScreen.ageLabel(version.createdAt))")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer()
            if version.current {
                Text("Current")
                    .junoType(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoSecondaryInk)
            } else {
                Button(restoring == version.version ? "Restoring…" : "Restore") { restore(version.version) }
                    .contentShape(.rect)
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .disabled(restoring != nil)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
    }
}

// MARK: - Files in and out

/// A file's name as it leaves by drag, as text a Finder or a note can take.
struct DesktopLibraryDragItem: Transferable {
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.name)
    }
}

private struct DesktopLibraryDownload {
    let document: DesktopLibraryFileDocument
    let name: String
}

struct DesktopLibraryFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }

    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration _: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// Reading files for upload, and fetching a stored file's bytes.
enum DesktopLibraryUploads {
    /// The web's `ACCEPT_ATTRIBUTE` (`src/lib/uploads.ts`): images, PDFs,
    /// office documents, text and data.
    static let acceptedTypes: [UTType] = [
        .image, .pdf, .plainText, .commaSeparatedText, .json, .xml, .rtf, .html,
        UTType(filenameExtension: "md") ?? .plainText,
        UTType(filenameExtension: "docx") ?? .data,
        UTType(filenameExtension: "xlsx") ?? .data,
        UTType(filenameExtension: "pptx") ?? .data,
        .sourceCode, .data,
    ]

    static func read(_ urls: [URL]) -> [(data: Data, fileName: String, mimeType: String)] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension)
            return (data, url.lastPathComponent, type?.preferredMIMEType ?? "application/octet-stream")
        }
    }

    /// The bytes behind a file access: downloaded already, or a signed URL.
    static func bytes(_ access: NativeProjectFileAccess?) async -> Data? {
        switch access {
        case .downloaded(let data): return data
        case .remote(let url):
            return try? await URLSession.shared.data(from: url).0
        case nil: return nil
        }
    }
}

// MARK: - The deal

extension View {
    /// Rows and tiles are dealt once on first load: the rise-in on
    /// `JunoMotion`, 45ms apart, capped at ten. Switching views does not
    /// replay it; under Reduce Motion everything appears in place.
    func junoDealt(index: Int, active: Bool, reduceMotion: Bool) -> some View {
        modifier(DesktopDealtModifier(index: index, active: active, reduceMotion: reduceMotion))
    }
}

private struct DesktopDealtModifier: ViewModifier {
    let index: Int
    let active: Bool
    let reduceMotion: Bool

    @State private var arrived = false

    func body(content: Content) -> some View {
        content
            .opacity(!active || arrived || reduceMotion ? 1 : 0)
            .offset(y: !active || arrived || reduceMotion ? 0 : JunoMotion.riseDistance)
            .onAppear {
                guard active, !reduceMotion else { return }
                withAnimation(JunoMotion.riseIn.delay(Double(min(index, 10)) * 0.045)) {
                    arrived = true
                }
            }
    }
}
