import SwiftUI

/// AIcss "Image Generation" — the canvas.
///
/// The one block in the set that arrived already speaking Juno: a field of points
/// with a soft mass moving through it. The dot matrix is this app's own mark (see
/// `JunoBrand`), so adopting this said "something is being made" in the
/// vocabulary the brand already uses for it — and on the web it replaced three
/// blurred orbs, a soft-light sheen sweep and a breathing radial pulse doing the
/// same job with five stacked gradient layers.
///
/// Two ellipses are cut out of a denser lattice. They walk the four corners on a
/// 4.2s overshoot curve while breathing on an unrelated 1.9s one, so the motion
/// never lands on a beat the eye can anticipate — which is what stops a loop of
/// this length reading as a loop.
public struct JunoAIcssImageCanvas: View {
    /// One keyframe of the morph: two mask ellipses, each a size and a position
    /// as fractions of the canvas. Verbatim from `@keyframes aicss-ig-morph`.
    private struct Frame {
        let sizeA: CGSize
        let sizeB: CGSize
        let originA: CGPoint
        let originB: CGPoint
    }

    private static let frames: [Frame] = [
        Frame(sizeA: CGSize(width: 0.52, height: 0.46), sizeB: CGSize(width: 0.40, height: 0.40),
              originA: CGPoint(x: 0.16, y: 0.20), originB: CGPoint(x: 0.30, y: 0.32)),
        Frame(sizeA: CGSize(width: 0.46, height: 0.58), sizeB: CGSize(width: 0.44, height: 0.38),
              originA: CGPoint(x: 0.84, y: 0.16), originB: CGPoint(x: 0.66, y: 0.30)),
        Frame(sizeA: CGSize(width: 0.60, height: 0.44), sizeB: CGSize(width: 0.38, height: 0.46),
              originA: CGPoint(x: 0.82, y: 0.84), originB: CGPoint(x: 0.62, y: 0.68)),
        Frame(sizeA: CGSize(width: 0.48, height: 0.54), sizeB: CGSize(width: 0.46, height: 0.40),
              originA: CGPoint(x: 0.14, y: 0.82), originB: CGPoint(x: 0.34, y: 0.66)),
    ]

    private static let morphCycle: Double = 4.2
    private static let breatheCycle: Double = 1.9
    /// `cubic-bezier(0.35, 1.55, 0.65, 1)` — the overshoot that makes the mass
    /// arrive with weight rather than gliding into place.
    private static let morphCurve = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.35, y: 1.55),
        endControlPoint: UnitPoint(x: 0.65, y: 1)
    )
    /// `cubic-bezier(0.66, 0, 0.34, 1)`.
    private static let breatheCurve = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.66, y: 0),
        endControlPoint: UnitPoint(x: 0.34, y: 1)
    )

    private let pitch: Double
    private let resolution: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - pitch: the lattice spacing. AIcss's 11pt is tuned against the mask
    ///     sizes above and is the default; a canvas much larger than their 208pt
    ///     wants it opened up, or the field reads as a texture.
    ///   - resolution: shown as a badge, in the metadata voice, when the request
    ///     fixed a size. Never invented.
    public init(pitch: Double = 11, resolution: String? = nil) {
        self.pitch = pitch
        self.resolution = resolution
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topTrailing) {
                lattice(radius: 0.85, color: .junoMutedForeground)
                    .opacity(0.22)

                if reduceMotion {
                    // Still, and slightly brighter than the animated floor: the
                    // mass is the subject, and with nothing moving it has to
                    // carry the whole "in progress" reading on presence alone.
                    mass(frame: Self.frames[0], in: geometry.size).opacity(0.7)
                } else {
                    TimelineView(.animation) { context in
                        let time = context.date.timeIntervalSinceReferenceDate
                        mass(frame: interpolatedFrame(at: time), in: geometry.size)
                            .opacity(breathe(at: time))
                    }
                }

                if let resolution {
                    Text(resolution)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.junoMutedForeground)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.junoSurface.opacity(0.72), in: Capsule())
                        .padding(8)
                }
            }
        }
        .background(Color.junoMuted)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityHidden(true)
    }

    /// The point field. Drawn rather than tiled so the pitch is exact and the
    /// whole thing is one draw call instead of a few hundred views.
    private func lattice(radius: Double, color: Color) -> some View {
        Canvas { context, size in
            // `background-repeat: space` in the original: whole tiles only, with
            // the remainder shared out between them, so the field never ends on a
            // clipped half-point.
            let columns = max(1, Int((size.width - 4) / pitch))
            let rows = max(1, Int((size.height - 4) / pitch))
            let stepX = (size.width - 4) / Double(columns)
            let stepY = (size.height - 4) / Double(rows)
            for row in 0...rows {
                for column in 0...columns {
                    let centre = CGPoint(x: 2 + Double(column) * stepX, y: 2 + Double(row) * stepY)
                    context.fill(
                        Path(ellipseIn: CGRect(
                            x: centre.x - radius,
                            y: centre.y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )),
                        with: .color(color)
                    )
                }
            }
        }
        .padding(2)
    }

    /// The denser lattice, cut to two soft ellipses.
    private func mass(frame: Frame, in size: CGSize) -> some View {
        lattice(radius: 1.25, color: .primary)
            .mask {
                ZStack(alignment: .topLeading) {
                    ellipse(size: frame.sizeA, origin: frame.originA, stop: 0.60, in: size)
                    ellipse(size: frame.sizeB, origin: frame.originB, stop: 0.62, in: size)
                }
            }
    }

    /// One mask ellipse. CSS position percentages are fractions of the space
    /// LEFT OVER (`p × (container − image)`), which is why a position of 84% does
    /// not push the ellipse off the canvas.
    private func ellipse(size fraction: CGSize, origin: CGPoint, stop: Double, in canvas: CGSize) -> some View {
        let width = canvas.width * fraction.width
        let height = canvas.height * fraction.height
        return RadialGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .clear, location: stop),
            ],
            center: .center,
            startRadius: 0,
            endRadius: max(width, height) / 2
        )
        .frame(width: width, height: height)
        .offset(x: (canvas.width - width) * origin.x, y: (canvas.height - height) * origin.y)
    }

    /// CSS applies the timing function BETWEEN each pair of keyframes, not once
    /// across the whole animation, so the curve is evaluated per segment.
    private func interpolatedFrame(at time: TimeInterval) -> Frame {
        let phase = time.truncatingRemainder(dividingBy: Self.morphCycle) / Self.morphCycle
        let scaled = phase * Double(Self.frames.count)
        let index = min(Int(scaled), Self.frames.count - 1)
        let next = (index + 1) % Self.frames.count
        let t = Double(Self.morphCurve.value(at: scaled - Double(index)))
        let from = Self.frames[index]
        let to = Self.frames[next]
        return Frame(
            sizeA: lerp(from.sizeA, to.sizeA, t),
            sizeB: lerp(from.sizeB, to.sizeB, t),
            originA: lerp(from.originA, to.originA, t),
            originB: lerp(from.originB, to.originB, t)
        )
    }

    /// `@keyframes aicss-ig-breathe`: 0.55 → 1 → 0.55.
    private func breathe(at time: TimeInterval) -> Double {
        let phase = time.truncatingRemainder(dividingBy: Self.breatheCycle) / Self.breatheCycle
        let rising = phase < 0.5
        let t = Double(Self.breatheCurve.value(at: rising ? phase * 2 : (phase - 0.5) * 2))
        return rising ? 0.55 + 0.45 * t : 1 - 0.45 * t
    }

    private func lerp(_ from: Double, _ to: Double, _ t: Double) -> Double { from + (to - from) * t }
    private func lerp(_ from: CGSize, _ to: CGSize, _ t: Double) -> CGSize {
        CGSize(width: lerp(from.width, to.width, t), height: lerp(from.height, to.height, t))
    }
    private func lerp(_ from: CGPoint, _ to: CGPoint, _ t: Double) -> CGPoint {
        CGPoint(x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t))
    }
}

#if DEBUG
#Preview("AIcss image generation") {
    VStack(alignment: .leading, spacing: 10) {
        JunoAIcssImageCanvas(pitch: 11, resolution: "1024 × 1024")
            .frame(width: 208, height: 208)
        VStack(alignment: .leading, spacing: 1) {
            JunoAIcssThinkingLabel("Generating image", tone: .strong, size: 14)
            Text("“a calm mountain lake at dawn”")
                .font(.system(size: 13))
                .foregroundStyle(Color.junoMutedForeground)
        }
    }
    .padding(24)
    .background(Color.junoCanvas)
}
#endif
