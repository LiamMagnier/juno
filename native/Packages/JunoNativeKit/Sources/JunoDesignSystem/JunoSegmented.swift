import SwiftUI

// MARK: - Segmented control

/// One segment of a ``JunoSegmented``: a value, its words, and what rides
/// beside them.
public struct JunoSegmentedOption<Value: Hashable>: Identifiable {
    public let value: Value
    public let title: String
    /// A mark before the title, in the label's ink. It never animates on its
    /// own: the thumb is the thing that moves.
    public let icon: JunoIcon?
    /// A live tally after the title — "All 12", "Images 5" — in the mono
    /// micro rung at the segment's own ink (the web's `count`).
    public let count: Int?
    /// Things waiting on the reader behind this segment, as a small accent
    /// disc (the web's `badge`). Absent at zero and on the selected segment.
    public let badge: Int?
    public let isDisabled: Bool

    public var id: Value { value }

    public init(
        _ value: Value,
        _ title: String,
        icon: JunoIcon? = nil,
        count: Int? = nil,
        badge: Int? = nil,
        isDisabled: Bool = false
    ) {
        self.value = value
        self.title = title
        self.icon = icon
        self.count = count
        self.badge = badge
        self.isDisabled = isDisabled
    }
}

/// The metrics of ``JunoSegmented`` (spec §9, web `segmented-control.tsx`).
public enum JunoSegmentedMetrics {
    /// The whole control: the Mac's pointer rung over the web's 36px `h-9`
    /// (register #10, the same 4pt the other controls give up).
    public static let trackHeight: CGFloat = 32
    /// `p-1`, and the `gap-1` between segments.
    public static let inset: CGFloat = JunoSpace.hairline
    /// The thumb, and the segment it marks: the track less its inset.
    public static var segmentHeight: CGFloat { trackHeight - inset * 2 }
    /// `rounded-menu` (14) outside, `rounded-control` (10) inside: concentric
    /// across the 4pt inset.
    public static let trackRadius: CGFloat = JunoRadius.menu
    public static let thumbRadius: CGFloat = JunoRadius.control
    /// `px-3`.
    public static let segmentPadding: CGFloat = JunoSpace.cozy
    /// `size-3.5`: a mark beside a 13pt word.
    public static let iconSize: CGFloat = 14
    /// The compact track, for a switch that sits in a card's header (an
    /// inline artifact's Preview / Code): the pointer rung, 11pt labels.
    public static let compactTrackHeight: CGFloat = 28
    public static let compactSegmentPadding: CGFloat = JunoSpace.snug
    /// The glass track's inset around its lens, and the gap between segments.
    public static let glassInset: CGFloat = 3
    public static let glassGap: CGFloat = 2
}

/// How large a ``JunoSegmented`` is drawn: a page's 32pt control, or the
/// compact 28pt one a card header carries.
public enum JunoSegmentedSize: Sendable {
    case regular
    case compact

    var trackHeight: CGFloat {
        self == .compact ? JunoSegmentedMetrics.compactTrackHeight : JunoSegmentedMetrics.trackHeight
    }

    var segmentHeight: CGFloat { trackHeight - JunoSegmentedMetrics.inset * 2 }

    var glassSegmentHeight: CGFloat { trackHeight - JunoSegmentedMetrics.glassInset * 2 }

    var segmentPadding: CGFloat {
        self == .compact ? JunoSegmentedMetrics.compactSegmentPadding : JunoSegmentedMetrics.segmentPadding
    }
}

/// Juno's segmented control: an inset track with one raised thumb that
/// slides between equal segments.
///
/// It replaces `DesktopSegmented` and every system `.segmented` `Picker` in
/// content (§9), which drew the system accent and AppKit's slab chrome — the
/// wrong weight for a control that sits *inside* a page.
///
/// **The web's control, measured** (`segmented-control.tsx`):
/// - the track is `.surface-inset` — the canvas fill under a 1pt `--border`
///   at 0.8 — at radius 14 with a 4pt inset, 32pt tall on the Mac;
/// - the thumb is `.surface-raised` — the card fill, the same hairline and
///   `--shadow-raised` — at radius 10, carried between segments on the
///   standard spring;
/// - segments share the track equally (the web's `repeat(n, 1fr)` grid), so a
///   digit arriving in a count never moves the thumb;
/// - labels are 13pt medium; the unselected ink is muted and a faint wash
///   names the segment under the pointer; a press dips the segment, thumb and
///   legend together, to 0.97;
/// - counts are mono micro at the segment's own ink. The spec's 70% dimming
///   is gone because the web dropped it (2.9:1 in light); register #46.
///
/// **The container is not `.focusable()`.** SwiftUI hands initial focus to
/// the first focusable view, so a focusable switcher wears a permanent ring on
/// a freshly opened window. The segments are ordinary buttons — Full Keyboard
/// Access tabs to them and Space presses them — and VoiceOver adjusts the
/// whole control through the adjustable action.
public struct JunoSegmented<Value: Hashable>: View {
    public typealias Option = JunoSegmentedOption<Value>

    private let options: [Option]
    @Binding private var selection: Value
    private let accessibilityLabel: String
    private let optionAccessibilityIdentifier: ((Value) -> String)?
    /// Whether the segments share the width they are offered rather than the
    /// widest label's. A switch that spans its column fills; a filter in a
    /// page's controls row hugs its words.
    private let fills: Bool
    private let size: JunoSegmentedSize

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        options: [Option],
        selection: Binding<Value>,
        accessibilityLabel: String,
        optionAccessibilityIdentifier: ((Value) -> String)? = nil,
        fills: Bool = false,
        size: JunoSegmentedSize = .regular
    ) {
        self.options = options
        _selection = selection
        self.accessibilityLabel = accessibilityLabel
        self.optionAccessibilityIdentifier = optionAccessibilityIdentifier
        self.fills = fills
        self.size = size
    }

    public var body: some View {
        #if os(macOS)
        glassControl
        #else
        drawnControl
        #endif
    }

    #if os(macOS)
    /// The Mac's control (round 3): the segments on one capsule of Liquid
    /// Glass, the selection a soft ink lens that slides between them on the
    /// standard spring — the toolbar's own vocabulary, brought into the page.
    /// The owner retired AppKit's white segmented slab here. Counts and
    /// waiting badges ride inside their segment as on the web.
    private var glassControl: some View {
        JunoEqualWidthRow(spacing: JunoSegmentedMetrics.glassGap, fills: fills).callAsFunction {
            ForEach(options) { option in
                JunoSegmentButton(
                    option: option,
                    isSelected: option.value == selection,
                    thumb: thumb,
                    size: size,
                    glass: true,
                    select: { select(option.value) }
                )
                .accessibilityIdentifier(optionAccessibilityIdentifier?(option.value) ?? "")
            }
        }
        .padding(JunoSegmentedMetrics.glassInset)
        .frame(height: size.trackHeight)
        .modifier(JunoGlassSegmentTrack())
        .fixedSize(horizontal: !fills, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAdjustableAction { direction in adjust(direction) }
    }
    #endif

    private func adjust(_ direction: AccessibilityAdjustmentDirection) {
        let enabled = options.filter { !$0.isDisabled }
        guard let index = enabled.firstIndex(where: { $0.value == selection }) else { return }
        let next: Int
        switch direction {
        case .increment: next = index + 1
        case .decrement: next = index - 1
        @unknown default: return
        }
        guard enabled.indices.contains(next) else { return }
        select(enabled[next].value)
    }

    private var drawnControl: some View {
        JunoEqualWidthRow(spacing: JunoSegmentedMetrics.inset, fills: fills).callAsFunction {
            ForEach(options) { option in
                JunoSegmentButton(
                    option: option,
                    isSelected: option.value == selection,
                    thumb: thumb,
                    size: size,
                    select: { select(option.value) }
                )
                .accessibilityIdentifier(optionAccessibilityIdentifier?(option.value) ?? "")
            }
        }
        .padding(JunoSegmentedMetrics.inset)
        .frame(height: size.trackHeight)
        .background {
            RoundedRectangle(cornerRadius: JunoSegmentedMetrics.trackRadius, style: .continuous)
                .fill(Color.junoCanvas)
                .overlay {
                    RoundedRectangle(cornerRadius: JunoSegmentedMetrics.trackRadius, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
                }
        }
        .fixedSize(horizontal: !fills, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        // What `.focusable()` would have bought, without the permanent ring.
        .accessibilityAdjustableAction { direction in
            let enabled = options.filter { !$0.isDisabled }
            guard let index = enabled.firstIndex(where: { $0.value == selection }) else { return }
            let next: Int
            switch direction {
            case .increment: next = index + 1
            case .decrement: next = index - 1
            @unknown default: return
            }
            guard enabled.indices.contains(next) else { return }
            select(enabled[next].value)
        }
    }

    private func select(_ value: Value) {
        guard value != selection else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            selection = value
        }
    }
}

/// One segment: the thumb (when selected) under the mark, the words and the
/// count, dipping together on a press.
private struct JunoSegmentButton<Value: Hashable>: View {
    let option: JunoSegmentedOption<Value>
    let isSelected: Bool
    let thumb: Namespace.ID
    var size: JunoSegmentedSize = .regular
    /// Drawn inside the Mac's glass track: a capsule lens, not the raised key.
    var glass = false
    let select: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ink: Color {
        isSelected || isHovering ? Color.junoForeground : Color.junoMutedForeground
    }

    var body: some View {
        Button(action: select) {
            HStack(spacing: JunoSpace.tight) {
                if let icon = option.icon {
                    JunoIconView(icon, size: JunoSegmentedMetrics.iconSize)
                        .accessibilityHidden(true)
                }
                Text(option.title)
                    .junoType(size == .compact ? JunoType.caption.weight(.medium) : JunoType.ui.weight(.medium))
                    // A segment never truncates: a label that cannot fit is a
                    // layout bug to fix at the call site.
                    .lineLimit(1)
                    .fixedSize()
                if let count = option.count {
                    Text(count, format: .number)
                        .junoType(.micro)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .fixedSize()
                }
                if let badge = option.badge, badge > 0, !isSelected {
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .junoType(.micro)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoOnAccent)
                        .padding(.horizontal, JunoSpace.hairline)
                        .frame(minWidth: JunoSpace.regular, minHeight: JunoSpace.regular)
                        .background(Capsule(style: .continuous).fill(Color.junoAccent))
                        .fixedSize()
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(ink)
            // The ink is the one thing that changes without moving, so it keeps
            // its curve under Reduce Motion.
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: ink)
            .padding(.horizontal, size.segmentPadding)
            .frame(maxWidth: .infinity)
            .frame(height: glass ? size.glassSegmentHeight : size.segmentHeight)
            .background {
                if glass {
                    if isSelected {
                        JunoGlassSegmentLens()
                            .matchedGeometryEffect(id: "thumb", in: thumb)
                    } else if isHovering, !option.isDisabled {
                        Capsule(style: .continuous)
                            .fill(Color.junoForeground.opacity(0.045))
                    }
                } else if isSelected {
                    JunoSegmentThumb()
                        .matchedGeometryEffect(id: "thumb", in: thumb)
                } else if isHovering, !option.isDisabled {
                    // A faint wash names the target under the pointer — far
                    // below the thumb's own contrast (`hover:bg-accent/60`).
                    RoundedRectangle(cornerRadius: JunoSegmentedMetrics.thumbRadius, style: .continuous)
                        .fill(Color.junoHover.opacity(0.6))
                }
            }
            .contentShape(glass ? AnyShape(Capsule()) : AnyShape(.rect(cornerRadius: JunoSegmentedMetrics.thumbRadius)))
        }
        .buttonStyle(JunoSegmentPressStyle())
        .contentShape(.rect(cornerRadius: JunoSegmentedMetrics.thumbRadius))
        .disabled(option.isDisabled)
        .opacity(option.isDisabled ? 0.5 : 1)
        .onHover { isHovering = $0 }
        .accessibilityLabel(accessibilityName)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }

    private var accessibilityName: String {
        var name = option.title
        if let count = option.count { name += ", \(count)" }
        if let badge = option.badge, badge > 0 { name += ", \(badge) waiting on you" }
        return name
    }
}

/// The lens that marks the selected segment in the glass track: a capsule of
/// ink at low strength, with a hairline rim — a darker lens on light glass, a
/// brighter one on dark. Never the accent: a selection is not an accent place.
private struct JunoGlassSegmentLens: View {
    var body: some View {
        Capsule(style: .continuous)
            .fill(Color.junoForeground.opacity(0.085))
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(Color.junoForeground.opacity(0.06), lineWidth: 0.5)
            }
    }
}

/// The raised key: `.surface-raised` — card fill, hairline, `--shadow-raised`.
///
/// One view, one `matchedGeometryEffect` id, present under whichever segment
/// is selected: the layout reads that as the same tile, moved.
private struct JunoSegmentThumb: View {
    var body: some View {
        RoundedRectangle(cornerRadius: JunoSegmentedMetrics.thumbRadius, style: .continuous)
            .fill(Color.junoCard)
            .junoRaisedShadow()
            .overlay {
                RoundedRectangle(cornerRadius: JunoSegmentedMetrics.thumbRadius, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
            }
    }
}

/// The press dip: `active:scale-[0.97]` on the press rung, on the whole
/// segment — the thumb is inside the label, so key and legend dip together.
private struct JunoSegmentPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PressBody(configuration: configuration)
    }

    private struct PressBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .animation(
                    JunoMotion.reduced(JunoMotion.press, when: reduceMotion),
                    value: configuration.isPressed
                )
        }
    }
}

// MARK: - Equal-width row

/// A row whose children share one width: the widest child's, or — when
/// `fills` — an equal share of the width offered. The web's
/// `grid-template-columns: repeat(n, minmax(0, 1fr))`.
struct JunoEqualWidthRow: Layout {
    var spacing: CGFloat
    var fills: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let column = columnWidth(proposal: proposal, subviews: subviews)
        let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        let width = column * CGFloat(subviews.count) + spacing * CGFloat(subviews.count - 1)
        return CGSize(width: width, height: proposal.height ?? height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let gaps = spacing * CGFloat(subviews.count - 1)
        let column = max((bounds.width - gaps) / CGFloat(subviews.count), 0)
        var x = bounds.minX
        for subview in subviews {
            subview.place(
                at: CGPoint(x: x, y: bounds.midY),
                anchor: .leading,
                proposal: ProposedViewSize(width: column, height: bounds.height)
            )
            x += column + spacing
        }
    }

    private func columnWidth(proposal: ProposedViewSize, subviews: Subviews) -> CGFloat {
        let gaps = spacing * CGFloat(subviews.count - 1)
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        guard fills, let offered = proposal.width, offered.isFinite else { return widest }
        return max((offered - gaps) / CGFloat(subviews.count), 0)
    }
}

// MARK: - Radio mark

/// The one radio mark every page draws (register #83): a 16pt ring in the
/// input ink, and, when chosen, a 1.5pt foreground ring around an 8pt
/// foreground dot. Foreground, never the accent: a selection is not one of
/// the accent's places. Hidden from VoiceOver; the row it sits in says
/// whether it is chosen.
public struct JunoRadioMark: View {
    private let isOn: Bool

    public init(isOn: Bool) {
        self.isOn = isOn
    }

    public var body: some View {
        ZStack {
            Circle()
                .strokeBorder(isOn ? Color.junoForeground : Color.junoInput, lineWidth: 1.5)
            if isOn {
                Circle()
                    .fill(Color.junoForeground)
                    .frame(width: 8, height: 8)
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }
}

