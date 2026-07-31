import AppKit
import Foundation
import JunoChatKit
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

/// The artifact a transcript asked to open.
///
/// Built from `NativeMessageContent.ArtifactReference` — the tag body carried on
/// the message itself — because that is the only copy guaranteed to exist. The
/// stored artifact row is written server-side and reaches this Mac on the next
/// sync, so for the whole window between "the reply finished" and "the row
/// arrived" the tag is all there is. That is also why this canvas offers no
/// versions, no restore and no Office export: there is no row behind it to
/// promise them against, and a disabled Restore control would promise one.
struct DesktopChatArtifact: Identifiable, Equatable {
    let reference: NativeMessageContent.ArtifactReference

    var id: String { reference.id }

    var kind: NativeArtifactKind {
        NativeArtifactKind(rawValue: reference.kind.uppercased()) ?? .code
    }

    var title: String {
        reference.title.isEmpty ? "Untitled artifact" : reference.title
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
        default: kind
        }
    }

    /// The web's `ICONS` map, in SF Symbols. Falls through to the code glyph for
    /// a kind this client does not know, which is honest: an artifact of an
    /// unrecognised kind is still source.
    static func symbol(forWireKind kind: String) -> String {
        switch kind.uppercased() {
        case "HTML": "globe"
        case "REACT": "curlybraces.square"
        case "SVG": "square.on.circle"
        case "MERMAID": "flowchart"
        case "MARKDOWN": "doc.text"
        default: "chevron.left.forwardslash.chevron.right"
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

// MARK: - Width model

/// The canvas column's width, in the website's own numbers
/// (`chat-view.tsx`: `CANVAS_MIN_WIDTH`, `CHAT_MIN_WIDTH`, `canvasWidthBounds`).
enum DesktopArtifactCanvasMetrics {
    /// The narrowest a canvas is worth showing at all.
    static let minimumCanvas: CGFloat = 420
    /// What the transcript keeps whatever the reader drags. A conversation
    /// narrower than this is not a conversation any more.
    static let minimumTranscript: CGFloat = 320
    /// `Math.round(window.innerWidth * 0.46)` — the width it opens at.
    static let defaultFraction: CGFloat = 0.46
    /// The ceiling a drag can reach.
    static let maximumFraction: CGFloat = 0.82
    /// Below this the detail column cannot hold a readable transcript *and* a
    /// readable canvas, so the canvas takes the whole of it — the web's
    /// `hidden lg:flex`. Measured against the column, not the window: a Mac
    /// window also carries a sidebar, and the space the canvas competes for is
    /// what is left after it.
    static let sideBySideWidth: CGFloat = 900

    static func bounds(in container: CGFloat) -> (minimum: CGFloat, maximum: CGFloat) {
        let minimum = min(minimumCanvas, max(minimumTranscript, container - minimumTranscript))
        let maximum = max(
            minimum,
            min((container * maximumFraction).rounded(), container - minimumTranscript)
        )
        return (minimum, maximum)
    }

    static func defaultWidth(in container: CGFloat) -> CGFloat {
        clamp((container * defaultFraction).rounded(), in: container)
    }

    static func clamp(_ width: CGFloat, in container: CGFloat) -> CGFloat {
        let range = bounds(in: container)
        return min(max(width, range.minimum), range.maximum)
    }
}

// MARK: - The dock

/// Docks the artifact canvas beside `content` as a real column — and over it,
/// never instead of it, when the column is too narrow to hold both.
///
/// The transcript keeps its own `safeAreaInset` composer, so the composer spans
/// the conversation and stops at the divider — which is where the web puts it
/// too. Width is persisted under `juno.chat.canvasWidth`, the native spelling of
/// the site's `juno:canvas-width`, and clamped against the column on every read
/// so a width chosen on a wide display cannot strand the transcript on a narrow
/// one.
struct DesktopArtifactDock<Content: View>: View {
    let artifact: DesktopChatArtifact?
    let close: () -> Void
    private let content: Content

    init(
        artifact: DesktopChatArtifact?,
        close: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.artifact = artifact
        self.close = close
        self.content = content()
    }

    @AppStorage("juno.chat.canvasWidth") private var storedWidth: Double = 0
    @State private var containerWidth: CGFloat = 0
    /// The width the drag started from, so a gesture measures against where it
    /// began rather than accumulating against a value it is itself changing.
    @State private var dragOrigin: CGFloat?
    /// The live width mid-drag. Held apart from `storedWidth` so a drag writes
    /// user defaults once, on release, instead of once per frame.
    @State private var draggingWidth: CGFloat?
    @State private var showingResizeCursor = false

    /// The divider's hit box, which the conversation gives up along with the
    /// panel itself. One number for the inset and the handle both, so the two
    /// cannot drift and leave the canvas standing on the transcript.
    private static var handleWidth: CGFloat { JunoSpace.snug }

    /// Whether the column is too narrow to hold both. Only true once the width
    /// has actually been measured — at zero the canvas would flash full-bleed on
    /// the first frame of every open.
    private var isCompact: Bool {
        containerWidth > 0 && containerWidth < DesktopArtifactCanvasMetrics.sideBySideWidth
    }

    /// Whether the canvas is *covering* the conversation rather than standing
    /// beside it: the compact column, showing one thing at a time.
    private var transcriptIsCovered: Bool {
        artifact != nil && isCompact
    }

    /// What the canvas takes out of the conversation's width — the panel and the
    /// divider that resizes it — and nothing when it is closed or covering.
    private var reservedWidth: CGFloat {
        guard artifact != nil, !isCompact else { return 0 }
        return canvasWidth + Self.handleWidth
    }

    private var canvasWidth: CGFloat {
        guard containerWidth > 0 else { return DesktopArtifactCanvasMetrics.minimumCanvas }
        if let draggingWidth {
            return DesktopArtifactCanvasMetrics.clamp(draggingWidth, in: containerWidth)
        }
        guard storedWidth > 0 else {
            return DesktopArtifactCanvasMetrics.defaultWidth(in: containerWidth)
        }
        return DesktopArtifactCanvasMetrics.clamp(CGFloat(storedWidth), in: containerWidth)
    }

    /// The conversation, with the canvas drawn in the room it reserved — or over
    /// the whole column when there is not enough room for both.
    ///
    /// **`content` is never removed.** It used to be, in the compact case, and
    /// that one `if` reached a very long way. It took ``DesktopComposer`` with
    /// it, and a SwiftUI view that leaves the hierarchy takes its `@State` too:
    /// the half-typed message, Deep research, Web search, the connectors picked
    /// for this one send, the model chosen for it. It also took the voice dock
    /// mounted on that composer, and `DesktopVoiceDock` hangs up on
    /// `onDisappear` — so opening an artifact ended a call that was still being
    /// spoken, and the dock came back offering to *restart*, which clears the
    /// record. Dragging the window across ``DesktopArtifactCanvasMetrics/sideBySideWidth``
    /// with the canvas open did the same thing. The website has never removed
    /// this node: `hidden lg:flex` is `display: none`, and a hidden node keeps
    /// its state and its lifetime. So this hides it — and only hides it.
    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(transcriptIsCovered ? 0 : 1)
            .allowsHitTesting(!transcriptIsCovered)
            // Disabled as well as untouchable. Hit testing turns the pointer
            // away, but only `disabled` moves the keyboard off a composer that
            // is still mounted: a focused text field that is merely invisible
            // still takes every keystroke aimed at the canvas.
            .disabled(transcriptIsCovered)
            .accessibilityHidden(transcriptIsCovered)
            .padding(.trailing, reservedWidth)
            .overlay(alignment: .trailing) { canvasColumn }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
    }

    /// The panel and its divider, laid over the inset they were given.
    ///
    /// One instance for both widths — the compact case changes what the canvas is
    /// *sized* to, never where it sits in the hierarchy — so dragging the window
    /// across the threshold cannot reset the view the reader was on any more than
    /// it can reset the composer behind it.
    @ViewBuilder
    private var canvasColumn: some View {
        if let artifact {
            HStack(spacing: 0) {
                if !isCompact {
                    resizeHandle
                }
                DesktopArtifactCanvas(artifact: artifact, close: close)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frame(width: isCompact ? nil : canvasWidth)
            }
            // The window's own reading canvas, painted a second time and only
            // where this panel covers something — the web's `bg-background` on
            // the same panel. The conversation underneath is already hidden, but
            // the composer's glass is a system effect rather than something a
            // parent's opacity is guaranteed to dim, and a covering panel that
            // can be seen through is not covering.
            .background {
                if isCompact {
                    Color.junoCanvasWarm
                }
            }
            // Sixteen points and a fade on the way in, a bare fade on the way
            // out — the web's `slide-in-from-right-4` / `fade-out` pair. The
            // asymmetry is the point: arriving should read as the card handing
            // off to the workspace, leaving should read as the transcript
            // reclaiming the room.
            .transition(
                .asymmetric(
                    insertion: .offset(x: DesktopChatMotion.canvasSlide)
                        .combined(with: .opacity),
                    removal: .opacity
                )
            )
        }
    }

    /// The divider, and the grip on it.
    ///
    /// One hairline inside a wider transparent box: the line stays the weight of
    /// every other divider in the window while the pointer gets a target it can
    /// actually hit. Hidden from VoiceOver — there is no keyboard equivalent of a
    /// drag, and announcing a control that cannot be operated is worse than
    /// announcing nothing. Nothing behind it is reachable only this way.
    private var resizeHandle: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1)
            .frame(width: Self.handleWidth)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let origin = dragOrigin ?? canvasWidth
                        dragOrigin = origin
                        // Dragging left widens the canvas, so the translation is
                        // subtracted: the handle is on the canvas's leading edge.
                        draggingWidth = origin - value.translation.width
                    }
                    .onEnded { _ in
                        if let draggingWidth, containerWidth > 0 {
                            storedWidth = Double(
                                DesktopArtifactCanvasMetrics.clamp(
                                    draggingWidth,
                                    in: containerWidth
                                )
                            )
                        }
                        dragOrigin = nil
                        draggingWidth = nil
                    }
            )
            .simultaneousGesture(
                TapGesture(count: 2).onEnded {
                    guard containerWidth > 0 else { return }
                    storedWidth = Double(
                        DesktopArtifactCanvasMetrics.defaultWidth(in: containerWidth)
                    )
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
            // A pushed cursor outlives the view that pushed it: `.ended` cannot
            // arrive if the handle goes away while the pointer is still over it —
            // closing the canvas, switching conversations, closing the window.
            // The resize cursor would then be the app's cursor everywhere, with
            // no handle left to pop it.
            .onDisappear {
                guard showingResizeCursor else { return }
                showingResizeCursor = false
                NSCursor.pop()
            }
            .help("Drag to resize the canvas. Double-click to reset.")
            .accessibilityHidden(true)
    }
}

// MARK: - The canvas

/// The artifact itself: the website's canvas header, its view switcher, and the
/// artifact under both.
///
/// Paints no canvas of its own. `junoReadingCanvas()` is applied once, at the
/// window level, and a page that repaints it is what flattens the window into
/// one cream field — the header's half-strength surface is the only fill here,
/// and it is the web's `bg-card/50`.
struct DesktopArtifactCanvas: View {
    let artifact: DesktopChatArtifact
    let close: () -> Void

    @State private var mode = NativeArtifactDisplayMode.preview
    @State private var pendingDownload: DesktopChatArtifactDownload?
    @State private var downloadError: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            viewBar
            Divider()
            // Clamped for the reason ``JunoDetailPage`` spells out: a `ScrollView`
            // propagates its content's ideal height rather than absorbing it, and
            // a `NavigationSplitView` answers an ideal it cannot meet by growing
            // the window's split view. `Color.clear` takes whatever it is
            // proposed and an overlay is sized by its base, so a hundred-page
            // artifact scrolls instead of resizing the window it opened in.
            Color.clear.overlay { canvasBody }
        }
        // A different artifact is a different document: it opens on its preview
        // and owes nothing to the last one's failed save. The web gets this free
        // by keying the whole panel on the artifact; one column reused for both
        // has to say so.
        .onChange(of: artifact.id) { _, _ in
            mode = .preview
            downloadError = nil
        }
        .fileExporter(
            isPresented: Binding(
                get: { pendingDownload != nil },
                set: { if !$0 { pendingDownload = nil } }
            ),
            document: pendingDownload?.document,
            // `.data` rather than a guessed content type: the file name already
            // carries the extension, and a second, guessed type would fight it.
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

    // MARK: Header

    /// The web's canvas header: identity, one primary action, an overflow menu, a
    /// hairline, and close. Compact on purpose — the artifact's *content* is the
    /// visual event, and a title bar that competes with it is a title bar in the
    /// way.
    private var header: some View {
        HStack(spacing: JunoSpace.tight) {
            VStack(alignment: .leading, spacing: 1) {
                Text(artifact.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                // One monospaced line with "·" separators, exactly as the web
                // writes it. Provenance belongs here rather than as a subtitle
                // under the title: three floating fragments is three things to
                // read instead of one.
                Text(metadata)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            ShareLink(item: artifact.reference.content, subject: Text(artifact.title)) {
                headerGlyph("square.and.arrow.up")
            }
            .buttonStyle(.plain)
            .help("Share this artifact's source")
            .accessibilityLabel("Share")

            Menu {
                Button("Copy Source") {
                    JunoPasteboard.copy(artifact.reference.content)
                }
                Button("Save Source As…") {
                    downloadError = nil
                    pendingDownload = DesktopChatArtifactDownload(
                        document: DesktopChatArtifactDocument(
                            text: artifact.reference.content
                        ),
                        name: DesktopArtifactKindLabel.fileName(
                            title: artifact.reference.title,
                            kind: artifact.kind,
                            language: artifact.reference.language
                        )
                    )
                }
            } label: {
                headerGlyph("ellipsis")
            }
            // The composer's `addMenu` idiom: a borderless menu with its
            // indicator suppressed is the only way an icon-only menu keeps the
            // weight of the buttons beside it instead of growing a chevron and a
            // bezel of its own.
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Copy or save this artifact's source")
            .accessibilityLabel("Artifact actions")
            .accessibilityIdentifier("juno.desktop.chat.artifact-actions")

            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 1, height: 20)
                .padding(.horizontal, 1)
                .accessibilityHidden(true)

            Button(action: close) {
                headerGlyph("xmark")
            }
            .buttonStyle(.plain)
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

    /// A header action's glyph.
    ///
    /// Flat and quiet — the web's `variant="ghost" text-muted-foreground`. A
    /// bordered control here would put three bezels above an artifact whose
    /// content is the thing worth looking at, and the frame is what makes the
    /// glyph clickable across the whole 24pt square rather than only where the
    /// ink happens to be.
    private func headerGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .contentShape(.rect)
    }

    /// `Markdown · From this conversation`, or `Code · SWIFT · From this
    /// conversation` when the model named a language.
    private var metadata: String {
        var fields = [DesktopArtifactKindLabel.title(forWireKind: artifact.reference.kind)]
        if let language = artifact.reference.language, !language.isEmpty {
            fields.append(language.uppercased())
        }
        fields.append("From this conversation")
        return fields.joined(separator: " · ")
    }

    // MARK: View switcher

    private var viewBar: some View {
        HStack(spacing: JunoSpace.snug) {
            if artifact.kind.supportsRenderedPreview {
                DesktopCanvasSegmented(
                    options: [
                        .init(NativeArtifactDisplayMode.preview, "Preview"),
                        .init(NativeArtifactDisplayMode.source, "Source"),
                    ],
                    selection: $mode,
                    accessibilityLabel: "Artifact view"
                )
                .accessibilityIdentifier("juno.desktop.chat.artifact-view-mode")
            } else {
                // Nothing to switch between: Juno has no renderer for this kind,
                // so the source *is* the view. The row still says which one is
                // showing rather than going bare, as the web's tab row does.
                Text("Source")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.junoMutedForeground)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
            }

            Spacer(minLength: JunoSpace.snug)

            if let downloadError {
                Text(downloadError)
                    .font(.caption)
                    .foregroundStyle(Color.junoCaution)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
    }

    // MARK: Body

    @ViewBuilder
    private var canvasBody: some View {
        if mode == .preview, artifact.kind == .markdown {
            // Markdown is prose, and prose is what `NativeArtifactPreview` gets
            // wrong: its markdown branch is `AttributedString(markdown:)`, which
            // flattens headings, lists, tables and fences into one run of body
            // text and then pours it across the full width of the panel.
            // `JunoMarkdownText` is the renderer the transcript already uses and
            // `JunoDetailPage` clamps the measure — the same substitution
            // ``DesktopArtifactsScreen`` makes, for the same reason.
            JunoDetailPage {
                JunoMarkdownText(artifact.reference.content)
                    .padding(JunoSpace.section)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .junoCard()
            }
        } else {
            NativeArtifactPreview(
                kind: artifact.kind,
                content: artifact.reference.content,
                mode: mode
            )
        }
    }
}

// MARK: - Segmented control

/// The website's view switcher: a quiet track with one raised thumb.
///
/// Replaces `Picker(...).pickerStyle(.segmented)`, whose AppKit chrome is the
/// wrong weight for a control sitting *inside* content — hard dividers and a
/// slab that announces itself louder than the artifact it switches. The web's is
/// a `bg-muted/70` track with a `bg-card` thumb that carries the pop shadow, and
/// the thumb is one view that **moves** between slots rather than two that
/// cross-fade, so the switch reads as a physical throw. The phone's
/// `JunoMobileSegmented` is the same control; the two are separate only because
/// the apps share no view layer.
struct DesktopCanvasSegmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }

        init(_ value: Value, _ title: String) {
            self.value = value
            self.title = title
        }
    }

    let options: [Option]
    @Binding var selection: Value
    var accessibilityLabel: String

    /// The track's radius is the thumb's plus the track's own padding, so the two
    /// curves are concentric rather than merely both rounded.
    private static var trackRadius: CGFloat { JunoCornerRadius.control + 2 }

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(
                        JunoMotion.reduced(
                            DesktopChatMotion.segmentTravel,
                            when: reduceMotion
                        )
                    ) {
                        selection = option.value
                    }
                } label: {
                    Text(option.title)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(selected ? Color.primary : Color.junoMutedForeground)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background {
                            if selected {
                                RoundedRectangle(
                                    cornerRadius: JunoCornerRadius.control,
                                    style: .continuous
                                )
                                .fill(Color.junoRaised)
                                .shadow(color: .junoCardShadow, radius: 2, y: 1)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(.rect)
                }
                .buttonStyle(DesktopCanvasSegmentStyle())
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: Self.trackRadius, style: .continuous)
                .fill(Color.junoMuted.opacity(0.7))
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// The web's `active:scale-[0.97]` on the same curve the thumb travels on, so a
/// press and the throw it causes are one gesture rather than two animations.
private struct DesktopCanvasSegmentStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(
                JunoMotion.reduced(DesktopChatMotion.segmentTravel, when: reduceMotion),
                value: configuration.isPressed
            )
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
