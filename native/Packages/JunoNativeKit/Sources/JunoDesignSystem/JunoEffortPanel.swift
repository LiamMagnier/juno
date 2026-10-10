import SwiftUI

// MARK: - The effort panel (the model chip's first stage)
//
// The web's `EffortPanel` (src/components/chat/reasoning-slider.tsx,
// `variant="panel"`): the chip of a model with thinking levels opens on this
// first, because effort is what most turns change; the model's name inside it
// opens the full catalogue. Every other model (one effort, Auto, image, video,
// audio) skips it and opens the catalogue straight away — see
// ``JunoModelPickerStage/first(for:)``.
//
// Layout, as the web draws it: a three-column row (Flash on the left, the rung
// named large in the middle with the model under it, reset on the right), then
// a thick pill track with one stop per rung and a 28pt knob.
//
// No coral anywhere. The web spends no accent on this panel: the fill is ink,
// the knob is white, the Flash "on" state is the inverted pair. The panel
// sits inside a system popover, which is the Liquid Glass; nothing here draws
// glass of its own (glass on glass, §0.1).

/// The effort panel's fixed geometry. AppKit cannot negotiate a popover whose
/// content measures itself (crash rule 2), so the caller states this frame.
public enum JunoEffortPanelMetrics {
    /// `w-[18.5rem]`.
    public static let width: CGFloat = 296
    /// The panel's inset: the web's `p-3`.
    public static let inset: CGFloat = JunoSpace.cozy
    /// The header row: the rung's name over the model's, whose button keeps
    /// the Mac's 28pt pointer target.
    public static let headerHeight: CGFloat = 48
    /// The gap between the header and the track: `mt-3`.
    public static let trackGap: CGFloat = JunoSpace.cozy
    /// The track: `h-9`.
    public static let trackHeight: CGFloat = 36
    /// The knob: `size-7`.
    public static let knob: CGFloat = 28
    /// The track's own inset around the knob, on every side.
    public static let knobInset: CGFloat = (trackHeight - knob) / 2
    /// The panel's height: inset, header, gap, track, inset.
    public static let height: CGFloat = inset + headerHeight + trackGap + trackHeight + inset
    /// The Pro row's content: the name over its two-line explanation, beside
    /// a switch.
    public static let proRowContentHeight: CGFloat = 50
    /// The Pro row under the track: the gap, a hairline, the gap, then the
    /// content (the web's `mt-3 border-t pt-3`).
    public static let proRowHeight: CGFloat = trackGap + 1 + trackGap + proRowContentHeight
    /// The panel's height with or without the Pro row, for callers that
    /// state the popover's frame.
    public static func height(showsPro: Bool) -> CGFloat {
        height
    }

    /// The panel's height with any of the switch rows under the track (Ultra
    /// fast and Pro are the same row shape, stacked).
    /// Speed and Pro now sit on the header line, so neither adds height; kept
    /// so callers that state the popover's frame need not change.
    public static func height(showsPro: Bool, showsUltraFast: Bool) -> CGFloat {
        height
    }

    /// The header's side columns: the speed control and the Pro capsule on
    /// the left, reset on the right, one width so the rung stays centred.
    public static let sideColumn: CGFloat = 76

    /// Where stop `index` of `count` sits along a track `width` wide: the
    /// knob's centre, 18pt in from either end (the web's `panelStop`).
    public static func stopCentre(_ index: Int, of count: Int, width: CGFloat) -> CGFloat {
        let edge = knob / 2 + knobInset
        guard count > 1 else { return edge }
        let t = CGFloat(index) / CGFloat(count - 1)
        return edge + t * max(0, width - edge * 2)
    }

    /// The stop nearest to `x` on a track `width` wide.
    public static func nearestStop(to x: CGFloat, count: Int, width: CGFloat) -> Int {
        guard count > 1 else { return 0 }
        let edge = knob / 2 + knobInset
        let travel = max(1, width - edge * 2)
        let t = min(max((x - edge) / travel, 0), 1)
        return Int((t * CGFloat(count - 1)).rounded())
    }
}

/// The ordered effort slider: Instant to Max, one stop per rung the model has.
///
/// A drawn track driven by a stock `DragGesture`, rather than an invisible
/// `Slider` laid over the artwork: the overlaid control keeps its own thumb and
/// hit geometry, and the two drift apart. Here the hit area IS the artwork, so
/// a click on any stop jumps to it.
///
/// Everything a native slider gives for free is stated explicitly: arrow keys
/// (all four), Home and End, VoiceOver's adjustable action with the rung's
/// word as its value ("High", never "3"), and Reduce Motion, under which the
/// knob no longer travels.
public struct JunoEffortSlider: View {
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?
    private let focusOnAppear: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool
    /// Whether the keyboard has driven the slider since it took focus: the
    /// focus edge is the web's `focus-visible`, drawn for the keyboard only,
    /// so a panel that opens with the slider focused does not open ringed.
    @State private var keyboardEngaged = false

    public init(ladder: JunoThinkingLadder, stopID: Binding<String?>, focusOnAppear: Bool = false) {
        self.ladder = ladder
        _stopID = stopID
        self.focusOnAppear = focusOnAppear
    }

    private var count: Int { ladder.stops.count }
    private var index: Int { ladder.index(of: stopID) ?? 0 }
    private var dark: Bool { colorScheme == .dark }

    public var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let head = JunoEffortPanelMetrics.stopCentre(index, of: count, width: width)
            track(width: width, head: head)
                .contentShape(Capsule())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged {
                            keyboardEngaged = false
                            commit(JunoEffortPanelMetrics.nearestStop(to: $0.location.x, count: count, width: width))
                        }
                        .onEnded { commit(JunoEffortPanelMetrics.nearestStop(to: $0.location.x, count: count, width: width)) }
                )
        }
        .frame(height: JunoEffortPanelMetrics.trackHeight)
        .opacity(isEnabled ? 1 : 0.55)
        // The web's focus edge: a quiet ring 3pt outside the track, only while
        // the keyboard is on it. AppKit's blue halo is turned off in its favour.
        .overlay {
            Capsule()
                .strokeBorder(Color.junoForeground.opacity(0.2), lineWidth: 2)
                .padding(-3)
                .opacity(focused && keyboardEngaged ? 1 : 0)
                .allowsHitTesting(false)
        }
        .sensoryFeedback(.selection, trigger: index)
        .focusable(ladder.isAdjustable && isEnabled)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { step(-1) }
        .onKeyPress(.downArrow) { step(-1) }
        .onKeyPress(.rightArrow) { step(1) }
        .onKeyPress(.upArrow) { step(1) }
        .onKeyPress(.home) { jump(to: 0) }
        .onKeyPress(.end) { jump(to: count - 1) }
        .onAppear { if focusOnAppear { focused = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking effort")
        .accessibilityValue(ladder.stop(at: index)?.label ?? "")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: _ = step(1)
            case .decrement: _ = step(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("juno.effort-slider")
    }

    // MARK: Artwork

    private func track(width: CGFloat, head: CGFloat) -> some View {
        let edge = JunoEffortPanelMetrics.knob / 2 + JunoEffortPanelMetrics.knobInset
        let travel = JunoMotion.reduced(JunoMotion.base, when: reduceMotion)
        return ZStack(alignment: .leading) {
            Capsule()
                .fill(dark ? Color.white.opacity(0.08) : Color.junoForeground.opacity(0.07))

            // The fill is a pill that holds the knob with the track's own 4pt
            // inset on every side, so at the last rung it meets the track's
            // end with no sliver of empty track, and the radii stay concentric.
            // Hidden at the first rung, where there is nothing behind the knob.
            Capsule()
                .fill(dark ? Color.white.opacity(0.25) : Color.junoForeground.opacity(0.85))
                .frame(width: min(width, head + edge))
                .opacity(index == 0 ? 0 : 1)
                .animation(travel, value: index)

            ForEach(0..<count, id: \.self) { stop in
                Circle()
                    .fill(stopColor(stop))
                    .frame(width: 6, height: 6)
                    .position(
                        x: JunoEffortPanelMetrics.stopCentre(stop, of: count, width: width),
                        y: JunoEffortPanelMetrics.trackHeight / 2
                    )
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: index)
            }

            Circle()
                .fill(Color.white)
                .overlay {
                    Circle().strokeBorder(Color.black.opacity(contrast == .increased ? 0.4 : 0.06), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
                .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
                .frame(width: JunoEffortPanelMetrics.knob, height: JunoEffortPanelMetrics.knob)
                .position(x: head, y: JunoEffortPanelMetrics.trackHeight / 2)
                .animation(travel, value: index)
        }
        .frame(width: width, height: JunoEffortPanelMetrics.trackHeight)
        .clipShape(Capsule())
    }

    /// Behind the knob: the canvas showing through the fill; under it:
    /// nothing; ahead of it: a quiet ink dot.
    private func stopColor(_ stop: Int) -> Color {
        if stop < index { return dark ? Color.white.opacity(0.4) : Color.junoCanvas.opacity(0.55) }
        if stop == index { return .clear }
        return Color.junoForeground.opacity(0.25)
    }

    // MARK: Input

    private func step(_ delta: Int) -> KeyPress.Result {
        guard ladder.isAdjustable, isEnabled else { return .ignored }
        keyboardEngaged = true
        commit(min(max(index + delta, 0), count - 1))
        return .handled
    }

    private func jump(to target: Int) -> KeyPress.Result {
        guard ladder.isAdjustable, isEnabled else { return .ignored }
        keyboardEngaged = true
        commit(target)
        return .handled
    }

    private func commit(_ target: Int) {
        guard ladder.isAdjustable, isEnabled, target != index, let stop = ladder.stop(at: target) else { return }
        stopID = stop.id
    }
}

/// Pro, in the web's words (reasoning-slider.tsx `PRO_MODE_HELP`): said once,
/// under the switch, wherever the switch is drawn.
public enum JunoProMode {
    public static let title = "Pro"
    public static let help = "The model's deeper reasoning mode. Slower and costs more."
}

/// Ultra fast, in the web's words (reasoning-slider.tsx `ultraFastHelp`):
/// OpenAI's Ultrafast service tier, captioned with the premium it costs.
public enum JunoUltraFastMode {
    public static let title = "Ultra fast"
    public static func help(multiplier: Double?) -> String {
        guard let multiplier else { return "OpenAI's fastest tier, at a premium." }
        return "OpenAI's fastest tier, at \(rate(multiplier))x the standard price."
    }

    static func rate(_ multiplier: Double) -> String {
        multiplier.rounded() == multiplier ? String(Int(multiplier)) : String(format: "%.2g", multiplier)
    }
}

/// The effort panel's speed control: Off, the lab's fast tier, or OpenAI's
/// Ultrafast, one press at a time (the web's `SpeedTier`).
public enum JunoSpeedTier: Equatable, Sendable {
    case off, fast, ultra

    /// Off → Fast → Ultra fast → Off, skipping a tier the model lacks.
    public func next(hasFast: Bool, hasUltra: Bool) -> JunoSpeedTier {
        var order: [JunoSpeedTier] = [.off]
        if hasFast { order.append(.fast) }
        if hasUltra { order.append(.ultra) }
        let at = order.firstIndex(of: self) ?? 0
        return order[(at + 1) % order.count]
    }

    /// The tooltip and accessible label: "Ultra fast · 6× standard price".
    public func label(multiplier: Double?) -> String {
        let price = multiplier.map { " · \(JunoUltraFastMode.rate($0))× standard price" } ?? ""
        switch self {
        case .off: return "Standard speed"
        case .fast: return "Fast\(price)"
        case .ultra: return "Ultra fast\(price)"
        }
    }
}

/// The chip's first stage: the rung named large with the model under it (press
/// it to change model), Flash on the left, reset on the right, and the slider.
///
/// `openModels` is the door to the catalogue; `fastMode` and `proMode` are
/// optional so a product without the concept passes nothing and gets no
/// control. Pro is drawn only where the ladder says the model has it.
public struct JunoEffortPanel: View {
    private let ladder: JunoThinkingLadder
    @Binding private var stopID: String?
    private let modelName: String
    private let fastMode: Binding<Bool>?
    private let ultraFast: Binding<Bool>?
    private let proMode: Binding<Bool>?
    private let openModels: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    public init(
        ladder: JunoThinkingLadder,
        stopID: Binding<String?>,
        modelName: String,
        fastMode: Binding<Bool>? = nil,
        ultraFast: Binding<Bool>? = nil,
        proMode: Binding<Bool>? = nil,
        openModels: (() -> Void)? = nil
    ) {
        self.ladder = ladder
        _stopID = stopID
        self.modelName = modelName
        self.fastMode = fastMode
        self.ultraFast = ultraFast
        self.proMode = proMode
        self.openModels = openModels
    }

    /// Whether the panel draws the Ultra fast row: a binding was passed and
    /// the model is on OpenAI's Ultrafast tier.
    public static func showsUltraFast(ladder: JunoThinkingLadder, ultraFast: Binding<Bool>?) -> Bool {
        ultraFast != nil && ladder.supportsUltraFastMode
    }

    /// Whether the panel draws the Pro row: a binding was passed and the model
    /// has the mode. Callers size the popover with
    /// ``JunoEffortPanelMetrics/height(showsPro:)``.
    public static func showsPro(ladder: JunoThinkingLadder, proMode: Binding<Bool>?) -> Bool {
        proMode != nil && ladder.supportsProMode
    }

    private var current: JunoThinkingStop? { ladder.stop(id: stopID) ?? ladder.stops.first }
    private var showsFlash: Bool { fastMode != nil && ladder.supportsFastMode }
    private var showsUltra: Bool { Self.showsUltraFast(ladder: ladder, ultraFast: ultraFast) }

    private var speedTier: JunoSpeedTier {
        if showsUltra, ultraFast?.wrappedValue == true { return .ultra }
        if showsFlash, fastMode?.wrappedValue == true { return .fast }
        return .off
    }

    private func cycleSpeed() {
        let current = speedTier
        switch current.next(hasFast: showsFlash, hasUltra: showsUltra) {
        case .fast:
            fastMode?.wrappedValue = true
            ultraFast?.wrappedValue = false
        case .ultra:
            ultraFast?.wrappedValue = true
            fastMode?.wrappedValue = false
        case .off:
            fastMode?.wrappedValue = false
            ultraFast?.wrappedValue = false
        }
    }
    private var canReset: Bool {
        guard let defaultStopID = ladder.defaultStopID else { return false }
        return current?.id != defaultStopID
    }

    public var body: some View {
        VStack(spacing: JunoEffortPanelMetrics.trackGap) {
            header
                .frame(height: JunoEffortPanelMetrics.headerHeight)
            JunoEffortSlider(ladder: ladder, stopID: $stopID, focusOnAppear: true)
        }
        .padding(JunoEffortPanelMetrics.inset)
        .frame(width: JunoEffortPanelMetrics.width, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Thinking")
        .accessibilityIdentifier("juno.effort-panel")
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.micro) {
                if showsFlash || showsUltra {
                    JunoEffortSpeedButton(
                        tier: speedTier,
                        multiplier: speedTier == .ultra ? ladder.ultraFastRateMultiplier : ladder.fastModeRateMultiplier,
                        action: cycleSpeed
                    )
                }
                if Self.showsPro(ladder: ladder, proMode: proMode), let proMode {
                    JunoEffortProCapsule(isOn: proMode)
                }
            }
            .frame(width: JunoEffortPanelMetrics.sideColumn, alignment: .leading)

            VStack(spacing: 0) {
                Text(current?.label ?? "")
                    .junoType(JunoType.body.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: current?.id)
                    .accessibilityHidden(true)
                if let openModels {
                    JunoEffortModelButton(name: modelName, action: openModels)
                }
            }
            .frame(maxWidth: .infinity)

            Button {
                if let defaultStopID = ladder.defaultStopID { stopID = defaultStopID }
            } label: {
                JunoIconView(.rotateCcw, size: 16)
            }
            .buttonStyle(JunoEffortIconButton(isOn: false))
            .contentShape(Circle())
            .frame(width: JunoEffortPanelMetrics.sideColumn, alignment: .trailing)
            .disabled(!canReset || !isEnabled)
            .help("Reset to the model's default")
            .accessibilityLabel("Reset to the model's default")
            .accessibilityIdentifier("juno.effort-panel.reset")
        }
    }
}

/// Pro beside the speed control: a compact capsule, a hairline when off and
/// the filled ink pair when on (the iOS Calendar segment). A separate axis
/// from the rung, so a toggle rather than another stop.
public struct JunoEffortProCapsule: View {
    @Binding var isOn: Bool
    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(isOn: Binding<Bool>) { _isOn = isOn }

    public var body: some View {
        Button {
            isOn.toggle()
        } label: {
            Text(JunoProMode.title)
                .junoType(.caption.weight(.medium))
                .foregroundStyle(isOn ? Color.junoCanvas : (hovered ? Color.junoForeground : Color.junoSecondaryInk))
                .padding(.horizontal, JunoSpace.snug)
                .frame(height: 24)
                .background {
                    Capsule(style: .continuous).fill(isOn ? Color.junoForeground : Color.junoGlassHover.opacity(hovered ? 1 : 0))
                }
                .overlay {
                    Capsule(style: .continuous).strokeBorder(isOn ? Color.clear : Color.junoHairline, lineWidth: 1)
                }
                .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.35)
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isOn)
        .help(JunoProMode.help)
        .accessibilityLabel(isOn ? "Pro on: deeper reasoning" : "Pro: deeper reasoning")
        .accessibilityHint(JunoProMode.help)
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("juno.effort-panel.pro")
    }
}

/// The model's name under the rung: the door to the catalogue. Muted, with a
/// caret that nudges right under the pointer.
private struct JunoEffortModelButton: View {
    let name: String
    let action: () -> Void

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.micro) {
                Text(name)
                    .junoType(.ui)
                    .lineLimit(1)
                    .truncationMode(.tail)
                JunoIconView(.chevronRight, size: 14)
                    .offset(x: hovered && !reduceMotion ? 2 : 0)
            }
            .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.tight)
            .frame(minHeight: JunoLayout.pointerTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .help("Change model")
        .accessibilityLabel("Change model")
        .accessibilityValue(name)
        .accessibilityIdentifier("juno.effort-panel.models")
    }
}

/// The speed control: the web's bolt, muted when off and ink when on; for
/// Ultra fast the same bolt twice, overlapped 3pt, the second springing in
/// (held still under Reduce Motion). Each press moves one tier.
public struct JunoEffortSpeedButton: View {
    let tier: JunoSpeedTier
    let multiplier: Double?
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(tier: JunoSpeedTier, multiplier: Double?, action: @escaping () -> Void) {
        self.tier = tier
        self.multiplier = multiplier
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            ZStack {
                JunoIconView(.zap, size: 16)
                    .offset(x: tier == .ultra ? -2 : 0)
                JunoIconView(.zap, size: 16)
                    .offset(x: tier == .ultra ? 3 : 0)
                    .opacity(tier == .ultra ? 1 : 0)
            }
            .animation(
                JunoMotion.reduced(JunoMotion.spring, when: reduceMotion),
                value: tier
            )
        }
        .buttonStyle(JunoEffortIconButton(isOn: false, tinted: tier != .off))
        .contentShape(Circle())
        .help(tier.label(multiplier: multiplier))
        .accessibilityLabel(tier.label(multiplier: multiplier))
        .accessibilityHint("Changes the serving speed")
        .accessibilityAddTraits(tier != .off ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("juno.effort-panel.flash")
    }
}

/// The panel's two round buttons: muted at rest, the hover tone under the
/// pointer, the inverted pair when on, faded when there is nothing to do.
struct JunoEffortIconButton: ButtonStyle {
    static let side: CGFloat = 32
    let isOn: Bool
    /// On through tint alone: full ink, no fill (the speed control).
    var tinted: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, isOn: isOn, tinted: tinted)
    }

    private struct Face: View {
        let configuration: Configuration
        let isOn: Bool
        let tinted: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .foregroundStyle(isOn ? Color.junoCanvas : (hovered || tinted ? Color.junoForeground : Color.junoSecondaryInk))
                .frame(width: JunoEffortIconButton.side, height: JunoEffortIconButton.side)
                .background {
                    Circle().fill(
                        isOn
                            ? Color.junoForeground.opacity(configuration.isPressed ? 0.85 : 1)
                            : Color.junoGlassHover.opacity(hovered || configuration.isPressed ? 1 : 0)
                    )
                }
                .opacity(isEnabled ? 1 : 0.35)
                .contentShape(Circle())
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isOn)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: tinted)
        }
    }
}
