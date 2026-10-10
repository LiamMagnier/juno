import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// A message between this Chat and another of the reader's conversations, as
/// one compact row in the transcript (the web's `CrossMessageRow`): "Sent to
/// ‘Fix the cart total’ · Open", "From ‘Release prep’ · Open", or "‘Fix the
/// cart total’ is idle again".
///
/// Never the reader's bubble, since a received message is not something they
/// said: a hairline on the leading edge, the caption line in the muted ink and
/// the text beneath. No pill, no dot, no coral.
struct DesktopCrossMessageRow: View {
    let message: NativeCrossMessage
    /// Opens the other conversation when it is a Chat; nil hides Open.
    var open: ((String) -> Void)?

    private var icon: JunoIcon {
        switch message.direction {
        case .sent: .send
        case .received: .cornerDownRight
        case .notice: .message
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 1)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(icon, size: 12)
                        .foregroundStyle(Color.junoMutedForeground)
                    Text(message.line)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let open, let chatID = message.peerChatID {
                        Text("·")
                        Button("Open") { open(chatID) }
                            .buttonStyle(.plain)
                            .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                            .foregroundStyle(Color.junoForeground)
                            .accessibilityHint("Opens \(message.peerTitle)")
                    }
                }
                .junoFont(size: 12, relativeTo: .caption)
                .foregroundStyle(Color.junoMutedForeground)
                if message.direction != .notice, !message.text.isEmpty {
                    Text(message.text)
                        .junoFont(size: 14, relativeTo: .body)
                        .foregroundStyle(Color.junoForeground.opacity(0.85))
                        .lineLimit(4)
                        .textSelection(.enabled)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.line)
    }
}
