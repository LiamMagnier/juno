import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// What the gauge reads (DESIGN §5.7: `ContextWindowSnapshot`).
public struct CodeV2ContextReading: Equatable, Sendable {
    public var usedTokens: Int
    public var maxTokens: Int
    public var autoCompactAt: Int
    /// "This thread so far: $1.84" for Alevr / BYOK.
    public var costUsd: Double?
    /// "Counts against your Max plan" for a subscription.
    public var planSentence: String?

    public init(usedTokens: Int, maxTokens: Int, autoCompactAt: Int? = nil, costUsd: Double? = nil, planSentence: String? = nil) {
        self.usedTokens = usedTokens
        self.maxTokens = maxTokens
        self.autoCompactAt = autoCompactAt ?? CodeV2ContextMath.autoCompactThreshold(window: maxTokens)
        self.costUsd = costUsd
        self.planSentence = planSentence
    }

    public var fraction: Double { maxTokens > 0 ? Double(usedTokens) / Double(maxTokens) : 0 }
    /// Past 80% of the auto-compact threshold: "needs you soon".
    public var isWarning: Bool {
        autoCompactAt > 0 && Double(usedTokens) / Double(autoCompactAt) >= CodeV2ContextMath.warningPressure
    }
    public var usedLine: String {
        "\(CodeV2ContextMath.compactCount(usedTokens)) of \(CodeV2ContextMath.label(tokens: maxTokens)) (\(Int((fraction * 100).rounded()))%)"
    }
}

/// A 16pt dial in the composer footer: a hairline circle and a solid wedge
/// from twelve o'clock — a wedge, never an open arc, so it cannot be read as
/// the spinner. Hover opens the card; a click pins it.
struct CodeV2ContextGauge: View {
    let reading: CodeV2ContextReading
    var compact: (() -> Void)?

    @State private var hovering = false
    @State private var pinned = false
    @State private var hoverTask: Task<Void, Never>?

    var body: some View {
        Button { pinned.toggle() } label: {
            CodeV2Dial(fraction: reading.fraction, warning: reading.isWarning)
                .frame(width: 16, height: 16)
                .frame(width: 28, height: Studio.Metrics.control)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { inside in
            hoverTask?.cancel()
            if inside {
                hoverTask = Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    if !Task.isCancelled { hovering = true }
                }
            } else {
                hovering = false
            }
        }
        .popover(isPresented: Binding(get: { hovering || pinned }, set: { if !$0 { hovering = false; pinned = false } }), arrowEdge: .top) {
            CodeV2ContextCard(reading: reading, compact: compact)
        }
        .help("Context: \(reading.usedLine)")
        .accessibilityLabel("Context window")
        .accessibilityValue(reading.usedLine)
    }
}

struct CodeV2Dial: View {
    let fraction: Double
    let warning: Bool

    var body: some View {
        ZStack {
            Circle().strokeBorder(Studio.Ink.secondary.opacity(0.55), lineWidth: 1)
            CodeV2Wedge(fraction: min(1, max(0, fraction)))
                .fill(warning ? Studio.Signal.edge : Studio.Ink.secondary)
                .padding(2.5)
        }
    }
}

struct CodeV2Wedge: Shape {
    var fraction: Double
    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard fraction > 0 else { return path }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: center)
        path.addArc(
            center: center, radius: min(rect.width, rect.height) / 2,
            startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * max(fraction, 0.04)), clockwise: false
        )
        path.closeSubpath()
        return path
    }
}

/// The 280pt hover card (DESIGN §5.7).
struct CodeV2ContextCard: View {
    let reading: CodeV2ContextReading
    var compact: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                Text("Context").font(Studio.Font.labelEmphasis)
                Spacer()
                Text(reading.usedLine).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
            }
            CodeV2Meter(fraction: reading.fraction, tint: reading.isWarning ? Studio.Signal.edge : Studio.Ink.primary)
            Text("Compacts at \(CodeV2ContextMath.compactCount(reading.autoCompactAt))")
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            if let cost = reading.costUsd {
                Text("This thread so far: \(CodeV2ContextMath.dollars(cost))")
                    .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
            } else if let plan = reading.planSentence {
                Text(plan).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            }
            if let compact {
                Button("Compact now", action: compact)
                    .buttonStyle(CodeV2OutlineButtonStyle(compact: true))
                    .padding(.top, JunoSpace.tight)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(width: 280, alignment: .leading)
    }
}
