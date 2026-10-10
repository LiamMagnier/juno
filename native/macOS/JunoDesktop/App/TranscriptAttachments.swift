import AVKit
import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Where the pictures come from, and what opening one does

extension EnvironmentValues {
    /// Where the transcript's pictures, pages and files come from: the
    /// session's ``NativeChatMediaLoader``, or the snapshot harness's stills.
    /// Nil draws every picture as unavailable and every page as its extension.
    @Entry var junoTranscriptMedia: (any TranscriptMediaProviding)? = nil
    /// What a click, a context menu or a hover control does with a file. The
    /// conversation column owns all of it — Quick Look, the save panel and the
    /// edit sheet cannot live in a lazily built row (see
    /// ``DesktopConversationView``).
    @Entry var junoTranscriptMediaActions = TranscriptMediaActions()
}

/// The file actions a transcript row can ask for. Each takes the attachment
/// and does the rest — download, panel, sheet — in the column.
struct TranscriptMediaActions {
    /// Click, Space, or Expand: the system's Quick Look panel.
    var quickLook: @MainActor (NativeChatAttachment) -> Void = { _ in }
    var openWithDefaultApp: @MainActor (NativeChatAttachment) -> Void = { _ in }
    /// Save As… and a picture's Download: `NSSavePanel`.
    var saveAs: @MainActor (NativeChatAttachment) -> Void = { _ in }
    /// A generated picture's Edit. Nil where no edit can start — no image
    /// model that edits, a private chat, or nothing to run it through.
    var editImage: (@MainActor (NativeChatAttachment) -> Void)? = nil
}

/// Owns the transcript's media loader for one signed-in account, and hands it
/// to everything below as ``SwiftUI/EnvironmentValues/junoTranscriptMedia``.
///
/// Apply it with `.id(accountID)` so a different account gets a new loader —
/// and with it, an empty cache — rather than the previous account's pictures.
struct TranscriptMediaScope: ViewModifier {
    @State private var loader: NativeChatMediaLoader

    init(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID) {
        _loader = State(initialValue: NativeChatMediaLoader(sender: sender, accountID: accountID))
    }

    func body(content: Content) -> some View {
        content.environment(\.junoTranscriptMedia, loader)
    }
}

/// Whether any control inside a media tile holds keyboard focus — reported
/// up from the button styles, which are the only place `isFocused` describes
/// the button.
struct TranscriptMediaFocusKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

// MARK: - The reader's attachments

/// What the reader sent with a question, above the bubble and on its trailing
/// edge: pictures as themselves, everything else as a page tile — the web's
/// `MessageAttachments` (`components/chat/attachment-tile.tsx`). Wraps rather
/// than scrolling sideways, 8pt apart.
struct UserAttachmentStrip: View {
    let attachments: [NativeChatAttachment]

    var body: some View {
        JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug, alignment: .trailing) {
            ForEach(attachments) { attachment in
                if attachment.isImageKind {
                    SentImageTile(attachment: attachment)
                } else {
                    FileTile(attachment: attachment)
                }
            }
        }
    }
}

/// A sent picture, at the transcript's thumbnail height: 144pt tall, as wide
/// as its shape asks up to 288 (and no narrower than 72), cropped to fill, in
/// a radius-16 frame. Click or Space opens it in Quick Look.
struct SentImageTile: View {
    let attachment: NativeChatAttachment

    @Environment(\.junoTranscriptMedia) private var media
    @Environment(\.junoTranscriptMediaActions) private var actions
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    static let height: CGFloat = 144
    private static let shape = RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)

    private var state: NativeTranscriptImageState { media?.imageState(for: attachment) ?? .failed }
    private var lit: Bool { hovered || snapshotHover }

    /// `h-36 w-auto max-w-[18rem]`: the picture's own shape at 144pt tall,
    /// from the server's measurement or, failing that, the decoded pixels.
    /// A shape nobody knows yet is a square.
    private var width: CGFloat {
        var aspect = attachment.aspectRatio
        if aspect == nil, case .ready(let image) = state, image.height > 0 {
            aspect = CGFloat(image.width) / CGFloat(image.height)
        }
        guard let aspect else { return Self.height }
        return min(max(Self.height * aspect, 72), 288)
    }

    var body: some View {
        Button {
            actions.quickLook(attachment)
        } label: {
            ZStack {
                Self.shape.fill(Color.junoSecondary)
                picture
            }
            .frame(width: width, height: Self.height)
            .clipShape(Self.shape)
            .overlay {
                Self.shape.strokeBorder(
                    lit ? Color.junoForeground.opacity(0.25) : Color.junoBorder.opacity(0.7),
                    lineWidth: 1
                )
            }
            .junoRaisedShadow(lit)
            .contentShape(Self.shape)
        }
        .buttonStyle(TranscriptTileButtonStyle(cornerRadius: JunoRadius.card))
        .focusEffectDisabled()
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .task(id: attachment.id) { await media?.loadImage(attachment) }
        .contextMenu { TranscriptFileMenu(attachment: attachment, actions: actions) }
        .help(attachment.fileName)
        .accessibilityLabel("Open \(attachment.fileName)")
    }

    @ViewBuilder
    private var picture: some View {
        switch state {
        case .ready(let image):
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .scaledToFill()
                .frame(width: width, height: Self.height)
                .clipped()
                // The web's `group-hover:scale-[1.015]` on `--dur-base`
                // out-soft; none under Reduce Motion.
                .scaleEffect(lit && !reduceMotion ? 1.015 : 1)
                .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: lit)
        case .failed:
            JunoIconView(.imageOff, size: 20)
                .foregroundStyle(Color.junoSecondaryInk)
                .opacity(0.7)
        case .loading:
            // The secondary fill is the placeholder: the frame is already the
            // right size, so nothing moves when the pixels land.
            EmptyView()
        }
    }
}

// MARK: - A document as a page

/// A file as the web's `AttachmentTile` draws it: a 144pt square whose top is
/// a tinted well holding the document's first page on a sheet of paper, and
/// whose foot is a caption band with its name and "Excel workbook · 88 KB".
/// Used for what the reader sent and for what Juno produced alike, so a file
/// looks like itself on both sides of the conversation.
///
/// The page is the first of: a picture of the first page (the server's, or
/// PDFKit's, QuickLook's or ImageIO's here), the file's opening lines, or its
/// extension. Click or Space opens it in Quick Look.
struct FileTile: View {
    let attachment: NativeChatAttachment

    @Environment(\.junoTranscriptMedia) private var media
    @Environment(\.junoTranscriptMediaActions) private var actions
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    static let side: CGFloat = 144
    /// The well above the caption band.
    static let wellHeight: CGFloat = 96
    static let captionHeight: CGFloat = 48
    private static let shape = RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)

    private var lit: Bool { hovered || snapshotHover }

    var body: some View {
        Button {
            actions.quickLook(attachment)
        } label: {
            VStack(spacing: 0) {
                well
                caption
            }
            .frame(width: Self.side, height: Self.side)
            .background(Color.junoCard)
            .clipShape(Self.shape)
            .overlay {
                Self.shape.strokeBorder(
                    lit ? Color.junoForeground.opacity(0.25) : Color.junoBorder.opacity(0.7),
                    lineWidth: 1
                )
            }
            .junoRaisedShadow(lit)
            .contentShape(Self.shape)
        }
        .buttonStyle(TranscriptTileButtonStyle(cornerRadius: JunoRadius.card))
        .focusEffectDisabled()
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .task(id: attachment.id) { await media?.loadPreview(attachment) }
        .contextMenu { TranscriptFileMenu(attachment: attachment, actions: actions) }
        .help(attachment.fileName)
        .accessibilityLabel("Open \(attachment.fileName)")
        .accessibilityValue(attachment.captionMeta)
    }

    /// The sheet of paper, set into the well 14pt from each side and 12pt
    /// from the top, running down under the caption band — the top of a page,
    /// which is the part a document is recognised by. It rises 2pt under the
    /// pointer.
    private var well: some View {
        ZStack(alignment: .top) {
            Color.junoSecondary
            FilePage(attachment: attachment, state: media?.previewState(for: attachment) ?? .ready(.init()))
                // Three points longer than the well, so neither the rise nor
                // the clip ever shows the page's own bottom edge.
                .frame(width: Self.side - 28, height: Self.wellHeight - 12 + 3)
                .background(Color.junoCard)
                .clipShape(FilePage.shape)
                .overlay { FilePage.shape.strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1) }
                .junoRaisedShadow()
                .padding(.top, JunoSpace.cozy)
                .offset(y: lit && !reduceMotion ? -2 : 0)
                .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: lit)
        }
        .frame(width: Self.side, height: Self.wellHeight, alignment: .top)
        .clipped()
    }

    /// Its name without the extension, and what it is: "Excel workbook ·
    /// 88 KB". The size is a count, so its digits are tabular.
    private var caption: some View {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text(attachment.stem)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                // The web's `truncate`: cut at the end, never mid-word.
                .truncationMode(.tail)
            Text(attachment.captionMeta)
                .junoFont(size: 10.5, relativeTo: .caption2)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                // "PowerPoint deck · 1.2 MB" is a hair wider than the band:
                // it tightens a little before it loses the size.
                .minimumScaleFactor(0.85)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(width: Self.side, height: Self.captionHeight, alignment: .leading)
        .background(Color.junoCard)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.junoBorder.opacity(0.6))
                .frame(height: 1)
        }
    }
}

/// What is printed on a file tile's page, in the web's order of preference.
struct FilePage: View {
    let attachment: NativeChatAttachment
    let state: NativeTranscriptPreviewState

    /// `rounded-t-xs`: the page's top corners only.
    static let shape = UnevenRoundedRectangle(
        topLeadingRadius: JunoRadius.xs,
        bottomLeadingRadius: 0,
        bottomTrailingRadius: 0,
        topTrailingRadius: JunoRadius.xs,
        style: .continuous
    )

    /// The excerpt's type: SF Mono 10.5 on a 1.55 line — the file's own
    /// characters, so the one place a tile sets text in mono.
    private static let excerptType = JunoType(size: 10.5, lineHeight: 1.55, face: .mono, textStyle: .caption2)
    /// The extension, when there is nothing else: SF Mono 11 medium — a file
    /// format's identifier, not a label, which is why it may be mono.
    private static let extensionType = JunoType(
        size: 11, weight: .medium, lineHeight: 1.45, face: .mono, textStyle: .caption
    )

    private var preview: NativeTranscriptFilePreview? {
        if case .ready(let preview) = state { return preview }
        return nil
    }

    var body: some View {
        GeometryReader { proxy in
            if let thumbnail = preview?.thumbnail {
                // `object-top`: a page is read from the top, so a tile squarer
                // than A4 keeps the masthead, not a band from the middle.
                Image(decorative: thumbnail, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                    .clipped()
            } else if let excerpt = preview?.excerpt {
                Text(excerpt)
                    .junoType(Self.excerptType)
                    .foregroundStyle(Color.junoForeground.opacity(0.6))
                    // Its whole height, then clipped by the page: a fragment
                    // runs off the sheet, it does not end in an ellipsis.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: proxy.size.width - 20, alignment: .topLeading)
                    .padding([.top, .leading, .trailing], JunoSpace.close)
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                    .clipped()
                    // A fragment of a longer file dissolves rather than
                    // stopping: a hard bottom edge reads as "this is all".
                    .mask {
                        LinearGradient(
                            stops: [.init(color: .black, location: 0.45), .init(color: .clear, location: 1)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    }
            } else {
                Text(attachment.extensionBadge)
                    .junoType(Self.extensionType)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: proxy.size.width, height: proxy.size.height)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A file's context menu: Quick Look · Open With Default App · Save As….
struct TranscriptFileMenu: View {
    let attachment: NativeChatAttachment
    let actions: TranscriptMediaActions

    var body: some View {
        // Menu items, drawn by AppKit at its own metrics; the content shapes
        // only state that for a gate that cannot see the `.contextMenu` this
        // body is handed to.
        Button { actions.quickLook(attachment) } label: {
            Label { Text("Quick Look") } icon: { JunoIconView(.eye, size: 16) }
        }
        .contentShape(.rect)
        Button { actions.openWithDefaultApp(attachment) } label: {
            Label { Text("Open With Default App") } icon: { JunoIconView(.externalLink, size: 16) }
        }
        .contentShape(.rect)
        Divider()
        Button { actions.saveAs(attachment) } label: {
            Label { Text("Save As…") } icon: { JunoIconView(.download, size: 16) }
        }
        .contentShape(.rect)
    }
}

// MARK: - What Juno made

/// The files and media on an answer, in the web's order: documents it
/// produced as page tiles, then pictures and clips (`message-item.tsx`).
struct AssistantAttachments: View {
    let attachments: [NativeChatAttachment]
    /// Edit shows on a picture only when the turn allows it: not private, not
    /// while a reply is being written, and with an image model that edits.
    let canEditImages: Bool

    @Environment(\.junoTranscriptMedia) private var transcriptMedia
    @Environment(\.junoTranscriptMediaActions) private var actions

    private var files: [NativeChatAttachment] {
        attachments.filter { !$0.isImageKind && !$0.isVideo && $0.viewerKind != .audio }
    }

    private var media: [NativeChatAttachment] {
        attachments.filter { $0.isImageKind || $0.isVideo }
    }

    /// A track a music model made: a player with its waveform, not a file tile.
    private var tracks: [NativeChatAttachment] {
        attachments.filter { $0.viewerKind == .audio }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            ForEach(tracks) { track in
                NativeGeneratedAudioCard(attachment: track) {
                    guard let transcriptMedia else { throw NativeTranscriptFileError.unavailable }
                    return try await transcriptMedia.fileURL(for: track)
                }
                .contextMenu { TranscriptFileMenu(attachment: track, actions: actions) }
            }
            if !files.isEmpty {
                JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug) {
                    ForEach(files) { FileTile(attachment: $0) }
                }
            }
            if !media.isEmpty {
                JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug) {
                    ForEach(media) { attachment in
                        if attachment.isVideo {
                            GeneratedVideoCard(attachment: attachment)
                        } else {
                            GeneratedImageView(attachment: attachment, canEdit: canEditImages)
                        }
                    }
                }
            }
        }
        .padding(.bottom, JunoSpace.hairline)
    }
}

/// A generated picture: a square of at most 320pt, the picture fitted inside
/// it on the muted ground, a hairline that darkens under the pointer, and no
/// shadow — it sits in the reading column, it does not lift off it.
///
/// The frame arrives at once and holds its size; only the pixels dissolve in
/// once they are decoded, so completion never collapses and re-expands the
/// transcript (`GeneratedImageAttachment`). Under the pointer, Edit ·
/// Download · Expand; a click opens Quick Look — the web opens a new tab, and
/// has no Download or Expand (§0.8 #15). Drag it out to get the file.
struct GeneratedImageView: View {
    let attachment: NativeChatAttachment
    var canEdit = false

    @Environment(\.junoTranscriptMedia) private var media
    @Environment(\.junoTranscriptMediaActions) private var actions
    @Environment(\.junoMeasure) private var measure
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false
    @State private var focused = false
    /// The pixels are showing. Set without a fade when the picture was
    /// already decoded as the row appeared — a row scrolled back into view is
    /// not a picture arriving.
    @State private var revealed = false

    private static let shape = RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)

    private var side: CGFloat { min(measure, 320) }
    private var state: NativeTranscriptImageState { media?.imageState(for: attachment) ?? .failed }
    private var isReady: Bool { if case .ready = state { true } else { false } }
    private var isFailed: Bool { state == .failed }
    private var lit: Bool { hovered || snapshotHover }
    private var clusterShown: Bool { lit || focused }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button {
                actions.quickLook(attachment)
            } label: {
                frame
            }
            .buttonStyle(TranscriptTileButtonStyle(cornerRadius: JunoRadius.field))
            .contentShape(Self.shape)
            .focusEffectDisabled()
            .onDrag { dragItem() }
            .accessibilityLabel(
                isFailed
                    ? "Preview unavailable. Open \(attachment.fileName) in Quick Look"
                    : "Open \(attachment.fileName) in Quick Look"
            )
            // The hover controls, for VoiceOver, whether or not they are
            // showing.
            .accessibilityActions {
                if canEdit, let editImage = actions.editImage {
                    Button("Edit") { editImage(attachment) }
                        .contentShape(.rect)
                }
                Button("Download") { actions.saveAs(attachment) }
                    .contentShape(.rect)
            }

            cluster
                .padding(JunoSpace.snug)
                .opacity(clusterShown ? 1 : 0)
                .allowsHitTesting(clusterShown)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: clusterShown)
        }
        .frame(width: side, height: side)
        .onHover { hovered = $0 }
        .onPreferenceChange(TranscriptMediaFocusKey.self) { focused = $0 }
        .contextMenu { TranscriptFileMenu(attachment: attachment, actions: actions) }
        .task(id: attachment.id) { await media?.loadImage(attachment) }
        .onAppear {
            // Already decoded: shown as it is, not faded in again.
            guard isReady else { return }
            var settled = Transaction()
            settled.disablesAnimations = true
            withTransaction(settled) { revealed = true }
        }
        .onChange(of: isReady) { _, ready in revealed = ready }
    }

    private var frame: some View {
        ZStack {
            Self.shape.fill(Color.junoMuted)
            if case .ready(let image) = state {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .opacity(revealed ? 1 : 0)
                    // The pixels dissolve in on `--dur-slow` out-soft.
                    .animation(
                        JunoMotion.reduced(JunoMotion.outSoft(JunoMotion.Duration.slow), when: reduceMotion, tier: .tint),
                        value: revealed
                    )
            }
            overlay
                .opacity(revealed ? 0 : 1)
                .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: revealed)
        }
        .frame(width: side, height: side)
        .clipShape(Self.shape)
        .overlay {
            Self.shape.strokeBorder(Color.junoBorder.opacity(lit ? 1 : 0.6), lineWidth: 1)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        }
        .contentShape(Self.shape)
    }

    /// "Preparing image" over the muted ground until the pixels land, or
    /// what to do instead when they will not.
    private var overlay: some View {
        ZStack {
            Color.junoMuted
            VStack(spacing: JunoSpace.tight) {
                JunoIconView(isFailed ? .imageOff : .image, size: 20)
                    .opacity(isFailed ? 1 : 0.7)
                Text(isFailed ? "Preview unavailable · open original" : "Preparing image")
                    .junoType(.caption)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.cozy + 8)
        }
        .allowsHitTesting(false)
    }

    /// Edit · Download · Expand, top-right, 6pt apart.
    private var cluster: some View {
        HStack(spacing: JunoSpace.tight) {
            if canEdit, let editImage = actions.editImage {
                Button {
                    editImage(attachment)
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.pencil, size: 14)
                        Text("Edit")
                    }
                }
                .buttonStyle(MediaOverlayButtonStyle(shape: .capsule))
                .contentShape(Capsule())
                .focusEffectDisabled()
                .help("Edit")
                .accessibilityLabel("Edit \(attachment.fileName)")
            }
            Button {
                actions.saveAs(attachment)
            } label: {
                JunoIconView(.download, size: 14)
            }
            .buttonStyle(MediaOverlayButtonStyle(shape: .circle))
            .contentShape(Circle())
            .focusEffectDisabled()
            .help("Download")
            .accessibilityLabel("Download \(attachment.fileName)")
            Button {
                actions.quickLook(attachment)
            } label: {
                JunoIconView(.maximize, size: 14)
            }
            .buttonStyle(MediaOverlayButtonStyle(shape: .circle))
            .contentShape(Circle())
            .focusEffectDisabled()
            .help("Quick Look")
            .accessibilityLabel("Quick Look")
        }
    }

    /// The file itself, for a drag out to the Finder or another app: fetched
    /// (or read from the cache) when the drop asks for it, not when the drag
    /// starts.
    private func dragItem() -> NSItemProvider {
        let provider = NSItemProvider()
        provider.suggestedName = attachment.fileName
        guard let media else { return provider }
        let attachment = attachment
        let type = UTType(mimeType: attachment.mimeType)
            ?? UTType(filenameExtension: attachment.fileExtension)
            ?? .image
        provider.registerFileRepresentation(for: type, visibility: .all, openInPlace: false) { completion in
            let reply = DragFileReply(completion)
            Task { @MainActor in
                do {
                    reply.send(try await media.fileURL(for: attachment))
                } catch {
                    reply.fail(error)
                }
            }
            return nil
        }
        return provider
    }
}

/// The drop's completion handler, carried to the main actor where the file is
/// fetched. AppKit calls it once from whatever thread it likes, so it is safe
/// to hand across — the SDK just does not say so.
final class DragFileReply: @unchecked Sendable {
    private let completion: (URL?, Bool, (any Error)?) -> Void

    init(_ completion: @escaping (URL?, Bool, (any Error)?) -> Void) {
        self.completion = completion
    }

    func send(_ url: URL) { completion(url, false, nil) }
    func fail(_ error: any Error) { completion(nil, false, error) }
}

/// A generated clip: a card at most 480pt wide with a 16:9 stage and a 52pt
/// footer — stable chrome, and the player revealed once it can play
/// (`VideoAttachment`). The stage holds "Preparing video" until AVKit says the
/// item is ready; the footer names it and opens it in the default player.
struct GeneratedVideoCard: View {
    let attachment: NativeChatAttachment

    enum Phase: Equatable { case preparing, ready, failed }

    @Environment(\.junoTranscriptMedia) private var media
    @Environment(\.junoTranscriptMediaActions) private var actions
    @Environment(\.junoMeasure) private var measure
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var player: AVPlayer?
    @State private var phase = Phase.preparing
    @State private var hovered = false

    private static let shape = RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
    private static let footerHeight: CGFloat = 52

    private var width: CGFloat { min(measure, 480) }
    private var lit: Bool { hovered || snapshotHover }

    private var status: String {
        switch phase {
        case .preparing: "Preparing"
        case .ready: "Ready"
        case .failed: "Preview unavailable"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            stage
            footer
        }
        .frame(width: width)
        .background(Color.junoCard)
        .clipShape(Self.shape)
        .overlay {
            Self.shape.strokeBorder(Color.junoBorder.opacity(lit ? 1 : 0.6), lineWidth: 1)
        }
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .contextMenu { TranscriptFileMenu(attachment: attachment, actions: actions) }
        .task(id: attachment.id) { await prepare() }
        .onDisappear { player?.pause() }
    }

    private var stage: some View {
        ZStack {
            Color.junoMuted
            if let player {
                VideoPlayer(player: player)
                    .opacity(phase == .ready ? 1 : 0)
                    .allowsHitTesting(phase == .ready)
                    .accessibilityHidden(phase != .ready)
                    .animation(
                        JunoMotion.reduced(JunoMotion.outSoft(JunoMotion.Duration.slow), when: reduceMotion, tier: .tint),
                        value: phase
                    )
            }
            VStack(spacing: JunoSpace.tight) {
                JunoIconView(.video, size: 20)
                    .opacity(0.7)
                Text(phase == .failed ? "Video preview unavailable" : "Preparing video")
                    .junoType(.caption)
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .opacity(phase == .ready ? 0 : 1)
            .allowsHitTesting(false)
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: phase)
        }
        .frame(width: width, height: width * 9 / 16)
        .clipped()
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.video, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text("Video")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoForeground.opacity(0.75))
                Text("·")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoBorder)
                    .accessibilityHidden(true)
                Text(status)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .accessibilityLabel(accessibleStatus)
            }
            Spacer(minLength: 0)
            Button {
                actions.openWithDefaultApp(attachment)
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    Text("Open")
                    JunoIconView(.externalLink, size: 14)
                }
            }
            .buttonStyle(MediaPillButtonStyle())
            .contentShape(Capsule())
            .focusEffectDisabled()
            .help("Open in the default player")
            .accessibilityLabel("Open \(attachment.fileName)")
        }
        .padding(.horizontal, JunoSpace.comfy)
        .frame(height: Self.footerHeight)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.junoBorder.opacity(0.6))
                .frame(height: 1)
        }
    }

    private var accessibleStatus: String {
        switch phase {
        case .preparing: "Preparing \(attachment.fileName)"
        case .ready: "\(attachment.fileName) is ready"
        case .failed: "Video preview unavailable for \(attachment.fileName)"
        }
    }

    /// Downloads the clip (the files route has no streaming player yet — an
    /// `AVAssetResourceLoaderDelegate` over its Range support is the
    /// follow-up), then waits for the item to say it can play.
    private func prepare() async {
        guard let media else {
            phase = .failed
            return
        }
        do {
            let url = try await media.fileURL(for: attachment)
            let item = AVPlayerItem(url: url)
            player = AVPlayer(playerItem: item)
            while !Task.isCancelled {
                switch item.status {
                case .readyToPlay:
                    phase = .ready
                    return
                case .failed:
                    phase = .failed
                    return
                default:
                    try await Task.sleep(for: .milliseconds(100))
                }
            }
        } catch is CancellationError {
            return
        } catch {
            phase = .failed
        }
    }
}

// MARK: - Styles

/// A media tile as a button: no chrome of its own — the tile draws its frame
/// and its hover — and the graphite focus ring 2pt off its edge, since the
/// system's own ring is turned off at the call site.
struct TranscriptTileButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, cornerRadius: cornerRadius)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let cornerRadius: CGFloat
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .overlay {
                    if isFocused {
                        RoundedRectangle(cornerRadius: cornerRadius + 2, style: .continuous)
                            .stroke(Color.junoRing, lineWidth: 2)
                            .padding(-2)
                    }
                }
                .preference(key: TranscriptMediaFocusKey.self, value: isFocused)
        }
    }
}

/// The controls that float over a picture: a 28pt capsule or circle in the
/// card fill at 90% over a 60% hairline, with the one-point raised shadow —
/// opaque enough to read over any picture, and never glass (§0.1).
struct MediaOverlayButtonStyle: ButtonStyle {
    enum Shape { case capsule, circle }
    var shape: Shape

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, shape: shape)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let shape: MediaOverlayButtonStyle.Shape
        @Environment(\.isFocused) private var isFocused
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        /// A 28pt-tall capsule with circular ends — a circle when it holds
        /// only a glyph.
        static let plate = Capsule(style: .circular)

        var body: some View {
            configuration.label
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoForeground.opacity(hovered ? 1 : 0.85))
                .padding(.horizontal, shape == .capsule ? 10 : 0)
                .frame(minWidth: 28, minHeight: 28)
                .frame(height: 28)
                // The lift is the plate's own, cast by the shape rather than
                // by the composited control, so it follows the capsule.
                .background(Self.plate.fill(Color.junoCard.opacity(0.9)).junoRaisedShadow())
                .overlay(Self.plate.strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1))
                .overlay {
                    if isFocused {
                        Self.plate
                            .stroke(Color.junoRing, lineWidth: 2)
                            .padding(-2)
                    }
                }
                .contentShape(Self.plate)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
                .preference(key: TranscriptMediaFocusKey.self, value: isFocused)
        }
    }
}

/// The video footer's "Open": a 28pt capsule in the secondary fill over a
/// 60% hairline, which under the pointer takes the hover fill, a full
/// hairline and foreground ink.
struct MediaPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var isFocused
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        /// A 28pt-tall capsule with circular ends — a circle when it holds
        /// only a glyph.
        static let plate = Capsule(style: .circular)

        var body: some View {
            configuration.label
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(hovered ? Color.junoForeground : Color.junoForeground.opacity(0.8))
                .padding(.horizontal, JunoSpace.close)
                .frame(height: 28)
                .background(Self.plate.fill(hovered ? Color.junoHover : Color.junoSecondary))
                .overlay(Self.plate.strokeBorder(Color.junoBorder.opacity(hovered ? 1 : 0.6), lineWidth: 1))
                .overlay {
                    if isFocused {
                        Self.plate
                            .stroke(Color.junoRing, lineWidth: 2)
                            .padding(-2)
                    }
                }
                .contentShape(Self.plate)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}
