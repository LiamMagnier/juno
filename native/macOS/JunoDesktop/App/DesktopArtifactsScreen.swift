import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

/// Artifacts — the account's Canvas documents, and the one surface where a person
/// reads and edits what Juno produced.
///
/// The shape is the web's artifacts page (`src/app/(app)/artifacts/page.tsx`)
/// translated into a Mac window rather than transcribed: a library of documents,
/// then the document itself. Six decisions carry that:
///
/// 1. The page is one column deep, not two. It is the *content* of the Chat
///    window's detail column (``DesktopChatWorkspace``), and it shows either the
///    library of artifacts or one open document — never a navigation column of
///    its own, which would be a second source list beside the window's real one.
///    The document carries its own command bar because commands belong to the
///    open document rather than to the app-wide title bar.
/// 2. **The body of an artifact is a page, not a pour.** The web puts a document
///    on a white `--card` over the warm `--background` and clamps its measure;
///    this screen used to render Markdown through `AttributedString` straight
///    onto the canvas at full window width, which came out as one unbroken wall
///    of unstyled text running past the right edge. Prose now goes through
///    `JunoMarkdownText` inside ``JunoDetailPage``, on a ``SwiftUI/View/junoCard()``,
///    and wraps.
/// 3. The library is content, not a second sidebar. This whole screen lives
///    inside the window's *detail* column, so a `.sidebar`-styled list here would
///    read as a second vibrant rail beside the real one. What it is instead is the
///    web's grid: each artifact a live thumbnail of itself on a raised card over
///    the warm canvas, and opening one replaces the grid with the document rather
///    than pushing a column.
/// 4. Editing is not a mode. The latest version's source is always writable and
///    `draft` stays `nil` while clean, which is how the web Canvas behaves. Older
///    versions render as selectable text rather than as a text editor whose edits
///    would be silently discarded.
/// 5. A version the user is only *looking* at cannot be saved over. The one
///    floating control on this page is the read-only badge that says so, and
///    offers the restore that makes the version writable again.
/// 6. **This page owns no `.inspector` and no `.searchable`.** Both are window
///    furniture, and this is content inside a window it does not own. `.inspector`
///    is the sharp one: attached to a `NavigationSplitView`'s detail column — which
///    is exactly what this page is — it makes SwiftUI's `NSHostingView` call
///    `setNeedsUpdateConstraints:` from inside its own `updateConstraints` while
///    the window's constraint pass is already running, AppKit throws from
///    `-[NSWindow _postWindowNeedsUpdateConstraints]` and the process takes
///    SIGTRAP; ``DesktopCodeWorkspace`` carries the bisected report. Version
///    history is therefore a pane inside the open document — see
///    ``artifactDocument`` — and the window's one inspector, mounted on the split
///    view itself in ``DesktopChatWorkspace``, belongs to Tasks. Search is a plain
///    field in this page's own header for the milder version of the same reason: a
///    `.searchable` renders in the *window's* titlebar, where a field that filters
///    this library reads as searching the whole window.
struct DesktopArtifactsScreen: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>

    @State private var searchText = ""
    /// The web's type chips (`TYPE_LABELS`). `nil` is "All".
    @State private var kindFilter: NativeArtifactKind?
    /// `nil` means "follow whatever the artifact's current version is", so a save
    /// or a sync landing a new version does not leave the reader pinned to an old
    /// one.
    @State private var selectedVersion: Int?
    /// `nil` while the editor is clean. The first keystroke stamps it, which is
    /// what makes Save honest about whether there is anything to save.
    @State private var draft: String?
    @State private var mode = DesktopArtifactViewMode.preview
    @State private var showingChanges = false
    /// Whether the version pane is beside the document. Page state, not window
    /// state: it is only meaningful while a document is open, and it opens closed
    /// every time — history is something the reader asks for, not a mode they
    /// return to.
    @State private var historyVisible = false
    @State private var compareBase: Int?
    @State private var diffLines: [DesktopArtifactDiffLine] = []
    @State private var diffComputing = false
    @State private var renaming = false
    @State private var renameValue = ""
    @State private var deleteTarget: String?
    @State private var pendingFile: DesktopArtifactFile?
    @State private var localErrorDescription: String?
    @State private var previewReloadID = UUID()
    /// Bumped to re-open the design editor from stored content.
    ///
    /// ``DesktopDesignSurface`` reads its body once and then treats the editor as
    /// the authority on the document, which is what keeps a save from throwing away
    /// the reader's viewport. The cost is that "Discard Changes" has to say so out
    /// loud: without this the draft would clear, the subtitle would stop saying
    /// "Unsaved changes", and the canvas would carry on drawing the very edit that
    /// was just discarded.
    @State private var designReloadToken = UUID()
    /// Artifacts always enter through their visual library. Opening a card flips
    /// this to the document; Back returns without losing the selected artifact.
    @State private var libraryVisible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // MARK: - Derived state

    private var artifact: NativeArtifact? { model.selectedArtifact }

    private var visibleArtifacts: [NativeArtifact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.artifacts.filter { artifact in
            if let kindFilter, artifact.kind != kindFilter { return false }
            guard !query.isEmpty else { return true }
            return artifact.title.localizedCaseInsensitiveContains(query)
                || artifact.conversationTitle.localizedCaseInsensitiveContains(query)
                || (artifact.language?.localizedCaseInsensitiveContains(query) ?? false)
                || DesktopArtifactKindName.singular(artifact.kind)
                    .localizedCaseInsensitiveContains(query)
        }
    }

    /// Only the kinds the account actually has. A row of six chips over two
    /// artifacts is a menu of dead ends — the same rule the phone applies in
    /// `JunoMobileArtifactsView`, and the web's `presentTypes`.
    private var availableKinds: [NativeArtifactKind] {
        NativeArtifactKind.allCases.filter { kind in
            model.artifacts.contains { $0.kind == kind }
        }
    }

    private var targetVersion: Int? {
        guard let artifact else { return nil }
        return selectedVersion ?? artifact.currentVersion
    }

    private var targetEntry: NativeArtifactVersion? {
        guard let artifact, let targetVersion else { return nil }
        return artifact.versions.first { $0.version == targetVersion }
    }

    private var isLatest: Bool {
        guard let artifact, let targetVersion else { return false }
        return targetVersion == artifact.currentVersion
    }

    /// The draft belongs to the latest version only, so switching to an older one
    /// shows that version rather than the unsaved edit, and switching back
    /// restores the edit.
    private var displayedContent: String {
        let stored = targetEntry?.content ?? ""
        return isLatest ? (draft ?? stored) : stored
    }

    private var isDirty: Bool {
        guard isLatest, let draft, let stored = targetEntry?.content else { return false }
        return draft != stored
    }

    /// The views the open artifact actually has. See ``DesktopArtifactViewMode``.
    ///
    /// `[.source]` while nothing is open, which is the honest floor: source is
    /// the one view every artifact has, and the switcher collapses to a label at
    /// a single option rather than drawing a control with one segment.
    private var availableModes: [DesktopArtifactViewMode] {
        guard let artifact else { return [.source] }
        return DesktopArtifactViewMode.available(for: artifact.kind)
    }

    /// What is on screen, as opposed to what the reader last chose.
    ///
    /// Clamped here rather than by writing `mode` back, because the mismatch
    /// exists for exactly as long as it takes a newly opened artifact of a
    /// different kind to load, and mutating state from inside a body evaluation
    /// to fix a one-frame mismatch is how SwiftUI is made to loop.
    private var resolvedMode: DesktopArtifactViewMode {
        availableModes.contains(mode) ? mode : (availableModes.first ?? .source)
    }

    private var modeSelection: Binding<DesktopArtifactViewMode> {
        Binding(get: { resolvedMode }, set: { mode = $0 })
    }

    private var baseVersion: Int? {
        guard let artifact, let targetVersion else { return nil }
        if let compareBase, compareBase < targetVersion,
            artifact.versions.contains(where: { $0.version == compareBase })
        {
            return compareBase
        }
        return artifact.versions.last { $0.version < targetVersion }?.version
    }

    private var earlierVersions: [NativeArtifactVersion] {
        guard let artifact, let targetVersion else { return [] }
        return Array(artifact.versions.filter { $0.version < targetVersion }.reversed())
    }

    private var addedCount: Int { diffLines.filter { $0.change == .added }.count }
    private var removedCount: Int { diffLines.filter { $0.change == .removed }.count }

    /// Recomputing a 200,000-character diff inside `body` would run on every
    /// keystroke elsewhere in the window, so the request is a value the task
    /// observes: artifact, both endpoints, and the version count (which changes
    /// when `openArtifact` hydrates history the local store did not have).
    private var diffRequest: DesktopArtifactDiffRequest? {
        guard showingChanges, let artifact, let targetVersion, let baseVersion else {
            return nil
        }
        return DesktopArtifactDiffRequest(
            artifactID: artifact.id,
            base: baseVersion,
            target: targetVersion,
            versionCount: artifact.versions.count
        )
    }

    /// The store's phase, in the storage-free vocabulary ``DesktopArtifactStatus``
    /// reasons about.
    private var loadPhase: DesktopArtifactLoadPhase {
        switch model.phase {
        case .idle: .idle
        case .loading: .loading
        case .ready: .ready
        case .offline: .offline
        case .failed: .failed
        }
    }

    // MARK: - Body

    var body: some View {
        Color.clear.overlay {
            if libraryVisible {
                artifactLibrary
            } else {
                artifactDocument
            }
        }
        .overlay(alignment: .bottom) { statusControl }
        .task(id: model.selectedArtifactID) {
            draft = nil
            selectedVersion = nil
            compareBase = nil
            showingChanges = false
            diffLines = []
            localErrorDescription = nil
            // Always Preview, and the kind-dependent fallback this line used to
            // carry now lives in ``resolvedMode``, which clamps to whatever the
            // open artifact offers. Two places deciding the same thing is how a
            // switcher ends up lit on a segment that is not on screen.
            mode = .preview
            guard let id = model.selectedArtifactID else { return }
            await model.openArtifact(id: id)
            // Always Preview, and the kind-dependent fallback this line used to
            // carry now lives in ``resolvedMode``, which clamps to whatever the
            // open artifact offers. Two places deciding the same thing is how a
            // switcher ends up lit on a segment that is not on screen.
            mode = .preview
        }
        .onAppear {
            libraryVisible = true
            historyVisible = false
        }
        .onChange(of: model.selectedArtifactID) { _, selected in
            if selected == nil {
                libraryVisible = true
                historyVisible = false
            }
        }
        // The rename popover anchors inside `documentCommandBar`, which only
        // exists while the document is showing. Going back to the library
        // destroys that anchor — and a `.popover` whose anchor leaves the
        // hierarchy while it is still presented makes SwiftUI re-run
        // `updatePresentations` and call `showRelativeToRect:` against a window
        // that is already being ordered: an uncaught `NSRemoteView` exception and
        // SIGTRAP. `JunoThinkingControl` documents the same failure.
        //
        // Keyed on `libraryVisible` rather than patched into the three places
        // that set it (the Back control, `onAppear`, and a sync clearing the
        // selection), because there is no click to dismiss the popover on two of
        // those paths and a fourth caller would silently reopen the hole.
        .onChange(of: libraryVisible) { _, showingLibrary in
            if showingLibrary { renaming = false }
        }
        .onDisappear { renaming = false }
        .task(id: diffRequest) {
            guard let diffRequest, let artifact else {
                diffLines = []
                diffComputing = false
                return
            }
            diffComputing = true
            let base = content(of: diffRequest.base, in: artifact)
            let target = content(of: diffRequest.target, in: artifact)
            let computed = await Task.detached(priority: .userInitiated) {
                DesktopArtifactDiff.lines(from: base, to: target)
            }.value
            guard model.selectedArtifactID == diffRequest.artifactID else { return }
            diffLines = computed
            diffComputing = false
        }
        .fileExporter(
            isPresented: Binding(
                get: { pendingFile != nil },
                set: { if !$0 { pendingFile = nil } }
            ),
            document: pendingFile?.document,
            // `.data` rather than a per-format type: the file name the server (or
            // the artifact's kind) already decided carries the extension, and a
            // second, guessed content type would fight it.
            contentType: .data,
            defaultFilename: pendingFile?.name
        ) { result in
            if case .failure(let error) = result {
                localErrorDescription = error.localizedDescription
            }
            pendingFile = nil
        }
        .confirmationDialog(
            "Delete this artifact?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            presenting: deleteTarget
        ) { id in
            Button("Delete", role: .destructive) {
                Task { await model.deleteArtifact(id: id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Every version of this artifact is removed. This cannot be undone.")
        }
    }

    /// The open document, and — when the clock control asks for it — its history
    /// beside it.
    ///
    /// History is a pane *in the page*, not a `.inspector`. This view is the
    /// content of a `NavigationSplitView`'s detail column, and an inspector
    /// attached from there takes the process down; see the note at the head of
    /// this file. The window's own inspector, which does not crash, is not an
    /// option either: the version list reads and writes this screen's editing
    /// state — the version being displayed, the compare base, whether the diff is
    /// showing — and lifting all of that out of the document and into the window
    /// shell to place a column would move the artifact editor's state machine out
    /// of the artifact editor.
    ///
    /// A fixed width rather than the inspector's full range: with no split view to
    /// drag against there is no divider, so the pane takes the width an inspector
    /// column would have opened at. `historyVisible` is only ever set while a
    /// document is open — the Back control, `onAppear` and a cleared selection all
    /// return it to `false` — so the library never has to allow for it.
    private var artifactDocument: some View {
        VStack(spacing: 0) {
            documentCommandBar
            Divider()
            HStack(spacing: 0) {
                Color.clear.overlay { canvas }
                if historyVisible {
                    Divider()
                    versionInspector
                        .frame(width: JunoInspectorMetrics.ideal)
                }
            }
        }
        .accessibilityIdentifier("juno.artifact-document")
    }

    // MARK: - Artifact library

    private var artifactLibrary: some View {
        VStack(spacing: 0) {
            artifactLibraryHeader
            Divider()
            artifactLibraryContent
        }
    }

    private var artifactLibraryHeader: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .bottom, spacing: JunoSpace.section) {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    Text("Artifacts")
                        .junoPageHeading()
                    Text("Pages, diagrams, code and documents Juno built with you.")
                        .junoRowLabel()
                        .junoSecondaryInk()
                }

                Spacer(minLength: JunoSpace.roomy)

                if !model.artifacts.isEmpty {
                    Text(
                        model.artifacts.count == 1
                            ? "1 artifact" : "\(model.artifacts.count) artifacts"
                    )
                    .junoCaption()
                    .monospacedDigit()
                    .accessibilityIdentifier("juno.artifact-count")
                }
            }

            HStack(spacing: JunoSpace.cozy) {
                HStack(spacing: JunoSpace.tight) {
                    Image(systemName: "magnifyingglass")
                        .junoSecondaryInk()
                        .accessibilityHidden(true)
                    TextField("Search artifacts", text: $searchText)
                        .textFieldStyle(.plain)
                        .accessibilityIdentifier("juno.artifact-search")
                    if !searchText.isEmpty {
                        Button {
                            searchText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .junoMetaInk()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear artifact search")
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 32)
                .background(
                    // Pure #FFFFFF in light aqua, exactly as the Projects search
                    // field was. Both fields are the same control doing the same
                    // job, so both now stand on the card token rather than on a
                    // white the rest of the palette does not contain.
                    RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                        .fill(Color.junoSurface)
                )
                .frame(maxWidth: 420)

                Menu {
                    Button("All kinds") { kindFilter = nil }
                    if !availableKinds.isEmpty {
                        Divider()
                        ForEach(availableKinds, id: \.self) { kind in
                            Button {
                                kindFilter = kind
                            } label: {
                                Label(
                                    DesktopArtifactKindName.plural(kind),
                                    systemImage: DesktopArtifactKindName.symbol(kind)
                                )
                            }
                        }
                    }
                } label: {
                    Label(
                        kindFilter.map(DesktopArtifactKindName.plural) ?? "All kinds",
                        systemImage: "line.3.horizontal.decrease"
                    )
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityIdentifier("juno.artifact-kind-filter")

                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.top, JunoSpace.section)
        .padding(.bottom, JunoSpace.roomy)
        .frame(maxWidth: 1152)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var artifactLibraryContent: some View {
        if visibleArtifacts.isEmpty {
            if model.artifacts.isEmpty {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                JunoEmptyState(
                    title: "No artifacts match",
                    message: "Juno searched titles, types, languages and conversations.",
                    icon: .search,
                    actionLabel: "Clear Filters",
                    action: {
                        searchText = ""
                        kindFilter = nil
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            artifactGrid
        }
    }

    private var artifactGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: [
                    GridItem(
                        .adaptive(minimum: 210, maximum: 300),
                        spacing: JunoSpace.regular,
                        alignment: .topLeading
                    )
                ],
                alignment: .leading,
                spacing: JunoSpace.section
            ) {
                ForEach(visibleArtifacts) { artifact in
                    artifactCard(artifact)
                }
            }
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: 1152)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("juno.artifact-library-grid")
    }

    private func artifactCard(_ artifact: NativeArtifact) -> some View {
        Button {
            model.selectedArtifactID = artifact.id
            libraryVisible = false
        } label: {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                artifactCardPreview(artifact)

                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(rowMeta(artifact))
                        .junoCaption()
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Copy Source") { copySource(of: artifact) }
                .disabled(artifact.currentContent == nil)
            Button("Open in New Window") { openInWindow(artifact) }
                .disabled(artifact.currentContent == nil)
            Divider()
            Button("Delete…", role: .destructive) { deleteTarget = artifact.id }
                .disabled(model.isMutating)
        }
        .help(artifact.conversationTitle)
        .accessibilityIdentifier("juno.artifact-card.\(artifact.id)")
    }

    /// A card's thumbnail: the artifact as itself, inert.
    ///
    /// A design gets its mark instead of its body. Drawing one would mean a whole
    /// bundled editor per card — a `WKWebView` and a JavaScript boot for every
    /// design in a grid that exists to be scrolled — and the alternative the grid
    /// used to take is worse than nothing: `NativeArtifactPreview` has no design
    /// renderer, so a design card was a postage stamp of `DesignDocument` JSON,
    /// which tells a reader less about which design it is than the word "Design"
    /// does. The card is a way in; the editor is behind it.
    @ViewBuilder
    private func artifactCardPreview(_ artifact: NativeArtifact) -> some View {
        Color.clear
            .aspectRatio(4 / 3, contentMode: .fit)
            .overlay {
                if let content = artifact.currentContent, !artifact.kind.isDesignDocument {
                    /* INSET, so a rendered document reads as a document.
                     *
                     * A page artifact is usually a white HTML page, and it SHOULD
                     * stay white — this thumbnail is the artifact as itself, and
                     * re-tinting it to match the app would misreport what the
                     * artifact looks like. But drawn edge to edge it stops being a
                     * preview and becomes the tile: beside a Design card on the
                     * warm plate it read as a colder tile in light mode, and on the
                     * dark canvas it was a pure-white slab, the most conspicuous
                     * thing on the screen.
                     *
                     * The inset lets the card's own surface frame it, which is what
                     * every document thumbnail does — the page keeps its colour and
                     * the grid keeps its rhythm. */
                    NativeArtifactPreview(
                        kind: artifact.kind,
                        content: content,
                        mode: artifact.kind.supportsRenderedPreview ? .preview : .source,
                        policy: .thumbnail
                    )
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
                    .padding(JunoSpace.snug)
                } else {
                    VStack(spacing: JunoSpace.cozy) {
                        Image(systemName: DesktopArtifactKindName.symbol(artifact.kind))
                            .font(.system(.largeTitle, weight: .light))
                        Text(DesktopArtifactKindName.singular(artifact.kind))
                            .junoMono()
                    }
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                }
            }
            .clipShape(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
            )
            .junoCard()
    }

    private var subtitle: String {
        guard let artifact, let targetVersion else { return "" }
        var parts = [DesktopArtifactKindName.singular(artifact.kind)]
        if let language = artifact.language, !language.isEmpty {
            parts.append(language.capitalized)
        }
        parts.append("v\(targetVersion)")
        if isDirty { parts.append("Unsaved changes") }
        return parts.joined(separator: " · ")
    }

    /// A failure, as floating glass over the column rather than a caption welded
    /// to its bottom edge.
    ///
    /// Two things were wrong with the old footer. It printed the server's own
    /// wording verbatim — an artifact whose fetch 404s put the bare words "Not
    /// found" under the list, which tells a reader nothing about what was not
    /// found or what to do — and it offered no way out, so the only recovery was
    /// to quit the app. ``DesktopArtifactStatus`` now turns the raw string into a
    /// sentence, and anything retryable carries the retry.
    @ViewBuilder
    private var statusControl: some View {
        if let status = DesktopArtifactStatus(
            localError: localErrorDescription,
            phase: loadPhase,
            serverError: model.lastErrorDescription
        ) {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Image(systemName: status.symbol)
                        .foregroundStyle(status.tint)
                        .accessibilityHidden(true)
                    Text(status.message)
                        .junoCaption()
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 520, alignment: .leading)
                        .textSelection(.enabled)
                    if localErrorDescription != nil {
                        Button("Dismiss") {
                            localErrorDescription = nil
                        }
                        .controlSize(.small)
                    } else if status.isRetryable {
                        Button("Try Again") {
                            localErrorDescription = nil
                            Task { await model.reload() }
                        }
                        .controlSize(.small)
                        .disabled(model.phase == .loading)
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome(cornerRadius: JunoRadius.well)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.bottom, JunoSpace.roomy)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.artifact-status")
        }
    }

    /// The web's mono meta line: what the artifact is, which version, when it
    /// last moved, and the conversation it came out of.
    ///
    /// The provenance is the part that was missing. The web prints `in
    /// "conversation title"` on every row, and it is the only thing that tells
    /// two artifacts called "index.html" apart — without it the list is a column
    /// of near-identical rows and the reader has to open each one to find the
    /// one they meant. `updatedAt` also now says *what* the date is, because a
    /// bare "3 days ago" beside a version number reads as the version's age.
    private func rowMeta(_ artifact: NativeArtifact) -> String {
        var parts = [DesktopArtifactKindName.singular(artifact.kind)]
        if artifact.currentVersion > 1 { parts.append("v\(artifact.currentVersion)") }
        parts.append(
            "Updated \(artifact.updatedAt.formatted(.relative(presentation: .named)))"
        )
        let conversation = artifact.conversationTitle.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if !conversation.isEmpty {
            parts.append("in \(conversation)")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Reading canvas

    @ViewBuilder
    private var canvas: some View {
        if let artifact, let targetVersion {
            content(for: artifact, version: targetVersion)
                .animation(
                    JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                    value: showingChanges
                )
                .overlay(alignment: .top) { readOnlyBadge(artifact) }
        } else if model.artifacts.isEmpty {
            emptyState
        } else {
            // The destination's own mark. `square.stack.3d.up` is SF's idea of a
            // stack; the website's artifact glyph is Lucide's `Layers3`, and it
            // is already in the asset catalog as the sidebar row this page sits
            // behind — so drawing a different stack here named a different thing.
            JunoEmptyState(
                title: "No artifact selected",
                message: "Choose an artifact to read, edit or export it.",
                icon: .artifacts
            )
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading artifacts")
        case .failed, .offline:
            JunoEmptyState(
                title: "Artifacts unavailable",
                message: model.lastErrorDescription
                    ?? "Check your connection and try again.",
                symbol: "exclamationmark.triangle",
                actionLabel: "Try Again",
                action: { Task { await model.reload() } }
            )
        case .ready:
            JunoEmptyState(
                title: "No artifacts yet",
                message: "When Juno builds a page, a component or a diagram in a chat, it is kept here — every version of it.",
                icon: .artifacts
            )
        }
    }

    @ViewBuilder
    private func content(for artifact: NativeArtifact, version: Int) -> some View {
        if targetEntry == nil {
            JunoEmptyState(
                title: "Version unavailable",
                message: "Reconnect to load this version's content.",
                symbol: "clock.arrow.circlepath",
                actionLabel: "Try Again",
                action: { Task { await model.openArtifact(id: artifact.id) } }
            )
        } else if showingChanges {
            DesktopArtifactDiffCanvas(
                lines: diffLines,
                computing: diffComputing,
                baseVersion: baseVersion,
                targetVersion: version
            )
        } else if artifact.kind.isDesignDocument {
            // Ahead of `mode`, because a design has no Preview/Source pair to
            // choose between — the same call the chat canvas makes, and the same
            // call the phone makes in `JunoMobileArtifactBody`. Behind
            // `showingChanges`, because ⇧⌘D is an explicit request to compare two
            // versions and a design document diffs as text like any other body.
            designSurface(artifact)
        } else if resolvedMode == .canvas {
            liveCanvas(artifact, version: version)
        } else if resolvedMode == .preview, artifact.kind == .markdown {
            // Markdown is prose, and prose is the whole reason this page was
            // unreadable: `NativeArtifactPreview` renders it through
            // `AttributedString(markdown:)`, which flattens headings, lists,
            // tables and fences into one run of body text and then pours it
            // across the full width of the window. `JunoMarkdownText` is the
            // renderer the transcript already uses, and the page clamps the
            // measure.
            documentPage(artifact, version: version) {
                JunoMarkdownText(displayedContent)
            }
            .accessibilityIdentifier("juno.artifact-preview")
        } else if resolvedMode == .preview, artifact.kind.supportsRenderedPreview {
            renderedPreview(artifact)
        } else if isLatest {
            sourceEditor(artifact, version: version)
        } else {
            // Wraps rather than scrolling sideways. The old canvas gave this a
            // horizontal scroll axis and no measure, so a long line simply left
            // the window — the reader had to drag to find out a sentence had
            // ended.
            documentPage(artifact, version: version) {
                Text(displayedContent)
                    .junoMono()
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Artifact source, version \(version)")
            }
        }
    }

    /// The artifact as a page: the document's own header, then its body, on a
    /// white ``SwiftUI/View/junoCard()`` clamped to a measure and centred on the
    /// warm canvas — the web's `--card` over `--background`.
    ///
    /// ``JunoDetailPage`` supplies the scroll and the clamp, so a hundred-page
    /// artifact scrolls instead of growing the window's split view.
    private func documentPage<Body: View>(
        _ artifact: NativeArtifact,
        version: Int,
        @ViewBuilder body: () -> Body
    ) -> some View {
        JunoDetailPage {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                documentHeader(artifact, version: version)
                body()
            }
            .padding(JunoSpace.section)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoCard()
        }
    }

    /// A document states what it is at the top of itself, the way the web's
    /// canvas header does. The window's title bar carries the same title, but a
    /// page that is scrolled, exported or opened in its own window keeps this.
    private func documentHeader(_ artifact: NativeArtifact, version: Int) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                .junoPageHeading(compact: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(provenance(artifact, version: version))
                .junoCodeSmall()
                .junoSecondaryInk()
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
        }
    }

    /// The stamp is the *displayed version's* own, not the artifact's: a header
    /// over v2 that said "Updated 3 minutes ago" because v5 had just been saved
    /// would be describing a document the reader is not looking at.
    private func provenance(_ artifact: NativeArtifact, version: Int) -> String {
        var parts = [DesktopArtifactKindName.singular(artifact.kind)]
        if let language = artifact.language, !language.isEmpty {
            parts.append(language.capitalized)
        }
        parts.append("v\(version)")
        if let entry = artifact.versions.first(where: { $0.version == version }) {
            let stamp = entry.createdAt.formatted(.relative(presentation: .named))
            if let origin = entry.origin {
                parts.append("\(DesktopArtifactKindName.origin(origin)) \(stamp)")
            } else {
                parts.append(stamp)
            }
        }
        if !artifact.conversationTitle.isEmpty {
            parts.append("in \(artifact.conversationTitle)")
        }
        return parts.joined(separator: " · ")
    }

    /// A rendered page or graphic keeps the full pane rather than a prose
    /// measure: clamping a laid-out HTML document to 720pt would re-flow the very
    /// thing the reader asked to see. It still sits on a page — clipped, with the
    /// card's hairline and throw — instead of running to the window's edges.
    ///
    /// No `ScrollView` around it: the web view scrolls itself, and nesting the
    /// two gives the page two scrollers that fight over the wheel.
    private func renderedPreview(_ artifact: NativeArtifact) -> some View {
        NativeArtifactPreview(
            kind: artifact.kind,
            content: displayedContent,
            mode: .preview
        )
        .id(previewReloadID)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("juno.artifact-preview")
    }

    /// The live canvas: the source beside the running document, with everything
    /// the page logged and everything the sandbox refused to load.
    ///
    /// **Why the library gets this and not only the chat dock.** A page artifact
    /// that renders blank does so for a reason the page itself states — a CDN
    /// script the sandbox blocked, an uncaught `TypeError` on line 12 — and until
    /// now none of those reasons reached the Mac at all. The Preview showed a
    /// white rectangle and the Source showed code that looks correct. The
    /// artifacts library is where someone goes to work out what is wrong with an
    /// artifact they kept, so it is the surface that most needs the console.
    ///
    /// `.sideBySide` here and `.tabbed` in the docked chat column: this pane is a
    /// window's whole detail column, which is the width the split was designed
    /// for.
    ///
    /// The identity deliberately includes `previewReloadID`, so the toolbar's
    /// Reload reloads this the way it reloads the plain preview, and the *version*
    /// rather than the artifact, because looking at v3 after v4 is a different
    /// document and its console must not inherit v4's errors.
    private func liveCanvas(_ artifact: NativeArtifact, version: Int) -> some View {
        DesktopArtifactLiveCanvas(
            kind: artifact.kind,
            content: displayedContent,
            layout: .sideBySide
        )
        .id("\(artifact.id)#v\(version)#\(previewReloadID)")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("juno.artifact-canvas")
    }

    /// A stored design, in the design editor — the same ``DesktopDesignSurface``
    /// the chat canvas opens, because a design opened from the library is the same
    /// document as one opened from the conversation it came out of.
    ///
    /// Before this, the library was the only surface on the Mac that did not know
    /// what a design was: `renderedPreview` was skipped (`supportsRenderedPreview`
    /// is false for `.design`), the version was the latest, and so the reader got
    /// `sourceEditor` — a `TextEditor` full of `DesignDocument` JSON. That is what
    /// "the library shows raw JSON" was.
    ///
    /// **Editable here, unlike the chat canvas, and that difference is the point.**
    /// The library has a stored row behind the document, so an edit has somewhere
    /// to go: each accepted transaction is re-encoded into `draft`, which lights
    /// the Save button, puts "Unsaved changes" in the subtitle, and commits through
    /// exactly the same `saveArtifact` path every other kind uses — no second write
    /// path, and no version manufactured per drag. The chat canvas has no row and
    /// therefore opens read-only rather than accepting edits it would have to drop.
    /// Older versions are read-only for the reason the whole page is: a version the
    /// reader is only looking at cannot be saved over, and Restore is the way back.
    ///
    /// The identity deliberately keys on `selectedVersion` rather than on the
    /// resolved version number. Saving leaves `selectedVersion` at `nil` while
    /// bumping `artifact.currentVersion`, so keying on the number would reload the
    /// bundle after every ⌘S and throw away the reader's pan, zoom and selection.
    /// Choosing a version from history *does* move `selectedVersion`, which is
    /// exactly when a reload is what was asked for.
    private func designSurface(_ artifact: NativeArtifact) -> some View {
        DesktopDesignSurface(
            content: displayedContent,
            readOnly: !isLatest,
            onEdit: isLatest ? { draft = $0 } : nil
        )
        .id("\(artifact.id)#\(selectedVersion.map(String.init) ?? "latest")#\(designReloadToken)")
    }

    /// The editor is deliberately not inside ``JunoDetailPage``: a `TextEditor`
    /// scrolls itself. It still reads as the same page — same header, same card,
    /// same margin — so switching Preview to Source does not change what kind of
    /// surface the document is sitting on.
    private func sourceEditor(_ artifact: NativeArtifact, version: Int) -> some View {
        TextEditor(text: editorText)
            .junoMono()
            .scrollContentBackground(.hidden)
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // `NSColor.textBackgroundColor` is pure #FFFFFF in light aqua. This
            // is the largest single surface on the page and the one a reader
            // stares at, so a cold white here is the version of the defect that
            // shows most. The card token keeps the same one-step lift off the
            // canvas without leaving the palette.
            .background(Color.junoSurface)
            .accessibilityLabel(
                "Artifact source for \(artifact.title), version \(version)"
            )
            .accessibilityIdentifier("juno.artifact-editor")
    }

    private var editorText: Binding<String> {
        Binding(
            get: { displayedContent },
            set: { value in
                guard isLatest else { return }
                draft = value
            }
        )
    }

    /// The only floating element on this page, and the one thing glass is for
    /// here: a transient status control that explains why the editor is not
    /// writable, with the action that makes it writable.
    @ViewBuilder
    private func readOnlyBadge(_ artifact: NativeArtifact) -> some View {
        if let targetVersion, !isLatest, !showingChanges {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    Text("Viewing v\(targetVersion) · read-only")
                        .junoCaption()
                        .foregroundStyle(.primary)
                    Button {
                        Task { await restore(artifact, version: targetVersion) }
                    } label: {
                        Text("Restore")
                            .foregroundStyle(Color.junoAccent)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isMutating)
                    .help("Save this version's content as a new version")
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome()
            }
            .padding(.top, JunoSpace.cozy)
            .accessibilityIdentifier("juno.artifact-read-only")
        }
    }

    // MARK: - Version history pane

    /// Every version of the open artifact, and the controls that compare and
    /// restore them. Mounted beside the canvas by ``artifactDocument`` — an
    /// `.inspector` from here is the crash that note describes.
    @ViewBuilder
    private var versionInspector: some View {
        if let artifact, let targetVersion {
            List(selection: versionSelection) {
                Section("Versions") {
                    ForEach(artifact.versions.reversed()) { version in
                        versionRow(version, current: artifact.currentVersion)
                    }
                }
            }
            // Same selection colour as the index, for the same reason: the
            // platform resolves a focused list selection to the app's accent, and
            // Juno's accent is coral.
            .junoSidebarSelectionTint()
            .accessibilityIdentifier("juno.artifact-versions")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                inspectorFooter(artifact, targetVersion: targetVersion)
            }
        } else {
            JunoEmptyState(
                title: "No version history",
                message: "Select an artifact to see how it changed.",
                symbol: "clock.arrow.circlepath"
            )
        }
    }

    private var versionSelection: Binding<Int?> {
        Binding(
            get: { targetVersion },
            set: { value in
                guard let value else { return }
                selectedVersion = value
                compareBase = nil
            }
        )
    }

    private func versionRow(_ version: NativeArtifactVersion, current: Int) -> some View {
        versionRowContent(version, current: current)
            .junoSidebarRowInk()
            .tag(version.version)
            .contextMenu {
                Button("Compare From This Version") { compareBase = version.version }
                    .disabled(targetVersion.map { version.version >= $0 } ?? true)
            }
    }

    private func versionRowContent(
        _ version: NativeArtifactVersion,
        current: Int
    ) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: JunoSpace.tight) {
                Text("v\(version.version)")
                    .junoCode()
                if version.version == current {
                    Text("current")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                }
            }
            Text(versionCaption(version))
                .junoCaption()
                .lineLimit(1)
        }
    }

    /// Origin is only known once `openArtifact` has run — the local projection
    /// stores version content without it — so it is stated when present rather
    /// than defaulted to "Generated".
    private func versionCaption(_ version: NativeArtifactVersion) -> String {
        let stamp = version.createdAt.formatted(.relative(presentation: .named))
        guard let origin = version.origin else { return stamp }
        return "\(DesktopArtifactKindName.origin(origin)) · \(stamp)"
    }

    @ViewBuilder
    private func inspectorFooter(_ artifact: NativeArtifact, targetVersion: Int) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Divider()

            Picker("Compare with", selection: compareBaseSelection) {
                ForEach(earlierVersions) { version in
                    Text("v\(version.version)").tag(version.version as Int?)
                }
            }
            .pickerStyle(.menu)
            .disabled(earlierVersions.isEmpty)
            .accessibilityIdentifier("juno.artifact-compare-base")

            if showingChanges, let baseVersion {
                HStack(spacing: JunoSpace.snug) {
                    Text("v\(baseVersion) → v\(targetVersion)")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                    Text("+\(addedCount)")
                        .junoCodeSmall()
                        .foregroundStyle(Color.junoSuccess)
                    Text("−\(removedCount)")
                        .junoCodeSmall()
                        .foregroundStyle(Color.junoDanger)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(addedCount) lines added, \(removedCount) lines removed between version \(baseVersion) and version \(targetVersion)"
                )
            }

            Button("Restore This Version") {
                Task { await restore(artifact, version: targetVersion) }
            }
            .disabled(isLatest || model.isMutating)
            .help("Save this version's content as a new version")
            .accessibilityIdentifier("juno.artifact-restore")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.cozy)
    }

    private var compareBaseSelection: Binding<Int?> {
        Binding(
            get: { baseVersion },
            set: { compareBase = $0 }
        )
    }

    // MARK: - Document commands

    /// Commands belong to the open document, not to the app-wide title bar. The
    /// stable strip also leaves the main toolbar quiet when the artifact index is
    /// narrow or the window is resized.
    private var documentCommandBar: some View {
        HStack(spacing: JunoSpace.snug) {
            Button {
                historyVisible = false
                libraryVisible = true
            } label: {
                Label("All artifacts", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .help("Back to artifacts")
            .accessibilityLabel("All artifacts")
            .accessibilityIdentifier("juno.artifact-library")

            Divider()
                .frame(height: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(
                    artifact?.title.isEmpty == false
                        ? artifact?.title ?? "" : "Artifact"
                )
                .font(.headline)
                .lineLimit(1)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }
            }

            Spacer(minLength: JunoSpace.cozy)

            viewSwitch

            Toggle(isOn: $showingChanges) {
                Label("Changes", systemImage: "plus.forwardslash.minus")
            }
            .toggleStyle(.button)
            .labelStyle(.iconOnly)
            .disabled((artifact?.versions.count ?? 0) < 2 || baseVersion == nil)
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .help("Compare this version with an earlier one (⇧⌘D)")
            .accessibilityLabel("Show changes")
            .accessibilityIdentifier("juno.artifact-changes")

            Button {
                copyDisplayed()
            } label: {
                Label(showingChanges ? "Copy Changes" : "Copy Source", systemImage: "doc.on.doc")
            }
            .labelStyle(.iconOnly)
            .disabled(targetEntry == nil)
            .keyboardShortcut("c", modifiers: [.command, .shift])
            .help(
                showingChanges
                    ? "Copy this comparison as a unified diff (⇧⌘C)"
                    : "Copy the artifact source (⇧⌘C)"
            )
            .accessibilityLabel(showingChanges ? "Copy changes" : "Copy source")
            .accessibilityIdentifier("juno.artifact-copy")

            Button {
                previewReloadID = UUID()
            } label: {
                Label("Reload preview", systemImage: "arrow.clockwise")
            }
            .labelStyle(.iconOnly)
            // The Canvas is reloadable too, and re-running an artifact is the
            // most useful thing this button does there: `documentWillLoad` clears
            // the console, so a fixed artifact stops carrying the last run's
            // errors. Source is the one view with nothing to reload.
            .disabled(resolvedMode == .source || showingChanges)
            .help("Reload the interactive preview")
            .accessibilityIdentifier("juno.artifact-preview-reload")

            Button("Save") {
                guard let artifact else { return }
                Task { await save(artifact) }
            }
            .disabled(!isDirty || model.isMutating)
            .keyboardShortcut("s", modifiers: .command)
            .help("Save your edit as a new version (⌘S)")
            .accessibilityIdentifier("juno.artifact-save")

            Menu {
                Button("Rename…") {
                    renameValue = artifact?.title ?? ""
                    renaming = true
                }
                .disabled(artifact == nil || model.isMutating)

                Button("Discard Changes") {
                    draft = nil
                    designReloadToken = UUID()
                }
                .disabled(!isDirty)

                Divider()

                Button("Open in New Window") {
                    guard let artifact else { return }
                    openInWindow(artifact)
                }
                .disabled(targetEntry == nil)

                Button("Save Source As…") { exportSource() }
                    .disabled(targetEntry == nil)

                if !model.availableExportFormats.isEmpty {
                    Section("Export") {
                        ForEach(model.availableExportFormats, id: \.rawValue) { format in
                            Button(DesktopArtifactKindName.exportLabel(format)) {
                                Task { await exportOffice(format) }
                            }
                        }
                    }
                }

                Divider()

                Button("Delete…", role: .destructive) {
                    deleteTarget = model.selectedArtifactID
                }
                .disabled(artifact == nil || model.isMutating)
            } label: {
                Label("Artifact actions", systemImage: "ellipsis")
            }
            .labelStyle(.iconOnly)
            .disabled(artifact == nil || model.isExporting)
            .help("Rename, export or delete this artifact")
            .accessibilityLabel("Artifact actions")
            .accessibilityIdentifier("juno.artifact-actions")
            .popover(isPresented: $renaming, arrowEdge: .bottom) {
                renameForm
            }

            Button {
                historyVisible.toggle()
            } label: {
                Label("Version history", systemImage: "clock.arrow.circlepath")
            }
            .labelStyle(.iconOnly)
            .disabled(artifact == nil)
            .keyboardShortcut("i", modifiers: [.command, .option])
            .help("Show version history (⌥⌘I)")
            .accessibilityLabel("Version history")
            .accessibilityIdentifier("juno.artifact-history")
        }
        .controlSize(.small)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 52)
        // `windowBackgroundColor` is the system's neutral grey, which put a cold
        // strip across the top of a warm page — the same defect as the pure-white
        // search field below, one step less obvious because grey hides better
        // than white does. The canvas is the ground this bar sits on.
        .background(Color.junoCanvas)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.artifact-command-bar")
    }

    /// The views this artifact has — or, when it has only one, that view's name.
    ///
    /// A design gets a label rather than a dimmed pair, which is the same call the
    /// chat canvas's `viewBar` makes. Leaving the segmented control in place looked
    /// right until it was looked at: `mode` started at `.source` for any kind with
    /// no rendered preview, so a design opened in the editor sat under a switch
    /// whose selected half read "Source" — a control describing a view the reader
    /// was demonstrably not in, greyed out so they could not correct it either.
    /// The same rule now covers Code and Mermaid, which have exactly one view, and
    /// admits the third segment for the kinds that have three.
    ///
    /// The frame widens with the number of segments rather than staying at the
    /// 148pt two segments needed: three words squeezed into that width truncate
    /// to "Prev… Sour… Canv…", which is a switcher nobody can read.
    @ViewBuilder
    private var viewSwitch: some View {
        if artifact?.kind.isDesignDocument == true {
            Text("Design")
                .junoFont(size: 11, relativeTo: .body, weight: .medium)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 148)
                .help("A design opens in the design editor — there is no separate source view to switch to")
                .accessibilityIdentifier("juno.artifact-view-mode")
        } else if availableModes.count > 1 {
            Picker("View", selection: modeSelection) {
                ForEach(availableModes) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: availableModes.count > 2 ? 214 : 148)
            // Comparing two versions replaces the body with a diff, so no view
            // choice applies while it is on screen.
            .disabled(showingChanges)
            .help(viewSwitchHelp)
            .accessibilityIdentifier("juno.artifact-view-mode")
        } else {
            Text(resolvedMode.title)
                .junoFont(size: 11, relativeTo: .body, weight: .medium)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 148)
                .help("This artifact kind has no native renderer and nothing to run — its source is shown")
                .accessibilityIdentifier("juno.artifact-view-mode")
        }
    }

    private var viewSwitchHelp: String {
        availableModes.contains(.canvas)
            ? "Switch between the rendered artifact, its source, and the live canvas with its console"
            : "Switch between the rendered artifact and its source"
    }

    /// An explicit frame, deliberately: a self-sizing popover over a split view is
    /// what drove the constraint loop this window used to crash in.
    private var renameForm: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Rename artifact")
                .junoTitle()
            TextField("Title", text: $renameValue)
                .textFieldStyle(.roundedBorder)
                .onSubmit { commitRename() }
                .accessibilityIdentifier("juno.artifact-rename-field")
            HStack {
                Spacer()
                Button("Cancel") { renaming = false }
                    .keyboardShortcut(.cancelAction)
                Button("Rename") { commitRename() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        renameValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
        }
        .padding(JunoSpace.regular)
        .frame(width: 340, height: 152)
    }

    // MARK: - Actions

    private func content(of version: Int, in artifact: NativeArtifact) -> String {
        artifact.versions.first { $0.version == version }?.content ?? ""
    }

    /// A stale write is not a failure to hide: the model reloads the newer version
    /// and reports it, so the draft is kept and a second Save — now based on the
    /// version that actually exists — is the recovery.
    private func save(_ artifact: NativeArtifact) async {
        guard let draft else { return }
        localErrorDescription = nil
        await model.saveArtifact(id: artifact.id, content: draft)
        guard model.lastErrorDescription == nil else { return }
        self.draft = nil
        selectedVersion = nil
    }

    private func restore(_ artifact: NativeArtifact, version: Int) async {
        localErrorDescription = nil
        await model.restoreArtifact(id: artifact.id, version: version)
        guard model.lastErrorDescription == nil else { return }
        selectedVersion = nil
        compareBase = nil
    }

    private func commitRename() {
        renaming = false
        guard let artifact else { return }
        let title = renameValue
        Task { await model.renameArtifact(id: artifact.id, title: title) }
    }

    private func copyDisplayed() {
        guard let targetVersion else { return }
        let text: String
        if showingChanges, let baseVersion {
            text = DesktopArtifactDiff.unified(
                diffLines,
                baseLabel: "v\(baseVersion)",
                targetLabel: "v\(targetVersion)"
            )
        } else {
            text = displayedContent
        }
        write(text)
    }

    private func copySource(of artifact: NativeArtifact) {
        guard let content = artifact.currentContent else { return }
        write(content)
    }

    private func write(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func openInWindow(_ artifact: NativeArtifact) {
        let version = artifact.id == model.selectedArtifactID ? targetVersion : artifact.currentVersion
        guard let version,
            let entry = artifact.versions.first(where: { $0.version == version })
        else { return }
        DesktopArtifactWindows.shared.present(
            title: artifact.title,
            subtitle: "\(DesktopArtifactKindName.singular(artifact.kind)) · v\(version)",
            kind: artifact.kind,
            content: entry.content,
            mode: windowMode(for: artifact.kind)
        )
    }

    /// The view a detached window opens on.
    ///
    /// The page's own view when this artifact's kind offers it, and that kind's
    /// first view otherwise. "Open in New Window" is reachable from the library
    /// grid's context menu, where the page's view belongs to a *different*
    /// document — carrying `.canvas` from an open page onto a Code artifact
    /// would open a window on a canvas that has nothing to run.
    private func windowMode(for kind: NativeArtifactKind) -> DesktopArtifactViewMode {
        let modes = DesktopArtifactViewMode.available(for: kind)
        return modes.contains(resolvedMode) ? resolvedMode : (modes.first ?? .source)
    }

    private func exportSource() {
        guard let artifact, let targetVersion, let entry = targetEntry else { return }
        pendingFile = DesktopArtifactFile(
            document: DesktopArtifactDocument(data: Data(entry.content.utf8)),
            name: DesktopArtifactKindName.sourceFileName(
                title: artifact.title,
                kind: artifact.kind,
                language: artifact.language,
                version: targetVersion
            )
        )
    }

    private func exportOffice(_ format: NativeArtifactExportFormat) async {
        guard let artifact else { return }
        localErrorDescription = nil
        guard let exported = await model.exportArtifact(id: artifact.id, format: format)
        else { return }
        pendingFile = DesktopArtifactFile(
            document: DesktopArtifactDocument(data: exported.data),
            name: exported.fileName
        )
    }
}

// MARK: - Metrics

/// The one measurement this page owns that the shared scales do not cover.
private enum DesktopArtifactMetrics {
    /// The index row's leading glyph tile — the web's `size-8`. Not in
    /// `JunoSpace`, because it is the size of a *thing*, not a gap between two.
    static let tile: CGFloat = 32
}

// MARK: - Diff canvas

/// The comparison, on the same raised page as the source it describes.
///
/// Row fills come from `junoDiffAdded`/`junoDiffRemoved` — low-chroma by design,
/// because the whole row is tinted and has to sit *under* monospaced text in both
/// appearances — with a solid bar in the status hue carrying the sign for anyone
/// who cannot rely on the fill alone.
///
/// Only the diff itself is carded. "Comparing…" and "No changes" are states of
/// the page, not documents on it, and a lone empty white panel with a sentence
/// floating in the middle of it reads as a broken view.
private struct DesktopArtifactDiffCanvas: View {
    let lines: [DesktopArtifactDiffLine]
    let computing: Bool
    let baseVersion: Int?
    let targetVersion: Int

    private var hasChanges: Bool {
        lines.contains { $0.change != .context }
    }

    var body: some View {
        if computing {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Comparing versions")
        } else if !hasChanges {
            JunoEmptyState(
                title: "No changes",
                message: baseVersion.map {
                    "v\($0) and v\(targetVersion) have identical content."
                } ?? "These versions have identical content.",
                symbol: "equal"
            )
        } else {
            // A diff keeps its horizontal scroll where prose gets a wrap: column
            // alignment is the thing being read, and soft-wrapping a changed line
            // hides which characters actually moved.
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in
                        row(line)
                    }
                }
                .padding(.vertical, JunoSpace.snug)
            }
            .clipShape(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
            )
            .junoCard()
            .padding(JunoSpace.region)
            .accessibilityLabel(
                baseVersion.map {
                    "Changes from version \($0) to version \(targetVersion)"
                } ?? "Changes in version \(targetVersion)"
            )
            .accessibilityIdentifier("juno.artifact-diff")
        }
    }

    private func row(_ line: DesktopArtifactDiffLine) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Rectangle()
                .fill(barColor(line.change))
                .frame(width: 2)
                .accessibilityHidden(true)
            Text(gutter(line.baseLine))
                .junoCodeSmall()
                .monospacedDigit()
                .junoMetaInk()
                .frame(width: 34, alignment: .trailing)
            Text(gutter(line.targetLine))
                .junoCodeSmall()
                .monospacedDigit()
                .junoMetaInk()
                .frame(width: 34, alignment: .trailing)
            Text(sign(line.change))
                .junoCode()
                .junoSecondaryInk()
                .frame(width: 10, alignment: .leading)
            Text(line.text.isEmpty ? " " : line.text)
                .junoCode()
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.trailing, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fill(line.change))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText(line))
    }

    private func gutter(_ value: Int?) -> String {
        value.map(String.init) ?? " "
    }

    private func sign(_ change: DesktopArtifactDiffLine.Change) -> String {
        switch change {
        case .added: "+"
        case .removed: "−"
        case .context: " "
        }
    }

    private func fill(_ change: DesktopArtifactDiffLine.Change) -> Color {
        switch change {
        case .added: Color.junoDiffAdded
        case .removed: Color.junoDiffRemoved
        case .context: Color.clear
        }
    }

    private func barColor(_ change: DesktopArtifactDiffLine.Change) -> Color {
        switch change {
        case .added: Color.junoSuccess
        case .removed: Color.junoDanger
        case .context: Color.clear
        }
    }

    private func accessibilityText(_ line: DesktopArtifactDiffLine) -> String {
        switch line.change {
        case .added: "Added: \(line.text)"
        case .removed: "Removed: \(line.text)"
        case .context: line.text
        }
    }
}

// MARK: - Diff engine

private struct DesktopArtifactDiffRequest: Equatable, Sendable {
    let artifactID: String
    let base: Int
    let target: Int
    let versionCount: Int
}

private struct DesktopArtifactDiffLine: Identifiable, Sendable {
    enum Change: Sendable, Equatable {
        case context
        case added
        case removed
    }

    let id: Int
    let change: Change
    let text: String
    let baseLine: Int?
    let targetLine: Int?
}

/// A line diff between two stored versions.
///
/// Deliberately the same shape as the web Canvas's `line-diff.ts`, so the same
/// two versions describe the same change on both clients: trim the shared prefix
/// and suffix, then align only the middle. The cap matters — a version may hold
/// 200,000 characters, and past a few thousand changed lines an aligned diff
/// stops being readable at all — so beyond it the middle is reported honestly as
/// one removed block followed by one added block instead of a fabricated
/// alignment.
private enum DesktopArtifactDiff {
    static let middleLineCap = 1500

    static func lines(from base: String, to target: String) -> [DesktopArtifactDiffLine] {
        let baseLines = split(base)
        let targetLines = split(target)

        var out: [DesktopArtifactDiffLine] = []
        func append(
            _ change: DesktopArtifactDiffLine.Change,
            _ text: String,
            base baseLine: Int?,
            target targetLine: Int?
        ) {
            out.append(
                DesktopArtifactDiffLine(
                    id: out.count,
                    change: change,
                    text: text,
                    baseLine: baseLine,
                    targetLine: targetLine
                )
            )
        }

        let shared = min(baseLines.count, targetLines.count)
        var prefix = 0
        while prefix < shared, baseLines[prefix] == targetLines[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < shared - prefix,
            baseLines[baseLines.count - 1 - suffix] == targetLines[targetLines.count - 1 - suffix]
        {
            suffix += 1
        }

        for index in 0..<prefix {
            append(.context, baseLines[index], base: index + 1, target: index + 1)
        }

        let baseMiddle = Array(baseLines[prefix..<(baseLines.count - suffix)])
        let targetMiddle = Array(targetLines[prefix..<(targetLines.count - suffix)])

        if baseMiddle.count > middleLineCap || targetMiddle.count > middleLineCap {
            for (offset, text) in baseMiddle.enumerated() {
                append(.removed, text, base: prefix + offset + 1, target: nil)
            }
            for (offset, text) in targetMiddle.enumerated() {
                append(.added, text, base: nil, target: prefix + offset + 1)
            }
        } else {
            let difference = targetMiddle.difference(from: baseMiddle)
            var removed = Set<Int>()
            var inserted = Set<Int>()
            for change in difference {
                switch change {
                case .remove(let offset, _, _):
                    removed.insert(offset)
                case .insert(let offset, _, _):
                    inserted.insert(offset)
                }
            }

            var baseIndex = 0
            var targetIndex = 0
            while baseIndex < baseMiddle.count || targetIndex < targetMiddle.count {
                if baseIndex < baseMiddle.count, removed.contains(baseIndex) {
                    append(
                        .removed,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: nil
                    )
                    baseIndex += 1
                } else if targetIndex < targetMiddle.count, inserted.contains(targetIndex) {
                    append(
                        .added,
                        targetMiddle[targetIndex],
                        base: nil,
                        target: prefix + targetIndex + 1
                    )
                    targetIndex += 1
                } else if baseIndex < baseMiddle.count, targetIndex < targetMiddle.count {
                    append(
                        .context,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: prefix + targetIndex + 1
                    )
                    baseIndex += 1
                    targetIndex += 1
                } else if baseIndex < baseMiddle.count {
                    append(
                        .removed,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: nil
                    )
                    baseIndex += 1
                } else {
                    append(
                        .added,
                        targetMiddle[targetIndex],
                        base: nil,
                        target: prefix + targetIndex + 1
                    )
                    targetIndex += 1
                }
            }
        }

        for offset in 0..<suffix {
            let baseIndex = baseLines.count - suffix + offset
            let targetIndex = targetLines.count - suffix + offset
            append(
                .context,
                baseLines[baseIndex],
                base: baseIndex + 1,
                target: targetIndex + 1
            )
        }
        return out
    }

    /// A real unified diff, so what lands on the pasteboard can be read by a
    /// person *and* applied by `patch`.
    static func unified(
        _ lines: [DesktopArtifactDiffLine],
        baseLabel: String,
        targetLabel: String
    ) -> String {
        let context = 3
        var out = ["--- \(baseLabel)", "+++ \(targetLabel)"]
        let changed = lines.indices.filter { lines[$0].change != .context }
        guard !changed.isEmpty else { return out.joined(separator: "\n") }

        var hunks: [(start: Int, end: Int)] = []
        var start = changed[0]
        var end = changed[0]
        for index in changed.dropFirst() {
            if index - end <= context * 2 {
                end = index
            } else {
                hunks.append((start, end))
                start = index
                end = index
            }
        }
        hunks.append((start, end))

        for hunk in hunks {
            let from = max(0, hunk.start - context)
            let to = min(lines.count - 1, hunk.end + context)
            var baseStart = 0
            var targetStart = 0
            var baseCount = 0
            var targetCount = 0
            for index in from...to {
                if let line = lines[index].baseLine {
                    if baseCount == 0 { baseStart = line }
                    baseCount += 1
                }
                if let line = lines[index].targetLine {
                    if targetCount == 0 { targetStart = line }
                    targetCount += 1
                }
            }
            // An empty side anchors to the line before the hunk, which is the
            // unified-diff convention for a pure insertion or deletion.
            if baseCount == 0 { baseStart = lastLine(before: from, in: lines, base: true) }
            if targetCount == 0 { targetStart = lastLine(before: from, in: lines, base: false) }
            out.append(
                "@@ -\(range(baseStart, baseCount)) +\(range(targetStart, targetCount)) @@"
            )
            for index in from...to {
                let line = lines[index]
                let sign =
                    switch line.change {
                    case .added: "+"
                    case .removed: "-"
                    case .context: " "
                    }
                out.append(sign + line.text)
            }
        }
        return out.joined(separator: "\n")
    }

    private static func split(_ value: String) -> [String] {
        value.isEmpty ? [] : value.components(separatedBy: "\n")
    }

    private static func range(_ start: Int, _ count: Int) -> String {
        count == 1 ? "\(start)" : "\(start),\(count)"
    }

    private static func lastLine(
        before index: Int,
        in lines: [DesktopArtifactDiffLine],
        base: Bool
    ) -> Int {
        var cursor = index - 1
        while cursor >= 0 {
            if let value = base ? lines[cursor].baseLine : lines[cursor].targetLine {
                return value
            }
            cursor -= 1
        }
        return 0
    }
}

// MARK: - Export

private struct DesktopArtifactFile {
    let document: DesktopArtifactDocument
    let name: String
}

/// Carries bytes the backend already produced (an Office export) or the version's
/// own source, so `.fileExporter` — the system's save flow, with its sandbox
/// grant and its replace confirmation — does the writing rather than a bare
/// `NSSavePanel` and a `try?`.
private struct DesktopArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// MARK: - Detached artifact window

/// "Open in New Window" as a real window, not a sheet.
///
/// The app has one `WindowGroup`, so there is no scene to route an
/// `openWindow(value:)` through; the window is therefore built here and held by
/// this presenter until AppKit tells it the window closed. It renders an
/// immutable snapshot of one version on purpose — a detached window that silently
/// followed later edits would misrepresent the version named in its subtitle.
@MainActor
private final class DesktopArtifactWindows: NSObject, NSWindowDelegate {
    static let shared = DesktopArtifactWindows()

    private var windows: [NSWindow] = []

    func present(
        title: String,
        subtitle: String,
        kind: NativeArtifactKind,
        content: String,
        mode: DesktopArtifactViewMode
    ) {
        let controller = NSHostingController(
            rootView: DesktopArtifactWindowContent(kind: kind, content: content, mode: mode)
        )
        let window = NSWindow(contentViewController: controller)
        window.title = title
        window.subtitle = subtitle
        window.setContentSize(NSSize(width: 820, height: 620))
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        windows.append(window)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        windows.removeAll { $0 === closing }
    }
}

private struct DesktopArtifactWindowContent: View {
    let kind: NativeArtifactKind
    let content: String
    let mode: DesktopArtifactViewMode

    var body: some View {
        Group {
            if kind.isDesignDocument {
                // Read-only, which is what "immutable snapshot of one version"
                // means once the thing on screen can be dragged: this window has no
                // Save, no draft and no route back to the model, so an editor that
                // accepted edits here would be collecting work it could only throw
                // away when the window closed.
                DesktopDesignSurface(content: content, readOnly: true)
            } else if mode == .canvas {
                // The canvas torn off into its own window is the best version of
                // it there is: `.sideBySide` at 820pt gives the source and the
                // running document a readable half each, and the console keeps
                // reporting while the reader works in the main window.
                DesktopArtifactLiveCanvas(
                    kind: kind,
                    content: content,
                    layout: .sideBySide
                )
            } else if mode == .preview, kind == .markdown {
                // Same renderer and same page as the main canvas, so a document
                // torn off into its own window is the document the reader was
                // just looking at rather than a second, worse rendering of it.
                JunoDetailPage {
                    JunoMarkdownText(content)
                        .padding(JunoSpace.section)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .junoCard()
                }
            } else {
                NativeArtifactPreview(kind: kind, content: content, mode: mode.displayMode)
            }
        }
        .frame(minWidth: 480, minHeight: 360)
        // This *is* the window level for a detached window, which is the one
        // place a page paints the canvas itself.
        .junoReadingCanvas()
    }
}

// MARK: - Vocabulary

/// The product's words for an artifact, in one place.
///
/// The wire values are shouted enum names (`MARKDOWN`), and a window subtitle
/// full of capitals reads as an error code. These are the same nouns the web
/// Canvas uses so the two clients describe the same document the same way.
private enum DesktopArtifactKindName {
    static func singular(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Page"
        case .react: "Component"
        case .code: "Code"
        case .markdown: "Document"
        case .svg: "Graphic"
        case .mermaid: "Diagram"
        case .design: "Design"
        }
    }

    /// The filter chips' labels — a *category* of artifact, matching the web's
    /// `TYPE_LABELS`.
    ///
    /// Plurals of the singulars above rather than a straight copy of the web
    /// list: the web calls an HTML artifact a "Site" in its chips and a "Page"
    /// everywhere else, and both native clients already say "Page". Introducing a
    /// third noun for the same object here would be worse than the small
    /// divergence.
    static func plural(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Pages"
        case .react: "Components"
        case .code: "Code"
        case .markdown: "Documents"
        case .svg: "Graphics"
        case .mermaid: "Diagrams"
        case .design: "Designs"
        }
    }

    static func symbol(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "globe"
        case .react: "atom"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .markdown: "doc.text"
        case .svg: "scribble.variable"
        case .mermaid: "flowchart"
        case .design: "pencil.and.outline"
        }
    }

    static func origin(_ origin: NativeArtifactOrigin) -> String {
        switch origin {
        case .generated: "Generated"
        case .edit: "Edited"
        case .restore: "Restored"
        }
    }

    static func exportLabel(_ format: NativeArtifactExportFormat) -> String {
        switch format {
        case .docx: "Word Document (.docx)"
        case .xlsx: "Excel Workbook (.xlsx)"
        case .pptx: "PowerPoint Deck (.pptx)"
        }
    }

    /// The version number is part of the file name because the source of a *past*
    /// version is a different document from the current one, and a folder of
    /// same-named files is how that distinction gets lost.
    static func sourceFileName(
        title: String,
        kind: NativeArtifactKind,
        language: String?,
        version: Int
    ) -> String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let cleaned = String(
            title.unicodeScalars.map { forbidden.contains($0) ? " " : Character($0) }
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? "artifact" : String(cleaned.prefix(80))
        return "\(base) v\(version).\(sourceExtension(kind: kind, language: language))"
    }

    private static func sourceExtension(kind: NativeArtifactKind, language: String?) -> String {
        switch kind {
        case .html: "html"
        case .react: "tsx"
        case .markdown: "md"
        case .svg: "svg"
        case .mermaid: "mmd"
        case .design: "juno.design.json"
        case .code: codeExtension(language)
        }
    }

    private static func codeExtension(_ language: String?) -> String {
        switch language?.lowercased() {
        case "swift": "swift"
        case "python", "py": "py"
        case "typescript", "ts": "ts"
        case "tsx": "tsx"
        case "javascript", "js": "js"
        case "jsx": "jsx"
        case "rust", "rs": "rs"
        case "go": "go"
        case "ruby", "rb": "rb"
        case "java": "java"
        case "kotlin", "kt": "kt"
        case "c": "c"
        case "cpp", "c++": "cpp"
        case "css": "css"
        case "json": "json"
        case "yaml", "yml": "yaml"
        case "sql": "sql"
        case "sh", "bash", "shell": "sh"
        default: "txt"
        }
    }
}
