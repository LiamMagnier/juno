import JunoDesignSystem
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The parts of the model picker and the Thinking control that are identical on
/// every platform: the provider mark, capability chips, grade bars, the detail
/// panel, and the discrete thinking slider.
///
/// Presentation stays per-platform — a phone gets a detent sheet, a Mac gets an
/// anchored popover — but these leaves do not, and duplicating them is how the
/// two apps drift apart.

// MARK: - Provider mark

/// A model provider's real logo, from the same artwork the website serves.
///
/// Each provider ships light and dark variants in the app's asset catalog under
/// `Providers/`, so the mark stays legible in both appearances without tinting.
/// Auto uses the Juno mark, a template image that takes the label colour.
///
/// The monogram fallback exists for one case only: the server added a provider
/// after this build shipped. An SF Symbol is never substituted for a brand that
/// has a real logo.
public struct JunoProviderMark: View {
    private let providerID: String
    private let providerName: String
    private let size: CGFloat

    public init(providerID: String, providerName: String, size: CGFloat = 20) {
        self.providerID = providerID
        self.providerName = providerName
        self.size = size
    }

    private var assetName: String { "provider-\(providerID.lowercased())" }

    private var assetExists: Bool {
        #if canImport(UIKit)
        UIImage(named: assetName) != nil
        #elseif canImport(AppKit)
        NSImage(named: assetName) != nil
        #else
        false
        #endif
    }

    public var body: some View {
        Group {
            if assetExists {
                Image(assetName)
                    .resizable()
                    .scaledToFit()
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var monogram: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(.quaternary)
            .overlay {
                Text(String(providerName.prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
    }
}

// MARK: - Capability chips

public struct JunoCapabilityChips: View {
    private let model: NativeChatModelOption
    /// List rows use glyph-only chips. Four labelled capsules do not fit a
    /// phone-width row, and a chip that wraps mid-word is worse than a glyph
    /// with an accessibility label — the detail panel spells them out.
    private let compact: Bool

    public init(model: NativeChatModelOption, compact: Bool = false) {
        self.model = model
        self.compact = compact
    }

    public var body: some View {
        let chips = NativeModelPresentation.capabilityChips(model)
        if !chips.isEmpty {
            // Labelled chips wrap: four do not fit a 268pt detail panel on one
            // line, and they grow further with Dynamic Type.
            JunoChipFlow(spacing: compact ? 4 : 5) {
                ForEach(chips) { chip in
                    Group {
                        if compact {
                            Image(systemName: chip.systemImage)
                                .font(.system(size: 10, weight: .medium))
                                .frame(width: 15, height: 15)
                        } else {
                            Label(chip.label, systemImage: chip.systemImage)
                                .font(.system(size: 10, weight: .medium))
                                .labelStyle(.titleAndIcon)
                                // A chip is one line by definition; without this
                                // the label wraps mid-word inside its capsule.
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .background {
                        Capsule().strokeBorder(Color.junoHairline, lineWidth: 1)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// A one-axis flow: lay chips left to right, wrap when the row is full.
///
/// `HStack` cannot do this — it either overflows its container or squeezes its
/// children — and the chips have to survive both a 268pt detail panel and
/// accessibility text sizes.
public struct JunoChipFlow: Layout {
    private let spacing: CGFloat
    private let lineSpacing: CGFloat

    public init(spacing: CGFloat = 5, lineSpacing: CGFloat = 5) {
        self.spacing = spacing
        self.lineSpacing = lineSpacing
    }

    public func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var total = CGSize(width: 0, height: 0)
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + spacing + size.width > maxWidth {
                total.width = max(total.width, rowWidth)
                total.height += rowHeight + lineSpacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth > 0 ? spacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        total.width = max(total.width, rowWidth)
        total.height += rowHeight
        return total
    }

    public func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            subview.place(
                at: CGPoint(x: x, y: y),
                anchor: .topLeading,
                proposal: ProposedViewSize(size)
            )
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// The website's ten-segment meter. The numeric value is in the accessibility
/// label as well as the bars, so the reading never depends on colour alone.
public struct JunoGradeBars: View {
    private let label: String
    private let value: Int

    public init(label: String, value: Int) {
        self.label = label
        self.value = value
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(value)/10")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 3) {
                ForEach(0..<10, id: \.self) { index in
                    Capsule()
                        .fill(index < value ? Color.junoAccent : Color.junoRowSelected)
                        .frame(height: 12)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value) out of 10")
    }
}

// MARK: - Detail

/// Everything the manifest actually knows about one model. Every value here is
/// server-published; nothing is derived or estimated, so a field the server did
/// not send simply does not appear.
public struct JunoModelDetailView: View {
    private let model: NativeChatModelOption
    /// Expanded under its own row, where the name, provider and summary are
    /// already on screen — repeating them there would just be noise.
    private let showsHeader: Bool

    public init(model: NativeChatModelOption, showsHeader: Bool = true) {
        self.model = model
        self.showsHeader = showsHeader
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if showsHeader {
                HStack(spacing: 10) {
                    JunoProviderMark(
                        providerID: model.providerID,
                        providerName: model.providerName,
                        size: 26
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.displayName).font(.headline)
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let summary = model.summary {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !model.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(model.highlights.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(index + 1)")
                                .font(.caption.monospaced())
                                .foregroundStyle(Color.junoAccent)
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            let chips = NativeModelPresentation.capabilityChips(model)
            if showsHeader, !chips.isEmpty {
                JunoCapabilityChips(model: model)
                    .accessibilityHidden(false)
                    .accessibilityLabel(
                        "Capabilities: " + chips.map(\.label).joined(separator: ", ")
                    )
            }

            // Bars only when the server published real grades — Auto has none,
            // and a router's speed or intelligence is not something to invent.
            if let grades = model.grades {
                JunoGradeBars(label: "Intelligence", value: grades.intelligence)
                JunoGradeBars(label: "Speed", value: grades.speed)
            }

            VStack(alignment: .leading, spacing: 5) {
                if let context = model.contextWindowTokens {
                    detailLine(
                        "Context",
                        NativeModelPresentation.contextWindow(context) + " tokens"
                    )
                }
                if let price = NativeModelPresentation.priceDetail(model.pricing) {
                    detailLine("Pricing", price)
                }
                if let released = model.released {
                    detailLine("Released", released)
                }
                detailLine("Thinking", thinkingSummary)
                if let reason = NativeModelPresentation.unavailabilityReason(model) {
                    detailLine("Availability", reason)
                }
                if let note = model.deprecationNote {
                    detailLine("Note", note)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var subtitle: String {
        var parts = [model.providerName]
        if let context = model.contextWindowTokens {
            parts.append(NativeModelPresentation.contextWindow(context) + " context")
        }
        return parts.joined(separator: " · ")
    }

    private var thinkingSummary: String {
        let scale = NativeThinkingScale(model: model)
        if scale.isAutomatic { return "Chosen automatically for each message" }
        guard !scale.stops.isEmpty else { return "Not adjustable" }
        return scale.stops.map(\.label).joined(separator: " · ")
    }

    private func detailLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(width: 76, alignment: .leading)
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Thinking

/// The Thinking popover's content: section label, current value, the discrete
/// slider, and a caption when the model's ladder needs explaining.
///
/// `width` is required rather than optional. On macOS a self-sizing popover
/// whose content measures itself (this one contains a `GeometryReader`) drives
/// AppKit into a layout feedback loop and crashes the app — that shipped once,
/// as the 3.0.5 thinking-slider crash. Callers give it a fixed width, and on
/// macOS a fixed height as well.
public struct JunoThinkingPopover: View {
    private let scale: NativeThinkingScale
    @Binding private var effort: NativeReasoningEffort?
    private let width: CGFloat

    public init(
        scale: NativeThinkingScale,
        effort: Binding<NativeReasoningEffort?>,
        width: CGFloat
    ) {
        self.scale = scale
        _effort = effort
        self.width = width
    }

    private var index: Int { scale.index(of: effort) ?? 0 }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("THINKING")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                Text(scale.stop(at: index)?.label ?? "Off")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.junoAccent)
            }
            .accessibilityHidden(true)

            JunoThinkingSlider(scale: scale, effort: $effort)

            if let caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: width)
    }

    private var caption: String? {
        switch scale.stops.count {
        case 2 where scale.stops.contains(.thinking):
            "This model has one thinking mode rather than depths."
        case 2:
            "This model offers two levels."
        default:
            nil
        }
    }
}

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
public struct JunoThinkingSlider: View {
    private let scale: NativeThinkingScale
    @Binding private var effort: NativeReasoningEffort?

    public init(scale: NativeThinkingScale, effort: Binding<NativeReasoningEffort?>) {
        self.scale = scale
        _effort = effort
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var focused: Bool

    private let trackHeight: CGFloat = 34
    private let thumb: CGFloat = 26
    private let pad: CGFloat = 4

    private var count: Int { max(scale.stops.count, 1) }
    private var lastIndex: Int { count - 1 }
    private var index: Int { scale.index(of: effort) ?? 0 }

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
        .focusable(scale.isAdjustable)
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
        .accessibilityValue(scale.stop(at: index)?.accessibilityLabel ?? "Off")
        .accessibilityHint("Adjustable. Swipe up or down to change the thinking level.")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("juno.thinking-slider")
        .disabled(!scale.isAdjustable)
    }

    /// Maps a touch to the nearest detent. `x` is measured from the track's
    /// leading edge; the thumb's own centre offset is removed first so the
    /// detent under the finger is the one that gets picked.
    private func select(at x: CGFloat, travel: CGFloat) {
        guard scale.isAdjustable, travel > 0 else { return }
        let position = (x - pad - thumb / 2) / travel
        let target = Int((position * Double(lastIndex)).rounded())
        commit(min(max(target, 0), lastIndex))
    }

    private func step(_ delta: Int) {
        guard scale.isAdjustable else { return }
        commit(min(max(index + delta, 0), lastIndex))
    }

    private func commit(_ target: Int) {
        guard target != index, let stop = scale.stop(at: target) else { return }
        effort = stop.effort
    }

    static let gradientColours: [Color] = [
        Color.junoAccent,
        Color(red: 0.90, green: 0.42, blue: 0.52),
        Color(red: 0.53, green: 0.42, blue: 0.86),
    ]
}
