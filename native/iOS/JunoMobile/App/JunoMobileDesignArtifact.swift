import JunoChatKit
import JunoDesignKit
import JunoDesignSystem
import SwiftUI

/// Reading a Juno Design document on the phone.
///
/// A design artifact used to arrive here as a label and an icon over its raw
/// JSON — the same body ``NativeArtifactSandbox`` escapes for any surface with
/// nowhere to draw it. This is that surface with somewhere to put the document:
/// what it is, what is in it, and every word it contains, decoded by
/// ``DesignDocument`` so nothing on screen can disagree with the file.
///
/// **What this deliberately is not: the drawing.** Two ways to draw one exist
/// and neither belongs on iOS today.
///
/// The first is a Swift renderer. `src/lib/design/render.ts` draws what
/// `layout.ts` computed, and that includes measuring text to decide where lines
/// break; a CoreText reimplementation would break them elsewhere, so the same
/// document would read one way here and another way on the Mac, on the web, and
/// in every export. ``DesignDocument`` says there is one scene model and one
/// engine, and a second renderer is what that rule exists to prevent.
///
/// The second is the Mac's: host the bundled editor read-only in a `WKWebView`,
/// which is the same renderer and therefore cannot drift. That is the right
/// shape and it does not currently work. The bundle loads inside an iOS web
/// view and completes the ``DesignBridge`` handshake — it posts `ready` with the
/// protocol version and the host accepts it — and then throws while mounting the
/// editor for the document it was sent, reporting `failure` with the message
/// WebKit sanitises to "Script error." because the bundle is cross-origin to its
/// own `file://` document. Relaxing the bundle's `script-src` to permit the one
/// `eval` it is refused changes nothing, so that violation is incidental. The
/// fix is in the editor bundle, not on this side, and a canvas that renders
/// "unavailable" every time is worse than no canvas at all — so the drawing is
/// named as living elsewhere rather than promised and withheld.
struct JunoMobileDesignArtifactBody: View {
    let content: String

    /// Decoded once. A body that is not a valid document — or that was written
    /// by a newer build of Juno — is refused with the reason stated rather than
    /// summarised into a plausible-looking empty outline.
    @State private var decoded: Result<DesignDocument, Error>?
    @State private var showsSource = false

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
        if showsSource {
            ScrollView([.horizontal, .vertical]) {
                Text(content)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        } else {
            switch decoded {
            case .success(let document):
                outline(document)
            case .failure(let error):
                ContentUnavailableView {
                    Label("This design can\u{2019}t be opened", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(reason(for: error))
                } actions: {
                    Button("Show source") { showsSource = true }
                }
            case nil:
                // One frame, between `onAppear` and the decode landing.
                Color.clear
            }
        }
    }

    private func outline(_ document: DesignDocument) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(document.pages, id: \.id) { page in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(page.name)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .textCase(.uppercase)
                            .accessibilityAddTraits(.isHeader)

                        let rows = JunoMobileDesignOutline.rows(of: page, in: document)
                        if rows.isEmpty {
                            Text("This page is empty.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
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
                .foregroundStyle(.tertiary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.system(size: 14))
                    .lineLimit(1)
                if let characters = row.characters {
                    Text(characters)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if row.hidden {
                Image(systemName: "eye.slash")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Hidden")
            }
        }
        // Indented by depth, so the nesting the document describes is the
        // nesting on screen rather than a flat list that loses it.
        .padding(.leading, CGFloat(row.depth) * 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Says what this screen is and what it is not, on the same line as the way
    /// out of it. Stated rather than implied: a reader who is told where the
    /// drawing is stops looking for it here.
    private var footer: some View {
        HStack(spacing: 10) {
            Label("Open the drawing on a Mac or on the web", systemImage: "rectangle.on.rectangle")
                .font(.system(size: 12))
                .foregroundStyle(Color.junoMutedForeground)
                .lineLimit(2)
            Spacer(minLength: 8)
            Button(showsSource ? "Layers" : "Source") { showsSource.toggle() }
                .font(.system(size: 13, weight: .medium))
                .accessibilityIdentifier("juno.mobile.design.source-toggle")
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

    private func decode() {
        guard decoded == nil else { return }
        decoded = Result { try DesignDocumentCodec.load(Data(content.utf8)) }
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

/// An artifact's body, whichever kind it is.
///
/// One place decides that a design document goes to the design reader and
/// everything else goes to the shared preview, because both artifact screens —
/// the stored one and the copy carried in a reply — ask the same question and
/// answering it twice is how they drift apart.
struct JunoMobileArtifactBody: View {
    let kind: NativeArtifactKind
    let content: String
    let mode: NativeArtifactDisplayMode

    var body: some View {
        if kind.isDesignDocument {
            JunoMobileDesignArtifactBody(content: content)
        } else {
            NativeArtifactPreview(kind: kind, content: content, mode: mode)
        }
    }
}
