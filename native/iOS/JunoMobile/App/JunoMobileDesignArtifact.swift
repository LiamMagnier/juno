import JunoChatKit
import JunoDesignKit
import JunoDesignSystem
import SwiftUI

/// Reading a Juno Design document on the phone.
///
/// A design artifact used to arrive here as a label and an icon over its raw
/// JSON — the same body ``NativeArtifactSandbox`` escapes for any surface with
/// nowhere to draw it. This screen has somewhere to put it: the drawing, the
/// layers, and the file, decoded by ``DesignDocument`` so nothing on screen can
/// disagree with what was stored.
///
/// **The drawing is the bundled editor, not a second renderer.** A Swift
/// renderer was the other option and it is the wrong one: `src/lib/design/render.ts`
/// draws what `layout.ts` computed, and that includes measuring text to decide
/// where lines break, so a CoreText reimplementation would break them elsewhere
/// and the same document would read one way here and another on the Mac, on the
/// web, and in every export. ``JunoMobileDesignEditorHost`` runs the same bundle
/// the Mac runs, read-only, which cannot drift because it is not a second
/// implementation.
///
/// That host is why this screen changed. It did not work: the bundle completed
/// the ``DesignBridge`` handshake and then threw while mounting, and the failure
/// arrived as WebKit's sanitised "Script error." — a bundle loaded as a
/// subresource of a `file://` document is cross-origin to it, so `window.onerror`
/// reports nothing usable. Asked through React's own root callbacks instead, the
/// exception read "`Tooltip` must be used within `TooltipProvider`": the editor's
/// toolbar is built from Radix tooltips and the host bundle never supplied the
/// provider the website's `providers.tsx` wraps the whole app in. It was never an
/// origin problem, and it was never iOS-specific — the Mac's pane was blank for
/// the same reason and for as long.
///
/// The layer list stays, because it is not a consolation prize: it is the fastest
/// way to check a typo in a button on a phone, and it is searchable and
/// selectable in a way a canvas is not.
struct JunoMobileDesignArtifactBody: View {
    let content: String
    let readOnly: Bool
    var onEdit: ((String) -> Void)?

    /// Which of the three readings is showing.
    private enum Reading: Hashable {
        case drawing
        case layers
        case source
    }

    /// Decoded once. A body that is not a valid document — or that was written
    /// by a newer build of Juno — is refused with the reason stated rather than
    /// summarised into a plausible-looking empty outline.
    @State private var decoded: Result<DesignDocument, Error>?
    @State private var reading = Reading.drawing
    /// Created once per document, and held here rather than rebuilt on every
    /// render: rebuilding would reload the bundle and throw away the reader's
    /// pan and zoom each time anything above this view changed.
    @State private var host: JunoMobileDesignEditorHost?

    var body: some View {
        VStack(spacing: 0) {
            reader
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            footer
        }
        .onAppear(perform: decode)
        .accessibilityIdentifier("juno.mobile.design")
    }

    @ViewBuilder
    private var reader: some View {
        switch reading {
        case .source:
            ScrollView([.horizontal, .vertical]) {
                Text(content)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        case .drawing, .layers:
            switch decoded {
            case .success(let document):
                if reading == .layers {
                    outline(document)
                } else {
                    drawing
                }
            case .failure(let error):
                ContentUnavailableView {
                    Label("This design can\u{2019}t be opened", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(reason(for: error))
                } actions: {
                    Button("Show source") { reading = .source }
                }
            case nil:
                // One frame, between `onAppear` and the decode landing.
                Color.clear
            }
        }
    }

    /// The canvas.
    ///
    /// A failure from the editor is shown *over* the web view rather than
    /// instead of it: the host is what reports the failure, so tearing it down to
    /// display the report would also destroy the thing that has more to say. The
    /// way out is the layer list, which needs nothing from the bundle.
    @ViewBuilder
    private var drawing: some View {
        if let host {
            ZStack {
                JunoMobileDesignEditorView(host: host)
                switch host.status {
                case .loading:
                    ProgressView().controlSize(.small)
                case .unavailable(let reason), .failed(let reason):
                    ContentUnavailableView {
                        Label("Design editor unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(reason)
                    } actions: {
                        Button("Show layers") { reading = .layers }
                    }
                    .background(Color.junoSurface)
                case .ready:
                    EmptyView()
                }
            }
            .accessibilityIdentifier("juno.mobile.design.canvas")
        } else {
            Color.clear
        }
    }

    private func outline(_ document: DesignDocument) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(document.pages, id: \.id) { page in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(page.name)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .junoMetaInk()
                            .textCase(.uppercase)
                            .accessibilityAddTraits(.isHeader)

                        let rows = JunoMobileDesignOutline.rows(of: page, in: document)
                        if rows.isEmpty {
                            Text("This page is empty.")
                                .font(.callout)
                                .junoSecondaryInk()
                        } else {
                            ForEach(rows) { row in layer(row) }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .accessibilityIdentifier("juno.mobile.design.outline")
    }

    /// One layer. The name, its kind, and — for a text layer — the words, which
    /// are the part of a design somebody checks on a phone: a typo in a button
    /// is legible in a list and illegible on a thumbnail.
    private func layer(_ row: JunoMobileDesignOutline.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: row.glyph)
                .font(.system(size: 12))
                .junoMetaInk()
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.system(size: 14))
                    .lineLimit(1)
                if let characters = row.characters {
                    Text(characters)
                        .font(.callout)
                        .junoSecondaryInk()
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if row.hidden {
                Image(systemName: "eye.slash")
                    .font(.system(size: 11))
                    .junoMetaInk()
                    .accessibilityLabel("Hidden")
            }
        }
        // Indented by depth, so the nesting the document describes is the
        // nesting on screen rather than a flat list that loses it.
        .padding(.leading, CGFloat(row.depth) * 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The three readings, in the order a reader wants them: what it looks like,
    /// what is in it, what it is.
    ///
    /// At the bottom rather than the top because it belongs to the document and
    /// not to the artifact chrome already stacked above this view — and because
    /// the canvas is what the thumb should not be covering.
    private var footer: some View {
        HStack(spacing: 10) {
            JunoMobileSegmented(
                options: [
                    .init(Reading.drawing, "Design"),
                    .init(Reading.layers, "Layers"),
                    .init(Reading.source, "Source"),
                ],
                selection: $reading,
                accessibilityLabel: "Design view"
            )
            .accessibilityIdentifier("juno.mobile.design.view-mode")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.junoSurface.opacity(0.5))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    /// Decodes natively, before the editor ever sees the body.
    ///
    /// The order matters: a body that is not a valid `DesignDocument` is refused
    /// here with a stated reason, rather than handed to a web view that would
    /// draw an empty canvas indistinguishable from a document whose contents were
    /// lost. The Mac's canvas makes the same call in the same order.
    private func decode() {
        guard decoded == nil else { return }
        let result = Result { try DesignDocumentCodec.load(Data(content.utf8)) }
        decoded = result
        if case .success(let document) = result {
            let editor = JunoMobileDesignEditorHost(document: document, readOnly: readOnly)
            if !readOnly, let onEdit {
                editor.onTransaction = { document, _, _ in
                    do {
                        let data = try DesignDocumentCodec.encode(document)
                        onEdit(String(decoding: data, as: UTF8.self))
                    } catch {
                        // The host reports bridge failures over the same status
                        // surface; a codec failure is surfaced by the native
                        // document shell when it cannot produce a draft.
                    }
                }
            }
            host = editor
        }
    }

    private func reason(for error: Error) -> String {
        (error as? DesignDocumentCodec.Failure)?.description ?? error.localizedDescription
    }
}

/// Flattens a page into the rows the reader draws.
///
/// Separated from the view because it is the part with an answer to check: the
/// traversal has to follow the document's `children` arrays rather than the
/// `nodes` dictionary's order, which is unordered, and it has to survive a
/// document that names a child it does not contain — a state ``DesignDocumentCodec``
/// rejects at the door, but which this must not crash on if it ever arrives by
/// another route.
enum JunoMobileDesignOutline {
    struct Row: Identifiable {
        let id: String
        let name: String
        let depth: Int
        let glyph: String
        /// The words a text layer contains. Nil for every other type.
        let characters: String?
        let hidden: Bool
    }

    static func rows(of page: DesignPage, in document: DesignDocument) -> [Row] {
        var rows: [Row] = []
        var visited: Set<String> = []
        for childID in page.children {
            append(childID, depth: 0, document: document, visited: &visited, into: &rows)
        }
        return rows
    }

    private static func append(
        _ nodeID: String,
        depth: Int,
        document: DesignDocument,
        visited: inout Set<String>,
        into rows: inout [Row]
    ) {
        // A cycle is impossible in a validated document and fatal to a recursive
        // walk, so it is refused here rather than trusted upstream.
        guard let node = document.nodes[nodeID], visited.insert(nodeID).inserted else { return }
        rows.append(
            Row(
                id: node.id,
                name: node.name,
                depth: depth,
                glyph: glyph(for: node.type),
                characters: node.type == .text ? node.characters : nil,
                hidden: !node.visible
            )
        )
        for childID in node.children ?? [] {
            append(childID, depth: depth + 1, document: document, visited: &visited, into: &rows)
        }
    }

    static func glyph(for type: NodeType) -> String {
        switch type {
        case .frame: "rectangle.inset.filled"
        case .group: "square.on.square"
        case .rectangle: "rectangle"
        case .ellipse: "circle"
        case .line: "line.diagonal"
        case .path: "scribble"
        case .text: "textformat"
        case .image: "photo"
        case .component: "square.grid.2x2"
        case .instance: "square.grid.2x2.fill"
        }
    }
}

// MARK: - Which view of an artifact

/// The three ways the phone can show one artifact. The Mac's
/// `DesktopArtifactViewMode` is the same idea; the two are separate only because
/// the apps share no view layer.
///
/// A type of its own rather than `NativeArtifactDisplayMode` plus a flag, because
/// the switch above the body has to name the view the reader is *in*: a two-way
/// Preview/Source control lit on one of its halves while a live canvas is on
/// screen describes neither of them.
enum JunoMobileArtifactViewMode: String, CaseIterable, Identifiable, Hashable {
    case preview
    case source
    /// ``ArtifactCanvasView``: the code, the running document, and the page's own
    /// console — including the resources the sandbox refused to load, which is the
    /// single most common reason an artifact renders blank and the one thing the
    /// phone previously had no way at all to show.
    case canvas

    var id: String { rawValue }

    var title: String {
        switch self {
        case .preview: "Preview"
        case .source: "Source"
        case .canvas: "Canvas"
        }
    }

    var displayMode: NativeArtifactDisplayMode {
        self == .source ? .source : .preview
    }

    /// The modes worth offering for `kind`, in the order they are shown. A single
    /// element means "no switch": the caller draws the body and no control, which
    /// is what this screen already did for a code artifact.
    static func available(for kind: NativeArtifactKind) -> [JunoMobileArtifactViewMode] {
        var modes: [JunoMobileArtifactViewMode] = []
        if kind.supportsRenderedPreview { modes.append(.preview) }
        modes.append(.source)
        if kind.supportsLiveCanvas { modes.append(.canvas) }
        return modes
    }
}

/// An artifact's body, whichever kind it is.
///
/// One place decides that a design document goes to the design reader, that a
/// runnable one can go to the live canvas, and that everything else goes to the
/// shared preview — because both artifact screens (the stored one and the copy
/// carried in a reply) ask the same question, and answering it twice is how they
/// drift apart.
struct JunoMobileArtifactBody: View {
    let kind: NativeArtifactKind
    let content: String
    let mode: JunoMobileArtifactViewMode
    let readOnly: Bool
    var onEdit: ((String) -> Void)? = nil

    init(
        kind: NativeArtifactKind,
        content: String,
        mode: JunoMobileArtifactViewMode,
        readOnly: Bool = true,
        onEdit: ((String) -> Void)? = nil
    ) {
        self.kind = kind
        self.content = content
        self.mode = mode
        self.readOnly = readOnly
        self.onEdit = onEdit
    }

    var body: some View {
        if kind.isDesignDocument {
            JunoMobileDesignArtifactBody(content: content, readOnly: readOnly, onEdit: onEdit)
        } else if mode == .canvas {
            JunoMobileArtifactLiveCanvas(kind: kind, content: content)
        } else {
            NativeArtifactPreview(kind: kind, content: content, mode: mode.displayMode)
        }
    }
}

/// Hosts one ``ArtifactCanvasModel`` for the artifact it was given.
///
/// **The model is `@State`, and callers key the body on the artifact.** It holds
/// the console transcript, the error count and the bridge's connection state *of
/// the loaded document*; reused across two artifacts it would show the first
/// one's uncaught exception under the second one's code. Both call sites already
/// apply an `.id(_:)` for the design editor's sake, and it covers this too.
///
/// `.tabbed`, always: a phone has no width for a split, and the canvas's own
/// layout control is still there on an iPad in landscape.
///
/// No ``ArtifactCanvasRuntime`` is passed because none ships, so a React artifact
/// says which runtime is missing rather than showing an empty white pane.
private struct JunoMobileArtifactLiveCanvas: View {
    private let content: String
    @State private var model: ArtifactCanvasModel

    init(kind: NativeArtifactKind, content: String) {
        self.content = content
        _model = State(initialValue: ArtifactCanvasModel(kind: kind, layout: .tabbed))
    }

    var body: some View {
        ArtifactCanvasView(content: content, model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
