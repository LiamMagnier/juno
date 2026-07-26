import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The Library: every file this account has already shared with Juno.
///
/// **Shaped after the web's `src/app/(app)/library/page.tsx`.** That page opens
/// with an editorial header — "Your files", the one-line explanation, and the
/// library's own totals — then a filter row carrying real per-tab counts, a
/// search field, a list/grid switch, and finally the files themselves as cards
/// with a preview. This screen is the same product on a Mac window's terms: the
/// header and the file surface are the page, and the three controls that are
/// *chrome* rather than content (filter, view switch, search) live in the
/// toolbar, which is where macOS puts them and where they stay reachable when
/// the sidebar is collapsed.
///
/// **Why both a grid and a table, rather than only the table this screen used to
/// be.** The old build was a bare `Table`, and a short `Table` with
/// `alternatesRowBackgrounds` paints the rest of the pane with empty grey
/// stripes — two real files under a dozen phantom ones. Grid is now the default
/// because it is what the website shows and what makes a library of pictures
/// legible; the table survives as the second view because sorting by size or by
/// date is genuinely useful and impossible in a grid. Both are built only when
/// there are rows, so neither can draw a placeholder.
///
/// **Raised, not flat.** The web puts white `--card` surfaces over the warm
/// `--background`; painting file rows straight onto the canvas is what made the
/// window read as one cream field. Every card and the table itself go through
/// `junoCard()`, and the canvas shows around and between them. The screen paints
/// no canvas of its own — the detail column already did that, once.
///
/// **What is deliberately absent.** No open, no Quick Look, no download, no
/// rename and no delete, and image cards show a typed glyph rather than a
/// thumbnail. `NativeLibraryModel` and `NativeLibraryClient` expose the file's
/// name, type, size and date and nothing else: no bytes, no signed URL, no
/// mutation. Every one of those controls would be a control that does nothing,
/// so they are reported as gaps instead of drawn.
struct DesktopLibraryScreen: View {
    @Bindable var model: NativeLibraryModel

    /// How the files are drawn. Mirrors the web's `LibraryView`, including the
    /// fact that the choice is remembered — the website persists it under
    /// `juno-library-view` in local storage, and a Mac window that forgot which
    /// view you left it in would be worse behaved than the browser tab.
    private enum Presentation: String, CaseIterable, Identifiable {
        case grid
        case list

        var id: String { rawValue }
    }

    /// Row selection is local, not `model.selection`. That property is the
    /// composer's library-picker state: whatever is left in it becomes
    /// pre-selected the next time someone attaches from the Library, so merely
    /// browsing this page must not write to it.
    @State private var selection: Set<NativeLibraryItem.ID> = []
    @State private var searchText = ""
    @State private var sortOrder = [
        KeyPathComparator(\NativeLibraryItem.createdAt, order: .reverse)
    ]
    /// The last card clicked without a modifier — the anchor a ⇧-click extends
    /// from, exactly as a Finder icon view behaves.
    @State private var selectionAnchor: NativeLibraryItem.ID?
    @State private var hoveredID: NativeLibraryItem.ID?
    @AppStorage("juno.desktop.library-view") private var storedPresentation = Presentation.grid.rawValue

    /// The web shell's `max-w-6xl`. Without it a maximised window stretches one
    /// file name across two thousand points and the page loses the measure the
    /// website reads at.
    private static let contentWidth: CGFloat = 1152
    /// A grid tile's range. The floor keeps a long name legible on two lines'
    /// worth of width; the ceiling stops four columns from becoming two slabs on
    /// a wide display.
    private static let tileWidth: ClosedRange<CGFloat> = 168...248

    private var presentation: Presentation {
        Presentation(rawValue: storedPresentation) ?? .grid
    }

    private var presentationBinding: Binding<Presentation> {
        Binding(
            get: { presentation },
            set: { storedPresentation = $0.rawValue }
        )
    }

    private var query: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The visible files. Search covers the file name *and* the MIME type, as
    /// the web's does — "png" is how people look for images they cannot name.
    private var rows: [NativeLibraryItem] {
        model.visibleItems
            .filter { item in
                query.isEmpty
                    || item.fileName.localizedCaseInsensitiveContains(query)
                    || item.mimeType.localizedCaseInsensitiveContains(query)
            }
            .sorted(using: sortOrder)
    }

    private var selectedFileNames: [String] {
        rows.filter { selection.contains($0.id) }.map(\.fileName)
    }

    var body: some View {
        // `Color.clear.overlay { … }` rather than the content directly. A detail
        // column reports an ideal size upward and `NavigationSplitView` grows its
        // AppKit split view to satisfy it, so a library of two hundred files
        // would resize the *window* instead of scrolling. `Color.clear` accepts
        // whatever height it is proposed and an overlay is sized by its base, so
        // this page can never influence the window it sits in.
        Color.clear
            .overlay {
                VStack(spacing: 0) {
                    header
                    Divider()
                    content
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { refreshFailure }
            .searchable(text: $searchText, placement: .toolbar, prompt: "Search files")
            .toolbar { libraryToolbar }
            .task { await model.refresh() }
            // A file that scrolls out of the filter, or a reload that removes it,
            // must not leave a selection nobody can see or act on.
            .onChange(of: model.filter) { _, _ in pruneSelection() }
            .onChange(of: searchText) { _, _ in pruneSelection() }
            .onChange(of: model.items) { _, _ in pruneSelection() }
    }

    // MARK: - Header

    /// The web's page header: the editorial heading, the sentence that says what
    /// this page is, and the library's real totals on the trailing side.
    private var header: some View {
        HStack(alignment: .bottom, spacing: JunoSpace.section) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Your files")
                    .junoPageHeading()
                Text("Images and documents shared across your conversations.")
                    .junoRowLabel()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            summary
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.top, JunoSpace.section)
        .padding(.bottom, JunoSpace.roomy)
        .frame(maxWidth: Self.contentWidth)
        .frame(maxWidth: .infinity)
    }

    /// "12 items · 30.4 KB", and what is currently picked out of it. Every number
    /// here is counted from `model.items`, never from a filtered view — the web
    /// header reports the library's size, not the tab's.
    @ViewBuilder
    private var summary: some View {
        if !model.items.isEmpty {
            HStack(spacing: JunoSpace.snug) {
                Text(itemCountLabel)
                separatorDot
                Text(totalSizeLabel)
                if !selection.isEmpty {
                    separatorDot
                    Text("\(selection.count) selected")
                        .foregroundStyle(.primary)
                    Button("Clear") { clearSelection() }
                        .buttonStyle(.link)
                        .accessibilityIdentifier("juno.desktop.library-clear-selection")
                }
            }
            .junoCaption()
            .monospacedDigit()
            .fixedSize()
        }
    }

    private var separatorDot: some View {
        Circle()
            .fill(Color.junoBorder)
            .frame(width: JunoSpace.hairline, height: JunoSpace.hairline)
            .accessibilityHidden(true)
    }

    private var itemCountLabel: String {
        "\(model.items.count) \(model.items.count == 1 ? "item" : "items")"
    }

    private var totalSizeLabel: String {
        Self.sizeLabel(model.items.reduce(0) { $0 + $1.size })
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if rows.isEmpty {
            // Exactly one honest state, and never over placeholder rows: the
            // grid and the table are both swapped *out* here rather than
            // overlaid, because a short `Table` fills the rest of the pane with
            // empty alternating rows of its own accord.
            status
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if presentation == .grid {
            grid
        } else {
            table
        }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(
                columns: [
                    GridItem(
                        .adaptive(
                            minimum: Self.tileWidth.lowerBound,
                            maximum: Self.tileWidth.upperBound
                        ),
                        spacing: JunoSpace.regular,
                        alignment: .topLeading
                    )
                ],
                alignment: .leading,
                spacing: JunoSpace.section
            ) {
                ForEach(rows) { item in
                    card(item)
                }
            }
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: Self.contentWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        // Edit ▸ Copy and ⌘C act on the selection through the platform's own
        // command rather than a private shortcut nobody would guess.
        .copyable(selectedFileNames)
        .accessibilityIdentifier("juno.desktop.library-grid")
    }

    private func card(_ item: NativeLibraryItem) -> some View {
        let isSelected = selection.contains(item.id)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            preview(item, isSelected: isSelected)

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(item.fileName)
                    .junoRowLabel()
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("\(Self.sizeLabel(item.size)) · \(Self.ageLabel(item.createdAt))")
                    .junoCaption()
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .onTapGesture { click(item) }
        .onHover { inside in
            if inside {
                hoveredID = item.id
            } else if hoveredID == item.id {
                hoveredID = nil
            }
        }
        .contextMenu { fileMenu(for: item) }
        .help(item.fileName)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.accessibilityLabel(for: item))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        // A tap gesture is not activatable by VoiceOver on its own; this is what
        // makes the card respond to VO-space as a button would.
        .accessibilityAction { toggle(item) }
    }

    /// The tile the website fills with a thumbnail.
    ///
    /// It carries a typed glyph instead, and that is a limitation rather than a
    /// style: the desktop library client returns no bytes and no signed URL for
    /// an item, so there is nothing to draw. Faking a picture-shaped placeholder
    /// would be worse than saying "PNG" truthfully.
    private func preview(_ item: NativeLibraryItem, isSelected: Bool) -> some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                VStack(spacing: JunoSpace.cozy) {
                    Image(systemName: item.isImage ? "photo" : "doc.text")
                        .font(.system(.largeTitle, design: .default, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(Self.typeLabel(item))
                        .junoMono()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .accessibilityHidden(true)
            }
            .junoCard()
            .overlay {
                // The selection ring is a stroke, never a filled tile: coral is
                // spent on outlines and one primary action here, as on the web,
                // and a saturated fill behind a file name would be unreadable.
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(isSelected ? 1 : 0)
            }
            .overlay(alignment: .topLeading) {
                selectionBadge(item, isSelected: isSelected)
                    .padding(JunoSpace.snug)
                    .opacity(isSelected || hoveredID == item.id ? 1 : 0)
            }
    }

    /// The web's `SelectCheck`: a way to build a selection without knowing that
    /// ⌘-click exists. It appears on hover and stays while the file is selected.
    private func selectionBadge(_ item: NativeLibraryItem, isSelected: Bool) -> some View {
        Button {
            toggle(item)
        } label: {
            Group {
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(Color.junoOnAccent, Color.junoAccent)
                } else {
                    Image(systemName: "circle")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.title2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isSelected ? "Deselect \(item.fileName)" : "Select \(item.fileName)")
    }

    /// The table view. Sortable, resizable, arrow-key navigable and
    /// multi-selectable — the things a Mac window can do with a file list that a
    /// grid cannot — and raised onto a card so it reads as content over the warm
    /// canvas rather than as part of it.
    private var table: some View {
        Table(rows, selection: $selection, sortOrder: $sortOrder) {
            TableColumn("Name", value: \.fileName) { item in
                Label {
                    Text(item.fileName)
                        .junoRowLabel()
                        .lineLimit(1)
                        .truncationMode(.middle)
                } icon: {
                    Image(systemName: item.isImage ? "photo" : "doc.text")
                        .foregroundStyle(Color.junoAccent)
                }
                .help(item.fileName)
            }
            .width(min: 180, ideal: 340)

            // Shows the extension the web shows ("PNG"), sorts on the MIME type
            // behind it. Sorting on the displayed string would scatter
            // `image/jpeg` across JPG and JPEG; sorting on the type groups every
            // image together, which is what someone clicking this header wants.
            TableColumn("Type", value: \.mimeType) { item in
                Text(Self.typeLabel(item))
                    .junoCaption()
                    .lineLimit(1)
                    .help(item.mimeType)
            }
            .width(min: 76, ideal: 96)

            TableColumn("Size", value: \.size) { item in
                Text(Self.sizeLabel(item.size))
                    .junoCaption()
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .width(min: 76, ideal: 100)

            TableColumn("Added", value: \.createdAt) { item in
                Text(Self.ageLabel(item.createdAt))
                    .junoCaption()
                    .monospacedDigit()
                    .lineLimit(1)
                    .help(item.createdAt.formatted(date: .long, time: .shortened))
            }
            .width(min: 110, ideal: 140)
        }
        // Rows carry three columns of numbers and identifiers; alternating
        // backgrounds are what keeps the eye on one file across them.
        .tableStyle(.inset(alternatesRowBackgrounds: true))
        // The table supplies its own row fills, so the card underneath only has
        // to provide the white ground, the hairline and the throw. Without
        // hiding the scroll background the table would paint the window's own
        // fill over the card and the border would float around nothing.
        .scrollContentBackground(.hidden)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        .junoCard()
        .padding(.horizontal, JunoSpace.region)
        .padding(.vertical, JunoSpace.section)
        .frame(maxWidth: Self.contentWidth)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("juno.desktop.library-table")
        .contextMenu(forSelectionType: NativeLibraryItem.ID.self) { ids in
            if ids.isEmpty {
                Button("Refresh", action: refresh)
                    .disabled(model.isLoading)
            } else {
                Button(Self.copyTitle(count: ids.count)) { copyNames(for: ids) }
            }
        }
        .copyable(selectedFileNames)
    }

    /// A card's own menu. It acts on the whole selection when the clicked file is
    /// part of it and on that one file otherwise — the behaviour every Mac list
    /// has, and the reason a right-click never silently loses a selection.
    @ViewBuilder
    private func fileMenu(for item: NativeLibraryItem) -> some View {
        let targets = selection.contains(item.id) ? selection : [item.id]
        Button(Self.copyTitle(count: targets.count)) { copyNames(for: targets) }
        Divider()
        Button("Refresh", action: refresh)
            .disabled(model.isLoading)
    }

    // MARK: - Toolbar

    /// Every item is always present and disables rather than vanishing: a
    /// `ToolbarItem` that comes and goes rebuilds the AppKit toolbar under a live
    /// window, which is what drove this shell's split-view constraint loop.
    @ToolbarContentBuilder
    private var libraryToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            // The web's tab row, with its counts. The numbers come from
            // `model.items` — the whole library — so "Images 5" means five
            // images exist, not five survived the current search.
            Picker("Filter", selection: $model.filter) {
                ForEach(NativeLibraryModel.Filter.allCases) { filter in
                    Text("\(filter.title) \(count(for: filter))").tag(filter)
                }
            }
            .pickerStyle(.segmented)
            // Wide enough for "Images 300" — the route caps a library at 300
            // rows, so no segment can ever grow past three digits.
            .frame(width: 240)
            .help("Show all files, images only, or documents only")
            .accessibilityLabel("Library filter")
            .accessibilityIdentifier("juno.desktop.library-filter")

            Picker("View", selection: presentationBinding) {
                Label("Grid", systemImage: "square.grid.2x2").tag(Presentation.grid)
                Label("List", systemImage: "list.bullet").tag(Presentation.list)
            }
            .pickerStyle(.segmented)
            .labelStyle(.iconOnly)
            .frame(width: 84)
            .help("Show files as a grid of previews or as a sortable list")
            .accessibilityLabel("File view")
            .accessibilityIdentifier("juno.desktop.library-view")

            Button(action: refresh) {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(model.isLoading)
            .help("Reload your library (⌘R)")
            .accessibilityLabel("Refresh library")
            .accessibilityIdentifier("juno.desktop.library-refresh")
        }
    }

    // MARK: - States

    /// The four states this page can honestly be in. Exactly one is drawn, and
    /// the header stays above all of them so the page keeps its identity while
    /// it is loading or empty — as the website's does.
    @ViewBuilder
    private var status: some View {
        if model.isLoading, model.items.isEmpty {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Loading your library")
        } else if model.items.isEmpty, let error = model.lastErrorDescription {
            JunoEmptyState(
                title: "Library unavailable",
                message: error,
                symbol: "exclamationmark.triangle",
                actionLabel: "Try Again",
                action: refresh
            )
        } else if model.items.isEmpty {
            JunoEmptyState(
                title: "Your library is empty",
                message: "Files and images you share with Juno appear here automatically.",
                symbol: "books.vertical",
                actionLabel: "Refresh",
                action: refresh
            )
        } else {
            JunoEmptyState(
                title: "No matching files",
                message: noMatchMessage,
                symbol: "magnifyingglass",
                actionLabel: clearLabel,
                action: clearNarrowing
            )
        }
    }

    /// A failed *reload* while files are still on screen. It floats over the
    /// content as glass because it is transient chrome, and the content insets
    /// under it so the last row is never trapped beneath it. The Retry button
    /// inside is plain — glass laid over glass flattens both.
    @ViewBuilder
    private var refreshFailure: some View {
        if let error = model.lastErrorDescription, !model.items.isEmpty {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    Text(error)
                        .junoCaption()
                        .lineLimit(2)
                    Button("Retry", action: refresh)
                        .buttonStyle(.borderless)
                        .disabled(model.isLoading)
                        .accessibilityIdentifier("juno.desktop.library-retry")
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome()
            }
            .padding(.bottom, JunoSpace.cozy)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Library could not be reloaded")
        }
    }

    private var noMatchMessage: String {
        if query.isEmpty {
            return "Nothing in your library matches the \(model.filter.title) filter."
        }
        return "No file name or type contains “\(query)”."
    }

    private var clearLabel: String {
        query.isEmpty ? "Show All Files" : "Clear Search"
    }

    // MARK: - Actions

    private func count(for filter: NativeLibraryModel.Filter) -> Int {
        switch filter {
        case .all: model.items.count
        case .images: model.items.filter(\.isImage).count
        case .files: model.items.filter { !$0.isImage }.count
        }
    }

    /// A click in the grid, with the modifiers a Finder icon view honours:
    /// plain replaces the selection, ⌘ toggles one file, ⇧ extends from the
    /// anchor. `NSEvent.modifierFlags` is the live keyboard state and is read
    /// while the click is still being handled, so it is the same answer AppKit
    /// would give the gesture itself.
    private func click(_ item: NativeLibraryItem) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            toggle(item)
        } else if flags.contains(.shift), let anchor = selectionAnchor,
            let start = rows.firstIndex(where: { $0.id == anchor }),
            let end = rows.firstIndex(where: { $0.id == item.id })
        {
            let span = start <= end ? start...end : end...start
            selection.formUnion(rows[span].map(\.id))
        } else {
            selection = [item.id]
            selectionAnchor = item.id
        }
    }

    private func toggle(_ item: NativeLibraryItem) {
        if selection.contains(item.id) {
            selection.remove(item.id)
        } else {
            selection.insert(item.id)
        }
        selectionAnchor = item.id
    }

    private func clearSelection() {
        selection = []
        selectionAnchor = nil
    }

    /// Drops anything no longer on screen. A selection the reader cannot see is
    /// a selection ⌘C would copy behind their back.
    private func pruneSelection() {
        guard !selection.isEmpty else { return }
        let visible = Set(rows.map(\.id))
        selection.formIntersection(visible)
        if let anchor = selectionAnchor, !visible.contains(anchor) {
            selectionAnchor = nil
        }
    }

    private func clearNarrowing() {
        searchText = ""
        model.filter = .all
    }

    private func refresh() {
        Task { await model.refresh() }
    }

    private func copyNames(for ids: Set<NativeLibraryItem.ID>) {
        let names = rows.filter { ids.contains($0.id) }.map(\.fileName)
        guard !names.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(names.joined(separator: "\n"), forType: .string)
    }

    // MARK: - Formatting

    private static func copyTitle(count: Int) -> String {
        count == 1 ? "Copy Name" : "Copy \(count) Names"
    }

    private static func sizeLabel(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// The relative age the web shows under each card. `.distantPast` is the
    /// sentinel `NativeLibraryClient` stores when the server's timestamp will not
    /// parse, and rendering it as "2025 years ago" would present a parse failure
    /// as a fact about the file.
    private static func ageLabel(_ date: Date) -> String {
        guard date > .distantPast else { return "Date unknown" }
        return date.formatted(.relative(presentation: .named))
    }

    /// The web's `typeLabel`: the extension when there is a plausible one, and
    /// the kind otherwise.
    private static func typeLabel(_ item: NativeLibraryItem) -> String {
        let ext = (item.fileName as NSString).pathExtension
            .trimmingCharacters(in: .whitespaces)
        if !ext.isEmpty, ext.count <= 8 { return ext.uppercased() }
        return item.isImage ? "Image" : "File"
    }

    private static func accessibilityLabel(for item: NativeLibraryItem) -> String {
        "\(item.fileName), \(typeLabel(item)), \(sizeLabel(item.size)), added \(ageLabel(item.createdAt))"
    }
}
