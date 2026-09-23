import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// An artifact referenced inline in an answer — the web's
/// `artifact-inline-card.tsx`.
///
/// An opaque tile on the card rung with a hairline: a 40pt icon tile, the title
/// in the UI face, the kind on a mono caption, and an "Open" ghost button with
/// the external mark. Never glass, never a neumorphic throw — a card in a
/// transcript is content, and the coral is spent nowhere on it.
struct DesktopInlineArtifactCard: View {
    let artifact: NativeMessageContent.ArtifactReference
    let open: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    private var kindLabel: String {
        DesktopArtifactKindLabel.title(forWireKind: artifact.kind)
    }

    /// The web's mono line: the kind, then the language when the model named
    /// one. "Writing" replaces both while the source is still arriving.
    private var metadata: String {
        if artifact.streaming { return "Writing" }
        guard let language = artifact.language, !language.isEmpty else { return kindLabel }
        return "\(kindLabel) · \(language.uppercased())"
    }

    var body: some View {
        Button {
            open?()
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(DesktopArtifactKindLabel.icon(forWireKind: artifact.kind), size: 18)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 40, height: 40)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                            .fill(Color.junoMuted)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .junoInk()
                        .lineLimit(1)
                    Text(metadata)
                        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                if artifact.streaming {
                    JunoThinkingMatrix(dot: 3, spacing: 2)
                        .junoSecondaryInk()
                } else if open != nil {
                    HStack(spacing: JunoSpace.hairline) {
                        Text("Open")
                        JunoIconView(.external, size: 12)
                    }
                    .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(hovered ? Color.junoForeground : Color.junoMutedForeground)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                            .fill(hovered ? Color.junoRowHover : Color.clear)
                    )
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoCard(cornerRadius: JunoRadius.card)
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .disabled(open == nil)
        .onHover { hovered = $0 }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: hovered
        )
        .accessibilityLabel(
            artifact.streaming
                ? "Writing artifact \(artifact.title)"
                : "Open artifact \(artifact.title), \(metadata)"
        )
    }
}
