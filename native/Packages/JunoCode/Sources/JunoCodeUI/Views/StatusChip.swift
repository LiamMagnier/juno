import JunoDesignSystem
import SwiftUI

/// A small tinted capsule stating one fact about a run: a permission mode, a
/// risk class, a capture state.
///
/// It lived in `AgentCanvasView.swift` until that file — along with the rest of
/// the pre-rework Code shell — was deleted as dead code. Two live surfaces still
/// use it, so it moves here rather than being duplicated into each of them.
///
/// The tint is passed in rather than derived, because the callers are the ones
/// that know whether a fact is neutral, cautionary or dangerous, and a chip that
/// picked its own colour from its title string would be guessing.
struct StatusChip: View {
    let title: String
    let icon: JunoIcon
    let tint: Color

    init(_ title: String, icon: JunoIcon, tint: Color) {
        self.title = title
        self.icon = icon
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            JunoIconView(icon, size: 13)
            Text(title)
        }
        .font(.caption)
        .foregroundStyle(tint)
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, 3)
        .background(
            Capsule(style: .continuous).fill(tint.opacity(0.13))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }
}
