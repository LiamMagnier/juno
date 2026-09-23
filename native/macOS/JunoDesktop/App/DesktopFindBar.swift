import JunoDesignSystem
import SwiftUI

/// Find in this conversation (⌘F; spec §6.14, brief §6.8): a glass capsule at
/// most 480pt wide at the top of the chat column — the magnifier, the field,
/// "3 of 12", Previous and Next, and Done.
///
/// One of the transcript's two allow-listed glass sites: it floats over the
/// text it is finding things in. The highlights themselves are neutral — the
/// foreground at 10%, the current match at 22% — because a find highlight marks
/// a place, not an action, and coral is for actions.
///
/// Return and ⌘G step forward, ⇧Return and ⇧⌘G back, Esc closes.
struct DesktopFindBar: View {
    @Binding var query: String
    /// The current match, from zero, when there is one.
    let current: Int?
    let total: Int
    let next: () -> Void
    let previous: () -> Void
    let done: () -> Void
    /// Bumped to put the caret back in the field — ⌘F while it is open.
    var focusRequest = 0

    @FocusState private var focused: Bool

    private var countLabel: String? {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard total > 0 else { return "No matches" }
        return "\((current ?? 0) + 1) of \(total)"
    }

    var body: some View {
        GlassEffectContainer {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.search, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                TextField("Find in this conversation", text: $query)
                    .textFieldStyle(.plain)
                    .junoFont(size: 13, relativeTo: .callout)
                    .focused($focused)
                    .onSubmit(next)
                    .onKeyPress(.escape) {
                        done()
                        return .handled
                    }
                    .onKeyPress(keys: [.return], phases: .down) { press in
                        guard press.modifiers.contains(.shift) else { return .ignored }
                        previous()
                        return .handled
                    }
                    .accessibilityLabel("Find in this conversation")
                if let countLabel {
                    Text(countLabel)
                        .junoFont(size: 12, relativeTo: .footnote, design: total > 0 ? .monospaced : .default)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .fixedSize()
                        .accessibilityLabel(total > 0 ? "Match \((current ?? 0) + 1) of \(total)" : "No matches")
                }
                Button(action: previous) {
                    JunoIconView(.chevronUp, size: 12)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(DesktopFindBarControlStyle())
                .contentShape(Circle())
                .disabled(total == 0)
                .help("Previous Match (⇧⌘G)")
                .accessibilityLabel("Previous match")
                Button(action: next) {
                    JunoIconView(.chevronDown, size: 12)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(DesktopFindBarControlStyle())
                .contentShape(Circle())
                .disabled(total == 0)
                .help("Next Match (⌘G)")
                .accessibilityLabel("Next match")
                Button(action: done) {
                    Text("Done")
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(minHeight: 28)
                }
                .buttonStyle(DesktopFindBarControlStyle())
                .contentShape(Capsule())
                .accessibilityLabel("Done")
            }
            .padding(.leading, JunoSpace.cozy)
            .padding(.trailing, JunoSpace.hairline)
            .frame(height: 36)
            .glassEffect(.regular, in: Capsule())
        }
        .frame(maxWidth: 480)
        .onAppear { focused = true }
        .onChange(of: focusRequest) { _, _ in focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find")
    }
}

/// A borderless control inside the find capsule: glass's own hover fill,
/// never the accent.
private struct DesktopFindBarControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .foregroundStyle(hovered && isEnabled ? Color.junoForeground : Color.junoSecondaryInk)
                .background(Capsule().fill(Color.junoGlassHover).opacity(hovered && isEnabled ? 1 : 0))
                .opacity(isEnabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        }
    }
}
