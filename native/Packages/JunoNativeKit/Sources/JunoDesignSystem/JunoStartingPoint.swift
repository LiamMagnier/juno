import SwiftUI

/// The metrics of ``JunoStartingPointCard``.
public enum JunoStartingPointMetrics {
    /// Between two cards in a row, and between rows.
    public static let spacing: CGFloat = JunoSpace.snug
    /// The mark's tile.
    public static let tile: CGFloat = 28
    public static let glyph: CGFloat = 15
    /// The card's radius: the web's `card` rung, concentric with nothing — a
    /// card sits on the canvas.
    public static let radius: CGFloat = JunoRadius.card
    /// The inner padding.
    public static let padding: CGFloat = JunoSpace.cozy
    /// A card is never narrower than this; a row that cannot fit four at
    /// this width wraps to two.
    public static let minimumWidth: CGFloat = 148
}

/// One starting point on an empty state (premium pass, rule 2): a real action
/// with a mark, a two-to-four-word title and one line saying what will happen.
///
/// **Richer than a pill, quieter than a hero.** The card sits on the canvas
/// with a hairline and no fill of its own until the pointer arrives, then
/// lifts: the card fill, the raised throw, one point up, and the mark's tile
/// takes the foreground ink. A press dips it to 0.97 on the press rung. The
/// only colour is the ink; the accent stays the send disc's.
///
/// **A starting point seeds; it never sends.** The action a caller passes
/// fills the composer (or opens examples); a suggestion that sent itself would
/// spend the reader's allowance on a sentence they did not write.
///
/// Under Reduce Motion the lift keeps its fill and shadow and loses its travel.
public struct JunoStartingPointCard: View {
    private let title: String
    private let detail: String
    private let icon: JunoIcon
    private let isSelected: Bool
    private let action: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        title: String,
        detail: String,
        icon: JunoIcon,
        isSelected: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.detail = detail
        self.icon = icon
        self.isSelected = isSelected
        self.action = action
    }

    private var isLifted: Bool { isHovering || isSelected }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: JunoStartingPointMetrics.radius, style: .continuous)
    }

    public var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                JunoIconView(icon, size: JunoStartingPointMetrics.glyph)
                    .foregroundStyle(isLifted ? Color.junoForeground : Color.junoSecondaryInk)
                    .frame(width: JunoStartingPointMetrics.tile, height: JunoStartingPointMetrics.tile)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                            .fill(isLifted ? Color.junoSelectedFill : Color.junoHover)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Text(detail)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(2, reservesSpace: true)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(JunoStartingPointMetrics.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape
                    .fill(isLifted ? Color.junoCard : Color.junoCard.opacity(0))
                    .junoRaisedShadow(isLifted)
            }
            .overlay {
                shape.strokeBorder(Color.junoBorder.opacity(isLifted ? 1 : 0.8), lineWidth: 1)
            }
            .contentShape(shape)
            .offset(y: isHovering ? JunoMotion.shift(-1, reduceMotion: reduceMotion) : 0)
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isLifted)
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: isHovering)
        }
        .buttonStyle(JunoPressButtonStyle())
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A starting point's words and mark, for ``JunoStartingPointGrid``.
public struct JunoStartingPoint: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let icon: JunoIcon

    public init(id: String? = nil, title: String, detail: String, icon: JunoIcon) {
        self.id = id ?? title
        self.title = title
        self.detail = detail
        self.icon = icon
    }
}

/// Starting points sharing their width equally: all in one row where each
/// gets at least ``JunoStartingPointMetrics/minimumWidth``, two by two where
/// they do not — never three and a straggler.
public struct JunoStartingPointGrid: View {
    private let points: [JunoStartingPoint]
    private let selectedID: String?
    private let identifier: (JunoStartingPoint) -> String
    private let choose: (JunoStartingPoint) -> Void

    public init(
        points: [JunoStartingPoint],
        selectedID: String? = nil,
        identifier: @escaping (JunoStartingPoint) -> String = { "juno.starting-point.\($0.id)" },
        choose: @escaping (JunoStartingPoint) -> Void
    ) {
        self.points = points
        self.selectedID = selectedID
        self.identifier = identifier
        self.choose = choose
    }

    @State private var width: CGFloat = 0

    /// All in one row when each card gets its minimum, else two by two.
    private var columns: Int {
        let spacing = JunoStartingPointMetrics.spacing
        let all = CGFloat(points.count)
        let needed = all * JunoStartingPointMetrics.minimumWidth + (all - 1) * spacing
        return width >= needed || width == 0 ? points.count : 2
    }

    public var body: some View {
        let columns = max(1, columns)
        Grid(
            horizontalSpacing: JunoStartingPointMetrics.spacing,
            verticalSpacing: JunoStartingPointMetrics.spacing
        ) {
            ForEach(Array(stride(from: 0, to: points.count, by: columns)), id: \.self) { start in
                GridRow(alignment: .top) {
                    ForEach(start..<min(start + columns, points.count), id: \.self) { index in
                        card(points[index])
                    }
                    if start + columns > points.count {
                        ForEach(points.count..<(start + columns), id: \.self) { _ in
                            Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func card(_ point: JunoStartingPoint) -> some View {
        JunoStartingPointCard(
            title: point.title,
            detail: point.detail,
            icon: point.icon,
            isSelected: point.id == selectedID
        ) {
            choose(point)
        }
        .accessibilityIdentifier(identifier(point))
    }
}
