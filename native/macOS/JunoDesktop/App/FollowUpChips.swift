import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// What to ask next, above the composer (spec §6.12, brief §6.6): up to three
/// **opaque** chips — `JunoChipStyle`, a hairline capsule that fills on hover
/// — left-aligned to the measure and wrapping, each cut off at 320pt. A click
/// **sends** the suggestion, as the web's does.
///
/// Opaque on purpose: the composer is the only glass shape in its cluster, and
/// glass pills read as "AI suggestion bubbles" rather than as the footnote to
/// the reply that these are.
///
/// Shown only when nothing is running and the draft is empty; renders nothing
/// while it loads and nothing when there are none — a placeholder here would
/// shove the transcript on every turn.
struct DesktopFollowUpChips: View {
    let conversationID: String
    /// The reply the suggestions are for. A new one is a new fetch.
    let replyID: String?
    let accountID: AccountID
    let client: NativeFollowUpClient?
    /// The reply has settled: idle, ending on an answer with words and no error.
    let ready: Bool
    /// Nothing is typed or attached.
    let draftIsEmpty: Bool
    let send: (String) -> Void
    /// Stands in for the network in the snapshot harness.
    var preset: [String]? = nil

    @State private var suggestions: [String] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var shown: [String] { preset ?? suggestions }

    var body: some View {
        Group {
            if ready, draftIsEmpty, !shown.isEmpty {
                JunoChipFlow(spacing: JunoChipMetrics.spacing, lineSpacing: JunoChipMetrics.spacing) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, suggestion in
                        Button {
                            send(suggestion)
                        } label: {
                            Label {
                                Text(suggestion)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .frame(maxWidth: 320, alignment: .leading)
                            } icon: {
                                JunoIconView(.plus, size: 14)
                            }
                        }
                        .buttonStyle(JunoChipStyle())
                        .contentShape(Capsule())
                        .help(suggestion)
                        .accessibilityLabel(suggestion)
                        .accessibilityHint("Sends this as your next message")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(DesktopChoreography.riseDistance, reduceMotion: reduceMotion))))
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Suggested follow-ups")
            }
        }
        // Suggestions belong to the reply they were fetched for: a new reply or
        // another conversation drops them before anything else happens.
        .task(id: "\(conversationID)|\(replyID ?? "")|\(ready)") {
            guard preset == nil else { return }
            suggestions = []
            guard ready, let client else { return }
            let fetched = await client.suggestions(conversationID: conversationID, for: accountID)
            guard !Task.isCancelled else { return }
            var seen = Set<String>()
            let distinct = fetched
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                suggestions = Array(distinct.prefix(3))
            }
        }
    }
}
