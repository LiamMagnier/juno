import SwiftUI

/// The composer's thinking dial, as a glyph: a 270° arc open at the bottom and
/// a needle from the hub to the current depth — ChatGPT's "thinking speed"
/// gauge, drawn rather than borrowed so the needle can travel between levels
/// instead of swapping between four fixed symbols.
///
/// Shared by the iPhone and the Mac so the one control looks and moves the
/// same on both.
public struct JunoDialShape: Shape {
    /// 0 is the shallowest level (needle lower left), 1 the deepest (lower
    /// right); 0.5 stands the needle upright, which is what Auto shows.
    public var fraction: Double

    public init(fraction: Double) {
        self.fraction = fraction
    }

    public var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    public func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        var path = Path()
        // Angles run clockwise from 3 o'clock in a flipped space: 135° is the
        // lower left, 405° the lower right, so the gap sits at the bottom.
        path.addArc(
            center: center, radius: radius,
            startAngle: .degrees(135), endAngle: .degrees(405), clockwise: false
        )
        let angle = Angle.degrees(135 + 270 * min(max(fraction, 0), 1)).radians
        let length = radius * 0.56
        path.move(to: center)
        path.addLine(to: CGPoint(x: center.x + cos(angle) * length, y: center.y + sin(angle) * length))
        return path
    }
}

/// The dial at a control's size, its needle swinging on the control spring.
public struct JunoDialGlyph: View {
    let fraction: Double
    var size: CGFloat
    var lineWidth: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(fraction: Double, size: CGFloat = 21, lineWidth: CGFloat = 1.9) {
        self.fraction = fraction
        self.size = size
        self.lineWidth = lineWidth
    }

    public var body: some View {
        JunoDialShape(fraction: fraction)
            .stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
            .overlay { Circle().frame(width: lineWidth * 1.9, height: lineWidth * 1.9) }
            .frame(width: size, height: size)
            .animation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion), value: fraction)
            .accessibilityHidden(true)
    }

    /// Where the needle sits for a level on a model's ladder.
    public static func fraction(index: Int?, count: Int) -> Double {
        guard let index, count > 1 else { return 0.5 }
        return Double(index) / Double(count - 1)
    }
}
