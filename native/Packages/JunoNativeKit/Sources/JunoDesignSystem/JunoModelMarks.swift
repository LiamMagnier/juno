import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The leaves of the model picker: the provider mark, capability chips, grade
/// bars and the spec sheet.
///
/// These moved down from JunoChatKit so Juno Code can render them without
/// importing the chat stack. They were already presentation-neutral — a logo and
/// a ten-segment meter know nothing about a manifest — so nothing about them
/// changed except which module they live in.

// MARK: - Provider mark

/// A model provider's real logo, from the same artwork the website serves.
///
/// Each provider ships light and dark variants in the **app's** asset catalog
/// under `Providers/`, so the mark stays legible in both appearances without
/// tinting. Deliberately resolved against `Bundle.main` rather than
/// `.module`: both apps already carry the catalog, and duplicating fifteen
/// imagesets into a package resource bundle would mean two copies to keep in
/// step with the web. A package that renders this inside either app therefore
/// gets the same marks for free.
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
            .fill(Color.junoMuted)
            .overlay {
                Text(String(providerName.prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .semibold, design: .rounded))
                    .junoSecondaryInk()
            }
    }
}

// MARK: - Chip flow

/// A one-axis flow: lay chips left to right, wrap when the row is full.
///
/// `HStack` cannot do this — it either overflows its container or squeezes its
/// children — and the chips have to survive both a narrow detail panel and
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

// MARK: - Grade bars

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
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.caption)
                    .junoSecondaryInk()
                Spacer()
                Text("\(value)/10")
                    .font(.caption.monospaced())
                    .junoMetaInk()
            }
            HStack(spacing: 3) {
                ForEach(0..<10, id: \.self) { index in
                    Capsule()
                        .fill(index < value ? Color.junoAccent : Color.junoForeground.opacity(0.12))
                        .frame(height: 10)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value) out of 10")
    }
}

// MARK: - Capability chips

/// The capabilities a model reported, as chips.
///
/// An empty `capabilities` array renders nothing — it means the product reported
/// no capabilities, not that they were omitted for space.
public struct JunoModelCapabilityChips: View {
    private let capabilities: [JunoModelCapability]
    /// List rows use glyph-only chips. Four labelled capsules do not fit a
    /// narrow row, and a chip that wraps mid-word is worse than a glyph with an
    /// accessibility label — the spec sheet spells them out.
    private let compact: Bool

    public init(capabilities: [JunoModelCapability], compact: Bool = false) {
        self.capabilities = capabilities
        self.compact = compact
    }

    public var body: some View {
        if !capabilities.isEmpty {
            JunoChipFlow(spacing: compact ? 4 : 5) {
                ForEach(capabilities) { chip in
                    Group {
                        if compact {
                            Image(systemName: chip.systemImage)
                                .junoFont(size: 10, relativeTo: .caption, weight: .medium)
                                .frame(width: 15, height: 15)
                        } else {
                            Label(chip.label, systemImage: chip.systemImage)
                                .junoFont(size: 10, relativeTo: .caption, weight: .medium)
                                .labelStyle(.titleAndIcon)
                                // A chip is one line by definition; without this
                                // the label wraps mid-word inside its capsule.
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                        }
                    }
                    .junoSecondaryInk()
                    .background {
                        Capsule().strokeBorder(Color.junoHairline, lineWidth: 1)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                capabilities.map(\.label).joined(separator: ", ")
            )
        }
    }
}

// MARK: - Spec sheet

/// Everything the product actually knows about one model. Every value here is
/// published, never derived or estimated, so a field that was not supplied
/// simply does not appear.
public struct JunoModelSpecSheet: View {
    private let model: JunoModelDescriptor
    /// Expanded under its own row, where the name, provider and summary are
    /// already on screen — repeating them there would just be noise.
    private let showsHeader: Bool

    @State private var stopID: String? = nil

    public init(model: JunoModelDescriptor, showsHeader: Bool = true) {
        self.model = model
        self.showsHeader = showsHeader
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if showsHeader {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.displayName)
                            .font(.title3.weight(.bold))
                            .junoInk()
                        Text(subtitle)
                            .font(.caption)
                            .junoSecondaryInk()
                    }
                    Spacer(minLength: 8)
                    JunoProviderMark(
                        providerID: model.providerID,
                        providerName: model.providerName,
                        size: 28
                    )
                }

                if let summary = model.summary {
                    Text(summary)
                        .font(.subheadline)
                        .junoSecondaryInk()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !model.highlights.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    ForEach(Array(model.highlights.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            Text("\(index + 1)")
                                .font(.caption.monospaced())
                                .foregroundStyle(Color.junoAccent)
                            Text(line)
                                .font(.caption)
                                .junoSecondaryInk()
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            if showsHeader, !model.capabilities.isEmpty {
                JunoModelCapabilityChips(capabilities: model.capabilities)

                ForEach(model.capabilities.filter { $0.explanation != nil }) { capability in
                    if let explanation = capability.explanation {
                        Text(explanation)
                            .font(.caption)
                            .junoSecondaryInk()
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            // Bars matching website layout (Intelligence, Speed, Context, Cost)
            VStack(alignment: .leading, spacing: 10) {
                if let intelligence = model.intelligenceGrade {
                    JunoGradeBars(label: "Intelligence", value: intelligence)
                }
                if let speed = model.speedGrade {
                    JunoGradeBars(label: "Speed", value: speed)
                }
                if let contextGrade = contextGradeValue {
                    JunoGradeBars(label: "Context", value: contextGrade)
                }
                if let costGrade = costGradeValue {
                    JunoGradeBars(label: "Cost", value: costGrade)
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                if let price = model.priceDetail {
                    detailLine("Pricing", price)
                }
                if let released = model.released {
                    detailLine("Released", released)
                }
                if model.thinking.isAdjustable {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Thinking")
                                .font(.caption)
                                .junoMetaInk()
                                .frame(width: 76, alignment: .leading)
                            Text(model.thinking.label(for: stopID))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.junoAccent)
                        }
                        JunoThinkingTrack(
                            ladder: model.thinking,
                            stopID: $stopID
                        )
                    }
                    .padding(.vertical, 2)
                    .onAppear {
                        if stopID == nil {
                            stopID = model.thinking.stops.last?.id
                        }
                    }
                    .onChange(of: model.id) { _, _ in
                        stopID = model.thinking.stops.last?.id
                    }
                } else {
                    detailLine("Thinking", model.thinking.summary)
                }
                if let reason = model.unavailabilityReason {
                    detailLine("Availability", reason)
                }
                if let retires = model.retiresOn.flatMap(JunoModelFormatting.retirementDate) {
                    detailLine("Available until", retires)
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
            parts.append(JunoModelFormatting.contextWindow(context) + " context")
        }
        return parts.joined(separator: " · ")
    }

    private var contextGradeValue: Int? {
        guard let tokens = model.contextWindowTokens else { return nil }
        if tokens >= 1_000_000 { return 10 }
        if tokens >= 500_000 { return 8 }
        if tokens >= 200_000 { return 7 }
        if tokens >= 128_000 { return 5 }
        return 3
    }

    private var costGradeValue: Int? {
        guard let glyph = model.costGlyph else { return nil }
        switch glyph {
        case "$$$$", "$$$": return 10
        case "$$": return 6
        case "$": return 3
        default: return 5
        }
    }

    private func detailLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text(label)
                .font(.caption)
                .junoMetaInk()
                .frame(width: 76, alignment: .leading)
            Text(value)
                .font(.caption)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
