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

    /// The server's own `activity` stream, read through the same lens a local
    /// run is read through.
    ///
    /// A projection and not a second research engine: deep research runs
    /// server-side, and re-deriving phase, queries and sources here would give
    /// the phone a different account of the run from the one the report was
    /// written against. See ``DeepResearchActivityProjection``.
    private var progress: ServerResearchProgress {
        DeepResearchActivityProjection.progress(from: activity)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if enabled { header }
            runRow
            searchBlock
            if let degradedWarning { warningRow(degradedWarning) }
        }
        .padding(.horizontal, JunoSpace.regular)
        .accessibilityIdentifier("juno.mobile.research-progress")
    }

    /// What stage the run is at, and how much it has covered.
    ///
    /// The block below already shows the *current* query and, unfolded, the
    /// sources — so this line carries only what that block cannot: the phase, and
    /// the totals. Without them a long run reads as one query repeating, because
    /// the block only ever shows the latest.
    ///
    /// The phase never runs ahead of the events: a run that has searched and not
    /// yet visited anything says "Searching", not "Reading". A label that guesses
    /// forward is how a stuck run looks healthy.
    @ViewBuilder
    private var runRow: some View {
        let run = progress
        // Absent, not zero. Before the first search there is genuinely nothing
        // to report, and "Planning · 0 sources" states a fact nobody has.
        if let counts = run.countsSummary {
            HStack(spacing: JunoSpace.tight) {
                // Not `binoculars`: the header above already carries that glyph
                // for "research is on", and repeating it here would make two
                // rows that look like the same statement twice.
                JunoIconView(.research, size: 13)
                Text("\(run.phase.displayName) · \(counts)")
                    .font(.caption2)
                    .lineLimit(1)
                Spacer()
            }
            .foregroundStyle(Color.junoMutedForeground)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("juno.mobile.research-run")
        }
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
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.research, size: 14)
            Text("research.enabled")
                .font(.caption.weight(.medium))
            Spacer()
            Button("research.turn-off", action: onDisable)
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
            .contentShape(.rect)
        }
        .accessibilityElement(children: .combine)
    }


    /// Shown separately from the steps because it changes what the answer *is*.
    /// A reader who asked for research and silently received plain chat has
    /// been misled about the basis of the reply.
    private func warningRow(_ message: String) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.error, size: 13)
            Text(message)
                .font(.caption2)
                .lineLimit(2)
            Spacer()
        }
        .foregroundStyle(Color.junoCaution)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.research-degraded")
    }

}
