import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The goal's progress row, directly above the composer while a goal exists
/// and is not cleared (CODE_AGENT_SPEC §2.8). Text only:
///
/// > **Goal** Make the settings menu open on click · 2 of 3 criteria · 38 min · turn 7 · $1.12
/// > Checking: c2 has no Preview evidence yet            Pause · Edit · Clear
///
/// Glow only while a run works toward it (glow = state); never a dot or a
/// status pill.
struct StudioGoalRow: View {
    let content: GoalRowContent
    let isWorking: Bool
    let perform: (GoalRowContent.Action) -> Void
    let openSheet: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                title
                if content.detail == nil {
                    actions
                }
            }
            if let detail = content.detail {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(studioInline: detail)
                        .font(Studio.Font.meta)
                        .foregroundStyle(
                            content.status == .needsYou || content.status == .budgetReached
                                ? Studio.Ink.primary
                                : Studio.Ink.secondary
                        )
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: JunoSpace.snug)
                    actions
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .modifier(StudioGoalSurface(isWorking: isWorking))
        .accessibilityElement(children: .contain)
    }

    /// "Goal", the objective and the facts; opens the sheet.
    private var title: some View {
        Button(action: openSheet) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Goal")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Text(content.objective)
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(content.facts)
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Open the goal: criteria, evidence, budget and history")
        .accessibilityLabel("Goal: \(content.objective). \(content.facts)")
        .accessibilityIdentifier("juno.code.goal.row")
    }

    /// Pause · Edit · Clear, as words.
    private var actions: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            ForEach(Array(content.actions.enumerated()), id: \.element) { index, action in
                if index > 0 {
                    Text("·")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Button(action.rawValue) { perform(action) }
                    .buttonStyle(StudioGoalActionStyle(emphasis: index == 0 && action != .clear))
                    .accessibilityIdentifier("juno.code.goal.\(action.rawValue.lowercased().replacingOccurrences(of: " ", with: "-"))").contentShape(.rect)
            }
        }
        .fixedSize()
    }
}

/// A word that acts: the row's actions are text, like the rest of it.
struct StudioGoalActionStyle: ButtonStyle {
    var emphasis = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(emphasis ? Studio.Font.metaEmphasis : Studio.Font.meta)
            .foregroundStyle(emphasis ? Studio.Ink.accent : Studio.Ink.secondary)
            .underline(hovering)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .onHover { hovering = $0 }
            .contentShape(.rect)
    }
}

/// Liquid Glass for chrome that floats over the thread, or the opaque card
/// that stands in for it with Reduce Transparency and in offscreen snapshots.
/// While a run works toward the goal, a soft accent glow says so.
struct StudioGoalSurface: ViewModifier {
    var isWorking = false
    var cornerRadius: CGFloat = Studio.Radius.card

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        Group {
            if reduceTransparency || snapshotOpaqueGlass {
                content
                    .background(Studio.Surface.raised, in: shape)
                    .overlay { shape.strokeBorder(Studio.Surface.hairline) }
            } else {
                content.glassEffect(.regular, in: shape)
            }
        }
        .shadow(color: isWorking ? Studio.Ink.accent.opacity(0.22) : .clear, radius: isWorking ? 10 : 0)
        .animation(JunoMotion.standard, value: isWorking)
    }
}
