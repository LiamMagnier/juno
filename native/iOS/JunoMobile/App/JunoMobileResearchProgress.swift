import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Deep research state above the composer: that the mode is on, what the server
/// is currently doing, and whether the research quietly degraded.
///
/// The live steps are the point. Research runs PLAN → SEARCH → READ for tens of
/// seconds before a single token of the report is streamed, so without them the
/// screen is an empty bubble and a spinner for the entire prep phase — which
/// reads as a hung app rather than as work in progress.
struct JunoMobileResearchProgress: View {
    let enabled: Bool
    let activity: [NativeChatActivity]
    let degradedWarning: String?
    let onDisable: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if enabled { header }
            searchBlock
            if let degradedWarning { warningRow(degradedWarning) }
        }
        .padding(.horizontal, 14)
        .accessibilityIdentifier("juno.mobile.research-progress")
    }

    /// The searches, in AIcss's Web Search block — the same block the Mac and the
    /// web show for the same events.
    ///
    /// This used to be the latest activity item only, as an SF Symbol beside
    /// `title` and `detail`, on the reasoning that a growing list above the
    /// composer would push the text field around while someone types into it.
    /// That reasoning still holds and this still honours it: the block's own list
    /// is collapsible and, once folded, the whole thing is one line. What changed
    /// is that the one line is now the QUERY — the thing a reader is waiting on —
    /// rather than whichever event happened to arrive last, which was as often
    /// "Selected model" as it was a search.
    @ViewBuilder
    private var searchBlock: some View {
        let sites = NativeSearchActivity.sites(in: activity)
        let query = NativeSearchActivity.query(in: activity)
        if query != nil || !sites.isEmpty {
            JunoAIcssWebSearch(
                query: query,
                sites: sites,
                settled: NativeSearchActivity.settled(in: activity),
                // Folded above the composer: the reader is typing, and the rail of
                // sources is reference rather than status. The query alone is the
                // status, and it stays visible.
                defaultOpen: false
            )
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "binoculars")
                .font(.caption)
            Text("research.enabled")
                .font(.caption.weight(.medium))
            Spacer()
            Button("research.turn-off", action: onDisable)
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
        }
        .accessibilityElement(children: .combine)
    }


    /// Shown separately from the steps because it changes what the answer *is*.
    /// A reader who asked for research and silently received plain chat has
    /// been misled about the basis of the reply.
    private func warningRow(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption2)
            Text(message)
                .font(.caption2)
                .lineLimit(2)
            Spacer()
        }
        .foregroundStyle(.orange)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.research-degraded")
    }

}
