import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import Observation
import SwiftUI

// MARK: - What the chat made, and what it used

/// The transcript, read as an index: a line-for-line port of the web's
/// `readSession()` (`session-outputs.tsx`).
///
/// **Two lists, and the split is the point.** Outputs outlive the
/// conversation — an artifact, a generated picture. "Used in this session"
/// is provenance: the uploads, the searches, the remembered facts and the
/// connectors that went into the answers.
///
/// **It derives, it does not fetch**, and nothing in it is a claim the
/// transcript cannot back: a Web search row appears because a turn carried
/// sources or a search, never because the model was allowed to search.
struct ChatSessionOutputs: Equatable {
    struct Tile: Identifiable, Equatable {
        let id: String
        /// The artifact's identifier, which the canvas opens. Nil for
        /// generated media.
        let identifier: String?
        let title: String
        /// What kind of thing it is, in the reader's words.
        let label: String
        let kind: NativeArtifactKind
        let language: String?
        /// The source a tile shows an excerpt of; nil for a design and for
        /// media.
        let preview: String?
        /// A design's stored id and version: its tile is the server's picture
        /// of its first page, never its JSON.
        let poster: Poster?
        /// Generated media, which opens in Quick Look.
        let attachment: NativeChatAttachment?
        let sortKey: Date

        struct Poster: Equatable {
            let artifactID: String
            let version: Int
        }
    }

    struct UsedRow: Identifiable, Equatable {
        let id: String
        let icon: JunoIcon
        let label: String
        /// The specific thing — a name, a count. Absent rows still render.
        let detail: String?
        /// The files behind an Uploads row, each openable.
        var files: [NativeChatAttachment] = []
    }

    var outputs: [Tile]
    var used: [UsedRow]

    var isEmpty: Bool { outputs.isEmpty && used.isEmpty }

    /// `TYPE_LABEL`, in the reader's words rather than the enum's.
    static func typeLabel(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .markdown: "Doc"
        case .html: "Web page"
        case .react: "Component"
        case .code: "Code"
        case .svg: "Image"
        case .mermaid: "Diagram"
        case .design: "Design"
        case .spreadsheet: "Spreadsheet"
        case .document: "Document"
        case .presentation: "Deck"
        }
    }

    /// One pass over the messages.
    ///
    /// - Parameter modelName: the catalogue's name for a model id — the web's
    ///   `resolveModel(id)?.name ?? id`.
    static func read(
        artifacts: [NativeArtifact],
        messages: [NativeChatMessage],
        modelName: (String) -> String = junoDisplayModelName
    ) -> ChatSessionOutputs {
        var outputs: [Tile] = artifacts.map { artifact in
            let label: String = if artifact.kind == .code, let language = artifact.language, !language.isEmpty {
                language
            } else {
                typeLabel(artifact.kind)
            }
            let content = artifact.currentContent ?? ""
            return Tile(
                id: artifact.id,
                identifier: artifact.identifier,
                title: artifact.title,
                label: label,
                kind: artifact.kind,
                language: artifact.language,
                preview: artifact.kind == .design || content.isEmpty ? nil : content,
                poster: artifact.kind == .design
                    ? Tile.Poster(artifactID: artifact.id, version: artifact.currentVersion)
                    : nil,
                attachment: nil,
                sortKey: artifact.updatedAt
            )
        }

        var uploads: [NativeChatAttachment] = []
        // Which model actually answered, in order of first appearance: the
        // turn's own model, not the conversation's sticky selection.
        var models: [String] = []
        var searchTurns = 0
        var searchSources = Set<String>()
        var memories = Set<String>()
        var memorySubject: String?
        var connectors: [String] = []

        for message in messages {
            for attachment in message.attachments {
                if message.role == .user {
                    if !uploads.contains(where: { $0.id == attachment.id }) { uploads.append(attachment) }
                    continue
                }
                // An assistant attachment is generated media — the only
                // output that is bytes rather than source.
                if attachment.kind.uppercased() == "IMAGE" {
                    outputs.append(
                        Tile(
                            id: attachment.id,
                            identifier: nil,
                            title: attachment.fileName,
                            label: "Image",
                            kind: .svg,
                            language: nil,
                            preview: nil,
                            poster: nil,
                            attachment: attachment,
                            sortKey: message.createdAt
                        )
                    )
                }
            }

            if message.role == .assistant, let model = message.model, !model.isEmpty, !models.contains(model) {
                models.append(model)
            }

            if !message.sources.isEmpty {
                searchTurns += 1
                for source in message.sources { searchSources.insert(source.url.absoluteString) }
            }
            for event in message.activity {
                if event.kind == .search, message.sources.isEmpty { searchTurns += 1 }
                if event.kind == .visit, let url = event.url, !url.isEmpty { searchSources.insert(url) }
                for receipt in event.memory {
                    memories.insert(receipt.id)
                    if memorySubject == nil, let category = receipt.category, !category.isEmpty {
                        memorySubject = category
                    }
                }
                if event.kind == .tool, let server = event.tool?.server, !server.isEmpty, !connectors.contains(server) {
                    connectors.append(server)
                }
            }
        }

        outputs.sort { $0.sortKey > $1.sortKey }

        var used: [UsedRow] = []
        if !models.isEmpty {
            let names = models.map(modelName)
            used.append(
                UsedRow(
                    id: "models",
                    icon: .models,
                    label: names.count == 1 ? "Model" : "Models",
                    detail: names.count <= 2 ? names.joined(separator: " · ") : "\(names[0]) +\(names.count - 1)"
                )
            )
        }
        if !uploads.isEmpty {
            used.append(
                UsedRow(
                    id: "uploads",
                    icon: .attach,
                    label: "Uploads",
                    detail: uploads.count == 1 ? uploads[0].fileName : "\(uploads.count) files",
                    files: uploads
                )
            )
        }
        if searchTurns > 0 || !searchSources.isEmpty {
            used.append(
                UsedRow(
                    id: "search",
                    icon: .web,
                    label: "Web search",
                    detail: searchSources.isEmpty
                        ? nil
                        : "\(searchSources.count) \(searchSources.count == 1 ? "source" : "sources")"
                )
            )
        }
        if !memories.isEmpty {
            used.append(
                UsedRow(
                    id: "memory",
                    icon: .memory,
                    label: "Memory",
                    detail: memorySubject.map { "Read · \($0)" }
                        ?? "Read · \(memories.count) \(memories.count == 1 ? "fact" : "facts")"
                )
            )
        }
        if !connectors.isEmpty {
            used.append(
                UsedRow(
                    id: "connectors",
                    icon: .connections,
                    label: connectors.count == 1 ? "Connector" : "Connectors",
                    detail: connectors.count <= 2 ? connectors.joined(separator: " · ") : "\(connectors.count) used"
                )
            )
        }

        return ChatSessionOutputs(outputs: outputs, used: used)
    }

    /// A conversation's stored artifacts, one per identifier — the one further
    /// along when a streamed row and its synced self meet, as the transcript's
    /// resolver keeps it.
    static func conversationArtifacts(_ all: [NativeArtifact], conversationID: String) -> [NativeArtifact] {
        var byIdentifier: [String: NativeArtifact] = [:]
        var order: [String] = []
        for artifact in all where artifact.conversationID == conversationID {
            if let existing = byIdentifier[artifact.identifier] {
                if existing.currentVersion >= artifact.currentVersion { continue }
            } else {
                order.append(artifact.identifier)
            }
            byIdentifier[artifact.identifier] = artifact
        }
        return order.compactMap { byIdentifier[$0] }
    }

    /// The web's `extensionOf`: the file's own extension when it is short
    /// and plain, else the MIME subtype, at most five characters.
    static func extensionLabel(of attachment: NativeChatAttachment) -> String {
        let name = attachment.fileName
        if let dot = name.lastIndex(of: "."), dot > name.startIndex, name.index(after: dot) < name.endIndex {
            let raw = String(name[name.index(after: dot)...])
            if raw.count <= 5, raw.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) {
                return raw.uppercased()
            }
        }
        let subtype = attachment.mimeType.split(separator: "/").dropFirst().first.map(String.init) ?? attachment.mimeType
        let head = subtype.split(whereSeparator: { ".+;".contains($0) }).first.map(String.init) ?? ""
        return String((head.isEmpty ? "FILE" : head).prefix(5)).uppercased()
    }
}

// MARK: - Requests into the conversation

/// What the toolbar's popovers and the ⌘K panel ask the conversation column
/// to do: open an artifact in its canvas dock, or a file in Quick Look.
///
/// The column owns both (a presentation hoisted there outlives the rows that
/// asked for it), and it sits below the toolbar that raises these, so the
/// request travels down as a token the column consumes once.
@MainActor
@Observable
final class DesktopChatOutputRequests {
    struct Request: Identifiable, Equatable {
        enum Kind: Equatable {
            /// Open this artifact's canvas, in this conversation.
            case artifact(NativeMessageContent.ArtifactReference, conversationID: String)
            case quickLook(NativeChatAttachment)
        }

        let id = UUID()
        let kind: Kind
    }

    private(set) var pending: Request?

    func post(_ kind: Request.Kind) {
        pending = Request(kind: kind)
    }

    func consume(_ request: Request) {
        guard pending?.id == request.id else { return }
        pending = nil
    }

    /// A reference the canvas can open, from a stored row.
    static func reference(for artifact: NativeArtifact) -> NativeMessageContent.ArtifactReference {
        NativeMessageContent.ArtifactReference(
            identifier: artifact.identifier,
            title: artifact.title,
            kind: artifact.kind.rawValue.lowercased(),
            language: artifact.language,
            streaming: false,
            content: artifact.currentContent ?? ""
        )
    }
}

extension View {
    /// The conversation column's half of ``DesktopChatOutputRequests``: runs
    /// a pending request once the column is showing its conversation, a turn
    /// after the selection change that brought it here has closed whatever
    /// the dock held.
    func desktopOutputRequests(
        conversationID: String?,
        openArtifact: @escaping (NativeMessageContent.ArtifactReference) -> Void,
        quickLook: @escaping (NativeChatAttachment) -> Void
    ) -> some View {
        modifier(
            DesktopOutputRequestsConsumer(
                conversationID: conversationID,
                openArtifact: openArtifact,
                quickLook: quickLook
            )
        )
    }
}

private struct DesktopOutputRequestsConsumer: ViewModifier {
    let conversationID: String?
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    let quickLook: (NativeChatAttachment) -> Void

    @Environment(DesktopChatOutputRequests.self) private var requests: DesktopChatOutputRequests?

    private var key: String { "\(requests?.pending?.id.uuidString ?? "-")|\(conversationID ?? "")" }

    func body(content: Content) -> some View {
        content.onChange(of: key, initial: true) { _, _ in
            guard let requests, let request = requests.pending else { return }
            switch request.kind {
            case .artifact(let reference, let conversation):
                guard conversation == conversationID else { return }
                requests.consume(request)
                Task { @MainActor in openArtifact(reference) }
            case .quickLook(let attachment):
                requests.consume(request)
                Task { @MainActor in quickLook(attachment) }
            }
        }
    }
}

// MARK: - The toolbar chip's model

/// Everything the Outputs chip and its popover need, computed by the window.
struct DesktopOutputsContext {
    var outputs = ChatSessionOutputs(outputs: [], used: [])
    var sender: (any NativeAuthenticatedRequestSending)?
    var accountID: AccountID?
    var openArtifact: (ChatSessionOutputs.Tile) -> Void = { _ in }
    var quickLook: (NativeChatAttachment) -> Void = { _ in }
}

/// The chip in the Share/Private capsule: `ph.filetext` and a rolling count
/// when the chat made something. Its label names what it holds.
struct DesktopOutputsToolbarButton: View {
    let context: DesktopOutputsContext
    @Binding var isPresented: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var count: Int { context.outputs.outputs.count }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoSymbol(.file)
                if count > 0 {
                    Text("\(count)")
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint), value: count)
                }
            }
            .contentShape(.rect)
        }
        .help("Outputs")
        .accessibilityLabel(count > 0 ? "Outputs — \(count) in this chat" : "What this chat used")
        .accessibilityIdentifier("juno.desktop.outputs")
        .onDisappear { isPresented = false }
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            DesktopOutputsPopover(
                outputs: context.outputs,
                openArtifact: { tile in
                    isPresented = false
                    context.openArtifact(tile)
                },
                quickLook: { attachment in
                    isPresented = false
                    context.quickLook(attachment)
                }
            )
            .modifier(TranscriptMediaScope(sender: context.sender, accountID: context.accountID ?? Self.noAccount))
            .modifier(DesignPreviewScope(sender: context.sender, accountID: context.accountID ?? Self.noAccount))
        }
    }

    private static let noAccount = try! AccountID("signed-out")
}

// MARK: - The popover

/// The Outputs popover (Phase 3 brief, B3; register P3-17): what this chat
/// made, then what it used.
///
/// Width 336 and a height computed from its rows — never measured at run
/// time — capped at 400, with a scroller inside for the rest.
///
/// **The signature detail:** one output fills the width as a landscape tile,
/// so a single result never reads as a grid that failed to load the rest.
struct DesktopOutputsPopover: View {
    let outputs: ChatSessionOutputs
    let openArtifact: (ChatSessionOutputs.Tile) -> Void
    let quickLook: (NativeChatAttachment) -> Void

    static let width: CGFloat = 336
    static let maxHeight: CGFloat = 400
    static let padding: CGFloat = 16
    private static let columnGap: CGFloat = 12
    private static let rowGap: CGFloat = 16
    private static let headingLine: CGFloat = 24
    private static let tileText: CGFloat = 8 + 20 + 16
    private static let usedRow: CGFloat = 32
    private static let fileRow: CGFloat = 28

    /// The popover's height for `outputs`: a pure function of its rows.
    static func height(for outputs: ChatSessionOutputs) -> CGFloat {
        var height = 2 * padding
        let inner = width - 2 * padding
        if !outputs.outputs.isEmpty {
            height += headingLine + JunoSpace.cozy
            if outputs.outputs.count == 1 {
                height += inner * 9 / 16 + tileText
            } else {
                let tile = (inner - columnGap) / 2
                let rows = CGFloat((outputs.outputs.count + 1) / 2)
                height += rows * (tile * 3 / 4 + tileText) + (rows - 1) * rowGap
            }
        }
        if !outputs.used.isEmpty {
            if !outputs.outputs.isEmpty { height += JunoSpace.roomy + 1 + JunoSpace.regular }
            height += headingLine + JunoSpace.snug
            for row in outputs.used {
                height += usedRow
                if !row.files.isEmpty {
                    height += CGFloat(min(row.files.count, 8)) * fileRow + JunoSpace.tight
                    if row.files.count > 8 { height += 24 }
                }
            }
        }
        return min(maxHeight, height.rounded(.up))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !outputs.outputs.isEmpty {
                    outputsSection
                }
                if !outputs.used.isEmpty {
                    if !outputs.outputs.isEmpty {
                        Rectangle()
                            .fill(Color.junoBorder.opacity(0.6))
                            .frame(height: 1)
                            .padding(.top, JunoSpace.roomy)
                            .padding(.bottom, JunoSpace.regular)
                    }
                    usedSection
                }
            }
            .padding(Self.padding)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: Self.width, height: Self.height(for: outputs), alignment: .top)
        .accessibilityIdentifier("juno.desktop.outputs-popover")
    }

    // MARK: Outputs

    private var outputsSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Outputs")
                .junoType(JunoType.body.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .frame(height: Self.headingLine, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if outputs.outputs.count == 1, let tile = outputs.outputs.first {
                DesktopOutputTileView(tile: tile, wide: true, open: action(for: tile))
            } else {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: Self.columnGap, alignment: .top),
                        GridItem(.flexible(), spacing: Self.columnGap, alignment: .top),
                    ],
                    alignment: .leading,
                    spacing: Self.rowGap
                ) {
                    ForEach(outputs.outputs) { tile in
                        DesktopOutputTileView(tile: tile, wide: false, open: action(for: tile))
                    }
                }
            }
        }
    }

    /// A tile is a button only when there is somewhere to go.
    private func action(for tile: ChatSessionOutputs.Tile) -> (() -> Void)? {
        if tile.identifier != nil { return { openArtifact(tile) } }
        if let attachment = tile.attachment { return { quickLook(attachment) } }
        return nil
    }

    // MARK: Used

    private var usedSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Used in this session")
                .junoType(JunoType.body.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .frame(height: Self.headingLine, alignment: .leading)
                .padding(.bottom, JunoSpace.snug)
                .accessibilityAddTraits(.isHeader)
            ForEach(outputs.used) { row in
                HStack(spacing: JunoSpace.close) {
                    JunoIconView(row.icon, size: 16)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .accessibilityHidden(true)
                    Text(row.label)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize()
                    Spacer(minLength: JunoSpace.snug)
                    if let detail = row.detail {
                        Text(detail)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .frame(height: Self.usedRow)
                .accessibilityElement(children: .combine)
                if !row.files.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(row.files.prefix(8), id: \.id) { file in
                            DesktopOutputFileRow(file: file) { quickLook(file) }
                        }
                        if row.files.count > 8 {
                            Text("+\(row.files.count - 8) more in the chat")
                                .junoFont(size: 11, relativeTo: .caption2)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .frame(height: 24, alignment: .leading)
                                .padding(.horizontal, JunoSpace.tight)
                        }
                    }
                    .padding(.leading, JunoSpace.section)
                    .padding(.bottom, JunoSpace.tight)
                }
            }
        }
    }
}

/// One upload, openable: its extension, its name and "Open".
private struct DesktopOutputFileRow: View {
    let file: NativeChatAttachment
    let open: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.snug) {
                Text(ChatSessionOutputs.extensionLabel(of: file))
                    .junoType(.micro)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.tight)
                    .frame(minWidth: 32, minHeight: 18)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                            .fill(Color.junoSecondary)
                    )
                Text(file.fileName)
                    .junoType(.caption)
                    .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Open")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.horizontal, JunoSpace.tight)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoHover)
                    .opacity(isHovering ? 1 : 0)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
        .onHover { isHovering = $0 }
        .help("Open \(file.fileName)")
        .accessibilityLabel("Open \(file.fileName)")
    }
}

/// One tile: a picture of the thing, its name, and what kind of thing it is.
private struct DesktopOutputTileView: View {
    let tile: ChatSessionOutputs.Tile
    let wide: Bool
    let open: (() -> Void)?

    @State private var isHovering = false

    var body: some View {
        if let open {
            Button(action: open) { content }
                .buttonStyle(.plain)
                .contentShape(.rect)
                .onHover { isHovering = $0 }
                .help("Open \(tile.title)")
                .accessibilityLabel("\(tile.title), \(tile.label)")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The ratio is the tile's, whatever the picture inside it is.
            Color.clear
                .aspectRatio(wide ? 16 / 9 : 4 / 3, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .overlay { DesktopOutputPreview(tile: tile) }
                .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
                }
            Text(tile.title.isEmpty ? "Untitled" : tile.title)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(height: 20, alignment: .bottomLeading)
                .padding(.top, JunoSpace.snug)
            Text(tile.label)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .frame(height: 16, alignment: .topLeading)
        }
        .opacity(isHovering ? 0.8 : 1)
        .animation(JunoMotion.fast, value: isHovering)
        .contentShape(.rect)
    }
}

/// What an artifact looks like at tile size — the web's `ArtifactPreview`:
/// its first twenty lines of source, set in the micro rung under a fade; a
/// picture for an SVG and a design's poster; the picture itself for
/// generated media; the kind's glyph when there is nothing to show.
///
/// Never a live render: a popover of web views booting a document each is
/// the wrong price for a thumbnail, and an excerpt is honest about being one.
private struct DesktopOutputPreview: View {
    let tile: ChatSessionOutputs.Tile

    @Environment(\.junoTranscriptMedia) private var media
    @Environment(\.junoDesignPreviews) private var designs

    var body: some View {
        ZStack {
            Color.junoCanvas
            if let attachment = tile.attachment {
                mediaPicture(attachment)
            } else if let poster = tile.poster {
                designPoster(poster)
            } else if let preview = tile.preview {
                DesktopArtifactExcerpt(source: preview, kind: tile.kind)
            } else {
                glyph
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func mediaPicture(_ attachment: NativeChatAttachment) -> some View {
        Group {
            if case .ready(let image) = media?.imageState(for: attachment) {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFill()
            } else {
                glyph
            }
        }
        .task(id: attachment.id) { await media?.loadImage(attachment) }
    }

    @ViewBuilder
    private func designPoster(_ poster: ChatSessionOutputs.Tile.Poster) -> some View {
        Group {
            if case .ready(let svg) = designs?.designPreviewState(artifactID: poster.artifactID, version: poster.version),
                let image = Self.svgImage(svg)
            {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(JunoSpace.cozy)
            } else {
                glyph
            }
        }
        .task(id: "\(poster.artifactID)#\(poster.version)") {
            await designs?.loadDesignPreview(artifactID: poster.artifactID, version: poster.version)
        }
    }

    private var glyph: some View {
        JunoIconView(tile.attachment != nil ? .image : DesktopOutputPreview.icon(tile.kind), size: 28)
            .foregroundStyle(Color.junoSecondaryInk)
    }

    /// The web's `GLYPHS` by kind.
    static func icon(_ kind: NativeArtifactKind) -> JunoIcon {
        switch kind {
        case .html: .web
        case .react: .codeBrackets
        case .code: .fileCode
        case .svg: .image
        case .markdown: .file
        case .mermaid: .branch
        case .design: .design
        case .spreadsheet: .grid
        case .document: .file
        case .presentation: .squareStack
        }
    }

    static func svgImage(_ source: String) -> NSImage? {
        DesktopArtifactExcerpt.svgImage(source)
    }
}
