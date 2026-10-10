import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// "Let conversations message each other" for Code (src/lib/cross-conversation):
/// whether a session's agent may list, read and message the reader's other
/// conversations, and be messaged by them. On by default. A session's own
/// choice, from its menu, wins.
struct StudioCrossConversationSettings: View {
    @Bindable private var defaults = CodeDefaults.shared

    var body: some View {
        Section {
            Toggle(isOn: $defaults.crossMessagesEnabled) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Let conversations message each other")
                    Text("An agent can list, read and message your other conversations. What it sends arrives as a message from this session, never as you, and it can't approve anything. Sending asks first except in Full Access.")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                }
            }
            .accessibilityIdentifier("juno.code.settings.cross-messages")
        } header: {
            Text("Other conversations")
        }
    }
}
