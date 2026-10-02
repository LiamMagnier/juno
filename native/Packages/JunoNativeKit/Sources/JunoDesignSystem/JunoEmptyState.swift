import SwiftUI

#if os(macOS)

// MARK: - Empty states

/// "There is nothing here yet", and "that did not load" (spec §9, rebuilt on
/// the web's `components/ui/empty-state.tsx`).
///
/// **Two sizes, two frames.**
/// - ``Size/page`` owns the content column, so it is drawn *open*: no box, a
///   48pt glyph tile, an 18pt heading and a sentence on the page itself. The
///   web retired the column-high dashed recess because it read as a drop zone
///   for files rather than an answer.
/// - ``Size/panel`` sits inside a card, a section or a list, where it needs a
///   boundary to say where the empty part is: the one place the dashed well
///   stays — the canvas fill under a dashed `--border` at 0.8, at the card
///   radius (16), which is what the web draws today. Errata 9 had the well at
///   the field radius; the web moved it (register #47).
///
/// **Two tones, and the difference is the tile.** An error keeps the heading
/// in the foreground ink and tints only the tile (the destructive wash under a
/// destructive glyph); a panel error trades the dashed edge for a solid one,
/// because a failure is not a placeholder. Left unset, the tone follows the
/// glyph: a warning or failure mark reads as an error.
///
/// It arrives on the workhorse entrance — a 6pt rise and a fade, the fade
/// alone under Reduce Motion — because an empty state appears when the reader
/// filtered, searched or opened something, and a settle says "this is the
/// answer" where a cut says "the page broke".
///
/// The action is the system's neutral `.bordered` button (the web's
/// `secondary`): an empty state offers a way on, not the page's one primary
/// action — and it is opaque, never glass (§0.1).
public struct JunoEmptyState: View {
    public enum Size: Sendable {
        case page
        case panel
    }

    public enum Tone: Sendable {
        case empty
        case error
    }

    private let title: String
    private let message: String?
    private let icon: JunoIcon
    private let actionLabel: String?
    private let perform: (() -> Void)?
    private let size: Size
    private let tone: Tone
    /// The web's two-action states (Library: Upload files and Go to chat;
    /// Artifacts: Start building and New design ▾), and a page-size state
    /// that carries the page's one prominent button while the header's copy
    /// of it is withheld (Phase 4 brief §2.1).
    private let actions: AnyView?

    @State private var hasArrived = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Drawn with one of the website's own marks — the thing that is missing
    /// has a glyph on the web, and the empty state names it the way every
    /// other surface does.
    public init(
        title: String,
        message: String? = nil,
        icon: JunoIcon,
        actionLabel: String? = nil,
        action: (() -> Void)? = nil,
        size: Size = .page,
        tone: Tone? = nil
    ) {
        self.title = title
        self.message = message
        self.icon = icon
        self.actionLabel = actionLabel
        self.perform = action
        self.size = size
        self.tone = tone ?? Self.tone(for: icon)
        actions = nil
    }

    /// A state whose actions are the page's own buttons, laid out in a row.
    public init<Actions: View>(
        title: String,
        message: String? = nil,
        icon: JunoIcon,
        size: Size = .page,
        tone: Tone? = nil,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.message = message
        self.icon = icon
        actionLabel = nil
        perform = nil
        self.size = size
        self.tone = tone ?? Self.tone(for: icon)
        self.actions = AnyView(actions())
    }

    /// The marks that mean something went wrong.
    static func tone(for icon: JunoIcon) -> Tone {
        switch icon {
        case .error, .triangleAlert, .warning, .octagonX, .circleX, .wifiOff, .cloudOff: .error
        default: .empty
        }
    }

    private var isPage: Bool { size == .page }

    public var body: some View {
        Group {
            if isPage {
                content
                    .padding(.horizontal, JunoSpace.section)
                    .padding(.vertical, JunoSpace.vast + JunoSpace.regular)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                content
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.wide)
                    .frame(maxWidth: .infinity)
                    .background(well)
            }
        }
        .opacity(hasArrived ? 1 : 0)
        .offset(y: hasArrived || reduceMotion ? 0 : JunoMotion.riseDistance)
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)) {
                hasArrived = true
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var content: some View {
        VStack(spacing: 0) {
            tile
            Text(title)
                .junoType(isPage ? .heading : JunoType.body.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(isPage ? .isHeader : [])
                .padding(.top, isPage ? JunoSpace.regular : JunoSpace.cozy)
            if let message {
                Text(message)
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: JunoEmptyStateMetrics.messageMeasure)
                    .padding(.top, isPage ? JunoSpace.tight : JunoSpace.hairline)
            }
            if let actions {
                HStack(spacing: JunoSpace.snug) {
                    actions
                }
                .controlSize(.regular)
                .padding(.top, isPage ? JunoSpace.section : JunoSpace.regular)
            } else if let actionLabel, let perform {
                Button(actionLabel, action: perform)
                    .buttonStyle(.bordered)
                    // Neutral: the detail column's accent tint must not turn the
                    // outline coral (Phase 2 review).
                    .tint(nil)
                    .controlSize(.regular)
                    .contentShape(.rect)
                    .padding(.top, isPage ? JunoSpace.section : JunoSpace.regular)
            }
        }
    }

    /// The glyph on its tile: 48 at the field radius (page), 36 at the
    /// control radius (panel); the secondary fill, or the destructive wash.
    private var tile: some View {
        let side = isPage ? JunoEmptyStateMetrics.pageTile : JunoEmptyStateMetrics.panelTile
        let radius = isPage ? JunoRadius.field : JunoRadius.control
        return JunoIconView(icon, size: isPage ? JunoEmptyStateMetrics.pageGlyph : JunoEmptyStateMetrics.panelGlyph)
            .foregroundStyle(tone == .error ? Color.junoDestructiveInk : Color.junoMutedForeground)
            .frame(width: side, height: side)
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(tone == .error ? Color.junoDestructive.opacity(0.1) : Color.junoSecondary)
            )
            .accessibilityHidden(true)
    }

    /// The panel's recess: `.surface-inset` with a dashed edge (solid for an
    /// error), at the card radius.
    private var well: some View {
        let shape = RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        return shape
            .fill(Color.junoCanvas)
            .overlay {
                shape.strokeBorder(
                    Color.junoBorder.opacity(0.8),
                    style: StrokeStyle(lineWidth: 1, dash: tone == .error ? [] : [4, 3])
                )
            }
    }
}

/// The empty state's measures (web `empty-state.tsx`).
public enum JunoEmptyStateMetrics {
    /// `size-12` and `size-6`.
    public static let pageTile: CGFloat = 48
    public static let pageGlyph: CGFloat = 24
    /// `size-9` and `size-5`.
    public static let panelTile: CGFloat = 36
    public static let panelGlyph: CGFloat = 20
    /// `max-w-sm`.
    public static let messageMeasure: CGFloat = 384
}

#endif
