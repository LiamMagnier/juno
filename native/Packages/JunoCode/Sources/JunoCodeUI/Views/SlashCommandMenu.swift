import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// The list that drops above the composer while a `/command` is being typed.
///
/// Deliberately **not** a `.popover`. A popover over a `NavigationSplitView`
/// negotiates its own size against the window, and an unconstrained one whose
/// content changes on every keystroke is exactly the intrinsic-size feedback
/// that has already cost this window a constraint-loop crash. This is an
/// overlay, sized by its container, so it can never talk back to the split view.
///
/// It also does not steal the keyboard. The composer's field keeps focus
/// throughout — the reader is still typing the command's name — and the menu
/// only reacts to what the field's own key handlers report. A list that grabbed
/// focus would break the one thing this feature exists to make fast.
@available(macOS 26.0, *)
struct SlashCommandMenu: View {
    let commands: [CodeSlashCommand]
    /// The row the arrow keys have moved to, which Return will run.
    let highlighted: Int
    let choose: (CodeSlashCommand) -> Void

    /// Enough rows to be useful, few enough that the menu never covers the
    /// transcript it is being written against.
    private static let maximumVisibleRows = 6
    private static let rowHeight: CGFloat = 42

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.tight) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                            row(command, isHighlighted: index == highlighted)
                                .id(index)
                        }
                    }
                    .padding(JunoSpace.hairline)
                }
                .scrollIndicators(.hidden)
                .frame(
                    maxHeight: Self.rowHeight * CGFloat(min(commands.count, Self.maximumVisibleRows))
                )
                // Keeps the arrow-key selection visible when the list is longer
                // than the window shows.
                .onChange(of: highlighted) { _, index in
                    withAnimation(JunoMotion.fast) { proxy.scrollTo(index, anchor: .center) }
                }
            }
            .junoFloatingChrome(cornerRadius: JunoRadius.well)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Slash commands")
        .accessibilityIdentifier("juno.code.composer.slash-menu")
    }

    private func row(_ command: CodeSlashCommand, isHighlighted: Bool) -> some View {
        Button {
            choose(command)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: JunoSpace.tight) {
                        Text("/\(command.name)")
                            .junoMono()
                            .foregroundStyle(Color.junoForeground)
                        if command.source.isWorkspace {
                            // The one distinction worth drawing in the menu: a
                            // command the repository defined behaves however the
                            // repository decided, and the reader should know
                            // which of the two they are about to run.
                            Text("workspace")
                                // Text, not a glyph, and 9pt fixed — the
                                // smallest unscaled string in this menu.
                                .junoFont(size: 9, relativeTo: .caption2, weight: .medium)
                                .junoSecondaryInk()
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(
                                    Capsule(style: .continuous).fill(Color.junoMuted)
                                )
                        }
                    }
                    Text(command.summary)
                        .junoCaption()
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.snug)
                if let behavior = command.behavior {
                    Text(behavior.slashMenuLabel)
                        .font(.caption2)
                        .junoSecondaryInk()
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isHighlighted ? Color.junoRowSelected : .clear)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("/\(command.name). \(command.summary)")
    }
}

extension AgentBehavior {
    /// How the command's implied mode reads in the menu's right margin.
    var slashMenuLabel: String {
        switch self {
        case .ask: "Ask"
        case .plan: "Plan"
        case .code: "Code"
        }
    }
}
