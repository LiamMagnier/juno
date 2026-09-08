import SwiftUI

/// A placeholder with the final geometry of the thing it stands in for.
///
/// The rework brief's fifth principle: animation may only spend time the user
/// was going to lose anyway. A slow operation gets a skeleton in the real
/// shape of its result — never a spinner, which informs identically whether
/// the request is healthy or wedged and, at 112 sites, was the single most
/// repeated "experimental" tell in both apps. A skeleton says *what* is
/// coming and *how much* of it, and the content lands in place rather than
/// pushing a centred glyph aside.
///
/// The sweep is frame-driven through `TimelineView`, so it stops outright
/// under Reduce Motion (the ambient tier: an ambient loop that is merely
/// slowed is still unbidden motion) and it never names a raw curve.
public struct JunoSkeleton: View {
    private let height: CGFloat
    private let width: CGFloat?
    private let cornerRadius: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One bar. `width` nil fills the available line.
    public init(height: CGFloat = 14, width: CGFloat? = nil, cornerRadius: CGFloat = JunoRadius.chip) {
        self.height = height
        self.width = width
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let phase = reduceMotion ? 0.5 : sweepPhase(at: context.date)
            shape
                .fill(Color.junoMuted)
                .overlay {
                    if !reduceMotion {
                        GeometryReader { proxy in
                            LinearGradient(
                                colors: [.clear, Color.junoForeground.opacity(0.06), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: proxy.size.width * 0.6)
                            .offset(x: (proxy.size.width * 1.6) * phase - proxy.size.width * 0.6)
                        }
                        .clipShape(shape)
                    }
                }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }

    /// 0 → 1 over one sweep, with a rest between sweeps so the shimmer reads
    /// as a pass rather than a strobe. 1.6s is inside the brief's 1.2–2.0s
    /// window for the one loop a screen may run.
    private func sweepPhase(at date: Date) -> Double {
        let period = 1.6
        let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
        return min(1, t * 1.25)
    }
}

/// A run of list rows with a leading mark, a title line and a shorter detail
/// line — the shape most Juno lists share, so a loading list and its loaded
/// self have the same silhouette.
public struct JunoSkeletonRows: View {
    private let count: Int
    private let showsMark: Bool

    public init(count: Int = 6, showsMark: Bool = true) {
        self.count = max(1, count)
        self.showsMark = showsMark
    }

    public var body: some View {
        VStack(spacing: JunoSpace.regular) {
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: JunoSpace.cozy) {
                    if showsMark {
                        JunoSkeleton(height: 28, width: 28, cornerRadius: JunoRadius.row)
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        JunoSkeleton(height: 14, width: titleWidth(for: index))
                        JunoSkeleton(height: 11, width: detailWidth(for: index))
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }

    /// Varied on purpose: identical bars read as a table, not as text.
    private func titleWidth(for index: Int) -> CGFloat { [180, 220, 150, 240, 200, 170][index % 6] }
    private func detailWidth(for index: Int) -> CGFloat { [110, 90, 130, 100, 120, 80][index % 6] }
}

/// A paragraph: three to five lines, the last one short, for a transcript or
/// a document waiting on its text.
public struct JunoSkeletonParagraph: View {
    private let lines: Int

    public init(lines: Int = 4) {
        self.lines = max(1, lines)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(0..<lines, id: \.self) { index in
                JunoSkeleton(height: 12, width: index == lines - 1 ? 140 : nil)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}
