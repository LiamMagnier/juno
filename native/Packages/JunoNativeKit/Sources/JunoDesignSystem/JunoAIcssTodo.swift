import SwiftUI

/// One entry in an AIcss to-do list.
public struct JunoAIcssTodoItem: Identifiable, Hashable, Sendable {
    public enum State: Sendable {
        case pending
        case active
        case done
    }

    public let id: String
    public let label: String
    public let state: State

    public init(id: String, label: String, state: State) {
        self.id = id
        self.label = label
        self.state = state
    }
}

/// AIcss "To-do List" — a plan that reports against itself.
///
/// The header glyph IS the status: a list before anything starts, a determinate pie
/// while it works, a filled check when it is done — and it becomes a chevron on
/// hover or press, because folding is the only thing you can do with a header.
/// Three states and an affordance in one 16pt box, with no label spent on any of
/// them.
///
/// As with the other blocks, AIcss's own version walks itself through five
/// hardcoded tasks on a timer. This one shows exactly what it was given.
public struct JunoAIcssTodoList: View {
    private let items: [JunoAIcssTodoItem]
    private let title: String

    @State private var open: Bool
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(items: [JunoAIcssTodoItem], title: String = "To-dos", defaultOpen: Bool = true) {
        self.items = items
        self.title = title
        self._open = State(initialValue: defaultOpen)
    }

    private var done: Int { items.count { $0.state == .done } }
    private var running: Bool { items.contains { $0.state == .active } }
    private var allDone: Bool { !items.isEmpty && done == items.count }
    private var fraction: Double { items.isEmpty ? 0 : Double(done) / Double(items.count) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(items) { item in
                        row(item)
                    }
                }
                .padding(.top, 10)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 12)
        .background(Color.junoSurface)
        .clipShape(RoundedRectangle(cornerRadius: JunoCornerRadius.compactControl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.compactControl, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: open)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: done)
    }

    private var header: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 8) {
                headerGlyph
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 0)
                // The count rolls rather than cuts. `contentTransition(.numericText)`
                // is the platform's own version of the web's per-digit roller, and
                // it does the same thing: the changed digit moves, the rest hold.
                Text("\(done)/\(items.count)")
                    .font(.system(size: 13))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
                    .contentTransition(.numericText(value: Double(done)))
            }
            .frame(minHeight: 22)
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .onHover { hovering = $0 }
        #endif
        .accessibilityLabel("\(title) — \(done) of \(items.count) done")
    }

    @ViewBuilder
    private var headerGlyph: some View {
        ZStack {
            if hovering || !open {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.junoMutedForeground)
                    .rotationEffect(.degrees(open ? 0 : -90))
            } else if allDone {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.junoSuccess)
            } else if running {
                pie
            } else {
                Image(systemName: "list.bullet")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.junoMutedForeground)
            }
        }
        .frame(width: 16, height: 16)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: hovering)
    }

    /// A determinate wedge inside the same dotted ring the pending items wear, so
    /// the header's progress and the list's own glyphs are visibly one system.
    private var pie: some View {
        ZStack {
            Circle()
                .strokeBorder(
                    Color.junoMutedForeground,
                    style: StrokeStyle(lineWidth: 1.4, lineCap: .round, dash: [1.4, 2.8])
                )
            Circle()
                .trim(from: 0, to: fraction)
                .fill(Color.primary)
                .rotationEffect(.degrees(-90))
                .padding(2.6)
        }
        .frame(width: 13, height: 13)
    }

    private func row(_ item: JunoAIcssTodoItem) -> some View {
        HStack(alignment: .top, spacing: 9) {
            glyph(item.state)
            label(item)
            Spacer(minLength: 0)
        }
    }

    /// Dotted ring → arrow → check, stacked in one box so the label beside them
    /// cannot shift as a task changes hands.
    private func glyph(_ state: JunoAIcssTodoItem.State) -> some View {
        ZStack {
            Image(systemName: "circle.dotted")
                .foregroundStyle(Color.junoMutedForeground)
                .opacity(state == .pending ? 1 : 0)
            Image(systemName: "arrow.right.circle")
                .foregroundStyle(Color.primary)
                .opacity(state == .active ? 1 : 0)
            Image(systemName: "checkmark.circle")
                .foregroundStyle(Color.junoMutedForeground)
                .opacity(state == .done ? 1 : 0)
        }
        .font(.system(size: 14))
        .frame(width: 16, height: 16)
        .padding(.top, 1)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: state)
    }

    @ViewBuilder
    private func label(_ item: JunoAIcssTodoItem) -> some View {
        switch item.state {
        case .active:
            // The one shining line in the block, which is what makes "where the
            // agent is" findable in a list of ten without a colour or a badge.
            Text(item.label)
                .font(.system(size: 13))
                .junoAIcssShine(color: .primary)
                .fixedSize(horizontal: false, vertical: true)
        case .done:
            Text(item.label)
                .font(.system(size: 13))
                .strikethrough()
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        case .pending:
            Text(item.label)
                .font(.system(size: 13))
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

#if DEBUG
#Preview("AIcss to-dos") {
    JunoAIcssTodoList(items: [
        .init(id: "0", label: "Scaffold the project structure", state: .done),
        .init(id: "1", label: "Build the component registry", state: .done),
        .init(id: "2", label: "Implement entitlement gating", state: .active),
        .init(id: "3", label: "Wire up Stripe checkout", state: .pending),
        .init(id: "4", label: "Polish the landing page", state: .pending),
    ])
    .padding(20)
    .frame(width: 360)
    .background(Color.junoCanvas)
}
#endif
