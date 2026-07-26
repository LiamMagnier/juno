import SwiftUI

/// The Thinking control, shared by Chat and Code.
///
/// Driven by a ``JunoThinkingLadder`` and a stop id rather than by either
/// product's effort enum, so the same slider serves `NativeReasoningEffort`
/// (Chat, where "off" is a real state) and `ReasoningEffort` (Code, where it is
/// not) without knowing about either.

/// A discrete slider over exactly the stops the selected model supports.
///
/// Driven by an explicit drag/tap gesture rather than an invisible native
/// `Slider` laid over the artwork. That trick — the one the website plays with a
/// transparent `<input type="range">` — does not survive the translation: the
/// overlaid control kept its own hit-testing geometry and its own thumb, so the
/// visible thumb and the touchable one drifted apart and the track could not be
/// tapped at all. A gesture on the track we actually draw means the hit area IS
/// the artwork, and clicking a detent jumps to it, which a native slider on
/// neither platform does.
///
/// Accessibility is therefore explicit rather than inherited: an adjustable
/// element for VoiceOver, arrow-key commands for keyboard control, and a value
/// that always names the tier. Everything that communicates the value — label,
/// ticks, thumb position, accessibility value — is duplicated outside the
/// gradient, so the reading never depends on colour.
public struct JunoThinkingTrack: View {
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?

    public init(ladder: JunoThinkingLadder, stopID: Binding<String?>) {
        self.ladder = ladder
        _stopID = stopID
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var focused: Bool

    private let trackHeight: CGFloat = 34
    private let thumb: CGFloat = 26
    private let pad: CGFloat = 4

    private var count: Int { max(ladder.stops.count, 1) }
    private var lastIndex: Int { count - 1 }
    private var index: Int { ladder.index(of: stopID) ?? 0 }

    public var body: some View {
        GeometryReader { geometry in
            let travel = max(geometry.size.width - pad * 2 - thumb, 0)
            let fraction = count > 1 ? Double(index) / Double(max(lastIndex, 1)) : 0

            ZStack(alignment: .leading) {
                Capsule().fill(Color.junoRowSelected)

                // Coral → warm rose → restrained violet, clipped to the filled
                // portion. Purely decorative: it never carries the value alone.
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: Self.gradientColours,
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: thumb + travel * fraction)
                    .padding(pad)
                    .opacity(reduceTransparency ? 1 : 0.92)

                // Detents, so the stop count is visible even at rest.
                ForEach(0..<count, id: \.self) { stop in
                    let stopFraction = count > 1 ? Double(stop) / Double(max(lastIndex, 1)) : 0
                    Circle()
                        .fill(Color.primary.opacity(stop <= index ? 0.28 : 0.16))
                        .frame(width: 3, height: 3)
                        .offset(x: pad + thumb / 2 - 1.5 + travel * stopFraction)
                }

                Circle()
                    .fill(.white)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                    .frame(width: thumb, height: thumb)
                    .offset(x: pad + travel * fraction)
                    .animation(
                        JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
                        value: index
                    )
            }
            .frame(height: trackHeight)
            // The whole capsule is the control, so a click anywhere on the track
            // selects the nearest detent instead of requiring the thumb.
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in select(at: value.location.x, travel: travel) }
                    .onEnded { value in select(at: value.location.x, travel: travel) }
            )
        }
        .frame(height: trackHeight)
        .overlay {
            if contrast == .increased {
                Capsule().strokeBorder(Color.primary.opacity(0.4), lineWidth: 1)
            }
        }
        // Native selection feedback at each detent, which respects the system
        // haptics setting rather than firing a generator unconditionally.
        .sensoryFeedback(.selection, trigger: index)
        .focusable(ladder.isAdjustable)
        .focused($focused)
        // Full Keyboard Access and hardware keyboards. `onMoveCommand` is
        // macOS/tvOS only, so the arrow keys are read directly on both.
        .onKeyPress(.leftArrow) {
            step(-1)
            return .handled
        }
        .onKeyPress(.rightArrow) {
            step(1)
            return .handled
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking level")
        .accessibilityValue(ladder.stop(at: index)?.accessibilityLabel ?? "Off")
        .accessibilityHint("Adjustable. Swipe up or down to change the thinking level.")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("juno.thinking-slider")
        .disabled(!ladder.isAdjustable)
    }

    /// Maps a touch to the nearest detent. `x` is measured from the track's
    /// leading edge; the thumb's own centre offset is removed first so the
    /// detent under the finger is the one that gets picked.
    private func select(at x: CGFloat, travel: CGFloat) {
        guard ladder.isAdjustable, travel > 0 else { return }
        let position = (x - pad - thumb / 2) / travel
        let target = Int((position * Double(lastIndex)).rounded())
        commit(min(max(target, 0), lastIndex))
    }

    private func step(_ delta: Int) {
        guard ladder.isAdjustable else { return }
        commit(min(max(index + delta, 0), lastIndex))
    }

    private func commit(_ target: Int) {
        guard target != index, let stop = ladder.stop(at: target) else { return }
        stopID = stop.id
    }

    public static let gradientColours: [Color] = [
        Color.junoAccent,
        Color(red: 0.90, green: 0.42, blue: 0.52),
        Color(red: 0.53, green: 0.42, blue: 0.86),
    ]
}

/// The Thinking popover's content: section label, current value, the discrete
/// slider, and the ladder's caption when it has one.
///
/// `width` is required rather than optional. On macOS a self-sizing popover
/// whose content measures itself (this one contains a `GeometryReader`) drives
/// AppKit into a layout feedback loop and crashes the app — that shipped once,
/// as the 3.0.5 thinking-slider crash. Callers give it a fixed width, and on
/// macOS a fixed height as well.
public struct JunoThinkingPanel: View {
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?
    private let width: CGFloat

    public init(
        ladder: JunoThinkingLadder,
        stopID: Binding<String?>,
        width: CGFloat = JunoThinkingMetrics.width
    ) {
        self.ladder = ladder
        _stopID = stopID
        self.width = width
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpacing.control) {
            HStack {
                Text("THINKING")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer(minLength: JunoSpace.cozy)
                Text(ladder.label(for: stopID))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.junoAccent)
            }
            .accessibilityHidden(true)

            JunoThinkingTrack(ladder: ladder, stopID: $stopID)

            if let caption = ladder.caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: width)
    }
}

/// The composer control that opens the Thinking panel.
///
/// A router that picks its own depth gets a static "Auto" label instead of a
/// button, because there is nothing to set — offering a disabled slider would
/// imply the depth is a choice the reader declined to make.
public struct JunoThinkingButton: View {
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?
    private let accessibilityID: String

    @State private var presented = false

    public init(
        ladder: JunoThinkingLadder,
        stopID: Binding<String?>,
        accessibilityID: String = "juno.thinking-button"
    ) {
        self.ladder = ladder
        _stopID = stopID
        self.accessibilityID = accessibilityID
    }

    public var body: some View {
        if ladder.isAutomatic {
            Text("Auto")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Thinking")
                .accessibilityValue("Automatic")
                .accessibilityIdentifier(accessibilityID)
        } else if !ladder.stops.isEmpty {
            Button {
                presented = true
            } label: {
                HStack(spacing: JunoSpace.hairline) {
                    Image(systemName: "gauge.with.dots.needle.33percent")
                        .imageScale(.small)
                    Text(ladder.label(for: stopID)).lineLimit(1)
                    Image(systemName: "chevron.up")
                        .font(.caption2.weight(.semibold))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(!ladder.isAdjustable)
            .help("How much thinking the model does before answering")
            .accessibilityLabel("Thinking")
            .accessibilityValue(ladder.label(for: stopID))
            .accessibilityIdentifier(accessibilityID)
            // Dismissed with its anchor, always.
                //
                // A `.popover` whose anchor leaves the view hierarchy while it is still
                // presented makes SwiftUI's `PopoverBridge` re-run `updatePresentations`
                // and call `showRelativeToRect:` against a window that is already being
                // ordered — `addChildWindow:` → `_doOrderWindow:` → an uncaught
                // `NSRemoteView` exception, and the process takes SIGTRAP. It is easy to
                // hit: open this popover, then click a different sidebar row, which tears
                // down the composer that owns the anchor.
                //
                // Resetting on disappear guarantees the presentation is torn down with
                // the anchor rather than after it.
                .onDisappear { presented = false }
            .popover(
                isPresented: $presented,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .bottom
            ) {
                JunoThinkingPanel(ladder: ladder, stopID: $stopID)
                    .frame(
                        width: JunoThinkingMetrics.width,
                        height: ladder.caption == nil
                            ? JunoThinkingMetrics.height
                            : JunoThinkingMetrics.captionedHeight
                    )
            }
        }
    }
}

/// The Thinking popover's fixed geometry. See ``JunoThinkingPanel`` for why it
/// cannot be allowed to size itself.
public enum JunoThinkingMetrics {
    public static let width: CGFloat = 268
    /// Label row + track + padding.
    public static let height: CGFloat = 88
    /// The same, plus two lines of caption.
    public static let captionedHeight: CGFloat = 118
}
