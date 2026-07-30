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
            .fill(.quaternary)
            .overlay {
                Text(String(providerName.prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
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
            // One element that reads the whole set, rather than the previous
            // `accessibilityHidden(true)`.
            //
            // Hiding was defensible when every chip restated something already in
            // the row, but it never was for the compact form — a glyph-only chip
            // has no visible text to fall back on, so the capabilities were simply
            // absent for a VoiceOver reader. "Screen control" makes that worse: it
            // is derived rather than shown anywhere else, so hiding it would hide
            // the only statement of whether a model can drive the Mac.
            //
            // Combined instead of per-chip so a five-capability row is one stop
            // instead of five.
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

    public init(model: JunoModelDescriptor, showsHeader: Bool = true) {
        self.model = model
        self.showsHeader = showsHeader
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if showsHeader {
                HStack(spacing: JunoSpace.tight) {
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
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    ForEach(Array(model.highlights.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
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

            if showsHeader, !model.capabilities.isEmpty {
                JunoModelCapabilityChips(capabilities: model.capabilities)
                    .accessibilityLabel(
                        "Capabilities: "
                            + model.capabilities.map(\.label).joined(separator: ", ")
                    )

                // A chip that names a Juno feature rather than a model property
                // says what it means. Only `computerUse` carries one today.
                ForEach(model.capabilities.filter { $0.explanation != nil }) { capability in
                    if let explanation = capability.explanation {
                        Text(explanation)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            // Bars only when real grades were published — a router has none, and
            // its speed or intelligence is not something to invent.
            if let intelligence = model.intelligenceGrade {
                JunoGradeBars(label: "Intelligence", value: intelligence)
            }
            if let speed = model.speedGrade {
                JunoGradeBars(label: "Speed", value: speed)
            }

            VStack(alignment: .leading, spacing: 5) {
                if let context = model.contextWindowTokens {
                    detailLine(
                        "Context",
                        JunoModelFormatting.contextWindow(context) + " tokens"
                    )
                }
                if let price = model.priceDetail {
                    detailLine("Pricing", price)
                }
                if let released = model.released {
                    detailLine("Released", released)
                }
                detailLine("Thinking", model.thinking.summary)
                if let reason = model.unavailabilityReason {
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
            parts.append(JunoModelFormatting.contextWindow(context) + " context")
        }
        return parts.joined(separator: " · ")
    }

    private func detailLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
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
