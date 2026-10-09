import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - What the transcript knows about its artifacts

extension EnvironmentValues {
    /// The stored rows behind the artifacts this conversation's replies
    /// mention — the web's `artifactsByIdentifier`. Empty in a draft or a
    /// private chat, where every card draws from its tag.
    @Entry var junoArtifactResolver = ChatArtifactResolver.empty
    /// The conversation column's height, which an inline artifact's body is
    /// sized against (`min(44vh, 360)`, at least 240). Zero until measured.
    @Entry var junoTranscriptViewportHeight: CGFloat = 0
    /// Where an inline design's picture comes from: the session's
    /// ``NativeDesignPreviewLoader``, or the snapshot harness's stand-in.
    @Entry var junoDesignPreviews: (any DesignPreviewProviding)? = nil
    /// Forces an inline artifact onto one view — the snapshot harness's way of
    /// photographing Code and Console without clicking. Production never sets
    /// it.
    @Entry var junoSnapshotArtifactView: InlineArtifactView? = nil
}

/// The three views an inline artifact offers.
enum InlineArtifactView: String, Hashable {
    case preview, code, console
}

// MARK: - The card

/// An artifact living inline in the transcript — the web's
/// `ArtifactInlineCard` (`components/chat/artifact-inline-card.tsx`).
///
/// **The artifact runs, where it was written.** A page renders, a component
/// mounts, a program's output streams, a document reads; Code and Console are
/// a switch away, and "Open" hands it to the canvas beside the transcript.
/// The chrome is quiet — a hairline frame, a flat header, one line of
/// metadata — so the artifact's own content is the event, not the card.
///
/// **Opaque, and no coral on furniture.** The card is `junoCard` under a
/// hairline; the icon tile stays muted even while the source is written (the
/// web's tile turns coral then — §0.4 keeps the accent for the live dot and
/// the "Writing" word). The one moving thing while it streams is the band
/// that sweeps the divider.
struct DesktopInlineArtifactCard: View {
    let card: ChatArtifactCard
    /// Opens the canvas. Nil while the source is still arriving.
    let open: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoTranscriptViewportHeight) private var viewportHeight
    @Environment(\.junoSnapshotArtifactView) private var snapshotView
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @State private var runtime = ArtifactRuntimeModel()
    @State private var chosenView: InlineArtifactView?
    @State private var hovered = false
    @State private var identityHovered = false
    @State private var width: CGFloat = 0
    @State private var appeared = false

    @Environment(\.junoDesignPreviews) private var designPreviews
    @Environment(\.junoWebPreviewStill) private var webPreviewStill

    private var runtimeInfo: NativeArtifactRuntimeInfo { card.runtime }
    private var content: String { card.content }
    private var hasContent: Bool { !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isMarkdown: Bool { card.kind == .markdown }
    private var isDesign: Bool { card.kind.isDesignDocument }
    /// Whether this artifact has a Preview at all: everything the Mac's closed
    /// sandbox can run (React and TypeScript on the bundled Babel and React;
    /// Python, whose engine is not bundled, shows Code), and a design once it
    /// has a stored row to draw from — never its tag body, which is the
    /// compact authoring form (the Mac draws designs; the web prints their
    /// JSON — §0.8 register, 14).
    private var hasPreview: Bool {
        guard hasContent else { return false }
        if isDesign { return card.drawsDesign }
        // A semantic body draws from the stored row or the tag's authoring
        // form alike; one that does not parse shows its source.
        if card.kind.isSemantic { return SemanticArtifact.parsed(kind: card.kind, content: content) != nil }
        return runtimeInfo.runsOnThisMac
    }
    /// Console earns its place once the page has said something — the web's
    /// rule — and only for pages (a console runtime's output *is* its Preview).
    private var hasConsoleTab: Bool {
        runtimeInfo.mode == .web && !isMarkdown && (!runtime.entries.isEmpty || view == .console)
    }

    /// The view on screen: forced to Code while the source streams, Preview
    /// once it lands, and what the reader picked in between.
    private var view: InlineArtifactView {
        if let snapshotView { return snapshotView }
        if card.isStreaming { return .code }
        if let chosenView, chosenView != .preview || hasPreview { return chosenView }
        return hasPreview ? .preview : .code
    }

    private var options: [InlineArtifactSwitch.Option] {
        var options: [InlineArtifactSwitch.Option] = []
        if hasPreview {
            options.append(.init(view: .preview, title: runtimeInfo.mode == .console ? "Output" : "Preview"))
        }
        options.append(.init(view: .code, title: "Code"))
        if hasConsoleTab {
            options.append(.init(view: .console, title: "Console", count: runtime.entries.count))
        }
        return options
    }

    /// The header lays out as a row from 384pt — the web's `@[24rem]`.
    private var isWide: Bool { width == 0 || width >= 384 }

    /// `min(44vh, 360px)`, at least 240.
    private var bodyHeight: CGFloat {
        guard viewportHeight > 0 else { return 360 }
        return min(max(viewportHeight * 0.44, 240), 360)
    }

    /// The body's height once the page has reported its own: the page's
    /// content on its mat — within 120pt and ``bodyHeight`` — so a short page
    /// never sits over a band of empty sheet. The same height holds for every
    /// view, so switching to Code never makes the card jump.
    private var fittedBodyHeight: CGFloat {
        guard hasPreview, !isDesign, !isMarkdown, runtimeInfo.mode == .web,
            let height = runtime.contentHeight, let pageWidth = runtime.contentWidth, pageWidth > 0, width > 0
        else { return bodyHeight }
        // The sheet sits on an 8pt mat inside the card's 1pt edge; a page
        // laid out at another width (an offscreen still) scales to this one.
        let sheetWidth = max(1, width - 2 * JunoSpace.snug - 2)
        let fitted = CGFloat(height) * sheetWidth / CGFloat(pageWidth) + 2 * JunoSpace.snug + 2
        return min(max(fitted.rounded(.up), 120), bodyHeight)
    }

    /// The page's own ground under the sheet — white when it paints none.
    private var sheetGround: Color {
        guard let color = runtime.pageBackground, color.alpha > 0.99 else { return .white }
        return Color(.sRGB, red: color.red, green: color.green, blue: color.blue, opacity: 1)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            divider
            bodyContent
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(hovered || snapshotHover ? 1 : 0.6), lineWidth: 1)
        )
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        // `animate-rise-in`: up 6pt and in, once, as the card arrives.
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion))
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) { appeared = true }
        }
        .padding(.vertical, JunoSpace.cozy)
        // A new run is a new console: the web resets its status and entries
        // when the streaming state changes.
        .onChange(of: card.isStreaming) { _, _ in runtime.reset() }
        // The snapshot harness can force Code or Console, where the page is
        // never mounted; what the page said while its still was taken is
        // replayed instead. Production sets neither value.
        .task(id: snapshotView) {
            guard let snapshotView, snapshotView != .preview, let webPreviewStill, hasPreview, !isDesign else { return }
            let document = NativeArtifactRuntimeDocument.build(kind: card.kind, content: content, language: card.language)
            runtime.reset()
            for message in webPreviewStill.messages(document) { runtime.apply(message) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityTitle)
    }

    private var accessibilityTitle: String {
        card.isStreaming ? "Writing artifact \(card.title)" : "Artifact \(card.title), \(runtimeInfo.label)"
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        Group {
            if isWide {
                HStack(spacing: JunoSpace.snug) {
                    identityControl.frame(maxWidth: .infinity, alignment: .leading)
                    trailingControls
                }
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.close) {
                    identityControl
                    trailingControls.frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
    }

    /// The identity block doubles as a second, larger open target.
    @ViewBuilder
    private var identityControl: some View {
        if let open {
            Button(action: open) {
                identity
                    .padding(JunoSpace.tight)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoHover.opacity(identityHovered ? 0.4 : 0))
                    )
                    .contentShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .padding(-6)
            .onHover { identityHovered = $0 }
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: identityHovered)
            .accessibilityLabel("Open \(card.title) in canvas")
        } else {
            identity
        }
    }

    private var identity: some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(DesktopArtifactKindLabel.icon(for: card.kind), size: 16)
                .foregroundStyle(identityHovered && open != nil ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(identityHovered && open != nil ? 1 : 0.6), lineWidth: 1)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(card.title)
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(minHeight: 20)
                InlineArtifactMeta(
                    label: runtimeInfo.label,
                    version: card.version,
                    isUpdated: card.isUpdated && !card.isStreaming,
                    status: status
                )
                .padding(.top, JunoSpace.micro)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var status: InlineArtifactStatus? {
        if card.isStreaming { return .writing }
        if isDesign {
            guard let stored = card.stored else { return nil }
            return InlineArtifactStatus(
                design: designPreviews?.designPreviewState(artifactID: stored.id, version: stored.currentVersion) ?? .failed
            )
        }
        switch runtime.status {
        case .error: return .error
        case .running: return .running
        case .loading: return .loading
        case .done: return runtimeInfo.mode == .console ? .done : .live
        case .idle: return nil
        }
    }

    @ViewBuilder
    private var trailingControls: some View {
        HStack(spacing: JunoSpace.hairline) {
            if !card.isStreaming, hasContent, options.count > 1 {
                // The shared switch at its compact size, so Preview / Code on
                // the card and in the canvas dock beside it are one control.
                JunoSegmented(
                    options: options.map { JunoSegmentedOption($0.view, $0.title, count: $0.count) },
                    selection: Binding(get: { view }, set: { chosenView = $0 }),
                    accessibilityLabel: "Artifact view",
                    size: .compact
                )
            }
            if let open {
                if isWide {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.7))
                        .frame(width: 1, height: 16)
                        .padding(.horizontal, JunoSpace.hairline)
                        .accessibilityHidden(true)
                }
                Button(action: open) {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.panelRight, size: 14)
                        Text("Open")
                    }
                }
                .buttonStyle(InlineArtifactOpenStyle())
                .contentShape(.rect)
                .help("Open in canvas")
                .accessibilityLabel("Open in canvas")
            }
        }
        .fixedSize()
    }

    // MARK: Divider

    /// The hairline that doubles as a progress track while the source streams:
    /// a third-wide band sweeps across it. Still under Reduce Motion.
    private var divider: some View {
        Rectangle()
            .fill(Color.junoBorder.opacity(0.6))
            .frame(height: 1)
            .overlay {
                if card.isStreaming, !reduceMotion {
                    InlineArtifactSweep()
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }

    // MARK: Body

    @ViewBuilder
    private var bodyContent: some View {
        if hasContent {
            Group {
                switch view {
                case .preview where isMarkdown:
                    ScrollView {
                        JunoMarkdownText(content)
                            .padding(JunoSpace.roomy)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .preview:
                    previewSheet
                case .console:
                    InlineArtifactConsole(entries: runtime.entries)
                case .code:
                    ArtifactCodeSurface(
                        source: content,
                        wraps: isMarkdown,
                        followsTail: card.isStreaming,
                        accessibilityLabel: "\(card.title) source"
                    )
                }
            }
            // One stable height across views, and a quick cross-fade on a
            // switch: the card never jumps, the content trades places.
            .id(view)
            .transition(.opacity)
            .frame(height: fittedBodyHeight)
            .frame(maxWidth: .infinity)
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: view)
        } else if card.isStreaming {
            VStack(spacing: JunoSpace.cozy) {
                // The run signature's tool pattern, small, in the muted ink
                // (SPEC §7.13) — the matrix and its coral dot are gone.
                JunoRunSignature(phase: .tool, size: .small)
                VStack(spacing: JunoSpace.micro) {
                    Text("Writing artifact")
                        .junoType(.heading)
                        .foregroundStyle(Color.junoForeground)
                    Text("The source will stream in here.")
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 180)
            .padding(JunoSpace.roomy)
        } else {
            InlineArtifactUnavailable()
                .padding(JunoSpace.cozy)
        }
    }

    /// The running page on a light sheet, inset on an 8pt mat of the
    /// transcript's own ground so a white page never bleeds edge to edge in a
    /// dark transcript. Console runtimes run on the terminal's own dark ground.
    @ViewBuilder
    private var previewSheet: some View {
        if isDesign, let stored = card.stored {
            InlineDesignPreviewBody(artifactID: stored.id, version: stored.currentVersion, open: open)
        } else if card.kind.isSemantic {
            SemanticArtifactView(kind: card.kind, content: content, presentation: .inline)
                .background(Color.junoCanvas)
        } else {
            NativeArtifactPreview(
                kind: card.kind,
                content: content,
                mode: .preview,
                policy: .inline,
                language: card.language,
                runtime: runtime
            )
            .modifier(ArtifactPreviewSheet(ground: runtimeInfo.mode == .console ? InlineArtifactCard.terminalGround : sheetGround))
        }
    }
}

/// The light sheet a running page sits on: radius 8 under a 70% inset
/// hairline, on an 8pt mat of the transcript's own ground — concentric with
/// the card's 16 (16 − 8).
struct ArtifactPreviewSheet: ViewModifier {
    var ground: Color = .white

    func body(content: Content) -> some View {
        content
            .background(ground)
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
            )
            .padding(JunoSpace.snug)
            .background(Color.junoCanvas)
    }
}

enum InlineArtifactCard {
    /// The web's terminal ground (`#0b0b0e`): the console runtime's own dark
    /// shell, which it paints in both appearances.
    static let terminalGround = Color(red: 11 / 255, green: 11 / 255, blue: 14 / 255)
}

// MARK: - Metadata

/// One run-state word, as the web shows it.
enum InlineArtifactStatus: Equatable {
    case writing, loading, running, live, done, error

    var label: String {
        switch self {
        case .writing: "Writing"
        case .loading: "Loading"
        case .running: "Running"
        case .live: "Live"
        case .done: "Done"
        case .error: "Error"
        }
    }

    var tone: Color {
        switch self {
        case .writing: .junoAccentInk
        case .loading, .running: .junoSource
        case .live, .done: .junoSuccessInk
        case .error: .junoDestructiveInk
        }
    }

    /// The dot pulses while something is happening.
    var isLive: Bool { self == .writing || self == .loading || self == .running }
}

/// `React · v2 · Updated · Live` — one line under the title.
///
/// In SF rather than the web's mono: these are labels, and the Mac keeps mono
/// for code, ids, counts and costs (§10.2). The version number is tabular.
struct InlineArtifactMeta: View {
    let label: String
    let version: Int?
    let isUpdated: Bool
    let status: InlineArtifactStatus?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text(label)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .truncationMode(.tail)
            if let version {
                separator
                Text("v\(version)")
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize()
            }
            if isUpdated {
                separator
                Text("Updated")
                    .foregroundStyle(Color.junoForeground.opacity(0.6))
                    .fixedSize()
            }
            if let status {
                separator
                // The word, never a dot (owner directive): in progress it
                // shimmers in secondary ink; only an error wears a colour.
                Group {
                    switch status {
                    case .writing, .loading, .running:
                        JunoShimmerText(status.label, font: .caption2, active: true)
                    case .error:
                        Text(status.label).foregroundStyle(status.tone)
                    case .live, .done:
                        Text(status.label).foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                .fixedSize()
                .id(status)
                .transition(.opacity)
            }
        }
        .junoFont(size: 11, relativeTo: .caption2)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: status)
        .accessibilityElement(children: .combine)
    }

    private var separator: some View {
        Circle()
            .fill(Color.junoBorder)
            .frame(width: 4, height: 4)
            .accessibilityHidden(true)
    }
}

/// A band a third of the track wide, crossing from −100% to 300% every 1.8s:
/// the web's `animate-gen-sweep`. Drawn from the clock rather than an
/// animation, so it needs no curve and stops the moment it is removed.
private struct InlineArtifactSweep: View {
    var body: some View {
        GeometryReader { proxy in
            TimelineView(.animation) { context in
                let period = JunoMotion.Loop.matrix
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                let band = proxy.size.width / 3
                LinearGradient(
                    colors: [Color.junoAccent.opacity(0), Color.junoAccent, Color.junoAccent.opacity(0)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: band, height: proxy.size.height)
                .offset(x: -band + phase * 4 * band)
            }
        }
    }
}

// MARK: - The switch

/// One view the inline card can show, with its words and, for the console,
/// its count: the options the card's switch is built from.
enum InlineArtifactSwitch {
    struct Option: Identifiable {
        let view: InlineArtifactView
        let title: String
        var count: Int? = nil
        var id: InlineArtifactView { view }
    }
}

/// "Open": 28pt, radius 10, muted until the pointer is over it.
struct InlineArtifactOpenStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
                .padding(.horizontal, JunoSpace.close)
                .frame(minHeight: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoHover.opacity(hovered ? 1 : 0))
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

// MARK: - Console and failure

/// The page's console: a header, then its last 80 lines in the theme's inks.
struct InlineArtifactConsole: View {
    let entries: [ArtifactRuntimeModel.Entry]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.terminal, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                Text("Console")
                    .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            Rectangle().fill(Color.junoBorder.opacity(0.6)).frame(height: 1).accessibilityHidden(true)
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    if entries.isEmpty {
                        Text("No console output yet.")
                            .junoFont(size: 11, relativeTo: .caption2)
                            .foregroundStyle(Color.junoSecondaryInk)
                    } else {
                        ForEach(entries.suffix(80)) { entry in
                            Text(entry.text)
                                .junoFont(size: 10.5, relativeTo: .caption2, design: .monospaced)
                                .lineSpacing(4)
                                .foregroundStyle(ink(entry.level))
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(JunoSpace.cozy)
            }
        }
        .background(Color.junoCard)
    }

    private func ink(_ level: ArtifactRuntimeLevel) -> Color {
        switch level {
        case .error: .junoDestructiveInk
        case .warn: .junoWarningInk
        case .info: .junoSource
        case .log: .junoForeground
        }
    }
}

/// A settled artifact with no source: a failure, not a placeholder — the web's
/// `EmptyState tone="error"`, inset so its border is not clipped by the card.
struct InlineArtifactUnavailable: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: JunoSpace.snug) {
            JunoIconView(.error, size: 20)
                .foregroundStyle(Color.junoDestructiveInk)
                .accessibilityHidden(true)
            Text("Source unavailable")
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
            Text("This artifact was referenced in the message but its content isn’t available here yet.")
                .junoFont(size: 12, relativeTo: .caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, minHeight: 140)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoDestructive.opacity(colorScheme == .dark ? 0.14 : 0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoDestructive.opacity(0.4), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Code

/// An artifact's source, read-only: `junoMuted`, 10.5pt mono on a 20pt line,
/// a numbered gutter with a hairline, and horizontal scrolling for everything
/// but Markdown, which wraps. While the source is streaming it follows the
/// tail — unless the reader has scrolled more than 48pt up to read.
struct ArtifactCodeSurface: View {
    let source: String
    var wraps = false
    var followsTail = false
    var accessibilityLabel = "Source"

    @State private var nearBottom = true
    /// The visible height, so the gutter's hairline runs the full height of a
    /// short source rather than stopping at its last line.
    @State private var viewport: CGFloat = 0

    private var lines: [Substring] {
        let split = source.split(separator: "\n", omittingEmptySubsequences: false)
        return source.hasSuffix("\n") && split.count > 1 ? Array(split.dropLast()) : split
    }

    /// Wide enough for the largest line number, plus the gutter's padding.
    private var gutterWidth: CGFloat {
        CGFloat(max(2, String(lines.count).count)) * 7 + 2 * JunoSpace.snug
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(wraps ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .top, spacing: 0) {
                            Text("\(index + 1)")
                                .foregroundStyle(Color.junoSecondaryInk.opacity(0.7))
                                .frame(width: gutterWidth - 2 * JunoSpace.snug, alignment: .trailing)
                                .padding(.horizontal, JunoSpace.snug)
                                .accessibilityHidden(true)
                            Text(line.isEmpty ? " " : String(line))
                                .foregroundStyle(Color.junoForeground)
                                .fixedSize(horizontal: !wraps, vertical: true)
                                .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
                                .padding(.leading, JunoSpace.cozy)
                                .padding(.trailing, JunoSpace.wide)
                        }
                        .frame(minHeight: 20, alignment: .topLeading)
                    }
                    Color.clear.frame(height: JunoSpace.cozy).id(Self.tail)
                }
                .junoFont(size: 10.5, relativeTo: .caption2, design: .monospaced)
                .lineSpacing(6)
                .textSelection(.enabled)
                .padding(.top, JunoSpace.cozy)
                .frame(minHeight: viewport, alignment: .top)
                .background(alignment: .leading) {
                    // The gutter's hairline, the full height of the source.
                    Color.clear
                        .frame(width: gutterWidth)
                        .overlay(alignment: .trailing) {
                            Rectangle().fill(Color.junoBorder.opacity(0.4)).frame(width: 1)
                        }
                }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 48
            } action: { _, isNear in
                nearBottom = isNear
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
            .onChange(of: source) { _, _ in
                guard followsTail, nearBottom else { return }
                proxy.scrollTo(Self.tail, anchor: .bottom)
            }
            .onAppear {
                if followsTail { proxy.scrollTo(Self.tail, anchor: .bottom) }
            }
        }
        .background(Color.junoMuted)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(source)
    }

    private static let tail = "artifact-code-tail"
}
