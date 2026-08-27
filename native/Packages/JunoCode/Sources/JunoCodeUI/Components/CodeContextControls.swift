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
    private let icon: JunoIcon
    private let tint: Color?

    public init(_ title: String, icon: JunoIcon, tint: Color? = nil) {
        self.title = title
        self.icon = icon
        self.tint = tint
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 14)
            Text(title)
                .junoRowLabel()
                .lineLimit(1)
                .truncationMode(.middle)
            // The disclosure is part of the same website icon vocabulary as
            // the destination mark. Keeping it as a generated Lucide asset
            // also gives the native and web composers the same optical weight.
            JunoIconView(.chevronDown, size: 12)
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
