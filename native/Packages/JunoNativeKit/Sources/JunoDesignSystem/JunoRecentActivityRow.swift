import JunoCore
import SwiftUI

/// A quiet, source-list row for activity that needs a decision.
///
/// It is deliberately a row rather than a card or a status pill: attention is
/// useful information, not a reason to make the sidebar visually alarming.
public struct JunoRecentActivityRow: View {
    public let item: JunoRecentItem

    public init(item: JunoRecentItem) {
        self.item = item
    }

    public var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(item.kind.icon)
                .junoFont(size: 13, relativeTo: .body, weight: .medium)
                .foregroundStyle(item.needsAttention ? Color.junoCaution : Color.junoSidebarForeground)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .junoRowLabel()
                    .lineLimit(1)
                HStack(spacing: JunoSpace.tight) {
                    Text(item.kind.label)
                    if let status = item.status, let label = statusLabel(status) {
                        Text("·")
                        Text(label)
                    }
                }
                .junoCaption()
                .lineLimit(1)
            }

            Spacer(minLength: JunoSpace.hairline)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Open \(item.kind.label)")
    }

    private func statusLabel(_ status: String) -> String? {
        switch status {
        case "waiting_input": "Waiting for your answer"
        case "waiting_approval", "awaiting_approval": "Waiting for approval"
        case "host_offline": "Mac offline"
        case "failed": "Failed"
        case "interrupted": "Interrupted"
        default: nil
        }
    }
}

extension JunoRecentKind {
    /// The website's mark for each kind: the same glyphs the product switcher
    /// and the sidebar draw for the product the item belongs to.
    var icon: JunoIcon {
        switch self {
        case .chat: .conversation
        case .work: .listChecks
        case .code: .code
        case .project: .projects
        }
    }
}
