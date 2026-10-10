import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Opens another of the reader's conversations by its ref (chat:…, code:…,
/// env:…). Set by the app; nil where nothing can open one, and then the rows
/// name the conversation without an Open.
public struct StudioOpenConversationKey: EnvironmentKey {
    public static let defaultValue: (@MainActor (String) -> Void)? = nil
}

public extension EnvironmentValues {
    var studioOpenConversation: (@MainActor (String) -> Void)? {
        get { self[StudioOpenConversationKey.self] }
        set { self[StudioOpenConversationKey.self] = newValue }
    }
}

/// A message between this session and another of the reader's conversations,
/// as one compact row: "Sent to ‘Fix the cart total’ · Open", "From ‘Release
/// prep’ · Open", or "‘Release prep’ is idle again".
///
/// Never the reader's bubble: a received message is not something they said.
/// A hairline on the leading edge, the caption line in the meta ink and the
/// text beneath; no pill, no dot, and no coral (that is for work in flight
/// and for the reader being needed).
struct StudioConversationMessageRow: View {
    let event: ConversationMessageEvent
    var open: (@MainActor (String) -> Void)?

    @Environment(\.studioOpenConversation) private var environmentOpen

    static func line(for event: ConversationMessageEvent) -> String {
        let title = "‘\(event.peerTitle)’"
        switch event.direction {
        case .notice: return "\(title) is idle again"
        case .received: return "From \(title)"
        case .sent: return event.status == "failed" ? "Not delivered to \(title)" : "Sent to \(title)"
        }
    }

    private var icon: JunoIcon {
        switch event.direction {
        case .sent: .send
        case .received: .cornerDownRight
        case .notice: .message
        }
    }

    private var opener: (@MainActor (String) -> Void)? { open ?? environmentOpen }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Rectangle()
                .fill(Studio.Ink.tertiary.opacity(0.35))
                .frame(width: 1)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(icon, size: 11)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .frame(width: 11)
                    Text(Self.line(for: event))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let opener {
                        Text("·")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                        Button("Open") { opener(event.peerRef) }
                            .buttonStyle(.plain)
                            .font(Studio.Font.metaEmphasis)
                            .foregroundStyle(Studio.Ink.primary)
                            .accessibilityHint("Opens \(event.peerTitle)")
                    }
                }
                if event.direction != .notice, !event.text.isEmpty {
                    Text(event.text)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(4)
                        .textSelection(.enabled)
                        .padding(.leading, 11 + JunoSpace.tight)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Self.line(for: event))
    }
}
