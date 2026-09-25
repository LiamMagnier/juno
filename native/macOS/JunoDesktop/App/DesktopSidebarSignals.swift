import JunoDesignSystem
import SwiftUI

/// The Needs-you fold's heading (`NeedsYouFold` in `app-sidebar.tsx`): a
/// filter, not a destination, and the column's signature detail.
///
/// It wears the section heading's voice — the system's header size, the
/// secondary ink, no chevron, because pressing it filters rather than folds
/// and a chevron would be a lie about what it does. The count rides in the
/// heading, in tabular figures, rather than at the row's far end: a second
/// element on the right would be a trailing signal on something that already
/// has one job.
///
/// Pressed, it becomes the column's one selected state — the pill every
/// selected row wears, the foreground ink — because while it is on the column
/// shows these chats and nothing else, which is the fact a selection states.
/// So "what needs me" is one press from anywhere.
struct DesktopNeedsYouHeader: View {
    let count: Int
    let isFiltering: Bool
    let toggle: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovering = false

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 0) {
                Text("Needs you")
                    .lineLimit(1)
                Text(" · \(count)")
                    .monospacedDigit()
                    .fixedSize()
                Spacer(minLength: 0)
            }
            .textCase(nil)
            .foregroundStyle(isFiltering || isHovering ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .background(alignment: .leading) { pill }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .help(isFiltering ? "Show everything" : "Show only these")
        .accessibilityLabel("Needs you")
        .accessibilityValue("\(count)")
        .accessibilityHint(isFiltering ? "Shows every chat again" : "Shows only the chats waiting on you")
        .accessibilityAddTraits(isFiltering ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("juno.desktop.sidebar.needs-you")
    }

    /// The selected row's pill, reaching the row pills' edges: the heading's
    /// text sits a row inset in from where a row's pill starts.
    private var pill: some View {
        let shape = RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
        return shape
            .fill(isFiltering ? Color.junoSelectedFill : Color.clear)
            .overlay {
                shape.strokeBorder(
                    isFiltering ? Color.junoSelectedEdge(increaseContrast: contrast == .increased) : Color.clear,
                    lineWidth: 1
                )
            }
            // Out to where a row's pill starts, and in from the header's
            // trailing edge (which reaches past the rows for the fold
            // chevron's slot) to where a row's pill ends.
            .padding(.leading, -JunoSpace.snug)
            .padding(.trailing, JunoSpace.hairline)
            .accessibilityHidden(true)
    }
}
