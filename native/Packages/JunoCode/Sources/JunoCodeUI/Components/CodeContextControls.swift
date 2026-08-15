import JunoDesignSystem
import SwiftUI

// The composer's context row is a strip of menus — which project, where it
// runs, what it is allowed to do — and every one of them used to draw its own
// label by hand. There were four hand-rolled variants in one row: two chevron
// sizes, three glyph sizes, a `.caption2` chevron here and a fixed 8pt one
// there. These are the two pieces they all needed.

/// A menu's label inside the composer's context row: a mark, a word, a
/// chevron.
///
/// Neutral ink by default, as the website's own target chip is
/// (`code-target-picker.tsx` draws its folder, branch and chevron marks
/// `text-muted-foreground`). The accent in that row belongs to the send button
/// at the other end of it — a composer with a coral glyph at each end has two
/// primary actions and therefore none.
public struct CodeContextChipLabel: View {
    private let title: String
    private let systemImage: String?
    private let junoIcon: JunoIcon?
    private let tint: Color?

    public init(_ title: String, systemImage: String, tint: Color? = nil) {
        self.title = title
        self.systemImage = systemImage
        junoIcon = nil
        self.tint = tint
    }

    public init(_ title: String, icon: JunoIcon, tint: Color? = nil) {
        self.title = title
        systemImage = nil
        junoIcon = icon
        self.tint = tint
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if let junoIcon {
                JunoIconView(junoIcon, size: 14)
            } else if let systemImage {
                Image(systemName: systemImage)
                    // Scaled against the label it leads, one rung up so the
                    // mark reads as the chip's anchor rather than as a second
                    // word.
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .contentTransition(.symbolEffect(.replace))
            }
            Text(title)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                // The scale's floor. The fixed 8pt and 9pt chevrons this
                // replaces sat below the caption rung and never moved with
                // Dynamic Type.
                .font(.caption2.weight(.bold))
        }
        .foregroundStyle(tint ?? Color.junoMutedForeground)
        .padding(.vertical, JunoSpace.hairline)
        // The chip is a 44pt target even though it draws smaller: a menu you
        // have to aim at is a menu you open by accident.
        .frame(minHeight: CodeRowMetrics.minHeight)
        .contentShape(.rect)
    }
}

/// The hairline between two controls in a context row.
///
/// One definition because there were three, at three heights, and a rule that
/// is 18pt beside one control and 16pt beside the next reads as a rendering
/// bug rather than as a separator.
public struct CodeContextSeparator: View {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1, height: 18)
            .accessibilityHidden(true)
    }
}
