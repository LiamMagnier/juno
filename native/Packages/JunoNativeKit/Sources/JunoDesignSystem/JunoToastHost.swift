import Observation
import SwiftUI

// MARK: - The message

/// One toast: a status, a sentence, and at most an offer and a dismissal
/// (spec §7.7; web `components/ui/sonner.tsx`).
///
/// **The tier lives in the glyph, not the sentence.** The title keeps the
/// foreground ink and the 16pt mark carries the status on its ink ramp, as
/// the web's `TOAST_ICONS` do: a red paragraph for every failure made the
/// message harder to read at exactly the moment it mattered.
public struct JunoToast: Identifiable {
    /// The status the glyph states. Nil draws no glyph at all.
    public enum Tone: Sendable, Equatable {
        /// `ph.checkcircle` in the success ink: something finished.
        case success
        /// `ph.warningcircle` in the destructive ink: something did not.
        case error
        /// `ph.warning` in the warning ink: something needs a look.
        case warning
        /// `ph.info` in the secondary ink: something to know.
        case info
        /// The set's one spinner, in the secondary ink: something under way.
        case loading
    }

    /// A button on the toast — "Undo", "Retry", "Keep mine" — or on the
    /// selection bar.
    public struct Action: Identifiable {
        public let id = UUID()
        public let title: String
        public let icon: JunoIcon?
        /// `.destructive` draws the web's destructive outline on the selection
        /// bar ("Delete"); a toast's own buttons are always neutral.
        public let role: ButtonRole?
        public let perform: @MainActor () -> Void

        public init(
            _ title: String,
            icon: JunoIcon? = nil,
            role: ButtonRole? = nil,
            perform: @escaping @MainActor () -> Void
        ) {
            self.title = title
            self.icon = icon
            self.role = role
            self.perform = perform
        }
    }

    /// How long a toast stays when nobody is pointing at it: sonner's own
    /// 4000ms, which is also the spec's 4s.
    public static let defaultDuration: Duration = .seconds(4)

    /// Posting a toast with an id that is already showing replaces it in
    /// place, and ``JunoToastNotifier/dismiss(_:)`` takes it down by that id —
    /// which is how a standing condition ("Settings changed on another
    /// device") keeps one toast rather than stacking a new one per change.
    public var id: String
    public var tone: Tone?
    public var title: String
    /// The second line, in the secondary ink (the web's `description`).
    public var detail: String?
    /// The offer: a neutral bordered button (the web's `[data-button]`).
    public var action: Action?
    /// A second, quieter offer: the ghost of the first (`[data-cancel]`).
    public var cancel: Action?
    /// Nil keeps the toast until it is dismissed — for a decision the reader
    /// owes, which a 4s timer would take away before it was read.
    public var duration: Duration?
    /// Changes on every post, so a re-post of the same id still reads as new
    /// to VoiceOver and restarts its timer.
    let instance = UUID()

    public init(
        id: String = UUID().uuidString,
        tone: Tone? = nil,
        title: String,
        detail: String? = nil,
        action: Action? = nil,
        cancel: Action? = nil,
        duration: Duration? = JunoToast.defaultDuration
    ) {
        self.id = id
        self.tone = tone
        self.title = title
        self.detail = detail
        self.action = action
        self.cancel = cancel
        self.duration = duration
    }

    public static func success(_ title: String, detail: String? = nil, action: Action? = nil) -> JunoToast {
        JunoToast(tone: .success, title: title, detail: detail, action: action)
    }

    public static func error(_ title: String, detail: String? = nil, action: Action? = nil) -> JunoToast {
        JunoToast(tone: .error, title: title, detail: detail, action: action)
    }

    public static func warning(_ title: String, detail: String? = nil, action: Action? = nil) -> JunoToast {
        JunoToast(tone: .warning, title: title, detail: detail, action: action)
    }

    public static func info(_ title: String, detail: String? = nil, action: Action? = nil) -> JunoToast {
        JunoToast(tone: .info, title: title, detail: detail, action: action)
    }
}

/// The host's selection mode (§7.7): the Library's multi-select bar — "3
/// selected", what can be done to them, and the way out.
///
/// The web's bulk bar (`library/page.tsx`): `.surface-float` at the card
/// radius, the count in 13pt medium tabular figures, ghost actions and a
/// destructive outline, and a clear ✕.
public struct JunoToastSelection {
    public var count: Int
    public var actions: [JunoToast.Action]
    public var clear: @MainActor () -> Void

    public init(count: Int, actions: [JunoToast.Action] = [], clear: @escaping @MainActor () -> Void) {
        self.count = count
        self.actions = actions
        self.clear = clear
    }
}

// MARK: - The center

/// The window's toasts: what is showing, and the selection bar.
///
/// One per window. The window creates it, hands it to everything below as
/// ``SwiftUI/EnvironmentValues/junoToast`` and draws it once with
/// ``SwiftUI/View/junoToastHost(_:)``; pages, the transcript and the sidebar
/// post through the environment and never draw a toast of their own.
@MainActor
@Observable
public final class JunoToastCenter {
    /// The toast on screen. A newer post replaces it: the web stacks up to
    /// three, but a stack of glass cards over a reading column is three
    /// pieces of chrome where one says the newest thing.
    public private(set) var current: JunoToast?
    /// The selection bar, while a page has something selected.
    public private(set) var selection: JunoToastSelection?

    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var isHovering = false

    public init() {}

    public func post(_ toast: JunoToast) {
        current = toast
        AccessibilityNotification.Announcement(Self.announcement(for: toast)).post()
        schedule(toast)
    }

    /// Takes the toast down: the one with `id`, or whichever is showing.
    public func dismiss(id: String? = nil) {
        guard let current, id == nil || current.id == id else { return }
        timer?.cancel()
        timer = nil
        self.current = nil
    }

    public func setSelection(_ selection: JunoToastSelection?) {
        self.selection = selection.flatMap { $0.count > 0 ? $0 : nil }
    }

    /// The pointer over the host holds the toast, as sonner's hover does; it
    /// gets its whole time again when the pointer leaves.
    func setHovering(_ hovering: Bool) {
        isHovering = hovering
        if hovering {
            timer?.cancel()
            timer = nil
        } else if let current {
            schedule(current)
        }
    }

    private func schedule(_ toast: JunoToast) {
        timer?.cancel()
        timer = nil
        guard let duration = toast.duration, !isHovering else { return }
        let instance = toast.instance
        timer = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, let self, self.current?.instance == instance else { return }
            self.current = nil
        }
    }

    private static func announcement(for toast: JunoToast) -> String {
        [toast.title, toast.detail].compactMap { $0 }.joined(separator: ". ")
    }
}

/// How a view below the window's host posts a toast:
/// `@Environment(\.junoToast) private var toast` then `toast(.success("Saved"))`.
///
/// Outside a host it does nothing, so a page drawn in a snapshot or a preview
/// can post without a window around it.
public struct JunoToastNotifier {
    private weak var center: JunoToastCenter?

    public init() {}

    public init(center: JunoToastCenter) {
        self.center = center
    }

    @MainActor
    public func callAsFunction(_ toast: JunoToast) {
        center?.post(toast)
    }

    @MainActor
    public func post(_ toast: JunoToast) {
        center?.post(toast)
    }

    @MainActor
    public func dismiss(_ id: String) {
        center?.dismiss(id: id)
    }

    @MainActor
    public func setSelection(_ selection: JunoToastSelection?) {
        center?.setSelection(selection)
    }
}

public extension EnvironmentValues {
    /// The window's toast host. See ``JunoToastNotifier``.
    @Entry var junoToast = JunoToastNotifier()
}

// MARK: - Placement

/// Where the composer is, for the host to sit 12pt above it (§7.7). Nil —
/// no composer on screen — puts the host 24pt above the window's bottom.
public struct JunoToastAnchorKey: PreferenceKey {
    public static var defaultValue: Anchor<CGRect>? { nil }

    public static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

public extension View {
    /// Draws the window's toasts over this view, once, and hands the center
    /// to everything below as ``SwiftUI/EnvironmentValues/junoToast``. Put it
    /// on the window's content — never inside a sheet.
    func junoToastHost(_ center: JunoToastCenter) -> some View {
        modifier(JunoToastHostModifier(center: center))
    }

    /// Hands the center to everything below without drawing it — for the part
    /// of a window (a sidebar, a sheet's presenter) that posts to a host drawn
    /// elsewhere in the same window.
    func junoToastNotifier(_ center: JunoToastCenter) -> some View {
        environment(\.junoToast, JunoToastNotifier(center: center))
    }

    /// Marks the composer this view is: the host sits 12pt above its top
    /// edge, centred on it, while `isActive`.
    func junoToastAnchor(_ isActive: Bool = true) -> some View {
        anchorPreference(key: JunoToastAnchorKey.self, value: .bounds) { isActive ? $0 : nil }
    }

    /// Says a standing condition in the window's toast host: posts
    /// `toast(condition)` under `id` whenever `condition` changes to a value,
    /// and takes it down when it clears or this view goes. For the failures
    /// and conflicts pages used to float their own glass for (§7.7).
    func junoToastStatus<Key: Equatable>(
        id: String,
        _ condition: Key?,
        toast make: @escaping (Key) -> JunoToast
    ) -> some View {
        modifier(JunoToastStatusModifier(id: id, condition: condition, make: make))
    }

    /// Raises the host's selection bar while `selection` has a count, and
    /// takes it down when this view goes. `id` is what the bar is rebuilt on —
    /// the selected set itself, usually.
    func junoToastSelection<ID: Equatable>(_ selection: JunoToastSelection?, id: ID) -> some View {
        modifier(JunoToastSelectionModifier(selection: selection, id: id))
    }
}

/// The metrics of the host (spec §7.7, errata 9, web `sonner.tsx`).
public enum JunoToastMetrics {
    /// At most 420 wide (§7.7), and no narrower than a sentence needs.
    public static let maxWidth: CGFloat = 420
    public static let minWidth: CGFloat = 300
    /// The web's `rounded-card`: a toast is a card that floats, not a capsule
    /// (errata 9).
    public static let cornerRadius: CGFloat = JunoRadius.card
    /// 12pt above the composer's top edge; 24pt above the window's bottom
    /// where there is no composer.
    public static let composerClearance: CGFloat = JunoSpace.cozy
    public static let bottomClearance: CGFloat = JunoSpace.section
    /// The side margin kept inside a narrow column.
    public static let sideMargin: CGFloat = JunoSpace.regular
    /// The Mac's pointer rung for the toast's buttons (the web's are 32px).
    public static let buttonHeight: CGFloat = 28
    /// sonner's `min-h-12`.
    public static let minHeight: CGFloat = 48
    public static let glyphSize: CGFloat = 16
}

private struct JunoToastHostModifier: ViewModifier {
    let center: JunoToastCenter

    func body(content: Content) -> some View {
        content
            .environment(\.junoToast, JunoToastNotifier(center: center))
            .overlayPreferenceValue(JunoToastAnchorKey.self) { anchor in
                GeometryReader { proxy in
                    let composer = anchor.map { proxy[$0] }
                    let bottom = composer.map {
                        max(proxy.size.height - $0.minY, 0) + JunoToastMetrics.composerClearance
                    } ?? JunoToastMetrics.bottomClearance
                    let midX = composer?.midX ?? proxy.size.width / 2
                    JunoToastStack(center: center)
                        .frame(maxWidth: max(proxy.size.width - JunoToastMetrics.sideMargin * 2, 0))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, bottom)
                        .offset(x: midX - proxy.size.width / 2)
                }
            }
    }
}

private struct JunoToastStatusModifier<Key: Equatable>: ViewModifier {
    let id: String
    let condition: Key?
    let make: (Key) -> JunoToast
    @Environment(\.junoToast) private var toast

    func body(content: Content) -> some View {
        content
            .onChange(of: condition, initial: true) { _, value in
                if let value {
                    var posted = make(value)
                    posted.id = id
                    toast.post(posted)
                } else {
                    toast.dismiss(id)
                }
            }
            .onDisappear { toast.dismiss(id) }
    }
}

private struct JunoToastSelectionModifier<ID: Equatable>: ViewModifier {
    let selection: JunoToastSelection?
    let id: ID
    @Environment(\.junoToast) private var toast

    func body(content: Content) -> some View {
        content
            .onChange(of: id, initial: true) { _, _ in toast.setSelection(selection) }
            .onDisappear { toast.setSelection(nil) }
    }
}

// MARK: - Drawing

/// The toast over the selection bar, in one glass container so the two
/// sample the same backdrop.
struct JunoToastStack: View {
    let center: JunoToastCenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GlassEffectContainer(spacing: JunoSpace.snug) {
            VStack(spacing: JunoSpace.snug) {
                if let toast = center.current {
                    JunoToastCard(toast: toast) { center.dismiss(id: toast.id) }
                        .id(toast.instance)
                        .transition(transition)
                }
                if let selection = center.selection {
                    JunoToastSelectionBar(selection: selection)
                        .transition(transition)
                }
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.outSoft(JunoMotion.Duration.base), when: reduceMotion), value: center.current?.instance)
        .animation(JunoMotion.reduced(JunoMotion.outSoft(JunoMotion.Duration.base), when: reduceMotion), value: center.selection?.count)
        .onHover { center.setHovering($0) }
    }

    /// A 4pt rise and a fade in over 220ms on `outSoft`; a fade out over
    /// 160ms on `in`. Under Reduce Motion the rise is the travel that goes.
    private var transition: AnyTransition {
        .asymmetric(
            insertion: .opacity
                .combined(with: .offset(y: reduceMotion ? 0 : JunoSpace.hairline))
                .animation(JunoMotion.outSoft(JunoMotion.Duration.base)),
            removal: .opacity.animation(JunoMotion.exit)
        )
    }
}

/// One toast: the status glyph, the sentence, the offer and the dismiss.
public struct JunoToastCard: View {
    let toast: JunoToast
    let dismiss: @MainActor () -> Void

    public init(toast: JunoToast, dismiss: @escaping @MainActor () -> Void) {
        self.toast = toast
        self.dismiss = dismiss
    }

    public var body: some View {
        JunoToastWidth(minWidth: JunoToastMetrics.minWidth, maxWidth: JunoToastMetrics.maxWidth).callAsFunction {
            // One row while the sentence and its offers fit in 420; otherwise
            // the offers drop under the sentence, trailing, rather than
            // squeezing it into a column of single words.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: JunoSpace.close) {
                    glyph
                    words
                    offers
                    JunoToastCloseButton(label: "Dismiss", action: dismiss)
                }
                VStack(alignment: .trailing, spacing: JunoSpace.snug) {
                    HStack(alignment: .center, spacing: JunoSpace.close) {
                        glyph
                        words
                        JunoToastCloseButton(label: "Dismiss", action: dismiss)
                    }
                    HStack(spacing: JunoSpace.snug) {
                        offers
                    }
                    .padding(.trailing, JunoSpace.hairline)
                }
            }
            .padding(.leading, JunoSpace.regular)
            .padding(.trailing, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .frame(minHeight: JunoToastMetrics.minHeight)
            .modifier(JunoToastSurface())
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var glyph: some View {
        if let tone = toast.tone {
            JunoToastGlyph(tone: tone)
        }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text(toast.title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            if let detail = toast.detail {
                Text(detail)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoMutedForeground)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var offers: some View {
        if let cancel = toast.cancel {
            JunoToastButton(action: cancel, kind: .ghost) { dismiss() }
        }
        if let action = toast.action {
            JunoToastButton(action: action, kind: .neutral) { dismiss() }
        }
    }
}

/// The selection bar: "N selected", what can be done, and the clear ✕.
public struct JunoToastSelectionBar: View {
    let selection: JunoToastSelection

    public init(selection: JunoToastSelection) {
        self.selection = selection
    }

    public var body: some View {
        JunoToastWidth(minWidth: JunoToastMetrics.minWidth, maxWidth: JunoToastMetrics.maxWidth).callAsFunction {
            HStack(spacing: JunoSpace.hairline) {
                Text("\(selection.count) selected")
                    .junoType(JunoType.ui.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoForeground)
                    .contentTransition(.numericText())
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(selection.actions) { action in
                    JunoToastButton(action: action, kind: action.role == .destructive ? .destructive : .ghost) {}
                }
                JunoToastCloseButton(label: "Clear selection", action: selection.clear)
            }
            .padding(.leading, JunoSpace.regular)
            .padding(.trailing, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .frame(minHeight: JunoToastMetrics.minHeight)
            .modifier(JunoToastSurface())
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(selection.count) selected")
    }
}

/// The status mark, on its ink ramp (web `TOAST_ICONS`).
private struct JunoToastGlyph: View {
    let tone: JunoToast.Tone

    var body: some View {
        Group {
            switch tone {
            case .success:
                JunoIconView(.circleCheck, size: JunoToastMetrics.glyphSize)
                    .foregroundStyle(Color.junoSuccessInk)
            case .error:
                JunoIconView(.error, size: JunoToastMetrics.glyphSize)
                    .foregroundStyle(Color.junoDestructiveInk)
            case .warning:
                JunoIconView(.warning, size: JunoToastMetrics.glyphSize)
                    .foregroundStyle(Color.junoWarningInk)
            case .info:
                JunoIconView(.info, size: JunoToastMetrics.glyphSize)
                    .foregroundStyle(Color.junoMutedForeground)
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .frame(width: JunoToastMetrics.glyphSize, height: JunoToastMetrics.glyphSize)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Glass in the one allow-listed site (§0.1), or its Reduce Transparency
/// recipe: the web's `.surface-float` — the popover fill, a hairline at 0.9
/// and the float throw.
private struct JunoToastSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: JunoToastMetrics.cornerRadius, style: .continuous)
    }

    func body(content: Content) -> some View {
        if reduceTransparency || snapshotOpaqueGlass {
            content
                .background {
                    shape
                        .fill(Color.junoPopover)
                        .shadow(color: Color.junoCardShadow, radius: JunoSpace.cozy, y: JunoSpace.hairline)
                }
                .overlay {
                    shape.strokeBorder(
                        Color.junoBorder.opacity(contrast == .increased ? 1 : 0.9),
                        lineWidth: 1
                    )
                }
        } else {
            content
                .glassEffect(.regular, in: shape)
                .glassEffectTransition(.materialize)
                .overlay {
                    if contrast == .increased {
                        shape.strokeBorder(Color.junoBorder, lineWidth: 1)
                    }
                }
        }
    }
}

/// A toast's or the selection bar's button.
private struct JunoToastButton: View {
    enum Kind {
        /// The web's toast button: the secondary fill under a hairline.
        case neutral
        /// Its ghost: no fill until the pointer arrives.
        case ghost
        /// The selection bar's "Delete": the destructive outline.
        case destructive
    }

    let action: JunoToast.Action
    let kind: Kind
    /// What the host does after the action — a toast goes away once its offer
    /// is taken.
    let then: @MainActor () -> Void

    init(action: JunoToast.Action, kind: Kind, then: @escaping @MainActor () -> Void) {
        self.action = action
        self.kind = kind
        self.then = then
    }

    var body: some View {
        Button(role: action.role) {
            action.perform()
            then()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                if let icon = action.icon {
                    JunoIconView(icon, size: JunoSegmentedMetrics.iconSize)
                        .accessibilityHidden(true)
                }
                Text(action.title)
                    .junoType(JunoType.ui.weight(.medium))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .buttonStyle(JunoToastButtonStyle(kind: kind))
        .contentShape(.rect(cornerRadius: JunoRadius.control))
    }
}

private struct JunoToastButtonStyle: ButtonStyle {
    let kind: JunoToastButton.Kind

    func makeBody(configuration: Configuration) -> some View {
        StyledBody(configuration: configuration, kind: kind)
    }

    private struct StyledBody: View {
        let configuration: ButtonStyleConfiguration
        let kind: JunoToastButton.Kind
        @State private var isHovering = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        private var shape: RoundedRectangle {
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
        }

        private var fill: Color {
            switch kind {
            case .neutral: isHovering ? Color.junoHover : Color.junoSecondary
            case .ghost: isHovering ? Color.junoHover : Color.clear
            case .destructive: isHovering ? Color.junoDestructive.opacity(0.08) : Color.clear
            }
        }

        private var edge: Color {
            switch kind {
            case .neutral: isHovering ? Color.junoForeground.opacity(0.18) : Color.junoBorder
            case .ghost: Color.clear
            case .destructive: Color.junoDestructive.opacity(0.4)
            }
        }

        private var ink: Color {
            kind == .destructive ? Color.junoDestructiveInk : Color.junoForeground
        }

        var body: some View {
            configuration.label
                .foregroundStyle(ink)
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: JunoToastMetrics.buttonHeight)
                .background(shape.fill(fill))
                .overlay(shape.strokeBorder(edge, lineWidth: 1))
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .onHover { isHovering = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isHovering)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The dismiss: a 24pt circle drawn inside the toast's edge, hit at 28.
private struct JunoToastCloseButton: View {
    let label: String
    let action: @MainActor () -> Void
    @State private var isHovering = false

    var body: some View {
        Button {
            action()
        } label: {
            JunoIconView(.dismiss, size: JunoSegmentedMetrics.iconSize)
                .foregroundStyle(isHovering ? Color.junoForeground : Color.junoMutedForeground)
                .frame(width: JunoSpace.section, height: JunoSpace.section)
                .background(Circle().fill(isHovering ? Color.junoHover : Color.clear))
                .frame(width: JunoToastMetrics.buttonHeight, height: JunoToastMetrics.buttonHeight)
        }
        .buttonStyle(.junoPress)
        .contentShape(Circle())
        .onHover { isHovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

/// As wide as its content wants, between `minWidth` and `maxWidth` (or the
/// width offered, if that is less), and wrapping at that width — so "Chat
/// archived." is a short card and a long failure wraps at 420 rather than
/// running off it.
private struct JunoToastWidth: Layout {
    var minWidth: CGFloat
    var maxWidth: CGFloat

    init(minWidth: CGFloat, maxWidth: CGFloat) {
        self.minWidth = minWidth
        self.maxWidth = maxWidth
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let limit = min(maxWidth, proposal.width ?? maxWidth)
        let ideal = child.sizeThatFits(.unspecified).width
        let width = min(max(ideal, min(minWidth, limit)), limit)
        let height = child.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}
