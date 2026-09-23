import AppKit
import Foundation
import JunoChatKit
import JunoDesignKit
import JunoDesignSystem
import SwiftUI
import UniformTypeIdentifiers

/// An artifact opened from a transcript, and the column it opens into.
///
/// **This file exists to delete a modal.** Opening an artifact from a Mac chat
/// used to present `.sheet(item:)` from inside the message row that mentioned it
/// — a lazily-materialised row in a `LazyVStack`, so the presenter could be torn
/// down out from under a live sheet — and the sheet covered the conversation the
/// artifact was written in. The website has never done that: it adds a real
/// third column beside the transcript (`chat-view.tsx`), and everything below is
/// that column, down to its width model and the sixteen points it slides in from.
///
/// The dock is plain layout — a trailing inset on the conversation with the
/// panel drawn in the room it reserved — and deliberately **not** `.inspector`,
/// `.sheet` or `.popover`. This surface is the content of a
/// `NavigationSplitView`'s detail column, and an inspector attached from there
/// makes `NSHostingView` call `setNeedsUpdateConstraints:` from inside its own
/// `updateConstraints` while the window's constraint pass is running — AppKit
/// throws and the process takes SIGTRAP. ``DesktopCodeWorkspace`` carries the
/// bisected report; ``DesktopArtifactsScreen`` docks its version history the same
/// way for the same reason. Nothing here is *presented*: a SwiftUI overlay is a
/// sibling in the same layout pass, so the constraint machinery never hears
/// about it.

// MARK: - The open artifact

/// The artifact a transcript asked to open: the tag the reply carried, and the
/// stored row behind it when this Mac has one.
///
/// **The row wins.** The model revises an artifact by re-emitting it under the
/// same identifier, and the server appends a version to the one row; the tag a
/// card carries is only the body *that* reply wrote. Opening from the tag
/// alone is how the canvas kept showing the previous revision when a revised
/// artifact was opened (Artifacts & Design audit, mac-artifacts-1). With the
/// row, the canvas shows the latest version, names it (`v3`), and can save a
/// new one; without it — the moment between "the reply finished" and "the row
/// arrived", or a private chat — the tag is all there is, and the canvas says
/// so and offers nothing it cannot keep.
struct DesktopChatArtifact: Identifiable, Equatable {
    let reference: NativeMessageContent.ArtifactReference
    /// The stored row, resolved when the canvas opened and kept current by the
    /// conversation column as sync and saves move it on.
    var stored: NativeArtifact?

    init(reference: NativeMessageContent.ArtifactReference, stored: NativeArtifact? = nil) {
        self.reference = reference
        self.stored = stored
    }

    var id: String { reference.id }

    var kind: NativeArtifactKind {
        stored?.kind ?? NativeArtifactKind(rawValue: reference.kind.uppercased()) ?? .code
    }

    var language: String? { stored?.language ?? reference.language }

    var title: String {
        let title = stored?.title ?? reference.title
        return title.isEmpty ? "Untitled artifact" : title
    }

    /// The latest source: the stored row's current version, or the tag's body.
    var latestContent: String {
        stored?.currentContent ?? reference.content
    }

    /// The version ``latestContent`` is, when there is a row.
    var latestVersion: Int? { stored?.currentVersion }

    /// The design the canvas may open: the stored row's body — the expanded
    /// `DesignDocument` — and never the tag's. The model writes the compact
    /// authoring form, which only the server expands, so opening the tag body
    /// is how every chat-made design used to fail with "This design can't be
    /// opened" (Artifacts & Design audit, X-11). Nil until the row arrives.
    var storedDesignContent: String? {
        kind.isDesignDocument ? stored?.currentContent : nil
    }
}

// MARK: - Which view of an artifact

/// The three ways a Mac surface can show one artifact.
///
/// A type of its own rather than `NativeArtifactDisplayMode` plus a Bool, and the
/// reason is written on the artifacts screen's own view switch: the control has
/// to name the view the reader is *in*. A two-way Preview/Source picker sitting
/// above a live canvas would have one of its halves lit while showing neither of
/// them — the exact defect that switch already documents for design documents.
///
/// Both desktop artifact surfaces share this enum because they are two windows
/// onto the same document, and a canvas reachable from the chat dock but not from
/// the library (or the reverse) is the divergence `DesktopDesignSurface` was
/// created to end.
enum DesktopArtifactViewMode: String, CaseIterable, Identifiable, Hashable {
    /// The artifact as itself: rendered HTML, a graphic, prose.
    case preview
    /// Its source, and on the library screen its editable source.
    case source
    /// ``ArtifactCanvasView``: code beside the running document, with the page's
    /// console and its uncaught errors captured out of the sandbox.
    case canvas

    var id: String { rawValue }

    var title: String {
        switch self {
        case .preview: "Preview"
        case .source: "Source"
        case .canvas: "Canvas"
        }
    }

    /// What ``NativeArtifactPreview`` should be asked for when this mode reaches
    /// it. `.canvas` never does — the canvas is a different view entirely — but
    /// callers that must hand a display mode to a shared component (the detached
    /// window, a thumbnail) need one answer rather than a crash, and Preview is
    /// the honest one: the canvas opens on the running document too.
    var displayMode: NativeArtifactDisplayMode {
        self == .source ? .source : .preview
    }

    /// The modes worth offering for `kind`, in the order they are shown.
    ///
    /// Never returns a single option. A one-segment switcher is a label wearing a
    /// control's clothes, so a caller that gets one element back draws the label
    /// instead — which is what both surfaces already do for a kind with no
    /// renderer.
    static func available(for kind: NativeArtifactKind) -> [DesktopArtifactViewMode] {
        var modes: [DesktopArtifactViewMode] = []
        if kind.supportsRenderedPreview { modes.append(.preview) }
        modes.append(.source)
        if kind.supportsLiveCanvas { modes.append(.canvas) }
        return modes
    }
}

/// Hosts one ``ArtifactCanvasModel`` for the artifact it was given.
///
/// **The model is `@State`, and the caller must key this view on the artifact.**
/// The model carries the console transcript, the error count and the bridge's
/// connection state *of the document that is loaded*. Reused across two
/// artifacts it would show the first one's uncaught exception under the second
/// one's code — a red badge on a document that never failed, and no way for the
/// reader to tell which file it came from. `ArtifactCanvasModel.documentWillLoad`
/// clears the transcript on reload for the same reason within one document;
/// `.id(_:)` at the call site is how that guarantee extends across documents.
///
/// No ``ArtifactCanvasRuntime`` is passed because none ships: the canvas reports
/// `runtimeNotInstalled` for a React artifact and shows its source with that
/// sentence attached. Passing an empty runtime here to make the Preview tab look
/// populated would replace a stated fact with a blank white pane.
struct DesktopArtifactLiveCanvas: View {
    private let content: String
    @State private var model: ArtifactCanvasModel

    /// - Parameter layout: the docked chat column passes `.tabbed` because a
    ///   split at 380pt leaves neither pane readable; a full-window artifact page
    ///   passes `.sideBySide`, which is what the layout is for. The reader can
    ///   change it either way — this only chooses what they open on.
    init(
        kind: NativeArtifactKind,
        content: String,
        layout: ArtifactCanvasLayout = .sideBySide
    ) {
        self.content = content
        _model = State(initialValue: ArtifactCanvasModel(kind: kind, layout: layout))
    }

    var body: some View {
        ArtifactCanvasView(content: content, model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Naming

/// How the chat surface names an artifact: in the transcript's inline card, in
/// the canvas header, and on the file the canvas saves.
///
/// Shared between the card and the canvas so the two cannot describe the same
/// object differently — the card saying "Markdown" while the panel beside it
/// says "Document" is the kind of drift that makes a product read as assembled
/// from parts.
enum DesktopArtifactKindLabel {
    /// The kind, spelled the way the product spells it.
    ///
    /// Not `kind.capitalized`: the wire value is upper-case, so that produced
    /// "Html", "Svg" and "React" — the first two are wrong as words, and all
    /// three were the card's most prominent metadata. An unrecognised kind falls
    /// back to the wire value untouched, which is honest rather than title-cased
    /// nonsense.
    static func title(forWireKind kind: String) -> String {
        switch kind.uppercased() {
        case "HTML": "HTML"
        case "REACT": "React"
        case "CODE": "Code"
        case "SVG": "SVG"
        case "MARKDOWN": "Markdown"
        case "MERMAID": "Diagram"
        // Was missing, so a design's card and canvas printed the wire value
        // "DESIGN" (Artifacts & Design audit, mac-artifacts-9).
        case "DESIGN": "Design"
        default: kind
        }
    }

    /// The web's `ICONS` map (`artifact-inline-card.tsx`), in the website's
    /// own marks: `Globe`, `Code2`, `FileCode2`, `Image`, `CodeIcons.file`,
    /// `GitBranch` and `AppIcons.design`. Falls through to the code glyph for a
    /// kind this client does not know, which is honest: an artifact of an
    /// unrecognised kind is still source.
    ///
    /// REACT is Phosphor's `Code` brackets (``JunoIcon/codeBrackets``), not
    /// ``JunoIcon/code`` — that is the Juno Code product mark. DESIGN is the
    /// Juno Design mark, not a pen.
    static func icon(forWireKind kind: String) -> JunoIcon {
        icon(for: NativeArtifactKind(rawValue: kind.uppercased()))
    }

    static func icon(for kind: NativeArtifactKind?) -> JunoIcon {
        switch kind {
        case .html: .web
        case .react: .codeBrackets
        case .svg: .image
        case .mermaid: .branch
        case .markdown: .file
        case .design: .design
        case .code, nil: .fileCode
        }
    }

    /// The name the save panel opens on.
    ///
    /// No version suffix, unlike the Artifacts page's own exporter: a reference
    /// carried on a message *is* one version — the one that reply wrote — and
    /// numbering it would imply a history this canvas cannot show.
    static func fileName(title: String, kind: NativeArtifactKind, language: String?) -> String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let cleaned = String(
            title.unicodeScalars.map { forbidden.contains($0) ? " " : Character($0) }
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? "artifact" : String(cleaned.prefix(80))
        return "\(base).\(fileExtension(kind: kind, language: language))"
    }

    private static func fileExtension(kind: NativeArtifactKind, language: String?) -> String {
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

    /// The languages a model actually labels a fenced artifact with. Anything
    /// else saves as `.txt`, which opens everywhere and claims nothing.
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

// MARK: - The trailing dock

/// One panel the trailing dock holds. The dock shows one at a time; each
/// remembers its own width.
protocol TrailingDockPanel: Identifiable, Equatable {
    /// The defaults key this panel's width is kept under: `dock.canvas.width`.
    var widthKey: String { get }
}

/// What the conversation column docks beside its transcript: an artifact's
/// canvas, or a reply's Activity panel (the rework's name for the brief's
/// Thought panel) — never both.
enum DesktopDockPanel: TrailingDockPanel {
    case canvas(DesktopChatArtifact)
    /// A reply's run, by message id, opened on a call when one is given.
    case activity(messageID: String, focusCallID: String?)
    /// A research run, by id — `message:<id>` for research a profile-1 server
    /// answered inside the chat.
    case research(runID: String)

    var id: String {
        switch self {
        case .canvas(let artifact): "canvas:\(artifact.id)"
        case .activity(let messageID, _): "activity:\(messageID)"
        case .research(let runID): "research:\(runID)"
        }
    }

    /// Activity and Research are one right-column shell (SPEC §8.5), so they
    /// keep one width.
    var widthKey: String {
        switch self {
        case .canvas: "dock.canvas.width"
        case .activity, .research: "dock.activity.width"
        }
    }

    var artifact: DesktopChatArtifact? {
        switch self {
        case .canvas(let artifact): artifact
        case .activity, .research: nil
        }
    }
}

/// The dock's width model — spec §1.2: at least 400, 480 when it opens, at
/// most 60% of the detail column, and never less than 480 left for the chat.
/// Below an 800pt column the panel takes the column (the web's
/// `@container/split` rule).
enum TrailingDockMetrics {
    static let minimumPanel: CGFloat = 400
    static let idealPanel: CGFloat = 480
    static let maximumFraction: CGFloat = 0.6
    static let minimumChat: CGFloat = 480
    static let sideBySideWidth: CGFloat = 800

    static func bounds(in container: CGFloat) -> (minimum: CGFloat, maximum: CGFloat) {
        // Between 800 and 880 the two floors cannot both hold; the panel's
        // wins, because a canvas narrower than 400 cannot show a page.
        let maximum = max(minimumPanel, min((container * maximumFraction).rounded(), container - minimumChat))
        return (minimumPanel, maximum)
    }

    static func defaultWidth(in container: CGFloat) -> CGFloat {
        clamp(idealPanel, in: container)
    }

    static func clamp(_ width: CGFloat, in container: CGFloat) -> CGFloat {
        let range = bounds(in: container)
        return min(max(width, range.minimum), range.maximum)
    }
}

/// Docks one panel beside `content` as a real column — and over it, never
/// instead of it, when the column is too narrow to hold both. The spec's
/// `TrailingDock`, generalised from the artifact dock.
///
/// **Plain layout, deliberately not `.inspector`, `.sheet` or `.popover`.**
/// This view is the content of a `NavigationSplitView`'s detail column, and an
/// inspector attached from there makes `NSHostingView` call
/// `setNeedsUpdateConstraints:` from inside its own `updateConstraints` while
/// the window's constraint pass is running — AppKit throws and the process
/// takes SIGTRAP (``DesktopCodeWorkspace`` carries the bisected report). The
/// panel is an overlay in the room a trailing inset reserved: a sibling in the
/// same layout pass, which the constraint machinery never hears about.
///
/// **`content` is never removed.** A SwiftUI view that leaves the hierarchy
/// takes its `@State` with it — the half-typed message, the tools picked for
/// one send, a live call (which hangs up on `onDisappear`). The web's
/// `hidden lg:flex` is `display: none`, which keeps its node alive; so the
/// compact case hides the transcript and only hides it.
struct TrailingDock<Panel: TrailingDockPanel, Content: View, PanelContent: View>: View {
    let panel: Panel?
    private let panelContent: (Panel) -> PanelContent
    private let content: Content

    init(
        panel: Panel?,
        @ViewBuilder panelContent: @escaping (Panel) -> PanelContent,
        @ViewBuilder content: () -> Content
    ) {
        self.panel = panel
        self.panelContent = panelContent
        self.content = content()
    }

    @State private var containerWidth: CGFloat = 0
    /// The width the drag started from, so a gesture measures against where it
    /// began rather than accumulating against a value it is itself changing.
    @State private var dragOrigin: CGFloat?
    /// The live width mid-drag, written to defaults once, on release.
    @State private var draggingWidth: CGFloat?
    @State private var showingResizeCursor = false
    /// Bumped when a width is written, so the read below is taken again.
    @State private var widthRevision = 0

    /// The divider's hit box, which the conversation gives up along with the
    /// panel itself.
    private static var handleWidth: CGFloat { JunoSpace.snug }

    /// Only true once the width has been measured — at zero the panel would
    /// flash full-bleed on the first frame of every open.
    private var isCompact: Bool {
        containerWidth > 0 && containerWidth < TrailingDockMetrics.sideBySideWidth
    }

    private var transcriptIsCovered: Bool { panel != nil && isCompact }

    private var reservedWidth: CGFloat {
        guard panel != nil, !isCompact else { return 0 }
        return panelWidth + Self.handleWidth
    }

    private var storedWidth: CGFloat? {
        _ = widthRevision
        guard let key = panel?.widthKey else { return nil }
        let value = UserDefaults.standard.double(forKey: key)
        return value > 0 ? CGFloat(value) : nil
    }

    private var panelWidth: CGFloat {
        guard containerWidth > 0 else { return TrailingDockMetrics.idealPanel }
        if let draggingWidth { return TrailingDockMetrics.clamp(draggingWidth, in: containerWidth) }
        guard let storedWidth else { return TrailingDockMetrics.defaultWidth(in: containerWidth) }
        return TrailingDockMetrics.clamp(storedWidth, in: containerWidth)
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(transcriptIsCovered ? 0 : 1)
            .allowsHitTesting(!transcriptIsCovered)
            // Disabled as well: only `disabled` moves the keyboard off a
            // composer that is still mounted underneath.
            .disabled(transcriptIsCovered)
            .accessibilityHidden(transcriptIsCovered)
            .padding(.trailing, reservedWidth)
            .overlay(alignment: .trailing) { panelColumn }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
    }

    /// One instance for both widths — the compact case changes what the panel
    /// is sized to, never where it sits — so dragging the window across the
    /// threshold cannot reset the view the reader was on.
    @ViewBuilder
    private var panelColumn: some View {
        if let panel {
            HStack(spacing: 0) {
                if !isCompact {
                    resizeHandle(for: panel)
                }
                panelContent(panel)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frame(width: isCompact ? nil : panelWidth)
            }
            // The window's canvas, painted again only where the panel covers
            // the transcript: a covering panel that can be seen through is not
            // covering.
            .background {
                if isCompact {
                    Color.junoCanvasWarm
                }
            }
            // Sixteen points and a fade in, a bare fade out — the web's
            // `slide-in-from-right-4` / `fade-out` pair.
            .transition(
                .asymmetric(
                    insertion: .offset(x: DesktopChoreography.canvasSlide).combined(with: .opacity),
                    removal: .opacity
                )
            )
        }
    }

    /// The divider, and the grip on it: one hairline inside a wider
    /// transparent box. Double-click puts the panel back to 480.
    private func resizeHandle(for panel: Panel) -> some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1)
            .frame(width: Self.handleWidth)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let origin = dragOrigin ?? panelWidth
                        dragOrigin = origin
                        // Dragging left widens the panel: the handle is on its
                        // leading edge.
                        draggingWidth = origin - value.translation.width
                    }
                    .onEnded { _ in
                        if let draggingWidth, containerWidth > 0 {
                            UserDefaults.standard.set(
                                Double(TrailingDockMetrics.clamp(draggingWidth, in: containerWidth)),
                                forKey: panel.widthKey
                            )
                            widthRevision += 1
                        }
                        dragOrigin = nil
                        draggingWidth = nil
                    }
            )
            .simultaneousGesture(
                TapGesture(count: 2).onEnded {
                    UserDefaults.standard.removeObject(forKey: panel.widthKey)
                    widthRevision += 1
                }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    guard !showingResizeCursor else { return }
                    showingResizeCursor = true
                    NSCursor.resizeLeftRight.push()
                case .ended:
                    guard showingResizeCursor else { return }
                    showingResizeCursor = false
                    NSCursor.pop()
                }
            }
            // A pushed cursor outlives the view that pushed it; pop it if the
            // handle goes away under the pointer.
            .onDisappear {
                guard showingResizeCursor else { return }
                showingResizeCursor = false
                NSCursor.pop()
            }
            .help("Drag to resize. Double-click to reset.")
            .accessibilityHidden(true)
    }
}

// MARK: - The canvas

/// Saves a new version of a stored artifact on top of the version the canvas
/// opened, and answers with the reason it could not — nil when it landed.
typealias DesktopArtifactSave = @MainActor (_ id: String, _ content: String, _ baseVersion: Int) async -> String?

/// The artifact in the dock: the web's canvas header, its view switch, and the
/// artifact under both.
///
/// **It follows the stored row.** The canvas shows the row's latest version and
/// moves on when sync or a later reply brings a newer one — unless the reader
/// has unsaved edits, which it keeps (a Save on top of an old version is then
/// refused by the server, and says so, rather than overwriting). Without a row
/// it shows the tag and edits nothing.
///
/// Views, as on the web: **Preview** runs the artifact in the same runtime the
/// transcript card uses; **Code** is its source — editable, with Save, when
/// there is a row to save to; **Console** appears once the page has logged. A
/// design opens in the editor, editable when there is a row.
///
/// Paints no canvas of its own: the window paints `Color.junoCanvas` once, and
/// the header's half-strength surface is the only fill here — the web's
/// `bg-card/50`.
struct DesktopArtifactCanvas: View {
    let artifact: DesktopChatArtifact
    let close: () -> Void
    let requestEdit: (String) -> Void
    /// Nil where there is nothing to save through.
    let save: DesktopArtifactSave?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var view: InlineArtifactView = .preview
    /// The reader's edits, or nil when there are none. An emptied editor is a
    /// real (empty) draft, not "no draft" (Artifacts & Design audit,
    /// mac-artifacts-12).
    @State private var draft: String?
    /// What the canvas is showing edits against: the latest source when it
    /// opened or last followed the row, and that source's version.
    @State private var baseContent = ""
    @State private var baseVersion: Int?
    /// Bumped when the design editor must reload a newer document.
    @State private var designRevision = 0
    @State private var runtime = ArtifactRuntimeModel()
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var selectedComponent: DesktopArtifactComponent?
    /// Extracted once per settled source, not twice per keystroke
    /// (Artifacts & Design audit, mac-artifacts-7).
    @State private var componentCandidates: [DesktopArtifactComponent] = []
    @State private var pendingDownload: DesktopChatArtifactDownload?
    @State private var downloadError: String?

    init(
        artifact: DesktopChatArtifact,
        close: @escaping () -> Void,
        requestEdit: @escaping (String) -> Void,
        save: DesktopArtifactSave? = nil
    ) {
        self.artifact = artifact
        self.close = close
        self.requestEdit = requestEdit
        self.save = save
        _baseContent = State(initialValue: artifact.latestContent)
        _baseVersion = State(initialValue: artifact.latestVersion)
    }

    private var runtimeInfo: NativeArtifactRuntimeInfo {
        NativeArtifactRuntimeInfo.resolve(kind: artifact.kind, language: artifact.language)
    }

    private var resolvedContent: String { draft ?? baseContent }
    private var hasDraftChanges: Bool { draft != nil && draft != baseContent }
    private var canEdit: Bool { artifact.stored != nil && save != nil }
    private var isMarkdown: Bool { artifact.kind == .markdown }
    private var hasPreview: Bool { runtimeInfo.runsOnThisMac && !artifact.kind.isDesignDocument }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            viewBar
            Divider()
            // Clamped for the reason ``JunoDetailPage`` spells out: a
            // `ScrollView` propagates its content's ideal height, and a
            // `NavigationSplitView` answers an ideal it cannot meet by growing
            // the window. `Color.clear` takes what it is proposed, and nothing
            // the artifact draws reaches past the panel.
            Color.clear.overlay { canvasBody }.clipped()
        }
        // A different artifact is a different document.
        .onChange(of: artifact.id) { _, _ in
            view = .preview
            draft = nil
            saveError = nil
            downloadError = nil
            selectedComponent = nil
            rebase()
        }
        // A newer version — a later reply, sync, another device — is followed
        // unless the reader is in the middle of an edit.
        .onChange(of: artifact.latestVersion) { _, _ in
            if !hasDraftChanges { rebase() }
        }
        .onChange(of: artifact.latestContent) { _, _ in
            if !hasDraftChanges { rebase() }
        }
        .task(id: resolvedContent) {
            guard supportsComponentSelection else {
                componentCandidates = []
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            componentCandidates = DesktopArtifactComponent.extract(from: resolvedContent)
        }
        .fileExporter(
            isPresented: Binding(
                get: { pendingDownload != nil },
                set: { if !$0 { pendingDownload = nil } }
            ),
            document: pendingDownload?.document,
            // `.data` rather than a guessed content type: the file name already
            // carries the extension.
            contentType: .data,
            defaultFilename: pendingDownload?.name
        ) { result in
            if case .failure(let error) = result {
                downloadError = error.localizedDescription
            }
            pendingDownload = nil
        }
        .accessibilityIdentifier("juno.desktop.chat.artifact-canvas")
    }

    /// Takes the row's latest source as the new base, dropping any draft.
    private func rebase() {
        let latest = artifact.latestContent
        let changed = latest != baseContent
        baseContent = latest
        baseVersion = artifact.latestVersion
        draft = nil
        if changed { designRevision += 1 }
    }

    // MARK: Header

    /// The web's canvas header: identity, Share, an overflow menu, a hairline,
    /// and Close — compact, because the artifact is the event.
    private var header: some View {
        HStack(spacing: JunoSpace.tight) {
            VStack(alignment: .leading, spacing: 1) {
                Text(artifact.title)
                    .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                InlineArtifactMeta(
                    label: runtimeInfo.label,
                    version: baseVersion,
                    isUpdated: false,
                    status: status
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            ShareLink(item: resolvedContent, subject: Text(artifact.title)) {
                headerGlyph(.share)
            }
            .buttonStyle(.plain)
            .help("Share this artifact’s source")
            .accessibilityLabel("Share")

            Menu {
                Button("Copy Source") {
                    JunoPasteboard.copy(resolvedContent)
                }
                Button("Save Source As…") {
                    downloadError = nil
                    pendingDownload = DesktopChatArtifactDownload(
                        document: DesktopChatArtifactDocument(text: resolvedContent),
                        name: DesktopArtifactKindLabel.fileName(
                            title: artifact.title,
                            kind: artifact.kind,
                            language: artifact.language
                        )
                    )
                }
            } label: {
                headerGlyph(.ellipsis)
            }
            // A borderless menu with its indicator suppressed keeps the weight
            // of the buttons beside it.
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Copy or save this artifact’s source")
            .accessibilityLabel("Artifact actions")
            .accessibilityIdentifier("juno.desktop.chat.artifact-actions")

            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 1, height: 20)
                .padding(.horizontal, 1)
                .accessibilityHidden(true)

            Button(action: close) {
                headerGlyph(.close)
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .help("Close the canvas")
            .accessibilityLabel("Close canvas")
            .accessibilityIdentifier("juno.desktop.chat.artifact-close")
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoSurface.opacity(0.5))
        .accessibilityElement(children: .contain)
    }

    /// Flat and quiet — the web's `variant="ghost" text-muted-foreground` —
    /// across a 28pt square.
    private func headerGlyph(_ icon: JunoIcon) -> some View {
        JunoIconView(icon, size: 14)
            .junoSecondaryInk()
            .frame(width: 28, height: 28)
            .contentShape(.rect)
    }

    private var status: InlineArtifactStatus? {
        if isSaving { return .running }
        guard view == .preview || view == .console, hasPreview else { return nil }
        switch runtime.status {
        case .error: return .error
        case .running: return .running
        case .loading: return .loading
        case .done: return runtimeInfo.mode == .console ? .done : .live
        case .idle: return nil
        }
    }

    // MARK: View bar

    private var options: [DesktopSegmented<InlineArtifactView>.Option] {
        var options: [DesktopSegmented<InlineArtifactView>.Option] = []
        if hasPreview { options.append(.init(.preview, runtimeInfo.mode == .console ? "Output" : "Preview")) }
        options.append(.init(.code, "Code"))
        if runtimeInfo.mode == .web, !isMarkdown, !runtime.entries.isEmpty || view == .console {
            options.append(.init(.console, "Console \(runtime.entries.count)"))
        }
        return options
    }

    /// What is on screen: the chosen view, clamped to the ones this artifact
    /// has, so the switch never draws with no segment lit.
    private var resolvedView: InlineArtifactView {
        options.contains { $0.value == view } ? view : (hasPreview ? .preview : .code)
    }

    private var viewBar: some View {
        HStack(spacing: JunoSpace.snug) {
            if artifact.kind.isDesignDocument {
                // One view: its JSON is not something anyone reads by choice.
                Text(canEdit ? "Design" : "Design · Read only")
                    .junoFont(size: 12, relativeTo: .body, weight: .medium)
                    .foregroundStyle(Color.junoMutedForeground)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
            } else if options.count > 1 {
                DesktopSegmented(
                    options: options,
                    selection: Binding(get: { resolvedView }, set: { view = $0 }),
                    accessibilityLabel: "Artifact view"
                )
                .accessibilityIdentifier("juno.desktop.chat.artifact-view-mode")
            } else {
                Text("Code")
                    .junoFont(size: 12, relativeTo: .body, weight: .medium)
                    .foregroundStyle(Color.junoMutedForeground)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
            }

            if let message = saveError ?? downloadError {
                Text(message)
                    .junoFont(size: 11, relativeTo: .caption2)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: JunoSpace.snug)

            if supportsComponentSelection, !componentCandidates.isEmpty {
                Menu {
                    ForEach(componentCandidates) { component in
                        Button(component.label) { selectedComponent = component }
                    }
                } label: {
                    Label(
                        verbatim: selectedComponent?.shortLabel ?? "Select Component",
                        icon: .crosshair
                    )
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .contentShape(.rect)
                .help("Choose an element to target in an edit")

                if let selectedComponent {
                    Button("Edit") {
                        requestEdit(
                            "Edit the \(selectedComponent.promptDescription) in “\(artifact.title)”. "
                                + "Keep the rest of the artifact unchanged."
                        )
                    }
                    .buttonStyle(.borderless)
                    .contentShape(.rect)
                    .help("Put a targeted edit request in the conversation composer")
                }
            }

            if hasDraftChanges {
                Button("Revert") {
                    draft = nil
                    saveError = nil
                    designRevision += 1
                }
                .buttonStyle(.borderless)
                .contentShape(.rect)
                .disabled(isSaving)
                .help("Discard your edits")

                if canEdit {
                    Button {
                        Task { await saveDraft() }
                    } label: {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Save")
                        }
                    }
                    // The canvas's one prominent button, and only while there
                    // is something to save.
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .contentShape(.rect)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(isSaving)
                    .help("Save as a new version")
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
    }

    /// Saves the draft as a new version on top of the version it was made
    /// against. A newer version on the server comes back as a refusal the
    /// reader sees, never as a silent overwrite (Artifacts & Design audit,
    /// mac-design-2).
    private func saveDraft() async {
        guard let save, let stored = artifact.stored, let draft, !isSaving else { return }
        isSaving = true
        saveError = nil
        let failure = await save(stored.id, draft, baseVersion ?? stored.currentVersion)
        isSaving = false
        if let failure {
            saveError = failure
        } else {
            // The editor already shows what was saved; take it as the base
            // without reloading it.
            baseContent = draft
            baseVersion = (baseVersion ?? stored.currentVersion) + 1
            self.draft = nil
        }
    }

    // MARK: Body

    @ViewBuilder
    private var canvasBody: some View {
        if artifact.kind.isDesignDocument {
            if artifact.storedDesignContent != nil {
                // Opened from the stored row (``DesktopChatArtifact/storedDesignContent``),
                // and editable when there is somewhere to save: an editor that
                // took edits and dropped them would be the worse divergence.
                DesktopDesignSurface(
                    content: baseContent,
                    readOnly: !canEdit,
                    onEdit: canEdit ? { draft = $0 } : nil
                )
                .id("\(artifact.id)#\(designRevision)")
            } else {
                // The reply has finished but its stored row has not reached
                // this Mac yet — or never will, in a private chat.
                JunoEmptyState(
                    title: "This design isn’t saved yet",
                    message: "It opens here once Juno has stored it — usually a moment after the reply finishes.",
                    icon: .design
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            switch resolvedView {
            case .preview where isMarkdown:
                // `JunoMarkdownText` is the transcript's renderer; the shared
                // preview's markdown branch flattens headings and fences.
                JunoDetailPage {
                    JunoMarkdownText(resolvedContent)
                        .padding(JunoSpace.section)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .junoCard()
                }
            case .preview:
                NativeArtifactPreview(
                    kind: artifact.kind,
                    content: resolvedContent,
                    mode: .preview,
                    policy: .inline,
                    language: artifact.language,
                    runtime: runtime
                )
                .background(runtimeInfo.mode == .console ? InlineArtifactCard.terminalGround : .white)
            case .console:
                InlineArtifactConsole(entries: runtime.entries)
            case .code:
                if canEdit {
                    TextEditor(text: Binding(get: { resolvedContent }, set: { draft = $0 }))
                        .junoFont(size: 12, relativeTo: .body, design: .monospaced)
                        .foregroundStyle(Color.junoForeground)
                        .scrollContentBackground(.hidden)
                        .padding(JunoSpace.snug)
                        .background(Color.junoMuted)
                        .accessibilityLabel("Artifact source editor")
                        .accessibilityIdentifier("juno.desktop.chat.artifact-source-editor")
                } else {
                    ArtifactCodeSurface(
                        source: resolvedContent,
                        wraps: isMarkdown,
                        accessibilityLabel: "\(artifact.title) source"
                    )
                }
            }
        }
    }

    private var supportsComponentSelection: Bool {
        artifact.kind == .html || artifact.kind == .svg
    }
}

struct DesktopArtifactComponent: Identifiable, Hashable {
    let id: String
    let tag: String
    let elementID: String?
    let className: String?

    var shortLabel: String {
        if let elementID { return "#\(elementID)" }
        if let className, let first = className.split(separator: " ").first {
            return ".\(first)"
        }
        return tag
    }

    var label: String {
        var value = "<\(tag)>"
        if let elementID { value += "  #\(elementID)" }
        if let className, !className.isEmpty { value += "  .\(className.replacingOccurrences(of: " ", with: "."))" }
        return value
    }

    var promptDescription: String {
        if let elementID { return "<\(tag)> element with id \"\(elementID)\"" }
        if let className { return "<\(tag)> element with class \"\(className)\"" }
        return "<\(tag)> component"
    }

    static func extract(from source: String) -> [Self] {
        guard let expression = try? NSRegularExpression(
            pattern: #"<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>"#
        ) else { return [] }
        let nsSource = source as NSString
        let matches = expression.matches(
            in: source,
            range: NSRange(location: 0, length: nsSource.length)
        )
        let skipped: Set<String> = ["html", "head", "meta", "link", "script", "style"]
        var rows: [Self] = []
        var seen: Set<String> = []

        for (index, match) in matches.enumerated() {
            guard match.numberOfRanges >= 3 else { continue }
            let tag = nsSource.substring(with: match.range(at: 1)).lowercased()
            guard !skipped.contains(tag) else { continue }
            let attributes = nsSource.substring(with: match.range(at: 2))
            let elementID = attribute("id", in: attributes)
            let className = attribute("class", in: attributes)
            let identity = elementID.map { "#\($0)" }
                ?? className.map { "\(tag).\($0)" }
                ?? "\(tag)-\(index)"
            guard seen.insert(identity).inserted else { continue }
            rows.append(Self(id: identity, tag: tag, elementID: elementID, className: className))
            if rows.count == 60 { break }
        }
        return rows
    }

    private static func attribute(_ name: String, in attributes: String) -> String? {
        guard let expression = try? NSRegularExpression(
            pattern: "\\b\(NSRegularExpression.escapedPattern(for: name))\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']",
            options: [.caseInsensitive]
        ) else { return nil }
        let nsAttributes = attributes as NSString
        guard let match = expression.firstMatch(
            in: attributes,
            range: NSRange(location: 0, length: nsAttributes.length)
        ), match.numberOfRanges > 1 else { return nil }
        return nsAttributes.substring(with: match.range(at: 1))
    }
}

// MARK: - The design surface

/// The one place a Juno Design document becomes a design on the Mac.
///
/// **Why it is a view of its own.** Two surfaces hold a design — the chat canvas
/// above, and the artifacts library in ``DesktopArtifactsScreen`` — and until
/// this view existed only the first of them knew what a design was. The library
/// sent every artifact through `NativeArtifactPreview`, whose `.design` branch is
/// `escapedSourceDocument`, so opening a stored design from the library printed
/// its `DesignDocument` JSON in a monospaced dump while opening the *same*
/// document from the chat it came out of showed the editor. A design is the same
/// design wherever it was opened from; one view is how that stays true, and it is
/// the shape the phone already settled on in `JunoMobileArtifactBody`.
///
/// The document is decoded here, natively, before the editor ever sees it: a body
/// that is not a valid `DesignDocument` — or was written by a newer build of Juno
/// — is refused with a stated reason rather than handed to a web view that would
/// render an empty canvas indistinguishable from a document whose contents were
/// lost. The phone decodes in the same order, for the same reason.
struct DesktopDesignSurface: View {
    /// The stored `DesignDocument` JSON.
    ///
    /// Read once, at the identity this view is given. Later values are ignored on
    /// purpose: while the editor is open it is the authority on the document, and
    /// re-reading `content` would fight the very edits it just reported. A caller
    /// that means "different document" says so with `.id(_:)`.
    let content: String
    /// Whether the editor refuses edits. A caller with nowhere to put an edit
    /// passes `true` rather than accepting one and dropping it.
    let readOnly: Bool
    /// Each accepted transaction, re-encoded as the artifact body. Never called
    /// while `readOnly`.
    var onEdit: ((String) -> Void)?

    /// Created once per document. Held here rather than rebuilt on every render,
    /// because rebuilding reloads the bundle and would discard the editor's
    /// viewport, selection and undo stack on each keystroke elsewhere in the
    /// window.
    @State private var host: DesktopDesignEditorHost?
    @State private var openError: String?
    /// An edit the editor made and this view could not turn back into an artifact
    /// body. See ``editWarning`` for why it is a banner and not a replacement.
    @State private var editError: String?

    var body: some View {
        surface
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .top) { editWarning }
            .accessibilityIdentifier("juno.desktop.design-surface")
    }

    /// An edit that cannot be encoded, said out loud.
    ///
    /// `JSONEncoder` refuses a non-conforming float, and a design carries plenty
    /// of them — x, y, width, opacity, rotation — so a degenerate transform in the
    /// editor can produce a document that will not serialise. Swallowing that
    /// would leave the reader dragging shapes around a canvas whose Save button
    /// never lights and never says why.
    ///
    /// It is drawn *over* the editor rather than in place of it, for the same
    /// reason the host's own failures are: the work is still on screen, and
    /// replacing the canvas with a notice would be the one action guaranteed to
    /// lose it.
    @ViewBuilder
    private var editWarning: some View {
        if let editError {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.triangleAlert, size: 16)
                        .foregroundStyle(Color.junoCaution)
                        .accessibilityHidden(true)
                    Text("This edit can\u{2019}t be saved: \(editError)")
                        .junoCaption()
                        .lineLimit(2)
                        .frame(maxWidth: 420, alignment: .leading)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome()
            }
            .padding(.top, JunoSpace.cozy)
            .accessibilityIdentifier("juno.desktop.design-surface.edit-error")
        }
    }

    @ViewBuilder
    private var surface: some View {
        if let openError {
            JunoEmptyState(title: "This design can\u{2019}t be opened", message: openError, icon: .error)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let host {
            // The failure is drawn *over* the web view rather than instead of it:
            // the host is what reports the failure, so tearing it down to display
            // the report would also destroy the thing that has more to say.
            ZStack {
                DesktopDesignEditorView(host: host)
                switch host.status {
                case .loading:
                    ProgressView().controlSize(.small)
                case .unavailable(let reason), .failed(let reason):
                    JunoEmptyState(title: "Design editor unavailable", message: reason, icon: .error)
                        .background(Color.junoCanvasWarm)
                case .ready:
                    EmptyView()
                }
            }
        } else {
            // One frame, between the first layout pass and the decode landing.
            Color.clear.onAppear(perform: open)
        }
    }

    private func open() {
        guard host == nil, openError == nil else { return }
        do {
            let document = try DesignDocumentCodec.load(Data(content.utf8))
            let editor = DesktopDesignEditorHost(document: document, readOnly: readOnly)
            if !readOnly, let onEdit {
                // Re-encoded through the same codec the website writes with —
                // sorted keys, no escaped slashes — so a document that came back
                // untouched produces the same bytes it arrived as, and a save of a
                // design nobody edited cannot manufacture a version whose diff
                // shows nothing.
                editor.onTransaction = { document, _, _ in
                    do {
                        let data = try DesignDocumentCodec.encode(document)
                        onEdit(String(decoding: data, as: UTF8.self))
                        editError = nil
                    } catch {
                        editError = error.localizedDescription
                    }
                }
            }
            host = editor
        } catch {
            // `DesignDocumentCodec.Failure` writes its own sentence; anything else
            // is a programming error and reads better raw than paraphrased.
            openError = (error as? DesignDocumentCodec.Failure)?.description ?? "\(error)"
        }
    }
}

// MARK: - Saving the source

private struct DesktopChatArtifactDownload {
    let document: DesktopChatArtifactDocument
    let name: String
}

/// Carries the artifact's own source so `.fileExporter` — the system's save
/// flow, with its sandbox grant and its replace confirmation — does the writing
/// rather than a bare `NSSavePanel` and a `try?`.
private struct DesktopChatArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }

    let text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        let data = configuration.file.regularFileContents ?? Data()
        text = String(decoding: data, as: UTF8.self)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
