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
                        .fill(Color.junoForeground.opacity(stop <= index ? 0.28 : 0.16))
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
                Capsule().strokeBorder(Color.junoForeground.opacity(0.4), lineWidth: 1)
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
    private let fastMode: Binding<Bool>?
    private let proMode: Binding<Bool>?

    /// `fastMode` and `proMode` are optional BINDINGS rather than plain flags so
    /// that a product which does not have the concept passes nothing and gets no
    /// toggles. Juno Code shares this panel and has neither; a non-optional
    /// parameter would have put two Chat-only controls in Code's composer.
    public init(
        ladder: JunoThinkingLadder,
        stopID: Binding<String?>,
        width: CGFloat = JunoThinkingMetrics.width,
        fastMode: Binding<Bool>? = nil,
        proMode: Binding<Bool>? = nil
    ) {
        self.ladder = ladder
        _stopID = stopID
        self.width = width
        self.fastMode = fastMode
        self.proMode = proMode
    }

    private var showsFast: Bool { fastMode != nil && ladder.supportsFastMode }
    private var showsPro: Bool { proMode != nil && ladder.supportsProMode }

    /// Whether this panel draws the mode row at all — read by callers that must
    /// state their own popover height. See ``JunoThinkingMetrics``.
    public var showsModeToggles: Bool { showsFast || showsPro }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack {
                Text("THINKING")
                    .junoFont(size: 11, relativeTo: .caption, weight: .medium, design: .monospaced)
                    .junoSecondaryInk()
                    // Hidden individually rather than on the HStack. The whole
                    // row used to carry `.accessibilityHidden(true)`, which is
                    // correct for two decorative labels and silently fatal for a
                    // button: the toggles below would have been on screen and
                    // absent from the VoiceOver tree.
                    .accessibilityHidden(true)
                Spacer(minLength: JunoSpace.cozy)
                Text(ladder.label(for: stopID))
                    .junoFont(size: 11, relativeTo: .caption, weight: .semibold, design: .monospaced)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityHidden(true)
            }

            JunoThinkingTrack(ladder: ladder, stopID: $stopID)

            if showsModeToggles {
                HStack(spacing: JunoSpace.cozy) {
                    if showsFast, let fastMode {
                        JunoModeToggle(
                            isOn: fastMode,
                            symbol: "bolt.fill",
                            title: "Flash",
                            detail: ladder.fastModeRateMultiplier.map {
                                // The premium named, not gestured at. "Faster,
                                // at a premium" is a sentence a reader believes
                                // once; a number is one they can decide on.
                                "\(JunoThinkingPanel.rate($0))x rate"
                            } ?? "Premium rate",
                            accessibilityName: "Flash mode"
                        )
                    }
                    if showsPro, let proMode {
                        JunoModeToggle(
                            isOn: proMode,
                            symbol: "sparkles",
                            title: "Pro",
                            // Deliberately NOT the same shape of sentence as
                            // Flash. Pro is the same rate spent on more tokens;
                            // describing both as "premium" would make the one
                            // that multiplies the bill look like the one that
                            // does not.
                            detail: "Same rate",
                            accessibilityName: "Pro mode"
                        )
                    }
                    Spacer(minLength: 0)
                }
            }

            if let caption = ladder.caption {
                Text(caption)
                    .font(.caption2)
                    .junoMetaInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: width)
    }

    /// "2" and "2.5", never "2.0" — the multiplier is a price the reader reads,
    /// and a trailing zero on a round number looks like a rounding artefact.
    static func rate(_ value: Double) -> String {
        value == value.rounded()
            ? String(Int(value))
            : String(format: "%.1f", value)
    }
}

/// One of the composer's two mode switches.
///
/// A labelled pill rather than the web's bare icon button. The browser can lean
/// on a hover tooltip to say what its Flash bolt costs; neither Mac nor iPhone
/// can, and an unlabelled icon that silently multiplies the bill by 2.5 is the
/// wrong thing to make people guess at.
private struct JunoModeToggle: View {
    @Binding var isOn: Bool
    let symbol: String
    let title: String
    let detail: String
    let accessibilityName: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 9, weight: .semibold))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            // The web's on-state is `bg-foreground text-background` — the
            // inverted pair, deliberately not the coral accent, which already
            // means "the current tier" two rows up in this same panel.
            .foregroundStyle(isOn ? Color.junoCanvas : Color.secondary)
            .background {
                Capsule().fill(isOn ? Color.junoForeground : Color.clear)
            }
            .overlay {
                Capsule().strokeBorder(
                    isOn ? Color.clear : Color.junoHairline,
                    lineWidth: 1
                )
            }
            // Liquid Glass and plain capsules alike draw nothing the hit-tester
            // sees, so the pill states its own shape. Without this the live area
            // is the glyphs only — the bug already documented on the iOS
            // Thinking chip, where a 56pt capsule had a 13pt target.
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: isOn)
        .help("\(accessibilityName) — \(detail)")
        // `[.isButton, .isSelected]` and not `.isToggle`: every other two-state
        // control in this tree uses the former, and one control announcing
        // itself differently is a worse inconsistency than a better trait.
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
        .accessibilityLabel(accessibilityName)
        .accessibilityValue(isOn ? "On, \(detail)" : "Off, \(detail)")
        .accessibilityIdentifier("juno.thinking.\(title.lowercased())-toggle")
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
                .junoSecondaryInk()
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
                .junoSecondaryInk()
                .contentShape(.rect)
            }
            .buttonStyle(.junoPress)
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
    /// What the Flash/Pro row adds: a 27pt pill plus the stack's spacing.
    ///
    /// A constant every caller adds for itself, because the panel cannot be
    /// allowed to measure itself and tell them — a self-sizing AppKit popover
    /// containing this file's `GeometryReader` recurses until the app dies, and
    /// that shipped once as the 3.0.5 thinking-slider crash. Growing the panel
    /// without growing the frame around it clips the toggles instead, silently
    /// and only on macOS, which is the failure this constant exists to prevent.
    public static let modeRowHeight: CGFloat = 39

    /// The panel's height for a given shape. Callers state a fixed frame; this
    /// is the one place that decides what the number is.
    public static func height(caption: Bool, modeToggles: Bool) -> CGFloat {
        (caption ? captionedHeight : height) + (modeToggles ? modeRowHeight : 0)
    }
}
