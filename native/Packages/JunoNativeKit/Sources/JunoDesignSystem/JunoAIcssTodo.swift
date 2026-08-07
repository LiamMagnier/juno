import SwiftUI

/// One entry in an AIcss to-do list.
public struct JunoAIcssTodoItem: Identifiable, Hashable, Sendable {
    public enum State: Sendable {
        case pending
        case active
        case done
        /// Started and stopped — waiting on something the agent cannot resolve.
        ///
        /// AIcss has no such state; its list is pending → active → done. It is
        /// added because Juno's own plans have it (`GoalStepStatus.blocked`), and
        /// folding a blocked step into `pending` would say the plan is merely
        /// waiting its turn when it is actually stuck. That is the one thing a
        /// reader glancing at a plan most needs to be told.
        case blocked
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
    private var blocked: Int { items.count { $0.state == .blocked } }
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
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
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
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                Spacer(minLength: 0)
                // The count rolls rather than cuts. `contentTransition(.numericText)`
                // is the platform's own version of the web's per-digit roller, and
                // it does the same thing: the changed digit moves, the rest hold.
                Text("\(done)/\(items.count)")
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
                    .contentTransition(.numericText(value: Double(done)))
            }
            .frame(minHeight: 22)
        }
        .buttonStyle(.junoPress)
        #if os(macOS)
        .onHover { hovering = $0 }
        #endif
        .accessibilityLabel(blocked > 0
            ? "\(title) — \(done) of \(items.count) done, \(blocked) blocked"
            : "\(title) — \(done) of \(items.count) done")
    }

    @ViewBuilder
    private var headerGlyph: some View {
        ZStack {
            if hovering || !open {
                Image(systemName: "chevron.down")
                    .junoFont(size: 11, relativeTo: .caption, weight: .semibold)
                    .foregroundStyle(Color.junoMutedForeground)
                    .rotationEffect(.degrees(open ? 0 : -90))
            } else if allDone {
                Image(systemName: "checkmark.circle.fill")
                    .junoFont(size: 14, relativeTo: .body)
                    .foregroundStyle(Color.junoSuccess)
            } else if blocked > 0, !running {
                // The plan has stopped and cannot continue on its own. A pie here
                // would keep implying forward motion at whatever fraction it had
                // reached when it stalled.
                Image(systemName: "exclamationmark.circle")
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .foregroundStyle(Color.junoCaution)
            } else if running {
                pie
            } else {
                Image(systemName: "list.bullet")
                    .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(Color.junoMutedForeground)
            }
        }
        .frame(width: 16, height: 16)
        // `.tint`: a hover fill is a colour change on the element the pointer
        // is already touching. Nothing moves, so there is nothing for Reduce
        // Motion to remove — flattening it to the cross-fade rung would cost the
        // feedback and buy the preference nothing.
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: hovering
        )
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
                .fill(Color.junoForeground)
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
                .foregroundStyle(Color.junoForeground)
                .opacity(state == .active ? 1 : 0)
            Image(systemName: "checkmark.circle")
                .foregroundStyle(Color.junoMutedForeground)
                .opacity(state == .done ? 1 : 0)
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(Color.junoCaution)
                .opacity(state == .blocked ? 1 : 0)
        }
        .junoFont(size: 14, relativeTo: .body)
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
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoAIcssShine(color: .primary)
                .fixedSize(horizontal: false, vertical: true)
        case .done:
            Text(item.label)
                .junoFont(size: 13, relativeTo: .subheadline)
                .strikethrough()
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        case .pending:
            Text(item.label)
                .junoFont(size: 13, relativeTo: .subheadline)
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        case .blocked:
            // Not shining: the shine means "being worked on", and a blocked step
            // is precisely the one that is not.
            Text(item.label)
                .junoFont(size: 13, relativeTo: .subheadline)
                .foregroundStyle(Color.junoCaution)
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
