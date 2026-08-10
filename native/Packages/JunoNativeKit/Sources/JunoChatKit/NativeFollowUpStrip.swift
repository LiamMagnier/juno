import JunoAuth
import JunoCore
import JunoSync
import JunoDesignSystem
import SwiftUI

/// Clickable follow-up prompts under a finished reply.
///
/// Renders nothing while loading and nothing when empty — deliberately no
/// skeleton, and the reason is the same one the web states: this sits directly
/// under the last message, so any placeholder shoves the thread and the reader's
/// scroll position on every single turn. A strip that appears late is a strip
/// that appeared; a strip that reserves space it may never use is a layout bug
/// with good intentions.
///
/// Shared by both apps. The suggestions are the server's and the presentation is
/// a row of pills on each platform, so there is nothing here worth writing twice.
public struct NativeFollowUpStrip: View {
    private let conversationID: String
    private let accountID: AccountID?
    private let client: NativeFollowUpClient?
    /// True once the reply has finished streaming. Fetching before then would ask
    /// the server to suggest follow-ups to half an answer.
    private let ready: Bool
    private let onPick: (String) -> Void

    @State private var suggestions: [String] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        conversationID: String,
        accountID: AccountID?,
        client: NativeFollowUpClient?,
        ready: Bool,
        onPick: @escaping (String) -> Void
    ) {
        self.conversationID = conversationID
        self.accountID = accountID
        self.client = client
        self.ready = ready
        self.onPick = onPick
    }

    public var body: some View {
        Group {
            if !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button { onPick(suggestion) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Color.junoMutedForeground)
                                Text(suggestion)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.primary.opacity(0.85))
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                .fill(Color.junoSurface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                .strokeBorder(Color.junoHairline)
                        )
                    }
                }
                .transition(.opacity)
            }
        }
        // Keyed on both, so a new turn in the same conversation refetches and
        // moving to another conversation does not carry the old set across.
        .task(id: "\(conversationID)|\(ready)") {
            // Drop first, always: suggestions belong to the turn they were fetched
            // for and must never linger over a newer reply.
            suggestions = []
            guard ready, let client, let accountID else { return }
            let fetched = await client.suggestions(conversationID: conversationID, for: accountID)
            guard !Task.isCancelled else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                // Deduplicated because the row below is keyed on the string
                // itself. The server does not promise these are distinct, and a
                // model that offers the same follow-up twice would hand `ForEach`
                // two identical ids — which SwiftUI resolves by dropping one row
                // and diffing the rest wrongly from then on. Order is preserved:
                // the server ranked them, and a `Set` would throw that away.
                var seen = Set<String>()
                suggestions = fetched.filter { seen.insert($0).inserted }
            }
        }
        .accessibilityLabel("Follow-up suggestions")
    }
}
