import JunoDesignSystem
import SwiftUI

/// The `‹ 1 / 3 ›` switcher under a message that has more than one revision.
///
/// **It only exists where there is something to switch to.** A message that has
/// never been edited has no siblings, and a pager reading `1 / 1` would be a
/// control that cannot do anything sitting under every single turn — so
/// ``NativeConversationModel/branchPosition(for:in:)`` returns nil for those and
/// this view is never built. The host renders it below the message body, where
/// the web puts the same control.
///
/// The arrows stop at the ends rather than wrapping. Wrapping from `3 / 3` to
/// `1 / 3` on a forward tap looks exactly like losing a branch, and a reader who
/// has just spent an edit getting an answer they liked should never be given
/// that impression.
public struct NativeBranchNavigator: View {
    private let position: NativeMessageBranchPosition
    private let isEnabled: Bool
    private let onStep: (Int) -> Void

    /// - Parameters:
    ///   - position: where the message sits among its siblings. Counting for the
    ///     reader starts at one; the position's index does not, and the `+ 1` is
    ///     done here so no caller has to remember it.
    ///   - isEnabled: false while a generation is running. Switching branches
    ///     mid-stream would leave the answer being written attached to a
    ///     question no longer on screen, so the control greys out rather than
    ///     disappearing — a disappearing pager reads as a lost revision.
    public init(
        position: NativeMessageBranchPosition,
        isEnabled: Bool = true,
        onStep: @escaping (Int) -> Void
    ) {
        self.position = position
        self.isEnabled = isEnabled
        self.onStep = onStep
    }

    private var canGoBack: Bool { position.index > 0 }
    private var canGoForward: Bool { position.index + 1 < position.siblingsCount }

    public var body: some View {
        HStack(spacing: 2) {
            step(
                icon: .chevronLeft,
                label: "Previous revision",
                offset: -1,
                available: canGoBack
            )
            Text("\(position.index + 1) / \(position.siblingsCount)")
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .monospacedDigit()
                .foregroundStyle(Color.junoMutedForeground)
                // Monospaced digits so stepping from 9 to 10 does not shift the
                // arrows sideways under the reader's finger.
                .padding(.horizontal, 2)
            step(
                icon: .chevronRight,
                label: "Next revision",
                offset: 1,
                available: canGoForward
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Revision \(position.index + 1) of \(position.siblingsCount)")
    }

    private func step(
        icon: JunoIcon,
        label: String,
        offset: Int,
        available: Bool
    ) -> some View {
        Button { onStep(offset) } label: {
            JunoIconView(icon)
                .junoFont(size: 10, relativeTo: .body, weight: .semibold)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!available || !isEnabled)
        .foregroundStyle(
            Color.junoMutedForeground.opacity(available && isEnabled ? 1 : 0.35)
        )
        .accessibilityLabel(label)
    }
}

#if DEBUG
#Preview("Branch navigator") {
    VStack(alignment: .leading, spacing: 12) {
        NativeBranchNavigator(
            position: NativeMessageBranchPosition(
                index: 0,
                siblingMessageIDs: ["a", "b", "c"]
            )
        ) { _ in }
        NativeBranchNavigator(
            position: NativeMessageBranchPosition(
                index: 2,
                siblingMessageIDs: ["a", "b", "c"]
            )
        ) { _ in }
        NativeBranchNavigator(
            position: NativeMessageBranchPosition(
                index: 1,
                siblingMessageIDs: ["a", "b", "c"]
            ),
            isEnabled: false
        ) { _ in }
    }
    .padding()
}
#endif
