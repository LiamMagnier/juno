import Foundation
import JunoDesignSystem
import SwiftUI

/// Deep Field, native: the run's real sources on three orbits around the
/// question — found on the outer ring, read on the middle, cited on the inner
/// with its number — and one presence line drawn to the page being read now.
///
/// **Signature detail.** Motion is state, never decoration: a source arrives
/// on its orbit when it is discovered and *travels inward* when it is read or
/// cited (a layout move on the house spring), and the presence line follows the
/// page being read. Nothing loops; a finished field is drawn still, and under
/// Reduce Motion everything cross-fades in place.
public struct NativeResearchField: View {
    let model: NativeResearchFieldModel
    /// Working: the centre mark answers events, and the presence line shows.
    let working: Bool
    /// What changed last, so the centre mark passes tone once per event.
    let eventKey: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0

    public init(model: NativeResearchFieldModel, working: Bool, eventKey: String) {
        self.model = model
        self.working = working
        self.eventKey = eventKey
    }

    public var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { ring in
                FieldOrbit(rx: NativeResearchFieldModel.rings[ring].rx, ry: NativeResearchFieldModel.rings[ring].ry)
                    .stroke(
                        Color.junoSecondaryInk.opacity(ring == 2 ? 0.28 : 0.42),
                        style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [0.5, 5])
                    )
            }
            if working, let current = model.current {
                FieldPresenceLine(x: current.x, y: current.y)
                    .stroke(Color.junoAccent.opacity(0.7), style: StrokeStyle(lineWidth: 1, lineCap: .round))
                    .transition(.opacity)
            }
            FieldLayout {
                JunoResearchPresence(active: working, eventKey: eventKey, size: 22)
                    .layoutValue(key: FieldPlacement.self, value: .init(x: 0.5, y: 0.5))
                ForEach(model.nodes) { node in
                    FieldNodeMark(node: node, working: working)
                        .layoutValue(key: FieldPlacement.self, value: .init(x: node.x, y: node.y))
                        .transition(.opacity.combined(with: .scale(scale: 0.4)))
                }
                ForEach(model.nodes.filter { $0.labelled || $0.cited != nil }) { node in
                    FieldLabel(node: node, showsHost: node.labelled && fits(node))
                        .layoutValue(
                            key: FieldPlacement.self,
                            value: .init(
                                x: node.x, y: node.labelY,
                                anchor: node.labelTrailing ? .leading : .trailing,
                                dx: node.labelTrailing ? 14 : -14
                            )
                        )
                        .transition(.opacity)
                }
            }
        }
        .aspectRatio(1.32, contentMode: .fit)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .animation(JunoMotion.reduced(JunoMotion.layout, when: reduceMotion), value: model)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    /// Whether a node's host fits on its outward side without leaving the
    /// box. One that does not keeps only its citation number: no label is
    /// better than one drawn across the field.
    private func fits(_ node: NativeResearchFieldModel.Node) -> Bool {
        guard width > 0 else { return true }
        let estimate = CGFloat(node.host.count + (node.cited == nil ? 0 : 3)) * 6.8 + 6
        let x = width * node.x
        return node.labelTrailing ? x + 14 + estimate <= width : x - 14 - estimate >= 0
    }

    private var accessibilityLabel: String {
        let cited = model.nodes.filter { $0.state == .cited }.count
        let read = model.nodes.filter { $0.state == .read }.count + cited
        var line = "Source map: \(read) read"
        if cited > 0 { line += ", \(cited) cited" }
        if let current = model.current, working { line += ". Reading \(current.host)" }
        return line
    }
}

/// One source on the map: a quiet point while only found, its logo once read,
/// its logo under a hairline ring once cited, the accent ring while it is the
/// page being read.
private struct FieldNodeMark: View {
    let node: NativeResearchFieldModel.Node
    let working: Bool

    var body: some View {
        switch node.state {
        case .found:
            Circle()
                .fill(Color.junoSecondaryInk.opacity(0.5))
                .frame(width: 5, height: 5)
                .frame(width: 18, height: 18)
        case .read, .cited:
            NativeSourceIcon(url: node.url, size: node.state == .cited ? 18 : 15, circular: true)
                .padding(2)
                .background(Circle().fill(Color.junoCanvas))
                .overlay(
                    Circle().strokeBorder(
                        node.current && working ? Color.junoAccent
                            : node.state == .cited ? Color.junoForeground.opacity(0.55) : Color.junoHairline,
                        lineWidth: node.current && working ? 1.5 : 1
                    )
                )
        }
    }
}

private struct FieldLabel: View {
    let node: NativeResearchFieldModel.Node
    let showsHost: Bool

    var body: some View {
        HStack(spacing: 4) {
            if let cited = node.cited {
                Text(cited.formatted())
                    .foregroundStyle(Color.junoForeground)
            }
            if showsHost {
                Text(node.host)
                    .foregroundStyle(node.current ? Color.junoForeground : Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
        .fixedSize()
    }
}

/// Where a subview sits on the map: a point as fractions of the box, which of
/// its own points sits there, and a nudge in points.
struct FieldPlacement: LayoutValueKey {
    struct Value: Equatable {
        var x: Double
        var y: Double
        var anchor: UnitPoint = .center
        var dx: CGFloat = 0
    }
    static let defaultValue = Value(x: 0.5, y: 0.5)
}

/// Places every subview at its ``FieldPlacement``; moves animate as layout.
struct FieldLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions(by: CGSize(width: 320, height: 240))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            let place = subview[FieldPlacement.self]
            let size = subview.sizeThatFits(.unspecified)
            let nodeX = bounds.minX + bounds.width * place.x
            // Held inside the box; the field drops a host that cannot fit.
            var x = nodeX + place.dx
            if place.anchor == .leading { x = min(x, bounds.maxX - size.width) }
            if place.anchor == .trailing { x = max(x, bounds.minX + size.width) }
            let point = CGPoint(x: x, y: bounds.minY + bounds.height * place.y)
            subview.place(at: point, anchor: place.anchor, proposal: .unspecified)
        }
    }
}

/// An orbit: an ellipse centred in the box, its radii fractions of the box.
struct FieldOrbit: Shape {
    let rx: Double
    let ry: Double

    func path(in rect: CGRect) -> Path {
        Path(ellipseIn: CGRect(
            x: rect.midX - rect.width * rx, y: rect.midY - rect.height * ry,
            width: rect.width * rx * 2, height: rect.height * ry * 2
        ))
    }
}

/// The presence line: from the question to the page being read, animatable so
/// it follows that page round the map.
struct FieldPresenceLine: Shape {
    var x: Double
    var y: Double

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(x, y) }
        set { x = newValue.first; y = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        let end = CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        // Starts clear of the centre mark and stops short of the logo's ring.
        let dx = end.x - centre.x
        let dy = end.y - centre.y
        let length = max(1, (dx * dx + dy * dy).squareRoot())
        let start = CGPoint(x: centre.x + dx / length * 15, y: centre.y + dy / length * 15)
        let stop = CGPoint(x: end.x - dx / length * 12, y: end.y - dy / length * 12)
        guard length > 30 else { return path }
        path.move(to: start)
        path.addLine(to: stop)
        return path
    }
}
